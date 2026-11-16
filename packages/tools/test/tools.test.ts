// 工具自己的契约门：直接拿工具对象调，真动盘、真起进程、真发请求（发到本机假服务）。
// 经产品装配之后的整链（权限、沙箱走真装配、后台作业）在各产品自己的测试里——`echo-coding` 的在它的 `coding-agent.test.ts`。

import { test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { ModelTool, ToolExecutionContext } from "@echo-agent/core";
import { makeFsTools } from "../src/fs.ts";
import { makeBashTool } from "../src/bash.ts";
import { makeSearchTools } from "../src/search.ts";
import { htmlToText, makeWebTools } from "../src/web.ts";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "echo-tools-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const ctx = (): ToolExecutionContext => ({
  toolCallId: "t1",
  workspace: root,
  sessionId: null,
  iteration: 0,
});

/** web_fetch / web_search 的正文：去掉打头那一句「外部内容」说明（它的判据在 web.test.ts）。 */
const webBody = (content: string): string => (content.startsWith("[External content from ") ? content.slice(content.indexOf("\n") + 1) : content);

function tool(list: ModelTool[], name: string): ModelTool {
  return list.find((t) => t.name === name)!;
}

/* ══════════ 文件三件套 ══════════ */

test("read/write/edit 整套:写 → 读(带行号)→ 精确替换", async () => {
  const fs = makeFsTools();
  const w = await tool(fs, "write_file").execute({ path: "a.ts", content: "const a = 1;\nconst b = 2;" }, ctx());
  expect(w.isError).toBe(false);

  const r = await tool(fs, "read_file").execute({ path: "a.ts" }, ctx());
  expect(r.content).toContain("1\tconst a = 1;");

  const e = await tool(fs, "edit_file").execute({ path: "a.ts", old_string: "const b = 2;", new_string: "const b = 3;" }, ctx());
  expect(e.isError).toBe(false);
  expect(await readFile(join(root, "a.ts"), "utf8")).toBe("const a = 1;\nconst b = 3;");
});

/** 只有文件头的 PNG：1568 像素以内不缩放，core 只读头，够用。 */
function pngHeader(w: number, h: number): Uint8Array {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const v = new DataView(b.buffer);
  v.setUint32(16, w);
  v.setUint32(20, h);
  b.set([8, 6, 0, 0, 0], 24);
  return b;
}

test("read_file 读图片（2026-11-02，照 Claude Code 的 Read）：返回图片本身加一行说明；扩展名是图片但内容不是就按文本读；太大报错并教缩小", async () => {
  const fs = makeFsTools();
  await writeFile(join(root, "shot.png"), pngHeader(800, 600));
  const r = await tool(fs, "read_file").execute({ path: "shot.png" }, ctx());
  expect([r.isError, r.content]).toEqual([false, "Image file shot.png (800×600)"]);
  expect(r.images?.length).toBe(1);
  expect(r.images?.[0]?.mimeType).toBe("image/png");
  // 声明了不外存：读文件自己会分页
  expect(tool(fs, "read_file").maxInlineTokens).toBe(Infinity);

  await writeFile(join(root, "not-really.png"), "just some text");
  const text = await tool(fs, "read_file").execute({ path: "not-really.png" }, ctx());
  expect([text.isError, text.content.includes("1\tjust some text"), text.images]).toEqual([false, true, undefined]);

  // 长边超过接口上限、又缩不了（只有文件头，缩放工具解不出来）→ 报错，教先缩小再读
  await writeFile(join(root, "huge.png"), pngHeader(9_000, 9_000));
  const huge = await tool(fs, "read_file").execute({ path: "huge.png" }, ctx());
  expect(huge.isError).toBe(true);
  expect(huge.content).toContain("Cannot read huge.png as an image");
  expect(huge.content).toContain("smaller copy");
});

