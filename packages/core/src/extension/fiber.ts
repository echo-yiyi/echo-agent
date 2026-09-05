// Fiber：一个 Entry generation 的运行实例——状态机 + 它拥有的 Effect + 它给 Extension 的 Context。
//
//   DISCOVERED → PENDING → LOADING → ACTIVE → UNLOADING → DISPOSED
//                                      └ failure → FAILED（unwind owned effects）→ DISPOSED
//
// Context 的三个方法都先过两道门：① Fiber 还活着（UNLOADING 之后抛 ExtensionDisposedError）；
// ② 在 definition 里声明过（get 只读 inject 的、provide 只发 provide 的）——否则依赖图看到的是假图。

import {
  ExtensionAbiError,
  ExtensionDisposedError,
  RELOAD_BOUNDARY_RANK,
  type EffectLease,
  type ExtensionContext,
  type ExtensionDefinition,
  type ExtensionScope,
  type ReloadBoundary,
  type ServiceKey,
} from "./abi.ts";
import { EffectStack } from "./effects.ts";
import type { ServiceKeyTable } from "./service-key.ts";

export type FiberStatus = "discovered" | "pending" | "loading" | "active" | "failed" | "unloading" | "disposed";

/** 一条依赖边。provider 为 "host" = Host 自带的 Service（registry 等）；null = optional 且当前无 provider。 */
export type FiberEdge = Readonly<{
  name: string;
  service: ServiceKey<unknown>;
  required: boolean;
  provider: Fiber | "host" | null;
}>;

/** Fiber 解析依赖时向 Host 要的东西。 */
export type FiberHostAccess = Readonly<{
  keys: ServiceKeyTable;
  hostService(service: ServiceKey<unknown>): unknown;
}>;

export class Fiber {
  readonly scope: ExtensionScope;
  readonly reload: ReloadBoundary;
  /** PREPARE 时由 graph 填；canonical key。 */
  dependencies: readonly FiberEdge[] = [];
  /** canonical key → 本 Fiber 声明要 provide 的。 */
  readonly declaredProvides: ReadonlySet<ServiceKey<unknown>>;
  /** canonical key → 已 provide 的值。 */
  readonly provided = new Map<ServiceKey<unknown>, unknown>();
  readonly effects = new EffectStack();
  readonly abortController = new AbortController();
  status: FiberStatus = "discovered";
  private contextLive = false;

  constructor(
    readonly entryId: string,
    readonly generation: string,
    readonly definition: ExtensionDefinition<unknown>,
    readonly config: unknown,
    keys: ServiceKeyTable,
  ) {
    this.scope = definition.scope ?? "agent";
    this.reload = definition.reload ?? "agent";
    this.declaredProvides = new Set((definition.provide ?? []).map((k) => keys.canonical(k)));
  }

  get label(): string {
    return `'${this.entryId}'@${this.generation}`;
  }

  /** LOADING 时造；UNLOADING 一开始就失效。 */
  createContext(host: FiberHostAccess): ExtensionContext {
    this.contextLive = true;
    const fiber = this;
    const assertLive = (what: string): void => {
      if (!fiber.contextLive) throw new ExtensionDisposedError(fiber.entryId, fiber.generation, what);
    };
    return {
      entryId: this.entryId,
      generation: this.generation,
      signal: this.abortController.signal,

      get<T>(service: ServiceKey<T>): T {
        assertLive(`get('${service.id}')`);
        const key = host.keys.canonical(service);
        const edge = fiber.dependencies.find((d) => d.service === key);
        if (edge === undefined) {
          throw new ExtensionAbiError(`Extension ${fiber.label} 读取了未在 inject 声明的 Service '${key.id}'——依赖图看不见这条边`);
        }
        if (edge.provider === null) {
          throw new ExtensionAbiError(`Extension ${fiber.label} 的 optional 依赖 '${key.id}' 当前没有 provider`);
        }
        if (edge.provider === "host") return host.hostService(key) as T;
        if (!edge.provider.provided.has(key)) {
          // provider ACTIVE 后 consumer 才 LOADING，且 provider 的 apply 返回时已验过「声明的都 provide 了」；到这里只剩 provider 已卸
          throw new ExtensionAbiError(`Service '${key.id}' 的 provider ${edge.provider.label} 已不再提供它`);
        }
        return edge.provider.provided.get(key) as T;
      },

      provide<T>(service: ServiceKey<T>, value: T): void {
        assertLive(`provide('${service.id}')`);
        const key = host.keys.canonical(service);
        if (!fiber.declaredProvides.has(key)) {
          throw new ExtensionAbiError(`Extension ${fiber.label} 发布了未在 provide 声明的 Service '${key.id}'`);
        }
        if (fiber.provided.has(key)) throw new ExtensionAbiError(`Extension ${fiber.label} 重复 provide '${key.id}'（single Service 恰好一个 provider）`);
        fiber.provided.set(key, value);
      },

      effect<T>(spec: { boundary?: ReloadBoundary; start(signal: AbortSignal): EffectLease<T> | Promise<EffectLease<T>> }): Promise<T> {
        assertLive("effect()");
        if (!fiber.effects.open) throw new ExtensionDisposedError(fiber.entryId, fiber.generation, "effect()");
        const boundary = spec.boundary ?? "agent";
        if (!(boundary in RELOAD_BOUNDARY_RANK)) {
          throw new ExtensionAbiError(`Extension ${fiber.label} 的 Effect boundary 必须是 turn | run | agent | process，收到 ${String(boundary)}`);
        }
        if (RELOAD_BOUNDARY_RANK[boundary] > RELOAD_BOUNDARY_RANK[fiber.reload]) {
          // 作者用错误声明绕过 safe boundary：拒绝，不自动升级
          throw new ExtensionAbiError(
            `Extension ${fiber.label} 声明 reload '${fiber.reload}'，却登记了 boundary '${boundary}' 的 Effect——实际比声明强，Host 不自动升级`,
          );
        }
        const label = `${fiber.label} effect#${fiber.effects.size + fiber.effects.pending + 1}(${boundary})`;
        // start 与入栈是同一条被 track 的链：闸关之后才完成的 start，它的 lease 也入栈、随后被 unwind 卸掉
        const started = fiber.effects.track(
          Promise.resolve()
            .then(() => spec.start(fiber.abortController.signal))
            .then((lease) => {
              if (typeof lease?.dispose !== "function") {
                throw new ExtensionAbiError(`${label} 的 start 没有返回带 dispose 的 EffectLease`);
              }
              fiber.effects.push(boundary, lease as EffectLease<unknown>, label);
              return lease;
            }),
        );
        const result = started.then((lease) => lease.value);
        // 调用方 `void ctx.effect()` 是合法用法：这条 rejection 不能成 unhandled rejection（Node 下会终结进程）。
        // 失败仍由 Host 在 settlePendingStarts 里当 mount failure 处理；await 它的调用方也照样看到 reject。
        result.catch(() => {});
        return result;
      },
    };
  }

  /** UNLOADING 的第一步：Context 失效、登记闸关、abort。 */
  beginUnload(): void {
    this.status = this.status === "failed" ? "failed" : "unloading";
    this.contextLive = false;
    this.effects.closeGate();
    this.abortController.abort();
  }
}
