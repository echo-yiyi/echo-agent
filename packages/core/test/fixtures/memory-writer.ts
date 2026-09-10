// 跨进程写记忆的一端（`memory.test.ts` 的原子提交判据用）：
//   bun memory-writer.ts <目录> <标签> <次数>
// 往 `project/note.md` 的开头插 <次数> 行 `<标签>-<i>`，每次都是一次完整的读改写。
// 两个这样的进程同时跑、写同一个文件：锁若只在进程内，插入会被对方的写回静默吃掉。
// 最后一行输出 JSON：{ tag, failed }——失败必须是**明确返回的**，不能是悄悄丢掉的。

import { bindMemoryScopes, createAgentMemories, memoryInsert } from "../../src/memory/harness.ts";
import { memoryScopeTable } from "../../src/memory/scope.ts";
import { residentMemory } from "../../src/memory/types.ts";
import { FileDir } from "../../src/storage/file-dir.ts";

const [dir, tag, count] = process.argv.slice(2);
if (dir === undefined || tag === undefined || count === undefined) throw new Error("用法：bun memory-writer.ts <目录> <标签> <次数>");

const memory = createAgentMemories({ memories: [residentMemory("note", { budget: 100_000 })] });
bindMemoryScopes(
  memory,
  memoryScopeTable([{ def: { name: "project", order: 1, describe: "shared", anchor: { kind: "home" }, prefix: "" }, dir: new FileDir(dir) }]),
);

let failed = 0;
for (let i = 0; i < Number(count); i++) {
  const r = await memoryInsert(memory, "project/note.md", 0, `${tag}-${i}`);
  if (r.isError === true) failed++;
}
console.log(JSON.stringify({ tag, failed }));
