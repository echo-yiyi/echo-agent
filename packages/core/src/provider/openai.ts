// OpenAI 兼容方言 + kimi / deepseek 两个内建 provider。
//
// 一个方言覆盖一整片生态:kimi(moonshot)、deepseek、openai 本尊、任何 chat/completions
// 兼容网关——它们只差 baseUrl、模型目录、取 key 的环境变量,方言本体一行不差。
// fetch 直写,**零新依赖**;`fetchFn` 可注入(测试喂假的 SSE,不碰网络)。
//
// 方言只做翻译(DO/DON'T 见 dialect.ts 头注):重试、partial 累积、错误抢救都在
// `createProviderStreams` 壳里,这里**不重试、不累积观测 partial**;
// 但 `done.message` 是**定稿权威**,所以方言必须自己攒最终消息(与观测 partial 是两回事)。
//
// 用法(产品端三行):
// ```ts
// const models = new Models();
// models.setProvider(kimiProvider());
// new Agent({ model: models.getModel("kimi", "kimi-k3")!, streamFunction: (m, c, o) => models.stream(m, c, o) });
// ```

import { agentError, errText, type AgentError } from "../errors.ts";
import type { ProviderEvent } from "../events.ts";
import type {
  AssistantMessage,
  ContentBlock,
  Context,
  ProviderMessage,
  StopReason,
  ThinkingBlock,
  Usage,
} from "../messages.ts";
import { createProviderStreams, type Dialect } from "./dialect.ts";
import { createProvider } from "./models.ts";
import type { Model, Provider, ProviderAuth, StreamOptions } from "./types.ts";

export const OPENAI_COMPLETIONS_API = "openai-completions";

/** 思考通道的字段名。**顺序即优先级**，与 pi 的 `OPENAI_COMPLETIONS_REASONING_FIELDS` 同一份。 */
const REASONING_FIELDS = ["reasoning_content", "reasoning", "reasoning_text"] as const;
type ReasoningField = (typeof REASONING_FIELDS)[number];
const isReasoningField = (v: string | undefined): v is ReasoningField =>
  v !== undefined && (REASONING_FIELDS as readonly string[]).includes(v);

/**
 * Z.AI(GLM) 的 thinking 开关。形状取自 pi 的 `openai-completions.ts`（`thinkingFormat: "zai"` 分支）：
 * `{ type: "enabled", clear_thinking: false }` = 开着且**不要清掉**上一轮的思考——
 * preserved thinking 要的就是这个，配合请求侧把 `reasoning_content` 原样带回，多轮 tool loop 才闭合。
 */
const THINKING_ENABLED = { thinking: { type: "enabled", clear_thinking: false } } as const;

/**
 * 关掉 thinking。**MiniMax M3 用它**（M3 官方可以关；关不掉的 M2.x 已从目录摘掉）。
 *
 * **两个常量必须并存，不是重复**：GLM 走「开着并回传」，MiniMax 走「关掉」，是两家不同的取舍。
 * 本文件合并 #32 与 #33 两条线时，自动合并一度只留下 `THINKING_ENABLED`，
 * MiniMax 那行于是引用了一个不存在的名字——typecheck 当场判红（review 用 merge-tree 提前预测到）。
 * 形状与 GLM 那个恰好同族（都是 `thinking: { type }`），但各自依据各自厂商文档，不是同一套协议。
 */
const THINKING_DISABLED = { thinking: { type: "disabled" } } as const;

export type OpenAiDialectOptions = {
  /** 形如 `https://api.moonshot.cn/v1`(不带 /chat/completions)。 */
  baseUrl: string;
  /** 方言 id,缺省 "openai-completions"。 */
  api?: string;
  /** 测试注入:喂一段假 SSE,零网络。 */
  fetchFn?: typeof fetch;
  /**
   * **回放的 assistant 消息一律带上 `reasoning_content` 字段**（没有思考就带空串）。
   *
   * 为什么需要这么一条：DeepSeek 在 reasoning 打开时要求每条回放的 assistant 消息都有这个字段，
   * 缺了会被拒（pi 的 `requiresReasoningContentOnAssistantMessages`，探测规则就是 `isDeepSeek`，
   * 是他们对着真端点趟出来的）。
   *
   * 本仓还有第二个用处：**2026-08-28 之前落盘的会话里没有 thinking 块**（那时思考被当观测丢掉了），
   * 恢复后停在工具循环中间的那一格，会把「没有 reasoning 的 assistant + 工具结果」一起发回去。
   * 带上空串就不会因为缺字段被拒——**它补的是字段在不在，不是把思考编出来**：
   * 当初没存下来的思考，谁也变不回来。
   */
  alwaysSendReasoningField?: boolean;
};

