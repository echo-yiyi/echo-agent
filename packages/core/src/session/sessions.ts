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
import { describeAgentRef, DEFAULT_AGENT_REF, type AgentDefinition, type AgentRef } from "../agent-def/types.ts";
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
  /** 哪个产品开的（2026-09-07 从 `agent` 分出来）。 */
  readonly product: string;
  /**
   * 挂的哪份 agent 定义，**人读的那个名字**（`describeAgentRef`）：具名角色是它的名字，
   * 现写的是 `inline`，产品原样的是 `default`。行是给人和模型看的，不摊开整份定义。
   */
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
  /**
   * 新段挂哪份 agent 定义（角色，2026-09-07）：**名字**（从三处来源那张表里找，找不到判红），
   * 或**现写一份**。不给 = 产品原样（`DEFAULT_AGENT_REF`），**不继承创建者的角色**——
   * 一段 reviewer 派出去的活默认不该也是 reviewer，那是它自己要说的事。
   *
   * 现写的定义里 `tools` **必须 ⊆ 创建者此刻的工具集**：越权判红，盘上不建目录。
   */
  readonly agent?: string | AgentDefinition;
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
/**
 * `send()` 的结局。`accepted` 时对方**一定是活着的**——这是 2026-09-07 拍板的那条
 * （虚拟 actor）：只跟活着的段说话，没在跑的先叫起来，叫不起来就 `unreachable`。
 * 所以不存在「存下了但没人读」这种中间态。
 */
export type SendResult =
  | { readonly kind: "accepted"; readonly alive: true; readonly recordId: string }
  | {
      readonly kind: "rejected";
      /** `unreachable` = 它没在跑，而这个容器叫不起来它（没给 `run`，或 runner 失败）。 */
      readonly reason: "not-found" | "closed" | "invalid" | "unreachable";
      readonly detail: string;
    };

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
  /**
   * 调用方自己是哪一段（`send` 的落款、`create` 的缺省与不越权判据）。
   *
   * `tools` 是**此刻**的工作集——不越权检查读它，所以它必须是现查的那一份，
   * 不能是装配时抄下来的（角色收紧过的段只能派出比自己更小的段）。
   */
  readonly self: () => { sessionId: string | null; product: string; workspace: string; tools: readonly string[] };
  /**
   * 按名找一份 agent 定义（三处来源合并好的那张表）。
   * 不给 = 这个容器没有具名角色，`agent: "reviewer"` 一律判红。
   */
  readonly agentDefs?: () => ReadonlyMap<string, AgentDefinition>;
  /**
   * 怎么让一段 session 跑起来。**两处用它**：`create()` 之后把新的那段拉起来；`send()` 发现
   * 对方没在跑时先把它叫醒（2026-09-07 拍板的虚拟 actor 模型）。
   *
   * 不给 = 这个容器起不了会话：`session_create` 工具不挂，`send` 给没在跑的段直接 `unreachable`。
   */
  readonly run?: SessionRunner;
  readonly runTimeoutMs?: number;
};

/** 清单的筛选条件。缺省只列 `active` 的——`closed` 的还在盘上，要看得显式要。 */
export type SessionListFilter = {
  readonly workspace?: string;
  /** 按**角色的人读名**筛（`describeAgentRef`：具名的用名字，现写的是 `inline`，产品原样是 `default`）。 */
  readonly agent?: string;
  /** 按**哪个产品开的**筛（2026-09-07）。 */
  readonly product?: string;
  readonly includeClosed?: boolean;
};

/**
 * 会话面：开一段、列一遍、发一句、关一段。
 *
 * **抽成接口是为了让「没有容器」也有一个诚实的答案**（2026-09-07）：`echo:tui` 这类扩展会被挂在
 * 裸 `new Agent()` 上，那里没有容器、也就没有会话面。ABI 没有「可选依赖」的读法
 * （`ctx.get()` 遇到没有 provider 的 optional 直接抛），所以能力端口只能**恒有**——
 * 缺容器时提供 `NO_SESSION_FACE`，它不说谎：没有别的会话就是没有。
 */
export interface SessionFace {
  /**
   * 这个容器能不能把没在跑的会话叫起来（有没有 `SessionRunner`）。
   *
   * 消费方按它决定**怎么说话**：能叫醒时，没在跑的段仍是可以对话的 peer；叫不醒时，
   * 它们只是盘上的记录，工具与界面就该这么讲，而不是许一个兑现不了的「它下次起来会看到」。
   */
  readonly canWake: boolean;
  create(input: CreateSessionInput): Promise<SessionRow>;
  list(filter?: SessionListFilter): Promise<readonly SessionRow[]>;
  send(to: string, message: string): Promise<SendResult>;
  close(sessionId: string): Promise<void>;
}

/** 没有容器时的会话面。**不是「假装能用」**：一段都没有是事实，开与关则如实说做不到。 */
export const NO_SESSION_FACE: SessionFace = Object.freeze({
  canWake: false,
  create: async () => {
    throw new Error("这个 agent 没有会话面：它不是由容器（`createEcho()`）装出来的，开不了新的一段");
  },
  list: async () => [],
  send: async (to: string) => ({ kind: "rejected", reason: "not-found", detail: `没有会话 ${to}（这个 agent 没有会话面）` }) as SendResult,
  close: async () => {
    throw new Error("这个 agent 没有会话面：关不了别的一段");
  },
});

