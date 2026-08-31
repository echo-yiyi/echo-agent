// api-snapshot 门的自检入口：把清点会遇到的每种导出写法各摆一个。
// 判定逻辑（kind 看出口语法、alias 解到底只为定 origin、export type * 的补漏）
// 任何一支写错，自检就红。

export { originValue } from "./api-relay.ts"; // 两层 alias → origin 必须是 api-origin.ts
export { OriginClass, DualShape } from "./api-origin.ts"; // class 与「同名值+类型」都应判 both
export type { OriginType } from "./api-origin.ts"; // 声明级 type-only → type
export * from "./api-star.ts"; // 非 alias 分支

// —— 出口处的 type-only：原始符号是值，出口没有值 ——
// 上一版把 kind 交给「解析到底的原始符号」，这两条会被记成 both，而用户 import 到的是空。
export type { OriginClass as TypeOnlyClass } from "./api-origin.ts"; // 声明级
export { type DualShape as TypeOnlyDual } from "./api-origin.ts"; // specifier 级

// `export type *`：不产生 ExportSpecifier，只有从入口 AST 一侧才看得见
export type * from "./api-typestar.ts";

const probeInternal = 7;
/** 本地导出：origin 就是本文件。 */
export const probeLocal = probeInternal;