test("edit_file:匹配 0 处 / 多处都拒,replace_all 放行", async () => {
  const fs = makeFsTools();
  await writeFile(join(root, "x.txt"), "aa aa", "utf8");
  await tool(fs, "read_file").execute({ path: "x.txt" }, ctx()); // 改前必读（2026-09-02 起是门，见下一条）
  const zero = await tool(fs, "edit_file").execute({ path: "x.txt", old_string: "zzz", new_string: "y" }, ctx());
  expect(zero.isError).toBe(true);
  const multi = await tool(fs, "edit_file").execute({ path: "x.txt", old_string: "aa", new_string: "b" }, ctx());
  expect(multi.isError).toBe(true);
  expect(multi.content).toContain("2 matches");
  const all = await tool(fs, "edit_file").execute({ path: "x.txt", old_string: "aa", new_string: "b", replace_all: true }, ctx());
  expect(all.isError).toBe(false);
  expect(await readFile(join(root, "x.txt"), "utf8")).toBe("b b");
});

test("edit_file:空 old_string 一律拒、文件一个字节不动（review 2026-09-07：此前 replace_all 时会逐字符插入、静默毁掉整个文件）", async () => {
  const fs = makeFsTools();
  await writeFile(join(root, "e.txt"), "abc", "utf8");
  await tool(fs, "read_file").execute({ path: "e.txt" }, ctx());
  for (const args of [{ replace_all: true }, {}]) {
    const r = await tool(fs, "edit_file").execute({ path: "e.txt", old_string: "", new_string: "X", ...args }, ctx());
    expect(r.isError).toBe(true);
    expect(r.content).toContain("must not be empty");
    expect(await readFile(join(root, "e.txt"), "utf8")).toBe("abc");
  }
  await writeFile(join(root, "empty.txt"), "", "utf8");
  await tool(fs, "read_file").execute({ path: "empty.txt" }, ctx());
  const onEmpty = await tool(fs, "edit_file").execute({ path: "empty.txt", old_string: "", new_string: "X" }, ctx());
  expect(onEmpty.isError).toBe(true);
  expect(await readFile(join(root, "empty.txt"), "utf8")).toBe("");
});

test("改前必读、读后未变：没读过拒、盘上被别人改过拒、自己写过的算读过；新建文件不用读", async () => {
  // 2026-09-02 用户拍板（照 Claude Code 的 Edit / Write 门）：此前只是 description 里一句「先读」，
  // 模型没读就改、或按旧内容盖掉用户刚在编辑器里改的文件，都拦不住
  const fs = makeFsTools();
  await writeFile(join(root, "g.txt"), "one\n", "utf8");

  const blind = await tool(fs, "edit_file").execute({ path: "g.txt", old_string: "one", new_string: "two" }, ctx());
  expect([blind.isError, blind.content]).toEqual([true, "Read g.txt with read_file before changing it"]);
  const blindWrite = await tool(fs, "write_file").execute({ path: "g.txt", content: "x" }, ctx());
  expect(blindWrite.isError).toBe(true);
  expect(await readFile(join(root, "g.txt"), "utf8")).toBe("one\n"); // 一个字没动

  await tool(fs, "read_file").execute({ path: "g.txt" }, ctx());
  const ok = await tool(fs, "edit_file").execute({ path: "g.txt", old_string: "one", new_string: "two" }, ctx());
  expect(ok.isError).toBe(false);
  // 自己刚写过的算读过：连续两次 edit 不用中间重读
  const again = await tool(fs, "edit_file").execute({ path: "g.txt", old_string: "two", new_string: "three" }, ctx());
  expect(again.isError).toBe(false);

  // 别人（编辑器、另一个进程）改了盘上的文件：mtime 变了 → 拒，读一遍才能再改
  await new Promise((r) => setTimeout(r, 15)); // mtime 至少差 1ms
  await writeFile(join(root, "g.txt"), "three\nuser edit\n", "utf8");
  const stale = await tool(fs, "edit_file").execute({ path: "g.txt", old_string: "three", new_string: "four" }, ctx());
  expect([stale.isError, stale.content]).toEqual([true, "g.txt changed on disk since you read it; read it again before changing it"]);
  expect(await readFile(join(root, "g.txt"), "utf8")).toBe("three\nuser edit\n"); // 用户的改动没被盖
  await tool(fs, "read_file").execute({ path: "g.txt" }, ctx());
  expect((await tool(fs, "edit_file").execute({ path: "g.txt", old_string: "three", new_string: "four" }, ctx())).isError).toBe(false);

  // 新建不用先读
  const fresh = await tool(fs, "write_file").execute({ path: "new/n.txt", content: "hi" }, ctx());
  expect(fresh.isError).toBe(false);
});

