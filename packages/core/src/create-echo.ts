// `createEcho` —— **唯一 composition root**（§14.14.1 O3 的第一刀）。
//
// `createAgent()` 装的是「一个能跑的 Agent」；`createEcho()` 在它外面多做一件事：
// **把磁盘上的 Extension 发现出来、装进这个 Agent**。所以出来的不是第二个 Agent 类，
// 是一个 `Echo` 句柄：`{ agent, extensions, stop() }`。
//
// **node-only**（`node:fs/promises` + `node:url`），和 `create-agent.ts` 一样只在根入口，不进 `/engine`。
//
// ## 与 §14.8 完整 Loader 的诚实边界
//
// 规格里的 Loader 是四步（resolve → manifest → **内容寻址编译** → import），并要一道
// host singleton identity gate。**本文件只做最后一步的最小形态**：直接 `import()` 源文件。
// 差在哪、为什么现在可以这样，逐条说清（登记在 `docs/ISSUES.md`）：
//
//   - **不编译、不内容寻址**：因此**没有热重载**——同一路径的模块在进程内只求值一次，
//     改了文件要重启。`mount` 用固定 generation `"boot"`，换代是 O4 的事。
//   - **不做 singleton resolver**：`ServiceKeyTable` 按 `id + version/kind/scope/reload`
//     canonicalize（见 `extension/service-key.ts`），所以就算 Extension 解析到了另一份
//     `@echo/core` 实例，同 id 的 ServiceKey 仍会归一，registry 照样拿得到。
//     §14.8.2 要求的 `extensionServiceKey === hostServiceKey` **引用相等**门这里没有——
//     它防的是「两份物理实例各持一半状态」，那要等 O4 的编译期 resolver 才有意义。
//   - **不弹信任确认**（2026-08-28 用户拍板）：`extensions/` 下的文件按用户自己的代码对待。
//     模块求值本来就不是 sandbox（§14.8.4），加一个确认框只是仪式，挡不住任何东西。
//
// ## 一个坏扩展就整体不起（fail-loud）
//
// 发现到的文件里任何一个 import 失败 / 默认导出形状不对 / mount 失败 → **整个 `createEcho()` 抛**，
// 并且**把已经造好的 Agent 停掉**（不然状态锁和 store 会泄漏）。不收集 diagnostic 继续跑：
// 「装了一半的 agent」是本仓明令禁止的那种静默降级——用户以为工具在，模型却看不见它。

import { readdir } from "node:fs/promises";
import { extname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Agent } from "./agent.ts";
import { createAgent, type CreateAgentOptions } from "./create-agent.ts";
import { errText } from "./errors.ts";
import { defineExtension, type ExtensionDefinition } from "./extension/abi.ts";
import { ExtensionHost, type ExtensionEntry } from "./extension/host.ts";
import { agentRegistries } from "./extension/registries.ts";
import { BUILTIN_GENERATION, builtinEntriesFor, defineToolPack, mountBuiltinTools } from "./extension/builtin.ts";
import { unmountGenerations } from "./extension/cleanup.ts";

/** 约定目录名：`<cwd>/extensions`。 */
export const EXTENSIONS_DIR = "extensions";

/** 外部那一代：磁盘发现的 + 显式传入的。换代（reload）是 §14.8/§14.9 的事。 */
const BOOT_GENERATION = "boot";

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
};

/** 装上了什么。`file` 为 `undefined` 表示它来自 `opts.extensions`（不是从盘上发现的）。 */
export type LoadedExtension = Readonly<{
  entryId: string;
  name: string;
  file: string | undefined;
}>;

export type Echo = Readonly<{
  agent: Agent;
  /** 本次装上的全部 Extension，顺序即 mount 顺序。 */
  extensions: readonly LoadedExtension[];
  /** 先卸 Extension（构造的逆序），再停 Agent。 */
  stop(): Promise<void>;
}>;

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
 * await echo.agent.start();
 * await echo.agent.prompt("hello");
 * await echo.stop();
 * ```
 *
 * `stop()` 卸 Extension 再停 Agent。**mount 失败会连 Agent 一起停掉**再把错抛出去。
 */
export async function createEcho(opts: CreateEchoOptions): Promise<Echo> {
  const dirs = resolveExtensionDirs(opts);

  // **先扫盘、后造 Agent**：发现阶段一行用户代码都不执行（§14.8.1「不允许边发现边执行」），
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
  const agent = await createAgent(
    agentOpts === undefined ? opts : ({ ...opts, agent: agentOpts } as CreateAgentOptions),
  );

  // **Host 在 try 外面造**：catch 要按 boot → builtin 逆序把已 mount 的代卸掉，
  // 声明在 try 里的话它在 catch 里根本不可见（上一版就是这样，于是 builtin 那代永远没人卸）。
  const host = new ExtensionHost({
    services: agentRegistries({
      tools: agent.tools,
      hooks: agent.hooks,
      skills: { pool: agent.skills, active: agent.activeSkills },
      // **能力端口**（2026-08-31）：扩展要挂后台任务得拿得到这个。不给的话扩展面就只有
      // 「往里注册」没有「用起来」，产品层只能绕到 `createEcho()` 外面自己造 Agent。
      background: agent.background,
    }),
  });

  // 从这里起 Agent 已经存在：任何失败都必须把它停掉，否则 store 与文件锁没人收。
  try {
    const discovered: { entry: ExtensionEntry; file: string }[] = [];
    for (const file of files) {
      const definition = await loadExtensionFile(file);
      discovered.push({ entry: { entryId: resolve(file), definition }, file });
    }

    // ── ① 内部：`echo:*` builtin 表 ──────────────────────────────────────────────
    // 「通过内置模块表解析，不从安装目录动态找文件；但进入 ExtensionHost 后与第三方一样
    // 获得 Fiber、Effect、依赖检查与 dispose」（§14）。所以内建工具与外部扩展**同一条注册路**。
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
    const inline: ExtensionEntry[] =
      inlineTools.length === 0
        ? []
        : [{ entryId: "echo:inline-tools", definition: defineToolPack("echo:inline-tools") as never, config: { tools: inlineTools } }];
    const entries: ExtensionEntry[] = [...inline, ...discovered.map((d) => d.entry), ...extra];
    await host.mount(BOOT_GENERATION, entries);

    const loaded: LoadedExtension[] = [
      ...builtin.map((e) => ({ entryId: e.entryId, name: e.definition.name, file: undefined })),
      ...inline.map((e) => ({ entryId: e.entryId, name: e.definition.name, file: undefined })),
      ...discovered.map((d) => ({ entryId: d.entry.entryId, name: d.entry.definition.name, file: d.file })),
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
      // **逆序卸两代**：外部可能 inject 了 builtin 提供的 Service，先卸外部才不会让
      // builtin 的 provider 在还有 consumer 时消失。
      const errors = await unmountGenerations(host, [BOOT_GENERATION, BUILTIN_GENERATION]);
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

    return Object.freeze({
      agent,
      extensions: Object.freeze(loaded),
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
    const errors: unknown[] = [e, ...(await unmountGenerations(host, [BOOT_GENERATION, BUILTIN_GENERATION]))];
    try {
      await agent.stop();
    } catch (stopError) {
      errors.push(stopError);
    }
    if (errors.length === 1) throw e;
    throw new AggregateError(errors, `装 Extension 失败，收摊时又有 ${errors.length - 1} 处失败：${errText(e)}`);
  }
}
