// 凭据配置段的判据（`setup.ts`）。它是主界面里的一个片段（`app.ts` 嵌它），不是一屏——
// 所以这里直接驱动组件：`handleInput()` 进、`render()` 出，不需要 TUI。
// 嵌进主界面之后的行为（顶替输入行、配好回来、Ctrl+D / Ctrl+C）在 `tui.test.ts`。
//
// 一次 `handleInput()` = 终端的一次数据到达：回车要单独喂。

import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileCredentialStore, InMemoryCredentialStore, kimiProvider, type CredentialStore } from "@echo-agent/core";
import { CredentialSetup, isConfigured, verifyApiKey, type CredentialSetupOptions, type VerifyFn } from "../src/setup.ts";

const ESC = String.fromCharCode(27);
const ENTER = "\r";

let dir: string;
const ENV_KEYS = ["MOONSHOT_API_KEY", "ECHO_LLM_API_KEY"] as const;
let saved: Record<string, string | undefined>;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "echo-setup-"));
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(dir, { recursive: true, force: true });
});

/** 推进微任务：验证是异步的。 */
async function flush(turns = 50): Promise<void> {
  for (let i = 0; i < turns; i++) await Promise.resolve();
}

/** 等真写盘：`FileCredentialStore` 走 `node:fs`，光推微任务等不到它，要让出一个宏任务。 */
async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 30));
}

const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");
const screenOf = (setup: CredentialSetup): string => strip(setup.render(80).join("\n"));
const type = (setup: CredentialSetup, text: string): void => {
  for (const ch of text) setup.handleInput(ch);
};

type Script = readonly ({ ok: true } | { ok: false; reason: string })[];
function recordingVerify(outcomes: Script): { verify: VerifyFn; asked: string[] } {
  const asked: string[] = [];
  let i = 0;
  const verify: VerifyFn = async ({ apiKey }) => {
    asked.push(apiKey);
    const o = outcomes[Math.min(i, outcomes.length - 1)]!;
    i += 1;
    return o;
  };
  return { verify, asked };
}

/** 一个装好的配置段 + 记录它回调了什么。 */
function setupWith(over: Partial<CredentialSetupOptions> = {}): {
  setup: CredentialSetup;
  configured: number[];
  errors: unknown[];
} {
  const configured: number[] = [];
  const errors: unknown[] = [];
  const setup = new CredentialSetup({
    provider: kimiProvider(),
    credentials: new InMemoryCredentialStore(),
    verify: async () => ({ ok: true }),
    onConfigured: () => configured.push(Date.now()),
    onError: (e) => errors.push(e),
    ...over,
  });
  return { setup, configured, errors };
}

/* ─────────────────────────── 屏幕上有什么 ─────────────────────────── */

test("说清给哪家配、怎么换家；不给 alternatives 就不提换家", () => {
  const { setup } = setupWith({ alternatives: ["deepseek", "openai"] });
  const screen = screenOf(setup);
  expect(screen).toContain("Kimi (Moonshot) 的 API key");
  expect(screen).toContain("--provider deepseek / openai");
  expect(screen).toContain("Ctrl+D 退出");

  const { setup: bare } = setupWith();
  expect(screenOf(bare)).not.toContain("--provider");
});

test("输入的 key **一个字符都不上屏**，只画等长掩码", () => {
  const { setup } = setupWith();
  type(setup, "sk-SECRET-9");
  const screen = screenOf(setup);
  expect(screen, "明文 key 上屏了").not.toContain("sk-SECRET-9");
  expect(screen, "明文 key 的片段上屏了").not.toContain("sk-");
  expect(screen, "掩码长度要跟着输入走，否则粘贴进没进来看不出来").toContain("•".repeat("sk-SECRET-9".length));
});

test("粘贴一整把 key（一次数据到达多字符）也收得下，且仍然不回显", () => {
  const { setup } = setupWith();
  setup.handleInput("sk-PASTED-KEY");
  expect(screenOf(setup)).not.toContain("sk-PASTED-KEY");
  expect(screenOf(setup)).toContain("•".repeat("sk-PASTED-KEY".length));
});

