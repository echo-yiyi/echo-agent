// 生命周期四个方法的**精确类型快照**。
//
// 为什么单独立一条：`test/api-snapshot.txt` 只清点导出**符号名**，不记 class member 与签名——
// 给 `Agent` 加三个方法、改 `start()` 的签名，那份快照零变化（O2d-2 review 指出的假绿）。
// 这里用编译期 `Equal<>` 把这四个的形状钉死：改签名不更新本文件 → `tsc` 判红。

import { test, expect } from "bun:test";
import { Agent } from "../src/agent.ts";

/** 严格相等（不是互相 assignable）：多一个可选参数、宽一个联合都算不等。 */
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

type LifecycleSurface = {
  start: (options?: { activation?: "immediate" | "deferred" }) => Promise<void>;
  activate: () => Promise<void>;
  pauseManagedWork: (input: { reason: "handoff" }) => Promise<void>;
  resumeManagedWork: () => Promise<void>;
};

// 改了这四个的签名就必须同步改这里——否则这一行直接编译失败
const LIFECYCLE_SHAPE_IS_STABLE: Equal<Pick<Agent, "start" | "activate" | "pauseManagedWork" | "resumeManagedWork">, LifecycleSurface> = true;

test("生命周期四个方法的签名快照（编译期钉死）+ 运行时确实在公共面上", () => {
  expect(LIFECYCLE_SHAPE_IS_STABLE).toBe(true);
  for (const name of ["start", "activate", "pauseManagedWork", "resumeManagedWork"] as const) {
    expect(typeof Agent.prototype[name], name).toBe("function");
  }
});
