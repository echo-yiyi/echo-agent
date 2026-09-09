/**
 * 斜杠命令的补全 provider（包内私有，不出公共面）。
 *
 * 只做斜杠这一半：pi-tui 的 `CombinedAutocompleteProvider` 连 @ 文件补全一起带
 * （要 fd、要 basePath），我们没有消费文件的下游，裁掉。语义照它的 slash 分支：
 * 命令名 fuzzy 过滤、描述里带参数提示、`getArgumentCompletions` 补参数、
 * 命令名补全后带尾随空格（Enter 直接提交、继续敲参数都顺手）。
 * 菜单的按键（Tab 补全、↑↓ 选、Esc 收、Enter 执行）全在 `Editor` 内置路由里，键位天然照 pi。
 */
import {
  fuzzyFilter,
  type AutocompleteItem,
  type AutocompleteProvider,
  type AutocompleteSuggestions,
  type SlashCommand,
} from "@earendil-works/pi-tui";

/** 命令表的一行：pi-tui 的 `SlashCommand`（菜单面）+ 执行体（派发面）。`rest` 已去首尾空白，无参数时是 ""。 */
export type SlashSpec = SlashCommand & { readonly run: (rest: string) => void };

export class SlashCommandProvider implements AutocompleteProvider {
  constructor(private readonly commands: readonly SlashCommand[]) {}

  async getSuggestions(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    _options: { signal: AbortSignal; force?: boolean },
  ): Promise<AutocompleteSuggestions | null> {
    // 菜单只在首行——与 Editor 的 isSlashMenuAllowed 同一条约束，两边不一致菜单会闪
    if (cursorLine !== 0) return null;
    const textBeforeCursor = (lines[0] ?? "").slice(0, cursorCol);
    if (!textBeforeCursor.startsWith("/")) return null;
    const spaceIndex = textBeforeCursor.indexOf(" ");
    if (spaceIndex === -1) {
      const filtered = fuzzyFilter([...this.commands], textBeforeCursor.slice(1), (c) => c.name);
      if (filtered.length === 0) return null;
      return {
        items: filtered.map((c) => {
          const hint = c.argumentHint;
          const desc =
            hint !== undefined ? (c.description !== undefined ? `${hint} — ${c.description}` : hint) : c.description;
          return { value: c.name, label: c.name, ...(desc !== undefined && desc !== "" ? { description: desc } : {}) };
        }),
        prefix: textBeforeCursor,
      };
    }
    // 空格之后是参数：交给命令自己的 getArgumentCompletions（没有就没有菜单）
    const command = this.commands.find((c) => c.name === textBeforeCursor.slice(1, spaceIndex));
    if (command?.getArgumentCompletions === undefined) return null;
    const argumentPrefix = textBeforeCursor.slice(spaceIndex + 1);
    const items = await command.getArgumentCompletions(argumentPrefix);
    if (!Array.isArray(items) || items.length === 0) return null;
    return { items, prefix: argumentPrefix };
  }

  applyCompletion(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    item: AutocompleteItem,
    prefix: string,
  ): { lines: string[]; cursorLine: number; cursorCol: number } {
    const line = lines[cursorLine] ?? "";
    const before = line.slice(0, cursorCol - prefix.length);
    const after = line.slice(cursorCol);
    const newLines = [...lines];
    if (prefix.startsWith("/")) {
      // 命令名（prefix 是含斜杠的整段）：补成 `/name ` 并把光标放在空格后
      newLines[cursorLine] = `${before}/${item.value} ${after}`;
      return { lines: newLines, cursorLine, cursorCol: before.length + item.value.length + 2 };
    }
    // 参数（prefix 是空格后的片段）：原地替换，光标落在补全值末尾
    newLines[cursorLine] = before + item.value + after;
    return { lines: newLines, cursorLine, cursorCol: before.length + item.value.length };
  }
}
