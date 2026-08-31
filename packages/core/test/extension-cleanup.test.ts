import { test, expect } from "bun:test";
import { unmountGenerations, type UnmountTarget } from "../src/extension/cleanup.ts";

// 「装到一半失败了怎么收摊」是最容易写错、又最难从外面观察的一段代码：
// `createEcho()` / `createCodingAgent()` 的失败路径都不返回任何东西，Host 不可达，
// `agent.tools` 又会被 `agent.stop()` 清空——端到端测试**证明不了它跑过**（review 三轮实测：
// 把 catch 里的 unmount 整段删掉，那两条端到端测试照样绿）。
//
// 所以判据落在**这个函数本身**：用一个记账的假 Host，把顺序、跳过、继续执行、错误聚合逐条钉住。
// 两个调用方共用它，于是「顺序对不对」只需要在一处证明。

function fakeHost(opts: { mounted: string[]; failOn?: Record<string, string> }): UnmountTarget & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    get mountedGenerations(): readonly string[] {
      return opts.mounted;
    },
    async unmount(generation: string): Promise<void> {
      calls.push(generation);
      const msg = opts.failOn?.[generation];
      if (msg !== undefined) throw new Error(msg);
    },
  };
}

test("按给定顺序逐代卸载——顺序是调用方给的，不是 Host 自己的挂载序", async () => {
  const host = fakeHost({ mounted: ["builtin", "boot"] });
  const errors = await unmountGenerations(host, ["boot", "builtin"]);
  // 外层先卸：外层可能 inject 了内层提供的 Service，反过来会让 provider 在还有 consumer 时消失
  expect(host.calls).toEqual(["boot", "builtin"]);
  expect(errors).toEqual([]);
});

test("没 mount 上的那一代**跳过**，不当成故障", async () => {
  // `unmount` 一个未知 generation 会抛「未知」。把它记进错误账里，
  // 就是把「本来就没装」误报成「卸失败」——构造在第一代就失败时这是常态。
  const host = fakeHost({ mounted: ["builtin"] });
  const errors = await unmountGenerations(host, ["boot", "builtin"]);
  expect(host.calls).toEqual(["builtin"]); // boot 压根没试
  expect(errors).toEqual([]);
});

test("一代失败**不影响后面几代**，且错误全部收集（不抛、不顶掉）", async () => {
  // 上一版是 `try { unmount(A) } finally { unmount(B) }` 那种串法：B 抛会把 A 的错顶掉。
  // 丢掉一个失败原因，排查时就少一条线索。
  const host = fakeHost({ mounted: ["builtin", "boot"], failOn: { boot: "boot-unmount-failed" } });
  const errors = await unmountGenerations(host, ["boot", "builtin"]);
  expect(host.calls).toEqual(["boot", "builtin"]); // 前一代失败了，后一代照样试
  expect(errors.map(String)).toEqual(["Error: boot-unmount-failed"]);
});

test("两代都失败：两个错都在，顺序与卸载顺序一致", async () => {
  const host = fakeHost({
    mounted: ["builtin", "boot"],
    failOn: { boot: "boot-failed", builtin: "builtin-failed" },
  });
  const errors = await unmountGenerations(host, ["boot", "builtin"]);
  expect(errors.map(String)).toEqual(["Error: boot-failed", "Error: builtin-failed"]);
});

test("`unmountGenerations` 自己**不抛**——收摊路径上抛错会顶掉调用方手里的原始失败原因", async () => {
  const host = fakeHost({ mounted: ["a"], failOn: { a: "boom" } });
  await expect(unmountGenerations(host, ["a"])).resolves.toBeArrayOfSize(1);
});
