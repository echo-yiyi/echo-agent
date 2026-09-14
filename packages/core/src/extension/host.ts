// ExtensionHost：把一组 Entry 作为一个 generation mount / unmount 的内核。
//
// 边界：PREPARE（成图、验规则）→ 按拓扑 LOADING → ACTIVE，与逆拓扑 unmount；外加一条换代事务
// `replace()`（2026-09-14）：先 PREPARE 新的一代（config、依赖图），过了才卸旧代、LOADING 新代，装不上就把旧的装回去。
// loader / import、安全时机（谁来保证此刻没有
// run 在跑）、ManagedRunSources（要 admission）都不在这里——安全时机归 `Agent.betweenRuns()`，加载归装配层。
//
// 三条纪律：
//   - mount 是**全有或全无**：任何一个 Fiber 失败，它自己 LIFO unwind，本次已 ACTIVE 的按逆序全部卸掉，再抛；
//     「READY 前不得留下 unresolved hard dependency」——PENDING 只在这一次调用内部短暂存在；
//   - 失败时 **Host 状态零变化**：ServiceKey 的 canonical 表用 staged 层，整代 ACTIVE 才 commit；
//   - mount / unmount 走同一条串行事务链，**按调用顺序**执行：并发 mount 同一 generation 只有第一个成功（第二个
//     执行时发现已存在而拒绝）；unmount(g) 紧接 mount(g) 先卸后装。所有检查都在链内做，链外不看 Host 状态。

import { ExtensionAbiError, RELOAD_BOUNDARY_RANK, type ExtensionDefinition, type ReloadBoundary, type ServiceKey } from "./abi.ts";
import { Fiber, type FiberStatus } from "./fiber.ts";
import { resolveGraph } from "./graph.ts";
import { ServiceKeyTable } from "./service-key.ts";
import { probeExtension, type ExtensionFiberFact, type ExtensionProbe } from "./observe.ts";

export type ExtensionEntry = Readonly<{
  /** 稳定身份（跨 generation 不变）。 */
  entryId: string;
  definition: ExtensionDefinition<unknown>;
  config?: unknown;
}>;

export type FiberInfo = Readonly<{
  entryId: string;
  generation: string;
  status: FiberStatus;
  /** 当前登记的 Effect 数。 */
  effects: number;
}>;

/** mount 失败：`cause` 是第一个失败的原因，`unwindErrors` 是回滚过程中另外收到的错误（不吞）。 */
export class ExtensionMountError extends Error {
  constructor(
    readonly generation: string,
    readonly entryId: string,
    override readonly cause: unknown,
    readonly unwindErrors: readonly unknown[],
  ) {
    super(
      `mount generation '${generation}' 失败于 Extension '${entryId}'：${cause instanceof Error ? cause.message : String(cause)}` +
        (unwindErrors.length > 0 ? `（回滚时另有 ${unwindErrors.length} 个 disposer 失败）` : "；已回滚"),
    );
    this.name = "ExtensionMountError";
  }
}

/**
 * `replace()` 的结果。四种都**不抛**：换代是运行中做的事，抛出去只会让壳子把「新版没装上」显示成崩溃。
 *   · `replaced`：旧的已卸、新的已 ACTIVE（`next` 为 null 时就是只卸）；
 *   · `refused`：不能在此刻换——旧代里有 Fiber 声明的 `reload` 比 `safePoint` 强，或别的代还绑在它 provide 的 Service 上。**Host 状态零变化**；
 *   · `rolled_back`：新的没装上，旧的仍在（`error` 是新代失败的原因）——新代 PREPARE 就没过（config 解析、依赖图）时
 *     旧代根本没卸过、`unwindErrors` 为空；LOADING 失败时是卸了再按原 entries 装回来的；
 *   · `lost`：旧的卸了、新的没装上、旧的也装不回来——这一代现在**没挂着**。
 * `unwindErrors` 是卸旧代时 disposer 报的错：一个都不吞，但也不因此中断换代（卸都卸了）。
 */
