// 观测线程的消息形状：主线程（thread.ts）与观测线程（thread-host.ts）共用。只有类型。
//
// 主线程发的都是**原始数据**：探针的投影（descriptor 在节点上做的有界取字段）、run 边界的输入、Agent 此刻的状态。
// 编码、摘要、seq、批、写文件都在观测线程里做（决策：docs/decisions/implemented/2026-09-14-observation-off-main-loop.md）。
// 存储是反过来的：观测线程要读写文件时发 `storage` 请求，主线程在 `createEcho()` 给的那个 `StorageDir` 上执行后回信——
// 注入的存储是主线程上的对象，过不了线程。
//
// 工作消息带递增的 `n`：观测线程空闲时回报处理到了哪一条，主线程据此决定线程要不要继续拖住进程退出（thread.ts）。

import type { BuiltinSlotContribution } from "./assembly.ts";
import type { ObservationFactProjection } from "./fact-sink.ts";
import type { ObservationSubscribeItem, SequencerLimits } from "./sequencer.ts";
import type {
  EchoObservableState,
  ObservationCapturePolicy,
  ObservationHealth,
  ObservationOwner,
  ObservationValue,
  ObservedRunSource,
  RuntimePhase,
} from "./types.ts";

/** run 归属的身份。 */
export type RunIdentity = Readonly<{ agentId: string; agentInstanceId: string; sessionId: string | null }>;

/** run 冻结的模型绑定，只带数据字段（`Model` 上可能挂着函数，过不了线程）。摘要在观测线程里算。 */
export type RunModelData = Readonly<{
  provider: string;
  id: string;
  api: unknown;
  params: unknown;
  thinkingLevelMap: unknown;
  capabilities: unknown;
  cost: unknown;
  catalogRevision: string;
}>;

/** run 的结果里观测要的那几项（`AgentOutcome` 的错误对象不一定能过线程）。 */
export type RunOutcomeData =
  | Readonly<{ kind: "completed" }>
  | Readonly<{ kind: "aborted"; reason?: string }>
  | Readonly<{ kind: "error"; code: string; message: string }>;

/**
 * Agent 在 run 开头 / 结尾拍的状态，还没算摘要。观测线程补上各能力的 `stateDigest` / `digest`、
 * `runtime.status` 与 `runtime.observationPersistence`（它们是观测线程自己的状态），再按 `EchoObservableState` 校验。
 */
export type ObservableStateInput = Readonly<{
  runtime: Readonly<{ phase: RuntimePhase; generation: string; activeEntryCount: number }>;
  agent: EchoObservableState["agent"];
  capabilities: readonly Readonly<{ id: string; counters: Readonly<Record<string, number>>; state: ObservationValue }>[];
}>;

/** 跨线程的错误：只带得过去这几项。 */
export type SerializedError = Readonly<{ name: string; message: string; code?: string }>;

