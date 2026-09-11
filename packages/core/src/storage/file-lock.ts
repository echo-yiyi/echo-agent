// first-party 的 single-writer 文件锁（D6）。**node-only**——`node:fs`，只在根入口。
//
// 底下是带递增编号的锁（`generation-lock.ts`，2026-09-10）：`path` 是一个目录，里面按代记认领与释放。
// **持有者崩溃之后，下一个来拿的人自动接管**——前提是能确认它死了（同一台机器、pid 查无此号）；
// 确认不了（别的机器、pid 被复用、记录坏了）就照旧拿不到，报错说清是谁占着、锁在哪。
//
// 2026-08-18 那一版是单个锁文件、不自动接管，因为「读 → 判陈旧 → 删 → 重建」会双授（压测第 136 次）；
// 代价是崩溃后 `--resume` 起不来、要人工删锁。新实现里当前代从不删除，接管是往上叠一代，
// 那条双授的路径不存在了（理由与判据见 `generation-lock.ts` 头注）。
//
// 可让位的交还请求写在锁目录旁边的 `<path>.handoff`：要请它走的人在另一个进程里。

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { claimGeneration, describeRecord, holderGone, inspectGeneration, type StateLockInspection } from "./generation-lock.ts";
import type { Lease, StateLock } from "./lock.ts";

export type { PeekedLockRecord, StateLockInspection } from "./generation-lock.ts";

/** 交还请求的轮询间隔。请求是人触发的、一次性的，不值得为它上 fs.watch。 */
const HANDOFF_POLL_MS = 50;

/**
 * 每 `HANDOFF_POLL_MS` 问一次 `probe`，第一次拿到非 null 就 resolve。**永不 reject**。
 *
 * `stop()` 停掉轮询，之后 promise 永远悬着（与不可让位持有者那条 `new Promise(() => {})` 同形）。
 * 没有它的话，release 之后这条链照样每 50ms 读一次盘、永不回收——`--serve` 宿主空闲退出时
 * 进程因此退不出，长驻宿主每 acquire/release 一次就多攒一条（review 2026-09-07）。
 */
