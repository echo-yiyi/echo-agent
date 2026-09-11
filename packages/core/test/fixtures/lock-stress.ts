// 多进程压测的一端（state-lock.test.ts 用），走 `FileDir.lock`——与 lease 同一个带递增编号的锁。
//
//   bun lock-stress.ts <root> work <n>   拿放 n 次；每次在锁里先占位（建不出占位文件 = 另一个人也在锁里 = 双授），
//                                        再读改写一次计数。最后一行输出 `{done, doubles}`。
//   bun lock-stress.ts <root> crash 1    拿到锁就输出 `held` 并退出，不释放——模拟崩在持锁期间。

import { open, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FileDir } from "../../src/storage/file-dir.ts";

const [root, mode, count] = process.argv.slice(2) as [string, string, string];
const dir = new FileDir(root);
const WAIT_MS = 120_000;

if (mode === "crash") {
  await dir.lock("x", { timeoutMs: WAIT_MS });
  console.log("held");
  process.exit(0);
}

let doubles = 0;
for (let i = 0; i < Number(count); i++) {
  const release = await dir.lock("x", { timeoutMs: WAIT_MS });
  try {
    let inside: Awaited<ReturnType<typeof open>>;
    try {
      inside = await open(join(root, "inside"), "wx");
    } catch {
      doubles++;
      continue;
    }
    await inside.close();
    const n = Number((await readFile(join(root, "counter"), "utf8").catch(() => "")) || "0");
    if (Math.random() < 0.2) await new Promise((r) => setTimeout(r, 1)); // 撑开读改写的窗口
    await writeFile(join(root, "counter"), String(n + 1));
    await unlink(join(root, "inside"));
  } finally {
    await release();
  }
}
console.log(JSON.stringify({ done: Number(count), doubles }));
