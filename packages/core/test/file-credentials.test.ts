// 落盘凭据的判据：**路径、权限、解析顺序、以及「读不动就报错」**。
//
// 三条硬要求各自都有对应的测试，而且都造得出反例：
//   · 文件权限 0600 —— 直接读 `statSync().mode`，不是看代码里写了 0600；
//   · 环境变量优先于文件 —— 两边都设、**值不同**，断言真正发出去的那把 key 是环境变量那个；
//   · 读不动不当「没配过」 —— 坏 JSON / 不可读文件都断言 `rejects`，不是断言返回 undefined。

import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CREDENTIALS_FILE, FileCredentialStore } from "../src/provider/file-credentials.ts";
import { Models, createProvider } from "../src/provider/models.ts";
import { createProviderStreams } from "../src/provider/dialect.ts";
import { scriptedDialect, textTurn } from "../src/testing.ts";
import { kimiProvider } from "../src/provider/openai.ts";
import { createEcho } from "../src/create-echo.ts";

let home: string;
const ENV_KEYS = ["ECHO_HOME", "MOONSHOT_API_KEY", "ECHO_LLM_API_KEY"] as const;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "echo-cred-"));
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  // **每个环境变量都要清干净**：跑测试那台机器上真配了 key 的话，
  // 「缺凭据」这一整组判据会全部变成假绿。
  for (const k of ENV_KEYS) delete process.env[k];
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(home, { recursive: true, force: true });
});

/* ─────────────────────────── 路径与格式 ─────────────────────────── */

test("缺省路径跟着 ECHO_HOME 走，落在根上而**不进 agents/**", async () => {
  process.env["ECHO_HOME"] = home;
  const store = new FileCredentialStore();

  expect(store.path()).toBe(join(home, CREDENTIALS_FILE));
  await store.write("kimi", { type: "api_key", key: "sk-a" });

  // 凭据是跨 agent 共享的：它和 `agents/` 平级，不在某个 agent 的状态根里面
  expect(existsSync(join(home, "credentials.json"))).toBe(true);
  expect(existsSync(join(home, "agents"))).toBe(false);
});

test("缺省路径**每次现算**：构造之后才设 ECHO_HOME 也算数", async () => {
  const store = new FileCredentialStore();
  process.env["ECHO_HOME"] = home; // 构造之后才设
  expect(store.path()).toBe(join(home, CREDENTIALS_FILE));
  await store.write("kimi", { type: "api_key", key: "sk-a" });
  expect(existsSync(join(home, CREDENTIALS_FILE))).toBe(true);
});

test("ECHO_HOME 里的 `~` 会展开，不会建出一个名叫 `~` 的目录", () => {
  process.env["ECHO_HOME"] = "~/.echo-not-created-by-this-test";
  expect(new FileCredentialStore().path().startsWith("~")).toBe(false);
});

test("盘上格式：按 provider id 分键，值是**对象**（给 baseUrl / 过期时间留位置）", async () => {
  const file = join(home, CREDENTIALS_FILE);
  const store = new FileCredentialStore(file);
  await store.write("kimi", { type: "api_key", key: "sk-a" });
  await store.write("deepseek", { type: "api_key", key: "sk-b" });

  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
    kimi: { apiKey: "sk-a" },
    deepseek: { apiKey: "sk-b" },
  });
});

test("写→读→删 一轮；删掉的那条读回 undefined，别的条不受影响", async () => {
  const store = new FileCredentialStore(join(home, CREDENTIALS_FILE));
  await store.write("kimi", { type: "api_key", key: "sk-a" });
  await store.write("deepseek", { type: "api_key", key: "sk-b" });

  expect(await store.read("kimi")).toEqual({ type: "api_key", key: "sk-a" });
  await store.delete("kimi");
  expect(await store.read("kimi")).toBeUndefined();
  expect(await store.read("deepseek")).toEqual({ type: "api_key", key: "sk-b" });
});

