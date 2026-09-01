// `echo-agent` 的命令行面：**唯一那个可执行文件**（2026-08-31 用户拍板方案 ③）。
//
// ## 为什么只有一个
//
// 在它之前有两个 CLI：`@echo/runner` 的 `echo-agent`（管道形态）与 `@echo/tui` 的 `echo-tui`
// （交互形态）。两个包、两套参数解析、两份 `createEcho()` 调用——于是它们**会分家**，
// 实测已经分了：runner 认五家 provider，TUI 只认两家，加 provider 时漏改了后者。
//
// 归并的落点是 `@echo/tui` 而不是 `@echo/core`，因为 core 的**运行时依赖恒空**是硬门
// （`packages/core/test/zero-runtime-deps.test.ts`），而交互式终端要 `pi-tui`。
// core 保持纯库不出 bin；`@echo/tui` 既是默认壳，也是那个可执行文件。
//
// ## 形态怎么选：看 stdin 是不是终端
//
//   · **不是**（管道、重定向、CI、`echo x | echo-agent`）→ 管道形态：一行输入一次 prompt，
//     正文进 stdout、旁白进 stderr，读完收摊。
//   · **是** → 交互形态：起 TUI。
//
// 不给 `--pipe` 这种开关：形态由「有没有人坐在终端前」决定，那件事进程自己看得见，
// 让用户再声明一遍只会多一种「声明了却和事实不符」的错法。
//
// ## 一条纪律贯穿本文件
//
// **不认识的东西一律报错，不静默忽略**。拼错一个 flag 就静默按缺省跑，
// 等于让用户以为配上了——那是本仓的原罪「假绿」在 CLI 上的形态。

import {
  createEcho,
  deepseekProvider,
  FileCredentialStore,
  kimiProvider,
  minimaxProvider,
  openaiProvider,
  zaiCodingProvider,
  type CredentialStore,
  type Provider,
} from "@echo-agent/core";
import type { TUI } from "@earendil-works/pi-tui";
import { tuiShell } from "./extension.ts";
import { run } from "./run.ts";
import { runFirstRunSetup, type FirstRunChoice } from "./first-run.ts";
// （FirstRunChoice 同时是装配与选择器的「一家」形状：name = --provider 短名，provider = 实例）
import { readSettings, writeSettings } from "./settings.ts";
import { isConfigured, type VerifyFn } from "./setup.ts";
import { linesOf } from "./stdin.ts";
import { ECHO_AGENT, type PresetForm, type Product } from "./product.ts";

export type ProviderName = "kimi" | "deepseek" | "openai" | "zai" | "minimax";

export type CliOptions = {
  /** 状态根。不给则由 core 决定（`ECHO_HOME`，再退到 `$PWD/.echo`）。 */
  stateDir?: string;
  agentId?: string;
  /** **不给 = 没说**（D7）：用设置文件记住的那家，其次 kimi。给了永远赢。 */
  provider?: ProviderName;
  model?: string;
  /** `--no-memory`：不装记忆，也就不开 Dream 自调度。一次性跑用得上。 */
  withoutMemory: boolean;
  /** 可重复。一条都不给 = 走约定目录 `<cwd>/extensions`。 */
  extensionDirs: string[];
};

const PROVIDERS: Record<ProviderName, () => Provider> = {
  kimi: () => kimiProvider(),
  deepseek: () => deepseekProvider(),
  openai: () => openaiProvider(),
  // `zai` 是短名，实际是智谱 GLM 的 coding 端点（pi 那边叫 `zai-coding-cn`）
  zai: () => zaiCodingProvider(),
  // MiniMax 挂的是 **M3**：目录换成它之后 thinking 可以关掉，不再需要「先改消息契约才能用」。
  // **仍未经真 key 实跑验证**（假 fetch 只证明请求体形状），这一条登记在 `docs/ISSUES.md`。
  minimax: () => minimaxProvider(),
};

