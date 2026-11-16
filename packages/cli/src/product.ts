// `echo-agent` 这个产品自己：身份段、名字与版本，加上它的入口。
//
// 2026-09-09 拆包：`Product` / `PresetForm` 这两个**契约**归装配层（`@echo-agent/base`），
// 本文件只剩「echo-agent 是哪一个产品」这件事实。壳由产品挑——终端那份是 `@echo-agent/tui`。
//
// **对外的工具**（2026-11-15）：通用 agent 也挂工具包的三条（`@echo-agent/tools`：文件与搜索、shell、web）。
// 它们不属于哪个产品，这里只做三个产品自己的决定，与 `echo-coding` 各自声明各自的：
//   · 沙箱归使用者（2026-11-16）：settings.json 写了 `sandbox: true` 才把 bash 包进操作系统沙箱，缺省不包——
//     常见用法是整个 agent 已经放在容器里；
//   · 交给内核安全分类器的形状取工具包那一份（哪些工具不用判；开着沙箱时再带上 bash 的 `sandbox: false` 是什么意思）；开不开归使用者；
//   · 开着沙箱、分类器关着时，越出沙箱的那一条问人（管道形态没人可问就是拒）；分类器开着时由它判，不另装策略。
// **管道形态全放行**：没人可问，分类器缺省也关着——那时它就是一个会读写当前目录、会跑命令的脚本。

import { readFileSync } from "node:fs";
import { conductEntry, mainFor, retainRecentDays, type Main, type Product } from "@echo-agent/base";
import { permissionPolicyFromRules } from "@echo-agent/core";
import { SHELL_CLASSIFIER_NOTES, TOOLS_SAFE_TOOLS, askOutsideSandbox, toolsEntries } from "@echo-agent/tools";
import { terminalShell } from "@echo-agent/tui";
import { identityEntry } from "./prompt.ts";

/** 本包的版本。`../package.json` 在源码树和 tarball 里都在这个相对位置（`files: ["src", …]`）。 */
const VERSION: string = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string })
  .version;

/** `echo-agent` 自己：通用 agent。身份段与纪律段都由它自己挂（2026-09-09：纪律归产品），工具取工具包的三条。 */
export const ECHO_AGENT: Product = Object.freeze({
  name: "echo-agent",
  version: VERSION,
  preset: (form, host) => ({
    extensions: [identityEntry(), conductEntry(form), ...toolsEntries({ sandbox: form.sandbox === true, credentials: host.credentials })],
    // 开着沙箱、分类器关着：全放行，但越出沙箱的那一条问人。其余情形不装策略（分类器开着时装配层会补一份让「问人」有人接）
    ...(form.sandbox === true && !form.safetyClassifier
      ? { agent: { permission: askOutsideSandbox(permissionPolicyFromRules({ fallback: "allow", responder: form.interactive ? "host" : "none" })) } }
      : {}),
    safetyClassifier: { safeTools: TOOLS_SAFE_TOOLS, ...(form.sandbox === true ? { notes: SHELL_CLASSIFIER_NOTES } : {}) },
  }),
  // 观测留 30 天（2026-09-15 用户拍板）：更早且已封口的 run 在启动时被清掉。
  // 不给这条规则的话观测只增不减，`listRuns` 越来越慢（observability.md §8）。
  observationExpiry: retainRecentDays(30),
});

/** 进程入口的实质：装配层的 `main` 绑上本产品与终端壳。 */
export const main: Main = mainFor(ECHO_AGENT, terminalShell);
