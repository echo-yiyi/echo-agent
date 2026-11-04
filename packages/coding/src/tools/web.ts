// web 一组（2026-09-03/04）：`web_fetch` 取一个 URL 的正文；`web_search` 走 Brave Search API 拿结果列表。
// 不做出网确认（用户拍板：缺省全放行）；但 web_fetch 不取内网地址（2026-11-03，见 `isPrivateAddress`）。
// HTML 在这层剥成可读文本，不加依赖。
// 两件都是延迟工具（`deferred`）：多数编码任务用不上，经 tool_search 取过才上菜单。
//
// 搜索源选 Brave（2026-09-04 用户拍板）：与模型无关，一把 key 五家 provider 通用；厂商自带搜索要改 core 的
// dialect 且 deepseek 没有，另议。key 的解析顺序与模型 key 一样：环境变量 `BRAVE_API_KEY` → 凭据 store 的
// `brave` 条目 → 没有（工具如实报「没配」，不猜）。key 的值不进任何错误信息。

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { toolError, toolOk, type CredentialStore, type ModelTool } from "@echo-agent/core";

const TIMEOUT_MS = 30_000;
/** 重定向最多跟这么多跳（与 opencode 的 webfetch 同数）：每跳都重查地址，所以手动跟、不交给 fetch。 */
const MAX_REDIRECTS = 10;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
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
  /**
   * 测试用：web_fetch 判「是不是内网」之前那一步主机名解析（缺省：IP 字面量原样，其余走系统 DNS）。
   * 本机起的假服务在 127.0.0.1，测试把它解析成公网地址才发得出去；它只换「查什么」，判据本身不放开。
   */
  resolveHost?: (host: string) => Promise<readonly string[]>;
};

export function makeWebTools(deps: WebDeps = {}): ModelTool[] {
  return [webFetchTool(deps), webSearchTool(deps)] as ModelTool[];
}

/* ─────────────────── 不取内网地址 ─────────────────── */

/**
 * web_fetch 只取公网地址（2026-11-03 拍板，`docs/decisions/implemented/2026-11-03-web-fetch-refuses-private-addresses.md`）：
 * 抓回来的网页是不可信内容，一句注入就能让模型去取 `http://169.254.169.254/` 的云凭据或本机的管理口，
 * 再把结果带进对话。所以每一跳发出之前都查：主机名解析出的**任一**地址落在下面这些段就拒。
 * 已知的缺口：DNS rebinding（查的那次与 fetch 自己解析的那次之间换了答案）不在防线内——fetch 不让指定连哪个地址。
 */
export function isPrivateAddress(ip: string): boolean {
  const bare = ip.replace(/%.*$/, ""); // IPv6 的 zone id（fe80::1%lo0）
  const kind = isIP(bare);
  if (kind === 4) return privateV4(bare.split(".").map(Number) as [number, number, number, number]);
  if (kind === 6) return privateV6(bare);
  return true; // 认不出的不放行
}

function privateV4([a, b]: [number, number, number, number]): boolean {
  return (
    a === 0 || // 0.0.0.0/8：未指定 / 本网络
    a === 10 || // 10/8
    a === 127 || // loopback
    (a === 169 && b === 254) || // 链路本地，含云元数据 169.254.169.254
    (a === 172 && b >= 16 && b <= 31) || // 172.16/12
    (a === 192 && b === 168) || // 192.168/16
    (a === 100 && b >= 64 && b <= 127) // CGNAT 100.64/10
  );
}

function privateV6(ip: string): boolean {
  const g = ipv6Groups(ip);
  if (g === null) return true;
  const zeroHead = g.slice(0, 5).every((x) => x === 0);
  if (zeroHead && g[5] === 0xffff) return privateV4([g[6]! >> 8, g[6]! & 0xff, g[7]! >> 8, g[7]! & 0xff]); // ::ffff:a.b.c.d（IPv4 映射）
  if (zeroHead && g[5] === 0) {
    if (g[6] === 0 && (g[7] === 0 || g[7] === 1)) return true; // :: 未指定、::1 loopback
    return privateV4([g[6]! >> 8, g[6]! & 0xff, g[7]! >> 8, g[7]! & 0xff]); // ::a.b.c.d（已废弃的 IPv4 兼容写法）
  }
  return (g[0]! & 0xfe00) === 0xfc00 || (g[0]! & 0xffc0) === 0xfe80; // fc00::/7 唯一本地、fe80::/10 链路本地
}

