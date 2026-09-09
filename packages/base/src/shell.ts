// 壳端口（2026-09-09 拍板：装配层独立成包）。
//
// **装配层不认识任何具体界面。** 在它之前，`mainFor()` 判断出交互形态之后直接调 `tuiShell()` / `runFirstRunSetup()`
// ——终端壳被焊死在启动逻辑里。后果不只是「换不了壳」：`@earendil-works/pi-tui` 是本包的依赖，
// 于是做 web 界面的第三方也被迫装一个终端库。
//
// 机制上壳早就可替换（壳是一条 inject `AgentRuntime` 的 extension），差的只是**调用方向**。
// 本文件把方向倒过来：装配层只认下面这个端口，谁实现它、用什么画界面都行；
// 终端那份实现是 `terminalShell`（`extension.ts` 的 `tuiShell` + `first-run.ts` 的引导设置）。
//
// 记录：`docs/decisions/proposed/2026-09-09-assembly-layer-packages.md`。

import type { CredentialStore, Provider } from "@echo-agent/core";
import type { ExtensionDefinition } from "@echo-agent/core/extension";
import type { Product } from "./product.ts";
import type { VerifyFn } from "./setup.ts";

/** 引导设置里可选的一家：`--provider` 认的短名 + 那家的实例。装配层备好，壳只负责摆出来让人选。 */
export type FirstRunChoice = Readonly<{ name: string; provider: Provider }>;

/** 引导设置的结果。**它是端口的一部分**：装配层据此决定用哪家、哪个模型去装配。 */
export type FirstRunOutcome =
  /** 配好了：用这家、这个模型去装配。key 已验证并写盘。 */
  | Readonly<{ kind: "configured"; provider: Provider; providerName: string; modelId: string }>
  /** 用户退出，或进程被中止。 */
  | Readonly<{ kind: "cancelled" }>;

/** 界面退出时要说的两件事：退出码，和「要换到哪一段会话」（`/resume`；不换就不给）。 */
export type ShellExit = Readonly<{ code: number; resume?: string }>;

/** 一个跑起来的界面。装配层拿到的全部就是这三样。 */
export type ShellHandle = Readonly<{
  /** 交给 `createEcho({ extensions })` 去 mount——壳也是一条 extension。 */
  definition: ExtensionDefinition<void>;
  /** 跑到用户退出、要换段或被中止。 */
  exited: Promise<ShellExit>;
  /** 往运行中的界面塞一条旁白（装配诊断这类**壳外产生**的消息）。界面还没起来时先攒着。 */
  notify(text: string): void;
}>;

/** 缺 key 时界面里那一段配置要的东西：可选的家、凭据、验证方式。 */
export type ShellConfigure = Readonly<{
  providers: readonly FirstRunChoice[];
  credentials: CredentialStore;
  onModelChange?: (model: { provider: string; id: string }) => void;
  verify?: VerifyFn;
}>;

export type ShellOpenOptions = Readonly<{
  product?: Pick<Product, "name" | "version">;
  signal?: AbortSignal;
  configure?: ShellConfigure;
  /**
   * 壳自己认识的注入物（测试给假界面）。**端口这一层不认识它的类型**——认识了就等于把某一种
   * 界面技术写进装配层，那正是本文件要拆掉的东西。实现方自己收窄。
   */
  ui?: unknown;
}>;

export type ShellFirstRunOptions = Readonly<{
  product?: Pick<Product, "name" | "version">;
  choices: readonly FirstRunChoice[];
  credentials: CredentialStore;
  preselect?: string;
  verify?: VerifyFn;
  signal?: AbortSignal;
  ui?: unknown;
}>;

/**
 * 交互形态的壳。装配层只认这两件事：
 *   · `open()` —— 界面本体；
 *   · `firstRun()` —— 缺凭据时的引导设置。它在**装配之前**跑：选哪家、哪个模型本来就得在装配前定。
 *
 * 不做成一件事，是因为两者的时机不同：引导设置发生在还没有 agent 的时候，界面发生在装配之后。
 * 合成一个「界面」接口会让实现方必须先造出一个没有 agent 可显示的界面。
 */
export type Shell = Readonly<{
  open(opts: ShellOpenOptions): ShellHandle;
  firstRun(opts: ShellFirstRunOptions): Promise<FirstRunOutcome>;
}>;