test("老文件里的 oauth 那种记录（access / refresh / expires）认不出：判红，不静默当成没配（2026-09-09 摘掉 OAuth 半接线）", async () => {
  const file = join(home, CREDENTIALS_FILE);
  writeFileSync(file, JSON.stringify({ x: { access: "a", refresh: "r", expires: 123 }, kimi: { apiKey: "sk-a" } }), "utf8");
  const store = new FileCredentialStore(file);
  await expect(store.read("x")).rejects.toThrow("认不出来");
  await expect(store.read("x")).rejects.not.toThrow("refresh"); // 报错里不出现记录内容
  expect(await store.read("kimi")).toEqual({ type: "api_key", key: "sk-a" }); // 别的条不受影响
});

test("api_key 的 `env` 是来源标签，**不落盘**——落了下次读回来就是假的", async () => {
  const file = join(home, CREDENTIALS_FILE);
  const store = new FileCredentialStore(file);
  await store.write("kimi", { type: "api_key", key: "sk-a", env: "MOONSHOT_API_KEY" });

  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ kimi: { apiKey: "sk-a" } });
  expect(await store.read("kimi")).toEqual({ type: "api_key", key: "sk-a" });
});

/* ─────────────────────────── 权限 ─────────────────────────── */

test("凭据文件权限是 0600", async () => {
  const file = join(home, CREDENTIALS_FILE);
  await new FileCredentialStore(file).write("kimi", { type: "api_key", key: "sk-a" });
  expect(statSync(file).mode & 0o777).toBe(0o600);
});

test("重写一次之后**仍然**是 0600（临时文件 → rename 不许把权限放回默认）", async () => {
  const file = join(home, CREDENTIALS_FILE);
  const store = new FileCredentialStore(file);
  await store.write("kimi", { type: "api_key", key: "sk-a" });
  await store.write("deepseek", { type: "api_key", key: "sk-b" });
  expect(statSync(file).mode & 0o777).toBe(0o600);
});

test("**是我们创建**的父目录是 0700；已经存在的目录不替用户改权限", async () => {
  const mine = join(home, "made-by-us");
  await new FileCredentialStore(join(mine, CREDENTIALS_FILE)).write("kimi", { type: "api_key", key: "sk-a" });
  expect(statSync(mine).mode & 0o777).toBe(0o700);

  const theirs = join(home, "already-there");
  mkdirSync(theirs, { mode: 0o755 });
  chmodSync(theirs, 0o755); // mkdir 的 mode 会被 umask 削，显式设死再断言
  await new FileCredentialStore(join(theirs, CREDENTIALS_FILE)).write("kimi", { type: "api_key", key: "sk-a" });
  expect(statSync(theirs).mode & 0o777, "替用户改了他自己建的目录的权限").toBe(0o755);
});

test("写完不留临时文件（它带着 key）", async () => {
  const file = join(home, CREDENTIALS_FILE);
  await new FileCredentialStore(file).write("kimi", { type: "api_key", key: "sk-a" });
  expect(readdirSync(home).filter((n) => n.endsWith(".tmp"))).toEqual([]);
});

/* ────────────────── 读不动就报错，不当成「没配过」 ────────────────── */

test("文件不存在 = 没配过（这是唯一一种 undefined）", async () => {
  expect(await new FileCredentialStore(join(home, CREDENTIALS_FILE)).read("kimi")).toBeUndefined();
});

test("JSON 坏了 → **抛**，而且报错里没有 key 的任何片段", async () => {
  const file = join(home, CREDENTIALS_FILE);
  // **这份坏 JSON 是特意挑的**：值没有加引号，于是解析器把它当成一个标识符，
  // 并**把它原样抄进报错消息**。实测两个运行时都会漏：
  //   Bun  → `JSON Parse error: Unexpected identifier "skSUPERSECRETVALUE"`
  //   Node → `Unexpected token 's', ..."apiKey":skSUPERSE"... is not valid JSON`
  // 换成「少一个右括号」那种坏法，两边的报错里都不带原文——那样这条判据就是空的（实测过）。
  writeFileSync(file, '{"kimi":{"apiKey":skSUPERSECRETVALUE}}', "utf8");
  const store = new FileCredentialStore(file);

  await expect(store.read("kimi")).rejects.toThrow("不是合法 JSON");
  const message = await store.read("kimi").then(
    () => "没抛",
    // `cause` 也要一起看：把原始异常挂上去，同样会把那段原文带到用户面前
    (e: unknown) => (e instanceof Error ? `${e.message} ${String(e.cause ?? "")}` : String(e)),
  );
  expect(message, "报错把 key 抄出来了").not.toContain("skSUPERSECRETVALUE");
  expect(message, "报错把 key 的片段抄出来了").not.toContain("SUPERSECRET");
});

