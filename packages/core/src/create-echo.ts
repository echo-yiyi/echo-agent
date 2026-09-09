// `createEcho` —— **唯一 composition root**（O3 的第一刀）。
//
// `createAgent()` 装的是「一个能跑的 Agent」；`createEcho()` 在它外面多做一件事：
// **把磁盘上的 Extension 发现出来、装进这个 Agent**。所以出来的不是第二个 Agent 类，
// 是一个 `Echo` 句柄：`{ agent, extensions, stop() }`。
//
// **node-only**（`node:fs/promises` + `node:url`），和 `create-agent.ts` 一样只在根入口。
//
// ## 与完整 Loader 的诚实边界
//
// 规格里的 Loader 是四步（resolve → manifest → **内容寻址编译** → import），并要一道
// host singleton identity gate。**本文件只做最后一步的最小形态**：直接 `import()` 源文件。
// 差在哪、为什么现在可以这样，逐条说清：
//
//   - **不编译、不内容寻址**：因此**没有热重载**——同一路径的模块在进程内只求值一次，
//     改了文件要重启。`mount` 用固定 generation `"boot"`，换代是 O4 的事。
//   - **不做 singleton resolver**：`ServiceKeyTable` 按 `id + version/kind/scope/reload`
//     canonicalize（见 `extension/service-key.ts`），所以就算 Extension 解析到了另一份
//     `@echo-agent/core` 实例，同 id 的 ServiceKey 仍会归一，registry 照样拿得到。
//     完整 Loader 要求的 `extensionServiceKey === hostServiceKey` **引用相等**门这里没有——
//     它防的是「两份物理实例各持一半状态」，那要等 O4 的编译期 resolver 才有意义。
//   - **不弹信任确认**（2026-08-28 用户拍板）：`extensions/` 下的文件按用户自己的代码对待。
// 模块求值本来就不是 sandbox，加一个确认框只是仪式，挡不住任何东西。
//
// ## 坏扩展不阻塞启动（D6，2026-09-01 用户拍板：常驻 agent 的存活不以外围配置为前提）
//
// 分界线是**谁的东西坏了**：
//   · **盘上发现的**（`extensions/` 下用户的文件）：import 失败 / 默认导出不对 / mount 失败 →
//     记一条 `Diagnostic`（`Echo.diagnostics`）、跳过它，agent 照起、**界面里看得见**。
//     它是运行态配置——热部署下修好文件重启（O4 之后是 reload）就好，不该把整个常驻 agent 拖死。
//   · **显式传入的**（`opts.extensions`、`agent.tools` 的 inline）：照旧 **fail-loud** 整体不起——
//     那是程序自己的装配，坏了是代码 bug，静默跳过才是「装了一半的 agent」那种降级。
//
// 「跳过一个、其余照装」的实现是**每个盘上扩展各占一个 generation**：Host 的 mount 按代
// 全有或全无（`host.ts` 头注），分代之后一个坏 apply 只回滚它自己那代；后代照样能 inject
// 前代已 ACTIVE 的 Service（跨代绑定，`graph.ts` 的 activeProviders）。
// **诊断不是可选项**：跳过而不上报就是静默失败——`Echo.diagnostics` 是机器可读的那份，
// 壳子怎么显示归壳子（CLI 在 TUI 里发 notice、管道模式写 stderr）。

import { readdir } from "node:fs/promises";
import { extname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Agent } from "./agent.ts";
import { createAgent, resolveSessionsRoot, resolveStateDir, type CreateAgentOptions } from "./create-agent.ts";
import { EchoSessions, type SessionRunner } from "./session/sessions.ts";
import { makeSessionTools, sessionToolsSection } from "./session/tools.ts";
import { FileDir, echoHome, expandHome } from "./storage/file-dir.ts";
import { AGENT_DEF_DIR, loadAgentDefs } from "./agent-def/loader.ts";
import { inlineAgentExtension, INLINE_AGENT_ENTRY } from "./agent-def/extension.ts";
import { DEFAULT_AGENT_REF, isEmptyDefinition, type AgentRef } from "./agent-def/types.ts";
import type { ParsedAgentFile } from "./agent-def/parse.ts";
import { inspectStateLock } from "./storage/file-lock.ts";
import { errText, type Diagnostic } from "./errors.ts";
import { defineExtension, type ExtensionDefinition } from "./extension/abi.ts";
import { ExtensionHost, type ExtensionEntry } from "./extension/host.ts";
import { agentRegistries } from "./extension/registries.ts";
import { BUILTIN_GENERATION, builtinEntriesFor, defineToolPack, mountBuiltinTools } from "./extension/builtin.ts";
import { unmountGenerations } from "./extension/cleanup.ts";
import type { AgentMessage } from "./messages.ts";
import { observationHostOf } from "./observability/host-wiring.ts";
import type { EchoObservations, EchoRunResult } from "./observability/types.ts";

