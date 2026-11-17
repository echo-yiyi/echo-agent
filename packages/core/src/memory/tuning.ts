// 记忆后台活的可调取值（2026-11-12）：产品经 `CreateEchoOptions.memory.extract` / `.dream` 配，
// 装配时在这里校验、补齐缺省。**配错就抛**——不是整数、低于下限、写错键名都算配错；
// 悄悄回落到缺省会让产品以为自己的配置生效了。
//
// 2026-11-17 起两边各多一项 `prompt`（提取 / 整理指令怎么写），是函数，不是整数。

import { DEFAULT_DREAM_GATES, defaultDreamPrompt, type DreamGates, type DreamPrompt, type MemoryDreamOptions } from "./dream.ts";
import { DEFAULT_EXTRACT_SETTINGS, type ExtractPrompt, type ExtractSettings, type MemoryExtractOptions } from "./extract.ts";

/** 每一项的下限：轮数上限与「攒满几轮」至少 1，其余 0 起（0 = 这一道不设门槛）。 */
const EXTRACT_MIN: Readonly<Record<Exclude<keyof MemoryExtractOptions, "prompt">, number>> = { maxTurns: 1, everyTurns: 1, minUserWords: 0 };
const DREAM_MIN: Readonly<Record<keyof DreamGates, number>> = { minWritesSinceLast: 0, minTurnsSinceLast: 0, minFiles: 0, minIntervalMs: 0 };

/** 整理实际用的取值：门（补齐缺省）与整理指令（不给就是缺省写法）。 */
export type DreamSettings = Readonly<{ gates: DreamGates; prompt: DreamPrompt }>;

/** `memory.extract` 校验后补齐缺省。不给 = 全用缺省。 */
export function resolveExtractOptions(given: MemoryExtractOptions | undefined): ExtractSettings {
  const { prompt, numbers } = splitPrompt<ExtractPrompt>("memory.extract", given);
  return Object.freeze({ ...DEFAULT_EXTRACT_SETTINGS, ...checked("memory.extract", numbers, EXTRACT_MIN), ...(prompt === undefined ? {} : { prompt }) });
}

/** `memory.dream` 校验后补齐缺省：给了的门覆盖 `DEFAULT_DREAM_GATES` 里的同名项，其余照缺省；`prompt` 不给用缺省写法。 */
export function resolveDreamOptions(given: MemoryDreamOptions | undefined): DreamSettings {
  const { prompt, numbers } = splitPrompt<DreamPrompt>("memory.dream", given);
  return Object.freeze({
    gates: Object.freeze({ ...DEFAULT_DREAM_GATES, ...checked("memory.dream", numbers, DREAM_MIN) }),
    prompt: prompt ?? defaultDreamPrompt,
  });
}

/** 先查是对象，再把 `prompt`（给了就得是函数）与其余各项分开。 */
function splitPrompt<P>(where: string, given: object | undefined): { prompt: P | undefined; numbers: Record<string, unknown> | undefined } {
  if (given === undefined) return { prompt: undefined, numbers: undefined };
  if (typeof given !== "object" || given === null || Array.isArray(given)) throw new Error(`${where} 必须是对象`);
  const { prompt, ...numbers } = given as Record<string, unknown>;
  if (prompt !== undefined && typeof prompt !== "function") throw new Error(`${where}.prompt 必须是函数（输入 → 指令文字），收到 ${typeof prompt}`);
  return { prompt: prompt as P | undefined, numbers };
}

/** 逐项查：键名在表里、值是不低于下限的整数。值为 undefined 的项当没给。 */
function checked<K extends string>(where: string, given: Record<string, unknown> | undefined, min: Readonly<Record<K, number>>): Partial<Record<K, number>> {
  if (given === undefined) return {};
  const out: Partial<Record<K, number>> = {};
  for (const [key, value] of Object.entries(given)) {
    if (!Object.hasOwn(min, key)) throw new Error(`${where} 没有 '${key}' 这一项；可配的是 ${[...Object.keys(min), "prompt"].join(" / ")}`);
    if (value === undefined) continue;
    const floor = min[key as K];
    if (typeof value !== "number" || !Number.isInteger(value) || value < floor) {
      throw new Error(`${where}.${key} 必须是 ≥ ${floor} 的整数，收到 ${JSON.stringify(value)}`);
    }
    out[key as K] = value;
  }
  return out;
}
