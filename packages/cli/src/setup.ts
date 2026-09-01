// 首次运行的配置流程：**没有凭据时也能起来，在界面里配完继续跑**。
//
// ## 这不是把 fail-loud 放宽
//
// fail-loud 防的是**假装在工作**——缺 key 偷偷换个假模型、或者装起来一半。这里一件都没做：
// 屏幕上明说「还没配」，配不成就不启动，验不过就不落盘。变的只是**对谁用哪种策略**：
// 管道/CI 那头没人能回答问题，报错退出是对的；终端这头有人坐着，把问题问出来才是对的。
// 形态判据沿用仓里已有的那条（stdin 是不是终端），本文件不引入第二个。
//
// ## 为什么「验一次」是必须的
//
// 存一个坏 key 比不存更糟：下次启动会以「没有可用模型」失败，而用户明明记得自己配过，
// 于是去查环境变量、查文档，就是不会怀疑那把 key 本身。所以**验过才写**。
//
// ## 「模型目录刷新」在内建 provider 上并不存在
//
// 五家内建 provider 都没有 `fetchModels`，因此 `provider.refreshModels` 是 `undefined`、
// `Models.refresh()` 直接跳过它们——目录是纯静态的，拿它验 key 等于什么都没验。
// 所以这里打的是真实的等价物：`GET {baseUrl}/models` 带 Bearer。那是 OpenAI 兼容端点的
// 标准接口，坏 key 回 401/403，而且只读、便宜。`fetchFn` 可注入，测试一行都不碰网。
//
// ## 按键一律走 `matchesKey()`，**不许手写字节比较**
//
// 同一个按键在不同终端下有多种字节形式，手写 `data === "\x1b[B"` 只认得其中一种：
//   · 「下」既可能是 `ESC[B`，也可能是应用光标键模式的 `ESC O B`（`keys.ts` 里两条都列着）；
//   · Ctrl+C 在传统终端是字节 `0x03`，但 pi-tui 会**探测并启用 Kitty 键盘协议**
//     （`ProcessTerminal` 的 `queryAndEnableKittyProtocol()`），那之后它变成 `ESC[99;5u`。
// 于是「方向键不动、Ctrl+C 退不出去」——2026-08-31 用户在真终端上撞到的就是这个。
// 假 TUI 测不出来：它的 `feed()` 直接把字符串交给 `handleInput`，绕过了终端的编码这一层。
// 判据落在 `setup-pty.test.ts`（真 PTY，把这几种编码逐个送进去）。
//
// Kitty 协议还会为同一次按键补发一条 **release**，所以每个入口都要先 `isKeyRelease()` 滤掉，
// 否则按一下等于按两下。
//
// ## key 不回显、也不进任何字符串
//
// 输入期只画掩码；`Input` 的 `render()` **一次都不能调**（它会把明文画出来）。
// 验证失败的原因、写盘失败的报错里也一律没有 key——它只出现在 Authorization 头里。

import { errText, type CredentialStore, type Provider } from "@echo-agent/core";
import {
  decodeKittyPrintable,
  Input,
  isKeyRelease,
  matchesKey,
  ProcessTerminal,
  TuiMainScreen,
  type TUI,
} from "@earendil-works/pi-tui";

const ESC = String.fromCharCode(27);
const DIM = `${ESC}[2m`;
const UNDIM = `${ESC}[22m`;
const YELLOW = `${ESC}[33m`;
const RED = `${ESC}[31m`;
const DEFAULT_COLOR = `${ESC}[39m`;

/** 一个可选项。`name` 是 `--provider` 认的那个短名，摆在屏幕上好让用户对得上。 */
export type SetupChoice = Readonly<{ name: string; provider: Provider }>;

/** 验一把 key 能不能用。`reason` 是给人看的，**不许包含 key**。 */
export type VerifyOutcome = Readonly<{ ok: true }> | Readonly<{ ok: false; reason: string }>;

export type VerifyFn = (
  input: Readonly<{ provider: Provider; apiKey: string; signal?: AbortSignal }>,
) => Promise<VerifyOutcome>;

export type SetupOutcome =
  /** 配好了，用这家继续启动。 */
  | Readonly<{ kind: "configured"; provider: Provider }>
  /** 用户自己退出了（Ctrl+C / Ctrl+D），或进程被中止。 */
  | Readonly<{ kind: "cancelled" }>;

export type SetupOptions = Readonly<{
  choices: readonly SetupChoice[];
  /** 验过之后写进这里。 */
  credentials: CredentialStore;
  /** 光标初始停在哪个 `name` 上——`--provider` 给的那个。 */
  preselect?: string;
  /** 注入用：测试给假的 TUI。 */
  ui?: TUI;
  signal?: AbortSignal;
  /** 注入用：测试给假的验证。缺省 `verifyApiKey`（真打一次 HTTP）。 */
  verify?: VerifyFn;
}>;

