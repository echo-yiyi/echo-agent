// 会话面：开一段、列一遍、发一句、关一段。设计见 docs/design/sessions.md §5、§7。
//
// **一组 API，三个消费者**：模型的 `session_*` 工具、壳的 `/sessions`、宿主程序（findjob 那种
// 一个进程里同时跟几十个对象聊的）。三边共用一份实现，否则「会话是什么」会长出三个版本。
//
// **纯的**：只依赖 `StorageDir` 与几个注入的探针，不碰 `node:`——「这段活着吗」要读锁文件，
// 那是宿主知识（`isAlive`）；「怎么让新的一段跑起来」更是（`run`）。core 不起进程、不管进程。

import { environmentMessage, type AgentMessage } from "../messages.ts";
import { createRecordIdSource, recordPath, serializeRecord, type InboxRecordV1 } from "../inbox/records.ts";
import type { StorageDir } from "../storage/types.ts";
import { listSessions, setSessionStatus, SessionService, assertSafeSessionId } from "./service.ts";
import { newSessionId, type SessionInfo } from "./types.ts";
import { readSessionPhase, type SessionPhase } from "./status.ts";

/** 会话间消息的 `source`。收方的 transcript 里就是一条普通 environment 消息。 */
export const SESSION_SOURCE = "session";

/**
 * 交出去的一行：`meta.json` + lease 活没活着 + `status.json`，**在这里合成一次**。
 *
 * 三个字段一起给的原因是它们必须一起读：进程崩在 working 时 `status.json` 会永远停在 working，
 * 三个消费者各组合一遍就会各错一遍。所以规矩收在 `sessionRow()` 里——`alive` 为假时 `phase` 恒为 `null`。
 */
export type SessionRow = {
  readonly id: string;
  readonly name: string;
  readonly workspace: string;
  readonly agent: string;
  readonly main: boolean;
  readonly status: SessionInfo["status"];
  /** 此刻有没有进程持有它的 lease。 */
  readonly alive: boolean;
  /** 它在忙没忙。**没活着就是 `null`**——盘上那份是死状态，不许被读成「空闲」。 */
  readonly phase: SessionPhase | null;
};

/** 开一段新会话要交代的事。`agent` / `workspace` 不给就继承建它的那一段。 */
export type CreateSessionInput = {
  readonly name?: string;
  /** 归哪个 agent（产品 / 身份名）。不给 = 跟建它的这一段同一个。 */
  readonly agent?: string;
  readonly workspace?: string;
  /**
   * 第一条消息，投进新段的 inbox。**工具面必填**（见 `echo:sessions`）：
   * 一段 session 是为了做某件事才开的，没有这条就是一个永远躺着的空目录。
   */
  readonly message: string;
  /** 经 extension 面（`session_create` 工具）建的传 false；容器自己建的是 main。 */
  readonly main?: boolean;
};

/** `send()` 的结局。`accepted` 带 `alive`：对方没进程时这句话只是留言，发送方得知道。 */
export type SendResult =
  | { readonly kind: "accepted"; readonly alive: boolean; readonly recordId: string }
  | { readonly kind: "rejected"; readonly reason: "not-found" | "closed" | "invalid"; readonly detail: string };

/**
 * 容器交给 core 的「怎么让一段新建的 session 跑起来」。core 在 `create()` 里调它一次，之后不监督。
 *
 * 返回契约：**resolve = 那段已经持有自己的 lease**（活了）；reject 或超时 = 没跑起来。
 * 进程内的实现 await 那一段 `start()`；开终端窗口的实现等它的 `.lock` 出现。
 */
export type SessionRunner = (session: SessionRow) => Promise<void>;

/** runner 迟迟不 resolve 时的上界。见 `EchoSessions.create()` 里为什么必须有一个。 */
export const DEFAULT_RUN_TIMEOUT_MS = 30_000;

/**
 * 会话面要宿主给的几件。两件是**宿主知识**、core 给不出：`isAlive` 要读锁文件（node），
 * `run` 是「怎么让新的一段跑起来」（core 不起进程）。
 */
export type EchoSessionsDeps = {
  /** 全部 session 目录的上一层。 */
  readonly root: StorageDir;
  /** 某一段自己的目录。 */
  storeFor(sessionId: string): StorageDir;
  /** 这一段此刻有没有进程持有 lease。读锁文件是宿主知识，所以注进来。 */
  isAlive(sessionId: string): Promise<boolean>;
  /** 调用方自己是哪一段（`send` 的落款、`create` 的 agent / workspace 缺省）。 */
  readonly self: () => { sessionId: string | null; agent: string; workspace: string };
  /** 怎么让新建的一段跑起来。不给 = 宿主自己负责（`session_create` 工具那时不挂）。 */
  readonly run?: SessionRunner;
  readonly runTimeoutMs?: number;
};

