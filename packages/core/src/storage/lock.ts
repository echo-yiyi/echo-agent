// StateLock —— 状态根的单写者资格（D6 / §13.12.3）。**纯端口，不碰 `node:`。**
//
// 为什么不塞进 `StorageDir`：那个面只有 read/write/remove/list，**没有原子 create-if-absent
// 也没有 CAS**，用它模拟锁必然留 TOCTOU 窗口。而且一旦用户换成远程 Store，两个 `stateDir`
// 不同、却指向同一后端的进程之间，本地文件锁毫无意义——D6 那条「single-writer fail-loud」
// 就只在默认实现上成立、换 Store 静默失效，那是假绿。

/**
 * 持有中的租约。
 *
 * **只有两件事**：怎么还，以及怎么知道自己已经不持有了。续租不在这条面上——
 * 谁实现谁负责续（本地文件锁根本不需要续），core 只关心「还持有吗」。
 */
export type Lease = {
  release(): Promise<void>;
  /**
   * **丢锁信号**：租约到期、续租失败、被抢占——实现在任一情况下**用 Error resolve 它**。
   *
   * 是 resolve 不是 reject：仍持有时这个 Promise **永不 settle**，
   * 而一个长期挂着的 rejected Promise 会变成 unhandled rejection 噪音；
   * 且「丢锁」是**正常的、必须被处理的事件**，不是异常。
   * 本地文件锁的实现就是 `new Promise<Error>(() => {})`。
   */
  lost: Promise<Error>;
};

export interface StateLock {
  /**
   * 取得单写者资格。**`null` = 已被别人持有**，调用方（`start()`）据此 fail-loud。
   *
   * **core 不抢占**：返回 `null` 就是拿不到，core 不猜「对面是不是死了」。
   * 带 TTL 的实现是否在租约过期后接管，由该实现自己决定并写进它的 conformance。
   */
  acquire(opts: { holder: string }): Promise<Lease | null>;

  /**
   * 「现在是谁占着」——**只用于人读的诊断**，不参与任何取舍判断（core 仍然不抢占）。
   *
   * 可选：远程实现未必答得上来。答不上来返回 `null`，`start()` 就退回原来那句报错。
   * 有它的意义在于：不接管的代价是「崩溃后要人工删锁」，而人工删锁的前提是
   * **看得见是谁占着**——否则这条纪律只能靠猜。
   */
  describeHolder?(): Promise<string | null>;
}

/**
 * 内存锁：**单进程内**互斥，给测试与纯内存跑用。
 *
 * 它不跨进程——所以别拿它当「关掉 single-writer」的开关；真要跨进程互斥就用
 * first-party 的文件锁（`@echo-agent/core` 根入口）或自己的远程实现。
 */
export class InMemoryStateLock implements StateLock {
  private current: { signalLost: (e: Error) => void } | null = null;

  async acquire(_opts: { holder: string }): Promise<Lease | null> {
    if (this.current !== null) return null;
    let signalLost: (e: Error) => void = () => {};
    const lost = new Promise<Error>((resolve) => {
      signalLost = resolve;
    });
    const holder = { signalLost };
    this.current = holder;
    return {
      release: async () => {
        if (this.current === holder) this.current = null;
      },
      lost,
    };
  }

  /**
   * 模拟租约丢失。**测试专用**——丢锁后的行为是契约要求配单测的不变量（§13.12.3），
   * 没有这个入口就只能等真实租约过期，那种测试要么慢要么飘。
   */
  simulateLost(reason: string): void {
    this.current?.signalLost(new Error(reason));
  }
}
