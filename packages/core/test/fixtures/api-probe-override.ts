// 自检入口 · 情形②：显式 value 导出**覆盖** type-only star。
//
// `starTypeValue` 这个名字两条路都能到达，而 ES 的规则是**显式导出优先于 star 导出**。
// 所以它在运行时是有值的，必须判 value；同一条 star 带来的 `StarOnlyType` 没被覆盖，仍是 type。
//
// 这条正是「把 star 带来的名字塞进一个 Set、再按名字统一标 type」那种写法修不好的地方——
// 覆盖是优先级关系，不是集合的加减，改成递归也一样错。

export type * from "./api-typestar.ts";
export { starTypeValue } from "./api-typestar.ts";
