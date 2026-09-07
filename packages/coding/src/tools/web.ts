// web 一组（2026-09-03/04）：`web_fetch` 取一个 URL 的正文；`web_search` 走 Brave Search API 拿结果列表。
// 不做出网确认（用户拍板：缺省全放行）。HTML 在这层剥成可读文本，不加依赖。
// 两件都是延迟工具（`deferred`）：多数编码任务用不上，经 tool_search 取过才上菜单。
//
// 搜索源选 Brave（2026-09-04 用户拍板）：与模型无关，一把 key 五家 provider 通用；厂商自带搜索要改 core 的
// dialect 且 deepseek 没有，另议。key 的解析顺序与模型 key 一样：环境变量 `BRAVE_API_KEY` → 凭据 store 的
// `brave` 条目 → 没有（工具如实报「没配」，不猜）。key 的值不进任何错误信息。

import { toolError, toolOk, type CredentialStore, type ModelTool } from "@echo-agent/core";

const TIMEOUT_MS = 30_000;
/** 响应体最多读这么多字节：超过就截，避免一个大文件把内存与上下文一起吃掉。 */
const MAX_BYTES = 4_000_000;
const DEFAULT_MAX_CHARS = 20_000;

const BRAVE_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";
const BRAVE_ENV = "BRAVE_API_KEY";
/** 凭据 store 里的条目名：`{ "brave": { "apiKey": "…" } }`。 */
const BRAVE_CREDENTIAL = "brave";
const SEARCH_TIMEOUT_MS = 20_000;
const SEARCH_COUNT_DEFAULT = 5;
const SEARCH_COUNT_MAX = 10;

export type WebDeps = {
  /** 搜索 key 的第二来源（第一是环境变量）。不给 = 只认环境变量。 */
  credentials?: Pick<CredentialStore, "read">;
  /** 测试用：把 Brave 的接口指到假服务。 */
  searchEndpoint?: string;
};

export function makeWebTools(deps: WebDeps = {}): ModelTool[] {
  return [webFetchTool(), webSearchTool(deps)] as ModelTool[];
}

/** 环境变量 → 凭据 store → 没有。值只在这里经手，不进返回给模型的任何文字。 */
async function searchKey(deps: WebDeps): Promise<string | undefined> {
  const env = process.env[BRAVE_ENV];
  if (env !== undefined && env !== "") return env;
  const stored = await deps.credentials?.read(BRAVE_CREDENTIAL);
  return stored?.type === "api_key" && stored.key !== "" ? stored.key : undefined;
}

type BraveResult = { title?: unknown; url?: unknown; description?: unknown; age?: unknown; page_age?: unknown };

const FRESHNESS: Record<string, string> = { day: "pd", week: "pw", month: "pm", year: "py" };

function webSearchTool(deps: WebDeps): ModelTool<{ query: string; count?: number; freshness?: string }> {
  return {
    kind: "model",
    name: "web_search",
    label: "搜网页",
    deferred: true,
    description:
      "Search the web (Brave Search) and return the top results as title, URL and snippet; read a result with web_fetch. " +
      "count is 1-10 (default 5); freshness limits results to the last day, week, month or year. " +
      `Needs a Brave Search API key: the ${BRAVE_ENV} environment variable or a '${BRAVE_CREDENTIAL}' entry in the credentials file.`,
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        count: { type: "number", description: "How many results, 1-10 (default 5)" },
        freshness: { type: "string", enum: ["day", "week", "month", "year"], description: "Only results from the last day/week/month/year" },
      },
      required: ["query"],
    },
    async execute({ query, count, freshness }, ctx) {
      const q = query.trim();
      if (q === "") return toolError("query is empty");
      const key = await searchKey(deps);
      if (key === undefined) {
        return toolError(
          `No search service configured: set ${BRAVE_ENV}, or add { "${BRAVE_CREDENTIAL}": { "apiKey": "…" } } to $ECHO_HOME/credentials.json ` +
            "(a Brave Search API key, see https://brave.com/search/api/).",
        );
      }
      const url = new URL(deps.searchEndpoint ?? BRAVE_ENDPOINT);
      url.searchParams.set("q", q);
      url.searchParams.set("count", String(Math.min(SEARCH_COUNT_MAX, Math.max(1, Math.floor(count ?? SEARCH_COUNT_DEFAULT)))));
      if (freshness !== undefined) {
        const code = FRESHNESS[freshness];
        if (code === undefined) return toolError(`freshness must be one of day, week, month, year (got '${freshness}')`);
        url.searchParams.set("freshness", code);
      }
      const timeout = AbortSignal.timeout(SEARCH_TIMEOUT_MS);
      const signal = ctx.signal === undefined ? timeout : AbortSignal.any([ctx.signal, timeout]);
      let res: Response;
      let text: string;
      try {
        res = await fetch(url, { signal, headers: { accept: "application/json", "x-subscription-token": key } });
        text = await res.text();
      } catch (e) {
        return toolError(`Search request failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (res.status === 401 || res.status === 403) return toolError(`Brave Search rejected the API key (HTTP ${res.status}); check ${BRAVE_ENV} or the '${BRAVE_CREDENTIAL}' credential`);
      if (res.status === 429) return toolError("Brave Search rate limit or quota exceeded (HTTP 429); wait or check the plan");
      if (!res.ok) return toolError(`Brave Search returned HTTP ${res.status} ${res.statusText}\n${text.slice(0, 300)}`);
      let results: BraveResult[];
      try {
        const parsed = JSON.parse(text) as { web?: { results?: unknown } };
        results = Array.isArray(parsed.web?.results) ? (parsed.web.results as BraveResult[]) : [];
      } catch {
        return toolError("Brave Search returned a response that is not JSON");
      }
      if (results.length === 0) return toolOk(`No results for "${q}"`, { query: q, count: 0 });
      const lines = results.map((r, i) => {
        const title = typeof r.title === "string" ? stripTags(r.title) : "(untitled)";
        const link = typeof r.url === "string" ? r.url : "";
        const snippet = typeof r.description === "string" ? stripTags(r.description) : "";
        const age = typeof r.age === "string" ? r.age : typeof r.page_age === "string" ? r.page_age : "";
        return `${i + 1}. ${title}${age === "" ? "" : ` (${age})`}\n   ${link}${snippet === "" ? "" : `\n   ${snippet}`}`;
      });
      return toolOk(`Results for "${q}":\n${lines.join("\n")}`, { query: q, count: results.length });
    },
  };
}

/** Brave 的标题与摘要里带 `<strong>` 之类的高亮标签：剥掉、解实体、压空白。 */
function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
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
      "output capped at max_chars (default 20000). Find pages with web_search.",
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