/**
 * 拿一把 key 去问端点「你认不认」。**只读**：`GET {baseUrl}/models`。
 *
 * key 只出现在 Authorization 头里——不进 URL（会被日志与代理记下来），
 * 也不进任何返回的 `reason`。
 */
export async function verifyApiKey(
  input: Readonly<{ provider: Provider; apiKey: string; signal?: AbortSignal; fetchFn?: typeof fetch }>,
): Promise<VerifyOutcome> {
  const baseUrl = input.provider.baseUrl;
  if (baseUrl === undefined) {
    // 五家内建的都有 baseUrl；自定义 provider 没有就**说清楚验不了**，不要假装验过。
    return { ok: false, reason: `provider '${input.provider.id}' 没有 baseUrl，没法验证这把 key` };
  }
  const url = `${baseUrl.replace(/\/+$/, "")}/models`;
  const doFetch = input.fetchFn ?? fetch;
  let res: Response;
  try {
    res = await doFetch(url, {
      method: "GET",
      headers: { ...input.provider.headers, authorization: `Bearer ${input.apiKey}` },
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    });
  } catch (e) {
    return { ok: false, reason: `连不上 ${url}：${errText(e)}` };
  }
  if (res.ok) return { ok: true };
  if (res.status === 401 || res.status === 403) return { ok: false, reason: `这把 key 被端点拒了（HTTP ${res.status}）` };
  // 5xx / 429 之类不是「key 不对」，但也**没能证明它对**——不能凭这个就落盘。
  return { ok: false, reason: `${url} 回了 HTTP ${res.status}，没能确认这把 key 可用` };
}

type Stage =
  | Readonly<{ kind: "pick" }>
  | Readonly<{ kind: "key"; choice: SetupChoice; error?: string }>
  | Readonly<{ kind: "checking"; choice: SetupChoice }>;

/**
 * 跑一遍配置流程，跑到「配好了」或「用户退出」。
 *
 * **只做首次运行要的那几步**，不是设置中心：选一家 → 收 key（掩码）→ 验一次 → 写盘。
 * 换 key、删凭据、多 provider 并存都不在这里——那些是别的入口的事。
 */
