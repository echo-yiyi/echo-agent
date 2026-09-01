// `echo-coding` 的命令行面：**复用 `echo-agent` 的整条启动逻辑**，自己只交一个 `Product`。
//
// 依赖方向（2026-09-01 拍板）：`@echo-agent/core` ← `echo-agent`（通用展示层，不认识任何产品）
// ← `echo-coding`。本包不改 `echo-agent` 一行代码——它就是「第三方怎么基于我们的 agent
// 做产品」的样板。参数解析、凭据、引导设置、形态分叉、装配、收摊全在 `echo-agent` 的
// `mainFor()` 里，这里一行都不复制。
//
// 本文件只有一个决定要做：**权限策略随形态走**（2026-09-01 用户拍板）。
//   · 交互形态：`DEFAULT_PERMISSION`——读随便，动手（bash / write_file / edit_file）先问，
//     壳（`echo:tui`）摆出来问 y/n → `responder: "host"`；
//   · 管道 / CI：没人在终端前，问不出去——**全放行**（`permission: false`）。
//     不选「ask 折成 deny」：那样管道形态只能读不能改，等于没用；`echo x | echo-coding`
//     就当作一个会改文件的脚本来用，是否交给它由调用方在管道外面决定。

import { readFileSync } from "node:fs";
import { mainFor, type Product } from "echo-agent";
import { codingPreset } from "./agent.ts";
import { DEFAULT_PERMISSION } from "./permission.ts";

/** 本包的版本，欢迎头里显示。`../package.json` 在源码树和 tarball 里都在这个相对位置。 */
const VERSION: string = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string })
  .version;

export const ECHO_CODING: Product = Object.freeze({
  name: "echo-coding",
  version: VERSION,
  preset: ({ interactive, cwd }) =>
    codingPreset({
      workspaceRoot: cwd,
      permission: interactive ? { ...DEFAULT_PERMISSION, responder: "host" } : false,
    }),
});

/** 进程入口的实质：`echo-agent` 的 `main` 绑上本产品。签名与它完全相同，退出码语义也相同。 */
export const main = mainFor(ECHO_CODING);
