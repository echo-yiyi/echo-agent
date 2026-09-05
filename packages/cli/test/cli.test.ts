// `echo-agent` 的判据（管道形态 + 命令行面）。判据跟着它的实现住在本包。
//
// 分两层，故意分开：
//   · `run()` / `parseArgs()` —— 进程内直接调，验行为；
//   · `bin/echo-agent.ts` —— 真 spawn，验「这个可执行文件确实能被执行、退出码是那么回事」。
//     只 spawn 不验行为、或只测函数不 spawn，都会留下「装起来跑不了」的缺口。
//
// 交互形态的判据在 `tui.test.ts` 与 `extension.test.ts`。

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createEcho,
  createProvider,
  createProviderStreams,
  FileCredentialStore,
  FileDir,
  kimiProvider,
  SessionService,
  listSessions,
  toolOk,
  type Agent,
  type Context,
  type Echo,
  type Model,
  type ModelTool,
  type Provider,
  type ProviderEvent,
} from "@echo-agent/core";
import { textTurn, toolTurn } from "@echo-agent/core/testing";
import { AgentRuntimeService, defineExtension } from "@echo-agent/core/extension";
import { PassThrough } from "node:stream";
import { echoOptions, main, mainFor, parseArgs, usage } from "../src/cli.ts";
import { ECHO_AGENT, type PresetForm } from "../src/product.ts";
import { isConfigured } from "../src/setup.ts";
import { fakeTui } from "./fake-tui.ts";
import { linesOf } from "../src/stdin.ts";
import { run, type Sink } from "../src/run.ts";

const BIN = join(import.meta.dir, "..", "bin", "echo-agent.ts");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "echo-cli-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function sink(): Sink & { text: string } {
  const box = {
    text: "",
    write(s: string) {
      box.text += s;
    },
  };
  return box;
}

const pingTool: ModelTool = {
  kind: "model",
  name: "ping",
  label: "ping",
  description: "回一个 pong",
  parameters: { type: "object", properties: {} },
  execute: async () => toolOk("pong"),
};

/**
 * 确定性 provider（同 `packages/core/test/fixtures/resident-host.ts` 的做法：
 * 记录点放 dialect 里，配 provider 天经地义）。脚本按轮次消费，用尽即报错——
 * 这正好被「某一轮出错」那条测试拿来造错。
 */
function scriptedProvider(turns: ProviderEvent[][]): Provider {
  let i = 0;
  return createProvider({
    id: "runner-test",
    auth: { apiKey: { resolve: async () => ({ apiKey: "x" }) } },
    defaultModelId: "only",
    models: [{ id: "only", api: "runner-test" }],
    api: createProviderStreams({
      api: "runner-test",
      async *request(_model: Model, _context: Context): AsyncGenerator<ProviderEvent> {
        const turn = turns[i++];
        if (turn === undefined) {
          yield { type: "error", error: { source: "provider", code: "protocol", retryable: false, message: "脚本用尽" } };
          return;
        }
        for (const ev of turn) yield structuredClone(ev);
      },
    }),
  });
}

/**
 * **走真装配**（`createEcho` —— §14.2 的唯一 composition root）而不是 `new Agent`：
 * Runner 面对的就是这一个。落盘默认件、单写者锁、`start()` 的恢复顺序、以及
 * builtin extension 装上来的工具面，都只在这条路上才存在——
 * 用低层 `new Agent` 测，「收摊后锁没了」这类判据压根无从谈起。
 *
 * `allowNetwork: false`：不许为了刷模型目录联网。`withoutMemory: true`：不开 Dream，
 * 本文件验的是 Runner 不是记忆。`extensionDirs: []`：关掉磁盘发现，
 * 免得跑测试那台机器上碰巧有个 `extensions/` 目录就把判据搅了。
 */
async function agentWith(turns: ProviderEvent[][], tools: ModelTool[] = []): Promise<Echo> {
  return createEcho({
    provider: scriptedProvider(turns),
    stateDir: dir,
    allowNetwork: false,
    withoutMemory: true,
    extensionDirs: [],
    ...(tools.length > 0 ? { agent: { tools } } : {}),
  });
}

test("每行输入跑一轮:正文进 out、工具旁白进 err、退出码 0", async () => {
  const out = sink();
  const err = sink();
  const echo = await agentWith([textTurn("第一句"), toolTurn("c1", "ping", {}), textTurn("第二句")], [pingTool]);

  const code = await run({ echo, input: ["你好", "再来"], out, err });

  expect(code).toBe(0);
  expect(out.text).toContain("第一句");
  expect(out.text).toContain("第二句");
  // 工具动静走 err:正文与旁白分流,管道里 `echo-agent start > out.txt` 才拿得到干净正文
  expect(err.text).toContain("[工具] ping");
  expect(out.text, "工具旁白混进正文了").not.toContain("[工具]");
});

