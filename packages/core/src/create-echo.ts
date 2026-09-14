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
//   - **不编译、不内容寻址**：启动时直接 import 原文件。热部署（`reloadExtensions()`，2026-09-14）
//     不靠模块缓存失效——同一路径的模块在 Node / Bun 里都只求值一次，而且入口的相对依赖不跟着刷
//     （两边实测）——而是把改过的扩展**复制一份到原文件旁边**（`.foo.echo-<pid>-<n>.ts`）再 import：
//     路径变了就是新模块，相对路径（`./helper.ts`、`../shared.ts`）与 `node_modules` 的查找都还落在原处。
//     旧模块留在内存里卸不掉，这是 JS 运行时的限制，只适合开发期；见决策记录的 Non-Goals。
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

import { createHash, randomUUID } from "node:crypto";
import { copyFile, cp, readdir, readFile, realpath, rm } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
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
import { holderGone } from "./storage/generation-lock.ts";
import { errText, type Diagnostic } from "./errors.ts";
import { defineExtension, type ExtensionDefinition } from "./extension/abi.ts";
import { ExtensionHost, type ExtensionEntry } from "./extension/host.ts";
import { extensionFactDescriptor } from "./extension/observe.ts";
import { AGENT_ENTRY_ID, builtinOwner } from "./observability/runtime.ts";
import { agentRegistries } from "./extension/registries.ts";
import { BUILTIN_GENERATION, builtinEntriesFor, defineToolPack, mountBuiltinTools } from "./extension/builtin.ts";
import { unmountGenerations } from "./extension/cleanup.ts";
import type { ReloadChange, ReloadReport, ReloadResult } from "./extension/reload.ts";
import { environmentMessage, type AgentMessage } from "./messages.ts";
import { renderReloadReport } from "./extension/reload-tool.ts";
import type { ScheduleResult } from "./extension/reload.ts";
import { observationHostOf } from "./observability/host-wiring.ts";
import type { EchoObservations, EchoRunResult } from "./observability/types.ts";

/** 约定目录名：`<cwd>/extensions`。 */
export const EXTENSIONS_DIR = "extensions";
/** 与 `create-agent.ts` 同一个名字：会话面判「那一段活着吗」读的就是它。 */
const LOCK_FILE = ".lock";

/** 缺省会话名的长度上限：一行标题，长了在列表里挤掉别的列。 */
const SESSION_NAME_MAX = 60;

/** 显式传入那一代（`opts.extensions`，含壳）。换代（reload）是后话。 */
const BOOT_GENERATION = "boot";
/** `agent.tools` 转成的 inline Extension 那一代：显式装配，fail-loud。 */
const INLINE_GENERATION = "boot:inline";
/** 角色（`echo:inline-agent`）那一代：**最后 mount**——它替产品的 identity 段，产品那代必须已在。 */
const ROLE_GENERATION = "boot:agent";

const MODULE_EXTS: ReadonlySet<string> = new Set([".ts", ".mts", ".js", ".mjs"]);
/** 一层子目录的入口文件，按此顺序取第一个存在的。 */
const INDEX_FILES: readonly string[] = ["index.ts", "index.mts", "index.js", "index.mjs"];

/**
 * 热部署的代码快照命名：`.<原名>.echo-<pid>-<序号>[.<后缀>]`，与原文件同一个父目录。
 * 点开头是为了不碍眼；pid 是为了几个进程共用一个扩展目录时互不干扰；序号是同一进程内不重名。
 * 发现、哈希、复制三处都靠它认出「这是我们自己留下的」并跳过——**只跳这一种命名**，别的点开头文件照旧算数。
 */
