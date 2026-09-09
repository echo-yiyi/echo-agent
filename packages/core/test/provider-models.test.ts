// `createProvider({ fetchModels })` 的刷新闩：并发去重不能变成永久卡死。
// review 2026-09-07：早退（离线 / 已 abort）在 `inflight ??=` 赋值之前就把 finally 跑完了，
// 闩被赋成一个已 resolve 的 promise 再也清不掉——之后 fetchModels 永远不会再被调用，目录冻在最后一次成功。

import { test, expect } from "bun:test";
import { createProvider } from "../src/provider/models.ts";
import { createProviderStreams } from "../src/provider/dialect.ts";
import { scriptedDialect, textTurn } from "../src/testing.ts";

function providerWithFetch(): { provider: ReturnType<typeof createProvider>; calls: () => number } {
  let calls = 0;
  const provider = createProvider({
    id: "dyn",
    auth: { apiKey: { resolve: async () => ({ apiKey: "x" }) } },
    defaultModelId: "static",
    models: [{ id: "static", api: "scripted" }],
    api: createProviderStreams(scriptedDialect([textTurn("ok")])),
    fetchModels: async () => {
      calls += 1;
      return [{ id: `dyn-${calls}`, api: "scripted" }];
    },
  });
  return { provider, calls: () => calls };
}

test("离线一次之后再上线，fetchModels 仍会被调用；目录跟着刷新（review 2026-09-07：此前闩永久卡死）", async () => {
  const { provider, calls } = providerWithFetch();
  await provider.refreshModels!({ allowNetwork: false });
  expect(calls()).toBe(0);
  await provider.refreshModels!({ allowNetwork: true });
  expect(calls()).toBe(1);
  expect(provider.getModels().map((m) => m.id)).toContain("dyn-1");
  await provider.refreshModels!({ allowNetwork: false }); // 中间再离线一次也不占闩
  await provider.refreshModels!({ allowNetwork: true });
  expect(calls()).toBe(2);
  expect(provider.getModels().map((m) => m.id)).toContain("dyn-2");
});

test("已 abort 的 signal 同样早退不占闩；在途的那次仍然去重", async () => {
  const { provider, calls } = providerWithFetch();
  const aborted = new AbortController();
  aborted.abort();
  await provider.refreshModels!({ allowNetwork: true, signal: aborted.signal });
  expect(calls()).toBe(0);
  const a = provider.refreshModels!({ allowNetwork: true });
  const b = provider.refreshModels!({ allowNetwork: true });
  expect(a).toBe(b); // 在途共享
  await Promise.all([a, b]);
  expect(calls()).toBe(1);
  await provider.refreshModels!({ allowNetwork: true });
  expect(calls()).toBe(2);
});
