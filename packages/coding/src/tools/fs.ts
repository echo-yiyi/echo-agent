// 文件三件套:read_file / write_file / edit_file。
//
// 这些是**产品层工具**(对外部世界动手),所以住这儿不住 core(判据 2026-08-04 拍定)。
// 路径纪律:相对路径以 ctx.workspace 解析,**解析结果必须落在 workspace 之内**——
// 越界一律拒绝(`../../etc/passwd` 这类,不管是模型手滑还是注入)。workspace 是 session 级事实（2026-09-01），
// 既是起点也是边界,一个字段。这道边界是**六件工作区工具共用的一条**（`resolveInWorkspace`，search.ts 也走它），
// 解 symlink（review 2026-09-07：此前只比字符串前缀，工作区里一条软链就能读写外面）。bash 不在这道边界内——
// 它是有意留的出口，像 Claude Code 的 Bash 一样能 cd 到任何地方，看着它的是 permission 策略，不是路径。
//
// description 与结果文本是模型逐字读的资产（全英文，2026-09-01）；跨工具的用法（先读后改、glob/grep 优先）
// 在 `prompt.ts` 的 `tool:workspace` 段，这里只讲单个工具自己的语义。

import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { toolError, toolOk, type ModelTool, type ToolExecutionContext } from "@echo-agent/core";
import { isImagePath, loadImageFile } from "@echo-agent/base";

/** 读回显的上限:超过就按整行截断并标注——一个 50MB 的日志不该挤爆上下文。 */
const READ_CAP = 50_000;
const READ_LINES_DEFAULT = 2000;
/** 「只差空白」的提示里最多原样列出几行、每行多长。 */
const HINT_LINES = 20;
const HINT_LINE_CHARS = 200;

/**
 * 盘上字节 → 文本。三种情形：
 * - 含 NUL 字节：二进制（与 grep 同一条判据），不解码；
 * - 合法 UTF-8：`utf8: true`。BOM 原样留在文本里，改完写回时还在；
 * - 不是合法 UTF-8（Latin-1、GBK……）：按 UTF-8 宽松解，解不通的字节成 U+FFFD，`utf8: false`。
 *   这种文本**只能看不能写回**——写回去那些字节就永久变成了替换符。
 */
type Decoded = { kind: "binary" } | { kind: "text"; text: string; utf8: boolean };

function decodeFile(bytes: Uint8Array): Decoded {
  if (bytes.includes(0)) return { kind: "binary" };
  try {
    return { kind: "text", text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes), utf8: true };
  } catch {
    return { kind: "text", text: new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes), utf8: false };
  }
}

/** edit_file / write_file 拒改非 UTF-8 文件时给模型的话。 */
function notUtf8Text(path: string): string {
  return (
    `${path} is not valid UTF-8 (it may be Latin-1, GBK or another legacy encoding). Changing it here would turn every byte ` +
    "that does not decode into U+FFFD, so it is refused. Change it with bash in a way that keeps its encoding " +
    "(for example `LC_ALL=C sed` for an ASCII-only change, or iconv to convert it deliberately)."
  );
}

/** CRLF 占多数才算 CRLF 文件；一样多（含都没有）不算。 */
function isCrlf(text: string): boolean {
  const crlf = text.split("\r\n").length - 1;
  const lf = text.split("\n").length - 1 - crlf;
  return crlf > lf;
}

/**
 * **改前必读、读后未变**（2026-09-01 用户拍板，照 Claude Code 的 Edit / Write 门）：
 * `edit_file` / `write_file` 只接受本会话用 `read_file` 读过、且盘上自那次读之后没被别人改过的文件
 * （mtime 相等判据）。此前只在 description 里写了一句「先读」——那是纪律不是门：模型没读就改、
 * 或者用户在编辑器里刚改过的文件被模型按旧内容覆盖，都不会被拦住。
 *
 * 一张表跟着一次 `makeFsTools()` 走（= 一个 agent）：键是绝对路径，值是读到 / 我们自己写完时的 mtime。
 * 新建文件（盘上不存在）不需要先读。
 */
type SeenFiles = Map<string, number>;

export function makeFsTools(): ModelTool[] {
  const seen: SeenFiles = new Map();
  return [readFileTool(seen), writeFileTool(seen), editFileTool(seen)] as ModelTool[];
}

/**
 * 改之前的门。返回 null = 可以改；否则是给模型看的拒绝理由。
 * `exists` 由调用方决定新建文件算不算（`write_file` 新建不用先读）。
 */
