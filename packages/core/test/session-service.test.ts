import { test, expect } from "bun:test";
import { SessionService, listSessions, setSessionStatus } from "../src/session/service.ts";
import { InMemoryDir } from "../src/storage/in-memory-dir.ts";
import { FileDir } from "../src/storage/file-dir.ts";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { userMessage } from "../src/messages.ts";
import type { StorageDir } from "../src/storage/types.ts";

// Session Service 的四条不变量（逐条配单测）。
//
// **由来**：D3 之前，这些语义住在注入方实现的 `SessionManager` 里——「坏档 fail-loud，
// 不给半截 session」只是接口注释里的一句自觉。换一个实现就可以返回半截、可以静默吞掉 append，
// `Agent` 无从保证。语义收进 core 之后，它们才第一次成为**能被测的东西**。
//
// 所以本文件的每条测试都对应「第三方 Store 使坏时 core 必须判红」，
// 而不只是「正常路径能跑通」。

function svc(dir: StorageDir = new InMemoryDir()): { s: SessionService; dir: StorageDir } {
  return { s: new SessionService(dir), dir };
}

/** 前缀视图：`listSessions` 扫的是 session 目录的上一层，所以每段要各自一个子目录。 */
function scoped(base: StorageDir, prefix: string): StorageDir {
  return {
    read: (path) => base.read(prefix + path),
    write: (path, content) => base.write(prefix + path, content),
    remove: (path) => base.remove(prefix + path),
    list: async (sub) => (await base.list(prefix + sub)).map((k) => k.slice(prefix.length)),
  };
}

test("不变量① 恢复后 messages 与 compaction 同源（同一份 entries 投影出来，取最后一次压缩的状态）", async () => {
  const dir = new InMemoryDir();
  const first = new SessionService(dir);
  await first.createOrResume("main");
  await first.append("main", [
    { kind: "message", message: userMessage("一") },
    { kind: "message", message: userMessage("二") },
    { kind: "compaction", at: 1, reason: "auto", compaction: { spans: [{ from: 0, to: 1, summary: "压过一次" }], clearedBefore: 0 } },
    { kind: "message", message: userMessage("三") },
    { kind: "compaction", at: 2, reason: "manual", compaction: { spans: [{ from: 0, to: 2, summary: "压过两次" }], clearedBefore: 0 } },
  ]);
  await first.settle();

  // 换一个进程（新 Service 实例、同一个 store）
  const resumed = await new SessionService(dir).createOrResume("main");
  expect(resumed.messages.map((m) => m.role)).toEqual(["user", "user", "user"]);
  // 状态是最后一条 compaction entry 里的那份，下标直接落在恢复出来的 messages 上
  expect(resumed.compaction).toEqual({ spans: [{ from: 0, to: 2, summary: "压过两次" }], clearedBefore: 0 });
  expect(resumed.info.messageCount).toBe(3);
});

test("compaction 状态在恢复出来的 messages 上不成立 → 坏档判红（越界 / 切在配对中间）", async () => {
  for (const compaction of [
    { spans: [{ from: 0, to: 5, summary: "越界" }], clearedBefore: 0 },
    { spans: [], clearedBefore: 9 },
  ]) {
    const dir = new InMemoryDir();
    const s = new SessionService(dir);
    await s.createOrResume("main");
    await s.append("main", [
      { kind: "message", message: userMessage("一") },
      { kind: "compaction", at: 1, reason: "auto", compaction },
    ]);
    await s.settle();
    await expect(new SessionService(dir).createOrResume("main")).rejects.toThrow(/compaction/);
  }
});

test("不变量② 同一 entry id 不重复——跨进程续写也接着排", async () => {
  const dir = new InMemoryDir();
  const a = new SessionService(dir);
  await a.createOrResume("main");
  const w1 = await a.append("main", [{ kind: "message", message: userMessage("一") }]);
  await a.settle();

  const b = new SessionService(dir);
  await b.createOrResume("main"); // resume：游标要从盘上的条数接着走
  const w2 = await b.append("main", [{ kind: "message", message: userMessage("二") }]);
  await b.settle();

  expect(w1[0]!.id).toBe("main-e1");
  expect(w2[0]!.id).toBe("main-e2"); // 不是又一个 e1
  expect(w2[0]!.parentId).toBe("main-e1"); // 链也接得上
});

test("不变量③ 坏档抛错而不是返回半截 —— entry 解不开", async () => {
  const dir = new InMemoryDir();
  const a = new SessionService(dir);
  await a.createOrResume("main");
  await a.append("main", [
    { kind: "message", message: userMessage("一") },
    { kind: "message", message: userMessage("二") },
  ]);
  await a.settle();

  // 手工毁掉第二条
  await dir.write("entries/000002.json", "{ 这不是 json");

  await expect(new SessionService(dir).createOrResume("main")).rejects.toThrow(/000002\.json 解不开/);
});

