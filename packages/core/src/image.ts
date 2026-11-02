// 图片的基础件（2026-11-02 用户拍板，照 Claude Code 的做法）：认格式、读尺寸、转成 `ImageBlock`、按尺寸估 token。
//
// 零依赖：格式靠文件头的魔数认，宽高从文件头读（PNG / GIF / WebP 在前 30 字节，JPEG 扫到第一个 SOF 段）。
// **不缩放**——解码要依赖，core 不带；超过上限就返回「太大」和原因，由调用方去缩放再交回来
// （`@echo-agent/base` 的 `loadImageFile` 借系统自带的 `sips` / ImageMagick 做这一步）。
// 决策见 `docs/decisions/implemented/2026-11-02-large-tool-results-and-images.md`。

import type { ImageBlock } from "./messages.ts";

/** core 认得的图片格式（各家模型接口普遍收的四种）。 */
export type ImageFormat = "png" | "jpeg" | "gif" | "webp";

const MIME: Readonly<Record<ImageFormat, string>> = { png: "image/png", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };

/** 单张图原始字节的上限：各家接口拒收的常见线（Anthropic 5MB，OpenAI 系相近）。超了要缩放。 */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** 长边的上限：超过这么多像素各家接口会直接拒。超了要缩放。 */
export const MAX_IMAGE_EDGE = 8_000;
/**
 * 认不出尺寸时一张图按这么多 token 估（各家按尺寸分档计费，取一个中档）。**不能按 base64 长度估**：
 * 一张 1MB 的截图按字符会算成二十多万 token，压缩会被它疯狂提前触发。
 */
export const IMAGE_TOKEN_ESTIMATE = 1_200;
/** 每这么多像素约一个 token（Anthropic 公布的换算；别家按块计费，量级相同）。 */
const PIXELS_PER_TOKEN = 750;

/** 从文件头认出的格式、MIME 类型与宽高（像素）。 */
export type ImageInfo = { readonly format: ImageFormat; readonly mimeType: string; readonly width: number; readonly height: number };

/** 认格式、读宽高。认不出（不是这四种、文件头残缺）返回 null。 */
export function sniffImage(bytes: Uint8Array): ImageInfo | null {
  const b = bytes;
  const at = (i: number): number => b[i] ?? -1;
  const be16 = (i: number): number => (at(i) << 8) | at(i + 1);
  const be32 = (i: number): number => ((at(i) << 24) | (at(i + 1) << 16) | (at(i + 2) << 8) | at(i + 3)) >>> 0;
  const le16 = (i: number): number => at(i) | (at(i + 1) << 8);
  const le24 = (i: number): number => at(i) | (at(i + 1) << 8) | (at(i + 2) << 16);
  const ascii = (i: number, s: string): boolean => [...s].every((c, k) => at(i + k) === c.charCodeAt(0));
  const info = (format: ImageFormat, width: number, height: number): ImageInfo | null =>
    width > 0 && height > 0 ? { format, mimeType: MIME[format], width, height } : null;

  // PNG：8 字节签名，IHDR 里宽高各 4 字节大端
  if (b.length >= 24 && at(0) === 0x89 && ascii(1, "PNG") && at(4) === 0x0d && at(5) === 0x0a && at(6) === 0x1a && at(7) === 0x0a) {
    return info("png", be32(16), be32(20));
  }
  // GIF：GIF87a / GIF89a，逻辑屏幕宽高各 2 字节小端
  if (b.length >= 10 && (ascii(0, "GIF87a") || ascii(0, "GIF89a"))) return info("gif", le16(6), le16(8));
  // WebP：RIFF....WEBP，再看第一个块
  if (b.length >= 30 && ascii(0, "RIFF") && ascii(8, "WEBP")) {
    if (ascii(12, "VP8 ")) return info("webp", le16(26) & 0x3fff, le16(28) & 0x3fff);
    if (ascii(12, "VP8L") && at(20) === 0x2f) {
      const bits = at(21) | (at(22) << 8) | (at(23) << 16) | (at(24) << 24);
      return info("webp", (bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
    }
    if (ascii(12, "VP8X")) return info("webp", le24(24) + 1, le24(27) + 1);
    return null;
  }
  // JPEG：FFD8 起头，逐段扫到第一个 SOF（C0–CF，除 C4 DHT / C8 / CC DAC），高在前、宽在后
  if (b.length >= 4 && at(0) === 0xff && at(1) === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (at(i) !== 0xff) return null;
      const marker = at(i + 1);
      if (marker === 0xff) {
        i++; // 填充字节
        continue;
      }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2; // 没有长度的独立标记
        continue;
      }
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return info("jpeg", be16(i + 7), be16(i + 5));
      }
      i += 2 + be16(i + 2);
    }
    return null;
  }
  return null;
}

