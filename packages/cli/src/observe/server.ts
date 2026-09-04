// `echo-agent observe serve`：本地只读面板。`Bun.serve` 起一个 HTTP 服务，页面轮询 JSON。
//
// 数据面只有三条路由，全部走同一个 read-only reader（不取锁、不起 agent）：
//   GET /                      页面（vendor 的 token CSS + 术语表内联，零外部资源）
//   GET /api/runs?limit&cursor  `listRuns()` 的一页 header + 这页用到的会话（产品名 / workspace，按 sessionId 反查）
//   GET /api/runs/<run-id>     `getRun()` → `RunObservationViewModel`（renderer 的 json 格式，UI 消费同一份 ViewModel，§15.6）
//   GET /api/health            库路径、各 runtime 已裁决到的 seq、run / record 计数
// reader 的每次查询都是短事务，页面轮询不会让 WAL 长住。
//
// 会话信息不在 journal 里（run header 只有 sessionId），从盘上的 session meta 读（`listSessions()`，只读）。
// **状态根就是一段 session 的目录**（2026-09-03），所以清单要扫它的**上一层**——那样面板里
// 出现的任何 sessionId 都反查得到名字与 workspace，不只是本库这一段的。
// `echo-agent` 与 `echo-coding` 缺省共用一个状态根，产品名（`SessionInfo.agent`）与 workspace 是把它们分开看的唯一依据。

import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { FileDir, listSessions, type RunObservationPage, type SqliteEchoObservationReader } from "@echo-agent/core";
import { renderRunObservation } from "@echo-agent/core/observability";
import { lexicon } from "./lexicon.ts";

/** 页面要的会话摘要：产品名与 workspace。不带 messageCount 之类会随 agent 写盘变化的东西——那是另一份真相。 */
export type SessionBrief = Readonly<{ agent: string; name: string; workspace: string; updatedAt: number }>;

/** `/api/runs` 的响应：一页 header + 这页引用到的会话。 */
export type RunsResponse = RunObservationPage & Readonly<{ sessions: Readonly<Record<string, SessionBrief>> }>;

/** session meta 每次 list 都要扫目录；轮询 500ms 一次，缓存 2s 足够新鲜（会话不会秒级增删）。 */
const SESSION_CACHE_MS = 2_000;

export type ObserveServerOptions = Readonly<{
  reader: SqliteEchoObservationReader;
  stateRoot: string;
  /** 缺省只绑 127.0.0.1：这是本机面板，不做鉴权，不能暴露到局域网。 */
  hostname?: string;
  /** 0 = 随机端口（测试用）。 */
  port?: number;
}>;

export type ObserveServer = Readonly<{
  url: string;
  port: number;
  stop(): Promise<void>;
}>;

let pageCache: string | undefined;

/** 页面 = page.html + vendor 的 token CSS + 术语表 JSON。三者都在本包内，运行时不碰网络、不碰设计系统仓。 */
export function observePageHtml(): string {
  if (pageCache !== undefined) return pageCache;
  const html = readFileSync(fileURLToPath(new URL("./page.html", import.meta.url)), "utf8");
  const tokens = readFileSync(fileURLToPath(new URL("../../vendor/echo-tokens/dist/coding/tokens.css", import.meta.url)), "utf8");
  // `</script>` 不会出现在术语表里，但 JSON 里的 `<` 一律转义，页面不因为文案里的字符断掉
  const lex = JSON.stringify(lexicon()).replace(/</g, "\\u003c");
  pageCache = html.replace("/*__TOKENS__*/", tokens).replace("/*__LEXICON__*/ null", lex);
  return pageCache;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}

function clampLimit(raw: string | null): number {
  const n = Number(raw ?? "");
  if (!Number.isFinite(n) || n <= 0) return 50;
  return Math.min(200, Math.floor(n));
}

export function startObserveServer(opts: ObserveServerOptions): ObserveServer {
  const reader = opts.reader;
  const hostname = opts.hostname ?? "127.0.0.1";
  const sessionsRoot = new FileDir(dirname(opts.stateRoot));
  let sessionCache: { at: number; map: Record<string, SessionBrief> } | undefined;
  /** sessionId → 摘要。session 目录还不存在（agent 从没起过）就是空表，不是错。 */
  const sessionIndex = async (): Promise<Record<string, SessionBrief>> => {
    if (sessionCache !== undefined && Date.now() - sessionCache.at < SESSION_CACHE_MS) return sessionCache.map;
    const map: Record<string, SessionBrief> = {};
    for (const s of await listSessions(sessionsRoot)) map[s.id] = { agent: s.agent, name: s.name, workspace: s.workspace, updatedAt: s.updatedAt };
    sessionCache = { at: Date.now(), map };
    return map;
  };
  const server = Bun.serve({
    hostname,
    port: opts.port ?? 4321,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method !== "GET") return json({ error: "method not allowed" }, 405);
      try {
        if (url.pathname === "/") {
          return new Response(observePageHtml(), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
        }
        if (url.pathname === "/api/health") {
          return json({ stateRoot: opts.stateRoot, path: reader.path, heads: await reader.runtimeHeads(), counts: await reader.counts(), now: Date.now() });
        }
        if (url.pathname === "/api/runs") {
          const cursor = url.searchParams.get("cursor");
          const page = await reader.listRuns({ limit: clampLimit(url.searchParams.get("limit")), ...(cursor === null ? {} : { cursor }) });
          const index = await sessionIndex();
          const used: Record<string, SessionBrief> = {};
          for (const h of page.items) {
            const brief = h.sessionId === null ? undefined : index[h.sessionId];
            if (h.sessionId !== null && brief !== undefined) used[h.sessionId] = brief;
          }
          const body: RunsResponse = { ...page, sessions: used };
          return json(body);
        }
        const m = /^\/api\/runs\/([^/]+)$/.exec(url.pathname);
        if (m !== null) {
          const lookup = await reader.getRun(decodeURIComponent(m[1]!));
          if (lookup.kind === "unknown") return json({ kind: "unknown" }, 404);
          if (lookup.kind === "pruned") return json({ kind: "pruned", header: lookup.header, gaps: lookup.gaps });
          const rendered = renderRunObservation(lookup.observation, { format: "json" });
          return new Response(rendered.content, { headers: { "content-type": rendered.mediaType, "cache-control": "no-store" } });
        }
        return json({ error: "not found" }, 404);
      } catch (e) {
        // reader 抛错（corruption / 库被删）原样进响应：页面显示，不吞
        return json({ error: e instanceof Error ? e.message : String(e) }, 500);
      }
    },
  });
  // TCP 监听一定有端口；Bun 的类型把 unix socket 也算进去了，这里 fail-loud 而不是塞个 0
  const port = server.port;
  if (port === undefined) throw new Error("observe server 没拿到端口");
  return {
    url: `http://${hostname}:${port}`,
    port,
    stop: async () => {
      await server.stop(true);
    },
  };
}