async function assertFreshlyRead(seen: SeenFiles, abs: string, path: string): Promise<string | null> {
  const st = await stat(abs).catch(() => null);
  if (st === null) return null; // 不存在：write_file 新建；edit_file 随后读文件时会报 File not found
  const readAt = seen.get(abs);
  if (readAt === undefined) return `Read ${path} with read_file before changing it`;
  if (st.mtimeMs !== readAt) return `${path} changed on disk since you read it; read it again before changing it`;
  return null;
}

/** 读完 / 写完之后记下盘上的 mtime。 */
async function markSeen(seen: SeenFiles, abs: string): Promise<void> {
  const st = await stat(abs).catch(() => null);
  if (st !== null) seen.set(abs, st.mtimeMs);
}

/** 解析结果：`abs` 是可以读写的绝对路径；越界时 `error` 是给模型看的拒绝理由。 */
export type SafePath = { ok: true; abs: string } | { ok: false; error: string };

/**
 * 公共面上的那一份：判据与 {@link resolveInWorkspace} 相同，只回路径或 null（越界）。
 * 六件工具自己用 `resolveInWorkspace`——它多带一句给模型看的拒绝理由。
 */
export async function resolveSafe(ctx: ToolExecutionContext, path: string): Promise<string | null> {
  const r = await resolveInWorkspace(ctx, path);
  return r.ok ? r.abs : null;
}

/**
 * 解析 + 越界守卫：六件工作区工具（read_file / write_file / edit_file / list_dir / glob / grep）共用的**唯一**边界。
 *
 * 判据是**两边都取 realpath 再比**：目标的真实位置（**最近的已存在祖先** realpath 之后接上余下的段）
 * 必须落在工作区根的真实位置之内。只比字面前缀挡不住软链——工作区里一条 `link -> /etc`，`link/passwd`
 * 字面上完全在工作区内；只对目标取 realpath 又会误拒——工作区路径本身经软链（macOS 的 `/var` → `/private/var`、
 * 用户自己的软链目录）时，模型按 realpath 形式给的绝对路径字面上不在工作区下。用祖先是因为目标本身可能还不存在
 * （write_file 正要创建它）；祖先在工作区之内，那么在它下面新建的东西也在。
 * **write_file 必须先过这一关再 mkdir**：`mkdir(..., {recursive:true})` 会顺着软链在外面把目录建出来。
 *
 * 返回的是工作区字面形式的路径（不是 realpath）：后面的读写照常跟着软链走，结果仍在工作区内；结果文案里也不该
 * 冒出 `/private/var/...` 这种展开后的路径。给的是 realpath 形式时换算回工作区形式。
 *
 * 字面在工作区内、真实位置在外（monorepo 里 `node_modules` 软链到工作区外的兄弟包）：仍拒，拒绝理由说明是软链、
 * 指到哪，并指向 bash——文件工具守着工作区，读工作区外的东西是 bash 的事。
 */
export async function resolveInWorkspace(ctx: ToolExecutionContext, path: string): Promise<SafePath> {
  const root = resolve(ctx.workspace);
  const abs = isAbsolute(path) ? resolve(path) : resolve(root, path);
  const literalInside = abs === root || abs.startsWith(root + sep);
  const outside: SafePath = { ok: false, error: `Path outside the workspace: '${path}'` };

  let realRoot: string;
  try {
    realRoot = await realpath(root);
  } catch {
    // 工作区目录本身不存在 → 里面不可能有软链；只剩字面判据，后面的读写会自己报 not found
    return literalInside ? { ok: true, abs } : outside;
  }
  const real = await realTarget(abs);
  if (real === null) return outside; // 读不出来（权限、循环软链）：按越界拒，不猜
  if (real === realRoot || real.startsWith(realRoot + sep)) {
    return { ok: true, abs: literalInside ? abs : join(root, relative(realRoot, real)) };
  }
  if (!literalInside) return outside;
  return {
    ok: false,
    error:
      `Path outside the workspace: '${path}' leads through a symlink to ${real}, which is outside the workspace. ` +
      "The file tools stay inside the workspace; read files outside it with bash.",
  };
}

/** 目标的真实位置：最近的已存在祖先取 realpath，再接上不存在的那几段。null = 读不出来（权限、循环软链）。 */
async function realTarget(abs: string): Promise<string | null> {
  let cursor = abs;
  for (;;) {
    try {
      const real = await realpath(cursor);
      return cursor === abs ? real : join(real, relative(cursor, abs));
    } catch (e) {
      if ((e as { code?: string }).code !== "ENOENT") return null;
      const parent = dirname(cursor);
      if (parent === cursor) return abs; // 一路到文件系统根都不存在
      cursor = parent;
    }
  }
}