test("空行跳过,不白跑一轮模型", async () => {
  const out = sink();
  // 脚本只有一轮:空行如果也进 prompt,第二轮会「脚本用尽」而报错
  const echo = await agentWith([textTurn("只这一句")]);

  const code = await run({ echo, input: ["", "   ", "唯一一句"], out, err: sink() });

  expect(code).toBe(0);
  expect(out.text).toContain("只这一句");
});

test("某一轮出错:退出码 1,错误进 err,但后面的输入照跑", async () => {
  const out = sink();
  const err = sink();
  // 第一轮脚本用尽 → error;第二轮有脚本 → 正常
  const echo = await agentWith([]);

  const code = await run({ echo, input: ["会错的一句"], out, err });

  expect(code).toBe(1);
  expect(err.text).toContain("[错误]");
});

test("输入耗尽即收摊:状态落盘、锁已释放(dispose 真的跑了)", async () => {
  const echo = await agentWith([textTurn("好")]);
  await run({ echo, input: ["记一笔"], out: sink(), err: sink() });

  // `.lock` 在 dispose 的最后一段被删掉。它还在 = 没收摊,下一个进程会被挡在门外。
  expect(existsSync(join(dir, ".lock")), "收摊后锁还在").toBe(false);
  // 会话落盘:证明 start() 真的跑过而不是被跳过。`stateDir` 就是这一段自己的目录(2026-09-03),
  // 所以 meta 与 entries 在它的根上,不再有 `sessions/<id>/` 那一层。
  expect(existsSync(join(dir, "meta.json")), "会话没落盘,start() 恐怕没跑").toBe(true);
});

test("abort:停止收新输入,并且照样干净收摊", async () => {
  const out = sink();
  const controller = new AbortController();
  const echo = await agentWith([textTurn("第一句"), textTurn("不该跑到这句")]);

  // 输入源自己不响应信号(数组就不响应)——这正是 run() 里每轮都要看一次 signal 的理由
  async function* input(): AsyncGenerator<string> {
    yield "第一句";
    controller.abort();
    yield "第二句";
  }

  const code = await run({ echo, input: input(), out, err: sink(), signal: controller.signal });

  expect(code).toBe(0);
  expect(out.text).toContain("第一句");
  expect(out.text, "abort 之后还在收新输入").not.toContain("不该跑到这句");
  expect(existsSync(join(dir, ".lock")), "被中止时没收摊").toBe(false);
});

/* ─────────────────────────── 参数解析:不认识就报错 ─────────────────────────── */

test("parseArgs:认识的都认得出", () => {
  // 空 argv **不再是打帮助**：两个 CLI 并成一个之后，`echo-agent` 光秃秃地敲下去
  // 就是「按缺省起来」——交互形态下那才是用户要的（原 `echo-agent start` 的 start
  // 是唯一的子命令，等于噪音，2026-08-31 一并去掉）。
  // D7 起 `provider` 不再有解析期缺省：**不给 = 没说**，缺省与「记住上次」的合成在 main() 里做
  expect(parseArgs([])).toEqual({ withoutMemory: false, extensionDirs: [], continueLast: false });
  expect(parseArgs(["--provider", "deepseek", "--no-memory", "--agent-id", "a1"])).toEqual({
    provider: "deepseek",
    withoutMemory: true,
    agentId: "a1",
    extensionDirs: [],
    continueLast: false,
  });
  expect(parseArgs(["--help"])).toBeNull();
  expect(parseArgs(["-h"])).toBeNull();
});

test("parseArgs:`--observe <档>` 只认 off / metadata / content，不给就不出现在结果里（core 缺省 metadata）", () => {
  expect(parseArgs(["--observe", "content"])).toEqual({ withoutMemory: false, extensionDirs: [], continueLast: false, observe: "content" });
  expect(parseArgs(["--observe", "off"])?.observe).toBe("off");
  expect(parseArgs([])).not.toHaveProperty("observe");
  expect(() => parseArgs(["--observe", "full"])).toThrow("--observe 只能是 off / metadata / content");
  expect(() => parseArgs(["--observe"])).toThrow("缺一个值");
});

test("parseArgs:`--continue` / `--resume <id>` 各自认得，两个一起给就报错", () => {
  // 2026-09-01 用户拍板：缺省每次启动新建会话，续上次是显式动作
  expect(parseArgs(["--continue"])).toMatchObject({ continueLast: true });
  expect(parseArgs(["--resume", "s-abc"])).toMatchObject({ resume: "s-abc", continueLast: false });
  expect(() => parseArgs(["--resume"])).toThrow("缺一个值");
  expect(() => parseArgs(["--continue", "--resume", "s-abc"])).toThrow("只能给一个");
});

