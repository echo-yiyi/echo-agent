// web_fetch（2026-09-03）：取一个 URL 的正文给模型看。不做出网确认（用户拍板：缺省全放行）；不接搜索——
// web_search 要接搜索服务（要 key），另议。HTML 在这层剥成可读文本，不加依赖。
// 延迟工具（`deferred`）：多数编码任务用不上它，经 tool_search 取过才上菜单。

import { toolError, toolOk, type ModelTool } from "@echo-agent/core";

const TIMEOUT_MS = 30_000;
/** 响应体最多读这么多字节：超过就截，避免一个大文件把内存与上下文一起吃掉。 */
const MAX_BYTES = 4_000_000;
const DEFAULT_MAX_CHARS = 20_000;

export function makeWebTools(): ModelTool[] {
  return [webFetchTool()] as ModelTool[];
}

function webFetchTool(): ModelTool<{ url: string; max_chars?: number }> {
  return {
    kind: "model",
    name: "web_fetch",
    label: "取网页",
    deferred: true,
    description:
      "Fetch a URL (http or https) and return its content as text: HTML is reduced to readable text with headings and " +
      "links kept as [text](url); JSON and plain text come back as they are. Follows redirects, 30 s timeout, " +
      "output capped at max_chars (default 20000).",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string" },
        max_chars: { type: "number", description: "Cap on returned characters, default 20000" },
      },
      required: ["url"],
    },
    async execute({ url, max_chars }, ctx) {
      let target: URL;
      try {
        target = new URL(url);
      } catch {
        return toolError(`Not a valid URL: ${url}`);
      }
      if (target.protocol !== "http:" && target.protocol !== "https:") return toolError(`Only http and https are supported: ${url}`);
      const timeout = AbortSignal.timeout(TIMEOUT_MS);
      const signal = ctx.signal === undefined ? timeout : AbortSignal.any([ctx.signal, timeout]);
      let res: Response;
      let bytes: Uint8Array;
      try {
        res = await fetch(target, {
          signal,
          redirect: "follow",
          headers: { "user-agent": "echo-coding", accept: "text/html, text/plain, application/json;q=0.9, */*;q=0.5" },
        });
        bytes = new Uint8Array(await res.arrayBuffer());
      } catch (e) {
        return toolError(`Fetch failed for ${url}: ${e instanceof Error ? e.message : String(e)}`);
      }
      const clipped = bytes.byteLength > MAX_BYTES;
      const raw = new TextDecoder().decode(clipped ? bytes.subarray(0, MAX_BYTES) : bytes);
      const type = (res.headers.get("content-type") ?? "").toLowerCase();
      if (!res.ok) return toolError(`HTTP ${res.status} ${res.statusText} for ${res.url !== "" ? res.url : url}\n${raw.slice(0, 500)}`);
      let text: string;
      if (type.includes("html")) text = htmlToText(raw);
      else if (type === "" || type.startsWith("text/") || type.includes("json") || type.includes("xml")) text = raw;
      else return toolError(`Unsupported content type '${type}' (${bytes.byteLength} bytes) at ${url}`);
      const cap = Math.max(1, max_chars ?? DEFAULT_MAX_CHARS);
      const head = res.url !== "" && res.url !== url ? `(redirected to ${res.url})\n` : "";
      const body =
        text.length > cap ? `${text.slice(0, cap)}\n…[truncated: ${text.length} characters in total; raise max_chars to see more]` : text;
      return toolOk(`${head}${body === "" ? "(empty)" : body}${clipped ? `\n…[response body over ${MAX_BYTES} bytes, cut]` : ""}`, {
        url: res.url !== "" ? res.url : url,
        status: res.status,
        contentType: type,
      });
    },
  };
}

/** HTML → 可读文本：去 script/style/head，标题成 `#`、列表成 `-`、绝对链接留成 `[text](url)`，块级标签换行，实体解码。 */
export function htmlToText(html: string): string {
  let s = html.replace(/<!--[\s\S]*?-->/g, "").replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1\s*>/gi, "");
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(s)?.[1];
  s = s.replace(/<head\b[\s\S]*?<\/head\s*>/i, "");
  s = s.replace(/<a\b[^>]*?href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a\s*>/gi, (_m, href: string, inner: string) => {
    const label = inner.replace(/<[^>]+>/g, "").trim();
    return /^https?:\/\//i.test(href) && label !== "" && label !== href ? `[${label}](${href})` : label;
  });
  s = s
    .replace(/<(br|hr)\b[^>]*\/?>/gi, "\n")
    .replace(/<h([1-6])\b[^>]*>/gi, (_m, n: string) => `\n${"#".repeat(Number(n))} `)
    .replace(/<\/(p|div|section|article|header|footer|main|nav|aside|h[1-6]|li|tr|blockquote|pre|table|ul|ol|dd|dt|figure)\s*>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "- ")
    .replace(/<(td|th)\b[^>]*>/gi, " ")
    .replace(/<[^>]+>/g, "");
  s = decodeEntities(s);
  const text = s
    .split("\n")
    .map((l) => l.replace(/[ \t\r ]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const t = title === undefined ? "" : decodeEntities(title).trim();
  return t === "" ? text : `${t}\n\n${text}`;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  copy: "©",
  reg: "®",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  laquo: "«",
  raquo: "»",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e.startsWith("#")) {
      const code = e[1]?.toLowerCase() === "x" ? Number.parseInt(e.slice(2), 16) : Number.parseInt(e.slice(1), 10);
      try {
        return String.fromCodePoint(code);
      } catch {
        return m;
      }
    }
    return NAMED_ENTITIES[e.toLowerCase()] ?? m;
  });
}
