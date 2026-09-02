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

import { readFileSync } from "node:fs";
import type { CreateEchoOptions } from "@echo-agent/core";
import { identityEntry } from "./prompt.ts";

/** 装配前已经定了的形态。产品层据此决定「谁答权限询问」之类；工作目录不在这里（见文件头）。 */
export type PresetForm = Readonly<{
  /** `true` = 交互形态（有人坐在终端前）；`false` = 管道 / CI。判据只有 `main()` 那一个。 */
  interactive: boolean;
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

/** 本包的版本。`../package.json` 在源码树和 tarball 里都在这个相对位置（`files: ["src", …]`）。 */
const VERSION: string = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string })
  .version;

/** `echo-agent` 自己：通用 agent。preset 只交一样——它的身份段。 */
/**
 * 缺省延迟的工具（2026-09-02 用户拍板：延迟与否**由配置给**、所有工具一视同仁，这里是那批缺省）。
 * 挑的是「一次会话里多半用不到」的：闹钟三件、造 skill、读 transcript、单查任务；
 * 常驻的是文件 / 搜索 / shell / 任务清单 / 记忆 / 激活 skill，再加 `tool_search` 自己。
 * 名单进 `createEcho({ agent: { deferredTools } })`；产品 preset 的 `agent.deferredTools` 给了就覆盖这份。
 * 将来让用户在 settings.json 里改，也是覆盖这一层，core 不认识任何名单。
 */
export const DEFAULT_DEFERRED_TOOLS: readonly string[] = ["schedule_create", "schedule_list", "schedule_cancel", "skill_create", "transcript_read", "TaskGet"];

export const ECHO_AGENT: Product = Object.freeze({
  name: "echo-agent",
  version: VERSION,
  preset: () => ({ extensions: [identityEntry()] }),
});
