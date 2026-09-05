// adopt slot factory 的**零外部副作用探针**。
//
// 契约那句话是：PREPARE 允许创建 candidate-owned JS 对象，但 factory / constructor **不得**读写磁盘、
// 取得 StateLock、启动 timer、连接网络/子进程、注册 global listener，或消费 Inbox。这条契约撑着两件事：
// ①「未 start 的 candidate 被 dispose 时只释放纯内存引用」——所以 adopt slot 默认不需要 disposer；
// ②「旧 Agent 还 ACTIVE 时不会偷偷起第二份」——所以装配一个 candidate 是安全的。
//
// **纪律不算证明，所以有这个探针**：它把 factory 拿得到的两条外部通道换成陷阱端口（碰一下就抛），
// 再把进程级的四类入口（timer / 网络 / global listener / 子进程）临时接管。
//
// **被禁的入口一律「记账 + 当场抛」，绝不调用原实现**。上一版是「记一笔再调 original」，于是探针自己把
// 违约副作用真的做了一遍：`fetch()` 真发了一次请求、`process.on()` 注册的监听器在探针退出后还留着
// （只数前后差根本撤不掉它）。判据是「有没有碰这个入口」，不需要让它真的生效。
//
// **factory 必须是同步的，而且这件事只能在调用之前挡**：探针接管全局入口的窗口就是 `factory()` 这一次
// 同步调用，async factory 的续体在还原之后才跑，副作用整段逃逸——「返回 thenable 之后再判红」拦不住它
//（实测：`async () => { await Promise.resolve(); await fetch(...) }` 判红了，原 `fetch` 仍被真调了一次）。
// 所以原生 AsyncFunction / AsyncGeneratorFunction **在调用之前就拒**，类型层也把返回 PromiseLike 的
// factory 判红。契约里 candidate 就是一个同步 new 出来的 JS 对象，需要 await 的东西属于 restore，
// 归 `Agent.start()`。
//
// **诚实边界（这一条挡不住）**：一个普通同步函数**动态造出** thenable（返回 `{ then(cb){ …副作用… } }`、
// 或返回一个别处已经在飞的 Promise）时，探针只能在事后**报告**违约，拦不住它之后的副作用——真要拦住
// 得把 factory 放进隔离子进程跑，本探针不做那件事。别把「返回 thenable 判红」读成「逃逸被阻止了」：
// 对这一类它是**检出**，不是防线。被降级编译成状态机的 async 函数（本仓不降级，Bun 直接跑 TS）
// 在运行期也认不出来，同属这一类。
//
// 诚实的覆盖边界：探针能证明的是「factory 没通过**注入的端口**碰盘/碰锁，也没碰**全局对象上的**
// 那几类入口」。它**不拦** `import("node:fs")` / `import("node:child_process")` 之类直接绕过注入的写法——
// 那种东西 review 能看见，而探针给不出机器判据；别把它当成全覆盖的门。first-party 的几个 factory 都只经
// 注入端口做事，所以对它们来说这条判据是紧的。

import type { StorageDir } from "../storage/types.ts";
import type { Lease, StateLock } from "../storage/lock.ts";

export type PurityViolationKind =
  | "storage"
  | "lock"
  | "timer"
  | "network"
  | "global-listener"
  | "subprocess"
  | "async-factory";

export type PurityViolation = Readonly<{ kind: PurityViolationKind; detail: string }>;

/** factory 碰了不该碰的东西。**陷阱端口与被接管的入口都直接抛它**——fail-loud，且不让副作用真的发生。 */
export class FactoryPurityError extends Error {
  readonly kind: PurityViolationKind;
  constructor(violation: PurityViolation) {
    super(`adopt slot factory 违反零副作用契约（${violation.kind}）：${violation.detail}`);
    this.name = "FactoryPurityError";
    this.kind = violation.kind;
  }
}

