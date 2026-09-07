// TUI 应用：把 `AgentRuntime` 协议渲染到终端上。
//
// **壳是 extension，不是 core 外面套的一层**（2026-08-31 用户拍板）。它 `inject` core 那份
// 封闭的 `AgentRuntime`（`@echo-agent/core/extension`），协议里有什么它就得处理什么——
// TUI 与将来的 Web 壳是同一份协议的两个实现，我们只是默认提供了这一个。
//
// 于是这个文件**只认协议、不认 Agent**：`start` / `stop` / `deliver` 都不在协议里，
// 进程级启停归装配层（`createEcho()` / `echo.stop()`），壳子碰不到也不该碰。

import { errText, NO_SESSION_FACE, type AgentState, type CredentialStore, type Model, type Provider, type SessionFace, type ThinkingLevel } from "@echo-agent/core";
import type { AgentRuntime } from "@echo-agent/core/extension";
import {
  decodeKittyPrintable,
  Editor,
  fuzzyFilter,
  isKeyRelease,
  ProcessTerminal,
  SelectList,
  truncateToWidth,
  TuiMainScreen,
  visibleWidth,
  type AutocompleteItem,
  type TUI,
} from "@earendil-works/pi-tui";
import { Transcript, clean } from "./transcript.ts";
import { wrap } from "./text.ts";
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { installKeybindings } from "./keybindings.ts";
import { CredentialSetup, isConfigured, type VerifyFn } from "./setup.ts";
import { SlashCommandProvider, type SlashSpec } from "./slash.ts";
import { describeModel } from "./catalog.ts";
import { bold, dim, EDITOR_THEME, SELECT_LIST_THEME } from "./theme.ts";
import { ECHO_AGENT, type Product } from "./product.ts";

const ESC = String.fromCharCode(27);

/** 键位照 pi（`keybindings.ts`）。Ctrl+C 不再是退出——提示行必须写 Ctrl+D，否则用户按 Ctrl+C 只会看到输入被清掉。 */
const HINT = `${ESC}[2mEnter 发送 · Shift+Enter 换行 · Esc 中断 · Ctrl+D 退出${ESC}[22m`;

export type TuiAppOptions = Readonly<{
  /**
   * core 那份封闭协议。**壳子看得到的全部就是它**——没有 `start`/`stop`，
   * 因为进程级启停归装配层；没有 `deliver`，因为那是投递侧不是 UI。
   */
  agent: AgentRuntime;
  /**
   * 会话面（2026-09-07）：`/sessions` 读它。不给 = `NO_SESSION_FACE`——
   * 「一段都没有」是个诚实的答案，不是缺件；低层用户自己装壳时不必先有容器。
   */
  sessions?: SessionFace;
  /**
   * `/resume <id>` 的出口（2026-09-07）：**壳不换 Agent，壳只说「我要换到哪一段」然后退出**。
   *
   * 真正的换段在装配层（`runInteractive`）——它收摊这一段、按新 id 重装一份再把界面开回来。
   * 壳子里就地换 `AgentRuntime` 是做不到的：租约、收件箱、任务清单、闹钟、观测库都挂在
   * 那一个 `Agent` 上，换实例是装配的事，协议里连 `start`/`stop` 都没有。
   *
   * 不给 = 这个壳没有换段的去处（裸 `runTui()` 的低层用法），`/resume` 如实说一句、不动。
   */
  onResume?: (sessionId: string) => void;
  /** 欢迎头里的名字与版本（`product.ts`）。不给 = `echo-agent` 自己。 */
  product?: Pick<Product, "name" | "version">;
  /** 进程信号。abort = 停止收新输入并中断在飞的那一轮。 */
  signal?: AbortSignal;
  /** 注入用：测试给假的 TUI 与终端。 */
  ui?: TUI;
  /**
   * 壳外旁白的接入口（D6：装配诊断走它进屏幕）。传一个「挂 sink」函数，
   * runTui 起来时用 transcript 的 notice 通道接上，返回的摘除函数在收摊时调。
   */
  announcer?: (fn: (text: string) => void) => () => void;
  /**
   * 缺 key 时在界面里配的那一段要的东西（2026-09-01：配置是运行态，不阻塞启动）。
   * 不给 = 壳子不管凭据——低层用户自己装配、自己给 key 的场合。
   */
  configure?: TuiConfigureOptions;
}>;

export type TuiConfigureOptions = Readonly<{
  /**
   * 全部可选的家（P3b-a：Ctrl+L 跨家换模）。「当前家」按 `state.model.provider` 现查——
   * 换过之后凭据段、验证、目录全都自动跟着当前家走，壳子不记第二份。
   */
  providers: readonly { name: string; provider: Provider }[];
  credentials: CredentialStore;
  /** 换模成功后的回调（D7：cli 拿去写 settings.json，重启还能用）。传的是 provider **id** + 模型 id。 */
  onModelChange?: (model: { provider: string; id: string }) => void;
  /** 注入用：测试给假的验证。 */
  verify?: VerifyFn;
}>;

/**
 * 前两行（是什么 / 在哪）。首次运行的引导设置（`first-run.ts`）与主界面共用，进来第一眼是同一个头。
 * 「是什么」来自 `product`：`echo-agent` 自己，或依赖本包的产品（`echo-coding`）。
 */
export function bannerLines(product: Pick<Product, "name" | "version">, cwd: string): string[] {
  return [`${bold(product.name)}  ${dim(`v${product.version}`)}`, dim(cwd)];
}

/**
 * 欢迎头（P1，`docs/review/tui-design.md` §三）：启动时一次，在文档流最上面，跟着内容滚走。
 * 四行：是什么 / 在哪 / 用什么模型 / 键怎么按。模型来自 `AgentState.model`，cwd 是壳自己拿的。
 */
function welcomeLines(product: Pick<Product, "name" | "version">, state: Readonly<AgentState>, cwd: string): string[] {
  return [
    ...bannerLines(product, cwd),
    `模型 ${state.model.id} · ${state.model.provider}`,
    dim("Enter 发送 · Shift+Enter 换行 · Esc 中断 · Ctrl+D 退出 · ↑ 历史 · Ctrl+O 工具输出 · Ctrl+L 模型"),
    "",
  ];
}

/** Shift+Tab 轮换的顺序。全集来自 `ThinkingLevel`；协议拒绝的档位会原样把原因显示出来。 */
const THINKING_CYCLE: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

const STATUS_LABEL: Record<AgentState["status"], string> = {
  idle: "空闲",
  generating: "生成中",
  acting: "执行工具",
  compacting: "压缩中",
};

/** `1234` → `1.2k`。状态栏一行，数字要短。 */
function short(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n);
}

/**
 * 状态栏（P1，§四）：最底下一行，每次重画都从 `AgentRuntime.state` 现读——它就是整个 `AgentState`
 * （`runtime.ts:50-54`），所以这里显示的每一项都不需要壳子自己记一份。
 * 模型 / 状态 / 用量恒显；任务 / skill / MCP 为零就不占地方。
 */
