// 记忆工具的动词面,单独一个**无依赖**的文件:types.ts 要按 mode 定默认动词集,
// tool.ts 要按模块收紧工具面,两边都引它而它谁都不引——否则 types ↔ tool 成环。
//
// 命令面**对齐 Anthropic memory tool**(view/create/str_replace/insert/delete/rename)
// ——判据与 skill 加载器同一条:「别人训练好的行为能不能在我们这直接跑」。

export type MemoryCommand = "view" | "create" | "str_replace" | "insert" | "delete" | "rename";

export const MEMORY_COMMANDS: readonly MemoryCommand[] = ["view", "create", "str_replace", "insert", "delete", "rename"];

/**
 * 按 mode 的默认动词集(2026-09-07 用户拍板:**限制在工具里保证,不在 prompt 里说**)。
 *
 * `resident` 模块**没有 rename**:它是一份固定路径的单文件,改名没有意义。dream 要把一条
 * 记在 `agent.md` 里的事实挪进笔记,因此只能走"笔记里新建 → `str_replace` 从原处删掉"两步——
 * 那是门,不是纪律。跨模块 / 跨层的 rename 另有禁令(换预算域、换可见性不许静默发生)。
 */
export function defaultOpsForMode(mode: string): readonly MemoryCommand[] {
  return mode === "resident" ? ["view", "create", "str_replace", "insert", "delete"] : MEMORY_COMMANDS;
}

/**
 * 一个模块实际支持的动词:声明的 `ops` 与 mode 默认集的**交集**——**只能收紧,不能放宽**。
 * 声明里写了 mode 默认集之外的动词,静默丢掉即可(放宽本来就不该生效);认不出的字符串同理。
 */
export function memoryOps(m: { readonly mode?: unknown; readonly ops?: readonly string[] }): readonly MemoryCommand[] {
  const allowed = defaultOpsForMode(typeof m.mode === "string" ? m.mode : "");
  if (!Array.isArray(m.ops)) return allowed;
  return allowed.filter((c) => (m.ops as readonly string[]).includes(c));
}