/** `--help` 的正文。`name` 是可执行文件名：`echo-agent` 自己，或依赖本包的产品（`product.ts`）。 */
export function usage(name: string): string {
  return `用法：${name} [选项]

  stdin 是终端 → 起交互界面；是管道/重定向 → 一行输入跑一轮，
  正文进 stdout、工具旁白进 stderr，读完就干净收摊。Ctrl-C 也是干净收摊。

选项：
  --state-dir <路径>   状态根（缺省：$ECHO_HOME/agents/<id>，再退到 $PWD/.echo/agents/<id>）
  --agent-id <名字>    同一状态根下的 agent 身份（缺省 default）
  --provider <名字>    kimi | deepseek | openai | zai | minimax（缺省：上次选的，其次 kimi）
  --model <id>         模型 id（缺省：上次选的，其次由 provider 声明）
  --extensions <目录>  去哪里找扩展，可重复（缺省 ./extensions）
  --no-memory          不装记忆与 Dream
  -h, --help           显示本帮助

上次在界面里选的模型记在 $ECHO_HOME/settings.json（D7）：**显式 --provider / --model 永远赢**，
设置只是「没说就用上次的」；文件坏了不挡启动，如实说一句然后用缺省。

凭据的解析顺序是**环境变量 → 凭据文件 → 没有**：先看 provider 自己认的那些环境变量
（MOONSHOT_API_KEY / ECHO_LLM_API_KEY 等），再看 $ECHO_HOME/credentials.json
（未设 ECHO_HOME 则 ~/.echo/credentials.json，权限 0600，跨 agent 共享）。
环境变量优先是有意的：CI 与临时覆盖要能不改文件就生效。

**缺凭据不会退化成假模型，也不会挡着不让起。** 管道/重定向（脚本、CI）在启动前报错并以 1 退出，
因为调用方需要非零退出码、也没人能回答问题；stdin 是终端时进**引导设置**：欢迎 → 选 provider →
贴 key（回车验证并保存）→ 选模型 → 直接进对话。key 中途失效也在界面里重配，不用重启。
两者都不会静默跑一个没配好的 agent。`;
}

/**
 * 解析 argv（**不含** node/bun 与脚本名两项）。
 *
 * 返回 `null` = 该打帮助并以 0 退出。其余任何不认识的输入都 `throw`。
 *
 * @param name 可执行文件名，只进「不认识的选项」那条错误里附带的用法文本。
 */
export function parseArgs(argv: readonly string[], name: string = ECHO_AGENT.name): CliOptions | null {
  if (argv[0] === "-h" || argv[0] === "--help") return null;

  const opts: CliOptions = { withoutMemory: false, extensionDirs: [] };

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    // 取下一项当值；缺值就报错，别把下一个 flag 当成值吞掉
    // （实测过：`--model --no-memory` 会得到 `{ model: "--no-memory" }`，
    // 而 `--no-memory` 就这么被静默丢了——「写了没生效」的另一面）
    const value = (): string => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("-")) throw new Error(`${flag} 后面缺一个值`);
      return v;
    };
    switch (flag) {
      case "--state-dir":
        opts.stateDir = value();
        break;
      case "--agent-id":
        opts.agentId = value();
        break;
      case "--model":
        opts.model = value();
        break;
      case "--extensions":
        opts.extensionDirs.push(value());
        break;
      case "--provider": {
        const v = value();
        // **判据取自 PROVIDERS 本身**，不再手写一串字面量——加一家却忘了改这里，
        // 用户会得到「不认识的 provider」而那家其实已经装上了（写了没生效的反面）
        if (!Object.hasOwn(PROVIDERS, v)) {
          throw new Error(`不认识的 provider '${v}'；可选：${Object.keys(PROVIDERS).join("、")}`);
        }
        opts.provider = v as ProviderName;
        break;
      }
      case "--no-memory":
        opts.withoutMemory = true;
        break;
      default:
        throw new Error(`不认识的选项 '${flag}'\n\n${usage(name)}`);
    }
  }
  return opts;
}

