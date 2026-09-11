import { test, expect } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { fileStateLock, inspectStateLock } from "../src/storage/file-lock.ts";
import { InMemoryStateLock } from "../src/storage/lock.ts";

// StateLock 的契约。文件锁 = 带递增编号的锁（`storage/generation-lock.ts`，2026-09-10）。
//
// 这道端口存在的理由本身就是一条判据：`StorageDir` 只有 read/write/remove/list，
// **没有原子 create-if-absent 也没有 CAS**，拿它模拟锁必然留 TOCTOU 窗口。
// 所以这里测的不是「能建个文件」，而是**互斥真的成立**——包括持有者崩溃后几个人同时来接管的时候。

/** 一定查无此号的 pid：超过 Linux 的 pid_max 上限（2^22）与 macOS 的 99999。 */
const DEAD_PID = 2 ** 22;

async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), "echo-lock-"));
}

/** 伪造第 `gen` 代的认领记录——模拟别的进程写下的那一条。 */
async function forge(lock: string, gen: number, record: unknown): Promise<void> {
  await mkdir(lock, { recursive: true });
  await writeFile(join(lock, `g${gen}`), typeof record === "string" ? record : JSON.stringify(record));
}

/** 一个崩掉的持有者：本机、pid 查无此号。 */
function crashed(holder = "崩掉的"): { holder: string; pid: number; host: string; at: number; token: string } {
  return { holder, pid: DEAD_PID, host: hostname(), at: Date.now(), token: `t-${holder}` };
}

