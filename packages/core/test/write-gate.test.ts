// §14.9 状态根写入资格：LeaseIdentityCell 三态 / 五条 enforced lane / activeBusinessMode /
// adoptStorageView 的 fail-closed，以及 Agent 的 revoke fence 顺序（release 之前 revoke、丢锁不补 flush）。
//
// Agent 级的几条**一律对真 adopted view 断言**：只断言 `prompt()` / `ingress` 被拒是没有区分力的——
// 那两条本来就有别的闸挡着，把 `gate.revoke()` 删掉照样绿。

import { test, expect } from "bun:test";
import { Agent } from "../src/agent.ts";
import { InMemoryDir } from "../src/storage/in-memory-dir.ts";
import { InMemoryStateLock } from "../src/storage/lock.ts";
import { scriptedStreamFn, textTurn } from "../src/testing.ts";
import { adoptStorageView, createStateWriteGate, StateWriteDenied, type LeaseIdentity, type StateWriteGate } from "../src/state/write-gate.ts";
import { attachStateHost } from "../src/state/host-wiring.ts";
import type { StateLeaseLifecycle } from "../src/state/lease-lifecycle.ts";
import { SessionService } from "../src/session/service.ts";
import type { StateLock } from "../src/storage/lock.ts";
import type { StorageDir } from "../src/storage/types.ts";

/* ─────────────── cell 三态 ─────────────── */

test("LeaseIdentityCell：empty → installed → revoked；revoked 之后装不回去，重复 install 也抛", () => {
  const gate = createStateWriteGate();
  expect(gate.cell.state()).toBe("empty");
  expect(gate.cell.current()).toBeNull();
  expect(gate.isOpen()).toBe(false);

  const identity = gate.install({ agentInstanceId: "a@1", acquisitionId: "acq-1" });
  expect(gate.cell.state()).toBe("installed");
  expect(gate.cell.current()).toBe(identity);
  expect(gate.isOpen()).toBe(true);
  expect(() => gate.install({ agentInstanceId: "a@1", acquisitionId: "acq-2" })).toThrow(/已经装过/);

  gate.revoke();
  expect(gate.cell.state()).toBe("revoked");
  expect(gate.isOpen()).toBe(false);
  // **revoke 是永久的**：旧 view 不可重新激活，fresh rollback 必须重建一整套
  expect(() => gate.install({ agentInstanceId: "a@1", acquisitionId: "acq-3" })).toThrow(/已 revoke/);
});

/* ─────────────── adoptStorageView 的 fail-closed ─────────────── */

test("adoptStorageView：读直通、写受闸；cell 为空（尚未 start）时写与删都 fail-closed，读照样可用", async () => {
  const raw = new InMemoryDir();
  await raw.write("seed.json", "已有内容");
  const gate = createStateWriteGate();
  const view = adoptStorageView(raw, gate.authorityFor("echo:test", { lanes: ["restore-migration"], activeBusiness: true }));

  expect(await view.read("seed.json")).toBe("已有内容"); // 读不受闸管
  expect(await view.list("")).toEqual(["seed.json"]);
  await expect(view.write("x.json", "写不进去")).rejects.toBeInstanceOf(StateWriteDenied);
  await expect(view.remove("seed.json")).rejects.toThrow(/cell 为空/);
  expect(await raw.read("seed.json")).toBe("已有内容"); // 真 I/O 一次都没发生
});

test("activeBusinessMode：open / draining 放行有资格的能力，closed 拒；没资格的能力只能靠 lane", async () => {
  const raw = new InMemoryDir();
  const gate = createStateWriteGate();
  const business = adoptStorageView(raw, gate.authorityFor("echo:business", { activeBusiness: true }));
  const laneOnly = adoptStorageView(raw, gate.authorityFor("echo:lane-only", { lanes: ["canonical-observation"] }));
  gate.install({ agentInstanceId: "a@1", acquisitionId: "acq" });

  await expect(business.write("b.json", "1")).rejects.toThrow(/没有开放的通道/); // 缺省 closed
  gate.setActiveBusinessMode("open");
  await business.write("b.json", "1");
  gate.setActiveBusinessMode("draining");
  await business.write("b.json", "2"); // draining：barrier 前已开始的照样写得完
  // 没资格走 active business 的，open 期间也不放行
  await expect(laneOnly.write("l.json", "1")).rejects.toThrow(/无资格/);
  gate.openLane("canonical-observation");
  await laneOnly.write("l.json", "1");
  gate.setActiveBusinessMode("closed");
  await expect(business.write("b.json", "3")).rejects.toThrow(/没有开放的通道/);
  expect(await raw.read("b.json")).toBe("2");
});