/** `main()` 的注入点。生产一个都不给。 */
export type MainDeps = Readonly<{
  /** 凭据来源。缺省 `FileCredentialStore()` —— `$ECHO_HOME/credentials.json`。 */
  credentials?: CredentialStore;
  /** 测试注入：假终端。 */
  ui?: TUI;
  /** 测试注入：验 key 的方式。缺省真打一次 `GET {baseUrl}/models`。 */
  verify?: VerifyFn;
}>;

/** 引导设置里摆出来的可选项。**判据取自 `PROVIDERS` 本身**，加一家不会漏掉这里。 */
function providerChoices(): readonly FirstRunChoice[] {
  return Object.entries(PROVIDERS).map(([name, make]) => ({ name, provider: make() }));
}

/**
 * `createEcho()` 的入参，两种形态共用——**装配只有一处**，形态差别只在「装不装壳」。
 *
 * `provider` 由调用方给：同一个实例既用来装配，也交给壳子在界面里配 key（要它的 `baseUrl` 去验）。
 */
function echoOptions(
  product: Product,
  form: PresetForm,
  opts: CliOptions,
  provider: Provider,
  choices: readonly FirstRunChoice[],
  credentials: CredentialStore,
): Parameters<typeof createEcho>[0] {
  return {
    provider,
    // 五家全注册（P3b-a）：Ctrl+L 跨家换模的派发靠它；初始模型仍从 `provider` 解析
    providers: choices.map((c) => c.provider),
    credentials,
    withoutMemory: opts.withoutMemory,
    ...(opts.stateDir !== undefined ? { stateDir: opts.stateDir } : {}),
    ...(opts.agentId !== undefined ? { agentId: opts.agentId } : {}),
    ...(opts.model !== undefined ? { model: opts.model } : {}),
    // **一条 `--extensions` 都不给就走约定目录**（`<cwd>/extensions`）——给了就只用给的，
    // 所以这里区分「空数组」与「不传」，不能无脑展开。
    ...(opts.extensionDirs.length > 0 ? { extensionDirs: opts.extensionDirs } : {}),
    // **产品层的装配片段**（`product.ts`）：`agent`（系统 prompt、权限策略）与 `extensions`（产品自带的）。
    // 能来自产品的只有这两个字段——`Product.preset` 的返回类型就这么窄——所以它盖不掉上面任何一项，
    // 尤其盖不掉 `extensionDirs`：去哪发现扩展归 `--extensions`、归用户。
    ...(product.preset?.(form) ?? {}),
  };
}

/** `main` 的签名：argv（不含 node/bun 与脚本名）、形态、注入点 → 退出码。 */
export type Main = (argv: readonly string[], interactive?: boolean, deps?: MainDeps) => Promise<number>;

/**
 * 把启动逻辑绑上一个产品，得到它的 `main`。`echo-agent` 自己是 `mainFor(ECHO_AGENT)`；
 * 依赖本包的产品（`echo-coding`）拿自己的 `Product` 调一次——**整条启动逻辑一行不复制**，
 * 产品之间差的只有 `Product` 那三样（名字、版本、装配片段）。
 *
 * 得到的函数是进程入口的实质。**返回退出码，自己不调 `process.exit`**——那样测不了，
 * 也会把还没 flush 的输出砍掉。
 *
 * `SIGINT` / `SIGTERM` 都接到同一个 `AbortController` 上：对「怎么停」只有一种回答。
 * **不装第二次强杀**——收摊本来就该在有限时间内完成，装了强杀就等于给「收不干净」发了许可证。
 *
 * 它的第二个参数 `interactive` 是形态。缺省看 stdin 是不是终端；测试可以直接指定。
 *   **形态判据只有这一个**——不再引入第二处「有没有人坐在终端前」的判断。
 * 第三个参数 `deps` 是注入点。生产一个都不给：真凭据文件、真终端、真 HTTP 验证。
 */
