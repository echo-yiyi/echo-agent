import { describe, expect, test } from "bun:test";
import {
  checkCodeBlocks, checkFileRefs, checkLinks, checkPairing, checkRoster,
  loadManifest, type Violation,
} from "../scripts/docs-lint.ts";

// **文档门**:五道判据,读 `docs/docs.manifest.json`。
//
// 与代码侧的门分工:
//   · `api-snapshot`  锁导出符号表不无声漂移;
//   · `export-jsdoc`  锁 core 公共面每个符号都解释过自己(棘轮:只拦新增);
//   · 本门锁文档本身。
//
// **判据自身的正反例在 `docs-lint-fixtures.test.ts`** —— 没有那一层,这里的"绿"
// 可能只是因为解析器什么都没解析出来(链接门空绿过一轮,就是这么来的)。
//
// 人读报告:`bun scripts/docs-lint.ts`;两侧确认一致后重录:`--write-pairing <文档>`。

const manifest = loadManifest();
const fmt = (vs: Violation[]): string => vs.map(v => `\n  ${v.path}\n    ${v.message}`).join("");

describe("文档门", () => {
  test("花名册:登记的都存在,全仓没有野 md 与孤儿配对文件", () => {
    const v = checkRoster(manifest);
    expect(v.map(x => x.path), `花名册不符:${fmt(v)}\n`).toEqual([]);
  });

  test("链接:Markdown 锚点真实存在;源码链接仍指向声明或唯一测试名", () => {
    const v = checkLinks(manifest);
    expect(v.map(x => x.path), `死链:${fmt(v)}\n`).toEqual([]);
  });

  test("代码块:文档里的 ts 围栏能独立编译", () => {
    const v = checkCodeBlocks(manifest);
    expect(v.map(x => x.path), `代码块编译失败:${fmt(v)}\n`).toEqual([]);
  });

  test("引用:注释与散文里写到的文件路径真实存在", () => {
    const v = checkFileRefs(manifest);
    expect(v.map(x => x.path), `引用了不存在的文件:${fmt(v)}\n`).toEqual([]);
  });

  test("双语:三文件成组,两侧字节与记录一致,结构签名一致", () => {
    const v = checkPairing(manifest);
    expect(v.map(x => x.path), `配对不符:${fmt(v)}\n`).toEqual([]);
  });
});
