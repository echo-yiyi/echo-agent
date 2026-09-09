// 会话宿主（`--serve`）与叫醒它的 runner 的判据（2026-09-07，docs/design/sessions.md §5、§7）。
//
// 这条链上每一环都只有**真进程**才验得出来：
//   · `--serve` 无界面地把一段跑起来 —— 不装壳、不读 stdin，拿到那一段的锁；
//   · 它**可被请走** —— 人在别处 `--resume` 同一段时，它把手上的活做完就让开（e48a366 那条协议）；
//   · 叫不起来时不假装成功。
//
// 用假 key：这几条一次模型都不调（收件箱是空的），要的只是让 CLI 过了「有没有凭据」那道门。

import { test, expect } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileStateLock, SessionService, FileDir } from "@echo-agent/core";
import { parseArgs } from "@echo-agent/base";

const BIN = join(import.meta.dir, "..", "bin", "echo-agent.ts");

/** 预置一段说过话的会话——一句话没说的段不落 meta，`--resume` 就找不到它。 */
async function seed(root: string, id: string): Promise<void> {
  const svc = new SessionService(new FileDir(join(root, id)));
  await svc.createOrResume(id, { workspace: process.cwd(), product: "echo-agent" });
  await svc.append(id, [
    { kind: "message", message: { role: "user", source: "human", content: [{ type: "text", text: "开场" }], at: 1 } },
  ]);
  await svc.settle();
}

function spawnServe(root: string, id: string): ReturnType<typeof Bun.spawn> {
  return Bun.spawn(["bun", BIN, "--serve", "--resume", id, "--state-dir", root, "--no-memory", "--extensions", root], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ECHO_HOME: root, MOONSHOT_API_KEY: "sk-fake-for-serve-test" },
  });
}

async function waitFor(check: () => boolean, what: string, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`等超时：${what}`);
}

test("--serve 要点名跑哪一段：不配 --resume 就报错", () => {
  // 没有这条时：`--serve` 单跑会新建一段、无界面地占着它，谁也不知道那是什么。
  expect(() => parseArgs(["--serve"], "echo-agent")).toThrow(/要点名跑哪一段/);
  expect(parseArgs(["--serve", "--resume", "s-1"], "echo-agent")?.serve).toBe(true);
  expect(parseArgs([], "echo-agent")?.serve).toBe(false);
});

test(
  "--serve：无界面地把那一段跑起来并拿到它的锁；人来请它就让开、进程退干净",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "echo-serve-"));
    await seed(root, "s-served");
    const lockPath = join(root, "s-served", ".lock");

    const child = spawnServe(root, "s-served");
    try {
      await waitFor(() => existsSync(lockPath), "宿主没拿到那一段的锁");

      // **人来了**：请它让位。这条只有对「自称可被请走」的持有者才成立——
      // `--serve` 起来的宿主正是那种，人开的会话不是。
      const lock = fileStateLock(lockPath);
      expect(await lock.requestHandoff?.({ by: "人", timeoutMs: 15_000 }), "请不动它").toBe(true);
      expect(existsSync(lockPath), "让了却没还锁").toBe(false);

      // 让完它就没事可干了：进程自己退，退干净
      expect(await child.exited).toBe(0);
    } finally {
      child.kill();
    }
  },
  60_000,
);

test(
  "--serve 起来的宿主让开之后，同一段能被正常打开——锁真的空出来了",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "echo-serve-"));
    await seed(root, "s-taken");
    const lockPath = join(root, "s-taken", ".lock");

    const child = spawnServe(root, "s-taken");
    try {
      await waitFor(() => existsSync(lockPath), "宿主没拿到锁");
      const lock = fileStateLock(lockPath);
      expect(await lock.requestHandoff?.({ by: "人", timeoutMs: 15_000 })).toBe(true);
      const mine = await lock.acquire({ holder: "人" });
      expect(mine, "让完了却还是拿不到").not.toBeNull();
      await mine!.release();
    } finally {
      child.kill();
    }
  },
  60_000,
);
