// `echo-coding` 的命令行面：**用装配层的启动器部件把本产品跑起来**，自己只交一个 `Product`
// 和一个壳。
//
// 依赖方向（2026-09-09 拆包，记录见 `docs/decisions/implemented/2026-09-09-assembly-layer-packages.md`）：
// `@echo-agent/core` ← `@echo-agent/base` ← {`@echo-agent/tui`, 各产品}。**产品之间平级**——
// 本包不依赖 `echo-agent`，那是它的兄弟不是它的上游。参数解析、凭据、引导设置、形态分叉、
// 装配、收摊全在 base 的 `mainFor()` 里，这里一行都不复制；交互形态起哪个壳由本文件挑
// （`terminalShell`），装配层不写死。
//
// **权限**：2026-09-01 定的是两种形态都全放行——每一步都问只会让人按到麻木，管道形态更是没人可问。
// 2026-11-15 起两层兜底，都不是本产品自己的机制：
//   · **安全分类器**是内核的（`createEcho({ safetyClassifier })`），开不开归使用者（settings.json 的 `safetyClassifier`，
//     不写按形态：交互开、管道关——装配层 `presetForm` 定）。本产品只交**形状**：哪些工具不用判（`CODING_SAFE_TOOLS`：
//     工具包那份加上本产品的 worktree 两件）、bash 的 `sandbox: false` 是什么意思（工具包的 `SHELL_CLASSIFIER_NOTES`）。
//   · **沙箱归使用者**（2026-11-16，settings.json 的 `sandbox`，缺省不包——常见用法是整个 agent 已经在容器里）：写了 `true`
//     才把命令包进操作系统沙箱（只能写工作区、临时目录与缓存，`@echo-agent/tools` 的 `sandbox.ts`）。开着沙箱、分类器关着时，
//     越出沙箱的那一条由人看（`permissionPolicyFor` 的规矩）；分类器开着时由它判，不另装策略。
// `permission.ts` 的 `DEFAULT_PERMISSION`（三件先问的黑名单）**不是这条命令的行为**：它只在嵌入方调 `codingPreset()`
// 而不传 `permission` 时生效（评测、别的宿主）。

import { readFileSync } from "node:fs";
import { conductEntry, mainFor, retainRecentDays, type Product } from "@echo-agent/base";
import { terminalShell } from "@echo-agent/tui";
import { codingPreset } from "./agent.ts";
import { SHELL_CLASSIFIER_NOTES } from "@echo-agent/tools";
import { CODING_SAFE_TOOLS } from "./permission.ts";

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
    // 沙箱归使用者（settings.json 的 `sandbox`，缺省不包）。开着沙箱、分类器关着时越出沙箱的那一条问人（管道形态就是拒）；
    // 分类器开着时交给分类器（见文件头）
    const sandbox = form.sandbox === true;
    const permission = sandbox && !form.safetyClassifier ? ({ fallback: "allow", responder: form.interactive ? "host" : "none" } as const) : false;
    const preset = codingPreset({ permission, sandbox, maxIterations: 200, credentials: host.credentials });
    return {
      ...preset,
      extensions: [conductEntry(form), ...preset.extensions],
      safetyClassifier: { safeTools: CODING_SAFE_TOOLS, ...(sandbox ? { notes: SHELL_CLASSIFIER_NOTES } : {}) },
    };
  },
  // 观测留 30 天（2026-09-15 用户拍板，与 echo-agent 同一条规则；两个产品平级，各自声明各自的）。
  observationExpiry: retainRecentDays(30),
});

/** 进程入口的实质：`echo-agent` 的 `main` 绑上本产品。签名与它完全相同，退出码语义也相同。 */
// 壳由**产品**选（2026-09-09）：装配层只认端口，这里挑终端那份实现。做 web / 桌面界面的产品换掉这一个参数即可。
export const main = mainFor(ECHO_CODING, terminalShell);
