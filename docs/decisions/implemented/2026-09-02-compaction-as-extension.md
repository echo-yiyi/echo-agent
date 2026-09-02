# 压缩策略是 extension，core 只留状态、投影、流水线与账本

> 状态:implemented · 提出 2026-09-01 · 拍板 2026-09-02 · 来源 [Compaction](../../design/compaction.md) §6

## 现状（拍板前）

`maybeCompact()` 只认一个可选的 `compaction.summarize` 回调,没有任何产品接它;就算接了,摘要也只落 session、不缩短送模上下文。策略与机制混在循环里,换一套压缩办法只能改 core。

## 不拍板的代价

压缩是最需要按产品、按模型调的一块(窗口从 128k 到 1M,工具结果的形状各家不同)。策略长在 core 里,每个产品的调整都是一次 core 改动;第三方没有任何口子。

## 选项

- **A. registry 多阶段。** core 定 `CompactionStage` 契约与 `AgentCompaction` registry;core 跑流水线、守配对、发事件、写账本;阶段只产状态。内建阶梯经同一个 registry 注册,产品加段或整套替换都走同一条路。
- **B. single service 整套策略。** 一个 `kind: "single"` 的 Service 交出「怎么压」;内建与产品二选一,不能叠加。
- **C. 留在 core 的回调。** 维持 `summarize` 一类的函数参数。

## 决定

**A**(2026-09-02 用户拍板)。附带两条:内建的 `echo:compaction` 与第三方走**同一个** `stage()`、同一份所有权账本;装卸在轮边界生效(流水线每次跑之前重取阶段表),热插拔与工具、prompt 段同一档(`boundary: "turn"`)。

## 验收

`packages/core/test/compaction.test.ts` 的「阶段是 extension」一条:mount 一代用它的策略,unmount 后没有阶段就不压,再 mount 另一代用新的,都在下一轮生效。`compaction.builtin = false` 的 agent 清单里没有 `echo:compaction`。
