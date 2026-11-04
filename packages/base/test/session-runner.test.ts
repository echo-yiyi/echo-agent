// 叫醒一段会话的 runner（`cli.ts#sessionRunner`）：**没跑起来就不许之后再跑起来**。
//
// 契约是「resolve = 那一段已经持有自己的 lease；reject = 没跑起来」，而 reject 之后 core 会把那一段置 closed、
// 模型照这个结论重试。所以超时那一刻起的副本必须当场死透——活下来的话，它稍后拿到锁照样恢复 inbox 开干，
// 与模型重试出来的那一段干同一件事。
//
// 用一个替身进程代替真副本（注入的 spawn 起它、透传 runner 给的 spawn 选项）：它起一个孙进程、
// 过一会儿写一个「开始干活」的标记文件。判据落在进程与文件上，不落在 runner 的返回值上。

import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionRow } from "@echo-agent/core";
import { sessionRunner, type CliOptions } from "../src/cli.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "echo-runner-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** 替身：起一个孙进程（记下 pid），`workAfterMs` 之后写标记——对应真副本「稍后拿到锁、开始干活」。 */
const STAND_IN = `
const [marker, gpidFile, workAfterMs] = process.argv.slice(2);
const g = Bun.spawn(["sleep", "30"], { stdio: ["ignore", "ignore", "ignore"] });
await Bun.write(gpidFile, String(g.pid));
await Bun.sleep(Number(workAfterMs));
await Bun.write(marker, "worked");
`;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("等锁超时：runner 报没跑起来，并且那个副本连同它起的子进程当场被杀——之后不会再拿锁干活", async () => {
  const standIn = join(dir, "stand-in.ts");
  writeFileSync(standIn, STAND_IN);
  const marker = join(dir, "worked");
  const gpidFile = join(dir, "grandchild.pid");
  const spawned: { cmd: string[]; child: ReturnType<typeof Bun.spawn> }[] = [];
  const opts: CliOptions = { withoutMemory: false, extensionDirs: [], continueLast: false, serve: false, stateDir: join(dir, "sessions") };
  const runner = sessionRunner(opts, "kimi", {
    spawn: (cmd, spawnOpts) => {
      const child = Bun.spawn(["bun", standIn, marker, gpidFile, "2500"], spawnOpts);
      spawned.push({ cmd, child });
      return child;
    },
    timeoutMs: 1_000,
  });

  let error: unknown;
  try {
    await runner({ id: "s-late" } as SessionRow);
  } catch (e) {
    error = e;
  }
  expect(String(error)).toContain("没拿到锁");
  expect(spawned).toHaveLength(1);
  expect(spawned[0]!.cmd).toEqual(expect.arrayContaining(["--serve", "--resume", "s-late"]));

  // 副本死了（不是还在跑、等着之后拿锁）
  const child = spawned[0]!.child;
  expect([child.exitCode !== null || child.signalCode !== null, child.signalCode]).toEqual([true, "SIGKILL"]);
  // 它起的子进程也死了：杀的是进程组，不只是那一个 pid
  expect(existsSync(gpidFile), "替身没来得及起孙进程，判据不成立").toBe(true);
  const gpid = Number(readFileSync(gpidFile, "utf8"));
  await Bun.sleep(100);
  expect(alive(gpid), "孙进程还活着").toBe(false);
  // 过了它本来要「开始干活」的时刻，标记也没有出现
  await Bun.sleep(2_000);
  expect(existsSync(marker), "被判没跑起来的副本之后照样干了活").toBe(false);
}, 15_000);

test("副本起来就被信号杀死：runner 当场报没跑起来，不白等到超时", async () => {
  const standIn = join(dir, "dies.ts");
  writeFileSync(standIn, `await Bun.sleep(50);\nprocess.kill(process.pid, "SIGTERM");\nawait Bun.sleep(10_000);\n`);
  const opts: CliOptions = { withoutMemory: false, extensionDirs: [], continueLast: false, serve: false, stateDir: join(dir, "sessions") };
  const runner = sessionRunner(opts, "kimi", { spawn: (_cmd, spawnOpts) => Bun.spawn(["bun", standIn], spawnOpts), timeoutMs: 8_000 });
  const t0 = Date.now();
  let error: unknown;
  try {
    await runner({ id: "s-dies" } as SessionRow);
  } catch (e) {
    error = e;
  }
  expect(String(error)).toContain("signal SIGTERM");
  expect(Date.now() - t0).toBeLessThan(3_000);
}, 15_000);