test("不变量③ 坏档抛错 —— entry 缺必要字段", async () => {
  const dir = new InMemoryDir();
  const a = new SessionService(dir);
  await a.createOrResume("main");
  await a.append("main", [{ kind: "message", message: userMessage("一") }]);
  await a.settle();
  await dir.write("entries/000001.json", JSON.stringify({ nope: true }));

  await expect(new SessionService(dir).createOrResume("main")).rejects.toThrow(/不是合法 entry/);
});

test("不变量③ 坏档抛错 —— meta 解不开", async () => {
  const dir = new InMemoryDir();
  await new SessionService(dir).createOrResume("main");
  await dir.write("meta.json", "半截");

  await expect(new SessionService(dir).createOrResume("main")).rejects.toThrow(/meta\.json 解不开/);
});

test("别处把这一段置 closed 之后，自己的入账不把它盖回 active：保住 closed、报一次诊断（review 2026-09-07 #57，2026-09-09 拍板止血版）", async () => {
  const { s, dir } = svc();
  const codes: string[] = [];
  s.attachDiagnostics((d) => codes.push(d.code));
  await s.createOrResume("s1", { workspace: "/w" });
  await s.append("s1", [{ kind: "message", message: userMessage("一") }]);
  await s.settle();
  await setSessionStatus(dir, "s1", "closed"); // 会话列表 / session_close 走的就是它：不经这个 Service 实例
  await s.append("s1", [{ kind: "message", message: userMessage("二") }]);
  await s.settle();
  const meta = JSON.parse((await dir.read("meta.json"))!) as { status: string; messageCount: number };
  expect([meta.status, meta.messageCount]).toEqual(["closed", 2]); // 计数照常刷，状态不倒退
  expect(codes).toEqual(["session_closed_underneath"]);
  await s.append("s1", [{ kind: "message", message: userMessage("三") }]);
  await s.settle();
  expect(codes).toEqual(["session_closed_underneath"]); // 游标已经跟着 closed 走：不再重复报
  expect((JSON.parse((await dir.read("meta.json"))!) as { status: string }).status).toBe("closed");
});

test("入账在飞时改名不丢：bumpMeta 醒来只补 status、不把 await 前的旧对象整份赋回（review 2026-09-09 回归）", async () => {
  const base = new InMemoryDir();
  let hold = false;
  let release: (() => void) | undefined;
  const dir: StorageDir = {
    read: (p) => base.read(p),
    remove: (p) => base.remove(p),
    list: (p) => base.list(p),
    write: async (p, c) => {
      if (hold && p === "meta.json") await new Promise<void>((r) => void (release = r)); // 把这次 meta 写卡住，改名插在中间
      return base.write(p, c);
    },
  };
  const s = new SessionService(dir);
  await s.createOrResume("s1", { workspace: "/w" });
  hold = true;
  await s.append("s1", [{ kind: "message", message: userMessage("一") }]);
  for (let i = 0; i < 50 && release === undefined; i++) await new Promise((r) => setTimeout(r, 0));
  expect(release).toBeDefined();
  s.rename("s1", "foo"); // 此刻 cursor.info 换成了带名字的新对象
  hold = false;
  release!();
  await s.settle();
  expect(s.nameOf("s1")).toBe("foo"); // 此前 bumpMeta 醒来把旧对象赋回去，名字在内存里就没了
  await s.append("s1", [{ kind: "message", message: userMessage("二") }]);
  await s.settle();
  expect((JSON.parse((await base.read("meta.json"))!) as { name: string }).name).toBe("foo"); // 下一次入账也不会盖回 id
});

test("别处置 closed 之后改名：rename 也接 writeMeta 的返回，closed 只报一次（review 2026-09-09）", async () => {
  const { s, dir } = svc();
  const codes: string[] = [];
  s.attachDiagnostics((d) => codes.push(d.code));
  await s.createOrResume("s1", { workspace: "/w" });
  await s.append("s1", [{ kind: "message", message: userMessage("一") }]);
  await s.settle();
  await setSessionStatus(dir, "s1", "closed");
  s.rename("s1", "x");
  await s.settle();
  await s.append("s1", [{ kind: "message", message: userMessage("二") }]);
  await s.settle();
  expect(codes).toEqual(["session_closed_underneath"]);
  const meta = JSON.parse((await dir.read("meta.json"))!) as { status: string; name: string };
  expect([meta.status, meta.name]).toEqual(["closed", "x"]);
});

