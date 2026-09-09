// Hook Runtime：进程内可编程、进程外可脚本化的统一挂点机制。
//
// 三条骨架：
//   ① **一套词汇表，两种消费**：LifecycleEvent 是唯一词汇表；注册表给每个事件标
//      「可拦截 / 仅通知」。可拦截的走 Promise<HookResult>，仅通知的返回值忽略。
//      不给通知和拦截各起一套名字——同一时刻两个名字必然漂移。
//   ② **两种 handler 后端，同协议**：进程内 callback 与外部脚本同事件、同顺序、
//      同折叠、同失败语义，只差运输。
//   ③ **hook 没有特权**：V0 handler 只有当前事件与 HookResult 的 continue/block/patch，
//      **不暴露** steer/followUp/abort 或 `tools.invoke` 命令面（2026-08-25 决策记录）。
//      Hook 要改变后续对话，走将来显式授权的 Runtime command API；问人是 permission pipeline 的事。
//
// 加固的几条（2026-08-25）：
//   - **turn 工作集**：`snapshot()` 把当前 handler 条目冻成一份 `HookWorkset`，循环在每轮开头取一次，
//     本轮中途的注册/卸载只影响下一轮——热重载不能让同一轮前半用旧 handler、后半用新 handler。
//   - **卸载器认对象身份**：`on()` 返回的卸载器只删自己登记的那一条；同 id 后来者不受它影响。
//   - `HookEffect[]` 与 hook 直调 InternalTool 的命令面一并删除：前者从没有过消费者，后者是一条
//     绕开循环流水线的后门——留着都是假 ABI。

import { errText } from "../errors.ts";
import type { LifecycleEvent, LifecycleEventOf, LifecycleEventType } from "../events.ts";
import type { AgentToolResult } from "../tools/types.ts";

/* ───────────────── 可拦截集与 patch 白名单 ───────────────── */

/**
 * 可拦截点。其余事件是「已经发生」，订阅即可，返回值不被消费。
 *
 * `permissionRequest` **不在**这里：授权只能来自正式 authorization stage，
 * hook 对 permission 生命周期事件只能观察——留在可拦截集里，`block` 就是第二条 deny 路径，
 * `patch` 就能改掉已冻结的参数。
 *
 * **同一批并行工具内，`preToolUse` / `postToolUse` 可能并发，hook 作者不能假设批内顺序**
 * （工具自己声明 `concurrent`；见 docs/decisions/implemented/2026-09-07-parallel-tools.md）。
 * 每个工具各跑各的一遍，按 `toolCallId` 配对；批与批之间仍是顺序的。
 */
export const INTERCEPTABLE = [
  "preToolUse",
  "postToolUse",
  "userPromptSubmit",
  "stop",
  "preCompact",
  "contextBeforeBuild",
] as const;
export type InterceptableType = (typeof INTERCEPTABLE)[number];

const INTERCEPTABLE_SET: ReadonlySet<string> = new Set(INTERCEPTABLE);

export function isInterceptable(type: LifecycleEventType): type is InterceptableType {
  return INTERCEPTABLE_SET.has(type);
}

/**
 * 每个事件能改什么，类型层锁死——防「hook 万能改」。
 * 不在表里的事件 = 只能 block，改不了任何字段。
 */
export type Patchable = {
  preToolUse: { params: Record<string, unknown> };
  postToolUse: { result: AgentToolResult };
  userPromptSubmit: { text: string };
  contextBeforeBuild: { messages: LifecycleEventOf<"contextBeforeBuild">["messages"] };
};

type PatchOf<E extends LifecycleEventType> = E extends keyof Patchable ? Patchable[E] : never;

/* ───────────────── HookResult ───────────────── */

export type HookResult<E extends LifecycleEventType = LifecycleEventType> = {
  /** 缺省 continue；handler 返回 void 也是 continue。**没有 "stop"**——hook 不能停整个 agent（已否决）。 */
  decision?: "continue" | "block";
  /** block 时这句话就是落给模型/日志的拒因。 */
  reason?: string;
  patch?: PatchOf<E>;
};

/** 折叠结果：事件可能被改过，所以把最终事件一起还给调用方。 */
export type Interception<E extends LifecycleEventType> = {
  decision: "continue" | "block";
  reason?: string;
  event: LifecycleEventOf<E>;
};

/* ───────────────── HookContext ───────────────── */

export type HookOrigin = "model" | "hook" | "runtime" | "user";

/**
 * hook 能碰到的现场——**只有现场，没有命令面**。
 * 刻意没有的：`agent.steer/followUp/abort`、`tools.invoke`（2026-08-25 作废：绕开循环流水线的后门）、
 * `session.appendMessage`（破 entries 单写者）、`ui.confirm`（问人是 permission pipeline 的职责）。
 */
