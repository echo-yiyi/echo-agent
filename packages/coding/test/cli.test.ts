// `echo-coding` 的判据。本包自己只有两样东西：一个 `Product`（唯一的决定是「权限询问由谁答」）
// 和一个可执行文件。启动逻辑本身归 `echo-agent`（判据在那边的 `cli.test.ts`：参数解析、凭据、
// 引导设置、preset 进装配），这里不重测——重测就是两份判据，会分家。

import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { usage, type PresetForm } from "@echo-agent/base";
import { InMemoryCredentialStore, type PermissionPolicyInput } from "@echo-agent/core";
import { ECHO_CODING } from "../src/cli.ts";
import { SHELL_CLASSIFIER_NOTES } from "@echo-agent/tools";
import { CODING_SAFE_TOOLS } from "../src/permission.ts";

const BIN = join(import.meta.dir, "..", "bin", "echo-coding.ts");

test("preset：产品自带 echo:coding / echo:workspace / echo:shell；不碰 workspace；交互形态包沙箱、管道形态不包；交给安全分类器的是形状不是开关", async () => {
  for (const interactive of [true, false]) {
    // 形态照装配层的缺省：分类器交互开、管道关（`presetForm`）
    const preset = ECHO_CODING.preset!({ interactive, safetyClassifier: interactive }, { credentials: new InMemoryCredentialStore() });
    // 身份与编码纪律段、worktree 是 coding 自己的；文件读写与搜索、shell、web 来自工具包（echo-agent 也挂）——都以 Extension 的形态进装配。
    // **共用纪律段也在里面**（2026-09-09 拍板：纪律归产品，装配层不再恒挂）。
    expect(preset.extensions?.map((e) => e.entryId)).toEqual([
      "echo:conduct",
      "echo:coding",
      "echo:workspace",
      "echo:shell",
      "echo:worktree",
      "echo:web",
    ]);
    // 「动手前先确认」只在有人能答的那一头出现：非交互跑（Docker 里的评测）照它执行就是去问一个不存在的人
    const conduct = preset.extensions!.find((e) => e.entryId === "echo:conduct")!;
    const text = (conduct.config as { sections: { render: (c: never) => string }[] }).sections[0]!.render(undefined as never);
    expect(text.includes("confirm with the user")).toBe(interactive);
    expect(text).toContain("Look at a target before you delete or overwrite it"); // 两版都留
    // workspace 是 session 级事实，由 `mainFor()` 直接交给 `createEcho()`，preset 不出这一项（2026-09-01）。
    // 执行预算 200（2026-09-02 用户拍板）：core 缺省 20 是通用 agent / 评测的预算，coding 几步就撞顶。
    // 思考档 medium（2026-11-03 拍板）：两种形态都开，管道形态没有 Shift+Tab 可按
    // 权限（2026-11-15）：分类器开着时产品不装策略（越界那一条交给分类器判）；分类器本身是内核的，产品只交形状。
    // 「动手先问」（`permission.ts` 的 `DEFAULT_PERMISSION`）是 `codingPreset()` 不传 permission 时的缺省（评测 / 别的宿主），本产品不用它。
    expect(preset.agent).toEqual({ maxIterations: 200, thinkingLevel: "medium" });
    expect(preset.safetyClassifier).toEqual({ safeTools: CODING_SAFE_TOOLS, notes: SHELL_CLASSIFIER_NOTES });
    // 沙箱跟形态走：交互形态 bash 包进操作系统沙箱，管道形态不包（2026-11-15）
    expect(preset.extensions?.find((e) => e.entryId === "echo:shell")?.config).toEqual(interactive ? { sandbox: true } : undefined);
  }
});

test("使用者关掉安全分类器（settings.json 的 safetyClassifier: false）：交互形态仍包沙箱，越出沙箱的那一条改问人；管道形态什么都不装（2026-11-15）", async () => {
  const presetOf = (form: PresetForm) => ECHO_CODING.preset!(form, { credentials: new InMemoryCredentialStore() });
  const step = (params: unknown): PermissionPolicyInput => ({
    runId: "r", turnId: "t", toolCallId: "c", toolName: "bash", params, userIntent: [],
    askModel: async () => {
      throw new Error("分类器关着，产品的规则不该调模型");
    },
  });
  const off = presetOf({ interactive: true, safetyClassifier: false });
  const permission = off.agent!.permission!;
  expect([permission.responder, (await permission.authorize(step({ command: "ls" }))).kind]).toEqual(["host", "allow"]);
  expect((await permission.authorize(step({ command: "npm i -g x", sandbox: false }))).kind).toBe("ask");
  expect(off.extensions?.find((e) => e.entryId === "echo:shell")?.config).toEqual({ sandbox: true });
  expect(presetOf({ interactive: false, safetyClassifier: false }).agent?.permission).toBeUndefined();
});

/* ─────────────────────────── 可执行文件本身 ─────────────────────────── */

function spawnBin(args: string[], env: Record<string, string> = {}): { code: number; out: string; err: string } {
  const r = Bun.spawnSync(["bun", BIN, ...args], {
    env: { ...process.env, ...env },
    stdin: new Blob([""]), // 立刻 EOF，免得管道形态挂在等输入上
  });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

test("bin：--help 打的是本产品的用法（不是 echo-agent 的），退出码 0；参数错以 2 退出并附本产品的用法", () => {
  const help = spawnBin(["--help"]);
  expect(help.code).toBe(0);
  expect(help.out).toContain(usage("echo-coding").split("\n")[0]!); // 用法：echo-coding [选项]
  expect(help.out).not.toContain("用法：echo-agent");

  const bad = spawnBin(["--nope"]);
  expect(bad.code).toBe(2);
  expect(bad.err).toContain("不认识的选项");
  expect(bad.err).toContain("用法：echo-coding");
});

test("bin：管道形态缺凭据 → 退出码 1，诚实拒跑（走的确实是 echo-agent 那条启动逻辑）", () => {
  const dir = mkdtempSync(join(tmpdir(), "echo-coding-"));
  try {
    // `ECHO_HOME` 指到空目录：凭据的解析顺序是「环境变量 → 凭据文件 → 没有」，
    // 跑测试那台机器上真有 `~/.echo/credentials.json` 的话，只清环境变量不构成「缺凭据」。
    const r = spawnBin(["--state-dir", join(dir, "state")], {
      MOONSHOT_API_KEY: "",
      ECHO_LLM_API_KEY: "",
      ECHO_HOME: join(dir, "home"),
    });
    expect(r.code).toBe(1);
    expect(r.err).toContain("没有凭据");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
