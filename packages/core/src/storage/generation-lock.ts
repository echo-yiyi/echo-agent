// 带递增编号的锁（generation lock，2026-09-10）：session 的 lease（`file-lock.ts`）与记忆的提交锁
// （`FileDir.lock`）共用这一个实现。**node-only**。
//
// ## 盘上的样子
//
// 一把锁是一个目录，里面只有三种文件：
//   · `g<n>`：第 n 代的认领记录（holder / pid / host / at / beat / token）。**当前代 = 最大的 n**。
//   · `r<n>`：第 n 代已释放。
//   · `t-<pid>-<token>…`：认领或刷心跳前先写的临时文件（正常情况下 link / rename 完就没了）。
//
// ## 怎么拿、为什么不会双授
//
// 看当前代 m：一代都没有、`r<m>` 在、或 `g<m>` 的持有者**已经不在了**，就认领 `g<m+1>`；否则拿不到。
// 认领 = 写临时文件并 fsync → `link` 成 `g<m+1>`。`link` 是文件系统给的原子「不存在才建」，名字出现
// 的那一刻内容已经完整：几个人同时接管同一个死掉的持有者，只有一个 link 成功，其余 EEXIST。
//
// link 成功后再看一遍，两件都成立才算拿到：没有比我大的代；我据以判断的那条 `g<m>` 原样还在（持有者
// 在此期间刷过心跳 = 它还活着，或者目录被整个删掉重建过）。不成立就把自己这一代标成已释放，重来。
//
// ## 心跳与「已经不在了」（2026-11-15）
//
// 持有期间每 `LOCK_BEAT_MS` 把自己那一代的 `beat` 刷成此刻（写临时文件、rename 回 `g<n>`）。刷之前先看
// 一眼：上面已经叠了更大的代、或自己那一代的记录不见了 / 换了人，就是**被接管了**——`Claim.lost` 带着
// 原因 resolve，不再刷。持有方据此停手（session 那边是 `Agent` 的丢锁善后）。
//
// 「已经不在了」两种都算：心跳超过 `LOCK_STALE_MS` 没刷；或者记录里的 host 是本机且 pid 查无此号（ESRCH，
// 刚崩的进程不必干等心跳过期）。此前（2026-09-10）只认后一种，机器名与 pid 在两种常见情形下都立不住：
// macOS 没设固定主机名时随网络变（实测 `hainans-MacBook-Pro.local` → `Mac.lan`），沙箱重建后主机名与 pid
// 也都换了——崩掉的会话从此续不上。没有 `beat` 的旧记录只能按后一种判。
//
// ## 强行接管
//
// `claimGeneration(…, { force: true })` 不管持有者活没活，照样叠一代（显式续会话用，`StateLock.takeOver`）。
// 活着的持有者在下一次刷心跳前看见更大的代、丢锁停手；这之间（至多一个 `LOCK_BEAT_MS`）它可能还写进一条。
// 当前代的记录坏了也照样叠上去；旧版本留下的单文件锁先挪到一边（`<锁>.legacy-<时刻>`）再认领。
//
// ## 清理
//
// 认领到第 n 代的人删掉 n-2 代及更早的 `g`/`r`（上一代留着，报错时看得见交接），以及 pid 已死的临时文件。