/** 会话面的实现。一个容器一个实例。 */
export class EchoSessions implements SessionFace {
  /** 有 runner 才叫得醒（见 `SessionFace.canWake`）。 */
  get canWake(): boolean {
    return this.deps.run !== undefined;
  }

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
    // **先解析角色、先验越权，再动盘**：判红时 `~/.echo/sessions/` 下不许多出一个目录
    const ref = this.resolveAgent(input.agent);
    this.assertNotEscalating(ref, self.tools);
    const id = newSessionId();
    assertSafeSessionId(id);
    const store = this.deps.storeFor(id);
    const svc = new SessionService(store);
    const data = await svc.createOrResume(id, {
      ...(input.name !== undefined ? { name: input.name } : {}),
      product: self.product,
      agent: ref,
      workspace: input.workspace ?? self.workspace,
      main: input.main ?? true,
    });
    // `createOrResume` 已经把 meta 写出去了（2026-09-04）：新建的那一段得**立刻在清单里看得见**，
    // 否则 runner 还没接手它就已经查无此段。这里只等那次写落定。
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
      product: data.info.product,
      agent: describeAgentRef(data.info.agent),
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
    // runner resolve = 对方持有 lease（活着）；phase 读盘，与 list() 同一条路——它还没写 status.json 时如实是 null，
    // 不硬编码 idle（review 2026-09-07）
    return { ...(await this.rowOf(data.info)), alive: true };
  }

  /**
   * `agent` 参数 → 一份 `AgentRef`。名字从三处来源那张表里找，**找不到判红**——
   * 静默退回缺省的话，模型以为自己开了个 reviewer，实际开出来的是产品原样。
   */
  private resolveAgent(input: string | AgentDefinition | undefined): AgentRef {
    if (input === undefined) return DEFAULT_AGENT_REF;
    if (typeof input !== "string") return { definition: input };
    const defs = this.deps.agentDefs?.();
    const found = defs?.get(input);
    if (found === undefined) {
      const known = defs === undefined || defs.size === 0 ? "这个容器一份具名 agent 定义都没有" : `有的是：${[...defs.keys()].join("、")}`;
      throw new Error(`没有名叫 '${input}' 的 agent 定义（${known}）`);
    }
    return { name: input, definition: found };
  }

  /**
   * **不越权**（2026-09-03 拍板，2026-09-07 落到角色上）：新段的 `tools` 必须 ⊆ 创建者此刻的工具集。
   * 越权判红——否则一段被收紧过的 session 可以派出一段工具更多的，收紧就成了摆设。
   */
  private assertNotEscalating(ref: AgentRef, own: readonly string[]): void {
    const want = ref.definition.tools;
    if (want === undefined) return;
    const have = new Set(own);
    const over = want.filter((n) => !have.has(n));
    if (over.length > 0) {
      throw new Error(`agent 定义点了创建者没有的工具：${over.join("、")}——工具集只能收紧，不能越权（自己有的是：${own.join("、")}）`);
    }
  }

  /** 清单。缺省只列 `active` 的；`closed` 的还在盘上，要看得显式要。 */
  async list(filter?: SessionListFilter): Promise<readonly SessionRow[]> {
    const infos = await listSessions(this.deps.root);
    const out: SessionRow[] = [];
    for (const info of infos) {
      if (filter?.includeClosed !== true && info.status !== "active") continue;
      if (filter?.workspace !== undefined && info.workspace !== filter.workspace) continue;
      if (filter?.agent !== undefined && describeAgentRef(info.agent) !== filter.agent) continue;
      if (filter?.product !== undefined && info.product !== filter.product) continue;
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

    // **先确保它活着，再投递**（2026-09-07：虚拟 actor）。顺序不能反——
    // 反过来就会留下一条「存在没人读的邮箱里」的纸条：容器起不了它时，那条消息要等人哪天
    // 手动 `--resume` 才会被看到，而工具已经回了「存下了，它下次起来会读」。那是句空话。
    if (!(await this.deps.isAlive(to))) {
      const woke = await this.wake(target);
      if (woke !== null) return { kind: "rejected", reason: "unreachable", detail: woke };
    }

    const self = this.deps.self();
    const ref = `${self.sessionId ?? "host"}:${newMessageId()}`;
    let recordId: string;
    try {
      recordId = await this.deliver(this.deps.storeFor(to), to, this.envelope(self.sessionId, message, ref), `${SESSION_SOURCE}:${ref}`);
    } catch (e) {
      return { kind: "rejected", reason: "invalid", detail: `写不进对方的 inbox：${e instanceof Error ? e.message : String(e)}` };
    }
    return { kind: "accepted", alive: true, recordId };
  }

  /**
   * 把一段没在跑的会话叫起来。返回 `null` = 现在活着了；否则是给调用方看的拒绝理由。
   *
   * **这是「session 一定有一个宿主」那条的落点**（2026-09-07 用户拍板）：一段 session 的地址是
   * 持久的，但它得有宿主才谈得上通信。容器给了 `run` 就按需激活；没给就诚实说这个容器起不了它，
   * 而不是把消息塞进一个没人看的邮箱。
   */
  private async wake(info: SessionInfo): Promise<string | null> {
    const run = this.deps.run;
    if (run === undefined) {
      return `会话 ${info.id} 没在跑，而这个容器起不了它（没有 SessionRunner）——先把它起起来再说话`;
    }
    const row: SessionRow = {
      id: info.id,
      name: info.name,
      workspace: info.workspace,
      product: info.product,
      agent: describeAgentRef(info.agent),
      main: info.main,
      status: info.status,
      alive: false,
      phase: null,
    };
    try {
      await withTimeout(run(row), this.deps.runTimeoutMs ?? DEFAULT_RUN_TIMEOUT_MS, info.id);
    } catch (e) {
      return `会话 ${info.id} 没在跑，叫它也没起来：${e instanceof Error ? e.message : String(e)}`;
    }
    return null;
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
      product: info.product,
      agent: describeAgentRef(info.agent),
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
