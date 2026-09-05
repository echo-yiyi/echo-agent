// Extension Host ABI：Extension 模块看到的全部类型，
// 加两个构造器 `defineService()` / `defineExtension()`。
//
// 这里只有**声明**：模块求值阶段必须 declaration-only，长期副作用只能在 `apply()` 里经 `ctx.effect()` 建立
// ——那样 Host 才拿得到 disposer，热重载才有东西可卸。

/** turn < run < agent < process：越靠右越「强」——需要越大的安全点才能换代。 */
export type ReloadBoundary = "turn" | "run" | "agent" | "process";
export type ExtensionScope = "process" | "agent";
export type Disposer = () => void | Promise<void>;
export type EffectLease<T> = { value: T; dispose: Disposer };
export type ServiceKind = "single" | "registry";

export const RELOAD_BOUNDARY_RANK: Readonly<Record<ReloadBoundary, number>> = Object.freeze({
  turn: 0,
  run: 1,
  agent: 2,
  process: 3,
});

/**
 * Service 的身份。**不是字符串**：Host 按 `id + version` canonicalize，
 * 相同 id 的不兼容 version 或不同 kind/scope/reload 在 PREPARE fail-loud。
 *   - single：恰好一个 provider；重复 provide fail-loud；
 *   - registry：由 owner 提供稳定 registry，多个 Extension 往里注册条目（Tool / Hook / Skill…）。
 */
export type ServiceKey<T> = Readonly<{
  id: string;
  version: number;
  kind: ServiceKind;
  scope: ExtensionScope;
  reload: ReloadBoundary;
}> & { readonly __type?: T };

/** `inject` 声明：名字 → Service。`ctx.get()` 只能读这里声明过的。 */
export type InjectDeclaration = Readonly<Record<string, Readonly<{ service: ServiceKey<unknown>; required?: boolean }>>>;

export interface ExtensionContext {
  readonly entryId: string;
  readonly generation: string;
  /** Fiber 进入 UNLOADING 即 abort；Effect 的 start 应当尊重它。 */
  readonly signal: AbortSignal;

  /** 只能读 `inject` 已声明的 Service；required 的一定可得，optional 的当前无 provider 时抛。 */
  get<T>(service: ServiceKey<T>): T;
  /** 只能发布 `provide` 已声明的 Service；single 重复 provide 抛。由当前 Fiber 自动拥有。 */
  provide<T>(service: ServiceKey<T>, value: T): void;
  /**
   * 登记一个有 disposer 的长期副作用。`boundary` 缺省 `agent`（保守），且不得强于 Extension 自己声明的
   * `reload`。返回 lease 的 `value`。
   * 状态 / 声明类错误（Fiber 已 UNLOADING → `ExtensionDisposedError`；boundary 非法或强于声明）**同步抛**；
   * `start` 自己的失败以 rejection 返回——`void ctx.effect()` 是合法用法，Host 会在 apply 返回后 settle 这些 start，
   * 任一失败按 mount failure 回滚，且不会变成 unhandled rejection。
   */
  effect<T>(spec: {
    boundary?: ReloadBoundary;
    start(signal: AbortSignal): EffectLease<T> | Promise<EffectLease<T>>;
  }): Promise<T>;
}

export interface ExtensionDefinition<TConfig> {
  readonly name: string;
  readonly hostAbiVersion: 1;
  /** 缺省 agent。 */
  readonly scope?: ExtensionScope;
  /** 缺省 agent（保守）。mount 中登记了比它强的 Effect → Host 拒绝该 generation。 */
  readonly reload?: ReloadBoundary;
  readonly inject?: InjectDeclaration;
  readonly provide?: readonly ServiceKey<unknown>[];
  config?(input: unknown): TConfig;
  apply(ctx: ExtensionContext, config: TConfig): void | Promise<void>;
}

/** 声明 / 形状 / 依赖图层面的错误：PREPARE 阶段 fail-loud。 */
export class ExtensionAbiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExtensionAbiError";
  }
}

