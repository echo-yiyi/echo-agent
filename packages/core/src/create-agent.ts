// `createAgent` —— 完整默认装配（D2 / D4 / D5 / D6 / D17，见 AGENT-CORE §13.12.3）。
//
// **node-only**：解析 `$PWD` / `$ECHO_HOME`、建 `FileDir` 与文件锁，所以只在根入口，
// 低层用法走 `new Agent()`，自己给已解析好的 Model 与端口。
//
// **它是装配函数，不是第二个 Agent 类**（D16）：出来的就是同一个 `Agent`。
//
// **只做一件 IO：解析模型**。理由是 `AgentState.model` 与 `AgentOptions.model` 都是非空
// `Model`，构造之前必须先拿到它；推迟到 `start()` 就得引入 placeholder 或把 model 改可空，
// 那会变成两个类。Session/Memory/Task 等状态恢复一律归 `start()`。
// **解析模型不看凭据**：目录里有它就能装，key 有没有是运行态（见 `createAgent` 里的说明）。

import { join } from "node:path";
import { Agent, type AgentOptions } from "./agent.ts";
import { errText } from "./errors.ts";
import { Models } from "./provider/models.ts";
import type { CredentialStore, Model, Provider } from "./provider/types.ts";
import { InboxStore } from "./inbox/store.ts";
import { AgentAssembly, type AdoptionLedger } from "./assembly/ledger.ts";
import { adoptStorageView } from "./state/write-gate.ts";
import { attachStateHost } from "./state/host-wiring.ts";
import { createAgentMemories } from "./memory/harness.ts";
import { createAgentSchedule } from "./schedule/harness.ts";
import type { Clock } from "./schedule/clock.ts";
import type { TaskStore } from "./task/types.ts";
import { SessionService } from "./session/service.ts";
import { newSessionId } from "./session/types.ts";
import { fileStateLock } from "./storage/file-lock.ts";
import { FileDir, echoHome, expandHome } from "./storage/file-dir.ts";
import type { StateLock } from "./storage/lock.ts";
import { assertSafePathSegment } from "./storage/path-safety.ts";
import type { StorageDir } from "./storage/types.ts";
import { systemClock } from "./schedule/clock.ts";
import { BUILTIN_GENERATION } from "./extension/builtin.ts";
import { sealAgentAssemblyObservation, type BuiltinSlotContribution } from "./observability/assembly.ts";
import { attachObservationHost } from "./observability/host-wiring.ts";
import { ObservationRuntime } from "./observability/runtime.ts";
import { SqliteCanonicalObservationStore, observationDatabasePath } from "./observability/sqlite-store.ts";

/** 默认身份（D5）。 */
const DEFAULT_AGENT_ID = "default";
const LOCK_FILE = ".lock";
/** §14 RuntimeGeneration：O3a 只有 boot 一代（reload / 换代是 O5 的事），与 `createEcho` 的 boot 代同名。 */
const RUNTIME_GENERATION = "boot";
/** §15 OR9 的缺省 capture policy：metadata。content 要显式打开，O3a 不开这个口子。 */
const OBSERVATION_CAPTURE_POLICY = "metadata" as const;
const TASKS_FILE = "tasks.json";
const SKILLS_DIR = "skills";
const MEMORY_DIR = "memory";
const SESSIONS_DIR = "sessions";

