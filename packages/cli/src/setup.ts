// 凭据配置：**主界面里的一段，不是启动前的一屏**（2026-09-01 用户拍板：配置是运行态）。
//
// ## 为什么不再是向导
//
// 上一版是「起来之前先弹一屏：选 provider → 收 key → 验 → 写 → 再装配」。用户一启动就被按在
// 向导上，而 pi / Claude Code 都是界面先起来、key 是进去之后的事（pi：`/login`）。
// 根因不在壳，在 core 装配时按凭据过滤目录——那一行改掉之后（`create-agent.ts`），
// 没 key 的 Agent 照样造得出来、壳照样挂得上；缺 key 只在请求路径报一条 `auth` 错误。
// 于是这里只剩「把 key 收进来、验一次、写盘」这一段，嵌在主界面里，由 `app.ts` 在
// 「还没配」或「端点拒了这把 key」时摆出来。**配好之后不用重启**：模型早就解析好了，
// key 是每轮重读的（`Models.stream()`）。
//
// ## 为什么「验一次」是必须的
//
// 存一个坏 key 比不存更糟：下一句 prompt 以 `auth` 失败，而用户明明记得自己配过，
// 于是去查环境变量、查文档，就是不会怀疑那把 key 本身。所以**验过才写**。
//
// ## 「模型目录刷新」在内建 provider 上并不存在
//
// 五家内建 provider 都没有 `fetchModels`，因此 `provider.refreshModels` 是 `undefined`、
// `Models.refresh()` 直接跳过它们——目录是纯静态的，拿它验 key 等于什么都没验。
// 所以这里打的是真实的等价物：`GET {baseUrl}/models` 带 Bearer。那是 OpenAI 兼容端点的
// 标准接口，坏 key 回 401/403，而且只读、便宜。`fetchFn` 可注入，测试一行都不碰网。
//
// ## 按键一律走 `matchesKey()` / `isKeyRelease()`，不许手写字节比较
//
// 理由与门都在 `keybindings.ts` 头注和 `test/key-discipline.test.ts`。本文件只管**收字符**
// （交给 pi-tui 的 `Input`）；Ctrl+C 清空 / Ctrl+D 退出这两个应用级键归 `app.ts` 统一分发。
//
// ## key 不回显、也不进任何字符串
//
// 输入期只画掩码；`Input` 的 `render()` **一次都不能调**（它会把明文画出来）。
// 验证失败的原因、写盘失败的报错里也一律没有 key——它只出现在 Authorization 头里。

import { errText, Models, type CredentialStore, type Provider } from "@echo-agent/core";
import { Input, isKeyRelease } from "@earendil-works/pi-tui";
import { dim, red, yellow } from "./theme.ts";

/** 验一把 key 能不能用。`reason` 是给人看的，**不许包含 key**。 */
export type VerifyOutcome = Readonly<{ ok: true }> | Readonly<{ ok: false; reason: string }>;

export type VerifyFn = (
  input: Readonly<{ provider: Provider; apiKey: string; signal?: AbortSignal }>,
) => Promise<VerifyOutcome>;

/**
 * 「这家配好了没」——与请求路径**同一个判据**（`Models.checkAuth()`：环境变量 → 凭据文件 → 没有）。
 * 壳子启动时问一次，决定要不要把配置流程摆出来；管道形态用它决定要不要在启动前就报错退出。
 */
export async function isConfigured(provider: Provider, credentials: CredentialStore): Promise<boolean> {
  const models = new Models(credentials);
  models.setProvider(provider);
  return (await models.checkAuth(provider.id)) !== undefined;
}

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
