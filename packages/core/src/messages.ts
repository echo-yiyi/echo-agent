// 消息层：我们的账本（AgentMessage）与发出去的电报（ProviderMessage），以及两者之间**唯一**一道翻译。
//
// 三条不变量：
//   ① AgentMessage 是纯数据（JSON-safe）——它会被原样落盘，所以不许挂函数、不许挂类实例。
//   ② 内建只有三种角色：循环自己会产生或消费的才配进内建（产 assistant、消费 user 与 toolResult）。
//      其余一律走 CustomAgentMessages 扩展位。
//   ③ 投影是单向、每轮重算、绝不回写——ProviderMessage 只是临时形态，不存。

import type { AgentError } from "./errors.ts";

/* ─────────────────────────── 内容块 ─────────────────────────── */

export type TextBlock = { type: "text"; text: string };
export type ImageBlock = { type: "image"; mimeType: string; data: string };
export type ToolUseBlock = { type: "tool_use"; id: string; name: string; input: unknown };

/**
 * 模型的思考。**它进 content，不只是观测事件**（2026-08-28 订正——原来的取舍是「thinking 不进 convo」，
 * 那条对单轮成立、对**多轮工具循环不成立**）。
 *
 * 为什么必须落进消息：开了 preserved thinking 的 provider（Z.AI Coding Plan、MiniMax M2.x、
 * DeepSeek reasoner 一类）要求工具结果回来时**原样带回上一轮的 reasoning**，否则这一轮的
 * tool loop 在服务端就不闭合。丢掉它等于「能想但不能一边想一边用工具」——
 * 而这正是 agent 最核心的那条路径。
 *
 * `signature` 是 **provider 不透明的回放数据**：OpenAI 兼容侧记的是这段思考来自哪个字段
 * （`reasoning_content` / `reasoning` / `reasoning_text`——各家不统一），回传时原样写回同一个字段。
 * 别在这里解释它的语义，也别跨 provider 复用——它只对发它的那家有意义。
 * （形状对齐 pi 的 `ThinkingContent`：`thinking` + `thinkingSignature` + `redacted`。）
 *
 * `origin` 是**回放边界的判据**（2026-08-31 review P1）：不透明数据只对**同 provider + 同 api +
 * 同 model** 有意义，回放给别家轻则被拒（实测：DeepSeek/GLM 的历史切到 gpt-4.1，请求仍带着
 * `reasoning_content`），重则违反签名不得跨家使用的契约。
 *
 * **为什么标在块上而不是消息上**：pi 是拿 `AssistantMessage` 的 `provider/api/model` 三元组比
 * （`transform-messages.ts`），而本仓的投影**有意剥掉** `AssistantMessage.model`
 * （不变量③：ProviderMessage 是临时形态，不带账本字段）。要么破那条不变量，
 * 要么让来源跟着不透明数据一起走——选后者：**谁不透明，谁自己带身份**。
 */
export type ThinkingBlock = {
  type: "thinking";
  thinking: string;
  signature?: string;
  /** 被安全过滤器抹掉的思考：正文没有，但 `signature` 仍要原样带回，否则多轮续不上。 */
  redacted?: boolean;
  /** 这段思考是谁产的。缺省（老会话、或方言没标）时按**跨源**处理——保守，不冒回放的险。 */
  origin?: { provider: string; api: string; model: string };
};

/** AgentMessage 里能出现的块。tool_result **不在**这里——它在 v2 里是一等消息角色。 */
export type ContentBlock = TextBlock | ThinkingBlock | ImageBlock | ToolUseBlock;

export type Usage = {
  inputTokens: number;
  outputTokens: number;
  /**
   * 输入里由 prompt 缓存命中的那部分（≤ inputTokens）。**provider 没报就没有这个字段**——
   * 不填 0 冒充报了账，与 `usage: null` 同一条纪律。OpenAI 系报在
   * `prompt_tokens_details.cached_tokens`，DeepSeek 报在 `prompt_cache_hit_tokens`。
   */
  cachedInputTokens?: number;
};

export type StopReason = "end_turn" | "tool_use" | "max_tokens" | "aborted" | "error";

/* ─────────────────────── 三个内建变体 ─────────────────────── */

export type UserMessage = {
  role: "user";
  /**
   * 谁放进来的。**这个字段修的是「harness 插话伪装成用户说的」**：
   * 恢复轻推、steer、「请继续」在 v1 里全是裸 user 消息，历史里无从分辨谁开的口。
   */
  source: "human" | "steer" | "harness";
  content: ContentBlock[];
};