export type ReplaceResult =
  | Readonly<{ kind: "replaced"; unwindErrors: readonly unknown[] }>
  | Readonly<{ kind: "refused"; reason: string }>
  | Readonly<{ kind: "rolled_back"; error: unknown; unwindErrors: readonly unknown[] }>
  | Readonly<{ kind: "lost"; error: unknown; rollbackError: unknown; unwindErrors: readonly unknown[] }>;

/** fibers 按 load 顺序；entries 是 mount 时收到的原件——回滚要按它重装（Fiber 里的 config 是 `definition.config()` 解析过的）。 */
type Generation = { readonly id: string; readonly fibers: readonly Fiber[]; readonly entries: readonly ExtensionEntry[] };

/** PREPARE 的产物：staged 的 key 表、拓扑序的 Fiber、mount 时收到的原 entries。还没碰任何 apply。 */
type Prepared = Readonly<{ keys: ServiceKeyTable; order: readonly Fiber[]; entries: readonly ExtensionEntry[] }>;

/** 一个装上的 Fiber 在观测里的样子：身份、声明、依赖边实际连到了谁。只读 PREPARE 解析好的图，不碰 config。 */
function fiberFact(f: Fiber): ExtensionFiberFact {
  return {
    entryId: f.entryId,
    name: f.definition.name,
    scope: f.scope,
    reload: f.reload,
    effects: f.effects.size,
    injects: f.dependencies.map((d) => ({
      service: d.service.id,
      required: d.required,
      provider: d.provider === null ? null : d.provider === "host" ? "host" : d.provider.entryId,
    })),
    provides: [...f.declaredProvides].map((k) => k.id),
  };
}

export class ExtensionHost {
  private readonly keys = new ServiceKeyTable();
  private readonly hostServices = new Map<ServiceKey<unknown>, unknown>();
  private readonly generations = new Map<string, Generation>();
  /** mount / unmount 的串行事务链：同一时刻只有一个事务在改 Host 状态，按调用顺序执行。 */
  private chain: Promise<unknown> = Promise.resolve();
  /** 观测探针（`extension/observe.ts`）：装载 / 卸载的结果在事务链上当场记。可选——低层用法不给照跑。 */
  private readonly observe: ExtensionProbe | undefined;

  /**
   * @param opts.services Host 自带的 Service（AgentTools / AgentHooks 这类 registry）。任何 Fiber 都可 inject；
   *                      没有 Fiber 能 provide 它们。
   * @param opts.observe  观测探针。与 services 无关——它不是 extension 能拿到的东西，是插在 Host 事务上的节点。
   */
  constructor(opts: { services?: ReadonlyArray<readonly [ServiceKey<unknown>, unknown]>; observe?: ExtensionProbe } = {}) {
    this.observe = opts.observe;
    for (const [key, value] of opts.services ?? []) {
      const k = this.keys.canonical(key);
      if (this.hostServices.has(k)) throw new ExtensionAbiError(`Host Service '${k.id}' 重复`);
      this.hostServices.set(k, value);
    }
  }

  get mountedGenerations(): readonly string[] {
    return [...this.generations.keys()];
  }

  inspect(): readonly FiberInfo[] {
    const out: FiberInfo[] = [];
    for (const g of this.generations.values()) {
      for (const f of g.fibers) out.push({ entryId: f.entryId, generation: g.id, status: f.status, effects: f.effects.size });
    }
    return out;
  }

  /**
   * PREPARE 一整组 → 按拓扑序 LOADING → 全部 ACTIVE。失败即回滚并抛 ExtensionMountError。
   * 一切检查都在事务链内（doMount 开头）：链外看 `generations` 会让 unmount(g) → mount(g) 的后者看到还没卸的旧代而
   * 误拒；并发 mount 同一 generation 则由串行本身保证只有第一个成功（上一版两个都越过 has()，Effect 泄漏，实测）。
   */
  mount(generation: string, entries: readonly ExtensionEntry[]): Promise<void> {
    return this.serialize(() => this.mountObserved(generation, entries));
  }