test("身份不符：view 攥着的 cell 与根闸认的不是同一代 → 拒（这条判据不是死代码）", async () => {
  const raw = new InMemoryDir();
  const gate = createStateWriteGate();
  const view = adoptStorageView(raw, gate.authorityFor("echo:test", { activeBusiness: true }));
  // 绕过 gate.install() 直接往 cell 里塞一个身份：cell 说 installed，根闸却不认它
  gate.cell.install({ agentInstanceId: "a@1", acquisitionId: "acq" } as unknown as LeaseIdentity);
  gate.setActiveBusinessMode("open");
  expect(gate.cell.state()).toBe("installed");
  await expect(view.write("x.json", "1")).rejects.toThrow(/身份与当前租约不符/);
});

test("五条 enforced lane 逐条验：只有自己那条开着才放行，别人的 lane 全开也借不到道", async () => {
  const lanes = ["restore-migration", "durable-ingress", "managed-activation", "lifecycle-finalization", "canonical-observation"] as const;
  for (const mine of lanes) {
    const raw = new InMemoryDir();
    const gate = createStateWriteGate();
    const view = adoptStorageView(raw, gate.authorityFor(`echo:${mine}`, { lanes: [mine] }));
    gate.install({ agentInstanceId: "a@1", acquisitionId: "acq" });
    for (const other of lanes) if (other !== mine) gate.openLane(other);
    await expect(view.write("x.json", "1"), mine).rejects.toThrow(/没有开放的通道/);
    const close = gate.openLane(mine);
    await view.write("x.json", "1");
    expect(await raw.read("x.json"), mine).toBe("1");
    close();
    await expect(view.write("x.json", "2"), mine).rejects.toThrow(/没有开放的通道/);
  }
});

/* ─────────────── Agent 的 fence 顺序（对真 adopted view 断言） ─────────────── */

/** 手搭一个受生命周期管的 Agent：真 gate、真 adopted view、真 lock。 */
function hostedAgent(input: {
  raw: StorageDir;
  lock: StateLock;
  lifecycle?: StateLeaseLifecycle;
  sessionService?: SessionService;
}): { agent: Agent; gate: StateWriteGate; view: StorageDir } {
  const gate = createStateWriteGate();
  const view = adoptStorageView(
    input.raw,
    gate.authorityFor("echo:probe", { lanes: ["restore-migration", "lifecycle-finalization"], activeBusiness: true }),
  );
  const agent = new Agent({
    model: { provider: "t", id: "only", api: "scripted" },
    streamFunction: scriptedStreamFn([textTurn("收到"), textTurn("再来")]),
    stateLock: input.lock,
    ...(input.sessionService !== undefined ? { sessionService: input.sessionService } : {}),
  });
  attachStateHost(agent, { gate, ...(input.lifecycle !== undefined ? { leaseLifecycle: input.lifecycle } : {}) });
  return { agent, gate, view };
}

test("stop()：真 view 在 stop 之前写得进、之后写不进；beforeLeaseRelease(stop) 时 cell 仍 installed，revoke 在 release 之前", async () => {
  const raw = new InMemoryDir();
  const order: string[] = [];
  const cellDuringFence: string[] = [];
  let gateRef: StateWriteGate | undefined;
  const lock: StateLock = {
    acquire: async () => ({
      release: async () => {
        order.push("release");
      },
      lost: new Promise<Error>(() => {}),
    }),
  };
  const lifecycle: StateLeaseLifecycle = {
    beforeLeaseRelease: async (input) => {
      order.push(`beforeLeaseRelease:${input.reason}`);
      cellDuringFence.push(gateRef!.cell.state()); // Host 的 writer 要在这时还写得动
    },
    onLeaseLost: async () => {
      order.push("onLeaseLost");
    },
  };
  const { agent, gate, view } = hostedAgent({ raw, lock, lifecycle });
  gateRef = gate;
  await agent.start();

  // **直接对真 view 断言**：这才证明闸真的开着，而不是别的检查代答
  await view.write("probe.json", "跑着的时候写得进");
  expect(gate.cell.state()).toBe("installed");

  await agent.stop();
  expect(order).toEqual(["beforeLeaseRelease:stop", "release"]);
  expect(cellDuringFence).toEqual(["installed"]);
  expect(gate.cell.state()).toBe("revoked");
  // **删掉 gate.revoke() 这条就会红**：租约已经还回去，view 却还写得进状态根
  await expect(view.write("probe.json", "停了还写")).rejects.toBeInstanceOf(StateWriteDenied);
  expect(await raw.read("probe.json")).toBe("跑着的时候写得进");
});

