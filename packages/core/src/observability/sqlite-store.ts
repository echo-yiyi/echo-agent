// V0 唯一 canonical store：`bun:sqlite`（§15.4.2.2 / §15.4.2.3，O3a happy path）。
//
// 库固定在 `<stateRoot>/observability/observations.sqlite`；writer open 时验 WAL / NORMAL / foreign_keys / busy_timeout，
// 任一不满足就 fail-loud——不进 READY，不静默退到别的 journal mode。一个进程只有一条 writer connection，
// 所有写事务 `BEGIN IMMEDIATE` 串行；reader（observe CLI / 同进程查询）用独立的 read-only connection，只看已 COMMIT 快照。
//
// 裁决与 `InMemoryCanonicalObservationStore` 同一套（store.ts 头注）：一批 records + 受影响 RunIndex + runtime head
// 同事务全见或全不见；逐字等价的重复提交是 `already-committed-same`；bytes 不同 / 半批存在 / index digest 漂移是 corruption。
//
// **`bun:sqlite` 只在 `open()` 里动态 import**：根入口（`createEcho` 所在）在 Node 下也要能加载——分发门用 `new Agent`
// 在 Node 跑一次；顶层 import 会让整个包在 Node 下 import 即炸。O3a 不做 crash recovery / retention / reopen（O3b）。

import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { canonicalJsonBytes } from "./normalize.ts";
import { ObservationCorruptionError, runIndexDigest, type CanonicalObservationStore, type CommitBatchInput, type CommitBatchResult } from "./store.ts";
import type { ObservationValue, RunIndexEntryV1, RunObservationHeader } from "./types.ts";

/** 库文件相对 state root 的固定位置（§15.4.2.2）。 */
export const OBSERVATION_DB_RELATIVE_PATH = join("observability", "observations.sqlite");
/** 当前 schema 版本。同版本只能加 optional 字段（§15.4.3）；旧库版本更高 = 本进程太旧，fail-loud。 */
export const OBSERVATION_SCHEMA_VERSION = 1;
/** `path_digest_key` 的固定长度（§15.9：Memory path 的 HMAC key，随库首次创建，之后永不改写）。 */
export const PATH_DIGEST_KEY_BYTES = 32;
const DEFAULT_BUSY_TIMEOUT_MS = 5_000;

/**
 * 本文件用到的 `bun:sqlite` `Database` 子集。**不 import 它的类型**：.d.ts 里一出现 `bun:sqlite`，
 * 没装 `@types/bun` 的 Node 消费者连根入口都编译不过（分发门的 examples 走的正是普通 tsconfig）。
 */
type SqliteStatement<R, P extends unknown[]> = Readonly<{
  get(...params: P): R | null;
  all(...params: P): R[];
  run(...params: P): unknown;
}>;
type SqliteDatabase = Readonly<{
  query<R, P extends unknown[] = []>(sql: string): SqliteStatement<R, P>;
  run(sql: string): unknown;
  exec(sql: string): unknown;
  close(): void;
}>;

/** `<stateRoot>/observability/observations.sqlite`。 */
export function observationDatabasePath(stateRoot: string): string {
  return join(stateRoot, OBSERVATION_DB_RELATIVE_PATH);
}

/** reader 打开时库文件不存在：这个 state root 还没记录过任何 run。与 corruption 分开——那是「有东西但坏了」。 */
export class ObservationDatabaseMissingError extends Error {
  readonly code = "observation_database_missing";
  constructor(readonly path: string) {
    super(`observation database not found: ${path}`);
    this.name = "ObservationDatabaseMissingError";
  }
}

/** writer open 时 PRAGMA / schema / key 任一不满足：完整 Runtime 不进入 READY（§15.4.2.2）。 */
export class ObservationStoreOpenError extends Error {
  readonly code = "observation_store_open_failed";
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ObservationStoreOpenError";
  }
}

