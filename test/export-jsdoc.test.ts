import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { inventory } from "../packages/core/scripts/api-inventory.ts";

// **`@echo-agent/core` 的公共符号必须解释过自己**——棘轮式:只拦新增,存量记在 baseline 里慢慢还。
//
// 为什么是棘轮:立门那天有 163 个存量缺口。一道注定长期红的门比没有门更糟——
// 它让"跑门"这个动作失去信号(人开始习惯性忽略红色),还连累同一次 `bun test` 里的其他门。
// 棘轮让「163 → 0」成为一条可以走的路,而不是一堵墙。
//
// **复用 `inventory()` 数公共面**,不另造第二套数法(`api-inventory.ts` 立的规矩)。
// 但按 `(origin, name)` 去重:`inventory()` 返回的是**按入口的出现**,同一个符号从
// `.` 与 `./engine` 各导出一次就会数两遍——上一版报的 273 就是这么虚高的(实际 163)。
//
// ## 这道门守不住什么(如实标注)
//
//   · **覆盖面只有 core**。`cli` 与 `coding-agent` 也有 `exports` 公共入口,不在这道门里——
//     `entryPoints()` 现在绑死 core 根目录,扩它要改被 `api-snapshot` 守着的那个文件。
//   · **只判有没有,不判写得好不好。** 一句废话也算数,那是人审的事。
//     空的 `/** */` 不算——那是它唯一能识别的"假装写过"。
//
// 重录 baseline(**只在确实补了文档、缺口变少时**):
//   bun test/export-jsdoc.test.ts --write-baseline

const CORE = join(import.meta.dir, "..", "packages", "core");
const BASELINE = join(import.meta.dir, "jsdoc-baseline.txt");

/** 该文件里名为 `name` 的顶层声明有没有挂**非空** JSDoc。 */
function documented(originFile: string, name: string): boolean | "not-found" {
  const abs = join(CORE, originFile);
  const src = ts.createSourceFile(abs, readFileSync(abs, "utf8"), ts.ScriptTarget.ESNext, true);
  let seen = false;
  let hasDoc = false;
  const nameOf = (n: ts.Node): string | undefined =>
    ts.isVariableStatement(n)
      ? n.declarationList.declarations.map(d => d.name.getText(src)).find(x => x === name)
      : (n as { name?: ts.Node }).name?.getText(src);

  for (const node of src.statements) {
    if (nameOf(node) !== name) continue;
    seen = true;
    for (const doc of ts.getJSDocCommentsAndTags(node)) {
      // 空的 `/** */` 不算写过——它只是让 presence 检查通过的仪式。
      const body = doc.getFullText().replace(/^\s*\/\*\*|\*\/\s*$|^\s*\*/gm, "").trim();
      if (body.length > 0) hasDoc = true;
    }
  }
  return seen ? hasDoc : "not-found";
}

/** 当前缺口,按 `origin#name` 去重后排序。 */
function currentGaps(): { missing: string[]; unresolved: string[]; total: number } {
  const seen = new Set<string>();
  const missing: string[] = [];
  const unresolved: string[] = [];
  for (const entry of inventory()) {
    for (const sym of entry.symbols) {
      const key = `${sym.origin}#${sym.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const r = documented(sym.origin, sym.name);
      if (r === "not-found") unresolved.push(key);
      else if (!r) missing.push(key);
    }
  }
  return { missing: missing.sort(), unresolved: unresolved.sort(), total: seen.size };
}

function readBaseline(): string[] {
  if (!existsSync(BASELINE)) return [];
  return readFileSync(BASELINE, "utf8").split("\n").map(l => l.trim()).filter(l => l !== "" && !l.startsWith("#"));
}

if (process.argv.includes("--write-baseline")) {
  const { missing, total } = currentGaps();
  writeFileSync(BASELINE, `# @echo-agent/core 公共符号缺 JSDoc 的存量。由 test/export-jsdoc.test.ts --write-baseline 生成。\n# 这个列表【只许缩不许涨】:补完一个就从这里删一行,门会替你确认。\n# 当前:${missing.length} / ${total}\n${missing.join("\n")}\n`);
  console.log(`recorded ${missing.length} / ${total}`);
  process.exit(0);
}

describe("公共导出的 JSDoc(棘轮)", () => {
  const { missing, unresolved, total } = currentGaps();
  const baseline = new Set(readBaseline());

  test("解析器认得所有声明写法", () => {
    // 定位不到 = 本门的解析漏了一种写法,不是文档问题,不该混进缺口里。
    expect(unresolved, `以下符号在声明文件里定位不到:\n  ${unresolved.join("\n  ")}\n`).toEqual([]);
  });

  test("没有【新增】未文档化的公共符号", () => {
    const fresh = missing.filter(k => !baseline.has(k));
    expect(fresh, `新增了没有 JSDoc 的公共符号(${total} 个符号,存量缺口 ${baseline.size}):\n  ${fresh.join("\n  ")}\n`).toEqual([]);
  });

  test("baseline 只许缩不许涨", () => {
    const fixed = [...baseline].filter(k => !missing.includes(k));
    expect(fixed, `以下符号已经补上 JSDoc,请从 test/jsdoc-baseline.txt 删掉它们(跑 --write-baseline):\n  ${fixed.join("\n  ")}\n`).toEqual([]);
  });
});
