// 带递增编号的锁（generation lock，2026-09-10）：session 的 lease（`file-lock.ts`）与记忆的提交锁
// （`FileDir.lock`）共用这一个实现。**node-only**。
//
// ## 盘上的样子
//
// 一把锁是一个目录，里面只有三种文件：
//   · `g<n>`：第 n 代的认领记录（holder / pid / host / at / token）。**当前代 = 最大的 n**。
//   · `r<n>`：第 n 代已释放。
//   · `t-<pid>-<token>`：认领前先写的临时文件（正常情况下 link 完立刻删）。
//
// ## 怎么拿、为什么不会双授
//
// 看当前代 m：一代都没有、`r<m>` 在、或 `g<m>` 的持有者**确认已死**，就认领 `g<m+1>`；否则拿不到。
// 认领 = 写临时文件并 fsync → `link` 成 `g<m+1>`。`link` 是文件系统给的原子「不存在才建」，名字出现
// 的那一刻内容已经完整：几个人同时接管同一个死掉的持有者，只有一个 link 成功，其余 EEXIST。
//
// 2026-08-18 的单文件锁不敢自动接管，是因为接管得「读 → 判陈旧 → **删** → 重建」，删与建之间没有
// 互斥（压测第 136 次双授），而且「刚建好还没写完」会被误判成坏档删掉。这里两件都不存在：
// **当前代从来不删**，接管是往上叠一代；内容先写好再 link。
//
// link 成功后再看一遍，两件都成立才算拿到：没有比我大的代（否则我是凭过期的观察叠上去的——只有
// 旧代被清理掉之后才 link 得成）；我据以判断的那条 `g<m>` 原样还在（否则目录被整个删掉重建过）。
// 不成立就把自己这一代标成已释放，重来。
//
// ## 「确认已死」只有一种
//
// 记录里的 host 是本机，且 `process.kill(pid, 0)` 报 ESRCH。EPERM（进程在、只是不归我们管）、别的机器、
// 没写 host 的记录、读不出来的记录，一律当活着——判错的方向只许是「多等」，不许是「两个写者」。
// 代价：共享盘上别的机器崩掉留下的锁、pid 恰好已被别的进程复用的锁，照旧要人确认后删掉锁目录。
//
// ## 清理
//
// 认领到第 n 代的人删掉 n-2 代及更早的 `g`/`r`（它们的持有者一定已经释放或确认死了；上一代留着，
// 报错时看得见交接），以及 pid 已死的临时文件。

import { randomUUID } from "node:crypto";
import { link, mkdir, open, readdir, readFile, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";

/** 认领记录。我们写出去的一定字段都全。 */
export type ClaimRecord = {
  readonly holder: string;
  readonly pid: number;
  /** 持有者所在的机器。「确认已死」只在同一台机器上判得了。 */
  readonly host: string;
  readonly at: number;
  /** 这一代的身份：release 只认它（pid 会复用、`at` 只有毫秒精度会撞）。 */
  readonly token: string;
  /** 可不可以被请走（lease 的交还要从盘上看出来）。不写 = 不可以。 */
  readonly preemptible?: boolean;
};

/**
 * 盘上读回来的认领记录。**诊断字段（holder / pid / at）必须齐，所有权字段可以缺**：
 * 缺 token 的记录照样说得出是谁占着，只是在所有权比较里不等于任何 token；缺 host 的记录
 * 永远不会被判成已死。
 */
export type PeekedLockRecord = {
  /** 这个持有者可不可以被请走。没有这个字段 = 不可以（缺省最保守）。 */
  readonly preemptible?: boolean;
  readonly holder: string;
  readonly pid: number;
  readonly at: number;
  readonly token?: string;
  /** 持有者所在的机器。没有 = 判不了死活，一律当活着。 */
  readonly host?: string;
};

/**
 * 锁此刻的样子，三态照实报、不折叠：`missing`（没人持有）· `corrupt`（当前代的记录读不出或字段不全，
 * 附原因）· `valid`（附当前代的记录——**持有者可能已经死了**，要不要当它活着由调用方用 `holderGone` 判）。
 */
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
    Number.isInteger(r["pid"]) &&
    (r["pid"] as number) > 0 && // 0 / 负数 / 小数不是进程号：`process.kill(0, 0)` 会成功，会被探活判成活着（review 2026-09-09）
    typeof r["at"] === "number" &&
    Number.isFinite(r["at"]) &&
    (r["token"] === undefined || typeof r["token"] === "string") &&
    (r["host"] === undefined || typeof r["host"] === "string")
  );
}

/**
 * 持有者**确认已经不在了**吗。只有一种情形算：记录里的 host 是本机，且进程表里查无此号（ESRCH）。
 * EPERM（进程在、只是不归我们管）、别的机器、没写 host、其它错误，一律 `false`——判错只许往「还活着」那边错。
 */
export function holderGone(record: { readonly pid: number; readonly host?: string }): boolean {
  return record.host === hostname() && pidGone(record.pid);
}

function pidGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (e) {
    return (e as { code?: string }).code === "ESRCH";
  }
}