export type AssistantMessage = {
  role: "assistant";
  /** 失败轮里这就是「已经流出来的 partial」——不丢弃。 */
  content: ContentBlock[];
  stopReason: StopReason;
  /** 仅 stopReason === "error" 时在。 */
  error?: AgentError;
  /** 本轮的账。null = provider 没报（≠ 零花费，这个区分是诚实位）。 */
  usage: Usage | null;
  /** 哪个模型说的（provider id / model id），用于多模型会话的回溯。 */
  model?: { provider: string; id: string };
};

export type ToolResultMessage = {
  /**
   * 一等角色。**修的是「工具结果伪装成 user 消息」**：v1 里它是 user 消息里的一个块，
   * transcript 中「工具说的」与「人说的」分不开。出门时再包回线上形状（见 convertToLlm）。
   */
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: string;
  isError: boolean;
  images?: ImageBlock[];
  /** 只观测，**永不进模型**（铁律，继承自 v1 工具层）。 */
  metadata: Record<string, unknown> | null;
};

/**
 * 环境消息：**不是人说的、不是模型说的、也不是工具结果**——是外面发生了一件事。
 * 后台任务结束、定时到点、webhook 进来，都是它。
 *
 * 为什么它够格进内建（判据是「循环自己会产生或消费的角色」）：**循环会消费它**
 * ——inbox 攒的就是它，消费时它进对话、要被投影。
 * 为什么不塞进 `UserMessage.source`：「人说的」与「外面发生的」是两类事实，
 * role 才是第一判别符；塞进 user 只能靠 source 字段去猜，UI 与评测都得多绕一道。
 */
export type EnvironmentMessage = {
  role: "environment";
  /** 谁发生的。**开放字符串**——上层可以有自己的来源，不必改 core。 */
  source: string;
  content: ContentBlock[];
  /** 关联物（后台任务 id 之类）。UI 用它把消息挂回来源。 */
  ref?: string;
};

/** 内核认识的四种，闭合。 */
export type Message = UserMessage | AssistantMessage | ToolResultMessage | EnvironmentMessage;

/**
 * 扩展位：上层 agent 用 declaration merging 往里填自己的消息种类。
 *
 * 跨包写法（仓库外的上层 agent 必须这么写）：
 * ```ts
 * declare module "@echo-agent/core" {
 *   interface CustomAgentMessages {
 *     planNote: { role: "planNote"; text: string };
 *   }
 * }
 * ```
 * 相对路径式 augment 只在同包编译内有效，示例一律教包说明符。
 */
export interface CustomAgentMessages {}

/** 信封只有 at（入账时盖章，一切变体生效）；id 与树位置归 session 账本，不在消息上。 */
export type AgentMessage = { readonly at: number } & (
  | Message
  | CustomAgentMessages[keyof CustomAgentMessages]
);

/* ───────────────────────── 构造器 ───────────────────────── */

export function userMessage(
  text: string,
  source: UserMessage["source"] = "human",
  images?: ImageBlock[],
  at: number = Date.now(),
): AgentMessage {
  const content: ContentBlock[] = [{ type: "text", text }];
  if (images !== undefined) content.push(...images);
  return { role: "user", source, content, at };
}

export function assistantMessage(
  content: ContentBlock[],
  stopReason: StopReason,
  usage: Usage | null = null,
  at: number = Date.now(),
): AgentMessage {
  return { role: "assistant", content, stopReason, usage, at };
}

export function environmentMessage(
  text: string,
  source: string,
  ref?: string,
  at: number = Date.now(),
): AgentMessage {
  const m: EnvironmentMessage & { at: number } = {
    role: "environment",
    source,
    content: [{ type: "text", text }],
    at,
  };
  if (ref !== undefined) m.ref = ref;
  return m;
}

export function toolResultMessage(
  toolCallId: string,
  toolName: string,
  content: string,
  isError: boolean,
  metadata: Record<string, unknown> | null = null,
  images?: ImageBlock[],
  at: number = Date.now(),
): AgentMessage {
  const m: ToolResultMessage & { at: number } = {
    role: "toolResult",
    toolCallId,
    toolName,
    content,
    isError,
    metadata,
    at,
  };
  if (images !== undefined && images.length > 0) m.images = images;
  return m;
}

/* ───────────────────────── 读取助手 ───────────────────────── */

