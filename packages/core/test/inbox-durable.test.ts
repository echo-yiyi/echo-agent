import { test, expect } from "bun:test";
import { InboxAckError, InboxStore, type InboxAcceptOutcome } from "../src/inbox/store.ts";
import { ackCommitIdOf, scheduleDedupeKey } from "../src/inbox/records.ts";
import { addSchedule, listSchedules } from "../src/schedule/harness.ts";
import { createAgent } from "../src/create-agent.ts";
import { createProvider } from "../src/provider/models.ts";
import { createProviderStreams } from "../src/provider/dialect.ts";
import { InMemoryDir } from "../src/storage/in-memory-dir.ts";
import { InMemoryStateLock } from "../src/storage/lock.ts";
import { FakeClock } from "../src/schedule/clock.ts";
import { environmentMessage, userMessage } from "../src/messages.ts";
import { Agent } from "../src/agent.ts";
import {
  FAKE_MODEL,
  runDedupeKeyProducerConformance,
  runDurableIngressConformance,
  scriptedDialect,
  scriptedStreamFn,
  textTurn,
  toolTurn,
} from "../src/testing.ts";
import type { Provider } from "../src/provider/types.ts";
import type { StorageDir } from "../src/storage/types.ts";
import type { DurableDeliveryResult } from "../src/inbox/ingress.ts";

// 持久 Inbox（§13.9 第 10 条）：**已接受但未消费的入站事实，不因崩溃静默丢失**。
//
// inbox 原本是纯内存队列：定时任务到点了、后台活动结束了，投进来，进程一崩就没了。
// 「外面发生过这件事」是事实，不是运行时状态——它该活过进程。
//
// 投递语义是 **at-least-once**：run 结束（无论成败）才删。崩在半路会重放一次；
// 跑完了就删，不会变成死循环。要 exactly-once 得让消费方带幂等键，core 不替它决定。

function provider(): Provider {
  return createProvider({
    id: "t",
    auth: { apiKey: { resolve: async () => ({ apiKey: "x" }) } },
    defaultModelId: "only",
    models: [{ id: "only", api: "scripted" }],
    api: createProviderStreams(scriptedDialect([textTurn("收到")])),
  });
}

/** 旧的 `agent.deliverDurable(message)` 已私有化：公开面是 `agent.ingress`，dedupeKey 由调用方给。 */
async function deliverDurable(agent: Agent, message: ReturnType<typeof environmentMessage>): Promise<DurableDeliveryResult> {
  const key = message.role === "environment" && message.ref !== undefined ? `${message.source} ${message.ref}` : `delivery:${Math.random()}`;
  return agent.ingress.deliverDurable({ message, dedupeKey: key });
}

function opts(store: StorageDir, extra: Record<string, unknown> = {}): never {
  return {
    provider: provider(),
    store,
    lock: new InMemoryStateLock(),
    clock: new FakeClock(0),
    allowNetwork: false,
    ...extra,
  } as never;
}

/** 盘上真正存在的 inbox recordId（不是内存账本的投影）。 */
async function persistedIdsOf(dir: StorageDir): Promise<readonly string[]> {
  return (await dir.list("inbox/"))
    .filter((p) => /inbox\/[0-9]{6}\.json$/.test(p))
    .map((p) => p.slice("inbox/".length, -".json".length));
}

/**
 * 带控制面的 `StorageDir`：写次数、下一次写失败、卡住下一次写。
 * conformance 靠它证明「accepted 返回前已落盘」「去重命中零写入」「I/O 失败不留半条」——
 * 只看返回字段的话，一个纯内存 fake 也能把整套跑绿（review 实测过）。
 */
function instrumentedDir(inner: StorageDir): StorageDir & {
  writeCount: () => number;
  failNextWrite: () => void;
  blockNextWrite: () => () => void;
} {
  let writes = 0;
  let failNext = false;
  let gate: Promise<void> | null = null;
  let open: (() => void) | null = null;
  return {
    read: (p) => inner.read(p),
    remove: (p) => inner.remove(p),
    list: (p) => inner.list(p),
    write: async (p, c) => {
      writes += 1;
      if (failNext) {
        failNext = false;
        throw new Error("注入故障：盘挂了");
      }
      if (gate !== null) {
        const waiting = gate;
        gate = null;
        await waiting;
      }
      return inner.write(p, c);
    },
    writeCount: () => writes,
    failNextWrite: () => {
      failNext = true;
    },
    blockNextWrite: () => {
      gate = new Promise<void>((resolve) => {
        open = resolve;
      });
      return () => open?.();
    },
  };
}

test("DurableIngressPort conformance：standalone `Agent.ingress` 必须过共享的答复口径 suite", async () => {
  // 这套 suite 归 `/testing`：O3 的 Runtime / AgentHandle stable ingress 是第二个实现，跑同一份判据。
  await runDurableIngressConformance(async () => {
    const raw = new InMemoryDir();
    const dir = instrumentedDir(raw);
    const agent = await createAgent(opts(dir));
    await agent.start();
    return {
      port: agent.ingress,
      stop: () => agent.stop(),
      controls: {
        persistedRecordIds: () => persistedIdsOf(raw),
        writeCount: dir.writeCount,
        failNextWrite: dir.failNextWrite,
        blockNextWrite: dir.blockNextWrite,
      },
    };
  });
});

/* 反证：**suite 本身要有牙**。下面三种 fake 各自破坏一条 durable 契约，suite 必须判红。 */

/** 只有内存 Map、一个字节都不落盘的 fake：返回字段全都「对」。 */
function zeroPersistenceFake(): Parameters<typeof runDurableIngressConformance>[0] {
  return () => {
    const byKey = new Map<string, string>();
    let n = 0;
    return {
      port: {
        deliverDurable: async ({ dedupeKey, message }) => {
          if (dedupeKey === "" || typeof (message as { role?: unknown }).role !== "string") {
            return { kind: "rejected", reason: "invalid-request", errorDigest: "bad" };
          }
          const existing = byKey.get(dedupeKey);
          if (existing !== undefined) return { kind: "accepted", recordId: existing, dedupeKey, deduplicated: true };
          const recordId = `mem-${++n}`;
          byKey.set(dedupeKey, recordId);
          return { kind: "accepted", recordId, dedupeKey, deduplicated: false };
        },
      },
      stop: async () => undefined,
      controls: {
        persistedRecordIds: async () => [], // 盘上永远是空的
        writeCount: () => 0,
        failNextWrite: () => undefined,
        blockNextWrite: () => () => undefined,
      },
    };
  };
}

test("反证：完全不落盘的 fake 必须被 suite 判红（上一版它能跑绿）", async () => {
  await expect(runDurableIngressConformance(zeroPersistenceFake())).rejects.toThrow(/accepted 返回后盘上必须有|不许先 resolve/);
});

test("反证：Store I/O 失败改成 Promise rejection 的实现必须被判红", async () => {
  await expect(
    runDurableIngressConformance(async () => {
      // **每个场景一份新盘**：suite 会开多份 SUT，共用一份盘等于让上一场景的写入影响下一场景的判据
      const raw = new InMemoryDir();
      const dir = instrumentedDir(raw);
      const agent = await createAgent(opts(dir));
      await agent.start();
      return {
        // 把结构化 store-error 改写成 Promise rejection——正是契约禁止的那种表达
        port: {
          deliverDurable: async (req) => {
            const r = await agent.ingress.deliverDurable(req);
            if (r.kind === "rejected" && r.reason === "store-error") throw new Error("盘挂了");
            return r;
          },
        },
        stop: () => agent.stop(),
        controls: {
          persistedRecordIds: () => persistedIdsOf(raw),
          writeCount: dir.writeCount,
          failNextWrite: dir.failNextWrite,
          blockNextWrite: dir.blockNextWrite,
        },
      };
    }),
  ).rejects.toThrow(/必须 fulfill 结构化 rejected/);
});

test("反证：stop 完成之后仍答 stopping 的实现必须被判红", async () => {
  await expect(
    runDurableIngressConformance(async () => {
      // **每个场景一份新盘**：suite 会开多份 SUT，共用一份盘等于让上一场景的写入影响下一场景的判据
      const raw = new InMemoryDir();
      const dir = instrumentedDir(raw);
      const agent = await createAgent(opts(dir));
      await agent.start();
      return {
        port: {
          deliverDurable: async (req) => {
            const r = await agent.ingress.deliverDurable(req);
            // 停完之后把终态答成中间态：调用方会以为「再等等就好了」，其实这个 runtime 已经没了
            return r.kind === "rejected" && r.reason === "runtime-disposed" ? { ...r, reason: "stopping" } : r;
          },
        },
        stop: () => agent.stop(),
        controls: {
          persistedRecordIds: () => persistedIdsOf(raw),
          writeCount: dir.writeCount,
          failNextWrite: dir.failNextWrite,
          blockNextWrite: dir.blockNextWrite,
        },
      };
    }),
  ).rejects.toThrow(/必须是 runtime-disposed/);
});