function footerLine(
  state: Readonly<AgentState>,
  width: number,
  live: { frame: string; since: number | null },
): string {
  // 跑着的状态段带当前帧和已跑秒数（`since` 从 idle→busy 那次重画起算）；空闲保持素静
  const status =
    state.status === "idle"
      ? STATUS_LABEL.idle
      : `${live.frame} ${STATUS_LABEL[state.status]}${live.since === null ? "" : ` ${Math.max(0, Math.floor((Date.now() - live.since) / 1000))}s`}`;
  const parts = [
    state.model.id,
    status,
    `↑${short(state.usage.inputTokens)} ↓${short(state.usage.outputTokens)}`,
  ];
  // 缓存情况（2026-09-01 用户拍板：token 就够，但要看到缓存）。provider 没报就不占地方——
  // 显示 0% 会把「没报」冒充成「没命中」，那是两回事
  const cached = state.usage.cachedInputTokens;
  if (cached !== undefined && state.usage.inputTokens > 0) {
    parts.push(`缓存 ${short(cached)} (${Math.round((cached / state.usage.inputTokens) * 100)}%)`);
  }
  // 上下文占用（2026-09-02）：provider 每轮报的 usage 与压缩后的估算，配目录里的窗口；两边缺一个都不显示——
  // 只显示 token 数而没有分母，用户仍不知道离撞窗还有多远
  const window = state.model.capabilities?.contextWindow;
  if (state.contextTokens !== null && window !== undefined && window > 0) {
    parts.push(`上下文 ${short(state.contextTokens)}/${short(window)} (${Math.round((state.contextTokens / window) * 100)}%)`);
  }
  if (state.thinkingLevel !== "off") parts.push(`思考 ${state.thinkingLevel}`);
  if (state.tasks.total > 0) parts.push(`任务 ${state.tasks.active.length}/${state.tasks.total}`);
  if (state.activeSkills.length > 0) parts.push(`skill ${state.activeSkills.length}`);
  if (state.mcp.length > 0) parts.push(`mcp ${state.mcp.length}`);
  // 按**可见列宽**裁，不按码点：「空闲 / 缓存 / 上下文」是宽字符，一个占两列，按码点切会超宽——
  // 而 pi-tui 对超宽行直接抛，实测状态栏 60 > 55 整屏崩（2026-09-04）。次要项排在后面，
  // 放不下先整段从尾部丢；连第一段都放不下再硬截。字宽算法用 pi-tui 自己那套（与它的判定一致）。
  let kept = parts;
  while (kept.length > 1 && visibleWidth(kept.join(" · ")) > width) kept = kept.slice(0, -1);
  return dim(truncateToWidth(kept.join(" · "), Math.max(0, width), ""));
}

