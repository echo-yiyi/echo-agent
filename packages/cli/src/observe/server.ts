// `echo-agent observe serve`：本地只读面板。`Bun.serve` 起一个 HTTP 服务，页面轮询 JSON。
//
// 数据面四条路由，全部走 `SessionObservationReaders`（每段会话一个 read-only reader，不取锁、不起 agent）：
//   GET /                        页面（vendor 的 token CSS + 术语表内联，零外部资源）
//   GET /api/runs?limit          各段会话的 run 合并后按 acceptedAt 倒序的一页 header + 这页用到的会话（产品名 / workspace）
//   GET /api/runs/<run-id>       `getRun()` → `RunObservationViewModel`（renderer 的 json 格式，UI 消费同一份 ViewModel）
//   GET /api/activity?limit      run 之外的记录（inbox 收件 / ack、闹钟投递……）合并后按 observedAt 倒序，带 sessionId
//   GET /api/health              会话根、每段的库路径 / runtime heads / 计数 / 最近 run
// reader 的每次查询都是短事务，页面轮询不会让 WAL 长住。
//
// 观测库归 session（状态根 = session 目录，2026-09-03），agent 集群里几段并行——面板缺省把会话根下**全部**有库的段
// 一起看，`--session` 才收窄到一段。`echo-agent` 与 `echo-coding` 缺省共用一个会话根，产品名（`SessionInfo.agent`）
// 与 workspace 是把它们分开看的依据。

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderRunObservation } from "@echo-agent/core/observability";
import { lexicon } from "./lexicon.ts";
import type { SessionObservationReaders } from "./sessions.ts";

export type ObserveServerOptions = Readonly<{
  readers: SessionObservationReaders;
  /** 缺省只绑 127.0.0.1：这是本机面板，不做鉴权，不能暴露到局域网。 */
  hostname?: string;
  /** 0 = 随机端口（测试用）。 */
  port?: number;
}>;

export type ObserveServer = Readonly<{
  url: string;
  port: number;
  /** 只停 HTTP；readers 归调用方关。 */
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

function clampLimit(raw: string | null, fallback: number): number {
  const n = Number(raw ?? "");
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(200, Math.floor(n));
}

export function startObserveServer(opts: ObserveServerOptions): ObserveServer {
  const readers = opts.readers;
  const hostname = opts.hostname ?? "127.0.0.1";
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
          return json({
            sessionsRoot: readers.opts.sessionsRoot,
            ...(readers.opts.sessionId === undefined ? {} : { sessionId: readers.opts.sessionId }),
            sessions: await readers.health(),
            // 会话清单读不出来时 run 照看，但产品名 / 工作目录会缺——原因如实报出，不让页面自己猜
            ...(readers.sessionsProblem === undefined ? {} : { sessionsProblem: readers.sessionsProblem }),
            now: Date.now(),
          });
        }
        if (url.pathname === "/api/runs") {
          return json(await readers.listRuns(clampLimit(url.searchParams.get("limit"), 50)));
        }
        if (url.pathname === "/api/activity") {
          return json({ items: await readers.activity(clampLimit(url.searchParams.get("limit"), 30)), sessions: readers.sessions });
        }
        const m = /^\/api\/runs\/([^/]+)$/.exec(url.pathname);
        if (m !== null) {
          const lookup = await readers.getRun(decodeURIComponent(m[1]!));
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
