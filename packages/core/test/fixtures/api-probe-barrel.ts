// 自检入口 · 情形①：type-only star **经 barrel 中转**。
//
// 这里写的是普通 `export *`，type-only 那一跳藏在 relay 里。
// 期望：两个名字都判 type——运行时这条入口一个值都导不出来。

export * from "./api-typestar-relay.ts";
