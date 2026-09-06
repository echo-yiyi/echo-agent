// run / reply / turn 的 ID（docs/design/run-loop-layers.md §1）：**由 loop 产生、随事件带出**，
// permission 与观测都引用同一份，不各自拼一套。
//
//   replyId = `${runId}/${k}`   k 按 run 从 1 起
//   turnId  = `${replyId}#${n}` n 按 reply 从 1 起、每个 turn 加 1，**重试不消耗**
//
// n 就是 `shouldStopAfterTurn` / `prepareNextTurn` 收到的 `iteration`——不另设计数器。

export function replyIdOf(runId: string, k: number): string {
  return `${runId}/${k}`;
}

export function turnIdOf(replyId: string, n: number): string {
  return `${replyId}#${n}`;
}

/** turnId 里的 n（该 turn 在它的 reply 里的序号）。不是 turnId 形状的字符串返回 0。 */
export function turnNumberOf(turnId: string): number {
  const i = turnId.lastIndexOf("#");
  if (i < 0) return 0;
  const n = Number(turnId.slice(i + 1));
  return Number.isInteger(n) && n > 0 ? n : 0;
}