test("反证：写还卡着就提前返回 accepted 的实现必须被判红（上一版的 settled 判据恒假）", async () => {
  await expect(
    runDurableIngressConformance(async () => {
      const raw = new InMemoryDir();
      const dir = instrumentedDir(raw);
      const agent = await createAgent(opts(dir));
      await agent.start();
      let blocked = false;
      return {
        port: {
          // 写被 block 时**先返回 accepted**，等 release() 之后才真的持久化——
          // 其余行为全对。这正是「accepted 只在持久化之后返回」那条要挡的实现
          deliverDurable: async (req) => {
            const real = agent.ingress.deliverDurable(req);
            if (blocked) {
              blocked = false;
              void real.catch(() => undefined);
              return { kind: "accepted", recordId: "早说的", dedupeKey: req.dedupeKey, deduplicated: false };
            }
            return real;
          },
        },
        stop: () => agent.stop(),
        controls: {
          persistedRecordIds: () => persistedIdsOf(raw),
          writeCount: dir.writeCount,
          failNextWrite: dir.failNextWrite,
          blockNextWrite: () => {
            blocked = true;
            return dir.blockNextWrite();
          },
        },
      };
    }),
  ).rejects.toThrow(/不许先 resolve/);
});

test("dedupeKey producer conformance：schedule adapter 的 key 派生必须过（常量 key 的 producer 判红）", async () => {
  // ingress 那套 suite 自己造 key，证明不了 producer 侧——固定常量 key 的责任在这里立判据。
  await runDedupeKeyProducerConformance(() => ({
    keyFor: ({ id, incarnation }) => scheduleDedupeKey("agent-1", id, incarnation),
  }));
  await expect(runDedupeKeyProducerConformance(() => ({ keyFor: () => "constant" }))).rejects.toThrow(
    /不同事实必须得到不同的 dedupeKey/,
  );
  // 反证：**非字符串 key**。唯一性判据放它过去了（`"valid"` / 1 / 2 三个值确实互不相同），
  // 所以类型必须逐个验——上一版只验了第一个
  let n = 0;
  await expect(
    runDedupeKeyProducerConformance(() => ({ keyFor: () => (n++ < 2 ? "valid" : (n as unknown as string)) })),
  ).rejects.toThrow(/必须是非空字符串/);
});

/* ───────────── InboxStore 账本本身（§14.2.4） ───────────── */

/** 造一个已恢复的账本。 */
async function ledger(dir: StorageDir): Promise<InboxStore> {
  const s = new InboxStore(dir);
  await s.restore();
  return s;
}
function accept(s: InboxStore, text: string, dedupeKey: string): Promise<InboxAcceptOutcome> {
  return s.accept({ message: userMessage(text), dedupeKey });
}
/** 与 Agent 内部同一份 tuple canonicalization。 */
function envKey(source: string, ref: string): string {
  return `env:${source.length}:${source}:${ref.length}:${ref}`;
}
function acceptedIdOf(outcome: InboxAcceptOutcome): string {
  if (outcome.kind !== "accepted") throw new Error(`期望 accepted，实际 ${JSON.stringify(outcome)}`);
  return outcome.recordId;
}
/** 盘上还剩哪些 record（不经账本，直接看文件）。 */
async function recordFiles(dir: StorageDir): Promise<string[]> {
  return (await dir.list("inbox/")).filter((p) => /inbox\/[0-9]{6}\.json$/.test(p)).sort();
}
async function ackFiles(dir: StorageDir): Promise<string[]> {
  return (await dir.list("inbox/acks/")).sort();
}
/** 可按路径注入失败的 StorageDir 包装。 */
function flaky(inner: StorageDir, fail: { write?: (p: string) => boolean; read?: (p: string) => boolean }): StorageDir {
  return {
    read: async (p) => {
      if (fail.read?.(p) === true) throw new Error("读挂了");
      return inner.read(p);
    },
    write: async (p, c) => {
      if (fail.write?.(p) === true) throw new Error("盘挂了");
      return inner.write(p, c);
    },
    remove: (p) => inner.remove(p),
    list: (p) => inner.list(p),
  };
}

test("accept / restore 保序；ack 之后 record 文件与 marker 都清掉", async () => {
  const dir = new InMemoryDir();
  const s = await ledger(dir);
  const a = acceptedIdOf(await accept(s, "一", "k1"));
  const b = acceptedIdOf(await accept(s, "二", "k2"));
  expect((await new InboxStore(dir).restore()).map((r) => r.recordId)).toEqual([a, b]); // 投递顺序

  const batch = s.reserveBatch()!;
  expect(batch.recordIds).toEqual([a, b]);
  expect(s.pendingCount).toBe(0); // reserve 走的是整批
  await s.ackBatch(batch.reservationId);
  expect(await recordFiles(dir)).toEqual([]);
  expect(await ackFiles(dir)).toEqual([]); // 整批 record 都不存在了才删 marker
  expect(await new InboxStore(dir).restore()).toEqual([]);
});

test("dedupe：同 dedupeKey 命中返回**最早那条**的 recordId + deduplicated:true，不落第二条；ack 之后同 key 又能落新的", async () => {
  const dir = new InMemoryDir();
  const s = await ledger(dir);
  const first = await accept(s, "到点了", "schedule s1");
  const again = await accept(s, "到点了", "schedule s1");
  expect(again).toEqual({ kind: "accepted", recordId: acceptedIdOf(first), dedupeKey: "schedule s1", deduplicated: true });
  expect(await recordFiles(dir)).toHaveLength(1);
  // reserve 之后仍防重：durable fact 还在盘上（防积压）
  const batch = s.reserveBatch()!;
  expect((await accept(s, "到点了", "schedule s1")).kind === "accepted" && (await accept(s, "到点了", "schedule s1")).kind).toBeTruthy();
  expect(await recordFiles(dir)).toHaveLength(1);
  await s.ackBatch(batch.reservationId);
  // ack 把整批从 index 移除：同 key 是新一次事实
  const third = await accept(s, "又到点了", "schedule s1");
  expect(third).toMatchObject({ kind: "accepted", deduplicated: false });
  expect(acceptedIdOf(third)).not.toBe(acceptedIdOf(first));
});

test("restore 从**全部 pending records** 重建 dedupe index：换实例后同 key 仍 dedupe 到原 record", async () => {
  const dir = new InMemoryDir();
  const first = await ledger(dir);
  const id = acceptedIdOf(await accept(first, "到点了", "schedule s1"));
  const second = await ledger(dir); // 换进程
  expect(await accept(second, "到点了", "schedule s1")).toEqual({ kind: "accepted", recordId: id, dedupeKey: "schedule s1", deduplicated: true });
  expect(await recordFiles(dir)).toHaveLength(1);
});

test("恢复之后接着排号，不和盘上已有的撞；坏档抛错不吞", async () => {
  const dir = new InMemoryDir();
  const first = await ledger(dir);
  await accept(first, "一", "k1");
  await accept(first, "二", "k2");
  const second = await ledger(dir);
  const third = acceptedIdOf(await accept(second, "三", "k3"));
  const all = await new InboxStore(dir).restore();
  expect(all).toHaveLength(3);
  expect(all[2]!.recordId).toBe(third);
  expect(new Set(all.map((r) => r.recordId)).size).toBe(3);

  await dir.write("inbox/000001.json", "{ 半截");
  await expect(new InboxStore(dir).restore()).rejects.toThrow(/解不开/);
});

test("**P0**：序号还没从盘上恢复就 accept → 抛，不许盖掉已有记录；ready 为 false", async () => {
  const dir = new InMemoryDir();
  await dir.write("inbox/000001.json", JSON.stringify({ id: "000001", message: environmentMessage("崩溃前那条", "x", "old"), at: 1 }));
  const fresh = new InboxStore(dir);
  expect(fresh.ready).toBe(false);
  await expect(accept(fresh, "新的", "k")).rejects.toThrow(/还没从盘上恢复/);
  const all = await new InboxStore(dir).restore();
  expect(all.map((r) => r.recordId)).toEqual(["000001"]);
  expect(JSON.stringify(all[0]!.message)).toContain("崩溃前那条");
});

test("**P0**：伪造的 recordId 不能删掉别的状态资产", async () => {
  const dir = new InMemoryDir();
  await dir.write("tasks.json", "别动我");
  await dir.write("inbox/000001.json", JSON.stringify({ recordId: "../tasks", dedupeKey: "k", message: userMessage("坏"), acceptedAt: 1 }));
  await expect(new InboxStore(dir).restore()).rejects.toThrow(/不合法|对不上/);
  expect(await dir.read("tasks.json")).toBe("别动我");
});

