// `echo:tui` —— **壳作为 extension**（2026-08-31 用户拍板：「壳也是我们的 extension，
// 就是 tui 还是 web，都是长在我们 ui 协议上的东西。我们只是默认提供了一个 tui」）。
//
// 它 `inject` core 的 `AgentRuntime`（那份**封闭**协议），于是壳与工具扩展**长在同一套机制上**：
// 同一个 ExtensionHost、同一份 Fiber/Effect 所有权账本、同一条依赖图。
// 换个壳（Web）只是换一条 inject 同一个 Service 的 Extension，不需要在 core 外面另搭一层。
//
// ## 为什么是「工厂返回句柄」而不是纯 definition
//
// 壳有一件别的扩展没有的事：**它要跑到用户退出**，而进程得知道那一刻到了。
// mount 只负责把它装上，不负责等它。所以这里出的是
// `{ definition, exited }`——definition 交给 `createEcho()` 去 mount，
// `exited` 留给进程 `await`。装配与「等它结束」是两件事，不该挤进同一个返回值。
//
// **谁收摊**：`exited` resolve 之后由进程调 `echo.stop()`，那一步会 unmount 本 Extension，
// Fiber 的 disposer 把终端还回去。壳子自己不碰 `agent.stop()`——协议里根本没有它。

import { AgentPrompt, AgentRuntimeService, AgentSessionsService, defineExtension, type ExtensionDefinition } from "@echo-agent/core/extension";
import type { TUI } from "@earendil-works/pi-tui";
import { runTui, type TuiConfigureOptions } from "./app.ts";
import type { Product } from "./product.ts";
import { surfaceSection } from "./prompt.ts";

export type TuiShell = {
  /** 交给 `createEcho({ extensions: [...] })` 去 mount。 */
  readonly definition: ExtensionDefinition<void>;
  /** 跑到用户退出（Ctrl+C / Ctrl+D）或被中止。resolve 的是进程退出码。 */
  readonly exited: Promise<number>;
  /**
   * 往运行中的界面塞一条旁白（D6：装配诊断这类**壳外产生**的消息走这里进屏幕）。
   * 界面还没起来时先攒着，起来后一次放行——`createEcho()` 返回在壳 mount 之后，时序天然成立。
   */
  notify(text: string): void;
};

/**
 * @param opts.product 欢迎头里的名字与版本——透传给 `runTui`。不给 = `echo-agent` 自己。
 * @param opts.configure 缺 key 时壳子在界面里配的那一段要的东西——透传给 `runTui`。
 *   不给 = 壳子不管凭据（自己装配、自己给 key 的场合）。
 */
