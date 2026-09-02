# 缺省阶梯:tool-results → collapse → summary → snip,外加撞窗应急一次

> 状态:implemented · 提出 2026-09-01 · 拍板 2026-09-02 · 来源 [Compaction](../../design/compaction.md) §4–§5

## 现状(拍板前)

只有「一次摘要」一种动作,而且不缩上下文。撞 `context_overflow` 直接以 error 收场。

## 不拍板的代价

一压就是整段摘要,代价高、丢细节;不压就撞窗。两头都没有中间档。

## 选项

- **A. 单层摘要。** 只做整段摘要,先把正确性修好。
- **B. 四层阶梯 + 应急。** 参照 Claude Code:零成本清旧工具结果 → 渐进折叠旧段 → 整段摘要 → 应急省略;撞窗后同一条流水线以 overflow 跑一次再重跑本轮。
- **C. B 但 collapse 后补。**

## 决定

**B**,collapse 一起做(2026-09-02 用户拍板)。缺省数值一并定:`reserveTokens = max(maxOutputTokens, 16k)`、`keepRecentTokens = 8k`(overflow 时 2k)、`sectionTokens = 32k`、`keepRecentToolResults = 3`(overflow 时 1)、auto 压到 `target − 10% window`、overflow 压到半窗、collapse 一次最多 8 段。都是 `CompactionOptions` 上带缺省的配置项,不是裸常量。应急一个 run 只准一次,第二次撞窗按 error 收场;summary 失败时 snip 兜底只在 overflow。

## 验收

compaction 测试里的「auto:超阈值 → 轮首压缩 → 紧接着的请求只含摘要」「撞窗应急:一次 → 重跑成功;第二次 → error」「collapse 只服务 auto、一段一次调用、够了就停」「snip 只在 overflow」四条。
