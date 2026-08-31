// `AgentInternalRunRequest` 的运行时验形（§14.2.4）：按 `source.kind` 显式穷举——
//   inbox：必须带非空 reservationId + 非空 / 有序 / 去重的 reservedRecordIds，priority / purpose 都是 foreground；
//   dream：禁止携带 reservation 字段，priority / purpose 都是 maintenance；
//   其他：不是 Agent 内建来源，拒。
// 缺字段的 inbox request 上一版靠 `"reservationId" in request` 分支落进了 Dream 分支、还产生了 ticket（实测）。
// StandaloneRunAdmission 与 fake admission 用同一份，conformance 也按它断言。抛 = 受保护接线的编程不变量破坏，enqueue 在创建 ticket 前同步抛。

import type { AgentInternalRunRequest } from "./types.ts";

type InboxRequest = Extract<AgentInternalRunRequest, { source: { kind: "inbox" } }>;
type DreamRequest = Extract<AgentInternalRunRequest, { source: { kind: "dream" } }>;

export function assertInternalRunRequest(request: AgentInternalRunRequest): void {
  if (typeof request !== "object" || request === null || typeof request.source !== "object" || request.source === null) {
    throw new Error("run request 必须是 { source: { kind }, priority, purpose }");
  }
  const kind = (request.source as { kind?: unknown }).kind;
  switch (kind) {
    case "inbox": {
      const r = request as InboxRequest;
      if (r.priority !== "foreground" || r.purpose !== "foreground") {
        throw new Error(`inbox run request 的 priority / purpose 必须都是 foreground，收到 ${String(r.priority)} / ${String(r.purpose)}`);
      }
      if (typeof r.reservationId !== "string" || r.reservationId === "") throw new Error("inbox run request 的 reservationId 为空");
      const ids = r.reservedRecordIds;
      if (!Array.isArray(ids) || ids.length === 0) throw new Error("inbox run request 的 reservedRecordIds 必须非空");
      if (ids.some((id) => typeof id !== "string" || id === "")) throw new Error("inbox run request 的 reservedRecordIds 含非法 id");
      if (new Set(ids).size !== ids.length) throw new Error("inbox run request 的 reservedRecordIds 有重复");
      return;
    }
    case "dream": {
      const r = request as DreamRequest & { reservationId?: unknown; reservedRecordIds?: unknown };
      if (r.priority !== "maintenance" || r.purpose !== "maintenance") {
        throw new Error(`dream run request 的 priority / purpose 必须都是 maintenance，收到 ${String(r.priority)} / ${String(r.purpose)}`);
      }
      if ("reservationId" in r || "reservedRecordIds" in r) throw new Error("dream run request 不能携带 reservation 字段");
      return;
    }
    default:
      throw new Error(`run request 的 source.kind 必须是 inbox | dream，收到 ${String(kind)}`);
  }
}