/** 会话面的实现。一个容器一个实例。 */
export class EchoSessions {
  /**
   * 每个收件人一个发号器。**不缓存 `InboxStore`**：那会把对方的整个 inbox 读进内存，
   * 而且随着对方消费而过期；只缓存发号器则既保序又没有增长。
   */
  private readonly idSources = new Map<string, () => string>();

  constructor(private readonly deps: EchoSessionsDeps) {}

  /**
   * 开一段新的：建目录、写 meta、把第一条消息投进它的 inbox，然后调容器给的 runner。
   *
   * **runner 那一下的失败有语义，之后才是不监督**：reject 或超时 → 判红，并把刚建的那段置
   * `closed` 留痕（不删）。不这么做就会留下一段「活着但不会跑」的孤儿——正是挂载条件想避免的东西
   * 从另一个门进来。投进去的那条消息留在盘上，closed 的段不列也不收信，它不会被消费。
   *
   * 没给 runner 时**照样建**：宿主自己知道怎么跑它（findjob 就是在进程内挂一个实例上去）。
   * 模型面不一样——`session_create` 工具在没有 runner 时压根不挂，工具不能承诺系统不交付的事。
   */
  async create(input: CreateSessionInput): Promise<SessionRow> {
    const self = this.deps.self();
    const id = newSessionId();
    assertSafeSessionId(id);
    const store = this.deps.storeFor(id);
    const svc = new SessionService(store);
    const data = await svc.createOrResume(id, {
      ...(input.name !== undefined ? { name: input.name } : {}),
      agent: input.agent ?? self.agent,
      workspace: input.workspace ?? self.workspace,
      main: input.main ?? true,
    });
    // **先落 meta 再投消息**：反过来的话，runner 失败后要置 closed 时盘上还没有 meta 可改，
    // 那条消息就成了没有归属的孤儿。`createOrResume` 有意不写 meta（空会话不留痕），所以这里显式写一次。
    await svc.commitMeta(id);
    await svc.settle();

    try {
      await this.deliver(store, id, this.envelope(self.sessionId, input.message), `${SESSION_SOURCE}:${self.sessionId ?? "host"}:${id}:first`);
    } catch (e) {
      await this.markClosed(id);
      throw new Error(
        `新会话 ${id} 的第一条消息没投进去（${e instanceof Error ? e.message : String(e)}）：已置 closed，不留一段没人跑的空会话`,
      );
    }

    const row: SessionRow = {
      id,
      name: data.info.name,
      workspace: data.info.workspace,
      agent: data.info.agent,
      main: data.info.main,
      status: "active",
      alive: false,
      phase: null,
    };

    const run = this.deps.run;
    if (run === undefined) return row; // 宿主自己跑它
    try {
      await withTimeout(run(row), this.deps.runTimeoutMs ?? DEFAULT_RUN_TIMEOUT_MS, id);
    } catch (e) {
      await this.markClosed(id);
      throw new Error(`新会话 ${id} 没跑起来（${e instanceof Error ? e.message : String(e)}）：已置 closed`);
    }
    return { ...row, alive: true, phase: "idle" };
  }

  /** 清单。缺省只列 `active` 的；`closed` 的还在盘上，要看得显式要。 */
  async list(filter?: { readonly workspace?: string; readonly agent?: string; readonly includeClosed?: boolean }): Promise<readonly SessionRow[]> {
    const infos = await listSessions(this.deps.root);
    const out: SessionRow[] = [];
    for (const info of infos) {
      if (filter?.includeClosed !== true && info.status !== "active") continue;
      if (filter?.workspace !== undefined && info.workspace !== filter.workspace) continue;
      if (filter?.agent !== undefined && info.agent !== filter.agent) continue;
      out.push(await this.rowOf(info));
    }
    return out;
  }