export type SqliteObservationOpenOptions = Readonly<{
  path: string;
  /** 有界 busy_timeout（毫秒）。缺省 5s；不允许无上限等待（§15.12）。 */
  busyTimeoutMs?: number;
}>;

/** `listRunIndex` 的分页游标：`(acceptedAt, runId)` 倒序稳定分页（§15.6.1）。 */
export type RunIndexCursor = Readonly<{ acceptedAt: number; runId: string }>;

export type RuntimeHeadRow = Readonly<{ runtimeId: string; committedPrefix: number }>;

const DDL = `
CREATE TABLE observation_schema (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL
);
CREATE TABLE observation_private_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  path_digest_key BLOB NOT NULL
);
CREATE TABLE observation_runtime_heads (
  runtime_id TEXT PRIMARY KEY,
  committed_prefix INTEGER NOT NULL
);
CREATE TABLE observation_records (
  runtime_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  record_id TEXT NOT NULL UNIQUE,
  run_id TEXT,
  envelope_bytes BLOB NOT NULL,
  byte_length INTEGER NOT NULL,
  PRIMARY KEY (runtime_id, seq)
);
CREATE INDEX observation_records_run ON observation_records (runtime_id, run_id, seq);
CREATE TABLE observation_run_index (
  run_id TEXT PRIMARY KEY,
  runtime_id TEXT NOT NULL,
  accepted_record_id TEXT NOT NULL REFERENCES observation_records (record_id) DEFERRABLE INITIALLY DEFERRED,
  started_record_id TEXT REFERENCES observation_records (record_id) DEFERRABLE INITIALLY DEFERRED,
  terminal_record_id TEXT REFERENCES observation_records (record_id) DEFERRABLE INITIALLY DEFERRED,
  accepted_at INTEGER NOT NULL,
  first_seq INTEGER NOT NULL,
  last_seq INTEGER NOT NULL,
  body_state TEXT NOT NULL CHECK (body_state IN ('retained', 'pruned')),
  pruned_at INTEGER,
  header_bytes BLOB NOT NULL,
  index_digest TEXT NOT NULL
);
CREATE INDEX observation_run_index_accepted ON observation_run_index (accepted_at, run_id);
`;

type RunIndexRow = {
  run_id: string;
  runtime_id: string;
  accepted_record_id: string;
  started_record_id: string | null;
  terminal_record_id: string | null;
  accepted_at: number;
  first_seq: number;
  last_seq: number;
  body_state: string;
  pruned_at: number | null;
  header_bytes: Uint8Array;
  index_digest: string;
};

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** bun:sqlite 的 BLOB 回来可能是 Buffer 子类；统一成裸 Uint8Array，避免比较 / 序列化时的类型分歧。 */
function asBytes(v: unknown, what: string): Uint8Array {
  if (v instanceof Uint8Array) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  throw new ObservationCorruptionError(`${what} 不是 BLOB（实际 ${typeof v}）`);
}

