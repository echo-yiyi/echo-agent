// 状态根的写入资格。**Host-internal**：这些形状都不进公共面，
// Extension 拿不到 token，lane 也不通过 AsyncLocal / 可选参数 / 领域 message 透传。
//
// 三个东西：
//   - `LeaseIdentityCell`：本代 Agent 的写入身份格，`empty → installed → revoked` 三态，**revoked 是永久的**；
//   - `StateWriteGate`：状态根这一级的总闸——根开关、五条 enforced lane、`activeBusinessMode` 三态；
//   - `CapabilityWriteAuthority` + `adoptStorageView()`：每个能力拿到的仍是原样的 `StorageDir`，
//     只是每个 mutating method 在真 I/O 紧邻边界先 `assertWriteAllowed()`。
//
// **它能判什么、不能判什么**：能拒空 / revoked cell、错 Lease 身份、关着的根闸、
// 未开放的 lane、关着的 active business 通道；**不能**分辨同一个 Memory view 是前台还是 Dream 在调——
// 那条互斥来自 admission 的单 permit 与 `abort → wait settled` 顺序，不是 I/O 层的 origin check。

import type { StorageDir } from "../storage/types.ts";

// 曾经还有一条 `canonical-observation`，但从没有人申请过它：观测库不经这道闸（它有自己的 SQLite 连接，
// 封口走 `lease-lifecycle.ts`）。一条没人走的 lane 只会让文档以为观测也在闸内（review 2026-09-07），删了。
export type EnforcedWriteLane = "restore-migration" | "durable-ingress" | "managed-activation" | "lifecycle-finalization";

export type ActiveBusinessWriteMode = "closed" | "open" | "draining";

declare const leaseIdentityBrand: unique symbol;

/** 进程内的写入身份。**不假装等于 StateLock 文件里的 token**——它只用来判「还是不是这一代」。 */
export type LeaseIdentity = Readonly<{
  readonly [leaseIdentityBrand]: never;
  agentInstanceId: string;
  acquisitionId: string;
}>;

export type LeaseIdentityCell = Readonly<{
  state(): "empty" | "installed" | "revoked";
  current(): LeaseIdentity | null;
  install(identity: LeaseIdentity): void;
  revoke(): void;
}>;

declare const capabilityWriteAuthorityBrand: unique symbol;

export type CapabilityWriteAuthority = Readonly<{
  readonly [capabilityWriteAuthorityBrand]: never;
  capabilityId: string;
  leaseCell: LeaseIdentityCell;
  allowedLanes: ReadonlySet<EnforcedWriteLane>;
  /** 这个能力有没有资格走 active business path。**不是它能自己切换的 lane**，也不进领域方法参数。 */
  allowsActiveBusinessWrites: boolean;
  assertWriteAllowed(): void;
}>;

/** 写被拒。理由说清是哪一条闸——「写不进去」和「为什么写不进去」是两件事。 */
export class StateWriteDenied extends Error {
  constructor(
    readonly capabilityId: string,
    readonly reason: string,
  ) {
    super(`能力 '${capabilityId}' 现在不许写状态根：${reason}`);
    this.name = "StateWriteDenied";
  }
}

export type StateWriteGate = Readonly<{
  readonly cell: LeaseIdentityCell;
  /** acquire 成功后**原子安装**到 cell 与根闸；同一格只能装一次，revoked 之后永远装不回去。 */
  install(input: { agentInstanceId: string; acquisitionId: string }): LeaseIdentity;
  /**
   * 永久收摊：revoke cell + 关根闸 + 关全部 lane。**这之后任何经闸的状态根写入都被拒**
   * （读与 list 不经闸；观测库不在闸内，由 `lease-lifecycle.ts` 那条 port 封口）。
   */
  revoke(): void;
  isOpen(): boolean;
  /** 打开一条 lane，返回关它的函数（重复关是 no-op）。 */
  openLane(lane: EnforcedWriteLane): () => void;
  closeLane(lane: EnforcedWriteLane): void;
  laneOpen(lane: EnforcedWriteLane): boolean;
  activeBusinessMode(): ActiveBusinessWriteMode;
  setActiveBusinessMode(mode: ActiveBusinessWriteMode): void;
  /** 给一个能力发不可伪造的写入资格。**只有 composition root 能调**。 */
  authorityFor(
    capabilityId: string,
    spec: { lanes?: readonly EnforcedWriteLane[]; activeBusiness?: boolean },
  ): CapabilityWriteAuthority;
}>;