export type CreateAgentOptions = {
  /** 模型来源。**必需**——没有 provider 就没有可解析的目录。 */
  provider: Provider;
  /**
   * 额外注册进 `Models` 的 provider（P3b-a，2026-09-01）：请求派发与 `setModel` 的可选目标。
   * **初始模型仍从 `provider` 解析**（D17 不变）；这些家的凭据照旧每轮现读，
   * 没配 key 时切过去的第一句是诚实的 `auth` 错误（壳子会接住并弹配置段）。
   */
  providers?: readonly Provider[];
  /**
   * 用哪个模型（`Model["id"]`）。可省，解析顺序见 `resolveModel`。
   * 省了而 provider 又没声明 `defaultModelId`、目录里还不止一个 → **fail-loud**。
   */
  model?: string;

  /** agent 身份（D5，缺省 `"default"`）。 */
  agentId?: string;
  /**
   * 会话归属名（2026-09-01：会话身份 = workspace + agent）。写进新建会话的 `SessionInfo.agent`，
   * 产品各给各的名字（`echo-agent` / `echo-coding`），同一目录里就各有各的对话。缺省 = `agentId`。
   */
  agentName?: string;
  /**
   * 会话身份（D5）。**不给 = `start()` 时新建一段**（2026-09-01 用户拍板：续上次是显式动作）；
   * 给了 = create-or-resume 那一段。产品的 `--continue` / `--resume` 用 `listSessions()` 挑出 id 后给这里。
   */
  sessionId?: string;
  /**
   * 工作目录（session 级事实，2026-09-01）：新建 session 时写进 `SessionInfo.workspace`，resume 以盘上为准。
   * 宿主给绝对路径；core 不读 `process.cwd()`。`createEcho()` 缺省用它自己的 `cwd`（进程目录）。
   */
  workspace?: string;
  /**
   * 状态根 = **这一段 session 的目录**。不给就是 `<sessionsRoot>/<sessionId>`
   * （2026-09-03，见 `resolveStateDir`）。点名它就是「把这一段放这儿」，与 `sessionsRoot` 互斥使用。
   */
  stateDir?: string;
  /**
   * 全部 session 目录的上一层。不给就是 `<ECHO_HOME>/sessions`。
   *
   * 这是容器（cli / 宿主程序）该给的那一个：它管的是「我的会话都放哪儿」，
   * 具体某一段的目录由 `sessionsRoot + sessionId` 得出，容器不必先知道 id。
   */
  sessionsRoot?: string;

  /**
   * 存储端口。不给用 `FileDir(stateDir)`——**那就是这一段 session 的目录**（meta、entries、inbox、
   * tasks、schedule、observability 都在它下面）。记忆与技能不在这里，见 `sharedStore`。
   *
   * **给了 `store` 就必须同时给 `lock`**（见 `createAgent` 里的检查）——
   * 换了远程 Store 却用本机文件锁，两台机器会各自拿到锁、同时写同一份远程状态，
   * 恰好违反 `StateLock` 存在的理由。
   */
  store?: StorageDir;
  /**
   * user 层（记忆与技能）的字节面——**与 `store` 是两个根**：`store` 只覆盖这一段 session 的目录，
   * 记忆与技能跨 session 共享，在它外面。
   *
   * 不给的解析顺序：给了自定义 `store` 就跟着它（记忆落在那个 store 的 `memory/` 下），
   * 否则 `FileDir(<ECHO_HOME>)`。前一条是有意的——「我传了 InMemoryDir」的调用方不该发现
   * 记忆仍旧写进了真盘 home。
   */
  sharedStore?: StorageDir;
  /**
   * 关掉记忆（C6/D7 的装配面）。缺省 **false** = 装配记忆并让 `start()` 打开 Dream 自调度。
   * 评测与一次性跑给 `true`：那时「跨任务变好」不是目标，整理只会让轨迹不确定。
   */
  withoutMemory?: boolean;
  /** 单写者端口。不给用状态根下的 first-party 文件锁。 */
  lock?: StateLock;
  /** 时间与定时器。不给用真时钟；测试给 `FakeClock` 才能零 sleep 地驱动 schedule。 */
  clock?: Clock;
  /** 凭据存储，透传给 `Models`。 */
  credentials?: CredentialStore;
  /** 解析模型时是否允许联网刷新目录。缺省 `true`；离线环境给 `false`。 */
  allowNetwork?: boolean;

  /**
   * 其余一律透传给低层 `Agent`。
   * **不含 `model` / `sessionService` / `stateLock` / `agentId`**——那几件由本函数装配。
   *
   * `sessionId` 也在 omit 之列：本函数在顶层收它、并据此定状态根，
   * 嵌套里再给一个只会被**静默覆盖**——写了没生效是最坏的一种参数。
   *
   * `memory` / `taskStore` / `schedule` / `inboxStore` / `skillStore` 同理：本函数按状态根装配它们，
   * 嵌套里给的会被 spread 顶掉。**接受配置又静默忽略是最坏的一种参数**——
   * 实测传自定义 `schedule`，返回的不是那个实例。
   * 要自己的实现就走低层 `new Agent({ ... })`；想在本函数下关掉记忆用 `withoutMemory: true`。
   */
  agent?: Omit<
    AgentOptions,
    | "model"
    | "sessionService"
    | "stateLock"
    | "agentId"
    | "sessionId"
    | "memory"
    | "taskStore"
    | "schedule"
    | "inboxStore"
    | "skillStore"
    | "streamFunction"
  > & {
    /**
     * **可省**：不给就用本函数从 `provider` 装出来的那个（见下方装配处）。
     *
     * 之所以要在这里单独放宽：`AgentOptions.streamFunction` 是**必填**，而 `Omit` 会把
     * 必填带过来——于是「其余一律透传」这句话在类型上不成立，想传任何一个嵌套项
     * （比如 `skills`）都得连 `streamFunction` 一起给。文档说有默认值、类型却逼你传，
     * 是**写了没生效的反面**：说了能省却省不掉。
     */
    streamFunction?: AgentOptions["streamFunction"];
  };
};