test("写 meta 前看盘上 status：读失败不是「没有」——这次入账封存，不静默盖写（review 2026-09-09）", async () => {
  const base = new InMemoryDir();
  let fail = false;
  const dir: StorageDir = {
    read: (p) => (fail && p === "meta.json" ? Promise.reject(new Error("EMFILE: too many open files")) : base.read(p)),
    write: (p, c) => base.write(p, c),
    remove: (p) => base.remove(p),
    list: (p) => base.list(p),
  };
  const s = new SessionService(dir);
  await s.createOrResume("s1", { workspace: "/w" });
  await s.append("s1", [{ kind: "message", message: userMessage("一") }]);
  await s.settle();
  await setSessionStatus(base, "s1", "closed");
  fail = true;
  await s.append("s1", [{ kind: "message", message: userMessage("二") }]);
  await expect(s.settle()).rejects.toThrow(/EMFILE/); // 读失败走持久化失败那条路：settle 把成因抛出来，与写失败同一条口径
  expect((JSON.parse((await base.read("meta.json"))!) as { status: string }).status).toBe("closed"); // 没被盖回 active
  await expect(s.append("s1", [{ kind: "message", message: userMessage("三") }])).rejects.toThrow(/封存/);
});

test("不变量④ 封存后不再入账（丢锁的第一步）", async () => {
  const { s } = svc();
  await s.createOrResume("main");
  await s.append("main", [{ kind: "message", message: userMessage("一") }]);
  s.seal();
  expect(s.isSealed).toBe(true);
  await expect(s.append("main", [{ kind: "message", message: userMessage("二") }])).rejects.toThrow(/已封存/);
});

// ── 下面三条锁的是「第三方 Store 使坏」，不是正常路径 ──

test("Store 说 list 里有、read 却为空 → 判红，不静默跳过", async () => {
  const dir = new InMemoryDir();
  const a = new SessionService(dir);
  await a.createOrResume("main");
  await a.append("main", [{ kind: "message", message: userMessage("一") }]);
  await a.settle();

  // 一个自相矛盾的 store：list 报告文件存在，read 返回 null
  const lying: StorageDir = {
    read: async (p) => (p.endsWith("meta.json") ? dir.read(p) : null),
    write: (p, c) => dir.write(p, c),
    remove: (p) => dir.remove(p),
    list: (prefix) => dir.list(prefix),
  };
  await expect(new SessionService(lying).createOrResume("main")).rejects.toThrow(/list 里有、read 却为空/);
});

test("盘上出现重复 entry id → 判红", async () => {
  const dir = new InMemoryDir();
  const a = new SessionService(dir);
  await a.createOrResume("main");
  await a.append("main", [
    { kind: "message", message: userMessage("一") },
    { kind: "message", message: userMessage("二") },
  ]);
  await a.settle();
  // 把第二条改成和第一条同 id
  const dup = await dir.read("entries/000001.json");
  await dir.write("entries/000002.json", dup!);

  await expect(new SessionService(dir).createOrResume("main")).rejects.toThrow(/重复 entry id/);
});

test("未 createOrResume 就 append → 判红（不隐式开会话）", async () => {
  const { s } = svc();
  await expect(s.append("main", [{ kind: "message", message: userMessage("一") }])).rejects.toThrow(/会话未打开/);
});

// ── settle 是 stop() 的依据，必须真的等到写完 ──

test("settle 等到所有 write settle —— 慢 store 也不许提前返回", async () => {
  const inner = new InMemoryDir();
  let inflight = 0;
  let maxInflight = 0;
  const slow: StorageDir = {
    read: (p) => inner.read(p),
    write: async (p, c) => {
      inflight++;
      maxInflight = Math.max(maxInflight, inflight);
      await new Promise((r) => setTimeout(r, 5));
      await inner.write(p, c);
      inflight--;
    },
    remove: (p) => inner.remove(p),
    list: (prefix) => inner.list(prefix),
  };
  const s = new SessionService(slow);
  await s.createOrResume("main");
  await s.append("main", [
    { kind: "message", message: userMessage("一") },
    { kind: "message", message: userMessage("二") },
  ]);
  await s.settle();

  expect(inflight).toBe(0); // settle 返回时一个都不在飞
  expect(maxInflight).toBeGreaterThan(0); // 且确实并发过（否则这条测试是空的）
  // 写真的落盘了：新实例能读回来
  const resumed = await new SessionService(inner).createOrResume("main");
  expect(resumed.messages).toHaveLength(2);
});

/* ────────────── 2026-08-19 review 的两条：中毒封存 · 逐 role 验形 ────────────── */

/** 第 n 次写抛错的 store，用来精确命中「第一次失败之后会发生什么」。 */
function failingAt(n: number): { dir: StorageDir } {
  const inner = new InMemoryDir();
  let seen = 0;
  const dir: StorageDir = {
    read: (p) => inner.read(p),
    list: (p) => inner.list(p),
    remove: (p) => inner.remove(p),
    write: async (p, c) => {
      seen++;
      if (seen === n) throw new Error("write-failed");
      await inner.write(p, c);
    },
  };
  return { dir };
}

