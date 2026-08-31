import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { join, relative } from "node:path";
import ts from "typescript";
import { entryPoints } from "../scripts/api-inventory.ts";

// `@echo-yiyi/core/engine` 必须是 **Web-standard**（AGENT-CORE §13 的 D9/C12/D16）。
// 这条承诺只有立门才算数——「根入口是否纯 JS」曾经也只是注释里的一句话，
// 而 MCP 就那样把 `@modelcontextprotocol/sdk` 拖进了根依赖图（M1 实测，PR #2 才摘掉）。
//
// **判据不手写正则，走 TypeScript AST + `ts.resolveModuleName`。** 这不是洁癖，是三次被捅穿换来的：
//   ① 手写「剥注释」的正则不理解字符串边界。`const a = "/*"; import("node:fs"); const b = "*/";`
//      是合法代码，正则却把中间那行真 import 当块注释删掉——**假绿**，比漏报更坏。
//      AST 里注释根本不是节点，这个问题不存在。
//   ② 只认 `node:fs` 不认裸 `fs`：`import "fs"` 曾整条绕过。
//   ③ 自己拼 `.ts`/`index.ts` 不等于 TS 的解析：`./errors.js` 在 `moduleResolution: bundler`
//      下解析到 `errors.ts`，手写版报 unresolved——**假红**。用编译器自己的解析器就不会两头错。
//
// 守三件事（每件都被真实绕过过）：
//   A. 闭包内不许有 Node 内建（`node:fs` / 裸 `fs` / 子路径 `fs/promises` 一视同仁）
//   B. 闭包内不许有**未登记的裸运行时依赖**。§13.9 判据 2 写着这条，但上一版把它推给了
//      `zero-runtime-deps`——而那道门只查 manifest 三字段与 MCP SDK，不查任意 bare import。
//      实测 `import "typescript"` 曾让两道门合计 8/8 全绿：开发期能跑（它是 devDep），
//      用户装包时拿不到依赖，运行时才炸。
//   C. 每个说明符都解析得到。解析不到 = 门自己瞎了，必须红，不许静默跳过。
//   D. 闭包内不许有 triple-slash 的 `reference lib` / `reference types` / `reference path`。
//      它们能把 lib 从**源码这一侧**加回来，直接废掉 E 的前提（见下）。
//   E. 换 `lib` 重新类型检查：DOM 与 WebWorker **各建一个独立 Program**，宿主全局
//      （`process` / `Buffer` / `window` / `importScripts`…）由编译器判，不自己写「扫全局名」的正则。

const CORE_ROOT = join(import.meta.dir, "..");

/**
 * `@echo-agent/core/engine` 的入口——**从 `package.json#exports` 解析，不硬编码**。
 *
 * 两次搬家换来这条：先是指 `src/agent.ts`（代理测量：只盖住 `Agent` 可达的部分，
 * `prompt/` · `provider/openai.ts` 这些够不到就抓不到）；改指 `src/engine.ts` 后又留下更坏的洞——
 * **注释说这是 manifest 里那条，代码却硬编码了路径**。实测把 `exports["./engine"]` 改指
 * node-only 的 `./src/index.ts`，这道门 9/9 全绿：发布出去的 `/engine` 已经是脏的，门还在扫旧文件。
 *
 * 入口解析与 `api-inventory.ts` 共用同一个 `entryPoints()`——**两份真相源迟早会分叉**，
 * 分叉的那一刻其中一份就在假绿。
 */
const ENGINE_ENTRY = ((): string => {
  const found = entryPoints().find((e) => e.subpath === "./engine");
  if (found === undefined) {
    throw new Error('package.json#exports 里没有 "./engine"——这道门失去了守卫对象，判红不猜');
  }
  return found.abs;
})();

/** Node 内建模块名（不含 `node:` 前缀）。 */
const BUILTINS = new Set(builtinModules);

/**
 * 允许出现在 engine 闭包里的**运行时**裸依赖白名单。
 * 现在是空的——`@echo/core` 的 `dependencies` 恒空（zero-runtime-deps 那道门守着），
 * engine 层更不该有。将来真要加，先改 manifest 再改这里，两处都留痕。
 */