/**
 * **状态根 = session 目录**（2026-09-03，sessions.md §2–§3）：`stateDir` 最高优先，
 * 其余是 `<echoHome()>/sessions/<sessionId>`。
 *
 * 一段 session 就是一个独立在跑的 agent，所以按状态根一份的东西——lease、inbox、tasks、
 * schedule、dream 状态、observability——自动变成按 session 一份，一行代码都不用改。
 * 同一台机器上两段 echo-coding 各拿各的锁，这是它们能同时起来的全部原因。
 *
 * `agentId` **不再进路径**（替代 2026-09-01 的 `agents/<agentId>/`）：一段 session 是谁，
 * 记在它自己的 `meta.json` 的 `agent` 字段里；agentId 只剩 lease 的 holder 标识。
 * 跨 session 共享的两件（记忆、技能）不在状态根下，见 `resolveSharedDir()`。
 */
export function resolveStateDir(opts: { stateDir?: string; sessionsRoot?: string; sessionId: string }): string {
  // **sessionId 是路径段**：不校验的话 `sessionId="../../escaped"` 会把整个状态根挪出
  // `.echo/sessions`（`agentId` 曾经实测过同样的洞）——防线漏在哪一处，就从哪一处漏掉全部。
  assertSafePathSegment("会话 id ", opts.sessionId);
  if (opts.stateDir !== undefined) return opts.stateDir;
  return join(opts.sessionsRoot ?? resolveSessionsRoot(), opts.sessionId);
}

/**
 * 全部 session 目录的上一层（`<echoHome()>/sessions`）：`--continue` / `--resume` 与会话列表
 * 扫的就是它。**不是任何一段的状态根**——`listSessions()` 只读 meta，不写。
 */
export function resolveSessionsRoot(opts: { echoHome?: string } = {}): string {
  return join(opts.echoHome ?? echoHome(), SESSIONS_DIR);
}

/**
 * user 层（`<echoHome()>`）：跨 session 共享的东西住在这里——**记忆与技能**。
 *
 * 它们不能跟着状态根下沉到 session 目录：那样每开一段就换一套记忆、换一批技能，
 * 「这个仓库跑测试用 bun test」这种事实一段一份、谁也看不见谁。credentials.json 与
 * settings.json 本来就在这一层，现在只是把记忆和技能归到它们旁边。
 */
export function resolveSharedDir(opts: { echoHome?: string } = {}): string {
  return opts.echoHome ?? echoHome();
}

/**
 * D17 的四级解析。**每一级都 fail-loud，不猜**——静默选错模型意味着成本与能力全变而无人察觉。
 *
 * 顺序（前一级命中就停）：
 *   1. 显式 `model` id      → 不存在则报错并列候选
 *   2. `provider.defaultModelId` → 声明了但不存在也报错（那是 provider 自己的 bug，别吞）
 *   3. 目录里恰好一个        → 用它
 *   4. 以上都不成立          → 报错并列出全部候选
 */
export function resolveModel(provider: Provider, available: readonly Model[], wanted?: string): Model {
  const ids = available.map((m) => m.id);
  const listing = ids.length > 0 ? ids.join("、") : "（空）";

  if (wanted !== undefined) {
    const hit = available.find((m) => m.id === wanted);
    if (hit === undefined) {
      throw new Error(`provider '${provider.id}' 没有模型 '${wanted}'；可选：${listing}`);
    }
    return hit;
  }

  if (available.length === 0) {
    // 目录本身是空的：provider 定义没给模型、或动态目录刷新失败。**与凭据无关**——
    // 装配不看凭据（见 `createAgent`），缺 key 是运行态，由请求路径报 `auth`。
    throw new Error(`provider '${provider.id}' 没有可用模型——目录是空的，检查 provider 定义或目录刷新`);
  }

  const declared = provider.defaultModelId;
  if (declared !== undefined) {
    const hit = available.find((m) => m.id === declared);
    if (hit === undefined) {
      throw new Error(
        `provider '${provider.id}' 声明的 defaultModelId='${declared}' 不在可用目录里；可选：${listing}`,
      );
    }
    return hit;
  }

  if (available.length === 1) return available[0]!;

  throw new Error(
    `provider '${provider.id}' 有多个模型且未指定用哪个：${listing}\n` +
      `给 createAgent({ model: "…" })，或让 provider 声明 defaultModelId`,
  );
}