import { randomUUID } from "node:crypto";
import { link, mkdir, open, readdir, readFile, rename, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";

/** 持有者多久刷一次心跳。 */
export const LOCK_BEAT_MS = 2_000;
/** 心跳多久没刷就算持有者已经不在了：容得下几次刷心跳被事件循环耽搁。 */
export const LOCK_STALE_MS = 10_000;

/** 认领记录。我们写出去的一定字段都全。 */
export type ClaimRecord = {
  readonly holder: string;
  readonly pid: number;
  /** 持有者所在的机器（给人看；本机且 pid 查无此号时可以不等心跳过期就判它不在了）。 */
  readonly host: string;
  /** 认领的时刻。 */
  readonly at: number;
  /** 最近一次心跳（2026-11-15）。超过 `LOCK_STALE_MS` 没刷 = 持有者已经不在了。 */
  readonly beat: number;
  /** 这一代的身份：release 只认它（pid 会复用、`at` 只有毫秒精度会撞）。 */
  readonly token: string;
  /** 可不可以被请走（lease 的交还要从盘上看出来）。不写 = 不可以。 */
  readonly preemptible?: boolean;
};

/**
 * 盘上读回来的认领记录。**诊断字段（holder / pid / at）必须齐，所有权字段可以缺**：
 * 缺 token 的记录照样说得出是谁占着，只是在所有权比较里不等于任何 token；缺 beat（2026-11-15 之前写的）
 * 的记录只能按「本机且 pid 查无此号」判死活。
 */
export type PeekedLockRecord = {
  /** 这个持有者可不可以被请走。没有这个字段 = 不可以（缺省最保守）。 */
  readonly preemptible?: boolean;
  readonly holder: string;
  readonly pid: number;
  readonly at: number;
  /** 最近一次心跳。没有 = 旧版本写的，判不了心跳过期。 */
  readonly beat?: number;
  readonly token?: string;
  /** 持有者所在的机器。 */
  readonly host?: string;
};

/**
 * 锁此刻的样子，三态照实报、不折叠：`missing`（没人持有）· `corrupt`（当前代的记录读不出或字段不全，
 * 附原因）· `valid`（附当前代的记录与它的持有者**此刻还在不在**——`alive: false` 的下一次 acquire 就会接管）。
 */
export type StateLockInspection =
  | { readonly state: "missing" }
  | { readonly state: "corrupt"; readonly why: string }
  | { readonly state: "valid"; readonly record: PeekedLockRecord; readonly alive: boolean };

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
    (r["beat"] === undefined || (typeof r["beat"] === "number" && Number.isFinite(r["beat"]))) &&
    (r["token"] === undefined || typeof r["token"] === "string") &&
    (r["host"] === undefined || typeof r["host"] === "string")
  );
}

/**
 * 持有者**已经不在了**吗。两种都算：心跳超过 `LOCK_STALE_MS` 没刷；或者记录里的 host 是本机、且进程表里
 * 查无此号（ESRCH）——刚崩掉的进程不必干等心跳过期。其余（心跳新鲜、EPERM、没有心跳的旧记录在别的机器上）一律当活着。
 */
export function holderGone(record: { readonly pid: number; readonly host?: string; readonly beat?: number }, now: number = Date.now()): boolean {
  if (record.beat !== undefined && now - record.beat >= LOCK_STALE_MS) return true;
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

/** 给人看的一句：谁、哪个进程、从什么时候起、最近一次心跳在多久之前。 */
export function describeRecord(record: PeekedLockRecord, now: number = Date.now()): string {
  const since = new Date(record.at);
  return (
    `holder=${record.holder} pid=${record.pid}` +
    (record.host !== undefined ? ` host=${record.host}` : "") +
    (Number.isNaN(since.getTime()) ? "" : ` 自 ${since.toISOString()} 起`) +
    (record.beat !== undefined ? `，${Math.max(0, Math.round((now - record.beat) / 1000))} 秒前还有心跳` : "")
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

/**
 * 一次观察。`basis` 是当前代记录的原文（一代都没有、或读不出来时为 `null`），认领之后拿它复核「我看到的那一代还是那一代」。
 * `corrupt` 带上强行接管要用的东西：当前代是第几代（目录读得出来时），或者这是一把旧版本的单文件锁。
 */
type Observation =
  | { readonly kind: "free"; readonly gen: number; readonly basis: string | null }
  | { readonly kind: "gone"; readonly gen: number; readonly basis: string; readonly record: PeekedLockRecord }
  | { readonly kind: "held"; readonly gen: number; readonly basis: string; readonly record: PeekedLockRecord }
  | { readonly kind: "corrupt"; readonly why: string; readonly gen?: number; readonly basis?: string | null; readonly legacyFile?: true };

/** 看一眼。`null` = 列出来的当前代读的时候已经被清理掉了（观察过期），重看即可。 */
async function observe(dir: string): Promise<Observation | null> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "ENOENT") return { kind: "free", gen: 0, basis: null };
    if (code === "ENOTDIR") return { kind: "corrupt", why: "这是旧版本的单文件锁：确认里面记的进程已经不在了之后删掉它", legacyFile: true };
    return { kind: "corrupt", why: `读不出来：${(e as Error).message}` };
  }
  const { max, released } = scan(names);
  if (max === 0) return { kind: "free", gen: 0, basis: null };
  const raw = await readRaw(join(dir, `g${max}`));
  if (raw.kind === "missing") return null;
  if (released.has(max)) return { kind: "free", gen: max, basis: raw.kind === "text" ? raw.text : null };
  if (raw.kind === "error") return { kind: "corrupt", why: `读不出来：${raw.why}`, gen: max, basis: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.text);
  } catch (e) {
    return { kind: "corrupt", why: `解不开：${(e as Error).message}`, gen: max, basis: raw.text };
  }
  // 字段也要验形：`{}` 能 parse，但 `new Date(undefined)` 会让诊断抛 RangeError（实测）
  if (!isPeekedRecord(parsed)) return { kind: "corrupt", why: "缺 holder / pid / at（或类型不对）", gen: max, basis: raw.text };
  if (holderGone(parsed)) return { kind: "gone", gen: max, basis: raw.text, record: parsed };
  return { kind: "held", gen: max, basis: raw.text, record: parsed };
}

