// 文件三件套的判据：编码、二进制、分页尾注、匹配失败的提示、工作区边界的软链。
// 直接调工具对象（不经装配）：这里只判单个工具的输入输出。

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelTool, ToolExecutionContext } from "@echo-agent/core";
import { makeFsTools } from "../src/tools/fs.ts";
import { makeSearchTools } from "../src/tools/search.ts";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "echo-fs-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const ctxAt = (workspace: string): ToolExecutionContext => ({ toolCallId: "t1", workspace, sessionId: null, iteration: 0 });
const ctx = (): ToolExecutionContext => ctxAt(root);
const tool = (list: ModelTool[], name: string): ModelTool => list.find((t) => t.name === name)!;

/* ══════════ 编码与二进制 ══════════ */

test("非 UTF-8 文件（Latin-1）：edit_file / write_file 拒改、字节一个不动，说明是编码问题并指向 bash；read_file 照读并注明", async () => {
  const latin1 = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a, 0x78, 0x3d, 0x31, 0x0a]); // "café\nx=1\n"，é 是 0xE9
  await writeFile(join(root, "l1.txt"), latin1);
  const fs = makeFsTools();

  const read = await tool(fs, "read_file").execute({ path: "l1.txt" }, ctx());
  expect(read.isError).toBe(false);
  expect(read.content).toContain("2\tx=1");
  expect(read.content).toContain("not valid UTF-8");

  const edit = await tool(fs, "edit_file").execute({ path: "l1.txt", old_string: "x=1", new_string: "x=2" }, ctx());
  expect([edit.isError, edit.content]).toEqual([true, expect.stringContaining("not valid UTF-8")]);
  expect(edit.content).toContain("bash");
  expect(await readFile(join(root, "l1.txt"))).toEqual(latin1);

  const write = await tool(fs, "write_file").execute({ path: "l1.txt", content: "café\nx=2\n" }, ctx());
  expect([write.isError, write.content]).toEqual([true, expect.stringContaining("not valid UTF-8")]);
  expect(await readFile(join(root, "l1.txt"))).toEqual(latin1);
});

test("UTF-8 文件带 BOM：edit_file 改完 BOM 还在", async () => {
  await writeFile(join(root, "bom.txt"), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("a=1\n")]));
  const fs = makeFsTools();
  await tool(fs, "read_file").execute({ path: "bom.txt" }, ctx());
  const r = await tool(fs, "edit_file").execute({ path: "bom.txt", old_string: "a=1", new_string: "a=2" }, ctx());
  expect(r.isError).toBe(false);
  expect(await readFile(join(root, "bom.txt"))).toEqual(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("a=2\n")]));
});

test("read_file 读二进制文件（含 NUL）：报 binary file，不把乱码塞进上下文", async () => {
  const bin = Buffer.alloc(4096);
  for (let i = 0; i < bin.length; i++) bin[i] = (i * 37) % 256;
  await writeFile(join(root, "data.bin"), bin);
  const r = await tool(makeFsTools(), "read_file").execute({ path: "data.bin" }, ctx());
  expect([r.isError, r.content]).toEqual([true, expect.stringContaining("binary file")]);
  expect(r.content.length).toBeLessThan(300);
  expect(r.content).not.toContain("\u0000");
  expect(r.content).not.toContain("�");
});

/* ══════════ 分页 ══════════ */

