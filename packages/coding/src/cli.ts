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
import { conductEntry, mainFor, type Product } from "@echo-agent/base";
import { terminalShell } from "@echo-agent/tui";
import { codingPreset } from "./agent.ts";

/** 本包的版本，欢迎头里显示。`../package.json` 在源码树和 tarball 里都在这个相对位置。 */
const VERSION: string = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string })
  .version;

export const ECHO_CODING: Product = Object.freeze({
  name: "echo-coding",
  version: VERSION,
  // 形态（`interactive`）本产品不看：两种形态的装配片段完全相同。workspace 不经 preset——
  // 它是 session 级事实，`mainFor()` 直接交给 `createEcho()`（2026-09-01）。
  //
  // **执行预算 200**（2026-09-02 用户拍板）：core 缺省 20 是通用 agent / 评测的预算，coding 在仓库里
  // grep / read 几下就撞顶（实测 `[错误] 迭代上限 20`），每 20 步要人说一次「继续」。
  // 评测的 identity 仍按 `codingPreset()` 缺省（20）算——产品与评测的预算不同，是否让 identity 跟产品走另议。
  // 凭据 store 从形态里来（`web_search` 读 `brave`）：与启动逻辑同一个文件，不另开
  // 共用的纪律段由**产品**挂（2026-09-09 拍板）：装配层不再恒挂，形态决定「有没有人能答」那一条。
  // `codingPreset()` 自己只依赖 core，所以这一条加在这里，不加进它。
  preset: (form, host) => {
    const preset = codingPreset({ permission: false, maxIterations: 200, credentials: host.credentials });
    return { ...preset, extensions: [conductEntry(form), ...preset.extensions] };
  },
});

/** 进程入口的实质：`echo-agent` 的 `main` 绑上本产品。签名与它完全相同，退出码语义也相同。 */
// 壳由**产品**选（2026-09-09）：装配层只认端口，这里挑终端那份实现。做 web / 桌面界面的产品换掉这一个参数即可。
export const main = mainFor(ECHO_CODING, terminalShell);