test("写失败之后**不再继续落盘**，settle() 也不会自己变回绿", async () => {
  // 反证的是这条实测破坏：e1 写失败后 e2/e3 照样落盘（它们的 parentId 指向盘上不存在的 e1），
  // 而第二次 settle() 返回 resolved——调用方据此以为已经存下了。
  const { dir } = failingAt(2); // 1 是 createOrResume 写 meta，2 是第一条 entry
  const s = new SessionService(dir);
  await s.createOrResume("main");

  await s.append("main", [{ kind: "message", message: userMessage("一") }]);
  await expect(s.settle()).rejects.toThrow("write-failed");

  const afterFailure = (await dir.list("entries/")).length;

  // ① 后续 append 直接判红，不是排进队再悄悄不做
  await expect(s.append("main", [{ kind: "message", message: userMessage("二") }])).rejects.toThrow(
    "已因持久化失败封存",
  );

  // ② 第二次 settle 仍然抛同一个错——错误是实例级事实，不是一次性通知
  await expect(s.settle()).rejects.toThrow("write-failed");

  // ③ 盘上没有多出任何东西
  expect((await dir.list("entries/")).length).toBe(afterFailure);
});

test("**已经排在队里**的写也不许落盘——失败之后队列必须停住", async () => {
  // 上一条测的是「失败之后再 append 判红」，走的是 append 的前置闸。
  // 这条测的是另一半：三次 append 在第一次失败**浮出来之前**就已经排进链里了，
  // 那时前置闸帮不上忙，必须由链自己在中毒后停止执行。
  const { dir } = failingAt(2); // 1=meta，2=第一批 entry → 失败
  const s = new SessionService(dir);
  await s.createOrResume("main");

  // append 只负责排队，不等落盘——三次都在第一次真正写之前就排好了
  await s.append("main", [{ kind: "message", message: userMessage("一") }]);
  await s.append("main", [{ kind: "message", message: userMessage("二") }]);
  await s.append("main", [{ kind: "message", message: userMessage("三") }]);

  await expect(s.settle()).rejects.toThrow("write-failed");
  // 一条都不该在盘上：e1 写失败，e2/e3 的 parentId 指向不存在的 e1，写下去就是坏档
  expect(await dir.list("entries/")).toEqual([]);
});

test("中毒的会话重新 createOrResume 才解毒（那是人显式确认盘上状态的点）", async () => {
  const { dir } = failingAt(2);
  const s = new SessionService(dir);
  await s.createOrResume("main");
  await s.append("main", [{ kind: "message", message: userMessage("一") }]);
  await expect(s.settle()).rejects.toThrow("write-failed");

  await s.createOrResume("main"); // 显式确认
  await s.append("main", [{ kind: "message", message: userMessage("二") }]);
  await s.settle(); // 不再抛
  expect((await dir.list("entries/")).length).toBeGreaterThan(0);
});

test("封存（丢锁）之后连 createOrResume 都拒绝——不给一份写不进去的 session", async () => {
  const dir = new InMemoryDir();
  const s = new SessionService(dir);
  s.seal();
  await expect(s.createOrResume("main")).rejects.toThrow("拒绝打开");
  expect(await dir.read("meta.json")).toBeNull();
});

test("坏 message payload 在恢复时判红——只有 role 是不够的", async () => {
  // 实测过 `{ kind:"message", message:{ role:"user" } }` 会被收下并恢复进 messages，
  // 缺 content/source/at 也照过，直到投影或送进 provider 才炸。
  const cases: { name: string; message: unknown }[] = [
    { name: "user 缺 content/source/at", message: { role: "user" } },
    { name: "user 的 source 不合法", message: { role: "user", source: "robot", content: [], at: 1 } },
    { name: "assistant 缺 usage 字段", message: { role: "assistant", content: [], stopReason: "end_turn", at: 1 } },
    {
      name: "assistant 的 stopReason 不合法",
      message: { role: "assistant", content: [], stopReason: "?", usage: null, at: 1 },
    },
    {
      name: "toolResult 的 content 不是字符串",
      message: { role: "toolResult", toolCallId: "c", toolName: "t", content: [], isError: false, metadata: null, at: 1 },
    },
    { name: "environment 缺 source", message: { role: "environment", content: [], at: 1 } },
    { name: "缺信封 at", message: { role: "user", source: "human", content: [] } },
  ];

  for (const c of cases) {
    const dir = new InMemoryDir();
    await dir.write(
      "meta.json",
      JSON.stringify({ id: "main", name: "main", workspace: "/", product: "default", agent: { definition: {} }, main: true, status: "active", createdAt: 1, updatedAt: 1, messageCount: 1 }),
    );
    await dir.write(
      "entries/000001.json",
      JSON.stringify({ kind: "message", id: "main-e1", parentId: null, message: c.message }),
    );
    await expect(new SessionService(dir).createOrResume("main"), c.name).rejects.toThrow();
  }
});

