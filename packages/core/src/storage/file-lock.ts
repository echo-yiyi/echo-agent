// first-party 的 single-writer 文件锁（D6）。**node-only**——`node:fs`，只在根入口。
//
// 用 `open(path, "wx")`：这是文件系统给的**原子 create-if-absent**，正是 `StorageDir`
// 没有、因而要单独立 `StateLock` 端口的那件事。
//
// ## 不做自动 stale takeover（2026-08-18 定，此前做过，**并发压测下会双授**）
//
// 曾经的实现是「锁在 → 读它 → pid 死了或文件坏了就 rm 再抢」。两个致命问题：
//
//   ① **read → rm → create 之间没有任何互斥**：两个进程可以同时判定 stale、同时 rm、
//      同时 create——`open(…, "wx")` 只保证「创建那一刻」原子，挡不住这条三步链。
//      实测（review 压测）第 136 次并发就出现两个调用同时拿到 Lease。
//   ② **「锁文件刚创建但还没写完」会被误判成坏档**：持有者 `open` 成功、`writeFile` 尚未落，
//      此刻另一个进程读到空内容 → `JSON.parse` 抛 → 当成 stale 删掉。
//      把「坏档」与「正在写」混为一谈，等于给正常竞争开了一道门。
//
// **加随机 token 解决不了**：TOCTOU 在于「判定与删除之间状态会变」，不在于名字撞不撞。
//
// 所以 V0 的选择是：**锁在就拒绝，绝不抢占**。这与 core 侧口径一致
// （「`acquire` 返回 `null` 就 fail-loud，core 不猜对面是不是死了」）——现在实现侧也不猜。
// 代价是崩溃后要人工删锁文件，所以报错信息里写清了是谁、在哪、怎么清。
// 真要自动接管，得用带内核仲裁的 advisory lock（`flock`/`fcntl`）或远程租约，
// 那是另一个实现，不是在这段逻辑上打补丁。

import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import type { Lease, StateLock } from "./lock.ts";

/** 锁文件里记的东西——报错时要能说清「是谁占着」。**我们写出去的一定四个字段都全**。 */
type LockRecord = {
  readonly holder: string;
  readonly pid: number;
  readonly at: number;
  /**
   * 这把锁的身份。**`pid + at` 不够**：pid 会被复用，`at` 只有毫秒精度，
   * 同一毫秒内起的两个进程可以撞成同一对，于是 A 的 `release()` 会把 B 的锁删掉。
   * 随机 token 让「这把是不是我的」变成一个确定的判断。
   */
  readonly token: string;
};

/**
 * 读锁文件的结果。**三态，不是「有/没有」**。
 *
 * 折叠成一个 `null` 是上一版的 P1 根因：`release()` 见 null 就直接成功返回，于是
 * 「锁文件坏了、我删不掉它」被报告成「已释放」——实测把持有中的锁文件改成 `{}`，
 * `release()` resolved、锁文件仍在、下一个 `acquire()` **永久拿不到**。
 * 这恰好绕过了刚补的「release 失败时 stop() 必须抛」。
 */
/**
 * 盘上读回来的记录。**`token` 是可选的**，而我们自己写的（`LockRecord`）一定有。
 *
 * 这个不对称是有意的：验形分两件事——「说得出话吗」（holder/pid/at，给人看的）与
 * 「是不是我的」（token，严格相等）。把 token 也算进验形，会让一份**只是没有 token**
 * 的记录整份作废，人就再也看不到 holder 是谁了——而那正是最需要看的时候。
 * 缺 token 的记录在所有权比较里天然不等于任何 token，照样删不得。
 */
export type PeekedLockRecord = {
  readonly holder: string;
  readonly pid: number;
  readonly at: number;
  readonly token?: string;
};

export type StateLockInspection =
  | { readonly state: "missing" }
  | { readonly state: "corrupt"; readonly why: string }
  | { readonly state: "valid"; readonly record: PeekedLockRecord };

function isPeekedRecord(v: unknown): v is PeekedLockRecord {
  const r = v as Record<string, unknown> | null;
  return (
    typeof r === "object" &&
    r !== null &&
    typeof r["holder"] === "string" &&
    typeof r["pid"] === "number" &&
    typeof r["at"] === "number" &&
    Number.isFinite(r["at"]) &&
    (r["token"] === undefined || typeof r["token"] === "string")
  );
}