/** 锁目录里有哪些代的认领（`g`）与释放（`r`）。 */
async function generations(lock: string): Promise<{ g: number[]; r: number[] }> {
  const names = await readdir(lock);
  const pick = (kind: string): number[] =>
    names
      .filter((n) => new RegExp(`^${kind}\\d+$`).test(n))
      .map((n) => Number(n.slice(1)))
      .sort((a, b) => a - b);
  return { g: pick("g"), r: pick("r") };
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

test("认领记录写着持有者、pid、机器；release 之后锁空出来，认领与释放的记录都留着（当前代从不删）", async () => {
  const path = join(await tmp(), ".lock");
  const lease = await fileStateLock(path).acquire({ holder: "agent:default" });
  const seen = await inspectStateLock(path);
  expect(seen.state).toBe("valid");
  if (seen.state === "valid") {
    expect(seen.record.holder).toBe("agent:default");
    expect(seen.record.pid).toBe(process.pid);
    expect(seen.record.host).toBe(hostname());
  }
  await lease!.release();
  expect(await inspectStateLock(path)).toEqual({ state: "missing" });
  expect(await generations(path)).toEqual({ g: [1], r: [1] });
});

test("**崩溃之后自动接管**：持有者在本机、pid 查无此号，下一个 acquire 叠一代拿到（此前要人工删锁）", async () => {
  const path = join(await tmp(), ".lock");
  await forge(path, 1, crashed());
  const lease = await fileStateLock(path).acquire({ holder: "接班的" });
  expect(lease).not.toBeNull();
  expect((await generations(path)).g).toEqual([1, 2]); // 崩掉的那一代原样留着——接管是往上叠，不是删了重建
  const seen = await inspectStateLock(path);
  expect(seen.state === "valid" && seen.record.holder).toBe("接班的");
  await lease!.release();
});

test("确认不了死活就不接管：别的机器、没写机器、持有者还活着，一律当它活着", async () => {
  for (const record of [
    { ...crashed("别的机器上的"), host: "another-host.invalid" },
    { holder: "没写机器的", pid: DEAD_PID, at: Date.now() }, // 手写的或外来的记录：判不了
    { holder: "活着的", pid: process.pid, host: hostname(), at: Date.now(), token: "alive" },
  ]) {
    const path = join(await tmp(), ".lock");
    await forge(path, 1, record);
    expect(await fileStateLock(path).acquire({ holder: "想接管的" }), record.holder).toBeNull();
    // 给人看的线索还在——哪怕这条记录没有 token（诊断字段与所有权字段分开验形）
    const who = await inspectStateLock(path);
    expect(who.state === "valid" && who.record.holder).toBe(record.holder);
  }
});

test("认领记录的 pid 必须是正整数：0 / 小数判成坏档（`process.kill(0, 0)` 会成功，探活会把它当活着；review 2026-09-09）", async () => {
  const path = join(await tmp(), ".lock");
  await forge(path, 1, { holder: "x", pid: 0, at: Date.now() });
  expect((await inspectStateLock(path)).state).toBe("corrupt");
  await forge(path, 1, { holder: "x", pid: 1.5, at: Date.now() });
  expect((await inspectStateLock(path)).state).toBe("corrupt");
  await forge(path, 1, { holder: "x", pid: process.pid, at: Date.now() });
  expect((await inspectStateLock(path)).state).toBe("valid");
});

test("当前代的记录坏了不接管——内容是先写好再 link 的，坏档只可能是外力，得人来看", async () => {
  const path = join(await tmp(), ".lock");
  await forge(path, 1, "不是 json");
  expect(await fileStateLock(path).acquire({ holder: "想接管的" })).toBeNull();
  expect((await inspectStateLock(path)).state).toBe("corrupt");
});

test("旧版本留下的单文件锁：拿不到，并且说清是什么、怎么清", async () => {
  const path = join(await tmp(), ".lock");
  await writeFile(path, JSON.stringify({ holder: "旧版本", pid: DEAD_PID, at: Date.now() }));
  const lock = fileStateLock(path);
  expect(await lock.acquire({ holder: "新版本" })).toBeNull();
  const seen = await inspectStateLock(path);
  expect(seen.state === "corrupt" && seen.why).toContain("旧版本的单文件锁");
  expect(await lock.describeHolder?.()).toContain("旧版本的单文件锁");
});

test("**P0 反证**：高并发下也只有一个能拿到（单文件锁曾经第 136 次就双授）", async () => {
  const path = join(await tmp(), ".lock");
  const lock = fileStateLock(path);

  // 反复来：每轮 32 个并发 acquire，成功的必须恰好一个
  for (let round = 0; round < 30; round++) {
    const leases = await Promise.all(Array.from({ length: 32 }, (_, i) => lock.acquire({ holder: `c${round}-${i}` })));
    const won = leases.filter((l) => l !== null);
    expect(won).toHaveLength(1); // ← 双授在这里当场红
    await won[0]!.release();
  }
});

test("**P0 反证·接管**：同一个死掉的持有者，32 个人同时来接管，每一轮恰好一个拿到", async () => {
  // 单文件锁不敢自动接管，就是怕这一幕：大家同时判它死了、同时删、同时建。这里没有「删」——
  // 接管是 link 出下一代，同一个名字只有一个人 link 得成。
  for (let round = 0; round < 100; round++) {
    const path = join(await tmp(), ".lock");
    await forge(path, 1, crashed());
    const lock = fileStateLock(path);
    const leases = await Promise.all(Array.from({ length: 32 }, (_, i) => lock.acquire({ holder: `c${round}-${i}` })));
    const won = leases.filter((l) => l !== null);
    expect(won).toHaveLength(1);
    expect((await generations(path)).g).toEqual([1, 2]);
    await won[0]!.release();
  }
});

test("旧代会被清掉：来回拿放多次，锁目录里只留最近两代；崩在认领半路的进程留下的临时文件也清", async () => {
  const path = join(await tmp(), ".lock");
  const lock = fileStateLock(path);
  await mkdir(path, { recursive: true });
  await writeFile(join(path, `t-${DEAD_PID}-leftover`), "{}");
  for (let i = 0; i < 10; i++) await (await lock.acquire({ holder: `第 ${i} 次` }))!.release();
  expect(await generations(path)).toEqual({ g: [9, 10], r: [9, 10] });
  expect(await readdir(path)).not.toContain(`t-${DEAD_PID}-leftover`);
});

test("持有中 lost 永不 settle（本地锁没有租约到期这回事）", async () => {
  const dir = await tmp();
  const lease = await fileStateLock(join(dir, ".lock")).acquire({ holder: "我" });
  const raced = await Promise.race([lease!.lost.then(() => "lost"), new Promise((r) => setTimeout(() => r("still-held"), 20))]);
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

/* ────────────── 所有权靠 token；读不出来、已经不是我的，就不放、并且要抛 ────────────── */

test("release() 只放 token 对得上的那一代——记录被换过就不动它，并且要抛", async () => {
  // 用 token 而不是 `pid + at`：pid 会复用、`at` 只有毫秒精度，撞了就把别人的锁放掉。
  const path = join(await tmp(), ".lock");
  const mine = await fileStateLock(path).acquire({ holder: "我" });
  const seen = await inspectStateLock(path);
  // 模拟「同 pid 同毫秒的另一个持有者」：只有 token 不同
  await forge(path, 1, { ...(seen.state === "valid" ? seen.record : {}), token: "别人的-token" });
  await expect(mine!.release()).rejects.toThrow(/不是我这把/);
  expect((await inspectStateLock(path)).state).toBe("valid"); // 没被放掉
});

test("上面已经叠了更大的一代：release() 抛，并且说得出现在是谁", async () => {
  const path = join(await tmp(), ".lock");
  const mine = await fileStateLock(path).acquire({ holder: "我" });
  await forge(path, 2, { holder: "别人", pid: process.pid, host: hostname(), at: Date.now(), token: "别人的" });
  await expect(mine!.release()).rejects.toThrow(/现在属于 holder=别人/);
  expect(await generations(path)).toEqual({ g: [1, 2], r: [] });
});

test("自己那一代的记录坏了：release() 抛、不放——「放不掉」不许报成「已释放」，否则锁永远留在盘上", async () => {
  for (const [broken, why] of [
    ["{ 半截", /解不开.*没有释放它/],
    ["{}", /不是我这把.*没有释放它/],
  ] as const) {
    const path = join(await tmp(), ".lock");
    const lock = fileStateLock(path);
    const mine = await lock.acquire({ holder: "我" });
    await forge(path, 1, broken);
    await expect(mine!.release()).rejects.toThrow(why);
    expect(await lock.acquire({ holder: "下一个" })).toBeNull(); // 坏档不接管：确实拿不到，得人来看
  }
});

test("已经放过、或锁目录已经不在 → release() 正常返回（没什么可放的，重复调不该炸）", async () => {
  const path = join(await tmp(), ".lock");
  const a = await fileStateLock(path).acquire({ holder: "我" });
  await a!.release();
  await a!.release(); // 第二次
  const b = await fileStateLock(path).acquire({ holder: "我" });
  await rm(path, { recursive: true });
  await b!.release();
});

test("describeHolder()：拿不到锁时说得出是谁占着、锁在哪；坏档也说人话，不自己抛 RangeError", async () => {
  const path = join(await tmp(), ".lock");
  const lock = fileStateLock(path);
  await lock.acquire({ holder: "agent:default" });
  expect(await lock.acquire({ holder: "另一个" })).toBeNull();
  const who = await lock.describeHolder?.();
  expect(who).toContain("agent:default");
  expect(who).toContain(path);
  const seen = await inspectStateLock(path);
  expect(seen.state === "valid" && typeof seen.record.token).toBe("string");

  // 实测过：`{}` 曾让 `new Date(undefined).toISOString()` 抛 RangeError，「拿不到锁」这个真错误反被诊断盖掉
  await forge(path, 1, "{}");
  expect(await lock.describeHolder?.()).toContain("是坏的");
  expect(await inspectStateLock(path)).toEqual({ state: "corrupt", why: "缺 holder / pid / at（或类型不对）" });
});

/* ────────────── 真进程 ────────────── */

test(
  "持锁进程被 kill -9：它活着时拿不到，死了之后下一个 acquire 直接接管",
  async () => {
    const path = join(await tmp(), ".lock");
    const holder = Bun.spawn(["bun", join(import.meta.dir, "fixtures", "lock-holder.ts"), path], { stdout: "ignore", stderr: "pipe" });
    try {
      const deadline = Date.now() + 15_000;
      for (;;) {
        const seen = await inspectStateLock(path);
        if (seen.state === "valid" && seen.record.pid === holder.pid) break;
        if (Date.now() > deadline) throw new Error("持锁进程没拿到锁");
        await new Promise((r) => setTimeout(r, 25));
      }
      const lock = fileStateLock(path);
      expect(await lock.acquire({ holder: "等着的" })).toBeNull(); // 它还活着
      holder.kill(9);
      await holder.exited;
      const lease = await lock.acquire({ holder: "等着的" });
      expect(lease, "持有者已经死了，却还是拿不到").not.toBeNull();
      await lease!.release();
    } finally {
      holder.kill(9);
    }
  },
  30_000,
);

test(
  "**多进程压测**：6 个进程各拿放 300 次，其间陆续有进程拿到锁就崩（不释放）——零双授、计数一个不少",
  async () => {
    const root = await tmp();
    const stress = join(import.meta.dir, "fixtures", "lock-stress.ts");
    const spawnOne = (mode: "work" | "crash", n: number) =>
      Bun.spawn(["bun", stress, root, mode, String(n)], { stdout: "pipe", stderr: "pipe" });
    const report = async (p: ReturnType<typeof spawnOne>): Promise<string> => {
      const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
      await p.exited;
      return `${out}\n${err}`.trim();
    };

    const workers = Array.from({ length: 6 }, () => spawnOne("work", 300));
    const workerOut = Promise.all(workers.map(report));
    let finished = false;
    void workerOut.then(() => (finished = true));
    // 干活的进程跑着的时候，陆续插进拿到锁就退出的进程：每一个都会让排队的几个人同时来接管
    const crashers: ReturnType<typeof spawnOne>[] = [];
    while (!finished && crashers.length < 40) {
      crashers.push(spawnOne("crash", 1));
      await new Promise((r) => setTimeout(r, 40));
    }
    const outs = await workerOut;
    const crashOuts = await Promise.all(crashers.map(report));

    const reports = outs.map((o) => JSON.parse(o.split("\n").at(-1) ?? "") as { done: number; doubles: number });
    expect(reports.map((r) => r.doubles), outs.join("\n---\n")).toEqual([0, 0, 0, 0, 0, 0]);
    expect(reports.map((r) => r.done)).toEqual([300, 300, 300, 300, 300, 300]);
    expect(Number(await readFile(join(root, "counter"), "utf8"))).toBe(1800);
    expect(crashOuts.every((o) => o === "held"), crashOuts.join("\n---\n")).toBe(true); // 每个崩溃者都真的拿到过锁、死在持锁期间
    expect(crashers.length).toBeGreaterThan(5);
  },
  180_000,
);
