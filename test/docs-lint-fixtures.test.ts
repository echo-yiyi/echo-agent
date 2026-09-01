import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  anchors,
  docLinks,
  fileRefCandidates,
  isNestedGitRoot,
  slug,
  sourceLinks,
  sourceSymbols,
  structuralSignature,
  testCaseAnchors,
  tsBlocks,
  validateSourceAnchor,
} from "../scripts/docs-lint.ts";

// **判据自检**:每个 parser 都要能分辨正例与反例。
//
// 为什么必须有这一层:上一版八道门的测试壳全是「当前仓库结果应为空」——
// 而当时仓库里**解析得出的相对链接数是 0**,所以链接门那声"绿"什么都没证明,
// parser 里 `[API](api.md)` 被算成锚点 `apiapimd` 的 bug 也就没人发现。
//
// 判据是:**把被测函数换成常量返回,这里必须红**。所以每条都成对——
// 一条证明它认得对的,一条证明它认得错的。

describe("slug / anchors", () => {
  test("标题里的行内链接还原成链接文字(GitHub 行为)", () => {
    expect(slug("[API](api.md)")).toBe("api");          // 曾经算成 "apiapimd"
    expect(slug("`code` 与 *强调*")).toBe("code-与-强调");
    expect(slug("一、两个高度")).toBe("一两个高度");
  });

  test("重复标题按 GitHub 规则补后缀", () => {
    const a = anchors("# 用法\n## 用法\n## 用法\n");
    expect([...a].sort()).toEqual(["用法", "用法-1", "用法-2"]);
  });
});

describe("docLinks", () => {
  test("行内、引用式、同页锚点三种都收", () => {
    const text = [
      "见 [行内](a.md) 与 [引用式][r] 与 [同页](#节)。",
      "[外链](https://x.com/y.md) 不收,[图片](p.png) 不收。",
      "",
      "[r]: b.md#锚",
    ].join("\n");
    const got = docLinks(text).map(l => `${l.target ?? ""}#${l.anchor ?? ""}`).sort();
    expect(got).toEqual(["#节", "a.md#", "b.md#锚"]);
  });

  test("围栏里的链接不收", () => {
    expect(docLinks("```\n[假的](nope.md)\n```\n")).toEqual([]);
  });
});

describe("源码语义链接", () => {
  test("只收源码目标,保留 symbol / test fragment", () => {
    const text = [
      "见 [方法](../src/a.ts#symbol=Agent.start) 与 [用例][case]。",
      "[文档](a.md) 与 [外链](https://x.test/a.ts#symbol=A) 不收。",
      "",
      "[case]: ../test/a.test.ts#test=并发-start-共享一次启动",
    ].join("\n");
    expect(sourceLinks(text).map(l => `${l.target}#${l.anchor ?? ""}`).sort()).toEqual([
      "../src/a.ts#symbol=Agent.start",
      "../test/a.test.ts#test=并发-start-共享一次启动",
    ]);
  });

  test("AST 只认声明:顶层符号、类成员与类型成员可锚,注释同名不能充数", () => {
    const source = [
      "// Ghost.onlyInComment",
      "export const TOP = 1;",
      "export type AgentOptions = { toolExecution?: 'sequential' };",
      "export class Agent { private phase = 'new'; async start(): Promise<void> {} }",
    ].join("\n");
    expect([...sourceSymbols(source)].sort()).toEqual([
      "Agent", "Agent.phase", "Agent.start", "AgentOptions", "AgentOptions.toolExecution", "TOP",
    ]);
    expect(validateSourceAnchor("symbol=Agent.start", source)).toBeNull();
    expect(validateSourceAnchor("symbol=AgentOptions.toolExecution", source)).toBeNull();
    expect(validateSourceAnchor("symbol=Ghost.onlyInComment", source)).toContain("源码符号不存在");
  });

  test("行号、缺 fragment 与不存在的符号都判红", () => {
    const source = "export function runLoop(): void {}\n";
    expect(validateSourceAnchor(null, source)).toContain("缺语义锚");
    expect(validateSourceAnchor("L48", source)).toContain("禁止行号");
    expect(validateSourceAnchor("symbol=runLoop", source)).toBeNull();
    expect(validateSourceAnchor("symbol=runTurn", source)).toContain("源码符号不存在");
  });

  test("测试标题按 slug 锚定且必须唯一", () => {
    const title = "并发两个 start() 共享同一次启动，都成功";
    const source = `test(${JSON.stringify(title)}, () => {});\nit(\"另一条\", () => {});\n`;
    const anchor = slug(title);
    expect(testCaseAnchors(source).get(anchor)).toBe(1);
    expect(validateSourceAnchor(`test=${anchor}`, source, "x.test.ts")).toBeNull();
    expect(validateSourceAnchor("test=不存在", source, "x.test.ts")).toContain("测试用例不存在");
    expect(validateSourceAnchor(`test=${anchor}`, `${source}\ntest(${JSON.stringify(title)}, () => {});`, "x.test.ts"))
      .toContain("测试用例锚不唯一");
  });
});

