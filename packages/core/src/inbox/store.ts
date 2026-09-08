// 持久 Inbox 账本 —— **已接受但未消费的入站事实，不因崩溃静默丢失**。
//
// 它是**四件东西的唯一 owner**：pending records、pending dedupe index、reservation ledger、batch-ack marker。
// Runtime / Agent 不建第二份账（「不维护 recordId→batch 镜像」）。
//
// **纯的**：只依赖 `StorageDir` 与 Web Crypto。传 `null` = 纯内存模式（评测与一次性跑），
// 两种模式共用同一套 id / dedupe / reservation 语义，只有「写不写盘」不同。
//
// 盘上布局：`inbox/000001.json` 一条一 record，`inbox/acks/<ackCommitId>.json` 一批一 marker。
// 理由同 session entries——`StorageDir` 只有全量 `write`，一条一文件的投递就是写一个新文件，
// 天然满足「一次 write 要么整份生效」。
//
// **投递语义是 at-least-once**：marker 落盘才算整批 ack。
//   · commit 前崩 → 整批仍 pending，重启后重放
//   · commit 后崩 → 整批逻辑上已 ack，restore 只做 cleanup，**绝不重新投递**
//   · 无法裁决 → indeterminate：seal intake、fail-loud，不猜
// 要 exactly-once 得让消费方带幂等键，那是消费方的事，core 不替它决定。

import { errText, type Diagnostic } from "../errors.ts";
import type { AgentMessage } from "../messages.ts";
import type { StorageDir } from "../storage/types.ts";
import type { CapabilityFactSink } from "../observability/fact-sink.ts";
import { inboxRecordBrief, type InboxFact, type InboxRecordBrief } from "./observe.ts";
import {
  ackCommitIdOf,
  ackIdFromPath,
  canonicalizeMessage,
  errorDigest,
  ackPath,
  INBOX_ACK_DIR,
  INBOX_DIR,
  migrateLegacyRecord,
  parseAckCommitV1,
  parseRecordV1,
  recordIdFromPath,
  createRecordIdSource,
  recordPath,
  serializeAckCommit,
  serializeRecord,
  type InboxBatchAckCommitV1,
  type InboxRecordV1,
} from "./records.ts";

export type InboxAcceptRequest = Readonly<{ message: AgentMessage; dedupeKey: string }>;

export type InboxAcceptOutcome =
  | Readonly<{ kind: "accepted"; recordId: string; dedupeKey: string; deduplicated: boolean }>
  | Readonly<{ kind: "rejected"; reason: "invalid-request" | "store-error"; errorDigest?: string }>;

/** 一次 reserve 出来的整批。`reservationId` 是 generation-scoped、单次使用的 opaque id，**不落盘**。 */
export type InboxReservedBatch = Readonly<{
  reservationId: string;
  recordIds: readonly string[];
  messages: readonly AgentMessage[];
}>;

/** ack 的三态裁决之一。`pre-commit` 与 `indeterminate` 都以 reject 报出。 */
export class InboxAckError extends Error {
  constructor(
    readonly verdict: "pre-commit" | "indeterminate",
    message: string,
  ) {
    super(message);
    this.name = "InboxAckError";
  }
}