export function tuiShell(
  opts: { product?: Pick<Product, "name" | "version">; signal?: AbortSignal; ui?: TUI; configure?: TuiConfigureOptions } = {},
): TuiShell {
  let settle: (code: number) => void = () => {};
  let fail: (e: unknown) => void = () => {};
  const exited = new Promise<number>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });

  // 旁白通道：界面起来前攒着，起来后（runTui 注册 sink）先放行积压、再直通。
  const backlog: string[] = [];
  let sink: ((text: string) => void) | null = null;
  const notify = (text: string): void => {
    if (sink !== null) sink(text);
    else backlog.push(text);
  };
  const attachAnnouncer = (fn: (text: string) => void): (() => void) => {
    sink = fn;
    for (const text of backlog.splice(0)) fn(text);
    return () => {
      if (sink === fn) sink = null; // 换代时旧界面摘下，新一代再挂
    };
  };

  const definition = defineExtension({
    name: "echo:tui",
    hostAbiVersion: 1,
    // 壳与 Agent 同寿：换代要在 run 之间，不能在轮中途把用户正在看的界面抽走
    reload: "agent",
    inject: {
      runtime: { service: AgentRuntimeService, required: true },
      prompt: { service: AgentPrompt, required: true },
      // 会话面（2026-09-07）：`/sessions` 读它。**恒有**，所以 required 装得上——
      // 容器给真的那一份，裸 `new Agent()` 上是 `NO_SESSION_FACE`。
      sessions: { service: AgentSessionsService, required: true },
    },
    apply(ctx) {
      const runtime = ctx.get(AgentRuntimeService);
      const sessions = ctx.get(AgentSessionsService);
      // 交互面段（2026-09-01）：「模型看到的是什么界面」这个事实归壳——壳在，段在；换壳换段。
      const prompt = ctx.get(AgentPrompt);
      void ctx.effect({
        boundary: "turn",
        start: () => {
          const off = prompt.section(surfaceSection("terminal"));
          return { value: "surface", dispose: () => void off() };
        },
      });
      // **UI 循环挂在 `ctx.effect()` 上**，disposer 负责让它停下来。
      // 直接 `void runTui(...)` 也能跑，但那样它就没有 owner——unmount 时无从收拾，
      // 而「装上就下不来」正是这一整批要消灭的东西。
      void ctx.effect({
        boundary: "agent",
        start: (fiberSignal) => {
          // **「Fiber 被卸载」与「用户要退出」是两回事**（2026-08-31 review 二轮 P1）。
          // 上一版把它们并进同一个 stopper：任何 unmount 都会让 `runTui()` 返回、
          // `shell.exited` resolve，于是 CLI 接着 `echo.stop()`——**将来一次 agent-boundary
          // reload 就会直接关掉整个 Runtime**。换代应当只是换一份界面，不是收摊。
          //
          //   · unmount → 界面停下来，但**不结算** `exited`（换代之后新一代会再起一个）；
          //   · 用户 / 进程要退出 → 结算 `exited`，CLI 据此收摊。
          const stopper = new AbortController();
          let userQuit = false;

          const onProcessAbort = (): void => {
            userQuit = true; // 这条是「真要退出」
            stopper.abort();
          };
          const onFiberAbort = (): void => stopper.abort(); // 这条只是「这一代结束」
          fiberSignal.addEventListener("abort", onFiberAbort, { once: true });
          opts.signal?.addEventListener("abort", onProcessAbort, { once: true });
          // **已经 abort 过的信号不会补发事件**：`addEventListener` 只等**将来**的 abort。
          // SIGINT 落在 `createEcho()` 或 Fiber 启动期间时就是这个形状——等这里注册好，
          // abort 早就过去了，于是 `runTui()` 收到的是一个全新的、没 abort 过的 `stopper.signal`，
          // `exited` 永远挂着，进程也就永远不退（review 三轮 P1）。
          // 同一个坑 `stdin.ts` 里踩过一次并修过——那条经验没有跟着搬进这一层。
          if (opts.signal?.aborted === true) onProcessAbort();

          const loop = runTui({
            agent: runtime,
            sessions,
            signal: stopper.signal,
            announcer: attachAnnouncer,
            ...(opts.product !== undefined ? { product: opts.product } : {}),
            ...(opts.ui !== undefined ? { ui: opts.ui } : {}),
            ...(opts.configure !== undefined ? { configure: opts.configure } : {}),
          });
          // 用户自己按 Ctrl+C 退出时 `runTui` 也会返回——那同样是「真要退出」
          loop.then(
            (code) => {
              if (!fiberSignal.aborted || userQuit) settle(code);
            },
            (e: unknown) => {
              if (!fiberSignal.aborted || userQuit) fail(e);
            },
          );

          return {
            value: loop,
            dispose: async () => {
              // **监听器必须显式摘掉**：`opts.signal` 是**跨代活着**的进程信号，
              // 每代都往它上面挂一个匿名监听器而不摘，换代多了就是一串泄漏（review 点名）。
              opts.signal?.removeEventListener("abort", onProcessAbort);
              fiberSignal.removeEventListener("abort", onFiberAbort);
              stopper.abort();
              // 等界面真的停下来——不等的话终端会被下一个写者插花
              await loop.catch(() => undefined);
            },
          };
        },
      });
    },
  });

  return { definition, exited, notify };
}