export type HookContext = {
  /** 这条事件是谁引起的：`user` = 用户输入进入循环（`userPromptSubmit`），其余事件由 Agent 按发生处标。 */
  readonly origin: HookOrigin;
  /** 正在被调用的这条 hook 的注册 id（`on()` 的 `opts.id` 或自动编号）——由 HookRuntime 逐条填，调用方给的值会被覆盖。 */
  readonly hookId: string;
  readonly signal?: AbortSignal;
};

/* ───────────────── 注册与外部脚本 ───────────────── */

export type NotifyOnlyType = Exclude<LifecycleEventType, InterceptableType>;

/**
 * 只读观察者（`subscribeLifecycle()`）：与 handler 走**同一个 emission point、同一顺序**，
 * 但不参与折叠——返回值不是授权决定，抛错也不能隐式 allow/deny。可信宿主 CLI/SDK 用它收 permission ask，
 * 再单独调 `answerPermission()`；不为 permission 另造一条事件总线。
 */
export type LifecycleEventListener = (event: LifecycleEvent) => void | Promise<void>;

/** notify-only handler 允许的返回：什么都不返回，或一个 resolve 成空的 Promise。 */
type NotifyReturn = void | undefined | Promise<void | undefined>;

/**
 * handler 允许的返回类型随事件分两种：可拦截点可以返回 `HookResult`；notify-only 点**不能**——
 * 不是「返回了也被忽略」，是类型上不合法。`permissionRequest/Granted/Denied/Cancelled` 都在后一类：
 * hook 对 permission 只能观察，block/patch 不是合法返回值。
 *
 * `on()` 把 handler 的实际返回类型抓成类型参数 `R extends HookHandlerReturn<E>`：TS 本来允许把「返回了东西的
 * 函数」赋给「返回 void 的函数类型」，光靠 `=> void` 拦不住 `on("permissionRequest", () => ({ decision: "block" }))`；
 * 抓成 R 之后，那个对象字面量不满足约束，调用当场不通过 tsc（`test/seams.test.ts` 有 @ts-expect-error 门）。
 */
export type HookHandlerReturn<E extends LifecycleEventType> = E extends InterceptableType
  ? HookResult<E> | void | Promise<HookResult<E> | void>
  : NotifyReturn;

export type HookHandler<E extends LifecycleEventType> = (
  event: LifecycleEventOf<E>,
  ctx: HookContext,
) => HookHandlerReturn<E>;

export type ExternalHookConfig = {
  event: LifecycleEventType;
  /** 命令行。stdin 收 {event, meta} JSON，stdout 回 HookResult JSON。 */
  command: string;
  args?: string[];
  timeoutMs?: number;
  priority?: number;
};

type Entry = {
  readonly id: string;
  readonly priority: number;
  readonly run: (event: LifecycleEvent, ctx: HookContext) => Promise<HookResult | void>;
};

export type ExternalRunner = (
  config: ExternalHookConfig,
  event: LifecycleEvent,
) => Promise<HookResult | void>;

export type HookRuntimeOptions = {
  timeoutMs?: number;
  /** 外部脚本的执行后端（进程 spawn 属宿主能力，注入进来——内核不自己 spawn）。 */
  externalRunner?: ExternalRunner;
  /** hook 抛错/超时的观测口（不是控制流）。 */
  onHookFailure?: (info: { hookId: string; event: LifecycleEventType; error: string; failClosed: boolean }) => void;
};

const DEFAULT_TIMEOUT_MS = 30_000;

/** fail-closed 的点：安全面——拦截器坏了不能放行。其余 fail-open：加工器坏了不能弄死主流程。 */
const FAIL_CLOSED: ReadonlySet<string> = new Set<string>(["preToolUse"]);

/**
 * 一轮里固定不变的 handler 工作集：与 `HookRuntime` 同一套 has / notify / intercept，
 * 只是条目在 `snapshot()` 那一刻冻结。`HookRuntime` 自己也实现它——
 * 直接拿活对象用就是「每次调用看最新」，循环内不许这么用。
 */
export interface HookWorkset {
  has(event: LifecycleEventType): boolean;
  /** 仅通知：跑完不看返回值；handler 抛错不影响任何人。 */
  notify(event: LifecycleEvent, ctx: HookContext): Promise<void>;
  /** 拦截：折叠规则见 `HookRuntime.intercept`。 */
  intercept<E extends InterceptableType>(event: LifecycleEventOf<E>, ctx: HookContext): Promise<Interception<E>>;
}

type EntriesByEvent = ReadonlyMap<LifecycleEventType, readonly Entry[]>;

