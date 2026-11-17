// 收方账本之外的写者往一段会话的 inbox 写 record（2026-11-16）：同进程里别的会话（`session_send`，`session/sessions.ts`），
// 或别的进程（`openSessionIngress`，`session/ingress.ts`）。
//
// **只写文件，不碰收方的内存账本**：收方在 `restore()`（启动）或 `refresh()`（每秒轮询）时把这条读进去，
// 保序、去重、ack 都在那一侧（`store.ts`）。不 `new InboxStore(对方目录)` 来写：那要先 `restore()` 一遍对方整个 inbox，
// 而 restore 会改盘（迁移、cleanup）——那是收方自己账本的事。

import type { AgentMessage } from "../messages.ts";
import type { StorageDir } from "../storage/types.ts";
import {
  ackIdFromPath,
  INBOX_ACK_DIR,
  INBOX_DIR,
  parseAckCommitV1,
  parseRecordV1,
  recordIdFromPath,
  recordPath,
  serializeRecord,
  type InboxRecordV1,
} from "./records.ts";

/**
 * 写一条 record，返回它的 `recordId`。`newRecordId` 是**这个写者**的发号器（`createRecordIdSource()`）：
 * 同一个写者连着写的几条按写的顺序排，收方也按这个顺序处理。`message` 由调用方先验形（`canonicalizeMessage`）。
 */
export async function writeInboxRecord(store: StorageDir, newRecordId: () => string, message: AgentMessage, dedupeKey: string): Promise<string> {
  const recordId = newRecordId();
  const record: InboxRecordV1 = { recordId, dedupeKey, message, acceptedAt: Date.now() };
  await store.write(recordPath(recordId), serializeRecord(record));
  return recordId;
}

/**
 * 盘上还没 ack 的 record 里，`dedupeKey` 相同的最早那一条的 `recordId`；没有就是 `null`。
 * 只读：读不出来的 record 与 marker 跳过（坏档由收方报）。legacy 形状的 record 没有落盘的 dedupeKey，不参与比对。
 */
export async function pendingRecordWithKey(store: StorageDir, dedupeKey: string): Promise<string | null> {
  const acked = new Set<string>();
  for (const path of await store.list(`${INBOX_ACK_DIR}/`)) {
    const full = path.startsWith(`${INBOX_ACK_DIR}/`) ? path : `${INBOX_ACK_DIR}/${path}`;
    const ackId = ackIdFromPath(full);
    if (ackId === null) continue;
    const text = await store.read(full);
    if (text === null) continue;
    try {
      for (const id of parseAckCommitV1(text, full, ackId).recordIds) acked.add(id);
    } catch {
      // 坏 marker：收方 restore 时判红，这里不替它判
    }
  }
  for (const path of [...(await store.list(`${INBOX_DIR}/`))].sort()) {
    const nameId = recordIdFromPath(path);
    if (nameId === null || acked.has(nameId)) continue;
    const full = path.startsWith(`${INBOX_DIR}/`) ? path : `${INBOX_DIR}/${path}`;
    const text = await store.read(full);
    if (text === null) continue;
    try {
      const parsed = parseRecordV1(text, full, nameId);
      if (parsed !== "legacy" && parsed.dedupeKey === dedupeKey) return nameId;
    } catch {
      // 坏 record：同上
    }
  }
  return null;
}