test("legacy migration：{id, message, at} 就地迁成 V1；有 source/ref 的按事实身份派生 dedupeKey，没有的只按 recordId（不同旧事实绝不互相去重）", async () => {
  const dir = new InMemoryDir();
  await dir.write("inbox/000001.json", JSON.stringify({ id: "000001", message: environmentMessage("到点了", "schedule", "s1"), at: 11 }));
  await dir.write("inbox/000002.json", JSON.stringify({ id: "000002", message: environmentMessage("到点了", "schedule", "s1"), at: 12 }));
  await dir.write("inbox/000003.json", JSON.stringify({ id: "000003", message: userMessage("没有身份的一条"), at: 13 }));
  await dir.write("inbox/000004.json", JSON.stringify({ id: "000004", message: userMessage("没有身份的另一条"), at: 14 }));

  const s = await ledger(dir);
  const migrated = await new InboxStore(dir).restore();
  expect(migrated.map((r) => r.recordId)).toEqual(["000001", "000002", "000003", "000004"]);
  expect(migrated[0]!.acceptedAt).toBe(11); // at → acceptedAt
  // 同 source/ref 的两条**都保留**，但新 delivery dedupe 到最早一条
  expect(migrated[0]!.dedupeKey).toBe(migrated[1]!.dedupeKey);
  // 没有稳定身份的两条各自独立
  expect(migrated[2]!.dedupeKey).not.toBe(migrated[3]!.dedupeKey);
  // 盘上已经是 V1（迁移 rewrite），再 restore 一次结果相同（幂等）
  expect(JSON.parse((await dir.read("inbox/000001.json"))!)).toMatchObject({ recordId: "000001", acceptedAt: 11 });
  expect((await new InboxStore(dir).restore()).map((r) => r.dedupeKey)).toEqual(migrated.map((r) => r.dedupeKey));
  // 新 delivery 用同一 legacy key → 命中最早那条
  const hit = await s.accept({ message: environmentMessage("到点了", "schedule", "s1"), dedupeKey: migrated[0]!.dedupeKey });
  expect(hit).toMatchObject({ kind: "accepted", recordId: "000001", deduplicated: true });
});

test("reservation：assertReserved 错序 / 不存在都抛；release 整批原序放回；新到的进下一批", async () => {
  const dir = new InMemoryDir();
  const s = await ledger(dir);
  const a = acceptedIdOf(await accept(s, "一", "k1"));
  const b = acceptedIdOf(await accept(s, "二", "k2"));
  const batch = s.reserveBatch()!;
  s.assertReserved(batch.reservationId, [a, b]); // 不抛
  expect(() => s.assertReserved(batch.reservationId, [b, a])).toThrow(/顺序/);
  expect(() => s.assertReserved("rsv:不存在", [a])).toThrow(/不存在或已消费/);
  // reserve 之后新到的：进下一批
  const c = acceptedIdOf(await accept(s, "三", "k3"));
  expect(s.pendingCount).toBe(1);
  s.releaseBatch(batch.reservationId);
  expect(s.reserveBatch()!.recordIds).toEqual([a, b, c]); // 原序在前
});

test("ack 三态之 pre-commit：marker write 失败且明确 not-found → 整批仍 pending、可重新 reserve，record 一条不删", async () => {
  const inner = new InMemoryDir();
  const dir = flaky(inner, { write: (p) => p.startsWith("inbox/acks/") });
  const s = await ledger(dir);
  const a = acceptedIdOf(await accept(s, "一", "k1"));
  const batch = s.reserveBatch()!;
  const err = await s.ackBatch(batch.reservationId).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(InboxAckError);
  expect((err as InboxAckError).verdict).toBe("pre-commit");
  expect(s.sealed).toBeNull();
  expect(await recordFiles(dir)).toEqual([`inbox/${a}.json`]);
  expect(s.reserveBatch()!.recordIds).toEqual([a]); // 整批仍 pending，可重新 reserve
});

test("ack 三态之 committed（write 报错但 marker 其实写成功了）：read-after-error 读到逐字相同 → 按已提交收尾", async () => {
  const inner = new InMemoryDir();
  // write 先真写进去、再抛：模拟「盘上成功了但调用方没收到成功」
  const dir: StorageDir = {
    read: (p) => inner.read(p),
    remove: (p) => inner.remove(p),
    list: (p) => inner.list(p),
    write: async (p, c) => {
      await inner.write(p, c);
      if (p.startsWith("inbox/acks/")) throw new Error("write 返回错误，但其实已经落盘");
    },
  };
  const s = await ledger(dir);
  await accept(s, "一", "k1");
  const batch = s.reserveBatch()!;
  await s.ackBatch(batch.reservationId); // 不抛：裁决为 committed
  expect(s.sealed).toBeNull();
  expect(await recordFiles(dir)).toEqual([]);
  expect(await ackFiles(dir)).toEqual([]);
});

test("ack 三态之 indeterminate：read 失败 / 读到不同内容 → seal intake，之后 accept 一律 store-error、reserve 抛", async () => {
  for (const mode of ["read-fails", "different-content"] as const) {
    const inner = new InMemoryDir();
    const dir: StorageDir = {
      read: async (p) => {
        if (mode === "read-fails" && p.startsWith("inbox/acks/")) throw new Error("读挂了");
        return inner.read(p);
      },
      remove: (p) => inner.remove(p),
      list: (p) => inner.list(p),
      write: async (p, c) => {
        if (p.startsWith("inbox/acks/")) {
          if (mode === "different-content") await inner.write(p, JSON.stringify({ ackCommitId: "x", recordIds: ["999999"], committedAt: 0 }));
          throw new Error("盘挂了");
        }
        await inner.write(p, c);
      },
    };
    const s = await ledger(dir);
    await accept(s, "一", "k1");
    const batch = s.reserveBatch()!;
    const err = await s.ackBatch(batch.reservationId).catch((e: unknown) => e);
    expect((err as InboxAckError).verdict, mode).toBe("indeterminate");
    expect(s.sealed, mode).not.toBeNull();
    // sealed 之后：intake 一律拒，reserve fail-loud，record 一条不删（**绝不重新投递、也不继续消费**）
    expect(await accept(s, "二", "k2")).toMatchObject({ kind: "rejected", reason: "store-error" });
    expect(() => s.reserveBatch()).toThrow(/已封/);
    expect(await recordFiles(dir)).toHaveLength(1);
  }
});

test("crash 矩阵：commit 后崩（marker 在、record 还在）→ restore 只 cleanup，**绝不重新投递**", async () => {
  const dir = new InMemoryDir();
  const s = await ledger(dir);
  const a = acceptedIdOf(await accept(s, "一", "k1"));
  const b = acceptedIdOf(await accept(s, "二", "k2"));
  const batch = s.reserveBatch()!;
  // 手工模拟：marker 已 durable，record 还没来得及删，进程就崩了
  const ackId = await ackCommitIdOf([a, b]);
  await dir.write(`inbox/acks/${ackId}.json`, JSON.stringify({ ackCommitId: ackId, recordIds: [a, b], committedAt: 1 }));
  void batch;

  const restored = await new InboxStore(dir).restore();
  expect(restored).toEqual([]); // 整批逻辑已 ack
  expect(await recordFiles(dir)).toEqual([]); // cleanup 做掉
  expect(await ackFiles(dir)).toEqual([]); // records 全没了才删 marker
});

test("crash 矩阵：commit 前崩（没有 marker）→ 整批仍 pending，重启后重放", async () => {
  const dir = new InMemoryDir();
  const s = await ledger(dir);
  await accept(s, "一", "k1");
  s.reserveBatch(); // 崩在 ack 之前：reservation 只活在内存里
  expect((await new InboxStore(dir).restore()).map((r) => r.recordId)).toEqual(["000001"]);
});

test("marker 不可信（内容重算的 ackCommitId 与文件名对不上）→ restore seal + 抛，不猜", async () => {
  const dir = new InMemoryDir();
  const s = await ledger(dir);
  const a = acceptedIdOf(await accept(s, "一", "k1"));
  const wrongId = (await ackCommitIdOf(["999999"])).replace(/.$/, "0");
  await dir.write(`inbox/acks/${wrongId}.json`, JSON.stringify({ ackCommitId: wrongId, recordIds: [a], committedAt: 1 }));
  const next = new InboxStore(dir);
  await expect(next.restore()).rejects.toThrow(/对不上|不合法/);
  expect(next.sealed).not.toBeNull();
  expect(await recordFiles(dir)).toHaveLength(1); // 一条都没动
});

test("recordId 复用防护：cleanup 没做完时，仍受 marker 保护的号不会被重新发出去", async () => {
  const dir = new InMemoryDir();
  const s = await ledger(dir);
  const a = acceptedIdOf(await accept(s, "一", "k1"));
  const ackId = await ackCommitIdOf([a]);
  await dir.write(`inbox/acks/${ackId}.json`, JSON.stringify({ ackCommitId: ackId, recordIds: [a], committedAt: 1 }));
  // record 删不掉：cleanup 卡住，marker 与 record 都留着
  const stuck: StorageDir = {
    read: (p) => dir.read(p),
    write: (p, c) => dir.write(p, c),
    list: (p) => dir.list(p),
    remove: async (p) => {
      if (/inbox\/[0-9]{6}\.json$/.test(p)) throw new Error("删不掉");
      return dir.remove(p);
    },
  };
  const next = await ledger(stuck);
  const b = acceptedIdOf(await accept(next, "二", "k2"));
  expect(b).not.toBe(a); // 不复用仍受 marker 保护的号
});

