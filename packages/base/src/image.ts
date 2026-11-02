// 读图片文件（2026-11-02 用户拍板，照 Claude Code 的做法）：读字节 → core 认格式读尺寸 → 大了就缩放、重新压缩。
//
// 缩放借系统自带的工具，不加依赖：macOS 的 `sips`，或装了的 ImageMagick（`magick` / `convert`）。都没有时，
// 没超接口上限的图原样用，超了就明确拒收、说清原因——不静默发一张接口会拒的图。
// 决策见 `docs/decisions/implemented/2026-11-02-large-tool-results-and-images.md`。

import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, isAbsolute, join, resolve } from "node:path";
import { imageFromBytes, type ImageBlock, type ImageInfo } from "@echo-agent/core";

/**
 * 长边超过这么多像素就缩到这么多（照 Claude Code：大图缩到模型的尺寸限制以内）。1568 是 Anthropic 推荐的长边，
 * 再大服务端也会缩；别家同样按尺寸计费，缩了省 token，模型看截图也够用。
 */
export const RESIZE_LONG_EDGE = 1_568;
/** 认作图片文件的扩展名（与 core 认得的四种格式一致）。 */
export const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
/** 拒收比这还大的文件，不读进内存（同 Claude Code 的 Read）。 */
const MAX_IMAGE_FILE_BYTES = 128 * 1024 * 1024;
const RESIZE_TIMEOUT_MS = 30_000;

export type LoadedImage =
  | {
      readonly ok: true;
      readonly image: ImageBlock;
      readonly info: ImageInfo;
      /** 缩放过就是缩放前的尺寸。 */
      readonly original?: { readonly width: number; readonly height: number };
    }
  | { readonly ok: false; readonly reason: "not_found" | "not_image" | "too_large"; readonly message: string };

/** 路径的扩展名是不是图片。 */
export function isImagePath(path: string): boolean {
  return IMAGE_EXTENSIONS.has(extname(path).toLowerCase());
}

/**
 * 读一张图：认不出 → `not_image`；长边超过 `RESIZE_LONG_EDGE` 或超过接口上限 → 缩放再认一次；
 * 缩不了（没有 `sips` / ImageMagick）时，没超接口上限就原样用，超了 → `too_large`。
 */
export async function loadImageFile(path: string): Promise<LoadedImage> {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return { ok: false, reason: "not_found", message: `no such file: ${path}` };
  }
  if (size > MAX_IMAGE_FILE_BYTES) {
    return { ok: false, reason: "too_large", message: `the file is ${(size / 1024 / 1024).toFixed(0)} MB; images over 128 MB are not read` };
  }
  const first = imageFromBytes(await readFile(path));
  if (!first.ok && first.reason === "not_image") return { ok: false, reason: "not_image", message: `${path} is ${first.message}` };
  const info = first.ok ? first.info : first.info!;
  if (first.ok && Math.max(info.width, info.height) <= RESIZE_LONG_EDGE) return { ok: true, image: first.image, info };

  const resized = await resizeImage(path, info.format === "png" || info.format === "gif" ? "png" : "jpeg");
  if (resized !== null) {
    const second = imageFromBytes(resized);
    if (second.ok) return { ok: true, image: second.image, info: second.info, original: { width: info.width, height: info.height } };
  }
  // 缩不了：没超接口上限就原样用（只是贵一点），超了说清楚
  if (first.ok) return { ok: true, image: first.image, info };
  return {
    ok: false,
    reason: "too_large",
    message: `${first.message}, and it could not be resized here (no sips or ImageMagick available)`,
  };
}

/** 用系统自带的工具把长边缩到 `RESIZE_LONG_EDGE`、重新压缩。哪个都用不了返回 null。 */
async function resizeImage(path: string, format: "png" | "jpeg"): Promise<Uint8Array | null> {
  const dir = await mkdtemp(join(tmpdir(), "echo-image-"));
  const out = join(dir, format === "png" ? "out.png" : "out.jpg");
  const edge = String(RESIZE_LONG_EDGE);
  const attempts: [string, string[]][] = [
    ["sips", ["-Z", edge, "-s", "format", format, ...(format === "jpeg" ? ["-s", "formatOptions", "85"] : []), path, "--out", out]],
    ["magick", [`${path}[0]`, "-resize", `${edge}x${edge}>`, "-quality", "85", out]],
    ["convert", [`${path}[0]`, "-resize", `${edge}x${edge}>`, "-quality", "85", out]],
  ];
  try {
    for (const [cmd, args] of attempts) {
      if (!(await runQuietly(cmd, args))) continue;
      if (existsSync(out)) return Uint8Array.from(await readFile(out));
    }
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** 跑一个命令，只看成没成：找不到命令、非零退出、超时都是 false。 */
function runQuietly(cmd: string, args: readonly string[]): Promise<boolean> {
  return new Promise((done) => {
    let child;
    try {
      child = spawn(cmd, [...args], { stdio: "ignore" });
    } catch {
      done(false);
      return;
    }
    const timer = setTimeout(() => child.kill("SIGKILL"), RESIZE_TIMEOUT_MS);
    child.on("error", () => {
      clearTimeout(timer);
      done(false);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      done(code === 0);
    });
  });
}

/**
 * 从一段输入文字里认出指向已存在图片文件的路径（用户把图片拖进终端时，终端粘贴的就是路径）。
 * 认三种写法：空格用反斜杠转义（`/a/My\ Shot.png`）、单引号或双引号包住；相对路径按 `cwd` 解析。
 * 去重、保持出现顺序。
 */
export function imagePathsIn(text: string, cwd: string): string[] {
  const found: string[] = [];
  for (const m of text.matchAll(/'([^']+)'|"([^"]+)"|((?:\\ |[^\s'"])+)/g)) {
    const raw = m[1] ?? m[2] ?? (m[3] ?? "").replace(/\\ /g, " ");
    if (!isImagePath(raw)) continue;
    const abs = isAbsolute(raw) ? raw : resolve(cwd, raw);
    if (existsSync(abs) && !found.includes(abs)) found.push(abs);
  }
  return found;
}
