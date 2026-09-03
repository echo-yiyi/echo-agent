// admission 的测试替身与共享 conformance（§14.2.4）。走 `@echo-agent/core/testing` 子路径，不在生产面上。
//
//   - `createFakeAgentAdmission()`：手动驱动的 fake——`grantNext(binding)` / `rejectNext(reason)` / `abortActive()`，
//     不自己跑微任务；测试可读 pending request，但拿不到 execute callback；
//   - `runAgentAdmissionConformance(factory)`：ABI 结算规则的共享 suite。StandaloneRunAdmission 与 fake 都必须过它，
//     将来完整 Runtime 的 admission 也一样——不能只测 fake 自己。

import type { LoopResult } from "../loop/types.ts";
import { errText } from "../errors.ts";
import type {
  AgentAdmissionExecuteScope,
  AgentAdmissionPort,
  AgentAdmissionResult,
  AgentAdmissionTicket,
  AgentInternalRunRequest,
  RunModelBinding,
  RunModelSnapshot,
  RunSource,
} from "./types.ts";
import { assertInternalRunRequest } from "./request.ts";
import type { Model } from "../provider/types.ts";

export type FakePendingRequest = Readonly<{ requestId: string; source: RunSource; purpose: "foreground" | "maintenance" }>;

export type FakeAgentAdmission = Readonly<{
  port: AgentAdmissionPort;
  /** Host 私有入口的替身：用户 run。 */
  admitUser<TResult extends LoopResult>(execute: (scope: AgentAdmissionExecuteScope) => Promise<TResult>): AgentAdmissionTicket<TResult>;
  /** 还没裁决的 request（按到达顺序）。 */
  pending(): readonly FakePendingRequest[];
  /**
   * 把 permit 给下一个（foreground 优先）：跑它的 execute，返回该 ticket 的结算。没有 pending → null。
   * 不给 binding 就按 request 派生一份缺省的（source / purpose 与 request 一致）。
   */
  grantNext(binding?: RunModelBinding): Promise<AgentAdmissionResult | null>;
  /** 拒下一个：ticket 以 rejected(reason) fulfill，execute 零次。 */
  rejectNext(reason: "paused" | "stopping" | "lease-lost" | "superseded"): boolean;
  /** abort 正在跑的那个的 scope signal。 */
  abortActive(): void;
  /** 让下一次 callback failure 的规范化自己也抛：fake 必须像真 actor 一样兜底出最小 LoopResult、ticket 照样结算。 */
  failNextNormalization(): void;
  readonly activeRunId: string | null;
}>;

type Slot = {
  readonly requestId: string;
  readonly source: RunSource;
  readonly purpose: "foreground" | "maintenance";
  readonly execute: (scope: AgentAdmissionExecuteScope) => Promise<LoopResult>;
  readonly settle: (r: AgentAdmissionResult) => void;
};

function failureResult(aborted: boolean, e: unknown): LoopResult {
  return {
    outcome: aborted
      ? { kind: "aborted" }
      : { kind: "error", error: { source: "internal", code: "internal", retryable: false, message: errText(e) } },
    messages: [],
  };
}

/** fake 的缺省 binding：一个不发网络请求的空 model，source / purpose 跟 request 走。 */
function defaultBinding(source: RunSource, purpose: "foreground" | "maintenance"): RunModelBinding {
  return Object.freeze({
    bindingId: `fake-binding:${source.kind}:${purpose}`,
    source: Object.freeze({ ...source }), // 与生产 binding 同一 ABI：冻结副本，不别名 request 的对象
    purpose,
    catalogRevision: "fake:0",
    provider: Object.freeze({ id: "fake", entryId: "echo:fake", generation: "0" }),
    model: Object.freeze({ provider: "fake", id: "fake", api: "fake" }),
    streamFunction: () => {
      throw new Error("fake admission 的缺省 binding 没有 stream：execute 不该真调模型");
    },
    thinkingLevel: "off",
    retryPolicy: Object.freeze({ maxAttempts: 1, backoffMs: () => 0 }),
  });
}