  /** 装配加观测：装上 / 没装上各记一条。`mount()` 与 `replace()` 里的装回都走这里——换代在账本里不能是空白。 */
  private async mountObserved(generation: string, entries: readonly ExtensionEntry[]): Promise<void> {
    let prepared: Prepared;
    try {
      prepared = this.prepare(generation, entries);
    } catch (e) {
      this.noteMountFailed(generation, entries, e); // PREPARE 失败：还没加载任何 Entry
      throw e;
    }
    await this.loadObserved(generation, prepared);
  }

  /** LOADING 加观测。`replace()` 装新代走这里——它的 PREPARE 在卸旧之前单独做。 */
  private async loadObserved(generation: string, prepared: Prepared): Promise<void> {
    try {
      await this.load(generation, prepared);
    } catch (e) {
      this.noteMountFailed(generation, prepared.entries, e); // 某个 Entry 的 apply / Effect start 失败并已回滚
      throw e;
    }
    const g = this.generations.get(generation);
    if (g !== undefined) probeExtension(this.observe, { kind: "generation_mounted", generation, fibers: g.fibers.map(fiberFact) });
  }

  private noteMountFailed(generation: string, entries: readonly ExtensionEntry[], e: unknown): void {
    const failed = e instanceof ExtensionMountError;
    probeExtension(this.observe, {
      kind: "generation_mount_failed",
      generation,
      entryIds: entries.map((x) => x.entryId),
      stage: failed ? "apply" : "prepare",
      ...(failed ? { failedEntryId: e.entryId } : {}),
      error: failed ? e.cause : e,
      unwindErrors: failed ? e.unwindErrors.length : 0,
    });
  }

  /**
   * 逆拓扑卸载一整代。别的 generation 里还有 ACTIVE 的 consumer 绑在本代 provider 上时拒绝——
   * consumer 先 UNLOAD、provider 后 UNLOAD 是契约；跨代 closure 的计算归 reload 事务（O5），这里只 fail-loud。
   * 未 mount 的 generation 直接返回（幂等）。所有 disposer 都尝试，最后聚合抛。
   * 与 mount 同一条事务链：mount("g") / unmount("g") 按调用顺序执行——unmount 一定看得到已 mount 的那代，
   * unmount(g) 紧接 mount(g) 则先卸后装。
   */
  unmount(generation: string): Promise<void> {
    return this.serialize(async () => {
      const g = this.generations.get(generation);
      if (g === undefined) return this.doUnmount(generation); // 未 mount：幂等返回，没有发生任何事，不记
      const entryIds = g.fibers.map((f) => f.entryId);
      try {
        await this.doUnmount(generation);
      } catch (e) {
        // 看状态而不是解析错误文本：被拒时这一代原样留着；清理出错时它已经从表里摘掉了
        if (this.generations.has(generation)) {
          probeExtension(this.observe, { kind: "generation_unmount_refused", generation, entryIds, error: e });
        } else {
          probeExtension(this.observe, { kind: "generation_unmounted", generation, entryIds, cleanupErrors: e instanceof AggregateError ? e.errors.length : 1 });
        }
        throw e;
      }
      probeExtension(this.observe, { kind: "generation_unmounted", generation, entryIds, cleanupErrors: 0 });
    });
  }