export class InboxStore {
  /**
   * 有没有从盘上恢复过。**没恢复就不许收**。
   *
   * recordId 现在由写者自己发（`newRecordId`，2026-09-03），撞名的老问题不存在了；但这条前置条件仍在，
   * 换了理由：restore 之前 `pending` 与 dedupe 索引都是空的，此时收下的投递会**绕过去重**，
   * 而且随后的 restore 会把内存里这条挤掉。实测在「锁很慢、start 还卡在 acquire」时就会发生：
   * 那时 agent 已经能收投递，而 inbox 还没恢复。
   */
  private restored = false;
  /** 本写者的发号器（2026-09-03）。状态在实例上，不共享——见 `createRecordIdSource`。 */
  private readonly newRecordId = createRecordIdSource();
  private sealedReason: string | null = null;
  /** 未被 reserve 的 pending records，按接受顺序。 */
  private pending: InboxRecordV1[] = [];
  /** dedupeKey → 有序 recordIds（**含已 reserve 未 ack 的**：它们的 durable fact 还在盘上，仍该防重）。 */
  private readonly index = new Map<string, string[]>();
  private readonly reservations = new Map<string, InboxRecordV1[]>();
  /** 正在落盘、还没发布 index 的：撞上的第二个调用方跟着它一起等，**成败一并继承**。 */
  private readonly inflight = new Map<string, Promise<InboxAcceptOutcome>>();
  /**
   * 正在 commit 的整批所覆盖的 dedupeKey → 该批的裁决。**accept 必须等这个 barrier**：
   * marker 已 durable、`ackBatch()` 还没从 write 返回的那一瞬间，同 key 的 accept 若直接 dedupe 到旧 record，
   * 崩溃后 restore 会按 marker 把旧 record 清掉，而新事实从来没有自己的 record——**永久消失**（实测确定性复现）。
   */
  private readonly ackBarriers = new Map<string, Promise<void>>();
  /**
   * 本进程**不再收**的 record id：已逻辑 ack 但 cleanup 没删掉的（marker 与 record 都还在盘上），
   * 以及 `clear()` 丢弃的（盘上留着等下次 restore 重放）。`refresh()` 重扫盘时跳过它们——
   * 否则每一拍都把它们当「别人新投进来的」重新入队（review 2026-09-07：已 ack 的每秒重投、`/clear` 形同虚设）。
   * 盘上没有了就从这里摘掉，所以它不会比 `inbox/` 里的文件数更大。
   */
  private readonly notForRefresh = new Set<string>();

  private onDiagnostic?: (d: Diagnostic) => void;
  /** 观测出口（Inbox 行，observe.ts 头注列了全部发点）：装配方（Agent）接上；没接就不发。 */
  observe?: CapabilityFactSink<InboxFact>;

  constructor(private readonly store: StorageDir | null = null) {
    if (store === null) this.restored = true; // 纯内存：没有盘可恢复
  }

  private fact(fact: Omit<InboxFact, "occurredAt">): void {
    this.observe?.offer({ ...fact, occurredAt: Date.now() });
  }

  /** 装配方（Agent）接诊断出口。cleanup-pending / seal 这类只能报告、不能改变裁决的事从这里出去。 */
  attachDiagnostics(sink: (d: Diagnostic) => void): void {
    this.onDiagnostic = sink;
  }

  /**
   * 序号是否已从盘上恢复——**没恢复不许发号**（见 `restored`）。ingress 用它决定 `runtime-not-ready`：
   * 判据是「账本准备好了没」，不是 phase——schedule 的 catch-up 就发生在 `start()` 内、restore 之后、
   * phase 还是 starting 的那一段，用 phase 判会把它一起挡掉（实测）。
   */
  get ready(): boolean {
    return this.restored;
  }

  /** 非空 = intake 已封（indeterminate 之后）。 */
  get sealed(): string | null {
    return this.sealedReason;
  }
  get pendingCount(): number {
    return this.pending.length;
  }
  /** 还没 ack 的 reservation 数（Inspector / 测试用）。 */
  get reservationCount(): number {
    return this.reservations.size;
  }

  /* ─────────────── restore ─────────────── */

