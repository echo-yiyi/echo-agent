// Transcript：把一次会话渲染成终端里的一段文档。
//
// **它只是投影**——不持有会话真相，不回写 Agent。真相在 `agent.messages` 与事件流里，
// 这里存的是「已经渲染成什么样」的一列组件。
//
// P2 起它是一个 pi-tui `Container`，每条消息是一个组件（`messages.ts`），各自持有状态——
// 工具调用的折叠 / 展开就靠这个。上一版是扁平的字符串数组，条目没有状态，折叠做不了。
//
// ## 投影边界 = 清洗边界
//
// 四类条目（user / assistant / tool / notice）的动态文本一律在**入口**过 `clean()`（`text.ts`），
// 组件里只管画。**新增一种条目就必须在 `push()` 里加一支清洗**——漏一支就是一个没洗的洞。

import type { AgentToolResult } from "@echo-agent/core";
import { Container, type Component } from "@earendil-works/pi-tui";
import { AssistantMessage, Notice, ToolExecution, UserMessage, type ToolState } from "./messages.ts";
import { clean } from "./text.ts";

export { clean } from "./text.ts";

/** 一条已经落定或正在流式生长的条目。 */
export type TranscriptEntry =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string; streaming: boolean; thinking?: string }
  | { kind: "tool"; name: string; detail: string; state: ToolState; params?: unknown }
  | { kind: "notice"; text: string };

/** 助手一条的内容：正文 + thinking（都是纯文本，已按块拼好）。 */
export type AssistantContent = Readonly<{ text: string; thinking?: string }>;

export class Transcript {
  private readonly container = new Container();
  private readonly items: Component[] = [];
  private toolsExpanded = false;

  /** `spinner`：可选帧源，执行中的工具标记用它转起来；不给就是静态 `⋯`（单测与低层用法不付这份依赖）。 */
  constructor(private readonly opts: { spinner?: (() => string) | undefined } = {}) {}

  /**
   * 追加一条。返回它的下标，流式那条之后要按下标续写。
   * **入口即清洗**（四类条目一个不漏，见文件头）：调用方不必记得洗，也没有「忘了洗」这条路。
   */
  push(entry: TranscriptEntry): number {
    let item: Component;
    switch (entry.kind) {
      case "user":
        item = new UserMessage(clean(entry.text));
        break;
      case "assistant":
        item = new AssistantMessage(clean(entry.text), clean(entry.thinking ?? ""), entry.streaming);
        break;
      case "tool":
        item = new ToolExecution({
          name: clean(entry.name),
          detail: clean(entry.detail),
          state: entry.state,
          params: entry.params,
          expanded: () => this.toolsExpanded,
          spinner: this.opts.spinner,
        });
        break;
      case "notice":
        item = new Notice(clean(entry.text));
        break;
    }
    this.items.push(item);
    this.container.addChild(item);
    return this.items.length - 1;
  }

  /** 只有正文的流式覆盖——`setAssistantContent` 的便捷形式。 */
  setAssistantText(index: number, text: string): void {
    this.setAssistantContent(index, { text });
  }

  /**
   * 用**权威 partial** 覆盖流式条目。
   *
   * 注意是「覆盖」不是「累加」：`message_update` 事件本身就带着此刻的完整 `message`，
   * 自己再攒一份 delta 等于在 TUI 里维护第二份真相——重试、丢包、provider 修正定稿时两边就会分叉。
   */
  setAssistantContent(index: number, content: AssistantContent): void {
    const item = this.items[index];
    if (!(item instanceof AssistantMessage)) return;
    item.update(clean(content.text), clean(content.thinking ?? ""), true);
  }

  /**
   * 收尾：**无条件以定稿为准**，包括定稿为空的情形（只带 tool_use 的那一轮、错误轮）。
   * 「先流出旧 partial、再被权威定稿修正」这一路，屏幕必须换成定稿——**定稿权威**这条不能有例外。
   */
  finishAssistant(index: number, final: string | AssistantContent): void {
    const item = this.items[index];
    if (!(item instanceof AssistantMessage)) return;
    const content = typeof final === "string" ? { text: final } : final;
    item.update(clean(content.text), clean(content.thinking ?? ""), false);
  }

  updateTool(index: number, patch: { name?: string; detail?: string; state?: ToolState; result?: AgentToolResult }): void {
    const item = this.items[index];
    if (!(item instanceof ToolExecution)) return;
    item.patch({
      ...(patch.name === undefined ? {} : { name: clean(patch.name) }),
      ...(patch.detail === undefined ? {} : { detail: clean(patch.detail) }),
      ...(patch.state === undefined ? {} : { state: patch.state }),
      ...(patch.result === undefined ? {} : { result: { ...patch.result, content: clean(patch.result.content) } }),
    });
  }

  /**
   * 清空投影（`/clear`，P3a）。**只清屏幕这一份**：会话真相在 Agent 里，协议的 `reset()` 清那份；
   * 两边都清才是「清空对话」，只清一边就是屏幕和真相分叉。调用顺序归 `app.ts`。
   */
  clear(): void {
    this.items.length = 0;
    this.container.clear();
  }

  /** Ctrl+O：全部工具调用一起展开 / 收起。返回切换后的状态。 */
  toggleTools(): boolean {
    this.toolsExpanded = !this.toolsExpanded;
    this.invalidate();
    return this.toolsExpanded;
  }

  invalidate(): void {
    for (const item of this.items) item.invalidate?.();
  }

  render(width: number): string[] {
    return this.container.render(width);
  }
}
