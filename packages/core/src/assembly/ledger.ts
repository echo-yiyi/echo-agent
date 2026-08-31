// AgentAssembly adoption（§14.5.1）：**每个 slot 在任何时刻只有一个 dispose owner，转移是原子的。**
//
// 为什么要有这一层：装配一个 Agent 要先造出若干 agent 域的值（Session / Memory / Schedule / Task / Inbox），
// 再把它们交给 `new Agent()`。这中间有一个窗口——**值已经造出来、Agent 还没构造成功**。上一版没人管这个
// 窗口：`new Agent()` 抛错时，已经建好的 root `StorageDir` 就再没人关过（实测：构造抛错后 `close` 计数为 0）。
// 补救办法不能是「provider 和 Agent 各登记一份保险 disposer」——那样正常路径就会关两次（`StorageDir.close()`
// 的契约没要求幂等，注入一个第二次关闭就报错的合法实现当场失败）。所以这里做的是**所有权账本**：
//
//   - `adopt`  = agent 域的值：provider 先持 `offered` 租约，`echo:agent` 构造成功后**原子接管**，
//                之后只有它的 `AdoptionLedger` 是 dispose owner，`Agent.stop()` 是排空它的唯一触发点；
//   - `borrow` = 进程域的值（root `StorageDir`、稳定 `ProviderCatalog`）：provider 始终是唯一 dispose owner，
//                Agent 只拿不带 `close` 的视图。
//
// **原子转移要靠 assembly 级状态机，不能只靠逐 slot 的三态。** 逐 slot 三态挡不住这条实测反例：
// `abort()` 收到一半、卡在某个慢 disposer 上时调 `adoptInto()`，剩下那些还是 `offered` 的 slot 照样被接管，
// 调用方拿到一个**残缺账本**——一半东西已经被 provider 收掉了。所以 `abort()` 在第一个 await **之前**
// 就同步进入 `aborting`，而 `adoptInto()` 只认完整的 `sealed`。
//
//   open ──seal()──▶ sealed ──adoptInto()──▶ adopted        （adopted 之后 provider 不再是 owner，
//    │                 │                                      收摊只能走 ledger.drain() + disposeProcessScope()）
//    ├──factory 抛错──▶ failed ─┐
//    └──abort()───────▶ aborting ──▶ aborted
//
// slot 的三态 `offered → adopted → disposed` 仍然单向走，且**跑 disposer 之前先落终态**——disposer 抛错也不给
// 第二次机会（否则 `stop()` 失败后重试就是二次 dispose）。
//
// **adopt slot 的 factory 必须零外部副作用**（§14.5.1 末段）：不读写磁盘、不取 StateLock、不起 timer、
// 不连网络/子进程、不注册 global listener、不消费 Inbox。durable restore 归 `Agent.start()`，
// 自主活动与 timer 归 `Agent.activate()`。这条契约由 `probe.ts` 的探针在 conformance 里证明——
// 它是「未 start 的 candidate 被 dispose 时只释放纯内存引用」这句话成立的前提，
// 也是本文件默认不给 adopt slot 登记 disposer 的理由：**纯内存的东西没有可关的资源**。

import { errText } from "../errors.ts";
import { createStateWriteGate, type StateWriteGate } from "../state/write-gate.ts";

/** slot 的处置模式（§14.5.1）。 */
export type AssemblyDisposalMode =
  | { kind: "adopt" } // agent-scope value：构造成功后由 concrete Agent 唯一 dispose
  | { kind: "borrow" }; // process-scope value：provider 保持 dispose owner，Agent 只借用

export type AssemblySlotPhase = "offered" | "adopted" | "disposed";

/**
 * 装配现场自己的状态。**`adoptInto()` 只认 `sealed`**——其余任何一个状态下接管，拿到的都可能是残缺账本。
 */
export type AssemblyState = "open" | "sealed" | "adopted" | "failed" | "aborting" | "aborted";

