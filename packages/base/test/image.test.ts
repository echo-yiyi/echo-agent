import { test, expect } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { imagePathsIn, loadImageFile, RESIZE_LONG_EDGE } from "../src/image.ts";

// 读图片文件（2026-11-02，照 Claude Code）：大了借 sips / ImageMagick 缩放。缩放要真的解码，所以这里拼一张真 PNG。

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set([...type].map((c) => c.charCodeAt(0)), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}
/** 一张 w×h 的纯色 RGB PNG。 */
function solidPng(w: number, h: number): Uint8Array {
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, w);
  v.setUint32(4, h);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const row = new Uint8Array(1 + w * 3);
  for (let x = 0; x < w; x++) row.set([30, 120, 200], 1 + x * 3);
  const raw = new Uint8Array(row.length * h);
  for (let y = 0; y < h; y++) raw.set(row, y * row.length);
  const parts = [Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", new Uint8Array())];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

test("小图原样读：认出格式与尺寸，不缩放", async () => {
  const dir = await mkdtemp(join(tmpdir(), "echo-img-"));
  const path = join(dir, "small.png");
  await writeFile(path, solidPng(40, 30));
  const r = await loadImageFile(path);
  if (!r.ok) throw new Error(r.message);
  expect(r.info).toMatchObject({ format: "png", width: 40, height: 30 });
  expect(r.original).toBeUndefined();
  expect(r.image.mimeType).toBe("image/png");
});

test("长边超过上限的图：有 sips / ImageMagick 就缩到上限以内并记下原尺寸；macOS 上 sips 一定在", async () => {
  const dir = await mkdtemp(join(tmpdir(), "echo-img-"));
  const path = join(dir, "wide.png");
  await writeFile(path, solidPng(2_400, 300));
  const r = await loadImageFile(path);
  if (!r.ok) throw new Error(r.message);
  if (r.original !== undefined) {
    expect(Math.max(r.info.width, r.info.height)).toBeLessThanOrEqual(RESIZE_LONG_EDGE);
    expect(r.original).toEqual({ width: 2_400, height: 300 });
    expect(r.info.format).toBe("png"); // PNG 保持 PNG：截图里的字要清楚
  } else {
    // 缩不了（没有缩放工具）：没超接口上限，原样用
    expect(r.info.width).toBe(2_400);
  }
  if (process.platform === "darwin") expect(r.original).toBeDefined();
});

test("认不出、找不到：各说各的", async () => {
  const dir = await mkdtemp(join(tmpdir(), "echo-img-"));
  const fake = join(dir, "fake.png");
  await writeFile(fake, "not an image at all");
  const notImage = await loadImageFile(fake);
  expect(notImage.ok === false && notImage.reason).toBe("not_image");
  const missing = await loadImageFile(join(dir, "nope.png"));
  expect(missing.ok === false && missing.reason).toBe("not_found");
});

test("从输入里认图片路径：反斜杠转义的空格、单双引号、相对路径；不存在的、不是图片的不算；去重保序", async () => {
  const dir = await mkdtemp(join(tmpdir(), "echo-img-"));
  await writeFile(join(dir, "My Shot.png"), solidPng(4, 4));
  await writeFile(join(dir, "b.jpg"), "x");
  await writeFile(join(dir, "notes.txt"), "x");
  const text = `看一下 ${dir}/My\\ Shot.png 和 'b.jpg' 还有 "${dir}/My Shot.png" notes.txt ${dir}/gone.png`;
  expect(imagePathsIn(text, dir)).toEqual([join(dir, "My Shot.png"), join(dir, "b.jpg")]);
  expect(imagePathsIn("没有路径的一句话", dir)).toEqual([]);
});