async function peek(path: string): Promise<StateLockInspection> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (e) {
    if ((e as { code?: string }).code === "ENOENT") return { state: "missing" };
    // 读失败（权限、IO）**不是「没有」**——当成没有就会把删不掉报成删掉了
    return { state: "corrupt", why: `读不出来：${(e as Error).message}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { state: "corrupt", why: `解不开：${(e as Error).message}` };
  }
  // 字段也要验形：`{}` 能 parse，但 `new Date(undefined)` 会让诊断抛 RangeError（实测）
  if (!isPeekedRecord(parsed)) return { state: "corrupt", why: "缺 holder / pid / at（或类型不对）" };
  return { state: "valid", record: parsed };
}

/**
 * `path` 是锁文件本身（不是目录），例如 `<stateDir>/.lock`。
 *
 * **拿不到就是拿不到**：不接管、不重试、不等待。`release()` 只删自己那把。
 */
export function fileStateLock(path: string): StateLock {
  return {
    async acquire(opts: { holder: string }): Promise<Lease | null> {
      await mkdir(dirname(path), { recursive: true });
      const record: LockRecord = { holder: opts.holder, pid: process.pid, at: Date.now(), token: randomUUID() };

      let fh: Awaited<ReturnType<typeof open>>;
      try {
        // 原子 create-if-absent。已存在 → EEXIST → 直接放弃，**不看里面写了什么**。
        fh = await open(path, "wx");
      } catch (e) {
        if ((e as { code?: string }).code === "EEXIST") return null;
        throw e;
      }

      try {
        await fh.writeFile(JSON.stringify(record));
      } catch (e) {
        // 内容没写成，锁文件却已经建出来了——留着它会变成谁也拿不到的死锁。
        // 这一路是我们自己建的，删它是安全的。
        await fh.close().catch(() => undefined);
        await rm(path, { force: true }).catch(() => undefined);
        throw e;
      }
      await fh.close();

      return {
        release: async () => {
          // **只删 token 对得上的那把，且删不掉必须说出来。** 三态各有各的归宿：
          //   missing → 没什么可清的，正常返回（release 是终点，重复调不该炸）
          //   corrupt → **不删**（可能是别人正在写它），但**抛**：锁还在盘上，
          //             下一个 acquire 会永久拿不到，调用方必须知道
          //   token 不匹配 → 这把已经是别人的了，单写已经破了，更要抛
          // 用 token 而不是 `pid + at`：后者会撞（pid 复用、同毫秒），撞了就删掉别人的锁。
          const cur = await peek(path);
          if (cur.state === "missing") return;
          if (cur.state === "corrupt") {
            throw new Error(`锁文件 ${path} ${cur.why}——没有删除它（可能是别人的），需人工确认`);
          }
          if (cur.record.token !== record.token) {
            throw new Error(
              `锁文件 ${path} 现在属于 holder=${cur.record.holder} pid=${cur.record.pid}，不是我这把——` +
                `没有删除它。单写者约束可能已经被破坏，需人工确认`,
            );
          }
          await rm(path, { force: true });
        },
        // 本地文件锁没有租约到期这回事：拿住了就一直拿着，直到 release。
        lost: new Promise<Error>(() => {}),
      };
    },

    /**
     * 端口的可选诊断口。`start()` 拿不到锁时用它把「是谁占着」写进报错。
     * **坏档也要说得出话**——那正是最需要人去看一眼的情形；此前 `{}` 会让这里
     * `new Date(undefined)` 抛 RangeError，报错反被诊断代码盖掉。
     */
    async describeHolder(): Promise<string | null> {
      const cur = await peek(path);
      if (cur.state === "missing") return null;
      if (cur.state === "corrupt") return `锁文件 ${path} 是坏的（${cur.why}），需人工确认后删除`;
      const { holder, pid, at } = cur.record;
      return `holder=${holder} pid=${pid} 自 ${new Date(at).toISOString()} 起，锁文件 ${path}`;
    },
  };
}

/**
 * 锁被谁占着——**只用于给人看的诊断**，不参与任何取舍判断。
 *
 * 三态照实报，不折叠：`missing`（没有锁）· `corrupt`（有但读不出/字段不全，附原因）·
 * `valid`（附记录）。折叠成 `null` 会让调用方分不清「没锁」和「锁坏了删不掉」——
 * 那正是上一版 `release()` 把失败报成成功的根因。
 *
 * 从根入口导出：不接管的代价是「崩溃后人工删锁」，而人工删锁的前提是看得见是谁占着。
 */
export async function inspectStateLock(path: string): Promise<StateLockInspection> {
  return peek(path);
}
