// `echo-agent` 的命令行面：**唯一那个可执行文件**。
//
// ## 为什么只有一个
//
// 两个 CLI 就是两套参数解析、两份 `createEcho()` 调用——它们**会分家**：实测过一次，
// 加 provider 只改了其中一边，另一边就少认几家。所以交互与管道两种形态共用同一个入口、
// 同一次装配。
//
// 落点是本包而不是 `@echo-agent/core`，因为 core 的**运行时依赖恒空**是硬门
// （`packages/core/test/zero-runtime-deps.test.ts`），而交互式终端要 `pi-tui`。
// core 保持纯库不出 bin；本包既是默认壳，也是那个可执行文件。
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
  errText,
  expandHome,
  FileCredentialStore,
  FileDir,
  kimiProvider,
  minimaxProvider,
  openaiProvider,
  resolveSessionsRoot,
  inspectStateLock,
  listSessions,
  zaiCodingProvider,
  type CredentialStore,
  type ObservationCapturePolicy,
  type Provider,
  type SessionRunner,
} from "@echo-agent/core";
import { join } from "node:path";
import { instructionsEntry } from "./instructions.ts";
import { pipeSurfaceEntry } from "./prompt.ts";
import type { Shell } from "./shell.ts";
import { run } from "./run.ts";
import { runObserve } from "./observe.ts";
import type { FirstRunChoice } from "./shell.ts";
// （FirstRunChoice 同时是装配与选择器的「一家」形状：name = --provider 短名，provider = 实例）
import { readSettings, writeSettings } from "./settings.ts";
import { isConfigured, type VerifyFn } from "./setup.ts";
import { linesOf } from "./stdin.ts";
import type { PresetForm, Product } from "./product.ts";

export type ProviderName = "kimi" | "deepseek" | "openai" | "zai" | "minimax";

export type CliOptions = {
  /** 状态根。不给则由 core 决定（`ECHO_HOME`，再退到 `~/.echo`）。 */
  stateDir?: string;
  /** **不给 = 没说**（D7）：用设置文件记住的那家，其次 kimi。给了永远赢。 */
  provider?: ProviderName;
  model?: string;
  /** `--no-memory`：不装记忆，也就不开 Dream 自调度。一次性跑用得上。 */
  withoutMemory: boolean;
  /** 可重复。一条都不给 = 走约定目录 `<cwd>/extensions`。 */
  extensionDirs: string[];
  /**
   * 会话（2026-09-01 用户拍板：**缺省每次启动新建一段**，续上次是显式动作）：
   * `--continue` = 本产品在本目录的最近一段；`--resume <id>` = 指名那一段。两者互斥。
   */
  continueLast: boolean;
  resume?: string;
  /**
   * 无界面地把一段会话跑起来（2026-09-07）：不装壳、不读 stdin，起来消费收件箱，空闲一会儿就退出。
   *
   * **这是给 runner 用的，不是给人敲的**：别的会话给这一段发消息时，容器 spawn 一个
   * `--serve --resume <id>` 的进程当它的宿主。人开的会话照旧走交互或管道形态。
   */
  serve: boolean;
  /**
   * `--observe <档>`：观测采集档。**不给 = 没说**，由 core 缺省（metadata）。`content` 把模型文本、
   * 工具参数与结果正文明文写进状态根的 observations.sqlite——看 `echo-agent observe serve` 时才需要。
   */
  observe?: ObservationCapturePolicy;
};

/** `--observe` 能接的值。与 `ObservationCapturePolicy` 同一份枚举——多写少写 `satisfies` 都会报。 */
const CAPTURE_POLICIES = ["off", "metadata", "content"] as const satisfies readonly ObservationCapturePolicy[];

/** 无界面形态的轮询节拍。只用来判「还忙着吗」，不参与任何投递。 */
const SERVE_TICK_MS = 250;
/**
 * 无界面形态连着空闲多久就收摊。
 *
 * 短一点更省，但也更容易在「一条消息刚处理完、下一条正在路上」时白退一次；
 * 一分钟足够覆盖一来一回，也不至于让一个没人再理的宿主占着锁过夜。
 */
