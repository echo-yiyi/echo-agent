// 扩展可声明的 agent 级选项（2026-09-09 用户拍板）：权限策略、执行预算、提问策略。
//
// **为什么要有这个口。** 在它之前这三样只有**产品**能给（`AgentOptions`），扩展的 registry 里没有对应的格：
// 工具、prompt 段、hooks、skills、压缩阶段、记忆模块都能注册，唯独这三样不行。于是「把工具与角色文件放进
// `<cwd>/extensions/`，echo-agent 就长成另一个 agent」这条路永远差一截——本地扩展能加工具、能换身份段，
// 却改不了执行预算与权限，在仓库里 grep、read 几下就撞上 core 缺省的 20。
// 记录：`docs/decisions/proposed/2026-09-09-assembly-layer-packages.md`。
//
// **值不在构造期冻死**：Agent 每次用时现读这里的当前值。产品经 `AgentOptions` 给初值，扩展经
// `AgentPolicies` registry 覆盖，卸载时回到初值——与别的 registry 一样，注册返回 disposer、由 Fiber 持有。
//
// **一项只能有一个声明者**，撞了 fail-loud：与工具撞名整组失败、prompt 段同名判红是同一个姿态。
// 静默让后来者赢，等于让「装了两个扩展之后预算是多少」变成 mount 顺序的函数。
//
// **不做「只能收紧」**：扩展本来就能注册任意工具，权限收不收紧拦不住一个有恶意的扩展；
// 在这里立一道只挡君子的门，只会让「本地扩展 = 另一个产品」这条路少一截而已（同 `gates-dont-overbuild`）。

import type { Disposer } from "./extension/abi.ts";
import type { PermissionPolicy } from "./permission/types.ts";
import type { QuestionPolicy } from "./question/types.ts";

/** 三项的当前值。Agent 用时现读，不缓存。 */
export type AgentPolicyValues = Readonly<{
  permission: PermissionPolicy;
  /** 一次 reply 的迭代预算（`DEFAULT_MAX_ITERATIONS` 是缺省）。 */
  maxIterations: number;
  questions: QuestionPolicy;
}>;

/** 一次声明能带的东西：只给要改的那几项。 */
export type DeclaredPolicies = Readonly<Partial<AgentPolicyValues>>;

/** 验形交给已有的那两个函数（住在 `agent.ts`，与构造期同一套判据），这里只负责「谁声明了什么」。 */
export type PolicyValidators = Readonly<{
  permission: (p: PermissionPolicy) => PermissionPolicy;
  questions: (q: QuestionPolicy) => QuestionPolicy;
}>;

const KEYS = ["permission", "maxIterations", "questions"] as const;

/**
 * 三项的持有者：初值来自产品，声明来自扩展。`AgentPolicies` registry 就是它的一层皮。
 */
export class AgentPolicySlots {
  private readonly initial: AgentPolicyValues;
  private current: AgentPolicyValues;
  /** 已经被扩展声明过的项。**不记是谁**——报错只说是哪一项，registry 这一层认不出 entryId。 */
  private readonly claimed = new Set<keyof AgentPolicyValues>();

  constructor(
    initial: AgentPolicyValues,
    private readonly validators: PolicyValidators,
  ) {
    this.initial = initial;
    this.current = initial;
  }

  get values(): AgentPolicyValues {
    return this.current;
  }

  /**
   * 声明一项或几项。**整组原子**：中途撞了，已经生效的那几项回滚再抛——与 `defineToolPack`
   * 「注册中途撞名要把已注册的撤回去」同一条纪律，半组生效比整组不生效更难排查。
   */
  declare(values: DeclaredPolicies): Disposer {
    const applied: (keyof AgentPolicyValues)[] = [];
    const rollback = (): void => {
      for (const k of applied) this.claimed.delete(k);
      this.current = { ...this.current, ...pick(this.initial, applied) };
    };
    for (const key of KEYS) {
      const raw = values[key];
      if (raw === undefined) continue;
      if (this.claimed.has(key)) {
        rollback();
        throw new Error(`agent 选项 '${key}' 已经被别的 extension 声明过：一项只能有一个声明者`);
      }
      let value: AgentPolicyValues[typeof key];
      try {
        value = this.validate(key, raw);
      } catch (e) {
        rollback();
        throw e;
      }
      this.claimed.add(key);
      this.current = { ...this.current, [key]: value };
      applied.push(key);
    }
    let disposed = false;
    return () => {
      if (disposed) return; // 幂等：Fiber 与调用方都可能撤
      disposed = true;
      rollback();
    };
  }

  private validate<K extends keyof AgentPolicyValues>(key: K, raw: AgentPolicyValues[K]): AgentPolicyValues[K] {
    if (key === "permission") return this.validators.permission(raw as PermissionPolicy) as AgentPolicyValues[K];
    if (key === "questions") return this.validators.questions(raw as QuestionPolicy) as AgentPolicyValues[K];
    const n = raw as number;
    if (!Number.isInteger(n) || n <= 0) throw new Error(`agent 选项 'maxIterations' 必须是正整数，收到 ${String(raw)}`);
    return n as AgentPolicyValues[K];
  }
}

function pick(from: AgentPolicyValues, keys: readonly (keyof AgentPolicyValues)[]): DeclaredPolicies {
  const out: Record<string, unknown> = {};
  for (const k of keys) out[k] = from[k];
  return out as DeclaredPolicies;
}