/**
 * 可观测的 slot 事实。**来源 owner 与当前 dispose owner 分开记**——值被 Agent adopt 之后不能把 provider
 * 丢掉，也不能反过来据 provider 身份推断它仍负责 dispose（§14.5.1 末段 Observation 那条）。
 */
export type AssemblySlotInfo = Readonly<{
  slotId: string;
  mode: AssemblyDisposalMode["kind"];
  phase: AssemblySlotPhase;
  /** 值是谁造的。adopt 之后不变。 */
  provider: string;
  /** 此刻谁负责 dispose。adopt 之后变成 consumer（`echo:agent`）。 */
  disposeOwner: string;
}>;

type Slot = {
  readonly slotId: string;
  readonly mode: AssemblyDisposalMode["kind"];
  readonly provider: string;
  phase: AssemblySlotPhase;
  disposeOwner: string;
  /** 跑过一次就置 `undefined`——恰好一次的机器判据。 */
  dispose: (() => void | Promise<void>) | undefined;
};

function info(s: Slot): AssemblySlotInfo {
  return Object.freeze({
    slotId: s.slotId,
    mode: s.mode,
    phase: s.phase,
    provider: s.provider,
    disposeOwner: s.disposeOwner,
  });
}

/**
 * 逐条跑 disposer：**LIFO、全尝试、错误聚合**。
 * 顺序反着来是因为后建的可能依赖先建的；全尝试是因为一个 disposer 抛错不能让其余的被跳过。
 */