export function createStateWriteGate(): StateWriteGate {
  let cellState: "empty" | "installed" | "revoked" = "empty";
  let cellIdentity: LeaseIdentity | null = null;
  /**
   * 根闸自己记的那份身份。**与 cell 里那份分开存**：判据是「view 绑的 cell 与根闸认的是不是同一代」——
   * 合一存的话这条判据就是死代码。旧代 view 攥着旧 cell、根闸已经换了一代时，正是这行拦住它。
   */
  let rootIdentity: LeaseIdentity | null = null;
  let open = false;
  let businessMode: ActiveBusinessWriteMode = "closed";
  const lanes = new Set<EnforcedWriteLane>();

  const cell: LeaseIdentityCell = Object.freeze({
    state: () => cellState,
    current: () => cellIdentity,
    install(next: LeaseIdentity): void {
      // revoked 永远装不回去：旧 view 不可重新激活（fresh rollback 必须重建整套 cell / authority / view）
      if (cellState === "revoked") throw new Error("LeaseIdentityCell 已 revoke，不能重新安装——fresh rollback 必须重建一整套");
      if (cellState === "installed") throw new Error("LeaseIdentityCell 已经装过了：一格只服务一代 Agent");
      cellIdentity = next;
      cellState = "installed";
    },
    revoke(): void {
      cellState = "revoked";
      cellIdentity = null;
    },
  });

  return Object.freeze({
    cell,
    install(input): LeaseIdentity {
      const next = Object.freeze({ agentInstanceId: input.agentInstanceId, acquisitionId: input.acquisitionId }) as unknown as LeaseIdentity;
      cell.install(next); // cell 与根闸同一步：中间没有「装了身份但闸还关着」的可观察状态
      rootIdentity = next;
      open = true;
      return next;
    },
    revoke(): void {
      cell.revoke();
      rootIdentity = null;
      open = false;
      businessMode = "closed";
      lanes.clear();
    },
    isOpen: () => open,
    openLane(lane): () => void {
      lanes.add(lane);
      return () => void lanes.delete(lane);
    },
    closeLane(lane): void {
      lanes.delete(lane);
    },
    laneOpen: (lane) => lanes.has(lane),
    activeBusinessMode: () => businessMode,
    setActiveBusinessMode(mode): void {
      businessMode = mode;
    },
    authorityFor(capabilityId, spec): CapabilityWriteAuthority {
      const allowedLanes = new Set(spec.lanes ?? []);
      const allowsActiveBusinessWrites = spec.activeBusiness === true;
      return Object.freeze({
        capabilityId,
        leaseCell: cell,
        allowedLanes,
        allowsActiveBusinessWrites,
        assertWriteAllowed(): void {
          // 顺序即诊断价值：先说「有没有资格」，再说「现在开不开」
          if (cellState === "empty") throw new StateWriteDenied(capabilityId, "还没取得 single-writer 租约（cell 为空）");
          if (cellState === "revoked") throw new StateWriteDenied(capabilityId, "租约已交还或丢失（cell 已 revoke）");
          if (rootIdentity === null || cell.current() !== rootIdentity) throw new StateWriteDenied(capabilityId, "写入身份与当前租约不符");
          if (!open) throw new StateWriteDenied(capabilityId, "状态根总闸已关");
          for (const lane of allowedLanes) if (lanes.has(lane)) return;
          if (allowsActiveBusinessWrites && businessMode !== "closed") return;
          const laneList = [...allowedLanes].join(" / ") || "无";
          throw new StateWriteDenied(
            capabilityId,
            `没有开放的通道（可用 lane：${laneList}；active business：${allowsActiveBusinessWrites ? businessMode : "无资格"}）`,
          );
        },
      }) as unknown as CapabilityWriteAuthority;
    },
  });
}

/**
 * 把一个裸 `StorageDir` 包成受本 authority 管的 view：**签名一模一样**，领域对象只看见原端口。
 * read / list 直接委托（读不受闸管）；write / remove 在**真 I/O 紧邻边界**先判一次。
 * 视图没有 `close`——共享 root 只由 composition root 关一次。
 */
export function adoptStorageView(raw: StorageDir, authority: CapabilityWriteAuthority): StorageDir {
  // 写面声明成 async：被拒走 **rejection**，不是同步 throw。`StorageDir.write` 的签名是 `Promise<void>`，
  // 同步抛会打穿 `store.write(x).catch(...)` 这类调用方——fail-closed 不该顺带改变调用约定。
  return {
    read: (path) => raw.read(path),
    list: (prefix) => raw.list(prefix),
    write: async (path, content) => {
      authority.assertWriteAllowed();
      return raw.write(path, content);
    },
    remove: async (path) => {
      authority.assertWriteAllowed();
      return raw.remove(path);
    },
    // 锁也要在盘上建锁文件，所以与写同一道闸；底下没有 lock 就不出这个方法（不伪装有互斥）
    ...(raw.lock === undefined
      ? {}
      : {
          lock: async (name: string, opts?: { timeoutMs?: number }) => {
            authority.assertWriteAllowed();
            return raw.lock!(name, opts);
          },
        }),
  };
}
