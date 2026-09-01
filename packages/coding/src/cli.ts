// `echo-coding` 的命令行面：**复用 `echo-agent` 的整条启动逻辑**，自己只交一个 `Product`。
//
// 依赖方向（2026-09-01 拍板）：`@echo-agent/core` ← `echo-agent`（通用展示层，不认识任何产品）
// ← `echo-coding`。本包不改 `echo-agent` 一行代码——它就是「第三方怎么基于我们的 agent
// 做产品」的样板。参数解析、凭据、引导设置、形态分叉、装配、收摊全在 `echo-agent` 的
// `mainFor()` 里，这里一行都不复制。
//
// **权限：缺省全放行**（2026-09-01 用户拍板，两种形态都是）。`permission: false` = 不装策略，
// bash / write_file / edit_file 不问直接跑。理由：这是用户自己在自己的仓库里开的 coding agent，
// 每一步都问只会让人按到麻木；管道形态更是没人可问。要「动手先问」的策略仍在
// `permission.ts`（`DEFAULT_PERMISSION` + `responder: "host"`，壳会摆出来问 y/n），
// 评测或别的宿主可以自己传——本产品不缺省开它。

import { readFileSync } from "node:fs";
import { mainFor, type Product } from "echo-agent";
import { codingPreset } from "./agent.ts";

/** 本包的版本，欢迎头里显示。`../package.json` 在源码树和 tarball 里都在这个相对位置。 */
const VERSION: string = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string })
  .version;

export const ECHO_CODING: Product = Object.freeze({
  name: "echo-coding",
  version: VERSION,
  // 形态（`interactive`）本产品不看：两种形态的装配片段完全相同。workspace 不经 preset——
  // 它是 session 级事实，`mainFor()` 直接交给 `createEcho()`（2026-09-01）。
  preset: () => codingPreset({ permission: false }),
});

/** 进程入口的实质：`echo-agent` 的 `main` 绑上本产品。签名与它完全相同，退出码语义也相同。 */
export const main = mainFor(ECHO_CODING);