/**
 * 装配一个带 first-party 默认件的 Agent。**async**：内部要刷新并解析模型目录。
 *
 * **不是公共面**（2026-08-31 收）：§14.2 的标题是「一个包、两个使用高度、**一个** composition root」，
 * 而这个函数曾经和 `createEcho()` 一起挂在根入口上——那就是两个装配现场，
 * 「CLI 与 SDK 不得各自装配」那条也就名存实亡。现在它只被 `createEcho()` 调用：
 * 装配现场唯一，低层用户走 `new Agent()`（自己给端口、自己注册工具）。
 *
 * 名字保留 `createAgent` 而不是改成 `assembleAgent`：它在几十处注释与决策记录里被引用，
 * 改名换来的是一次全仓改词，换不来任何判据。
 */
export async function createAgent(opts: CreateAgentOptions): Promise<Agent> {
  const agentId = opts.agentId ?? DEFAULT_AGENT_ID;
  assertSafePathSegment("agentId ", agentId);
  // **会话 id 在装配期就定**（2026-09-03）：状态根就是它的目录，晚一步定就没有目录可建。
  // 不给 = 新起一段（缺省每次启动新建，2026-09-01）；给了 = create-or-resume 那一段。
  const sessionId = opts.sessionId ?? newSessionId();
  const stateDir = expandHome(resolveStateDir({ ...opts, sessionId }));

  const models = new Models(opts.credentials);
  models.setProvider(opts.provider);
  for (const p of opts.providers ?? []) models.setProvider(p);
  await models.refresh({ allowNetwork: opts.allowNetwork ?? true });
  // **装配不看凭据**（2026-09-01 用户拍板：配置是运行态，不是启动前置）。
  //
  // 上一版这里用 `models.getAvailable()`——按凭据过滤过的目录——于是没 key 就没有候选、
  // Agent 造不出来、壳也没地方挂，用户一启动就被按在配置向导上。pi 与 Claude Code 都不这样：
  // 界面先起来，key 是进去之后的事。**常驻 agent 的存活不能以任何外围配置为前提**——
  // 缺 key、缺扩展、文件坏了，都该是「起来了但告诉你」，不是「起不来」。
  //
  // 这仍然是 fail-loud，只是挪到了它该在的地方：请求路径**每轮重解析 key**，缺了就出一条诚实的
  // `auth` 错误（`Models.stream()`：「端点未配置凭据」），壳子据此把配置流程摆出来；
  // 配好之后下一句 prompt 自然就通，不用重启——因为模型早就解析好了，缺的只是 key。
  // 管道 / CI 那头仍然在启动前报错退出，那是 CLI 按形态做的事（`cli.ts`），不是装配的事。
  const available = models.getModels(opts.provider.id);
  const model = resolveModel(opts.provider, available, opts.model);

  // **store 与 lock 必须成对**：默认文件锁只在默认 `FileDir` 下才有意义。
  // 用户换了存储介质（远程、数据库、别的进程共享的目录）却沿用本机 `<stateDir>/.lock`，
  // 两台机器会各自拿到锁——single-writer 静默失效，而这正是 StateLock 要防的那件事。
  // 所以这里 fail-loud，不替用户猜。
  if (opts.store !== undefined && opts.lock === undefined) {
    throw new Error(
      "给了自定义 store 就必须同时给 lock：默认的本机文件锁配不了非默认存储" +
        "（两个进程会各自拿到锁，single-writer 当场失效）。" +
        "纯内存跑用 `new InMemoryStateLock()`。",
    );
  }
  if (opts.lock !== undefined && opts.store === undefined) {
    throw new Error("给了自定义 lock 就必须同时给 store：只换锁不换存储没有意义，多半是漏传了");
  }
  const store = opts.store ?? new FileDir(stateDir);
  // user 层（记忆、技能）是**另一个根**：状态根成了 session 目录，它们不能跟着下沉。
  // 缺省两个根各自解析；给了自定义 `store` 而没单独给 `sharedStore` 时**跟着 `store` 走**——
  // 否则「我传了 InMemoryDir」的调用方会发现记忆仍旧写进了真盘 home，那是最不该有的意外。
  const sharedStore = opts.sharedStore ?? opts.store ?? new FileDir(expandHome(resolveSharedDir()));
  const lock = opts.lock ?? fileStateLock(join(stateDir, LOCK_FILE));

  // canonical observation store（§15.4.2.2）：固定在状态根下，与自定义 `store` 无关——它是 Runtime 基础设施，不是可换的 Entry。
  // open / PRAGMA / migrate 任一失败 = 不进 READY（fail-loud），不静默退到「没有 journal」的纯内存 admission（§15.12）。
  const observationStore = await SqliteCanonicalObservationStore.open({ path: observationDatabasePath(stateDir) });

  // 装配现场（§14.5.1）：这里造出来的每个值都有**唯一一个** dispose owner，且转移是原子的。
  // 它撑住的是「值已经造好、`new Agent()` 还没成功」那个窗口——上一版那时抛错，root store 就再没人关过。
  const assembly = new AgentAssembly({ provider: "echo:persistence-local" });

  // **共享 store 由本函数唯一持有并关闭一次。**
  // Memory / Schedule / Tasks / Inbox / Session 拿到的是一个**不带 `close` 的视图**：
  // 各自的 `dispose()` 里那句 `dir.close?.()` 于是成了空操作。
  // 不这么做的话它们会**并发关同一个 store 两次**（`StorageDir.close()` 的契约
  // 没要求幂等，注入一个第二次关闭就报错的合法实现，默认 `agent.stop()` 当场失败——实测），
  // 而且可能在 `saveTasks()` 还没写完时就关了。真正的关闭放在 `finalDisposables`：
  // 那是所有收摊 settle 之后才跑的一档。
  // 它在 assembly 里是 **borrow**（§14.5.1 规则 2）：进程域的值，dispose owner 永远是 provider 侧，
  // Agent 拿到的 `shared` 是**不带 `close`** 的视图。standalone 下进程域与 Agent 同寿，
  // 所以那次唯一的 close 仍由 `finalDisposables` 触发（见下方装配处）。
  const shared: StorageDir = assembly.borrow<StorageDir>(
    "echo:persistence-local/root-store",
    {
      read: (p) => store.read(p),
      write: (p, c) => store.write(p, c),
      remove: (p) => store.remove(p),
      list: (p) => store.list(p),
    },
    { dispose: async () => void (await (store as StorageDir).close?.()) },
  );

  // user 层的字节面（记忆、技能）。与 `shared` 同样是 **borrow**：进程域的值、dispose owner 在
  // provider 侧、给出去的视图不带 `close`。它是**另一个根**，不在 session 目录里，也不在 lease 覆盖范围内
  // ——多段 session 同时写它是设计允许的形态（sessions.md §2），互斥不由这把锁提供。
  //
  // 调用方把同一个对象同时给了 `store` 与 `sharedStore` 时**不再借第二次**：那会让同一个 store
  // 被关两次，而 `StorageDir.close()` 的契约没要求幂等（root store 那条注释里的同一个坑）。
  const sharedUser: StorageDir =
    sharedStore === store
      ? shared
      : assembly.borrow<StorageDir>(
          "echo:persistence-local/shared-store",
          {
            read: (p) => sharedStore.read(p),
            write: (p, c) => sharedStore.write(p, c),
            remove: (p) => sharedStore.remove(p),
            list: (p) => sharedStore.list(p),
          },
          { dispose: async () => void (await (sharedStore as StorageDir).close?.()) },
        );

  // **从这里开始到 attach 为止是一个事务**：视图、factory、seal、构造、adopt、接线全在里面。
  // 上一版的 try 从 `new Agent()` 才起，于是 borrow 之后、构造之前的任何一步抛错（比如 `opts` 上一个
  // 会抛的 getter，或某个 factory 自己炸）都不会 unwind——root store 的 close 次数仍是 0（实测）。
  //
  // 收摊按**当前 owner**分岔，不按「失败发生在第几行」：
  //   · adoption 之前失败 → `assembly.abort()`（provider 还是 owner）
  //   · adoption 之后失败 → `ledger.drain()` + `assembly.disposeProcessScope()`
  //     （agent 域归账本、进程域归 provider；此时 `abort()` 本身也已判红）
  let agent: Agent;
  let ledger: AdoptionLedger | undefined;
  try {
    const parts = prepareCapabilities({ assembly, shared, sharedUser, clock: opts.clock, withoutMemory: opts.withoutMemory });

    // 形状到此为止。**seal 只冻结形状，不转移所有权**——转移发生在构造成功之后的 `adoptInto()`。
    assembly.seal();

    // 观测 Runtime（§15）：唯一 Sequencer + 上面那条 SQLite；装配快照只封 builtin 槽的身份与安全配置摘要，
    // **不放对象本体、凭据、路径正文**（assembly.ts 头注）。每个 run 的 `run.assembly` 记录引用这份 digest。
    const observation = new ObservationRuntime({
      runtimeId: `rt:${crypto.randomUUID()}`,
      runtimeGeneration: RUNTIME_GENERATION,
      capturePolicy: OBSERVATION_CAPTURE_POLICY,
      store: observationStore,
      clock: opts.clock ?? systemClock,
      assembly: sealAgentAssemblyObservation(
        builtinSlotContributions({
          customStore: opts.store !== undefined,
          withoutMemory: opts.withoutMemory === true,
          providerIds: [opts.provider.id, ...(opts.providers ?? []).map((p) => p.id)],
          modelId: model.id,
        }),
      ),
    });

    agent = new Agent({
      ...opts.agent,
      model,
      ...(parts.memory !== undefined ? { memory: parts.memory } : {}),
      streamFunction: opts.agent?.streamFunction ?? ((m, ctx, o) => models.stream(m, ctx, o)),
      agentId,
      // Agent 拿 clock 只做一件事：定期重扫 inbox（别的进程写进来的消息靠它才看得见）。
      // 与 schedule 拿到的是**同一个**——测试拨一次 FakeClock，两边一起动。
      clock: opts.clock ?? systemClock,
      ...(opts.agentName !== undefined ? { agentName: opts.agentName } : {}),
      // 装配期已经定了（状态根就是它的目录），这里必须原样交给 Agent——
      // 让 `start()` 再抽一个新的，会写进一个**不是自己**的目录里。
      sessionId,
      ...(opts.workspace !== undefined ? { workspace: opts.workspace } : {}),
      sessionService: parts.sessionService,
      stateLock: lock,
      taskStore: parts.taskStore,
      schedule: parts.schedule,
      inboxStore: parts.inboxStore,
      skillStore: parts.skillStore,
      // 收摊全部 settle 之后，**唯一的那次** close：进程域（borrow）由 assembly 收，
      // 恰好一次由 slot 的三态保证——不再是这里直接调 `store.close()`。
      // 观测排在最前：先把 ring 里的尾巴写进 SQLite 再关它，之后才关 root store（§15.12 shutdown 顺序：flush canonical 在前）。
      finalDisposables: [...(opts.agent?.finalDisposables ?? []), { dispose: () => observation.dispose() }, { dispose: () => assembly.disposeProcessScope() }],
    });

    // **Host-internal 接线在构造之后挂**：写入总闸与所有权账本都不进公共 `AgentOptions`
    //（普通用户注入不了、也覆盖不掉——外部再登记一份「保险 disposer」正是要防的那件事）。
    // adoption 之后 provider 侧就不再是这些值的 dispose owner，`agent.stop()` 是排空账本的唯一触发点。
    ledger = assembly.adoptInto("echo:agent");
    attachStateHost(agent, { gate: ledger.writeGate, adoption: ledger });
    // canonical writer 同样不进公共 `AgentOptions`（observability/host-wiring.ts 头注）
    attachObservationHost(agent, { runtime: observation });
  } catch (e) {
    const owner = ledger;
    return await failWithUnwind(
      e,
      // 观测库先关：它不在 assembly 账本里（Runtime 基础设施，不是 adopt/borrow slot），失败路径要单独收
      async (): Promise<void> => observationStore.close(),
      ...(owner === undefined
        ? [(): Promise<void> => assembly.abort()]
        : [(): Promise<void> => owner.drain(), (): Promise<void> => assembly.disposeProcessScope()]),
    );
  }

  return agent;
}

