# 大窗口的压缩目标给绝对上限；校准比先扣掉固定开销

> 状态:implemented · 提出 2026-11-03（上下文线复查：kimi-k3 的 1,048,576 窗口压完仍长期带约 90 万 token；会话早期校准比 3–4、真实占用约 30% 就压缩）· 拍板 2026-11-03（用户：「全部按推荐修」）· 落地 `packages/core/src/compaction/pipeline.ts` / `types.ts` / `agent.ts`，判据 `packages/core/test/compaction.test.ts` · 修改 [阈值以 usage 为准](2026-09-02-compaction-threshold.md) 的两处：auto 的 `goal`（第 1 条）与校准比的算法（第 2 条）

**给谁看**：调压缩触发与目标、或排查「为什么这么早 / 这么晚压缩」的人。假设已知 [Compaction](../../design/compaction.md) §4 的预算。

**一句话**：auto / manual 的压缩目标封顶 20 万 token；校准比 = (usage − 工具 schema 与每轮注入) / (system + 消息的字符估)，固定开销单独加、不乘比值。

## 现状（拍板前）

- **目标随窗口线性长**：`goal = target − 10% window`。百万窗口的模型触发线约 103 万，压到约 93 万就停——之后每轮都按 90 多万 token 付钱、等首字延迟，只是没撞窗。
- **校准比把固定开销当乘数**：`calibration = usage / (system + 消息的字符估)`，而 usage 里还有工具 schema 与每轮注入。coding 产品首轮工具定义约 3.8k token、system 约 1.35k，比值约 3.9；之后三个 12.6k 的文件读取按字符估乘 3.9，轮首估算约 15 万，128k 窗口的触发线 11.2 万被越过——真实占用约 4.5 万。

## 选项

目标：

- A. 维持比例。大窗口的成本问题不解决。
- B. 再取 `min(…, 200_000)`。触发线不变（仍是 `window − reserve`），只是压的时候压到 20 万以内。参照 codex 给 auto-compact 设的绝对 token 上限。
- C. 按比例改小（例如 50%）。百万窗口仍是 50 万，小窗口又压得过狠。

校准：

- A. 维持。
- B. 固定开销单独估：工具 schema（JSON 字符估）+ 每轮注入，先从 usage 里扣掉再算比值，之后估算时再加回去、不乘比值。
- C. 校准只用相邻两轮 usage 的差。没有差可算的首轮仍然要兜底，而且两轮之间菜单可能变。

## 决定

两处都选 **B**。

1. `COMPACTION_GOAL_MAX_TOKENS = 200_000`：auto / manual 的 `goal = min(target − 10% window, 200_000)`；overflow 的半窗不变；触发线不变。
2. `fixedOverhead(tools, injections)`：本轮菜单的 `toolSchemas` JSON 字符估 + 每轮注入的字符估；`calibrationFrom(tokens, content, overhead) = (tokens − overhead) / content`。压缩流水线（轮首量一次固定开销，轮末算比值）与 Agent 记下的「上一次校准比」用同一个算法；估算 = `system 与消息的字符估 × 比值 + 固定开销`。

## Non-Goals

- 不接 tokenizer，固定开销仍是字符估。
- 不改触发线、`reserveTokens`、overflow 的目标。
- 不把上限做成产品配置。

## 验收

- [目标封顶](../../../packages/core/test/compaction.test.ts#test=预算auto-manual-的压缩目标是-target-再减一成窗口大窗口封顶-compactiongoalmaxtokens触发线不变overflow-仍是半窗)
- [固定开销不当乘数](../../../packages/core/test/compaction.test.ts#test=校准比不把固定开销当乘数usage-里的工具-schema-每轮注入单独算会话早期读几个大文件不会在真实占用约-13-窗口时就触发压缩)：三个大文件读取后不压缩，Agent 记下的比值约 1
- [ASCII 与中文阶段一致](../../../packages/core/test/compaction.test.ts#test=校准比ascii-与中文同一段对话同一份-usage压缩跑过的阶段一致中文不会在第一段就停)：usage 带上固定开销后，中文会话的比值照旧生效

变异：去掉上限、流水线或 Agent 任一处不扣固定开销，对应判据变红。