const SNAPSHOT_RE = /^\..+\.echo-\d+-\d+(?:\.[^.]+)?$/;
function isSnapshotName(name: string): boolean {
  return SNAPSHOT_RE.test(name);
}
/** 换代那次 reload 的安全点：装配层在两次 run 之间调（`Agent.betweenRuns`），所以是 `run`。 */
const RELOAD_SAFE_POINT = "run" as const;

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
   * 与 `stateDir` 互斥：会话面按 `sessionsRoot` 认人，放在别处的段别人看不见，所以两者同给时 `createEcho()` 抛。
   * 要续某一段就给 `sessionsRoot` + `sessionId`。
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
  /**
   * 现在装着的全部 Extension：内建 → inline → 盘上发现的（按入口路径）→ 产品自带的 → 角色。
   * **被跳过的坏扩展不在这里**——在 `diagnostics`。**每次读现算**（2026-09-14）：热部署会增删盘上那一段。
   */
  readonly extensions: readonly LoadedExtension[];
  /**
   * 诊断（D6）：盘上扩展 load / mount 失败，一条一个，带文件路径；热部署的失败也进这里（同一个文件按路径替换上一次的）。
   * 空数组 = 全部装上。**显式传入的失败不在这里**——那种直接抛。每次读现算。
   */
  readonly diagnostics: readonly Diagnostic[];
  /**
   * 热部署（2026-09-14）：重扫扩展目录，改过的换代、新增的装上、删掉的卸下；新版装不上就装回旧版。
   * 与 `AgentRuntime.reloadExtensions()`（壳的 `/reload`）是**同一个函数**。仅 idle；忙时 rejected，不排队。
   * 只管盘上发现的扩展；每个扩展怎么了见 `ReloadReport`。
   */
  reloadExtensions(): Promise<ReloadResult>;
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
    if (isSnapshotName(entry.name)) continue; // 热部署留下的代码快照：是我们自己的副本，不是第二个扩展
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
export function loadExtensionFile(file: string): Promise<ExtensionDefinition<unknown>> {
  return loadExtensionModule(file, file);
}

/**
 * `loadExtensionFile` 的里层：从 `importPath` 加载，报错时指名 `file`。
 * 热部署 import 的是快照副本，而错误、诊断、清单里出现的都得是用户认识的那个原路径。
 */
async function loadExtensionModule(importPath: string, file: string): Promise<ExtensionDefinition<unknown>> {
  let mod: { default?: unknown };
  try {
    mod = (await import(pathToFileURL(importPath).href)) as { default?: unknown };
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

/* ───────────── 热部署的三件盘上活：发现（带根）、比对内容、复制快照 ───────────── */

/** 一个盘上扩展：`entry` 是入口文件（entryId、诊断、清单都用它），`root` 是它占的那一块——单文件就是自己，子目录就是那个目录。 */
type DiscoveredRoot = Readonly<{ entry: string; root: string }>;

/** 扫全部目录，按解析后的绝对路径去重（同一个文件被两个目录指到只算一次），按入口路径排序。 */
async function discoverRoots(dirs: readonly string[]): Promise<readonly DiscoveredRoot[]> {
  const out: DiscoveredRoot[] = [];
  const seen = new Set<string>();
  for (const dir of dirs) {
    for (const file of await discoverExtensionFiles(dir)) {
      const entry = resolve(file);
      if (seen.has(entry)) continue;
      seen.add(entry);
      // 子目录入口（`<dir>/<sub>/index.ts`）的根是 `<sub>`；直接文件的根是自己
      out.push({ entry, root: dirname(entry) === resolve(dir) ? entry : dirname(entry) });
    }
  }
  return out.sort((a, b) => (a.entry < b.entry ? -1 : a.entry > b.entry ? 1 : 0));
}

/**
 * 内容哈希：单文件哈希字节；子目录哈希**目录下全部文件**（相对路径 + 字节，按路径排序），
 * 所以改了 `helper.ts` 没动 `index.ts` 也算变了。跳过 `node_modules`（大、且换依赖不是改扩展）与我们自己的快照。
 */
async function hashExtension(root: DiscoveredRoot): Promise<string> {
  const hash = createHash("sha256");
  if (root.root === root.entry) {
    hash.update(await readFile(root.entry));
    return hash.digest("hex");
  }
  const files: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const d of await readdir(dir, { withFileTypes: true, encoding: "utf8" })) {
      if (d.name === "node_modules" || isSnapshotName(d.name)) continue;
      const full = join(dir, d.name);
      if (d.isDirectory()) await walk(full);
      else if (d.isFile()) files.push(full);
    }
  };
  await walk(root.root);
  files.sort();
  for (const f of files) {
    hash.update(relative(root.root, f));
    hash.update("\0");
    hash.update(await readFile(f));
    hash.update("\0");
  }
  return hash.digest("hex");
}