/* ═══════════════════ 方言 ═══════════════════ */

export function openAiDialect(opts: OpenAiDialectOptions): Dialect {
  const doFetch = opts.fetchFn ?? fetch;
  const url = `${opts.baseUrl.replace(/\/+$/, "")}/chat/completions`;

  return {
    api: opts.api ?? OPENAI_COMPLETIONS_API,

    async *request(model: Model, context: Context, options?: StreamOptions): AsyncIterable<ProviderEvent> {
      let res: Response;
      try {
        res = await doFetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(options?.apiKey !== undefined ? { authorization: `Bearer ${options.apiKey}` } : {}),
            ...options?.headers,
          },
          body: JSON.stringify(buildRequest(model, context, opts.alwaysSendReasoningField === true)),
          ...(options?.signal !== undefined ? { signal: options.signal } : {}),
        });
      } catch (e) {
        // 预期失败编码成 error 事件,不 throw(throw 只留给 bug)
        yield { type: "error", error: classifyThrown(e) };
        return;
      }

      if (!res.ok) {
        yield { type: "error", error: await classifyHttp(res) };
        return;
      }
      if (res.body === null) {
        yield { type: "error", error: agentError("provider", "protocol", "响应没有 body(不是流)", false) };
        return;
      }

      yield { type: "start" };
      const turn = new Turn(model);

      try {
        for await (const data of sseLines(res.body)) {
          if (data === "[DONE]") break;
          let chunk: OpenAiChunk;
          try {
            chunk = JSON.parse(data) as OpenAiChunk;
          } catch {
            yield { type: "warning", code: "bad_chunk", message: `不可解析的 SSE 段(已跳过):${data.slice(0, 120)}` };
            continue;
          }
          // 部分网关把错误塞在流里发
          if (chunk.error !== undefined) {
            yield { type: "error", error: agentError("provider", "protocol", chunk.error.message ?? "上游在流中报错", false) };
            return;
          }
          yield* turn.feed(chunk);
        }
      } catch (e) {
        yield { type: "error", error: classifyThrown(e) };
        return;
      }

      yield* turn.finish();
    },

    classifyError: (e) => (isAbort(e) || e instanceof TypeError ? classifyThrown(e) : null),
  };
}

/* ─────────────── 请求体:Context → chat/completions ─────────────── */

function buildRequest(model: Model, context: Context, alwaysSendReasoningField: boolean): Record<string, unknown> {
  const messages: Record<string, unknown>[] = [];
  if (context.systemPrompt !== null && context.systemPrompt !== "") {
    messages.push({ role: "system", content: context.systemPrompt });
  }
  for (const m of context.messages) messages.push(...convertMessage(m, model, alwaysSendReasoningField));

  const body: Record<string, unknown> = { model: model.id, messages, stream: true, stream_options: { include_usage: true } };
  if (context.tools.length > 0) {
    body.tools = context.tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.input_schema },
    }));
  }
  if (model.capabilities?.maxOutputTokens !== undefined) body.max_tokens = model.capabilities.maxOutputTokens;
  return { ...body, ...model.params }; // params 最后:显式调参赢过一切缺省
}

/**
 * 这段思考是不是**当前这个模型**产的。三元组全等才算——与 pi 的 `transform-messages.ts` 同一口径。
 *
 * **没有 `origin` 一律判为跨源**（2026-08-28 之前落盘的老会话、或某个方言忘了盖）：
 * 保守方向是「不回放」而不是「赌它同源」——赌错的代价是把别家的不透明数据发出去。
 */
function isSameOrigin(origin: ThinkingBlock["origin"], model: Model): boolean {
  if (origin === undefined) return false;
  return origin.provider === model.provider && origin.api === model.api && origin.model === model.id;
}

