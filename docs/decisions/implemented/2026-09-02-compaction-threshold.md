# 触发阈值以 provider 报的 usage 为基准,字符估只算尾巴与兜底

> 状态:implemented · 提出 2026-09-01 · 拍板 2026-09-02 · 来源 [Compaction](../../design/compaction.md) §4

## 现状(拍板前)

`estimateTokens()` 用 JSON 字符除四,不含 system、注入与工具 schema;阈值取整个 `contextWindow`,没给输出留余量。usage 每轮都进账,却从不回喂压缩。

## 不拍板的代价

字符估对 CJK 偏低、对 JSON 偏高,累积几十条后与真实值相差可观;按整窗触发等于永远在撞窗之后才动。

## 选项

- **A. usage 基准 + 尾巴字符估。** 最近一次 `usage.inputTokens + outputTokens` 当基准(它含 system、注入、工具 schema),之后新入账的按字符估;压缩后基准作废、回到「system + 视图」字符估直到下一轮 usage 回来;没 usage 的路径只有字符估。
- **B. 纯字符估。** 维持现状。
- **C. 接各家 tokenizer。**

## 决定

**A**(2026-09-02 用户拍板)。`target = window − reserveTokens`,auto 的 `goal` 再减 10% 窗口以免下一轮又碰线;目录没标窗口就不自动压。`AgentState.contextTokens` 每轮以 usage 刷新、压缩后以估算刷新,状态栏据它显示占用百分比。

## 验收

compaction 测试里的「measureContext:有基准 = 基准 + 之后的字符估」「contextTokens:每轮以 usage 刷新」两条;`contextWindow` 缺席时 auto 不触发由 `runCompaction()` 的第一道判断守。