/**
 * 把扩展复制到原文件旁边再 import：`extensions/foo.ts` → `extensions/.foo.echo-<pid>-<n>.ts`，
 * `extensions/bar/` → `extensions/.bar.echo-<pid>-<n>/`（整棵复制，含它自己的 `node_modules`——否则副本里的包解析不到）。
 * 返回快照根与要 import 的入口。快照在这一代 ACTIVE 期间要留着（扩展可能按 `import.meta.url` 读旁边的文件），换代、删除、收摊时删。
 *
 * **入口给的是 realpath**（2026-09-14 实测）：Bun 的模块解析按目录缓存条目，目录路径经过软链（macOS 的 `/var` → `/private/var`）
 * 时，解析过一次之后新建的文件经软链路径 `import()` 报「Cannot find module」，经真实路径就能找到。
 */
async function snapshotExtension(root: DiscoveredRoot, seq: number): Promise<Readonly<{ path: string; entry: string }>> {
  const dir = dirname(root.root);
  const base = basename(root.root);
  const tag = `echo-${process.pid}-${seq}`;
  if (root.root === root.entry) {
    const ext = extname(base);
    const path = join(dir, `.${base.slice(0, base.length - ext.length)}.${tag}${ext}`);
    await copyFile(root.entry, path);
    return { path, entry: await realpath(path) };
  }
  const path = join(dir, `.${base}.${tag}`);
  await cp(root.root, path, { recursive: true, filter: (src) => !isSnapshotName(basename(src)) });
  return { path, entry: await realpath(join(path, basename(root.entry))) };
}

async function removeSnapshot(path: string | null): Promise<void> {
  if (path !== null) await rm(path, { recursive: true, force: true });
}