/** 主线程 → 观测线程的工作消息。 */
export type ObservationWork =
  | Readonly<{
      t: "open";
      rt: string;
      runtimeGeneration: string;
      capturePolicy: ObservationCapturePolicy;
      /** 给人看的存储位置（诊断用）。 */
      storePath: string;
      /** 主线程那个存储有没有锁原语（`StorageDir.lock`）：建 key 时要不要在锁下做。 */
      storageLock: boolean;
      /** run 边界与状态快照记录的 owner（`echo:agent` 这个 builtin Entry）。 */
      boundaryOwner: ObservationOwner;
      assembly: readonly BuiltinSlotContribution[];
      limits?: Partial<SequencerLimits>;
    }>
  | Readonly<{ t: "sink"; rt: string; sink: number; owner: ObservationOwner; instrumentation: Readonly<{ name: string; version: string }> }>
  /** `scope`：节点上 scope 供给此刻的返回值；没配供给时不带。 */
  | Readonly<{ t: "fact"; rt: string; sink: number; at: number; scope?: unknown; projection: ObservationFactProjection }>
  /** 探针在主线程这一侧就失败了（scope 供给 / 投影抛错、投影过不了线程）：观测线程补 hole + gap 与诊断。 */
  | Readonly<{ t: "fact-failed"; rt: string; sink: number; at: number; runId?: string; why: string; error?: string }>
  | Readonly<{ t: "run-accepted"; rt: string; at: number; runId: string; source: ObservedRunSource; identity: RunIdentity; model: RunModelData }>
  | Readonly<{ t: "run-started"; rt: string; at: number; runId: string; identity: RunIdentity; startedBy: "permit-executor" | "subloop"; state: ObservableStateInput }>
  | Readonly<{ t: "run-closed"; rt: string; at: number; runId: string; identity: RunIdentity; outcome: RunOutcomeData; finalState: ObservableStateInput | null }>
  /** 读之前：把此刻之前交出去的全部写完（没开始写的 runtime 这时开始写）再回信。 */
  | Readonly<{ t: "flush"; rt: string; id: number }>
  | Readonly<{ t: "health"; rt: string; id: number }>
  | Readonly<{ t: "subscribe"; rt: string; id: number; sub: number; afterSeq: number; runId?: string }>
  | Readonly<{ t: "unsubscribe"; rt: string; sub: number }>
  /** 收摊：写完手上的再丢掉这个 runtime；从没开始写的直接丢。 */
  | Readonly<{ t: "close"; rt: string }>
  /** 状态根要被删掉：什么都别再写，直接丢。 */
  | Readonly<{ t: "discard"; rt: string }>;

/** 主线程 → 观测线程。工作消息带编号 `n`；存储回信不算工作。 */
export type ToObservationThread =
  | (ObservationWork & Readonly<{ n: number }>)
  | Readonly<{ t: "storage-reply"; id: number; ok: true; value: unknown }>
  | Readonly<{ t: "storage-reply"; id: number; ok: false; error: SerializedError }>;

/** 观测线程要主线程在某个 runtime 的存储上做的一次操作。 */
export type StorageOp =
  | Readonly<{ op: "read"; path: string }>
  | Readonly<{ op: "write"; path: string; content: string }>
  | Readonly<{ op: "remove"; path: string }>
  | Readonly<{ op: "list"; prefix: string }>
  | Readonly<{ op: "lock"; name: string }>
  | Readonly<{ op: "unlock"; lock: number }>;

/** `health` 请求的回信。 */
export type ThreadHealth = Readonly<{ health: ObservationHealth; committedSeq: number }>;

/** 观测线程 → 主线程。 */
export type FromObservationThread =
  | (Readonly<{ t: "storage"; id: number; rt: string }> & StorageOp)
  | Readonly<{ t: "reply"; id: number; ok: true; value: unknown }>
  | Readonly<{ t: "reply"; id: number; ok: false; error: SerializedError }>
  | Readonly<{ t: "item"; rt: string; sub: number; item: ObservationSubscribeItem }>
  /** 空闲了：编号不超过 `through` 的工作消息都处理完，手上没有要写的。 */
  | Readonly<{ t: "idle"; through: number }>
  /** 这个 runtime 收完摊（`close` 写完了、或 `discard` 丢掉了），之后不会再为它发任何消息。 */
  | Readonly<{ t: "closed"; rt: string }>;

/** 在发出方把任意抛出值收成可跨线程的形状。永不抛。 */
export function serializeError(e: unknown): SerializedError {
  try {
    if (e instanceof Error) {
      const code = (e as { code?: unknown }).code;
      return { name: String(e.name), message: String(e.message), ...(typeof code === "string" ? { code } : {}) };
    }
    return { name: "Error", message: typeof e === "string" ? e : "non-error thrown" };
  } catch {
    return { name: "Error", message: "unreadable error" };
  }
}

/** 在接收方还原成 `Error`。 */
export function reviveError(e: SerializedError): Error {
  const err = new Error(e.message);
  err.name = e.name;
  if (e.code !== undefined) (err as Error & { code?: string }).code = e.code;
  return err;
}