test("read_file 撞字符上限时按整行截：尾注写实际显示到第几行、给出下一次的 offset；照它续读一行不漏", async () => {
  // 每行约 46 字符 × 4000 行 ≈ 18 万字符：缺省 2000 行读不完，5 万字符的上限先到
  const total = 4000;
  const body = Array.from({ length: total }, (_, i) => `line ${String(i + 1).padStart(5, "0")} ${"x".repeat(34)}`).join("\n") + "\n";
  await writeFile(join(root, "big.txt"), body);
  const read = tool(makeFsTools(), "read_file");

  const seen: number[] = [];
  let offset = 1;
  for (let round = 0; round < 20 && offset <= total; round++) {
    const r = await read.execute({ path: "big.txt", offset }, ctx());
    expect(r.isError).toBe(false);
    const shown = r.content.split("\n").filter((l) => /^\d+\t/.test(l)).map((l) => Number(l.split("\t")[0]));
    expect(shown[0]).toBe(offset);
    const last = shown.at(-1)!;
    // 每一行都是整行：显示出来的行号连续，没有半截行
    for (const n of shown) seen.push(n);
    expect(r.content).not.toContain(`${last + 1}\t`);
    if (round === 0) {
      // 第一页是字符上限截的，不是 2000 行截的：这正是尾注最容易算错的那一种
      expect(last).toBeLessThan(2000);
      expect(r.content).toContain("output capped at 50000 characters");
      expect(r.content.length).toBeLessThan(50_200);
    }
    if (last < total) {
      expect(r.content).toContain(`showing lines ${offset}-${last} of ${total}`);
      expect(r.content).toContain(`offset=${last + 1}`);
      offset = last + 1;
    } else {
      offset = total + 1;
    }
  }
  expect(seen).toEqual(Array.from({ length: total }, (_, i) => i + 1));
});

test("read_file：limit 截的尾注同样给下一次的 offset；以换行结尾的文件不多算一行；offset 超出末尾是明确错误", async () => {
  await writeFile(join(root, "s.txt"), "a\nb\nc\n");
  const read = tool(makeFsTools(), "read_file");
  const part = await read.execute({ path: "s.txt", limit: 2 }, ctx());
  expect([part.isError, part.content]).toEqual([false, expect.stringContaining("showing lines 1-2 of 3")]);
  expect(part.content).toContain("offset=3");
  const whole = await read.execute({ path: "s.txt" }, ctx());
  expect([whole.isError, whole.content]).toEqual([false, "1\ta\n2\tb\n3\tc"]);
  const past = await read.execute({ path: "s.txt", offset: 50 }, ctx());
  expect([past.isError, past.content]).toEqual([true, expect.stringContaining("past the end")]);
  expect(past.content).toContain("3 lines");
});

test("read_file：一行就超过字符上限时截这一行并说明，下一次从下一行起", async () => {
  await writeFile(join(root, "wide.txt"), `${"y".repeat(60_000)}\nnext\n`);
  const r = await tool(makeFsTools(), "read_file").execute({ path: "wide.txt" }, ctx());
  expect(r.isError).toBe(false);
  expect(r.content.length).toBeLessThan(51_000);
  expect(r.content).toContain("line 1 is 60000 characters");
  expect(r.content).toContain("offset=2");
});

/* ══════════ edit_file 匹配失败的提示 ══════════ */

test("CRLF 文件：read_file 注明行尾；多行 old_string 用 \\n 不匹配时点明 CRLF；用 \\r\\n 之后能改，new_string 的换行按 CRLF 写回", async () => {
  await writeFile(join(root, "a.ts"), "function a() {\r\n  return 1;\r\n}\r\n");
  const fs = makeFsTools();
  const read = await tool(fs, "read_file").execute({ path: "a.ts" }, ctx());
  expect(read.content).toContain("CRLF");

  const miss = await tool(fs, "edit_file").execute({ path: "a.ts", old_string: "function a() {\n  return 1;", new_string: "function a() {\n  return 2;" }, ctx());
  expect([miss.isError, miss.content]).toEqual([true, expect.stringContaining("CRLF")]);
  // 点明的是换行，不是笼统的「空白不同」
  expect(miss.content).toContain("line breaks are written as \\r\\n");
  expect(miss.content).not.toContain("whitespace");
  expect(await readFile(join(root, "a.ts"), "utf8")).toBe("function a() {\r\n  return 1;\r\n}\r\n"); // 不做静默的模糊替换

  const ok = await tool(fs, "edit_file").execute({ path: "a.ts", old_string: "function a() {\r\n  return 1;", new_string: "function a() {\n  // two\n  return 2;" }, ctx());
  expect(ok.isError).toBe(false);
  expect(await readFile(join(root, "a.ts"), "utf8")).toBe("function a() {\r\n  // two\r\n  return 2;\r\n}\r\n");
});