/** 跑到用户退出（Ctrl+C / Ctrl+D）或被中止，返回退出码。**不负责收摊 Agent**——那归装配层。 */
export async function runTui(options: TuiAppOptions): Promise<number> {
  const { agent, signal, configure, announcer, onResume } = options;
  const sessions = options.sessions ?? NO_SESSION_FACE;
  const ui: TUI = options.ui ?? new TuiMainScreen(new ProcessTerminal(), false, process.cwd());

  // 动效（2026-09-07）：**一个帧计时器驱动全部**——footer 状态段、执行中的工具标记、计秒。
  // 帧表与节拍取 pi-tui Loader 同款（Loader 是自带 interval 的组件，而我们的 footer 是每次
  // 重画现算的一行字，搬组件不如把帧接进自己的渲染流）。只在 `state.status` 非 idle 时设
  // interval——空闲不空转、不空耗重画；停表在 `syncSpinner`（每次重画核对）与退出 finally 两处。
  const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  const SPINNER_INTERVAL_MS = 80;
  let spinnerTick = 0;
  let spinnerTimer: ReturnType<typeof setInterval> | null = null;
  let busySince: number | null = null;
  const spinnerFrame = (): string => SPINNER_FRAMES[spinnerTick % SPINNER_FRAMES.length] ?? "⠋";
  const syncSpinner = (): void => {
    const running = agent.state.status !== "idle";
    if (running && spinnerTimer === null) {
      busySince = Date.now();
      spinnerTimer = setInterval(() => {
        spinnerTick += 1;
        rerender();
      }, SPINNER_INTERVAL_MS);
    } else if (!running && spinnerTimer !== null) {
      clearInterval(spinnerTimer);
      spinnerTimer = null;
      busySince = null;
    }
  };

  const transcript = new Transcript({ spinner: () => spinnerFrame() });
  const welcome = welcomeLines(options.product ?? ECHO_AGENT, agent.state, agent.state.workspace); // 「在哪」= session 的 workspace
  /**
   * 能不能收下一条输入，只由 `busy()` 决定——**「起来了没」也在里面**。
   *
   * 三轮 review 起，「空不空」不再由本地 `prompt()` 说了算——那样 `start()` 期间、
   * 以及 Inbox / Schedule 的自主 run 期间都会误判为空闲（实测：输入被清空 + 一句拒绝）。
   *
   * 四轮 review 又指出：拿 `agent_end` 当「空了」**也早**（circle 还没 settle permit）。
   * 五轮再指出：拿 `agent.status === "idle"` 判也**还差一段**——Inbox run 之后 core 是
   * `closeRun()`（置 `status = "idle"`）→ `await ackBatch()` → 清 `inboxTicketOutstanding`，
   * 中间那一段 `status` 已经 idle 而 `prompt()` 照拒。
   *
   * 四轮下来每次都慢一步，根因是**壳子在从外面猜一个只有 core 知道的判据**：
   * `prompt()` 会拒的五组条件里，`inboxTicketOutstanding` / `inboxFailure` / `leaseLostError` /
   * `phase` 一个都不在公共面上。所以不再猜——core 现在把那份判据读出来：
   *
   *     agent.acceptsWork   // 与 `prompt()` 同一份 `refuseWorkReason()`，不是近似条件
   *
   * `pendingLocal` 仍要留着，补的是另一头：`prompt()` 排进 admission 之后、permit 落位之前
   *（permit 在微任务里落位）`acceptsWork` 会短暂地又变成 true。这一小段只有调用方自己知道。
   *
   * **「读它 → 提交」必须在同一个同步段**：中间没有 await，别的 JS 跑不进来，所以判据不会在
   * 检查与 `prompt()` 之间失效。`onSubmit` 里现在就是这样——检查、清空、`submit()` 一路同步到
   * `prompt()` 内部那道同样的检查为止。
   */
  let pendingLocal = false; // 本地 `prompt()` 在飞：覆盖「已排队、permit 还没落位」那一小段
  const busy = (): boolean => pendingLocal || !agent.acceptsWork;
  let failed = false;
  let streamingIndex: number | null = null;
  const toolRows = new Map<string, number>();

  const rerender = (): void => {
    syncSpinner(); // 每次重画核对一次：busy 起表、idle 停表——状态从事件来，表从状态来
    ui.requestRender();
  };

  // **用 pi-tui 的 `Editor`，不自己写**（P0，`docs/review/tui-design.md` §二）：多行、按词移动、
  // 撤销、kill-ring、历史、bracketed paste、grapheme 边界、`CURSOR_MARKER`——全是它本身就有的行为。
  // 上一版用的是 `Input`（单行、无历史）；再上一版自写的 `PromptLine` 三条都错，review 逐条实测过。
  //
  // **键表先装、编辑器后造**：`Editor` 内部走 `getKeybindings()` 取键，装晚了它用的就是库缺省。
  const keys = installKeybindings();
  const editor = new Editor(ui, EDITOR_THEME, { paddingX: 1 });
  editor.onSubmit = (text: string): void => {
    const trimmed = text.trim();
    if (trimmed === "") return;
    // 斜杠命令：从 `slashCommands` 表派发（表见 compactNow 之后——菜单、派发、文案同一张表）。
    // 不认识的**报一句并把原文放回**，不发给模型——拼错命令静默变成一条消息，
    // 就是「写了没生效」在对话里的形态。
    if (trimmed.startsWith("/")) {
      const spaceIndex = trimmed.indexOf(" ");
      const name = (spaceIndex === -1 ? trimmed : trimmed.slice(0, spaceIndex)).slice(1);
      const command = slashCommands.find((c) => c.name === name);
      if (command !== undefined) {
        command.run(spaceIndex === -1 ? "" : trimmed.slice(spaceIndex + 1).trim());
        return;
      }
      editor.setText(text);
      transcript.push({ kind: "notice", text: `不认识的命令 /${name}（有 ${slashMenuText}）` });
      rerender();
      return;
    }
    // 有问题在等（`ask_user`）：这行字是回答，不是新的一句话——走 answerQuestion，不进 prompt。
    // 放在斜杠派发之后：等答的时候 /clear、/model 照样是命令，不能被当成回答送给模型。
    if (question !== null) {
      editor.addToHistory(trimmed); // 长回答也要 ↑ 翻得回来
      answerQuestionFromText(trimmed);
      return;
    }
    if (busy()) {
      // 还没就绪 / 正在跑：**文字放回输入行**，用户不用重打（不排队、不假装收下）。
      // `Editor.submitValue()` 是**先清空再回调**（与 `Input` 相反），所以这里要主动把它放回去——
      // 只断言「没发出去」是不够的，那样清空了也能过，用户却得重打一遍。
      // 「还没就绪」也落在 `acceptsWork` 上——未 running 时它就是 false，不需要壳子再记一个布尔。
      editor.setText(text);
      rerender();
      return;
    }
    // 发出去的才进历史（↑ 翻得到）；被拒的那次不进——它还留在输入行里，进了就是两份。
    // 清空由 `Editor` 自己做完了（见上），不再需要这里 `setValue("")`；「发完直接回车不重复发」的判据仍在。
    editor.addToHistory(trimmed);
    void submit(trimmed);
  };

  // **先订阅再 start()**——反过来会丢掉启动期间的事件（恢复、诊断都在那一段）。
  /**
   * **权限询问**：协议里 `permissionRequest` 是「必须有人回答」的那一支，
   * 而回答只能来自可信宿主（`answerPermission()` 是唯一入口，hook 只能观察）。
   *
   * 上一版 TUI **根本没订阅 lifecycle**，于是每一次 `ask` 都因为无人回答被折成 deny——
   * 用户看到「工具被拒」却不知道为什么。那不是设计，是壳子少实现了协议的一半。
   *
   * 交互形态的答法：把待答的那条摆在屏幕上，`y` / `n` 一键回答。**不排队**——
   * core 一次只会有一个 ask 等着（工具执行是串行的），多的那些由 core 自己管。
   */
  // **整条 ask 都留着**，不只留工具名（2026-08-31 review 二轮 P0）：
  // `PermissionAsk` 带的是 transform hooks 完成、重新校验并**冻结后的最终参数**——
  // 与 Tool `execute()` 收到的是同一份对象。只显示「允许 bash？」而不显示 `rm -rf /`，
  // 就是让用户**盲批**：他批准的和实际要跑的，屏幕上看不出是不是一回事。
  let pending: { permissionId: string; toolName: string; params: unknown } | null = null;

  /**
   * **提问**（`ask_user`，2026-09-05）：协议里与权限询问平行的另一支——那是壳子拦工具的工程机制，
   * 这是模型主动调的工具；回答只能来自 `answerQuestion()`。摆法：问题压在输入行上方，
   * 单选有选项时用选择器（↑/↓、回车），或在输入行打序号 / 自己的话再回车；多选打序号串。数字不直答——
   * 以数字开头的自由文本会被吞掉第一个字。
   * 一次只有一条（工具执行串行）；Esc 仍是中断那一轮，不是撤问题——撤了模型还在等。
   */
  type PendingQuestion = { questionId: string; question: string; options: readonly { label: string; description?: string }[]; multiSelect: boolean };
  let question: PendingQuestion | null = null;
  let questionList: SelectList | null = null;

  /**
   * **凭据配置段**（2026-09-01 用户拍板：配置是运行态，不阻塞启动）。
   *
   * 上一版是启动前弹一屏向导，用户一起来就被按在上面。现在装配不看凭据（`create-agent.ts`），
   * Agent 与壳照常起来；缺 key 时把这一段摆在输入行的位置上，配好就撤掉、输入行回来——
   * **不用重启**，因为模型早就解析好了，key 是每轮重读的。两个入口：
   *   · 启动时 `isConfigured()` 说没配；
   *   · 跑着的时候端点报 `auth`（key 被撤了 / 过期了）——`agent_end` 那支再摆一次。
   * `setup !== null` 就是「正在配」；那时 Ctrl+D 空时退出 / Ctrl+C 清空照旧由本文件分发。
   */
  /** 当前家 = `state.model.provider` 对应的那一项。换模之后它自动换，凭据段与目录都跟着走。 */
  const currentChoice = (): { name: string; provider: Provider } | undefined =>
    configure?.providers.find((c) => c.provider.id === agent.state.model.provider);

  let setup: CredentialSetup | null = null;
  /**
   * 摆出配置段。`reason` 只在**有新信息**时给（比如「这把 key 被端点拒了」）——
   * 段头自己会说「还没有 X 的 API key」，启动时再推一条 notice 就是同一句话说两遍
   * （2026-09-01 用户截图点名的重复）。
   */
  const enterConfigure = (reason?: string): void => {
    if (configure === undefined || setup !== null) return;
    const choice = currentChoice();
    if (choice === undefined) return; // 当前模型的家不在清单里（低层用法）：没有目录可配
    setup = new CredentialSetup({
      provider: choice.provider,
      credentials: configure.credentials,
      alternatives: configure.providers.filter((c) => c !== choice).map((c) => c.name),
      ...(configure.verify !== undefined ? { verify: configure.verify } : {}),
      ...(signal !== undefined ? { signal } : {}),
      onConfigured: () => {
        setup?.dispose();
        setup = null;
        transcript.push({ kind: "notice", text: "[凭据] 已保存。直接说话就行，不用重启。" });
        rerender();
      },
      onError: (e) => {
        // 写盘失败不是 key 的问题：如实报出来，撤掉这一段，别让用户对着它重输
        setup?.dispose();
        setup = null;
        failed = true;
        transcript.push({ kind: "notice", text: `[凭据] 没存上：${errText(e)}` });
        rerender();
      },
    });
    if (reason !== undefined) transcript.push({ kind: "notice", text: reason });
    rerender();
  };

  /**
   * 模型选择器（P3a，Ctrl+L）：**当前 provider 的目录内**换（跨 provider 是 P3b 的装配面）。
   * 目录来自 `configure.provider`——没给 configure 的低层用法没有目录，如实说一句。
   * 选中走协议 `setModel()`：仅 idle 可换、下一轮生效；忙时 rejected，把原因显示出来。
   */
  let modelPicker: SelectList | null = null;
  /** 选择器里的行：模型 + 它的家 + 那家配没配 key（未配的标出来，选了会主动弹配置段）。 */
  let pickerEntries: readonly { model: Model; configured: boolean }[] = [];
  /**
   * 防重入 token：构建是异步的（逐家问 `isConfigured`），期间再按 Ctrl+L 语义是「收起」——
   * token 一变，在飞的那次构建作废。不带这个的话快速连按两次会撞出两个构建、最后停在打开态（实测）。
   */
  let pickerToken = 0;
  /** 构建进行中。没有它的话「构建中再按一次」会开出第二个构建——第一次的 token 作废了，第二次的却是新 token，照样打开（实测）。 */
  let pickerOpening = false;
  const openModelPicker = (): void => {
    pickerToken += 1;
    if (modelPicker !== null || pickerOpening) {
      modelPicker = null; // Ctrl+L 再按一次 = 收起；构建中再按同理（token 已变，在飞构建作废）
      pickerOpening = false;
      rerender();
      return;
    }
    if (configure === undefined) {
      transcript.push({ kind: "notice", text: "[模型] 壳子没拿到目录（没给 configure 的低层用法没有选择器）" });
      rerender();
      return;
    }
    pickerOpening = true;
    void buildModelPicker(configure, pickerToken);
  };
  const buildModelPicker = async (conf: NonNullable<typeof configure>, token: number): Promise<void> => {
    // 跨家平铺（P3b-a）：每家问一次配没配 key（`isConfigured`，与请求路径同一判据），未配的标出来
    const entries: { model: Model; configured: boolean }[] = [];
    for (const c of conf.providers) {
      const configured = await isConfigured(c.provider, conf.credentials);
      for (const m of c.provider.getModels()) entries.push({ model: m, configured });
    }
    const current = agent.state.model;
    const picker = new SelectList(
      entries.map((e, i) => ({
        value: String(i),
        label: `${i + 1}. ${e.model.name ?? e.model.id}${e.model.id === current.id && e.model.provider === current.provider ? " ✓" : ""}`,
        description: `${e.configured ? "" : "未配 key · "}${e.model.provider} · ${describeModel(e.model)}`,
      })),
      12,
      SELECT_LIST_THEME,
    );
    picker.setSelectedIndex(Math.max(0, entries.findIndex((e) => e.model.id === current.id && e.model.provider === current.provider)));
    picker.onSelect = (item): void => pickModel(entries[Number(item.value)]!);
    picker.onCancel = (): void => {
      modelPicker = null;
      rerender();
    };
    if (token !== pickerToken) return; // 构建期间被收起 / 又开了一次：这份作废
    pickerOpening = false;
    pickerEntries = entries;
    modelPicker = picker;
    rerender();
  };
  /** `/model <id>`：跨五家目录按 id 直切，走与选择器同一条 `pickModel` 路（协议、写设置、主动弹配置段全一样）。 */
  const setModelById = async (id: string): Promise<void> => {
    if (configure === undefined) {
      transcript.push({ kind: "notice", text: "[模型] 壳子没拿到目录（没给 configure 的低层用法没有选择器）" });
      rerender();
      return;
    }
    for (const c of configure.providers) {
      const model = c.provider.getModels().find((m) => m.id === id);
      if (model !== undefined) {
        const configured = await isConfigured(c.provider, configure.credentials);
        pickModel({ model, configured });
        return;
      }
    }
    transcript.push({ kind: "notice", text: `[模型] 目录里没有 '${id}'——敲 /model 或 Ctrl+L 看有哪些` });
    rerender();
  };

  const pickModel = (e: { model: Model; configured: boolean }): void => {
    modelPicker = null;
    void agent.setModel(e.model).then((result) => {
      if (result.kind === "accepted") {
        transcript.push({ kind: "notice", text: `[模型] 已换到 ${e.model.id}（${e.model.provider}，下一轮生效）` });
        configure?.onModelChange?.({ provider: e.model.provider, id: e.model.id }); // D7：重启还能用
        // 换到还没配 key 的家：**主动**把配置段摆出来，不等第一句 prompt 撞 auth
        if (!e.configured) enterConfigure();
      } else {
        transcript.push({ kind: "notice", text: `[模型] 没换成：${result.reason}` });
      }
      rerender();
    });
    rerender();
  };

  /** Shift+Tab：thinking 档位轮换。协议拒了（正在跑）就把原因显示出来，档位原样不动。 */
  const cycleThinking = (): void => {
    const now = agent.state.thinkingLevel;
    const next = THINKING_CYCLE[(THINKING_CYCLE.indexOf(now) + 1) % THINKING_CYCLE.length]!;
    void agent.setThinkingLevel(next).then((result) => {
      if (result.kind === "rejected") transcript.push({ kind: "notice", text: `[思考] 没换成：${result.reason}` });
      rerender(); // 换成了不用说话——状态栏现读 state，档位直接变
    });
  };

  /** `/clear`：协议 `reset()` 清会话真相，成了再清屏幕投影——只清一边就是两份真相分叉。 */
  const clearConversation = (): void => {
    void agent.reset().then((result) => {
      if (result.kind === "rejected") {
        transcript.push({ kind: "notice", text: `[清空] 没清成：${result.reason}` });
      } else {
        transcript.clear();
        transcript.push({ kind: "notice", text: "[清空] 对话已清；模型与 thinking 档位不动" });
      }
      rerender();
    });
  };

  /** `/compact [指令]`：协议 `compact()`——与自动压缩同一条流水线。结果如实显示：压了哪些阶段 / 没什么可压 / 被拒（正在跑、没策略）。 */
  const compactNow = async (instructions: string): Promise<void> => {
    transcript.push({ kind: "notice", text: "[压缩] 开始…" });
    rerender();
    const result = await agent.compact(instructions === "" ? undefined : instructions);
    if (result.kind === "rejected") transcript.push({ kind: "notice", text: `[压缩] 没压成：${result.reason}` });
    else if (result.stages.length === 0) transcript.push({ kind: "notice", text: "[压缩] 没有可压的内容" });
    else {
      const size = result.contextTokens !== null ? `，上下文约 ${short(result.contextTokens)} token` : "";
      transcript.push({ kind: "notice", text: `[压缩] 完成：${result.stages.join(" → ")}${size}；原文仍可经 transcript_read 读取` });
    }
    rerender();
  };

  /** `/model <id>` 的参数补全：全目录（不分家）按 id fuzzy 过滤；低层用法没给 configure 就没有菜单。 */
  const modelIdCompletions = (prefix: string): AutocompleteItem[] | null => {
    if (configure === undefined) return null;
    const items = configure.providers.flatMap((c) =>
      c.provider.getModels().map((m) => ({ value: m.id, label: m.id, description: `${c.name} · ${m.name ?? m.id}` })),
    );
    const filtered = fuzzyFilter(items, prefix, (i) => i.value);
    return filtered.length === 0 ? null : filtered;
  };

  /**
   * `/sessions`：把**别的会话**摆出来——同一台机器上另开的终端、别人派出去的那些段。
   *
   * **只看不切**：切是 `/resume <id>` 的事（切过去要换一个 `Agent` 实例——lease、inbox、
   * 任务清单、闹钟、观测库都得重来，所以由装配层收摊重装，见 `onResume`）。这里只把
   * 「谁在跑、在哪、忙不忙」说清楚——两个终端各跑一段时，这是唯一能一眼看到对面的地方。
   *
   * 一行一段，用的是 core 合成好的那份（`alive` 为假时 `phase` 恒为 null，见 sessions.md §6），
   * 壳不自己组合——三个消费者各组合一遍就会各错一遍。
   */
  const listSessionsNow = async (): Promise<void> => {
    const rows = await sessions.list().catch((e: unknown) => e as Error);
    if (rows instanceof Error) {
      transcript.push({ kind: "notice", text: `[会话] 列不出来：${rows.message}` });
      rerender();
      return;
    }
    const mine = agent.state.sessionId;
    const others = rows.filter((r) => r.id !== mine);
    if (others.length === 0) {
      transcript.push({ kind: "notice", text: "[会话] 只有这一段在跑" });
    } else {
      const lines = others.map((r) => {
        // 没在跑的分两种说法（2026-09-07）：叫得醒 = 仍是能说话的对象；叫不醒 = 它只是盘上的一份记录，
        // 得说清楚「从这儿够不着」，否则看着像个能发消息的对象，其实发不过去。
        const where = r.alive
          ? r.phase === null
            ? "在跑"
            : r.phase === "working"
              ? "在跑 · 忙着"
              : "在跑 · 空闲"
          : sessions.canWake
            ? "没在跑 · 发消息会把它叫起来"
            : "没在跑 · 从这儿够不着（/resume 切过去）";
        return `  ${r.id}  ${r.name}  [${r.agent}]  ${where}  ${r.workspace}`;
      });
      transcript.push({ kind: "notice", text: `[会话] 另外 ${others.length} 段：\n${lines.join("\n")}` });
    }
    rerender();
  };

  /**
   * `/resume <id>`：切到另一段会话。**壳只挑段并退出，换实例归装配层**（见 `onResume`）。
   *
   * 点名可以给 id、id 的前缀、或名字的一截——id 是 16 位十六进制，指望人照着敲全是不现实的。
   * 认不准就把候选摆出来让人再点一次，**不猜**：切错段的代价是打断另一段的活。
   */
  const resumeSession = async (rest: string): Promise<void> => {
    const say = (text: string): void => {
      transcript.push({ kind: "notice", text });
      rerender();
    };
    if (onResume === undefined) return say("[会话] 这个壳没有换段的去处（低层用法自己装配，换段归装配层）");
    if (rest === "") return say("[会话] 要点名切到哪一段：/resume <id>——敲 /sessions 看有哪些");
    // 不空就不切：切 = 收摊这一段，会把在飞的那一轮掐掉。让人自己按 Esc，别替他决定。
    // 判据与收输入同一条（`busy()`），所以「还没就绪」也在里面——`start()` 落位前照样顶回去。
    if (busy()) return say("[会话] 还没就绪 / 正在跑，先 Esc 中断或等它空下来再切");
    const rows = await sessions.list().catch((e: unknown) => e as Error);
    if (rows instanceof Error) return say(`[会话] 列不出来：${rows.message}`);
    const needle = rest.toLowerCase();
    const exact = rows.find((r) => r.id === rest);
    const hits = exact !== undefined ? [exact] : rows.filter((r) => r.id.startsWith(needle) || r.name.toLowerCase().includes(needle));
    if (hits.length === 0) return say(`[会话] 没有匹配 '${rest}' 的段——敲 /sessions 看有哪些`);
    if (hits.length > 1) return say(`[会话] '${rest}' 对上了 ${hits.length} 段，说全一点：\n${hits.map((r) => `  ${r.id}  ${r.name}`).join("\n")}`);
    const target = hits[0]!;
    if (target.id === agent.state.sessionId) return say("[会话] 已经在这一段了");
    onResume(target.id); // 装配层收到之后：收摊这一段 → 按新 id 重装 → 界面开回来
    quit();
  };

  // 斜杠命令：**一张表喂三处**——编辑器的补全菜单、onSubmit 的派发、报错文案里的清单。
  // 加命令只改这里；三处各写一份就是漂移的起点。
  const slashCommands: readonly SlashSpec[] = [
    { name: "clear", description: "清空对话，重新开始", run: () => clearConversation() },
    { name: "sessions", description: "列出别的会话（只看，不切）", run: () => void listSessionsNow() },
    {
      name: "resume",
      argumentHint: "<id>",
      description: "切到另一段会话",
      run: (rest) => void resumeSession(rest),
    },
    {
      name: "model",
      argumentHint: "[模型id]",
      description: "选模型：不带参数开选择器，带 id 直切",
      getArgumentCompletions: (prefix) => modelIdCompletions(prefix),
      run: (rest) => (rest === "" ? openModelPicker() : void setModelById(rest)),
    },
    {
      name: "compact",
      argumentHint: "[指令]",
      description: "手动压缩上下文，可带侧重指令",
      run: (rest) => void compactNow(rest),
    },
  ];
  const slashMenuText = slashCommands
    .map((c) => `/${c.name}${c.argumentHint === undefined ? "" : ` ${c.argumentHint}`}`)
    .join("、");
  editor.setAutocompleteProvider(new SlashCommandProvider(slashCommands));

  const answer = (decision: "allow" | "deny"): void => {
    const ask = pending;
    if (ask === null) return;
    pending = null;
    rerender();
    void agent.answerPermission({ permissionId: ask.permissionId, decision }).then(
      (result) => {
        // **回答可能过期**（那一轮已经 abort / Agent 已收摊）：如实说出来，
        // 不能让用户以为自己批准的那件事真的发生了。
        if (result.kind !== "accepted") {
          transcript.push({ kind: "notice", text: `[权限] 这次回答没生效：${result.kind}` });
          rerender();
        }
      },
      (e: unknown) => {
        transcript.push({ kind: "notice", text: `[权限] 回答失败：${e instanceof Error ? e.message : String(e)}` });
        rerender();
      },
    );
  };

  /** 收下一条 ask（新来的、或订阅之前就欠着的）。按 `permissionId` 合并，不重复摆。 */
  const takeAsk = (ask: { permissionId: string; toolName: string; params: unknown; reason?: string }): void => {
    if (pending?.permissionId === ask.permissionId) return;
    pending = { permissionId: ask.permissionId, toolName: ask.toolName, params: ask.params };
    transcript.push({ kind: "notice", text: `[权限] 要用 ${ask.toolName}${ask.reason === undefined ? "" : `：${ask.reason}`}` });
    rerender();
  };

  const answerQuestion = (selected: readonly string[], text?: string): void => {
    const q = question;
    if (q === null) return;
    question = null;
    questionList = null;
    transcript.push({ kind: "notice", text: `[回答] ${[...selected, ...(text === undefined ? [] : [text])].join("、")}` });
    rerender();
    void agent.answerQuestion({ questionId: q.questionId, selected, ...(text === undefined ? {} : { text }) }).then(
      (result) => {
        // 回答可能过期（那一轮已经 abort / 超时）：如实说，别让用户以为模型收到了
        if (result.kind !== "accepted") {
          transcript.push({ kind: "notice", text: `[提问] 这次回答没生效：${result.kind}` });
          rerender();
        }
      },
      (e: unknown) => {
        transcript.push({ kind: "notice", text: `[提问] 回答失败：${e instanceof Error ? e.message : String(e)}` });
        rerender();
      },
    );
  };

  /** 输入行里的字作为回答：全是序号（多选可多个，逗号隔开）就按序号选；其余当自由文本。 */
  const answerQuestionFromText = (text: string): void => {
    const q = question;
    if (q === null) return;
    const parts = text.split(/[\s,，、]+/).filter((s) => s !== "");
    if (q.options.length > 0 && parts.length > 0 && parts.every((n) => /^\d+$/.test(n))) {
      const picked = [...new Set(parts.map((n) => q.options[Number(n) - 1]?.label))].filter((l): l is string => l !== undefined);
      // 全是序号但对不上（越界 / 单选给了多个）：放回输入行说一句，**不**当自由文本送出去——「9」不是回答
      if (picked.length !== new Set(parts).size || (!q.multiSelect && picked.length !== 1)) {
        editor.setText(text);
        transcript.push({
          kind: "notice",
          text: !q.multiSelect && picked.length > 1 ? "[提问] 这个问题只能选一项" : `[提问] 没有这个序号（1 到 ${q.options.length}）`,
        });
        rerender();
        return;
      }
      answerQuestion(picked);
      return;
    }
    answerQuestion([], text);
  };

  /** 收下一条提问（新来的、或订阅之前就欠着的）。按 `questionId` 合并，不重复摆。 */
  const takeQuestion = (q: PendingQuestion): void => {
    if (question?.questionId === q.questionId) return;
    question = { questionId: q.questionId, question: q.question, options: q.options, multiSelect: q.multiSelect };
    questionList = null;
    if (q.options.length > 0 && !q.multiSelect) {
      const list = new SelectList(
        q.options.map((o, i) => ({ value: o.label, label: `${i + 1}. ${o.label}`, description: o.description ?? "" })),
        8,
        SELECT_LIST_THEME,
      );
      list.onSelect = (item): void => answerQuestion([item.value]);
      questionList = list;
    }
    transcript.push({ kind: "notice", text: `[提问] ${q.question}` });
    rerender();
  };

  const unsubscribeLifecycle = agent.subscribeLifecycle((event) => {
    switch (event.type) {
      case "sessionStart":
        // **续了就得说**（2026-09-01 用户拍板）：无声恢复 = 用户以为全新开始、模型脑子里却带着上一场。
        // 只在真续了（带着条数）时说；新建一段是缺省，不值得占一行。
        if (event.resumed) {
          transcript.push({ kind: "notice", text: `[会话] 续 ${event.sessionId ?? "?"}：带着上一场的 ${event.messageCount} 条（/clear 从头开始）` });
          rerender();
        }
        return;
      case "permissionRequest":
        takeAsk(event);
        return;
      case "permissionCancelled":
        // 那一轮没了（abort / 收摊）：把问题从屏幕上撤掉，别让用户对着一个死问题按键
        if (pending?.permissionId === event.permissionId) pending = null;
        rerender();
        return;
      case "question":
        takeQuestion(event);
        return;
      case "questionCancelled":
        // 没等到答案（超时 / 中止 / 收摊）：撤掉，同权限那边
        if (question?.questionId === event.questionId) {
          question = null;
          questionList = null;
        }
        rerender();
        return;
      case "toolUseDenied":
        transcript.push({ kind: "notice", text: `[拒绝] ${event.toolName}：${event.reason}` });
        rerender();
        return;
      case "notification":
        transcript.push({ kind: "notice", text: event.message });
        rerender();
        return;
      default:
        return;
    }
  });

  const unsubscribe = agent.subscribe((event) => {
    switch (event.type) {
      case "message_update": {
        // **用事件带的权威 partial，不自己攒 delta**：`message_update` 就带着此刻的完整 `message`。
        // 自己累加等于在 TUI 里维护第二份真相，重试 / 丢包 / 定稿修正时两边会分叉。
        if (streamingIndex === null) streamingIndex = transcript.push({ kind: "assistant", text: "", streaming: true });
        transcript.setAssistantContent(streamingIndex, contentOf(event.message.content));
        rerender();
        return;
      }
      case "message_end":
        if (event.message.role !== "assistant") return;
        // **无条件以定稿为准**，包括定稿为空（只带 tool_use 的那一轮、错误轮）：
        // 只发 done 的 provider 一个 delta 都没有，被修正的定稿也要覆盖旧 partial。
        if (streamingIndex === null) streamingIndex = transcript.push({ kind: "assistant", text: "", streaming: true });
        transcript.finishAssistant(streamingIndex, contentOf(event.message.content));
        streamingIndex = null;
        rerender();
        return;
      case "tool_execution_start": {
        // 参数整份交给条目（展开时看全量），摘要一行折叠时看
        const row = transcript.push({
          kind: "tool",
          name: event.toolName,
          detail: summaryOf(event.params),
          state: "running",
          params: event.params,
        });
        toolRows.set(event.toolCallId, row);
        rerender();
        return;
      }
      case "agent_start":
        // 只重画——**运行态不在这里记**（见 `busy()` 的注释：镜像一份就会漂）。
        // run 落位比这一拍还早，所以这时 `agent.acceptsWork` 已经是 false。
        rerender();
        return;
      case "agent_end":
        // **这里不置「空闲」**：`agent_end` 只是循环收尾，core 还要 settle permit 才 `closeRun()`，
        // Inbox 那条更要等 ack 裁决。空不空由 `busy()` 现读 `agent.acceptsWork`。
        streamingIndex = null;
        // **错误在这里显示，不在 `submit()` 里**：自主 run 没有调用方接 outcome，
        // 两边都显示又会让本地那一轮出现两条一模一样的 `[错误]`。
        if (event.outcome.kind === "error") {
          failed = true;
          // 迭代上限不是「坏了」，是预算用完：说清下一步——已经做的都在上下文里，一句「继续」就接着跑
          const hint = event.outcome.error.code === "max_iterations" ? "（已做的都在，输入「继续」接着跑）" : "";
          transcript.push({ kind: "notice", text: `[错误] ${event.outcome.error.message}${hint}` });
          // 端点说 key 不对（没配 / 被撤 / 过期）：把配置段摆出来，而不是让用户对着一句 `[错误]` 猜
          if (event.outcome.error.code === "auth") enterConfigure("[凭据] 这把 key 不能用了——重新配一个");
        }
        rerender();
        return;
      case "tool_execution_end": {
        const row = toolRows.get(event.toolCallId);
        if (row !== undefined) {
          transcript.updateTool(row, { state: event.result.isError ? "failed" : "done", result: event.result });
          toolRows.delete(event.toolCallId);
          rerender();
        }
        return;
      }
      default:
        return;
    }
  });

  // **订阅之后立刻补一次已存在的 ask**，而且在**同一同步段**里做（中间不许 await）：
  // 协议把 `pendingPermissions` 摆出来就是为了这个——Extension 换代 / 壳重挂时，
  // 订阅只能收到「此后」的事件，**在那之前就欠着的那条谁也不会重发**。
  // 不补的话用户看不到问题，run 一直等到 `askTimeoutMs` 折成 deny，全程无人知情。
  // 顺序不能反：先读后订阅会漏掉两步之间新来的那条。
  for (const ask of agent.pendingPermissions) takeAsk(ask);
  for (const q of agent.pendingQuestions) takeQuestion(q);

  const submit = async (text: string): Promise<void> => {
    transcript.push({ kind: "user", text });
    // 只封「已经发出去、`agent_start` 还没到」这一小段：`prompt()` 是异步的，
    // 这中间用户再敲一次回车就会发第二条。**run 一开始就交棒给 `running`**。
    pendingLocal = true;
    rerender();
    try {
      // **`outcome` 里的错误不在这里显示**——`agent_end` 统一显示（见上面那支 case）。
      // 两边都显示 = 同一个错误在屏幕上出现两次（review 点名要避免的）。
      await agent.prompt(text);
    } catch (e) {
      // `prompt()` **自己抛**（被拒、已停）是另一回事：那种情况下 run 根本没开始，
      // 也就没有 `agent_end` 会来——不在这里显示就彻底没人显示了。
      failed = true;
      transcript.push({ kind: "notice", text: `[拒绝] ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      pendingLocal = false;
      rerender();
    }
  };

  let resolveExit: (() => void) | null = null;
  const exited = new Promise<void>((resolve) => {
    resolveExit = resolve;
  });
  const quit = (): void => {
    resolveExit?.();
    resolveExit = null;
  };

  // **root 要实现 `Focusable` 并把焦点代理给 `Editor`**：pi-tui 靠组件上的 `focused` 字段决定
  // 要不要输出 `CURSOR_MARKER`。上一版把焦点给了没有这个字段的 wrapper，于是编辑器的 `focused`
  // 永远是 false、光标标记一次都没输出——硬件光标与中文 IME 候选框的定位全落空（review 实测）。
  const root = {
    get focused(): boolean {
      return editor.focused;
    },
    set focused(value: boolean) {
      editor.focused = value;
    },
    render: (width: number): string[] => {
      // 文档流：欢迎头 → 对话；然后输入行；最后状态栏。三段式（§一），P1 先按行拼，P2 换 Container。
      // 欢迎头也按宽度折：那几行是固定文案，但键位提示 95 列、cwd 可以任意长——
      // 终端比它窄时 pi-tui 的渲染门一样会抛，启动即崩（与工具折叠行同一类，2026-09-01）。
      const lines = [...welcome.flatMap((l) => wrap(l, width)), ...transcript.render(width)];
      // 待答的权限问题**压在输入行上方**，且提示语写清按什么键——
      // 「屏幕上有个问题但没说怎么答」和没问是一样的
      if (pending !== null) {
        // **参数经 `clean()` 再上屏**：它来自模型，与正文一样不可信——不洗的话
        // 一条 `OSC 52` 就能在「请你确认」这一步改用户剪贴板（transcript 那边同款理由）。
        // 折行也走同一条：参数常常很长，硬塞会把提示挤出屏幕。
        for (const line of wrapForWidth(clean(paramsText(pending.params)), width)) {
          lines.push(`${ESC}[33m│ ${line}${ESC}[39m`);
        }
        lines.push(`${ESC}[33m允许 ${clean(pending.toolName)}？[y/n]${ESC}[39m`);
      }
      // 待答的提问（`ask_user`）同样压在输入行上方；文字来自模型，经 `clean()` 再上屏
      if (question !== null) {
        const inner = Math.max(1, width - 2);
        for (const line of wrapForWidth(clean(question.question), inner)) lines.push(`${ESC}[35m│ ${line}${ESC}[39m`);
        if (questionList !== null) {
          lines.push(...questionList.render(width));
          lines.push(dim("↑/↓ 选 · 回车确认 · 或输入序号 / 直接打字回答，回车发送"));
        } else if (question.options.length > 0) {
          question.options.forEach((o, i) => {
            for (const line of wrapForWidth(clean(`${i + 1}. ${o.label}${o.description === undefined ? "" : `  ${o.description}`}`), inner)) lines.push(`  ${line}`);
          });
          lines.push(dim(question.multiSelect ? "输入序号（可多个，逗号隔开）或直接打字回答，回车发送" : "输入序号或直接打字回答，回车发送"));
        } else {
          lines.push(dim("在输入行打字回答，回车发送"));
        }
      }
      // 模型选择器（Ctrl+L）：顶替输入行的位置，选完或 Esc 收起
      if (modelPicker !== null) {
        lines.push(bold("选择模型"));
        lines.push(dim("当前 ✓。仅 idle 可换，下一轮生效；↑/↓ 选 · 数字直选 · 回车确认 · Esc 收起"));
        lines.push("");
        lines.push(...modelPicker.render(width));
        lines.push(footerLine(agent.state, width, { frame: spinnerFrame(), since: busySince }));
        return lines;
      }
      // 正在配 key：这一段**顶替**输入行的位置，配好了输入行回来
      if (setup !== null) {
        lines.push(...setup.render(width));
        lines.push(footerLine(agent.state, width, { frame: spinnerFrame(), since: busySince }));
        return lines;
      }
      lines.push(...editor.render(width));
      // 空闲且没打字时给一句提示；有字或在跑就不占地方
      if (editor.getText() === "" && !busy()) lines.push(...wrap(HINT, width)); // 54 列，窄终端要折
      lines.push(footerLine(agent.state, width, { frame: spinnerFrame(), since: busySince }));
      return lines;
    },
    /**
     * 按键分发。**判定只走 `keys.matches()`，不比较字节**（`keybindings.ts` 头注说了为什么）。
     * 顺序即优先级：
     *   ① Kitty 协议给同一次按键补发的 release，一律丢——否则按一下等于按两下；
     *   ② 有待答的权限问题时，`y` / `n` 先被它吃掉：那一刻用户面对的是一个是非题，不是在写下一句话。
     *      不这么做的话按键会落进输入行，问题一直挂着——core 那边则在 `askTimeoutMs` 到点后
     *      按策略折成 deny，用户完全不知道发生过什么；
     *   ③ 应用级三个键（照 pi）：Ctrl+D **空时**退出 / Ctrl+C 清空 / Esc 中断在飞的那一轮；
     *   ④ 其余全给编辑器——包括有字时的 Ctrl+D（它是向前删一个字符）和空闲时的 Esc。
     */
    handleInput: (data: string): void => {
      if (isKeyRelease(data)) return;
      if (pending !== null) {
        if (keys.matches(data, "app.permission.allow")) return answer("allow");
        if (keys.matches(data, "app.permission.deny")) return answer("deny");
      }
      // 单选提问、输入行为空：↑/↓/回车交给选择器；其它键（打字、序号、Esc 中断、Ctrl+C/D）照常走下面。
      // 数字**不**直答：以数字开头的自由文本（「2 weeks」）会被吞掉第一个字；序号也要回车才算数
      if (question !== null && questionList !== null && editor.getText() === "" && isListNavKey(keys, data)) {
        questionList.handleInput(data);
        rerender();
        return;
      }
      // 问题 / 权限在等时不开选择器：两样叠在一起，按键不知道该给谁
      if (keys.matches(data, "app.model.select") && setup === null && question === null && pending === null) {
        openModelPicker();
        return;
      }
      if (modelPicker !== null) {
        // 数字直选（Kitty 下可打印字符走 CSI-u，选择器内部照样认 ↑↓/回车/Esc）
        const printable = decodeKittyPrintable(data) ?? data;
        if (/^[1-9]$/.test(printable)) {
          const i = Number(printable) - 1;
          if (i < pickerEntries.length) {
            pickModel(pickerEntries[i]!);
            return;
          }
        }
        modelPicker.handleInput(data);
        rerender();
        return;
      }
      if (keys.matches(data, "app.thinking.cycle") && setup === null) {
        cycleThinking();
        return;
      }
      if (keys.matches(data, "app.tools.expand")) {
        transcript.toggleTools();
        rerender();
        return;
      }
      // 正在配 key：应用级键的语义不变（Ctrl+D 空时退出 / Ctrl+C 清空），只是「空不空」问的是它
      if (setup !== null) {
        if (keys.matches(data, "app.exit") && setup.isEmpty()) {
          quit();
          return;
        }
        if (keys.matches(data, "app.clear")) {
          setup.clear();
          rerender();
          return;
        }
        setup.handleInput(data);
        rerender();
        return;
      }
      if (keys.matches(data, "app.exit") && editor.getText() === "") {
        // 在飞的那一轮先 abort，让 stop() 不用等模型说完
        if (busy()) agent.abort("用户中断");
        quit();
        return;
      }
      if (keys.matches(data, "app.clear")) {
        editor.setText("");
        rerender();
        return;
      }
      if (keys.matches(data, "app.interrupt") && busy()) {
        agent.abort("用户中断");
        rerender();
        return;
      }
      editor.handleInput(data);
      rerender();
    },
    invalidate: (): void => {
      transcript.invalidate();
      editor.invalidate();
      setup?.invalidate();
    },
  };

  const onAbort = (): void => {
    if (busy()) agent.abort("收到停止信号");
    quit();
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  // **已经 abort 的 signal 不会补发事件**：`createAgent()` 期间就被中止的话，
  // 光靠监听器会永远停在下面那个 `await exited`（review 实测）。所以注册完再主动看一眼。
  if (signal?.aborted === true) onAbort();

  // 启动时问一次「配好了没」。**读不了凭据文件也不挡着**（文件坏了、权限不对）：如实说一句，
  // 当成没配——用户在界面里重配时写盘会再撞一次并报出来，那是修文件的事，不是挡启动的理由。
  let needsConfigure = false;
  const startupChoice = currentChoice();
  if (configure !== undefined && startupChoice !== undefined) {
    try {
      needsConfigure = !(await isConfigured(startupChoice.provider, configure.credentials));
    } catch (e) {
      transcript.push({ kind: "notice", text: `[凭据] 读不了凭据文件：${errText(e)}` });
      needsConfigure = true;
    }
  }

  ui.addChild(root);
  ui.setFocus(root);
  ui.start();

  // 壳外旁白（装配诊断等）接进 notice 通道；界面起来前积压的这一刻一次放行
  const detachAnnouncer = announcer?.((text) => {
    transcript.push({ kind: "notice", text });
    rerender();
  });

  try {
    // **壳子不再 `start()`**（2026-08-31 壳变 extension）：启停归装配层。
    // 「起来了没」由协议的 `acceptsWork` 说了算——它在 running 之前恒为 false，
    // 所以从前那个 `ready` 布尔整个删掉了：一份判据，不再有壳子自己维护的第二份。
    if (signal?.aborted !== true) {
      // 「接上了、用的什么模型」由欢迎头说（`welcomeLines`），不再单发一行 notice
      if (needsConfigure) enterConfigure();
      rerender();
      await exited;
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    detachAnnouncer?.();
    unsubscribeLifecycle();
    unsubscribe();
    // `setup` 只在闭包里被赋值，TS 在这个作用域把它收窄成了 null——显式标回类型再调
    (setup as CredentialSetup | null)?.dispose(); // 缓冲区里不留 key
    if (spinnerTimer !== null) clearInterval(spinnerTimer); // 停表：挂着 interval 进程收不了摊
    ui.stop();
    // **不收摊 Agent**：协议里没有 `stop`，那是装配层（`echo.stop()`）的事。
    // 壳子自己停 Agent 就等于两个所有者——那正是把 `start`/`stop` 挡在协议外面要防的。
  }
  return failed ? 1 : 0;
}

/**
 * 消息内容 → 正文 + thinking。线上形状里 content 可能是字符串或块数组；
 * 被安全过滤器抹掉的 thinking（`redacted`）正文没有，不显示。
 */
function contentOf(content: unknown): { text: string; thinking: string } {
  if (typeof content === "string") return { text: content, thinking: "" };
  if (!Array.isArray(content)) return { text: "", thinking: "" };
  let text = "";
  let thinking = "";
  for (const b of content as { type?: unknown; text?: unknown; thinking?: unknown; redacted?: unknown }[]) {
    if (typeof b !== "object" || b === null) continue;
    if (b.type === "text" && typeof b.text === "string") text += b.text;
    else if (b.type === "thinking" && typeof b.thinking === "string" && b.redacted !== true) thinking += b.thinking;
  }
  return { text, thinking };
}

/** 工具参数的一行摘要（折叠时看）。JSON 压成一行、截到 80 列；展开时看的是全量，见 `messages.ts`。 */
function summaryOf(params: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(params) ?? "";
  } catch {
    return "(参数无法序列化)";
  }
  if (text === "{}" || text === "") return "";
  return text.length > 80 ? `${text.slice(0, 79)}…` : text;
}

/** 提问选择器只吃上下与回车——走键表，不比字节（本文件的纪律，见 `keybindings.ts` 头注）；其余留给输入行与应用级键。 */
function isListNavKey(keys: ReturnType<typeof installKeybindings>, data: string): boolean {
  return keys.matches(data, "tui.select.up") || keys.matches(data, "tui.select.down") || keys.matches(data, "tui.select.confirm");
}

/**
 * 把冻结后的最终参数渲染成一行行文本。**JSON 是唯一诚实的形状**——
 * 换成「人话摘要」就等于在用户和实际要执行的东西之间又加一层解释，那正是盲批的来源。
 */
function paramsText(params: unknown): string {
  if (params === undefined) return "(无参数)";
  try {
    return JSON.stringify(params) ?? String(params);
  } catch {
    // 循环引用之类：**说清楚渲染不出来**，不能默默显示成空——空会被读成「没有参数」
    return "(参数无法序列化——不要凭这条批准)";
  }
}

/** 折行。与 transcript 同一条（pi-tui 的字素感知实现），不另写一份。 */
function wrapForWidth(text: string, width: number): string[] {
  if (width <= 4) return [text];
  return wrapTextWithAnsi(text, width - 2);
}
