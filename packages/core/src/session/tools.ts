// 会话面的模型可见工具：`echo:sessions`。设计见 docs/design/sessions.md §7。
//
// 它们是 `EchoSessions` 的**薄壳**——语义一个字都不在这里。这一层只做两件事：把参数验成
// 那组 API 认识的形状，把结果说成模型读得懂的一句话。
//
// 两条挂载条件在装配层（`createEcho`），不在这里：
//   · 只有 main 才挂 `session_create` —— 扇出只有一层，派出去的段不会自己再派；
//   · 容器没给 `SessionRunner` 时也不挂 —— 工具不能承诺系统不交付的事：模型调了、
//     系统什么都不做，比没有这个工具更坏。
//
// ⚠️ description 是模型逐字读的 prompt 资产。

import { errText } from "../errors.ts";
import { PROMPT_ORDER, type PromptSection } from "../prompt/types.ts";
import { toolError, toolOk, type ModelTool } from "../tools/types.ts";
import type { EchoSessions, SessionRow } from "./sessions.ts";
import type { AgentDefinition } from "../agent-def/types.ts";

export type SessionToolsOptions = {
  /** 挂不挂 `session_create`。装配层按「是不是 main」与「容器给没给 runner」决定。 */
  readonly canCreate: boolean;
};

/** `echo:sessions` 这组工具。`canCreate` 为假时少一件——少的正是「派活」那件。 */
export function makeSessionTools(sessions: EchoSessions, opts: SessionToolsOptions): ModelTool[] {
  const tools: ModelTool[] = [listTool(sessions), sendTool(sessions), closeTool(sessions)];
  if (opts.canCreate) tools.unshift(createTool(sessions));
  return tools;
}

/**
 * 这组工具的习惯段（prompt 决策 2：谁拥有工具，谁在自己的段里讲它）。
 *
 * 讲的是**跨工具的习惯**，不是单件工具的用法——后者在各自的 description 里。
 * 这里要说清的只有一件：消息是异步的，发出去不等于对方看过。
 */
export function sessionToolsSection(opts: SessionToolsOptions): PromptSection {
  const create = opts.canCreate
    ? "Use session_create when a piece of work is better done by a separate agent working on its own: it gets its own " +
      "conversation, its own working directory, and its own inbox. The new session cannot create further sessions.\n" +
      "It is not a copy of you: it starts as the plain product unless you give it an agent, and it never inherits yours. " +
      "Whatever you give it can only narrow what you already have, never widen it.\n"
    : "";
  return {
    name: "tool:sessions",
    order: PROMPT_ORDER.tools + 10,
    render: () =>
      "## Other sessions\n\n" +
      "Each session is a separate agent running on its own. Messages between sessions are asynchronous: " +
      "session_send hands your message to the other session's inbox and returns immediately. It does not wait for a reply, " +
      "and there is no guarantee one ever comes. If the reply matters, say what you need and then continue with something " +
      "else; the answer arrives later as a message from that session.\n\n" +
      create +
      "A session that is not running right now is started when you message it, so you are always talking to a live " +
      "session. Where that is not possible, session_send says so and sends nothing — there is no such thing as a " +
      "message left for a session nobody will start.",
  };
}

function describe(row: SessionRow, canWake: boolean): string {
  // `phase` 为 null = **不知道**（它刚起来、状态还没落盘，或那份读不出来），不是「空闲」。
  // 把不知道说成空闲，模型会以为「现在问它马上有答复」——这正是 `status.ts` 里那条不许猜的理由。
  //
  // 没在跑的那些分两种说法：叫得醒（这个容器有 runner）= 仍然是能说话的对象；
  // 叫不醒 = 它只是盘上的一份记录，别让模型以为发过去有人看。
  const where = row.alive
    ? row.phase === null
      ? "running"
      : row.phase === "working"
        ? "running, busy"
        : "running, idle"
    : canWake
      ? "not running (will be started when you message it)"
      : "not running (cannot be reached from here)";
  return `${row.id}  ${row.name}  [${row.agent}]  ${where}  ${row.workspace}`;
}

