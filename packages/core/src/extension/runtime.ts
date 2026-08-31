// `AgentRuntime` —— **壳子与 Agent 之间的那份协议**（`docs/design/AGENT-CORE.md` §14 owner 表：
// 「`echo:agent` … 构造/恢复低层 Agent 并 **provide AgentRuntime**」）。
//
// ## 它解决什么
//
// 在它之前，「壳」是 core 外面套的一层：`createEcho()` 交出 `Echo`，`runTui({ echo })` 拿去用。
// 于是「一个壳该处理哪些事」没有任何约束——TUI 只订阅了 `agent.subscribe`（渲染那条），
// `subscribeLifecycle` 一次都没调，结果是：`permissionRequest` 没人回答（`ask` 全被折成 deny，
// 用户看到「工具被拒」不知道为什么）、`notification` 与工具拒绝一个都不显示。**没有任何门发现**，
// 因为没人规定过壳子要做什么。
//
// 2026-08-31 用户拍板：**壳也是 extension**——TUI、Web 都是长在这份协议上的东西，
// 我们只是默认提供了一个 TUI。于是「壳该做什么」变成一件可声明、可检查的事：
// 壳 `inject` 这个 Service，协议里有什么就得处理什么。
//
// ## 为什么是封闭的（2026-08-31 用户拍板）
//
// 开放的话「壳实现了多少全凭自觉」这个病只是换了个地方——它是**穷举**：加一支就是改契约，
// 所有壳都得跟上。这也正是它值得配一套 conformance 的原因：壳恰好有**两个**实现，
// 而共享 suite 的全部价值就是「两个实现跑同一套判据」（§12 决策记录 2026-08-28）。
//
// ## 三样故意不放进来
//
// | 不放 | 理由 |
// |---|---|
// | `start` / `stop` | **进程级启停归装配层**（`createEcho()` / `echo.stop()`）。壳子能停 Agent 就等于两个所有者 |
// | `deliver` / `consumeInbox` | 那是**投递侧**（Schedule / 后台）的入口，不是 UI 的 |
// | `pauseManagedWork` / `activate` | handoff 语义，属 O3 Runtime，壳子不该碰 |

import type { AgentListener, AgentOutcome } from "../events.ts";
import type { LifecycleEventListener } from "../hooks/runtime.ts";
import type { AgentState } from "../agent.ts";
import type { AgentMessage, ImageBlock } from "../messages.ts";
import type { FollowUpResult, SteerResult } from "../loop/intake.ts";
import type { PermissionAnswer, PermissionAnswerResult, PermissionAsk } from "../permission/types.ts";
import { defineService, type ServiceKey } from "./abi.ts";

/** 一轮跑完的结果。壳子只关心成没成、错在哪。 */
export type RuntimeTurnResult = { readonly outcome: AgentOutcome };

/**
 * 壳子（TUI / Web / 任何 UI）看得到的**全部**。封闭：加一支就是改契约。
 *
 * 四组，按壳子实际要做的事分：**看**什么、**说**什么、**答**什么、**停**什么。
 */
export interface AgentRuntime {
  /* ── 看 ───────────────────────────────────────────────────────────── */

  /**
   * 运行态快照。**给整个 `AgentState`**（2026-08-31 用户拍板），不收窄成「UI 以为要的那几项」：
   * 它本来就是**派生视图、每轮重算**，不是内核内部结构；收窄反而会让壳子想显示新东西时
   * 每次都要改协议。
   */
  readonly state: Readonly<AgentState>;

  /** 渲染那条：text / thinking / tool / turn / agent_* 增量事件。返回退订。 */
  subscribe(listener: AgentListener): () => void;

  /**
   * 要**回答**与要**显示**的那条：`permissionRequest` / `notification` /
   * `toolUseDenied` / 压缩三件…。**壳子必须订阅它**——不订阅的后果不是少显示几行，
   * 而是 `ask` 无人回答被折成 deny（诚实缺席的代价落在用户身上）。
   */
  subscribeLifecycle(listener: LifecycleEventListener): () => void;

  /* ── 说 ───────────────────────────────────────────────────────────── */

  /** 开一轮新任务。忙的时候会抛——先看 `acceptsWork`。 */
  prompt(input: string | AgentMessage | AgentMessage[], images?: ImageBlock[]): Promise<RuntimeTurnResult>;

  /**
   * 跑着的时候用户又说话了，两种语义**都在协议里**（2026-08-31 用户拍板）：
   *   · `steer`：插进当前这一轮，**打断**它的原计划；
   *   · `followUp`：排到这一轮之后。
   * 放进来是因为「跑着的时候只能拒绝」是**缺功能不是设计**——TUI 今天就是那样。
   */
  steer(message: AgentMessage | string): Promise<SteerResult>;
  followUp(message: AgentMessage | string): Promise<FollowUpResult>;

  /* ── 答 ───────────────────────────────────────────────────────────── */

  /** 回答一次 `permissionRequest`。这是**唯一**入口——hook 只能观察，回答只能来自可信宿主。 */
  answerPermission(answer: PermissionAnswer): Promise<PermissionAnswerResult>;
  /** 还欠着几个答复。壳子重启 / 重绘时靠它把待答的重新摆出来。 */
  readonly pendingPermissions: readonly PermissionAsk[];

  /* ── 停 ───────────────────────────────────────────────────────────── */

  /** 中断在飞的那一轮。**不是停 Agent**——那是装配层的事。 */
  abort(reason?: string): void;

  /**
   * 现在能不能收新输入。**壳子必须读它而不是自己猜**：
   * 「忙不忙」的判据牵涉 `activeRun` / permit 落位 / Inbox ack 裁决 / 相位，
   * 全都不在公共面上——壳子自己维护一份必然漂（那是 review 连折腾四轮的东西）。
   */
  readonly acceptsWork: boolean;
}

/**
 * Service 身份。`agent` scope（跟着这一代 Agent 走）、`agent` reload boundary
 * （换代要在 run 之间，不能在轮中途把壳脚下的 Runtime 抽走）。
 */
export const AgentRuntimeService: ServiceKey<AgentRuntime> = defineService<AgentRuntime>({
  id: "echo.agent.runtime",
  version: 1,
  kind: "single",
  scope: "agent",
  reload: "agent",
});