/** `createEcho()` 里那张盘上扩展账的一行。 */
type DiscoveredState = {
  readonly root: DiscoveredRoot;
  /** 装上（或上次尝试）那一刻的内容哈希。 */
  readonly hash: string;
  /** 现在挂着的代；null = 没装上。 */
  generation: string | null;
  /** 这一代代码的快照路径；boot 代从原路径加载，null。 */
  readonly snapshot: string | null;
  /** `definition.name`；没加载成功就 null。 */
  readonly name: string | null;
};

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
  const roots = await discoverRoots(dirs);

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
  // 发给它一律 not-found。所以开了会话面就**不收** `stateDir`（2026-09-09 拍板 fail-loud，review 2026-09-07 #89）：
  // 「只许点到 sessionsRoot/<sessionId>」这条例外没有生产调用方，词法比较又会把 /tmp 与 /private/tmp 判成两处，索性不留
  if (opts.sessions !== undefined && selfStateDir !== undefined) {
    throw new Error(
      `开了会话面（sessions）就不能给 stateDir：别的段按 sessionsRoot 认人，放在别处的段它们看不见。` +
        `本段的目录只能是 sessionsRoot/<sessionId>——用 sessionsRoot（要续某一段就再给 sessionId）来指定它`,
    );
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
  //   · `isAlive` 读的是那一段的 `.lock`——文件锁是 node 的事。崩溃留下的锁在被下一个人接管之前
  //     仍是 valid，所以还要看持有者死没死，判法与锁接管用的是同一个（`holderGone`）。
  //   · `run` 是「怎么让新的一段跑起来」，core 不起进程（sessions.md 的 Non-Goals）。
  //
  // 别人那一段的目录**不过本 Agent 的写入闸**：闸管的是「本段的 lease 还在不在手上」，
  // 而往别人的 inbox 写一条本来就不在我们的 lease 覆盖范围内——那是它自己的账本，
  // 由它自己的 lease 保护。
  const sessions = new EchoSessions({
    root: new FileDir(sessionsRoot),
    storeFor: (id) => new FileDir(sessionDirOf(id)),
    // 「活着」= 锁合法 **且** 持有者没有确认死掉（2026-09-09 拍板加 pid 探针，review 2026-09-07 #90）。
    // 会话面拿这个判「直投还是叫醒」：崩溃留下的锁若算活着，发给它的消息就躺在没人读的 inbox 里，工具还回「它会读」。
    // 「确认死掉」与锁接管同一个判法——同一台机器、pid 查无此号；别的机器、EPERM 一律当活着。
    isAlive: async (id) => {
      const cur = await inspectStateLock(join(sessionDirOf(id), LOCK_FILE));
      return cur.state === "valid" && !holderGone(cur.record);
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
      // agent 级选项（2026-09-09）：扩展经 `AgentPolicies` 声明权限 / 预算 / 提问策略，
      // 于是「本地扩展把 echo-agent 长成另一个 agent」这条路不再差预算与权限那一截
      policies: agent.policySlots,
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
    // 观测探针：五代装载（builtin / inline / 盘上发现的 / boot / role）的结果都在 Host 的事务链上当场记。
    // 盘上发现的 extension 装坏时，此前只进一条 diagnostic；现在账本里也有，带是哪个 Entry、在哪个阶段失败
    observe: observation.capabilitySink(extensionFactDescriptor, builtinOwner(AGENT_ENTRY_ID)),
  });

  // 从这里起 Agent 已经存在：任何（fail-loud 路径上的）失败都必须把它停掉，否则 store 与文件锁没人收。
  // 角色文件的加载诊断（坏档、撞名）从这里开始攒——与盘上扩展同一条口径：不挡启动，但看得见。
  const diagnostics: Diagnostic[] = [...agentDefsLoaded.diagnostics];
  /**
   * 盘上扩展的账（2026-09-14）：入口路径 → 现在什么样。热部署拿它比对上一次；清单（`Echo.extensions`）从它现算。
   * `generation` 为 null = 没装上（诊断里有）；`snapshot` 是这一代代码的副本（boot 代从原路径加载，null）。
   */
  const discovered = new Map<string, DiscoveredState>();
  /** 快照序号：同一进程内每次复制都不重名。 */
  let snapshotSeq = 0;
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
    //
    // **每个盘上扩展都进 `discovered` 表**，装没装上都进（`generation` 为 null = 没装上，诊断里有它）：
    // 热部署要拿它比对「上次是什么样」——文件删了要报 removed，上次坏着这次修好了要报 added。
    const loaded: { entry: ExtensionEntry; file: string }[] = [];
    for (const root of roots) {
      const hash = await hashExtension(root);
      try {
        const definition = await loadExtensionFile(root.entry);
        loaded.push({ entry: { entryId: root.entry, definition }, file: root.entry });
        discovered.set(root.entry, { root, hash, generation: null, snapshot: null, name: definition.name });
      } catch (e) {
        diagnostics.push({ code: "extension_load_failed", message: errText(e), path: root.entry });
        discovered.set(root.entry, { root, hash, generation: null, snapshot: null, name: null });
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
    // 热部署的入口挂在协议上（`AgentRuntime.reloadExtensions`）：函数体在下面，装配完才会被调，闭包引用没问题。
    //
    // **模型自己触发**（2026-09-14 用户拍板，`docs/decisions/implemented/2026-09-14-model-triggered-reload.md`）：
    // `extension_reload` 工具只登记；run 收尾后（`agent.afterRun`，在 inbox 消费与 dream 之前）调**同一个**
    // `reloadExtensions()`，把报告作为一条 `environment` 消息投进本段会话自己的 inbox——紧接着的自主工作就把它
    // 消费成下一个 run，模型在那里接着验证。同一 run 里只登记一次；报告投不进去（收摊中）记一条诊断，不抛。
    let reloadPending = false;
    const requestReload = (): ScheduleResult => {
      if (reloadPending) return { kind: "rejected", reason: "已经登记过了：结束这条回复即可，重载会在本 run 收尾后执行，报告随后到达" };
      const scheduled = agent.afterRun(async () => {
        reloadPending = false;
        const result = await reloadExtensions();
        const report = renderReloadReport(result, agent.state.tools.map((t) => t.name));
        const delivered = await agent.ingress.deliverDurable({ message: environmentMessage(report, "echo:reload"), dedupeKey: `echo:reload:${randomUUID()}` });
        if (delivered.kind === "rejected") {
          diagnostics.push({ code: "extension_reload_report_undelivered", message: `热部署做完了，报告没投进 inbox（${delivered.reason}）：${report}` });
        }
      });
      if (scheduled.kind === "scheduled") reloadPending = true;
      return scheduled;
    };
    const builtin = builtinEntriesFor(agent, { reloadExtensions: () => reloadExtensions(), requestReload });
    await mountBuiltinTools(agent, host, builtin); // 与低层用户 / 单测**同一条路、同一张表**

    // ── ② 外部：磁盘发现的 + 显式传入的 ──────────────────────────────────────────
    const extra = opts.extensions ?? [];
    // `agent.tools` 的归宿：一条 inline Extension，与外部扩展同代、同 registry、同所有权账本。
    // 排在最前面，是因为它语义上最接近「这个 agent 自带的」——磁盘发现的扩展可能想覆盖它。
    const inline: ExtensionEntry[] = [
      ...(inlineTools.length === 0
        ? []
        : [{ entryId: "echo:inline-tools", definition: defineToolPack("echo:inline-tools"), config: { tools: inlineTools } }]),
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
    // ── `echo:inline-agent`：这一段挂的角色（2026-09-07）──────────────────────────────
    //
    // **最后一代，排在 extra（产品自带的 extension）之后**（2026-09-10 修）：角色替的是产品的
    // `identity` 段（受控 replace，同名必须已存在），而真实产品的 identity 都在 `opts.extensions`
    // 里——此前它排在 inline 那代、早于 extra，replace 时那段还没注册，`echo-agent` / `echo-coding`
    // 一带 agentDef.identity 就判红「不存在：replace 无从替起」。收紧工作集不挑顺序（动态过滤，
    // `restrictTools`），跟着一起挪没有代价。第三件（model）在装配更早的地方接（见上面 `createAgent`）。
    // 空定义不挂：挂它等于不挂。
    const role: ExtensionEntry[] = isEmptyDefinition(agentRef.definition)
      ? []
      : [{ entryId: INLINE_AGENT_ENTRY, definition: inlineAgentExtension(), config: agentRef.definition }];
    // 顺序：inline → 盘上发现的 → extra → 角色。差别只在**代的划分**：
    //   · inline / extra / 角色是显式装配 → 各自一代、fail-loud；
    //   · 盘上发现的每个一代 → 坏 apply 只回滚它自己，记诊断继续（D6）。
    if (inline.length > 0) {
      await host.mount(INLINE_GENERATION, inline);
      mountedGens.push(INLINE_GENERATION);
    }
    for (const d of loaded) {
      const gen = `${BOOT_GENERATION}:${d.entry.entryId}`;
      try {
        await host.mount(gen, [d.entry]);
        mountedGens.push(gen);
        discovered.get(d.file)!.generation = gen;
      } catch (e) {
        diagnostics.push({ code: "extension_mount_failed", message: errText(e), path: d.file });
      }
    }
    if (extra.length > 0) {
      await host.mount(BOOT_GENERATION, extra);
      mountedGens.push(BOOT_GENERATION);
    }
    if (role.length > 0) {
      await host.mount(ROLE_GENERATION, role);
      mountedGens.push(ROLE_GENERATION);
    }

    /** 清单**现算**（2026-09-14）：热部署会增删盘上那一段，冻结一份就是第二份会漂的真相。顺序：内建 → inline → 盘上（按入口路径）→ 产品自带 → 角色。 */
    const listExtensions = (): readonly LoadedExtension[] =>
      Object.freeze([
        ...builtin.map((e) => ({ entryId: e.entryId, name: e.definition.name, file: undefined })),
        ...inline.map((e) => ({ entryId: e.entryId, name: e.definition.name, file: undefined })),
        ...[...discovered.values()]
          .filter((d): d is DiscoveredState & { name: string } => d.generation !== null && d.name !== null)
          .map((d) => ({ entryId: d.root.entry, name: d.name, file: d.root.entry })),
        ...extra.map((e) => ({ entryId: e.entryId, name: e.definition.name, file: undefined })),
        ...role.map((e) => ({ entryId: e.entryId, name: e.definition.name, file: undefined })),
      ]);

    /**
     * 热部署（2026-09-14 用户拍板，决策记录 `docs/decisions/implemented/2026-09-14-extension-hot-reload.md`）。
     *
     * 整个跑在 `agent.betweenRuns()` 里：拿 admission 的 permit，此刻没有 run、也排不进新的；忙就 rejected。
     * 重扫目录，和 `discovered` 表比对：
     *   · 表里有、盘上没了 → `host.replace(旧代, null)` 卸掉；
     *   · 内容哈希没变且挂着 → unchanged，**不重新加载**；
     *   · 其余 → 先复制快照、import、验形（这一步失败旧代一个字不动）→ 没挂着的 `mount`、挂着的 `host.replace()`。
     * `refused` / `rolled_back` / `lost` 的含义见 `extension/reload.ts`；每条失败同时进 `diagnostics`（按文件路径替换上一次的）。
     * **只管盘上发现的**：builtin / inline / extra / 角色四代不在 `discovered` 表里，这里碰不到它们。
     */
    const reloadExtensions = async (): Promise<ReloadResult> => {
      const admitted = await agent.betweenRuns(async (signal) => {
        const changes: ReloadChange[] = [];
        const current = new Map((await discoverRoots(dirs)).map((r) => [r.entry, r]));
        const dropDiagnostics = (file: string): void => {
          for (let i = diagnostics.length - 1; i >= 0; i--) if (diagnostics[i]!.path === file) diagnostics.splice(i, 1);
        };
        const noteUnwind = (file: string, errors: readonly unknown[]): void => {
          for (const e of errors) diagnostics.push({ code: "extension_unmount_failed", message: errText(e), path: file });
        };
        const swapGeneration = (gen: string, next: string | null): void => {
          const i = mountedGens.indexOf(gen);
          if (next === null) {
            if (i >= 0) mountedGens.splice(i, 1);
          } else if (i >= 0) mountedGens[i] = next;
          else mountedGens.push(next);
        };

        /* ── 盘上没了的 ── */
        for (const [file, prev] of [...discovered]) {
          if (current.has(file)) continue;
          if (prev.generation !== null) {
            const r = await host.replace(prev.generation, null, { safePoint: RELOAD_SAFE_POINT });
            if (r.kind === "refused") {
              changes.push({ kind: "refused", file, reason: r.reason });
              continue;
            }
            noteUnwind(file, r.unwindErrors);
            swapGeneration(prev.generation, null);
            await removeSnapshot(prev.snapshot);
          }
          dropDiagnostics(file);
          discovered.delete(file);
          changes.push({ kind: "removed", file });
        }

        /* ── 新的、改过的、上次没装上的 ── */
        for (const [file, root] of current) {
          const hash = await hashExtension(root);
          const prev = discovered.get(file);
          if (prev !== undefined && prev.generation !== null && prev.hash === hash) {
            changes.push({ kind: "unchanged", file });
            continue;
          }
          const mounted = prev !== undefined && prev.generation !== null;
          if (signal.aborted) {
            changes.push({ kind: mounted ? "rolled_back" : "failed", file, reason: "Agent 正在收摊，这一项没做" });
            continue;
          }
          // 加载新代码：失败时旧代还没被碰过，旧的照旧
          let snapshot: Readonly<{ path: string; entry: string }> | null = null;
          let definition: ExtensionDefinition<unknown>;
          try {
            snapshot = await snapshotExtension(root, ++snapshotSeq);
            definition = await loadExtensionModule(snapshot.entry, file);
          } catch (e) {
            await removeSnapshot(snapshot?.path ?? null);
            if (!mounted) {
              dropDiagnostics(file);
              discovered.set(file, { root, hash, generation: null, snapshot: null, name: null });
            }
            diagnostics.push({ code: "extension_load_failed", message: errText(e), path: file });
            changes.push({ kind: mounted ? "rolled_back" : "failed", file, reason: errText(e) });
            continue;
          }
          const gen = `reload-${snapshotSeq}:${file}`;
          const entry: ExtensionEntry = { entryId: file, definition };
          if (prev === undefined || prev.generation === null) {
            try {
              await host.mount(gen, [entry]);
            } catch (e) {
              await removeSnapshot(snapshot.path);
              dropDiagnostics(file);
              diagnostics.push({ code: "extension_mount_failed", message: errText(e), path: file });
              discovered.set(file, { root, hash, generation: null, snapshot: null, name: null });
              changes.push({ kind: "failed", file, reason: errText(e) });
              continue;
            }
            swapGeneration(gen, gen);
            dropDiagnostics(file);
            discovered.set(file, { root, hash, generation: gen, snapshot: snapshot.path, name: definition.name });
            changes.push({ kind: "added", file });
            continue;
          }
          const r = await host.replace(prev.generation, { generation: gen, entries: [entry] }, { safePoint: RELOAD_SAFE_POINT });
          switch (r.kind) {
            case "refused":
              await removeSnapshot(snapshot.path);
              changes.push({ kind: "refused", file, reason: r.reason });
              break;
            case "replaced":
              swapGeneration(prev.generation, gen);
              await removeSnapshot(prev.snapshot);
              dropDiagnostics(file);
              noteUnwind(file, r.unwindErrors);
              discovered.set(file, { root, hash, generation: gen, snapshot: snapshot.path, name: definition.name });
              changes.push({ kind: "replaced", file });
              break;
            case "rolled_back":
              await removeSnapshot(snapshot.path);
              dropDiagnostics(file);
              noteUnwind(file, r.unwindErrors);
              diagnostics.push({ code: "extension_mount_failed", message: errText(r.error), path: file });
              changes.push({ kind: "rolled_back", file, reason: errText(r.error) });
              break;
            case "lost":
              await removeSnapshot(snapshot.path);
              await removeSnapshot(prev.snapshot);
              swapGeneration(prev.generation, null);
              dropDiagnostics(file);
              noteUnwind(file, r.unwindErrors);
              diagnostics.push({ code: "extension_mount_failed", message: errText(r.error), path: file });
              diagnostics.push({ code: "extension_rollback_failed", message: errText(r.rollbackError), path: file });
              discovered.set(file, { root, hash, generation: null, snapshot: null, name: null });
              changes.push({ kind: "lost", file, reason: `新版：${errText(r.error)}；装回旧版也失败：${errText(r.rollbackError)}` });
              break;
          }
        }
        changes.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
        const report: ReloadReport = { changes };
        return report;
      });
      return admitted.kind === "rejected" ? admitted : { kind: "done", report: admitted.value };
    };

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
      // 热部署留下的代码快照：本进程的都收掉。别的进程的、崩溃留下的不动（决策记录 Non-Goals）。
      for (const d of discovered.values()) {
        try {
          await removeSnapshot(d.snapshot);
        } catch (e) {
          errors.push(e);
        }
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
      // 两张表都是 **getter**（2026-09-14）：热部署之后清单与诊断都会变，冻结快照会把「装了什么」说成启动那一刻的样子
      get extensions(): readonly LoadedExtension[] {
        return listExtensions();
      },
      get diagnostics(): readonly Diagnostic[] {
        return Object.freeze([...diagnostics]);
      },
      reloadExtensions,
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