/**
 * `agent` 参数的验形。**两种形状**（2026-09-07，角色定义）：
 * 名字（从三处来源那张表里找）或现写一份。给了别的东西就说清楚要什么，别猜。
 *
 * 现写的那份**只认三项**：多出来的键一律判红——静默丢掉一个模型以为生效了的字段，
 * 是「看起来能用其实没用」的典型，而它写下那个键正是因为它想要那个效果。
 */
function parseAgentParam(raw: unknown): { ok: true; value: string | AgentDefinition } | { ok: false; why: string } {
  if (typeof raw === "string") {
    return raw.trim() === "" ? { ok: false, why: "agent must not be empty: give a defined agent's name, or an inline definition" } : { ok: true, value: raw };
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, why: "agent must be a name (string) or an inline definition object with identity / tools / model" };
  }
  const d = raw as Record<string, unknown>;
  const extra = Object.keys(d).filter((k) => k !== "identity" && k !== "tools" && k !== "model");
  if (extra.length > 0) return { ok: false, why: `inline agent definition has no field(s) ${extra.join(", ")}; only identity, tools and model exist` };
  if (d["identity"] !== undefined && typeof d["identity"] !== "string") return { ok: false, why: "agent.identity must be a string" };
  if (d["model"] !== undefined && typeof d["model"] !== "string") return { ok: false, why: "agent.model must be a string" };
  if (d["tools"] !== undefined && (!Array.isArray(d["tools"]) || d["tools"].some((t) => typeof t !== "string"))) {
    return { ok: false, why: "agent.tools must be an array of tool names" };
  }
  if (d["identity"] === undefined && d["tools"] === undefined && d["model"] === undefined) {
    return { ok: false, why: "inline agent definition is empty: give at least one of identity, tools, model" };
  }
  return { ok: true, value: d as AgentDefinition };
}

function createTool(sessions: EchoSessions): ModelTool<{ message: string; name?: string; workspace?: string; agent?: unknown }> {
  return {
    kind: "model",
    name: "session_create",
    label: "开一段会话",
    description:
      "Start another session and give it a first instruction. It runs on its own from then on: " +
      "separate conversation, separate inbox, no access to yours. Returns its id — " +
      "use session_send to say more to it. Its answers come back to you as messages, not as the result of this call.\n" +
      "By default it runs the plain product with no agent definition. Pass 'agent' to give it one: the name of a " +
      "defined agent, or an inline definition. An inline definition may only narrow what you already have — " +
      "its tools must be a subset of yours, or the call is refused.",
    parameters: {
      type: "object",
      properties: {
        message: { type: "string", description: "The first instruction for the new session — what you want it to do" },
        name: { type: "string", description: "Short human-readable name, e.g. 'review PR 42'" },
        workspace: { type: "string", description: "Absolute path it works in; defaults to yours" },
        agent: {
          description:
            "Which agent the new session is: the name of a defined agent (e.g. 'reviewer'), or an inline definition. " +
            "Omit for the plain product. Not inherited from you.",
          oneOf: [
            { type: "string", description: "Name of a defined agent; refused if no agent by that name exists" },
            {
              type: "object",
              description: "An agent written out here and now",
              properties: {
                identity: { type: "string", description: "Replaces the product identity: who this session is" },
                tools: { type: "array", items: { type: "string" }, description: "Tool names it may use — must be a subset of yours" },
                model: { type: "string", description: "Model id; defaults to the product's" },
              },
            },
          ],
        },
      },
      required: ["message"],
    },
    async execute(params) {
      if (typeof params.message !== "string" || params.message.trim() === "") {
        return toolError("message is required: a session is started to do something");
      }
      // 验形在**动盘之前**，与 `sessions.create` 里的不越权检查同一条纪律：判红时盘上不留半段会话
      let agent: string | AgentDefinition | undefined;
      if (params.agent !== undefined) {
        const parsed = parseAgentParam(params.agent);
        if (!parsed.ok) return toolError(parsed.why);
        agent = parsed.value;
      }
      try {
        // **main: false**：经工具建的一律不是 main，所以它自己没有 session_create（扇出只有一层）
        const row = await sessions.create({
          message: params.message,
          main: false,
          ...(params.name !== undefined ? { name: params.name } : {}),
          ...(params.workspace !== undefined ? { workspace: params.workspace } : {}),
          ...(agent !== undefined ? { agent } : {}),
        });
        // 把它**是谁**说出来：模型点了名的话得能确认点中了，没点就该看到它是产品原样
        return toolOk(`Started session ${row.id} (${row.name}), agent ${row.agent}. It has your first message; its replies arrive as messages.`);
      } catch (e) {
        return toolError(errText(e));
      }
    },
  };
}

