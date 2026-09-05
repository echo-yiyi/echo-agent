import { test, expect } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// 「core 零运行时依赖」——M1（2026-08-11 开源计划 §4）把它从目标变成断言。
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
// 静态 import、动态 `import(...)`、`require(...)` 三种写法都盖住：
// 曾经 `harness.ts` 就用动态 import 藏着一条 StreamableHTTP 传输。
const SDK_IMPORT = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["'`]@modelcontextprotocol/;

test("core 源码里没有任何 MCP SDK import（端口留下，实现出去）", () => {
  const offenders: string[] = [];
  for (const file of walk(join(PKG_ROOT, "src"))) {
    if (SDK_IMPORT.test(readFileSync(file, "utf8"))) offenders.push(file.slice(PKG_ROOT.length + 1));
  }
  expect(offenders).toEqual([]);
});

// 上面那条门只要 `src/` 干净就恒绿——**恒绿的门等于没有门**。
// 这条用已知正反例证明它的判据真能分辨，改正则时先在这里加一行。
test("上一条门的判据真能分辨（3 正例抓到 / 2 反例放行）", () => {
  const caught = (src: string): boolean => SDK_IMPORT.test(src);
  expect(caught('import { Client } from "@modelcontextprotocol/sdk/client/index.js";')).toBe(true);
  expect(caught('const { T } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");')).toBe(true);
  expect(caught('const x = require("@modelcontextprotocol/sdk");')).toBe(true);
  // 注释里写清「为什么把 SDK 挪出去」不该判红
  expect(caught("// 会把 `@modelcontextprotocol/sdk` 拖进 core 的根依赖图")).toBe(false);
  // core 自己的端口子路径不是 SDK
  expect(caught('import { MCP_KIND } from "@echo-agent/core/mcp";')).toBe(false);
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
