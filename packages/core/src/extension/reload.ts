// 热部署（2026-09-14 用户拍板）的结果形状。**纯类型**，不碰 `node:`——
// `AgentRuntime.reloadExtensions()`（壳看的协议）与 `Echo.reloadExtensions()`（装配层入口）返回的是同一份。
//
// 机制在别处：换代事务在 `host.ts` 的 `replace()`，安全时机在 `Agent.betweenRuns()`，
// 重扫目录 / 比对内容 / 加载新代码在 `create-echo.ts`（那是 node-only 的那一层）。
// 决策记录：`docs/decisions/proposed/2026-09-14-extension-hot-reload.md`。

/**
 * 一个盘上扩展在这次 reload 里发生了什么。`file` 是它的入口文件（与 `LoadedExtension.file` 同一个路径）。
 *
 *   · `added`：新文件，装上了；
 *   · `removed`：文件没了，卸掉了；
 *   · `replaced`：内容变了，新的一代已 ACTIVE、旧的已卸；
 *   · `unchanged`：内容没变，没动它（也没重新加载——同一份代码不会被求值第二次）；
 *   · `refused`：不能在此刻换（它声明的 `reload` 比当前安全点强，或别的扩展还依赖它 provide 的 Service），**原样保留**；
 *   · `rolled_back`：新版没装上（加载失败 / mount 失败），**旧版仍在**——加载失败时旧版根本没被卸过，mount 失败时是卸了再装回来的；
 *   · `failed`：本来就没装着（新文件、或上次就坏着的文件），这次也没装上；
 *   · `lost`：旧版卸了、新版没装上、旧版也装不回来——**现在什么都没挂着**。诊断里有两条。
 */
export type ReloadChange =
  | Readonly<{ kind: "added" | "removed" | "replaced" | "unchanged"; file: string }>
  | Readonly<{ kind: "refused" | "rolled_back" | "failed" | "lost"; file: string; reason: string }>;

/** 一次 reload 的完整回报：每个盘上扩展（包括没动的）一条，按入口路径排序。 */
export type ReloadReport = Readonly<{ changes: readonly ReloadChange[] }>;

/**
 * `reloadExtensions()` 的返回：与 `compact()` 同款——**不抛、不静默**。
 * `rejected` 的常态是「正在运行」（仅 idle 可换，不排队）；低层装配（没有扩展目录可扫）恒 rejected。
 */
export type ReloadResult = Readonly<{ kind: "done"; report: ReloadReport }> | Readonly<{ kind: "rejected"; reason: string }>;