/** 约定目录名：`<cwd>/extensions`。 */
export const EXTENSIONS_DIR = "extensions";
/** 与 `create-agent.ts` 同一个名字：会话面判「那一段活着吗」读的就是它。 */
const LOCK_FILE = ".lock";

/** 进程还在不在：signal 0 只探不杀。ESRCH = 没了；EPERM = 在（别人的进程，杀不了但存在）；其余按在算，不误判死。 */
function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as { code?: string }).code !== "ESRCH";
  }
}
/** 缺省会话名的长度上限：一行标题，长了在列表里挤掉别的列。 */
const SESSION_NAME_MAX = 60;

/** 显式传入那一代（`opts.extensions`，含壳）。换代（reload）是后话。 */
const BOOT_GENERATION = "boot";
/** `agent.tools` 转成的 inline Extension 那一代：显式装配，fail-loud。 */
const INLINE_GENERATION = "boot:inline";

const MODULE_EXTS: ReadonlySet<string> = new Set([".ts", ".mts", ".js", ".mjs"]);
/** 一层子目录的入口文件，按此顺序取第一个存在的。 */
const INDEX_FILES: readonly string[] = ["index.ts", "index.mts", "index.js", "index.mjs"];

export type CreateEchoOptions = CreateAgentOptions & {
  /**
   * **`agent.tools` 在这一层会被转成一条 inline Extension**（`echo:inline-tools`），
   * 不再由 `Agent` 构造函数直接注册（review 二轮 P1）。
   *
   * 为什么不是「禁掉这个字段」：它表达的是「给这个 agent 这几件工具」，是个正当诉求；
   * 问题只在**实现路径**——直接注册的工具能被模型调用，却不经 ExtensionHost、
   * 不出现在 `echo.extensions`、没有 Fiber/Effect owner，与本层「一份注册机制、一份所有权账本」
   * 直接冲突。转成 inline Extension 之后两边都要：调用方照旧一行传工具，账本照旧只有一本。
   *
   * 低层 `new Agent({ tools })` **不受影响**——那一层本来就是「自己给端口、自己注册」。
   */
  /**
   * 去哪几个目录发现 Extension。**给了就只用给的**（不再叠加约定目录），相对路径按 `cwd` 解析。
   * 给 `[]` 就是彻底关掉自动发现。
   */
  extensionDirs?: readonly string[];
  /** 发现之外**显式追加**的 Entry（builtin、测试注入）。排在发现到的后面 mount。 */
  extensions?: readonly ExtensionEntry[];
  /** 解析约定目录与相对 `extensionDirs` 的基准。缺省 `process.cwd()`。 */
  cwd?: string;
  /**
   * 会话面（2026-09-03，sessions.md §7）。**给了才把 `session_*` 工具挂给模型**——这就是那个开关：
   * 不给就是今天的单会话形态，prompt 里一件工具都不多。`echo.sessions` 这组 API 与开关无关，恒在。
   *
   * `run` 是「容器怎么让新建的一段跑起来」。不给时 `echo.sessions.create()` 照样建（宿主自己知道
   * 怎么跑它），但模型面的 `session_create` 不挂——工具不能承诺系统不交付的事。
   *
   * 与 `stateDir` 同给时，`stateDir` 必须就是 `sessionsRoot/<sessionId>`（且要给 `sessionId`），否则 `createEcho()` 抛：
   * 会话面按 `sessionsRoot` 认人，放在别处的段别人看不见。
   */
  sessions?: {
    run?: SessionRunner;
    /** runner 迟迟不 resolve 的上界，缺省 30 秒。超时按失败处理：判红并把那段置 closed。 */
    runTimeoutMs?: number;
  };
  /**
   * 产品自带的 agent 定义（角色，2026-09-07）。排在三处来源的**最后**——
   * 人放在项目里或家目录里的同名角色盖得住产品自带的。
   */
  builtinAgentDefs?: readonly ParsedAgentFile[];
};

/** 装上了什么。`file` 为 `undefined` 表示它来自 `opts.extensions`（不是从盘上发现的）。 */
export type LoadedExtension = Readonly<{
  entryId: string;
  name: string;
  file: string | undefined;
}>;

