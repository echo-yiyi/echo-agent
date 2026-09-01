// 目录条目怎么描述成一行（选择器的描述列）。首次运行的引导设置（`first-run.ts`）与
// 主界面的模型选择器（`app.ts`，Ctrl+L）共用——**同一个东西在两处长一样**，而且都派生自目录，
// 不手写第二份（加模型、换缺省自动跟上）。单独成文件是为了别让那两头互相 import。

import type { Model, Provider } from "@echo-agent/core";

/** provider 行的描述列：头两个模型 id，多的用 … 收尾。 */
export function describeProvider(p: Provider): string {
  const ids = p.getModels().map((m) => m.id);
  const head = ids.slice(0, 2).join(" / ");
  return ids.length > 2 ? `${head} …` : head;
}

/** 模型行的描述列：id · 上下文窗口 · 推理与否。 */
export function describeModel(m: Model): string {
  const parts = [m.id];
  const ctx = m.capabilities?.contextWindow;
  if (ctx !== undefined) parts.push(`${Math.round(ctx / 1024)}k 上下文`);
  if (m.capabilities?.reasoning === true) parts.push("推理");
  return parts.join(" · ");
}