/** 观察过期、或认领一直被别人抢先时重来的上限。正常一两轮就定；转满说明局面异常，报错而不是无限转。 */
const MAX_ROUNDS = 1000;

/** 已经拿到的那一代。 */
export type Claim = {
  readonly gen: number;
  readonly record: ClaimRecord;
  /**
   * 释放：写上 `r<gen>`，停掉心跳。重复调是空操作；锁目录已经不在、或已经被接管（`lost` 已 resolve）也正常返回。
   * **没被接管、这一代却已经不是我的**（token 对不上、上面叠了更大的代）或记录读不出来时**抛**，不动它——
   * 调用方必须知道单写者约束可能已经破了。
   */
  release(): Promise<void>;
  /**
   * 被接管了（2026-11-15）：刷心跳前看见上面叠了更大的代，或自己那一代的记录不见了 / 换了人。带着原因 resolve；
   * 一直持有时**永不 settle**（与 `Lease.lost` 同一条理由）。
   */
  readonly lost: Promise<Error>;
};

/** 一次拿锁的结果。拿不到时 `seen` 说明是谁占着（或锁坏了），给人看的。 */
export type ClaimResult =
  | { readonly ok: true; readonly claim: Claim }
  | { readonly ok: false; readonly seen: { readonly kind: "held"; readonly record: PeekedLockRecord } | { readonly kind: "corrupt"; readonly why: string } };

/**
 * 试拿一次，**不等持有者**：活着的持有者占着、或当前代的记录坏了，就返回 `ok: false`。
 * 持有者已经不在了就接管（叠一代）。撞上别人同时认领会重看——那是看清局面，不是在等持有者。
 *
 * `force`：不管持有者在不在、记录坏没坏，照样叠一代（见文件头「强行接管」）。
 */
export async function claimGeneration(dir: string, who: { holder: string; preemptible?: boolean }, opts?: { force?: boolean }): Promise<ClaimResult> {
  const force = opts?.force === true;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const seen = await observe(dir);
    if (seen === null) continue;
    let prev: { readonly gen: number; readonly basis: string | null };
    if (seen.kind === "held") {
      if (!force) return { ok: false, seen: { kind: "held", record: seen.record } };
      prev = seen;
    } else if (seen.kind === "corrupt") {
      if (!force) return { ok: false, seen: { kind: "corrupt", why: seen.why } };
      if (seen.legacyFile === true) {
        await moveAside(dir);
        continue;
      }
      if (seen.gen === undefined) return { ok: false, seen: { kind: "corrupt", why: seen.why } }; // 连目录都读不出来：叠不上去
      prev = { gen: seen.gen, basis: seen.basis ?? null };
    } else {
      prev = seen;
    }
    const gen = prev.gen + 1;
    const now = Date.now();
    const record: ClaimRecord = {
      holder: who.holder,
      pid: process.pid,
      host: hostname(),
      at: now,
      beat: now,
      token: randomUUID(),
      ...(who.preemptible === true ? { preemptible: true } : {}),
    };
    if (!(await linkClaim(dir, gen, record))) continue; // 这一代被别人先认领了（或目录刚被删）：重看
    if (await confirmClaim(dir, gen, prev.basis)) {
      await sweep(dir, gen);
      return { ok: true, claim: claimOf(dir, gen, record) };
    }
    await markReleased(dir, gen); // 凭过期的观察叠上去的：这一代作废——标成已释放，不删
  }
  throw new Error(`锁 ${dir} 一直在变，${MAX_ROUNDS} 轮都没拿定`);
}

/** 旧版本的单文件锁挪到一边（不删：留着给人看是谁、什么时候占过）。已经被别人挪走也算成。 */
async function moveAside(path: string): Promise<void> {
  try {
    await rename(path, `${path}.legacy-${Date.now()}`);
  } catch (e) {
    if ((e as { code?: string }).code !== "ENOENT") throw e;
  }
}

