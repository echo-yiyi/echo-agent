// 首次运行配置流程的判据。**用假 TUI 驱动**（`fake-tui.ts`，与主界面同一个），
// 所以「问什么、收什么、验什么」全程可测，不需要真终端。
//
// 一次 `feed()` = 终端的一次数据到达：回车要单独喂，把 `"文本\r"` 当一块喂
// 等于模拟了一次不存在的输入（见 `fake-tui.ts` 的说明）。

import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FileCredentialStore,
  InMemoryCredentialStore,
  kimiProvider,
  deepseekProvider,
  type Credential,
  type CredentialStore,
} from "@echo-agent/core";
import { runCredentialSetup, verifyApiKey, type SetupChoice, type VerifyFn } from "../src/setup.ts";
import { fakeTui } from "./fake-tui.ts";

const ESC = String.fromCharCode(27);
const ENTER = "\r";
const CTRL_C = String.fromCharCode(3);
const DOWN = `${ESC}[B`;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "echo-setup-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const CHOICES: readonly SetupChoice[] = [
  { name: "kimi", provider: kimiProvider() },
  { name: "deepseek", provider: deepseekProvider() },
];

/** 推进微任务：假 TUI 不驱动事件循环。 */
async function flush(turns = 50): Promise<void> {
  for (let i = 0; i < turns; i++) await Promise.resolve();
}

/** 记下被问过的 key，好断言「验不过的那把没有落盘」。 */
function recordingVerify(outcomes: VerifyOutcomeScript): { verify: VerifyFn; asked: string[] } {
  const asked: string[] = [];
  let i = 0;
  const verify: VerifyFn = async ({ apiKey }) => {
    asked.push(apiKey);
    const o = outcomes[Math.min(i, outcomes.length - 1)];
    i += 1;
    return o!;
  };
  return { verify, asked };
}
type VerifyOutcomeScript = readonly ({ ok: true } | { ok: false; reason: string })[];

function type(ui: ReturnType<typeof fakeTui>, text: string): void {
  for (const ch of text) ui.feed(ch);
}

/* ─────────────────────────── 选 provider ─────────────────────────── */

test("一上来列出全部可选项，并说清这也决定这次用哪家", async () => {
  const ui = fakeTui();
  const done = runCredentialSetup({ choices: CHOICES, credentials: new InMemoryCredentialStore(), ui });
  await flush();

  const screen = ui.screen();
  expect(screen).toContain("还没有可用的凭据");
  expect(screen).toContain("Kimi (Moonshot)");
  expect(screen).toContain("DeepSeek");
  // `--provider` 的短名摆在屏幕上，用户才对得上命令行那个开关
  expect(screen).toContain("--provider kimi");
  expect(screen).toContain("--provider deepseek");

  ui.feed(CTRL_C);
  expect(await done).toEqual({ kind: "cancelled" });
});

test("`preselect` 把光标放在 `--provider` 指的那一家上", async () => {
  const ui = fakeTui();
  const done = runCredentialSetup({
    choices: CHOICES,
    credentials: new InMemoryCredentialStore(),
    preselect: "deepseek",
    ui,
  });
  await flush();

  const line = ui.screen().split("\n").find((l) => l.includes("DeepSeek"))!;
  expect(line, "光标没停在 --provider 指的那一家").toContain("❯");

  ui.feed(CTRL_C);
  await done;
});

test("↑/↓ 移光标，回车确认；也能用数字直选", async () => {
  for (const [keys, expected] of [
    [[DOWN, ENTER], "DeepSeek"],
    [["2"], "DeepSeek"],
    [["1"], "Kimi (Moonshot)"],
  ] as const) {
    const ui = fakeTui();
    const done = runCredentialSetup({ choices: CHOICES, credentials: new InMemoryCredentialStore(), ui });
    await flush();
    for (const k of keys) ui.feed(k);
    await flush();

    expect(ui.screen(), `按了 ${JSON.stringify(keys)} 之后没进到 ${expected} 的收 key 阶段`).toContain(
      `${expected} 的 API key`,
    );
    ui.feed(CTRL_C);
    await done;
  }
});

/* ─────────────────────────── 收 key：不回显 ─────────────────────────── */