function readFileTool(seen: SeenFiles): ModelTool<{ path: string; offset?: number; limit?: number }> {
  return {
    kind: "model",
    name: "read_file",
    label: "读文件",
    // 只读：模型一口气读五个文件时同批同跑。`seen` 只按路径记一条 mtime，同批互不覆盖。
    concurrent: true,
    // 自己会分页（行数 + `READ_CAP` 截断并教 offset/limit），不走 core 的外存——外存再读一遍是绕路（2026-11-02，同 Claude Code 的 Read）
    maxInlineTokens: Infinity,
    description:
      `Read a file with line numbers. One call returns at most ${READ_LINES_DEFAULT} lines (limit) or ${READ_CAP} characters, ` +
      "always ending at a whole line; when more remains, the note at the end gives the offset to continue from. " +
      "Read a file before editing it. A note at the end also says when the file has CRLF line endings or is not valid UTF-8. " +
      "PNG, JPEG, GIF and WebP files are returned as images you can see; large ones are scaled down first. Other binary files are refused.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to the workspace" },
        offset: { type: "number", description: "First line to read (1-based), default from the start" },
        limit: { type: "number", description: `Maximum number of lines, default ${READ_LINES_DEFAULT}` },
      },
      required: ["path"],
    },
    async execute({ path, offset, limit }, ctx) {
      const safe = await resolveInWorkspace(ctx, path);
      if (!safe.ok) return toolError(safe.error);
      const abs = safe.abs;
      // 图片按图片返回（2026-11-02，照 Claude Code 的 Read）：大了先缩放。文件不存在、或扩展名是图片但内容不是，
      // 落到下面照文本读（不存在就报 File not found）
      if (isImagePath(abs)) {
        const loaded = await loadImageFile(abs);
        if (loaded.ok) {
          const { width, height } = loaded.info;
          const scaled = loaded.original === undefined ? "" : `, scaled down from ${loaded.original.width}×${loaded.original.height}`;
          return toolOk(`Image file ${path} (${width}×${height}${scaled})`, { path, width, height }, [loaded.image]);
        }
        if (loaded.reason === "too_large") {
          return toolError(`Cannot read ${path} as an image: ${loaded.message}. Make a smaller copy (for example with ImageMagick via bash) and read that.`);
        }
      }
      let bytes: Uint8Array;
      try {
        bytes = await readFile(abs);
      } catch (e) {
        return toolError(readErrText(e, path));
      }
      const decoded = decodeFile(bytes);
      // 二进制不进上下文：几千个替换符对模型毫无用处，还占掉一大块窗口
      if (decoded.kind === "binary") {
        return toolError(`${path} is a binary file (${bytes.byteLength} bytes); read_file shows text only. Inspect it with bash (for example \`file\` or \`xxd | head\`).`);
      }
      await markSeen(seen, abs); // 从这一刻起它才算「读过」：edit_file / write_file 的门看这个
      const page = renderLines(path, decoded.text, offset, limit);
      if (!page.ok) return toolError(page.error);
      const notes: string[] = [];
      if (isCrlf(decoded.text)) {
        notes.push("(This file has CRLF line endings: in edit_file, write the line breaks of a multi-line old_string as \\r\\n; new_string's line breaks are written as CRLF.)");
      }
      if (!decoded.utf8) {
        notes.push("(This file is not valid UTF-8; bytes that do not decode are shown as U+FFFD. edit_file and write_file refuse it; change it with bash, keeping its encoding.)");
      }
      return toolOk([page.text, ...notes].join("\n"), { path, lines: page.total });
    },
  };
}

/**
 * 带行号的一页。行按 `\n` 切，以换行结尾的文件不多出一个空的「最后一行」。
 * 截断永远落在整行上（行数 `limit` 或字符数 `READ_CAP`，先到者为准），尾注写**实际**显示到第几行、
 * 下一次的 offset——模型照它续读一行不漏。只有一行本身就超过 `READ_CAP` 时才截半行，并明说。
 */