const ALLOWED_RUNTIME_BARE: readonly string[] = [];

function isNodeBuiltin(spec: string): boolean {
  return spec.startsWith("node:") || BUILTINS.has(spec.split("/")[0] ?? "");
}

function compilerOptions(): ts.CompilerOptions {
  const configPath = join(CORE_ROOT, "tsconfig.json");
  const raw = ts.readConfigFile(configPath, ts.sys.readFile);
  return ts.parseJsonConfigFileContent(raw.config, ts.sys, CORE_ROOT).options;
}

/** 非字面量的动态说明符——门无法判断它引了什么，一律判红。 */
export const DYNAMIC_UNKNOWN = "<非字面量动态说明符>";

type Spec = { text: string; typeOnly: boolean };

/**
 * 用 AST 取模块说明符：静态 import / export…from / 动态 `import()` / `require()`。
 * `typeOnly` 为真的不产生运行时依赖（`import type`，或 named 全带 `type` 修饰）。
 */
export function specsOfSource(source: string, fileName = "probe.ts"): Spec[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.ESNext, true);
  const out: Spec[] = [];
  const push = (node: ts.Expression | undefined, typeOnly: boolean): void => {
    if (node !== undefined && ts.isStringLiteralLike(node)) out.push({ text: node.text, typeOnly });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      // **只认声明级 `import type` / `export type`**。本包开着 `verbatimModuleSyntax`：
      // 那条选项的含义就是模块语法逐字保留——`import { type A } from "x"` 的 import 语句
      // **不会被擦除**，运行时照样加载 x，模块边仍然存在，必须继续查 x。
      // 只有整条声明带 `type`（`import type { A } from "x"`）才真的没有运行时边。
      // 上一版把 specifier 级的 `type` 也当成「整条依赖消失」，那是漏报。
      push(node.moduleSpecifier, node.importClause?.isTypeOnly === true);
    } else if (ts.isExportDeclaration(node)) {
      push(node.moduleSpecifier, node.isTypeOnly);
    } else if (ts.isCallExpression(node)) {
      const isDynamic = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require";
      if (isDynamic || isRequire) {
        const arg = node.arguments[0];
        // **说明符不是字面量 = 门看不见它引了什么**。静默放行等于给自己开后门
        // （`const m = "node:fs"; import(m);` 曾整条溜过去）。记成 unknown，由 scan 判红。
        if (arg !== undefined && ts.isStringLiteralLike(arg)) push(arg, false);
        else out.push({ text: DYNAMIC_UNKNOWN, typeOnly: false });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/**
 * triple-slash 指令。**它们不是 import，却能改变类型环境**——所以模块说明符那套判据完全看不见。
 *
 * 实测的绕过：往 engine 入口顶部加两行
 *
 * ```ts
 * /// <reference lib="dom" />
 * void window.document;
 * ```
 *
 * 九条测试**全绿**——包括那条「WebWorker 宿主下类型检查通过」。源码自己的指令把 DOM lib
 * 加回了 Worker 的 Program，于是「两套宿主分别检查」这个前提被从内部拆掉了：
 * 门还在报告 Worker 宿主安全，而代码里就摆着 `window`。
 *
 * 三种一并拒绝——`lib` 加标准库、`types` 加 `@types/*` 包、`path` 直接拉一个文件进来，
 * 都是同一件事的不同写法。engine 这一层的类型环境**只许由 tsconfig 决定**，不许源码自己改。
 *
 * （注意：指令只在文件**第一个语句之前**才生效。第一次复现时我把它 append 到文件末尾，
 * 门正确判红，差点据此认为绕过不成立——放到顶部才是真的。）
 */
export function referenceDirectivesOfSource(source: string, fileName = "probe.ts"): string[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.ESNext, true);
  return [
    ...sf.libReferenceDirectives.map((d) => `/// <reference lib="${d.fileName}" />`),
    ...sf.typeReferenceDirectives.map((d) => `/// <reference types="${d.fileName}" />`),
    ...sf.referencedFiles.map((d) => `/// <reference path="${d.fileName}" />`),
  ];
}

type Scan = {
  files: Set<string>;
  /** 文件 → 违规项（Node 内建 / 未登记裸依赖 / triple-slash 指令） */
  offenders: Map<string, string[]>;
  /** 解析失败的说明符——门瞎了，必须红 */
  unresolved: string[];
};

function scan(entry: string): Scan {
  const opts = compilerOptions();
  const host = ts.sys;
  const out: Scan = { files: new Set(), offenders: new Map(), unresolved: [] };
  const rel = (f: string): string => relative(CORE_ROOT, f);
  const flag = (file: string, spec: string): void => {
    const list = out.offenders.get(rel(file)) ?? [];
    list.push(spec);
    out.offenders.set(rel(file), list);
  };

  const walk = (file: string): void => {
    if (out.files.has(file)) return;
    out.files.add(file);
    const source = readFileSync(file, "utf8");
    // 先查 triple-slash：它改的是类型环境，模块说明符那套判据看不见它
    for (const directive of referenceDirectivesOfSource(source, file)) flag(file, directive);
    for (const { text, typeOnly } of specsOfSource(source, file)) {
      if (text === DYNAMIC_UNKNOWN) {
        out.unresolved.push(`${rel(file)} → ${DYNAMIC_UNKNOWN}`);
        continue;
      }
      if (isNodeBuiltin(text)) {
        flag(file, text); // 类型引用也算：Web-standard 的一层不该依赖 node 的类型面
        continue;
      }
      const resolved = ts.resolveModuleName(text, file, opts, host).resolvedModule?.resolvedFileName;
      const isRelative = text.startsWith(".");
      if (!isRelative) {
        // 裸说明符：type-only 不进运行时，放行；值 import 必须在白名单里
        if (!typeOnly && !ALLOWED_RUNTIME_BARE.includes(text)) flag(file, text);
        continue;
      }
      if (resolved === undefined) out.unresolved.push(`${rel(file)} → ${text}`);
      else walk(resolved);
    }
  };
  walk(entry);
  return out;
}

test("engine 闭包里没有 Node 内建，也没有未登记的裸运行时依赖", () => {
  const { offenders } = scan(ENGINE_ENTRY);
  expect([...offenders].map(([f, specs]) => `${f} → ${[...new Set(specs)].join(", ")}`)).toEqual([]);
});

test("闭包里每个相对说明符都解析得到（解析不到 = 门瞎了，不许静默跳过）", () => {
  const { unresolved, files } = scan(ENGINE_ENTRY);
  expect(unresolved).toEqual([]);
  // 顺带锁「递归真的在走」：只看入口一个文件的话，上面那条会恒绿。
  // 只写下限、不写实测值——具体数字随模块增减而变，写死进注释就是又一处会腐烂的手抄数。
  expect(files.size).toBeGreaterThan(40);
});

test("门守的是 manifest 里那条 `./engine`，不是硬编码的路径", () => {
  // 曾经的洞：注释说「这是 exports['./engine']」，代码却写死 `src/engine.ts`。
  // 把 manifest 改指 node-only 的 `./src/index.ts`，九条测试仍然 9/9 全绿——
  // 发布出去的 `/engine` 已经脏了，门还在扫旧文件。
  const manifest = JSON.parse(readFileSync(join(CORE_ROOT, "package.json"), "utf8")) as {
    exports: Record<string, string | Record<string, string>>;
  };
  const target = manifest.exports["./engine"];
  expect(target).toBeDefined();
  // 条件导出下取 `bun` 那支——它指向源码；`import`/`default` 指向 dist 产物，
  // 那是**构建出来的**，不是这道门要扫的东西（扫产物等于放过源码里的倒灌）。
  const declared = typeof target === "string" ? target : target!["bun"];
  expect(declared).toBeDefined();
  expect(ENGINE_ENTRY).toBe(join(CORE_ROOT, declared!));
  // 与 api-inventory 共用同一个入口解析——两份真相源分叉时，分叉那刻起就有一份在假绿
  expect(entryPoints().some((e) => e.subpath === "./engine" && e.abs === ENGINE_ENTRY)).toBe(true);
});

// 以上两条只要闭包干净就恒绿——**恒绿的门等于没有门**。
// 下面用已知正反例证明判据真能分辨；改上面任何一个函数，先在这里加一行。
test("判据自检 · 内建识别：前缀式 / 裸名 / 子路径都算，业务包与相对路径放行", () => {
  expect(isNodeBuiltin("node:fs")).toBe(true);
  expect(isNodeBuiltin("fs")).toBe(true);
  expect(isNodeBuiltin("fs/promises")).toBe(true);
  expect(isNodeBuiltin("@modelcontextprotocol/sdk/client/index.js")).toBe(false);
  expect(isNodeBuiltin("./storage/file-dir.ts")).toBe(false);
});

test("判据自检 · AST 取说明符：四种写法都抓得到，注释与字符串不误判", () => {
  const texts = (src: string): string[] => specsOfSource(src).map((s) => s.text);
  expect(texts('import { join } from "node:path";')).toEqual(["node:path"]);
  expect(texts('export { x } from "./x.ts";')).toEqual(["./x.ts"]);
  expect(texts('const m = await import("fs/promises");')).toEqual(["fs/promises"]);
  expect(texts('const os = require("os");')).toEqual(["os"]);
  // 注释不是 AST 节点——反例说明写在注释里天然放行，不需要「剥注释」这种脆判据
  expect(texts('// 反例说明：不要写 import "node:fs"。')).toEqual([]);
  expect(texts('/* 这一层禁止 require("fs") */')).toEqual([]);
  // **上一版的假绿**：字符串里的 /* 和 */ 曾让正则把中间的真 import 删掉
  expect(texts('const a = "/*";\nimport("node:fs");\nconst b = "*/";')).toEqual(["node:fs"]);
});

test("判据自检 · triple-slash 指令：三种写法都抓得到，且只在语句前才算", () => {
  const dirs = (src: string): string[] => referenceDirectivesOfSource(src);

  // 三种都能改类型环境，三种都拒绝
  expect(dirs('/// <reference lib="dom" />')).toEqual(['/// <reference lib="dom" />']);
  expect(dirs('/// <reference types="node" />')).toEqual(['/// <reference types="node" />']);
  expect(dirs('/// <reference path="./x.d.ts" />')).toEqual(['/// <reference path="./x.d.ts" />']);

  // **这是真实绕过的原样**：指令在顶部 + 用一个只有 DOM 才有的全局
  expect(dirs('/// <reference lib="dom" />\nvoid window.document;\n')).toEqual([
    '/// <reference lib="dom" />',
  ]);

  // 普通注释与字符串不误判
  expect(dirs('// 反例说明：不要写 /// <reference lib="dom" />')).toEqual([]);
  expect(dirs('const s = \'/// <reference lib="dom" />\';')).toEqual([]);

  // 指令**只在第一个语句之前**生效，之后的对 TS 无效——判据跟着 TS 的语义走，不自己加戏。
  // （第一次复现时正是把它 append 到了文件末尾，门判红，差点据此认为绕过不成立。）
  expect(dirs('const a = 1;\n/// <reference lib="dom" />')).toEqual([]);
});

test("判据自检 · type-only：只有**声明级** type 才真的没有运行时模块边", () => {
  const one = (src: string): Spec => specsOfSource(src)[0]!;

  // ── 真正无运行时模块边：整条声明被擦除 ──
  expect(one('import type { A } from "x";').typeOnly).toBe(true);
  expect(one('export type { A } from "x";').typeOnly).toBe(true);

  // ── 仍有运行时模块边，必须继续查 x ──
  // 本包开着 verbatimModuleSyntax：模块语法逐字保留，import 语句不会被擦除，
  // 运行时照样加载 x。specifier 级的 `type` 只擦掉那个绑定，擦不掉这条边。
  expect(one('import { type A } from "x";').typeOnly).toBe(false);
  expect(one('export { type A } from "x";').typeOnly).toBe(false);

  // ── 其余常规写法 ──
  expect(one('import { A } from "x";').typeOnly).toBe(false);
  expect(one('import ts, { type CompilerOptions } from "x";').typeOnly).toBe(false);
  expect(one('import "x";').typeOnly).toBe(false);
  expect(one('export { A } from "x";').typeOnly).toBe(false);
});

test("判据自检 · 非字面量的动态说明符记成 unknown（不许静默放行）", () => {
  const texts = (src: string): string[] => specsOfSource(src).map((s) => s.text);
  expect(texts('const m = "node:fs";\nimport(m);')).toEqual([DYNAMIC_UNKNOWN]);
  expect(texts("require(someVar);")).toEqual([DYNAMIC_UNKNOWN]);
  expect(texts('import("./ok.ts");')).toEqual(["./ok.ts"]); // 字面量照常解析
});

test("判据自检 · 解析走 TypeScript：`.js` 说明符在 bundler 模式下映射到 `.ts`", () => {
  const opts = compilerOptions();
  const from = join(CORE_ROOT, "src/index.ts");
  // 手写版曾把这种合法写法报成 unresolved（假红）
  const viaJs = ts.resolveModuleName("./agent.js", from, opts, ts.sys).resolvedModule?.resolvedFileName;
  expect(viaJs).toBeDefined();
  expect(viaJs!.endsWith("agent.ts")).toBe(true);
  // 无后缀同样解析得到（曾让遍历静默断掉）
  expect(ts.resolveModuleName("./agent", from, opts, ts.sys).resolvedModule?.resolvedFileName).toBeDefined();
  expect(ts.resolveModuleName("./__definitely_not_here", from, opts, ts.sys).resolvedModule).toBeUndefined();
});

/**
 * **A 面：宿主全局。** 模块边界那几条管不到它——`process.cwd()` 不 import 任何东西，
 * 浏览器/Worker 里却当场炸；而本包 tsconfig 注入了 `@types/bun`，tsc 也不会拦
 * （实测：插入 `process.cwd()` 后依赖门 6/6 全绿）。设计记录里写得很清楚：
 * core 当初正是**删掉 `process.cwd()`** 才敢说自己能在浏览器里跑。
 *
 * 判据不自己写「扫全局名」的正则（那会重蹈手写正则的覆辙），而是**换一套 lib 重新类型检查**：
 * `types: []` 去掉 Bun/Node 的全局注入，`lib` 只留标准环境。
 * 于是 `process` / `Buffer` / `__dirname` / `Bun` 会自然变成「找不到名称」，由编译器判红。
 *
 * **两套环境分别建 Program，不合并 lib**：DOM 与 WebWorker 的全局面不同
 * （`window`/`document` vs `self`/`importScripts`），混在一起会让「只有其中一边有的全局」
 * 蒙混过关——那正是 engine 承诺要覆盖的两种宿主。
 */
function hostGlobalOffenders(libs: readonly string[]): string[] {
  const { files } = scan(ENGINE_ENTRY);
  const program = ts.createProgram([ENGINE_ENTRY], {
    ...compilerOptions(),
    types: [], // 不注入 @types/bun、@types/node 的全局
    lib: [...libs],
    noEmit: true,
  });
  return ts
    .getPreEmitDiagnostics(program)
    .filter((d) => d.file !== undefined && files.has(d.file.fileName))
    .map((d) => {
      const { line } = d.file!.getLineAndCharacterOfPosition(d.start ?? 0);
      const msg = ts.flattenDiagnosticMessageText(d.messageText, " ");
      return `${relative(CORE_ROOT, d.file!.fileName)}:${line + 1} TS${d.code} ${msg}`;
    });
}

test("engine 闭包在 ESNext + DOM 下类型检查通过（浏览器宿主）", () => {
  expect(hostGlobalOffenders(["lib.esnext.d.ts", "lib.dom.d.ts"])).toEqual([]);
});

test("engine 闭包在 ESNext + WebWorker 下类型检查通过（Worker 宿主）", () => {
  expect(hostGlobalOffenders(["lib.esnext.d.ts", "lib.webworker.d.ts"])).toEqual([]);
});