test("输入的 key **一个字符都不上屏**，只画等长掩码", async () => {
  const ui = fakeTui();
  const done = runCredentialSetup({ choices: CHOICES, credentials: new InMemoryCredentialStore(), ui });
  await flush();
  ui.feed("1");
  type(ui, "sk-SECRET-9");
  await flush();

  const screen = ui.screen();
  expect(screen, "明文 key 上屏了").not.toContain("sk-SECRET-9");
  expect(screen, "明文 key 的片段上屏了").not.toContain("sk-");
  expect(screen, "掩码长度要跟着输入走，否则粘贴进没进来看不出来").toContain("•".repeat("sk-SECRET-9".length));

  ui.feed(CTRL_C);
  await done;
});

test("粘贴一整把 key（一次数据到达多字符）也收得下，且仍然不回显", async () => {
  const ui = fakeTui();
  const done = runCredentialSetup({ choices: CHOICES, credentials: new InMemoryCredentialStore(), ui });
  await flush();
  ui.feed("1");
  ui.feed("sk-PASTED-KEY"); // 粘贴 = 一整块
  await flush();

  expect(ui.screen()).not.toContain("sk-PASTED-KEY");
  expect(ui.screen()).toContain("•".repeat("sk-PASTED-KEY".length));

  ui.feed(CTRL_C);
  await done;
});

/* ─────────────────────────── 验一次，验过才写 ─────────────────────────── */

test("验过 → 写进凭据文件、返回选中的 provider，然后流程结束", async () => {
  const file = join(dir, "credentials.json");
  const credentials = new FileCredentialStore(file);
  const ui = fakeTui();
  const { verify, asked } = recordingVerify([{ ok: true }]);

  const done = runCredentialSetup({ choices: CHOICES, credentials, ui, verify });
  await flush();
  ui.feed("2"); // deepseek
  type(ui, "sk-GOOD");
  ui.feed(ENTER);
  const outcome = await done;

  expect(asked, "没有验，或验了不止一次").toEqual(["sk-GOOD"]);
  expect(outcome).toEqual({ kind: "configured", provider: CHOICES[1]!.provider });
  // **按选中那家的 provider.id 落键**（deepseek，不是 CLI 短名）
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ deepseek: { apiKey: "sk-GOOD" } });
  expect(await credentials.read("deepseek")).toEqual({ type: "api_key", key: "sk-GOOD" });
});

test("验不过 → **一个字节都不落盘**，屏幕说清原因，还能接着改", async () => {
  const file = join(dir, "credentials.json");
  const credentials = new FileCredentialStore(file);
  const ui = fakeTui();
  const { verify, asked } = recordingVerify([{ ok: false, reason: "这把 key 被端点拒了（HTTP 401）" }, { ok: true }]);

  const done = runCredentialSetup({ choices: CHOICES, credentials, ui, verify });
  await flush();
  ui.feed("1");
  type(ui, "sk-BAD");
  ui.feed(ENTER);
  await flush();

  // 第一次没过：屏幕上说了，而且**文件根本没被创建**
  expect(ui.screen()).toContain("验不过，没有保存");
  expect(ui.screen()).toContain("HTTP 401");
  expect(existsSync(file), "验不过却写了盘").toBe(false);
  // 原因里不许出现 key 本身
  expect(ui.screen()).not.toContain("sk-BAD");

  // 接着改：坏 key 留在缓冲区里，补几个字符再回车
  type(ui, "-FIXED");
  ui.feed(ENTER);
  const outcome = await done;

  expect(asked).toEqual(["sk-BAD", "sk-BAD-FIXED"]);
  expect(outcome.kind).toBe("configured");
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ kimi: { apiKey: "sk-BAD-FIXED" } });
});

test("正在验的时候不收键——回答不会被塞进下一个阶段", async () => {
  const ui = fakeTui();
  let release: (() => void) | null = null;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const verify: VerifyFn = async () => {
    await gate;
    return { ok: true };
  };

  const done = runCredentialSetup({ choices: CHOICES, credentials: new InMemoryCredentialStore(), ui, verify });
  await flush();
  ui.feed("1");
  type(ui, "sk-A");
  ui.feed(ENTER);
  await flush();

  expect(ui.screen()).toContain("正在验证…");
  type(ui, "XYZ"); // 验的过程中乱按
  await flush();
  expect(ui.screen(), "验证期间还在收键").toContain("正在验证…");

  release!();
  expect((await done).kind).toBe("configured");
});

