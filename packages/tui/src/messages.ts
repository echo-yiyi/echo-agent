// 消息组件（P2，`docs/design/tui.md` §五）：**每条消息是一个组件，持有自己的状态**。
//
// 上一版的 `Transcript` 是一份扁平数组，条目没有状态——于是「工具调用能不能折叠」这种事做不了：
// 折叠要每条工具调用记住自己展开没有、拿着完整的参数与结果。这就是 §一说的
// 「换 Container 买到的是结构，不是重绘性能」：原地更新 `Transcript` 本来就会，
// 差分渲染是 pi-tui 的 `TUI` 自己做的，组件树带来的是**每条各有各的状态与渲染**。
//
// 对照 pi 的 `modes/interactive/components/`：`user-message.ts` / `assistant-message.ts` / `tool-execution.ts`。
// 四条各自的要点写在类头上。**进来的文本已经过 `clean()`**——清洗在 `Transcript` 的入口做，
// 这里只管画（理由见 `text.ts` 头注：清洗要在加 SGR 之前）。

import type { AgentToolResult } from "@echo-agent/core";
import { Markdown, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { wrap } from "./text.ts";
import { cyan, dim, green, italic, MARKDOWN_THEME, red, yellow } from "./theme.ts";

export type ToolState = "running" | "done" | "failed";

/** 用户说的：缩进 + `›` 前缀 + 青色，与助手正文一眼分得开。 */
export class UserMessage implements Component {
  constructor(private readonly text: string) {}

  render(width: number): string[] {
    return [...wrap(this.text, width - 2).map((l) => cyan(`› ${l}`)), ""];
  }

  invalidate(): void {}
}

/**
 * 助手说的：**正文走 pi-tui 的 `Markdown` 组件**，不自己拼（pi 也是 `new Markdown(...)`，
 * `assistant-message.ts:111`）——代码块、列表、表格、行内代码都是它的事。
 * thinking 放正文前面，暗色 + 斜体，与正文区分；被安全过滤器抹掉的（`redacted`）不显示。
 *
 * 流式：`update()` 用**权威 partial** 覆盖（`message_update` 带的就是此刻的完整 message），
 * 不自己攒 delta；`Markdown.setText()` 原地换文本，半截围栏它会自己补上。
 */
export class AssistantMessage implements Component {
  private readonly md = new Markdown("", 0, 0, MARKDOWN_THEME);
  private text = "";
  private thinking = "";
  private streaming: boolean;

  constructor(text: string, thinking: string, streaming: boolean) {
    this.streaming = streaming;
    this.update(text, thinking, streaming);
  }

  update(text: string, thinking: string, streaming: boolean): void {
    this.text = text;
    this.thinking = thinking;
    this.streaming = streaming;
    this.md.setText(text);
  }

  render(width: number): string[] {
    // **空的助手条目不占地方**：只带 tool_use 的那一轮正文是空的，照直渲染会在工具行前面留出空白
    if (this.text === "" && this.thinking === "" && !this.streaming) return [];
    const lines: string[] = [];
    if (this.thinking !== "") {
      for (const l of wrap(this.thinking, width)) lines.push(dim(italic(l)));
      if (this.text !== "") lines.push("");
    }
    // `Markdown` 把每行右侧补空格到宽度；去掉，免得空行变成一串空格、末尾多出看不见的东西
    if (this.text !== "") for (const l of this.md.render(width)) lines.push(l.trimEnd());
    if (this.streaming) lines.push(dim("…"));
    lines.push("");
    return lines;
  }

  invalidate(): void {
    this.md.invalidate();
  }
}

/**
 * 工具调用：**默认折叠**，一行「状态标记 + 工具名 + 一行摘要」；展开时把参数（JSON）与结果全量摆出来。
 *
 * 折叠是 P2 的重点：一个 `read_file` 的结果就能刷掉整屏，折起来终端才可读。
 * 展开与否是**全局**开关（pi 的 `app.tools.expand`，Ctrl+O），由 `Transcript` 持有、这里通过
 * `expanded()` 现读——每条自己记一份就得逐条去按，和「一键看全部」的用法不合。
 *
 * 三态标记沿用：`⋯` 跑着 / `✓` 成功 / `✗` 失败；注入了 `spinner` 帧源时，跑着的标记显示当前帧
 * （帧计时器归壳子，组件只在重画时取一帧——与 `expanded` 同一种注入）。
 */
export class ToolExecution implements Component {
  private name: string;
  private detail: string;
  private state: ToolState;
  private params: unknown;
  private result: AgentToolResult | null = null;
  private readonly expanded: () => boolean;
  private readonly spinner: (() => string) | undefined;

  constructor(opts: {
    name: string;
    detail: string;
    state: ToolState;
    params?: unknown;
    expanded: () => boolean;
    spinner?: (() => string) | undefined;
  }) {
    this.name = opts.name;
    this.detail = opts.detail;
    this.state = opts.state;
    this.params = opts.params;
    this.expanded = opts.expanded;
    this.spinner = opts.spinner;
  }

  /** `result.content` 由调用方先 `clean()` 过再给进来。 */
  patch(p: { name?: string; detail?: string; state?: ToolState; result?: AgentToolResult }): void {
    if (p.name !== undefined) this.name = p.name;
    if (p.detail !== undefined) this.detail = p.detail;
    if (p.state !== undefined) this.state = p.state;
    if (p.result !== undefined) this.result = p.result;
  }

  render(width: number): string[] {
    const mark = this.state === "running" ? (this.spinner?.() ?? "⋯") : this.state === "done" ? "✓" : "✗";
    const paint = this.state === "failed" ? red : this.state === "done" ? green : yellow;
    const head = paint(`${mark} ${this.name}`) + (this.detail === "" ? "" : dim(`  ${this.detail}`));
    // 折叠行**只有一行**，摘要再长也截到宽度（全量看展开态）。不截的话 pi-tui 的渲染门直接抛——
    // 实测 `TaskCreate` 的参数 JSON 118 列 > 终端 112 列，整个界面崩掉（2026-09-01）。
    const lines = [truncateToWidth(head, width, "…")];
    if (this.expanded()) {
      const inner = Math.max(1, width - 2);
      const gutter = dim("│ ");
      if (this.params !== undefined) {
        for (const raw of paramsLines(this.params)) for (const l of wrap(raw, inner)) lines.push(gutter + dim(l));
      }
      if (this.result !== null) {
        const tint = this.result.isError ? red : (l: string): string => l;
        for (const raw of this.result.content.split("\n")) for (const l of wrap(raw, inner)) lines.push(gutter + tint(l));
      }
    }
    lines.push("");
    return lines;
  }

  invalidate(): void {}
}

/** 参数展开成多行 JSON。**JSON 是唯一诚实的形状**——「人话摘要」会在用户和实际执行的东西之间再加一层解释。 */
function paramsLines(params: unknown): string[] {
  try {
    const text = JSON.stringify(params, null, 2);
    return text === undefined ? [] : text.split("\n");
  } catch {
    return ["(参数无法序列化)"];
  }
}

/** 旁白（权限、错误、诊断）：暗色。 */
export class Notice implements Component {
  constructor(private readonly text: string) {}

  render(width: number): string[] {
    return [...wrap(this.text, width).map(dim), ""];
  }

  invalidate(): void {}
}