  /**
   * 恢复顺序写死：**先读并验证全部 ack markers**，建立 `logicallyAckedRecordIds`，再扫 record 文件与
   * legacy migration——被 marker 覆盖的 record 绝不进 pending queue / dedupe index / reservation，只幂等删除。
   * 反过来先扫 record 就会把已经逻辑 ack 的那批重新投递一遍。
   */
  async restore(): Promise<readonly InboxRecordV1[]> {
    const store = this.store;
    if (store === null) {
      this.restored = true;
      return [];
    }
    this.assertNotSealed("restore");
    const markers = await this.readMarkers(store);
    const acked = new Set<string>();
    for (const m of markers.values()) for (const id of m.recordIds) acked.add(id);

    const pending: InboxRecordV1[] = [];
    const ackedOnDisk = new Set<string>();
    for (const path of [...(await store.list(`${INBOX_DIR}/`))].sort()) {
      const nameId = recordIdFromPath(path);
      if (nameId === null) continue; // marker 或别的东西，不是 record
      const full = path.startsWith(`${INBOX_DIR}/`) ? path : `${INBOX_DIR}/${path}`;
      const text = await store.read(full);
      if (text === null) continue; // list 与 read 之间被别人删了——不是坏档
      if (acked.has(nameId)) {
        ackedOnDisk.add(nameId);
        continue; // 已逻辑 ack：不进 pending，下面只做 cleanup
      }
      const parsed = parseRecordV1(text, full, nameId);
      const record = parsed === "legacy" ? await migrateLegacyRecord(text, full, nameId) : parsed;
      if (parsed === "legacy") await store.write(full, serializeRecord(record)); // 迁移 rewrite，幂等
      pending.push(record);
    }
    this.pending = pending;
    this.index.clear();
    for (const r of pending) this.indexPush(r.dedupeKey, r.recordId); // 从**全部 pending records** 重建
    if (pending.length > 0) this.fact({ kind: "restored", records: pending.map((r) => inboxRecordBrief(r.message, r.recordId)) });

    // cleanup：删掉被 marker 覆盖的 record；某个 marker 的 records 全没了才删该 marker
    for (const id of ackedOnDisk) {
      this.notForRefresh.add(id); // 删不掉也不能再收：它已被 marker 覆盖
      try {
        await store.remove(recordPath(id));
      } catch (e) {
        this.diagnose("inbox_cleanup_pending", `已 ack 的 record ${id} 删除失败，下次 restore 继续：${errText(e)}`);
      }
    }
    for (const [ackId, commit] of markers) {
      const stillThere = await Promise.all(commit.recordIds.map(async (id) => (await store.read(recordPath(id))) !== null));
      if (stillThere.some(Boolean)) continue;
      try {
        await store.remove(ackPath(ackId));
      } catch (e) {
        this.diagnose("inbox_cleanup_pending", `ack marker ${ackId} 删除失败，下次 restore 继续：${errText(e)}`);
      }
    }
    // **验证与 cleanup 全部安全结束之后才置位**：中途抛错时 restore() 会 reject，而 `ready` 若已经是 true，
    // 上层（可能已经释放了 Lease、phase 退回 new）的 ingress 还会继续往状态根写（实测）。
    this.restored = true;
    return pending;
  }

  /**
   * 重扫盘上的 record，把**别的写者**新写进来的那些收进 pending（2026-09-03，sessions.md §5）。
   *
   * 会话之间发消息 = 往对方的 `inbox/` 写一条 record（`session_send`）。写者可以是**另一个进程**，
   * 而本实例只在 `restore()` 那一刻读过盘——不重扫的话，那条消息要等到对方下次重启才被看见，
   * 「A 发给 B，B 不重启就收到」这条根本不成立。
   *
   * 与 `restore()` 的分工：restore 是**打开账本**（验 ack marker、legacy 迁移、cleanup、置 `ready`），
   * 一段 session 一辈子只做一次；refresh 是**看看有没有新的**，只加不减：
   * 不碰 marker、不做 cleanup、不改 `ready`、不动已经 reserve 的那批。
   *
   * 坏档在这里**不判红**，只报诊断并跳过：refresh 跑在正常运行途中（idle 轮询），
   * 让一条别人写坏的 record 把一个健康的 agent 掀翻，代价比跳过它大得多；
   * 下一次 `restore()`（重启）仍然会按老规矩判红。
   *
   * @returns 这一次新收进来的条数。
   */
  async refresh(): Promise<number> {
    const store = this.store;
    if (store === null || !this.restored || this.sealedReason !== null) return 0;
    const known = new Set<string>();
    for (const r of this.pending) known.add(r.recordId);
    for (const batch of this.reservations.values()) for (const r of batch) known.add(r.recordId);
    for (const ids of this.index.values()) for (const id of ids) known.add(id);
    for (const id of this.notForRefresh) known.add(id);

    const found: InboxRecordV1[] = [];
    const onDisk = new Set<string>();
    for (const path of [...(await store.list(`${INBOX_DIR}/`))].sort()) {
      const nameId = recordIdFromPath(path);
      if (nameId === null) continue;
      onDisk.add(nameId);
      if (known.has(nameId)) continue;
      const full = path.startsWith(`${INBOX_DIR}/`) ? path : `${INBOX_DIR}/${path}`;
      const text = await store.read(full);
      if (text === null) continue; // list 与 read 之间被别人删了——不是坏档
      try {
        const parsed = parseRecordV1(text, full, nameId);
        // legacy 形状不在这里迁：迁移是 restore 的事（它要 rewrite 盘上的文件），
        // 运行途中改写别人正在写的目录不是 refresh 该做的
        if (parsed === "legacy") continue;
        found.push(parsed);
      } catch (e) {
        this.diagnose("inbox_refresh_skipped", `record ${nameId} 读不出来，本次跳过（重启时按坏档判红）：${errText(e)}`);
      }
    }
    // 盘上已经没有的就不用再记着（cleanup 或别的进程删掉了）
    for (const id of this.notForRefresh) if (!onDisk.has(id)) this.notForRefresh.delete(id);
    if (found.length === 0) return 0;
    // 按 recordId 排序 = 按时间排序（id 前缀是定长时间戳），所以别人写进来的这些也按它们的发生顺序入队
    found.sort((a, b) => (a.recordId < b.recordId ? -1 : a.recordId > b.recordId ? 1 : 0));
    for (const r of found) {
      this.pending.push(r);
      this.indexPush(r.dedupeKey, r.recordId);
      // 别的进程写进来的（跨 session 的 session_send 就是这条路）：一条一个事实，source / ref 说是谁发的
      this.fact({ kind: "accepted", records: [inboxRecordBrief(r.message, r.recordId)], deduplicated: false, via: "refresh" });
    }
    return found.length;
  }