test("纯内存模式（不传 StorageDir）：构造即 ready，语义一致但不落盘", async () => {
  const s = new InboxStore(null);
  expect(s.ready).toBe(true);
  const first = await accept(s, "一", "k1");
  expect(await accept(s, "一", "k1")).toMatchObject({ kind: "accepted", recordId: acceptedIdOf(first), deduplicated: true });
  const batch = s.reserveBatch()!;
  await s.ackBatch(batch.reservationId);
  expect(s.pendingCount).toBe(0);
  expect(await accept(s, "一", "k1")).toMatchObject({ deduplicated: false }); // ack 之后是新一次事实
});

test("空 dedupeKey / 坏 message → invalid-request，不落盘", async () => {
  const dir = new InMemoryDir();
  const s = await ledger(dir);
  expect(await s.accept({ message: userMessage("x"), dedupeKey: "" })).toMatchObject({ kind: "rejected", reason: "invalid-request" });
  expect(await s.accept({ message: null as never, dedupeKey: "k" })).toMatchObject({ kind: "rejected", reason: "invalid-request" });
  expect(await recordFiles(dir)).toEqual([]);
});

test("record write 失败 → store-error，不入 pending、不进 index（之后同 key 还能再投）", async () => {
  const inner = new InMemoryDir();
  let fail = true;
  const dir = flaky(inner, { write: (p) => fail && /inbox\/[0-9]{6}\.json$/.test(p) });
  const s = await ledger(dir);
  expect(await accept(s, "一", "k1")).toMatchObject({ kind: "rejected", reason: "store-error" });
  expect(s.pendingCount).toBe(0);
  fail = false;
  expect(await accept(s, "一", "k1")).toMatchObject({ kind: "accepted", deduplicated: false });
});

/* ───────────── 接到 Agent 上 ───────────── */

test("崩溃恢复：投了没消费 → 换个进程 start() 时那条还在", async () => {
  const store = new InMemoryDir();

  const first = await createAgent(opts(store));
  await first.start();
  first.autoConsumeInbox = false; // 模拟「还没来得及消费」
  first.deliver(environmentMessage("定时任务到点了", "schedule", "s1"));
  await new Promise((r) => setTimeout(r, 5)); // 让落盘的 promise 跑完
  // 不调 stop()：模拟进程被砍

  // 新进程起来：**agent 自己就该把它吃掉**，不需要谁来调 consumeInbox()。
  // 旧版这里手动调了一次，等于绕过了「恢复之后会不会自己醒」这条判据——
  // 而那正是坏的：`start()` 只把 autoConsumeInbox 拨成 true，没有后续事件的话
  // 恢复出来的事实会永远躺在队列里（实测）。
  const second = await createAgent(opts(store));
  await second.start();
  await new Promise((r) => setTimeout(r, 20)); // 给它自己醒来的机会

  // 消费完盘上就没了 = 那条事实活过了「崩溃」，而且**是它自己吃的**
  expect(await new InboxStore(store).restore()).toHaveLength(0);
  expect(second.messages.some((m) => m.role === "environment")).toBe(true);
  await second.stop();
});

test("消费完之后盘上就没了（跑完才删，不是投完就删）", async () => {
  const store = new InMemoryDir();
  const agent = await createAgent(opts(store));
  await agent.start();
  agent.autoConsumeInbox = false;
  agent.deliver(environmentMessage("有事", "background", "b1"));
  await new Promise((r) => setTimeout(r, 5));

  // 消费之前：盘上有
  expect(await new InboxStore(store).restore()).toHaveLength(1);

  await agent.consumeInbox();
  // 消费之后：盘上没了
  expect(await new InboxStore(store).restore()).toHaveLength(0);
  await agent.stop();
});

test("低层 `new Agent()` 不传 inboxStore = 纯内存（评测与一次性跑要的就是这个）", async () => {
  const store = new InMemoryDir();
  const agent = new Agent({
    model: FAKE_MODEL,
    streamFunction: scriptedStreamFn([textTurn("收到")]),
  });
  agent.deliver(environmentMessage("有事", "background", "b1"));
  await new Promise((r) => setTimeout(r, 5));
  // 没给 store 就一个字节都不该写——`createAgent` 装配的那条路见上一条测试
  expect(await new InboxStore(store).restore()).toHaveLength(0);
  await agent.dispose();
});

/* ══════════ 2026-08-20 review：inbox 协议与统一生命周期 ══════════ */

test("**P0**：伪造的 inbox id 不能删掉别的状态资产（legacy 形状）", async () => {
  // 实测破坏：写 tasks.json → 造一条 `{"id":"../tasks"}` 的 inbox → 消费它 → tasks.json 没了。
  // `remove()` 直接拼未验证的 id，`loadAll()` 又信任 JSON 里的 id。
  const dir = new InMemoryDir();
  await dir.write("tasks.json", "[]");
  await dir.write(
    "inbox/000001.json",
    JSON.stringify({ id: "../tasks", message: environmentMessage("坏的", "x", "1"), at: 1 }),
  );

  // ① 加载就该判红：文件名与记录里的 id 对不上（legacy 形状同样要验）
  await expect(new InboxStore(dir).restore()).rejects.toThrow(/与文件名对不上|不合法/);

  // ② tasks.json 一直都在
  expect(await dir.read("tasks.json")).toBe("[]");
});

test("消费完真的删得掉——id 是同步拿到的，不会漏删成幽灵记录", async () => {
  // 实测破坏：`put()` 是 fire-and-forget，模型消费完成时 inboxIds 还没设上，
  // `forgetInbox()` 跳过删除，盘上留一条**永远重放**的记录。
  const store = new InMemoryDir();
  const agent = await createAgent(opts(store));
  await agent.start();

  await deliverDurable(agent, environmentMessage("到点了", "schedule", "s1"));
  await new Promise((r) => setTimeout(r, 20));

  expect(await new InboxStore(store).restore()).toHaveLength(0); // 没有幽灵
  await agent.stop();
});

test("**P0**：inbox 落盘失败时，schedule 不许把它记成 fired", async () => {
  // 实测破坏：inbox 写失败 → 一次性任务已经被 schedule 删掉、lastFiredAt 也刷了，
  // 于是 **inbox 里没有、schedule 里也没有**，那个事实永久消失。
  const inner = new InMemoryDir();
  let failInbox = true;
  const store: StorageDir = {
    read: (p) => inner.read(p),
    remove: (p) => inner.remove(p),
    list: (p) => inner.list(p),
    write: async (p, c) => {
      if (failInbox && p.startsWith("inbox/")) throw new Error("盘挂了");
      await inner.write(p, c);
    },
  };

  const clock = new FakeClock(0);
  const agent = await createAgent(opts(store, { clock }));
  await agent.start();
  agent.autoConsumeInbox = false;

  await addSchedule(agent.schedule!, { id: "s1", kind: "at", at: 1_000, prompt: "该干活了", createdAt: 0 });
  clock.advance(2_000);
  await new Promise((r) => setTimeout(r, 20));

  // 投递没被接受 → 一次性任务必须还在（下一拍还会重试）
  expect((await listSchedules(agent.schedule!)).length).toBe(1);

  // 盘恢复之后，同一条能正常投出去
  failInbox = false;
  clock.advance(2_000);
  await new Promise((r) => setTimeout(r, 20));
  expect((await listSchedules(agent.schedule!)).length).toBe(0);
  await agent.stop();
});

test("**P0**：启动顺序不许让 cron 补跑盖掉盘上已有的 inbox", async () => {
  // 实测破坏：`startSchedule()` 排在 `loadAll()` 之前——补跑会 deliver，而那时
  // `nextSeq` 还是 1，写出的 000001 **盖掉盘上原有的 000001**（两条最后只剩一条）。
  //
  // 判据必须真的让补跑投出去一条：cron 条目 + 上次触发在一小时以前。
  // 光有一条旧 inbox、没有 schedule 的话，这条路根本没被走到（第一版反证就这么漏的）。
  const store = new InMemoryDir();
  await store.write(
    "inbox/000001.json",
    JSON.stringify({ id: "000001", message: environmentMessage("崩溃前那条", "x", "old"), at: 1 }),
  );
  await store.write(
    "schedules.json",
    JSON.stringify([
      { schedule: { id: "c1", kind: "cron", cron: "0 * * * *", prompt: "整点提醒", createdAt: 0 }, lastFiredAt: null },
    ]),
  );

  // 本地时间的「某点 30 分」：最近一次匹配是半小时前 ≥ 60s，补跑会投一条
  const at = new Date(2026, 0, 1, 12, 30, 0).getTime();
  const agent = await createAgent(opts(store, { clock: new FakeClock(at) }));
  await agent.start();
  agent.autoConsumeInbox = false; // start() 会打开，这里关掉，别让它把证据吃了

  // 两条都在：旧的没被盖，补跑那条排在 000002
  const all = await new InboxStore(store).restore();
  expect(all.map((r) => r.recordId)).toEqual(["000001", "000002"]);
  expect(JSON.stringify(all[0]!.message)).toContain("崩溃前那条");
  await agent.stop();
});

