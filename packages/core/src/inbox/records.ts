// Inbox 的持久 schema。**完整 durable ingress 只有一个公共协议**。
//
// 两份落盘形状 + 它们的 id 规则。**纯的**（只用 Web Crypto 与字符串），能进 engine 面。
//
// `causation?: ObservationRef` 是 spec 里的可选字段，Observation 落地（O2f）之前不写进 schema——
// 同一 schemaVersion 只许**增加** optional 字段（§15.4.3），所以那时补上是合法演进，现在先不占位。

import type { AgentMessage } from "../messages.ts";
import { assertMessageShape } from "../message-shape.ts";
import { sha256Hex } from "../digest.ts";

/** 一条已接受、尚未消费的入站事实。**recordId 就是文件名**，`dedupeKey` 是持久字段、不是内存旁账。 */
export type InboxRecordV1 = Readonly<{
  recordId: string;
  dedupeKey: string;
  message: AgentMessage;
  acceptedAt: number;
}>;

/** 整批 ack 的**唯一线性化点**：marker 落盘成功 = 这批在逻辑上已经 ack，之后的 record 删除只是可恢复 cleanup。 */
export type InboxBatchAckCommitV1 = Readonly<{
  ackCommitId: string;
  recordIds: readonly string[];
  committedAt: number;
}>;

export const INBOX_DIR = "inbox";
export const INBOX_ACK_DIR = "inbox/acks";
const SEQ_WIDTH = 6;
export const SEQ_MAX = 10 ** SEQ_WIDTH - 1;

/**
 * recordId 的合法形状：**恰好 6 位数字**，没有第二种可能。
 *
 * 为什么必须校验：它会被直接拼进路径。此前 `remove(id)` 拿到什么拼什么，而 `loadAll()` 又信任 JSON 里的
 * `record.id`——伪造一条 `{"id":"../tasks"}`，消费完那条 inbox 就把 `tasks.json` **删了**（实测确定性复现）。
 * `FileDir` 那层的 containment 只能挡住「跑出状态根」，挡不住「删掉状态根里**别的**资产」——那是本层自己的责任。
 */
const SAFE_RECORD_ID = /^[0-9]{6}$/;
/** ackCommitId 是 content-addressed 的 sha-256 十六进制串。 */
const SAFE_ACK_ID = /^[0-9a-f]{64}$/;

export function assertSafeRecordId(id: string, where: string): void {
  if (typeof id !== "string" || !SAFE_RECORD_ID.test(id)) throw new Error(`${where} 的 inbox recordId 不合法：'${String(id)}'——只允许 ${SEQ_WIDTH} 位数字`);
}
export function assertSafeAckCommitId(id: string, where: string): void {
  if (typeof id !== "string" || !SAFE_ACK_ID.test(id)) throw new Error(`${where} 的 ackCommitId 不合法：'${String(id)}'——只允许 64 位小写十六进制`);
}

export function recordIdOf(seq: number): string {
  if (seq > SEQ_MAX) {
    // 定长序号溢出会让字典序失效。不静默换格式，先判红。
    throw new Error(`inbox 累计条数超过 ${SEQ_MAX}，定长序号溢出——需先扩宽序号宽度`);
  }
  return String(seq).padStart(SEQ_WIDTH, "0");
}

export function recordPath(recordId: string): string {
  return `${INBOX_DIR}/${recordId}.json`;
}
export function ackPath(ackCommitId: string): string {
  return `${INBOX_ACK_DIR}/${ackCommitId}.json`;
}

/** `inbox/` 下的这条路径是不是一条 record（marker 也住在这个前缀下，必须区分开）。 */
export function recordIdFromPath(path: string): string | null {
  const rest = path.startsWith(`${INBOX_DIR}/`) ? path.slice(INBOX_DIR.length + 1) : path;
  if (!rest.endsWith(".json")) return null;
  const id = rest.slice(0, -".json".length);
  return SAFE_RECORD_ID.test(id) ? id : null;
}
export function ackIdFromPath(path: string): string | null {
  const prefix = `${INBOX_ACK_DIR}/`;
  if (!path.startsWith(prefix) || !path.endsWith(".json")) return null;
  const id = path.slice(prefix.length, -".json".length);
  return SAFE_ACK_ID.test(id) ? id : null;
}

/**
 * `ackCommitId = hash("inbox-batch-ack-v1", exactOrderedRecordIds)`——**不暴露 reservationId**、内容决定身份。
 * restore 必须用 marker 里的 recordIds 重算并核对文件名，所以进程重启后也能区分 self-consistent marker
 * 与不同 batch 的 collision/corruption。
 */
export function ackCommitIdOf(orderedRecordIds: readonly string[]): Promise<string> {
  return sha256Hex(["inbox-batch-ack-v1", ...orderedRecordIds]);
}