  /**
   * 换代事务（2026-09-14）：卸掉 `old`，装上 `next`；`next` 装不上就按 `old` 当初的 entries 把它装回去。
   * `next` 为 null = 只卸（文件删掉了）。**同一条事务链**，中间插不进别的 mount / unmount。
   *
   * `safePoint` 是调用方此刻所处的安全点（装配层在两次 run 之间调，给 `"run"`）：旧代里任何 Fiber 声明的
   * `reload` 比它强就 `refused`——这是 `ReloadBoundary` 第一次在运行时被读取，此前只有声明期校验。
   * 别的代还有 consumer 绑在旧代的 provider 上也 `refused`（连带重装不在这一版，见决策记录 Non-Goals）。
   *
   * **先卸再装，不先装再卸**：依赖图允许两代 overlap，但工具 / skill / prompt 段都按名注册，新代先装会撞名。
   * 但**卸之前先把新代 PREPARE 好**（config 解析、依赖图；2026-09-14 修，此前 PREPARE 在卸旧之后，config 抛会先卸再装回）：
   * 这一步失败旧代一个字都不动，结果是 `rolled_back` 且 `unwindErrors` 为空。调用方只需把新代码 import 好、验过形再调这里。
   */
  replace(
    old: string,
    next: Readonly<{ generation: string; entries: readonly ExtensionEntry[] }> | null,
    opts: Readonly<{ safePoint: ReloadBoundary }>,
  ): Promise<ReplaceResult> {
    return this.serialize(() => this.doReplace(old, next, opts.safePoint));
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const run = this.chain.then(work);
    this.chain = run.then(
      () => undefined,
      () => undefined, // 一个事务失败不阻塞链
    );
    return run;
  }

  private async doMount(generation: string, entries: readonly ExtensionEntry[]): Promise<void> {
    await this.load(generation, this.prepare(generation, entries));
  }

  /**
   * PREPARE：不碰任何 apply；ServiceKey 记在 staged 表，出错整层丢弃，Host 状态零变化。
   * `except`：算跨代 provider 时当作已经不在的那一代——`replace()` 在卸旧代之前就 PREPARE 新代，
   * 新代绑到一个马上要卸的 provider 上是假图。
   */
  private prepare(generation: string, entries: readonly ExtensionEntry[], except?: string): Prepared {
    if (typeof generation !== "string" || generation === "") throw new ExtensionAbiError("generation 必须是非空字符串");
    if (this.generations.has(generation)) throw new ExtensionAbiError(`generation '${generation}' 已经 mount 过`);

    const keys = this.keys.fork();
    const seen = new Set<string>();
    const fibers: Fiber[] = [];
    for (const entry of entries) {
      if (typeof entry.entryId !== "string" || entry.entryId === "") throw new ExtensionAbiError("Entry.entryId 必须是非空字符串");
      if (seen.has(entry.entryId)) throw new ExtensionAbiError(`generation '${generation}' 里 Entry '${entry.entryId}' 重复`);
      seen.add(entry.entryId);
      if (entry.definition.hostAbiVersion !== 1) {
        throw new ExtensionAbiError(`Entry '${entry.entryId}' 的 hostAbiVersion 不是 1，不 mount`);
      }
      let config: unknown = entry.config;
      if (entry.definition.config !== undefined) {
        try {
          config = entry.definition.config(entry.config);
        } catch (e) {
          throw new ExtensionAbiError(`Entry '${entry.entryId}' 的 config 解析失败：${e instanceof Error ? e.message : String(e)}`);
        }
      }
      fibers.push(new Fiber(entry.entryId, generation, entry.definition, config, keys));
    }
    const order = resolveGraph({
      fibers,
      keys,
      hostServices: new Set(this.hostServices.keys()),
      activeProviders: this.activeProviders(except),
    });
    for (const f of order) f.status = "pending";
    return { keys, order, entries };
  }

