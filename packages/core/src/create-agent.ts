// `createAgent` —— 完整默认装配（D2 / D4 / D5 / D6 / D17）。
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

import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { Agent, type AgentOptions } from "./agent.ts";
import { errText } from "./errors.ts";
import { Models } from "./provider/models.ts";
import type { CredentialStore, Model, Provider } from "./provider/types.ts";
import { InboxStore } from "./inbox/store.ts";
import { AgentAssembly, type AdoptionLedger } from "./assembly/ledger.ts";
import { adoptStorageView } from "./state/write-gate.ts";
import { attachStateHost } from "./state/host-wiring.ts";
import { bindMemoryScopes, createAgentMemories } from "./memory/harness.ts";
import { attachMemoryHost } from "./memory/host-wiring.ts";
import {
  assertProjectWorkspace,
  expandMemoryPrefix,
  memoryScopeTable,
  safeScopeSegment,
  withWorkspaceStamp,
  type MemoryAnchor,
  type MemoryScopeDef,
  type MemoryScopeEntry,
  type MemoryScopeFacts,
  type MemoryScopeTable,
} from "./memory/scope.ts";
import { AGENT_DEF_DIR } from "./agent-def/loader.ts";
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
import type { ObservationCapturePolicy } from "./observability/types.ts";
import { MEMORY_PATH, SqliteCanonicalObservationStore, observationDatabasePath } from "./observability/sqlite-store.ts";
import type { AgentRef } from "./agent-def/types.ts";

/** 不给产品名时的缺省（2026-09-07，原 `DEFAULT_AGENT_ID`）。 */
const DEFAULT_PRODUCT = "default";
const LOCK_FILE = ".lock";
/** RuntimeGeneration：O3a 只有 boot 一代（reload / 换代是 O5 的事），与 `createEcho` 的 boot 代同名。 */
const RUNTIME_GENERATION = "boot";

const MEMORY_DIR = "memory";
/** project 那层的家。**是缺省声明的一部分,不是 core 的概念**——产品换了声明它就不出现。 */
const PROJECTS_DIR = "projects";

/**
 * **core 的缺省记忆作用域**(2026-09-07 用户拍板):user / project / role 三层。
 *
 * 缺省件属于装配层,不属于能力层——`memory/` 里因此一个具体层名都不出现(名字、前缀、有几层
 * 全是产品的事)。产品给 `memoryScopes` 就整份替换:常驻产品换成「产品级 + role」,
 * 想把某层记忆放进仓库就声明 `{ anchor: "workspace", prefix: ".echo/memory/" }`。
 *
 * `order` 同时是**宽度序**(小 = 宽),模型选层时按它读 `describe`。
 * role 那层锚在 `<ECHO_HOME>/agents/<角色名>/`——**与角色定义同一棵树**(`AGENT_DEF_DIR`),
 * 定义和记忆不分家;没有角色名的 session 这一层直接不存在。
 */
export const DEFAULT_MEMORY_SCOPES: readonly MemoryScopeDef[] = Object.freeze([
  Object.freeze({
    name: "user",
    order: 1,
    describe: "every session of this user, in any project",
    anchor: Object.freeze({ kind: "home" as const }),
    prefix: `${MEMORY_DIR}/`,
  }),
  Object.freeze({
    name: "project",
    order: 2,
    describe: "every session working in this same directory",
    anchor: Object.freeze({ kind: "home" as const }),
    prefix: `${PROJECTS_DIR}/{{workspaceHash}}/${MEMORY_DIR}/`,
    // 目录名是 workspace 的 48 位哈希,撞了就是两个项目的记忆混在一起——留痕 + 打开时对一遍
    stamp: true,
  }),
  Object.freeze({
    name: "role",
    order: 3,
    describe: "every session running this same agent definition",
    anchor: Object.freeze({ kind: "agent" as const }),
    prefix: `${MEMORY_DIR}/`,
  }),
]);
/** OR9 的缺省 capture policy：metadata。content 要调用方显式打开（`observation.capture`）。 */
const DEFAULT_OBSERVATION_CAPTURE: ObservationCapturePolicy = "metadata";
/**
 * 观测层唯一还会让 agent 等的地方是 `run.closed` 的有界等待（2026-09-03 用户拍板：观测不得影响 agent 主线）。
 * 正常一次 COMMIT 亚毫秒；磁盘卡住时最多等这么久就降级返回，不用 Sequencer 缺省的 5 s。
 */