  private async readMarkers(store: StorageDir): Promise<Map<string, InboxBatchAckCommitV1>> {
    const out = new Map<string, InboxBatchAckCommitV1>();
    for (const path of [...(await store.list(`${INBOX_ACK_DIR}/`))].sort()) {
      const full = path.startsWith(`${INBOX_ACK_DIR}/`) ? path : `${INBOX_ACK_DIR}/${path}`;
      const nameId = ackIdFromPath(full);
      if (nameId === null) {
        this.seal(`inbox ack 目录下有非法文件名：${full}`);
        throw new Error(this.sealedReason!);
      }
      const text = await store.read(full);
      if (text === null) continue;
      let commit: InboxBatchAckCommitV1;
      try {
        commit = parseAckCommitV1(text, full, nameId);
        // **content-derived id 必须与路径一致**：重算一遍，才分得清 self-consistent marker 与 collision/corruption
        const recomputed = await ackCommitIdOf(commit.recordIds);
        if (recomputed !== nameId) throw new Error(`ack marker ${full} 的 recordIds 重算出 ${recomputed}，与文件名对不上`);
      } catch (e) {
        this.seal(`inbox ack marker 不可信：${errText(e)}`);
        throw e;
      }
      out.set(nameId, commit);
    }
    return out;
  }

  /* ─────────────── accept ─────────────── */

  /**
   * 接受一条 durable fact。**同一 critical section 先查 dedupeKey**：命中就返回最早 pending record 的
   * `deduplicated:true`，未命中才写完整 V1 record，durable write 成功后才发布 index / accepted result。
   * index 或 record write 失败不得返回 accepted。
   */
  async accept(request: InboxAcceptRequest): Promise<InboxAcceptOutcome> {
    if (this.sealedReason !== null) return this.reject([], "store-error", "inbox-sealed");
    const dedupeKey = request?.dedupeKey;
    if (typeof dedupeKey !== "string" || dedupeKey === "") return this.reject([], "invalid-request", "empty-dedupe-key");
    // 形状按公共判据验（与 Session 恢复同一份），随即取 JSON-safe 副本——账本存副本，不存调用方的对象
    let message: AgentMessage;
    try {
      message = canonicalizeMessage(request?.message, "inbox 投递");
    } catch {
      return this.reject([], "invalid-request", "message-shape");
    }
    if (!this.restored) {
      // 序号没恢复就发号会盖掉盘上已有的 record——这是不变量破坏，不是可重试的 I/O 失败
      throw new Error("inbox 还没从盘上恢复序号，拒绝投递——先 restore()（否则新记录会盖掉盘上已有的）");
    }
    return this.acceptCanonical(message, dedupeKey);
  }