test("顶层不是对象 → 抛（不是当成空）", async () => {
  const file = join(home, CREDENTIALS_FILE);
  writeFileSync(file, '["kimi"]', "utf8");
  await expect(new FileCredentialStore(file).read("kimi")).rejects.toThrow("顶层应当是一个对象");
});

test("那一条认不出来 → 抛，且报错里只有 provider id 与路径，没有记录内容", async () => {
  const file = join(home, CREDENTIALS_FILE);
  writeFileSync(file, JSON.stringify({ kimi: { token: "sk-SUPER-SECRET-VALUE" } }), "utf8");
  const store = new FileCredentialStore(file);

  await expect(store.read("kimi")).rejects.toThrow("认不出来");
  const message = await store.read("kimi").then(
    () => "没抛",
    (e: unknown) => (e instanceof Error ? e.message : String(e)),
  );
  expect(message).toContain("kimi");
  expect(message, "报错把记录内容抄出来了").not.toContain("SUPER-SECRET-VALUE");
});

test("读不动（权限不对）→ 抛，不当成「没配过」", async () => {
  const file = join(home, CREDENTIALS_FILE);
  writeFileSync(file, JSON.stringify({ kimi: { apiKey: "sk-a" } }), "utf8");
  chmodSync(file, 0o000);
  try {
    // root 跑测试时 0000 也读得动——那种环境下这条断言没有意义，跳过而不是假绿
    let readable = true;
    try {
      readFileSync(file, "utf8");
    } catch {
      readable = false;
    }
    if (readable) return;
    await expect(new FileCredentialStore(file).read("kimi")).rejects.toThrow("读不了凭据文件");
  } finally {
    chmodSync(file, 0o600);
  }
});

/* ──────────── 解析顺序：环境变量 → 凭据文件 → 没有 ──────────── */

/** 记下真正发出去的 Authorization 头。**判据是「发了哪把 key」**，不是「resolve 返回了什么」。 */
function capturingFetch(): { fn: typeof fetch; authorizations: string[] } {
  const authorizations: string[] = [];
  const fn = (async (_url: unknown, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    authorizations.push(headers["authorization"] ?? headers["Authorization"] ?? "(没有)");
    return new Response("data: [DONE]\n\n");
  }) as typeof fetch;
  return { fn, authorizations };
}

async function keySentTo(store: FileCredentialStore): Promise<string> {
  const { fn, authorizations } = capturingFetch();
  const models = new Models(store);
  const provider = kimiProvider({ fetchFn: fn });
  models.setProvider(provider);
  const model = models.getModel("kimi", "kimi-k3")!;
  await models.complete(model, { systemPrompt: null, messages: [], tools: [] });
  return authorizations[0] ?? "(没发出去)";
}

test("环境变量优先于凭据文件——两边都设、值不同，发出去的是环境变量那把", async () => {
  const store = new FileCredentialStore(join(home, CREDENTIALS_FILE));
  await store.write("kimi", { type: "api_key", key: "sk-FROM-FILE" });
  process.env["MOONSHOT_API_KEY"] = "sk-FROM-ENV";

  expect(await keySentTo(store)).toBe("Bearer sk-FROM-ENV");
});

