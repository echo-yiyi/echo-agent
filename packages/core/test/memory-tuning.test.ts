import { test, expect } from "bun:test";
import { DEFAULT_DREAM_GATES, defaultDreamPrompt } from "../src/memory/dream.ts";
import { DEFAULT_EXTRACT_SETTINGS, defaultExtractPrompt } from "../src/memory/extract.ts";
import { resolveDreamOptions, resolveExtractOptions } from "../src/memory/tuning.ts";

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
  expect(resolveDreamOptions(undefined)).toEqual({ gates: DEFAULT_DREAM_GATES, prompt: defaultDreamPrompt });
  expect(resolveDreamOptions({ minFiles: 3, minTurnsSinceLast: 20 }).gates).toEqual({ ...DEFAULT_DREAM_GATES, minFiles: 3, minTurnsSinceLast: 20 });
});

test("0 = 这一道不设门槛：词数门槛与整理的各道门可以给 0；值为 undefined 的项当没给", () => {
  expect(resolveExtractOptions({ minUserWords: 0 }).minUserWords).toBe(0);
  expect(resolveDreamOptions({ minWritesSinceLast: 0, minFiles: 0, minIntervalMs: 0 }).gates).toEqual({ minWritesSinceLast: 0, minFiles: 0, minIntervalMs: 0 });
  expect(resolveExtractOptions({ maxTurns: undefined })).toEqual(DEFAULT_EXTRACT_SETTINGS);
});

test("配错就抛：轮数上限与「攒满几轮」至少 1，不收小数、负数、字符串", () => {
  expect(thrown(() => resolveExtractOptions({ maxTurns: 0 }))).toContain("memory.extract.maxTurns 必须是 ≥ 1 的整数，收到 0");
  expect(thrown(() => resolveExtractOptions({ everyTurns: 0 }))).toContain("memory.extract.everyTurns 必须是 ≥ 1 的整数");
  expect(thrown(() => resolveExtractOptions({ maxTurns: 2.5 }))).toContain("收到 2.5");
  expect(thrown(() => resolveExtractOptions({ minUserWords: -1 }))).toContain("memory.extract.minUserWords 必须是 ≥ 0 的整数");
  expect(thrown(() => resolveExtractOptions({ maxTurns: "5" as unknown as number }))).toContain('收到 "5"');
  expect(thrown(() => resolveDreamOptions({ minIntervalMs: Number.NaN }))).toContain("memory.dream.minIntervalMs 必须是 ≥ 0 的整数");
});

test("写错键名也是配错：报出可配的那几项，不悄悄忽略", () => {
  expect(thrown(() => resolveExtractOptions({ maxTurn: 3 } as never))).toBe("memory.extract 没有 'maxTurn' 这一项；可配的是 maxTurns / everyTurns / minUserWords / prompt");
  expect(thrown(() => resolveDreamOptions({ budgetRatio: 0.8 } as never))).toContain("memory.dream 没有 'budgetRatio' 这一项");
});

test("提取与整理的指令可以换（2026-11-17）：prompt 给函数就用它，不给用缺省写法；给了不是函数就抛", () => {
  const mine = (): string => "我们自己的提取指令";
  expect(resolveExtractOptions(undefined).prompt).toBe(defaultExtractPrompt);
  expect(resolveExtractOptions({ prompt: mine, maxTurns: 10 })).toEqual({ ...DEFAULT_EXTRACT_SETTINGS, maxTurns: 10, prompt: mine });
  const dream = (): string => "我们自己的整理指令";
  expect(resolveDreamOptions({ prompt: dream, minWritesSinceLast: 2 })).toEqual({ gates: { ...DEFAULT_DREAM_GATES, minWritesSinceLast: 2 }, prompt: dream });
  expect(thrown(() => resolveExtractOptions({ prompt: "写点什么" as never }))).toBe("memory.extract.prompt 必须是函数（输入 → 指令文字），收到 string");
  expect(thrown(() => resolveDreamOptions({ prompt: 1 as never }))).toBe("memory.dream.prompt 必须是函数（输入 → 指令文字），收到 number");
});
