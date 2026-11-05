// RunIntakeGate：Agent 内**唯一**裁决 steer / followUp 入队与 run / turn 关门的临界区。
//
// 规则：
//   - followUp 只进当前 run，steer 只进当前活动 turn；没有就返回 rejected——不抛、不偷偷转成下一 run；
//   - 判断与入队在同一个同步方法里完成：JS 单线程，方法内不 await，所以「读到 run 还开着」与「入队」之间没有窗口；
//   - 关门（closeTurn / tryCloseRun）同样是一步：关门那一刻队列里的全部交给调用方消费，之后到达的一律 rejected。
//     于是不存在「返回 accepted，随后 scope 正好关闭，消息静默消失」的窗口；
//   - run 非正常终止（abort / error / 超时 / 轮数用尽）时 accepted 却没来得及消费的，由 closeRun() 交还给
//     调用方**显式**报出——不留在队列里等下一个 run 捡走；
//   - **steer 是改方向**（2026-11-05）：收下的那一刻 abort 本 turn 的 `steered` 信号，还没启动的工具据此不再启动；
//   - **中断只停这一步**：reply 每一步（轮首的边界工作 + 那一个 turn）`beginStep()` 换一个新信号，`interrupt()` 只 abort 它；
//     理由留到 reply 来 `takeInterrupt()`——中断落在两步之间也不丢，下一步一开始就是 aborted。
//   决策见 docs/decisions/implemented/2026-11-05-input-lifecycle.md。

import { AbortReason } from "../errors.ts";
import type { AgentMessage } from "../messages.ts";

/** 收下的那条消息的 `inputId`（Agent 在交给 gate 之前盖上；不是 user 消息就没有）。 */
function inputIdOf(message: AgentMessage): { readonly inputId?: string } {
  const id = (message as { inputId?: unknown }).inputId;
  return typeof id === "string" ? { inputId: id } : {};
}

export type FollowUpResult =
  | { readonly kind: "accepted"; readonly agentInstanceId: string; readonly runId: string; readonly inputId?: string }
  | {
      readonly kind: "rejected";
      readonly reason: "no-active-run" | "reconfiguring" | "stale-agent" | "agent-not-active" | "runtime-failed" | "runtime-disposed";
    };

/**
 * `turnId` 是收下它时开着的那个 turn；**引出的是下一个 turn**（轮末吸收，那一轮的 `turn_started.inputs` 里有这个 `inputId`）。
 */
export type SteerResult =
  | { readonly kind: "accepted"; readonly agentInstanceId: string; readonly runId: string; readonly turnId: string; readonly inputId?: string }
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
   * reconfiguration barrier：handoff 的 `pauseManagedWork()` 立起来之后，新的 steer / followUp 一律
   * `rejected(reconfiguring)`。**barrier 之前 accepted 的仍必须消费完**——它们 pin 着当前 turn / run，
   * 由正在 drain 的那一轮照常吃掉。不立这道闸的话，handoff 期间源源不断的 followUp 能把前台 run 无限延长，
   * drain 永远等不到头（实测饥饿）。
   */
  private barrier = false;
  /** 本 turn 收下过 steer 就 abort（`openTurn` 换新、`closeTurn` 撤掉）。 */
  private steeredCtl: AbortController | null = null;
  /** reply 当前这一步的中断口（`beginStep` 换新）。 */
  private stepCtl: AbortController | null = null;
  /** 还没被 reply 取走的中断理由。 */
  private interruptReason: string | null = null;

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
    // 改方向：本 turn 还没启动的工具不再启动（`run-turn.ts` 在启动前查它）；已经在跑的照常跑完
    this.steeredCtl?.abort();
    return { kind: "accepted", agentInstanceId: this.agentInstanceId, runId: this.run.runId, turnId: this.turn.turnId, ...inputIdOf(message) };
  }

  followUp(message: AgentMessage): FollowUpResult {
    if (this.disposed) return { kind: "rejected", reason: "runtime-disposed" };
    if (this.barrier) return { kind: "rejected", reason: "reconfiguring" };
    if (this.run === null) return { kind: "rejected", reason: "no-active-run" };
    this.run.followUps.push(message);
    return { kind: "accepted", agentInstanceId: this.agentInstanceId, runId: this.run.runId, ...inputIdOf(message) };
  }

  /**
   * 中断当前这一步（不是整个 run）：abort 这一步的信号，理由留给 reply 取走。没有 run 返回 false。
   * 落在两步之间（轮首压缩、吸收输入）也不丢：下一步 `beginStep()` 一开始就是 aborted。
   */
  interrupt(reason: string): boolean {
    if (this.disposed || this.run === null) return false;
    this.interruptReason = reason;
    this.stepCtl?.abort(new AbortReason(reason));
    return true;
  }

  /* ───────── 循环侧：开关门 ───────── */

  /** run 开门。与 `activeRun` 落位在同一个同步段里调，之后 followUp() 才 accepted。 */
  openRun(runId: string): void {
    if (this.run !== null) throw new Error(`RunIntakeGate：run ${this.run.runId} 还没关门就开了 ${runId}`);
    this.run = { runId, followUps: [] };
  }

  /**
   * turn 开门（turn_start 之前）。一个 turn 只开一次——重试是同一 turn 的下一个 attempt，不重开；
   * 上一 turn 没关就开下一个是 loop 的 bug，fail-loud。
   */
  openTurn(turnId: string): void {
    if (this.run === null) throw new Error("RunIntakeGate：run 没开门就开 turn");
    if (this.turn !== null) throw new Error(`RunIntakeGate：turn ${this.turn.turnId} 还没关门就开了 ${turnId}`);
    this.turn = { turnId, steers: [] };
    this.steeredCtl = new AbortController();
  }

  /** 本 turn 收下过 steer 就 abort 的信号；turn 没开时 undefined。 */
  get steered(): AbortSignal | undefined {
    return this.steeredCtl?.signal;
  }

  /** 轮末原子：drain 本 turn accepted 的 steer 并关 turn intake。之后的 steer() 是 rejected(no-active-turn)。 */
  closeTurn(): AgentMessage[] {
    const steers = this.turn?.steers ?? [];
    this.turn = null;
    this.steeredCtl = null;
    return steers;
  }

  /** reply 每一步开始时调：换一个新的中断信号。有还没取走的中断，这一步一开始就是 aborted。 */
  beginStep(): AbortSignal {
    this.stepCtl = new AbortController();
    if (this.interruptReason !== null) this.stepCtl.abort(new AbortReason(this.interruptReason));
    return this.stepCtl.signal;
  }

  /** 取走中断理由（取一次就清）；没有中断 null。 */
  takeInterrupt(): string | null {
    const reason = this.interruptReason;
    this.interruptReason = null;
    return reason;
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
    this.resetSteps();
    return null;
  }

  /** run 终止（任何原因）：强制关门，交还 accepted 却未消费的消息——调用方必须显式处理，不得静默。 */
  closeRun(): IntakeLeftovers {
    const leftovers: IntakeLeftovers = { steers: this.turn?.steers ?? [], followUps: this.run?.followUps ?? [] };
    this.run = null;
    this.turn = null;
    this.resetSteps();
    return leftovers;
  }

  /** run 关门：中断与插话信号都只属于这个 run，不带进下一个。 */
  private resetSteps(): void {
    this.steeredCtl = null;
    this.stepCtl = null;
    this.interruptReason = null;
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
