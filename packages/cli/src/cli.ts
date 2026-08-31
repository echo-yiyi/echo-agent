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
  kimiProvider,
  minimaxProvider,
  openaiProvider,
  zaiCodingProvider,
  type Provider,
} from "@echo-agent/core";
import { tuiShell } from "./extension.ts";
import { run } from "./run.ts";
import { linesOf } from "./stdin.ts";

export type CliOptions = {
  /** 状态根。不给则由 core 决定（`ECHO_HOME`，再退到 `$PWD/.echo`）。 */
  stateDir?: string;
  agentId?: string;
  provider: "kimi" | "deepseek" | "openai" | "zai" | "minimax";
  model?: string;
  /** `--no-memory`：不装记忆，也就不开 Dream 自调度。一次性跑用得上。 */
  withoutMemory: boolean;
  /** 可重复。一条都不给 = 走约定目录 `<cwd>/extensions`。 */
  extensionDirs: string[];
};

const PROVIDERS: Record<CliOptions["provider"], () => Provider> = {
  kimi: () => kimiProvider(),
  deepseek: () => deepseekProvider(),
  openai: () => openaiProvider(),
  // `zai` 是短名，实际是智谱 GLM 的 coding 端点（pi 那边叫 `zai-coding-cn`）
  zai: () => zaiCodingProvider(),
  // MiniMax 挂的是 **M3**：目录换成它之后 thinking 可以关掉，不再需要「先改消息契约才能用」。
  // **仍未经真 key 实跑验证**（假 fetch 只证明请求体形状），这一条登记在 `docs/ISSUES.md`。
  minimax: () => minimaxProvider(),
};

export const USAGE = `用法：echo-agent [选项]

  stdin 是终端 → 起交互界面；是管道/重定向 → 一行输入跑一轮，
  正文进 stdout、工具旁白进 stderr，读完就干净收摊。Ctrl-C 也是干净收摊。

选项：
  --state-dir <路径>   状态根（缺省：$ECHO_HOME/agents/<id>，再退到 $PWD/.echo/agents/<id>）
  --agent-id <名字>    同一状态根下的 agent 身份（缺省 default）
  --provider <名字>    kimi | deepseek | openai | zai | minimax（缺省 kimi）
  --model <id>         模型 id（缺省由 provider 声明）
  --extensions <目录>  去哪里找扩展，可重复（缺省 ./extensions）
  --no-memory          不装记忆与 Dream
  -h, --help           显示本帮助

凭据走环境变量（MOONSHOT_API_KEY / ECHO_LLM_API_KEY 等，由 provider 自己认）。
**缺凭据不会退化成假模型**——它会直接报错退出。`;

/**
 * 解析 argv（**不含** node/bun 与脚本名两项）。
 *
 * 返回 `null` = 该打帮助并以 0 退出。其余任何不认识的输入都 `throw`。
 */
export function parseArgs(argv: readonly string[]): CliOptions | null {
  if (argv[0] === "-h" || argv[0] === "--help") return null;

  const opts: CliOptions = { provider: "kimi", withoutMemory: false, extensionDirs: [] };

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
        opts.provider = v as CliOptions["provider"];
        break;
      }
      case "--no-memory":
        opts.withoutMemory = true;
        break;
      default:
        throw new Error(`不认识的选项 '${flag}'\n\n${USAGE}`);
    }
  }
  return opts;
}

/** `createEcho()` 的入参，两种形态共用——**装配只有一处**，形态差别只在「装不装壳」。 */
function echoOptions(opts: CliOptions): Parameters<typeof createEcho>[0] {
  return {
    provider: PROVIDERS[opts.provider](),
    withoutMemory: opts.withoutMemory,
    ...(opts.stateDir !== undefined ? { stateDir: opts.stateDir } : {}),
    ...(opts.agentId !== undefined ? { agentId: opts.agentId } : {}),
    ...(opts.model !== undefined ? { model: opts.model } : {}),
    // **一条 `--extensions` 都不给就走约定目录**（`<cwd>/extensions`）——给了就只用给的，
    // 所以这里区分「空数组」与「不传」，不能无脑展开。
    ...(opts.extensionDirs.length > 0 ? { extensionDirs: opts.extensionDirs } : {}),
  };
}

/**
 * 进程入口的实质。**返回退出码，自己不调 `process.exit`**——那样测不了，
 * 也会把还没 flush 的输出砍掉。
 *
 * `SIGINT` / `SIGTERM` 都接到同一个 `AbortController` 上：对「怎么停」只有一种回答。
 * **不装第二次强杀**——收摊本来就该在有限时间内完成，装了强杀就等于给「收不干净」发了许可证。
 *
 * @param interactive 形态。缺省看 stdin 是不是终端；测试可以直接指定。
 */
export async function main(argv: readonly string[], interactive: boolean = process.stdin.isTTY === true): Promise<number> {
  let opts: CliOptions | null;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    return 2;
  }
  if (opts === null) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  const controller = new AbortController();
  const stop = (): void => controller.abort();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  try {
    return interactive ? await runInteractive(opts, controller.signal) : await runPiped(opts, controller.signal);
  } catch (e) {
    // 装配失败（缺凭据、锁被别的进程占着、状态根不可写）一律**明说**并非零退出。
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}

/** 管道形态：`run()` 自己会 `echo.stop()`（它的 `finally`），所以这里不重复收摊。 */
async function runPiped(opts: CliOptions, signal: AbortSignal): Promise<number> {
  // **唯一 composition root**（§14.2）：壳子不自己装配，只把装好的 Echo 接到进程与输入源上。
  const echo = await createEcho(echoOptions(opts));
  return await run({ echo, input: linesOf(process.stdin, signal), signal });
}

/** 交互形态：壳作为 extension 进装配，进程这一层只剩三件事——装配、启动、等它退出。 */
async function runInteractive(opts: CliOptions, signal: AbortSignal): Promise<number> {
  const shell = tuiShell({ signal });
  const echo = await createEcho({
    ...echoOptions(opts),
    extensions: [{ entryId: "echo:tui", definition: shell.definition as never }],
  });
  try {
    // **启停归这一层**，不归壳：协议里没有 `start`/`stop`，壳子想碰也碰不到。
    await echo.agent.start();
    return await shell.exited;
  } finally {
    await echo.stop(); // 先卸 Extension（含壳自己）再停 Agent
  }
}