function renderLines(
  path: string,
  text: string,
  offset: number | undefined,
  limit: number | undefined,
): { ok: true; text: string; total: number } | { ok: false; error: string } {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const total = lines.length;
  if (total === 0) return { ok: true, text: "(empty file)", total };
  const from = Math.max(1, Math.floor(offset ?? 1));
  if (from > total) return { ok: false, error: `offset ${from} is past the end of ${path} (${total} lines)` };
  const end = Math.min(total, from - 1 + Math.max(1, Math.floor(limit ?? READ_LINES_DEFAULT))); // 1-based，含
  const out: string[] = [];
  let size = 0;
  let last = from - 1;
  let longLine: number | null = null;
  for (let n = from; n <= end; n++) {
    const row = `${n}\t${lines[n - 1]}`;
    if (size + row.length + 1 > READ_CAP) {
      if (out.length === 0) {
        out.push(row.slice(0, READ_CAP)); // 一行就装不下：截这一行，并说清楚
        longLine = n;
        last = n;
      }
      break;
    }
    out.push(row);
    size += row.length + 1;
    last = n;
  }
  const notes: string[] = [];
  if (longLine !== null) {
    notes.push(`…[line ${longLine} is ${lines[longLine - 1]!.length} characters long and was cut at ${READ_CAP}; view the rest of it with bash]`);
  }
  if (last < total) {
    const capped = last < end && longLine === null ? `output capped at ${READ_CAP} characters; ` : "";
    notes.push(`…(${capped}showing lines ${from}-${last} of ${total}; continue with offset=${last + 1})`);
  }
  return { ok: true, text: [out.join("\n"), ...notes].join("\n"), total };
}

function writeFileTool(seen: SeenFiles): ModelTool<{ path: string; content: string }> {
  return {
    kind: "model",
    name: "write_file",
    label: "写文件",
    description:
      "Write a whole file (created if missing, parent directories created). To change an existing file prefer edit_file; overwriting loses whatever you did not notice. " +
      "An existing file must have been read with read_file in this session and be unchanged on disk since; an existing binary or non-UTF-8 file is refused.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to the workspace" },
        content: { type: "string", description: "The full file content" },
      },
      required: ["path", "content"],
    },
    async execute({ path, content }, ctx) {
      const safe = await resolveInWorkspace(ctx, path); // 必须在 mkdir 之前：递归建目录会顺着软链把目录建到外面
      if (!safe.ok) return toolError(safe.error);
      const abs = safe.abs;
      const refused = await assertFreshlyRead(seen, abs, path); // 新建不用先读；覆盖已有的必须
      if (refused !== null) return toolError(refused);
      // 覆盖一个不是 UTF-8 的文件 = 悄悄把它换成另一种编码：拒，与 edit_file 同一条
      const existing = await readFile(abs).catch(() => null);
      if (existing !== null) {
        const decoded = decodeFile(existing);
        if (decoded.kind === "binary") return toolError(`${path} is a binary file; write_file does not overwrite binary files. Use bash if you mean to replace it.`);
        if (!decoded.utf8) return toolError(notUtf8Text(path));
      }
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, content, "utf8");
      await markSeen(seen, abs); // 自己写的算读过：接着 edit_file 不用再读一遍
      return toolOk(`Wrote ${path} (${content.length} characters)`, { path, bytes: content.length });
    },
  };
}

function editFileTool(seen: SeenFiles): ModelTool<{ path: string; old_string: string; new_string: string; replace_all?: boolean }> {
  return {
    kind: "model",
    name: "edit_file",
    label: "改文件",
    description:
      "Exact replacement: old_string must match the file content byte for byte (including indentation and line endings) and occur exactly once. " +
      "If it matches several places, give more surrounding context or set replace_all: true. " +
      "In a file with CRLF line endings, new_string's line breaks are written as CRLF. Only UTF-8 text files can be edited. " +
      "The file must have been read with read_file in this session and be unchanged on disk since.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        old_string: { type: "string", description: "The exact text to replace (byte for byte, including indentation)" },
        new_string: { type: "string", description: "The replacement text" },
        replace_all: { type: "boolean", description: "Replace every match; default false (the match must be unique)" },
      },
      required: ["path", "old_string", "new_string"],
    },
    async execute({ path, old_string, new_string, replace_all }, ctx) {
      const safe = await resolveInWorkspace(ctx, path);
      if (!safe.ok) return toolError(safe.error);
      const abs = safe.abs;
      if (old_string === new_string) return toolError("old_string and new_string are identical; nothing to change");
      // 空 old_string 会在每个字符之间插入（split("") 匹配文件长度次），replace_all 时静默毁掉整个文件（review 2026-09-07）
      if (old_string === "") {
        return toolError("old_string must not be empty; to insert text, include the line you are inserting next to as context (or use write_file for a new file)");
      }
      const refused = await assertFreshlyRead(seen, abs, path);
      if (refused !== null) return toolError(refused);
      let bytes: Uint8Array;
      try {
        bytes = await readFile(abs);
      } catch (e) {
        return toolError(readErrText(e, path));
      }
      const decoded = decodeFile(bytes);
      if (decoded.kind === "binary") return toolError(`${path} is a binary file; edit_file changes text files only.`);
      if (!decoded.utf8) return toolError(notUtf8Text(path)); // 写回去，解不通的字节就永久成了替换符
      const raw = decoded.text;
      const count = raw.split(old_string).length - 1;
      if (count === 0) return toolError(noMatchText(raw, old_string));
      if (count > 1 && replace_all !== true) {
        return toolError(`${count} matches: add surrounding context to make old_string unique, or set replace_all: true`);
      }
      // CRLF 文件里按文件的换行风格写回：模型写的 new_string 多半只用 \n，不换就成了混合行尾
      const replacement = isCrlf(raw) ? new_string.replace(/\r?\n/g, "\r\n") : new_string;
      // 替换文本用函数给：字符串形式会解释 `$&` / `$$` 这类模式，new_string 里带 `$` 的代码就会被替错
      const next = replace_all === true ? raw.split(old_string).join(replacement) : raw.replace(old_string, () => replacement);
      await writeFile(abs, next, "utf8");
      await markSeen(seen, abs); // 连续几次 edit 不用中间重读
      return toolOk(`Replaced ${replace_all === true ? count : 1} occurrence(s) in ${path}`, { path, replaced: count });
    },
  };
}