test("edit_file 的替换文本里带 `$` 原样落盘（不解释 $& / $$ 这类模式）", async () => {
  const fs = makeFsTools();
  await writeFile(join(root, "d.ts"), "const price = COST;\n", "utf8");
  await tool(fs, "read_file").execute({ path: "d.ts" }, ctx());
  const r = await tool(fs, "edit_file").execute({ path: "d.ts", old_string: "COST", new_string: "`$${n}` + $& + $$" }, ctx());
  expect(r.isError).toBe(false);
  expect(await readFile(join(root, "d.ts"), "utf8")).toBe("const price = `$${n}` + $& + $$;\n");
});

test("路径越界一律拒(../ 逃逸、绝对路径出工作区)", async () => {
  const fs = makeFsTools();
  for (const path of ["../outside.txt", "/etc/passwd", "a/../../b.txt"]) {
    const r = await tool(fs, "write_file").execute({ path, content: "x" }, ctx());
    expect(r.isError).toBe(true);
    expect(r.content).toContain("outside the workspace");
  }
});

test("越界守卫覆盖六件工具，且解 symlink：工作区里一条软链指到外面，读、写、改、搜、找、列一律拒；指回工作区内的软链照常（review 2026-09-07）", async () => {
  // 此前：`resolveSafe` 只比字符串前缀，`link -> /outside` 之后 `link/secret` 字面上完全在工作区内；
  // 而 glob / grep / list_dir 根本没有边界——凡是把 bash 设成 ask 的策略，grep 就是绕开那道门读整块盘的路。
  const outside = await mkdtemp(join(tmpdir(), "echo-ca-outside-"));
  try {
    await writeFile(join(outside, "secret.txt"), "top secret\n", "utf8");
    await mkdir(join(root, "sub"), { recursive: true });
    await writeFile(join(root, "sub/in.txt"), "inside\n", "utf8");
    await symlink(outside, join(root, "escape")); // 目录软链 → 外面
    await symlink(join(outside, "secret.txt"), join(root, "escape.txt")); // 文件软链 → 外面
    await symlink(join(root, "sub"), join(root, "alias")); // 软链 → 工作区内

    const fs = makeFsTools();
    const s = makeSearchTools();
    const refused = (r: { isError?: boolean; content: string }): void => {
      expect(r.isError).toBe(true);
      expect(r.content).toContain("outside the workspace");
    };
    refused(await tool(fs, "read_file").execute({ path: "escape/secret.txt" }, ctx()));
    refused(await tool(fs, "read_file").execute({ path: "escape.txt" }, ctx()));
    refused(await tool(fs, "write_file").execute({ path: "escape/new.txt", content: "x" }, ctx()));
    expect(existsSync(join(outside, "new.txt")), "写到外面去了").toBe(false);
    refused(await tool(fs, "write_file").execute({ path: "escape/deeper/new.txt", content: "x" }, ctx())); // mkdir 之前就得拒
    expect(existsSync(join(outside, "deeper")), "递归建目录顺着软链建到外面去了").toBe(false);
    refused(await tool(fs, "edit_file").execute({ path: "escape.txt", old_string: "top", new_string: "x" }, ctx()));
    refused(await tool(s, "grep").execute({ pattern: "secret", path: "escape" }, ctx()));
    refused(await tool(s, "glob").execute({ pattern: "*", path: "escape" }, ctx()));
    refused(await tool(s, "list_dir").execute({ path: "escape" }, ctx()));
    // 三件搜索工具对绝对路径与 `../` 同样拒（此前它们根本没有边界）
    refused(await tool(s, "list_dir").execute({ path: outside }, ctx()));
    refused(await tool(s, "grep").execute({ pattern: "secret", path: "../" }, ctx()));
    refused(await tool(s, "glob").execute({ pattern: "*", path: "/" }, ctx()));

    // 指回工作区内的软链不误伤（结果路径仍按字面相对工作区报，不冒出展开后的路径）
    const ok = await tool(fs, "read_file").execute({ path: "alias/in.txt" }, ctx());
    expect([ok.isError, ok.content]).toEqual([false, expect.stringContaining("inside")]);
    expect((await tool(s, "list_dir").execute({ path: "alias" }, ctx())).content).toBe("in.txt");
    expect((await tool(s, "grep").execute({ pattern: "inside", path: "alias" }, ctx())).content).toBe("alias/in.txt:1:inside");
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
});

/* ══════════ bash ══════════ */

test("bash:stdout+stderr 合并;非零退出是结果不是异常", async () => {
  const bash = makeBashTool();
  const ok = await bash.execute({ command: "echo out; echo err >&2" }, ctx());
  expect(ok.isError).toBe(false);
  expect(ok.content).toContain("out");
  expect(ok.content).toContain("err");

  const fail = await bash.execute({ command: "echo boom; exit 3" }, ctx());
  expect(fail.isError).toBe(true);
  expect(fail.content).toContain("exit code 3");
  expect(fail.content).toContain("boom"); // 模型要看到输出来决定下一步
});

test("bash 输出跨 chunk 的多字节字符不解成替换符（review 2026-09-07：此前逐块 toString）", async () => {
  const bash = makeBashTool();
  // 「中中中」的 UTF-8 拆在两次 printf 之间，中间 sleep 让它分两个 chunk 到
  const r = await bash.execute({ command: "printf '\\xe4\\xb8\\xad\\xe4'; sleep 0.05; printf '\\xb8\\xad\\xe4\\xb8\\xad'" }, ctx());
  expect(r.isError).toBe(false);
  expect(r.content).toContain("中中中");
  expect(r.content).not.toContain("�");
});

test("bash 超时:杀掉并说清,不挂死", async () => {
  const bash = makeBashTool();
  const r = await bash.execute({ command: "sleep 10", timeout_ms: 100 }, ctx());
  expect(r.isError).toBe(true);
  expect(r.content).toContain("Timed out");
}, 10_000);

test("bash 工作目录跨调用保留：cd 之后下一次从那里起；cd 失败不动；目录被删退回 workspace 并说明；exit 也保留退出码", async () => {
  // 2026-09-03 补：此前每次都是全新 shell，模型得每条命令都带 `cd sub && …`，多走一步就忘。变量仍不保留（照 Claude Code）。
  await mkdir(join(root, "sub"), { recursive: true });
  const bash = makeBashTool();
  const first = await bash.execute({ command: "cd sub && pwd" }, ctx());
  expect([first.isError, first.content]).toEqual([false, expect.stringContaining("(working directory is now ")]);
  // `$PWD` 是工作区那一种写法（逻辑路径），不是 realpath：工作区经软链（macOS 的 /var）时也不会展开
  expect(first.content.startsWith(join(root, "sub"))).toBe(true);
  // 下一次从 sub 起；标记不漏进正文
  const second = await bash.execute({ command: "basename \"$PWD\"; X=1" }, ctx());
  expect([second.isError, second.content.trimEnd()]).toEqual([false, "sub"]);
  // 变量不保留
  const third = await bash.execute({ command: "echo \"[$X]\"" }, ctx());
  expect(third.content.trimEnd()).toBe("[]");
  // cd 失败：目录不动，退出码照实回
  const bad = await bash.execute({ command: "cd nope-not-here" }, ctx());
  expect([bad.isError, bad.content]).toEqual([true, expect.stringContaining("exit code 1")]);
  expect(bad.content).not.toContain("working directory is now");
  expect((await bash.execute({ command: "basename \"$PWD\"" }, ctx())).content.trimEnd()).toBe("sub");
  // 命令自己 exit：退出码保留（包了一层不能把它吞成 0）
  const exited = await bash.execute({ command: "exit 7" }, ctx());
  expect([exited.isError, exited.content]).toEqual([true, "exit code 7\n"]);
  // 目录被删：退回 workspace，并把这件事说出来
  await rm(join(root, "sub"), { recursive: true, force: true });
  const back = await bash.execute({ command: "basename \"$PWD\"" }, ctx());
  expect(back.isError).toBe(false);
  expect(back.content).toContain("no longer exists; back in the workspace root");
  expect(back.content.startsWith(basename(root))).toBe(true);
  // 输出超长也截不掉标记：cd 仍然记住
  await mkdir(join(root, "sub2"), { recursive: true });
  const huge = await bash.execute({ command: "cd sub2 && head -c 100000 /dev/zero | tr '\\0' 'x'" }, ctx());
  // 10 万字符原样收全：截断与外存归 core（2026-11-02），工具这里不再截到 30,000 丢掉后半
  expect([huge.isError, huge.content.startsWith(`${"x".repeat(100_000)}\n(working directory is now`), huge.content.includes("truncated")]).toEqual([false, true, false]);
  expect((await bash.execute({ command: "basename \"$PWD\"" }, ctx())).content.trimEnd()).toBe("sub2");
});

/* ══════════ 搜索 ══════════ */

test("glob 找文件(排除 node_modules);grep 找内容带 文件:行号", async () => {
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(root, "node_modules/pkg"), { recursive: true });
  await writeFile(join(root, "src/a.ts"), "export const hit = 1;\n", "utf8");
  await writeFile(join(root, "node_modules/pkg/b.ts"), "export const hit = 2;\n", "utf8");

  const s = makeSearchTools();
  const g = await tool(s, "glob").execute({ pattern: "**/*.ts" }, ctx());
  expect(g.content).toContain("src/a.ts");
  expect(g.content).not.toContain("node_modules");

  const gr = await tool(s, "grep").execute({ pattern: "hit" }, ctx());
  expect(gr.content).toContain("src/a.ts:1:");
  expect(gr.content).not.toContain("node_modules");

  const bad = await tool(s, "grep").execute({ pattern: "[unclosed" }, ctx());
  expect(bad.isError).toBe(true);
});

