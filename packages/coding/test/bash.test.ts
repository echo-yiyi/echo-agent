// bash 工具的判据：起什么 shell、给子进程什么环境、`cmd &` 怎么收尾、运行环境怎么进 prompt。
// 直接调工具对象（不经装配）。

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolExecutionContext } from "@echo-agent/core";
import { detectShellEnvironment, makeBashTool } from "../src/tools/bash.ts";
import { SHELL_TOOLS, shellToolsSection } from "../src/prompt.ts";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "echo-bash-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const ctx = (): ToolExecutionContext => ({ toolCallId: "t1", workspace: root, sessionId: null, iteration: 0 });

/** 起一个子进程时改一下父进程的环境变量，测完还原。 */
async function withEnv<T>(vars: Record<string, string>, run: () => Promise<T>): Promise<T> {
  const before = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try {
    return await run();
  } finally {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("bash 不是登录 shell：环境原样继承父进程，PATH 不被 profile / path_helper 重排", async () => {
  const bash = makeBashTool();
  const r = await withEnv({ ECHO_BASH_PROBE: "inherited" }, () =>
    bash.execute({ command: 'shopt -q login_shell && echo login || echo not-login; echo "$ECHO_BASH_PROBE"; printf %s "$PATH"' }, ctx()),
  );
  expect(r.isError).toBe(false);
  expect(r.content).toBe(`not-login\ninherited\n${process.env.PATH}`);
});

test("会拉起编辑器 / 分页器 / 凭据提示的命令不挂：git commit 不带 -m 立刻因空消息中止；子进程环境里关掉了它们", async () => {
  const bash = makeBashTool();
  const init = await bash.execute({ command: "git init -q && git config user.email a@b.c && git config user.name t && echo x > f && git add f" }, ctx());
  expect(init.isError).toBe(false);
  // 父进程里的编辑器是一个会一直等下去的命令（git 把消息文件路径接在后面，`; true` 吃掉它）：不覆盖它，commit 就挂到超时
  const t0 = Date.now();
  const r = await withEnv({ GIT_EDITOR: "sleep 30; true", EDITOR: "sleep 30; true" }, () =>
    bash.execute({ command: "git commit", timeout_ms: 5_000 }, ctx()),
  );
  expect(Date.now() - t0).toBeLessThan(3_000);
  expect([r.isError, r.content]).toEqual([true, expect.stringContaining("empty commit message")]);
  const env = await bash.execute({ command: 'echo "$GIT_EDITOR|$GIT_PAGER|$PAGER|$GH_PAGER|$GIT_TERMINAL_PROMPT"' }, ctx());
  expect(env.content.trimEnd()).toBe("true|cat|cat|cat|0");
}, 15_000);

test("`cmd &` 不让前台等到超时：主进程退出后短暂排空就返回、说明有后台进程攥着输出；不杀它；cd 照常记住", async () => {
  await mkdir(join(root, "sub"));
  const bash = makeBashTool();
  const t0 = Date.now();
  const r = await bash.execute({ command: 'cd sub; sleep 30 & echo "pid=$!"', timeout_ms: 8_000 }, ctx());
  const took = Date.now() - t0;
  const pid = Number(/pid=(\d+)/.exec(r.content)?.[1]);
  try {
    expect(took).toBeLessThan(3_000);
    expect(r.isError).toBe(false);
    expect(r.content).toContain("background process");
    expect(r.content).toContain("background: true");
    expect(r.content).toContain(`(working directory is now ${join(root, "sub")})`);
    expect(r.content).not.toContain("\u001e"); // cwd 标记不漏进正文
    expect(() => process.kill(pid, 0)).not.toThrow(); // 后台的 sleep 还活着
  } finally {
    if (Number.isFinite(pid)) process.kill(pid, "SIGKILL");
  }
}, 15_000);

test("后台子进程在排空窗口里写完退出：它的输出照收，不报「攥着输出」，cwd 标记不漏进正文", async () => {
  const bash = makeBashTool();
  const r = await bash.execute({ command: "(sleep 0.02; echo late) & echo early" }, ctx());
  expect([r.isError, r.content]).toEqual([false, "early\nlate\n"]);
});

test("运行环境（平台、bash 版本）装配时取一次，写进 tool:shell 段；macOS 写明 BSD 工具链与 bash 3 的缺口", async () => {
  const env = detectShellEnvironment();
  expect(env.platform).toBe(process.platform);
  const real = Bun.spawnSync(["bash", "-c", 'printf %s "$BASH_VERSION"']).stdout.toString();
  expect(real.startsWith(env.bashVersion ?? "")).toBe(true);
  expect(env.bashVersion).toMatch(/^\d+\.\d+/);

  const mac = shellToolsSection({ platform: "darwin", bashVersion: "3.2.57" }).render(undefined as never) as string;
  expect(mac).toContain("bash 3.2.57 on macOS");
  expect(mac).toContain("sed -i ''");
  expect(mac).toContain("mapfile");
  const linux = shellToolsSection({ platform: "linux", bashVersion: "5.2.21" }).render(undefined as never) as string;
  expect(linux).toContain("bash 5.2.21 on Linux");
  expect(linux).not.toContain("mapfile");
  const unknown = shellToolsSection({ platform: "linux", bashVersion: null }).render(undefined as never) as string;
  expect(unknown).toContain("bash on Linux");
  // 段的正文其余部分与常量一致：环境那句只是接在后面
  expect(linux.startsWith(SHELL_TOOLS)).toBe(true);
});

test("bash 的 description 与 tool:shell 段说清：没有 TTY、stdin 已关要用非交互参数；读写搜文件用文件工具；长跑进程用 background 不用 &", () => {
  const description = makeBashTool().description;
  for (const text of [description, SHELL_TOOLS]) {
    expect(text).toContain("stdin is closed");
    expect(text).toContain("non-interactive");
    expect(text).toContain("read_file");
    expect(text).toContain("edit_file");
    expect(text).toContain("background: true");
  }
  expect(description).toContain("not a login shell");
});