/**
 * 匹配失败时告诉模型**为什么**，好让下一次一次改对。只认两种可判定的近似，**只提示、不替它改**
 * （静默的模糊替换会改到模型没看准的地方）：
 * - 换行不同：文件是 CRLF，old_string 用的是 \n——把 old_string 的 \n 写成 \r\n 就能精确匹配；
 * - 只差空白：按行比、每行折叠空白后相等（缩进 tab / 空格、行尾空格），把文件里那几行原样（JSON 引号包着，
 *   tab 与行尾空格看得见）给出来。
 * 两样都不是：原来那句。
 */
function noMatchText(raw: string, old: string): string {
  const generic = "No match: old_string must equal the file content byte for byte (including indentation). Read the file with read_file and copy it exactly";
  const crlf = isCrlf(raw);
  if (crlf && !old.includes("\r") && old.includes("\n") && raw.includes(old.replace(/\n/g, "\r\n"))) {
    return "No match: this file has CRLF (\\r\\n) line endings and old_string uses \\n. old_string matches once its line breaks are written as \\r\\n; retry that way (new_string's line breaks are converted to CRLF for you).";
  }
  const fileLines = raw.split("\n").map((l) => l.replace(/\r$/, ""));
  const at = whitespaceInsensitiveLine(fileLines, old);
  if (at === null) return generic;
  const span = old.replace(/\r/g, "").split("\n").length;
  const shown = fileLines
    .slice(at, at + Math.min(span, HINT_LINES))
    .map((l, i) => `${at + i + 1}: ${JSON.stringify(l.length > HINT_LINE_CHARS ? `${l.slice(0, HINT_LINE_CHARS)}…` : l)}`);
  return [
    `No match: old_string matches lines ${at + 1}-${at + span} only when whitespace is ignored, so the indentation or spacing differs ` +
      "(tabs versus spaces, trailing spaces). Those lines in the file, quoted so every tab and space shows:",
    ...shown,
    `Copy their whitespace exactly into old_string${crlf ? " (the file has CRLF line endings: write line breaks as \\r\\n)" : ""}.`,
  ].join("\n");
}

/**
 * old_string 在文件里**忽略空白**时从第几行（0-based）开始匹配；匹配不上 = null。
 * 每行折叠空白再比：首行可以只是文件那一行的结尾、末行可以只是开头（old_string 不必从行首起、到行尾止），中间整行相等。
 */
function whitespaceInsensitiveLine(fileLines: readonly string[], old: string): number | null {
  const norm = (s: string): string => s.replace(/\s+/g, " ").trim();
  const want = old.replace(/\r/g, "").split("\n").map(norm);
  if (want.every((w) => w === "")) return null;
  const have = fileLines.map(norm);
  for (let i = 0; i + want.length <= have.length; i++) {
    if (want.length === 1) {
      if (have[i]!.includes(want[0]!)) return i;
      continue;
    }
    let ok = have[i]!.endsWith(want[0]!) && have[i + want.length - 1]!.startsWith(want.at(-1)!);
    for (let k = 1; ok && k < want.length - 1; k++) ok = have[i + k] === want[k];
    if (ok) return i;
  }
  return null;
}

function readErrText(e: unknown, path: string): string {
  return (e as { code?: string }).code === "ENOENT" ? `File not found: ${path}` : `Read failed: ${String(e)}`;
}