test("自定义 role 仍然放行——扩展位不能被验形关掉", async () => {
  const dir = new InMemoryDir();
  await dir.write(
    "meta.json",
    JSON.stringify({ id: "main", name: "main", workspace: "/", product: "default", agent: { definition: {} }, main: true, status: "active", createdAt: 1, updatedAt: 1, messageCount: 1 }),
  );
  await dir.write(
    "entries/000001.json",
    JSON.stringify({
      kind: "message",
      id: "main-e1",
      parentId: null,
      message: { role: "planNote", text: "上层自己的消息", at: 1 },
    }),
  );
  const data = await new SessionService(dir).createOrResume("main");
  expect(data.messages).toHaveLength(1);
});

/* ────────── 2026-08-19 第三轮 review：meta 是派生缓存，不是第二份真相 ────────── */

test("meta.json 丢了但 entries 还在 → 判坏档，不当新会话（否则下一次 append 覆盖历史）", async () => {
  // 实测破坏：删掉 meta.json 之后重启，恢复出 0 条消息，
  // 下一次 append 从 000001.json 重新开始，直接盖掉原来那条。
  const dir = new InMemoryDir();
  const a = new SessionService(dir);
  await a.createOrResume("main");
  await a.append("main", [{ kind: "message", message: userMessage("旧消息") }]);
  await a.settle();

  await dir.remove("meta.json");

  await expect(new SessionService(dir).createOrResume("main")).rejects.toThrow(/缺 meta\.json/);
  // 历史还在盘上，没有被抹掉
  expect(await dir.read("entries/000001.json")).toContain("旧消息");
});

test("崩在「写完 entry、还没刷 meta」之间：计数按 entries 现算，且不会一直落后", async () => {
  // 这是**正常的崩溃形态**，不该让会话打不开；但也不能让落后的计数永远落后
  // （旧实现读旧值再加一，差值补不回来）。
  const dir = new InMemoryDir();
  const a = new SessionService(dir);
  await a.createOrResume("main");
  await a.append("main", [{ kind: "message", message: userMessage("一") }]);
  await a.append("main", [{ kind: "message", message: userMessage("二") }]);
  await a.settle();

  // 手工把 meta 打回落后一条（模拟崩在中间）
  const meta = JSON.parse((await dir.read("meta.json"))!) as Record<string, unknown>;
  await dir.write("meta.json", JSON.stringify({ ...meta, messageCount: 1 }));

  const b = new SessionService(dir);
  const resumed = await b.createOrResume("main");
  expect(resumed.messages).toHaveLength(2);
  expect(resumed.info.messageCount).toBe(2); // 现算，不是盘上那个 1

  // 再写一条：**盘上的 meta** 也要跟上，不再带着旧的差值。
  // 判据必须落在盘上——返回值是每次现算的，光看它盯不住这条（产品列会话读的是 meta.json）。
  await b.append("main", [{ kind: "message", message: userMessage("三") }]);
  await b.settle();
  const onDisk = JSON.parse((await dir.read("meta.json"))!) as { messageCount: number };
  expect(onDisk.messageCount).toBe(3); // 旧实现会是 2（读到落后的 1 再加一）
});

test("meta 缺字段 → 判红（缺字段的 info 不该以「恢复成功」的身份流出去）", async () => {
  const dir = new InMemoryDir();
  await dir.write("meta.json", JSON.stringify({ id: "main" }));
  await expect(new SessionService(dir).createOrResume("main")).rejects.toThrow(/缺 name/);
});

test("meta 缺 workspace → 判红（2026-09-01 之前的旧档，文案指明怎么处理）；新建写入、resume 以盘上为准", async () => {
  const oldDir = new InMemoryDir();
  await oldDir.write("meta.json", JSON.stringify({ id: "old", name: "old", createdAt: 1, updatedAt: 1, messageCount: 0 }));
  await expect(new SessionService(oldDir).createOrResume("old", { workspace: "/now" })).rejects.toThrow(/缺 workspace.*2026-09-01/);

  const dir = new InMemoryDir();
  const s = new SessionService(dir);
  const created = await s.createOrResume("fresh", { workspace: "/repo/a" });
  expect(created.info.workspace).toBe("/repo/a");
  await s.append("fresh", [{ kind: "message", message: userMessage("说一句才落 meta") }]);
  await s.settle();
  const onDisk = JSON.parse((await dir.read("meta.json"))!) as { workspace: string };
  expect(onDisk.workspace).toBe("/repo/a");
  // 换个宿主目录 resume：盘上的赢，宿主给的不覆盖
  const resumed = await new SessionService(dir).createOrResume("fresh", { workspace: "/elsewhere" });
  expect(resumed.info.workspace).toBe("/repo/a");
});