test("**P1**：共享 store 只被关一次，且在所有写之后", async () => {
  // 实测破坏：Memory 与 Schedule 各自 `dir.close?.()`，并发关同一个 store 两次；
  // `StorageDir.close()` 的契约没要求幂等，注入一个第二次就报错的合法实现即当场失败。
  const inner = new InMemoryDir();
  let closes = 0;
  let writesAfterClose = 0;
  const store: StorageDir = {
    read: (p) => inner.read(p),
    remove: (p) => inner.remove(p),
    list: (p) => inner.list(p),
    write: async (p, c) => {
      if (closes > 0) writesAfterClose += 1;
      await inner.write(p, c);
    },
    close: async () => {
      closes += 1;
      if (closes > 1) throw new Error("重复 close（合法实现可以这么做）");
    },
  };

  const agent = await createAgent(opts(store));
  await agent.start();
  await agent.prompt("干点活");
  await agent.stop(); // 不许因为重复 close 而失败

  expect(closes).toBe(1);
  expect(writesAfterClose).toBe(0); // 关之前所有写都落完了
});

/* ── 收摊顺序：停新活动 → 等全部落盘 settle → 关一次 ── */

/**
 * 造一个「某条路径的写可以被卡住」的 store，并记下 close 之后还有没有写落下来。
 * 判据统一是 `writesAfterClose` —— 「关了之后还在写」这件事本身。
 */
function gatedStore(
  gatedPrefix: string,
  gateOpts: { armed?: boolean } = {},
): {
  store: StorageDir;
  reached: Promise<void>;
  release: () => void;
  arm: () => void;
  closes: () => number;
  writesAfterClose: () => string[];
} {
  const inner = new InMemoryDir();
  let release = (): void => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  let started = (): void => {};
  const reached = new Promise<void>((r) => {
    started = r;
  });
  let gatedOnce = false;
  let armed = gateOpts.armed ?? true; // 关着时先不卡，等 arm() 之后才卡第一次
  let closes = 0;
  const after: string[] = [];

  return {
    reached,
    release,
    arm: () => {
      armed = true;
    },
    closes: () => closes,
    writesAfterClose: () => after,
    store: {
      read: (p) => inner.read(p),
      remove: (p) => inner.remove(p),
      list: (p) => inner.list(p),
      write: async (p, c) => {
        if (armed && !gatedOnce && p.startsWith(gatedPrefix)) {
          gatedOnce = true;
          started();
          await gate;
        }
        if (closes > 0) after.push(p);
        await inner.write(p, c);
      },
      close: async () => {
        closes += 1;
      },
    },
  };
}

test("**P0**：inbox 的写卡住时 stop()，store 不许先关", async () => {
  // 实测破坏：`settleInbox()` 排在 `dispose()` 之后，而 `close()` 在 `dispose()` 里面
  // ——于是「最后关闭」只晚于 dispose 内部的活，没晚于全部 durable write。
  const g = gatedStore("inbox/");
  const agent = await createAgent(opts(g.store));
  await agent.start();
  agent.autoConsumeInbox = false;

  agent.deliver(environmentMessage("卡住的那条", "x", "1")); // 同步命令面，不等
  await g.reached; // 写确实卡住了

  const stopping = agent.stop();
  await new Promise((r) => setTimeout(r, 10));
  g.release();
  await stopping;

  expect(g.closes()).toBe(1);
  expect(g.writesAfterClose()).toEqual([]); // 关掉之后一个字节都不许再写
});

test("**P0**：schedule 那一拍卡在写 schedules.json 时 stop()，store 不许先关", async () => {
  // `stopSchedule()` 只取消后续 timer，挡不住**已经开始**的那一拍，而它还会写 schedules.json。
  // 卡的必须是 **tick 的那次写**——卡 `addSchedule()` 测的是别的东西（那是调用方自己发起的写，
  // 它握着 promise，本来就该自己等；第一版就卡错了地方）。
  const g = gatedStore("schedules.json", { armed: false });
  const clock = new FakeClock(0);
  const agent = await createAgent(opts(g.store, { clock }));
  await agent.start();
  agent.autoConsumeInbox = false;

  // 先把条目放进去（这次写不卡），再开闸——之后只有 tick 的写会被卡住
  await addSchedule(agent.schedule!, { id: "s1", kind: "at", at: 1_000, prompt: "该干活了", createdAt: 0 });
  g.arm();

  clock.advance(2_000); // 到点 → tick 投递 + 写 schedules.json（卡住）
  await g.reached;

  const stopping = agent.stop();
  await new Promise((r) => setTimeout(r, 10));
  g.release();
  await stopping;

  expect(g.closes()).toBe(1);
  expect(g.writesAfterClose()).toEqual([]);
});

/* ── 投递的两条前置：序号必须先恢复；去重要盖住「正在落盘」那段 ── */

test("锁很慢时（phase=starting、inbox 未恢复）的投递不会毁掉盘上的记录", async () => {
  const store = new InMemoryDir();
  await store.write(
    "inbox/000001.json",
    JSON.stringify({ id: "000001", message: environmentMessage("崩溃前那条", "x", "old"), at: 1 }),
  );

  // acquire 卡住：start() 停在取锁那一步，此时 agent 已经能收投递
  let release = (): void => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const inner = new InMemoryStateLock();
  const lock = {
    acquire: async (o: { holder: string }) => {
      await gate;
      return inner.acquire(o);
    },
  };

  const agent = await createAgent(opts(store, { lock }));
  const starting = agent.start();
  await new Promise((r) => setTimeout(r, 5)); // 确实卡在 acquire 上了

  // 这一投必须失败（同步命令面只报诊断），**不能落盘**
  // 账本还没 restore（ready 为 false）→ 结构化 rejected(runtime-not-ready)，**不落盘**
  expect(await deliverDurable(agent, environmentMessage("抢跑的", "x", "new"))).toMatchObject({ kind: "rejected", reason: "runtime-not-ready" });

  release();
  await starting;
  agent.autoConsumeInbox = false;

  const all = await new InboxStore(store).restore();
  expect(JSON.stringify(all[0]!.message)).toContain("崩溃前那条"); // 没被盖掉
  await agent.stop();
});

test("**P1**：并发同 (source, ref) 只落一条——去重要盖住「正在落盘」那段", async () => {
  // 旧实现只查 inboxQueue，而消息要等落盘 resolve 才入队；那段真空里第二次投递照样穿过去。
  const inner = new InMemoryDir();
  const store: StorageDir = {
    read: (p) => inner.read(p),
    remove: (p) => inner.remove(p),
    list: (p) => inner.list(p),
    write: async (p, c) => {
      if (p.startsWith("inbox/")) await new Promise((r) => setTimeout(r, 10)); // 把真空撑开
      await inner.write(p, c);
    },
  };

  const agent = await createAgent(opts(store));
  await agent.start();
  agent.autoConsumeInbox = false;

  await Promise.all([
    deliverDurable(agent, environmentMessage("到点了", "schedule", "s1")),
    deliverDurable(agent, environmentMessage("到点了", "schedule", "s1")),
  ]);

  expect(await new InboxStore(store).restore()).toHaveLength(1);
  await agent.stop();
});

test("落盘失败之后，同一个 (source, ref) 还能再投——占位不许被漏掉", async () => {
  // 这条守的是 `finally` 里那次 `pendingRefs.delete`：失败路径若不还回占位，
  // 那个 (source, ref) 就**永远投不进来**了（比重复投递更难查）。
  const inner = new InMemoryDir();
  let fail = true;
  const store: StorageDir = {
    read: (p) => inner.read(p),
    remove: (p) => inner.remove(p),
    list: (p) => inner.list(p),
    write: async (p, c) => {
      if (fail && p.startsWith("inbox/")) throw new Error("盘挂了");
      await inner.write(p, c);
    },
  };

  const agent = await createAgent(opts(store));
  await agent.start();
  agent.autoConsumeInbox = false;

  expect(await deliverDurable(agent, environmentMessage("到点了", "schedule", "s1"))).toMatchObject({ kind: "rejected", reason: "store-error" });
  fail = false;
  await deliverDurable(agent, environmentMessage("到点了", "schedule", "s1")); // 不该被占位挡住

  expect(await new InboxStore(store).restore()).toHaveLength(1);
  await agent.stop();
});

