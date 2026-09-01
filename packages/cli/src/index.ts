// `@echo/tui` 公共面：**Echo 的官方 CLI 与默认壳**。
//
// 壳是一条官方 Extension，不是 core 外面套的一层（2026-08-31：壳也是 extension）。
// `echo:tui` inject core 那份封闭的 `AgentRuntime`（`@echo-agent/core/extension`），
// 于是壳与工具扩展长在同一套机制上——同一个 ExtensionHost、同一份所有权账本、同一条依赖图。
// 换一个壳（Web）只是换一条 inject 同一个 Service 的 Extension。
//
// 协议里没有 `start` / `stop`：**进程级启停归装配层**（`createEcho()` / `echo.stop()`），
// 壳子碰不到也不该碰。
//
// **`echo-agent` 这个可执行文件也住在本包**（2026-08-31 拍板方案 ③，原 `@echo/runner` 已删）：
// 归并落点不选 `@echo/core`，是因为 core 的运行时依赖恒空是硬门，而交互式终端要 `pi-tui`。
// core 保持纯库不出 bin。

/** 官方壳的 Extension 形态：交给 `createEcho({ extensions })` 去 mount。 */
export { tuiShell, type TuiShell } from "./extension.ts";

/** 渲染循环本体。自己写壳、或要换一套终端实现时用得上。 */
export { runTui, type TuiAppOptions, type TuiConfigureOptions } from "./app.ts";

/** 会话投影（含终端控制序列清洗与字素折行）。 */
export { Transcript, clean, type TranscriptEntry } from "./transcript.ts";

/** CLI：`echo-agent` 的解析与入口。两种形态的分叉在 `main()` 里。 */
export { main, parseArgs, USAGE, type CliOptions, type MainDeps } from "./cli.ts";

/**
 * 凭据配置段：缺 key 时主界面里摆出来的那一段，以及「配好了没」的判据（与请求路径同一个）。
 * 自己写壳时用得上。**它不是启动前置**——装配不看凭据（2026-09-01）。
 */
export {
  CredentialSetup,
  isConfigured,
  verifyApiKey,
  type CredentialSetupOptions,
  type VerifyFn,
  type VerifyOutcome,
} from "./setup.ts";

/** 管道形态的实质：给 Agent 一个进程与一个输入源。自己写别的输入源时用得上。 */
export { run, type RunOptions, type Sink } from "./run.ts";
export { linesOf } from "./stdin.ts";
