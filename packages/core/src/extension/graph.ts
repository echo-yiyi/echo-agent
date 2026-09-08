// 依赖图：inject / provide 在 mount 前成图。
//
//   provider ACTIVE 后 consumer 才能 LOADING；consumer 先 UNLOAD，provider 后 UNLOAD
//   required 缺失 → 启动失败（不 PENDING 假装成功）；cycle → 报完整路径
//   依赖只能从 agent 指向 process：process-scope Extension 不能 inject agent-scope Service
//   provider 的 reload boundary 不得弱于 Service 的：一个 turn 就换代的 provider 提供不了「run 内稳定」的 Service

import { ExtensionAbiError, RELOAD_BOUNDARY_RANK, type ServiceKey } from "./abi.ts";
import type { Fiber, FiberEdge } from "./fiber.ts";
import type { ServiceKeyTable } from "./service-key.ts";

export type GraphInput = Readonly<{
  fibers: readonly Fiber[];
  keys: ServiceKeyTable;
  /** Host 自带的 Service（registry 等）。 */
  hostServices: ReadonlySet<ServiceKey<unknown>>;
  /** 别的 generation 里仍 ACTIVE 的 provider（两代 overlap 时 consumer 可以绑到旧代）。 */
  activeProviders: ReadonlyMap<ServiceKey<unknown>, Fiber>;
}>;

/** 解析依赖边、验规则、给出拓扑序（只按本 mount 集合内的边排）。 */
export function resolveGraph(input: GraphInput): readonly Fiber[] {
  const { fibers, keys, hostServices, activeProviders } = input;

  /* provide 侧：本集合内谁提供什么；任何 Service 只一个 provider；scope / boundary 规则 */
  const providers = new Map<ServiceKey<unknown>, Fiber>();
  for (const f of fibers) {
    for (const key of f.declaredProvides) {
      if (hostServices.has(key)) throw new ExtensionAbiError(`Extension ${f.label} 不能 provide Host 自带的 Service '${key.id}'`);
      if (key.scope === "process" && f.scope === "agent") {
        throw new ExtensionAbiError(`agent-scope Extension ${f.label} 不能 provide process-scope Service '${key.id}'——长寿命对象不能反向持有某一代 Agent`);
      }
      if (RELOAD_BOUNDARY_RANK[f.reload] < RELOAD_BOUNDARY_RANK[key.reload]) {
        throw new ExtensionAbiError(
          `Extension ${f.label}（reload '${f.reload}'）不能 provide reload '${key.reload}' 的 Service '${key.id}'：provider 的 boundary 必须不弱于 Service`,
        );
      }
      const other = providers.get(key);
      if (other !== undefined) {
        // 任何 ServiceKey 都只有一个 provider：registry 的「多」发生在 registry **内容**的登记（多个 Extension 往里注册条目），
        // 不是 provider 数量。两个 registry provider 静默取后者 = 前者的消费者绑到了一个不存在的 registry（实测）。
        throw new ExtensionAbiError(
          `Service '${key.id}' 在同一 generation 里有两个 provider：${other.label}、${f.label}` +
            (key.kind === "registry" ? "（registry 也只能有一个 owner；「多」是往里登记条目，不是多个 provider）" : ""),
        );
      }
      // **跨代同样只有一个 provider**（review 2026-09-07）：此前这条只在同一代内成立，盘上任一扩展在下一代 provide
      // 同一个 key 就静默成了第二个 provider——`AgentRuntimeService` 被劫持，壳绑到假 runtime 上。
      // 同一 entryId 的两代 overlap 是 reload 的合法形状（新代顶替旧代），不在此列。
      const active = activeProviders.get(key);
      if (active !== undefined && active.entryId !== f.entryId) {
        throw new ExtensionAbiError(`Service '${key.id}' 已由仍 ACTIVE 的 ${active.label} provide，${f.label} 不能再 provide 它：跨代也只有一个 provider`);
      }
      providers.set(key, f);
    }
  }

  /* inject 侧：每条边找 provider（本集合 → Host → 别的 generation 里 ACTIVE 的） */
  for (const f of fibers) {
    const edges: FiberEdge[] = [];
    for (const [name, spec] of Object.entries(f.definition.inject ?? {})) {
      const key = keys.canonical(spec.service);
      const required = spec.required === true;
      if (f.declaredProvides.has(key)) throw new ExtensionAbiError(`Extension ${f.label} 同时 inject 与 provide '${key.id}'`);
      if (f.scope === "process" && key.scope === "agent") {
        throw new ExtensionAbiError(`process-scope Extension ${f.label} 不能 inject agent-scope Service '${key.id}'（依赖只能从 agent 指向 process）`);
      }
      let provider: Fiber | "host" | null = null;
      if (providers.has(key)) provider = providers.get(key)!;
      else if (hostServices.has(key)) provider = "host";
      else if (activeProviders.has(key)) provider = activeProviders.get(key)!;
      if (provider === null && required) {
        throw new ExtensionAbiError(`Extension ${f.label} 的 required 依赖 '${key.id}'（inject.${name}）没有 provider`);
      }
      edges.push({ name, service: key, required, provider });
    }
    f.dependencies = edges;
  }

  /* cycle：DFS 报完整路径 */
  const inSet = new Set(fibers);
  const state = new Map<Fiber, "visiting" | "done">();
  const stack: Fiber[] = [];
  const visit = (f: Fiber): void => {
    const s = state.get(f);
    if (s === "done") return;
    if (s === "visiting") {
      const start = stack.indexOf(f);
      const path = [...stack.slice(start), f].map((x) => x.entryId).join(" → ");
      throw new ExtensionAbiError(`Extension 依赖成环：${path}`);
    }
    state.set(f, "visiting");
    stack.push(f);
    for (const e of f.dependencies) {
      if (e.provider !== null && e.provider !== "host" && inSet.has(e.provider)) visit(e.provider);
    }
    stack.pop();
    state.set(f, "done");
  };
  for (const f of fibers) visit(f);

  /* 拓扑序（Kahn；同层按声明顺序，稳定） */
  const indeg = new Map<Fiber, number>();
  const consumersOf = new Map<Fiber, Fiber[]>();
  for (const f of fibers) indeg.set(f, 0);
  for (const f of fibers) {
    for (const e of f.dependencies) {
      if (e.provider === null || e.provider === "host" || !inSet.has(e.provider)) continue;
      indeg.set(f, indeg.get(f)! + 1);
      const list = consumersOf.get(e.provider) ?? [];
      list.push(f);
      consumersOf.set(e.provider, list);
    }
  }
  const order: Fiber[] = [];
  const ready = fibers.filter((f) => indeg.get(f) === 0);
  while (ready.length > 0) {
    const f = ready.shift()!;
    order.push(f);
    for (const c of consumersOf.get(f) ?? []) {
      const n = indeg.get(c)! - 1;
      indeg.set(c, n);
      if (n === 0) ready.push(c);
    }
  }
  if (order.length !== fibers.length) throw new ExtensionAbiError("Extension 依赖图拓扑失败（成环检测漏网）——判红不猜");
  return order;
}
