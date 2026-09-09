import { test, expect } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileDir } from "../src/storage/file-dir.ts";
import { SessionService } from "../src/session/service.ts";
import { resolveStateDir } from "../src/create-agent.ts";
import { userMessage } from "../src/messages.ts";

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

test("② sessionId 里的 ../ 在状态根解析这一层也逃不出去", () => {
  // 状态根 = `<ECHO_HOME>/sessions/<sessionId>`（2026-09-03），所以 sessionId 是路径段：
  // 不校验的话 "../../escaped" 会把整个状态根移出 .echo/sessions（agentId 在旧布局下实测过同样的洞）。
  expect(() => resolveStateDir({ sessionId: "../../escaped" })).toThrow(/会话 id/);
  expect(() => resolveStateDir({ sessionId: "." })).toThrow(/会话 id/);
  // 正常的仍然通
  expect(resolveStateDir({ sessionId: "s1", stateDir: "/tmp/x" })).toBe("/tmp/x");
});

test("③ 符号链接逃不出去——词法 containment 看不出这条", async () => {
  // 实测过：把 session 目录里的 entries/ 链到外部目录之后，入账会把 entry 文件写到**外部**去。
  // 每一段路径都在 root 底下，resolve() 全程没话说——词法 containment 对符号链接是瞎的。
  const root = await tmp("echo-link-root-");
  const outside = await tmp("echo-link-out-");
  await mkdir(join(outside, "stolen"), { recursive: true });
  await symlink(outside, join(root, "entries"));

  const svc = new SessionService(new FileDir(root));
  // 恢复 → 入账 → 落盘这条链上任一步判红都算：`list("entries/")` 2026-09-08 起也过 resolveSafe（起点是逃出 root 的符号链接
  // 就在恢复时抛），比等到落盘更早；无论在哪一步抛，外面都不能多出文件
  await expect(
    (async () => {
      await svc.createOrResume("main");
      await svc.append("main", [{ kind: "message", message: userMessage("会被写到外面去吗") }]);
      await svc.settle();
    })(),
  ).rejects.toThrow(/符号链接/);
  expect(existsSync(join(outside, "000001.json"))).toBe(false);
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
