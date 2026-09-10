import { test, expect } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileStateLock, inspectStateLock } from "../src/storage/file-lock.ts";
import { InMemoryStateLock } from "../src/storage/lock.ts";

// StateLock 的契约。
//
// 这道端口存在的理由本身就是一条判据：`StorageDir` 只有 read/write/remove/list，
// **没有原子 create-if-absent 也没有 CAS**，拿它模拟锁必然留 TOCTOU 窗口。
// 所以这里测的不是「能建个文件」，而是**互斥真的成立**。

async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), "echo-lock-"));
}

test("文件锁：拿到之后第二个 acquire 返回 null（不是抛，也不是等）", async () => {
  const dir = await tmp();
  const lock = fileStateLock(join(dir, ".lock"));

  const a = await lock.acquire({ holder: "第一个" });
  expect(a).not.toBeNull();

  const b = await lock.acquire({ holder: "第二个" });
  expect(b).toBeNull(); // 调用方据此 fail-loud；core 不抢占

  await a!.release();
  const c = await lock.acquire({ holder: "第三个" });
  expect(c).not.toBeNull(); // 还回去之后能再拿
  await c!.release();
});

test("文件锁：锁文件记下持有者与 pid（报错时要说得清是谁占着）", async () => {
  const dir = await tmp();
  const path = join(dir, ".lock");
  const lease = await fileStateLock(path).acquire({ holder: "agent:default" });
  const rec = JSON.parse(await readFile(path, "utf8")) as { holder: string; pid: number };
  expect(rec.holder).toBe("agent:default");
  expect(rec.pid).toBe(process.pid);
  await lease!.release();
  expect(existsSync(path)).toBe(false); // release 把它删干净
});

test("文件锁：**不做 stale takeover**——哪怕持有者 pid 早就没了也拒绝", async () => {
  const dir = await tmp();
  const path = join(dir, ".lock");
  // 伪造一把「上一个进程留下的」锁：pid 取一个几乎不可能存在的值
  await writeFile(path, JSON.stringify({ holder: "死掉的", pid: 2 ** 22, at: Date.now() }));

  // 曾经这里会接管。**并发压测下 read→rm→create 三步链会双授**（review 第 136 次复现），
  // 所以 V0 一律拒绝；崩溃后人工删锁，报错信息里说清是谁占着。
  expect(await fileStateLock(path).acquire({ holder: "想接管的" })).toBeNull();
  const who = await inspectStateLock(path);
  // 给人看的线索还在——**哪怕这条记录没有 token**（诊断字段与所有权字段分开验形）
  expect(who.state).toBe("valid");
  expect(who.state === "valid" && who.record.holder).toBe("死掉的");
});

test("锁记录的 pid 必须是正整数：0 / 小数判成坏档（`process.kill(0, 0)` 会成功，探活会把它当活着；review 2026-09-09）", async () => {
  const dir = await tmp();
  const path = join(dir, ".lock");
  await writeFile(path, JSON.stringify({ holder: "x", pid: 0, at: Date.now() }));
  expect((await inspectStateLock(path)).state).toBe("corrupt");
  await writeFile(path, JSON.stringify({ holder: "x", pid: 1.5, at: Date.now() }));
  expect((await inspectStateLock(path)).state).toBe("corrupt");
  await writeFile(path, JSON.stringify({ holder: "x", pid: process.pid, at: Date.now() }));
  expect((await inspectStateLock(path)).state).toBe("valid");
});

test("文件锁：持有者进程还活着 → 不接管", async () => {
  const dir = await tmp();
  const path = join(dir, ".lock");
  // 用本进程的 pid 冒充「还活着的持有者」
  await writeFile(path, JSON.stringify({ holder: "活着的", pid: process.pid, at: Date.now() }));

  expect(await fileStateLock(path).acquire({ holder: "想抢的" })).toBeNull();
});