test("meta 缺 product / agent / main / status → 判红；新建写入、resume 以盘上为准；缺省 default + main + active", async () => {
  // 会话身份 = workspace + product（2026-09-01 拍板，2026-09-07 从 `agent` 改名）；
  // `agent` 现在是角色（`AgentRef`）；main + status 是 2026-09-03 加的两维。
  // 四个字段都**不给缺省**：少了 product 会续错产品的对话，`agent` 存成老的产品名字符串会被
  // 当成一份角色定义，少了 main 会让 --continue 挑到别人派的活，少了 status 会让已关的段照样收信。
  const bare = { id: "old", name: "old", workspace: "/w", createdAt: 1, updatedAt: 1, messageCount: 0 };
  const ref = { definition: {} };
  const noProduct = new InMemoryDir();
  await noProduct.write("meta.json", JSON.stringify(bare));
  await expect(new SessionService(noProduct).createOrResume("old", { workspace: "/w", product: "echo-coding" })).rejects.toThrow(
    /缺 product.*2026-09-01/,
  );
  // **2026-09-07 之前的档**：`agent` 那里存的是产品名字符串，读它会把产品名当成一份角色定义
  const oldAgent = new InMemoryDir();
  await oldAgent.write("meta.json", JSON.stringify({ ...bare, product: "echo-coding", agent: "echo-coding", main: true, status: "active" }));
  await expect(new SessionService(oldAgent).createOrResume("old")).rejects.toThrow(/agent 不是 AgentRef.*2026-09-07/);
  const noMain = new InMemoryDir();
  await noMain.write("meta.json", JSON.stringify({ ...bare, product: "echo-coding", agent: ref }));
  await expect(new SessionService(noMain).createOrResume("old")).rejects.toThrow(/缺 main.*2026-09-03/);
  const badStatus = new InMemoryDir();
  await badStatus.write("meta.json", JSON.stringify({ ...bare, product: "echo-coding", agent: ref, main: true, status: "running" }));
  await expect(new SessionService(badStatus).createOrResume("old")).rejects.toThrow(/status 不认识/);

  const dir = new InMemoryDir();
  const s = new SessionService(dir);
  const created = await s.createOrResume("fresh", { workspace: "/w", product: "echo-coding" });
  expect([created.info.product, created.info.main, created.info.status]).toEqual(["echo-coding", true, "active"]);
  await s.append("fresh", [{ kind: "message", message: userMessage("说一句才落 meta") }]);
  await s.settle();
  expect((JSON.parse((await dir.read("meta.json"))!) as { product: string }).product).toBe("echo-coding");
  // 换个产品 resume 同一段：盘上的赢——续别人的对话得是显式动作，续了也不改它的归属
  const resumed = await new SessionService(dir).createOrResume("fresh", { workspace: "/w", product: "echo-agent" });
  expect(resumed.info.product).toBe("echo-coding");
  // 经 extension 面（session_create 工具）建的那一段不是 main
  const spawned = await new SessionService(new InMemoryDir()).createOrResume("spawned", { workspace: "/w", main: false });
  expect([spawned.info.product, spawned.info.main]).toEqual(["default", false]);
});

test("一个 store 就是一段 session 的目录：在同一个 store 上开第二个 id 判红", async () => {
  // 没有这条时：第二段的 meta.json / entries 会盖在第一段头上，两段互相毁历史。
  const s = new SessionService(new InMemoryDir());
  await s.createOrResume("a");
  await expect(s.createOrResume("b")).rejects.toThrow(/已经在管 'a'/);
});

