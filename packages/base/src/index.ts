// `@echo-agent/base` 公共面：**装配层**（2026-09-09 拆包，记录见
// `docs/decisions/implemented/2026-09-09-assembly-layer-packages.md`）。
//
// 它不是产品，也不是壳。它是「把一个产品跑起来」这件事本身：参数解析、凭据、引导设置的**时机**、
// 会话解析、装配、收摊、管道形态、观测面板。三个包的依赖是 core ← base ← {壳, 各产品}。
//
// **这里没有任何界面技术**：交互形态由产品在 bin 那一侧挑一个 `Shell` 实现交进来
// （终端那份是 `@echo-agent/tui` 的 `terminalShell`）。所以做 web / 桌面界面的产品依赖本包，
// 不必装一个终端库——那正是拆包要换来的东西。

/** 启动逻辑：把一个产品绑上壳，得到它的 `main`。 */
export {
  mainFor,
  parseArgs,
  usage,
  // 判据入口：`echoOptions` 是「装配现场那一份入参」，`wakeArgs` 是叫醒一段会话时传给子进程的参数。
  // 导出它们是为了让产品能对着**装配的真入参**写判据，而不是另搭一套。
  echoOptions,
  wakeArgs,
  type CliOptions,
  type Main,
  type MainDeps,
} from "./cli.ts";

/** 产品契约：一个产品交给启动逻辑的名字、版本与装配片段。 */
export { type PresetForm, type Product, type ProductHost } from "./product.ts";

/**
 * 壳端口：装配层只认它，谁实现它、用什么画界面都行。终端那份实现在 `@echo-agent/tui`。
 * `FirstRunChoice` / `FirstRunOutcome` 也在这里——它们是端口的一部分（装配层据此决定用哪家装配）。
 */
export type {
  FirstRunChoice,
  FirstRunOutcome,
  Shell,
  ShellConfigure,
  ShellExit,
  ShellFirstRunOptions,
  ShellHandle,
  ShellOpenOptions,
} from "./shell.ts";

/**
 * 装配层拥有的 prompt 段：工作纪律（文本一份，**产品自己挂**）与管道形态的交互面。
 * 产品的身份段归产品；终端的交互面归壳。
 */
export { conductEntry, conductSection, conductText, pipeSurfaceEntry, pipeSurfaceSection, PIPE_SURFACE } from "./prompt.ts";

/** 项目指令段：读 workspace 的 `AGENTS.md` / `CLAUDE.md`。core 是纯 JS 读不了文件，所以它落在这一层。 */
export {
  instructionsEntry,
  instructionsSection,
  loadInstructions,
  renderInstructions,
  neutralizeClosingTag,
  INSTRUCTION_FILES,
  INSTRUCTIONS_CAP,
  INSTRUCTIONS_HEADER,
} from "./instructions.ts";

/** 凭据的判据与验证（不碰界面）：这家配好了没、这把 key 能不能用。 */
export { isConfigured, verifyApiKey, type VerifyFn, type VerifyOutcome } from "./setup.ts";

/** 设置（记住上次选的模型）：`$ECHO_HOME/settings.json`。 */
export { readSettings, writeSettings, settingsPath, SETTINGS_FILE, type CliSettings, type SettingsReadResult } from "./settings.ts";

/** 管道形态的实质：给 Agent 一个进程与一个输入源。自己写别的输入源时用得上。 */
export { run, type RunOptions, type Sink } from "./run.ts";
export { linesOf } from "./stdin.ts";

/** 观测面板：只读盘上的观测库，不装配、不取锁。 */
export { runObserve, parseObserveArgs, observeUsage, type ObserveCommand, type ObserveOptions, type ObserveIo } from "./observe.ts";