export function createFakeAgentAdmission(): FakeAgentAdmission {
  const queue: Slot[] = [];
  let seq = 0;
  let active: { slot: Slot; runId: string; controller: AbortController } | null = null;

  const submit = <TResult extends LoopResult>(
    source: RunSource,
    purpose: "foreground" | "maintenance",
    execute: (scope: AgentAdmissionExecuteScope) => Promise<TResult>,
  ): AgentAdmissionTicket<TResult> => {
    const requestId = `fake:${++seq}`;
    let settle!: (r: AgentAdmissionResult) => void;
    const settled = new Promise<AgentAdmissionResult<TResult>>((resolve) => {
      settle = resolve as (r: AgentAdmissionResult) => void;
    });
    queue.push({ requestId, source, purpose, execute, settle });
    return { requestId, settled };
  };
  const takeNext = (): Slot | undefined => {
    const i = queue.findIndex((s) => s.purpose === "foreground");
    const idx = i >= 0 ? i : 0;
    return queue.splice(idx, 1)[0];
  };

  let normalizerBroken = false;
  const port: AgentAdmissionPort = {
    enqueue(request: AgentInternalRunRequest, execute) {
      assertInternalRunRequest(request); // 与 StandaloneRunAdmission 同一份验形
      return submit(request.source, request.purpose, execute);
    },
  };

  return {
    port,
    admitUser: (execute) => submit({ kind: "user" }, "foreground", execute),
    pending: () => queue.map((s) => ({ requestId: s.requestId, source: s.source, purpose: s.purpose })),
    async grantNext(binding) {
      if (active !== null) throw new Error("fake admission：上一个 permit 还没 close");
      const slot = takeNext();
      if (slot === undefined) return null;
      const runId = `${slot.source.kind === "dream" ? "dream" : "run"}:fake-${slot.requestId}`;
      const controller = new AbortController();
      active = { slot, runId, controller };
      const modelBinding = binding ?? defaultBinding(slot.source, slot.purpose);
      let result: AgentAdmissionResult;
      try {
        const r = await slot.execute(Object.freeze({ runId, signal: controller.signal, modelBinding }));
        result = { kind: "executed", runId, result: r };
      } catch (e) {
        const aborted = controller.signal.aborted;
        let normalized: LoopResult;
        if (normalizerBroken) {
          // 模拟 normalizer 自身失败：像真 actor 一样兜底出最小 LoopResult，ticket 照样恰好结算一次
          normalizerBroken = false;
          normalized = {
            outcome: aborted ? { kind: "aborted" } : { kind: "error", error: { source: "internal", code: "internal", retryable: false, message: `${errText(e)}（failure normalizer 自身也失败）` } },
            messages: [],
          };
        } else {
          normalized = failureResult(aborted, e);
        }
        result = {
          kind: "callback-error",
          runId,
          result: normalized,
          error: { source: "internal", code: aborted ? "aborted" : "internal", retryable: false, message: `run callback 违约：${errText(e)}` },
        };
      }
      active = null;
      slot.settle(result);
      return result;
    },
    failNextNormalization() {
      normalizerBroken = true;
    },
    rejectNext(reason) {
      const slot = takeNext();
      if (slot === undefined) return false;
      slot.settle({ kind: "rejected", reason });
      return true;
    },
    abortActive() {
      active?.controller.abort();
    },
    get activeRunId() {
      return active?.runId ?? null;
    },
  };
}

/** conformance 的被测面：port + 用户入口 + 推进 / 抢占 / 关门三个控制。 */
export type AdmissionUnderTest = Readonly<{
  port: AgentAdmissionPort;
  admitUser<TResult extends LoopResult>(execute: (scope: AgentAdmissionExecuteScope) => Promise<TResult>): AgentAdmissionTicket<TResult>;
  /** 让实现推进一步（fake：grant 下一个；自动的实现：让出事件循环）。 */
  drive(): Promise<void>;
  /** abort 正在跑的 run 的 scope signal。 */
  abortActive(): void;
  /** 关门：之后 enqueue 一律 rejected；排队的 rejected；在跑的 abort。 */
  close(): Promise<void>;
  /** 让下一次 callback failure 的规范化自己也抛（normalizer sink failure）。 */
  breakNormalizer(): void;
}>;