export function textFromMessage(m: AgentMessage): string {
  if (!("content" in m) || !Array.isArray(m.content)) return "";
  return (m.content as ContentBlock[])
    .filter((b): b is TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
}

export function toolUsesFromMessage(m: AgentMessage): ToolUseBlock[] {
  if (m.role !== "assistant") return [];
  return m.content.filter((b): b is ToolUseBlock => b.type === "tool_use");
}

export function isAssistant(m: AgentMessage): m is AssistantMessage & { at: number } {
  return m.role === "assistant";
}

/* ─────────────────── 线上形状（发给模型的电报） ─────────────────── */

export type ProviderToolResultBlock = {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error: boolean;
  images?: ImageBlock[];
};

/**
 * 线上块。**thinking 在这里**：assistant 的思考要原样出门（各家怎么写回自己的字段，由方言决定）。
 * 上一版不含它，于是 preserved thinking 的多轮 tool loop 在服务端不闭合。
 */
export type ProviderBlock = TextBlock | ThinkingBlock | ImageBlock | ToolUseBlock | ProviderToolResultBlock;

/** 线上协议只有两个角色；工具结果作为块寄生在 user 消息里。 */
export type ProviderMessage =
  | { role: "user"; content: ProviderBlock[] }
  | { role: "assistant"; content: ProviderBlock[] };

export type ToolSchema = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
};

/** 一次模型调用的完整输入。**算出来的，不存**（原则 4：context 是投影）。 */
export type Context = {
  systemPrompt: string | null;
  messages: ProviderMessage[];
  tools: ToolSchema[];
};

/* ─────────────────── 投影：AgentMessage → ProviderMessage ─────────────────── */

export type ConvertToLlm = (messages: AgentMessage[]) => ProviderMessage[] | Promise<ProviderMessage[]>;

/**
 * 缺省投影。上层可整体替换（`Agent.convertToLlm`）——它是**唯一**的投影真源，
 * 不再有第二张 projections 表。
 *
 * 契约：**绝不抛**。抛出会打断循环且不产出正常事件序列；认不出的消息种类一律**隐形**
 * （只进 transcript 与 session，不进模型），这是安全缺省——下游忘了处理，
 * 坏结果只是模型看不见那条，而不是模型输入被污染。
 */
export const defaultConvertToLlm: ConvertToLlm = (messages) => {
  const out: ProviderMessage[] = [];
  for (const m of messages) {
    const p = projectOne(m);
    if (p !== null) out.push(p);
  }
  return mergeAdjacentToolResults(out);
};

function projectOne(m: AgentMessage): ProviderMessage | null {
  switch (m.role) {
    case "user":
      // 剥壳：at、source 不出门
      return { role: "user", content: [...m.content] };

    case "assistant": {
      // 剥壳：at、stopReason、error、usage、model 不出门。
      // 失败 attempt 的定稿（stopReason=error）留在 transcript 当事实，但**不是模型说过的话**，不当上文送回去
      // （docs/decisions/proposed/2026-09-05-failed-attempt-in-transcript.md）。
      if (m.stopReason === "error") return null;
      // 空 content 的 assistant 消息是协议违规 → 整条隐形。
      if (m.content.length === 0) return null;
      return { role: "assistant", content: [...m.content] };
    }

    case "toolResult": {
      // 出门时包回线上形状：user 角色携 tool_result 块。metadata 永不出门。
      const block: ProviderToolResultBlock = {
        type: "tool_result",
        tool_use_id: m.toolCallId,
        content: m.content,
        is_error: m.isError,
      };
      if (m.images !== undefined && m.images.length > 0) block.images = m.images;
      return { role: "user", content: [block] };
    }

    case "environment":
      // 模型只认三种角色，所以它出门时变成一条 user 消息。
      // 剥壳：at、source、ref 不出门（那些是给 UI 与账本的）。
      return { role: "user", content: [...m.content] };

    default:
      return null; // 自定义种类：缺省隐形
  }
}

/**
 * 线上协议要求：一批工具的全部 tool_result 必须在**同一条** user 消息里、
 * 紧跟带 tool_use 的 assistant 消息之后。transcript 里它们是逐条的 ToolResultMessage，
 * 投影时把相邻的合并回一条。
 */
function mergeAdjacentToolResults(msgs: ProviderMessage[]): ProviderMessage[] {
  const out: ProviderMessage[] = [];
  for (const m of msgs) {
    const prev = out[out.length - 1];
    if (prev !== undefined && isToolResultOnly(prev) && isToolResultOnly(m)) {
      prev.content.push(...m.content);
      continue;
    }
    out.push({ role: m.role, content: [...m.content] } as ProviderMessage);
  }
  return out;
}

function isToolResultOnly(m: ProviderMessage): boolean {
  return m.role === "user" && m.content.length > 0 && m.content.every((b) => b.type === "tool_result");
}