export function mainFor(product: Product): Main {
  return async (
    argv: readonly string[],
    interactive: boolean = process.stdin.isTTY === true,
    deps: MainDeps = {},
  ): Promise<number> => {
    let opts: CliOptions | null;
    try {
      opts = parseArgs(argv, product.name);
    } catch (e) {
      process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
      return 2;
    }
    if (opts === null) {
      process.stdout.write(`${usage(product.name)}\n`);
      return 0;
    }

    const controller = new AbortController();
    const stop = (): void => controller.abort();
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);

    try {
      const credentials = deps.credentials ?? new FileCredentialStore();
      const choices = providerChoices(); // **一个 id 一份实例**：装配、向导、选择器共用，别各造各的
      const notices: string[] = [];

      // 设置（D7）：上次选的模型。**显式旗子永远赢**；设置存的是 provider **id**（目录真源），
      // 记住的家/模型已经不在了就如实说一句、退回缺省——记忆过期不该挡启动（D3 同一原则）。
      const settingsRead = await readSettings();
      if (settingsRead.problem !== undefined) notices.push(`[设置] ${settingsRead.problem}`);
      const remembered = settingsRead.settings.model;
      let chosen = opts.provider !== undefined ? choices.find((c) => c.name === opts.provider)! : undefined;
      if (chosen === undefined && remembered !== undefined) {
        chosen = choices.find((c) => c.provider.id === remembered.provider);
        if (chosen === undefined) notices.push(`[设置] 记住的 provider '${remembered.provider}' 不认识了，用缺省`);
      }
      chosen ??= choices[0]!; // kimi
      let provider = chosen.provider;
      let model = opts.model;
      if (model === undefined && remembered !== undefined && remembered.provider === provider.id) {
        if (provider.getModels().some((m) => m.id === remembered.id)) model = remembered.id;
        else notices.push(`[设置] 记住的模型 '${remembered.id}' 已不在 ${provider.id} 的目录里，用缺省`);
      }

      // **缺凭据时形态决定策略**（D3 + D4）：
      //   · 管道 / CI：没人能回答问题，调用方要的是非零退出码 → **启动前**报错返回 1，连装配都不做；
      //   · 终端：进**引导设置**（`first-run.ts`：欢迎 → 选 provider → 贴 key → 选模型），
      //     它跑在装配前——选哪家、哪个模型本来就得在装配前定（模型解析在装配期，换模型是 P3）。
      // 判据是 `isConfigured()`——与请求路径同一个 `Models.checkAuth()`，不匹配错误文案。
      // 装配本身不看凭据（`create-agent.ts`）；key **中途**失效由主界面里的配置段兜（`app.ts`）。
      if (!(await isConfigured(provider, credentials))) {
        if (!interactive) {
          process.stderr.write(
            `provider '${provider.id}' 没有凭据：设它认的环境变量，或写 $ECHO_HOME/credentials.json（见 --help）。\n`,
          );
          return 1;
        }
        const outcome = await runFirstRunSetup({
          product,
          choices,
          credentials,
          preselect: chosen.name,
          signal: controller.signal,
          ...(deps.ui !== undefined ? { ui: deps.ui } : {}),
          ...(deps.verify !== undefined ? { verify: deps.verify } : {}),
        });
        if (outcome.kind === "cancelled") {
          process.stderr.write("没有配置凭据，没有启动。\n");
          return 1;
        }
        provider = outcome.provider;
        // 显式 `--model` 赢；没给的话用引导设置里选的那个
        model = opts.model ?? outcome.modelId;
        // 记住这次的选择（D7）：写不进去不挡启动，如实说一句
        const w = await writeSettings({ model: { provider: outcome.provider.id, id: outcome.modelId } });
        if (w.problem !== undefined) notices.push(`[设置] ${w.problem}`);
      }

      const effective: CliOptions = { ...opts, ...(model !== undefined ? { model } : {}) };
      // 形态与工作目录到这里已经定了；产品层据此出它的装配片段（`echoOptions` 里调 `preset`）。
      const form: PresetForm = { interactive, cwd: process.cwd() };
      return interactive
        ? await runInteractive(product, form, effective, chosen === undefined ? choices[0]! : { name: chosen.name, provider }, choices, credentials, notices, controller.signal, deps)
        : await runPiped(product, form, effective, provider, choices, credentials, notices, controller.signal);
    } catch (e) {
      // 装配失败（锁被别的进程占着、状态根不可写、目录为空）一律**明说**并非零退出。
      process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
      return 1;
    } finally {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
    }
  };
}

