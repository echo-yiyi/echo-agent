// echo-coding 这一头的沙箱接线（2026-11-15）：preset 把 `sandbox` 交给 `echo:shell`。
// 沙箱本身（可写目录、规则、真跑）与交给安全分类器的那句说明，判据在 `@echo-agent/tools` 的测试里；走真装配的那条在 `coding-agent.test.ts`。

import { expect, test } from "bun:test";
import { codingPreset } from "../src/agent.ts";

test("codingPreset：sandbox: true 才给 echo:shell 配沙箱，缺省不配", () => {
  const shell = (p: ReturnType<typeof codingPreset>) => p.extensions.find((e) => e.entryId === "echo:shell")!;
  expect(shell(codingPreset({ permission: false })).config).toBeUndefined();
  expect(shell(codingPreset({ permission: false, sandbox: true })).config).toEqual({ sandbox: true });
});
