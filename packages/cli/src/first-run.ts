// 首次运行的引导设置（D4，2026-09-01 用户拍板）：**欢迎 → 选 provider → 贴 key → 验证 → 选模型 → 进对话**。
// 样子照 Claude Code 的选择器：标题与说明在上，带光标的编号列表在下，缺省项带 ✓ 预选中。
//
// ## 为什么跑在 `createEcho()` 之前
//
// 选哪家、用哪个模型，本来就得在装配前定——模型解析发生在装配期（core `create-agent.ts`），
// 运行中换模型是 P3 的 `/model`（协议缺口）。**这不是回退 D3**：装配仍然不看凭据，
// key 中途失效仍在主界面里重配（`app.ts` 的 CredentialSetup）；这里只是把「第一次的选择」
// 放到它唯一能生效的位置上，而且第一眼看到的就是欢迎头——用户感受到的是「进来了，被引导着配」。
//
// ## 列表用 pi-tui 的 `SelectList`
//
// ↑↓ / 回车 / Esc 它内置（走的就是 keybindings，Kitty 编码天然认得）；两列对齐、滚动也是它的。
// 我们只补两件：**数字直选**（`1`–`9` 跳过去直接确认）和 **Ctrl+D 退出**——都过 `matchesKey`，
// 纪律与门同 `keybindings.ts` / `test/key-discipline.test.ts`。
//
// 模型选择**这次会话生效**；要固定下来用 `--model`（选不选缺省都会印在欢迎头的「模型」行里）。
// 选完的持久化（记住上次选的模型）是另一个落盘格式决定，没拍板前不做。

import type { CredentialStore, Provider } from "@echo-agent/core";
import {
  decodeKittyPrintable,
  isKeyRelease,
  matchesKey,
  ProcessTerminal,
  SelectList,
  TuiMainScreen,
  type TUI,
} from "@earendil-works/pi-tui";
import { bannerLines } from "./app.ts";
import { describeModel, describeProvider } from "./catalog.ts";
import { CredentialSetup, type VerifyFn } from "./setup.ts";
import { bold, dim, SELECT_LIST_THEME } from "./theme.ts";

/** 一个可选项。`name` 是 `--provider` 认的短名。 */
export type FirstRunChoice = Readonly<{ name: string; provider: Provider }>;

export type FirstRunOutcome =
  /** 配好了：用这家、这个模型去装配。key 已验证并写盘。 */
  | Readonly<{ kind: "configured"; provider: Provider; providerName: string; modelId: string }>
  /** 用户退出（Ctrl+D），或进程被中止。 */
  | Readonly<{ kind: "cancelled" }>;

export type FirstRunOptions = Readonly<{
  choices: readonly FirstRunChoice[];
  /** 验过之后写进这里。 */
  credentials: CredentialStore;
  /** 光标初始停在哪个短名上（`--provider` 给的那个）。 */
  preselect?: string;
  /** 注入用：测试给假的 TUI / 假验证。 */
  ui?: TUI;
  verify?: VerifyFn;
  signal?: AbortSignal;
}>;

type Stage = "provider" | "key" | "model";

