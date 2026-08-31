// 包内共用的 digest。**只有一份**：拼接框架（分隔符 + 段长前缀）是协议的一部分，
// 两份实现迟早会在某一处少一个前缀，而那种漂移只有在两边算出不同 id 时才会暴露。
//
// 原来住在 `inbox/records.ts`，抽出来是为了让别的模块也能用同一套框架。
// 注意它与 `observability/hash.ts` **不是重复**：那边是 `offer()` 要用的**同步** SHA-256（自实现），
// 这边是带分段框架、走 `crypto.subtle` 的异步版；两者的用途与签名都不同。

/**
 * 分隔符与段长前缀都要有：拼接不能有歧义（`["a","bc"]` 与 `["ab","c"]` 必须不同）。
 * **源码里用 `\u0000` 转义写**——直接敲真字节会让整个文件被 git 当成 binary（`Bin 0 -> N bytes`），
 * 公共 schema 从此没法按文本 review；运行时输入一个字节都没变。
 */
export async function sha256Hex(parts: readonly string[]): Promise<string> {
  const canonical = parts.map((p) => `${p.length}:${p}`).join("\u0000");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