test("parseArgs:`--extensions` 可重复,给了就只用给的", () => {
  // 空数组与「没传」是两回事：前者走约定目录 `<cwd>/extensions`，后者才是显式指定。
  // 合并前这条只有交互形态有，管道形态压根没有 `--extensions`——**并成一个 CLI 之后两边都有了**。
  expect(parseArgs(["--extensions", "a", "--extensions", "b"])).toMatchObject({ extensionDirs: ["a", "b"] });
});

test("parseArgs:CLI 内置五家都认得（开源验收第 2 条）", () => {
  // minimax 2026-08-30 回到清单：目录换成 **M3** 之后 thinking 可以关掉，不再需要先改消息契约。
  // 上一版把它摘出去，是因为当时挂的是 M2.x——那个关不掉，列进 CLI 就是许诺一个跑起来行为不对的选项。
  //
  // **这条正是「两个 CLI 会分家」的实证**：合并前交互形态那个只认 kimi / deepseek 两家，
  // 加 provider 时漏改了它——同一个产品，两处参数解析，永远只有一处被想起来。
  for (const name of ["kimi", "deepseek", "openai", "zai", "minimax"]) {
    expect(parseArgs(["--provider", name])).toMatchObject({ provider: name });
  }
});

test("parseArgs:不认识的一律 throw,不静默按缺省跑", () => {
  expect(() => parseArgs(["serve"])).toThrow("不认识的选项");
  expect(() => parseArgs(["--stat-dir", "/x"])).toThrow("不认识的选项");
  // 用一个**确实不存在**的名字：`openai` 2026-08-28 起是内置的一家了
  expect(() => parseArgs(["--provider", "没这家"])).toThrow("不认识的 provider");
  // 文档里不许出现 CLI 不认的选项（review P2：注释曾写 `--base-url`，实际会以「不认识的选项」退出）
  expect(() => parseArgs(["--base-url", "https://x"])).toThrow("不认识的选项");
  // 缺值不许把下一个 flag 当值吞掉
  expect(() => parseArgs(["--model", "--no-memory"])).toThrow("缺一个值");
  expect(() => parseArgs(["--state-dir"])).toThrow("缺一个值");
  expect(() => parseArgs(["--extensions"])).toThrow("缺一个值");
});

/* ─────────────────────────── 可执行文件本身 ─────────────────────────── */

function spawnBin(args: string[], env: Record<string, string> = {}): { code: number; out: string; err: string } {
  const r = Bun.spawnSync(["bun", BIN, ...args], {
    env: { ...process.env, ...env },
    stdin: new Blob([""]), // 立刻 EOF,免得 start 挂在等输入上
  });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

test("bin:--help 打用法并以 0 退出", () => {
  const r = spawnBin(["--help"]);
  expect(r.code).toBe(0);
  expect(r.out).toContain(usage("echo-agent").split("\n")[0]!);
});

test("bin:参数错以 2 退出,并把错因说出来", () => {
  const r = spawnBin(["--nope"]);
  expect(r.code).toBe(2);
  expect(r.err).toContain("不认识的选项");
});

test("bin:缺凭据诚实拒跑——不退化成假模型", () => {
  // 把两个 key 都清掉。缺凭据时 `createEcho` 解析不出模型,必须**报错退出**;
  // 静默跑起来（哪怕跑的是空目录）才是本仓最不能接受的那种失败。
  //
  // **`ECHO_HOME` 必须指到一个空目录**（2026-08-31 起）：凭据的解析顺序现在是
  // 「环境变量 → 凭据文件 → 没有」，跑测试那台机器上真有 `~/.echo/credentials.json` 的话，
  // 只清环境变量根本不构成「缺凭据」，这条判据会静默变成假绿。
  const r = spawnBin(["--state-dir", join(dir, "state")], {
    MOONSHOT_API_KEY: "",
    ECHO_LLM_API_KEY: "",
    ECHO_HOME: join(dir, "home"),
  });
  expect(r.code).not.toBe(0);
  expect(r.err.length, "拒跑了却不说为什么").toBeGreaterThan(0);
});

/* ────────── 2026-08-24 review 的两条：done-only provider · 预先 abort ────────── */

/** 只发 `done` 的一轮——Core §6.1 契约③ 明说这是**最低实现门槛**（CLI 这类无流式后端）。 */
function bareDoneTurn(text: string): ProviderEvent[] {
  return [
    {
      type: "done",
      message: { role: "assistant", content: [{ type: "text", text }], stopReason: "end_turn", usage: null },
    },
  ];
}

test("done-only provider 的正文不许丢（只订阅 delta 会只剩一个换行）", async () => {
  const out = sink();
  const echo = await agentWith([bareDoneTurn("直出正文")]);

  const code = await run({ echo, input: ["说一句"], out, err: sink() });

  expect(code).toBe(0);
  expect(out.text, "只发 done 的 provider，正文整段丢了").toContain("直出正文");
});

test("流式那条不许打两遍（补打只在没流过的时候）", async () => {
  const out = sink();
  const echo = await agentWith([textTurn("流式正文")]);

  await run({ echo, input: ["说一句"], out, err: sink() });

  // `textTurn` 既发 delta 又发 done：补打逻辑要认得出来，否则正文出现两次
  expect(out.text.split("流式正文").length - 1, "正文被打了不止一遍").toBe(1);
});

test("已经 abort 过的 signal：不许卡在 stdin 上等一行永远不来的输入", async () => {
  // `addEventListener("abort")` 只等**将来**的 abort。SIGINT 落在 createAgent() 期间时，
  // 等 linesOf() 开始读，abort 早就过去了——上一版会在这里永久挂住。
  const controller = new AbortController();
  controller.abort();
  const stream = new PassThrough(); // 空流，永远不给行

  const lines: string[] = [];
  const drained = (async () => {
    for await (const line of linesOf(stream, controller.signal)) lines.push(line);
    return "结束了";
  })();

  const raced = await Promise.race([drained, new Promise((r) => setTimeout(() => r("卡住了"), 200))]);
  expect(raced, "预先 abort 的 signal 没能让输入源收摊").toBe("结束了");
  expect(lines).toEqual([]);
});

test("已经 abort 过的 signal：run() 也不进输入循环，且照样干净收摊", async () => {
  const controller = new AbortController();
  controller.abort();
  const echo = await agentWith([textTurn("不该被跑到")]);
  const out = sink();

  const code = await run({ echo, input: ["不该被消费"], out, err: sink(), signal: controller.signal });

  expect(code).toBe(0);
  expect(out.text, "abort 在先，却还是跑了一轮").not.toContain("不该被跑到");
  expect(existsSync(join(dir, ".lock")), "没收摊").toBe(false);
});

/* ══════════════ 缺凭据：形态决定策略（2026-09-01：配置是运行态，不阻塞启动） ══════════════ */
//
// 一张表两行，两行**各有一条判据**，而且都造得出反例：
//   · 管道 / 重定向 → **启动前**报错、退出码 1（连装配都不做）
//   · 终端         → **照样起来**，缺 key 在主界面里配；配好不用重启
//
// 判据是 `isConfigured()`——与请求路径同一个 `Models.checkAuth()`，不匹配错误文案。

/** 干净的环境：两个 key 都清掉，`ECHO_HOME` 指到本次的临时目录。 */
function isolate(): () => void {
  const keys = ["MOONSHOT_API_KEY", "ECHO_LLM_API_KEY", "ECHO_HOME"] as const;
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) delete process.env[k];
  process.env["ECHO_HOME"] = join(dir, "home");
  return () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

async function waitFor(check: () => boolean, what: string, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`等不到：${what}`);
}