export type Echo = Readonly<{
  agent: Agent;
  /**
   * 启动（2026-09-08）：就是 `agent.start()`——取单写者 lease、恢复 session / skill / tasks / schedule / inbox、打开 intake。
   * 装配不启动，启动不装配；第三方走这条，不碰 `agent`（`Agent` 类内部化后 `agent` 字段退场，见
   * `docs/decisions/proposed/2026-09-07-agent-class-internal.md` 第 4 条）。幂等，与 `agent.start()` 同一份判据。
   */
  start(options?: { activation?: "immediate" | "deferred" }): Promise<void>;
  /**
   * 完整 Runtime 的一次 user run（OR5）：`agent.prompt()` 加上观测三元组。
   * 观测层永远拦不住 run：store 写不动时 run 照跑，只是 `observationPersistence` 报 `degraded`（2026-09-03 用户拍板）。
   */
  send(input: string | AgentMessage): Promise<EchoRunResult>;
  /** live 查询面：`getRun(result.runId)` → `renderRunObservation()`。只有 `createEcho()` 出来的 Runtime 承诺 canonical persistence。 */
  observations: EchoObservations;
  /** 本次装上的全部 Extension，顺序即 mount 顺序。**被跳过的坏扩展不在这里**——在 `diagnostics`。 */
  extensions: readonly LoadedExtension[];
  /**
   * 装配期的诊断（D6）：盘上扩展 load / mount 失败，一条一个，带文件路径。
   * 空数组 = 全部装上。**显式传入的失败不在这里**——那种直接抛。
   */
  diagnostics: readonly Diagnostic[];
  /**
   * 会话面（2026-09-03）：开一段、列一遍、发一句、关一段。
   * 与模型的 `session_*` 工具、壳的 `/sessions` **同一份实现**。
   */
  sessions: EchoSessions;
  /** 先卸 Extension（构造的逆序），再停 Agent。 */
  stop(): Promise<void>;
}>;

/**
 * `echo:sessions` 这一条 Entry（没有就是空数组）。
 *
 * `main` 从盘上读：`--resume` 一段别人派的活时，那一段**不是** main，所以它没有 `session_create`。
 * 读不到 meta = 这一段还没说过话（空会话不落盘），那只可能是容器自己刚建的，按 main 算。
 */
async function sessionToolsEntry(
  sessions: EchoSessions,
  sessionDirOf: (id: string) => string,
  sessionId: string | null,
  hasRunner: boolean,
): Promise<readonly ExtensionEntry[]> {
  const main = sessionId === null ? true : await isMainSession(sessionDirOf, sessionId);
  const toolOpts = { canCreate: main && hasRunner };
  return [
    {
      entryId: "echo:sessions",
      definition: defineToolPack("echo:sessions"),
      config: { tools: makeSessionTools(sessions, toolOpts), sections: [sessionToolsSection(toolOpts)] },
    },
  ];
}

/**
 * 盘上那一段挂的是哪份 agent 定义。**读不到就是 `null`**（还没落 meta = 刚建的这一段），
 * 由调用方决定退到什么。meta 坏了这里不判红——`start()` 马上会撞上同一份并给出更准确的话。
 */
async function readSessionAgentRef(sessionDirOf: (id: string) => string, sessionId: string): Promise<AgentRef | null> {
  const raw = await new FileDir(sessionDirOf(sessionId)).read("meta.json");
  if (raw === null) return null;
  try {
    const ref = (JSON.parse(raw) as { agent?: unknown }).agent;
    if (ref === null || typeof ref !== "object" || typeof (ref as AgentRef).definition !== "object") return null;
    return ref as AgentRef;
  } catch {
    return null;
  }
}

async function isMainSession(sessionDirOf: (id: string) => string, sessionId: string): Promise<boolean> {
  const raw = await new FileDir(sessionDirOf(sessionId)).read("meta.json");
  if (raw === null) return true; // 还没落 meta = 刚由容器建的这一段
  try {
    return (JSON.parse(raw) as { main?: unknown }).main !== false;
  } catch {
    return true; // meta 坏了这里不判红：`start()` 马上会撞上同一份并给出更准确的话
  }
}

/** 加载某个 Extension 文件失败：import 抛了，或默认导出不是 `defineExtension()` 的产物。 */
export class ExtensionLoadError extends Error {
  constructor(
    readonly file: string,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(`加载 Extension '${file}' 失败：${message}`, options);
    this.name = "ExtensionLoadError";
  }
}

/** 约定目录：`<cwd>/extensions`。显式给了 `extensionDirs` 就用它（相对路径按 `cwd` 解析）。 */
export function resolveExtensionDirs(opts: { cwd?: string; extensionDirs?: readonly string[] } = {}): readonly string[] {
  const cwd = opts.cwd ?? process.cwd();
  if (opts.extensionDirs !== undefined) {
    return opts.extensionDirs.map((d) => (isAbsolute(d) ? d : resolve(cwd, d)));
  }
  return [join(cwd, EXTENSIONS_DIR)];
}

/**
 * 一层发现（形状照抄 pi 的 `discoverExtensionsInDir`，砍掉 package.json manifest 那条——
 * 那是 O4 的 npm source）：
 *
 *   1. `<dir>/*.ts|mts|js|mjs`  → 直接是一个 Extension
 *   2. `<dir>/<sub>/index.ts|…` → 子目录的入口
 *
 * **不递归第二层**。目录不存在返回空数组（没有 `extensions/` 是常态，不是错）；
 * 目录存在但读不动（权限）**照抛**——那是真错，不能当"没有扩展"混过去。
 * 结果按路径排序，保证 mount 顺序确定。
 */