test("grep 的 path 指到单个文件就只搜它（相对、绝对都行）；结果路径一律相对工作区；glob 拿到文件明说要目录", async () => {
  // 实测 bug（2026-09-01）：模型把 grep 当 `grep <pattern> <file>` 用，此前拿到的是一句 `ENOTDIR: not a directory`
  await mkdir(join(root, "src/deep"), { recursive: true });
  await writeFile(join(root, "src/deep/a.ts"), "const x = 1;\nconst hit = 2;\n", "utf8");
  await writeFile(join(root, "src/b.ts"), "const hit = 3;\n", "utf8");

  const s = makeSearchTools();
  for (const path of ["src/deep/a.ts", join(root, "src/deep/a.ts")]) {
    const r = await tool(s, "grep").execute({ pattern: "hit", path }, ctx());
    expect([path, r.isError, r.content]).toEqual([path, false, "src/deep/a.ts:2:const hit = 2;"]);
  }
  // 子目录里搜，报的仍是工作区相对路径——read_file / edit_file 收的就是它，不是 `a.ts` 这种相对 path 的
  const inDir = await tool(s, "grep").execute({ pattern: "hit", path: "src/deep" }, ctx());
  expect(inDir.content).toBe("src/deep/a.ts:2:const hit = 2;");
  const globbed = await tool(s, "glob").execute({ pattern: "*.ts", path: "src/deep" }, ctx());
  expect(globbed.content).toBe("src/deep/a.ts");

  // glob 的 path 是文件：不静默返回 0 个，明说要目录、指回 grep
  const fileGlob = await tool(s, "glob").execute({ pattern: "*.ts", path: "src/b.ts" }, ctx());
  expect([fileGlob.isError, fileGlob.content]).toEqual([true, expect.stringContaining("use grep")]);
  // 不存在：说是哪个 path，不是 ENOTDIR / ENOENT 原文
  const missing = await tool(s, "grep").execute({ pattern: "hit", path: "src/nope" }, ctx());
  expect([missing.isError, missing.content]).toEqual([true, "path not found: src/nope"]);
});

