import { test, expect } from "bun:test";
import { hmacSha256Hex, sha256Hex } from "../src/observability/hash.ts";

// 纯 JS SHA-256 / HMAC（§15.4.2 的同步预算要求 `offer()` 同步，Web Crypto 是异步的）。
// 用 NIST / RFC 4231 已知向量锁；单块、多块、跨块填充边界各一。

test("SHA-256：NIST 已知向量", () => {
  expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  // 56 字节：填充正好跨到第二块——最容易写错的边界
  expect(sha256Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")).toBe(
    "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
  );
});

test("SHA-256：1,000,000 个 'a'（多块）", () => {
  expect(sha256Hex("a".repeat(1_000_000))).toBe("cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0");
});

test("SHA-256：字节输入与字符串输入同值", () => {
  expect(sha256Hex(new TextEncoder().encode("abc"))).toBe(sha256Hex("abc"));
});

test("HMAC-SHA256：RFC 4231 向量（含 key > 64 字节先哈希的分支）", () => {
  expect(hmacSha256Hex(new Uint8Array(20).fill(0x0b), "Hi There")).toBe(
    "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7",
  );
  expect(hmacSha256Hex("Jefe", "what do ya want for nothing?")).toBe(
    "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843",
  );
  expect(hmacSha256Hex(new Uint8Array(20).fill(0xaa), new Uint8Array(50).fill(0xdd))).toBe(
    "773ea91e36800e46854db8ebd09181a72959098b3ef8c122d9635514ced565fe",
  );
  expect(hmacSha256Hex(new Uint8Array(131).fill(0xaa), "Test Using Larger Than Block-Size Key - Hash Key First")).toBe(
    "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54",
  );
});