test("**P1**：撞上在飞投递的第二个调用方，成败跟着首个走", async () => {
  // 实测破坏：命中去重就直接 return，第二个调用方**在落盘完成前**就 resolved；
  // 首个随后 rejected —— 于是它以为「已被持久接受」，而盘上什么都没有，
  // 恰好违反 `deliverDurable()` 承诺的确认语义。
  const inner = new InMemoryDir();
  let release = (): void => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const store: StorageDir = {
    read: (p) => inner.read(p),
    remove: (p) => inner.remove(p),
    list: (p) => inner.list(p),
    write: async (p, c) => {
      if (p.startsWith("inbox/")) {
        await gate;
        throw new Error("盘挂了");
      }
      await inner.write(p, c);
    },
  };

  const agent = await createAgent(opts(store));
  await agent.start();
  agent.autoConsumeInbox = false;

  const first = deliverDurable(agent, environmentMessage("到点了", "schedule", "s1"));
  await new Promise((r) => setTimeout(r, 5)); // 首个已经卡在落盘上
  const second = deliverDurable(agent, environmentMessage("到点了", "schedule", "s1"));

  let secondSettled = false;
  void second.then(
    () => (secondSettled = true),
    () => (secondSettled = true),
  );
  await new Promise((r) => setTimeout(r, 10));
  expect(secondSettled, "第二个调用方在落盘完成前就返回了").toBe(false);

  release();
  const [a, b] = await Promise.allSettled([first, second]);
  // 运行期失败是结构化 result（不是 Promise rejection）：两个调用方拿到的是**同一份** store-error
  expect(a.status === "fulfilled" && a.value).toMatchObject({ kind: "rejected", reason: "store-error" });
  expect(b.status === "fulfilled" && b.value).toMatchObject({ kind: "rejected", reason: "store-error" }); // 成败一并继承，不许凭空说成功
  expect(await new InboxStore(store).restore()).toHaveLength(0);
  await agent.stop().catch(() => undefined);
});

test("首个成功时，撞上的那个也算成功（共享结果，不是各投一条）", async () => {
  const inner = new InMemoryDir();
  const store: StorageDir = {
    read: (p) => inner.read(p),
    remove: (p) => inner.remove(p),
    list: (p) => inner.list(p),
    write: async (p, c) => {
      if (p.startsWith("inbox/")) await new Promise((r) => setTimeout(r, 10));
      await inner.write(p, c);
    },
  };

  const agent = await createAgent(opts(store));
  await agent.start();
  agent.autoConsumeInbox = false;

  const [a, b] = await Promise.allSettled([
    deliverDurable(agent, environmentMessage("到点了", "schedule", "s1")),
    deliverDurable(agent, environmentMessage("到点了", "schedule", "s1")),
  ]);
  expect(a.status).toBe("fulfilled");
  expect(b.status).toBe("fulfilled");
  expect(await new InboxStore(store).restore()).toHaveLength(1); // 仍然只落一条
  await agent.stop();
});

/* ─────────────── review 反例：restore 半途失败 / ack barrier / incarnation / 规范化副本 / 可见失败 / stopping ─────────────── */

test("**P0**：restore 后半段（cleanup）失败 → restore reject 且 ready 仍为 false，ingress 一律 runtime-not-ready、零写入", async () => {
  const inner = new InMemoryDir();
  const seed = await ledger(inner);
  const a = acceptedIdOf(await accept(seed, "一", "k1"));
  const ackId = await ackCommitIdOf([a]);
  await inner.write(`inbox/acks/${ackId}.json`, JSON.stringify({ ackCommitId: ackId, recordIds: [a], committedAt: 1 }));

  // cleanup 里那次 read（确认 record 是否已删）挂掉：restore 必须 reject
  let boom = true;
  const dir: StorageDir = {
    read: async (p) => {
      if (boom && /inbox\/[0-9]{6}\.json$/.test(p) && (await inner.read(p)) === null) throw new Error("读挂了");
      return inner.read(p);
    },
    write: (p, c) => inner.write(p, c),
    remove: (p) => inner.remove(p),
    list: (p) => inner.list(p),
  };
  const s = new InboxStore(dir);
  await expect(s.restore()).rejects.toThrow(/读挂了/);
  // 上一版：restored 在 cleanup 之前就置了位，reject 之后 ready 仍是 true——上层可能已经释放 Lease 却还能写
  expect(s.ready).toBe(false);
  await expect(accept(s, "新的", "k9")).rejects.toThrow(/还没从盘上恢复/);

  // Agent 侧：start() 失败（phase 退回 new）之后，公开 ingress 只能是 runtime-not-ready，盘上一条不多
  boom = true;
  const agent = await createAgent(opts(dir));
  await expect(agent.start()).rejects.toThrow();
  const before = await recordFiles(dir);
  expect(await deliverDurable(agent, environmentMessage("抢跑的", "x", "new"))).toMatchObject({ kind: "rejected", reason: "runtime-not-ready" });
  boom = false;
  expect(await recordFiles(dir)).toEqual(before);
});

test("**P0** ack barrier：marker 已 durable、ackBatch 还没返回时，同 key 的 accept 必须等裁决——committed → 落新 record（事实不消失）", async () => {
  const inner = new InMemoryDir();
  let releaseWrite = (): void => {};
  const gate = new Promise<void>((r) => {
    releaseWrite = r;
  });
  const dir: StorageDir = {
    read: (p) => inner.read(p),
    remove: (p) => inner.remove(p),
    list: (p) => inner.list(p),
    write: async (p, c) => {
      await inner.write(p, c);
      if (p.startsWith("inbox/acks/")) await gate; // marker 已落盘，调用方还没拿到返回
    },
  };
  const s = await ledger(dir);
  const old = acceptedIdOf(await accept(s, "到点了", "schedule s1"));
  const batch = s.reserveBatch()!;
  const acking = s.ackBatch(batch.reservationId);
  await new Promise((r) => setTimeout(r, 5)); // 确实卡在 marker write 上了

  let racedSettled = false;
  const raced = accept(s, "又到点了", "schedule s1");
  void raced.then(() => (racedSettled = true));
  await new Promise((r) => setTimeout(r, 5));
  // 上一版：这里直接 dedupe 到 old 并返回；崩溃后 marker 把 old 清掉，新事实永久消失
  expect(racedSettled, "同 key 的 accept 在裁决出来之前就返回了").toBe(false);

  releaseWrite();
  await acking;
  const result = await raced;
  expect(result).toMatchObject({ kind: "accepted", deduplicated: false });
  expect(acceptedIdOf(result)).not.toBe(old);
  // 重启：新事实还在（旧的已被 marker 清掉）
  expect((await new InboxStore(dir).restore()).map((r) => r.recordId)).toEqual([acceptedIdOf(result)]);
});

test("ack barrier：pre-commit 裁决 → 同 key 仍 dedupe 到旧事实；indeterminate → store-error", async () => {
  for (const mode of ["pre-commit", "indeterminate"] as const) {
    const inner = new InMemoryDir();
    let releaseWrite = (): void => {};
    const gate = new Promise<void>((r) => {
      releaseWrite = r;
    });
    const dir: StorageDir = {
      read: async (p) => {
        if (mode === "indeterminate" && p.startsWith("inbox/acks/")) throw new Error("读挂了");
        return inner.read(p);
      },
      remove: (p) => inner.remove(p),
      list: (p) => inner.list(p),
      write: async (p, c) => {
        if (p.startsWith("inbox/acks/")) {
          await gate;
          throw new Error("盘挂了"); // 没落盘
        }
        await inner.write(p, c);
      },
    };
    const s = await ledger(dir);
    const old = acceptedIdOf(await accept(s, "到点了", "k1"));
    const batch = s.reserveBatch()!;
    const acking = s.ackBatch(batch.reservationId).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 5));
    const raced = accept(s, "又到点了", "k1");
    releaseWrite();
    await acking;
    const result = await raced;
    if (mode === "pre-commit") expect(result, mode).toMatchObject({ kind: "accepted", recordId: old, deduplicated: true });
    else expect(result, mode).toMatchObject({ kind: "rejected", reason: "store-error" });
  }
});

test("message 规范化：形状不合法直接 invalid-request；accepted 之后调用方改原对象，当前进程与重启后看到的是**同一份**", async () => {
  const dir = new InMemoryDir();
  const s = await ledger(dir);
  // 缺 content / source 的内建消息：上一版只验 role，这种能进账本
  expect(await s.accept({ message: { role: "user", at: 1 } as never, dedupeKey: "k0" })).toMatchObject({ kind: "rejected", reason: "invalid-request" });

  const mutable = environmentMessage("before", "bg", "b1");
  expect(await s.accept({ message: mutable, dedupeKey: "k1" })).toMatchObject({ kind: "accepted" });
  (mutable.content[0] as { text: string }).text = "after"; // 调用方随后改了自己的对象
  const batch = s.reserveBatch()!;
  const inMemory = JSON.stringify(batch.messages[0]);
  const onDisk = JSON.stringify((await new InboxStore(dir).restore())[0]!.message);
  expect(inMemory).toContain("before");
  expect(inMemory).toBe(onDisk); // 上一版：内存里是 "after"、盘上是 "before"
});

