// 字节面上「独占一个名字」的原语（2026-09-10，记忆的原子提交要它）。
//
// 两种实现共用这里的错误与进程内互斥：`FileDir.lock` 走 `open(…, "wx")` 锁文件，跨实例、跨进程互斥；
// `InMemoryDir.lock` 与**没有 lock 原语的字节面**（按对象）只在进程内互斥，用下面的 `NameMutex`。
//
// **不自动接管陈旧锁**——与 lease 同一条（`file-lock.ts` 头注，2026-08-18 定）：「读锁 → 判陈旧 → 删 →
// 重建」三步之间没有互斥，压测下会双授。等不到就抛 `StorageLockBusy`，让调用方明确报冲突；持有者崩在
// 持锁窗口里留下的锁文件要人手清，报错里带着它的位置与持有者。

/** 等到超时还拿不到这个名字。`holder` 是锁文件里记的持有者（进程内互斥没有这一项）。 */
export class StorageLockBusy extends Error {
  constructor(
    readonly lockName: string,
    readonly holder: string | null,
  ) {
    super(`'${lockName}' 被别的写者占着${holder === null ? "" : `（${holder}）`}，等到超时仍未释放`);
    this.name = "StorageLockBusy";
  }
}

/** 缺省等多久。持锁窗口是一次读改写（毫秒级），十秒还等不到基本就是有人崩在里面了。 */
export const DEFAULT_LOCK_TIMEOUT_MS = 10_000;

/**
 * 进程内的按名互斥：同一个名字的持有者排成一条链，前一个释放下一个才拿到。
 * 超时的那一个**仍然在链上占着位置**——它的格子要在前一个释放后立刻让出，不然后面的人会被它堵死。
 */
export class NameMutex {
  private readonly tails = new Map<string, Promise<void>>();

  async acquire(name: string, timeoutMs: number = DEFAULT_LOCK_TIMEOUT_MS): Promise<() => Promise<void>> {
    const prev = this.tails.get(name) ?? Promise.resolve();
    let open!: () => void;
    const mine = new Promise<void>((r) => {
      open = r;
    });
    const tail = prev.then(() => mine);
    this.tails.set(name, tail);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const got = await Promise.race([
      prev.then(() => true),
      new Promise<false>((r) => {
        timer = setTimeout(() => r(false), timeoutMs);
      }),
    ]);
    clearTimeout(timer);
    const settle = (): void => {
      open();
      if (this.tails.get(name) === tail) this.tails.delete(name);
    };
    if (!got) {
      void prev.then(settle); // 不拿了：前一个一释放就把位置让出去
      throw new StorageLockBusy(name, null);
    }
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      settle();
    };
  }
}