/** legacy record 的 dedupeKey：有稳定事实身份就用 `(source, ref)`，否则只用 recordId——不同旧事实绝不能互相去重。 */
export function legacyDedupeKey(recordId: string, message: AgentMessage): Promise<string> {
  if (message.role === "environment" && typeof message.ref === "string" && message.ref !== "") {
    return sha256Hex(["legacy-source-ref", message.source, message.ref]);
  }
  return sha256Hex(["legacy-record", recordId]);
}

/**
 * 普通 `(source, ref)` 事实的 dedupeKey。**tuple canonicalization**：段长前缀让
 * `("a b", "c")` 与 `("a", "b c")` 不再撞成同一个 key（上一版直接 `${source} ${ref}` 拼接会撞）。
 */
export function environmentDedupeKey(source: string, ref: string): string {
  return `env:${source.length}:${source}:${ref.length}:${ref}`;
}

/**
 * Schedule 的 dedupeKey = `hash(agentId, schedule.id, schedule.createdAt)`（§14 R6）。
 * **incarnation 进 key、scheduledAt 不进**：删掉后以同一 ID 重建的 schedule 是**另一个事实**，不能跟旧的共用
 * 防积压 key（否则新 schedule 被记 fired、Inbox 里却只有旧 prompt，新事实被吞——实测）；而同一 incarnation
 * 的多次到点仍要防积压，所以 scheduledAt 不能进。
 */
export function scheduleDedupeKey(agentId: string, scheduleId: string, createdAt: number): Promise<string> {
  return sha256Hex(["schedule-incarnation", agentId, scheduleId, String(createdAt)]);
}

/** 公共协议里的 `errorDigest`：**真 digest**，不是截断的原文——本地路径这类东西不能顺着协议流出去。 */
export function errorDigest(text: string): Promise<string> {
  return sha256Hex(["error-digest", text]).then((hex) => hex.slice(0, 16));
}

/**
 * 入站消息的规范化：先按公共判据验形（与 Session 恢复同一份），再做 **JSON-safe 深拷贝**。
 * 账本存的是这份副本，不是调用方的对象——上一版直接存引用：accepted 之后调用方改了原对象，
 * 当前进程消费到的是改后的、重启恢复出来的却是落盘时的原值（实测两边不一致）。
 */
export function canonicalizeMessage(message: unknown, where: string): AgentMessage {
  assertMessageShape(message, where);
  // **先拒绝会被 JSON 静默改写的值**：`at: NaN` 落盘变 null、`tool_use.input: undefined` 落盘后整个键消失——
  // 两者都能过验形，于是 accept 返回 accepted、新进程 restore 却报「缺信封字段 at」，直接卡启动（实测）。
  assertJsonSafe(message, where);
  let json: string;
  try {
    json = JSON.stringify(message);
  } catch (e) {
    throw new Error(`${where} 的 message 不是 JSON-safe：${(e as Error).message}`);
  }
  if (json === undefined) throw new Error(`${where} 的 message 序列化成了 undefined`);
  const copy = JSON.parse(json) as AgentMessage;
  // **副本再验一次**：能落盘的形状必须与验过形的那份一致，不能只验原件
  assertMessageShape(copy, `${where}（序列化副本）`);
  return copy;
}

/**
 * 递归拒绝「JSON 会静默改写」的值：`undefined` 值、非 finite number、函数、symbol、bigint，以及
 * 带自定义 `toJSON` 的非 plain 对象（`Date` 会变成字符串）。**只放行能原样往返的**——
 * 判据是「写下去再读回来必须一模一样」，不是「JSON.stringify 不抛错」。
 */
function assertJsonSafe(value: unknown, path: string, seen: object[] = []): void {
  if (value === null) return;
  switch (typeof value) {
    case "boolean":
    case "string":
      return;
    case "number":
      if (!Number.isFinite(value)) throw new Error(`${path} 是非 finite number（${String(value)}），落盘会变成 null`);
      return;
    case "undefined":
      throw new Error(`${path} 是 undefined，落盘后这个键会消失`);
    case "function":
      throw new Error(`${path} 是函数，落盘后这个键会消失`);
    case "symbol":
      throw new Error(`${path} 是 symbol，落盘后这个键会消失`);
    case "bigint":
      throw new Error(`${path} 是 bigint，不是 JSON 值`);
    case "object":
      break;
  }
  const obj = value as object;
  if (seen.includes(obj)) throw new Error(`${path} 循环引用`);
  seen.push(obj);
  try {
    if (Array.isArray(obj)) {
      for (let i = 0; i < obj.length; i++) {
        if (!Object.prototype.hasOwnProperty.call(obj, i)) throw new Error(`${path}[${i}] 是数组空洞，落盘会变成 null`);
        assertJsonSafe(obj[i], `${path}[${i}]`, seen);
      }
      return;
    }
    const proto = Object.getPrototypeOf(obj);
    if (proto !== Object.prototype && proto !== null) {
      throw new Error(`${path} 是 ${(obj as { constructor?: { name?: string } }).constructor?.name ?? "非 plain"} 实例，落盘形状会变`);
    }
    for (const key of Object.keys(obj)) assertJsonSafe((obj as Record<string, unknown>)[key], `${path}.${key}`, seen);
  } finally {
    seen.pop();
  }
}