test("Kitty 的按键 release 不进缓冲区", () => {
  const { setup } = setupWith();
  setup.handleInput(`${ESC}[97u`); // 按下 a
  setup.handleInput(`${ESC}[97:3u`); // 松开 a
  expect(setup.isEmpty()).toBe(false);
  expect(screenOf(setup)).toContain("•"); // 恰好一个
  expect(screenOf(setup)).not.toContain("••");
});

test("isEmpty / clear：给 app.ts 判 Ctrl+D 与做 Ctrl+C 用", () => {
  const { setup } = setupWith();
  expect(setup.isEmpty()).toBe(true);
  type(setup, "abc");
  expect(setup.isEmpty()).toBe(false);
  setup.clear();
  expect(setup.isEmpty()).toBe(true);
  expect(screenOf(setup)).not.toContain("•");
});

/* ─────────────────────────── 验一次，验过才写 ─────────────────────────── */

test("验过 → 按 provider.id 写进凭据文件，回调 onConfigured", async () => {
  const file = join(dir, "credentials.json");
  const credentials = new FileCredentialStore(file);
  const { verify, asked } = recordingVerify([{ ok: true }]);
  const { setup, configured } = setupWith({ credentials, verify });

  type(setup, "sk-GOOD");
  setup.handleInput(ENTER);
  await settle();

  expect(asked, "没有验，或验了不止一次").toEqual(["sk-GOOD"]);
  expect(configured.length).toBe(1);
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ kimi: { apiKey: "sk-GOOD" } });
  expect(setup.isEmpty(), "写完缓冲区里还留着 key").toBe(true);
});

test("验不过 → **一个字节都不落盘**，屏幕说清原因（不含 key），还能接着改", async () => {
  const file = join(dir, "credentials.json");
  const { verify, asked } = recordingVerify([{ ok: false, reason: "这把 key 被端点拒了（HTTP 401）" }, { ok: true }]);
  const { setup, configured } = setupWith({ credentials: new FileCredentialStore(file), verify });

  type(setup, "sk-BAD");
  setup.handleInput(ENTER);
  await flush();

  expect(screenOf(setup)).toContain("验不过，没有保存");
  expect(screenOf(setup)).toContain("HTTP 401");
  expect(screenOf(setup)).not.toContain("sk-BAD");
  expect(existsSync(file), "验不过却写了盘").toBe(false);
  expect(configured).toEqual([]);

  type(setup, "-FIXED"); // 坏 key 留在缓冲区里，补几个字符再回车
  setup.handleInput(ENTER);
  await settle();

  expect(asked).toEqual(["sk-BAD", "sk-BAD-FIXED"]);
  expect(configured.length).toBe(1);
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ kimi: { apiKey: "sk-BAD-FIXED" } });
});

test("正在验的时候不收键——回答不会混进这把 key", async () => {
  let release: (() => void) | null = null;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const verify: VerifyFn = async () => {
    await gate;
    return { ok: true };
  };
  const { setup, configured } = setupWith({ verify });
  type(setup, "sk-A");
  setup.handleInput(ENTER);
  await flush();

  expect(screenOf(setup)).toContain("正在验证…");
  type(setup, "XYZ");
  expect(screenOf(setup), "验证期间还在收键").toContain("正在验证…");

  release!();
  await flush();
  expect(configured.length).toBe(1);
});

test("空回车不算提交：不去验，也不报错", async () => {
  const { verify, asked } = recordingVerify([{ ok: true }]);
  const { setup } = setupWith({ verify });
  setup.handleInput(ENTER);
  setup.handleInput(ENTER);
  await flush();
  expect(asked).toEqual([]);
  expect(screenOf(setup)).not.toContain("验不过");
});

test("写盘失败 → onError（不是 key 的问题，重输也好不了），不回调 onConfigured", async () => {
  const failing: CredentialStore = {
    read: async () => undefined,
    write: async () => {
      throw new Error("~/.echo 不可写");
    },
    delete: async () => undefined,
  };
  const { setup, configured, errors } = setupWith({ credentials: failing });
  type(setup, "sk-GOOD");
  setup.handleInput(ENTER);
  await flush();

  expect(configured).toEqual([]);
  expect(errors.map((e) => (e instanceof Error ? e.message : String(e)))).toEqual(["~/.echo 不可写"]);
  expect(setup.isEmpty(), "失败之后缓冲区里还留着 key").toBe(true);
});