  /**
   * 给另一段发一句。**就是往对方的 inbox 目录写一条 record**——同进程与跨进程同一条路
   * （同进程也先落盘，不许绕过盘：否则两条语义会分叉）。
   *
   * 返回值带对方**活没活着**：发给一段没进程的 session，这句话只是躺在盘上等它下次起来。
   * 发送方得知道自己是在留言还是在对话。
   */
  async send(to: string, message: string): Promise<SendResult> {
    if (typeof to !== "string" || to === "") return { kind: "rejected", reason: "invalid", detail: "收件人不能为空" };
    try {
      assertSafeSessionId(to);
    } catch (e) {
      return { kind: "rejected", reason: "invalid", detail: e instanceof Error ? e.message : String(e) };
    }
    const infos = await listSessions(this.deps.root);
    const target = infos.find((i) => i.id === to);
    if (target === undefined) return { kind: "rejected", reason: "not-found", detail: `没有会话 ${to}` };
    if (target.status !== "active") return { kind: "rejected", reason: "closed", detail: `会话 ${to} 已经关了` };

    const self = this.deps.self();
    const ref = `${self.sessionId ?? "host"}:${newMessageId()}`;
    let recordId: string;
    try {
      recordId = await this.deliver(this.deps.storeFor(to), to, this.envelope(self.sessionId, message, ref), `${SESSION_SOURCE}:${ref}`);
    } catch (e) {
      return { kind: "rejected", reason: "invalid", detail: `写不进对方的 inbox：${e instanceof Error ? e.message : String(e)}` };
    }
    return { kind: "accepted", alive: await this.deps.isAlive(to), recordId };
  }

  /** 关一段：meta 里置 `closed`。**不删盘上的东西**——旧对话还能 `--resume` 回来看。 */
  async close(sessionId: string): Promise<void> {
    assertSafeSessionId(sessionId);
    await this.markClosed(sessionId);
  }

  /**
   * 往一段 session 的 inbox 写一条 record。**只写文件，不碰对方的内存账本**——那是对方自己的事：
   * 它会在 `restore()`（重启）或 `refresh()`（每秒轮询）时把这条读进去，去重、保序、ack 全在那一侧。
   *
   * 为什么不 `new InboxStore(对方目录).accept()`：那要先 `restore()` 一遍对方的整个 inbox
   * （只为发一条），而且每发一次就是一个**新写者**——同毫秒计数器从 0 重来，连着发两条会被
   * 随机尾巴排反（实测：「HR 回你了」「再问一句」恢复出来顺序颠倒）。所以发号器按目标缓存一份，
   * 同一个发送方发给同一段的消息因此严格有序。
   */
  private async deliver(store: StorageDir, to: string, message: AgentMessage, dedupeKey: string): Promise<string> {
    let source = this.idSources.get(to);
    if (source === undefined) {
      source = createRecordIdSource();
      this.idSources.set(to, source);
    }
    const recordId = source();
    const record: InboxRecordV1 = { recordId, dedupeKey, message, acceptedAt: Date.now() };
    await store.write(recordPath(recordId), serializeRecord(record));
    return recordId;
  }

  private async markClosed(sessionId: string): Promise<void> {
    await setSessionStatus(this.deps.storeFor(sessionId), sessionId, "closed");
  }

  private async rowOf(info: SessionInfo): Promise<SessionRow> {
    const alive = await this.deps.isAlive(info.id);
    // **没活着就没有 phase**：盘上那份是它崩掉那一刻的样子，读成「正在忙」就是拿死状态当真
    const phase = alive ? ((await readSessionPhase(this.deps.storeFor(info.id)))?.phase ?? null) : null;
    return {
      id: info.id,
      name: info.name,
      workspace: info.workspace,
      agent: info.agent,
      main: info.main,
      status: info.status,
      alive,
      phase,
    };
  }

  /**
   * 会话间消息的形态：普通 environment 消息，`source` 固定为 `session`，`ref` 由**发送方**给
   * （`<发送方 id>:<发送方自己的消息 id>`）。收方的 transcript 里就是一条环境消息，壳按普通方式显示。
   *
   * `ref` 不用收方的 `recordId`：那个是收方 `accept()` 时才发的号，发送方拿不到、也不该依赖。
   * 等回信（`wait` / `replyTo`）要靠它来对上号，那部分还没做。
   */
  private envelope(from: string | null, text: string, ref?: string): AgentMessage {
    return environmentMessage(text, SESSION_SOURCE, ref ?? `${from ?? "host"}:${newMessageId()}`);
  }
}

/** 发送方自己发的消息 id。与 inbox 的 recordId 无关——那是**收方**发的，发送方拿不到也不该依赖。 */
function newMessageId(): string {
  const rand = crypto.getRandomValues(new Uint8Array(8));
  let tail = "";
  for (const b of rand) tail += b.toString(16).padStart(2, "0");
  return `${Date.now().toString(36)}-${tail}`;
}

async function withTimeout<T>(p: Promise<T>, ms: number, sessionId: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`runner 在 ${ms}ms 内没让 ${sessionId} 跑起来`)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
