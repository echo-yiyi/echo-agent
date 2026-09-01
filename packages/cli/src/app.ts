// TUI 应用：把 `AgentRuntime` 协议渲染到终端上。
//
// **壳是 extension，不是 core 外面套的一层**（2026-08-31 用户拍板）。它 `inject` core 那份
// 封闭的 `AgentRuntime`（`@echo-agent/core/extension`），协议里有什么它就得处理什么——
// TUI 与将来的 Web 壳是同一份协议的两个实现，我们只是默认提供了这一个。
//
// 于是这个文件**只认协议、不认 Agent**：`start` / `stop` / `deliver` 都不在协议里，
// 进程级启停归装配层（`createEcho()` / `echo.stop()`），壳子碰不到也不该碰。

import { errText, type CredentialStore, type Provider } from "@echo-agent/core";
import type { AgentRuntime } from "@echo-agent/core/extension";
import { Editor, isKeyRelease, ProcessTerminal, TuiMainScreen, type TUI } from "@earendil-works/pi-tui";
import { Transcript, clean } from "./transcript.ts";
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { installKeybindings } from "./keybindings.ts";
import { CredentialSetup, isConfigured, type VerifyFn } from "./setup.ts";
import { EDITOR_THEME } from "./theme.ts";

const ESC = String.fromCharCode(27);
/** 键位照 pi（`keybindings.ts`）。Ctrl+C 不再是退出——提示行必须写 Ctrl+D，否则用户按 Ctrl+C 只会看到输入被清掉。 */
const HINT = `${ESC}[2mEnter 发送 · Shift+Enter 换行 · Esc 中断 · Ctrl+D 退出${ESC}[22m`;

export type TuiAppOptions = Readonly<{
  /**
   * core 那份封闭协议。**壳子看得到的全部就是它**——没有 `start`/`stop`，
   * 因为进程级启停归装配层；没有 `deliver`，因为那是投递侧不是 UI。
   */
  agent: AgentRuntime;
  /** 进程信号。abort = 停止收新输入并中断在飞的那一轮。 */
  signal?: AbortSignal;
  /** 注入用：测试给假的 TUI 与终端。 */
  ui?: TUI;
  /**
   * 缺 key 时在界面里配的那一段要的东西（2026-09-01：配置是运行态，不阻塞启动）。
   * 不给 = 壳子不管凭据——低层用户自己装配、自己给 key 的场合。
   */
  configure?: TuiConfigureOptions;
}>;

export type TuiConfigureOptions = Readonly<{
  /** 这次装配的那家。界面里只能给它配 key；换家是 `--provider` 或 P3 `/model` 的事。 */
  provider: Provider;
  credentials: CredentialStore;
  /** 别家的 `--provider` 短名，只用来提示「换一家怎么换」。 */
  alternatives?: readonly string[];
  /** 注入用：测试给假的验证。 */
  verify?: VerifyFn;
}>;