describe("扫描边界", () => {
  test("带独立 .git 标记的嵌套 worktree / 仓库不属于本仓扫描面", () => {
    const root = mkdtempSync(join(tmpdir(), "echo-docs-lint-"));
    try {
      const nested = join(root, "nested");
      const ordinary = join(root, "ordinary");
      mkdirSync(nested);
      mkdirSync(ordinary);
      writeFileSync(join(nested, ".git"), "gitdir: elsewhere\n");
      expect(isNestedGitRoot(nested)).toBe(true);
      expect(isNestedGitRoot(ordinary)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("structuralSignature", () => {
  test("两张各一项的列表 ≠ 一张两项的列表", () => {
    const two = "- a\n\n- b\n";        // 空行断开 → 两个容器
    const one = "- a\n- b\n";          // 一个容器两项
    expect(structuralSignature(two)).not.toEqual(structuralSignature(one));
  });

  test("标题层级序列相同则签名相同(文字不进签名,这是刻意的)", () => {
    expect(structuralSignature("# A\n## B\n正文\n")).toEqual(structuralSignature("# 甲\n## 乙\n别的正文\n"));
  });

  test("伪造的收尾围栏藏不住内容", () => {
    // 收尾围栏后面跟了字,不算收尾——否则后面的差异会被当成"代码块内部"而逃过比对
    const fake = "```ts\nconst a = 1;\n``` 还有话说\nconst b = 2;\n```\n";
    const sig = structuralSignature(fake);
    expect(sig.some(s => s.startsWith("code:ts:") && s.includes("const b"))).toBe(true);
  });

  test("代码块字节不同则签名不同", () => {
    expect(structuralSignature("```ts\nconst a = 1;\n```\n"))
      .not.toEqual(structuralSignature("```ts\nconst a = 2;\n```\n"));
  });
});

describe("tsBlocks", () => {
  test("认 ts / typescript,跳过 ignore-check 与其他语言", () => {
    const text = [
      "```ts", "const a = 1;", "```",
      "```typescript", "const b = 2;", "```",
      "```ts ignore-check", "语法错误也没关系", "```",
      "```js", "const c = 3;", "```",
    ].join("\n");
    const got = tsBlocks("x.md", text).map(b => b.code);
    expect(got).toEqual(["const a = 1;", "const b = 2;"]);
  });

  test("块的起始行号指向围栏之后的第一行", () => {
    const text = "前言\n\n```ts\nconst a = 1;\n```\n";
    expect(tsBlocks("x.md", text)[0]!.line).toBe(4);
  });
});

describe("fileRefCandidates", () => {
  const dirs = ["docs", "packages", "scripts", "test", "examples"];

  test("中文紧邻路径也要抓到(这个仓库注释全是中文)", () => {
    // 列举允许的前导字符会漏掉这一类——实测漏过 11 条真死引用。
    expect(fileRefCandidates("详见docs/x.md", dirs)).toEqual(["docs/x.md"]);
    expect(fileRefCandidates("(见docs/x.md)", dirs)).toEqual(["docs/x.md"]);
    expect(fileRefCandidates("见 docs/x.md 那段", dirs)).toEqual(["docs/x.md"]);
  });

  test("后缀不许被截断", () => {
    // 曾经把 `.tsx` 截成 `.ts`,报出一个引用者根本没写过的路径。
    expect(fileRefCandidates("见 packages/a/x.tsx", dirs)).toEqual(["packages/a/x.tsx"]);
  });

  test("URL 与更长的词不算引用", () => {
    expect(fileRefCandidates("https://x.com/docs/x.md", dirs)).toEqual([]);
    expect(fileRefCandidates("xdocs/x.md", dirs)).toEqual([]);
  });

  test("顶层目录清单是参数,不是写死在正则里", () => {
    // 目录清单从文件系统读:将来加 web/ 这道门不会静默少查。
    expect(fileRefCandidates("见 web/x.md", dirs)).toEqual([]);
    expect(fileRefCandidates("见 web/x.md", [...dirs, "web"])).toEqual(["web/x.md"]);
  });
});