  /**
   * 已经验形、已经取过副本之后的接受流程。**barrier 放行后不回头读原 request**——等裁决那段时间里调用方
   * 可能已经改了自己的对象，重读等于把「accepted 的是哪一份」变成时序问题（实测）。
   */
  private async acceptCanonical(message: AgentMessage, dedupeKey: string): Promise<InboxAcceptOutcome> {
    // 这个 key 所在的整批正在 commit：**等裁决**再决定是 dedupe 到旧事实还是落一条新的
    for (let guard = 0; ; guard++) {
      const barrier = this.ackBarriers.get(dedupeKey);
      if (barrier === undefined) break;
      if (guard > 64) throw new Error(`inbox ack barrier 迟迟不放行（dedupeKey=${dedupeKey}）——判红不猜`);
      await barrier;
      if (this.sealedReason !== null) return { kind: "rejected", reason: "store-error", errorDigest: "inbox-sealed" };
    }

    const existing = this.index.get(dedupeKey);
    if (existing !== undefined && existing.length > 0) {
      this.fact({ kind: "accepted", records: [inboxRecordBrief(message, existing[0]!)], deduplicated: true, via: "deliver" });
      return { kind: "accepted", recordId: existing[0]!, dedupeKey, deduplicated: true };
    }
    // **撞上在飞的那次就跟着它一起等**，不是直接 return：直接 return 等于凭空给第二个调用方一个「已被接受」的答复，
    // 首个落盘随后失败时它以为存下了、而盘上什么都没有（实测）。
    const inflight = this.inflight.get(dedupeKey);
    if (inflight !== undefined) return inflight;

    const started = this.writeRecord(message, dedupeKey);
    this.inflight.set(dedupeKey, started);
    // **两个分支各清一次**，不要 `void p.finally(...)`：那会新造一个 promise，writeRecord reject 时
    // 调用方接一次、这个被忽略的返回值再 unhandled 一次（实测由序号耗尽复现）。
    const drop = (): void => {
      if (this.inflight.get(dedupeKey) === started) this.inflight.delete(dedupeKey);
    };
    started.then(drop, drop);
    return started;
  }

  private async writeRecord(message: AgentMessage, dedupeKey: string): Promise<InboxAcceptOutcome> {
    // **写者自己发号**（2026-09-03）：不读盘、不问别人，所以别的进程同时往这个 inbox 写也不会撞名。
    let recordId: string;
    try {
      recordId = this.newRecordId();
    } catch (e) {
      // 时间戳宽度溢出（公元 10889 年之后）：也要有明确结局——封账本、结构化拒绝，不把这条抛给调用方
      this.seal(errText(e));
      return this.reject([inboxRecordBrief(message)], "store-error", "record-id-overflow", errText(e));
    }
    const record: InboxRecordV1 = { recordId, dedupeKey, message, acceptedAt: Date.now() };
    if (this.store !== null) {
      try {
        await this.store.write(recordPath(recordId), serializeRecord(record));
      } catch (e) {
        // 原文只进本地诊断；协议里给的是**真 digest**，不是截断的错误文本
        this.diagnose("inbox_write_failed", `record ${recordId} 落盘失败：${errText(e)}`);
        return this.reject([inboxRecordBrief(message)], "store-error", await errorDigest(errText(e)), errText(e));
      }
    }
    this.pending.push(record);
    this.indexPush(dedupeKey, recordId);
    this.fact({ kind: "accepted", records: [inboxRecordBrief(message, recordId)], deduplicated: false, via: "deliver" });
    return { kind: "accepted", recordId, dedupeKey, deduplicated: false };
  }

  /** 结构化拒绝 + 一条 rejected 事实：原文只进事实的 content 档（metadata 只留 digest），协议里仍是 errorDigest。 */
  private reject(records: readonly InboxRecordBrief[], reason: "invalid-request" | "store-error", errorDigest: string, message?: string): InboxAcceptOutcome {
    this.fact({ kind: "rejected", records, reason, errorDigest, ...(message === undefined ? {} : { message }) });
    return { kind: "rejected", reason, errorDigest };
  }

  /* ─────────────── reservation ledger ─────────────── */

  /** 把当前 pending **整批** reserve 出来。新到的 delivery 不并入已 reserve 的批，只能进下一批。 */
  reserveBatch(): InboxReservedBatch | null {
    this.assertNotSealed("reserveBatch");
    if (this.pending.length === 0) return null;
    const batch = this.pending;
    this.pending = [];
    const reservationId = `rsv:${crypto.randomUUID()}`;
    this.reservations.set(reservationId, batch);
    return { reservationId, recordIds: batch.map((r) => r.recordId), messages: batch.map((r) => r.message) };
  }