/** `echo-agent` 自己的入口：`bin/echo-agent.ts` 调的就是它。 */
export const main: Main = mainFor(ECHO_AGENT);

/** 管道形态：`run()` 自己会 `echo.stop()`（它的 `finally`），所以这里不重复收摊。 */
async function runPiped(
  product: Product,
  form: PresetForm,
  opts: CliOptions,
  provider: Provider,
  choices: readonly FirstRunChoice[],
  credentials: CredentialStore,
  notices: readonly string[],
  signal: AbortSignal,
): Promise<number> {
  // **唯一 composition root**（§14.2）：壳子不自己装配，只把装好的 Echo 接到进程与输入源上。
  const echo = await createEcho(echoOptions(product, form, opts, provider, choices, credentials));
  // 启动口信（设置读不动等）与装配诊断（坏扩展被跳过，D6）都走 stderr：说了才算没静默，但不挡启动、不改退出码
  for (const n of notices) process.stderr.write(`${n}\n`);
  for (const d of echo.diagnostics) process.stderr.write(`[扩展] [${d.code}] ${d.message}${d.path !== undefined ? `（${d.path}）` : ""}\n`);
  return await run({ echo, input: linesOf(process.stdin, signal), signal });
}

/** 交互形态：壳作为 extension 进装配，进程这一层只剩三件事——装配、启动、等它退出。 */
async function runInteractive(
  product: Product,
  form: PresetForm,
  opts: CliOptions,
  chosen: FirstRunChoice,
  choices: readonly FirstRunChoice[],
  credentials: CredentialStore,
  notices: readonly string[],
  signal: AbortSignal,
  deps: MainDeps,
): Promise<number> {
  const shell = tuiShell({
    product,
    signal,
    ...(deps.ui !== undefined ? { ui: deps.ui } : {}),
    // 壳子的凭据配置段与 Ctrl+L 跨家选择器要的东西：全部可选的家 + 凭据 + 「换模成功就写设置」的回调（D7）
    configure: {
      providers: choices,
      credentials,
      onModelChange: (m): void => {
        void writeSettings({ model: m }).then((w) => {
          if (w.problem !== undefined) shell.notify(`[设置] ${w.problem}`);
        });
      },
      ...(deps.verify !== undefined ? { verify: deps.verify } : {}),
    },
  });
  const base = echoOptions(product, form, opts, chosen.provider, choices, credentials);
  const echo = await createEcho({
    ...base,
    // 产品自带的 Extension 在前、壳在最后：壳也只是一条 Extension（`echo:tui`），它 inject 的
    // `AgentRuntime` 由 builtin 那一代提供（`create-echo.ts`），与同代里谁先谁后无关。
    extensions: [...(base.extensions ?? []), { entryId: "echo:tui", definition: shell.definition as never }],
  });
  // 启动口信与装配诊断（D6）进界面：壳 mount 在先、这里在后，notify 直通或先攒着
  for (const n of notices) shell.notify(n);
  for (const d of echo.diagnostics) shell.notify(`[扩展] 没装上：${d.message}${d.path !== undefined ? `（${d.path}）` : ""}`);
  try {
    // **启停归这一层**，不归壳：协议里没有 `start`/`stop`，壳子想碰也碰不到。
    await echo.agent.start();
    return await shell.exited;
  } finally {
    await echo.stop(); // 先卸 Extension（含壳自己）再停 Agent
  }
}
