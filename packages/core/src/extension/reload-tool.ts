// `extension_reload`：模型菜单上的热部署工具（2026-09-14 用户拍板：触发从「人和程序」放宽到「人、程序、模型」，
// 决策记录 `docs/decisions/implemented/2026-09-14-model-triggered-reload.md`）。
//
// 工具本身**不重载**：它只登记「本 run 收尾后做」（`Agent.afterRun()`）。工具在 run 里执行，而换代要在两次 run 之间
// （`Agent.betweenRuns()` 拿 permit），run 里拿不到。结果也不走工具返回值——那时 run 还没结束——装配层把报告投进
// 这段会话**自己的 inbox**，下一个 run 自动开始，模型在那里接着验证。所以 description 要把「调完就结束回复」说清楚，
// 否则模型会在同一轮里去调一件还没装上的工具。
//
// 卸载不是另一件工具：热部署的语义是「盘上什么样，装着的就什么样」，删掉或改名文件再调它，报告里就是 removed。
// 单独一件 `extension_unload` 会造出第二份真相（盘上有、运行时没有），下次重载又装回来。
//
// 提示词是自己写的（措辞、结构），不抄任何专有产品的文案。

import { toolError, toolOk, type ModelTool } from "../tools/types.ts";
import type { ReloadResult, ScheduleResult } from "./reload.ts";

export const EXTENSION_RELOAD_NAME = "extension_reload";

export type ExtensionReloadDeps = {
  /** 登记「本 run 收尾后重载」。装配层接的是 `Agent.afterRun()` 加一层「同一 run 只登记一次」。 */
  request: () => ScheduleResult;
};

export function makeExtensionReloadTool(deps: ExtensionReloadDeps): ModelTool<Record<string, never>> {
  return {
    kind: "model",
    name: EXTENSION_RELOAD_NAME,
    label: "重载扩展",
    description:
      "Reload the extensions in this workspace's extensions/ directory. Call it after you have written or changed an " +
      "extension file there (for example a new tool for yourself). The reload does not happen immediately: it is " +
      "scheduled for the end of this run. So after calling it, finish your reply without using the new tool. The " +
      "report — which files were loaded, replaced or refused and why, plus the tools now available — arrives as your " +
      "next input, and you continue from there. To unload an extension, delete or rename its file and call this tool; " +
      "the report lists it as removed. Extensions must declare reload: \"run\" to be swappable; a refused entry tells " +
      "you what to fix.",
    parameters: { type: "object", properties: {} },
    async execute() {
      const r = deps.request();
      if (r.kind === "rejected") return toolError(r.reason);
      return toolOk("Scheduled. Finish this reply now without using the new tool: the reload runs when this run ends, and its report arrives as your next input.");
    },
  };
}

/**
 * 报告正文——模型在下一个 run 的输入里看到的东西。全英文（prompt 资产的规矩），一行一个扩展，没变的只计数；
 * 末尾列出此刻能用的工具名，模型不用再猜新工具叫什么。
 */
export function renderReloadReport(result: ReloadResult, toolsNow: readonly string[]): string {
  if (result.kind === "rejected") {
    return `Extension reload did not run: ${result.reason}. Call extension_reload again when you are ready.`;
  }
  const changed = result.report.changes.filter((c) => c.kind !== "unchanged");
  const unchanged = result.report.changes.length - changed.length;
  const lines = [
    "Extension reload finished.",
    ...changed.map((c) => `- ${c.kind} ${c.file}${"reason" in c ? ` — ${c.reason}` : ""}`),
    ...(changed.length === 0 ? [`- nothing changed (${unchanged} extension(s) unchanged)`] : unchanged > 0 ? [`- ${unchanged} extension(s) unchanged`] : []),
    `Tools now available: ${toolsNow.length === 0 ? "(none)" : toolsNow.join(", ")}.`,
  ];
  return lines.join("\n");
}