  /** admission 在创建 ticket 前同步核对：存在、未消费、record 集合与顺序**完全相等**。抛 = 编程不变量破坏。 */
  assertReserved(reservationId: string, orderedRecordIds: readonly string[]): void {
    const batch = this.reservations.get(reservationId);
    if (batch === undefined) throw new Error(`inbox reservation '${reservationId}' 不存在或已消费`);
    if (batch.length !== orderedRecordIds.length || batch.some((r, i) => r.recordId !== orderedRecordIds[i])) {
      throw new Error(`inbox reservation '${reservationId}' 的 record 集合/顺序与 request 不一致`);
    }
  }

  /**
   * 这批交给了哪条 run：`consumeInbox` 的 executor 进 loop 之前调，事实**落在那条 run 里**
   * （此刻 Agent 的 scope 供给已带 runId），run 的时间线由此能回答「谁的哪几条消息触发的」。
   */
  noteConsumed(reservationId: string, runId: string): void {
    const batch = this.reservations.get(reservationId);
    if (batch === undefined) return;
    this.fact({ kind: "consumed", records: batch.map((r) => inboxRecordBrief(r.message, r.recordId)), reservationId, runId });
  }

  /** 整批放回 pending 队头（原序）：durable facts 一条不丢，dedupe index 不动（它们仍在盘上）。`reason` 只进观测。 */
  releaseBatch(reservationId: string, reason: "run-rejected" | "enqueue-failed" | "ack-pre-commit" | "released" = "released", runId?: string): void {
    const batch = this.reservations.get(reservationId);
    if (batch === undefined) return;
    this.reservations.delete(reservationId);
    this.pending = [...batch, ...this.pending];
    this.fact({ kind: "released", records: batch.map((r) => inboxRecordBrief(r.message, r.recordId)), reservationId, reason, ...(runId === undefined ? {} : { runId }) });
  }

  /**
   * 整批 ack。**marker 写入是唯一线性化点**：
   *   write 成功 → committed；write 失败 → 对同一 bytes 做 read-after-error 三态裁决
   *   （逐字相同 = committed；明确 not-found = pre-commit；读失败 / 坏档 / 不同内容 = indeterminate → seal）。
   * commit 之前禁止 remove 任何 record、禁止更新 dedupe index；commit 之后整批在逻辑上已 ack，
   * 后续 record/marker 删除只是可恢复 cleanup，失败也**不能把 batch 改回 pending**。
   */
  async ackBatch(reservationId: string, opts: Readonly<{ runId?: string }> = {}): Promise<void> {
    this.assertNotSealed("ackBatch");
    const batch = this.reservations.get(reservationId);
    if (batch === undefined) return; // 幂等：已经 ack 过
    const recordIds = batch.map((r) => r.recordId);
    const acked: Omit<InboxFact, "occurredAt"> = { kind: "acked", records: batch.map((r) => inboxRecordBrief(r.message, r.recordId)), reservationId, ...(opts.runId === undefined ? {} : { runId: opts.runId }) };
    const store = this.store;
    if (store === null) {
      this.closeReservation(reservationId, recordIds);
      this.fact(acked);
      return;
    }

    // **barrier 必须在任何 await 之前立起来**（review 2026-09-07）：keys 在拿到 batch 那一刻就全知道了，
    // 不用等 ackCommitId。立晚了，`ackCommitIdOf` 那个 await 的窗口里同 key 的 accept 会 dedupe 到
    // 即将被删的旧 record——新事实从来没有自己的 record，永久消失。marker 落盘与 write 返回之间同理。
    const keys = new Set(batch.map((r) => r.dedupeKey));
    let releaseBarrier = (): void => {};
    const barrier = new Promise<void>((r) => {
      releaseBarrier = r;
    });
    for (const k of keys) this.ackBarriers.set(k, barrier);
    try {
      const ackCommitId = await ackCommitIdOf(recordIds);
      const bytes = serializeAckCommit({ ackCommitId, recordIds, committedAt: Date.now() });
      const path = ackPath(ackCommitId);
      return await this.commitAck(reservationId, recordIds, ackCommitId, bytes, path, store, acked);
    } finally {
      // 先摘 barrier 再放行：被唤醒的 accept 不能再看到这条已经裁决完的 barrier
      for (const k of keys) if (this.ackBarriers.get(k) === barrier) this.ackBarriers.delete(k);
      releaseBarrier();
    }
  }