/** 跑到用户退出（Ctrl+C / Ctrl+D）或被中止，返回退出码。**不负责收摊 Agent**——那归装配层。 */
export async function runTui(options: TuiAppOptions): Promise<number> {
  const { agent, signal, configure } = options;
  const ui: TUI = options.ui ?? new TuiMainScreen(new ProcessTerminal(), false, process.cwd());

  const transcript = new Transcript();
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

  const rerender = (): void => ui.requestRender();

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
   * **凭据配置段**（2026-09-01 用户拍板：配置是运行态，不阻塞启动）。
   *
   * 上一版是启动前弹一屏向导，用户一起来就被按在上面。现在装配不看凭据（`create-agent.ts`），
   * Agent 与壳照常起来；缺 key 时把这一段摆在输入行的位置上，配好就撤掉、输入行回来——
   * **不用重启**，因为模型早就解析好了，key 是每轮重读的。两个入口：
   *   · 启动时 `isConfigured()` 说没配；
   *   · 跑着的时候端点报 `auth`（key 被撤了 / 过期了）——`agent_end` 那支再摆一次。
   * `setup !== null` 就是「正在配」；那时 Ctrl+D 空时退出 / Ctrl+C 清空照旧由本文件分发。
   */
  let setup: CredentialSetup | null = null;
  const enterConfigure = (why: string): void => {
    if (configure === undefined || setup !== null) return;
    setup = new CredentialSetup({
      provider: configure.provider,
      credentials: configure.credentials,
      ...(configure.alternatives !== undefined ? { alternatives: configure.alternatives } : {}),
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
    transcript.push({ kind: "notice", text: why });
    rerender();
  };

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

  const unsubscribeLifecycle = agent.subscribeLifecycle((event) => {
    switch (event.type) {
      case "permissionRequest":
        takeAsk(event);
        return;
      case "permissionCancelled":
        // 那一轮没了（abort / 收摊）：把问题从屏幕上撤掉，别让用户对着一个死问题按键
        if (pending?.permissionId === event.permissionId) pending = null;
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
        const partial = textOf(event.message.content);
        if (streamingIndex === null) streamingIndex = transcript.push({ kind: "assistant", text: "", streaming: true });
        transcript.setAssistantText(streamingIndex, partial);
        rerender();
        return;
      }
      case "message_end":
        if (event.message.role !== "assistant") return;
        // **无条件以定稿为准**，包括定稿为空（只带 tool_use 的那一轮、错误轮）：
        // 只发 done 的 provider 一个 delta 都没有，被修正的定稿也要覆盖旧 partial。
        if (streamingIndex === null) streamingIndex = transcript.push({ kind: "assistant", text: "", streaming: true });
        transcript.finishAssistant(streamingIndex, textOf(event.message.content));
        streamingIndex = null;
        rerender();
        return;
      case "tool_execution_start": {
        const row = transcript.push({ kind: "tool", name: event.toolName, detail: "", state: "running" });
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
          transcript.push({ kind: "notice", text: `[错误] ${event.outcome.error.message}` });
          // 端点说 key 不对（没配 / 被撤 / 过期）：把配置段摆出来，而不是让用户对着一句 `[错误]` 猜
          if (event.outcome.error.code === "auth") enterConfigure("[凭据] 这把 key 不能用了——重新配一个");
        }
        rerender();
        return;
      case "tool_execution_end": {
        const row = toolRows.get(event.toolCallId);
        if (row !== undefined) {
          transcript.updateTool(row, { state: event.result.isError ? "failed" : "done" });
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
      const lines = [...transcript.render(width)];
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
      // 正在配 key：这一段**顶替**输入行的位置，配好了输入行回来
      if (setup !== null) {
        lines.push(...setup.render(width));
        return lines;
      }
      lines.push(...editor.render(width));
      // 空闲且没打字时给一句提示；有字或在跑就不占地方
      if (editor.getText() === "" && !busy()) lines.push(HINT);
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
  if (configure !== undefined) {
    try {
      needsConfigure = !(await isConfigured(configure.provider, configure.credentials));
    } catch (e) {
      transcript.push({ kind: "notice", text: `[凭据] 读不了凭据文件：${errText(e)}` });
      needsConfigure = true;
    }
  }

  ui.addChild(root);
  ui.setFocus(root);
  ui.start();

  try {
    // **壳子不再 `start()`**（2026-08-31 壳变 extension）：启停归装配层。
    // 「起来了没」由协议的 `acceptsWork` 说了算——它在 running 之前恒为 false，
    // 所以从前那个 `ready` 布尔整个删掉了：一份判据，不再有壳子自己维护的第二份。
    if (signal?.aborted !== true) {
      transcript.push({ kind: "notice", text: `已接上（${agent.state.model.id}）` });
      if (needsConfigure) enterConfigure("还没有可用的凭据——先配一个，配好不用重启");
      rerender();
      await exited;
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    unsubscribeLifecycle();
    unsubscribe();
    // `setup` 只在闭包里被赋值，TS 在这个作用域把它收窄成了 null——显式标回类型再调
    (setup as CredentialSetup | null)?.dispose(); // 缓冲区里不留 key
    ui.stop();
    // **不收摊 Agent**：协议里没有 `stop`，那是装配层（`echo.stop()`）的事。
    // 壳子自己停 Agent 就等于两个所有者——那正是把 `start`/`stop` 挡在协议外面要防的。
  }
  return failed ? 1 : 0;
}

/** 定稿消息里的纯文本。线上形状里 content 可能是字符串或块数组。 */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b): b is { type: "text"; text: string } => typeof b === "object" && b !== null && (b as { type?: unknown }).type === "text")
    .map((b) => b.text)
    .join("");
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