const OBSERVATION_BOUNDARY_DEADLINE_MS = 500;
/**
 * SQLite 的 busy_timeout 是**同步等待**（占着事件循环）。状态根有单写者锁、WAL 下 reader 不挡 writer，
 * 正常永远不该等；真等到了就是接线错误，快点失败让 Sequencer 降级，别拖主线 5 s。
 */
const OBSERVATION_BUSY_TIMEOUT_MS = 250;
const TASKS_FILE = "tasks.json";
const SKILLS_DIR = "skills";
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

  /**
   * 哪个产品（2026-09-07，替代 `agentId` / `agentName`）。写进新建会话的 `SessionInfo.product`，
   * 产品各给各的名字（`echo-agent` / `echo-coding`），同一目录里就各有各的对话
   * （`--continue` 按 workspace + product 挑）。缺省 `"default"`。
   */
  product?: string;
  /**
   * 这一段挂的 agent 定义（角色，2026-09-07）。写进 `SessionInfo.agent`。
   *
   * **叫 `agentDef` 不叫 `agent`**：这一层的 `agent` 已经是「透传给低层 `Agent` 的那包选项」
   * （见下），两个含义挤一个名字会让调用方每次都要想一下。`AgentOptions` 那边没这个包袱，
   * 就叫 `agent`，与 `SessionInfo.agent` 对齐。
   */
  agentDef?: AgentRef;
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
   * 这是容器（cli / 常驻程序）该给的那一个：它管的是「我的会话都放哪儿」，
   * 具体某一段的目录由 `sessionsRoot + sessionId` 得出，容器不必先知道 id。
   */
  sessionsRoot?: string;

  /**
   * 存储端口。不给用 `FileDir(stateDir)`——**那就是这一段 session 的目录**（meta、entries、inbox、
   * tasks、schedule、observability、**session 层记忆**都在它下面）。记忆的另外两层（user / project）
   * 与技能不在这里，见 `sharedStore`。
   *
   * **给了 `store` 就必须同时给 `lock`**（见 `createAgent` 里的检查）——
   * 换了远程 Store 却用本机文件锁，两台机器会各自拿到锁、同时写同一份远程状态，
   * 恰好违反 `StateLock` 存在的理由。
   */
  store?: StorageDir;
  /**
   * 跨 session 共享那两层（记忆的 user / project 层、技能）的字节面——**与 `store` 是两个根**：
   * `store` 只覆盖这一段 session 的目录，这两层在它外面。
   *
   * 不给的解析顺序：给了自定义 `store` 就跟着它（记忆的 user 层落在那个 store 的 `memory/` 下、
   * project 层落在 `projects/<hash>/memory/` 下），否则 `FileDir(<ECHO_HOME>)`。前一条是有意的——
   * 「我传了 InMemoryDir」的调用方不该发现记忆仍旧写进了真盘 home。
   */
  sharedStore?: StorageDir;
  /**
   * 记忆的作用域声明,**整份替换** `DEFAULT_MEMORY_SCOPES`(2026-09-07)。
   *
   * 不同产品要的分层本来就不一样:coding 要 user / role / project,常驻产品要产品级 / role
   * (它没有"这台机器的用户"这个概念)。core 只定义"作用域"这个位置——一个有序的、各带一个
   * 根的命名集合——名字、前缀、有几层由产品填。声明是**纯数据**,能写进配置文件。
   */
  memoryScopes?: readonly MemoryScopeDef[];
  /**
   * 关掉记忆（C6/D7 的装配面）。缺省 **false** = 装配记忆并让 `start()` 打开 Dream 自调度。
   * 评测与一次性跑给 `true`：那时「跨任务变好」不是目标，整理只会让轨迹不确定。
   */
  withoutMemory?: boolean;
  /** 单写者端口。不给用状态根下的 first-party 文件锁。 */
  lock?: StateLock;
  /**
   * 本实例可不可以被请走（2026-09-07：人优先，后台让位）。缺省 `false`。
   * 只该给「为了处理一条消息被叫醒」的那种临时宿主——人开的会话留 false，
   * 否则一次后台唤醒就能把正在用的界面顶下去。透传给 `Agent`。
   */
  preemptible?: boolean;
  /** 时间与定时器。不给用真时钟；测试给 `FakeClock` 才能零 sleep 地驱动 schedule。 */
  clock?: Clock;
  /** 凭据存储，透传给 `Models`。 */
  credentials?: CredentialStore;
  /** 解析模型时是否允许联网刷新目录。缺省 `true`；离线环境给 `false`。 */
  allowNetwork?: boolean;
  /**
   * 观测。`capture` 是采集档（OR9），缺省 `"metadata"`：只记形状与计数——工具名、耗时、参数与结果的字节数、
   * token 用量——没有正文。`"content"` 才把模型回复文本、工具 `params` 与结果正文、报错消息写进状态根的
   * `observability/observations.sqlite`；`"off"` 只留 run 边界，不投影任何 fact。
   *
   * 打开 `"content"` 之前要知道的三件事（2026-09-04）：正文**明文落盘、不脱敏**（与会话记录同一状态根、同一暴露面）；
   * 单条记录超 64 KiB 会成 gap、run 的 integrity 变 partial（长 bash 输出、大文件读取）；token 级 delta 逐条成记录，
   * 一轮回复几百条，体积可观。
   */
  observation?: { capture?: ObservationCapturePolicy };

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
    | "preemptible"
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
 * user 层（`<echoHome()>`）：跨 session 共享的东西住在这里——**记忆的 user / project 两层与技能**
 * （project 层是这下面的 `projects/<hash>/`，按 workspace 分）。
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
 * **不是公共面**（2026-08-31 收）：「一个包、两个使用高度、**一个** composition root」，
 * 而这个函数曾经和 `createEcho()` 一起挂在根入口上——那就是两个装配现场，
 * 「CLI 与 SDK 不得各自装配」那条也就名存实亡。现在它只被 `createEcho()` 调用：
 * 装配现场唯一，低层用户走 `new Agent()`（自己给端口、自己注册工具）。
 *
 * 名字保留 `createAgent` 而不是改成 `assembleAgent`：它在几十处注释与决策记录里被引用，
 * 改名换来的是一次全仓改词，换不来任何判据。
 */