const SERVE_IDLE_MS = 60_000;
/** 叫醒一段最多等多久拿到它的锁。超过就当没叫起来（`SessionRunner` 的契约）。 */
const WAKE_TIMEOUT_MS = 20_000;

const PROVIDERS: Record<ProviderName, () => Provider> = {
  kimi: () => kimiProvider(),
  deepseek: () => deepseekProvider(),
  openai: () => openaiProvider(),
  // `zai` 是短名，实际是智谱 GLM 的 coding 端点（pi 那边叫 `zai-coding-cn`）
  zai: () => zaiCodingProvider(),
  // MiniMax 挂的是 **M3**：目录换成它之后 thinking 可以关掉，不再需要「先改消息契约才能用」。
  // **仍未经真 key 实跑验证**（假 fetch 只证明请求体形状）。
  minimax: () => minimaxProvider(),
};

/** `--help` 的正文。`name` 是可执行文件名：`echo-agent` 自己，或依赖本包的产品（`product.ts`）。 */
export function usage(name: string): string {
  return `用法：${name} [选项]

  stdin 是终端 → 起交互界面；是管道/重定向 → 一行输入跑一轮，
  正文进 stdout、工具旁白进 stderr，读完就干净收摊。Ctrl-C 也是干净收摊。

选项：
  --state-dir <路径>   会话目录的上一层（缺省：$ECHO_HOME/sessions，再退到 ~/.echo/sessions）
  --provider <名字>    kimi | deepseek | openai | zai | minimax（缺省：上次选的，其次 kimi）
  --model <id>         模型 id（缺省：上次选的，其次由 provider 声明）
  --continue           续本命令在当前目录的最近一段会话
  --resume <id>        续指定的那一段会话
  --serve              无界面地把那一段跑起来（配 --resume）：消费收件箱，空闲就退出。
                       给容器叫醒会话用的，人不必敲它
  --extensions <目录>  去哪里找扩展，可重复（缺省 ./extensions）
  --no-memory          不装记忆与 Dream
  --observe <档>       观测采集档：metadata（缺省，只记形状与计数）| content（带模型文本、工具参数与结果正文，明文落盘）| off
  -h, --help           显示本帮助

子命令：
  observe <last|show <run-id>|export <run-id>|health|serve>
                       看已落盘的 run 观测记录：不启动 agent、不取锁（详见 ${name} observe --help）。
                       管道形态每轮结束会在 stderr 打一行 \`[run] <run-id> …\`，拿它去 observe show。

**每次启动都是新的一段会话**，续上次是显式动作（--continue / --resume）。会话按「目录 + 命令」归属：
在同一个目录里，${name} 与别的命令各有各的对话，互不相续；续上时界面会说明续了多少条。

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
export function parseArgs(argv: readonly string[], name: string): CliOptions | null {
  if (argv[0] === "-h" || argv[0] === "--help") return null;

  const opts: CliOptions = { withoutMemory: false, extensionDirs: [], continueLast: false, serve: false };

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
      case "--serve":
        opts.serve = true;
        break;
      case "--continue":
        opts.continueLast = true;
        break;
      case "--resume":
        opts.resume = value();
        break;
      case "--observe": {
        const v = value();
        if (!(CAPTURE_POLICIES as readonly string[]).includes(v)) throw new Error(`--observe 只能是 ${CAPTURE_POLICIES.join(" / ")}，不是 '${v}'`);
        opts.observe = v as ObservationCapturePolicy;
        break;
      }
      default:
        throw new Error(`不认识的选项 '${flag}'\n\n${usage(name)}`);
    }
  }
  // 两个「续」互斥：都给了就不知道听谁的，静默取一个是「写了没生效」
  if (opts.continueLast && opts.resume !== undefined) throw new Error("--continue 与 --resume 只能给一个");
  if (opts.serve && opts.resume === undefined && !opts.continueLast) throw new Error("--serve 要点名跑哪一段：配 --resume <id>");
  return opts;
}

/** `main()` 的注入点。生产一个都不给。 */
export type MainDeps = Readonly<{
  /** 凭据来源。缺省 `FileCredentialStore()` —— `$ECHO_HOME/credentials.json`。 */
  credentials?: CredentialStore;
  /**
   * 测试注入：假界面。**类型是 `unknown`**——装配层不认识任何界面技术（2026-09-09 的壳端口），
   * 认识了就等于把某一种终端库写回启动逻辑里。壳的实现方自己收窄（`terminalShell` 收成 pi-tui 的 `TUI`）。
   */
  ui?: unknown;
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
 *
 * **导出只为判据**（`cli.test.ts`）：装配现场仍然只有这一处，测试读的是同一份入参，
 * 不是另搭一套。
 */
export function echoOptions(
  product: Product,
  form: PresetForm,
  opts: CliOptions,
  provider: Provider,
  choices: readonly FirstRunChoice[],
  credentials: CredentialStore,
  /** 要续的那一段（`--continue` / `--resume` 解析出来的 id）；不给 = 新建一段。 */
  sessionId: string | undefined,
): Parameters<typeof createEcho>[0] {
  // **产品层的装配片段**（`product.ts`）：`agent`（权限策略等）与 `extensions`（产品自带的，含它的 prompt 段）。
  // 能来自产品的只有这两个字段——`Product.preset` 的返回类型就这么窄——所以它盖不掉下面任何一项，
  // 尤其盖不掉 `extensionDirs`：去哪发现扩展归 `--extensions`、归用户。
  const preset = product.preset?.(form, { credentials }) ?? {};
  return {
    provider,
    // 五家全注册（P3b-a）：Ctrl+L 跨家换模的派发靠它；初始模型仍从 `provider` 解析
    providers: choices.map((c) => c.provider),
    credentials,
    withoutMemory: opts.withoutMemory,
    // workspace 是 session 级事实（2026-09-01）：宿主给进程目录；core 不读 process.cwd()
    workspace: process.cwd(),
    // 会话身份的第二维：产品名。同一目录里 `echo-agent` 与 `echo-coding` 各有各的对话
    // （2026-09-01 用户拍板；2026-09-07 字段从 `agentName` 改名 `product`，角色占了 `agent` 那个词）
    product: product.name,
    ...(sessionId !== undefined ? { sessionId } : {}),
    // `--state-dir` 是**会话目录的上一层**（2026-09-03）：容器管「会话都放哪儿」，
    // 某一段的目录由 core 用 sessionsRoot + sessionId 得出。
    ...(opts.stateDir !== undefined ? { sessionsRoot: opts.stateDir } : {}),
    // 会话面开着（2026-09-03）：同一台机器上多开几个终端就是多段 session，让它们看得见彼此、
    // 能互相带个话。**runner 也给**（2026-09-07）：给一段没在跑的会话发消息时，容器 spawn
    // 一个 `--serve` 的进程当它的宿主——「只跟活着的段说话」那条要有人兑现才成立。
    // 那种容器是可让位的，所以你 `--resume` 它的时候它会让开。
    sessions: { run: sessionRunner(opts, choices.find((c) => c.provider === provider)?.name) },
    ...(opts.model !== undefined ? { model: opts.model } : {}),
    ...(opts.observe !== undefined ? { observation: { capture: opts.observe } } : {}),
    // **一条 `--extensions` 都不给就走约定目录**（`<cwd>/extensions`）——给了就只用给的，
    // 所以这里区分「空数组」与「不传」，不能无脑展开。
    ...(opts.extensionDirs.length > 0 ? { extensionDirs: opts.extensionDirs } : {}),
    // 提问（`ask_user`，2026-09-05）：有人坐在终端前就 `host`（壳子摆出来等答），管道 / CI 没人可答就 `none`——
    // 工具当场如实回话、不等人。与权限策略是两条通道：那条由产品 preset 定，这条由形态定。
    // 产品 preset 自己定了 questions 就用它的（类型允许，不能静默盖掉）；没定才按形态给
    agent: { ...(preset.agent ?? {}), questions: preset.agent?.questions ?? { responder: form.interactive ? "host" : "none", askTimeoutMs: null } },
    // `echo-agent` 恒挂的两段（纪律、项目指令）在前，产品自带的在后。顺序只影响 `echo.extensions`
    // 清单的可读性——prompt 里的先后由各段的 order 决定，不由挂载顺序决定。
    // 纪律段**不在这里**（2026-09-09）：它归产品，产品自己挂。项目指令留在装配层——
    // 读 workspace 的文件是宿主能力，core 是纯 JS 够不着（`docs/design/prompt.md` 的所有权表）。
    extensions: [instructionsEntry(), ...(preset.extensions ?? [])],
  };
}

/**
 * `--continue` / `--resume` → 要续的那一段的 id；两个都没给 → `undefined`（新建一段）。
 *
 * 清单来自 **session 目录的上一层**（`listSessions()`，2026-09-03：一段 session 就是一个状态根，
 * 它自己看不见别的段）。**续不到就判红**：`--resume` 点名的不存在、`--continue` 找不到本产品在本
 * 目录的任何一段，都报错退出——静默新建一段等于把「续」这个字说了没生效。
 *
 * `--continue` 的筛选是三维：本目录（`process.cwd()`）、本产品（`product.name`）、**自己起的**
 * （`main`）。第三维是 2026-09-03 加的：`session_create` 派出去的那些段也在同一层目录里，
 * 续到一段别人派的活不是「上次那段对话」。已关的（`closed`）也不续。
 */
async function resolveSessionId(product: Product, opts: CliOptions): Promise<string | undefined> {
  if (!opts.continueLast && opts.resume === undefined) return undefined;
  const root = expandHome(opts.stateDir ?? resolveSessionsRoot());
  const sessions = await listSessions(new FileDir(root)); // 已按 updatedAt 降序
  if (opts.resume !== undefined) {
    if (!sessions.some((s) => s.id === opts.resume)) throw new Error(`会话 '${opts.resume}' 不存在（${root}）`);
    return opts.resume;
  }
  const cwd = process.cwd();
  // 身份三维（2026-09-07）：目录 + **产品** + main + active。产品这一维从前存在 `agent` 字段里，
  // 现在 `agent` 归角色——同一目录里 echo-agent 与 echo-coding 各续各的，靠的是 `product`。
  const latest = sessions.find((s) => s.workspace === cwd && s.product === product.name && s.main && s.status === "active");
  if (latest === undefined) throw new Error(`${product.name} 在 ${cwd} 还没有可续的会话（${root}）`);
  return latest.id;
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
export function mainFor(product: Product, shell: Shell): Main {
  return async (
    argv: readonly string[],
    interactive: boolean = process.stdin.isTTY === true,
    deps: MainDeps = {},
  ): Promise<number> => {
    // `observe` 是只读子命令：不装配、不取锁、不看凭据——在一切启动逻辑之前分走
    if (argv[0] === "observe") return runObserve(argv.slice(1), product.name);
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
        if (provider.getModels().some((m: { id: string }) => m.id === remembered.id)) model = remembered.id;
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
        const outcome = await shell.firstRun({
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
      // 会话（2026-09-01 用户拍板）：缺省新建一段；`--continue` / `--resume` 才续。续哪段要在装配前定。
      const sessionId = await resolveSessionId(product, opts);
      // 形态到这里已经定了；产品层据此出它的装配片段（`echoOptions` 里调 `preset`）。
      const form: PresetForm = { interactive };
      // 无界面形态排在最前：它既不是交互也不是管道——不装壳、不读 stdin，跑完就退。
      if (effective.serve) return await runServe(product, form, effective, provider, choices, credentials, sessionId, controller.signal);
      return interactive
        ? await runInteractive(shell, product, form, effective, chosen === undefined ? choices[0]! : { name: chosen.name, provider }, choices, credentials, sessionId, notices, controller.signal, deps)
        : await runPiped(product, form, effective, provider, choices, credentials, sessionId, notices, controller.signal);
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


/** 管道形态：`run()` 自己会 `echo.stop()`（它的 `finally`），所以这里不重复收摊。 */
/**
 * 容器怎么让一段会话跑起来（`SessionRunner`，2026-09-07）：**spawn 一个自己的副本**，
 * 让它以 `--serve --resume <id>` 无界面地当那一段的宿主。
 *
 * 契约是「resolve = 那一段已经持有自己的 lease」，所以这里等的是**我起的那个进程持有一把合法的锁**——
 * 不是等进程起来（进程起来了但装配失败、或者锁被别人占着，都不算跑起来了），也不是「锁文件在」
 * （review 2026-09-07：盘上残留一把崩在写一半的坏锁时，第一拍就被当成子进程拿到了锁，消息投进一个没人读的目录）。
 *
 * 为什么起独立进程而不是在自己进程里多跑一段：**一段 session 一个宿主**是这条线的原话。
 * 起在自己进程里的话，你关掉这个终端就把别人的会话一起带走了；而独立进程会一直活到
 * 它自己空闲退出，或者你 `--resume` 它、它让开为止（那条让位协议就是为它准备的）。
 *
 * 子进程 `unref()`：它不该拖着本进程不退。stdio 全丢——没人看，写出来的东西只会污染终端。
 */
/**
 * 叫醒一段会话时给副本的 argv（导出只为判据）：与父进程**同一家、同一模型**、同状态根、同扩展目录
 * （review 2026-09-07：此前只传后两样，副本按设置文件另选一家、缺 key 就根本起不来）。
 * `--provider` 收的是 CLI 的 provider 名（`kimi` / `zai` …），不是目录里的 provider id。
 * `--observe` 也继承（2026-09-09 拍板）：父在看的档，被叫醒的那段也按同一档记，否则 `observe show` 只有半张图。
 */
export function wakeArgs(self: string, opts: CliOptions, providerName: string | undefined, sessionId: string): string[] {
  const args = [self, "--serve", "--resume", sessionId];
  if (providerName !== undefined) args.push("--provider", providerName);
  if (opts.model !== undefined) args.push("--model", opts.model);
  if (opts.stateDir !== undefined) args.push("--state-dir", opts.stateDir);
  if (opts.observe !== undefined) args.push("--observe", opts.observe);
  if (opts.withoutMemory) args.push("--no-memory");
  for (const dir of opts.extensionDirs) args.push("--extensions", dir);
  return args;
}

function sessionRunner(opts: CliOptions, providerName: string | undefined): SessionRunner {
  const self = process.argv[1];
  return async (row) => {
    if (self === undefined) throw new Error("认不出自己的可执行文件路径，起不了会话宿主");
    const args = wakeArgs(self, opts, providerName, row.id);
    const child = Bun.spawn([process.execPath, ...args], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    child.unref();

    const lock = join(expandHome(opts.stateDir ?? resolveSessionsRoot()), row.id, ".lock");
    const deadline = Date.now() + WAKE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      // 先看进程：它退了就是没跑起来——哪怕盘上留着一把别人的 / 坏的锁
      if (child.exitCode !== null) throw new Error(`会话 ${row.id} 的容器进程退了（exit ${child.exitCode}），没跑起来`);
      const cur = await inspectStateLock(lock);
      if (cur.state === "valid" && cur.record.pid === child.pid) return; // 我起的那个进程持有一把合法的锁 = 真的跑起来了
      await new Promise((r) => setTimeout(r, SERVE_TICK_MS));
    }
    throw new Error(`会话 ${row.id} 的容器 ${WAKE_TIMEOUT_MS}ms 内没拿到锁`);
  };
}

/**
 * 无界面形态（2026-09-07）：**把一段会话跑起来，仅此而已**。
 *
 * 谁会用它：`sessionRunner()` spawn 出来的进程。别的会话给这一段发消息时，容器先把它叫醒
 * （sessions.md §5 的虚拟 actor），叫醒的办法就是起一个这样的进程。
 *
 * 三条与人开的会话不同：
 *   · **不装壳、不读 stdin**——没人坐在它前面；
 *   · **可让位**（`preemptible`）——你哪天 `--resume` 这一段，它把手上的活做完就让开；
 *   · **空闲就退**——它是为了处理一条消息才起来的，处理完没理由继续占着锁。
 */
async function runServe(
  product: Product,
  form: PresetForm,
  opts: CliOptions,
  provider: Provider,
  choices: readonly FirstRunChoice[],
  credentials: CredentialStore,
  sessionId: string | undefined,
  signal: AbortSignal,
): Promise<number> {
  const base = echoOptions(product, form, opts, provider, choices, credentials, sessionId);
  const echo = await createEcho({ ...base, preemptible: true });
  try {
    // 退出只认两件事（review 2026-09-07，#6 拍板：不开新公共面）：**让位 / 丢锁**——Agent 在这两条路上各发一条诊断
    // （`[lease_handoff]` / `[lease_lost]`，经 lifecycle notification 送出，让位那条发在它自己 stop() 之前），
    // 以及连着空闲够久。此前拿 `acceptsWork` 当「被请走」读：一有活干它就变 false，宿主一被叫醒就自己收摊、
    // 把要处理的那条消息当场掐掉——它起来就是为了处理那条消息的。
    let gone = false;
    const unsubscribe = echo.agent.subscribeLifecycle((e) => {
      if (e.type === "notification" && (e.message.startsWith("[lease_handoff]") || e.message.startsWith("[lease_lost]"))) gone = true;
    });
    try {
      await echo.start();
      // 起来这一下就会把盘上攒着的 inbox 吃掉（`start()` 里那句 `consumeInbox()`）。
      // 之后靠每秒一拍的轮询接着收别人写进来的；连着空闲够久就收摊。
      let idleSince = Date.now();
      while (!signal.aborted && !gone) {
        await new Promise((r) => setTimeout(r, SERVE_TICK_MS));
        // 忙 = 跑着，或 admission 还没把这一段放回可接活（inbox 的 ack 裁决窗口里 status 已是 idle 而 acceptsWork 仍 false）
        const busy = echo.agent.state.status !== "idle" || !echo.agent.acceptsWork;
        if (busy) idleSince = Date.now();
        else if (Date.now() - idleSince >= SERVE_IDLE_MS) break;
      }
    } finally {
      unsubscribe();
    }
    return 0;
  } finally {
    await echo.stop(); // 让位那条路 Agent 自己已经 stop() 过了：幂等
  }
}

async function runPiped(
  product: Product,
  form: PresetForm,
  opts: CliOptions,
  provider: Provider,
  choices: readonly FirstRunChoice[],
  credentials: CredentialStore,
  sessionId: string | undefined,
  notices: readonly string[],
  signal: AbortSignal,
): Promise<number> {
  // **唯一 composition root**：壳子不自己装配，只把装好的 Echo 接到进程与输入源上。
  const base = echoOptions(product, form, opts, provider, choices, credentials, sessionId);
  // 管道形态的交互面段（`echo:pipe`）：与交互形态的 `echo:tui` 注册的是同名 `surface` 段，两者互斥
  const echo = await createEcho({ ...base, extensions: [...(base.extensions ?? []), pipeSurfaceEntry()] });
  // 启动口信（设置读不动等）与装配诊断（坏扩展被跳过，D6）都走 stderr：说了才算没静默，但不挡启动、不改退出码
  if (sessionId !== undefined) process.stderr.write(`[会话] 续 ${sessionId}\n`); // 续了就说，无声恢复是禁止的
  for (const n of notices) process.stderr.write(`${n}\n`);
  for (const d of echo.diagnostics) process.stderr.write(`[扩展] [${d.code}] ${d.message}${d.path !== undefined ? `（${d.path}）` : ""}\n`);
  return await run({ echo, input: linesOf(process.stdin, signal), signal });
}

/**
 * 交互形态：壳作为 extension 进装配，进程这一层只剩三件事——装配、启动、等它退出。
 *
 * **换段（`/resume <id>`）也归这一层**（2026-09-07）：壳退出时说要换到哪一段，这里
 * 收摊当前这一段、按新 id 重装一份、把界面开回来。壳子里就地换 `Agent` 是做不到的——
 * 租约、收件箱、任务清单、闹钟、观测库全挂在那一个实例上，而协议里连 `start`/`stop` 都没有。
 *
 * **先放开再去拿**：换段时旧的那一段一定先 `stop()`（锁还回去）再装新的，所以
 * 「同一进程同时占两把锁」这条路根本不存在。代价是新的那一段可能拿不到（正被别的写者
 * 占着且不肯让），这时退回刚才那一段——只退一次，退不回去就照旧 fail-loud。
 */
async function runInteractive(
  shell: Shell,
  product: Product,
  form: PresetForm,
  opts: CliOptions,
  chosen: FirstRunChoice,
  choices: readonly FirstRunChoice[],
  credentials: CredentialStore,
  sessionId: string | undefined,
  notices: readonly string[],
  signal: AbortSignal,
  deps: MainDeps,
): Promise<number> {
  /** 这一轮开哪一段：缺省 = 命令行定的那一段，之后 = `/resume` 点名的那一段。 */
  let toOpen = sessionId;
  /** 攒给下一份界面的口信：启动口信，或上一轮换段的结果。 */
  let pending: readonly string[] = notices;
  /** 上一段的 id。只在「刚换过段」时有值——换不成就退回它，退一次。 */
  let fallback: string | undefined;
  for (;;) {
    const ui = shell.open({
      product,
      signal,
      ...(deps.ui !== undefined ? { ui: deps.ui } : {}),
      // 壳子的凭据配置段与 Ctrl+L 跨家选择器要的东西：全部可选的家 + 凭据 + 「换模成功就写设置」的回调（D7）
      configure: {
        providers: choices,
        credentials,
        onModelChange: (m: { provider: string; id: string }): void => {
          void writeSettings({ model: m }).then((w) => {
            if (w.problem !== undefined) ui.notify(`[设置] ${w.problem}`);
          });
        },
        ...(deps.verify !== undefined ? { verify: deps.verify } : {}),
      },
    });
    const base = echoOptions(product, form, opts, chosen.provider, choices, credentials, toOpen);
    const echo = await createEcho({
      ...base,
      // 产品自带的 Extension 在前、壳在最后：壳也只是一条 Extension（`echo:tui`），它 inject 的
      // `AgentRuntime` 由 builtin 那一代提供（`create-echo.ts`），与同代里谁先谁后无关。
      extensions: [...(base.extensions ?? []), { entryId: "echo:tui", definition: ui.definition }],
    });
    // 启动口信与装配诊断（D6）进界面：壳 mount 在先、这里在后，notify 直通或先攒着
    for (const n of pending) ui.notify(n);
    for (const d of echo.diagnostics) ui.notify(`[扩展] 没装上：${d.message}${d.path !== undefined ? `（${d.path}）` : ""}`);
    pending = [];
    try {
      // **启停归这一层**，不归壳：协议里没有 `start`/`stop`，壳子想碰也碰不到。
      await echo.start();
    } catch (e) {
      await echo.stop();
      if (fallback === undefined) throw e; // 头一段就起不来：照旧 fail-loud，别把报错吞成一句口信
      pending = [`[会话] 切不过去：${errText(e)}——回到 ${fallback}`];
      toOpen = fallback;
      fallback = undefined;
      continue;
    }
    // 缺省新建时命令行没给 id，真正的 id 只有起来之后才知道——退回去要用它。
    // `null`（没有状态根的裸跑）= 无处可退，那时换段失败就照旧 fail-loud。
    const openedId = echo.agent.state.sessionId ?? undefined;
    let exit;
    try {
      exit = await ui.exited;
    } finally {
      await echo.stop(); // 先卸 Extension（含壳自己）再停 Agent
    }
    if (exit.resume === undefined) return exit.code;
    toOpen = exit.resume;
    fallback = openedId;
    pending = [`[会话] 已切到 ${exit.resume}`];
  }
}