/** Fiber 已进入 UNLOADING 之后，旧回调再调 `ctx.get/provide/effect`。 */
export class ExtensionDisposedError extends Error {
  constructor(
    readonly entryId: string,
    readonly generation: string,
    what: string,
  ) {
    super(`Extension '${entryId}'@${generation} 已卸载，不能再 ${what}`);
    this.name = "ExtensionDisposedError";
  }
}

const SCOPES: ReadonlySet<string> = new Set(["process", "agent"]);
const KINDS: ReadonlySet<string> = new Set(["single", "registry"]);

export function isReloadBoundary(v: unknown): v is ReloadBoundary {
  return typeof v === "string" && v in RELOAD_BOUNDARY_RANK;
}

/** 造一个 ServiceKey。形状在这里验；同 id 的兼容性由 Host 在 PREPARE 判（见 service-key.ts）。 */
export function defineService<T>(spec: {
  id: string;
  version: number;
  kind: ServiceKind;
  scope: ExtensionScope;
  reload: ReloadBoundary;
}): ServiceKey<T> {
  if (typeof spec.id !== "string" || spec.id.trim() === "") throw new ExtensionAbiError("ServiceKey.id 必须是非空字符串");
  if (!Number.isInteger(spec.version) || spec.version < 1) {
    throw new ExtensionAbiError(`ServiceKey '${spec.id}' 的 version 必须是正整数，收到 ${String(spec.version)}`);
  }
  if (!KINDS.has(spec.kind)) throw new ExtensionAbiError(`ServiceKey '${spec.id}' 的 kind 必须是 single | registry，收到 ${String(spec.kind)}`);
  if (!SCOPES.has(spec.scope)) throw new ExtensionAbiError(`ServiceKey '${spec.id}' 的 scope 必须是 process | agent，收到 ${String(spec.scope)}`);
  if (!isReloadBoundary(spec.reload)) {
    throw new ExtensionAbiError(`ServiceKey '${spec.id}' 的 reload 必须是 turn | run | agent | process，收到 ${String(spec.reload)}`);
  }
  return Object.freeze({ id: spec.id, version: spec.version, kind: spec.kind, scope: spec.scope, reload: spec.reload });
}

/** 造一个 Extension 定义。只验形状；依赖图、scope 方向、boundary 关系由 Host 在 PREPARE 判。 */
export function defineExtension<TConfig = void>(def: ExtensionDefinition<TConfig>): ExtensionDefinition<TConfig> {
  if (typeof def.name !== "string" || def.name.trim() === "") throw new ExtensionAbiError("Extension.name 必须是非空字符串");
  if (def.hostAbiVersion !== 1) {
    throw new ExtensionAbiError(`Extension '${def.name}' 的 hostAbiVersion 必须是 1，收到 ${String(def.hostAbiVersion)}——不兼容 ABI 不 mount`);
  }
  if (def.scope !== undefined && !SCOPES.has(def.scope)) {
    throw new ExtensionAbiError(`Extension '${def.name}' 的 scope 必须是 process | agent，收到 ${String(def.scope)}`);
  }
  if (def.reload !== undefined && !isReloadBoundary(def.reload)) {
    throw new ExtensionAbiError(`Extension '${def.name}' 的 reload 必须是 turn | run | agent | process，收到 ${String(def.reload)}`);
  }
  if (typeof def.apply !== "function") throw new ExtensionAbiError(`Extension '${def.name}' 必须有 apply()`);
  if (def.config !== undefined && typeof def.config !== "function") throw new ExtensionAbiError(`Extension '${def.name}' 的 config 必须是函数`);
  if (def.inject !== undefined) {
    for (const [name, spec] of Object.entries(def.inject)) {
      if (typeof spec !== "object" || spec === null || typeof (spec as { service?: unknown }).service !== "object") {
        throw new ExtensionAbiError(`Extension '${def.name}' 的 inject.${name} 必须是 { service, required? }`);
      }
    }
  }
  if (def.provide !== undefined && !Array.isArray(def.provide)) {
    throw new ExtensionAbiError(`Extension '${def.name}' 的 provide 必须是 ServiceKey 数组`);
  }
  return Object.freeze({ ...def, inject: def.inject === undefined ? undefined : Object.freeze({ ...def.inject }), provide: def.provide === undefined ? undefined : Object.freeze([...def.provide]) });
}
