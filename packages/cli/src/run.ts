// Runner 的全部实质：**给 Agent 一个进程与一个输入源**。
//
// 边界照抄设计，没有多做：Host 负责承载、投递输入、接收输出、进程级启停；
// **不替 Agent 编排** Memory / Dream / Schedule / Task——那些是 `start()` 自己的事。
//
// 输入源的类型就是标准的 `AsyncIterable<string>`，**不是自造 interface**。
// 之后要长的 TUI / UI 传自己的可迭代对象进来即可，Runner 不需要认识它们，
// 也不需要一张「输入源注册表」。

import type { Echo } from "@echo-agent/core";

/** 输出口。只要 `write`——`process.stdout` 与测试里的数组收集器都满足。 */
export type Sink = { write(text: string): void };

export type RunOptions = {
  /**
   * 已装配、**尚未 `start()`** 的 Echo（`createEcho()` 的产物：Agent + 已 mount 的 Extension）。
   * 谁装配谁决定 provider、状态根与扩展；壳子不参与装配（§14.2「一个 composition root」）。
   * 收摊也归它：`echo.stop()` 先卸 Extension 再停 Agent——壳子自己 `agent.stop()` 会漏掉前半。
   */
  echo: Echo;
  /**
   * 用户输入逐条来。**耗尽即收摊**。
   *
   * 同收同步与异步两种可迭代：`for await` 本来就都吃，收窄成只要 async 的唯一效果是
   * 逼调用方把一个数组包成生成器。
   */
  input: AsyncIterable<string> | Iterable<string>;
  /** 模型正文。缺省 `process.stdout`。 */
  out?: Sink;
  /** 工具动静、诊断与错误。缺省 `process.stderr`——**正文与旁白分流**，管道里才用得上。 */
  err?: Sink;
  /** 进程信号的抽象。abort = 不再收新输入，并中断在飞的那一轮。 */
  signal?: AbortSignal;
};

/**
 * 跑到输入耗尽或被中止，然后**干净收摊**，返回进程退出码（0 = 全部成功）。
 *
 * 三件事按顺序，每件都有理由：
 *   ① **先订阅再 `start()`**——反过来会丢掉启动期间的事件（恢复、诊断都在那一段）。
 *   ② 输入循环里每轮都看一次 `signal`：`for await` 自己**不会**因为 abort 而退出，
 *      输入源可能压根不响应信号（数组就不响应）。
 *   ③ `finally` 里 `stop()`——**无论怎么退出都要收摊**。
 *      是 `stop()` 不是 `dispose()`：后者只把资产收拢（停活动 → 等全部落盘 → 关存储），
 *      **不还锁**；`stop()` 在它外面再套一层「释放 lease + 复位」。Runner 调错这一个，
 *      状态根就会留下一把没人持有的 `.lock`，下一个进程直接被挡在门外（实测过）。
 */
export async function run(opts: RunOptions): Promise<number> {
  const out = opts.out ?? process.stdout;
  const err = opts.err ?? process.stderr;
  const { echo, signal } = opts;
  const agent = echo.agent;
  // **读成函数**，不要写成两次 `signal?.aborted === true`：那样 TS 会把第二次判成恒假
  // （第一次检查之后它认定类型已收窄），而运行时它恰恰是会变的——中断就发生在两次之间。
  const aborted = (): boolean => signal?.aborted === true;

  let failed = false;

  // **只订阅 delta 是不够的**：Core 明确说 provider 的最低实现门槛是「只发 done」
  // （§6.1 契约③，CLI 这类无流式后端就是这样）。那种 provider 一个 `text_delta` 都不发，
  // 于是 Runner 只打出一个换行——正文整段丢掉（2026-08-24 review 第 3 条实测 `out:"\n"`）。
  // 记一下这条 assistant 消息有没有流式输出过；没有就在 `message_end` 从定稿里补打。
  let streamedThisMessage = false;
  const unsubscribe = agent.subscribe((e) => {
    if (e.type === "message_update" && e.delta.type === "text_delta") {
      streamedThisMessage = true;
      out.write(e.delta.text);
    } else if (e.type === "message_end" && e.message.role === "assistant") {
      if (!streamedThisMessage) out.write(textOf(e.message.content));
      streamedThisMessage = false;
      out.write("\n");
    } else if (e.type === "tool_execution_start") {
      err.write(`[工具] ${e.toolName}\n`);
    }
  });

  // abort 要**同时**做两件事：中断在飞的那一轮（否则要等模型说完），
  // 以及让下面的循环在下一次检查时停下。
  const onAbort = (): void => agent.abort("runner 收到停止信号");
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    await agent.start();
    // **`start()` 期间也可能被中止**（它要拿锁、恢复状态，不是瞬间的事）。
    // 不在这里看一眼就会一头扎进输入循环，交互式 stdin 下等的是一行永远不会来的输入。
    if (aborted()) return failed ? 1 : 0;
    for await (const line of opts.input) {
      if (aborted()) break;
      const text = line.trim();
      if (text === "") continue;
      // 走 `send()` 而不是 `agent.prompt()`：完整 Runtime 的 run 结果带 runId 与观测三元组（§15.6 OR5）
      const result = await echo.send(text);
      if (result.outcome.kind === "error") {
        failed = true;
        err.write(`[错误] ${result.outcome.error.message}\n`);
      }
      // 每轮结束打 runId（§15.6「结束时打印 runId」）：进 err 不进正文；拿它去 `observe show <run-id>`
      err.write(`[run] ${result.runId} · observation ${result.observationIntegrity} · ${result.observationPersistence}\n`);
      if (aborted()) break;
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    unsubscribe();
    await echo.stop();
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