export async function createAgent(opts: CreateAgentOptions): Promise<Agent> {
  // **product 不校验路径形状**：它从前叫 `agentId`，是路径段（`agents/<agentId>/`），所以要校验。
  // 「状态根 = session 目录」之后它不进任何路径了——只是 meta 里的一个字段、holder 标识的一半。
  // 继续拿路径规则卡它会把中文产品名之类正当的名字挡在门外（实测：'echo-试产品' 起不来）。
  const product = opts.product ?? DEFAULT_PRODUCT;
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
  // project 层记忆**先**按这个 workspace 分目录。缺省与 `Agent` 那边同一个("/"),不然两处对不上。
  //
  // 这里只是起点,不是终值:workspace 是 session 级事实,`--resume` 一段在别的目录建的会话时,
  // 权威值要到 `Agent.start()` 里 `createOrResume` 返回才知道(盘上为准)。project 层在那时
  // **重指一次**(`projectScopeBinding` 的 `pin`,经 `attachMemoryHost` 挂进 Agent)。
  //
  // 运行中的 `setWorkspace()`(echo-coding 的 worktree 隔离)**故意不跟**(2026-09-07 用户拍板):
  // 同一个仓库换个 worktree 路径就换一套项目记忆,不是想要的行为。
  const memoryWorkspace = opts.workspace ?? "/";

  // canonical observation store：open / PRAGMA / migrate 任一失败 = 装配失败（fail-loud）——
  // 那是状态根坏了 / 文件系统不支持，启动时就该看见。起来之后的写失败**不再**影响 run
  // （观测层只降级，见 observability/runtime.ts 头注）。
  //
  // **注入了自定义 store 又没点名 stateDir 时，观测库落内存**（2026-09-07）。此前它无条件按
  // `<ECHO_HOME>/sessions/<id>` 落真盘——于是每一次 `createAgent({ store: new InMemoryDir() })`
  // 都在开发机的家目录里留一个真目录。实测：805 个空壳、68 MB，里面只有观测库，
  // 连测试夹具的会话 id（`bad` / `main` / `s`）都在。
  // 与 `sharedStore ?? store` 同一条理由：说了「我自己给存储」的调用方，不该发现东西仍旧写进了真盘。
  const observationPath = opts.store !== undefined && opts.stateDir === undefined ? MEMORY_PATH : observationDatabasePath(stateDir);
  const observationStore = await SqliteCanonicalObservationStore.open({ path: observationPath, busyTimeoutMs: OBSERVATION_BUSY_TIMEOUT_MS });

  // 装配现场：这里造出来的每个值都有**唯一一个** dispose owner，且转移是原子的。
  // 它撑住的是「值已经造好、`new Agent()` 还没成功」那个窗口——上一版那时抛错，root store 就再没人关过。
  const assembly = new AgentAssembly({ provider: "echo:persistence-local" });

  // **共享 store 由本函数唯一持有并关闭一次。**
  // Memory / Schedule / Tasks / Inbox / Session 拿到的是一个**不带 `close` 的视图**：
  // 各自的 `dispose()` 里那句 `dir.close?.()` 于是成了空操作。
  // 不这么做的话它们会**并发关同一个 store 两次**（`StorageDir.close()` 的契约
  // 没要求幂等，注入一个第二次关闭就报错的合法实现，默认 `agent.stop()` 当场失败——实测），
  // 而且可能在 `saveTasks()` 还没写完时就关了。真正的关闭放在 `finalDisposables`：
  // 那是所有收摊 settle 之后才跑的一档。
  // 它在 assembly 里是 **borrow**（规则 2）：进程域的值，dispose owner 永远是 provider 侧，
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
    // **装配期不再对 project 层做撞车检查**(2026-09-07):作用域现在是 `start()` 里 session
    // 加载完才解析的,只有那一个解析点,"早点判红比晚点好"这条理由不再成立——早的那一次
    // 查的是**可能不对**的 workspace。检查跟着解析走,见 `resolveMemoryScopes`。
    const parts = prepareCapabilities({ assembly, shared, sharedUser, clock: opts.clock, withoutMemory: opts.withoutMemory, workspace: memoryWorkspace });

    // 形状到此为止。**seal 只冻结形状，不转移所有权**——转移发生在构造成功之后的 `adoptInto()`。
    assembly.seal();

    // 观测 Runtime：唯一 Sequencer + 上面那条 SQLite；装配快照只封 builtin 槽的身份与安全配置摘要，
    // **不放对象本体、凭据、路径正文**（assembly.ts 头注）。每个 run 的 `run.assembly` 记录引用这份 digest。
    const observation = new ObservationRuntime({
      runtimeId: `rt:${crypto.randomUUID()}`,
      runtimeGeneration: RUNTIME_GENERATION,
      capturePolicy: opts.observation?.capture ?? DEFAULT_OBSERVATION_CAPTURE,
      store: observationStore,
      clock: opts.clock ?? systemClock,
      limits: { boundaryDeadlineMs: OBSERVATION_BOUNDARY_DEADLINE_MS },
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
      product,
      ...(opts.agentDef !== undefined ? { agent: opts.agentDef } : {}),
      ...(opts.preemptible === true ? { preemptible: true } : {}),
      // Agent 拿 clock 只做一件事：定期重扫 inbox（别的进程写进来的消息靠它才看得见）。
      // 与 schedule 拿到的是**同一个**——测试拨一次 FakeClock，两边一起动。
      clock: opts.clock ?? systemClock,
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
      // 观测排在最前：先把 ring 里的尾巴写进 SQLite 再关它，之后才关 root store（shutdown 顺序：flush canonical 在前）。
      finalDisposables: [
        ...(opts.agent?.finalDisposables ?? []),
        { dispose: () => observation.dispose() },
        // 记忆的 `workspace` / `path` 两种锚点解析时新建的字节面（`home` / `agent` 落在
        // `sharedStore` 上，那一份归 `assembly.disposeProcessScope()`）。数组是闭包引用：
        // 登记这个 disposer 时它还是空的，绑定发生在 `start()` 里，收摊时读到的才是解析出来的那几个。
        {
          dispose: async () => {
            for (const dir of parts.memoryOwnedDirs) await dir.close?.();
          },
        },
        { dispose: () => assembly.disposeProcessScope() },
        // **一句话都没说过的那一段，连目录一起清掉**（2026-09-07）。排在最后：观测库先关，
        // 否则删的是一个还开着的 SQLite。
        //
        // `discardIfUnused()` 只撤了 `meta.json` / `status.json`（它只有字节面，没有 rmdir），
        // 目录与里面的观测库还留着——实测在开发机上攒了 805 个这样的空壳、68 MB。
        // 目录是本函数建的，路径也只有本函数知道，所以这一步归它。
        //
        // 持有证明（review 2026-09-07）：写入格 `installed` 才是「这一段此刻归我」。`dispose()` 跑在
        // `doStop()` 的 revoke 之前，所以正常收摊时格还是 installed；丢锁后格已 revoke，一个字都不删。
        // 「观测库在内存里」才跳过清理——`store` + `stateDir` 同时给时观测库落真盘（review 2026-09-07：此前按 store 有无判，那种装配留下空壳目录）
        { dispose: () => removeIfEmptySession(stateDir, observationPath === MEMORY_PATH, () => assembly.writeGate.cell.state() === "installed") },
      ],
    });

    // **Host-internal 接线在构造之后挂**：写入总闸与所有权账本都不进公共 `AgentOptions`
    //（普通用户注入不了、也覆盖不掉——外部再登记一份「保险 disposer」正是要防的那件事）。
    // adoption 之后 provider 侧就不再是这些值的 dispose owner，`agent.stop()` 是排空账本的唯一触发点。
    ledger = assembly.adoptInto("echo:agent");
    attachStateHost(agent, {
      gate: ledger.writeGate,
      adoption: ledger,
      // 观测 writer 的封口（review 2026-09-07）：它有自己的 SQLite 连接、不经写入闸，所以只能由这条 port 管——
      // 正常交还前把 ring 里的尾巴 flush 掉（此时 lease 还在手上）；丢锁、或失败后交还，则只封不 flush。
      // 此前 `Agent` 一直在调这两个钩子，装配侧却从没提供过实现：丢锁后 `stop()` 照样往已经归别人的
      // 状态根里写观测库。
      leaseLifecycle: {
        beforeLeaseRelease: () => observation.sequencer.flushPending(),
        onLeaseLost: async (reason) => observation.sequencer.markLeaseLost(reason),
      },
    });
    // canonical writer 同样不进公共 `AgentOptions`（observability/host-wiring.ts 头注）
    attachObservationHost(agent, { runtime: observation });
    // 记忆作用域的绑定口：`start()` 从盘上拿到权威的 workspace / 角色 / 产品之后调一次
    // （memory/host-wiring.ts 头注）。关了记忆就不挂——没有作用域要绑。
    const resolveScopes = parts.resolveMemoryScopes;
    const memories = parts.memory;
    if (resolveScopes !== undefined && memories !== undefined) {
      const defs = opts.memoryScopes ?? DEFAULT_MEMORY_SCOPES;
      attachMemoryHost(agent, {
        bindScopes: async (facts) => bindMemoryScopes(memories, await resolveScopes(defs, facts)),
      });
    }
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
 * `createAgent()` 直接构造的 builtin 槽（sealed AgentAssembly 的 O2a 最小形态）：只有槽名、Entry id、
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
  /**
   * 记忆 project 层的一次性重指口，`start()` 拿到盘上权威的 workspace 之后调。
   * 关了记忆（`withoutMemory`）时是 `undefined`——没有这一层可指。
   */
  /** 给定 session 加载完之后的权威事实,造出这一段的作用域表。`Agent.start()` 调一次。 */
  resolveMemoryScopes: ((defs: readonly MemoryScopeDef[], facts: MemoryScopeFacts) => Promise<MemoryScopeTable>) | undefined;
  /** 锚点解析时新建的字节面,收摊时由本函数关掉。 */
  memoryOwnedDirs: StorageDir[];
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
  /** project 层记忆**先**按它分目录(`projects/<hash>/`);`start()` 拿到盘上权威的 workspace 后重指一次。 */
  workspace: string;
}): AssembledCapabilities {
  const { assembly, shared, sharedUser } = input;
  // **写入资格在这里发**：composition root 建一个总闸，每个能力拿到的是它发的 authority 包过的
  // view——签名与 `StorageDir` 一模一样，领域对象什么都不用改。身份要等 `Agent.start()` acquire 成功才装进去，
  // 所以从这里到 start 之间的任何写都 fail-closed。
  // 写入格是 **candidate-owned**（规则 6）：在 assembly 上建、随 adoption 转给唯一那个 Agent，
  // 只有它 `start()` acquire 成功后才 install。一次装配一个 cell，所以三代之间结构上就不共享。
  const gate = assembly.writeGate;
  const viewFor = (capabilityId: string, lanes: readonly Parameters<typeof gate.openLane>[0][]): StorageDir =>
    adoptStorageView(shared, gate.authorityFor(capabilityId, { lanes, activeBusiness: true }));
  // user 层的能力（记忆、技能）走**同一个写入闸**、不同的根：闸管的是「什么时候允许写」
  // （拿到 lease 之前 fail-closed、revoke 之后关死），那条纪律与根在哪无关。
  // 它**不**提供互斥——user 层本来就是多段 session 共写的（sessions.md §2）。
  const sharedViewFor = (capabilityId: string, lanes: readonly Parameters<typeof gate.openLane>[0][]): StorageDir =>
    adoptStorageView(sharedUser, gate.authorityFor(capabilityId, { lanes, activeBusiness: true }));
  // lane 划分：恢复期的写都走 restore-migration，收摊尾写走 lifecycle-finalization，
  // inbox 的 durable delivery 与 schedule 的 catch-up 各有自己的一条。
  const sessionView = viewFor("echo:session", ["restore-migration", "lifecycle-finalization"]);
  // 记忆的作用域**不在装配期解析**(2026-09-07 用户拍板):workspace、角色、产品都是 session
  // 级事实——`--resume` 一段在别的目录、别的角色下建的会话时,权威值要到 `Agent.start()` 里
  // `createOrResume` 返回才知道(盘上为准)。这里只造一个「给我 facts 就造出作用域表」的解析器,
  // `start()` 调它一次、绑定一次,之后不变。
  //
  // 这比从前那套「装配期先指着、`start()` 再重指一次」少一个概念:没有"重指",只有"还没指"
  // 与"指好了";运行期的 `setWorkspace()` 想跟也跟不了——**结构上没有第二个解析入口**,
  // 这条纪律因此不再建立在调用点自觉上。
  //
  // 各层都过同一个写入闸(闸管的是「什么时候允许写」,与根在哪无关);共享层**不提供互斥**——
  // 多段 session 同时写是设计允许的形态,正确性归记忆自己的文件锁。
  const memorySharedView = sharedViewFor("echo:memory", ["restore-migration"]);
  // 锚点解析时**本函数新建**的字节面(`workspace` / `path` 两种锚点)。`home` / `agent` 落在
  // `sharedStore` 上,那一份归 `finalDisposables` 关一次,不在这里。数组是闭包引用:
  // 登记 disposer 时它还是空的,收摊时读到的才是解析出来的那几个。
  const memoryOwnedDirs: StorageDir[] = [];
  const openMemoryAnchor = (anchor: MemoryAnchor, facts: MemoryScopeFacts): StorageDir | null => {
    switch (anchor.kind) {
      case "home":
        return memorySharedView;
      case "agent":
        // **没有角色名 = 没有身份,也就没有身份记忆**(`AgentRef.name` 可选:容器自己开的段、
        // `--continue` 的老会话、inline 定义都可能没有)。返回 null = 这一层对这段 session 不存在。
        return facts.role === undefined || facts.role === ""
          ? null
          : scopedDir(memorySharedView, `${AGENT_DEF_DIR}/${safeScopeSegment(facts.role)}/`);
      case "workspace":
      case "path": {
        const dir = new FileDir(anchor.kind === "workspace" ? facts.workspace : anchor.path);
        memoryOwnedDirs.push(dir);
        return adoptStorageView(dir, gate.authorityFor("echo:memory", { lanes: ["restore-migration"], activeBusiness: true }));
      }
    }
  };
  const resolveMemoryScopes = async (defs: readonly MemoryScopeDef[], facts: MemoryScopeFacts): Promise<MemoryScopeTable> => {
    const entries: MemoryScopeEntry[] = [];
    for (const def of defs) {
      const root = openMemoryAnchor(def.anchor, facts);
      if (root === null) continue;
      const prefix = expandMemoryPrefix(def.prefix, facts);
      // 撞车检查在**打开这一层的那一刻**做一次:目录名是短哈希时,撞了就是两个项目的记忆
      // 混在一起而没人发现。留痕仍归 `withWorkspaceStamp` 的「第一次真写时才落」。
      if (def.stamp === true) await assertProjectWorkspace(root, prefix, facts.workspace);
      const scoped = scopedDir(root, prefix);
      entries.push({ def, dir: def.stamp === true ? withWorkspaceStamp(scoped, facts.workspace) : scoped });
    }
    return memoryScopeTable(entries);
  };
  const taskView = viewFor("echo:task", ["restore-migration", "lifecycle-finalization"]);
  const scheduleView = viewFor("echo:schedule", ["restore-migration", "managed-activation", "lifecycle-finalization"]);
  const inboxView = viewFor("echo:inbox", ["restore-migration", "durable-ingress", "lifecycle-finalization"]);
  const skillView = sharedViewFor("echo:skill", ["restore-migration", "lifecycle-finalization"]);

  // **记忆分三层**（2026-09-07，替代 2026-09-03 的「整体在 user 层」）：user 与 project 两层跨 session
  // 共享（换一段不失忆），session 一层只有笔记、是 dream 唯一整理的地方。`createAgentMemories` 只要字节面。
  // 用户想换存储或策略时给 `sharedStore`，或者直接走低层 `new Agent({ memory })` 自己装。
  //
  // 下面五件是 **adopt** slot（规则 1）：agent 域的值，`new Agent()` 成功后由那一个 Agent 唯一 dispose。
  // 它们的 factory 都是**零外部副作用**的——只把注入的字节视图存起来，不读盘、不取锁、不起 timer；
  // 恢复归 `start()`、timer 与 intake 归 `activate()`。所以 candidate 期的 dispose 没有可关的资源，
  // 这里一个 disposer 都不登记（`assembly.adopt` 的第三参）。这条契约由 `assembly.test.ts` 的探针守着。
  // **别给它们补登记 disposer**：start 之后的收摊（`disposeMemory` / `disposeSchedule` / session settle）
  // 已经在 `Agent.stop()` 的第 ② 档按类型做过一次，再登记一份就是同一件事收两次。
  const memory =
    input.withoutMemory === true ? undefined : assembly.adopt("echo:memory", () => createAgentMemories());

  // 任务清单与闹钟也落在同一个状态根下。
  // `TaskStore` 是字节面（D3 收窄后），所以这里就是把 `StorageDir` 的两个方法接过去——
  // 这也印证了「终局是直接用 StorageDir，TaskStore 类型退役」。
  const taskStore = assembly.adopt<TaskStore>("echo:task", () => ({
    read: () => taskView.read(TASKS_FILE),
    write: (text) => taskView.write(TASKS_FILE, text),
  }));
  const schedule = assembly.adopt("echo:schedule", () => createAgentSchedule(scheduleView, { clock: input.clock }));
  // 入站事实也落在同一个状态根下——崩溃时未消费的那些在 `start()` 时重放。
  const inboxStore = assembly.adopt("echo:inbox", () => new InboxStore(inboxView));
  const sessionService = assembly.adopt("echo:session", () => new SessionService(sessionView));
  // skill 落在状态根 `skills/<name>/SKILL.md`（「文件实现写 SKILL.md」）。
  // 给 Agent 的是这一层的**字节视图**（D3），发现 / 落盘 / 工具 / 租约门全在 Agent 里。
  // 视图不是独立的值，跟着它上面那层 slot 走，所以不单独占一个 slot。
  const skillStore = scopedDir(skillView, `${SKILLS_DIR}/`);

  return {
    memory,
    taskStore,
    schedule,
    inboxStore,
    sessionService,
    skillStore,
    resolveMemoryScopes: input.withoutMemory === true ? undefined : resolveMemoryScopes,
    memoryOwnedDirs,
  };
}

