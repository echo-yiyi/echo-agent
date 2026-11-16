// 显式续会话之前要不要问一句「接管吗」（`cli.ts#takeoverQuestion`，2026-11-15）。
//
// 只在两种情形问：占着它的进程还活着、又不可让位（另一个终端开着，或沙箱刚异常退出、心跳还没过期），或锁坏了。
// 其余（没人占、持有者已经不在了、可让位的后台宿主）不问——续会话照常拿锁，拿不到就接管。

import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { takeoverQuestion } from "../src/cli.ts";

/** 一把锁目录，当前代是给定的记录（或一段坏内容）。 */
function lockWith(record: unknown): string {
  const path = join(mkdtempSync(join(tmpdir(), "echo-takeover-")), ".lock");
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "g1"), typeof record === "string" ? record : JSON.stringify(record));
  return path;
}

const NOW = Date.now();

test("没人占、持有者已经不在了（心跳过期）、可让位的后台宿主：不问", async () => {
  expect(await takeoverQuestion(join(mkdtempSync(join(tmpdir(), "echo-takeover-")), ".lock"))).toBeNull();
  expect(await takeoverQuestion(lockWith({ holder: "旧容器", pid: process.pid, host: "x.invalid", at: NOW - 60_000, beat: NOW - 60_000, token: "a" }))).toBeNull();
  expect(await takeoverQuestion(lockWith({ holder: "后台", pid: process.pid, host: "x.invalid", at: NOW, beat: NOW, token: "b", preemptible: true }))).toBeNull();
});

test("还活着、又不可让位：问，并说出是哪个进程、多久前还有心跳", async () => {
  const q = await takeoverQuestion(lockWith({ holder: "另一个终端", pid: 4321, host: "my-mac.local", at: NOW - 5_000, beat: NOW - 3_000, token: "c" }), NOW);
  expect(q).toContain("进程 4321");
  expect(q).toContain("my-mac.local");
  expect(q).toContain("3 秒前还有心跳");
});

test("锁坏了：问，并说出坏在哪", async () => {
  expect(await takeoverQuestion(lockWith("不是 json"))).toContain("锁是坏的");
});