/** canonical JSON：字段顺序固定，read-after-error 的逐字比对才有意义。 */
export function serializeRecord(record: InboxRecordV1): string {
  return JSON.stringify({ recordId: record.recordId, dedupeKey: record.dedupeKey, message: record.message, acceptedAt: record.acceptedAt });
}
export function serializeAckCommit(commit: InboxBatchAckCommitV1): string {
  return JSON.stringify({ ackCommitId: commit.ackCommitId, recordIds: commit.recordIds, committedAt: commit.committedAt });
}

/** 盘上的一条能不能当 V1 用。**坏一条不吞**：半截 inbox 意味着「有件事发生过但我们不知道是什么」。 */
export function parseRecordV1(text: string, path: string, nameId: string): InboxRecordV1 | "legacy" {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`inbox 的 ${path} 解不开：${(e as Error).message}`);
  }
  if (typeof raw !== "object" || raw === null) throw new Error(`inbox 的 ${path} 不是对象`);
  const r = raw as Record<string, unknown>;
  if (r["message"] === undefined) throw new Error(`inbox 的 ${path} 不是合法记录（缺 message）`);
  // legacy：`{ id, message, at }`，没有 recordId / dedupeKey
  if (r["recordId"] === undefined && typeof r["id"] === "string") return "legacy";
  if (typeof r["recordId"] !== "string" || typeof r["dedupeKey"] !== "string" || typeof r["acceptedAt"] !== "number") {
    throw new Error(`inbox 的 ${path} 不是合法 InboxRecordV1（缺 recordId / dedupeKey / acceptedAt）`);
  }
  // **文件名说了算，且记录里的 id 必须与它一致。** 只信 JSON 里的 id 时，伪造一条 `{"recordId":"../tasks"}`
  // 就能借消费流程删掉别的状态资产。
  assertSafeRecordId(r["recordId"], path);
  if (r["recordId"] !== nameId) throw new Error(`inbox 的 ${path} 里 recordId 是 '${String(r["recordId"])}'，与文件名对不上——拒载`);
  return { recordId: nameId, dedupeKey: r["dedupeKey"] as string, message: canonicalizeMessage(r["message"], path), acceptedAt: r["acceptedAt"] as number };
}

/** legacy `{ id, message, at }` → V1。`ref` 以前没有独立落盘字段，只读 message 自身携带的稳定 source/ref。 */
export async function migrateLegacyRecord(text: string, path: string, nameId: string): Promise<InboxRecordV1> {
  const raw = JSON.parse(text) as { id?: unknown; message?: unknown; at?: unknown };
  if (typeof raw.id !== "string") throw new Error(`inbox 的 ${path} 不是合法 legacy 记录（缺 id）`);
  assertSafeRecordId(raw.id, path);
  if (raw.id !== nameId) throw new Error(`inbox 的 ${path} 里 id 是 '${raw.id}'，与文件名对不上——拒载`);
  const message = canonicalizeMessage(raw.message, path);
  return {
    recordId: nameId,
    dedupeKey: await legacyDedupeKey(nameId, message),
    message,
    acceptedAt: typeof raw.at === "number" ? raw.at : 0,
  };
}

export function parseAckCommitV1(text: string, path: string, nameId: string): InboxBatchAckCommitV1 {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`inbox ack marker ${path} 解不开：${(e as Error).message}`);
  }
  if (typeof raw !== "object" || raw === null) throw new Error(`inbox ack marker ${path} 不是对象`);
  const r = raw as Record<string, unknown>;
  const ids = r["recordIds"];
  if (typeof r["ackCommitId"] !== "string" || !Array.isArray(ids) || ids.length === 0 || typeof r["committedAt"] !== "number") {
    throw new Error(`inbox ack marker ${path} 不是合法 InboxBatchAckCommitV1`);
  }
  for (const id of ids) assertSafeRecordId(id as string, path);
  if (new Set(ids as string[]).size !== ids.length) throw new Error(`inbox ack marker ${path} 的 recordIds 有重复`);
  assertSafeAckCommitId(r["ackCommitId"], path);
  if (r["ackCommitId"] !== nameId) throw new Error(`inbox ack marker ${path} 里 ackCommitId 与文件名对不上——拒载`);
  return { ackCommitId: nameId, recordIds: ids as string[], committedAt: r["committedAt"] as number };
}