function convertMessage(m: ProviderMessage, model: Model, alwaysSendReasoningField: boolean): Record<string, unknown>[] {
  if (m.role === "assistant") {
    let text = "";
    const toolCalls: Record<string, unknown>[] = [];
    // 思考按**来源字段**分组回传：同一轮里理论上只有一个字段，但分组比假设更稳
    const reasoning = new Map<ReasoningField, string[]>();
    for (const b of m.content) {
      if (b.type === "text") text += b.text;
      else if (b.type === "thinking") {
        // **回放要两个条件同时成立**（review 三轮 P1 + 四轮 P1）：
        //   ① **同源**——`signature` 是 provider 不透明数据，只对同 provider + 同 api + 同 model 有意义。
        //      跨源回放实测会把上一家的 `reasoning_content` 原样发给下一家（DeepSeek/GLM 的历史切到
        //      gpt-4.1 就是这样），轻则 400，重则违反签名不得跨家使用的契约。判据照 pi 的
        //      `transform-messages.ts`：三元组全等才算同源。
        //   ② **有合法签名**——上一版只判 ①，同源而没签名时**兜底成 `reasoning_content`**，
        //      于是「未收口就报错」留下的半截思考（那时签名还没到）会在下一次同模型调用里被发出去，
        //      与本文件自己写的「没签名 ⇒ 不可回放」正好相反（review 四轮实测复现）。
        //      **兜底字段名这件事本身就是错的**：不知道该写回哪个字段，就说明它不是可回放数据。
        // 两个条件写在**同一个** if 里而不是先存进 `const replayable`：
        // `isReasoningField` 是类型守卫，存成布尔值之后 TS 的窄化就丢了，
        // 下面那行 `const field = b.signature` 会退回 `string | undefined`（tsc 当场判红）。
        if (!isSameOrigin(b.origin, model) || !isReasoningField(b.signature)) {
          // 不可回放就降级，分两种：
          //  · `redacted`：正文本来就没有、只剩签名——**直接丢弃**，它对别家一个字节的意义都没有；
          //  · 普通思考：**降级成正文**（保留内容给下一家当上下文），但**不带签名回传**。
          if (b.redacted !== true && b.thinking !== "") text += b.thinking;
          continue;
        }
        const field = b.signature;
        const bucket = reasoning.get(field) ?? [];
        bucket.push(b.thinking);
        reasoning.set(field, bucket);
      } else if (b.type === "tool_use") {
        toolCalls.push({ id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } });
      }
    }
    const out: Record<string, unknown> = { role: "assistant", content: text === "" ? null : text };
    // **原样带回上一轮的思考**：Z.AI Coding Plan、MiniMax M2.x 这类开着 preserved thinking 的家，
    // 工具结果回来时缺了它，服务端的 tool loop 就不闭合（2026-08-28 review P0 的根因）。
    for (const [field, parts] of reasoning) out[field] = parts.join("\n");
    // 没有思考可带、而这家又要求字段在场时，补一个**空串**——补的是字段在不在。
    // 命中这条的两种情形：① DeepSeek 的协议要求；② 2026-08-28 之前落盘的老会话里没有 thinking 块。
    if (alwaysSendReasoningField && model.capabilities?.reasoning === true && out["reasoning_content"] === undefined) {
      out["reasoning_content"] = "";
    }
    if (toolCalls.length > 0) out.tool_calls = toolCalls;
    return [out];
  }

  // user:tool_result 块 → role:"tool" 消息(OpenAI 的格式);其余合成一条 user
  const out: Record<string, unknown>[] = [];
  const parts: Record<string, unknown>[] = [];
  for (const b of m.content) {
    if (b.type === "tool_result") {
      out.push({
        role: "tool",
        tool_call_id: b.tool_use_id,
        content: b.is_error ? `[工具执行失败]\n${b.content}` : b.content,
      });
    } else if (b.type === "text") {
      parts.push({ type: "text", text: b.text });
    } else if (b.type === "image") {
      parts.push({ type: "image_url", image_url: { url: `data:${b.mimeType};base64,${b.data}` } });
    }
  }
  if (parts.length > 0) {
    const textOnly = parts.every((p) => p.type === "text");
    out.push({ role: "user", content: textOnly ? parts.map((p) => p.text as string).join("") : parts });
  }
  return out;
}

/* ─────────────── 响应流:chunk → ProviderEvent(块三拍) ─────────────── */

type OpenAiChunk = {
  choices?: {
    delta?: {
      content?: string | null;
      /**
       * 思考通道。**字段名各家不统一**：`reasoning_content`（deepseek / kimi / zai / 多数国内家）、
       * `reasoning`（openrouter 一系）、`reasoning_text`（llama.cpp 一系）。
       * 收到哪个就记住哪个（进 `ThinkingBlock.signature`），下一轮原样写回同一个字段——
       * 写错字段等于没带回去（字段名单与做法都对齐 pi 的 `openai-completions.ts`）。
       */
      reasoning_content?: string | null;
      reasoning?: string | null;
      reasoning_text?: string | null;
      tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[];
    };
    finish_reason?: string | null;
  }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    /** OpenAI 系：缓存命中的输入。 */
    prompt_tokens_details?: { cached_tokens?: number } | null;
    /** DeepSeek：缓存命中的输入（miss 那半就是普通输入，不另记）。 */
    prompt_cache_hit_tokens?: number;
  } | null;
  error?: { message?: string };
};

/**
 * 一轮响应的状态机 + 定稿累积。
 * 块不变量(dialect.ts ①②)由 `ensure`/`close` 保证:同一时刻至多一个块打开,end 必配 start。
 */