/**
 * `imageFromBytes` 的结果：成了给 `ImageBlock`、认出的尺寸与原始字节数；不成说清是认不出（`not_image`）
 * 还是太大（`too_large`，这时带上认出的尺寸，调用方缩放后再交回来）。
 */
export type ImageFromBytes =
  | { readonly ok: true; readonly image: ImageBlock; readonly info: ImageInfo; readonly bytes: number }
  | { readonly ok: false; readonly reason: "not_image" | "too_large"; readonly message: string; readonly info?: ImageInfo };

/**
 * 字节 → `ImageBlock`。认不出 → `not_image`；超过 `MAX_IMAGE_BYTES` 或长边超过 `MAX_IMAGE_EDGE` → `too_large`
 * （带上认出的尺寸，调用方缩放后再交回来）。所有产生图片的入口（读文件、贴图、工具返回）都走它。
 */
export function imageFromBytes(bytes: Uint8Array): ImageFromBytes {
  const info = sniffImage(bytes);
  if (info === null) return { ok: false, reason: "not_image", message: "not a PNG, JPEG, GIF or WebP image" };
  const edge = Math.max(info.width, info.height);
  if (bytes.length > MAX_IMAGE_BYTES || edge > MAX_IMAGE_EDGE) {
    const size = `${info.width}×${info.height}, ${(bytes.length / 1024 / 1024).toFixed(1)} MB`;
    return {
      ok: false,
      reason: "too_large",
      info,
      message: `image is too large (${size}; the limit is ${MAX_IMAGE_BYTES / 1024 / 1024} MB and ${MAX_IMAGE_EDGE} pixels on the long edge)`,
    };
  }
  return { ok: true, info, bytes: bytes.length, image: { type: "image", mimeType: info.mimeType, data: Buffer.from(bytes).toString("base64") } };
}

/** 估算时读尺寸要解 base64：同一个块只解一次。 */
const tokensCache = new WeakMap<object, number>();
/** JPEG 的 SOF 段一般在前几十 KB 里；解这么多字节的头足够认出几乎所有图的尺寸。 */
const HEADER_BYTES = 256 * 1024;

/** 一张图按尺寸估 token（宽 × 高 ÷ 750）；认不出尺寸按 `IMAGE_TOKEN_ESTIMATE`。 */
export function imageTokens(image: ImageBlock): number {
  const cached = tokensCache.get(image);
  if (cached !== undefined) return cached;
  // base64 每 4 个字符对应 3 个字节：按 4 的倍数截，解出来的就是完整的头
  const head = image.data.slice(0, Math.ceil((HEADER_BYTES * 4) / 3 / 4) * 4);
  const info = sniffImage(Uint8Array.from(Buffer.from(head, "base64")));
  const tokens = info === null ? IMAGE_TOKEN_ESTIMATE : Math.max(1, Math.ceil((info.width * info.height) / PIXELS_PER_TOKEN));
  tokensCache.set(image, tokens);
  return tokens;
}