  /** LOADING：按拓扑序逐个 apply；失败全回滚。 */
  private async load(generation: string, prepared: Prepared): Promise<void> {
    const { keys, order, entries } = prepared;
    const activated: Fiber[] = [];
    const access = { keys, hostService: (k: ServiceKey<unknown>) => this.hostServices.get(k) };
    for (const f of order) {
      f.status = "loading";
      const ctx = f.createContext(access);
      try {
        await f.definition.apply(ctx, f.config);
        // apply 返回 ≠ Effect 都起来了：`void ctx.effect()` 的 start 还在飞。先等当时已登记的 pending start，
        // 任一失败按 mount failure 回滚——不能让 Fiber 顶着失败的 Effect 标成 ACTIVE（实测 inspect 仍显示 ACTIVE）。
        const startFailures = await f.effects.settlePendingStarts();
        if (startFailures.length > 0) {
          throw startFailures.length === 1 ? startFailures[0] : new AggregateError(startFailures, `${startFailures.length} 个 Effect start 失败`);
        }
        // 声明要 provide 的必须都 provide 了——否则 consumer 拿到的是空
        for (const key of f.declaredProvides) {
          if (!f.provided.has(key)) throw new ExtensionAbiError(`Extension ${f.label} 声明 provide '${key.id}' 但 apply 返回时没有 provide`);
        }
        f.status = "active";
        activated.push(f);
      } catch (e) {
        f.status = "failed";
        const unwindErrors: unknown[] = [];
        await this.unloadFiber(f, unwindErrors);
        for (const done of [...activated].reverse()) await this.unloadFiber(done, unwindErrors);
        throw new ExtensionMountError(generation, f.entryId, e, unwindErrors); // staged keys 随之丢弃
      }
    }
    keys.commit();
    this.generations.set(generation, { id: generation, fibers: order, entries });
  }

  private async doUnmount(generation: string): Promise<void> {
    const g = this.generations.get(generation);
    if (g === undefined) return;
    const dependents = this.dependentsOf(g);
    if (dependents.length > 0) {
      throw new ExtensionAbiError(`不能卸载 generation '${generation}'：别的 generation 还有 consumer 绑在它的 provider 上（先卸 consumer）：${dependents.join("；")}`);
    }
    const errors = await this.retire(g);
    if (errors.length > 0) throw new AggregateError(errors, `unmount generation '${generation}'：${errors.length} 处清理失败（其余已全部尝试）`);
  }

  private async doReplace(
    old: string,
    next: Readonly<{ generation: string; entries: readonly ExtensionEntry[] }> | null,
    safePoint: ReloadBoundary,
  ): Promise<ReplaceResult> {
    const g = this.generations.get(old);
    if (g === undefined) throw new ExtensionAbiError(`generation '${old}' 没有 mount，无从换代`);
    if (next !== null && this.generations.has(next.generation)) throw new ExtensionAbiError(`generation '${next.generation}' 已经 mount 过，不能拿它当新的一代`);
    if (!(safePoint in RELOAD_BOUNDARY_RANK)) throw new ExtensionAbiError(`safePoint 必须是 turn | run | agent | process，收到 ${String(safePoint)}`);

    const entryIds = g.fibers.map((f) => f.entryId);
    // 拒绝也进账本（与 `unmount()` 被拒同一条事实）：事后复盘「为什么 /reload 没换上」要看得到是谁挡的
    const refuse = (reason: string): ReplaceResult => {
      probeExtension(this.observe, { kind: "generation_unmount_refused", generation: old, entryIds, error: new ExtensionAbiError(reason) });
      return { kind: "refused", reason };
    };

    /* ── 能不能换：两条都在改任何状态之前判，refused 时 Host 零变化 ── */
    const tooStrong = g.fibers.filter((f) => RELOAD_BOUNDARY_RANK[f.reload] > RELOAD_BOUNDARY_RANK[safePoint]);
    if (tooStrong.length > 0) {
      // 没声明就是缺省 `agent`（ABI：保守）。这是热部署最常撞上的一堵墙，报文得告诉作者那一行怎么写
      const who = tooStrong.map((f) => `${f.label} ${f.definition.reload === undefined ? "没声明 reload（缺省 'agent'）" : `声明 reload '${f.reload}'`}`).join("；");
      const how = tooStrong.some((f) => f.reload === "process") ? "重启进程" : "重启 Agent";
      const hint = tooStrong.some((f) => f.definition.reload === undefined) ? `；能在两次 run 之间换的扩展请在 defineExtension 里声明 reload: "run"` : "";
      return refuse(`${who}——比当前安全点 '${safePoint}' 强，要换只能${how}${hint}`);
    }
    const dependents = this.dependentsOf(g);
    if (dependents.length > 0) {
      return refuse(`别的 generation 还有 consumer 绑在它的 provider 上（连带重装不在这一版，先卸 consumer）：${dependents.join("；")}`);
    }

    /* ── 先备新代（PREPARE：config 解析、依赖图），过了才卸旧代：新代连声明都不合格时，旧代一个字不动 ── */
    let prepared: Prepared | null = null;
    if (next !== null) {
      try {
        prepared = this.prepare(next.generation, next.entries, old);
      } catch (error) {
        this.noteMountFailed(next.generation, next.entries, error); // 账本里是「新代没装上（prepare）」，没有「卸了又装回」
        return { kind: "rolled_back", error, unwindErrors: [] };
      }
    }

    /* ── 卸旧：disposer 的错收着，不中断——卸都卸了，剩下的只有往前走 ── */
    const unwindErrors = await this.retire(g);
    probeExtension(this.observe, { kind: "generation_unmounted", generation: old, entryIds, cleanupErrors: unwindErrors.length });
    if (next === null || prepared === null) return { kind: "replaced", unwindErrors };

    /* ── 装新（LOADING）；装不上就把旧的按原 entries 装回去。装新与装回都记账：装上 / 没装上各一条事实 ── */
    try {
      await this.loadObserved(next.generation, prepared);
      return { kind: "replaced", unwindErrors };
    } catch (error) {
      try {
        await this.mountObserved(old, g.entries);
        return { kind: "rolled_back", error, unwindErrors };
      } catch (rollbackError) {
        return { kind: "lost", error, rollbackError, unwindErrors };
      }
    }
  }

