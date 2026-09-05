// ServiceKey canonicalization：同一个 Host 内，相同 id 无论由宿主还是 Extension import，
// 都归到**同一个对象引用**；相同 id 但 version / kind / scope / reload 任一不同 → PREPARE fail-loud，
// 不能因为字符串相同就当作兼容。
//
// 表是**分层**的：Host 持一张已提交的表，每次 mount 在它上面 fork 一张 staged 表——PREPARE / LOADING 期间
// 新见到的 id 只记在 staged 层，整代 ACTIVE 后才 commit 进父表；任何失败直接丢弃 staged 层。
// 否则一个失败的 v1 candidate 会永久占住 id，随后合法的 v2 mount 被报「声明冲突」（实测）——那违反「Host 状态零变化」。

import { ExtensionAbiError, type ServiceKey } from "./abi.ts";

export class ServiceKeyTable {
  private readonly byId = new Map<string, ServiceKey<unknown>>();

  constructor(private readonly parent?: ServiceKeyTable) {}

  /** 返回该 id 的规范引用；第一次见到的那份成为规范（记在本层）。 */
  canonical<T>(key: ServiceKey<T>): ServiceKey<T> {
    const existing = this.lookup(key.id);
    if (existing === undefined) {
      this.byId.set(key.id, key);
      return key;
    }
    if (existing === key) return key;
    if (existing.version !== key.version || existing.kind !== key.kind || existing.scope !== key.scope || existing.reload !== key.reload) {
      throw new ExtensionAbiError(
        `ServiceKey '${key.id}' 声明冲突：已知 v${existing.version}/${existing.kind}/${existing.scope}/${existing.reload}，` +
          `又见 v${key.version}/${key.kind}/${key.scope}/${key.reload}——相同 id 的不兼容声明不能当作同一个 Service`,
      );
    }
    return existing as ServiceKey<T>;
  }

  /** 开一张 staged 表：查询先看本层、再看父层；新条目只落本层。 */
  fork(): ServiceKeyTable {
    return new ServiceKeyTable(this);
  }

  /** 整代 ACTIVE 后把本层条目并进父表（mount 串行，父表在这期间没人改）。没有父表 = no-op。 */
  commit(): void {
    if (this.parent === undefined) return;
    for (const key of this.byId.values()) this.parent.canonical(key);
    this.byId.clear(); // 之后的查询穿透到父表，拿到的仍是同一个引用
  }

  private lookup(id: string): ServiceKey<unknown> | undefined {
    return this.byId.get(id) ?? this.parent?.lookup(id);
  }
}