test("isConfigured：环境变量空着、文件里没有 → false；文件里有 → true", async () => {
  const restore = isolate();
  try {
    const credentials = new FileCredentialStore(join(dir, "credentials.json"));
    expect(await isConfigured(kimiProvider(), credentials)).toBe(false);
    await credentials.write("kimi", { type: "api_key", key: "sk-FROM-FILE" });
    expect(await isConfigured(kimiProvider(), credentials)).toBe(true);
  } finally {
    restore();
  }
});

test("main:非交互 + 缺凭据 → 退出码 1，而且是在**启动前**拦下的（状态根没被碰过）", async () => {
  const restore = isolate();
  try {
    const code = await main(["--state-dir", join(dir, "state"), "--no-memory", "--extensions", dir], false);
    expect(code).toBe(1);
    // 装配本身不看凭据了——不在这里先拦，管道形态会「起来再在第一句报 auth」，状态根就被碰过了
    expect(existsSync(join(dir, "state")), "缺凭据的管道形态把 agent 装起来了").toBe(false);
  } finally {
    restore();
  }
});

test("main:交互 + 缺凭据 → 引导设置：欢迎 → 选 provider → 贴 key → 选模型 → 直接进对话", async () => {
  const restore = isolate();
  const ui = fakeTui();
  try {
    const running = main(["--state-dir", join(dir, "state"), "--no-memory", "--extensions", dir], true, {
      ui,
      credentials: new FileCredentialStore(join(dir, "credentials.json")),
      verify: async () => ({ ok: true }),
    });
    // 第一眼是欢迎 + provider 列表（D4：样子照 Claude Code 的选择器，列表在说明下面）
    await waitFor(() => ui.screen().includes("选择 provider"), "引导设置第一屏");
    expect(ui.screen()).toContain("echo-agent"); // 欢迎头在上
    expect(ui.screen()).toContain("1. Kimi (Moonshot)");
    expect(ui.screen()).toContain("5. MiniMax");
    expect(ui.screen()).toContain("kimi-k3"); // 描述列来自目录

    ui.feed("2"); // 数字直选 DeepSeek
    await waitFor(() => ui.screen().includes("DeepSeek 的 API key"), "收 key");
    for (const ch of "sk-GOOD") ui.feed(ch);
    ui.feed("\r");
    await waitFor(() => ui.screen().includes("选择模型"), "选模型");
    expect(ui.screen()).toContain("✓"); // 缺省项标着、预选中
    ui.feed("2"); // **故意不选缺省**：选缺省的话「选的模型进没进装配」根本分不出来

    // 直接进对话，欢迎头印着选的那家、选的那个模型——证明选择真的流进了 createEcho
    await waitFor(() => ui.screen().includes("模型 deepseek-v4-pro · deepseek"), "主界面（用选的那家那个模型）");
    // key 按选中那家的 provider.id 落盘
    expect(JSON.parse(readFileSync(join(dir, "credentials.json"), "utf8"))).toEqual({ deepseek: { apiKey: "sk-GOOD" } });

    ui.feed(String.fromCharCode(4)); // Ctrl+D 退出
    expect(await running).toBe(0);
  } finally {
    restore();
  }
});