function check(cond: boolean, message: string): void {
  if (!cond) throw new Error(`admission conformance：${message}`);
}

const INBOX_REQUEST: AgentInternalRunRequest = {
  source: { kind: "inbox" },
  priority: "foreground",
  purpose: "foreground",
  reservationId: "rsv:conformance",
  reservedRecordIds: ["r1", "r2"],
};
const DREAM_REQUEST: AgentInternalRunRequest = { source: { kind: "dream" }, priority: "maintenance", purpose: "maintenance" };

const done: LoopResult = { outcome: { kind: "completed" }, messages: [] };

/** 一直 drive 到条件满足或步数用尽。 */
async function driveUntil(sut: AdmissionUnderTest, cond: () => boolean, steps = 20): Promise<void> {
  for (let i = 0; i < steps && !cond(); i++) await sut.drive();
}

/**
 * ABI 结算规则（§14.2.4）：foreground 高于 maintenance；在跑的 Dream 可被抢占；scope 的 source / purpose 与 request 一致；
 * execute 0-or-1 次；LoopResult 原样保留；正常 rejected 只 fulfill；sync throw / async reject / abort 都形成 callback-error 且
 * 各只 settle 一次；execute 里再 enqueue 不会递归执行。抛错 = 不合格。
 */
export async function runAgentAdmissionConformance(factory: () => AdmissionUnderTest | Promise<AdmissionUnderTest>): Promise<void> {
  /* 1. foreground 高于 maintenance；scope 与 request 一致；execute 恰一次 */
  {
    const sut = await factory();
    const order: string[] = [];
    const frozenBinding = (scope: AgentAdmissionExecuteScope): void => {
      const b = scope.modelBinding;
      check(
        Object.isFrozen(b) && Object.isFrozen(b.source) && Object.isFrozen(b.provider) && Object.isFrozen(b.model) && Object.isFrozen(b.retryPolicy),
        "binding 及其 source / provider / model / retryPolicy 必须是冻结副本（binding ABI）",
      );
    };
    const dream = sut.port.enqueue(DREAM_REQUEST, async (scope) => {
      order.push(`dream:${scope.modelBinding.purpose}`);
      check(scope.modelBinding.source.kind === "dream" && scope.modelBinding.purpose === "maintenance", "Dream 的 binding source/purpose 必须是 dream/maintenance");
      frozenBinding(scope);
      return done;
    });
    let userRuns = 0;
    const user = sut.admitUser(async (scope) => {
      userRuns += 1;
      order.push(`user:${scope.modelBinding.purpose}`);
      check(scope.modelBinding.source.kind === "user" && scope.modelBinding.purpose === "foreground", "用户 run 的 binding source/purpose 必须是 user/foreground");
      frozenBinding(scope);
      return done;
    });
    let userSettled = false;
    void user.settled.then(() => {
      userSettled = true;
    });
    await driveUntil(sut, () => userSettled);
    check(order[0] === "user:foreground", `foreground 必须先于 maintenance 执行，实际顺序 ${order.join(",")}`);
    check(userRuns === 1, "用户 execute 必须恰好一次");
    let dreamSettled: AgentAdmissionResult | null = null;
    void dream.settled.then((r) => {
      dreamSettled = r;
    });
    await driveUntil(sut, () => dreamSettled !== null);
    const d = dreamSettled as AgentAdmissionResult | null;
    check(d !== null, "maintenance ticket 必须结算");
    check(
      d!.kind === "executed" || (d!.kind === "rejected" && d!.reason === "superseded"),
      `被前台挤开的 maintenance 只能是之后 executed 或 rejected(superseded)，实际 ${JSON.stringify(d)}`,
    );
    if (d!.kind === "executed") check(order[1] === "dream:maintenance", "maintenance 只能在 foreground 之后执行");
  }

  /* 2. 在跑的 Dream 被前台抢占：signal abort、等它 close 再跑前台 */
  {
    const sut = await factory();
    const order: string[] = [];
    const dream = sut.port.enqueue(DREAM_REQUEST, (scope) => {
      order.push("dream:start");
      return new Promise<LoopResult>((resolve) => {
        scope.signal.addEventListener("abort", () => {
          order.push("dream:aborted");
          resolve({ outcome: { kind: "aborted" }, messages: [] });
        });
      });
    });
    await driveUntil(sut, () => order.includes("dream:start"));
    check(order.includes("dream:start"), "空闲时 Dream 必须拿到 permit");
    const user = sut.admitUser(async () => {
      order.push("user:start");
      return done;
    });
    let userSettled = false;
    void user.settled.then(() => {
      userSettled = true;
    });
    // 自动实现自己 abort；手动实现由测试驱动 abortActive
    await sut.drive();
    if (!order.includes("dream:aborted")) sut.abortActive();
    await driveUntil(sut, () => userSettled);
    check(order.indexOf("dream:aborted") < order.indexOf("user:start"), `前台必须等 Dream close 之后才开工，实际 ${order.join(",")}`);
    const d = await dream.settled;
    check(d.kind === "executed" && d.result.outcome.kind === "aborted", "被抢占的 Dream 以 aborted outcome 正常封口（executed）");
  }

  /* 3. LoopResult 原样保留（泛型 TResult 不被抽成 outcome） */
  {
    const sut = await factory();
    type Rich = LoopResult & { extra: number };
    const t = sut.admitUser(async (): Promise<Rich> => ({ ...done, extra: 42 }));
    let r: AgentAdmissionResult<Rich> | null = null;
    void t.settled.then((x) => {
      r = x;
    });
    await driveUntil(sut, () => r !== null);
    const got = r as AgentAdmissionResult<Rich> | null;
    check(got !== null && got.kind === "executed" && got.result.extra === 42, "executed 必须保留完整 TResult");
  }

  /* 4. sync throw / async reject / abort → callback-error，配对的 LoopResult，各只 settle 一次 */
  {
    const sut = await factory();
    const settledCounts = new Map<string, number>();
    const track = (t: AgentAdmissionTicket): void => {
      void t.settled.then(() => settledCounts.set(t.requestId, (settledCounts.get(t.requestId) ?? 0) + 1));
    };
    const syncThrow = sut.admitUser(() => {
      throw new Error("sync boom");
    });
    track(syncThrow);
    const asyncReject = sut.admitUser(async () => {
      await Promise.resolve();
      throw new Error("async boom");
    });
    track(asyncReject);
    const aborted = sut.admitUser(
      (scope) =>
        new Promise<LoopResult>((_, reject) => {
          scope.signal.addEventListener("abort", () => reject(new Error("aborted by scope")));
        }),
    );
    track(aborted);
    let r1: AgentAdmissionResult | null = null;
    let r2: AgentAdmissionResult | null = null;
    void syncThrow.settled.then((x) => {
      r1 = x;
    });
    void asyncReject.settled.then((x) => {
      r2 = x;
    });
    await driveUntil(sut, () => r1 !== null && r2 !== null);
    const a = r1 as AgentAdmissionResult | null;
    const b = r2 as AgentAdmissionResult | null;
    check(a !== null && a.kind === "callback-error" && a.result.outcome.kind === "error", "同步 throw → callback-error + error outcome");
    check(b !== null && b.kind === "callback-error" && b.result.outcome.kind === "error", "异步 reject → callback-error + error outcome");
    // 第三个在跑：abort 它
    let r3: AgentAdmissionResult | null = null;
    void aborted.settled.then((x) => {
      r3 = x;
    });
    await sut.drive();
    sut.abortActive();
    await driveUntil(sut, () => r3 !== null);
    const c = r3 as AgentAdmissionResult | null;
    check(c !== null && c.kind === "callback-error" && c.result.outcome.kind === "aborted", "abort 后 reject → callback-error + aborted outcome");
    await sut.drive();
    for (const [id, n] of settledCounts) check(n === 1, `ticket ${id} 结算了 ${n} 次`);
  }

  /* 5. 正常 rejected 只 fulfill：关门后排队的与新来的都 rejected，execute 零次 */
  {
    const sut = await factory();
    let ran = 0;
    // 先占住 permit，让第二个排队
    // 占 permit 的 run 尊重 scope.signal：关门时被 abort 就封口（不认 abort 的 execute 是它自己违约，不是 admission 的）
    const first = sut.admitUser(
      (scope) =>
        new Promise<LoopResult>((resolve) => {
          scope.signal.addEventListener("abort", () => resolve({ outcome: { kind: "aborted" }, messages: [] }));
        }),
    );
    await sut.drive();
    const queued = sut.port.enqueue(INBOX_REQUEST, async () => {
      ran += 1;
      return done;
    });
    await sut.close();
    let q: AgentAdmissionResult | null = null;
    void queued.settled.then((x) => {
      q = x;
    });
    await driveUntil(sut, () => q !== null);
    const qq = q as AgentAdmissionResult | null;
    check(qq !== null && qq.kind === "rejected", "关门时排队的 ticket 必须 rejected（fulfill，不 reject）");
    check(ran === 0, "rejected 的 execute 必须零次");
    const late = sut.admitUser(async () => done);
    const l = await late.settled;
    check(l.kind === "rejected", "关门后 enqueue 必须 rejected");
    await first.settled;
  }

  /* 6. execute 里再 enqueue 不递归：新 run 在当前 callback 返回之后才开始 */
  {
    const sut = await factory();
    const order: string[] = [];
    let innerSettled = false;
    const outer = sut.admitUser(async () => {
      order.push("outer:start");
      const inner = sut.port.enqueue(DREAM_REQUEST, async () => {
        order.push("inner:start");
        return done;
      });
      void inner.settled.then(() => {
        innerSettled = true;
      });
      await Promise.resolve();
      order.push("outer:end");
      return done;
    });
    let outerSettled = false;
    void outer.settled.then(() => {
      outerSettled = true;
    });
    await driveUntil(sut, () => outerSettled && innerSettled);
    check(order.join(",") === "outer:start,outer:end,inner:start", `execute 里 enqueue 的 run 必须在当前 callback 返回后才开始，实际 ${order.join(",")}`);
  }

  /* 7. normalizer 自身失败：ticket 仍恰好结算一次（callback-error + 最小 LoopResult），队列不卡 */
  {
    const sut = await factory();
    sut.breakNormalizer();
    const broken = sut.admitUser(async () => {
      throw new Error("callback boom");
    });
    let r: AgentAdmissionResult | null = null;
    void broken.settled.then((x) => {
      r = x;
    });
    await driveUntil(sut, () => r !== null);
    const got = r as AgentAdmissionResult | null;
    check(got !== null, "normalizer 失败时 ticket 不能永久 pending");
    check(got!.kind === "callback-error" && got!.result.outcome.kind === "error", "normalizer 失败时 actor 自己兜底出 error outcome 的 LoopResult");
    // 队列没卡：下一个照常执行
    let ran = false;
    const next = sut.admitUser(async () => {
      ran = true;
      return done;
    });
    let nextSettled = false;
    void next.settled.then(() => {
      nextSettled = true;
    });
    await driveUntil(sut, () => nextSettled);
    check(ran, "normalizer 失败之后后续 admission 必须继续执行（active 已清、队列已唤醒）");
  }

  /* 8. request 形状按 source.kind 穷举：缺 reservation 的 inbox、带 reservation 的 dream、错的 priority——同步抛、不产生 ticket */
  {
    const sut = await factory();
    const malformed: unknown[] = [
      { source: { kind: "inbox" }, priority: "foreground", purpose: "foreground" },
      { source: { kind: "inbox" }, priority: "foreground", purpose: "foreground", reservationId: "", reservedRecordIds: ["r1"] },
      { source: { kind: "inbox" }, priority: "foreground", purpose: "foreground", reservationId: "rsv", reservedRecordIds: ["r1", "r1"] },
      { source: { kind: "inbox" }, priority: "maintenance", purpose: "foreground", reservationId: "rsv", reservedRecordIds: ["r1"] },
      { source: { kind: "dream" }, priority: "maintenance", purpose: "maintenance", reservationId: "rsv", reservedRecordIds: ["r1"] },
      { source: { kind: "dream" }, priority: "foreground", purpose: "maintenance" },
      { source: { kind: "user" }, priority: "foreground", purpose: "foreground" },
    ];
    let ran = 0;
    for (const req of malformed) {
      let threw = false;
      try {
        sut.port.enqueue(req as AgentInternalRunRequest, async () => {
          ran += 1;
          return done;
        });
      } catch {
        threw = true;
      }
      check(threw, `坏形状的 request 必须在创建 ticket 前同步抛：${JSON.stringify(req)}`);
    }
    await sut.drive();
    check(ran === 0, "坏形状的 request 不能执行");
  }
}