test("环境变量没有时才落到凭据文件——同一份文件，仅仅去掉环境变量就换了一把 key", async () => {
  const store = new FileCredentialStore(join(home, CREDENTIALS_FILE));
  await store.write("kimi", { type: "api_key", key: "sk-FROM-FILE" });
  delete process.env["MOONSHOT_API_KEY"];

  expect(await keySentTo(store)).toBe("Bearer sk-FROM-FILE");
});

test("`checkAuth` 与请求路径口径一致：文件里的 key 也算「配好了」", async () => {
  const store = new FileCredentialStore(join(home, CREDENTIALS_FILE));
  const models = new Models(store);
  models.setProvider(kimiProvider());

  // 什么都没有 → 未配置，目录里一个可用模型都没有
  expect(await models.checkAuth("kimi")).toBeUndefined();
  expect(await models.getAvailable("kimi")).toEqual([]);

  // 只写文件（环境变量仍然空着）→ 必须算「配好了」，否则装配会抛「没有可用模型」，
  // 而 `stream()` 那边其实用得了这把 key —— 同一个问题两个答案
  await store.write("kimi", { type: "api_key", key: "sk-FROM-FILE" });
  expect(await models.checkAuth("kimi")).toEqual({ source: "credentialStore" });
  expect((await models.getAvailable("kimi")).length).toBeGreaterThan(0);

  // 环境变量也设上 → source 变成那个环境变量的名字（谁赢看得见）
  process.env["MOONSHOT_API_KEY"] = "sk-FROM-ENV";
  expect(await models.checkAuth("kimi")).toEqual({ source: "MOONSHOT_API_KEY" });
});

test("本地无 key 的服务：`checkAuth` 说配好了，请求路径也真的发得出去——两处同一个数法（review 2026-09-07）", async () => {
  // 此前两处各判各的：checkAuth 认「resolve() 返回了对象」，stream 认「拿到了 apiKey 字符串」——
  // 文档点名支持的 keyless 服务正好踩中：checkAuth 配好了，stream 当场回 auth 错
  const models = new Models(new FileCredentialStore(join(home, CREDENTIALS_FILE)));
  models.setProvider(
    createProvider({
      id: "local",
      auth: { apiKey: { resolve: async () => ({}) } }, // 有鉴权语义、没有 key
      defaultModelId: "m",
      models: [{ id: "m", api: "fake" }],
      api: createProviderStreams(scriptedDialect([textTurn("ok")])),
    }),
  );
  expect(await models.checkAuth("local")).toEqual({ source: "apiKey" });
  const reply = await models.complete(
    { provider: "local", id: "m", api: "fake" },
    { systemPrompt: null, messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }], tools: [] },
  );
  expect(reply.content.some((b) => b.type === "text" && b.text === "ok")).toBe(true);
});

/* ──────────── 装配不看凭据：配置是运行态（2026-09-01 用户拍板） ──────────── */

test("没 key 也能 createEcho；缺 key 是第一句 prompt 报 `auth`，不是装配期抛", async () => {
  // 上一版这里会在 `createEcho()` 抛「没有可用模型」——于是用户一启动就被按在配置向导上。
  // pi / Claude Code 都是界面先起来、key 是进去之后的事：常驻 agent 的存活不以外围配置为前提。
  const echo = await createEcho({
    provider: kimiProvider(),
    credentials: new FileCredentialStore(join(home, CREDENTIALS_FILE)), // 空的
    stateDir: join(home, "state"),
    withoutMemory: true,
    extensionDirs: [],
    allowNetwork: false,
  });
  try {
    expect(echo.agent.state.model.id).toBe("kimi-k3"); // 模型照常解析——目录里有它就够
    await echo.agent.start();
    let code: string | undefined;
    const off = echo.agent.subscribe((ev) => {
      if (ev.type === "agent_end" && ev.outcome.kind === "error") code = ev.outcome.error.code;
    });
    await echo.agent.prompt("你好");
    off();
    // fail-loud 挪到了它该在的地方：请求路径每轮重解析 key，缺了就是一条诚实的 auth 错误
    expect(code).toBe("auth");
  } finally {
    await echo.stop();
  }
});