export async function runCredentialSetup(opts: SetupOptions): Promise<SetupOutcome> {
  const { choices, credentials, signal } = opts;
  if (choices.length === 0) throw new Error("配置流程至少要有一个可选 provider");
  const ui: TUI = opts.ui ?? new TuiMainScreen(new ProcessTerminal(), false, process.cwd());
  const verify = opts.verify ?? ((input): Promise<VerifyOutcome> => verifyApiKey(input));

  const preselected = choices.findIndex((c) => c.name === opts.preselect);
  let cursor = preselected >= 0 ? preselected : 0;
  let stage: Stage = { kind: "pick" };

  // **用 pi-tui 的 `Input` 管缓冲区，但不用它渲染**（理由见文件头）：它已经处理好了
  // bracketed paste（粘贴一把 key 不能被当成回车提交）、退格、行内编辑；
  // 我们只是自己画掩码，绝不调它的 `render()`。
  const secret = new Input();

  // **成功与失败共用同一个结算闸**：`settled` 一旦置上，后来的按键与在飞的验证都不再改结果。
  // 上一版只有 resolve、失败那条走 `throw`——于是写盘失败时 `done` 永远醒不来，
  // 调用方挂死在 `await`（写这条测试时当场撞上）。**失败也是一种结算**。
  let resolveDone: ((outcome: SetupOutcome) => void) | null = null;
  let rejectDone: ((e: unknown) => void) | null = null;
  let settled = false;
  const done = new Promise<SetupOutcome>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });
  const finish = (outcome: SetupOutcome): void => {
    if (settled) return;
    settled = true;
    resolveDone?.(outcome);
  };
  const abandon = (e: unknown): void => {
    if (settled) return;
    settled = true;
    rejectDone?.(e);
  };

  const rerender = (): void => ui.requestRender();

  secret.onSubmit = (value: string): void => {
    if (stage.kind !== "key") return;
    const apiKey = value.trim();
    if (apiKey === "") {
      // 空回车不算一次提交：既不去验，也不报错——它就是「还没输完」。
      return;
    }
    const choice = stage.choice;
    stage = { kind: "checking", choice };
    rerender();
    void (async (): Promise<void> => {
      const outcome = await verify({ provider: choice.provider, apiKey, ...(signal !== undefined ? { signal } : {}) });
      if (settled) return; // 验的过程中用户退出了
      if (!outcome.ok) {
        // **验不过就不写**。key 留在输入行里不清空——多半只是漏贴了几个字符，
        // 让他接着改，比清空重来友好，而且屏幕上明说了为什么不收。
        stage = { kind: "key", choice, error: outcome.reason };
        rerender();
        return;
      }
      // 验过了才落盘。写盘失败**照抛**——它不是 key 的问题，重输一遍也好不了，
      // 让它冒到进程那一层如实报出来（比如 `~/.echo` 不可写）。
      await credentials.write(choice.provider.id, { type: "api_key", key: apiKey });
      secret.setValue(""); // 缓冲区里不留 key
      finish({ kind: "configured", provider: choice.provider });
    })().catch((e: unknown) => {
      secret.setValue("");
      abandon(e);
    });
  };

  const root = {
    get focused(): boolean {
      return secret.focused;
    },
    set focused(value: boolean) {
      secret.focused = value;
    },
    render: (width: number): string[] => {
      void width;
      const lines: string[] = [`${YELLOW}还没有可用的凭据——先配一个${DEFAULT_COLOR}`, ""];
      if (stage.kind === "pick") {
        lines.push("用哪一家？（这也决定这次启动用哪家）");
        choices.forEach((c, i) => {
          const mark = i === cursor ? "❯" : " ";
          lines.push(`${mark} ${i + 1}. ${c.provider.name}${DIM}  --provider ${c.name}${UNDIM}`);
        });
        lines.push("", `${DIM}↑/↓ 选 · 数字直选 · 回车确认 · Ctrl+C 退出${UNDIM}`);
        return lines;
      }
      lines.push(`${stage.choice.provider.name} 的 API key：`);
      if (stage.kind === "checking") {
        lines.push(`${DIM}正在验证…${UNDIM}`);
        return lines;
      }
      // **只画掩码**。长度是故意露出来的：粘贴到底进没进来，看得见才判断得了。
      lines.push(`> ${"•".repeat(secret.getValue().length)}`);
      if (stage.error !== undefined) {
        lines.push(`${RED}验不过，没有保存：${stage.error}${DEFAULT_COLOR}`);
      }
      lines.push("", `${DIM}输入不回显 · 回车验证并保存 · Ctrl+C 退出${UNDIM}`);
      return lines;
    },
    handleInput: (data: string): void => {
      // Kitty 协议给同一次按键补发的 release：不滤掉就是按一下动两格
      if (isKeyRelease(data)) return;
      if (stage.kind === "checking") return; // 验的时候不收键，免得把回答塞进下一个阶段
      if (stage.kind === "pick") {
        if (matchesKey(data, "up")) {
          cursor = (cursor - 1 + choices.length) % choices.length;
        } else if (matchesKey(data, "down")) {
          cursor = (cursor + 1) % choices.length;
        } else if (matchesKey(data, "return") || matchesKey(data, "enter")) {
          stage = { kind: "key", choice: choices[cursor]! };
        } else {
          // 数字直选。Kitty 协议下连普通可打印字符都走 CSI-u（`1` 是 `ESC[49u`），
          // 所以先解码回字符再判——直接 `/^[1-9]$/.test(data)` 在那种终端上永远不成立。
          const printable = decodeKittyPrintable(data) ?? data;
          if (/^[1-9]$/.test(printable)) {
            const i = Number(printable) - 1;
            if (i < choices.length) {
              cursor = i;
              stage = { kind: "key", choice: choices[i]! };
            }
          }
        }
        rerender();
        return;
      }
      secret.handleInput(data);
      rerender();
    },
    invalidate: (): void => {
      secret.invalidate();
    },
  };

  // Ctrl+C / Ctrl+D：退出。走 `addInputListener` 并 `consume`，与主界面同一条路——
  // 不这么做的话按键会落进 `Input` 缓冲区，变成 key 的一部分。
  const removeListener = ui.addInputListener((data) => {
    if (isKeyRelease(data)) return undefined;
    if (matchesKey(data, "ctrl+c") || matchesKey(data, "ctrl+d")) {
      secret.setValue("");
      finish({ kind: "cancelled" });
      return { consume: true };
    }
    return undefined;
  });
  const onAbort = (): void => {
    secret.setValue("");
    finish({ kind: "cancelled" });
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  // **已经 abort 过的信号不会补发事件**（`stdin.ts` / `app.ts` / `extension.ts` 都踩过这个坑）：
  // 注册完主动看一眼，否则 SIGINT 落在启动这一段时，下面那个 `await done` 永远醒不来。
  if (signal?.aborted === true) onAbort();

  ui.addChild(root);
  ui.setFocus(root);
  ui.start();
  try {
    return await done;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    removeListener();
    secret.setValue(""); // 无论怎么结束，缓冲区里都不留 key
    ui.stop();
  }
}