/** IPv6 文本 → 8 组 16 位。末尾可以是点分 IPv4。格式不对 = null。 */
function ipv6Groups(ip: string): number[] | null {
  let text = ip.toLowerCase();
  const v4 = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (v4 !== null) {
    const [a, b, c, d] = v4.slice(1).map(Number) as [number, number, number, number];
    text = `${text.slice(0, v4.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const parse = (s: string): number[] => (s === "" ? [] : s.split(":").map((h) => Number.parseInt(h, 16)));
  const head = parse(halves[0]!);
  const tail = halves.length === 2 ? parse(halves[1]!) : [];
  const fill = 8 - head.length - tail.length;
  if (fill < 0 || (halves.length === 1 && fill !== 0)) return null;
  const groups = [...head, ...Array<number>(halves.length === 2 ? fill : 0).fill(0), ...tail];
  return groups.length === 8 && groups.every((x) => Number.isInteger(x) && x >= 0 && x <= 0xffff) ? groups : null;
}

/** 缺省的主机名解析：IP 字面量原样，其余走系统 DNS，取全部地址。 */
async function systemResolve(host: string): Promise<readonly string[]> {
  if (isIP(host) !== 0) return [host];
  return (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);
}

/** 这一跳能不能发：null = 能；否则是给模型看的拒绝理由。 */
async function refusedHost(url: URL, resolveHost: (host: string) => Promise<readonly string[]>, via: string | null): Promise<string | null> {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  let addresses: readonly string[];
  try {
    addresses = await resolveHost(host);
  } catch (e) {
    return `Fetch failed for ${url.href}: could not resolve ${host} (${e instanceof Error ? e.message : String(e)})`;
  }
  const bad = addresses.find(isPrivateAddress);
  if (bad === undefined) return null;
  const how = via === null ? url.href : `${via}, which redirects to ${url.href}`;
  return (
    `Refused to fetch ${how}: ${host} resolves to ${bad}, a loopback, private, link-local or otherwise non-public address. ` +
    "web_fetch only reaches public internet addresses; this is a safety restriction, not a network error."
  );
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

function webFetchTool(deps: WebDeps): ModelTool<{ url: string; max_chars?: number }> {
  const resolveHost = deps.resolveHost ?? systemResolve;
  return {
    kind: "model",
    name: "web_fetch",
    label: "取网页",
    deferred: true,
    description:
      "Fetch a URL (http or https) and return its content as text: HTML is reduced to readable text with headings, " +
      "links kept as [text](url) and <pre> blocks kept verbatim as code blocks; JSON and plain text come back as they are. " +
      `Follows up to ${MAX_REDIRECTS} redirects, 30 s timeout, output capped at max_chars (default 20000). ` +
      "Only public internet addresses: loopback, private-network and link-local hosts (localhost, 10.x, 192.168.x, 169.254.x, ...) are refused. " +
      "Find pages with web_search.",
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
      let clipped = false;
      let current = target; // 跟到第几跳了：最终 URL 也是相对链接的基准
      try {
        // 重定向手动逐跳跟：fetch 自己跟的话中间那几跳不经检查，公网页面一个 302 就能把请求带进内网
        for (let hop = 0; ; hop++) {
          const refused = await refusedHost(current, resolveHost, hop === 0 ? null : target.href);
          if (refused !== null) return toolError(refused);
          res = await fetch(current, {
            signal,
            redirect: "manual",
            headers: { "user-agent": "echo-coding", accept: "text/html, text/plain, application/json;q=0.9, */*;q=0.5" },
          });
          const location = res.headers.get("location");
          if (!REDIRECT_STATUSES.has(res.status) || location === null) break;
          await res.body?.cancel();
          if (hop >= MAX_REDIRECTS) return toolError(`Too many redirects (more than ${MAX_REDIRECTS}) starting from ${target.href}`);
          let next: URL;
          try {
            next = new URL(location, current);
          } catch {
            return toolError(`${current.href} redirects to an invalid location: ${location}`);
          }
          if (next.protocol !== "http:" && next.protocol !== "https:") return toolError(`${current.href} redirects to an unsupported scheme: ${next.href}`);
          current = next;
        }
        // 流式读、到上限就取消：`arrayBuffer()` 会先把整个响应体收进内存再截，MAX_BYTES 那时限不住内存（review 2026-09-07）
        const chunks: Uint8Array[] = [];
        let total = 0;
        const reader = res.body?.getReader();
        if (reader !== undefined) {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value === undefined) continue;
            if (total + value.byteLength > MAX_BYTES) {
              chunks.push(value.subarray(0, MAX_BYTES - total));
              total = MAX_BYTES;
              clipped = true;
              await reader.cancel();
              break;
            }
            chunks.push(value);
            total += value.byteLength;
          }
        }
        bytes = new Uint8Array(total);
        let offset = 0;
        for (const c of chunks) {
          bytes.set(c, offset);
          offset += c.byteLength;
        }
      } catch (e) {
        return toolError(`Fetch failed for ${url}: ${e instanceof Error ? e.message : String(e)}`);
      }
      const type = (res.headers.get("content-type") ?? "").toLowerCase();
      const raw = decodeBody(bytes, type);
      const finalUrl = current.href;
      if (!res.ok) return toolError(`HTTP ${res.status} ${res.statusText} for ${finalUrl}\n${raw.slice(0, 500)}`);
      let text: string;
      if (type.includes("html")) text = htmlToText(raw, finalUrl);
      else if (type === "" || type.startsWith("text/") || type.includes("json") || type.includes("xml")) text = raw;
      else return toolError(`Unsupported content type '${type}' (${clipped ? `over ${MAX_BYTES}` : String(bytes.byteLength)} bytes) at ${url}`);
      const cap = Math.max(1, max_chars ?? DEFAULT_MAX_CHARS);
      const head = finalUrl !== target.href ? `(redirected to ${finalUrl})\n` : "";
      const body =
        text.length > cap ? `${text.slice(0, cap)}\n…[truncated: ${text.length} characters in total; raise max_chars to see more]` : text;
      return toolOk(`${head}${body === "" ? "(empty)" : body}${clipped ? `\n…[response body over ${MAX_BYTES} bytes, cut]` : ""}`, {
        url: finalUrl,
        status: res.status,
        contentType: type,
      });
    },
  };
}

/**
 * 响应体字节 → 文本：先认 `Content-Type` 的 charset；没写、又是 HTML（或没有类型）就看文档开头的 `<meta charset>` /
 * `<meta http-equiv="Content-Type" content="…; charset=…">`；都没有或认不出这个编码名，按 UTF-8 解。
 */
function decodeBody(bytes: Uint8Array, contentType: string): string {
  const declared =
    /charset\s*=\s*["']?([^;"'\s]+)/i.exec(contentType)?.[1] ??
    (contentType === "" || contentType.includes("html") ? sniffMetaCharset(bytes) : undefined);
  if (declared !== undefined) {
    try {
      return new TextDecoder(declared).decode(bytes);
    } catch {
      // 编码名认不出：退 UTF-8
    }
  }
  return new TextDecoder().decode(bytes);
}

/** 文档开头 4 KB 里的 `<meta … charset=…>`。按 latin1 读——编码名本身是 ASCII，读的时候还不知道编码。 */
function sniffMetaCharset(bytes: Uint8Array): string | undefined {
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 4096));
  return /<meta\b[^>]*?charset\s*=\s*["']?([^"'\s/>;]+)/i.exec(head)?.[1];
}

/** 链接目标 → 绝对 http(s) URL；本来就是绝对的原样返回。页内锚点、解析不了、不是 http(s) = null（只留文字）。 */
function absoluteLink(href: string, baseUrl: string | undefined): string | null {
  if (/^https?:\/\//i.test(href)) return href;
  if (href.startsWith("#") || baseUrl === undefined) return null;
  try {
    const u = new URL(href, baseUrl);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
}

/**
 * HTML → 可读文本：去 script/style/head，标题成 `#`、列表成 `-`、链接留成 `[text](url)`，块级标签换行，实体解码。
 * `<pre>` 整块原样（缩进、空行都不压），成一段 ``` 代码块。给了页面 URL（`baseUrl`）就把相对链接解析成绝对链接；
 * 没给只认本来就是绝对的 http(s) 链接。页内锚点（`#…`）与非 http(s) 链接只留文字。
 */
export function htmlToText(html: string, baseUrl?: string): string {
  let s = html.replace(/<!--[\s\S]*?-->/g, "").replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1\s*>/gi, "");
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(s)?.[1];
  s = s.replace(/<head\b[\s\S]*?<\/head\s*>/i, "");
  // pre 先摘出来换成占位（私用区字符）：后面逐行压空白、折叠空行都碰不到它，最后原样放回
  const blocks: string[] = [];
  s = s.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre\s*>/gi, (_m, inner: string) => {
    const code = decodeEntities(inner.replace(/<br\b[^>]*\/?>/gi, "\n").replace(/<[^>]+>/g, ""))
      .replace(/^\r?\n/, "") // 紧跟 <pre> 的那个换行按 HTML 规则不算内容
      .replace(/\s+$/, "");
    blocks.push(code);
    return `\n\n${blocks.length - 1}\n\n`; // 前后各空一行：成段
  });
  s = s.replace(/<a\b[^>]*?href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a\s*>/gi, (_m, href: string, inner: string) => {
    const label = inner.replace(/<[^>]+>/g, "").trim();
    const link = absoluteLink(href, baseUrl);
    return link !== null && label !== "" && label !== href && label !== link ? `[${label}](${link})` : label;
  });
  s = s
    .replace(/<(br|hr)\b[^>]*\/?>/gi, "\n")
    .replace(/<h([1-6])\b[^>]*>/gi, (_m, n: string) => `\n${"#".repeat(Number(n))} `)
    .replace(/<\/(p|div|section|article|header|footer|main|nav|aside|h[1-6]|li|tr|blockquote|table|ul|ol|dd|dt|figure)\s*>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "- ")
    .replace(/<(td|th)\b[^>]*>/gi, " ")
    .replace(/<[^>]+>/g, "");
  s = decodeEntities(s);
  const text = s
    .split("\n")
    .map((l) => l.replace(/[ \t\r ]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .replace(/(\d+)/g, (_m, i: string) => `\`\`\`\n${blocks[Number(i)]}\n\`\`\``);
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
