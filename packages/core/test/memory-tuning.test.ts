import { test, expect } from "bun:test";
import { DEFAULT_DREAM_GATES } from "../src/memory/dream.ts";
import { DEFAULT_EXTRACT_SETTINGS } from "../src/memory/extract.ts";
import { resolveDreamGates, resolveExtractOptions } from "../src/memory/tuning.ts";

// 记忆后台活的可调取值（2026-11-12）：产品经 `memory.extract` / `memory.dream` 配，装配时校验、补齐缺省。
// 配错就抛，不回落到缺省——回落的话产品以为自己的配置生效了。

function thrown(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  return "";
}

test("不配 = 全用缺省；配了的项覆盖、其余照缺省", () => {
  expect(resolveExtractOptions(undefined)).toEqual(DEFAULT_EXTRACT_SETTINGS);
  expect(resolveExtractOptions({ maxTurns: 8 })).toEqual({ ...DEFAULT_EXTRACT_SETTINGS, maxTurns: 8 });
  expect(resolveDreamGates(undefined)).toEqual(DEFAULT_DREAM_GATES);
  expect(resolveDreamGates({ minFiles: 3, minTurnsSinceLast: 20 })).toEqual({ ...DEFAULT_DREAM_GATES, minFiles: 3, minTurnsSinceLast: 20 });
});

test("0 = 这一道不设门槛：词数门槛与整理的各道门可以给 0；值为 undefined 的项当没给", () => {
  expect(resolveExtractOptions({ minUserWords: 0 }).minUserWords).toBe(0);
  expect(resolveDreamGates({ minWritesSinceLast: 0, minFiles: 0, minIntervalMs: 0 })).toEqual({ minWritesSinceLast: 0, minFiles: 0, minIntervalMs: 0 });
  expect(resolveExtractOptions({ maxTurns: undefined })).toEqual(DEFAULT_EXTRACT_SETTINGS);
});

test("配错就抛：轮数上限与「攒满几轮」至少 1，不收小数、负数、字符串", () => {
  expect(thrown(() => resolveExtractOptions({ maxTurns: 0 }))).toContain("memory.extract.maxTurns 必须是 ≥ 1 的整数，收到 0");
  expect(thrown(() => resolveExtractOptions({ everyTurns: 0 }))).toContain("memory.extract.everyTurns 必须是 ≥ 1 的整数");
  expect(thrown(() => resolveExtractOptions({ maxTurns: 2.5 }))).toContain("收到 2.5");
  expect(thrown(() => resolveExtractOptions({ minUserWords: -1 }))).toContain("memory.extract.minUserWords 必须是 ≥ 0 的整数");
  expect(thrown(() => resolveExtractOptions({ maxTurns: "5" as unknown as number }))).toContain('收到 "5"');
  expect(thrown(() => resolveDreamGates({ minIntervalMs: Number.NaN }))).toContain("memory.dream.minIntervalMs 必须是 ≥ 0 的整数");
});

test("写错键名也是配错：报出可配的那几项，不悄悄忽略", () => {
  expect(thrown(() => resolveExtractOptions({ maxTurn: 3 } as never))).toBe("memory.extract 没有 'maxTurn' 这一项；可配的是 maxTurns / everyTurns / minUserWords");
  expect(thrown(() => resolveDreamGates({ budgetRatio: 0.8 } as never))).toContain("memory.dream 没有 'budgetRatio' 这一项");
});
