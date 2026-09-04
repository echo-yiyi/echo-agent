// `@echo/core` 公共 API 清点（D15）。
//
// **一份结果，两个用途**：人读它来划 root/engine/subpath（§13.11 M2 的第二件事），
// 门读它来防公共面无声漂移。所以清点逻辑只有这一份——`inventory()`——
// 脚本打印它、测试比对它，不允许再造第二套数法。
//
// 为什么必须是脚本而不是「上次那条一次性命令」：M1 那次临时清点得出 **165 个符号**，这个数
// 被写进了设计文档、还成了施工依据；同口径落成脚本后数出的**根本不是这个数**。两个数没有一个
// 能自证对错，因为当时的口径没有落成代码、没法复跑。差异本身就是立这道门的理由。
// （当前值不写在这里——它在 `test/api-snapshot.txt` 里，那份由本脚本生成。散文档一复述就开始腐烂。）
//
// 用法：
//   bun packages/core/scripts/api-inventory.ts            打印到 stdout（人读）
//   bun packages/core/scripts/api-inventory.ts --write    写 test/api-snapshot.txt
//
// 判据粒度是**名字 + 种类 + 声明来源**，不含类型签名。M2 要回答的是「哪个符号该在哪条
// 入口」，签名漂移是另一件事（真要防，那是发布期的 API extractor，不是这道门）。

import { readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

const CORE_ROOT = join(import.meta.dir, "..");
export const SNAPSHOT_PATH = join(CORE_ROOT, "test/api-snapshot.txt");

/** 一个公共符号的三件事实。 */
export type ApiSymbol = {
  readonly name: string;
  /** `both` = 同名的值与类型（class、以及 `const X` + `type X` 的组合）。 */
  readonly kind: "value" | "type" | "both";
  /** 声明所在文件，相对包根。**re-export 会解析到原始声明**，不是停在 index.ts。 */
  readonly origin: string;
};

export type ApiEntry = {
  /** `package.json#exports` 里的键，如 `.` / `./mcp`。 */
  readonly subpath: string;
  /** 该键指向的文件，相对包根。 */
  readonly file: string;
  readonly symbols: readonly ApiSymbol[];
};

function compilerOptions(): ts.CompilerOptions {
  const raw = ts.readConfigFile(join(CORE_ROOT, "tsconfig.json"), ts.sys.readFile);
  return ts.parseJsonConfigFileContent(raw.config, ts.sys, CORE_ROOT).options;
}

/**
 * `package.json#exports` 里真正是入口的那些键。
 * `./package.json` 是给工具读 manifest 的，不是 API 面，排除。
 */
type ExportTarget = string | Record<string, string>;

/**
 * 一条 exports 的**源码入口**。
 *
 * 条件导出（`{ bun, types, import, default }`）下取 `bun` 那支——它指向 `src/*.ts`，
 * 也就是清点与纯度门要看的东西。`import`/`default` 指向 `dist/`，那是构建产物：
 * 拿它清点会在没 build 时判红、build 之后又清点出一份重复的公共面。
 *
 * **不认识的形状一律判红**，不猜——公共面的真相源出错比没有更糟。
 */
function sourceEntryOf(subpath: string, target: ExportTarget): string {
  if (typeof target === "string") return target;
  const bun = target["bun"];
  if (typeof bun === "string") return bun;
  throw new Error(
    `exports["${subpath}"] 是条件导出但没有 "bun" 那支——清点要的是源码入口，判红不猜`,
  );
}

export function entryPoints(): { subpath: string; abs: string }[] {
  const manifest = JSON.parse(readFileSync(join(CORE_ROOT, "package.json"), "utf8")) as {
    exports?: Record<string, ExportTarget>;
  };
  const exports = manifest.exports ?? {};
  const out: { subpath: string; abs: string }[] = [];
  for (const [subpath, target] of Object.entries(exports)) {
    if (subpath === "./package.json") continue;
    out.push({ subpath, abs: join(CORE_ROOT, sourceEntryOf(subpath, target)) });
  }
  // 键序跟 manifest 走会让 snapshot 随手改 package.json 而变，排序钉死。
  out.sort((a, b) => a.subpath.localeCompare(b.subpath));
  return out;
}

/** alias 一路解到原始符号。`export { X } from` 会产生 alias，多层 re-export 会产生多层。 */
function resolveAlias(checker: ts.TypeChecker, sym: ts.Symbol): ts.Symbol {
  let cur = sym;
  for (let hop = 0; hop < 16; hop++) {
    if ((cur.flags & ts.SymbolFlags.Alias) === 0) return cur;
    cur = checker.getAliasedSymbol(cur);
  }
  throw new Error(`符号 ${sym.name} 的 alias 链超过 16 层——多半成环，判红不猜`);
}

function kindOf(sym: ts.Symbol): ApiSymbol["kind"] {
  const isValue = (sym.flags & ts.SymbolFlags.Value) !== 0;
  const isType = (sym.flags & ts.SymbolFlags.Type) !== 0;
  if (isValue && isType) return "both";
  if (isValue) return "value";
  if (isType) return "type";
  // 既不是值也不是类型 = 我们不认识它。静默归类会让公共面出现一条没人看得懂的记录。
  throw new Error(`符号 ${sym.name} 既非值也非类型（flags=${sym.flags}）——判据不覆盖，判红不猜`);
}

/** 本地 `export { A }`（无 `from`）引用的绑定，是不是根本没有运行时值。 */
function localBindingIsTypeOnly(checker: ts.TypeChecker, spec: ts.ExportSpecifier): boolean {
  const sym = checker.getSymbolAtLocation(spec.propertyName ?? spec.name);
  for (const d of sym?.declarations ?? []) {
    // 绑定来自 type-only import：`import type { A } from "m"; export { A };`
    if (ts.isImportSpecifier(d) && (d.isTypeOnly || d.parent.parent.isTypeOnly)) return true;
    if (ts.isImportClause(d) && d.isTypeOnly) return true;
    if (ts.isNamespaceImport(d) && d.parent.isTypeOnly) return true;
    // 绑定本身就是纯类型声明
    if (ts.isTypeAliasDeclaration(d) || ts.isInterfaceDeclaration(d)) return true;
  }
  return false;
}

/** 一条 `export` 声明上带 `export` 修饰符吗（`export const` / `export class` …）。 */
function hasExportModifier(stmt: ts.Statement): boolean {
  return (
    ts.canHaveModifiers(stmt) &&
    (ts.getModifiers(stmt) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
  );
}

/**
 * 带 `default` 修饰符吗（`export default class X {}` / `export default function f() {}`）。
 *
 * **这类声明对外的公共名是 `default`，不是那个本地绑定名。** `X` / `f` 只是文件内部的名字，
 * `import { X }` 拿不到任何东西。上一版把本地名加进了运行时集合，于是真正的 `default`
 * 反而不在集合里，被判成纯类型。匿名形式（`export default class {}`）同属这一支。
 */
function hasDefaultModifier(stmt: ts.Statement): boolean {
  return (
    ts.canHaveModifiers(stmt) &&
    (ts.getModifiers(stmt) ?? []).some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)
  );
}

/** 变量声明可能是解构，名字不止一个。 */
function bindingNames(name: ts.BindingName, out: string[]): void {
  if (ts.isIdentifier(name)) {
    out.push(name.text);
    return;
  }
  for (const el of name.elements) if (ts.isBindingElement(el)) bindingNames(el.name, out);
}

/**
 * 这个模块**在运行时真正导出**的名字集合。
 *
 * 这是 kind 判定的唯一依据：名字在里面 → 有运行时值，用原始符号的 flags 定 value/both；
 * 不在里面 → 它只是类型。
 *
 * ## 为什么不能用「type-only star 带来的名字集合」那种写法
 *
 * 上一版记的是「哪些名字是 `export type *` 带进来的」，那是个**名字集合**，
 * 表达不了 provenance，两种合法写法会翻车（都实测过、tsc 都通过）：
 *
 * ```ts
 * // ① barrel 中转：只扫入口自己的 `export type *`，看不见 relay 那一跳
 * // relay.ts
 * export type * from "./origin.ts";
 * // entry.ts
 * export * from "./relay.ts";        // ← 上一版把 origin 的 class 记成 both
 *
 * // ② 显式 value 覆盖 type-only star
 * export type * from "./m.ts";       // 带来名字 x
 * export { x } from "./m.ts";        // ← 显式导出优先，x 是运行时值；上一版记成 type
 * ```
 *
 * 递归修不了 ②——**显式导出优先于 star 导出**是覆盖关系，不是集合的加减。
 * 所以判据换成「按语法算运行时可达性」：`export type …` 整条不进集合，`export *` 并入
 * 目标模块的集合（因此 ① 里 relay 的空集自然传下来），显式 `export { x }` 直接进集合（因此 ②
 * 里 x 在集合内）。两种情形由同一条规则覆盖，不需要各打一个补丁。
 *
 * ## 为什么是固定点迭代，不是带 memo 的递归
 *
 * 上一版遇到循环 re-export 时「这一跳先返回空集」——那不是固定点，是**一次性的猜测**，
 * 而且猜完就被外层 memo 固化了。实测（tsc 通过，Bun 实际导出 `["x","y"]`）：
 *
 * ```ts
 * // a.ts
 * export * from "./b.ts";
 * export const x = 1;
 * // b.ts
 * export { x as y } from "./a.ts";   // ← 反向重命名
 * ```
 *
 * 算 a 时进入 b，b 回头问 a——a 还在计算中，拿到空集，于是 `y` 没被算出来；
 * 递归返回后**没有任何机制回来补它**，`y` 就永久判成 type。
 *
 * 现在改成：先收集可达模块，再对所有模块反复求值到不动点。集合**只增不减**（单调）
 * 且名字有限，所以必然收敛；不收敛就抛错，不给「差不多了」留口子。
 */
function runtimeExportNames(program: ts.Program, checker: ts.TypeChecker, entry: ts.SourceFile): Set<string> {
  const targetOf = (sf: ts.SourceFile, spec: ts.Expression | undefined, ctx: string): ts.SourceFile => {
    if (spec === undefined || !ts.isStringLiteralLike(spec)) {
      throw new Error(`${sf.fileName} 的 ${ctx} 说明符不是字面量——判据不覆盖，判红不猜`);
    }
    const resolved = ts.resolveModuleName(spec.text, sf.fileName, program.getCompilerOptions(), ts.sys)
      .resolvedModule?.resolvedFileName;
    const target = resolved === undefined ? undefined : program.getSourceFile(resolved);
    if (target === undefined) {
      throw new Error(`${sf.fileName} 的 ${ctx} "${spec.text}" 解析不到——门自己瞎了，判红不猜`);
    }
    return target;
  };

  // ── 第一步：收集从 entry 沿 re-export 边可达的全部模块 ──
  // 必须完整：求值时任何一个没收集到的目标都会被当成空集，静默算少。
  const modules = new Map<string, ts.SourceFile>();
  const collect = (sf: ts.SourceFile): void => {
    if (modules.has(sf.fileName)) return;
    modules.set(sf.fileName, sf);
    for (const stmt of sf.statements) {
      if (!ts.isExportDeclaration(stmt) || stmt.moduleSpecifier === undefined) continue;
      collect(targetOf(sf, stmt.moduleSpecifier, "`export … from`"));
    }
  };
  collect(entry);

  // ── 第二步：对所有模块反复求值到不动点 ──
  const solution = new Map<string, Set<string>>();
  for (const f of modules.keys()) solution.set(f, new Set());

  /** 用当前解算一遍某个模块的运行时导出面。 */
  const step = (sf: ts.SourceFile): Set<string> => {
    const namesOf = (t: ts.SourceFile): Set<string> => solution.get(t.fileName) ?? new Set();
    const out = new Set<string>();
    for (const stmt of sf.statements) {
      if (ts.isExportDeclaration(stmt)) {
        // `export type { … }` / `export type * from …`：整条声明不进运行时
        if (stmt.isTypeOnly) continue;
        const clause = stmt.exportClause;
        if (clause === undefined) {
          // `export * from "m"`——**注意 star 不带 default**
          for (const n of namesOf(targetOf(sf, stmt.moduleSpecifier, "`export *`"))) {
            if (n !== "default") out.add(n);
          }
          continue;
        }
        if (ts.isNamespaceExport(clause)) {
          out.add(clause.name.text); // `export * as ns from "m"`
          continue;
        }
        for (const spec of clause.elements) {
          if (spec.isTypeOnly) continue; // `export { type A }`
          if (stmt.moduleSpecifier !== undefined) {
            // 源模块运行时得真有这个名字，才谈得上转出去
            const src = (spec.propertyName ?? spec.name).text;
            if (namesOf(targetOf(sf, stmt.moduleSpecifier, "`export … from`")).has(src)) {
              out.add(spec.name.text);
            }
          } else if (!localBindingIsTypeOnly(checker, spec)) {
            out.add(spec.name.text);
          }
        }
        continue;
      }
      if (ts.isExportAssignment(stmt)) {
        out.add("default"); // `export default …` / `export = …`
        continue;
      }
      if (!hasExportModifier(stmt)) continue;
      // 纯类型声明不进运行时（`export default interface X {}` 也走这条，它没有运行时值）
      if (ts.isTypeAliasDeclaration(stmt) || ts.isInterfaceDeclaration(stmt)) continue;
      // `export default class X {}` / `export default function f() {}`：
      // **对外的名字是 `default`**，`X` / `f` 只是文件内部绑定，外面 import 不到
      if (hasDefaultModifier(stmt)) {
        out.add("default");
        continue;
      }
      if (ts.isVariableStatement(stmt)) {
        const acc: string[] = [];
        for (const d of stmt.declarationList.declarations) bindingNames(d.name, acc);
        for (const n of acc) out.add(n);
        continue;
      }
      if (
        ts.isFunctionDeclaration(stmt) ||
        ts.isClassDeclaration(stmt) ||
        ts.isEnumDeclaration(stmt) ||
        ts.isModuleDeclaration(stmt)
      ) {
        const name = stmt.name;
        if (name !== undefined && ts.isIdentifier(name)) out.add(name.text);
        continue;
      }
      // 带 export 修饰符、却不是上面任何一种——判据不认识它，不猜
      throw new Error(
        `${sf.fileName} 有一条带 export 修饰符的 ${ts.SyntaxKind[stmt.kind]}——判据不覆盖，判红不猜`,
      );
    }

    return out;
  };

  // 每轮至少把一个名字沿 re-export 链多传一跳，所以链最长时也只需 modules.size 轮；
  // 多给两轮余量。超了说明判据里有不单调的地方——**抛错，不接受「差不多收敛了」**。
  const maxRounds = modules.size + 2;
  for (let round = 0; ; round++) {
    if (round > maxRounds) {
      throw new Error(`运行时导出面的固定点迭代 ${maxRounds} 轮未收敛（入口 ${entry.fileName}）——判红不猜`);
    }
    let changed = false;
    for (const [file, sf] of modules) {
      const cur = solution.get(file)!;
      for (const n of step(sf)) {
        if (!cur.has(n)) {
          cur.add(n);
          changed = true;
        }
      }
    }
    if (!changed) break;
  }

  return solution.get(entry.fileName) ?? new Set();
}

/**
 * 清点入口。**唯一的数法**——脚本与测试都调它。
 *
 * `entries` 默认取 `package.json#exports`；传入是给门做 fixture 自检用的
 * （拿构造好的入口验判定分支，不然这道门只能证明「结果没变」、证明不了「数得对」）。
 */
export function inventory(entries: readonly { subpath: string; abs: string }[] = entryPoints()): ApiEntry[] {
  const program = ts.createProgram(
    entries.map((e) => e.abs),
    { ...compilerOptions(), noEmit: true },
  );
  const checker = program.getTypeChecker();

  return entries.map(({ subpath, abs }) => {
    const sf = program.getSourceFile(abs);
    if (!sf) throw new Error(`exports["${subpath}"] 指向的 ${abs} 不在编译图里——路径写错或文件不存在`);
    const moduleSymbol = checker.getSymbolAtLocation(sf);
    if (!moduleSymbol) throw new Error(`${abs} 取不到模块符号——它可能根本没有 export`);

    // **kind 看这条入口的运行时可达性，origin 看原始声明**——两件事分开。
    // 混用会把 `export type { SomeClass }` 记成 both（原始符号是 class，出口却没有值）。
    const runtime = runtimeExportNames(program, checker, sf);

    const symbols: ApiSymbol[] = checker.getExportsOfModule(moduleSymbol).map((raw) => {
      const sym = resolveAlias(checker, raw);
      const decl = sym.declarations?.[0];
      if (!decl) throw new Error(`符号 ${raw.name} 找不到声明——门自己瞎了，判红不猜`);
      return {
        name: raw.name,
        kind: runtime.has(raw.name) ? kindOf(sym) : ("type" as const),
        origin: relative(CORE_ROOT, decl.getSourceFile().fileName),
      };
    });

    symbols.sort((a, b) => a.origin.localeCompare(b.origin) || a.name.localeCompare(b.name));
    return { subpath, file: relative(CORE_ROOT, abs), symbols };
  });
}

/** 渲染成 snapshot 文本。**人读格式就是机器判据**，不做两种渲染。 */
export function render(entries: readonly ApiEntry[]): string {
  const lines: string[] = [
    "# @echo/core 公共 API 清点 · 由脚本生成，勿手改",
    "#",
    "# 生成：bun packages/core/scripts/api-inventory.ts --write",
    "# 门　：packages/core/test/api-snapshot.test.ts（全文比对，不等即红）",
    "#",
    "# 每行 `<种类> <符号名>`。种类：value 运行时值 / type 仅类型 / both 同名的值与类型。",
    "# 按 exports 入口分组，入口内按**声明来源模块**分组——划 root/engine/subpath 读的就是这一层。",
    "",
  ];

  for (const entry of entries) {
    const n = entry.symbols.length;
    const count = (k: ApiSymbol["kind"]) => entry.symbols.filter((s) => s.kind === k).length;
    lines.push(`== 入口 "${entry.subpath}" → ${entry.file} ==`);
    lines.push(`符号 ${n}（value ${count("value")} · type ${count("type")} · both ${count("both")}）`);
    lines.push("");

    let currentOrigin: string | null = null;
    for (const sym of entry.symbols) {
      if (sym.origin !== currentOrigin) {
        if (currentOrigin !== null) lines.push("");
        currentOrigin = sym.origin;
        const inOrigin = entry.symbols.filter((s) => s.origin === sym.origin).length;
        lines.push(`-- ${sym.origin} (${inOrigin}) --`);
      }
      lines.push(`${sym.kind.padEnd(6)} ${sym.name}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

if (import.meta.main) {
  const text = render(inventory());
  if (process.argv.includes("--write")) {
    writeFileSync(SNAPSHOT_PATH, text);
    console.log(`已写入 ${relative(process.cwd(), SNAPSHOT_PATH)}`);
  } else {
    process.stdout.write(text);
  }
}