test("空回车不算提交：不去验，也不报错", async () => {
  const ui = fakeTui();
  const { verify, asked } = recordingVerify([{ ok: true }]);
  const done = runCredentialSetup({ choices: CHOICES, credentials: new InMemoryCredentialStore(), ui, verify });
  await flush();
  ui.feed("1");
  ui.feed(ENTER);
  ui.feed(ENTER);
  await flush();

  expect(asked, "空输入也拿去验了").toEqual([]);
  expect(ui.screen()).not.toContain("验不过");

  ui.feed(CTRL_C);
  await done;
});

/* ─────────────────────────── 退出 ─────────────────────────── */

test("Ctrl+C / Ctrl+D 退出，且什么都没写", async () => {
  for (const key of [CTRL_C, String.fromCharCode(4)]) {
    const file = join(dir, `c-${key.charCodeAt(0)}.json`);
    const ui = fakeTui();
    const done = runCredentialSetup({ choices: CHOICES, credentials: new FileCredentialStore(file), ui });
    await flush();
    ui.feed("1");
    type(ui, "sk-TYPED-BUT-ABANDONED");
    ui.feed(key);

    expect(await done).toEqual({ kind: "cancelled" });
    expect(existsSync(file), "用户退出了却写了盘").toBe(false);
  }
});

test("已经 abort 过的 signal：不许挂着等一个永远不会来的按键", async () => {
  const controller = new AbortController();
  controller.abort();
  const ui = fakeTui();

  const raced = await Promise.race([
    runCredentialSetup({ choices: CHOICES, credentials: new InMemoryCredentialStore(), ui, signal: controller.signal }),
    new Promise((r) => setTimeout(() => r("卡住了"), 200)),
  ]);
  expect(raced, "预先 abort 的 signal 没能让配置流程收摊").toEqual({ kind: "cancelled" });
});

test("跑起来之后收到 abort（SIGINT）也收摊", async () => {
  const controller = new AbortController();
  const ui = fakeTui();
  const done = runCredentialSetup({
    choices: CHOICES,
    credentials: new InMemoryCredentialStore(),
    ui,
    signal: controller.signal,
  });
  await flush();
  controller.abort();
  expect(await done).toEqual({ kind: "cancelled" });
});

test("一个可选项都不给 → 立刻报错（空列表是调用方的 bug，不是一种界面状态）", async () => {
  await expect(
    runCredentialSetup({ choices: [], credentials: new InMemoryCredentialStore(), ui: fakeTui() }),
  ).rejects.toThrow("至少要有一个可选 provider");
});

test("写盘失败照抛：那不是 key 的问题，重输一遍也好不了", async () => {
  const failing: CredentialStore = {
    read: async () => undefined,
    write: async () => {
      throw new Error("~/.echo 不可写");
    },
    delete: async () => undefined,
  };
  const ui = fakeTui();
  const done = runCredentialSetup({ choices: CHOICES, credentials: failing, ui, verify: async () => ({ ok: true }) });
  await flush();
  ui.feed("1");
  type(ui, "sk-GOOD");
  ui.feed(ENTER);

  await expect(done).rejects.toThrow("~/.echo 不可写");
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

/** 类型出口的守门：`Credential` 是判别联合，写进去的就是 api_key 那一支。 */
test("落盘的凭据形状就是 `Credential` 的 api_key 那一支", async () => {
  const credentials = new InMemoryCredentialStore();
  const ui = fakeTui();
  const done = runCredentialSetup({ choices: CHOICES, credentials, ui, verify: async () => ({ ok: true }) });
  await flush();
  ui.feed("1");
  type(ui, "sk-GOOD");
  ui.feed(ENTER);
  await done;

  const got: Credential | undefined = await credentials.read("kimi");
  expect(got).toEqual({ type: "api_key", key: "sk-GOOD" });
});