test("list_dir：一层目录，子目录在前带 /；缺省工作区根；拿到文件明说要目录", async () => {
  // 2026-09-02 补：glob 只出文件，模型看不到目录结构，只能 bash ls
  await mkdir(join(root, "src/deep"), { recursive: true });
  await mkdir(join(root, "node_modules/pkg"), { recursive: true });
  await writeFile(join(root, "src/a.ts"), "", "utf8");
  await writeFile(join(root, "README.md"), "", "utf8");

  const s = makeSearchTools();
  const top = await tool(s, "list_dir").execute({}, ctx());
  expect([top.isError, top.content]).toEqual([false, "node_modules/\nsrc/\nREADME.md"]); // 目录真相：node_modules 也列
  const sub = await tool(s, "list_dir").execute({ path: "src" }, ctx());
  expect(sub.content).toBe("deep/\na.ts");
  expect((await tool(s, "list_dir").execute({ path: "src/deep" }, ctx())).content).toBe("(empty directory)");
  const file = await tool(s, "list_dir").execute({ path: "src/a.ts" }, ctx());
  expect([file.isError, file.content]).toEqual([true, expect.stringContaining("needs a directory")]);
});

/* ══════════ web_fetch ══════════ */

test("web_fetch：HTML 剥成文本（标题、标题级、链接、列表）；JSON 原样；非 2xx 与二进制是 error；max_chars 截断", async () => {
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const p = new URL(req.url).pathname;
      if (p === "/page") {
        return new Response(
          '<html><head><title>Hi &amp; bye</title><style>x{}</style></head><body><h1>Top</h1><p>Hello <a href="https://x.test/a">link</a> world</p><script>bad()</script><ul><li>one</li><li>two</li></ul></body></html>',
          { headers: { "content-type": "text/html; charset=utf-8" } },
        );
      }
      if (p === "/json") return Response.json({ a: 1 });
      if (p === "/bin") return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "application/octet-stream" } });
      if (p === "/big") {
        // 8 MB 的慢流（每块 64 KB、异步喂）：读端到 4 MB 上限就 cancel 的话，服务端喂不到 8 MB 就停了
        //（review 2026-09-07：此前 arrayBuffer() 先把整个响应体收进内存再截）。不用无限流——同步的无限 pull 会卡住事件循环
        const block = new Uint8Array(64 * 1024).fill(0x61);
        return new Response(
          new ReadableStream({
            async pull(controller) {
              await new Promise((r) => setTimeout(r, 1));
              if (served >= 8 * 1024 * 1024) {
                controller.close();
                return;
              }
              served += block.byteLength;
              controller.enqueue(block);
            },
          }),
          { headers: { "content-type": "text/plain" } },
        );
      }
      return new Response("nope", { status: 404 });
    },
  });
  let served = 0;
  try {
    // 假服务在 127.0.0.1：把它解析成公网地址才发得出去（缺省拒绝内网地址，判据在 web.test.ts）
    const [fetchTool] = makeWebTools({ resolveHost: async () => ["203.0.113.7"] }) as [ModelTool<{ url: string; max_chars?: number }>];
    const base = `http://127.0.0.1:${server.port}`;
    const big = await fetchTool.execute({ url: `${base}/big`, max_chars: 10 }, ctx());
    expect([big.isError, big.content]).toEqual([false, expect.stringContaining("over 4000000 bytes, cut")]);
    expect(served).toBeLessThan(8 * 1024 * 1024); // 到上限就 cancel 了，不是把无限流读到内存里
    const page = await fetchTool.execute({ url: `${base}/page` }, ctx());
    expect([page.isError, webBody(page.content)]).toEqual([false, "Hi & bye\n\n# Top\nHello [link](https://x.test/a) world\n- one\n- two"]);
    const json = await fetchTool.execute({ url: `${base}/json` }, ctx());
    expect([json.isError, webBody(json.content)]).toEqual([false, '{"a":1}']);
    const missing = await fetchTool.execute({ url: `${base}/missing` }, ctx());
    expect([missing.isError, missing.content]).toEqual([true, expect.stringContaining("HTTP 404")]);
    const bin = await fetchTool.execute({ url: `${base}/bin` }, ctx());
    expect([bin.isError, bin.content]).toEqual([true, expect.stringContaining("Unsupported content type")]);
    const short = await fetchTool.execute({ url: `${base}/page`, max_chars: 8 }, ctx());
    expect([short.isError, webBody(short.content).startsWith("Hi & bye\n…[truncated")]).toEqual([false, true]);
    const bad = await fetchTool.execute({ url: "ftp://x" }, ctx());
    expect(bad.isError).toBe(true);
  } finally {
    server.stop(true);
  }
});