test("main:交互 + 缺凭据，引导设置里 Ctrl+D → 不启动，退出码 1，什么都没写", async () => {
  const restore = isolate();
  const ui = fakeTui();
  try {
    const running = main(["--state-dir", join(dir, "state"), "--no-memory", "--extensions", dir], true, {
      ui,
      credentials: new FileCredentialStore(join(dir, "credentials.json")),
      verify: async () => ({ ok: true }),
    });
    await waitFor(() => ui.screen().includes("选择 provider"), "引导设置第一屏");
    ui.feed(String.fromCharCode(4));

    // 引导设置在装配**前**：退出时什么都还没起来，1 是对的（与旧「配置段里退出 → 0」不同，
    // 那时 agent 已经装配并启动了）
    expect(await running).toBe(1);
    expect(existsSync(join(dir, "credentials.json")), "用户退出了却写了盘").toBe(false);
    expect(existsSync(join(dir, "state")), "没配就退出，状态根不该被碰").toBe(false);
  } finally {
    restore();
  }
});

/* ══════════════ 坏扩展不阻塞启动（D6）：跳过 + 界面里看得见 ══════════════ */

test("main:交互 + 扩展目录里有坏文件 → 照样起来，屏幕上一条「[扩展] 没装上」，好的照用", async () => {
  const restore = isolate();
  const ui = fakeTui();
  try {
    const ext = join(dir, "extensions");
    mkdirSync(ext, { recursive: true });
    writeFileSync(join(ext, "broken.ts"), "export const x = 1;\n"); // 没有默认导出
    const credentials = new FileCredentialStore(join(dir, "credentials.json"));
    await credentials.write("kimi", { type: "api_key", key: "sk-ok" });

    const running = main(["--state-dir", join(dir, "state"), "--no-memory", "--extensions", ext], true, {
      ui,
      credentials,
    });
    await waitFor(() => ui.screen().includes("模型 kimi-k3"), "主界面");
    await waitFor(() => ui.screen().includes("[扩展] 没装上"), "装配诊断上屏");
    expect(ui.screen()).toContain("broken.ts"); // 指名道姓，用户才知道去修哪个文件

    ui.feed(String.fromCharCode(4));
    expect(await running).toBe(0); // 坏扩展不改退出码——它没挡住任何事
  } finally {
    restore();
  }
});

test("bin:管道形态 + 坏扩展 → 照样跑，诊断进 stderr，退出码不受影响", () => {
  const ext = join(dir, "extensions");
  mkdirSync(ext, { recursive: true });
  writeFileSync(join(ext, "broken.ts"), "export const x = 1;\n");
  const home = join(dir, "home");
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "credentials.json"), JSON.stringify({ kimi: { apiKey: "sk-ok" } }));

  const r = spawnBin(["--state-dir", join(dir, "state"), "--no-memory", "--extensions", ext], {
    MOONSHOT_API_KEY: "",
    ECHO_LLM_API_KEY: "",
    ECHO_HOME: home,
  });
  // 空 stdin：一行输入都没有，起得来就 0 退出
  expect(r.code).toBe(0);
  expect(r.err).toContain("[扩展]");
  expect(r.err).toContain("broken.ts");
});

/* ══════════════ 记住上次的选择（D7）：切换了之后，重启还要能用 ══════════════ */