function waitFor<T>(probe: () => Promise<T | null>): { readonly promise: Promise<T>; stop(): void } {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<T>((resolve) => {
    const tick = (): void => {
      timer = undefined;
      if (stopped) return;
      void probe().then(
        (v) => {
          if (stopped) return;
          if (v === null) timer = setTimeout(tick, HANDOFF_POLL_MS);
          else resolve(v);
        },
        () => {
          if (!stopped) timer = setTimeout(tick, HANDOFF_POLL_MS);
        },
      );
    };
    timer = setTimeout(tick, HANDOFF_POLL_MS);
  });
  return {
    promise,
    stop(): void {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
  };
}

/** 这把锁此刻空着吗：没人持有，或持有者确认已死（下一次 acquire 会接管）。 */
function isFree(cur: StateLockInspection): boolean {
  return cur.state === "missing" || (cur.state === "valid" && holderGone(cur.record));
}

/**
 * `path` 是锁目录，例如 `<stateDir>/.lock`。
 *
 * 活着的持有者占着 → `null`（不等待、不抢）；持有者确认已死 → 接管。`release()` 只放自己那一代。
 */
export function fileStateLock(path: string): StateLock {
  /** 交还请求：锁旁边的一个小文件。用文件而不是信号，因为要跨进程、而且要能被崩溃后清掉。 */
  const handoffPath = `${path}.handoff`;
  return {
    async acquire(opts: { holder: string; preemptible?: boolean }): Promise<Lease | null> {
      const got = await claimGeneration(path, { holder: opts.holder, ...(opts.preemptible === true ? { preemptible: true } : {}) });
      if (!got.ok) return null;
      // 上一轮别人留下的请求不该算在这一把头上：**拿到锁之后**才把旧请求擦掉。放在认领之前的话，
      // 任何一次拿不到锁的 acquire 都会先删掉别人正在等的 `.handoff`——人的让位请求被第三方的失败尝试抹掉（review 2026-09-07）
      await rm(handoffPath, { force: true }).catch(() => undefined);

      // **只有可让位的持有者才盯这个文件**：别人不该被请走，也就不该为此每秒读一次盘。
      const handoff =
        opts.preemptible === true
          ? waitFor(async () => {
              const raw = await readFile(handoffPath, "utf8").catch(() => null);
              if (raw === null) return null;
              try {
                const by = (JSON.parse(raw) as { by?: unknown }).by;
                return { by: typeof by === "string" ? by : "（没说是谁）" };
              } catch {
                return { by: "（请求文件是坏的）" }; // 坏了也算有人在等：宁可让出去，不要卡住人
              }
            })
          : null;

      return {
        release: async () => {
          // 这把租约到头了：先停 handoff 轮询，再去放锁（放不放得掉都不该再盯着 `.handoff`）
          handoff?.stop();
          // 只放自己那一代；已经不是我的、或记录读不出来时抛——调用方必须知道单写者约束可能破了
          await got.claim.release();
        },
        // 本地文件锁没有租约到期这回事：活着就一直拿着，直到 release（只有确认已死才会被接管）。
        lost: new Promise<Error>(() => {}),
        handoffRequested: handoff === null ? new Promise<{ by: string }>(() => {}) : handoff.promise,
      };
    },

    /**
     * 请当前持有者交还（2026-09-07：人优先，后台让位）。
     *
     * **只对自称 `preemptible` 的持有者生效**——不可让位的立刻返回 `false`，调用方按老规矩
     * fail-loud。这样人开的那种会话不会被后台顶掉，而后台为处理一条消息叫醒的那种临时宿主会让开。
     *
     * 请求写在锁旁边的 `<path>.handoff` 里。持有者自己在轮询它（见 `acquire`），
     * 看到就 drain 完手上的活、release。这里等锁空出来，超时就如实说没让成。
     * **不动对方的锁**——让不让是持有者自己决定的。
     */
    async requestHandoff(opts: { by: string; timeoutMs: number }): Promise<boolean> {
      const cur = await inspectGeneration(path);
      if (isFree(cur)) return true; // 已经空着（或持有者已死，acquire 会接管）
      if (cur.state !== "valid") return false; // 坏档要人来看，不是请一下就能解决的
      if (cur.record.preemptible !== true) return false;

      await mkdir(dirname(path), { recursive: true });
      await writeFile(handoffPath, JSON.stringify({ by: opts.by, at: Date.now() }));
      const deadline = Date.now() + opts.timeoutMs;
      try {
        while (Date.now() < deadline) {
          if (isFree(await inspectGeneration(path))) return true;
          await new Promise((r) => setTimeout(r, HANDOFF_POLL_MS));
        }
        return isFree(await inspectGeneration(path));
      } finally {
        // 请求是一次性的：让没让成都不该留在盘上，否则下一个持有者一上来就以为有人在等
        await rm(handoffPath, { force: true }).catch(() => undefined);
      }
    },

    /**
     * 端口的可选诊断口。`start()` 拿不到锁时用它把「是谁占着」写进报错。
     * **坏档也要说得出话**——那正是最需要人去看一眼的情形。
     */
    async describeHolder(): Promise<string | null> {
      const cur = await inspectGeneration(path);
      if (cur.state === "missing") return null;
      if (cur.state === "corrupt") return `锁 ${path} 是坏的（${cur.why}），需人工确认后删除`;
      return `${describeRecord(cur.record)}，锁 ${path}`;
    },
  };
}

/**
 * 锁被谁占着——给人看，也给会话面判「活着」（配合 `holderGone`）。不改任何东西。
 *
 * 三态照实报，不折叠：`missing`（没人持有）· `corrupt`（有但读不出/字段不全，附原因）·
 * `valid`（附当前代的记录，**持有者可能已经死了**）。折叠成 `null` 会让调用方分不清「没锁」和
 * 「锁坏了」——那曾是 `release()` 把失败报成成功的根因。
 */
export async function inspectStateLock(path: string): Promise<StateLockInspection> {
  return inspectGeneration(path);
}
