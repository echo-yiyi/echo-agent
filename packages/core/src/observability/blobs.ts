// 观测正文的 blob（观测白盒化 §4，docs/decisions/proposed/2026-11-03-observation-white-box.md）。
//
// 单条记录有 64 KiB 上限，system prompt、一条工具结果、一份工具菜单都可能比它大；`content` 档要能逐字节重建送进模型的东西，
// 正文就不能塞在记录里。做法：正文按内容寻址存成单独的文件，记录 body 里只放 `ObservationBlobRef`。
//
//   · 文件：`observability/blobs/<digest>.json`，内容 `{ schemaVersion: 1, writtenAt, text }`。`digest` 是 `text` 的
//     UTF-8 字节的 SHA-256；同一份正文只有一个文件。`writtenAt` 是**最近一次写入**的时刻，只给过期清扫用（见下）。
//   · 写：只在观测线程，**写完 blob 才把引用它的记录交给 Sequencer**——提交了的记录不会指向不存在的文件。
//   · 清扫（document-store.ts 的 `DocumentObservationExpiry`）：删掉剩下的记录都不再引用、且 `writtenAt` 早于宽限期的。
//     「写 blob」与「提交引用它的批」之间有一段空当，那时 blob 还没人引用；宽限期就是给这段空当的。写入端对同一份正文
//     **隔一段时间就重写一次**（`BLOB_REWRITE_AFTER_MS`），所以一份老正文被新记录再次引用之前，它的 `writtenAt` 已经是新的。
//     只要「重写间隔 + 提交延迟」远小于宽限期，清扫就删不到一个正要被引用的 blob。
//
// 本文件不 import `node:` 模块：观测线程与读面都用。

import { canonicalJson } from "./normalize.ts";
import { sha256Hex } from "./hash.ts";
import { OBSERVATION_BLOB_REFS, type ObservationBlobRef, type ObservationValue } from "./types.ts";

/** 正文是纯文本。 */
export const BLOB_TEXT = "text/plain";
/** 正文是一个 JSON 值（canonical：键排序，同一个值同一个 digest）。 */
export const BLOB_JSON = "application/json";

/** 写入端隔多久重写一次同一份正文（刷新 `writtenAt`）。 */
export const BLOB_REWRITE_AFTER_MS = 60 * 60_000;
/** 清扫的宽限期：`writtenAt` 比「此刻」早这么多以上、又没有记录引用的 blob 才删。 */
export const BLOB_SWEEP_GRACE_MS = 24 * 60 * 60_000;
/** 引用列表每块多少条：只增的序列（transcript）前面的块每次都一样，只有末尾那块是新的。 */
export const BLOB_REFS_CHUNK = 64;
/** 一次并发写几个 blob：续上的会话第一次送模会有成百上千条新消息，一起发会把文件句柄打满。 */
const WRITE_CONCURRENCY = 16;

const DIGEST = /^[0-9a-f]{64}$/;
const encoder = new TextEncoder();

/** 编好的一份正文：引用 + 要写进文件的文本。 */
export type EncodedBlob = Readonly<{ ref: ObservationBlobRef; text: string }>;

function encode(text: string, mediaType: string): EncodedBlob {
  const bytes = encoder.encode(text);
  return { ref: { digest: sha256Hex(bytes), size: bytes.byteLength, mediaType }, text };
}

/** 纯文本正文。 */
export function textBlob(text: string): EncodedBlob {
  return encode(text, BLOB_TEXT);
}

/**
 * JSON 正文：先按 `JSON.stringify` 的规则取值（丢 `undefined` 字段、非有限数成 null），再写成 canonical JSON。
 * 读回来 `JSON.parse` 就是那个值。
 */
export function jsonBlob(value: unknown): EncodedBlob {
  return encode(canonicalJson(JSON.parse(JSON.stringify(value)) as ObservationValue), BLOB_JSON);
}

/** 引用列表：正文是 `ObservationBlobRef[]`，读的人按顺序展开。 */
export function refsBlob(refs: readonly ObservationBlobRef[]): EncodedBlob {
  return encode(canonicalJson(refs as unknown as ObservationValue), OBSERVATION_BLOB_REFS);
}

/**
 * 一段很长的引用序列 → 一个引用：每 `BLOB_REFS_CHUNK` 条成一块引用列表，块再成一份引用列表（块多了再往上一层）。
 * 只增的序列前面的块内容不变、digest 不变，不会重写。`put` 收下每一块（交给 `BlobBatch.add`）。
 */
export function refsTree(refs: readonly ObservationBlobRef[], put: (blob: EncodedBlob) => ObservationBlobRef): ObservationBlobRef {
  let level = refs;
  for (;;) {
    if (level.length <= BLOB_REFS_CHUNK) return put(refsBlob(level));
    const next: ObservationBlobRef[] = [];
    for (let i = 0; i < level.length; i += BLOB_REFS_CHUNK) next.push(put(refsBlob(level.slice(i, i + BLOB_REFS_CHUNK))));
    level = next;
  }
}

/** blob 文件的内容。 */
export function blobFileContent(blob: EncodedBlob, writtenAt: number): string {
  return JSON.stringify({ schemaVersion: 1, writtenAt, text: blob.text });
}