test("main:向导里选的家和模型，**下一次启动直接生效**——不再进向导、欢迎头印着上次选的", async () => {
  const restore = isolate();
  const ui1 = fakeTui();
  try {
    const credentials = new FileCredentialStore(join(dir, "credentials.json"));
    // 第一次：走向导，选 DeepSeek + 第二个模型
    const first = main(["--state-dir", join(dir, "state"), "--no-memory", "--extensions", dir], true, {
      ui: ui1,
      credentials,
      verify: async () => ({ ok: true }),
    });
    await waitFor(() => ui1.screen().includes("选择 provider"), "向导");
    ui1.feed("2");
    await waitFor(() => ui1.screen().includes("DeepSeek 的 API key"), "收 key");
    for (const ch of "sk-GOOD") ui1.feed(ch);
    ui1.feed("\r");
    await waitFor(() => ui1.screen().includes("选择模型"), "选模型");
    ui1.feed("2"); // deepseek-v4-pro（非缺省——选缺省的话「记没记住」分不出来）
    await waitFor(() => ui1.screen().includes("模型 deepseek-v4-pro · deepseek"), "主界面");
    ui1.feed(String.fromCharCode(4));
    expect(await first).toBe(0);

    // 第二次：**一个旗子都不给**。配好了 + 记住了 → 不进向导，直接是上次那家那个模型
    const ui2 = fakeTui();
    const second = main(["--state-dir", join(dir, "state"), "--no-memory", "--extensions", dir], true, {
      ui: ui2,
      credentials,
    });
    await waitFor(() => ui2.screen().includes("模型 deepseek-v4-pro · deepseek"), "重启后直接生效");
    expect(ui2.screen()).not.toContain("选择 provider");
    ui2.feed(String.fromCharCode(4));
    expect(await second).toBe(0);
  } finally {
    restore();
  }
});

test("main:显式 --provider 永远赢过设置；设置里记的模型只在同一家时生效", async () => {
  const restore = isolate();
  const ui = fakeTui();
  try {
    const credentials = new FileCredentialStore(join(dir, "credentials.json"));
    await credentials.write("kimi", { type: "api_key", key: "sk-k" });
    const home = join(dir, "home");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "settings.json"), JSON.stringify({ model: { provider: "deepseek", id: "deepseek-v4-pro" } }));

    const running = main(["--provider", "kimi", "--state-dir", join(dir, "state"), "--no-memory", "--extensions", dir], true, {
      ui,
      credentials,
    });
    // 家听旗子的（kimi），设置里那条是 deepseek 的模型 → 不适用，回 kimi 缺省
    await waitFor(() => ui.screen().includes("模型 kimi-k3 · kimi"), "旗子赢");
    ui.feed(String.fromCharCode(4));
    expect(await running).toBe(0);
  } finally {
    restore();
  }
});

test("main:记住的模型已不在目录里 → 口信上屏、用缺省，**不挡启动**", async () => {
  const restore = isolate();
  const ui = fakeTui();
  try {
    const credentials = new FileCredentialStore(join(dir, "credentials.json"));
    await credentials.write("deepseek", { type: "api_key", key: "sk-d" });
    const home = join(dir, "home");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "settings.json"), JSON.stringify({ model: { provider: "deepseek", id: "deepseek-v99-已下架" } }));

    const running = main(["--state-dir", join(dir, "state"), "--no-memory", "--extensions", dir], true, {
      ui,
      credentials,
    });
    await waitFor(() => ui.screen().includes("模型 deepseek-v4-flash · deepseek"), "家记住了、模型回缺省");
    await waitFor(() => ui.screen().includes("[设置]"), "口信上屏");
    expect(ui.screen()).toContain("deepseek-v99-已下架");
    ui.feed(String.fromCharCode(4));
    expect(await running).toBe(0);
  } finally {
    restore();
  }
});

test("main:设置文件坏了 → 口信上屏、按没有设置起，**不挡启动**", async () => {
  const restore = isolate();
  const ui = fakeTui();
  try {
    const credentials = new FileCredentialStore(join(dir, "credentials.json"));
    await credentials.write("kimi", { type: "api_key", key: "sk-k" });
    const home = join(dir, "home");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "settings.json"), "{ 坏的");

    const running = main(["--state-dir", join(dir, "state"), "--no-memory", "--extensions", dir], true, {
      ui,
      credentials,
    });
    await waitFor(() => ui.screen().includes("模型 kimi-k3 · kimi"), "照样起");
    // 断言用两个**短**词：口信一行 80 列会被折行，「不是合法 JSON」正好断在空格上，长串 includes 必然配不上（实测）
    await waitFor(() => ui.screen().includes("[设置]") && ui.screen().includes("JSON"), "口信上屏");
    ui.feed(String.fromCharCode(4));
    expect(await running).toBe(0);
  } finally {
    restore();
  }
});

/* ══════════════ 产品（`product.ts`）：`mainFor()` 把同一条启动逻辑绑上一个 Product ══════════════ */
//
// `echo-coding` 依赖本包、拿自己的 Product 调 `mainFor()`。这里守的是本包这一侧的承诺：
//   · 名字进用法文本（`--help` 与「不认识的选项」附带的那份）与欢迎头，版本进欢迎头；
//   · preset 在**形态定了之后**被调一次，拿到的是 `{ interactive, cwd }`；
//   · preset 交出的 Extension **真进了装配**——装得上就 apply 过，装不上整个启动就失败。
// 产品自己那份（coding 的两条 Extension、权限由谁答）判据在 `packages/coding/test/cli.test.ts`。