/**
 * `createAgent()` 直接构造的 builtin 槽（§15.5.1 sealed AgentAssembly 的 O2a 最小形态）：只有槽名、Entry id、
 * 代与**安全**配置摘要输入。O2b 接上正式 Entry owner 后往同一 schema 填值，slot id 不漂移。
 */
function builtinSlotContributions(input: { customStore: boolean; withoutMemory: boolean; providerIds: readonly string[]; modelId: string }): BuiltinSlotContribution[] {
  const slot = (name: string, entryId: string, safeConfig: unknown): BuiltinSlotContribution => ({ slot: name, entryId, entryGeneration: BUILTIN_GENERATION, safeConfig });
  const persistence = { kind: input.customStore ? "custom" : "file" };
  return [
    slot("store", "echo:persistence-local", persistence),
    slot("lock", "echo:persistence-local", persistence),
    slot("session", "echo:session", {}),
    ...(input.withoutMemory ? [] : [slot("memory", "echo:memory", {})]),
    slot("task", "echo:task", {}),
    slot("schedule", "echo:schedule", {}),
    slot("inbox", "echo:inbox", {}),
    slot("skill", "echo:skill", {}),
    slot("models", "echo:models", { providers: [...input.providerIds], model: input.modelId }),
  ];
}

/** 一份装配好的能力面。全部是 `shared` 之上的视图或纯内存对象——没有一件在这一步碰盘。 */
type AssembledCapabilities = Readonly<{
  memory: ReturnType<typeof createAgentMemories> | undefined;
  taskStore: TaskStore;
  schedule: ReturnType<typeof createAgentSchedule>;
  inboxStore: InboxStore;
  sessionService: SessionService;
  skillStore: StorageDir;
}>;