export async function discoverExtensionFiles(dir: string): Promise<readonly string[]> {
  let entries: { name: string; isFile(): boolean; isDirectory(): boolean }[];
  try {
    entries = await readdir(dir, { withFileTypes: true, encoding: "utf8" });
  } catch (e) {
    if ((e as { code?: string }).code === "ENOENT") return [];
    throw e;
  }

  const found: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isFile() && MODULE_EXTS.has(extname(entry.name))) {
      found.push(full);
      continue;
    }
    if (entry.isDirectory()) {
      // **不吞错**：上一版是 `.catch(() => [])`，于是 `extensions/foo/` 存在但权限不足或 I/O 出错时，
      // 被冒充成「这个子目录里没有扩展」——直接违反本文件开头写的 fail-loud。
      // 只对**竞态 ENOENT** 定语义（枚举到它、真去读时它已被删掉），其余照抛。
      let inner: string[];
      try {
        inner = await readdir(full);
      } catch (e) {
        if ((e as { code?: string }).code === "ENOENT") continue; // 枚举与读取之间被删掉了：当它不存在
        throw e;
      }
      const index = INDEX_FILES.find((f) => inner.includes(f));
      if (index !== undefined) found.push(join(full, index));
    }
  }
  return found.sort();
}

/**
 * import 一个 Extension 文件，取它的默认导出并验形。
 *
 * 验形复用 `defineExtension()` 本身——那是 ABI 的唯一判据，在这里再写一遍形状检查
 * 就是第二份真源。它返回一个新的冻结副本，Host 只认定义的内容，副本没关系。
 */
export async function loadExtensionFile(file: string): Promise<ExtensionDefinition<unknown>> {
  let mod: { default?: unknown };
  try {
    mod = (await import(pathToFileURL(file).href)) as { default?: unknown };
  } catch (e) {
    throw new ExtensionLoadError(file, e instanceof Error ? e.message : String(e), { cause: e });
  }
  const def = mod.default;
  if (def === undefined) {
    throw new ExtensionLoadError(file, "没有默认导出——Extension 文件要 `export default defineExtension({ … })`");
  }
  try {
    return defineExtension(def as ExtensionDefinition<unknown>);
  } catch (e) {
    throw new ExtensionLoadError(file, e instanceof Error ? e.message : String(e), { cause: e });
  }
}

/**
 * 装配一个带默认件、并且已经把 `extensions/` 装好的 Agent。
 *
 * ```ts
 * const echo = await createEcho({ provider: kimiProvider() });
 * await echo.start();
 * await echo.send("hello");
 * await echo.stop();
 * ```
 *
 * `stop()` 卸 Extension 再停 Agent。**mount 失败会连 Agent 一起停掉**再把错抛出去。
 */
