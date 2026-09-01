// `echo-agent` 的判据（管道形态 + 命令行面）。2026-08-31 从 `@echo/runner` 整份迁来：
// 两个 CLI 并成一个之后，这套判据跟着它的实现住进 `@echo/tui`。
//
// 分两层，故意分开：
//   · `run()` / `parseArgs()` —— 进程内直接调，验行为；
//   · `bin/echo-agent.ts` —— 真 spawn，验「这个可执行文件确实能被执行、退出码是那么回事」。
//     只 spawn 不验行为、或只测函数不 spawn，都会留下「装起来跑不了」的缺口。
//
// 交互形态的判据在 `tui.test.ts` 与 `extension.test.ts`。

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createEcho,
  createProvider,
  createProviderStreams,
  FileCredentialStore,
  kimiProvider,
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
import { PassThrough } from "node:stream";
import { main, parseArgs, USAGE } from "../src/cli.ts";
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
  // sessions 落盘:证明 start() 真的跑过而不是被跳过
  expect(existsSync(join(dir, "sessions")), "会话没落盘,start() 恐怕没跑").toBe(true);
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
  expect(parseArgs([])).toEqual({ provider: "kimi", withoutMemory: false, extensionDirs: [] });
  expect(parseArgs(["--provider", "deepseek", "--no-memory", "--agent-id", "a1"])).toEqual({
    provider: "deepseek",
    withoutMemory: true,
    agentId: "a1",
    extensionDirs: [],
  });
  expect(parseArgs(["--help"])).toBeNull();
  expect(parseArgs(["-h"])).toBeNull();
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
  expect(r.out).toContain(USAGE.split("\n")[0]!);
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

test("main:交互 + 缺凭据 → **照样起来**，主界面里就是配置段；配好直接说话，不用重启", async () => {
  const restore = isolate();
  const ui = fakeTui();
  try {
    const running = main(["--state-dir", join(dir, "state"), "--no-memory", "--extensions", dir], true, {
      ui,
      credentials: new FileCredentialStore(join(dir, "credentials.json")),
      verify: async () => ({ ok: true }),
    });
    // 关键：**主界面先起来**（「模型 kimi-k3」（欢迎头）是主界面才有的），配置段就在它里面，不是另一屏
    await waitFor(() => ui.screen().includes("模型 kimi-k3") && ui.screen().includes("还没有可用的凭据"), "主界面 + 配置段");
    expect(ui.screen()).toContain("Kimi (Moonshot) 的 API key");
    expect(ui.screen()).toContain("--provider deepseek"); // 换家怎么换，说了

    for (const ch of "sk-GOOD") ui.feed(ch);
    ui.feed("\r");
    await waitFor(() => ui.screen().includes("[凭据] 已保存"), "配好");

    expect(JSON.parse(readFileSync(join(dir, "credentials.json"), "utf8"))).toEqual({ kimi: { apiKey: "sk-GOOD" } });
    expect(ui.screen().split("Enter 发送").length - 1, "配好之后输入行没回来").toBe(2); // 欢迎头 + 输入行下的提示

    ui.feed(String.fromCharCode(4)); // Ctrl+D 退出
    expect(await running).toBe(0);
  } finally {
    restore();
  }
});

test("main:交互 + 缺凭据，用户在配置段里直接 Ctrl+D → 正常退出（0），什么都没写", async () => {
  const restore = isolate();
  const ui = fakeTui();
  try {
    const running = main(["--state-dir", join(dir, "state"), "--no-memory", "--extensions", dir], true, {
      ui,
      credentials: new FileCredentialStore(join(dir, "credentials.json")),
      verify: async () => ({ ok: true }),
    });
    await waitFor(() => ui.screen().includes("还没有可用的凭据"), "配置段");
    ui.feed(String.fromCharCode(4));

    // agent 是起来过的（走到了主界面），用户选择退出——那是正常退出，不是「没配所以失败」
    expect(await running).toBe(0);
    expect(existsSync(join(dir, "credentials.json")), "用户退出了却写了盘").toBe(false);
  } finally {
    restore();
  }
});