/**
 * 事务里的 PREPARE 段：发写入资格、切分视图、把五件 agent 域的值登记成 adopt slot。
 * **整段可以在任何一行抛错**——调用方的 catch 负责 unwind，所以这里不做局部补救。
 */
function prepareCapabilities(input: {
  assembly: AgentAssembly;
  shared: StorageDir;
  sharedUser: StorageDir;
  clock?: Clock;
  withoutMemory?: boolean;
}): AssembledCapabilities {
  const { assembly, shared, sharedUser } = input;
  // **写入资格在这里发**（§14.9）：composition root 建一个总闸，每个能力拿到的是它发的 authority 包过的
  // view——签名与 `StorageDir` 一模一样，领域对象什么都不用改。身份要等 `Agent.start()` acquire 成功才装进去，
  // 所以从这里到 start 之间的任何写都 fail-closed。
  // 写入格是 **candidate-owned**（§14.5.1 规则 6）：在 assembly 上建、随 adoption 转给唯一那个 Agent，
  // 只有它 `start()` acquire 成功后才 install。一次装配一个 cell，所以三代之间结构上就不共享。
  const gate = assembly.writeGate;
  const viewFor = (capabilityId: string, lanes: readonly Parameters<typeof gate.openLane>[0][]): StorageDir =>
    adoptStorageView(shared, gate.authorityFor(capabilityId, { lanes, activeBusiness: true }));
  // user 层的能力（记忆、技能）走**同一个写入闸**、不同的根：闸管的是「什么时候允许写」
  // （拿到 lease 之前 fail-closed、revoke 之后关死），那条纪律与根在哪无关。
  // 它**不**提供互斥——user 层本来就是多段 session 共写的（sessions.md §2）。
  const sharedViewFor = (capabilityId: string, lanes: readonly Parameters<typeof gate.openLane>[0][]): StorageDir =>
    adoptStorageView(sharedUser, gate.authorityFor(capabilityId, { lanes, activeBusiness: true }));
  // lane 划分照 §14.9 那张表：恢复期的写都走 restore-migration，收摊尾写走 lifecycle-finalization，
  // inbox 的 durable delivery 与 schedule 的 catch-up 各有自己的一条。
  const sessionView = viewFor("echo:session", ["restore-migration", "lifecycle-finalization"]);
  const memoryView = scopedDir(sharedViewFor("echo:memory", ["restore-migration"]), `${MEMORY_DIR}/`);
  const taskView = viewFor("echo:task", ["restore-migration", "lifecycle-finalization"]);
  const scheduleView = viewFor("echo:schedule", ["restore-migration", "managed-activation", "lifecycle-finalization"]);
  const inboxView = viewFor("echo:inbox", ["restore-migration", "durable-ingress", "lifecycle-finalization"]);
  const skillView = sharedViewFor("echo:skill", ["restore-migration", "lifecycle-finalization"]);

  // **记忆在 user 层**（2026-09-03，替代 2026-09-01 的「状态根下」）：状态根成了 session 目录之后，
  // 记忆若跟着下沉就是每开一段换一套记忆。`createAgentMemories` 只要字节面，给它 `<ECHO_HOME>/memory/`。
  // 用户想换存储或策略时给 `sharedStore`，或者直接走低层 `new Agent({ memory })` 自己装。
  //
  // 下面五件是 **adopt** slot（§14.5.1 规则 1）：agent 域的值，`new Agent()` 成功后由那一个 Agent 唯一 dispose。
  // 它们的 factory 都是**零外部副作用**的——只把注入的字节视图存起来，不读盘、不取锁、不起 timer；
  // 恢复归 `start()`、timer 与 intake 归 `activate()`。所以 candidate 期的 dispose 没有可关的资源，
  // 这里一个 disposer 都不登记（`assembly.adopt` 的第三参）。这条契约由 `assembly.test.ts` 的探针守着。
  // **别给它们补登记 disposer**：start 之后的收摊（`disposeMemory` / `disposeSchedule` / session settle）
  // 已经在 `Agent.stop()` 的第 ② 档按类型做过一次，再登记一份就是同一件事收两次。
  const memory =
    input.withoutMemory === true ? undefined : assembly.adopt("echo:memory", () => createAgentMemories(memoryView));

  // 任务清单与闹钟也落在同一个状态根下。
  // `TaskStore` 是字节面（D3 收窄后），所以这里就是把 `StorageDir` 的两个方法接过去——
  // 这也印证了 §13.12.2 说的「终局是直接用 StorageDir，TaskStore 类型退役」。
  const taskStore = assembly.adopt<TaskStore>("echo:task", () => ({
    read: () => taskView.read(TASKS_FILE),
    write: (text) => taskView.write(TASKS_FILE, text),
  }));
  const schedule = assembly.adopt("echo:schedule", () => createAgentSchedule(scheduleView, { clock: input.clock }));
  // 入站事实也落在同一个状态根下——崩溃时未消费的那些在 `start()` 时重放。
  const inboxStore = assembly.adopt("echo:inbox", () => new InboxStore(inboxView));
  const sessionService = assembly.adopt("echo:session", () => new SessionService(sessionView));
  // skill 落在状态根 `skills/<name>/SKILL.md`（§13.6 布局；§5A.4c「文件实现写 SKILL.md」）。
  // 给 Agent 的是这一层的**字节视图**（D3），发现 / 落盘 / 工具 / 租约门全在 Agent 里。
  // 视图不是独立的值，跟着它上面那层 slot 走，所以不单独占一个 slot。
  const skillStore = scopedDir(skillView, `${SKILLS_DIR}/`);

  return { memory, taskStore, schedule, inboxStore, sessionService, skillStore };
}