export async function createEcho(opts: CreateEchoOptions): Promise<Echo> {
  const dirs = resolveExtensionDirs(opts);

  // **先扫盘、后造 Agent**：发现阶段一行用户代码都不执行（「不允许边发现边执行」），
  // 这一段失败时还没有 Agent 要收拾。去重按解析后的绝对路径——同一个文件被两个目录指到只装一次。
  const files: string[] = [];
  const seen = new Set<string>();
  for (const dir of dirs) {
    for (const file of await discoverExtensionFiles(dir)) {
      const key = resolve(file);
      if (seen.has(key)) continue;
      seen.add(key);
      files.push(file);
    }
  }

  // **把 `agent.tools` 摘出来**：它不再走构造函数直注册，改成下面那条 inline Extension。
  const inlineTools = opts.agent?.tools ?? [];
  const agentOpts = opts.agent === undefined ? undefined : { ...opts.agent, tools: undefined };
  // workspace（session 级事实）的缺省由**这一层**定：进程目录。core 的 Agent 自己不读 process.cwd()。
  const workspace = opts.workspace ?? opts.cwd ?? process.cwd();
  const sessionsRoot = expandHome(opts.sessionsRoot ?? resolveSessionsRoot());
  // 「一段 session 的目录在哪」只有一个数法（review 2026-09-07）：**本段点名了 `stateDir` 就是它**，别的段才落
  // `sessionsRoot/<id>`。此前会话面按 sessionsRoot 另算一遍自己那一段——给了 `stateDir` 的宿主，会话面看不见自己：
  // `isAlive` 读错锁、`isMainSession` 读不到 meta 于是非 main 的段也拿到 `session_create`。
  // 本段的 id 在 `createAgent()` 之后才定（不给就随机），所以这里先记调用方给的，创建后再对齐。
  const selfStateDir = opts.stateDir === undefined ? undefined : expandHome(opts.stateDir);
  // 会话面靠 `listSessions(sessionsRoot)` 认人：本段的目录不在 `sessionsRoot/<id>` 这个位置，别的段就永远看不见它、
  // 发给它一律 not-found。开了会话面还点名 `stateDir`，只许点到那个位置（2026-09-09 拍板 fail-loud，review 2026-09-07 #89）
  if (opts.sessions !== undefined && selfStateDir !== undefined) {
    const expected = opts.sessionId === undefined ? undefined : resolveStateDir({ sessionsRoot, sessionId: opts.sessionId });
    if (expected === undefined || resolve(selfStateDir) !== resolve(expected)) {
      throw new Error(
        `开了会话面（sessions）就不能用 stateDir 把这一段放到 sessionsRoot 之外：别的段按 sessionsRoot 认人，会看不见它。` +
          `要么不给 stateDir（本段落在 ${sessionsRoot}/<sessionId>），要么 stateDir 指到 sessionsRoot/<sessionId> 并同时给 sessionId` +
          `（现在 stateDir=${selfStateDir}${expected === undefined ? "，没给 sessionId" : `，应为 ${expected}`}）`,
      );
    }
  }
  let selfSessionId: string | null = opts.sessionId ?? null;
  const sessionDirOf = (id: string): string =>
    selfStateDir !== undefined && id === selfSessionId ? selfStateDir : resolveStateDir({ sessionsRoot, sessionId: id });
  // agent 定义（角色，2026-09-07）：三处来源合并成一张按名查的表，`session_create({ agent: "reviewer" })`
  // 查的就是它。项目层在前——与项目指令文件同一条规矩，放仓库里的最具体、最优先。
  // 加载失败不挡启动（与盘上扩展同一条口径）：坏文件记一条诊断、跳过。
  const agentDefsLoaded = await loadAgentDefs([join(workspace, ".echo", AGENT_DEF_DIR), join(echoHome(), AGENT_DEF_DIR)], opts.builtinAgentDefs ?? []);
  const agentDefs = agentDefsLoaded.defs;
  // **这一段挂哪份角色：盘上说了算**。`--resume` 一段 reviewer 会话时角色得跟着回来，
  // 而 meta 要到 `start()` 才读得到——那时 mount 早过去了。所以这里照 `isMainSession` 的先例
  // 直接读一次 meta.json：给了 `sessionId` 且盘上有 meta 就以它为准，否则用调用方给的。
  const agentRef = (opts.sessionId !== undefined ? await readSessionAgentRef(sessionDirOf, opts.sessionId) : null) ?? opts.agentDef ?? DEFAULT_AGENT_REF;
  const agent = await createAgent({
    ...opts,
    workspace,
    // 角色的第三项：模型缺省。**在这一层接**——角色写的是模型 id，而按 id 查目录的能力只有
    // 装配层有（`echo:inline-agent` 拿不到 provider 目录，见那个文件的头注）。
    // 显式 `opts.model` 赢：命令行点名的模型比角色的缺省更具体。
    ...(opts.model ?? agentRef.definition.model) !== undefined ? { model: opts.model ?? agentRef.definition.model } : {},
    agentDef: agentRef,
    ...(agentOpts === undefined ? {} : { agent: agentOpts as CreateAgentOptions["agent"] }),
  });
  selfSessionId = agent.state.sessionId; // 到这里本段的 id 才定；`sessionDirOf` 从此对自己那一段认 `stateDir`
  // canonical writer 是 `createAgent()` 挂上的 Host-internal 接线；这里只把查询面与 `send()` 露出去
  const observation = observationHostOf(agent)?.runtime;
  if (observation === undefined) throw new Error("createAgent() 没有挂观测接线：composition root 装配不完整");

  // **Host 在 try 外面造**：catch 要按 boot → builtin 逆序把已 mount 的代卸掉，
  // 声明在 try 里的话它在 catch 里根本不可见（上一版就是这样，于是 builtin 那代永远没人卸）。
  // 会话面（2026-09-03）：一个容器一个实例，三个消费者共用（工具 / 壳 / 宿主）。
  //
  // 这里注进去的两件都是**宿主知识**，core 自己给不出：
  //   · `isAlive` 读的是那一段的 `.lock`——文件锁是 node 的事，而且**陈尸锁也算活着**
  //     （单写者设计不做自动接管，见 `storage/file-lock.ts`）：读到 valid 就当有人占着，
  //     要不要清由人决定。
  //   · `run` 是「怎么让新的一段跑起来」，core 不起进程（sessions.md 的 Non-Goals）。
  //
  // 别人那一段的目录**不过本 Agent 的写入闸**：闸管的是「本段的 lease 还在不在手上」，
  // 而往别人的 inbox 写一条本来就不在我们的 lease 覆盖范围内——那是它自己的账本，
  // 由它自己的 lease 保护。
  const sessions = new EchoSessions({
    root: new FileDir(sessionsRoot),
    storeFor: (id) => new FileDir(sessionDirOf(id)),
    // 「活着」= 锁合法 **且** 持有者进程还在（2026-09-09 拍板加 pid 探针，review 2026-09-07 #90）。core 不接管锁（不删、不抢），
    // 但会话面拿这个判「直投还是叫醒」：崩溃留下的锁若算活着，发给它的消息就躺在没人读的 inbox 里，工具还回「它会读」。
    isAlive: async (id) => {
      const cur = await inspectStateLock(join(sessionDirOf(id), LOCK_FILE));
      return cur.state === "valid" && processExists(cur.record.pid);
    },
    self: () => ({
      sessionId: agent.state.sessionId,
      product: opts.product ?? "default",
      workspace: agent.state.workspace,
      // **现查的那一份工作集**：不越权检查读它。装配时抄一份下来的话，
      // 一段被角色收紧过的 session 仍然能按「产品全套」去派活，收紧就成了摆设。
      tools: agent.state.tools.map((t) => t.name),
    }),
    agentDefs: () => agentDefs,
    ...(opts.sessions?.run !== undefined ? { run: opts.sessions.run } : {}),
    ...(opts.sessions?.runTimeoutMs !== undefined ? { runTimeoutMs: opts.sessions.runTimeoutMs } : {}),
  });

  const host = new ExtensionHost({
    services: agentRegistries({
      tools: agent.tools,
      // 收紧工作集的那一叠（2026-09-07）：角色（`echo:inline-agent`）经它把工具集收到子集
      toolRestrictions: agent.toolRestrictions,
      hooks: agent.hooks,
      skills: { pool: agent.skills, active: agent.activeSkills },
      // **能力端口**（2026-08-31）：扩展要挂后台任务得拿得到这个。不给的话扩展面就只有
      // 「往里注册」没有「用起来」，产品层只能绕到 `createEcho()` 外面自己造 Agent。
      background: agent.background,
      // prompt 段与变量：内建 `echo:*` 与产品 extension 都从这条 Service 进（2026-09-01）
      prompt: { sections: agent.promptSections, variables: agent.promptVariables },
      // 压缩阶段：`echo:compaction` 与产品自己的策略同一条 Service（2026-09-02）
      compaction: agent.compactionStages,
      // 记忆模块：`echo:memory` 与产品自己的模块同一条 Service（2026-09-08）。没装记忆就不传——
      // 那时这个 Service 缺席，声明 required 的扩展装不上（而不是装上了没处生效）。
      ...(agent.memory === undefined ? {} : { memory: agent.memory }),
      // 会话面（2026-09-07）：壳的 `/sessions`、第三方自己的会话工具都从这条 Service 拿，
      // 与内建 `echo:sessions` 是同一份实现——不会长出第二套「会话是什么」
      sessions,
    }),
  });

  // 从这里起 Agent 已经存在：任何（fail-loud 路径上的）失败都必须把它停掉，否则 store 与文件锁没人收。
  // 角色文件的加载诊断（坏档、撞名）从这里开始攒——与盘上扩展同一条口径：不挡启动，但看得见。
  const diagnostics: Diagnostic[] = [...agentDefsLoaded.diagnostics];
  /** 已经 mount 上的**非 builtin** 代，按 mount 顺序。收摊与失败回滚都按它逆序卸。 */
  // **会话的缺省命名**（2026-09-07，sessions.md §3）：拿第一句人话的首行当名字。
  //
  // 名字是给人看的——`session_list`、会话列表、`--continue` 的界面里认哪一段全靠它，
  // 而缺省是会话 id（`s-mtmoe01i-qmeb` 这种），对人零信息量。
  //
  // 做成**钩子**而不是写死在 core：产品想让模型起名、或按 workspace 命名，自己挂一个更早的
  // （`priority` 更小）钩子先改掉名字就行——这个缺省只在「名字还是 id」时动手，改过就不再碰。
  // 只认 `human`：steer / followUp 是同一场对话的追加，不是这段会话的由头。
  // 被别的会话叫醒的那一轮也是 `human`（inbox 消费走同一条前台路），所以 `session_create` 派出去、
  // 模型没给名字的那一段，会被它收到的第一条指令命名——那正是它存在的理由。
  agent.hooks.on(
    "userPromptSubmit",
    (event) => {
      if (event.source !== "human") return;
      const id = agent.state.sessionId;
      if (id === null || agent.sessionName !== id) return; // 已经有名字了（人起的、或别的钩子起的）
      const first = event.text.split("\n").find((l) => l.trim() !== "");
      if (first === undefined) return;
      agent.renameSession(first.trim().slice(0, SESSION_NAME_MAX));
    },
    { id: "echo:session-name", priority: 100 },
  );

  const mountedGens: string[] = [];
  try {
    // 盘上的扩展逐个加载：**坏一个记一条诊断、跳过它**（D6，头注）。`loadExtensionFile` 本身照抛
    // ExtensionLoadError——低层调用方仍然 fail-loud，宽恕只发生在装配这一层、只对盘上的文件。
    const discovered: { entry: ExtensionEntry; file: string }[] = [];
    for (const file of files) {
      try {
        const definition = await loadExtensionFile(file);
        discovered.push({ entry: { entryId: resolve(file), definition }, file });
      } catch (e) {
        diagnostics.push({ code: "extension_load_failed", message: errText(e), path: file });
      }
    }

    // ── ① 内部：`echo:*` builtin 表 ──────────────────────────────────────────────
    // 「通过内置模块表解析，不从安装目录动态找文件；但进入 ExtensionHost 后与第三方一样
    // 获得 Fiber、Effect、依赖检查与 dispose」。所以内建工具与外部扩展**同一条注册路**。
    //
    // **单独一代**，不是跟外部合并成一次 mount。两个理由：
    //   · 顺序——外部扩展可以 inject builtin 提供的 Service，那要求 builtin 先 ACTIVE
    //     （Host 支持跨代绑定：`graph.ts` 的 `activeProviders`）；
    //   · 换代——将来热重载外部扩展时，builtin 这一代不用跟着重装。
    // **算一次，mount 与公开清单共用同一份**：分两次算的话 `echo:agent` 会真的装上、
    // 清单里却没有（review 二轮 P1 实测）。
    const builtin = builtinEntriesFor(agent);
    await mountBuiltinTools(agent, host, builtin); // 与低层用户 / 单测**同一条路、同一张表**

    // ── ② 外部：磁盘发现的 + 显式传入的 ──────────────────────────────────────────
    const extra = opts.extensions ?? [];
    // `agent.tools` 的归宿：一条 inline Extension，与外部扩展同代、同 registry、同所有权账本。
    // 排在最前面，是因为它语义上最接近「这个 agent 自带的」——磁盘发现的扩展可能想覆盖它。
    const inline: ExtensionEntry[] = [
      ...(inlineTools.length === 0
        ? []
        : [{ entryId: "echo:inline-tools", definition: defineToolPack("echo:inline-tools"), config: { tools: inlineTools } }]),
      // ── `echo:inline-agent`：这一段挂的角色（2026-09-07）──────────────────────────────
      //
      // **排在 inline-tools 之后、盘上发现的之前**：identity 要替的那一段、tools 要收紧的那个池，
      // 都得先由产品与内建装好。角色只做两件——替 identity、收工作集，第三件（model）在装配
      // 更早的地方接（见上面 `createAgent` 那里）。空定义不挂：挂它等于不挂。
      ...(isEmptyDefinition(agentRef.definition)
        ? []
        : [{ entryId: INLINE_AGENT_ENTRY, definition: inlineAgentExtension(), config: agentRef.definition }]),
      // ── `echo:sessions`：会话面的模型可见工具（2026-09-03，sessions.md §7）──────────────
      //
      // **不在 builtin 表里**，因为它要的东西 `Agent` 没有：会话面是**容器**级的
      // （一个容器管着好几段），而 builtin 表是从一个 Agent 派生出来的。
      //
      // 两条挂载条件都在这里判，不在工具里判：
      //   · `canCreate` —— 只有 main 才挂 `session_create`。扇出只有一层：派出去的那段
      //     自己没有这件工具，不会再派。是不是 main 读盘上的 meta（新建的段还没有 meta，
      //     那条路本来就是容器自己建的，缺省 true）。
      //   · 容器没给 `SessionRunner` 时**整组的 create 都不挂**——模型调了 `session_create`、
      //     系统却什么都不做，比没有这件工具更坏（工具不能承诺系统不交付的事）。
      ...(opts.sessions === undefined
        ? [] // **开关**：容器不提会话面，这个 agent 就是今天的单会话形态，工具一件不多
        : await sessionToolsEntry(sessions, sessionDirOf, agent.state.sessionId, opts.sessions.run !== undefined)),
    ];
    // 顺序与从前一致：inline → 盘上发现的 → extra。差别只在**代的划分**：
    //   · inline / extra 是显式装配 → 各自一代、fail-loud；
    //   · 盘上发现的每个一代 → 坏 apply 只回滚它自己，记诊断继续（D6）。
    if (inline.length > 0) {
      await host.mount(INLINE_GENERATION, inline);
      mountedGens.push(INLINE_GENERATION);
    }
    const mounted: { entry: ExtensionEntry; file: string }[] = [];
    for (const d of discovered) {
      const gen = `${BOOT_GENERATION}:${d.entry.entryId}`;
      try {
        await host.mount(gen, [d.entry]);
        mountedGens.push(gen);
        mounted.push(d);
      } catch (e) {
        diagnostics.push({ code: "extension_mount_failed", message: errText(e), path: d.file });
      }
    }
    if (extra.length > 0) {
      await host.mount(BOOT_GENERATION, extra);
      mountedGens.push(BOOT_GENERATION);
    }

    const loaded: LoadedExtension[] = [
      ...builtin.map((e) => ({ entryId: e.entryId, name: e.definition.name, file: undefined })),
      ...inline.map((e) => ({ entryId: e.entryId, name: e.definition.name, file: undefined })),
      ...mounted.map((d) => ({ entryId: d.entry.entryId, name: d.entry.definition.name, file: d.file })),
      ...extra.map((e) => ({ entryId: e.entryId, name: e.definition.name, file: undefined })),
    ];

    /**
     * 收摊。**single-flight**：所有调用共享同一个 promise，因此也共享同一个完成或失败结果。
     *
     * 上一版用一个 `stopped` 布尔当闸：第一次进了 disposer、还没跑完，第二次 `await echo.stop()`
     * 就立刻成功返回了（review 实测 `secondSettledBeforeFirst: true`）——那是在告诉调用方
     * 「收摊完了」，而实际上第一次还卡在 disposer 里。幂等的含义是**第二次拿到同一个结果**，
     * 不是「第二次直接放行」。
     */
    let stopPromise: Promise<void> | null = null;
    const doStop = async (): Promise<void> => {
      // 逆序：先卸 Extension（它们的 disposer 要动 agent 的 tools / hooks / skills），再停 Agent。
      // **两步都要跑到**，各收各的错：上一版是 `try { unmount } finally { agent.stop() }`，
      // 两边同时失败时 finally 里那个抛会把前一个**顶掉**（实测只剩 agent-stop-failed，
      // extension-unmount-failed 整个丢了）。丢掉一个失败原因，排查时就少了一半线索。
      // **按 mount 的逆序卸所有代**（外部各代 → inline → builtin）：后代可能 inject 了前代的
      // Service，先卸后代才不会让 provider 在还有 consumer 时消失。未 mount 的代幂等跳过。
      const errors = await unmountGenerations(host, [...[...mountedGens].reverse(), BUILTIN_GENERATION]);
      try {
        await agent.stop();
      } catch (e) {
        errors.push(e);
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) {
        throw new AggregateError(errors, `Echo 收摊有 ${errors.length} 处失败：${errors.map(errText).join("；")}`);
      }
    };

    /**
     * `send()` = user source 的调用方适配器：outcome 来自 loop，观测三元组来自 admission 已 COMMIT 的 RunIndex。
     * `observationPersistence` 是**当前 Runtime** 的投影：terminal 已进 index 才 stored；尾写失败磁盘仍 running → degraded。
     */
    const send = async (input: string | AgentMessage): Promise<EchoRunResult> => {
      const result = await agent.prompt(input);
      const index = observation.runIndexOf(result.runId);
      return {
        runId: result.runId,
        outcome: result.outcome,
        observation: { runtimeId: observation.runtimeId, runId: result.runId },
        observationIntegrity: index?.header.integrity ?? "partial",
        observationPersistence: observation.persistenceOf(result.runId),
      };
    };

    return Object.freeze({
      agent,
      start: (options?: { activation?: "immediate" | "deferred" }): Promise<void> => agent.start(options),
      send,
      sessions,
      observations: observation.observations,
      extensions: Object.freeze(loaded),
      diagnostics: Object.freeze(diagnostics),
      stop: (): Promise<void> => (stopPromise ??= doStop()),
    });
  } catch (e) {
    // **构造失败也要按逆序清干净**：boot → builtin → agent（review 二轮 P1）。
    // 上一版这里只 `agent.stop()`：builtin 已经 mount 成功、boot 才失败时，
    // **builtin 那一代永远不卸**——Fiber 的 disposer 一次都不跑。
    // 眼下 Effect 主要是撤销工具注册，而 `agent.stop()` 会 `tools.clear()`，所以**症状被掩盖**；
    // 一旦哪个 Effect 持有 watcher / 连接 / 子进程，那就是真泄漏。
    // 收摊自己也失败时**每个错都要给出去**——吞掉等于把「资源没交回去」这件事藏了。
    // 逆序卸已挂上的代。判据落在 `unmountGenerations` 自己身上（假 Host 验顺序 / 继续执行 /
    // 错误聚合），而不是隔着本函数去猜——上一版那条端到端测试证明不了它跑过（review 三轮）。
    const errors: unknown[] = [e, ...(await unmountGenerations(host, [...[...mountedGens].reverse(), BUILTIN_GENERATION]))];
    try {
      await agent.stop();
    } catch (stopError) {
      errors.push(stopError);
    }
    if (errors.length === 1) throw e;
    throw new AggregateError(errors, `装 Extension 失败，收摊时又有 ${errors.length - 1} 处失败：${errText(e)}`);
  }
}
