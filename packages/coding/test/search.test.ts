// glob / grep 的判据：候选文件从哪来（git 认的文件 / 目录遍历）、点目录、排序后再截、超大文件的说明，
// 以及 grep 的 ignore_case / output_mode。直接调工具对象（不经装配）。

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelTool, ToolExecutionContext } from "@echo-agent/core";
import { makeSearchTools } from "../src/tools/search.ts";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "echo-search-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const ctx = (): ToolExecutionContext => ({ toolCallId: "t1", workspace: root, sessionId: null, iteration: 0 });
const tool = (name: string): ModelTool => makeSearchTools().find((t) => t.name === name)!;

/** 在 root 里建一个 git 工作树（不提交也行：未跟踪且未被忽略的文件同样算）。 */
function gitInit(dir: string): void {
  const r = Bun.spawnSync(["git", "init", "-q"], { cwd: dir });
  expect(r.exitCode).toBe(0);
}

async function put(rel: string, text: string): Promise<void> {
  const abs = join(root, rel);
  await mkdir(join(abs, ".."), { recursive: true });
  await writeFile(abs, text);
}

test("glob / grep 包含点目录（.github），仍排除 .git 与 node_modules", async () => {
  await put(".github/workflows/ci.yml", "run: bun test\n");
  await put("src/a.yml", "x: 1\n");
  await put("node_modules/pkg/c.yml", "run: no\n");
  await put(".env.example", "API_URL=x\n");
  for (const git of [false, true]) {
    if (git) gitInit(root);
    const all = await tool("glob").execute({ pattern: "**/*.yml" }, ctx());
    expect([git, all.content]).toEqual([git, ".github/workflows/ci.yml\nsrc/a.yml"]);
    const scoped = await tool("glob").execute({ pattern: ".github/**/*.yml" }, ctx());
    expect([git, scoped.content]).toEqual([git, ".github/workflows/ci.yml"]);
    const g = await tool("grep").execute({ pattern: "run:" }, ctx());
    expect([git, g.content]).toEqual([git, ".github/workflows/ci.yml:1:run: bun test"]);
    const env = await tool("grep").execute({ pattern: "API_URL" }, ctx());
    expect([git, env.content]).toEqual([git, ".env.example:1:API_URL=x"]);
    const head = await tool("glob").execute({ pattern: "**/HEAD" }, ctx());
    expect([git, head.content]).toEqual([git, "(no matches)"]); // .git 里的东西不出现
  }
});

test("git 工作树里按 .gitignore 排除（dist、build 不搜）；点名被忽略的目录照搜", async () => {
  gitInit(root);
  await put(".gitignore", "dist/\n*.log\n");
  await put("dist/bundle.js", "function handleLogin(){}\n");
  await put("debug.log", "handleLogin failed\n");
  await put("src/login.ts", "export function handleLogin() {}\n");
  const g = await tool("grep").execute({ pattern: "handleLogin" }, ctx());
  expect(g.content).toBe("src/login.ts:1:export function handleLogin() {}");
  const files = await tool("glob").execute({ pattern: "**/*.js" }, ctx());
  expect(files.content).toBe("(no matches)");
  // 用户点名要搜被忽略的目录：照搜
  const named = await tool("grep").execute({ pattern: "handleLogin", path: "dist" }, ctx());
  expect(named.content).toBe("dist/bundle.js:1:function handleLogin(){}");
});

test("结果按路径排序后再截，截断时说出总数", async () => {
  // 名字倒着建：截断若按扫描/创建顺序取，前几名就不是排序后的前几名
  for (let i = 520; i >= 1; i--) await put(`f/${String(i).padStart(4, "0")}.txt`, "hit\n");
  const g = await tool("glob").execute({ pattern: "**/*.txt" }, ctx());
  const lines = g.content.split("\n");
  expect(lines[0]).toBe("f/0001.txt");
  expect(lines[499]).toBe("f/0500.txt");
  expect(g.content).toContain("520 files match");

  const gr = await tool("grep").execute({ pattern: "hit" }, ctx());
  const rows = gr.content.split("\n");
  expect(rows[0]).toBe("f/0001.txt:1:hit");
  expect(rows[199]).toBe("f/0200.txt:1:hit");
  expect(gr.content).toContain("520 matching lines");
});

test("grep 跳过的超大文件（>1 MB）在结果尾部说出个数", async () => {
  await put("small.txt", "needle\n");
  await put("huge.txt", `needle\n${"x".repeat(1_100_000)}\n`);
  const g = await tool("grep").execute({ pattern: "needle" }, ctx());
  expect(g.content.startsWith("small.txt:1:needle")).toBe(true);
  expect(g.content).toContain("1 file over 1 MB");
  const none = await tool("grep").execute({ pattern: "absent" }, ctx());
  expect(none.content).toContain("1 file over 1 MB");
});

test("grep ignore_case：不分大小写；写 (?i) 时报错里指向 ignore_case", async () => {
  await put("src/login.ts", "export function handleLogin() {}\n");
  const plain = await tool("grep").execute({ pattern: "handlelogin" }, ctx());
  expect(plain.content).toContain("no matches");
  const ci = await tool("grep").execute({ pattern: "handlelogin", ignore_case: true }, ctx());
  expect(ci.content).toBe("src/login.ts:1:export function handleLogin() {}");
  const inline = await tool("grep").execute({ pattern: "(?i)handlelogin" }, ctx());
  expect([inline.isError, inline.content]).toEqual([true, expect.stringContaining("ignore_case")]);
});

test("grep output_mode：content（缺省）/ files_with_matches / count", async () => {
  await put("a.ts", "hit\nmiss\nhit\n");
  await put("b.ts", "hit\n");
  await put("c.ts", "miss\n");
  const content = await tool("grep").execute({ pattern: "hit" }, ctx());
  expect(content.content).toBe("a.ts:1:hit\na.ts:3:hit\nb.ts:1:hit");
  const files = await tool("grep").execute({ pattern: "hit", output_mode: "files_with_matches" }, ctx());
  expect(files.content).toBe("a.ts\nb.ts");
  const count = await tool("grep").execute({ pattern: "hit", output_mode: "count" }, ctx());
  expect(count.content).toBe("a.ts:2\nb.ts:1");
  const bad = await tool("grep").execute({ pattern: "hit", output_mode: "lines" }, ctx());
  expect(bad.isError).toBe(true);
});