  private async commitAck(
    reservationId: string,
    recordIds: readonly string[],
    ackCommitId: string,
    bytes: string,
    path: string,
    store: StorageDir,
    acked: Omit<InboxFact, "occurredAt">,
  ): Promise<void> {
    try {
      await store.write(path, bytes);
    } catch (writeError) {
      // reservation 仍 pinned、intake 仍禁止继续推进的状态下裁决
      let got: string | null;
      try {
        got = await store.read(path);
      } catch (readError) {
        this.seal(`inbox 整批 ack 无法裁决（marker read-after-error 失败）：${errText(readError)}`);
        throw new InboxAckError("indeterminate", this.sealedReason!);
      }
      if (got === null) {
        // **只能由明确 not-found 得出**：整批与 dedupe index 原样 pending
        this.releaseBatch(reservationId, "ack-pre-commit", acked.runId);
        throw new InboxAckError("pre-commit", `inbox 整批 ack 未提交（marker 未落盘）：${errText(writeError)}——整批仍 pending，可重新 reserve`);
      }
      if (got !== bytes) {
        // 不同内容 = corruption / ackCommitId collision：不覆盖、不删除、不修补，只记安全元数据
        this.seal(`inbox ack marker ${path} 内容与本批不一致（expected ${ackCommitId}）——corruption 或 id collision`);
        throw new InboxAckError("indeterminate", this.sealedReason!);
      }
    }

    // committed：同一 critical section 关闭 reservation + 一次性移除整批 index
    this.closeReservation(reservationId, recordIds);
    this.fact(acked);
    for (const id of recordIds) this.notForRefresh.add(id); // 已逻辑 ack：下面删不掉也不许 refresh 再收
    // 可恢复 cleanup：幂等删 record，**确认整批都不存在了**才删 marker
    let allGone = true;
    for (const id of recordIds) {
      try {
        await store.remove(recordPath(id));
      } catch (e) {
        allGone = false;
        this.diagnose("inbox_cleanup_pending", `record ${id} 删除失败（整批已逻辑 ack，不会重投）：${errText(e)}`);
      }
    }
    if (!allGone) return; // marker 留着，下次 restore 接着清
    try {
      await store.remove(path);
    } catch (e) {
      this.diagnose("inbox_cleanup_pending", `ack marker ${ackCommitId} 删除失败，下次 restore 继续：${errText(e)}`);
    }
  }

  /**
   * 清空**未 reserve 的** pending（盘上留着，下次 restore 重放；本进程的 `refresh()` 不再把它们捡回来）。
   * 已 reserve 的批不动。
   */
  clear(): void {
    for (const r of this.pending) {
      this.indexDrop(r.dedupeKey, r.recordId);
      this.notForRefresh.add(r.recordId);
    }
    this.pending = [];
  }

  /* ─────────────── 内部 ─────────────── */

  private closeReservation(reservationId: string, recordIds: readonly string[]): void {
    this.reservations.delete(reservationId);
    const byId = new Map<string, string>();
    for (const [key, ids] of this.index) for (const id of ids) byId.set(id, key);
    for (const id of recordIds) {
      const key = byId.get(id);
      if (key !== undefined) this.indexDrop(key, id);
    }
  }

  private indexPush(dedupeKey: string, recordId: string): void {
    const ids = this.index.get(dedupeKey);
    if (ids === undefined) this.index.set(dedupeKey, [recordId]);
    else ids.push(recordId);
  }

  private indexDrop(dedupeKey: string, recordId: string): void {
    const ids = this.index.get(dedupeKey);
    if (ids === undefined) return;
    const next = ids.filter((id) => id !== recordId);
    if (next.length === 0) this.index.delete(dedupeKey);
    else this.index.set(dedupeKey, next);
  }

  private seal(reason: string): void {
    if (this.sealedReason === null) {
      this.sealedReason = reason;
      this.fact({ kind: "sealed", records: [], message: reason });
    }
    this.diagnose("inbox_sealed", reason);
  }

  private assertNotSealed(where: string): void {
    if (this.sealedReason !== null) throw new Error(`inbox 已封（${where} 拒绝）：${this.sealedReason}`);
  }

  private diagnose(code: string, message: string): void {
    this.onDiagnostic?.({ code, message });
  }
}