async function unwind(slots: readonly Slot[], pick: (s: Slot) => boolean, what: string): Promise<void> {
  const errors: unknown[] = [];
  for (let i = slots.length - 1; i >= 0; i--) {
    const slot = slots[i]!;
    if (!pick(slot)) continue;
    const dispose = slot.dispose;
    // **先落终态再跑**：抛错也不留第二次机会
    slot.phase = "disposed";
    slot.dispose = undefined;
    if (dispose === undefined) continue;
    try {
      await dispose();
    } catch (e) {
      errors.push(e);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(
      errors,
      `${what} 期间 ${errors.length} 处失败（已全部尝试）：${errors.map(errText).join("；")}`,
    );
  }
}

/**
 * adoption 之后的账本：**这一个 concrete Agent 是全部 adopt slot 的唯一 dispose owner**，
 * `Agent.stop()` 排空它。它同时带着 candidate 期就建好的写入格（§14.5.1 规则 6：
 * cell 归 candidate，只有这一个 Agent 的 `start()` acquire 成功后才 install，三代之间不共享）。
 */
export type AdoptionLedger = Readonly<{
  /** 接管方身份（默认 profile 里是 `echo:agent` 这个 composition Entry）。 */
  consumerId: string;
  /** 随 adoption 一起转过来的写入格（§14.9）。 */
  writeGate: StateWriteGate;
  /** 这个账本是不是某个 slot 的 dispose owner（已 drain 的也算——所有权不因为收过而回退给 provider）。 */
  owns(slotId: string): boolean;
  slots(): readonly AssemblySlotInfo[];
  /** 排空：LIFO、全尝试、错误聚合、每个 slot 恰好一次。重复调用是空操作。 */
  drain(): Promise<void>;
}>;

/**
 * 装配现场。**seal 只冻结形状，不自动制造第二个 owner**——真正的所有权转移发生在 `adoptInto()`。
 *
 * 典型用法（见 `create-agent.ts`）：
 * ```ts
 * const assembly = new AgentAssembly({ provider: "echo:persistence-local" });
 * const shared = assembly.borrow("root-store", view, { dispose: () => store.close?.() });
 * let agent, ledger;
 * try {
 *   const memory = assembly.adopt("echo:memory", () => createAgentMemories(view));
 *   assembly.seal();
 *   agent = new Agent({ ... });
 *   ledger = assembly.adoptInto("echo:agent");
 *   attach(agent, ledger);
 * } catch (e) {
 *   // adoption 之前失败 → assembly.abort()；之后失败 → ledger.drain() + assembly.disposeProcessScope()
 * }
 * ```
 */
export class AgentAssembly {
  private readonly entries: Slot[] = [];
  private readonly ids = new Set<string>();
  private phase: AssemblyState = "open";
  private consumer: string | undefined;
  private abortRun: Promise<void> | undefined;
  private processScopeDisposed = false;
  /** 值是谁造的。 */
  readonly provider: string;
  /**
   * candidate-owned 写入格。**在 assembly 上建、随 adoption 转给唯一那个 Agent**（§14.5.1 规则 6）：
   * 一次装配一个 cell，所以「old / candidate / fresh 三代不共享」是结构上成立的，不靠纪律。
   */
  readonly writeGate: StateWriteGate = createStateWriteGate();

  constructor(opts?: { provider?: string }) {
    this.provider = opts?.provider ?? "echo:assembly";
  }

  /** 现在处在哪一步。 */
  get state(): AssemblyState {
    return this.phase;
  }

  /**
   * 造一个 agent 域的值并持 `offered` 租约。
   *
   * `factory` 必须零外部副作用（见文件头）。**默认不登记 disposer**：纯内存的 candidate 没有可关的资源，
   * 为了「对称」硬造一个 dispose 反而会在未 start 的 candidate 上产生外部 I/O。确有资源的传 `dispose`。
   *
   * **slotId 在跑 factory 之前就占住**：factory 里再 `adopt("同名")` 时，上一版两次都能过重名检查，
   * 最后留下两个同名 slot（实测）。factory 抛错则整份 assembly 置 `failed`——那时已经登记的东西处在
   * 半成品状态，唯一安全的出路是 `abort()`。
   */
  adopt<T>(slotId: string, factory: () => T, opts?: { dispose?: (value: T) => void | Promise<void> }): T {
    this.assertRegistrable(slotId);
    this.ids.add(slotId);
    let value: T;
    try {
      value = factory();
    } catch (e) {
      this.phase = "failed";
      throw e;
    }
    const dispose = opts?.dispose;
    this.entries.push({
      slotId,
      mode: "adopt",
      provider: this.provider,
      phase: "offered",
      disposeOwner: this.provider,
      dispose: dispose === undefined ? undefined : () => dispose(value),
    });
    return value;
  }

  /**
   * 登记一个进程域的值：**dispose owner 永远是 provider**，Agent 只借用。
   * 交给 Agent 的必须是不带 `close` / `dispose` 的视图（§14.5.1 规则 2）。
   */
  borrow<T>(slotId: string, value: T, opts: { dispose: () => void | Promise<void> }): T {
    this.assertRegistrable(slotId);
    this.ids.add(slotId);
    this.entries.push({
      slotId,
      mode: "borrow",
      provider: this.provider,
      phase: "offered",
      disposeOwner: this.provider,
      dispose: opts.dispose,
    });
    return value;
  }

  /** 冻结形状：之后不能再 offer。**不转移任何所有权**。 */
  seal(): this {
    if (this.phase === "sealed") return this;
    if (this.phase !== "open") throw new Error(`assembly 处于 '${this.phase}'，不能 seal`);
    this.phase = "sealed";
    return this;
  }

  /**
   * 原子接管：所有 `offered` 的 adopt slot 在**同一个同步步**里翻成 `adopted` 并把 disposer 交给账本，
   * 不存在 provider 与 Agent 同时可执行 disposer 的中间态。borrow slot 一动不动。
   *
   * **只认完整的 `sealed`**：`aborting` / `aborted` / `failed` 下接管到的是残缺集合（一部分已经被
   * provider 收掉了），`adopted` 下是第二次接管，`open` 下形状还能变——四种都当场判红。
   */
  adoptInto(consumerId: string): AdoptionLedger {
    if (this.phase === "adopted") {
      throw new Error(`这份 assembly 已经被 '${this.consumer}' 接管过了：一份 assembly 只交给一个 Agent`);
    }
    if (this.phase === "open") {
      throw new Error("adoptInto 之前必须先 seal()：形状没冻结就转移所有权，等于允许边跑边加 slot");
    }
    if (this.phase !== "sealed") {
      throw new Error(`assembly 处于 '${this.phase}'，不能接管：那样拿到的是一份残缺账本（一部分 slot 已经被收掉）`);
    }
    if (this.processScopeDisposed) {
      throw new Error("进程域已经收摊过了，不能再接管：Agent 会拿到一个底层已关的存储");
    }
    this.phase = "adopted";
    this.consumer = consumerId;
    const owned: Slot[] = [];
    for (const slot of this.entries) {
      if (slot.mode !== "adopt" || slot.phase !== "offered") continue;
      slot.phase = "adopted";
      slot.disposeOwner = consumerId;
      owned.push(slot);
    }
    const writeGate = this.writeGate;
    return Object.freeze({
      consumerId,
      writeGate,
      owns: (slotId: string): boolean => owned.some((s) => s.slotId === slotId),
      slots: (): readonly AssemblySlotInfo[] => owned.map(info),
      drain: (): Promise<void> => unwind(owned, (s) => s.phase === "adopted", `adoption ledger '${consumerId}' drain`),
    });
  }

  /**
   * provider 侧 unwind：收掉**还是 `offered`** 的 slot（adopt 与 borrow 都收）。
   * 用在「值已经造好、Agent 还没构造成功」那个窗口。重复调用共享同一次收摊。
   *
   * **adoption 之后不许调**：那时 provider 已经不是 owner，收摊要走 `ledger.drain()` +
   * `disposeProcessScope()`——两边各收各的，不重不漏。
   */
  abort(): Promise<void> {
    if (this.phase === "adopted") {
      throw new Error(
        `这份 assembly 已经被 '${this.consumer}' 接管：provider 不再是 dispose owner，` +
          "收摊要走 ledger.drain() + disposeProcessScope()",
      );
    }
    if (this.abortRun !== undefined) return this.abortRun;
    // **第一个 await 之前就把门关上**：上一版 abort 卡在某个慢 disposer 上时，`adoptInto()` 还能把剩下
    // 那些 offered 的 slot 接管走，调用方拿到一份残缺账本（实测）。
    this.phase = "aborting";
    const settled = (): void => {
      this.phase = "aborted";
    };
    this.abortRun = unwind(this.entries, (s) => s.phase === "offered", `assembly '${this.provider}' abort`).then(
      settled,
      (e: unknown) => {
        settled();
        throw e;
      },
    );
    return this.abortRun;
  }

  /**
   * 进程域收摊：只收 borrow slot。standalone `createAgent()` 里进程域与 Agent 同寿，
   * 所以由 Agent 的 `finalDisposables` 触发；多代宿主（Runtime）里由 provider Fiber 触发。
   *
   * 收过之后**不能再 adopt / 接管**：那样装出来的 Agent 底下是一个已经关掉的存储。
   */
  disposeProcessScope(): Promise<void> {
    this.processScopeDisposed = true; // 同步置位：理由同 abort()，判定不能落在 await 之后
    return unwind(
      this.entries,
      (s) => s.mode === "borrow" && s.phase !== "disposed",
      `assembly '${this.provider}' process scope`,
    );
  }

  /** 当前所有 slot 的事实（来源 owner + 当前 dispose owner + 三态）。 */
  inspect(): readonly AssemblySlotInfo[] {
    return this.entries.map(info);
  }

  private assertRegistrable(slotId: string): void {
    if (this.phase !== "open") throw new Error(`assembly 处于 '${this.phase}'，不能再登记 slot '${slotId}'`);
    if (this.processScopeDisposed) throw new Error(`进程域已经收摊过了，不能再登记 slot '${slotId}'`);
    if (this.ids.has(slotId)) throw new Error(`slot '${slotId}' 重复登记：一个 slot 只能有一个值、一个 owner`);
  }
}