/** 写好内容、fsync，再 link 成 `g<gen>`。`false` = 这一代已经有人了（或目录刚被删掉）。 */
async function linkClaim(dir: string, gen: number, record: ClaimRecord): Promise<boolean> {
  await mkdir(dir, { recursive: true });
  const temp = join(dir, `t-${process.pid}-${record.token}`);
  try {
    await writeSynced(temp, JSON.stringify(record));
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

/** 新建并写满、fsync——断电之后，名字在、内容却是空的，那才是真坏档。 */
async function writeSynced(path: string, text: string): Promise<void> {
  const fh = await open(path, "wx");
  try {
    await fh.writeFile(text);
    await fh.sync();
  } finally {
    await fh.close();
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

/**
 * 这一代还是我的吗。`null` = 是；否则是被接管的原因。读盘出错（不是「没了」）不下结论——返回 `undefined`，
 * 这一拍不刷、下一拍再看：一次 I/O 抖动不该让持有者以为自己被接管而停手。
 */
async function takenOver(dir: string, gen: number, token: string): Promise<Error | null | undefined> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (e) {
    if ((e as { code?: string }).code === "ENOENT") return new Error(`锁 ${dir} 整个不见了`);
    return undefined;
  }
  const { max, released } = scan(names);
  if (max > gen) {
    const raw = await readRaw(join(dir, `g${max}`));
    let who = "持有者不明";
    if (raw.kind === "text") {
      try {
        const parsed: unknown = JSON.parse(raw.text);
        if (isPeekedRecord(parsed)) who = describeRecord(parsed);
      } catch {
        /* 读不出也照样算被接管：上面已经叠了一代 */
      }
    }
    return new Error(`锁 ${dir} 已被第 ${max} 代接管（${who}）`);
  }
  if (released.has(gen)) return new Error(`锁 ${dir} 第 ${gen} 代被标成了已释放（不是我放的）`);
  const raw = await readRaw(join(dir, `g${gen}`));
  if (raw.kind === "missing") return new Error(`锁 ${dir} 第 ${gen} 代的记录不见了`);
  if (raw.kind === "error") return undefined;
  try {
    if ((JSON.parse(raw.text) as { token?: unknown } | null)?.token !== token) return new Error(`锁 ${dir} 第 ${gen} 代的记录换了人`);
  } catch {
    return undefined; // 正好读到别人写到一半？rename 是原子的，不该发生；不下结论
  }
  return null;
}

function claimOf(dir: string, gen: number, record: ClaimRecord): Claim {
  let signalLost: (e: Error) => void = () => {};
  const lost = new Promise<Error>((resolve) => {
    signalLost = resolve;
  });
  let lostError: Error | null = null;
  let stopped = false;
  let beating = false;
  const beat = async (): Promise<void> => {
    if (stopped || beating) return;
    beating = true;
    try {
      const verdict = await takenOver(dir, gen, record.token);
      if (stopped || verdict === undefined) return;
      if (verdict !== null) {
        stop();
        lostError = verdict;
        signalLost(verdict);
        return;
      }
      // 刷心跳：写临时文件再 rename 回 `g<gen>`——别人读到的永远是整份记录
      const temp = join(dir, `t-${process.pid}-${record.token}-beat`);
      try {
        await writeSynced(temp, JSON.stringify({ ...record, beat: Date.now() }));
        if (!stopped) await rename(temp, join(dir, `g${gen}`));
      } finally {
        await unlink(temp).catch(() => undefined);
      }
    } catch {
      /* 一次刷不成不下结论：下一拍再来；心跳真断了，别人看到的就是它过期 */
    } finally {
      beating = false;
    }
  };
  const timer = setInterval(() => void beat(), LOCK_BEAT_MS);
  (timer as { unref?: () => void }).unref?.(); // 心跳不该拖着进程不退
  const stop = (): void => {
    stopped = true;
    clearInterval(timer);
  };
  return {
    gen,
    record,
    lost,
    async release(): Promise<void> {
      stop();
      if (lostError !== null) return; // 已经被接管：没有可放的，也不是事故
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
    return { state: "valid", record: seen.record, alive: seen.kind === "held" };
  }
  throw new Error(`锁 ${dir} 一直在变，${MAX_ROUNDS} 轮都没看清`);
}
