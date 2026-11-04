// web_fetch 的判据：HTML 转文本（pre 原样、相对链接解析成绝对、按 charset 解码），以及不取内网地址
// （loopback、私网、链路本地、CGNAT、IPv6 同类；重定向逐跳重查）。直接调工具对象（不经装配）。
//
// 本机起的假服务在 127.0.0.1：要让请求真发出去，测试把主机名解析换成「解析到公网地址」（`resolveHost`）；
// 要测拦截，就用缺省解析或让解析结果落进内网段。

import { afterEach, expect, test } from "bun:test";
import type { ModelTool, ToolExecutionContext } from "@echo-agent/core";
import { htmlToText, isPrivateAddress, makeWebTools, type WebDeps } from "../src/tools/web.ts";

const ctx = (): ToolExecutionContext => ({ toolCallId: "t1", workspace: "/", sessionId: null, iteration: 0 });
const fetchTool = (deps: WebDeps = {}): ModelTool<{ url: string; max_chars?: number }> =>
  makeWebTools(deps).find((t) => t.name === "web_fetch") as ModelTool<{ url: string; max_chars?: number }>;
/** 一个公网地址（TEST-NET-3，不在拦截段里）：让本机假服务「看起来」在公网上。 */
const PUBLIC = "203.0.113.7";
const asPublic: WebDeps = { resolveHost: async () => [PUBLIC] };

let servers: { stop(force?: boolean): void }[] = [];
afterEach(() => {
  for (const s of servers) s.stop(true);
  servers = [];
});
function serve(handler: (req: Request) => Response): { base: string; hits: string[] } {
  const hits: string[] = [];
  const s = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      hits.push(new URL(req.url).pathname);
      return handler(req);
    },
  });
  servers.push(s);
  return { base: `http://127.0.0.1:${s.port}`, hits };
}

/* ══════════ HTML → 文本 ══════════ */

test("htmlToText：<pre> 里的缩进与换行原样保留（成一段代码块），实体只解一次", () => {
  const html = `<html><body><p>Example:</p><pre><code class="py">def f(x):
    if x &amp;&amp; y:
        return 1

    return 0
</code></pre><p>after   text</p></body></html>`;
  expect(htmlToText(html)).toBe("Example:\n\n```\ndef f(x):\n    if x && y:\n        return 1\n\n    return 0\n```\n\nafter text");
});

test("htmlToText：给了页面 URL 就把相对链接解析成绝对链接；页内锚点只留文字；绝对链接原样", () => {
  const html = `<p><a href="/docs/a">A</a> <a href="b.html">B</a> <a href="#top">T</a> <a href="https://h.test">https://h.test</a> <a href="mailto:x@y.z">mail</a></p>`;
  expect(htmlToText(html, "https://x.test/dir/page")).toBe("[A](https://x.test/docs/a) [B](https://x.test/dir/b.html) T https://h.test mail");
  expect(htmlToText(html)).toBe("A B T https://h.test mail"); // 没有页面 URL：相对链接只留文字（此前的行为）
});

test("web_fetch 按 Content-Type 的 charset 解码；没写就看 <meta charset>；认不出退 UTF-8；相对链接按最终 URL 解析", async () => {
  const gbk = new Uint8Array([0xc4, 0xe3, 0xba, 0xc3]); // 「你好」
  const { base } = serve((req) => {
    const p = new URL(req.url).pathname;
    if (p === "/header") return new Response(gbk, { headers: { "content-type": "text/plain; charset=GBK" } });
    if (p === "/meta") {
      const head = new TextEncoder().encode('<html><head><meta charset="gbk"><title>t</title></head><body><p>');
      const tail = new TextEncoder().encode('</p><a href="/x">x</a></body></html>');
      return new Response(new Uint8Array([...head, ...gbk, ...tail]), { headers: { "content-type": "text/html" } });
    }
    if (p === "/bogus") return new Response("héllo", { headers: { "content-type": "text/plain; charset=x-made-up" } });
    return new Response("nope", { status: 404 });
  });
  const f = fetchTool(asPublic);
  expect((await f.execute({ url: `${base}/header` }, ctx())).content).toBe("你好");
  expect((await f.execute({ url: `${base}/meta` }, ctx())).content).toBe(`t\n\n你好\n[x](${base}/x)`);
  expect((await f.execute({ url: `${base}/bogus` }, ctx())).content).toBe("héllo");
});