function decodeHeader(bytes: Uint8Array, runId: string): RunObservationHeader {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (e) {
    throw new ObservationCorruptionError(`RunIndex(${runId}) header bytes 不是合法 JSON：${e instanceof Error ? e.message : String(e)}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ObservationCorruptionError(`RunIndex(${runId}) header 不是对象`);
  }
  return parsed as RunObservationHeader;
}

function rowToEntry(row: RunIndexRow): RunIndexEntryV1 {
  const header = decodeHeader(asBytes(row.header_bytes, `RunIndex(${row.run_id}).header_bytes`), row.run_id);
  const bodyState = row.body_state;
  if (bodyState !== "retained" && bodyState !== "pruned") throw new ObservationCorruptionError(`RunIndex(${row.run_id}) body_state 非法：${bodyState}`);
  const entry: RunIndexEntryV1 = {
    schemaVersion: 1,
    runtimeId: row.runtime_id,
    runId: row.run_id,
    acceptedRecordId: row.accepted_record_id,
    ...(row.started_record_id === null ? {} : { startedRecordId: row.started_record_id }),
    ...(row.terminal_record_id === null ? {} : { terminalRecordId: row.terminal_record_id }),
    header,
    firstSeq: row.first_seq,
    lastSeq: row.last_seq,
    bodyState,
    ...(row.pruned_at === null ? {} : { prunedAt: row.pruned_at }),
  };
  // 列 + header bytes 重组出来的 entry 必须与写入时的 digest 逐字一致：任何列被改过都在这里判红，reader 不「修复」。
  const digest = runIndexDigest(entry);
  if (digest !== row.index_digest) {
    throw new ObservationCorruptionError(`RunIndex(${row.run_id}) digest 漂移：行存 ${row.index_digest}，重组得 ${digest}`);
  }
  return entry;
}

const RUN_INDEX_COLUMNS =
  "run_id, runtime_id, accepted_record_id, started_record_id, terminal_record_id, accepted_at, first_seq, last_seq, body_state, pruned_at, header_bytes, index_digest";

/**
 * 只读面：writer 与 reader 共用。reader connection 是 `readonly`，只看已 COMMIT 快照，不取 StateLock、不写任何查询状态。
 *
 * 每个方法一个短查询：拷出 bytes 就结束，decode 在外面做（§15.6.1「reader transaction 必须短」）。
 */
export class SqliteObservationReader {
  protected closed = false;

  protected constructor(
    protected readonly db: SqliteDatabase,
    readonly path: string,
  ) {}

  /** reader 打开：文件不存在 → `ObservationDatabaseMissingError`；schema 不认识 → fail-loud。 */
  static async openReadOnly(opts: SqliteObservationOpenOptions): Promise<SqliteObservationReader> {
    const { Database } = await import("bun:sqlite");
    let db: SqliteDatabase;
    try {
      db = new Database(opts.path, { readonly: true, create: false, strict: true }) as unknown as SqliteDatabase;
    } catch (e) {
      if (isMissingDatabase(e)) throw new ObservationDatabaseMissingError(opts.path);
      throw new ObservationStoreOpenError(`open read-only observation database failed: ${opts.path}`, { cause: e });
    }
    try {
      db.run(`PRAGMA busy_timeout = ${opts.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS}`);
      assertSchema(db, "reader");
    } catch (e) {
      db.close();
      throw e;
    }
    return new SqliteObservationReader(db, opts.path);
  }

  async readRecordBytes(recordId: string): Promise<Uint8Array | null> {
    const row = this.db.query<{ envelope_bytes: Uint8Array }, [string]>("SELECT envelope_bytes FROM observation_records WHERE record_id = ?").get(recordId);
    return row === null ? null : asBytes(row.envelope_bytes, `record(${recordId}).envelope_bytes`);
  }

  async readRunIndex(runId: string): Promise<RunIndexEntryV1 | null> {
    const row = this.db.query<RunIndexRow, [string]>(`SELECT ${RUN_INDEX_COLUMNS} FROM observation_run_index WHERE run_id = ?`).get(runId);
    return row === null ? null : rowToEntry(row);
  }

  async readCommittedPrefix(runtimeId: string): Promise<number> {
    const row = this.db.query<{ committed_prefix: number }, [string]>("SELECT committed_prefix FROM observation_runtime_heads WHERE runtime_id = ?").get(runtimeId);
    return row === null ? 0 : row.committed_prefix;
  }

  /** 一个 run 在 `[firstSeq, lastSeq]` 内落库的全部 record bytes，按 seq 升序。hole（gap 覆盖的 seq）自然不在其中。 */
  async readRunRecords(runtimeId: string, runId: string, firstSeq: number, lastSeq: number): Promise<readonly Uint8Array[]> {
    const rows = this.db
      .query<{ envelope_bytes: Uint8Array }, [string, string, number, number]>(
        "SELECT envelope_bytes FROM observation_records WHERE runtime_id = ? AND run_id = ? AND seq BETWEEN ? AND ? ORDER BY seq ASC",
      )
      .all(runtimeId, runId, firstSeq, lastSeq);
    return rows.map((r, i) => asBytes(r.envelope_bytes, `run(${runId}) record #${i}.envelope_bytes`));
  }

  /** 某个 runtime 在 `(afterSeq, afterSeq + limit]` 内的 record bytes（live subscribe 的 replay 页）。 */
  async readRecordsAfter(runtimeId: string, afterSeq: number, limit: number): Promise<readonly Uint8Array[]> {
    const rows = this.db
      .query<{ envelope_bytes: Uint8Array }, [string, number, number]>(
        "SELECT envelope_bytes FROM observation_records WHERE runtime_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?",
      )
      .all(runtimeId, afterSeq, limit);
    return rows.map((r, i) => asBytes(r.envelope_bytes, `runtime(${runtimeId}) record #${i}.envelope_bytes`));
  }

  /** 按 `(accepted_at, run_id)` 倒序分页；`after` 是上一页最后一条的游标（exclusive）。 */
  async listRunIndex(opts: Readonly<{ limit: number; after?: RunIndexCursor }>): Promise<readonly RunIndexEntryV1[]> {
    const limit = Math.max(1, Math.floor(opts.limit));
    const rows =
      opts.after === undefined
        ? this.db.query<RunIndexRow, [number]>(`SELECT ${RUN_INDEX_COLUMNS} FROM observation_run_index ORDER BY accepted_at DESC, run_id DESC LIMIT ?`).all(limit)
        : this.db
            .query<RunIndexRow, [number, number, string, number]>(
              `SELECT ${RUN_INDEX_COLUMNS} FROM observation_run_index WHERE accepted_at < ? OR (accepted_at = ? AND run_id < ?) ORDER BY accepted_at DESC, run_id DESC LIMIT ?`,
            )
            .all(opts.after.acceptedAt, opts.after.acceptedAt, opts.after.runId, limit);
    return rows.map(rowToEntry);
  }

  async readRuntimeHeads(): Promise<readonly RuntimeHeadRow[]> {
    return this.db
      .query<{ runtime_id: string; committed_prefix: number }, []>("SELECT runtime_id, committed_prefix FROM observation_runtime_heads ORDER BY runtime_id")
      .all()
      .map((r) => ({ runtimeId: r.runtime_id, committedPrefix: r.committed_prefix }));
  }

  async countRecords(): Promise<number> {
    return this.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM observation_records").get()?.n ?? 0;
  }

  async countRuns(): Promise<number> {
    return this.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM observation_run_index").get()?.n ?? 0;
  }

  /** 关 connection。幂等。observe CLI 每条命令结束都必须调（§15.6.1）。 */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}

/**
 * writer：Sequencer 之下的唯一持久层。`open()` = open + PRAGMA 验证 + migrate + `path_digest_key`。
 */
export class SqliteCanonicalObservationStore extends SqliteObservationReader implements CanonicalObservationStore {
  private constructor(db: SqliteDatabase, path: string) {
    super(db, path);
  }

  static async open(opts: SqliteObservationOpenOptions): Promise<SqliteCanonicalObservationStore> {
    const { Database } = await import("bun:sqlite");
    mkdirSync(dirname(opts.path), { recursive: true });
    let db: SqliteDatabase;
    try {
      db = new Database(opts.path, { create: true, readwrite: true, strict: true }) as unknown as SqliteDatabase;
    } catch (e) {
      throw new ObservationStoreOpenError(`open observation database failed: ${opts.path}`, { cause: e });
    }
    try {
      applyWriterPragmas(db, opts.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS);
      migrate(db);
    } catch (e) {
      db.close();
      throw e;
    }
    return new SqliteCanonicalObservationStore(db, opts.path);
  }

  /** 本 state root 的 Memory path HMAC key。只供 writer 侧 projection（§15.9），永不进 envelope / reader / export。 */
  readPathDigestKey(): Uint8Array {
    const row = this.db.query<{ path_digest_key: Uint8Array }, []>("SELECT path_digest_key FROM observation_private_meta WHERE id = 1").get();
    if (row === null) throw new ObservationCorruptionError("observation_private_meta 缺 path_digest_key");
    const key = asBytes(row.path_digest_key, "path_digest_key");
    if (key.byteLength !== PATH_DIGEST_KEY_BYTES) throw new ObservationCorruptionError(`path_digest_key 长度错误：${key.byteLength}`);
    return key;
  }

  /**
   * §15.4.2.3：一个 `BEGIN IMMEDIATE` 事务里做三件事——插 records、按 expected digest 校验并写 RunIndex、CAS 推进 head。
   * 任何校验失败抛 `ObservationCorruptionError` 并 ROLLBACK；SQLite 自己的错误（busy / I/O）原样抛给 Sequencer 做 read-after-error。
   */
  async commitBatchIfAbsent(input: CommitBatchInput): Promise<CommitBatchResult> {
    const db = this.db;
    db.run("BEGIN IMMEDIATE");
    try {
      const result = this.commitInTransaction(input);
      db.run("COMMIT");
      return result;
    } catch (e) {
      try {
        db.run("ROLLBACK");
      } catch {
        // 事务已经不在（COMMIT 阶段失败时 SQLite 可能已自动回滚）：只报原错
      }
      throw e;
    }
  }

  private commitInTransaction(input: CommitBatchInput): CommitBatchResult {
    const db = this.db;
    const readBytes = db.query<{ envelope_bytes: Uint8Array }, [string]>("SELECT envelope_bytes FROM observation_records WHERE record_id = ?");
    const states = input.records.map((r) => {
      const row = readBytes.get(r.recordId);
      if (row === null) return "absent" as const;
      return bytesEqual(asBytes(row.envelope_bytes, `record(${r.recordId}).envelope_bytes`), r.canonicalEnvelopeBytes) ? ("same" as const) : ("mismatch" as const);
    });
    if (states.some((s) => s === "mismatch")) {
      throw new ObservationCorruptionError("recordId 已存在但 canonical bytes 不同（ID collision / corruption）");
    }
    const allSame = states.length > 0 && states.every((s) => s === "same");
    const allAbsent = states.every((s) => s === "absent");
    if (!allSame && !allAbsent) throw new ObservationCorruptionError("同一批 records 部分存在：半批可见");

    const headRow = db.query<{ committed_prefix: number }, [string]>("SELECT committed_prefix FROM observation_runtime_heads WHERE runtime_id = ?").get(input.runtimeId);
    const head = headRow === null ? 0 : headRow.committed_prefix;
    const readIndex = db.query<RunIndexRow, [string]>(`SELECT ${RUN_INDEX_COLUMNS} FROM observation_run_index WHERE run_id = ?`);

    if (allSame) {
      if (head !== input.nextCommittedPrefix) {
        throw new ObservationCorruptionError(`records 已在但 head=${head} ≠ next=${input.nextCommittedPrefix}`);
      }
      for (const m of input.runIndexMutations) {
        const cur = readIndex.get(m.runId);
        if (cur === null || cur.index_digest !== runIndexDigest(m.nextRunIndex)) {
          throw new ObservationCorruptionError(`records 已在但 RunIndex(${m.runId}) 与 next 不等价`);
        }
      }
      return "already-committed-same";
    }

    if (head !== input.expectedCommittedPrefix) {
      throw new ObservationCorruptionError(`committed prefix CAS 失败：期望 ${input.expectedCommittedPrefix}，实际 ${head}`);
    }
    for (const m of input.runIndexMutations) {
      const cur = readIndex.get(m.runId);
      const curDigest = cur === null ? null : cur.index_digest;
      if (curDigest !== m.expectedRunIndexDigest) {
        throw new ObservationCorruptionError(`RunIndex(${m.runId}) digest 漂移：期望 ${String(m.expectedRunIndexDigest)}，实际 ${String(curDigest)}`);
      }
    }

    const insertRecord = db.query<void, [string, number, string, string | null, Uint8Array, number]>(
      "INSERT INTO observation_records (runtime_id, seq, record_id, run_id, envelope_bytes, byte_length) VALUES (?, ?, ?, ?, ?, ?)",
    );
    for (const r of input.records) {
      insertRecord.run(r.runtimeId, r.seq, r.recordId, r.runId ?? null, r.canonicalEnvelopeBytes, r.canonicalEnvelopeBytes.byteLength);
    }
    const upsertIndex = db.query<void, [string, string, string, string | null, string | null, number, number, number, string, number | null, Uint8Array, string]>(
      `INSERT INTO observation_run_index (${RUN_INDEX_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (run_id) DO UPDATE SET
         runtime_id = excluded.runtime_id,
         accepted_record_id = excluded.accepted_record_id,
         started_record_id = excluded.started_record_id,
         terminal_record_id = excluded.terminal_record_id,
         accepted_at = excluded.accepted_at,
         first_seq = excluded.first_seq,
         last_seq = excluded.last_seq,
         body_state = excluded.body_state,
         pruned_at = excluded.pruned_at,
         header_bytes = excluded.header_bytes,
         index_digest = excluded.index_digest`,
    );
    for (const m of input.runIndexMutations) {
      const e = m.nextRunIndex;
      upsertIndex.run(
        e.runId,
        e.runtimeId,
        e.acceptedRecordId,
        e.startedRecordId ?? null,
        e.terminalRecordId ?? null,
        e.header.acceptedAt,
        e.firstSeq,
        e.lastSeq,
        e.bodyState,
        e.prunedAt ?? null,
        canonicalJsonBytes(e.header as unknown as ObservationValue),
        runIndexDigest(e),
      );
    }
    db.query<void, [string, number]>(
      "INSERT INTO observation_runtime_heads (runtime_id, committed_prefix) VALUES (?, ?) ON CONFLICT (runtime_id) DO UPDATE SET committed_prefix = excluded.committed_prefix",
    ).run(input.runtimeId, input.nextCommittedPrefix);
    return "committed";
  }
}

function isMissingDatabase(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  const code = (e as { code?: unknown }).code;
  return code === "SQLITE_CANTOPEN" || /unable to open database file/i.test(msg) || /ENOENT/.test(msg);
}

function pragmaValue<T>(db: SqliteDatabase, sql: string): T | undefined {
  const row = db.query<Record<string, T>, []>(sql).get();
  if (row === null) return undefined;
  const values = Object.values(row);
  return values[0];
}

/** §15.4.2.2 固定验证：WAL / NORMAL / foreign_keys / bounded busy_timeout。不满足 = 不进 READY。 */
function applyWriterPragmas(db: SqliteDatabase, busyTimeoutMs: number): void {
  const journal = pragmaValue<string>(db, "PRAGMA journal_mode = WAL");
  if (typeof journal !== "string" || journal.toLowerCase() !== "wal") {
    throw new ObservationStoreOpenError(`journal_mode 不是 WAL（实际 ${String(journal)}）：这个文件系统不支持所需的 locking，拒绝进入 READY`);
  }
  db.run("PRAGMA synchronous = NORMAL");
  const sync = pragmaValue<number>(db, "PRAGMA synchronous");
  if (sync !== 1) throw new ObservationStoreOpenError(`synchronous 不是 NORMAL（实际 ${String(sync)}）`);
  db.run("PRAGMA foreign_keys = ON");
  const fk = pragmaValue<number>(db, "PRAGMA foreign_keys");
  if (fk !== 1) throw new ObservationStoreOpenError("foreign_keys 打不开");
  if (!Number.isFinite(busyTimeoutMs) || busyTimeoutMs <= 0) throw new ObservationStoreOpenError(`busy_timeout 必须是有界正数：${busyTimeoutMs}`);
  db.run(`PRAGMA busy_timeout = ${Math.floor(busyTimeoutMs)}`);
}

function hasTable(db: SqliteDatabase, name: string): boolean {
  return db.query<{ name: string }, [string]>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== null;
}

function readSchemaVersion(db: SqliteDatabase): number {
  const row = db.query<{ version: number }, []>("SELECT version FROM observation_schema WHERE id = 1").get();
  if (row === null) throw new ObservationCorruptionError("observation_schema 表存在但没有版本行");
  return row.version;
}

/** reader 只认版本，不建表也不改 key。 */
function assertSchema(db: SqliteDatabase, who: "reader"): void {
  if (!hasTable(db, "observation_schema")) {
    throw new ObservationCorruptionError(`observation database 没有 schema 表（${who}）：不是 echo 的 observation 库，或者尚未完成首次建库`);
  }
  const version = readSchemaVersion(db);
  if (version !== OBSERVATION_SCHEMA_VERSION) {
    throw new ObservationStoreOpenError(`observation schema 版本 ${version} 不被本进程支持（只认 ${OBSERVATION_SCHEMA_VERSION}）`);
  }
}

/**
 * 新库：一个事务里建全部表 + 版本行 + 32 字节 `path_digest_key`。
 * 旧库：版本必须相等；已有 records 时 key 缺失 / 长度错误判 corruption；reopen 永不改写 key。
 */
function migrate(db: SqliteDatabase): void {
  if (!hasTable(db, "observation_schema")) {
    db.run("BEGIN IMMEDIATE");
    try {
      db.exec(DDL);
      db.query<void, [number]>("INSERT INTO observation_schema (id, version) VALUES (1, ?)").run(OBSERVATION_SCHEMA_VERSION);
      db.query<void, [Uint8Array]>("INSERT INTO observation_private_meta (id, path_digest_key) VALUES (1, ?)").run(crypto.getRandomValues(new Uint8Array(PATH_DIGEST_KEY_BYTES)));
      db.run("COMMIT");
    } catch (e) {
      try {
        db.run("ROLLBACK");
      } catch {
        // 见 commitBatchIfAbsent
      }
      throw new ObservationStoreOpenError("observation schema 建库失败", { cause: e });
    }
    return;
  }
  const version = readSchemaVersion(db);
  if (version !== OBSERVATION_SCHEMA_VERSION) {
    throw new ObservationStoreOpenError(`observation schema 版本 ${version} 不被本进程支持（只认 ${OBSERVATION_SCHEMA_VERSION}）`);
  }
  for (const t of ["observation_private_meta", "observation_runtime_heads", "observation_records", "observation_run_index"]) {
    if (!hasTable(db, t)) throw new ObservationCorruptionError(`observation schema 版本 ${version} 却缺表 ${t}`);
  }
  const key = db.query<{ path_digest_key: Uint8Array }, []>("SELECT path_digest_key FROM observation_private_meta WHERE id = 1").get();
  const records = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM observation_records").get()?.n ?? 0;
  if (key === null) {
    if (records > 0) throw new ObservationCorruptionError("已有 observation records 但 path_digest_key 缺失：key 被改写过，历史关联无法恢复");
    db.query<void, [Uint8Array]>("INSERT INTO observation_private_meta (id, path_digest_key) VALUES (1, ?)").run(crypto.getRandomValues(new Uint8Array(PATH_DIGEST_KEY_BYTES)));
    return;
  }
  if (asBytes(key.path_digest_key, "path_digest_key").byteLength !== PATH_DIGEST_KEY_BYTES) {
    throw new ObservationCorruptionError(`path_digest_key 长度错误（${asBytes(key.path_digest_key, "path_digest_key").byteLength} ≠ ${PATH_DIGEST_KEY_BYTES}）`);
  }
}
