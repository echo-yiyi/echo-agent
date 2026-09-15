// 投影的通用预算工具：按 canonical 字节截断正文、估算载荷大小。各发口的 descriptor 共用这一把尺，
// 「投影出来的正文不会自己成为整条记录超预算的原因」只在这里保证一次。
//
// 纯 Web-standard（不碰 `node:`）。

import { ObservationEncodingError, encodeCanonical, projectionEncodingLimits } from "./normalize.ts";
import { OBSERVATION_SYNC_LIMITS } from "./types.ts";

/**
 * content 档拼出的正文上限，单位是**canonical 字节**，且是从**整条 fact 的预算**里扣出来的。
 *
 * 起因（2026-08-27 review P2 实测）：上一版把它定成 64 KiB **code unit**，而整条投影的预算是
 * 64 KiB − 8 KiB envelope reserve，Runtime envelope 自己还有开销——50,000 chars accepted、60,000 dropped、
 * **70,000 被 projector 截断后照样 dropped**。也就是说 `textTruncated:true` 的记录必然过不了后续编码，
 * 那个标记只在 `projectAgentEvent()` 的单测里成立，穿过 Sequencer 就是假的。
 *
 * 保留额留给 body 其余字段（stopReason / 计数 / usage / model）与 fact 框架（name / scope / attributes）。
 * 结构化的载荷（工具参数、结果 metadata、进展、`toolUseBlocks[].input`）截不了半个，走 `fitPayload`：放得进才带。
 */
const PROJECTED_BODY_RESERVE = 8 * 1024;
export const MAX_PROJECTED_TEXT_BYTES = projectionEncodingLimits().maxBytes - PROJECTED_BODY_RESERVE;

/** 非代理区 code unit 在 canonical JSON 里的字节数**上界**（宁可高估，绝不低估——低估就等于又放行一条编不出来的记录）。 */
function jsonByteCost(c: number): number {
  if (c === 0x22 || c === 0x5c) return 2; // " 与 \ 转义成两字节
  if (c < 0x20) return 6; // 控制字符最坏 \uXXXX
  if (c < 0x80) return 1;
  if (c < 0x800) return 2;
  return 3; // BMP 非代理字符，UTF-8 三字节
}

const HI_MIN = 0xd800;
const HI_MAX = 0xdbff;
const LO_MIN = 0xdc00;
const LO_MAX = 0xdfff;

/**
 * 取 `s` 中 canonical 字节数不超过 `room` 的最长前缀。
 *
 * **代理区必须成对看**（2026-08-27 review P1 实测）：把所有 surrogate code unit 一律算 3 字节时，
 * 合法代理对（2 单位 6 ≥ 实际 4）没问题，但**孤立 surrogate** 会被 `JSON.stringify` 转义成 `\ud800`
 * ——实打实 6 字节，3 就是低估，`textTruncated:true` 的记录又编不出来了（复现：projectedTextLength=16384、
 * textTruncated=true、accepted=0）。所以合法对按 4 记并整体推进 2 个单位（也避免把对切成孤立 surrogate），
 * 孤立的高/低代理一律按 6 记。
 *
 * 扫描长度按 `room` 封顶——每个 code unit 至少 1 字节，扫过 `room` 个必然已经停了；
 * 否则一条 5 MB 的 text block 会让「按预算截断」自己变成 O(输入) 的无界工作。
 */
export function takePrefix(s: string, room: number): Readonly<{ text: string; used: number; truncated: boolean }> {
  const cap = s.length < room ? s.length : room;
  let cost = 0;
  let i = 0;
  while (i < cap) {
    const c = s.charCodeAt(i);
    let width = 1;
    let unit: number;
    if (c >= HI_MIN && c <= HI_MAX && i + 1 < s.length && s.charCodeAt(i + 1) >= LO_MIN && s.charCodeAt(i + 1) <= LO_MAX) {
      width = 2;
      unit = 4; // 合法代理对：UTF-8 四字节
    } else if (c >= HI_MIN && c <= LO_MAX) {
      unit = 6; // 孤立高/低代理：`\udXXX`
    } else {
      unit = jsonByteCost(c);
    }
    if (cost + unit > room) break;
    cost += unit;
    i += width;
  }
  return i < s.length ? { text: s.slice(0, i), used: cost, truncated: true } : { text: s, used: cost, truncated: false };
}

/**
 * content 档要原样带的结构化载荷：canonical 字节数不超过 `room` 就带，超了就不带（只标 omitted）。
 * 结构化的值截不了半个；而带着一份注定超预算的值交给观测线程，主线程白做一次结构化拷贝，那边还是整条判成缺口（2026-09-14）。
 * 编码按 `room` 封顶，超了立即停，不是 O(输入)；坏 shape 也只算放不进，不抛。
 */
export function fitPayload(value: unknown, room: number): Readonly<{ fits: boolean; bytes: number }> {
  if (room <= 0) return { fits: false, bytes: 0 };
  try {
    const enc = encodeCanonical(value, {
      maxBytes: room,
      maxValueDepth: OBSERVATION_SYNC_LIMITS.maxValueDepth,
      maxValueNodes: OBSERVATION_SYNC_LIMITS.maxValueNodes,
      maxBlobChunkBytes: 0,
    });
    return { fits: true, bytes: enc.bytes.byteLength };
  } catch {
    return { fits: false, bytes: 0 };
  }
}

/**
 * metadata 档的尺寸估算：走同一套 canonical 编码但只取字节数；达到同步上限即停、标 truncated——
 * 坏 shape / getter 抛错也只标 truncated，绝不让 Agent outcome 失败。
 * `payloadTruncated:false` 时 payloadBytes 是精确 canonical UTF-8 长度；true 时是已检查上限（lower bound）。
 */
export function estimatePayloadBytes(value: unknown): Readonly<{ payloadBytes: number; payloadTruncated: boolean }> {
  try {
    const enc = encodeCanonical(value, {
      maxBytes: OBSERVATION_SYNC_LIMITS.maxCanonicalDraftBytes,
      maxValueDepth: OBSERVATION_SYNC_LIMITS.maxValueDepth,
      maxValueNodes: OBSERVATION_SYNC_LIMITS.maxValueNodes,
      maxBlobChunkBytes: 0,
    });
    return { payloadBytes: enc.bytes.byteLength, payloadTruncated: false };
  } catch (e) {
    const bound = e instanceof ObservationEncodingError && e.code === "bytes_exceeded" ? OBSERVATION_SYNC_LIMITS.maxCanonicalDraftBytes : 0;
    return { payloadBytes: bound, payloadTruncated: true };
  }
}