test("mainFor：用法文本用产品的名字", () => {
  expect(usage("echo-试产品").split("\n")[0]).toBe("用法：echo-试产品 [选项]");
  expect(() => parseArgs(["--nope"], "echo-试产品")).toThrow("用法：echo-试产品");
});

test("mainFor：preset 在形态定了之后被调一次、其 Extension 真被 mount；名字与版本进欢迎头", async () => {
  const restore = isolate();
  const ui = fakeTui();
  try {
    const credentials = new FileCredentialStore(join(dir, "credentials.json"));
    await credentials.write("kimi", { type: "api_key", key: "sk-FROM-FILE" }); // 有凭据 → 不进引导设置，直接装配
    const forms: PresetForm[] = [];
    let applied = 0;
    let poolNames: string[] = [];
    const probe = defineExtension({
      name: "test:probe",
      hostAbiVersion: 1,
      inject: { runtime: { service: AgentRuntimeService, required: true } },
      apply(ctx) {
        applied++;
        poolNames = ctx.get(AgentRuntimeService).state.tools.map((t) => t.name); // 真装出来的工具池
      },
    });
    const productMain = mainFor({
      name: "echo-试产品",
      version: "9.9.9",
      preset: (form) => {
        forms.push(form);
        return { extensions: [{ entryId: "test:probe", definition: probe as never }] };
      },
    });
    const running = productMain(["--state-dir", join(dir, "state"), "--no-memory", "--extensions", dir], true, {
      ui,
      credentials,
      verify: async () => ({ ok: true }),
    });
    await waitFor(() => ui.screen().includes("模型 kimi-k3 · kimi"), "主界面");
    expect(ui.screen()).toContain("echo-试产品");
    expect(ui.screen()).toContain("v9.9.9");
    // 形态到了 preset 手里，而且只调一次（workspace 不经 preset，`mainFor()` 直接交给 createEcho）
    expect(forms).toEqual([{ interactive: true }]);
    expect(applied, "preset 交出的 Extension 没被 mount").toBe(1);
    // 渐进式披露的缺省名单（`DEFAULT_DEFERRED_TOOLS`）进了装配：名单非空 → `tool_search` 在池里；
    // 延迟的工具本身也在池里（只是不上菜单，那半边的判据在 core 的 tool-search.test）
    expect(poolNames).toContain("tool_search");
    expect(poolNames).toContain("schedule_create");

    ui.feed(String.fromCharCode(4));
    expect(await running).toBe(0);
  } finally {
    restore();
  }
});

test("mainFor：preset 的 Extension 装不上 → 整个启动失败、退出码 1（fail-loud，不是装了一半）", async () => {
  const restore = isolate();
  const ui = fakeTui();
  try {
    const credentials = new FileCredentialStore(join(dir, "credentials.json"));
    await credentials.write("kimi", { type: "api_key", key: "sk-FROM-FILE" });
    const broken = defineExtension({
      name: "test:broken",
      hostAbiVersion: 1,
      apply() {
        throw new Error("preset 装配探针");
      },
    });
    const productMain = mainFor({
      name: "echo-试产品",
      version: "9.9.9",
      preset: () => ({ extensions: [{ entryId: "test:broken", definition: broken as never }] }),
    });
    const code = await productMain(["--state-dir", join(dir, "state"), "--no-memory", "--extensions", dir], true, {
      ui,
      credentials,
      verify: async () => ({ ok: true }),
    });
    expect(code).toBe(1);
    expect(ui.screen(), "装配失败了却起了界面").not.toContain("模型 kimi-k3");
  } finally {
    restore();
  }
});

/* ══════════════ 会话（2026-09-01 用户拍板）：缺省新建一段，--continue / --resume 才续，续了要说 ══════════════ */
//
// 起因：两个产品在同一目录里落进了同一段对话（会话 id 只按 workspace 派生、启动即 resume、壳一字不显示），
// `echo-coding` 续了通用 agent「我没有文件工具」的结论。三条判据对应三个修法：
//   · 会话身份 = workspace + agent（别的产品的那段不算）；
//   · 续是显式动作，续不到就判红（不静默新建）；
//   · 续了必须在屏幕上说明带了几条。

const oldMessage = (text: string) => ({ role: "user" as const, source: "human" as const, content: [{ type: "text" as const, text }], at: 1 });

/**
 * 在**会话目录的上一层**预置一段（2026-09-03：一段 session 就是一个状态根，`--state-dir` 指的是它们的上一层）。
 * 说一句话才落 meta——空会话不留痕，所以预置也得说一句。
 */
