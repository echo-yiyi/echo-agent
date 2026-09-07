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

/**
 * **暂时没有 `agent` 参数**：「按名挑一个 agent 定义」要等 agent 打包那一步（sessions.md §4）落地。
 * 在那之前让模型点名一个身份，等于工具收下了一个没人兑现的参数——新建的那段仍然跑容器挂的那一套。
 * 少一个参数比多一个假参数好。
 */
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
      "conversation, its own working directory, and its own inbox. The new session cannot create further sessions.\n"
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

function createTool(sessions: EchoSessions): ModelTool<{ message: string; name?: string; workspace?: string }> {
  return {
    kind: "model",
    name: "session_create",
    label: "开一段会话",
    description:
      "Start another session and give it a first instruction. It runs on its own from then on: " +
      "separate conversation, separate inbox, no access to yours, same agent as you. Returns its id — " +
      "use session_send to say more to it. Its answers come back to you as messages, not as the result of this call.",
    parameters: {
      type: "object",
      properties: {
        message: { type: "string", description: "The first instruction for the new session — what you want it to do" },
        name: { type: "string", description: "Short human-readable name, e.g. 'review PR 42'" },
        workspace: { type: "string", description: "Absolute path it works in; defaults to yours" },
      },
      required: ["message"],
    },
    async execute(params) {
      if (typeof params.message !== "string" || params.message.trim() === "") {
        return toolError("message is required: a session is started to do something");
      }
      try {
        // **main: false**：经工具建的一律不是 main，所以它自己没有 session_create（扇出只有一层）
        const row = await sessions.create({
          message: params.message,
          main: false,
          ...(params.name !== undefined ? { name: params.name } : {}),
          ...(params.workspace !== undefined ? { workspace: params.workspace } : {}),
        });
        return toolOk(`Started session ${row.id} (${row.name}). It has your first message; its replies arrive as messages.`);
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
      "List the other sessions: id, name, which agent it is, whether it is running right now, and its working directory. " +
      "Closed sessions are left out unless you ask for them.",
    parameters: {
      type: "object",
      properties: {
        workspace: { type: "string", description: "Only sessions working in this directory" },
        agent: { type: "string", description: "Only sessions of this agent" },
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