test("listSessions()：扫上一层、只读 meta、按 updatedAt 降序；活着就看得见；坏 meta 判红而不是静默少一条", async () => {
  const root = new InMemoryDir();
  const s1 = new SessionService(scoped(root, "s-1/"));
  const s2 = new SessionService(scoped(root, "s-2/"));
  await s1.createOrResume("s-1", { workspace: "/a", product: "echo-agent" });
  await s2.createOrResume("s-2", { workspace: "/a", product: "echo-coding", main: false });
  await s1.append("s-1", [{ kind: "message", message: userMessage("一") }]);
  await s1.settle();

  // **一句话没说的 s-2 也在清单里**（2026-09-04）：它正开着，别人得找得到它才能给它带话。
  // 此前把 meta 推迟到第一次入账，于是「刚打开的第二个终端」在别人眼里根本不存在（实测）。
  expect((await listSessions(root)).map((i) => i.id).sort()).toEqual(["s-1", "s-2"]);
  // 撤掉的条件是**一条 entry 都没写过**：s-1 说过话，撤不动
  expect(await s1.discardIfUnused("s-1")).toBe(false);
  expect((await listSessions(root)).map((i) => i.id).sort()).toEqual(["s-1", "s-2"]);

  await s2.append("s-2", [{ kind: "message", message: userMessage("二") }]);
  await s2.settle();
  // 产品的 --continue 靠 workspace + product + main 三维挑「本产品在本目录、自己起的那一段」
  const listed = await listSessions(root);
  expect(listed.map((i) => [i.id, i.workspace, i.product, i.main]).sort()).toEqual([
    ["s-1", "/a", "echo-agent", true],
    ["s-2", "/a", "echo-coding", false],
  ]);
  expect(listed[0]!.updatedAt).toBeGreaterThanOrEqual(listed[1]!.updatedAt); // 降序
  expect(listed.find((i) => i.id === "s-1")!.messageCount).toBe(1);

  await root.write("broken/meta.json", "{ 坏的");
  await expect(listSessions(root)).rejects.toThrow(/broken.*解不开/);
});

test("恢复失败**不解毒**——此前抛错之后 append 仍被接受", async () => {
  // 实测破坏：createOrResume 因 entry 断链抛错，随后 append() 仍被接受、
  // settle() 还返回成功，继续往一个已确认损坏的会话里写。
  const { dir } = failingAt(2);
  const s = new SessionService(dir);
  await s.createOrResume("main");
  await s.append("main", [{ kind: "message", message: userMessage("一") }]);
  await expect(s.settle()).rejects.toThrow("write-failed");

  // 让恢复失败：盘上只有一条序号为 2 的 entry（第一条压根没写成），序号断链
  await dir.write(
    "entries/000002.json",
    JSON.stringify({ kind: "message", id: "main-e2", parentId: "main-e1", message: userMessage("坏的") }),
  );
  await expect(s.createOrResume("main")).rejects.toThrow();

  // 中毒状态必须还在
  await expect(s.append("main", [{ kind: "message", message: userMessage("二") }])).rejects.toThrow(
    "已因持久化失败封存",
  );
  await expect(s.settle()).rejects.toThrow("write-failed");
});

test("内容块闭合验形：缺字段与不认识的 type 都判红", async () => {
  const bad: { name: string; block: unknown }[] = [
    { name: "text 块缺 text", block: { type: "text" } },
    { name: "image 块缺 data", block: { type: "image", mimeType: "image/png" } },
    { name: "tool_use 块缺 name", block: { type: "tool_use", id: "c1", input: {} } },
    { name: "tool_use 块缺 input", block: { type: "tool_use", id: "c1", name: "t" } },
    { name: "不认识的 type", block: { type: "tool_result", content: "x" } },
    { name: "块不是对象", block: "text" },
  ];

  for (const c of bad) {
    const dir = new InMemoryDir();
    await dir.write(
      "meta.json",
      JSON.stringify({ id: "main", name: "main", workspace: "/", product: "default", agent: { definition: {} }, main: true, status: "active", createdAt: 1, updatedAt: 1, messageCount: 1 }),
    );
    await dir.write(
      "entries/000001.json",
      JSON.stringify({
        kind: "message",
        id: "main-e1",
        parentId: null,
        message: { role: "user", source: "human", at: 1, content: [c.block] },
      }),
    );
    await expect(new SessionService(dir).createOrResume("main"), c.name).rejects.toThrow();
  }
});

test("compaction / error entry 缺 at 判红", async () => {
  for (const entry of [
    { kind: "compaction", id: "main-e1", parentId: null, reason: "auto", compaction: { spans: [], clearedBefore: 0 } },
    { kind: "error", id: "main-e1", parentId: null, error: { message: "boom" } },
  ]) {
    const dir = new InMemoryDir();
    await dir.write(
      "meta.json",
      JSON.stringify({ id: "main", name: "main", workspace: "/", product: "default", agent: { definition: {} }, main: true, status: "active", createdAt: 1, updatedAt: 1, messageCount: 0 }),
    );
    await dir.write("entries/000001.json", JSON.stringify(entry));
    await expect(new SessionService(dir).createOrResume("main")).rejects.toThrow(/缺 at/);
  }
});

/* ══════════ 并发写：CI 上真炸过的那个 ══════════ */
//
// 2026-08-18 CI 红：`FileDir.write` 的临时文件名只有 `pid + Date.now()`，同一毫秒内
// 并发写同一路径会生成**同名**临时文件——先到的 rename 走了，后到的 rename 就 ENOENT，
// 那一次写**静默丢失**。触发它的正是 `SessionService.append`：它并发发起多个 write。
//
// 本地分段跑一直是绿的，CI 单进程全量才撞出来——所以这两条用真 `FileDir`，不是内存实现。