/* ══════════ 不取内网地址 ══════════ */

test("isPrivateAddress：loopback、私网、链路本地（含云元数据）、CGNAT、未指定、IPv6 同类与 IPv4 映射一律算内网；边界外的照常", () => {
  for (const ip of [
    "127.0.0.1", "127.255.255.254", "10.0.0.1", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254",
    "100.64.0.1", "100.127.255.255", "0.0.0.0", "0.1.2.3",
    "::1", "::", "fc00::1", "fd12:3456::1", "fe80::1", "febf::1", "::ffff:127.0.0.1", "::ffff:a9fe:a9fe", "::127.0.0.1", "fe80::1%lo0",
  ]) {
    expect([ip, isPrivateAddress(ip)]).toEqual([ip, true]);
  }
  for (const ip of ["8.8.8.8", "172.15.255.255", "172.32.0.1", "100.63.255.255", "100.128.0.0", "192.169.0.1", "203.0.113.7", "2001:4860:4860::8888", "fec0::1", "::ffff:8.8.8.8"]) {
    expect([ip, isPrivateAddress(ip)]).toEqual([ip, false]);
  }
  expect(isPrivateAddress("not-an-ip")).toBe(true); // 认不出的不放行
});

test("web_fetch 缺省拒绝内网地址：本机服务一次请求都收不到，报错说明这是安全限制", async () => {
  const { base, hits } = serve(() => new Response("internal-secret", { headers: { "content-type": "text/plain" } }));
  const port = new URL(base).port;
  const f = fetchTool();
  for (const url of [`${base}/admin`, `http://localhost:${port}/admin`, `http://[::1]:${port}/admin`, "http://169.254.169.254/latest/meta-data/", "http://10.0.0.1/", `http://[::ffff:127.0.0.1]:${port}/`]) {
    const r = await f.execute({ url }, ctx());
    expect([url, r.isError, r.content]).toEqual([url, true, expect.stringContaining("safety restriction")]);
    expect(r.content).not.toContain("internal-secret");
  }
  expect(hits).toEqual([]);
});

test("web_fetch 主机名解析出的地址任一落在内网段就拒", async () => {
  const f = fetchTool({ resolveHost: async () => [PUBLIC, "10.1.2.3"] });
  const r = await f.execute({ url: "http://mixed.test/" }, ctx());
  expect([r.isError, r.content]).toEqual([true, expect.stringContaining("10.1.2.3")]);
  expect(r.content).toContain("safety restriction");
});

test("web_fetch 重定向逐跳跟随、每跳重查：跳到内网就拒（不发出那一跳）；跳太多次报错；正常跳转照常并注明", async () => {
  const { base, hits } = serve((req) => {
    const u = new URL(req.url);
    if (u.pathname === "/start") return new Response(null, { status: 302, headers: { location: `http://localhost:${u.port}/admin` } });
    if (u.pathname === "/loop") return new Response(null, { status: 301, headers: { location: "/loop" } });
    if (u.pathname === "/hop") return new Response(null, { status: 307, headers: { location: "/final" } });
    if (u.pathname === "/final") return new Response("landed", { headers: { "content-type": "text/plain" } });
    return new Response("internal-secret", { headers: { "content-type": "text/plain" } });
  });
  // 127.0.0.1 当成公网（让第一跳发出去），localhost 照实解析成 loopback
  const f = fetchTool({ resolveHost: async (h) => (h === "localhost" ? ["127.0.0.1"] : [PUBLIC]) });
  const blocked = await f.execute({ url: `${base}/start` }, ctx());
  expect([blocked.isError, blocked.content]).toEqual([true, expect.stringContaining("safety restriction")]);
  expect(blocked.content).toContain("redirect");
  expect(hits).toEqual(["/start"]);

  const loop = await f.execute({ url: `${base}/loop` }, ctx());
  expect([loop.isError, loop.content]).toEqual([true, expect.stringContaining("Too many redirects")]);

  const ok = await f.execute({ url: `${base}/hop` }, ctx());
  expect([ok.isError, ok.content]).toEqual([false, `(redirected to ${base}/final)\nlanded`]);
});
