// 「产品」：一个具体产品交给 `echo-agent` 启动逻辑的全部东西（2026-09-01）。
//
// `echo-agent` 是通用 agent 产品，也是展示层——它**不认识任何具体产品**。`echo-coding` 这类
// 完整产品依赖它、复用它整条启动逻辑（参数解析、凭据、引导设置、形态分叉、装配、收摊），
// 只把自己那份不同交进来：名字、版本、装配片段。不复制 `main()`——两份 `main()` 会分家，
// 实证见 `cli.ts` 文件头。
//
// **能交进来的只有这三样**。特别地，`preset` 的返回值限定为 `createEcho()` 的 `agent` 与
// `extensions` 两个字段：扩展**发现**（`extensionDirs`）归 `--extensions` 那个 flag、归用户，
// 产品层碰不到——产品自带的 Extension 走显式传入，不走扫盘，也不能被 flag 关掉。
//
// system prompt 也从这里进（2026-09-01）：产品的 identity / 纪律段以 `definePromptPack` 的 Extension
// 形态列在 `extensions` 里——没有 `systemPrompt` 字符串这条路了。workspace 不再经 preset：
// 它是 session 级事实，`mainFor()` 直接交给 `createEcho({ workspace })`。

import type { CreateEchoOptions, CredentialStore } from "@echo-agent/core";

/** 装配前已经定了的形态。产品层据此决定「谁答权限询问」之类；工作目录不在这里（见文件头）。 */
export type PresetForm = Readonly<{
  /** `true` = 交互形态（有人坐在终端前）；`false` = 管道 / CI。判据只有 `main()` 那一个。 */
  interactive: boolean;
  /**
   * 凭据来源——**与启动逻辑同一个 store**（缺省 `$ECHO_HOME/credentials.json`，测试可注入）。
   * 产品自带的、要 key 的工具（如 `echo-coding` 的 `web_search` 读 `brave`）从这里拿，不各开各的文件：
   * 解析顺序与模型 key 一样是「环境变量 → 这个 store → 没有」（2026-09-04）。
   */
  credentials: CredentialStore;
}>;

export type Product = Readonly<{
  /** 可执行文件名：进 `--help` 的「用法：」行与欢迎头。 */
  name: string;
  /** 欢迎头里显示的版本，各产品从自己的 `package.json` 取。 */
  version: string;
  /**
   * 产品层的装配片段：权限策略、自带的 Extension（含产品自己的 prompt 段）。形态定了之后调一次，
   * 返回值原样展开进 `createEcho()`。不给 = 通用 agent，只有 core 的 `echo:*` builtin
   * 加 `echo-agent` 恒挂的纪律 / 项目指令段。
   *
   * 与 `--extensions` 的关系：**正交**。那个 flag 决定去哪些目录**发现**扩展；这里的
   * `extensions` 是显式传入的。两者在 `createEcho()` 里同一代 mount，顺序是发现的在前、
   * 显式的在后（`create-echo.ts`）；工具撞名整组失败，不静默覆盖。
   */
  preset?: (form: PresetForm) => Pick<CreateEchoOptions, "agent" | "extensions">;
}>;