function listTool(sessions: EchoSessions): ModelTool<{ workspace?: string; agent?: string; include_closed?: boolean }> {
  return {
    kind: "model",
    name: "session_list",
    label: "会话列表",
    description:
      "List the other sessions: id, name, which agent it runs, whether it is running right now, and its working directory. " +
      "Closed sessions are left out unless you ask for them.",
    parameters: {
      type: "object",
      properties: {
        workspace: { type: "string", description: "Only sessions working in this directory" },
        agent: { type: "string", description: "Only sessions running this agent, by name ('default' means no agent definition)" },
        include_closed: { type: "boolean", description: "Include sessions that were closed" },
      },
      required: [],
    },
    async execute(params) {
      try {
        const rows = await sessions.list({
          ...(params.workspace !== undefined ? { workspace: params.workspace } : {}),
          ...(params.agent !== undefined ? { agent: params.agent } : {}),
          ...(params.include_closed === true ? { includeClosed: true } : {}),
        });
        if (rows.length === 0) return toolOk("No other sessions.");
        return toolOk(rows.map((r) => describe(r, sessions.canWake)).join("\n"));
      } catch (e) {
        return toolError(errText(e));
      }
    },
  };
}

function sendTool(sessions: EchoSessions): ModelTool<{ to: string; message: string }> {
  return {
    kind: "model",
    name: "session_send",
    label: "发给会话",
    description:
      "Send a message to another session. It lands in that session's inbox and it reads it when it is next free. " +
      "This returns as soon as the message is delivered — it does not wait for an answer, and an answer may never come. " +
      "A session that is not running is started first; if it cannot be started from here, the message is not sent and you are told so.",
    parameters: {
      type: "object",
      properties: {
        to: { type: "string", description: "Session id, from session_list" },
        message: { type: "string", description: "What to say to it" },
      },
      required: ["to", "message"],
    },
    async execute(params) {
      if (typeof params.message !== "string" || params.message === "") return toolError("message is required");
      try {
        const outcome = await sessions.send(params.to, params.message);
        if (outcome.kind === "rejected") return toolError(`Not delivered (${outcome.reason}): ${outcome.detail}`);
        // `accepted` 时对方一定活着（没在跑的已经被叫起来了），所以只有一句话可说
        return toolOk(`Delivered to ${params.to}; it will read this when free.`);
      } catch (e) {
        return toolError(errText(e));
      }
    },
  };
}

function closeTool(sessions: EchoSessions): ModelTool<{ id: string }> {
  return {
    kind: "model",
    name: "session_close",
    label: "关闭会话",
    description:
      "Close a session: it stops appearing in session_list and stops accepting messages. Its conversation is kept on disk " +
      "and a person can still reopen it. Close one when its work is done, not to interrupt it.",
    parameters: {
      type: "object",
      properties: { id: { type: "string", description: "Session id, from session_list" } },
      required: ["id"],
    },
    async execute(params) {
      try {
        await sessions.close(params.id);
        return toolOk(`Closed ${params.id}.`);
      } catch (e) {
        return toolError(errText(e));
      }
    },
  };
}