test("htmlToText：实体、注释、noscript、相对链接只留文字、多余空行折叠", () => {
  const out = htmlToText(
    "<!-- c --><div>A&nbsp;&lt;b&gt;&#39;q&#x27;</div><noscript>no</noscript>\n\n\n<p><a href='/rel'>rel</a> <a href='https://h.test'>https://h.test</a></p><table><tr><td>1</td><td>2</td></tr></table>",
  );
  expect(out).toBe("A <b>'q'\n\nrel https://h.test\n1 2"); // 源码里的连续空行折成一个段落空行
});

test("web_search（Brave）：没配 key 如实报没配；环境变量优先于凭据 store；结果剥标签成「标题 / 链接 / 摘要」；401 说 key 被拒且不泄露 key", async () => {
  const seen: Record<string, string>[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const u = new URL(req.url);
      const token = req.headers.get("x-subscription-token") ?? "";
      seen.push({ q: u.searchParams.get("q") ?? "", count: u.searchParams.get("count") ?? "", freshness: u.searchParams.get("freshness") ?? "", token });
      if (token === "bad") return new Response("{}", { status: 401 });
      return Response.json({
        web: {
          results: [
            { title: "<strong>Bun</strong> docs", url: "https://bun.sh/docs", description: "Bun &amp; TypeScript <b>guide</b>", age: "2 days ago" },
            { title: "Other", url: "https://x.test" },
          ],
        },
      });
    },
  });
  const search = (tools: ModelTool[]): ModelTool<{ query: string; count?: number; freshness?: string }> =>
    tools.find((t) => t.name === "web_search") as ModelTool<{ query: string; count?: number; freshness?: string }>;
  const prev = process.env.BRAVE_API_KEY;
  delete process.env.BRAVE_API_KEY;
  try {
    const endpoint = `http://127.0.0.1:${server.port}/search`;
    const none = search(makeWebTools({ searchEndpoint: endpoint }));
    const r0 = await none.execute({ query: "bun" }, ctx());
    expect([r0.isError, r0.content]).toEqual([true, expect.stringContaining("No search service configured")]);
    expect(seen.length).toBe(0); // 没 key 不出网

    const store = { read: async (id: string) => (id === "brave" ? ({ type: "api_key", key: "from-store" } as const) : undefined) };
    const withStore = search(makeWebTools({ credentials: store, searchEndpoint: endpoint }));
    const r1 = await withStore.execute({ query: "bun workspace", count: 2, freshness: "week" }, ctx());
    expect(r1.content.split("\n")[0]).toContain("External content from Brave Search");
    expect([r1.isError, webBody(r1.content)]).toEqual([
      false,
      'Results for "bun workspace":\n1. Bun docs (2 days ago)\n   https://bun.sh/docs\n   Bun & TypeScript guide\n2. Other\n   https://x.test',
    ]);
    expect(seen.at(-1)).toEqual({ q: "bun workspace", count: "2", freshness: "pw", token: "from-store" });

    process.env.BRAVE_API_KEY = "bad"; // 环境变量赢过 store
    const r2 = await withStore.execute({ query: "x" }, ctx());
    expect([r2.isError, r2.content, seen.at(-1)?.token]).toEqual([true, expect.stringContaining("rejected the API key"), "bad"]);
    expect(r2.content).not.toContain("from-store");
    expect(r2.content).not.toContain("bad\n");
  } finally {
    if (prev === undefined) delete process.env.BRAVE_API_KEY;
    else process.env.BRAVE_API_KEY = prev;
    server.stop(true);
  }
});
