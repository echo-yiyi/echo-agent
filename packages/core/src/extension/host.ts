// ExtensionHost：把一组 Entry 作为一个 generation mount / unmount 的内核。
//
// O2a 的边界：只有 PREPARE（成图、验规则）→ 按拓扑 LOADING → ACTIVE，与逆拓扑 unmount。
// reload 事务（QUIESCE / SWAP）、loader / import、ManagedRunSources（要 admission）都不在这里。
//
// 三条纪律：
//   - mount 是**全有或全无**：任何一个 Fiber 失败，它自己 LIFO unwind，本次已 ACTIVE 的按逆序全部卸掉，再抛；
//     「READY 前不得留下 unresolved hard dependency」——PENDING 只在这一次调用内部短暂存在；
//   - 失败时 **Host 状态零变化**：ServiceKey 的 canonical 表用 staged 层，整代 ACTIVE 才 commit；
//   - mount / unmount 走同一条串行事务链，**按调用顺序**执行：并发 mount 同一 generation 只有第一个成功（第二个
//     执行时发现已存在而拒绝）；unmount(g) 紧接 mount(g) 先卸后装。所有检查都在链内做，链外不看 Host 状态。

import { ExtensionAbiError, type ExtensionDefinition, type ServiceKey } from "./abi.ts";
import { Fiber, type FiberStatus } from "./fiber.ts";
import { resolveGraph } from "./graph.ts";
import { ServiceKeyTable } from "./service-key.ts";

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

type Generation = { readonly id: string; readonly fibers: readonly Fiber[] }; // fibers 按 load 顺序

export class ExtensionHost {
  private readonly keys = new ServiceKeyTable();
  private readonly hostServices = new Map<ServiceKey<unknown>, unknown>();
  private readonly generations = new Map<string, Generation>();
  /** mount / unmount 的串行事务链：同一时刻只有一个事务在改 Host 状态，按调用顺序执行。 */
  private chain: Promise<unknown> = Promise.resolve();

  /**
   * @param opts.services Host 自带的 Service（AgentTools / AgentHooks 这类 registry）。任何 Fiber 都可 inject；
   *                      没有 Fiber 能 provide 它们。
   */
  constructor(opts: { services?: ReadonlyArray<readonly [ServiceKey<unknown>, unknown]> } = {}) {
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
    return this.serialize(() => this.doMount(generation, entries));
  }

  /**
   * 逆拓扑卸载一整代。别的 generation 里还有 ACTIVE 的 consumer 绑在本代 provider 上时拒绝——
   * consumer 先 UNLOAD、provider 后 UNLOAD 是契约；跨代 closure 的计算归 reload 事务（O5），这里只 fail-loud。
   * 未 mount 的 generation 直接返回（幂等）。所有 disposer 都尝试，最后聚合抛。
   * 与 mount 同一条事务链：mount("g") / unmount("g") 按调用顺序执行——unmount 一定看得到已 mount 的那代，
   * unmount(g) 紧接 mount(g) 则先卸后装。
   */
  unmount(generation: string): Promise<void> {
    return this.serialize(() => this.doUnmount(generation));
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
    if (typeof generation !== "string" || generation === "") throw new ExtensionAbiError("generation 必须是非空字符串");
    if (this.generations.has(generation)) throw new ExtensionAbiError(`generation '${generation}' 已经 mount 过`);

    /* ── PREPARE：不碰任何 apply；ServiceKey 记在 staged 表，出错整层丢弃，Host 状态零变化 ── */
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
      activeProviders: this.activeProviders(),
    });
    for (const f of order) f.status = "pending";

    /* ── LOADING：按拓扑序逐个 apply；失败全回滚 ── */
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
    this.generations.set(generation, { id: generation, fibers: order });
  }

  private async doUnmount(generation: string): Promise<void> {
    const g = this.generations.get(generation);
    if (g === undefined) return;
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
    if (dependents.length > 0) {
      throw new ExtensionAbiError(`不能卸载 generation '${generation}'：别的 generation 还有 consumer 绑在它的 provider 上（先卸 consumer）：${dependents.join("；")}`);
    }
    this.generations.delete(generation);
    const errors: unknown[] = [];
    for (const f of [...g.fibers].reverse()) await this.unloadFiber(f, errors);
    if (errors.length > 0) throw new AggregateError(errors, `unmount generation '${generation}'：${errors.length} 处清理失败（其余已全部尝试）`);
  }

  /** 关闸 → abort → 等 pending start → LIFO unwind → 撤 Service。每一步都做，错误收进 errors。 */
  private async unloadFiber(f: Fiber, errors: unknown[]): Promise<void> {
    if (f.status === "disposed") return;
    f.beginUnload();
    try {
      await f.effects.settlePendingStarts(); // 卸载时 start 自己的失败不算 Host 的错：它须自行清理
      await f.effects.unwind();
    } catch (e) {
      if (e instanceof AggregateError) errors.push(...e.errors);
      else errors.push(e);
    }
    f.provided.clear();
    f.status = "disposed";
  }

  private activeProviders(): ReadonlyMap<ServiceKey<unknown>, Fiber> {
    const out = new Map<ServiceKey<unknown>, Fiber>();
    for (const g of this.generations.values()) {
      for (const f of g.fibers) {
        if (f.status !== "active") continue;
        for (const key of f.declaredProvides) out.set(key, f); // 后 mount 的代覆盖先前的：consumer 绑最新 ACTIVE provider
      }
    }
    return out;
  }
}
