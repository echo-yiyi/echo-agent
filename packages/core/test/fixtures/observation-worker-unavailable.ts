// 由 observability-runtime.test.ts 起子进程 `bun test` 跑：把 Worker 换成构造即抛的实现，看装配与 run 照常。
// 不叫 *.test.ts：mock.module 会留在整个测试进程里，不能被全仓 `bun test` 收进同一个进程。
import { expect, mock, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

mock.module("node:worker_threads", () => ({
  Worker: class {
    constructor() {
      throw new Error("Worker 在这个环境里起不来");
    }
  },
}));

test("Worker 构造抛错：createEcho、send、stop 照常，观测读不到这个 run", async () => {
  const { createEcho } = await import("../../src/create-echo.ts");
  const { createProvider } = await import("../../src/provider/models.ts");
  const { createProviderStreams } = await import("../../src/provider/dialect.ts");
  const { scriptedDialect, textTurn } = await import("../../src/testing.ts");
  process.env.ECHO_HOME = mkdtempSync(join(tmpdir(), "echo-no-worker-home-"));
  const echo = await createEcho({
    provider: createProvider({ id: "s", auth: { apiKey: { resolve: async () => ({ apiKey: "x" }) } }, models: [{ id: "only", api: "fake" }], api: createProviderStreams(scriptedDialect([textTurn("hi")])) }),
    stateDir: join(mkdtempSync(join(tmpdir(), "echo-no-worker-")), "state"),
    allowNetwork: false,
    withoutMemory: true,
    extensionDirs: [],
  });
  await echo.start();
  const r = await echo.send("x");
  expect(r.outcome.kind).toBe("completed");
  expect((await echo.observations.getRun(r.runId)).kind).toBe("unknown");
  await echo.stop();
});