class Turn {
  private open: "text" | "thinking" | "tool" | null = null;
  private blocks: ContentBlock[] = [];
  private textBuf = "";
  /** 思考也要**缓冲**：只转发事件而不攒起来，定稿里就没有这一块，下一轮也就带不回去。 */
  private thinkingBuf = "";
  /** 这一轮的思考来自哪个字段。缺省用最通行的那个。 */
  private reasoningField: ReasoningField = "reasoning_content";
  private tool: { id: string; name: string; args: string } | null = null;
  private pendingWarnings: ProviderEvent[] = [];
  private usage: Usage | null = null;
  private stop: StopReason = "end_turn";

  constructor(private readonly model: Model) {}

  *feed(chunk: OpenAiChunk): Generator<ProviderEvent> {
    const choice = chunk.choices?.[0];
    const delta = choice?.delta;

    for (const field of REASONING_FIELDS) {
      const chunkText = delta?.[field];
      if (chunkText == null || chunkText === "") continue;
      this.reasoningField = field; // 记住来源字段：回传要写回同一个
      yield* this.ensure("thinking");
      this.thinkingBuf += chunkText;
      yield { type: "thinking_delta", text: chunkText };
      break; // 有的端点同一段思考在两个字段里各发一份，别累加两遍
    }
    if (delta?.content != null && delta.content !== "") {
      yield* this.ensure("text");
      this.textBuf += delta.content;
      yield { type: "text_delta", text: delta.content };
    }
    for (const tc of delta?.tool_calls ?? []) {
      if (tc.id !== undefined && tc.id !== "") {
        // 新的一个调用:换块
        yield* this.close();
        this.open = "tool";
        this.tool = { id: tc.id, name: tc.function?.name ?? "", args: "" };
        yield { type: "toolcall_start", toolCallId: tc.id, name: this.tool.name };
      }
      const args = tc.function?.arguments;
      if (args !== undefined && args !== "") {
        if (this.tool === null) continue; // 违约:没 start 就来参数,丢弃这段
        this.tool.args += args;
        yield { type: "toolcall_delta", argsText: args };
      }
    }
    if (choice?.finish_reason != null) this.stop = mapStop(choice.finish_reason);
    if (chunk.usage != null) {
      // 缓存命中：两种上报形状择一（OpenAI 系 / DeepSeek）。没报就不带字段——不冒充报了账。
      const cached = chunk.usage.prompt_tokens_details?.cached_tokens ?? chunk.usage.prompt_cache_hit_tokens;
      this.usage = {
        inputTokens: chunk.usage.prompt_tokens ?? 0,
        outputTokens: chunk.usage.completion_tokens ?? 0,
        ...(typeof cached === "number" ? { cachedInputTokens: cached } : {}),
      };
    }
  }

  /** 收尾:关掉未收口的块,发定稿。 */
  *finish(): Generator<ProviderEvent> {
    yield* this.close();
    yield* this.takeWarnings();
    const message: AssistantMessage = {
      role: "assistant",
      content: this.blocks,
      stopReason: this.stop,
      usage: this.usage, // null = 上游没报,**不填 0 冒充报了账**
      model: { provider: this.model.provider, id: this.model.id },
    };
    yield { type: "done", message };
  }

  private *ensure(kind: "text" | "thinking"): Generator<ProviderEvent> {
    if (this.open === kind) return;
    yield* this.close();
    this.open = kind;
    yield kind === "text" ? { type: "text_start" } : { type: "thinking_start" };
  }

  private *close(): Generator<ProviderEvent> {
    const open = this.open;
    this.open = null;
    if (open === "text") {
      if (this.textBuf.length > 0) this.blocks.push({ type: "text", text: this.textBuf });
      this.textBuf = "";
      yield { type: "text_end" };
    } else if (open === "thinking") {
      // 思考**进 content**，并把来源字段名当作不透明签名一起存下（与 MessageAccumulator 同款取舍）。
      // `origin` 也必须在这里盖：**两处构造 thinking 块的地方一个都不能漏**——
      // 漏一处的后果不是「少个字段」，而是同源被误判成跨源、回放被静默降级（写这条时实测判红）。
      if (this.thinkingBuf.length > 0) {
        this.blocks.push({
          type: "thinking",
          thinking: this.thinkingBuf,
          signature: this.reasoningField,
          origin: { provider: this.model.provider, api: this.model.api, model: this.model.id },
        });
      }
      this.thinkingBuf = "";
      yield { type: "thinking_end", signature: this.reasoningField };
    } else if (open === "tool") {
      const t = this.tool;
      this.tool = null;
      if (t !== null) {
        const parsed = parseArgs(t.args);
        if (parsed === null) {
          this.pendingWarnings.push({
            type: "warning",
            code: "tool_call_dropped",
            message: `工具调用 '${t.name}' 的参数 JSON 不可解析,已丢弃(未执行)`,
          });
        } else {
          this.blocks.push({ type: "tool_use", id: t.id, name: t.name, input: parsed });
        }
      }
      yield { type: "toolcall_end" };
    }
    yield* this.takeWarnings();
  }

