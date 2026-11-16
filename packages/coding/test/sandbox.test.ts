// echo-coding 这一头的沙箱接线（2026-11-15）：preset 把 `sandbox` 交给 `echo:shell`，审查规则认得 `sandbox: false`。
// 沙箱本身（可写目录、规则、真跑）的判据在 `@echo-agent/tools` 的 `test/sandbox.test.ts`；走真装配的那条在 `coding-agent.test.ts`。

import { expect, test } from "bun:test";
import { codingPreset } from "../src/agent.ts";
import { REVIEW_SYSTEM } from "../src/permission.ts";

test("codingPreset：sandbox: true 才给 echo:shell 配沙箱，缺省不配；审查规则说清 sandbox: false 是在沙箱外跑", () => {
  const shell = (p: ReturnType<typeof codingPreset>) => p.extensions.find((e) => e.entryId === "echo:shell")!;
  expect(shell(codingPreset({ permission: false })).config).toBeUndefined();
  expect(shell(codingPreset({ permission: false, sandbox: true })).config).toEqual({ sandbox: true });
  expect(REVIEW_SYSTEM).toContain('"sandbox": false runs outside the sandbox');
});