test("文件锁：锁文件坏了也**不**当 stale——那和「持有者正在写」分不开", async () => {
  const dir = await tmp();
  const path = join(dir, ".lock");
  await writeFile(path, "不是 json");

  // 关键区分：持有者 `open` 成功、`writeFile` 还没落时，内容就是空/半截。
  // 把它判成坏档去删，等于给正常竞争开一道门——所以只看「文件在不在」。
  expect(await fileStateLock(path).acquire({ holder: "想接管的" })).toBeNull();
  // 读不出来照实报 corrupt（不折叠成「没有」），但那不构成接管理由
  expect((await inspectStateLock(path)).state).toBe("corrupt");
});

test("文件锁：release 只删自己那把，且**删不掉要抛**", async () => {
  const dir = await tmp();
  const path = join(dir, ".lock");
  const mine = await fileStateLock(path).acquire({ holder: "我" });
  // 模拟锁文件被外力换成了别人的（V0 不会自己这么做，但要保证 release 不误删）
  await writeFile(path, JSON.stringify({ holder: "别人", pid: process.pid, at: Date.now() + 1 }));

  // 不删是对的；但**静默返回成功是错的**——调用方会以为锁已经还回去了
  await expect(mine!.release()).rejects.toThrow(/不是我这把/);
  expect(existsSync(path)).toBe(true);
  const rec = JSON.parse(await readFile(path, "utf8")) as { holder: string };
  expect(rec.holder).toBe("别人");
});

test("**P0 反证**：高并发下也只有一个能拿到（曾经第 136 次就双授）", async () => {
  const dir = await tmp();
  const path = join(dir, ".lock");
  const lock = fileStateLock(path);

  // 反复来：每轮 32 个并发 acquire，成功的必须恰好一个
  for (let round = 0; round < 30; round++) {
    const leases = await Promise.all(
      Array.from({ length: 32 }, (_, i) => lock.acquire({ holder: `c${round}-${i}` })),
    );
    const won = leases.filter((l) => l !== null);
    expect(won).toHaveLength(1); // ← 双授在这里当场红
    await won[0]!.release();
  }
});

test("写内容失败不留死锁（建了文件却没写成，得清掉）", async () => {
  const dir = await tmp();
  const path = join(dir, ".lock");
  // 正常拿一次再放掉，确认路径可用
  const l = await fileStateLock(path).acquire({ holder: "我" });
  await l!.release();
  expect(existsSync(path)).toBe(false);
});

test("持有中 lost 永不 settle（本地锁没有租约到期这回事）", async () => {
  const dir = await tmp();
  const lease = await fileStateLock(join(dir, ".lock")).acquire({ holder: "我" });
  const raced = await Promise.race([
    lease!.lost.then(() => "lost"),
    new Promise((r) => setTimeout(() => r("still-held"), 20)),
  ]);
  expect(raced).toBe("still-held");
  await lease!.release();
});

test("内存锁：互斥 + simulateLost 用 Error resolve（不是 reject）", async () => {
  const lock = new InMemoryStateLock();
  const a = await lock.acquire({ holder: "一" });
  expect(a).not.toBeNull();
  expect(await lock.acquire({ holder: "二" })).toBeNull();

  lock.simulateLost("租约过期");
  // resolve 而非 reject：await 直接拿到 Error 值，不需要 try/catch
  const err = await a!.lost;
  expect(err).toBeInstanceOf(Error);
  expect(err.message).toBe("租约过期");

  await a!.release();
  expect(await lock.acquire({ holder: "三" })).not.toBeNull();
});

/* ────────────── 2026-08-19 review：所有权靠 token，读不出来就不删 ────────────── */

test("release() 只删 token 对得上的那把——锁文件被换过就不动它", async () => {
  // 此前用 `pid + at` 识别所有权：pid 会复用、`at` 只有毫秒精度，撞了就把别人的锁删掉。
  const dir = await tmp();
  const path = join(dir, ".lock");
  const lock = fileStateLock(path);

  const mine = await lock.acquire({ holder: "我" });
  expect(mine).not.toBeNull();

  // 模拟「同 pid 同毫秒的另一个持有者」：只有 token 不同
  const rec = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  await writeFile(path, JSON.stringify({ ...rec, token: "别人的-token" }));

  await expect(mine!.release()).rejects.toThrow(/不是我这把/);
  expect(existsSync(path)).toBe(true); // 没被删掉
});