  private *takeWarnings(): Generator<ProviderEvent> {
    const w = this.pendingWarnings;
    this.pendingWarnings = [];
    yield* w;
  }
}

function mapStop(reason: string): StopReason {
  if (reason === "tool_calls") return "tool_use";
  if (reason === "length") return "max_tokens";
  return "end_turn"; // "stop" 与其余未知值
}

function parseArgs(raw: string): Record<string, unknown> | null {
  const s = raw.trim();
  if (s === "") return {};
  try {
    const v: unknown = JSON.parse(s);
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/* ─────────────── SSE 解析(逐行,跨 chunk 缓冲) ─────────────── */

async function* sseLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trimEnd();
        buf = buf.slice(nl + 1);
        if (line.startsWith("data:")) yield line.slice(5).trim();
      }
    }
    const tail = buf.trimEnd();
    if (tail.startsWith("data:")) yield tail.slice(5).trim();
  } finally {
    reader.releaseLock();
  }
}

/* ─────────────── 错误归类 ─────────────── */

async function classifyHttp(res: Response): Promise<AgentError> {
  const text = await res.text().catch(() => "");
  const msg = `HTTP ${res.status}:${text.slice(0, 500)}`;
  if (res.status === 401 || res.status === 403) return agentError("provider", "auth", msg, false);
  if (res.status === 429) return agentError("provider", "rate_limit", msg);
  if (res.status >= 500) return agentError("provider", "server", msg);
  if (res.status === 400 && /context|length|token/i.test(text)) return agentError("provider", "context_overflow", msg, false);
  return agentError("provider", "protocol", msg, false);
}

function classifyThrown(e: unknown): AgentError {
  if (isAbort(e)) return agentError("provider", "aborted", "请求被中止", false);
  // fetch 的连接失败是 TypeError——「再试一次可能就好了」
  return agentError("provider", "network", errText(e));
}

function isAbort(e: unknown): boolean {
  return e instanceof DOMException && e.name === "AbortError";
}

/* ═══════════════════ 内建 provider:kimi / deepseek ═══════════════════ */

export type BuiltinProviderOptions = {
  /** 覆盖端点(自建网关/代理)。kimi 另认 ECHO_LLM_BASE_URL 环境变量。 */
  baseUrl?: string;
  /** 测试注入。 */
  fetchFn?: typeof fetch;
};

/** 从环境变量取 key,**按声明顺序择一**。resolve 报告「配好了没」——undefined = 未配置,上层诚实拒跑。 */
function envApiKey(...names: string[]): ProviderAuth {
  return {
    apiKey: {
      async resolve() {
        for (const name of names) {
          const v = readEnv(name);
          if (v !== undefined && v !== "") return { apiKey: v, env: name };
        }
        return undefined;
      },
    },
  };
}