/** 碰任何一个方法就抛的 `StorageDir`：证明 factory 期没有磁盘 I/O。 */
export function trapStorageDir(label = "trap"): StorageDir {
  const trap = (op: string): never => {
    throw new FactoryPurityError({ kind: "storage", detail: `${label}.${op}()——durable restore 只能发生在 Agent.start()` });
  };
  return {
    read: (p) => trap(`read(${p})`),
    write: (p) => trap(`write(${p})`),
    remove: (p) => trap(`remove(${p})`),
    list: (p) => trap(`list(${p})`),
    close: () => trap("close"),
  };
}

/** 碰 `acquire()` 就抛的 `StateLock`：单写者资格只能由 `Agent.start()` 取。 */
export function trapStateLock(label = "trap"): StateLock {
  return {
    acquire: (): Promise<Lease | null> => {
      throw new FactoryPurityError({ kind: "lock", detail: `${label}.acquire()——StateLock 只能由 Agent.start() 取` });
    },
  };
}

type AnyFn = (...args: never[]) => unknown;

/**
 * 同步 factory 的**类型层判据**：返回 `PromiseLike` 的 factory 编译期就判红
 *（`T extends never` 不成立 → 约束失败）。运行期还有 `assertSyncFactory()` 那道，给 JS 调用方。
 */
export type SyncFactoryResult<T> = T extends PromiseLike<unknown> ? never : unknown;

function isThenable(v: unknown): boolean {
  return (typeof v === "object" || typeof v === "function") && v !== null && typeof (v as { then?: unknown }).then === "function";
}

/** 原生 async 函数（含 async generator）。**调用之前就要认出来**——调用之后再判就晚了。 */
function isAsyncFunction(fn: unknown): boolean {
  const tag = Object.prototype.toString.call(fn);
  if (tag === "[object AsyncFunction]" || tag === "[object AsyncGeneratorFunction]") return true;
  return typeof fn === "function" && (fn.constructor as { name?: string } | undefined)?.name === "AsyncFunction";
}

/**
 * 在探针下跑一个 factory。factory 的返回值与它抛的错都原样透出（探针不吞异常），
 * 碰过的禁区记在 `violations` 里——**记账与抛错同时发生**，所以 factory 就算把 `FactoryPurityError`
 * 吞了，违约事实也还在。
 */
