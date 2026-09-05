// 路径段安全校验。**纯的**——只做字符串判定，不碰 `node:`。
//
// 存在的理由：`sessionId` 与 `agentId` 都会被直接拼进路径，任何一处漏校验就漏一片。
// 此前只有 session 一侧有校验，`agentId="../../escaped"` 仍能把整个状态根挪出
// `.echo/agents`（实测）。判据只有一份，两处共用。
//
// **白名单，不是黑名单**：黑名单（「过滤掉 `..`」那种）永远漏——`.` + `.` 的组合、
// URL 编码、平台相关的分隔符都能绕。这里只放行明确安全的形状。

/** 允许的形状：首字符必须是字母数字，其余允许 `.` `_` `-`，总长 ≤ 64。 */
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * `kind` 只用于错误信息（`会话 id` / `agentId`），让人一眼看出是哪一处传错了。
 */
export function assertSafePathSegment(kind: string, value: string): void {
  if (!SAFE_SEGMENT.test(value) || value === "." || value === "..") {
    throw new Error(`${kind}不合法：'${value}'——只允许字母数字与 . _ -、须以字母数字开头、不超过 64 字符`);
  }
}