export async function runFirstRunSetup(opts: FirstRunOptions): Promise<FirstRunOutcome> {
  const { choices, credentials, signal } = opts;
  if (choices.length === 0) throw new Error("引导设置至少要有一个可选 provider");
  const ui: TUI = opts.ui ?? new TuiMainScreen(new ProcessTerminal(), false, process.cwd());
  const banner = bannerLines(process.cwd());

  let stage: Stage = "provider";
  let chosen: FirstRunChoice = choices.find((c) => c.name === opts.preselect) ?? choices[0]!;
  let setup: CredentialSetup | null = null;
  let modelList: SelectList | null = null;

  // 结算闸与 `setup.ts` 同款：成功与失败共用，settled 之后按键与在飞的验证都不再改结果。
  let resolveDone: ((o: FirstRunOutcome) => void) | null = null;
  let rejectDone: ((e: unknown) => void) | null = null;
  let settled = false;
  const done = new Promise<FirstRunOutcome>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });
  const finish = (o: FirstRunOutcome): void => {
    if (settled) return;
    settled = true;
    resolveDone?.(o);
  };
  const abandon = (e: unknown): void => {
    if (settled) return;
    settled = true;
    rejectDone?.(e);
  };
  const rerender = (): void => ui.requestRender();

  /* ── 第一步：选 provider ──────────────────────────────────────────────── */

  const providerList = new SelectList(
    choices.map((c, i) => ({ value: c.name, label: `${i + 1}. ${c.provider.name}`, description: describeProvider(c.provider) })),
    10,
    SELECT_LIST_THEME,
  );
  providerList.setSelectedIndex(Math.max(0, choices.findIndex((c) => c.name === chosen.name)));
  providerList.onSelect = (item): void => {
    chosen = choices.find((c) => c.name === item.value)!;
    enterKeyStage();
  };
  // provider 是第一步，Esc 没有上一步可回——不接 onCancel，按了就当没按。

  /* ── 第二步：贴 key（复用主界面同一个组件，验过才写盘） ────────────────── */

  function enterKeyStage(): void {
    stage = "key";
    setup = new CredentialSetup({
      provider: chosen.provider,
      credentials,
      ...(opts.verify !== undefined ? { verify: opts.verify } : {}),
      ...(signal !== undefined ? { signal } : {}),
      onConfigured: () => enterModelStage(),
      onError: (e) => abandon(e), // 写盘失败不是 key 的问题，如实抛给进程层
    });
    rerender();
  }

  /* ── 第三步：选模型（缺省 ✓ 预选中，回车即用） ─────────────────────────── */

  function enterModelStage(): void {
    stage = "model";
    setup?.dispose();
    setup = null;
    const models = chosen.provider.getModels();
    const def = chosen.provider.defaultModelId ?? models[0]?.id;
    modelList = new SelectList(
      models.map((m, i) => ({
        value: m.id,
        label: `${i + 1}. ${m.name ?? m.id}${m.id === def ? " ✓" : ""}`,
        description: describeModel(m),
      })),
      10,
      SELECT_LIST_THEME,
    );
    modelList.setSelectedIndex(Math.max(0, models.findIndex((m) => m.id === def)));
    modelList.onSelect = (item): void =>
      finish({ kind: "configured", provider: chosen.provider, providerName: chosen.name, modelId: item.value });
    modelList.onCancel = (): void => {
      // Esc：回到选 provider（key 已经验过写盘了，回去换一家也不亏）
      stage = "provider";
      modelList = null;
      rerender();
    };
    rerender();
  }

  /* ── 屏幕 ─────────────────────────────────────────────────────────────── */

  const root = {
    focused: true,
    render: (width: number): string[] => {
      const lines = [...banner, ""];
      if (stage === "provider") {
        lines.push(bold("选择 provider"));
        lines.push(dim("首次运行先配一家。你的选择决定这次用谁；以后重启加 --provider 换。"));
        lines.push("");
        lines.push(...providerList.render(width));
        lines.push("", dim("↑/↓ 选 · 数字直选 · 回车确认 · Ctrl+D 退出"));
        return lines;
      }
      if (stage === "key" && setup !== null) {
        lines.push(...setup.render(width));
        lines.push(dim("Esc 返回选 provider"));
        return lines;
      }
      if (stage === "model" && modelList !== null) {
        lines.push(bold("选择模型"));
        lines.push(dim(`${chosen.provider.name} 的目录。回车用缺省（✓）就好；这次会话生效，以后可用 --model 指定。`));
        lines.push("");
        lines.push(...modelList.render(width));
        lines.push("", dim("↑/↓ 选 · 数字直选 · 回车确认 · Esc 返回 · Ctrl+D 退出"));
        return lines;
      }
      return lines;
    },
    handleInput: (data: string): void => {
      if (isKeyRelease(data)) return; // Kitty 补发的 release：按一下不许算两下
      // Ctrl+D 退出；key 阶段有字时它是编辑键（向前删），交给 Input
      if (matchesKey(data, "ctrl+d") && (stage !== "key" || setup === null || setup.isEmpty())) {
        finish({ kind: "cancelled" });
        return;
      }
      if (stage === "provider") {
        const i = digitIndex(data, choices.length);
        if (i !== null) {
          providerList.setSelectedIndex(i);
          chosen = choices[i]!;
          enterKeyStage();
          return;
        }
        providerList.handleInput(data);
        rerender();
        return;
      }
      if (stage === "key" && setup !== null) {
        if (matchesKey(data, "escape")) {
          setup.dispose();
          setup = null;
          stage = "provider";
          rerender();
          return;
        }
        if (matchesKey(data, "ctrl+c")) {
          setup.clear();
          rerender();
          return;
        }
        setup.handleInput(data);
        rerender();
        return;
      }
      if (stage === "model" && modelList !== null) {
        const models = chosen.provider.getModels();
        const i = digitIndex(data, models.length);
        if (i !== null) {
          const id = models[i]!.id;
          finish({ kind: "configured", provider: chosen.provider, providerName: chosen.name, modelId: id });
          return;
        }
        modelList.handleInput(data);
        rerender();
        return;
      }
    },
    invalidate: (): void => {
      providerList.invalidate();
      modelList?.invalidate();
      setup?.invalidate();
    },
  };

  const onAbort = (): void => finish({ kind: "cancelled" });
  signal?.addEventListener("abort", onAbort, { once: true });
  // 已经 abort 过的信号不会补发事件（stdin.ts / app.ts / extension.ts 都踩过）：注册完主动看一眼
  if (signal?.aborted === true) onAbort();

  ui.addChild(root);
  ui.setFocus(root);
  ui.start();
  try {
    return await done;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    // `setup` 只在闭包里被赋值，TS 在这个作用域把它收窄成了 null——显式标回类型再调
    (setup as CredentialSetup | null)?.dispose(); // 缓冲区里不留 key
    ui.stop();
  }
}

/** 数字直选：`1`–`9`。Kitty 协议下可打印字符走 CSI-u，先解码。超出条数的数字不算。 */
function digitIndex(data: string, count: number): number | null {
  const printable = decodeKittyPrintable(data) ?? data;
  if (!/^[1-9]$/.test(printable)) return null;
  const i = Number(printable) - 1;
  return i < count ? i : null;
}