async function seedSession(
  sessionsRoot: string,
  id: string,
  opts: { agent: string; text: string; main?: boolean },
): Promise<void> {
  const svc = new SessionService(new FileDir(join(sessionsRoot, id)));
  await svc.createOrResume(id, { workspace: process.cwd(), agent: opts.agent, main: opts.main ?? true });
  await svc.append(id, [{ kind: "message", message: oldMessage(opts.text) }]);
  await svc.settle();
}

test("--continue：续本产品在本目录的最近一段，屏幕上说明带了几条；别的产品的那段不算", async () => {
  const restore = isolate();
  const ui = fakeTui();
  try {
    const credentials = new FileCredentialStore(join(dir, "credentials.json"));
    await credentials.write("kimi", { type: "api_key", key: "sk-FROM-FILE" });
    const stateDir = join(dir, "state");
    // 盘上预置三段，都在本目录：coding 的（不是本产品的）、别人派的（不是 main）、echo-agent 自己的
    await seedSession(stateDir, "s-mine", { agent: "echo-agent", text: "上一场说过的" });
    await seedSession(stateDir, "s-coding", { agent: "echo-coding", text: "coding 的旧话" });
    await seedSession(stateDir, "s-spawned", { agent: "echo-agent", text: "别人派给我的活", main: false });

    const running = main(["--continue", "--state-dir", stateDir, "--no-memory", "--extensions", dir], true, {
      ui,
      credentials,
      verify: async () => ({ ok: true }),
    });
    await waitFor(() => ui.screen().includes("[会话] 续 s-mine"), "续上的口信");
    expect(ui.screen()).toContain("带着上一场的 1 条");
    expect(ui.screen()).not.toContain("s-coding");
    expect(ui.screen()).not.toContain("s-spawned"); // 别人派的活不是「上次那段对话」
    ui.feed(String.fromCharCode(4));
    expect(await running).toBe(0);
  } finally {
    restore();
  }
});

test("缺省不续：同一目录再起一次是新的一段，旧的原样；一句话没说的新段不留痕", async () => {
  const restore = isolate();
  try {
    const credentials = new FileCredentialStore(join(dir, "credentials.json"));
    await credentials.write("kimi", { type: "api_key", key: "sk-FROM-FILE" });
    const stateDir = join(dir, "state");
    await seedSession(stateDir, "s-old", { agent: "echo-agent", text: "上一场" });
    const before = await listSessions(new FileDir(stateDir));

    const ui = fakeTui();
    const running = main(["--state-dir", stateDir, "--no-memory", "--extensions", dir], true, { ui, credentials, verify: async () => ({ ok: true }) });
    await waitFor(() => ui.screen().includes("模型 kimi-k3 · kimi"), "主界面");
    expect(ui.screen()).not.toContain("[会话] 续"); // 新的一段，没什么可说的
    ui.feed(String.fromCharCode(4));
    expect(await running).toBe(0);

    // 旧的一个字没动；新起的那段一句话没说，**盘上不留目录**（否则清单很快被空段塞满）
    const after = await listSessions(new FileDir(stateDir));
    expect(after.map((s) => [s.id, s.messageCount])).toEqual(before.map((s) => [s.id, s.messageCount]));
    expect(after.map((s) => s.id)).toEqual(["s-old"]);
  } finally {
    restore();
  }
});

test("CLI 打开会话面、但不给 runner：模型能看见别的会话、能带话，开新的一段仍是人的动作", async () => {
  // 会话面是**容器的开关**（`CreateEchoOptions.sessions`），core 缺省不挂。这条盯的是 CLI 这个容器
  // 选了什么：同一台机器上多开几个终端就是多段 agent，让它们看得见彼此；但「怎么再开一个终端窗口」
  // 不该由 CLI 替用户决定，所以不给 runner——模型那边因此没有 session_create。
  // 判据读的是**装配现场那一份入参**，不是另搭一套。
  const built = echoOptions(
    ECHO_AGENT,
    { interactive: true },
    { withoutMemory: true, extensionDirs: [], continueLast: false },
    kimiProvider(),
    [],
    new FileCredentialStore(join(dir, "credentials.json")),
    undefined,
  );
  expect(built.sessions).toEqual({});
  expect(built.sessions?.run).toBeUndefined();
});

test("--resume 点名不存在的会话 / --continue 没有可续的 → 退出码 1，且不建任何状态（不静默新建）", async () => {
  const restore = isolate();
  try {
    const credentials = new FileCredentialStore(join(dir, "credentials.json"));
    await credentials.write("kimi", { type: "api_key", key: "sk-FROM-FILE" });
    const stateDir = join(dir, "state");
    const base = ["--state-dir", stateDir, "--no-memory", "--extensions", dir];
    expect(await main(["--resume", "s-nope", ...base], false, { credentials })).toBe(1);
    expect(await main(["--continue", ...base], false, { credentials })).toBe(1);
    expect(existsSync(join(stateDir, "sessions")), "续不到却建了状态").toBe(false);
  } finally {
    restore();
  }
});