export class HookRuntime implements HookWorkset {
  private readonly byEvent = new Map<LifecycleEventType, Entry[]>();
  /** 观察者不进 turn 工作集快照：它们不是 handler，晚订阅的宿主也该立刻看见 ask。 */
  private readonly observers = new Set<LifecycleEventListener>();
  private seq = 0;

  constructor(private readonly opts: HookRuntimeOptions = {}) {}

  /** 订阅全部 LifecycleEvent（notify 与 intercept 的入口都发）。返回退订。 */
  subscribe(listener: LifecycleEventListener): () => void {
    this.observers.add(listener);
    return () => {
      this.observers.delete(listener);
    };
  }

  hasSubscribers(): boolean {
    return this.observers.size > 0;
  }

  /**
   * 两组 overload，而不是一个 `E extends LifecycleEventType`：单个泛型对字面量事件名有效，但拿一个已经
   * 宽化成 `LifecycleEventType` 的变量来调，`HookHandlerReturn<E>` 分布之后包含 `HookResult`，
   * `() => ({ decision: "block" })` 又能通过了。分成两组后，宽联合两边都不匹配——调用方必须先显式收窄
   * 到可拦截或 notify-only 之一，「类型上不合法」这句公共承诺才完整成立。
   */
  on<E extends InterceptableType, R extends HookResult<E> | void | Promise<HookResult<E> | void>>(
    event: E,
    handler: (event: LifecycleEventOf<E>, ctx: HookContext) => R,
    opts?: { priority?: number; id?: string },
  ): () => void;
  on<E extends NotifyOnlyType, R extends NotifyReturn>(
    event: E,
    handler: (event: LifecycleEventOf<E>, ctx: HookContext) => R,
    opts?: { priority?: number; id?: string },
  ): () => void;
  on(
    event: LifecycleEventType,
    handler: (event: LifecycleEvent, ctx: HookContext) => unknown,
    opts?: { priority?: number; id?: string },
  ): () => void {
    const id = opts?.id ?? `${event}#${this.seq++}`;
    const entry: Entry = {
      id,
      priority: opts?.priority ?? 0,
      run: (e, ctx) => Promise.resolve(handler(e, ctx) as HookResult | void),
    };
    this.insert(event, entry);
    return () => this.remove(event, entry);
  }

  /**
   * 外部脚本走同一队列、同一折叠——只是 run 换成了子进程运输。
   * `config` 是调用方的对象，注册后它可以合法地被改：注册与卸载都只用这里拷下的快照，
   * 否则调用方改一下 `config.event`，卸载器就会去另一个事件的队列里找、什么都卸不掉（实测）。
   */
  addScript(config: ExternalHookConfig): () => void {
    const runner = this.opts.externalRunner;
    const event = config.event;
    const frozen: ExternalHookConfig = {
      ...config,
      ...(config.args !== undefined ? { args: [...config.args] } : {}),
    };
    const id = `script:${frozen.command}#${this.seq++}`;
    const entry: Entry = {
      id,
      priority: frozen.priority ?? 0,
      run: async (e) => {
        if (runner === undefined) {
          throw new Error(`外部脚本 hook 需要注入 externalRunner（宿主能力）：${frozen.command}`);
        }
        return runner(frozen, e);
      },
    };
    this.insert(event, entry);
    return () => this.remove(event, entry);
  }

  private insert(event: LifecycleEventType, entry: Entry): void {
    const list = this.byEvent.get(event) ?? [];
    // 稳定插入：同 priority 保持注册序（小者先跑）。
    let i = list.length;
    while (i > 0 && (list[i - 1] as Entry).priority > entry.priority) i--;
    list.splice(i, 0, entry);
    this.byEvent.set(event, list);
  }

  /**
   * 卸载**只认对象身份**：按 id 找会误删后来同 id 的那条——
   * `opts.id` 是调用方给的，两次注册同一个 id 完全合法，旧卸载器不该动新条目。
   */
  private remove(event: LifecycleEventType, entry: Entry): void {
    const list = this.byEvent.get(event);
    if (list === undefined) return;
    const i = list.indexOf(entry);
    if (i >= 0) list.splice(i, 1);
  }

  has(event: LifecycleEventType): boolean {
    return (this.byEvent.get(event)?.length ?? 0) > 0;
  }

  notify(event: LifecycleEvent, ctx: HookContext): Promise<void> {
    return runNotify(this.byEvent, event, ctx, this.opts, this.observers);
  }

