// EffectStack：一个 Fiber 拥有的全部 Effect，按登记顺序入栈、**LIFO** 卸。
//
// **栈位在登记那一刻占好**（`reserve()`），lease 到手再填（`fill()`）：两个并行的 start 谁先完成不改变它们的卸载顺序——
// 卸载是登记序的逆序，不是完成序（2026-09-14 修；此前 lease 完成才入栈，并行 start 实测按完成序排队，
// `docs/design/extensions.md` §9）。start 失败的那一位没有 lease，卸载跳过。
//
// 卸载顺序是契约：关闭登记闸 → abort → 等所有还没完成的 start settle → LIFO dispose。
// 「异步回调不能在 disposer snapshot 之后偷偷注册新资源」靠两件事：闸关了之后 `ctx.effect()` 直接抛；
// 闸关之前已经开始、之后才完成的 start，它的 lease 仍会入栈并在随后的 unwind 里被卸掉——
// 所以 unwind 必须等 pending start 全部 settle 之后才开始。

import type { Disposer, EffectLease, ReloadBoundary } from "./abi.ts";

type EffectEntry = Readonly<{ boundary: ReloadBoundary; dispose: Disposer; label: string }>;

export class EffectStack {
  /** 按登记顺序的栈位；null = 这一位的 start 还没完成或已失败（没有 lease 可卸）。 */
  private readonly entries: (EffectEntry | null)[] = [];
  /** 已填上 lease 的栈位数——`size` 报的是它，不是占了多少位。 */
  private filled = 0;
  private readonly pendingStarts = new Set<Promise<unknown>>();
  /**
   * mount 期已失败的 start 的原因，直到第一次 settlePendingStarts() drain 为止一直留着。
   * 第一次 drain 之后（Fiber 已 ACTIVE）**不再缓冲**：那些失败只有 await 它的登记者能看到（`ExtensionContext.effect` 的契约），
   * 缓冲到卸载只会随 turn 数一直涨、又没人读（review 2026-09-09）。
   */
  private readonly startFailures: unknown[] = [];
  private bufferFailures = true;
  private gate = true;
  private unwound = false;

  /** 登记闸是否还开着（UNLOADING 一开始就关）。 */
  get open(): boolean {
    return this.gate;
  }
  get size(): number {
    return this.filled;
  }
  get pending(): number {
    return this.pendingStarts.size;
  }

  /**
   * 记下一个尚未完成的 start；settle 后从 pending 移除，**失败的原因进持久缓冲** `startFailures`——
   * 上一版 settle 即删：`void ctx.effect()` 很快失败、apply 随后还做别的异步事，等 Host 来 settle 时失败已经
   * 消失，Fiber 照样 ACTIVE（实测）。返回的是同一个 promise（不吞 rejection）。
   */
  track<T>(started: Promise<T>): Promise<T> {
    this.pendingStarts.add(started);
    started.then(
      () => {
        this.pendingStarts.delete(started);
      },
      (e: unknown) => {
        this.pendingStarts.delete(started);
        if (this.bufferFailures) this.startFailures.push(e);
      },
    );
    return started;
  }

  /** 登记时占一个栈位：位号就是登记顺序，start 完成得早晚不改变它。 */
  reserve(): number {
    this.entries.push(null);
    return this.entries.length - 1;
  }

  /** start 完成、lease 到手：填进当初占的那一位。 */
  fill(slot: number, boundary: ReloadBoundary, lease: EffectLease<unknown>, label: string): void {
    this.entries[slot] = { boundary, dispose: lease.dispose, label };
    this.filled++;
  }

  /** 登记闸关上：之后 `ctx.effect()` 抛 ExtensionDisposedError。 */
  closeGate(): void {
    this.gate = false;
  }

  /**
   * 等所有还在飞的 start settle。成功的 lease 已入栈；失败的原因**收集返回**——mount 路径据此判 Fiber 失败
   * （`void ctx.effect()` 的 start 在 apply 返回之后才 reject，不能让 Fiber 顶着失败的 Effect 标成 ACTIVE），
   * unload 路径忽略（那是 start 自己的失败，它须自行清理部分资源）。
   */
  async settlePendingStarts(): Promise<unknown[]> {
    // start 完成时可能又触发新的 track（同步链），所以循环到空为止；settle 掉的由 track 的 handler 移除
    while (this.pendingStarts.size > 0) {
      await Promise.allSettled([...this.pendingStarts]);
    }
    // pending 清空后**原子 drain**：失败无论发生在多久之前，都在这里被看到（track 的 rejection handler
    // 比 allSettled 的 continuation 先跑，所以退出循环时 startFailures 已经齐了）。这之后的失败不再进缓冲。
    this.bufferFailures = false;
    return this.startFailures.splice(0);
  }

  /**
   * LIFO 卸载。**每一个都尝试**，失败的收进 AggregateError 最后一起抛；幂等——第二次调用直接返回，
   * 不重复执行 disposer（「dispose() 幂等是 Runtime 的保证，不要求每个第三方 disposer 自己实现二次调用」）。
   */
  async unwind(): Promise<void> {
    if (this.unwound) return;
    this.unwound = true;
    this.gate = false;
    const errors: unknown[] = [];
    const failed: string[] = [];
    while (this.entries.length > 0) {
      const entry = this.entries.pop()!;
      if (entry === null) continue; // 这一位的 start 没完成或失败了：没有 lease，无从卸
      this.filled--;
      try {
        await entry.dispose();
      } catch (e) {
        errors.push(e);
        failed.push(entry.label);
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, `${errors.length} 个 Effect disposer 失败（其余已全部尝试）：${failed.join("、")}`);
    }
  }
}