function readEnv(name: string): string | undefined {
  return (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[name];
}

/**
 * Kimi(moonshot)。key:`MOONSHOT_API_KEY` / `ECHO_LLM_API_KEY` 择一(与 EDD 同口径)。
 *
 * 目录按 2026-09-01 官方文档（platform.kimi.com；`platform.moonshot.cn/docs` 已 301 过去，API 域名没变）：
 * 现役四款；`kimi-k2` 整个系列 2026-05-25 下线（含上一版表里的 `kimi-k2-turbo-preview`，调用回 404）。
 * 四款都收图、思考都走 `reasoning_content`：K3 与 K2.7-code 思考常开（K3 的深度走 `reasoning_effort`，
 * 缺省 `max`），K2.6 缺省开、可关。`.cn` 与 `.ai` 两站模型 id 相同，key 不通用。
 *
 * **不填 `maxOutputTokens`**：官方只给缺省输出（K3 131,072、K2.x 32,768），上限没有明确数字，
 * 而且 K3 的 `max_tokens` 已标 deprecated（改 `max_completion_tokens`）。方言只在该字段有值时才发
 * `max_tokens`（见 `buildRequest`），留空即不发、由服务端用缺省——与 MiniMax 那条同一规矩：没确认的数宁可不发。
 */
export function kimiProvider(opts: BuiltinProviderOptions = {}): Provider {
  const baseUrl = opts.baseUrl ?? readEnv("ECHO_LLM_BASE_URL") ?? "https://api.moonshot.cn/v1";
  return createProvider({
    id: "kimi",
    name: "Kimi (Moonshot)",
    baseUrl,
    auth: envApiKey("MOONSHOT_API_KEY", "ECHO_LLM_API_KEY"),
    // 目录里不止一个模型，不声明缺省的话 `await createAgent({ provider })` 会 fail-loud（D17 第 4 级）。
    // 选 K3 是官方口径：「建议优先从 Kimi K3 开始」；追求出字速度的编程场景官方推 k2.7-code-highspeed。
    defaultModelId: "kimi-k3",
    models: [
      { id: "kimi-k3", api: OPENAI_COMPLETIONS_API, name: "Kimi K3", capabilities: { reasoning: true, vision: true, contextWindow: 1_048_576 } },
      { id: "kimi-k2.7-code", api: OPENAI_COMPLETIONS_API, name: "Kimi K2.7 Code", capabilities: { reasoning: true, vision: true, contextWindow: 262_144 } },
      { id: "kimi-k2.7-code-highspeed", api: OPENAI_COMPLETIONS_API, name: "Kimi K2.7 Code HighSpeed", capabilities: { reasoning: true, vision: true, contextWindow: 262_144 } },
      { id: "kimi-k2.6", api: OPENAI_COMPLETIONS_API, name: "Kimi K2.6", capabilities: { reasoning: true, vision: true, contextWindow: 262_144 } },
    ],
    api: createProviderStreams(openAiDialect({ baseUrl, ...(opts.fetchFn !== undefined ? { fetchFn: opts.fetchFn } : {}) })),
  });
}

/**
 * GPT-5.x 在 Chat Completions 上带工具调用时，`reasoning_effort` 只许 `none`——官方迁移指南原话：
 * 「Starting with GPT-5.4, Chat Completions does not support tool calling with `reasoning_effort`
 * values other than `none`」。本仓只有 chat/completions 方言、每个请求都带工具，所以 GPT-5.x 进目录
 * 就得把推理关掉：它们在这里是**高配的非推理模型**，因此不标 `reasoning`（chat/completions 本来也
 * 不回传任何 reasoning 文本，标了就是许诺一个不存在的思考通道）。要推理 + 工具，得先有 Responses 方言。
 */
const OPENAI_REASONING_OFF = { reasoning_effort: "none" } as const;

/**
 * OpenAI 本家。key:`OPENAI_API_KEY`。目录按 2026-09-01 官方文档（developers.openai.com，
 * `platform.openai.com/docs` 已 301 过去）。
 *
 * GPT-5.6 三档（Sol / Terra / Luna，2026-07-09 发布）是现役旗舰、Chat Completions 支持，但见
 * `OPENAI_REASONING_OFF`。`gpt-4.1` / `gpt-4.1-mini` 是原生非推理模型、`max_tokens` 原生可用，保留。
 * `gpt-4o` / `gpt-4o-mini` 摘掉：2024 的一代，已被 4.1-mini / 5.6 Luna 覆盖，且 `gpt-4o-2024-05-13`
 * 快照 2026-10-23 关停。`gpt-5` / `gpt-5-mini` / `gpt-5-nano` 不进：2026-12-11 关停。
 * `gpt-5.3-codex` 等 Responses-only 的模型不进：本仓没有那个方言。
 *
 * **GPT-5.6 不填 `maxOutputTokens`**：官方把 `max_tokens` 标成 deprecated（改 `max_completion_tokens`，
 * 且上限含 reasoning token），方言只发 `max_tokens`（见 `buildRequest`），留空即不发。
 */
export function openaiProvider(opts: BuiltinProviderOptions = {}): Provider {
  const baseUrl = opts.baseUrl ?? "https://api.openai.com/v1";
  return createProvider({
    id: "openai",
    name: "OpenAI",
    baseUrl,
    auth: envApiKey("OPENAI_API_KEY", "ECHO_LLM_API_KEY"),
    // 官方 Codex 模型文档：「If you are unsure, start with Sol」；Terra 给子代理类轻活，Luna 最便宜
    defaultModelId: "gpt-5.6-sol",
    models: [
      { id: "gpt-5.6-sol", api: OPENAI_COMPLETIONS_API, name: "GPT-5.6 Sol", capabilities: { vision: true, contextWindow: 1_050_000 }, params: OPENAI_REASONING_OFF },
      { id: "gpt-5.6-terra", api: OPENAI_COMPLETIONS_API, name: "GPT-5.6 Terra", capabilities: { vision: true, contextWindow: 1_050_000 }, params: OPENAI_REASONING_OFF },
      { id: "gpt-5.6-luna", api: OPENAI_COMPLETIONS_API, name: "GPT-5.6 Luna", capabilities: { vision: true, contextWindow: 1_050_000 }, params: OPENAI_REASONING_OFF },
      { id: "gpt-4.1", api: OPENAI_COMPLETIONS_API, name: "GPT-4.1", capabilities: { contextWindow: 1_047_576, maxOutputTokens: 32_768, vision: true } },
      { id: "gpt-4.1-mini", api: OPENAI_COMPLETIONS_API, name: "GPT-4.1 mini", capabilities: { contextWindow: 1_047_576, maxOutputTokens: 32_768, vision: true } },
    ],
    api: createProviderStreams(openAiDialect({ baseUrl, ...(opts.fetchFn !== undefined ? { fetchFn: opts.fetchFn } : {}) })),
  });
}

/**
 * 智谱 GLM 的 coding 端点（pi 那边叫 `zai-coding-cn`）。key:`ZAI_CODING_CN_API_KEY`。
 *
 * 目录按 2026-09-01 官方 Coding Plan 文档（docs.bigmodel.cn/cn/coding-plan/overview）：该端点**只真正
 * 服务两个模型** `glm-5.3` / `glm-5.3-flash`；旧 id 服务端静默改路由（`glm-5.1` / `glm-5.2` → 5.3，
 * `glm-4.7` / `glm-5-turbo` → 5.3-flash），`glm-4.5-air` 文档已不提。上一版那四条留着就是
 * 「选的是 A、跑的是 B」，所以整表换掉。该端点按订阅额度计费，不是按 token。
 *
 * **thinking 开着，且 `clear_thinking: false`**（2026-08-28：`ThinkingBlock` 落地之后的正解）。
 * 5.3 系 thinking **关不掉**（`type: "disabled"` 被拒，深度走 `reasoning_effort` low / high / max，缺省 max）；
 * preserved thinking 要求工具结果回来时原样带回上一轮 `reasoning_content`——方言两侧都做到了
 * （收时记来源字段进 `ThinkingBlock.signature`，发时写回同一个字段）。
 * `maxOutputTokens` 官方口径「128K」，沿用上一版（取自 pi 同一端点的目录）的 131_072。
 */
export function zaiCodingProvider(opts: BuiltinProviderOptions = {}): Provider {
  const baseUrl = opts.baseUrl ?? "https://open.bigmodel.cn/api/coding/paas/v4";
  return createProvider({
    id: "zai-coding-cn",
    name: "Z.AI Coding CN (GLM)",
    baseUrl,
    auth: envApiKey("ZAI_CODING_CN_API_KEY", "ZHIPU_API_KEY", "ECHO_LLM_API_KEY"),
    // 官方旗舰；flash 是 1/10 价、唯一收图的那个
    defaultModelId: "glm-5.3",
    models: [
      { id: "glm-5.3", api: OPENAI_COMPLETIONS_API, name: "GLM-5.3", capabilities: { reasoning: true, contextWindow: 1_000_000, maxOutputTokens: 131_072 }, params: THINKING_ENABLED },
      { id: "glm-5.3-flash", api: OPENAI_COMPLETIONS_API, name: "GLM-5.3-Flash", capabilities: { reasoning: true, vision: true, contextWindow: 1_000_000, maxOutputTokens: 131_072 }, params: THINKING_ENABLED },
    ],
    api: createProviderStreams(openAiDialect({ baseUrl, ...(opts.fetchFn !== undefined ? { fetchFn: opts.fetchFn } : {}) })),
  });
}

/**
 * MiniMax。key:`MINIMAX_API_KEY`。目录**只有 `MiniMax-M3`**，走 OpenAI 兼容端点。
 *
 * **为什么只有 M3、为什么 M2.x 不进来**（2026-08-30 用户拍板，review 二轮 P1；2026-09-01 按官方文档复核仍成立，
 * 含现役的 `MiniMax-M2.7` / `-highspeed`）：M2.x 的 thinking **关不掉**——不传 `reasoning_split` 时它混在正文的
 * `<think>` 里被当用户可见文本输出，传了则思考走 `reasoning_details` 字段（本方言只认 `REASONING_FIELDS` 那三个）
 * 且要求多轮工具调用时原样回传。留着它就是导出一个已知跑不对的模型。
 * **M3 官方明确可以关 thinking**（`thinking: { type: "disabled" }`；不传 = `adaptive`，开着），所以这一批不必先改
 * 消息契约：`params` 直发 disabled（形状与 GLM 那边**恰好相同**，共用同一个常量只是省一份字面量，
 * 不是在声称两家是同一套协议——各自依据各自厂商文档）。M3 收图（`image_url` / `video_url`），1M 上下文（官方保底 512K）。
 *
 * **`maxOutputTokens` 故意留空**：官方上限 524,288 是 `max_completion_tokens` 的口径，`max_tokens` 已标 legacy；
 * 而方言只在该字段有值时才发 `max_tokens`（见 `buildRequest`），留空即不发，由服务端用自己的默认值（官方建议 131,072）。
 * 上一版填的 131072 来自 pi 的 **Anthropic 目录**，被「假 fetch 无条件收下请求」的测试测成了绿——
 * **没确认准确上限之前，宁可不发也不发一个抄错的数**。
 *
 * **仍未经真 key 实跑验证**：本仓只有 OpenAI 兼容方言（pi 那边 minimax 走 `anthropic-messages`），
 * 假 fetch 只能证明请求体长什么样，证明不了端点接受它。base URL 按账号所在区可能要调
 * （国内站官方文档现在写的是 `https://api.minimax.cn/v1`，传 `minimaxProvider({ baseUrl })`；CLI 没有 `--base-url`）。
 * 不因为进了 CLI 清单就当它验证过。
 */
export function minimaxProvider(opts: BuiltinProviderOptions = {}): Provider {
  const baseUrl = opts.baseUrl ?? "https://api.minimax.io/v1";
  return createProvider({
    id: "minimax",
    name: "MiniMax",
    baseUrl,
    auth: envApiKey("MINIMAX_API_KEY", "ECHO_LLM_API_KEY"),
    defaultModelId: "MiniMax-M3",
    models: [
      // 不标 `reasoning: true`：thinking 是关掉的，标了就是许诺一个本批并不打开的通道。
      // 不填 `maxOutputTokens`：理由见上，宁可不发 `max_tokens`。
      { id: "MiniMax-M3", api: OPENAI_COMPLETIONS_API, name: "MiniMax-M3", capabilities: { vision: true, contextWindow: 1_000_000 }, params: THINKING_DISABLED },
    ],
    api: createProviderStreams(openAiDialect({ baseUrl, ...(opts.fetchFn !== undefined ? { fetchFn: opts.fetchFn } : {}) })),
  });
}

/**
 * DeepSeek。key:`DEEPSEEK_API_KEY`。目录按 2026-09-01 官方文档（api-docs.deepseek.com）+ 实测 `GET /models`：只有 V4 三款。
 *
 * `deepseek-chat` / `deepseek-reasoner` 官方 2026-04-24 宣布、2026-07-24 退役（分别路由到 v4-flash 的非思考 / 思考
 * 模式；实测今天还能打通，但 `/models` 已不列、文档已不提——没文档的余量不当正式 id）。
 * 三款都是 1M 上下文、思考缺省**开**（`thinking: { type: "enabled" }`，可传 `disabled` 关掉；深度 `reasoning_effort`
 * low / high / max，缺省 high），思考走 `reasoning_content`；只有 `-vision-exp` 收图，别的模型给图回 400。
 *
 * **`alwaysSendReasoningField` 只在这一家开**：官方明文——带 `tools` 的请求，后续每一轮都必须把 `reasoning_content`
 * 原样回传（**包括没发生工具调用的轮次**），缺了回 400。自建网关指向 DeepSeek 的话，调用方要自己传这个选项——**我们不按 URL 猜**。
 *
 * **不填 `maxOutputTokens`**：官方只给上限「384K」、没给精确数字和缺省值，按「没确认的数宁可不发」留空。
 */
export function deepseekProvider(opts: BuiltinProviderOptions = {}): Provider {
  const baseUrl = opts.baseUrl ?? "https://api.deepseek.com";
  return createProvider({
    id: "deepseek",
    name: "DeepSeek",
    baseUrl,
    auth: envApiKey("DEEPSEEK_API_KEY"),
    // 旧缺省 `deepseek-chat` 官方就是路由到 v4-flash，价格连续；pro 是 3 倍价，官方自己的 agent 配置把它当主模型、flash 给子代理
    defaultModelId: "deepseek-v4-flash",
    models: [
      { id: "deepseek-v4-flash", api: OPENAI_COMPLETIONS_API, name: "DeepSeek V4 Flash", capabilities: { reasoning: true, contextWindow: 1_000_000 } },
      { id: "deepseek-v4-pro", api: OPENAI_COMPLETIONS_API, name: "DeepSeek V4 Pro", capabilities: { reasoning: true, contextWindow: 1_000_000 } },
      { id: "deepseek-v4-flash-vision-exp", api: OPENAI_COMPLETIONS_API, name: "DeepSeek V4 Flash Vision (exp)", capabilities: { reasoning: true, vision: true, contextWindow: 1_000_000 } },
    ],
    api: createProviderStreams(
      openAiDialect({ baseUrl, alwaysSendReasoningField: true, ...(opts.fetchFn !== undefined ? { fetchFn: opts.fetchFn } : {}) }),
    ),
  });
}