  /**
   * 拦截：四条折叠规则
   *   ① block 短路（后面的不跑）
   *   ② patch 应用后**链式叠加**——后面的 handler 看到打过补丁的事件
   *   ③ 抛错/超时按失败档位：fail-closed 当 block，fail-open 当 continue
   *   ④ **patch 后的重新校验由调用方做**（工具参数要重跑 prepareArguments + 垫片）——
   *      runtime 不认识各事件的语义，校验归调用点。
   */
  intercept<E extends InterceptableType>(event: LifecycleEventOf<E>, ctx: HookContext): Promise<Interception<E>> {
    return runIntercept(this.byEvent, event, ctx, this.opts, this.observers);
  }

  /**
   * 冻结此刻的 handler 条目。循环在每轮开头取一次，整轮只用这份：
   * 本轮中途 `on()` 进来的下一轮才生效，中途卸掉的本轮仍跑完。
   * 条目对象本身不可变，所以只需拷数组。
   */
  snapshot(): HookWorkset {
    const frozen = new Map<LifecycleEventType, readonly Entry[]>();
    for (const [type, list] of this.byEvent) {
      if (list.length > 0) frozen.set(type, [...list]);
    }
    const opts = this.opts;
    const observers = this.observers; // 观察者用活集合：它们不是本轮工作集的一部分
    return {
      has: (event) => (frozen.get(event)?.length ?? 0) > 0,
      notify: (event, ctx) => runNotify(frozen, event, ctx, opts, observers),
      intercept: (event, ctx) => runIntercept(frozen, event, ctx, opts, observers),
    };
  }
}

/* ───────────────── 折叠器本体（活对象与快照共用同一份） ───────────────── */

/**
 * 观察者投递：同步逐个调用、不 await、抛错吞掉（记到 onHookFailure 观测口，failClosed 恒 false）。
 * 它在 handler 之前、按发生顺序拿到**原始事件**——observer 不参与折叠，看不到也改不了 patch。
 */
function observe(observers: ReadonlySet<LifecycleEventListener>, event: LifecycleEvent, opts: HookRuntimeOptions): void {
  for (const listener of observers) {
    try {
      const r = listener(event);
      if (r !== undefined && typeof (r as Promise<void>).catch === "function") {
        (r as Promise<void>).catch((e: unknown) => {
          opts.onHookFailure?.({ hookId: "lifecycle-subscriber", event: event.type, error: errText(e), failClosed: false });
        });
      }
    } catch (e) {
      opts.onHookFailure?.({ hookId: "lifecycle-subscriber", event: event.type, error: errText(e), failClosed: false });
    }
  }
}

async function runNotify(
  entries: EntriesByEvent,
  event: LifecycleEvent,
  ctx: HookContext,
  opts: HookRuntimeOptions,
  observers: ReadonlySet<LifecycleEventListener>,
): Promise<void> {
  observe(observers, event, opts);
  const list = entries.get(event.type);
  if (list === undefined || list.length === 0) return;
  for (const entry of list) {
    try {
      await withTimeout(entry.run(event, { ...ctx, hookId: entry.id }), opts);
    } catch (e) {
      opts.onHookFailure?.({
        hookId: entry.id,
        event: event.type,
        error: errText(e),
        failClosed: false,
      });
    }
  }
}

async function runIntercept<E extends InterceptableType>(
  entries: EntriesByEvent,
  event: LifecycleEventOf<E>,
  ctx: HookContext,
  opts: HookRuntimeOptions,
  observers: ReadonlySet<LifecycleEventListener>,
): Promise<Interception<E>> {
  observe(observers, event as LifecycleEvent, opts);
  let current = event;
  const eventType = (event as LifecycleEvent).type;
  const list = entries.get(eventType);
  if (list === undefined || list.length === 0) {
    return { decision: "continue", event: current };
  }

  for (const entry of list) {
    let result: HookResult | void;
    try {
      result = await withTimeout(entry.run(current as LifecycleEvent, { ...ctx, hookId: entry.id }), opts);
    } catch (e) {
      const failClosed = FAIL_CLOSED.has(eventType);
      opts.onHookFailure?.({
        hookId: entry.id,
        event: eventType,
        error: errText(e),
        failClosed,
      });
      if (failClosed) {
        // 模型可见的理由是固定短句：entry id、脚本路径、异常原文只走上面的 onHookFailure（review 2026-09-07）
        return {
          decision: "block",
          reason: "Blocked: a fail-closed hook failed to run",
          event: current,
        };
      }
      continue; // fail-open：当它没说话
    }

    if (result === undefined || result === null) continue;
    if (result.patch !== undefined) {
      current = { ...current, ...(result.patch as object) } as LifecycleEventOf<E>;
    }
    if (result.decision === "block") {
      return { decision: "block", reason: result.reason, event: current };
    }
  }

  return { decision: "continue", event: current };
}

function withTimeout<T>(p: Promise<T>, opts: HookRuntimeOptions): Promise<T> {
  const ms = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`hook 超时（${ms}ms）`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