/** 给人看的一句：谁、哪个进程、从什么时候起。 */
export function describeRecord(record: PeekedLockRecord): string {
  const since = new Date(record.at);
  return (
    `holder=${record.holder} pid=${record.pid}` +
    (record.host !== undefined ? ` host=${record.host}` : "") +
    (Number.isNaN(since.getTime()) ? "" : ` 自 ${since.toISOString()} 起`)
  );
}

const GEN_NAME = /^([gr])([1-9]\d*)$/;
const TEMP_NAME = /^t-(\d+)-/;

function scan(names: readonly string[]): { readonly max: number; readonly released: ReadonlySet<number> } {
  let max = 0;
  const released = new Set<number>();
  for (const name of names) {
    const m = GEN_NAME.exec(name);
    if (m === null) continue;
    const k = Number(m[2]);
    if (m[1] === "g") max = Math.max(max, k);
    else released.add(k);
  }
  return { max, released };
}

type Raw = { readonly kind: "text"; readonly text: string } | { readonly kind: "missing" } | { readonly kind: "error"; readonly why: string };

async function readRaw(path: string): Promise<Raw> {
  try {
    return { kind: "text", text: await readFile(path, "utf8") };
  } catch (e) {
    if ((e as { code?: string }).code === "ENOENT") return { kind: "missing" };
    return { kind: "error", why: (e as Error).message };
  }
}

/** 一次观察。`basis` 是当前代记录的原文（一代都没有时为 `null`），认领之后拿它复核「我看到的那一代还是那一代」。 */
type Observation =
  | { readonly kind: "free"; readonly gen: number; readonly basis: string | null }
  | { readonly kind: "gone"; readonly gen: number; readonly basis: string; readonly record: PeekedLockRecord }
  | { readonly kind: "held"; readonly gen: number; readonly record: PeekedLockRecord }
  | { readonly kind: "corrupt"; readonly why: string };

/** 看一眼。`null` = 列出来的当前代读的时候已经被清理掉了（观察过期），重看即可。 */
async function observe(dir: string): Promise<Observation | null> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "ENOENT") return { kind: "free", gen: 0, basis: null };
    if (code === "ENOTDIR") return { kind: "corrupt", why: "这是旧版本的单文件锁：确认里面记的进程已经不在了之后删掉它" };
    return { kind: "corrupt", why: `读不出来：${(e as Error).message}` };
  }
  const { max, released } = scan(names);
  if (max === 0) return { kind: "free", gen: 0, basis: null };
  const raw = await readRaw(join(dir, `g${max}`));
  if (raw.kind === "missing") return null;
  if (released.has(max)) return { kind: "free", gen: max, basis: raw.kind === "text" ? raw.text : null };
  if (raw.kind === "error") return { kind: "corrupt", why: `读不出来：${raw.why}` };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.text);
  } catch (e) {
    return { kind: "corrupt", why: `解不开：${(e as Error).message}` };
  }
  // 字段也要验形：`{}` 能 parse，但 `new Date(undefined)` 会让诊断抛 RangeError（实测）
  if (!isPeekedRecord(parsed)) return { kind: "corrupt", why: "缺 holder / pid / at（或类型不对）" };
  if (holderGone(parsed)) return { kind: "gone", gen: max, basis: raw.text, record: parsed };
  return { kind: "held", gen: max, record: parsed };
}

/** 观察过期、或认领一直被别人抢先时重来的上限。正常一两轮就定；转满说明局面异常，报错而不是无限转。 */
const MAX_ROUNDS = 1000;

/** 已经拿到的那一代。 */
export type Claim = {
  readonly gen: number;
  readonly record: ClaimRecord;
  /**
   * 释放：写上 `r<gen>`。重复调是空操作；锁目录已经不在也正常返回（没什么可放的）。
   * **这一代已经不是我的**（token 对不上、上面叠了更大的代）或记录读不出来时**抛**，不动它——
   * 调用方必须知道单写者约束可能已经破了。
   */
  release(): Promise<void>;
};

/** 一次拿锁的结果。拿不到时 `seen` 说明是谁占着（或锁坏了），给人看的。 */
export type ClaimResult =
  | { readonly ok: true; readonly claim: Claim }
  | { readonly ok: false; readonly seen: { readonly kind: "held"; readonly record: PeekedLockRecord } | { readonly kind: "corrupt"; readonly why: string } };

/**
 * 试拿一次，**不等持有者**：活着的持有者占着、或当前代的记录坏了，就返回 `ok: false`。
 * 持有者确认已死就接管（叠一代）。撞上别人同时认领会重看——那是看清局面，不是在等持有者。
 */