test("并发 append 不丢写（FileDir 临时名必须进程内唯一）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "echo-session-"));
  const s = new SessionService(new FileDir(dir));
  await s.createOrResume("main");

  // 同一毫秒内打出去一批——这正是原 bug 的触发条件
  await Promise.all(
    Array.from({ length: 20 }, (_, i) => s.append("main", [{ kind: "message", message: userMessage(`第 ${i} 条`) }])),
  );
  await s.settle();

  const resumed = await new SessionService(new FileDir(dir)).createOrResume("main");
  expect(resumed.messages).toHaveLength(20); // 一条都不能少
});

test("并发 append 的 messageCount 不丢更新（meta 是读改写，必须串行）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "echo-session-"));
  const s = new SessionService(new FileDir(dir));
  await s.createOrResume("main");

  await Promise.all(
    Array.from({ length: 10 }, (_, i) => s.append("main", [{ kind: "message", message: userMessage(`m${i}`) }])),
  );
  await s.settle();

  const resumed = await new SessionService(new FileDir(dir)).createOrResume("main");
  // 并发读改写会让计数偏小：各自读到同一个旧值、各自加一、后写的盖掉先写的
  expect(resumed.info.messageCount).toBe(10);
});

test("workspace entry（2026-09-03 worktree 隔离）：切目录记成过程事实，恢复取最后一条；info.workspace（开在哪）不变；缺 workspace 判红", async () => {
  const dir = new InMemoryDir();
  const first = new SessionService(dir);
  const created = await first.createOrResume("main", { workspace: "/repo", product: "coding" });
  expect(created.workspace).toBe("/repo");
  await first.append("main", [
    { kind: "workspace", at: 1, workspace: "/repo/.echo/worktrees/a" },
    { kind: "message", message: userMessage("一") },
    { kind: "workspace", at: 2, workspace: "/repo/.echo/worktrees/b" },
  ]);
  await first.settle();

  const again = await new SessionService(dir).createOrResume("main");
  expect(again.workspace).toBe("/repo/.echo/worktrees/b");
  expect(again.info.workspace).toBe("/repo"); // 身份不动：`--continue` 按它找
  expect(again.messages.length).toBe(1);

  // 坏档：workspace entry 没有 workspace → 与其它 kind 同一姿态，判红不修
  await dir.write("entries/000004.json", JSON.stringify({ id: "main-e4", parentId: "main-e3", kind: "workspace", at: 3 }));
  await expect(new SessionService(dir).createOrResume("main")).rejects.toThrow(/workspace/);
});

test("收摊兜底：一句话都没说过的段撤掉 meta，从此不进清单；说过话的撤不动（2026-09-04）", async () => {
  // 「空会话不留痕」的新做法：活着的时候看得见（别人才能给它带话），收摊时才决定它算不算数。
  const root = new InMemoryDir();
  const silent = new SessionService(scoped(root, "s-silent/"));
  await silent.createOrResume("s-silent", { workspace: "/a", product: "echo-agent" });
  expect((await listSessions(root)).map((i) => i.id)).toEqual(["s-silent"]); // 开着的时候在

  expect(await silent.discardIfUnused("s-silent")).toBe(true);
  expect(await listSessions(root)).toEqual([]); // 收摊之后不在
  expect(await silent.discardIfUnused("s-silent")).toBe(false); // 幂等：撤过了就不再撤

  // 同一个 id 再打开 = 一段全新的会话（与「从没存在过」同一个结果）
  const again = await new SessionService(scoped(root, "s-silent/")).createOrResume("s-silent", { workspace: "/b", product: "echo-coding" });
  expect([again.info.workspace, again.messages.length]).toEqual(["/b", 0]);
});

test("seal() 之后 discardIfUnused() 不撤：状态根已不归本进程，撤掉的会是接班者的 meta（review 2026-09-07）", async () => {
  // 此前它是这个类上唯一不看 sealed 的写路径：丢锁 → Agent seal() → 宿主 stop() → 这里照样 remove meta.json，
  // 低层手接线的 Agent 就把接班者的 meta 静默删掉，stop() 还报成功。
  const root = new InMemoryDir();
  const s = new SessionService(scoped(root, "s-lost/"));
  await s.createOrResume("s-lost", { workspace: "/a", product: "echo-agent" });
  s.seal();
  expect(await s.discardIfUnused("s-lost")).toBe(false);
  expect(await root.read("s-lost/meta.json")).not.toBeNull();
  expect((await listSessions(root)).map((i) => i.id)).toEqual(["s-lost"]);
});
