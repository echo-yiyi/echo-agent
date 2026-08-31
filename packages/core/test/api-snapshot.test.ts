import { test, expect } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { inventory, render, entryPoints, SNAPSHOT_PATH } from "../scripts/api-inventory.ts";
import type { ApiSymbol } from "../scripts/api-inventory.ts";

// `@echo/core` 的公共面快照门（AGENT-CORE §13 的 D15）。
//
// **由来（2026-08-17）**：M1 用一条一次性的 `getExportsOfModule` 命令清点公共面，得出
// **165 个符号**，这个数被写进了设计文档、还成了「按现有 165 个符号机械做减法」的施工依据。
// D15 把清点落成脚本后，同口径数出的**根本不是这个数**。两个数没有一个能自证对错——**口径没落成代码，
// 就没法复跑，也就没人能发现它错了**。文档里那种「机器可数却手抄进散文」的数字，
// 本仓已经腐烂过一次（README 曾把单测数写死成 437）。这道门就是那个锚。
//
// 守两件事：
//   A. 公共面不无声漂移——增删一个导出符号、或把它挪到别的模块，snapshot 必须跟着改，
//      改动进 diff 让人看见。M2 要在这份清单上划 root/engine/subpath，底下的地基不能自己动。
//   B. **数得对**，不只是「没变」。全文比对天然是恒绿友好的：清点逻辑整个写错、
//      每次都数出同一份错结果，比对照样过。所以另有一组 fixture 自检锁住判定分支。
//
// 判据源与人读报告是**同一份** `inventory()`——脚本 `--write` 写的就是这里读的，
// 不存在「报告说一套、门判另一套」的空间。

const FIXTURES = join(import.meta.dir, "fixtures");

test("snapshot 与实际公共面一致（不等即红，跑 --write 重录并人审 diff）", () => {
  expect(existsSync(SNAPSHOT_PATH)).toBe(true);
  const recorded = readFileSync(SNAPSHOT_PATH, "utf8");
  const actual = render(inventory());
  if (recorded !== actual) {
    throw new Error(
      "公共 API 面与 test/api-snapshot.txt 不一致。\n" +
        "确认这是有意的改动后重录：bun packages/core/scripts/api-inventory.ts --write\n" +
        "**必须人审 diff**——这份清单是 M2 划 root/engine/subpath 的底稿。",
    );
  }
});

test("exports 的每条入口都进了 snapshot（漏一条 = 一整片公共面没人守）", () => {
  const recorded = readFileSync(SNAPSHOT_PATH, "utf8");
  const subpaths = entryPoints().map((e) => e.subpath);
  // `.` 与 `./package.json` 之外还有子路径；少一条就是漏守，多一条说明 snapshot 过期。
  expect(subpaths.length).toBeGreaterThanOrEqual(2);
  for (const sub of subpaths) {
    expect(recorded).toContain(`== 入口 "${sub}" →`);
  }
});

test("根入口的符号量级对得上（防「只数了第一行」的恒绿）", () => {
  const root = inventory().find((e) => e.subpath === ".");
  expect(root).toBeDefined();
  // 具体数字由 snapshot 全文比对锁死，这里只挡「清点整个塌掉」这一类失败。
  // 下限随 2026-08-24 的根入口收窄（345 → 164）下调：这条门问的是「还数得出东西吗」，
  // **不是「公共面有多大」**——后者归 snapshot 全文比对，它才是收窄的判据。
  expect(root!.symbols.length).toBeGreaterThan(100);
  // 根入口必须来自多个模块——只剩一个来源说明 re-export 没被展开。
  expect(new Set(root!.symbols.map((s) => s.origin)).size).toBeGreaterThan(20);
});

test("自检：kind 看运行时可达性、alias 只用来定 origin、未导出的不进清单", () => {
  const [entry] = inventory([{ subpath: "<fixture>", abs: join(FIXTURES, "api-probe.ts") }]);
  expect(entry).toBeDefined();
  const got = entry!.symbols.map((s) => ({ ...s, origin: s.origin.replace("test/fixtures/", "") }));

  const expected: ApiSymbol[] = [
    // 两层 alias（probe → relay → origin）必须解到原始声明，停在 relay 就是错的
    { name: "originValue", kind: "value", origin: "api-origin.ts" },
    // class → 值与类型同名
    { name: "OriginClass", kind: "both", origin: "api-origin.ts" },
    // 非 class 的「同名 const + type」也是 both
    { name: "DualShape", kind: "both", origin: "api-origin.ts" },
    // 声明级 `export type {}` → 纯类型
    { name: "OriginType", kind: "type", origin: "api-origin.ts" },
    // `export *` 走非 alias 分支
    { name: "starValue", kind: "value", origin: "api-star.ts" },
    // 本地导出：origin 就是入口自己
    { name: "probeLocal", kind: "value", origin: "api-probe.ts" },

    // ── kind 必须看**这条入口的运行时可达性**，不是看解析到底的原始符号 ──
    // 下面三条的原始声明都带运行时值（两个 class、一个 const），但出口是 type-only，
    // 用户 `import { X }` 什么都拿不到。上一版把它们全记成 `both`，是错的。
    // origin 仍必须指向原始声明——这正是「kind 看出口、origin 看声明」两件事分开的意思。
    { name: "TypeOnlyClass", kind: "type", origin: "api-origin.ts" }, // export type { C as X }
    { name: "TypeOnlyDual", kind: "type", origin: "api-origin.ts" }, // export { type D as X }
    // `export type *`：不产生 ExportSpecifier，只有从入口 AST 一侧才看得见
    { name: "StarOnlyType", kind: "type", origin: "api-typestar.ts" }, // 原始声明是 class
    { name: "starTypeValue", kind: "type", origin: "api-typestar.ts" }, // 原始声明是 const
  ];
  expect(got).toEqual(
    [...expected].sort((a, b) => a.origin.localeCompare(b.origin) || a.name.localeCompare(b.name)),
  );

  const names = got.map((s) => s.name);
  // 负例①：fixture 里 `const notExported` 没导出，不该出现
  expect(names).not.toContain("notExported");
  // 负例②：中转文件的路径不该作为任何符号的 origin 泄漏出来
  expect(got.map((s) => s.origin)).not.toContain("api-relay.ts");
});

