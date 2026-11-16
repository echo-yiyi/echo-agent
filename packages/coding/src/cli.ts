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
// 2026-11-15 起**交互形态缺省由模型先审**（`REVIEWED_PERMISSION`），**命令包进操作系统沙箱**（只能写工作区、临时目录与缓存，
// `tools/sandbox.ts`）：名单之外的工具先让本会话的模型对着用户说过的话审一遍（两段），日常开发放行、用户没要的高风险动作拦下；
// 人只在连着被拦、或审不了的时候被问到。全放行时模型一旦被仓库里、网页里的字骗了，后面没有任何一层拦得住。
// **管道形态缺省不审**：评测与 CI 没人可问，每条命令多一次模型调用也会改掉评测的成本与结果。
// **开不开由使用者定**（settings.json 的 `safetyReview`，`PresetForm.safetyReview`）：写了两种形态都照写的来；
// 关掉审查时沙箱照旧（交互形态），越出沙箱的那一条问人（`permissionPolicyFor` 的规矩）。
// `permission.ts` 的 `DEFAULT_PERMISSION`（三件先问的黑名单）**不是这条命令的行为**：它只在嵌入方调 `codingPreset()`
// 而不传 `permission` 时生效（评测、别的宿主）。

import { readFileSync } from "node:fs";
import { conductEntry, mainFor, retainRecentDays, type Product } from "@echo-agent/base";
import { terminalShell } from "@echo-agent/tui";
import { codingPreset } from "./agent.ts";
import { REVIEWED_PERMISSION } from "./permission.ts";

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
    // 审不审：使用者说了算，没说按形态（交互开、管道关）；审不过问终端里的人，管道形态没人可问就拒。
    // 沙箱跟形态走：交互形态包、管道形态不包（见文件头）
    const responder = form.interactive ? "host" : "none";
    const permission =
      (form.safetyReview ?? form.interactive)
        ? ({ ...REVIEWED_PERMISSION, responder } as const)
        : form.interactive
          ? ({ fallback: "allow", responder } as const) // 不审，但越出沙箱的那一条仍要问人
          : false;
    const preset = codingPreset({ permission, sandbox: form.interactive, maxIterations: 200, credentials: host.credentials });
    return { ...preset, extensions: [conductEntry(form), ...preset.extensions] };
  },
  // 观测留 30 天（2026-09-15 用户拍板，与 echo-agent 同一条规则；两个产品平级，各自声明各自的）。
  observationExpiry: retainRecentDays(30),
});

/** 进程入口的实质：`echo-agent` 的 `main` 绑上本产品。签名与它完全相同，退出码语义也相同。 */
// 壳由**产品**选（2026-09-09）：装配层只认端口，这里挑终端那份实现。做 web / 桌面界面的产品换掉这一个参数即可。
export const main = mainFor(ECHO_CODING, terminalShell);