/**
 * core 自己会往 session 目录里写的东西。**只删这些**——目录里出现别的，说明有人另有用处，
 * 那就一个字都不动。收摊阶段删错东西的代价远大于留下一个空目录。
 */
const SESSION_DIR_OWNED = new Set(["observability", "tasks.json", "schedules.json", "status.json", "inbox", "entries", ".lock", ".dream", "memory"]);

/**
 * 收摊时清掉「一句话都没说过」的那个 session 目录。
 *
 * **判据落在 `meta.json` 在不在上**，而不是重新推一遍：`SessionService.discardIfUnused()` 已经
 * 判过了「这一段没有任何 entry、inbox 里也没有待消费的留言」，判过才撤 meta。所以
 * **没有 meta = 那两条都成立**——这里再推一遍只会推出一条不一样的规矩来。
 *
 * 再加两道（review 2026-09-07）：**只有此刻仍持有 lease 的实例才删**——丢锁后目录已经是接班者的，
 * 连 `.lock` 一起删等于把它的状态根抹掉；从没 `start()` 过的实例也不删，那时目录可能正被别的进程用着。
 * 以及 **`inbox/` 里还有文件就不删**：`discardIfUnused` 判过之后，别的进程仍可能刚投进来一条。
 *
 * 不能只看「除了 observability 什么都没有」：收摊会无条件刷一次 `tasks.json`（哪怕一条任务都没有），
 * 于是那条判据永远不满足（实测）。
 *
 * 观测库开在内存里时（注入了自定义 store 又没点名 `stateDir`）**不动**：那时这个路径下本来就没有我们写的东西，
 * 而路径本身可能是调用方另有用处的目录。给了 `stateDir` 的照常清——观测库就在那下面。
 *
 * 失败只当没发生：收摊阶段为了删一个空目录而抛错，代价远大于留下它。
 */
async function removeIfEmptySession(stateDir: string, observationInMemory: boolean, holdsLease: () => boolean): Promise<void> {
  if (observationInMemory) return;
  if (!holdsLease()) return;
  try {
    const entries = await readdir(stateDir);
    if (entries.includes("meta.json")) return; // 这一段算数：说过话，或有人给它留了话
    if (entries.some((e) => !SESSION_DIR_OWNED.has(e))) return; // 有不是我们写的东西：不碰
    if (entries.includes("inbox") && (await readdir(join(stateDir, "inbox"))).length > 0) return; // 有人刚留了话：不碰
    await rm(stateDir, { recursive: true, force: true });
  } catch {
    // 目录不在、没权限、正被别人用——都不值得为它把收摊搅黄
  }
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
