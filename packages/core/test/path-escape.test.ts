import { test, expect } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileDir } from "../src/storage/file-dir.ts";
import { SessionService } from "../src/session/service.ts";
import { resolveStateDir } from "../src/create-agent.ts";

// 状态根的 containment（2026-08-19 review 的 P1）。
//
// **一处漏就全漏**：路径由 `agentId` / `sessionId` / 相对 path 三段拼起来，
// 任何一段没设防，整个状态根就出得去。所以这里三条路径分别验：
//   ① 字面量 `../`（此前已修）
//   ② `agentId`（此前只校验了 sessionId，agentId 照样能把整个根挪走）
//   ③ 符号链接（词法比较全程看不出问题，每一段都在 root 底下）

async function tmp(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

test("① sessionId 里的 ../ 逃不出去", async () => {
  const root = await tmp("echo-esc-");
  const svc = new SessionService(new FileDir(root));
  await expect(svc.createOrResume("../../escaped")).rejects.toThrow(/不合法/);
});

test("② agentId 里的 ../ 同样逃不出去（此前只校验了 sessionId）", () => {
  // 实测过：agentId="../../escaped" 会把整个状态根移出 .echo/agents
  expect(() => resolveStateDir({ agentId: "../../escaped" })).toThrow(/agentId/);
  expect(() => resolveStateDir({ agentId: "." })).toThrow(/agentId/);
  // 正常的仍然通
  expect(resolveStateDir({ agentId: "default", stateDir: "/tmp/x" })).toBe("/tmp/x");
});

test("③ 符号链接逃不出去——词法 containment 看不出这条", async () => {
  // 实测过：把 root/sessions 链到外部目录之后，createOrResume("main") 会在**外部**
  // 写出 main/meta.json。每一段路径都在 root 底下，resolve() 全程没话说。
  const root = await tmp("echo-link-root-");
  const outside = await tmp("echo-link-out-");
  await mkdir(join(outside, "stolen"), { recursive: true });
  await symlink(outside, join(root, "sessions"));

  const svc = new SessionService(new FileDir(root));
  await expect(svc.createOrResume("main")).rejects.toThrow(/符号链接/);
  expect(existsSync(join(outside, "main", "meta.json"))).toBe(false);
});

test("③b 检查发生在 mkdir 之前——否则递归建目录会先把路径实体化到外面", async () => {
  const root = await tmp("echo-link-root2-");
  const outside = await tmp("echo-link-out2-");
  await symlink(outside, join(root, "escape"));

  const dir = new FileDir(root);
  await expect(dir.write("escape/deep/nested/x.json", "{}")).rejects.toThrow(/符号链接/);
  expect(existsSync(join(outside, "deep"))).toBe(false);
});

test("正常路径不受影响（防线不能把自己也挡在外面）", async () => {
  const root = await tmp("echo-ok-");
  const dir = new FileDir(root);
  await dir.write("sessions/main/meta.json", '{"ok":true}');
  expect(await dir.read("sessions/main/meta.json")).toBe('{"ok":true}');
  expect(await dir.list("sessions/")).toEqual(["sessions/main/meta.json"]);
  expect(await dir.remove("sessions/main/meta.json")).toBe(true);
});