test("dispose 之后在飞的验证结果**不落盘**、不回调（用户退出了）", async () => {
  const file = join(dir, "credentials.json");
  let release: (() => void) | null = null;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const verify: VerifyFn = async () => {
    await gate;
    return { ok: true };
  };
  const { setup, configured } = setupWith({ credentials: new FileCredentialStore(file), verify });
  type(setup, "sk-GOOD");
  setup.handleInput(ENTER);
  await flush();
  setup.dispose();
  release!();
  await settle();

  expect(existsSync(file), "退出之后还把 key 写盘了").toBe(false);
  expect(configured).toEqual([]);
});

/* ─────────────────────────── isConfigured：与请求路径同一个判据 ─────────────────────────── */

test("isConfigured：什么都没有 → false；凭据文件里有 → true；只有环境变量 → true", async () => {
  const store = new FileCredentialStore(join(dir, "credentials.json"));
  expect(await isConfigured(kimiProvider(), store)).toBe(false);

  await store.write("kimi", { type: "api_key", key: "sk-file" });
  expect(await isConfigured(kimiProvider(), store)).toBe(true);

  process.env["MOONSHOT_API_KEY"] = "sk-env";
  expect(await isConfigured(kimiProvider(), new InMemoryCredentialStore())).toBe(true);
});

/* ─────────────────────────── verifyApiKey 自己 ─────────────────────────── */

test("verifyApiKey：key 只进 Authorization 头，绝不进 URL", async () => {
  let seen: { url: string; auth: string | undefined } | null = null;
  const fetchFn = (async (url: unknown, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    seen = { url: String(url), auth: headers["authorization"] };
    return new Response("{}", { status: 200 });
  }) as typeof fetch;

  const outcome = await verifyApiKey({ provider: kimiProvider(), apiKey: "sk-SECRET", fetchFn });

  expect(outcome).toEqual({ ok: true });
  expect(seen!.url).toBe("https://api.moonshot.cn/v1/models");
  expect(seen!.url, "key 进了 URL——会被日志和代理记下来").not.toContain("sk-SECRET");
  expect(seen!.auth).toBe("Bearer sk-SECRET");
});

test("verifyApiKey：401/403 说「被拒了」，其他非 2xx 说「没能确认」——都不含 key", async () => {
  // 参数要写出来：零参函数转 `typeof fetch` 过不了 TS 的重叠检查（`preconnect` 缺失）
  const respond = (status: number): typeof fetch =>
    (async (_url: unknown, _init?: RequestInit) => new Response("nope", { status })) as typeof fetch;

  for (const status of [401, 403]) {
    const o = await verifyApiKey({ provider: kimiProvider(), apiKey: "sk-SECRET", fetchFn: respond(status) });
    expect(o.ok).toBe(false);
    expect(!o.ok && o.reason).toContain("被端点拒了");
    expect(!o.ok && o.reason).not.toContain("sk-SECRET");
  }
  const o = await verifyApiKey({ provider: kimiProvider(), apiKey: "sk-SECRET", fetchFn: respond(500) });
  expect(o.ok).toBe(false);
  expect(!o.ok && o.reason).toContain("没能确认");
  expect(!o.ok && o.reason).not.toContain("sk-SECRET");
});

test("verifyApiKey：连不上也是「没验过」，不是「验过了」", async () => {
  // 返回类型要显式写 `Promise<Response>`：只抛不返回的话推断成 `Promise<never>`，转不过去
  const fetchFn = (async (_url: unknown, _init?: RequestInit): Promise<Response> => {
    throw new Error("getaddrinfo ENOTFOUND");
  }) as typeof fetch;
  const o = await verifyApiKey({ provider: kimiProvider(), apiKey: "sk-SECRET", fetchFn });
  expect(o.ok).toBe(false);
  expect(!o.ok && o.reason).toContain("连不上");
});

test("verifyApiKey：provider 没有 baseUrl 就明说验不了，不假装验过", async () => {
  const bare = { ...kimiProvider(), baseUrl: undefined } as ReturnType<typeof kimiProvider>;
  const fetchFn = (async (_url: unknown, _init?: RequestInit) => new Response("{}")) as typeof fetch;
  const o = await verifyApiKey({ provider: bare, apiKey: "sk-x", fetchFn });
  expect(o.ok).toBe(false);
  expect(!o.ok && o.reason).toContain("没法验证");
});
