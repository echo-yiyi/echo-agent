// RunIntakeGate：Agent 内**唯一**裁决 steer / followUp 入队与 run / turn 关门的临界区。
//
// 规则：
//   - followUp 只进当前 run，steer 只进当前活动 turn；没有就返回 rejected——不抛、不偷偷转成下一 run；
//   - 判断与入队在同一个同步方法里完成：JS 单线程，方法内不 await，所以「读到 run 还开着」与「入队」之间没有窗口；
//   - 关门（closeTurn / tryCloseRun）同样是一步：关门那一刻队列里的全部交给调用方消费，之后到达的一律 rejected。
//     于是不存在「返回 accepted，随后 scope 正好关闭，消息静默消失」的窗口；
//   - run 非正常终止（abort / error / 超时 / 轮数用尽）时 accepted 却没来得及消费的，由 closeRun() 交还给
//     调用方**显式**报出——不留在队列里等下一个 run 捡走。

import type { AgentMessage } from "../messages.ts";

export type FollowUpResult =
  | { readonly kind: "accepted"; readonly agentInstanceId: string; readonly runId: string }
  | {
      readonly kind: "rejected";
      readonly reason: "no-active-run" | "reconfiguring" | "stale-agent" | "agent-not-active" | "runtime-failed" | "runtime-disposed";
    };

export type SteerResult =
  | { readonly kind: "accepted"; readonly agentInstanceId: string; readonly runId: string; readonly turnId: string }
  | {
      readonly kind: "rejected";
      readonly reason: "no-active-turn" | "reconfiguring" | "stale-agent" | "agent-not-active" | "runtime-failed" | "runtime-disposed";
    };

/** run 终止时交还的、accepted 却未消费的消息。 */
export type IntakeLeftovers = { readonly steers: readonly AgentMessage[]; readonly followUps: readonly AgentMessage[] };

export class RunIntakeGate {
  private run: { readonly runId: string; followUps: AgentMessage[] } | null = null;
  private turn: { readonly turnId: string; steers: AgentMessage[] } | null = null;
  private disposed = false;
  /**
   * reconfiguration barrier（§14.9.5）：handoff 的 `pauseManagedWork()` 立起来之后，新的 steer / followUp 一律
   * `rejected(reconfiguring)`。**barrier 之前 accepted 的仍必须消费完**——它们 pin 着当前 turn / run，
   * 由正在 drain 的那一轮照常吃掉。不立这道闸的话，handoff 期间源源不断的 followUp 能把前台 run 无限延长，
   * drain 永远等不到头（实测饥饿）。
   */
  private barrier = false;

  constructor(private readonly agentInstanceId: string) {}

  get steeringSize(): number {
    return this.turn?.steers.length ?? 0;
  }
  get followUpSize(): number {
    return this.run?.followUps.length ?? 0;
  }
  /** 当前开着的 run（Inspector / 诊断用）。 */
  get activeRunId(): string | null {
    return this.run?.runId ?? null;
  }
  /** 当前开着的 turn（`openTurn` 到 `closeTurn` 之间）；观测 scope 供给据此决定事实要不要挂 turn 归属。 */
  get activeTurnId(): string | null {
    return this.turn?.turnId ?? null;
  }

  /* ───────── 命令侧：同步裁决 + 入队 ───────── */

  steer(message: AgentMessage): SteerResult {
    if (this.disposed) return { kind: "rejected", reason: "runtime-disposed" };
    if (this.barrier) return { kind: "rejected", reason: "reconfiguring" };
    if (this.run === null || this.turn === null) return { kind: "rejected", reason: "no-active-turn" };
    this.turn.steers.push(message);
    return { kind: "accepted", agentInstanceId: this.agentInstanceId, runId: this.run.runId, turnId: this.turn.turnId };
  }

  followUp(message: AgentMessage): FollowUpResult {
    if (this.disposed) return { kind: "rejected", reason: "runtime-disposed" };
    if (this.barrier) return { kind: "rejected", reason: "reconfiguring" };
    if (this.run === null) return { kind: "rejected", reason: "no-active-run" };
    this.run.followUps.push(message);
    return { kind: "accepted", agentInstanceId: this.agentInstanceId, runId: this.run.runId };
  }

  /* ───────── 循环侧：开关门 ───────── */

  /** run 开门。与 `activeRun` 落位在同一个同步段里调，之后 followUp() 才 accepted。 */
  openRun(runId: string): void {
    if (this.run !== null) throw new Error(`RunIntakeGate：run ${this.run.runId} 还没关门就开了 ${runId}`);
    this.run = { runId, followUps: [] };
  }

  /**
   * turn 开门（turn_start 之前）。上一 turn 没经 closeTurn 就开了下一轮——只发生在 provider 重试路径
   * （同一 iteration 重跑）——它 accepted 的 steer 顺延到新 turn，不丢。
   */
  openTurn(turnId: string): void {
    if (this.run === null) throw new Error("RunIntakeGate：run 没开门就开 turn");
    const carried = this.turn?.steers ?? [];
    this.turn = { turnId, steers: carried };
  }

  /** 轮末原子：drain 本 turn accepted 的 steer 并关 turn intake。之后的 steer() 是 rejected(no-active-turn)。 */
  closeTurn(): AgentMessage[] {
    const steers = this.turn?.steers ?? [];
    this.turn = null;
    return steers;
  }

  /** run 中途 drain followUp；run intake 不关。 */
  drainFollowUps(): AgentMessage[] {
    if (this.run === null) return [];
    const out = this.run.followUps;
    this.run.followUps = [];
    return out;
  }

  /**
   * 关 run 的原子尝试：队列空 → 关门（连同 turn）返回 null；否则 drain 返回（门仍开），调用方消费后再试。
   * 「队列是否为空」与「关门」是同一步，stop hook 等待期间 accepted 的 followUp 不会凭空消失。
   */
  tryCloseRun(): AgentMessage[] | null {
    if (this.run === null) return null;
    if (this.run.followUps.length > 0) return this.drainFollowUps();
    this.run = null;
    this.turn = null;
    return null;
  }

  /** run 终止（任何原因）：强制关门，交还 accepted 却未消费的消息——调用方必须显式处理，不得静默。 */
  closeRun(): IntakeLeftovers {
    const leftovers: IntakeLeftovers = { steers: this.turn?.steers ?? [], followUps: this.run?.followUps ?? [] };
    this.run = null;
    this.turn = null;
    return leftovers;
  }

  /* ───────── reconfiguration barrier ───────── */

  /** 立起 barrier：之后的 steer / followUp 一律 `rejected(reconfiguring)`。已 accepted 的不受影响。 */
  closeForReconfiguration(): void {
    this.barrier = true;
  }
  /** handoff 结束（resume）后放开。 */
  reopenAfterReconfiguration(): void {
    this.barrier = false;
  }
  get reconfiguring(): boolean {
    return this.barrier;
  }

  /* ───────── 显式清空（调用方的主动决定，不是关门） ───────── */

  clearSteering(): void {
    if (this.turn !== null) this.turn.steers = [];
  }
  clearFollowUps(): void {
    if (this.run !== null) this.run.followUps = [];
  }

  dispose(): IntakeLeftovers {
    this.disposed = true;
    return this.closeRun();
  }
}
