import { test, expect } from "bun:test";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileDir } from "../src/storage/file-dir.ts";

// `FileDir` 的 Store conformance（§13.12.2）：**一次 `write` 要么整份生效、要么完全不生效**。
//
// **立门由来（2026-08-18，CI 上真炸过）**：临时文件名原先是 `${target}.${pid}.${Date.now()}`，
// 同一毫秒内并发写同一路径会生成**同名**临时文件——先到的 `rename` 走了，后到的 `rename`
// 就 ENOENT，那一次写**静默丢失**（在 CI 上表现为 create-agent 那条测试整个失败）。
//
// 本地分段跑一直没撞上，CI 单进程全量才暴露。所以这里直接打并发写同一路径这个点，
// 不绕道 SessionService——那边的 meta 串行链会把这个 bug 掩盖掉。

async function tmp(): Promise<FileDir> {
  return new FileDir(await mkdtemp(join(tmpdir(), "echo-filedir-")));
}

test("并发写同一路径：不抛、不丢，最终内容是其中一次的完整值", async () => {
  const dir = await tmp();
  const n = 50;
  // 同一毫秒内打出去——正是原 bug 的触发条件
  await Promise.all(Array.from({ length: n }, (_, i) => dir.write("same.json", JSON.stringify({ i }))));

  const got = await dir.read("same.json");
  expect(got).not.toBeNull();
  // **完整值**：不是半截。原子替换的意义就在这里
  const parsed = JSON.parse(got!) as { i: number };
  expect(parsed.i).toBeGreaterThanOrEqual(0);
  expect(parsed.i).toBeLessThan(n);
});

test("并发写之后不留临时文件残骸", async () => {
  const root = await mkdtemp(join(tmpdir(), "echo-filedir-"));
  const dir = new FileDir(root);
  await Promise.all(Array.from({ length: 20 }, (_, i) => dir.write("x.json", `${i}`)));

  const files = await readdir(root);
  expect(files.filter((f) => f.endsWith(".tmp"))).toEqual([]);
  expect(files).toContain("x.json");
});

test("并发写不同路径：每一份都在", async () => {
  const dir = await tmp();
  await Promise.all(Array.from({ length: 30 }, (_, i) => dir.write(`n/${i}.json`, `${i}`)));
  const listed = await dir.list("n/");
  expect(listed).toHaveLength(30);
});

test("read 不存在的路径返回 null，不抛（StorageDir 契约）", async () => {
  const dir = await tmp();
  expect(await dir.read("nope.json")).toBeNull();
});
