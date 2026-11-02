import { test, expect } from "bun:test";
import { IMAGE_TOKEN_ESTIMATE, MAX_IMAGE_BYTES, MAX_IMAGE_EDGE, imageFromBytes, imageTokens, sniffImage } from "../src/image.ts";
import { estimateTokens } from "../src/compaction/view.ts";
import { userMessage } from "../src/messages.ts";

// 图片基础件（2026-11-02，照 Claude Code）：认格式、读尺寸只看文件头，所以这里按各格式规范拼最小的头。

const be32 = (n: number): number[] => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const be16 = (n: number): number[] => [(n >>> 8) & 255, n & 255];
const le16 = (n: number): number[] => [n & 255, (n >>> 8) & 255];
const le24 = (n: number): number[] => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255];
const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));

function png(w: number, h: number, pad = 0): Uint8Array {
  return Uint8Array.from([0x89, ...ascii("PNG"), 0x0d, 0x0a, 0x1a, 0x0a, ...be32(13), ...ascii("IHDR"), ...be32(w), ...be32(h), 8, 6, 0, 0, 0, ...new Array(4 + pad).fill(0)]);
}
function gif(w: number, h: number): Uint8Array {
  return Uint8Array.from([...ascii("GIF89a"), ...le16(w), ...le16(h), 0, 0, 0]);
}
/** FFD8 + 一个 APP0 段（让扫描真的要跳一段）+ SOF0（高在前、宽在后）。 */
function jpeg(w: number, h: number): Uint8Array {
  const app0 = [0xff, 0xe0, ...be16(16), ...ascii("JFIF"), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0];
  const sof0 = [0xff, 0xc0, ...be16(17), 8, ...be16(h), ...be16(w), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
  return Uint8Array.from([0xff, 0xd8, ...app0, ...sof0, 0xff, 0xd9]);
}
function webpVp8x(w: number, h: number): Uint8Array {
  return Uint8Array.from([...ascii("RIFF"), 0, 0, 0, 0, ...ascii("WEBP"), ...ascii("VP8X"), 10, 0, 0, 0, 0, 0, 0, 0, ...le24(w - 1), ...le24(h - 1)]);
}
function webpVp8(w: number, h: number): Uint8Array {
  return Uint8Array.from([...ascii("RIFF"), 0, 0, 0, 0, ...ascii("WEBP"), ...ascii("VP8 "), 0, 0, 0, 0, 0, 0, 0, 0x9d, 0x01, 0x2a, ...le16(w), ...le16(h), 0, 0]);
}
function webpVp8l(w: number, h: number): Uint8Array {
  const bits = ((w - 1) & 0x3fff) | (((h - 1) & 0x3fff) << 14);
  return Uint8Array.from([...ascii("RIFF"), 0, 0, 0, 0, ...ascii("WEBP"), ...ascii("VP8L"), 0, 0, 0, 0, 0x2f, bits & 255, (bits >>> 8) & 255, (bits >>> 16) & 255, (bits >>> 24) & 255, 0, 0, 0, 0, 0]);
}

test("认格式、读宽高：PNG / GIF / JPEG（要跳过前面的段）/ WebP 三种块", () => {
  expect(sniffImage(png(640, 480))).toEqual({ format: "png", mimeType: "image/png", width: 640, height: 480 });
  expect(sniffImage(gif(32, 16))).toEqual({ format: "gif", mimeType: "image/gif", width: 32, height: 16 });
  expect(sniffImage(jpeg(1920, 1080))).toEqual({ format: "jpeg", mimeType: "image/jpeg", width: 1920, height: 1080 });
  expect(sniffImage(webpVp8x(3000, 2000))).toEqual({ format: "webp", mimeType: "image/webp", width: 3000, height: 2000 });
  expect(sniffImage(webpVp8(300, 200))?.width).toBe(300);
  expect(sniffImage(webpVp8l(123, 45))).toMatchObject({ width: 123, height: 45 });
});

test("认不出：不是这四种、文件头残缺、宽高为零都返回 null；imageFromBytes 说 not_image", () => {
  expect(sniffImage(Uint8Array.from(ascii("%PDF-1.7 ...")))).toBeNull();
  expect(sniffImage(png(640, 480).slice(0, 12))).toBeNull();
  expect(sniffImage(png(0, 480))).toBeNull();
  const r = imageFromBytes(Uint8Array.from(ascii("hello world")));
  expect(r.ok === false && r.reason).toBe("not_image");
});

test("太大：长边超上限、或字节超上限 → too_large，带上认出的尺寸（调用方缩放后再交回来）", () => {
  const tall = imageFromBytes(png(1000, MAX_IMAGE_EDGE + 1));
  expect(tall.ok === false && tall.reason).toBe("too_large");
  expect(tall.ok === false && tall.info?.height).toBe(MAX_IMAGE_EDGE + 1);
  expect(tall.ok === false && tall.message).toContain("pixels on the long edge");
  const heavy = imageFromBytes(png(100, 100, MAX_IMAGE_BYTES));
  expect(heavy.ok === false && heavy.reason).toBe("too_large");
});

test("正常的图 → ImageBlock：mimeType 按格式、base64 能还原出原字节", () => {
  const bytes = jpeg(800, 600);
  const r = imageFromBytes(bytes);
  if (!r.ok) throw new Error(r.message);
  expect(r.image.mimeType).toBe("image/jpeg");
  expect(r.image.data).toBe(Buffer.from(bytes).toString("base64")); // 原字节原样编码，不重新压缩
  expect(r.info).toMatchObject({ width: 800, height: 600 });
});

test("估 token：按尺寸（宽 × 高 ÷ 750），认不出尺寸退回固定值；估算里用的就是它", () => {
  const block = (bytes: Uint8Array) => ({ type: "image" as const, mimeType: "image/png", data: Buffer.from(bytes).toString("base64") });
  expect(imageTokens(block(png(1568, 1568)))).toBe(Math.ceil((1568 * 1568) / 750));
  expect(imageTokens(block(png(10, 10)))).toBe(1);
  expect(imageTokens({ type: "image", mimeType: "image/png", data: "A".repeat(1_000) })).toBe(IMAGE_TOKEN_ESTIMATE);
  const big = userMessage("look", "human", [block(png(1568, 1568))]);
  expect(estimateTokens([big])).toBe(estimateTokens([userMessage("look")]) + Math.ceil((1568 * 1568) / 750));
});