test("锁文件读不出来时 release() 不删——「正在写」不能被当成「没人占」", async () => {
  // 读不出来包含「另一个持有者刚 open 还没写完」。此前 `cur === null` 时照删，
  // 那一删就是把别人的锁抢掉。第三轮又补了后半句：不删的同时**必须抛**。
  const dir = await tmp();
  const path = join(dir, ".lock");
  const lock = fileStateLock(path);

  const mine = await lock.acquire({ holder: "我" });
  await writeFile(path, ""); // 半截：JSON.parse 会抛
  await expect(mine!.release()).rejects.toThrow(/没有删除它/);
  expect(existsSync(path)).toBe(true);
});

test("describeHolder()：拿不到锁时说得出是谁占着（人工清锁的前提）", async () => {
  const dir = await tmp();
  const path = join(dir, ".lock");
  const lock = fileStateLock(path);
  await lock.acquire({ holder: "agent:default" });

  expect(await lock.acquire({ holder: "另一个" })).toBeNull();
  const who = await lock.describeHolder?.();
  expect(who).toContain("agent:default");
  expect(who).toContain(path);
  // inspectStateLock 也在，且带 token
  const seen = await inspectStateLock(path);
  expect(seen.state === "valid" && typeof seen.record.token).toBe("string");
});

/* ────────── 2026-08-19 第三轮 review：「删不掉」不许报成「已释放」 ────────── */

test("锁文件坏掉时 release() 必须抛——此前它 resolved，而锁永远留在盘上", async () => {
  // 实测破坏：把持有中的锁文件改成 `{}` → release() resolved、文件仍在、
  // 下一个 acquire() 永久拿不到。这恰好绕过了「release 失败时 stop() 必须抛」那条。
  const dir = await tmp();
  const path = join(dir, ".lock");
  const lock = fileStateLock(path);

  const mine = await lock.acquire({ holder: "我" });
  await writeFile(path, "{}");

  await expect(mine!.release()).rejects.toThrow(/没有删除它/);
  expect(existsSync(path)).toBe(true); // 确实没删（可能是别人的）
  expect(await lock.acquire({ holder: "下一个" })).toBeNull(); // 而且确实拿不到了
});

test("锁文件半截（parse 不了）时 release() 也抛，且不删", async () => {
  const dir = await tmp();
  const path = join(dir, ".lock");
  const mine = await fileStateLock(path).acquire({ holder: "我" });
  await writeFile(path, "{ 半截");

  await expect(mine!.release()).rejects.toThrow(/解不开/);
  expect(existsSync(path)).toBe(true);
});

test("锁已经是别人的时候 release() 抛，并且说得出现在是谁", async () => {
  const dir = await tmp();
  const path = join(dir, ".lock");
  const mine = await fileStateLock(path).acquire({ holder: "我" });
  await writeFile(path, JSON.stringify({ holder: "别人", pid: 1, at: Date.now(), token: "别人的" }));

  await expect(mine!.release()).rejects.toThrow(/现在属于 holder=别人/);
  expect(existsSync(path)).toBe(true);
});

test("锁文件已经不在了 → release() 正常返回（没什么可清的，重复调不该炸）", async () => {
  const dir = await tmp();
  const path = join(dir, ".lock");
  const mine = await fileStateLock(path).acquire({ holder: "我" });
  await mine!.release();
  await mine!.release(); // 第二次
});

test("describeHolder() 遇到坏档要说人话，不能自己抛 RangeError", async () => {
  // 实测过：`{}` 会让 `new Date(undefined).toISOString()` 抛 RangeError，
  // 于是「拿不到锁」这个真错误反被诊断代码盖掉。
  const dir = await tmp();
  const path = join(dir, ".lock");
  const lock = fileStateLock(path);
  await lock.acquire({ holder: "我" });
  await writeFile(path, "{}");

  const who = await lock.describeHolder?.();
  expect(who).toContain("是坏的");
  expect(await inspectStateLock(path)).toEqual({ state: "corrupt", why: "缺 holder / pid / at（或类型不对）" });
});