/** 解析 blob 文件：形状不对返回 null（调用方决定算不算 corruption）。 */
export function parseBlobFile(content: string): Readonly<{ writtenAt: number; text: string }> | null {
  let v: unknown;
  try {
    v = JSON.parse(content);
  } catch {
    return null;
  }
  const f = v as { schemaVersion?: unknown; writtenAt?: unknown; text?: unknown } | null;
  if (f === null || typeof f !== "object" || f.schemaVersion !== 1 || typeof f.writtenAt !== "number" || typeof f.text !== "string") return null;
  return { writtenAt: f.writtenAt, text: f.text };
}

/** 文本的 digest 与字节数对不对得上引用。 */
export function blobMatches(ref: ObservationBlobRef, text: string): boolean {
  const bytes = encoder.encode(text);
  return bytes.byteLength === ref.size && sha256Hex(bytes) === ref.digest;
}

/** 像不像一个 blob 引用（清扫在记录 body 里找引用用）。 */
export function isBlobRef(v: unknown): v is ObservationBlobRef {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const r = v as { digest?: unknown; size?: unknown; mediaType?: unknown };
  return typeof r.digest === "string" && DIGEST.test(r.digest) && typeof r.size === "number" && (r.mediaType === undefined || typeof r.mediaType === "string");
}

/** 一个值里出现的全部 blob 引用（深度优先）。 */
export function collectBlobRefs(value: unknown, out: (ref: ObservationBlobRef) => void): void {
  if (typeof value !== "object" || value === null) return;
  if (isBlobRef(value)) {
    out(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectBlobRefs(v, out);
    return;
  }
  for (const v of Object.values(value)) collectBlobRefs(v, out);
}

/**
 * 观测线程里的写入端：记得哪些正文这个 runtime 已经写过、什么时候写的。同一份正文 `BLOB_REWRITE_AFTER_MS` 之内只写一次。
 * `write` 是落到存储上的那一步（写入端的 `DocumentObservationStore.writeBlob`）。
 */
export class BlobWriter {
  private readonly written = new Map<string, number>();

  constructor(
    private readonly write: (blob: EncodedBlob, writtenAt: number) => Promise<void>,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** 开一批：一条记录要的正文攒在一起，`commit()` 一次写完。 */
  batch(): BlobBatch {
    return new BlobBatch(this, this.now());
  }

  /** 这份正文在 `at` 这一刻还算不算「刚写过」。 */
  fresh(digest: string, at: number): boolean {
    const w = this.written.get(digest);
    return w !== undefined && at - w <= BLOB_REWRITE_AFTER_MS;
  }

  /** 写一批：并发有上限；全部写成才记成已写。任何一个失败就整体失败（调用方不提交引用）。 */
  async writeAll(blobs: readonly EncodedBlob[], at: number): Promise<void> {
    for (let i = 0; i < blobs.length; i += WRITE_CONCURRENCY) {
      await Promise.all(blobs.slice(i, i + WRITE_CONCURRENCY).map((b) => this.write(b, at)));
    }
    for (const b of blobs) this.written.set(b.ref.digest, at);
  }
}

/** `addCached` 的记忆：`Map` 与 `WeakMap` 都行。 */
export type BlobMemo<K> = { get(key: K): ObservationBlobRef | undefined; set(key: K, ref: ObservationBlobRef): unknown };

/**
 * 把一个引用按引用列表逐层展开成叶子正文（`refsTree` 的逆）。`read` 取正文（reader 的 `readBlob`）；
 * 哪一份不在了就返回 null。
 */
export async function expandBlobRefs(read: (ref: ObservationBlobRef) => Promise<string | null>, ref: ObservationBlobRef): Promise<ObservationBlobRef[] | null> {
  if (ref.mediaType !== OBSERVATION_BLOB_REFS) return [ref];
  const text = await read(ref);
  if (text === null) return null;
  const out: ObservationBlobRef[] = [];
  for (const child of JSON.parse(text) as ObservationBlobRef[]) {
    const leaves = await expandBlobRefs(read, child);
    if (leaves === null) return null;
    out.push(...leaves);
  }
  return out;
}

/** 一条记录要写的那些正文。 */
export class BlobBatch {
  private readonly due = new Map<string, EncodedBlob>();

  constructor(
    private readonly writer: BlobWriter,
    readonly at: number,
  ) {}

  /** 收下一份正文，返回它的引用；没写过（或该重写了）的排进这一批。 */
  add(blob: EncodedBlob): ObservationBlobRef {
    if (!this.writer.fresh(blob.ref.digest, this.at)) this.due.set(blob.ref.digest, blob);
    return blob.ref;
  }

  /**
   * 带记忆的 `add`：同一个键（transcript 里的消息对象、system 串的镜像编号）编过一次就记住引用，之后不再序列化、
   * 不再算 digest——除非它该重写了。
   */
  addCached<K>(memo: BlobMemo<K>, key: K, make: () => EncodedBlob): ObservationBlobRef {
    const known = memo.get(key);
    if (known !== undefined && this.writer.fresh(known.digest, this.at)) return known;
    const blob = make();
    memo.set(key, blob.ref);
    return this.add(blob);
  }

  /** 把排进来的写完。 */
  commit(): Promise<void> {
    return this.due.size === 0 ? Promise.resolve() : this.writer.writeAll([...this.due.values()], this.at);
  }
}