/* ═══════════════ model 快照：JSON-like 与 fail-loud 的共享判据 ═══════════════ */

/**
 * 「把一个 `Model` 变成 run 期冻结快照」的实现。standalone 用的是 `normalizeModelSnapshot`；
 * O3 的 Runtime 侧 binding 冻结走同一条规则，所以判据抽在这里，不各写一份单测。
 */
export type ModelSnapshotUnderTest = Readonly<{ snapshot: (model: Model) => RunModelSnapshot }>;

/**
 * `RunModelSnapshot` 的口径（§14.2.4）：
 * **递归 clone + 冻结**（原对象事后怎么改都影响不到快照）、只接受 JSON-like 值、
 * 不能 canonical 表达的值一律 **fail-loud 不静默删字段**、`__proto__` 这种键只是自身属性。
 *
 * 为什么值得共享：静默删一个 `params` 字段 = 这次 run 的模型行为悄悄变了，而轨迹里看不出来；
 * 第二个实现要是用 `JSON.parse(JSON.stringify(model))` 抄近路，上面每一条都会破，但**测不出来**——
 * 除非有这套判据跟着它走。抛错 = 不合格。
 */
export function runModelSnapshotConformance(factory: () => ModelSnapshotUnderTest): void {
  // 自己的前缀：这套判据与 admission 结算无关，报错里说清是谁不合格
  const check = (ok: boolean, what: string): void => {
    if (!ok) throw new Error(`model 快照 conformance 不合格：${what}`);
  };
  const { snapshot } = factory();
  const base: Model = { provider: "t", id: "m-1", api: "fake", capabilities: { contextWindow: 1_000 } };
  const rejects = (model: Model, what: string): void => {
    let threw = false;
    try {
      snapshot(model);
    } catch {
      threw = true;
    }
    check(threw, `${what} 必须 fail-loud（静默删字段等于让这次 run 的模型行为悄悄变了）`);
  };

  /* 1. 递归 clone + **递归**冻结：改原对象、改原数组，快照一个字节都不许动 */
  {
    const stop = ["a", "b"];
    const model: Model = { ...base, params: { temperature: 0.2, stop, nested: { k: 1 } } };
    const snap = snapshot(model);
    (model.params as Record<string, unknown>)["temperature"] = 0.9;
    ((model.params as Record<string, unknown>)["nested"] as Record<string, unknown>)["k"] = 2;
    // **数组也要验**：上一版只改了对象，于是「只冻结对象、数组仍可变」的实现照样跑绿（review 实测）
    stop.push("c");
    stop[0] = "改了";

    const params = snap.params as { temperature: number; stop: readonly string[]; nested: { k: number } };
    check(params.temperature === 0.2 && params.nested.k === 1, "快照必须是深拷贝，不能与调用方共享引用");
    check(
      params.stop.length === 2 && params.stop[0] === "a" && params.stop[1] === "b",
      `嵌套数组必须是拷贝，调用方之后 push / 改元素都影响不到快照，实际 ${JSON.stringify(params.stop)}`,
    );
    check(Object.isFrozen(snap) && Object.isFrozen(snap.params) && Object.isFrozen(params.nested), "快照必须递归冻结");
    check(Object.isFrozen(params.stop), "**嵌套数组也必须冻结**——只冻对象不冻数组，快照仍然可被改写");
  }

  /* 2. 不能 canonical 表达的值：逐类 fail-loud */
  {
    const withParams = (params: Record<string, unknown>): Model => ({ ...base, params });
    rejects(withParams({ f: () => 1 }), "function");
    rejects(withParams({ u: undefined }), "undefined 值");
    rejects(withParams({ n: Number.NaN }), "NaN");
    rejects(withParams({ n: Number.POSITIVE_INFINITY }), "Infinity");
    rejects(withParams({ b: 10n as never }), "bigint");
    class Box {}
    rejects(withParams({ box: new Box() }), "class 实例");
    rejects(withParams({ d: new Date() }), "Date 实例");
    const accessor = {};
    Object.defineProperty(accessor, "x", { get: () => 1, enumerable: true });
    rejects(withParams({ accessor }), "accessor 属性");
    rejects(withParams({ s: { [Symbol("k")]: 1 } }), "symbol key");
    const sparse: unknown[] = [1];
    sparse[2] = 3; // 中间那个洞
    rejects(withParams({ sparse }), "sparse array");
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    rejects(withParams({ cyclic }), "循环引用");
    rejects({ ...base, id: "" }, "空 model.id");
    rejects({ ...base, 未知字段: 1 } as unknown as Model, "未知顶层字段");
  }

  /* 3. `__proto__` 是**普通数据键**：既不许污染原型，也不许被悄悄丢掉 */
  {
    const params: Record<string, unknown> = {};
    Object.defineProperty(params, "__proto__", { value: { polluted: true }, enumerable: true, configurable: true, writable: true });
    const snap = snapshot({ ...base, params });
    const cloned = snap.params as Record<string, unknown>;
    check(
      Object.getPrototypeOf(cloned) === Object.prototype || Object.getPrototypeOf(cloned) === null,
      "`__proto__` 键不许改掉克隆对象的原型",
    );
    check((cloned as { polluted?: unknown }).polluted === undefined, "`__proto__` 键的内容不许泄进原型链");
    // **还要留着**：上一版只验「没被污染」，于是「干脆把这个键删掉」的实现也能过（review 实测）——
    // 那是静默丢字段，正是本套判据要挡的那类事故
    const own = Object.getOwnPropertyDescriptor(cloned, "__proto__");
    check(own !== undefined, "own `__proto__` 是普通数据键，必须留在快照里，不能被静默丢掉");
    check(
      typeof own!.value === "object" && own!.value !== null && (own!.value as { polluted?: unknown }).polluted === true,
      `own \`__proto__\` 的内容必须原样保留，实际 ${JSON.stringify(own!.value)}`,
    );
  }

  /* 4. 原型链上的字段不算数：快照只收自身属性 */
  {
    const proto = { temperature: 0.9 };
    const params = Object.create(proto) as Record<string, unknown>;
    params["top_p"] = 0.5;
    let snap: RunModelSnapshot | null = null;
    try {
      snap = snapshot({ ...base, params });
    } catch {
      snap = null; // 非 plain object 直接判红也合规
    }
    if (snap !== null) {
      const cloned = snap.params as Record<string, unknown>;
      check(!("temperature" in cloned), "原型链上的字段不许被当成自身属性抄进快照");
    }
  }
}
