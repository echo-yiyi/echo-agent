// 自检入口 · 循环 re-export。
//
// 本文件 `export *` 引 `api-cycle-back.ts`，那边又回头引本文件——合法 ESM，tsc 通过，
// Bun 实际从这里导出 `["cycleValue", "cycleRenamed"]` 两个值。

export * from "./api-cycle-back.ts";
export const cycleValue = 1;