test("**P0**：install 之后启动失败 → 先 revoke 再 release；旧 view 拒写、旧实例不许重试，fresh Agent 能起来", async () => {
  const raw = new InMemoryDir();
  const order: string[] = [];
  const lock: StateLock = {
    acquire: async () => ({
      release: async () => {
        order.push("release");
      },
      lost: new Promise<Error>(() => {}),
    }),
  };
  // 恢复的后半段炸：acquire / install 都已经成功了
  const broken = {
    createOrResume: async () => {
      throw new Error("session 坏档");
    },
    seal: () => {},
    settle: async () => {},
    setPhase: () => {},
    attachDiagnostics: () => {},
  } as unknown as SessionService;
  const { agent, gate, view } = hostedAgent({ raw, lock, sessionService: broken });

  await expect(agent.start()).rejects.toThrow(/session 坏档/);
  expect(order).toEqual(["release"]);
  expect(gate.cell.state()).toBe("revoked");
  // 上一版只 release 不 revoke：锁已经还回去，公开的 schedule / session view 仍能往状态根里写
  await expect(view.write("late.json", "启动失败了还写")).rejects.toBeInstanceOf(StateWriteDenied);
  expect(await raw.read("late.json")).toBeNull();
  // **契约改了**：install 之后失败是终态——不能清空复用 revoked cell，只能新建
  await expect(agent.start()).rejects.toThrow(/请新建一个/);

  // fresh Agent（新 gate、新 cell、新 view）能正常起来
  const fresh = hostedAgent({ raw, lock });
  await fresh.agent.start();
  await fresh.view.write("fresh.json", "新实例写得进");
  expect(await raw.read("fresh.json")).toBe("新实例写得进");
  await fresh.agent.stop();
});

test("从没 start() 过就 stop()：不调正常释放 fence（没有合法租约可释放）", async () => {
  const calls: string[] = [];
  const lifecycle: StateLeaseLifecycle = {
    beforeLeaseRelease: async () => {
      calls.push("beforeLeaseRelease");
    },
    onLeaseLost: async () => {
      calls.push("onLeaseLost");
    },
  };
  const { agent } = hostedAgent({ raw: new InMemoryDir(), lock: new InMemoryStateLock(), lifecycle });
  await agent.stop();
  expect(calls).toEqual([]);
});

test("丢锁之后再 stop()：只做 loss-safe 清理，**不再调 beforeLeaseRelease**；onLeaseLost 恰好一次", async () => {
  const raw = new InMemoryDir();
  const calls: string[] = [];
  const lock = new InMemoryStateLock();
  const lifecycle: StateLeaseLifecycle = {
    beforeLeaseRelease: async () => {
      calls.push("beforeLeaseRelease");
    },
    onLeaseLost: async () => {
      calls.push("onLeaseLost");
    },
  };
  const { agent, gate, view } = hostedAgent({ raw, lock, lifecycle });
  await agent.start();
  await view.write("before.json", "还持有的时候");

  lock.simulateLost("租约过期");
  await new Promise((r) => setTimeout(r, 10));
  expect(calls).toEqual(["onLeaseLost"]);
  expect(gate.cell.state()).toBe("revoked");
  // loss fence 不补 flush：从丢锁那一刻起 view 一律拒写
  await expect(view.write("after.json", "丢锁之后")).rejects.toBeInstanceOf(StateWriteDenied);

  await agent.stop().catch(() => undefined);
  // 上一版无条件调用：丢锁之后又走一次正常释放 fence（那条 fence 的前提是「还持有合法租约」）
  expect(calls).toEqual(["onLeaseLost"]);
  expect(await raw.read("after.json")).toBeNull();
});

test("start() 失败在 install 之前（锁被别人占着）：可重试，且一个字节都没写", async () => {
  const raw = new InMemoryDir();
  const shared = new InMemoryStateLock();
  const held = await shared.acquire({ holder: "别人" });
  const { agent, gate, view } = hostedAgent({ raw, lock: shared });
  await expect(agent.start()).rejects.toThrow(/已被另一个写者持有/);
  expect(gate.cell.state()).toBe("empty"); // 没 install 过：cell 仍是空的
  await expect(view.write("x.json", "1")).rejects.toThrow(/cell 为空/);
  // **拿锁之前失败仍可重试**（这条与上面那条 P0 的契约不同）
  await held!.release();
  await agent.start();
  await view.write("x.json", "1");
  expect(await raw.read("x.json")).toBe("1");
  await agent.stop();
});

test("低层 `new Agent()` 不挂 host 接线：不受影响（评测与一次性跑就是这么用的）", async () => {
  const agent = new Agent({
    model: { provider: "t", id: "only", api: "scripted" },
    streamFunction: scriptedStreamFn([textTurn("ok")]),
  });
  expect((await agent.prompt("干活")).outcome.kind).toBe("completed");
});
