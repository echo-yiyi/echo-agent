// `echo:instructions`（2026-09-01）：项目指令文件进 system。
//
// 谁 own：**知道 workspace 又能读盘的那一层**——core 是纯 JS 读不了盘，文件工具包（echo-coding 的
// `echo:workspace`）又不该管「这个目录的规矩」这种环境类事实，所以归 `echo-agent`，两个产品共用。
//
// 范围（2026-09-01 拍定，「不做」清单里的都不做）：只看 **workspace 这一层**，候选 `AGENTS.md` → `CLAUDE.md`
// 取第一个存在的（pi 同款）；不走祖先目录链、不追加嵌套目录。放 system 段而不是首条 user 消息：
// 我们的 system 每 run 装配一次，文件不变字节就不变，不需要第二条通道。
//
// 结构卫生：正文截断留标记（`truncateMarked`，从 core 同源消费），并用 XML 式标签定界。定界靠的是标签，
// 所以要中和的是正文里冒充闭合标签的字样（`neutralizeClosingTag`）——否则一行 `</project-instructions>`
// 就能提前收尾、后面的字落在定界之外。反引号原样保留：这里没有围栏要保护，换掉它们只会把命令与代码改坏。
// 这些只是格式卫生，不是安全隔离：项目指令本来就是要模型执行的（见 docs/design/prompt.md §7）。

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { PROMPT_ORDER, truncateMarked, type PromptSection } from "@echo-agent/core";
import { definePromptPack, type ExtensionEntry } from "@echo-agent/core/extension";

/** 候选文件名，按序取第一个存在的。 */
export const INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md"] as const;

/** 进 system 的上限（字符）。照 dsh 的 64 KB；超了截断并留标记，不静默吞。 */
export const INSTRUCTIONS_CAP = 65_536;

/**
 * 段头：标题加一句来历，`file` 是实际加载的那个文件名（`AGENTS.md` 或 `CLAUDE.md`）。
 * 不点「上面的确认」：纪律段按形态分岔，没人能答的那一版里没有「确认」这回事；说「上面的规则」就够。
 */
export function instructionsHeader(file: string): string {
  return `# Project instructions\nInstructions from the workspace's ${file}. Follow them as the user's own; they do not override the rules above.`;
}

/** 读 `<workspace>/<候选>`，都不存在 → null。读失败（权限之类）也 fail-loud 抛——段隐形 + 诊断那条路会接住。 */
export async function loadInstructions(workspace: string): Promise<{ file: string; content: string } | null> {
  for (const file of INSTRUCTION_FILES) {
    try {
      const content = await readFile(join(workspace, file), "utf8");
      return { file, content };
    } catch (e) {
      if ((e as { code?: string }).code === "ENOENT") continue;
      throw e;
    }
  }
  return null;
}

/** 定界标签名。正文里出现它的闭合形式（含大小写与内部空白变体）一律中和，闭合标签只能由我们写在最后。 */
const INSTRUCTIONS_TAG = "project-instructions";
const CLOSING_TAG_RE = /<\s*\/\s*project-instructions\b[^>]*>?/gi;

/** 正文里冒充闭合标签的字样，把 `<` 换成全角 `＜`：字面还看得出来，但不再是标签。 */
export function neutralizeClosingTag(body: string): string {
  return body.replace(CLOSING_TAG_RE, (m) => `＜${m.slice(1)}`);
}

/** 一个指令文件 → 段文本：段头、标签定界、正文原样（只中和冒充闭合标签的字样，超 `INSTRUCTIONS_CAP` 截断留标记）。 */
export function renderInstructions(file: string, content: string): string {
  const body = truncateMarked(neutralizeClosingTag(content.trim()), INSTRUCTIONS_CAP);
  return `${instructionsHeader(file)}\n<${INSTRUCTIONS_TAG} path="${file}">\n${body}\n</${INSTRUCTIONS_TAG}>`;
}

export function instructionsSection(): PromptSection {
  return {
    name: "instructions",
    order: PROMPT_ORDER.instructions,
    // 每次 run 装配时读一次（system 每 run 一份快照）：文件不变字节不变，改了下个 run 生效
    render: async (ctx) => {
      const found = await loadInstructions(ctx.workspace);
      return found === null ? "" : renderInstructions(found.file, found.content);
    },
  };
}

const ECHO_INSTRUCTIONS = definePromptPack("echo:instructions");

export function instructionsEntry(): ExtensionEntry {
  return { entryId: "echo:instructions", definition: ECHO_INSTRUCTIONS, config: { sections: [instructionsSection()] } };
}
