// `send` 子命令（2026-11-16）：同一台机器上别的进程往一段会话的 inbox 投一句话。不装配、不取锁。

import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileDir, SessionService, userMessage } from "@echo-agent/core";
import { parseSendArgs, runSend, type SendIo } from "../src/send.ts";

function io(): SendIo & { out: { text: string }; err: { text: string } } {
  const out = { text: "", write(s: string) { out.text += s; return true; } };
  const err = { text: "", write(s: string) { err.text += s; return true; } };
  return { out, err };
}

async function seed(root: string, id: string): Promise<void> {
  const svc = new SessionService(new FileDir(join(root, id)));
  await svc.createOrResume(id, { workspace: "/repo", product: "echo-agent" });
  await svc.append(id, [{ kind: "message", message: userMessage("开场") }]);
  await svc.settle();
}

test("parseSendArgs：会话 id + 后面的文字；--state-dir / --dedupe；缺 id、缺文字、不认识的选项都报错；没参数或 --help 打帮助", () => {
  expect(parseSendArgs(["s-ops", "把群公告", "改成明天停机", "--dedupe", "ops:1", "--state-dir", "/x"])).toEqual({
    sessionId: "s-ops",
    text: "把群公告 改成明天停机",
    dedupeKey: "ops:1",
    stateDir: "/x",
  });
  expect(parseSendArgs([])).toBeNull();
  expect(parseSendArgs(["--help"])).toBeNull();
  expect(() => parseSendArgs(["s-ops"])).toThrow("缺要它做的事");
  expect(() => parseSendArgs(["--dedupe", "k"])).toThrow("缺会话 id");
  expect(() => parseSendArgs(["s-ops", "x", "--bogus"])).toThrow("不认识的选项：--bogus");
});

test("runSend：投进去打记录 id（一条用户消息落在那段会话的 inbox）；同一个 --dedupe 还没处理完不重复投；会话不存在退 1；参数错退 2", async () => {
  const root = mkdtempSync(join(tmpdir(), "echo-send-"));
  await seed(root, "s-ops");

  const a = io();
  expect(await runSend(["s-ops", "--state-dir", root, "--dedupe", "ops:1", "把群公告改成明天停机"], "echo-agent", a)).toBe(0);
  const recordId = a.out.text.trim();
  const files = readdirSync(join(root, "s-ops", "inbox")).filter((f) => f.endsWith(".json"));
  expect(files).toEqual([`${recordId}.json`]);
  const record = JSON.parse(readFileSync(join(root, "s-ops", "inbox", files[0]!), "utf8")) as { dedupeKey: string; message: { role: string; source: string; content: unknown } };
  expect([record.dedupeKey, record.message.role, record.message.source, JSON.stringify(record.message.content).includes("把群公告改成明天停机")]).toEqual(["ops:1", "user", "human", true]);

  const b = io();
  expect(await runSend(["s-ops", "--state-dir", root, "--dedupe", "ops:1", "把群公告改成明天停机"], "echo-agent", b)).toBe(0);
  expect(b.out.text.trim()).toBe(recordId);
  expect(b.err.text).toContain("这次没有再投一条");

  const c = io();
  expect(await runSend(["s-ops", "--state-dir", root, "不带键的每次都是新的一条"], "echo-agent", c)).toBe(0);
  expect(readdirSync(join(root, "s-ops", "inbox")).filter((f) => f.endsWith(".json"))).toHaveLength(2);

  const missing = io();
  expect(await runSend(["s-none", "--state-dir", root, "x"], "echo-agent", missing)).toBe(1);
  expect(missing.err.text).toContain("没有会话 s-none");

  const bad = io();
  expect(await runSend(["s-ops", "--state-dir", root], "echo-agent", bad)).toBe(2);
  expect(bad.err.text).toContain("用法：echo-agent send");
});