test("edit_file 只差空白 / 缩进时点明，并把文件里那几行的真实空白原样给出来（tab、行尾空格看得见）", async () => {
  await writeFile(join(root, "b.py"), "def f():\n\treturn 1   \n");
  const fs = makeFsTools();
  await tool(fs, "read_file").execute({ path: "b.py" }, ctx());
  const miss = await tool(fs, "edit_file").execute({ path: "b.py", old_string: "def f():\n    return 1", new_string: "def f():\n    return 2" }, ctx());
  expect(miss.isError).toBe(true);
  expect(miss.content).toContain("whitespace");
  expect(miss.content).toContain("lines 1-2");
  expect(miss.content).toContain(JSON.stringify("\treturn 1   "));
  expect(await readFile(join(root, "b.py"), "utf8")).toBe("def f():\n\treturn 1   \n");
});

test("edit_file 真的不匹配时仍是原来那句（不乱给提示）", async () => {
  await writeFile(join(root, "c.txt"), "alpha\nbeta\n");
  const fs = makeFsTools();
  await tool(fs, "read_file").execute({ path: "c.txt" }, ctx());
  const miss = await tool(fs, "edit_file").execute({ path: "c.txt", old_string: "gamma", new_string: "delta" }, ctx());
  expect([miss.isError, miss.content.startsWith("No match")]).toEqual([true, true]);
  expect(miss.content).not.toContain("whitespace");
  expect(miss.content).not.toContain("CRLF");
});

/* ══════════ 工作区边界与软链 ══════════ */

test("工作区路径本身经软链：realpath 形式的绝对路径照常读写搜，结果路径按工作区报", async () => {
  await mkdir(join(root, "real"));
  await writeFile(join(root, "real/a.txt"), "hi\n");
  await symlink(join(root, "real"), join(root, "link"));
  const ws = join(root, "link");
  const realFile = join(await realpath(join(root, "real")), "a.txt"); // macOS 的 tmpdir 本身也经 /var → /private/var
  const fs = makeFsTools();
  const r = await tool(fs, "read_file").execute({ path: realFile }, ctxAt(ws));
  expect([r.isError, r.content]).toEqual([false, "1\thi"]);
  const e = await tool(fs, "edit_file").execute({ path: realFile, old_string: "hi", new_string: "ho" }, ctxAt(ws));
  expect(e.isError).toBe(false);
  const g = await tool(makeSearchTools(), "grep").execute({ pattern: "ho", path: realFile }, ctxAt(ws));
  expect([g.isError, g.content]).toEqual([false, "a.txt:1:ho"]);
});

test("经软链出工作区仍拒（monorepo 里 node_modules 指到兄弟包），报错说清是软链、指到哪、建议用 bash 读", async () => {
  const sibling = await mkdtemp(join(tmpdir(), "echo-fs-sibling-"));
  try {
    await writeFile(join(sibling, "index.ts"), "export {};\n");
    await mkdir(join(root, "node_modules/@scope"), { recursive: true });
    await symlink(sibling, join(root, "node_modules/@scope/pkg"));
    const r = await tool(makeFsTools(), "read_file").execute({ path: "node_modules/@scope/pkg/index.ts" }, ctx());
    expect([r.isError, r.content]).toEqual([true, expect.stringContaining("outside the workspace")]);
    expect(r.content).toContain("symlink");
    expect(r.content).toContain(await realpath(sibling));
    expect(r.content).toContain("bash");
    // 字面就在外面的路径不提软链
    const plain = await tool(makeFsTools(), "read_file").execute({ path: "../x.txt" }, ctx());
    expect([plain.isError, plain.content]).toEqual([true, "Path outside the workspace: '../x.txt'"]);
  } finally {
    await rm(sibling, { recursive: true, force: true });
  }
});