test("errorDigest 是真 digest：16 位十六进制，不含错误原文", async () => {
  const inner = new InMemoryDir();
  const dir = flaky(inner, { write: (p) => /inbox\/[0-9]{6}\.json$/.test(p) });
  const s = await ledger(dir);
  const r = await accept(s, "一", "k1");
  expect(r.kind).toBe("rejected");
  const digest = (r as { errorDigest?: string }).errorDigest ?? "";
  expect(digest).toMatch(/^[0-9a-f]{16}$/);
  expect(digest).not.toContain("盘挂了");
});

test("序号耗尽：结构化 store-error + 封账本，不抛给调用方、也不产生 unhandled rejection", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (e: unknown): void => {
    unhandled.push(e);
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    const s = new InboxStore(null);
    (s as unknown as { nextSeq: number }).nextSeq = 1_000_000; // 定长 6 位的上限之外
    expect(await accept(s, "一", "k1")).toMatchObject({ kind: "rejected", reason: "store-error", errorDigest: "sequence-exhausted" });
    expect(s.sealed).not.toBeNull();
    await new Promise((r) => setTimeout(r, 10));
    expect(unhandled).toEqual([]);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("公共 schema 文件不含真实 NUL 字节（否则 git 当成 binary，整份 schema 没法按文本 review）", async () => {
  // 路径相对**本模块**解析：按 CLAUDE.md 的分段口径跑（`cd packages/core && bun test`）时，
  // 仓库根相对路径会 ENOENT——同一道门在两种 cwd 下必须给同一个结果。
  for (const file of ["../src/inbox/records.ts", "../src/inbox/store.ts", "../src/inbox/ingress.ts"]) {
    const path = new URL(file, import.meta.url).pathname;
    const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
    expect(bytes.includes(0), file).toBe(false);
  }
});

test("Schedule dedupeKey 用 incarnation：同一 ID、不同 createdAt 是**两个事实**", async () => {
  const a = await scheduleDedupeKey("agent-1", "s1", 100);
  const b = await scheduleDedupeKey("agent-1", "s1", 200); // 删掉后重建
  const c = await scheduleDedupeKey("agent-2", "s1", 100); // 另一个 agent
  expect(new Set([a, b, c]).size).toBe(3);
  expect(await scheduleDedupeKey("agent-1", "s1", 100)).toBe(a); // 同 incarnation 的多次到点仍防积压
});

test("普通 (source, ref) 的 dedupeKey 无歧义：(\"a b\", \"c\") 与 (\"a\", \"b c\") 不撞", async () => {
  const dir = new InMemoryDir();
  const s = await ledger(dir);
  const one = await s.accept({ message: environmentMessage("x", "a b", "c"), dedupeKey: envKey("a b", "c") });
  const two = await s.accept({ message: environmentMessage("y", "a", "b c"), dedupeKey: envKey("a", "b c") });
  expect(acceptedIdOf(one)).not.toBe(acceptedIdOf(two));
  expect(await recordFiles(dir)).toHaveLength(2);
});

test("indeterminate 之后 Agent 进入**可见失败**：不再消费 inbox、prompt 被拒、state.lastError 留着", async () => {
  const inner = new InMemoryDir();
  const dir: StorageDir = {
    read: async (p) => {
      if (p.startsWith("inbox/acks/")) throw new Error("读挂了");
      return inner.read(p);
    },
    remove: (p) => inner.remove(p),
    list: (p) => inner.list(p),
    write: async (p, c) => {
      if (p.startsWith("inbox/acks/")) throw new Error("盘挂了");
      await inner.write(p, c);
    },
  };
  const store = new InboxStore(dir);
  await store.restore();
  const agent = new Agent({ model: FAKE_MODEL, streamFunction: scriptedStreamFn([textTurn("收到"), textTurn("再来")]), inboxStore: store });
  const notes: string[] = [];
  agent.subscribeLifecycle((e) => {
    if (e.type === "notification") notes.push(e.message);
  });
  agent.deliver(environmentMessage("有事", "bg", "b1"));
  await new Promise((r) => setTimeout(r, 5));
  const result = await agent.consumeInbox();
  expect(result?.outcome.kind).toBe("completed"); // run 确实发生过，不假装没跑

  // 上一版：只发一条通知，Agent 照样 idle、prompt 还能继续 —— 与「indeterminate → 可见 FAILED」冲突
  expect(store.sealed).not.toBeNull();
  expect(agent.state.lastError?.message).toContain("无法裁决");
  expect(notes.some((m) => m.includes("[inbox_indeterminate]"))).toBe(true);
  expect(agent.autoConsumeInbox).toBe(false);
  await expect(agent.prompt("还能干活吗")).rejects.toThrow(/Inbox 账本无法裁决/);
  expect(await agent.consumeInbox()).toBeNull();
});

test("stop() 进行中返回 stopping，完全停下之后才是 runtime-disposed", async () => {
  const store = new InMemoryDir();
  let releaseDispose = (): void => {};
  const slow = new Promise<void>((r) => {
    releaseDispose = r;
  });
  const agent = await createAgent(opts(store, { agent: { disposables: [{ dispose: () => slow }] } }));
  await agent.start();
  agent.autoConsumeInbox = false;

  const stopping = agent.stop();
  await new Promise((r) => setTimeout(r, 5)); // 卡在慢 disposer 上
  // 上一版先判 disposeInFlight：stop() 内部必然调 dispose()，于是整个收摊过程都报成 runtime-disposed
  expect(await deliverDurable(agent, environmentMessage("收摊中", "x", "1"))).toMatchObject({ kind: "rejected", reason: "stopping" });
  releaseDispose();
  await stopping;
  expect(await deliverDurable(agent, environmentMessage("停了", "x", "2"))).toMatchObject({ kind: "rejected", reason: "runtime-disposed" });
});

/* ─────────────── review 反例 2：JSON 静默改写 / 裁决前不排下一轮 ─────────────── */

test("JSON 会静默改写的值一律 invalid-request：at: NaN 与 tool_use.input: undefined 都进不了账本（否则重启时卡在恢复）", async () => {
  const dir = new InMemoryDir();
  const s = await ledger(dir);

  // at: NaN 能过验形（typeof 是 number），但落盘变成 null → 新进程 restore 报「缺信封字段 at」
  const nan = { ...userMessage("一"), at: Number.NaN };
  expect(await s.accept({ message: nan, dedupeKey: "k-nan" })).toMatchObject({ kind: "rejected", reason: "invalid-request" });

  // tool_use.input: undefined 能过验形（"input" in b 为真），但落盘后整个键消失 → 恢复时报缺 input
  const withToolUse = {
    role: "assistant" as const,
    content: [{ type: "tool_use" as const, id: "c1", name: "t", input: undefined }],
    stopReason: "tool_use" as const,
    usage: null,
    at: 1,
  };
  expect(await s.accept({ message: withToolUse as never, dedupeKey: "k-undef" })).toMatchObject({ kind: "rejected", reason: "invalid-request" });

  // 非 plain 对象（Date 会被 toJSON 变成字符串）同样拒
  const withDate = { ...userMessage("二"), at: 1, extra: new Date() };
  expect(await s.accept({ message: withDate as never, dedupeKey: "k-date" })).toMatchObject({ kind: "rejected", reason: "invalid-request" });

  expect(await recordFiles(dir)).toEqual([]);
  // 盘上什么都没落，恢复自然干净
  expect(await new InboxStore(dir).restore()).toEqual([]);
});

test("等 ack barrier 期间调用方改了原对象：账本用的是**第一次取的副本**，不回头重读 request", async () => {
  const inner = new InMemoryDir();
  let releaseWrite = (): void => {};
  const gate = new Promise<void>((r) => {
    releaseWrite = r;
  });
  const dir: StorageDir = {
    read: (p) => inner.read(p),
    remove: (p) => inner.remove(p),
    list: (p) => inner.list(p),
    write: async (p, c) => {
      await inner.write(p, c);
      if (p.startsWith("inbox/acks/")) await gate;
    },
  };
  const s = await ledger(dir);
  await accept(s, "旧的", "k1");
  const batch = s.reserveBatch()!;
  const acking = s.ackBatch(batch.reservationId);
  await new Promise((r) => setTimeout(r, 5));

  const mutable = environmentMessage("before", "bg", "b1");
  const raced = s.accept({ message: mutable, dedupeKey: "k1" });
  await new Promise((r) => setTimeout(r, 5));
  (mutable.content[0] as { text: string }).text = "after"; // 等裁决那段时间里改了自己的对象
  releaseWrite();
  await acking;
  const result = await raced;
  expect(result).toMatchObject({ kind: "accepted", deduplicated: false });
  // 上一版 barrier 放行后重读 request：落盘的会变成 "after"
  const onDisk = JSON.stringify((await new InboxStore(dir).restore())[0]!.message);
  expect(onDisk).toContain("before");
  expect(onDisk).not.toContain("after");
});

test("**P1**：整批 ack 裁决为 indeterminate 时，下一批 Inbox 与 Dream 都不许已经起跑（只有一次 agent_start）", async () => {
  const inner = new InMemoryDir();
  let failAcks = false;
  const dir: StorageDir = {
    read: async (p) => {
      if (failAcks && p.startsWith("inbox/acks/")) throw new Error("读挂了");
      return inner.read(p);
    },
    remove: (p) => inner.remove(p),
    list: (p) => inner.list(p),
    write: async (p, c) => {
      if (failAcks && p.startsWith("inbox/acks/")) throw new Error("盘挂了");
      await inner.write(p, c);
    },
  };
  const store = new InboxStore(dir);
  await store.restore();
  let agent!: Agent;
  const tool = {
    kind: "model" as const,
    name: "t",
    label: "t",
    description: "t",
    parameters: { type: "object", properties: {} },
    // 第一批还在跑的时候，第二条事实进来
    execute: async () => {
      agent.deliver(environmentMessage("第二条", "bg", "b2"));
      await new Promise((r) => setTimeout(r, 5));
      return { content: "ok", isError: false, metadata: null };
    },
  };
  agent = new Agent({
    model: FAKE_MODEL,
    streamFunction: scriptedStreamFn([
      toolTurn("c1", "t", {}),
      textTurn("收工"),
      textTurn("不该有的第二轮"),
    ]),
    tools: [tool],
    inboxStore: store,
    autoConsumeInbox: true,
    autoDream: true,
  });
  let starts = 0;
  agent.subscribe((e) => {
    if (e.type === "agent_start") starts += 1;
  });

  agent.deliver(environmentMessage("第一条", "bg", "b1"));
  await new Promise((r) => setTimeout(r, 5));
  failAcks = true; // 这一批的 ack 会裁决成 indeterminate
  await agent.consumeInbox();
  await new Promise((r) => setTimeout(r, 20)); // 给「万一已经起跑」的第二轮足够时间露头

  // 上一版：finishRun() 在 ack 裁决之前就排了下一批，第二轮已经拿到 admission（实测两次 agent_start）
  expect(starts).toBe(1);
  expect(store.sealed).not.toBeNull();
  expect(agent.autoConsumeInbox).toBe(false);
  expect(agent.autoDream).toBe(false);
  expect(agent.state.lastError?.message).toContain("无法裁决");
  expect(store.pendingCount).toBe(1); // 第二条事实还躺在账本里，没被吃掉
});

test("裁决为 committed / pre-commit 时，下一批照常起跑（拆开 finishRun 没把正常路径也停掉）", async () => {
  const store = new InboxStore(null); // 内存模式：ack 直接封口 = committed
  let agent!: Agent;
  const tool = {
    kind: "model" as const,
    name: "t",
    label: "t",
    description: "t",
    parameters: { type: "object", properties: {} },
    execute: async () => {
      agent.deliver(environmentMessage("第二条", "bg", "b2"));
      return { content: "ok", isError: false, metadata: null };
    },
  };
  agent = new Agent({
    model: FAKE_MODEL,
    streamFunction: scriptedStreamFn([
      toolTurn("c1", "t", {}),
      textTurn("收工"),
      textTurn("第二轮"),
    ]),
    tools: [tool],
    inboxStore: store,
    autoConsumeInbox: true,
  });
  let starts = 0;
  agent.subscribe((e) => {
    if (e.type === "agent_start") starts += 1;
  });
  agent.deliver(environmentMessage("第一条", "bg", "b1"));
  await new Promise((r) => setTimeout(r, 5));
  await agent.consumeInbox();
  await new Promise((r) => setTimeout(r, 20));
  expect(starts).toBe(2); // 第二批自己起跑了
  expect(store.pendingCount).toBe(0);
});

test("**P1**：ack 还没裁决（marker write 卡着）时 prompt() 必须被拒——始终只有一次 agent_start", async () => {
  const inner = new InMemoryDir();
  let releaseWrite = (): void => {};
  const gate = new Promise<void>((r) => {
    releaseWrite = r;
  });
  const dir: StorageDir = {
    read: async (p) => {
      if (p.startsWith("inbox/acks/")) throw new Error("读挂了"); // read-after-error 也失败 → indeterminate
      return inner.read(p);
    },
    remove: (p) => inner.remove(p),
    list: (p) => inner.list(p),
    write: async (p, c) => {
      if (p.startsWith("inbox/acks/")) {
        await gate; // 卡在 marker write 上：裁决迟迟不出来
        throw new Error("盘挂了");
      }
      await inner.write(p, c);
    },
  };
  const store = new InboxStore(dir);
  await store.restore();
  const agent = new Agent({
    model: FAKE_MODEL,
    streamFunction: scriptedStreamFn([textTurn("收到"), textTurn("不该有的第二轮")]),
    inboxStore: store,
  });
  let starts = 0;
  agent.subscribe((e) => {
    if (e.type === "agent_start") starts += 1;
  });

  agent.deliver(environmentMessage("有事", "bg", "b1"));
  await new Promise((r) => setTimeout(r, 5));
  const consuming = agent.consumeInbox();
  await new Promise((r) => setTimeout(r, 10)); // run 已跑完，卡在 marker write 上

  // 上一版：closeRun() 清了 activeRun、标记也提前清掉，这一 prompt 直接拿到新 permit（agent_start 变 2）
  await expect(agent.prompt("插一脚")).rejects.toThrow(/等 ack 裁决/);
  expect(starts).toBe(1);

  releaseWrite();
  await consuming;
  expect(store.sealed).not.toBeNull();
  expect(starts).toBe(1);
  // 裁决出来了（indeterminate）：之后是失败态的拒绝理由，不再是「等裁决」
  await expect(agent.prompt("还能干活吗")).rejects.toThrow(/无法裁决/);
  expect(starts).toBe(1);
});

test("裁决为 committed 之后标记就放开：prompt() 照常能跑（等待闸没把正常路径焊死）", async () => {
  const store = new InboxStore(null); // 内存模式：ack 直接封口
  const agent = new Agent({
    model: FAKE_MODEL,
    streamFunction: scriptedStreamFn([textTurn("收到"), textTurn("接着干")]),
    inboxStore: store,
  });
  agent.deliver(environmentMessage("有事", "bg", "b1"));
  await new Promise((r) => setTimeout(r, 5));
  expect((await agent.consumeInbox())?.outcome.kind).toBe("completed");
  expect((await agent.prompt("接着干")).outcome.kind).toBe("completed");
});

test("ack 窗口：`closeRun()` 已归 idle，但 `acceptsWork` 仍为 false —— 壳子拿 status 判空闲会撞上这里", async () => {
  // review 四轮之后的第五条（TUI 用阻塞 ack 的真 InboxStore 实测到）：
  // core 在 Inbox run 之后的顺序是 `closeRun()`（置 `status = "idle"`）→ `await ackBatch()`
  // → 清 `inboxTicketOutstanding`。中间这一段 `status` 已经是 idle，`prompt()` 却照拒——
  // 于是任何按 `status` 判「空了」的壳子都会在这里清空用户输入、发出去、再显示一句拒绝。
  //
  // 这条把那一刻钉死：**`acceptsWork` 必须与 `prompt()` 同真同假**。
  const dir = new InMemoryDir();
  let releaseAck = (): void => {};
  const ackGate = new Promise<void>((r) => {
    releaseAck = r;
  });
  class SlowAckStore extends InboxStore {
    override async ackBatch(reservationId: string): Promise<void> {
      await ackGate;
      return super.ackBatch(reservationId);
    }
  }
  const store = new SlowAckStore(dir);
  await store.restore();
  const agent = new Agent({ model: FAKE_MODEL, streamFunction: scriptedStreamFn([textTurn("收到")]), inboxStore: store });
  agent.autoConsumeInbox = false; // 手动消费，免得自动那条抢在前面，判据就不确定了

  agent.deliver(environmentMessage("有事", "bg", "b1"));
  await new Promise((r) => setTimeout(r, 5)); // deliver 是异步落盘的：不等这一拍，队列还是空的
  const consuming = agent.consumeInbox(); // 不 await：它会卡在 ackBatch 里
  await new Promise((r) => setTimeout(r, 20));

  // ——— review 实测到的那一刻 ———
  expect(agent.status).toBe("idle"); // closeRun() 已经跑过：拿它判空闲就是在这里出错的
  expect(agent.acceptsWork).toBe(false); // 而 ack 裁决还没出来
  await expect(agent.prompt("插一句")).rejects.toThrow(/ack 裁决/); // 与上一行同真同假

  releaseAck();
  await consuming;
  expect(agent.acceptsWork).toBe(true); // 裁决出来了才真的放行
  await agent.prompt("现在可以了").catch(() => undefined); // 不再被拒（脚本用尽会报别的错，不看它）
});
