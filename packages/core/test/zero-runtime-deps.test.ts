import { test, expect } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// 「core 零运行时依赖」——M1（2026-08-11 开源计划）把它从目标变成断言。
//
// 脱钩前 `@modelcontextprotocol/sdk` 是 core 唯一的运行时依赖，而且是**根入口硬拖的**：
// `import { Agent } from "@echo-agent/core"` 会一路静态 import 到 `mcp/harness.ts` → SDK。
// 实测（隔离消费 fixture）证明「只想跑一个 agent」的人被迫装整套 MCP 协议栈。
// 现在 SDK-backed 实现归适配器一侧（不在本仓），core 只留 `mcp/port.ts` 的类型。
//
// 两条一起查，缺一条门就是假绿：
//   ① manifest 三字段——`optionalDependencies` 仍在运行时依赖图里，
//     `peerDependencies` 把依赖推给宿主，只查 `dependencies` 留了两个绕行口；
//   ② 源码闭包——manifest 干净但源码里 import 了，装的时候不报错、跑的时候才炸。
//     `src/**` 里的 import / `import()` / `require()` 只许 `node:` / `bun` / `bun:` 前缀和相对路径
//     （2026-09-08 用户拍板扩到全部裸 specifier；此前只拦 `@modelcontextprotocol` 一个包名，
//     子路径 import 了根 node_modules 里恰好有的别的包时 typecheck 与本门都绿、装出去才炸）。
//     `@echo-agent/core` 自己的子路径也放行——它不是运行时依赖，只在注释示例里出现。

const RUNTIME_DEP_FIELDS = ["dependencies", "optionalDependencies", "peerDependencies"] as const;
const PKG_ROOT = join(import.meta.dir, "..");

test("@echo-agent/core 的运行时依赖三字段恒空", () => {
  const pkg = JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8")) as {
    name?: string;
  } & Partial<Record<(typeof RUNTIME_DEP_FIELDS)[number], Record<string, string>>>;
  // 先确认查的是 core 那份——路径写错时不许静默地去查了别人还报绿。
  expect(pkg.name).toBe("@echo-agent/core");
  for (const field of RUNTIME_DEP_FIELDS) {
    expect([field, Object.keys(pkg[field] ?? {})]).toEqual([field, []]);
  }
});

// 查的是 **import 语句**，不是「文件里出现过这个字符串」——
// 注释里写清「为什么把 SDK 挪出去」是应该的，不该被门判红（首次跑就撞到了这一条）。
// 静态 import / export-from、动态 `import(...)`、`require(...)` 三种写法都盖住：
// 曾经 `harness.ts` 就用动态 import 藏着一条 StreamableHTTP 传输。
const IMPORT_SPECIFIER = /(?:\bfrom[ \t]*|\bimport[ \t]*\(?[ \t]*|\brequire[ \t]*\([ \t]*)["'`]([^"'`\n]+)["'`]/g;
/** 放行的 specifier：Node / Bun 内建、相对路径、自己包的子路径。别的一律是运行时依赖。 */
const ALLOWED_SPECIFIER = /^(?:node:|bun(?::|$)|\.{1,2}\/|@echo-agent\/core(?:\/|$))/;
/** 注释先剥掉：JSDoc 里「见 `from` … `x`」这种散文会被上面的正则当成 import（实测 compaction/types.ts 撞到）。 */
const COMMENTS = /\/\*[\s\S]*?\*\/|(?:^|\s)\/\/.*$/gm;

/** 一段源码里违规的 specifier（去重，按出现顺序）。 */
function bareImports(source: string): string[] {
  const out: string[] = [];
  for (const m of source.replace(COMMENTS, " ").matchAll(IMPORT_SPECIFIER)) {
    const spec = m[1]!;
    if (!ALLOWED_SPECIFIER.test(spec) && !out.includes(spec)) out.push(spec);
  }
  return out;
}

test("core 源码里的 import 只许 node: / bun / 相对路径（MCP SDK 在内的任何包都不许，端口留下、实现出去）", () => {
  const offenders: string[] = [];
  for (const file of walk(join(PKG_ROOT, "src"))) {
    const bad = bareImports(readFileSync(file, "utf8"));
    if (bad.length > 0) offenders.push(`${file.slice(PKG_ROOT.length + 1)}: ${bad.join(", ")}`);
  }
  expect(offenders).toEqual([]);
});

// 上面那条门只要 `src/` 干净就恒绿——**恒绿的门等于没有门**。
// 这条用已知正反例证明它的判据真能分辨，改正则时先在这里加一行。
test("上一条门的判据真能分辨（5 正例抓到 / 7 反例放行）", () => {
  const caught = (src: string): boolean => bareImports(src).length > 0;
  expect(caught('import { Client } from "@modelcontextprotocol/sdk/client/index.js";')).toBe(true);
  expect(caught('const { T } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");')).toBe(true);
  expect(caught('const x = require("@modelcontextprotocol/sdk");')).toBe(true);
  expect(caught('import ts from "typescript";')).toBe(true); // 根 node_modules 里恰好有的包，装出去才炸
  expect(caught('export { z } from "zod";')).toBe(true); // export-from 也是一条依赖
  // 内建、相对路径、自己包的子路径都放行
  expect(caught('import { join } from "node:path";')).toBe(false);
  expect(caught('import { Database } from "bun:sqlite"; import { file } from "bun";')).toBe(false);
  expect(caught('import { x } from "./x.ts"; export * from "../y.ts";')).toBe(false);
  expect(caught('import { MCP_KIND } from "@echo-agent/core/mcp";')).toBe(false);
  // 注释里写清「为什么把 SDK 挪出去」不该判红；JSDoc 散文里的 `from` 后面跟着反引号也不是 import
  expect(caught("// 会把 `@modelcontextprotocol/sdk` 拖进 core 的根依赖图")).toBe(false);
  expect(caught("/** 切点从 `from`\n *   升序、互不重叠；见 `lodash` */\nimport { a } from './a.ts';")).toBe(false);
  expect(caught("const x = 1; // import 'lodash' 只是句注释")).toBe(false);
});

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}