/**
 * 失败路径的收摊：**原始错误优先**。
 * 上一版直接 `await unwind(); throw e`——unwind 自己抛错时，调用方看到的是收摊的错，
 * 装配为什么失败的那条原因当场消失。这里全尝试、聚合，一条都不盖掉。
 */
async function failWithUnwind(cause: unknown, ...unwinds: readonly (() => Promise<void>)[]): Promise<never> {
  const errors: unknown[] = [];
  for (const unwind of unwinds) {
    try {
      await unwind();
    } catch (e) {
      errors.push(e);
    }
  }
  if (errors.length === 0) throw cause;
  throw new AggregateError(
    [cause, ...errors],
    `装配失败（${errText(cause)}），收摊期间另有 ${errors.length} 处失败：${errors.map(errText).join("；")}`,
  );
}

/**
 * `StorageDir` 的前缀视图：把状态根的一个子目录当成独立的字节面交给 Agent。
 * **没有 `close`**——底层那份只在 `finalDisposables` 里关一次，视图不许再关一次。
 */
function scopedDir(base: StorageDir, prefix: string): StorageDir {
  return {
    read: (path) => base.read(prefix + path),
    write: (path, content) => base.write(prefix + path, content),
    remove: (path) => base.remove(prefix + path),
    list: async (sub) => (await base.list(prefix + sub)).map((k) => k.slice(prefix.length)),
  };
}
