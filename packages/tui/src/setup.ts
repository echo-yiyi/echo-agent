// 主界面里的凭据配置段：收 key（掩码）→ 验一次 → 写盘。
//
// **它是一个组件片段，不是一屏**：`app.ts` 在「还没配」时用它的 `render()` 顶替输入行、
// 把按键交给它的 `handleInput()`；配好了就撤掉，输入行回来。应用级键（Ctrl+C 清空 / Ctrl+D 退出）
// 由 `app.ts` 统一判，这里只暴露 `isEmpty()` / `clear()` 给它用。
//
// 输入期只画掩码；`Input` 的 `render()` **一次都不能调**（它会把明文画出来）。key 不进任何
// 返回给人看的字符串——判据与验证在 `@echo-agent/base` 的 `setup.ts`，那一侧同一条纪律。

import { errText, type CredentialStore, type Provider } from "@echo-agent/core";
import { verifyApiKey, type VerifyFn, type VerifyOutcome } from "@echo-agent/base";
import { Input, isKeyRelease } from "@earendil-works/pi-tui";
import { dim, red, yellow } from "./theme.ts";

export type CredentialSetupOptions = Readonly<{
  /** 给哪家配。就是这次启动装配的那家——换家是 `--provider` 或 P3 的 `/model` 的事。 */
  provider: Provider;
  /** 验过之后写进这里。 */
  credentials: CredentialStore;
  /** 别的可选 provider 的 `--provider` 短名，只用来在屏幕上提示「换一家怎么换」。不给就不提。 */
  alternatives?: readonly string[];
  /** 注入用：测试给假的验证。缺省 `verifyApiKey`（真打一次 HTTP）。 */
  verify?: VerifyFn;
  signal?: AbortSignal;
  /** 验过、写盘成功。 */
  onConfigured: () => void;
  /** 写盘失败——不是 key 的问题，重输一遍也好不了，交给壳子如实显示。 */
  onError: (e: unknown) => void;
}>;

/**
 * 主界面里的凭据配置段：收 key（掩码）→ 验一次 → 写盘。
 *
 * 它是一个**组件片段**，不是一屏：`app.ts` 在「还没配」时用它的 `render()` 顶替输入行、
 * 把按键交给它的 `handleInput()`；配好了就撤掉，输入行回来。应用级键（Ctrl+C 清空 / Ctrl+D 退出）
 * 由 `app.ts` 统一判，这里只暴露 `isEmpty()` / `clear()` 给它用。
 */
export class CredentialSetup {
  // **用 pi-tui 的 `Input` 管缓冲区，但不用它渲染**（理由见文件头）：它已经处理好了
  // bracketed paste（粘贴一把 key 不能被当成回车提交）、退格、行内编辑；
  // 我们只是自己画掩码，绝不调它的 `render()`。
  private readonly secret = new Input();
  private checking = false;
  private error: string | undefined;
  private disposed = false;

  constructor(private readonly opts: CredentialSetupOptions) {
    this.secret.onSubmit = (value: string): void => this.submit(value);
  }

  /** 输入行里有没有字——`app.ts` 判「Ctrl+D 是退出还是删字」用。 */
  isEmpty(): boolean {
    return this.secret.getValue() === "";
  }

  /** Ctrl+C：清空。 */
  clear(): void {
    this.secret.setValue("");
    this.error = undefined;
  }

  /** 撤掉时调：缓冲区里不留 key；在飞的验证结果也不再落盘。 */
  dispose(): void {
    this.disposed = true;
    this.secret.setValue("");
  }

  render(width: number): string[] {
    const p = this.opts.provider;
    const lines: string[] = [yellow(`还没有 ${p.name} 的 API key——贴进下面这行，回车验证并保存`)];
    if (this.opts.alternatives !== undefined && this.opts.alternatives.length > 0) {
      lines.push(dim(`换一家：重启时加 --provider ${this.opts.alternatives.join(" / ")}；也可以设环境变量后重启`));
    }
    if (this.checking) {
      lines.push(dim("正在验证…"));
      return lines;
    }
    // **只画掩码**。长度是故意露出来的：粘贴到底进没进来，看得见才判断得了。
    // 边框与内边距照 `Editor`（上下各一条 `─`、左右各留一列）——它顶替的是输入行的位置，
    // 长得像输入行用户才知道「这就是要我打字的地方」（P1 视觉对齐）。
    const border = dim("─".repeat(Math.max(1, width)));
    lines.push(border, ` ${"•".repeat(this.secret.getValue().length)}`, border);
    if (this.error !== undefined) lines.push(red(`验不过，没有保存：${this.error}`));
    lines.push(dim("输入不回显 · 回车验证并保存 · Ctrl+C 清空 · Ctrl+D 退出"));
    return lines;
  }

  handleInput(data: string): void {
    if (isKeyRelease(data)) return; // Kitty 协议补发的 release：不滤掉就是按一下进两个字
    if (this.checking) return; // 验的时候不收键，免得把下一段输入混进这把 key
    this.secret.handleInput(data);
  }

  invalidate(): void {
    this.secret.invalidate();
  }

  private submit(value: string): void {
    const apiKey = value.trim();
    if (apiKey === "") return; // 空回车不算一次提交：既不去验，也不报错——它就是「还没输完」
    this.checking = true;
    this.error = undefined;
    const { provider, credentials, signal } = this.opts;
    const verify = this.opts.verify ?? ((input): Promise<VerifyOutcome> => verifyApiKey(input));
    void (async (): Promise<void> => {
      const outcome = await verify({ provider, apiKey, ...(signal !== undefined ? { signal } : {}) });
      if (this.disposed) return; // 验的过程中被撤掉了（用户退出）
      if (!outcome.ok) {
        // **验不过就不写**。key 留在输入行里不清空——多半只是漏贴了几个字符，
        // 让他接着改，比清空重来友好，而且屏幕上明说了为什么不收。
        this.checking = false;
        this.error = outcome.reason;
        return;
      }
      // 验过了才落盘。写盘失败走 `onError`——它不是 key 的问题，重输一遍也好不了。
      await credentials.write(provider.id, { type: "api_key", key: apiKey });
      this.secret.setValue(""); // 缓冲区里不留 key
      this.checking = false;
      this.opts.onConfigured();
    })().catch((e: unknown) => {
      this.secret.setValue("");
      this.checking = false;
      if (!this.disposed) this.opts.onError(e);
    });
  }
}
