// 工作区信任的判定（`trustConventionDir`，决策 docs/decisions/implemented/2026-11-03-workspace-trust.md）：
// 约定目录里**有**扩展文件、工作区又不受信，才不交给装配；目录是空的（或不存在）就照交——
// 仓库没带来任何要执行的代码，之后在会话里写进去的与模型跑 bash 同一个信任级别，模型触发的热部署照常发现。

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { trustConventionDir } from "../src/cli.ts";

let ws = "";
let cwd = "";
beforeEach(() => {
  cwd = process.cwd();
  ws = realpathSync(mkdtempSync(join(tmpdir(), "echo-trust-")));
  process.chdir(ws);
});
afterEach(() => {
  process.chdir(cwd);
  rmSync(ws, { recursive: true, force: true });
});

const opts = { withoutMemory: true, extensionDirs: [], continueLast: false, serve: false };
const decide = (interactive: boolean): Promise<boolean> =>
  trustConventionDir({ name: "t" } as never, {} as never, opts, interactive, [], [], new AbortController().signal, {} as never);

test("约定目录不存在、或是空的：不问、照交（会话里新写的扩展热部署照常发现）", async () => {
  expect(await decide(false)).toBe(true);
  mkdirSync(join(ws, "extensions"));
  expect(await decide(false)).toBe(true);
});

test("约定目录里已经有扩展文件、工作区不受信、没人可问：不交", async () => {
  mkdirSync(join(ws, "extensions"));
  writeFileSync(join(ws, "extensions", "x.ts"), "export default {};\n");
  expect(await decide(false)).toBe(false);
});
