// barrel 中转站：type-only star 发生在**这一跳**，入口只是普通 `export *`。
//
// 判据若只扫入口自己的 `export type *`（上一版就是），这一跳完全看不见——
// 于是 `api-typestar.ts` 的 class 被记成 both、const 被记成 value，
// 而入口在运行时**根本没有**这两个导出。tsc 全程通过，所以只能靠门抓。

export type * from "./api-typestar.ts";
