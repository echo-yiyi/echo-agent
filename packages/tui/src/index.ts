// `@echo-agent/tui` 公共面：**终端壳**（2026-09-09 拆包，记录见
// `docs/decisions/implemented/2026-09-09-assembly-layer-packages.md`）。
//
// 壳是一条官方 Extension，不是 core 外面套的一层（2026-08-31：壳也是 extension）。
// `echo:tui` inject core 那份封闭的 `AgentRuntime`，于是壳与工具扩展长在同一套机制上——
// 同一个 ExtensionHost、同一份所有权账本、同一条依赖图。
//
// 它是装配层那个 `Shell` 端口的**终端实现**：`terminalShell` 一件东西交给 `mainFor()` 即可。
// 换一个壳（Web、桌面）就是换一个实现，本包与它的 `pi-tui` 依赖一起不装。
//
// 协议里没有 `start` / `stop`：进程级启停归装配层，壳子碰不到也不该碰。

/** 交给 `mainFor(product, shell)` 的终端实现：界面本体 + 缺凭据时的引导设置。 */
export { terminalShell, tuiShell, type TuiShell } from "./extension.ts";

/** 渲染循环本体。自己写壳、或要换一套终端实现时用得上。 */
export { runTui, type TuiAppOptions, type TuiConfigureOptions } from "./app.ts";

/** 引导设置：欢迎 → 选 provider → 贴 key → 选模型。装配前跑，不需要 agent。 */
export { runFirstRunSetup, type FirstRunChoice, type FirstRunOptions, type FirstRunOutcome } from "./first-run.ts";

/** 主界面里的凭据配置段（收 key → 验一次 → 写盘）。判据与验证在 `@echo-agent/base`。 */
export { CredentialSetup, type CredentialSetupOptions } from "./setup.ts";

/** 会话投影（含终端控制序列清洗与字素折行）。 */
export { Transcript, clean, type TranscriptEntry } from "./transcript.ts";

/** 壳拥有的那一段 prompt：模型看到的是什么界面。管道那一版在 `@echo-agent/base`。 */
export { terminalSurfaceSection, TERMINAL_SURFACE } from "./prompt.ts";