export async function claimGeneration(dir: string, who: { holder: string; preemptible?: boolean }): Promise<ClaimResult> {
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const seen = await observe(dir);
    if (seen === null) continue;
    if (seen.kind === "held") return { ok: false, seen: { kind: "held", record: seen.record } };
    if (seen.kind === "corrupt") return { ok: false, seen };
    const gen = seen.gen + 1;
    const record: ClaimRecord = {
      holder: who.holder,
      pid: process.pid,
      host: hostname(),
      at: Date.now(),
      token: randomUUID(),
      ...(who.preemptible === true ? { preemptible: true } : {}),
    };
    if (!(await linkClaim(dir, gen, record))) continue; // 这一代被别人先认领了（或目录刚被删）：重看
    if (await confirmClaim(dir, gen, seen.basis)) {
      await sweep(dir, gen);
      return { ok: true, claim: claimOf(dir, gen, record) };
    }
    await markReleased(dir, gen); // 凭过期的观察叠上去的：这一代作废——标成已释放，不删
  }
  throw new Error(`锁 ${dir} 一直在变，${MAX_ROUNDS} 轮都没拿定`);
}

/** 写好内容、fsync，再 link 成 `g<gen>`。`false` = 这一代已经有人了（或目录刚被删掉）。 */
async function linkClaim(dir: string, gen: number, record: ClaimRecord): Promise<boolean> {
  await mkdir(dir, { recursive: true });
  const temp = join(dir, `t-${process.pid}-${record.token}`);
  try {
    const fh = await open(temp, "wx");
    try {
      await fh.writeFile(JSON.stringify(record));
      await fh.sync(); // 断电之后，名字在、内容却是空的，那才是真坏档
    } finally {
      await fh.close();
    }
    await link(temp, join(dir, `g${gen}`));
    return true;
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "EEXIST" || code === "ENOENT") return false;
    throw e;
  } finally {
    await unlink(temp).catch(() => undefined);
  }
}

/** 认领之后复核：我是最大的一代，且我据以判断的上一代原样还在。 */
async function confirmClaim(dir: string, gen: number, basis: string | null): Promise<boolean> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return false;
  }
  if (scan(names).max !== gen) return false;
  if (gen === 1) return true;
  const prev = await readRaw(join(dir, `g${gen - 1}`));
  return (prev.kind === "text" ? prev.text : null) === basis;
}

async function markReleased(dir: string, gen: number): Promise<void> {
  try {
    await (await open(join(dir, `r${gen}`), "wx")).close();
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code !== "EEXIST" && code !== "ENOENT") throw e; // 已经标过 / 目录已不在：都算放掉了
  }
}

/** 认领到第 `gen` 代的人顺手清：n-2 代及更早的记录，pid 已死的临时文件。清不掉不影响正确性。 */
async function sweep(dir: string, gen: number): Promise<void> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const g = GEN_NAME.exec(name);
    const t = g === null ? TEMP_NAME.exec(name) : null;
    const stale = g !== null ? Number(g[2]) <= gen - 2 : t !== null && Number(t[1]) !== process.pid && pidGone(Number(t[1]));
    if (stale) await unlink(join(dir, name)).catch(() => undefined);
  }
}

function claimOf(dir: string, gen: number, record: ClaimRecord): Claim {
  return {
    gen,
    record,
    async release(): Promise<void> {
      let names: string[];
      try {
        names = await readdir(dir);
      } catch (e) {
        if ((e as { code?: string }).code === "ENOENT") return;
        throw e;
      }
      const { max, released } = scan(names);
      if (released.has(gen)) return;
      if (max > gen) {
        const now = await observe(dir);
        const who = now !== null && (now.kind === "held" || now.kind === "gone") ? describeRecord(now.record) : "持有者不明";
        throw new Error(`锁 ${dir} 现在属于 ${who}（第 ${max} 代），不是我这把（第 ${gen} 代）——没有动它。单写者约束可能已经被破坏，需人工确认`);
      }
      const raw = await readRaw(join(dir, `g${gen}`));
      if (raw.kind === "missing") return; // 记录被外力删了：没什么可放的
      if (raw.kind === "error") throw new Error(`锁 ${dir} 第 ${gen} 代的记录读不出来（${raw.why}）——没有释放它，需人工确认`);
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.text);
      } catch (e) {
        throw new Error(`锁 ${dir} 第 ${gen} 代的记录解不开（${(e as Error).message}）——没有释放它，需人工确认`);
      }
      if ((parsed as { token?: unknown } | null)?.token !== record.token) {
        const who = isPeekedRecord(parsed) ? describeRecord(parsed) : "一份字段不全的记录";
        throw new Error(`锁 ${dir} 第 ${gen} 代现在属于 ${who}，不是我这把——没有释放它。单写者约束可能已经被破坏，需人工确认`);
      }
      await markReleased(dir, gen);
    },
  };
}

/** 锁此刻的样子（给人看、给会话面判活着用）。不改任何东西。 */
export async function inspectGeneration(dir: string): Promise<StateLockInspection> {
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const seen = await observe(dir);
    if (seen === null) continue;
    if (seen.kind === "free") return { state: "missing" };
    if (seen.kind === "corrupt") return { state: "corrupt", why: seen.why };
    return { state: "valid", record: seen.record };
  }
  throw new Error(`锁 ${dir} 一直在变，${MAX_ROUNDS} 轮都没看清`);
}