export function runFactoryProbe<T>(
  factory: () => T & SyncFactoryResult<T>,
): {
  value: T;
  violations: readonly PurityViolation[];
  /** **真正被接管到的入口**。没进这张表的入口这一轮没有覆盖——conformance 据此判红，不留静默缺口。 */
  covered: readonly string[];
} {
  // **一次都不许调**：async factory 的续体在还原之后才跑，那时探针已经没有覆盖了。
  if (isAsyncFunction(factory)) {
    throw new FactoryPurityError({
      kind: "async-factory",
      detail: "factory 是 async 函数——candidate 必须同步 new 出来，要 await 的事情归 Agent.start()（探针拒绝调用它）",
    });
  }
  const violations: PurityViolation[] = [];
  const restores: (() => void)[] = [];
  const covered: string[] = [];

  /**
   * 接管一个入口：记一笔 + 当场抛，**不调用原实现**。
   *
   * 三种属性形态各有各的接管法：可配置的用 `defineProperty`；**不可配置但可写**的只能赋值
   *（`Bun.spawnSync` 就是这一类——上一版一律走 defineProperty，对它当场 TypeError 然后被 catch 吞掉，
   * 于是子进程整类没有覆盖，实测真的 spawn 出来了）；继承来的直接在自身上盖、还原时删掉。
   * 接管不了的**不进 `covered`**，让判据看得见缺口。
   */
  const seize = (host: object, name: string, violation: PurityViolation, label = name): void => {
    const bag = host as Record<string, unknown>;
    const original = bag[name];
    if (typeof original !== "function") return;
    const descriptor = Object.getOwnPropertyDescriptor(host, name);
    const replacement = ((): never => {
      violations.push(violation);
      throw new FactoryPurityError(violation);
    }) as AnyFn;
    try {
      if (descriptor !== undefined && descriptor.configurable) {
        Object.defineProperty(host, name, {
          value: replacement,
          writable: descriptor.writable ?? true,
          enumerable: descriptor.enumerable,
          configurable: true,
        });
        restores.push(() => Object.defineProperty(host, name, descriptor));
      } else if (descriptor === undefined) {
        bag[name] = replacement;
        restores.push(() => {
          delete bag[name];
        });
      } else if (descriptor.writable === true) {
        bag[name] = replacement;
        restores.push(() => {
          bag[name] = original;
        });
      } else {
        return;
      }
    } catch {
      return;
    }
    if (bag[name] !== replacement) return; // 赋值被 setter/只读挡掉了：没接管上，就别声称覆盖了
    covered.push(label);
  };

  const g = globalThis as unknown as object;
  const timer = (fn: string): PurityViolation => ({ kind: "timer", detail: `${fn}()——timer 只能由 Agent.activate() 起` });
  seize(g, "setTimeout", timer("setTimeout"));
  seize(g, "setInterval", timer("setInterval"));
  seize(g, "setImmediate", timer("setImmediate"));
  seize(g, "fetch", { kind: "network", detail: "fetch()——candidate 期不许连网络" });
  seize(
    g,
    "addEventListener",
    { kind: "global-listener", detail: "globalThis.addEventListener()" },
    "globalThis.addEventListener",
  );

  // 子进程：`Bun.spawn` / `Bun.spawnSync` 是本运行时上真实可达的那条。
  const bun = (globalThis as { Bun?: object }).Bun;
  if (bun !== undefined) {
    seize(bun, "spawn", { kind: "subprocess", detail: "Bun.spawn()——candidate 期不许起子进程" }, "Bun.spawn");
    seize(bun, "spawnSync", { kind: "subprocess", detail: "Bun.spawnSync()——candidate 期不许起子进程" }, "Bun.spawnSync");
  }

  // process 上的监听器：**拦注册**，不是事后数差值——数差值撤不掉已经注册上去的那个。
  const proc = (globalThis as { process?: object }).process;
  const listenerNames = ["on", "once", "addListener", "prependListener", "prependOnceListener"] as const;
  if (proc !== undefined) {
    for (const name of listenerNames) {
      seize(
        proc,
        name,
        { kind: "global-listener", detail: `process.${name}()——candidate 期不许注册进程级监听器` },
        `process.${name}`,
      );
    }
  }
  // 兜底：万一还有没接管到的注册路径，前后差至少能把它照出来（**不是主判据**）。
  const counted = proc as { eventNames?: () => (string | symbol)[]; listenerCount?: (e: string | symbol) => number } | undefined;
  const countListeners = (): number => {
    if (counted?.eventNames === undefined || counted.listenerCount === undefined) return 0;
    let n = 0;
    for (const name of counted.eventNames()) n += counted.listenerCount(name);
    return n;
  };
  const before = countListeners();

  try {
    const value = factory();
    const added = countListeners() - before;
    if (added > 0) violations.push({ kind: "global-listener", detail: `process 上多了 ${added} 个监听器` });
    if (isThenable(value)) {
      // 同步函数动态造出来的 thenable：这里只能**报告**，拦不住它之后的副作用（诚实边界，见文件头）。
      violations.push({
        kind: "async-factory",
        detail:
          "factory 返回了 thenable——candidate 必须是同步 new 出来的对象；" +
          "**这一条是检出不是阻止**：续体里的副作用发生在探针还原之后，本探针拦不住",
      });
    }
    return { value, violations, covered };
  } finally {
    for (let i = restores.length - 1; i >= 0; i--) restores[i]!();
  }
}

/** `runFactoryProbe` 的严格版：有任何违约就抛。conformance 用这个。 */
export function assertPureFactory<T>(factory: () => T & SyncFactoryResult<T>, what: string): T {
  const { value, violations } = runFactoryProbe(factory);
  if (violations.length > 0) {
    throw new FactoryPurityError({
      kind: violations[0]!.kind,
      detail: `${what}：${violations.map((v) => v.detail).join("；")}`,
    });
  }
  return value;
}