  /** 从表里摘掉这一代并逆序卸它的 Fiber。返回 disposer 报的错（不抛）。 */
  private async retire(g: Generation): Promise<unknown[]> {
    this.generations.delete(g.id);
    const errors: unknown[] = [];
    for (const f of [...g.fibers].reverse()) await this.unloadFiber(f, errors);
    return errors;
  }

  /** 别的代里仍 ACTIVE、且绑在这一代某个 provider 上的 consumer：`consumer → provider` 一条一个。 */
  private dependentsOf(g: Generation): string[] {
    const mine = new Set(g.fibers);
    const dependents: string[] = [];
    for (const other of this.generations.values()) {
      if (other === g) continue;
      for (const f of other.fibers) {
        if (f.status !== "active") continue;
        for (const e of f.dependencies) {
          if (e.provider !== null && e.provider !== "host" && mine.has(e.provider)) dependents.push(`${f.label} → ${e.provider.label}`);
        }
      }
    }
    return dependents;
  }

  /** 关闸 → abort → 等 pending start → LIFO unwind → 撤 Service。每一步都做，错误收进 errors。 */
  private async unloadFiber(f: Fiber, errors: unknown[]): Promise<void> {
    if (f.status === "disposed") return;
    f.beginUnload();
    try {
      // 卸载时 start 自己的失败不算 Host 的错：它须自行清理。ACTIVE 之后 `void ctx.effect()` 的失败也在这里被丢掉——
      // 那是契约（见 `ExtensionContext.effect` 的注释），不是遗漏
      await f.effects.settlePendingStarts();
      await f.effects.unwind();
    } catch (e) {
      if (e instanceof AggregateError) errors.push(...e.errors);
      else errors.push(e);
    }
    f.provided.clear();
    f.status = "disposed";
  }

  /** 别的代里仍 ACTIVE 的 provider。`except`：这一代当作已经不在（`replace()` 先备新代时，旧代马上要卸）。 */
  private activeProviders(except?: string): ReadonlyMap<ServiceKey<unknown>, Fiber> {
    const out = new Map<ServiceKey<unknown>, Fiber>();
    for (const g of this.generations.values()) {
      if (g.id === except) continue;
      for (const f of g.fibers) {
        if (f.status !== "active") continue;
        for (const key of f.declaredProvides) out.set(key, f); // 后 mount 的代覆盖先前的：consumer 绑最新 ACTIVE provider
      }
    }
    return out;
  }
}
