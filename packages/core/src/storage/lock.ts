// StateLock —— 状态根的单写者资格（D6）。**纯端口，不碰 `node:`。**
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
   * **有人在等这把锁**（2026-09-07 用户拍板：人优先，后台让位）。
   *
   * 只有**自称可让位**的持有者才会收到它——收到就该把手上的活 drain 完、`release()`、退出。
   * 没人等、或本持有者不可让位时，这个 Promise **永不 settle**（与 `lost` 同一条理由：
   * 长期挂着的 rejected 会变噪音，而「有人在等」是正常事件不是异常）。
   *
   * **这不是抢占**：锁不会被从持有者手里夺走，是持有者自己让出来的。所以
   * 「core 不抢占、不猜对面死没死」那条一个字没变——变的是持有者可以声明「人来了我就走」。
   */
  handoffRequested?: Promise<{ by: string }>;
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
  acquire(opts: {
    holder: string;
    /**
     * 本持有者可不可以被请走（2026-09-07）。缺省 `false`——人开的那种会话不该被后台顶掉。
     * 只有「为了处理一条消息而被叫醒」的那种临时宿主才该声明 `true`。
     */
    preemptible?: boolean;
  }): Promise<Lease | null>;

  /**
   * 「现在是谁占着」——**只用于人读的诊断**，不参与任何取舍判断（core 仍然不抢占）。
   *
   * 可选：远程实现未必答得上来。答不上来返回 `null`，`start()` 就退回原来那句报错。
   * 有它的意义在于：不接管的代价是「崩溃后要人工删锁」，而人工删锁的前提是
   * **看得见是谁占着**——否则这条纪律只能靠猜。
   */
  describeHolder?(): Promise<string | null>;

  /**
   * 请当前持有者交还（2026-09-07）。**只有它自称 `preemptible` 时才会真的让**——
   * 不可让位的持有者一律立刻返回 `false`，调用方按老规矩 fail-loud。
   *
   * 返回 `true` = 这一刻锁空出来了（调用方随后仍要正常 `acquire()`，中间可能被第三方抢先，
   * 那时照旧拿不到——**没有任何路径能让两个写者同时在**）。
   *
   * 可选：远程实现未必有这条通道；没有就等于「谁都请不走」，行为退回今天的样子。
   */
  requestHandoff?(opts: { by: string; timeoutMs: number }): Promise<boolean>;
}

/**
 * 内存锁：**单进程内**互斥，给测试与纯内存跑用。
 *
 * 它不跨进程——所以别拿它当「关掉 single-writer」的开关；真要跨进程互斥就用
 * first-party 的文件锁（`@echo-agent/core` 根入口）或自己的远程实现。
 */
export class InMemoryStateLock implements StateLock {
  private current: {
    signalLost: (e: Error) => void;
    signalHandoff: (by: { by: string }) => void;
    preemptible: boolean;
  } | null = null;

  async acquire(opts: { holder: string; preemptible?: boolean }): Promise<Lease | null> {
    if (this.current !== null) return null;
    let signalLost: (e: Error) => void = () => {};
    const lost = new Promise<Error>((resolve) => {
      signalLost = resolve;
    });
    let signalHandoff: (by: { by: string }) => void = () => {};
    const handoffRequested = new Promise<{ by: string }>((resolve) => {
      signalHandoff = resolve;
    });
    const holder = { signalLost, signalHandoff, preemptible: opts.preemptible === true };
    this.current = holder;
    return {
      release: async () => {
        if (this.current === holder) this.current = null;
      },
      lost,
      // 不可让位的持有者拿到一个**永不 settle** 的 Promise：它不该收到这个信号
      handoffRequested: holder.preemptible ? handoffRequested : new Promise<{ by: string }>(() => {}),
    };
  }

  /**
   * 请持有者交还。可让位的：发信号并等它 `release()`；否则立刻 `false`。
   * 与文件锁同一份语义，所以两种实现下的判据是同一条。
   */
  async requestHandoff(opts: { by: string; timeoutMs: number }): Promise<boolean> {
    const holder = this.current;
    if (holder === null) return true; // 已经空着
    if (!holder.preemptible) return false;
    holder.signalHandoff({ by: opts.by });
    const deadline = Date.now() + opts.timeoutMs;
    while (Date.now() < deadline) {
      if (this.current === null) return true;
      await new Promise((r) => setTimeout(r, 5));
    }
    return this.current === null;
  }

  /**
   * 模拟租约丢失。**测试专用**——丢锁后的行为是契约要求配单测的不变量，
   * 没有这个入口就只能等真实租约过期，那种测试要么慢要么飘。
   */
  simulateLost(reason: string): void {
    this.current?.signalLost(new Error(reason));
  }
}