// 下面两条锁的是同一件事：**kind 必须按运行时可达性算，不能按「名字在不在某个集合里」算。**
// 两个例子 tsc 都通过，上一版的名字集合写法两个都判错——一个漏、一个多。
test("自检 · type-only star 经 barrel 中转：入口看不见那一跳，仍必须判 type", () => {
  const [entry] = inventory([{ subpath: "<fixture>", abs: join(FIXTURES, "api-probe-barrel.ts") }]);
  const got = entry!.symbols.map((s) => `${s.kind} ${s.name}`).sort();
  // 入口写的是普通 `export *`，type-only 藏在 relay 里；运行时这条入口一个值都导不出来
  expect(got).toEqual(["type StarOnlyType", "type starTypeValue"]);
});

test("自检 · 显式 value 导出覆盖 type-only star：被覆盖的那个是 value", () => {
  const [entry] = inventory([{ subpath: "<fixture>", abs: join(FIXTURES, "api-probe-override.ts") }]);
  const got = entry!.symbols.map((s) => `${s.kind} ${s.name}`).sort();
  // 显式导出优先于 star 导出——所以 starTypeValue 有值，同一条 star 里没被覆盖的 StarOnlyType 没有
  expect(got).toEqual(["type StarOnlyType", "value starTypeValue"]);
});

test("自检 · `export default` 声明：对外的名字是 default，不是那个本地绑定", () => {
  const [entry] = inventory([{ subpath: "<fixture>", abs: join(FIXTURES, "api-probe-default.ts") }]);
  // Bun 实际导出的键就是 ["default"]；`DefaultThing` 是文件内部名字，外面 import 不到
  expect(entry!.symbols.map((s) => `${s.kind} ${s.name}`)).toEqual(["both default"]);
});

test("自检 · 循环 re-export：反向重命名必须收敛出来（空集猜测漏得掉，固定点漏不掉）", () => {
  const [entry] = inventory([{ subpath: "<fixture>", abs: join(FIXTURES, "api-probe-cycle.ts") }]);
  const got = entry!.symbols.map((s) => `${s.kind} ${s.name}`).sort();
  expect(got).toEqual(["value cycleRenamed", "value cycleValue"]);
});

// **这条是上面所有 fixture 断言的总闸**：不再由我来说「应该是什么」，直接问运行时。
// ESM 名字空间对象的键 = 这个模块真正导出的运行时值；判据说 value/both 的必须一个不多一个不少。
// 三轮 review 捅穿的四个 bug（出口 type-only、barrel 中转、显式覆盖、default 与环）
// 全都会被这一条直接照出来，不需要我先想到那种写法。
test("自检 · 与运行时真相对账：判为 value/both 的名字 === 该模块实际导出的键", async () => {
  const fixtures = [
    "api-probe.ts",
    "api-probe-barrel.ts",
    "api-probe-override.ts",
    "api-probe-default.ts",
    "api-probe-cycle.ts",
  ];
  for (const name of fixtures) {
    const abs = join(FIXTURES, name);
    const mod: Record<string, unknown> = await import(abs);
    const actual = Object.keys(mod).sort();
    const [entry] = inventory([{ subpath: `<${name}>`, abs }]);
    const judged = entry!.symbols
      .filter((s) => s.kind !== "type")
      .map((s) => s.name)
      .sort();
    expect({ [name]: judged }).toEqual({ [name]: actual });
  }
});

test("自检：render 对符号增删敏感（比对本身不是摆设）", () => {
  const base = inventory([{ subpath: "<fixture>", abs: join(FIXTURES, "api-probe.ts") }]);
  const dropped = base.map((e) => ({ ...e, symbols: e.symbols.slice(1) }));
  expect(render(dropped)).not.toBe(render(base));
  // 只改种类、不改数量，也必须体现在文本里
  const retyped = base.map((e) => ({
    ...e,
    symbols: e.symbols.map((s, i) => (i === 0 ? { ...s, kind: "type" as const } : s)),
  }));
  expect(render(retyped)).not.toBe(render(base));
  // 符号**搬家**——名字与种类都不变，只有声明来源变了。划线时最常发生的正是这一种。
  const moved = base.map((e) => ({
    ...e,
    symbols: e.symbols.map((s, i) => (i === 0 ? { ...s, origin: "src/somewhere-else.ts" } : s)),
  }));
  expect(render(moved)).not.toBe(render(base));
});
