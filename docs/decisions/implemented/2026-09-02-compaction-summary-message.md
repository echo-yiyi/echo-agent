# 摘要以 user/harness 消息送模,带固定框定;原文经 transcript_read 取回

> 状态:implemented · 提出 2026-09-01 · 拍板 2026-09-02 · 来源 [Compaction](../../design/compaction.md) §3、§5

## 现状(拍板前)

摘要不进送模上下文,所以没有形态可言。上一代内核曾把摘要合成为假的 assistant 轮,与真实模型轮字节上分不开,语义上也是「这是你自己说的」。

## 不拍板的代价

摘要伪装成人或模型原话,审计分不清,模型也会被诱导产出摘要形状的回复;被压掉的细节没有取回口,模型只能凭记忆重构。

## 选项

- **A. user + harness 来源 + 固定英文框定。** 投影时每个 span 一条 `userMessage(summary, "harness")`,不进 transcript;框定说明来历、范围、怎么取回原文。
- **B. 新内建 role。** `compaction` 角色进 transcript,投影时再翻成 user。
- **C. 只做 session entry。** 摘要只落盘、不送模。

## 决定

**A**(2026-09-02 用户拍板)。并定:阶段写全 `summary` 正文(框定 + 正文 + 取回提示);`summary === null` 的段与被清的工具结果用 core 的固定文案,**不提任何工具**——怎么取回原文由拥有 `transcript_read` 的 `echo:compaction` 出 prompt 段说明。`transcript_read` 读内存里的完整 transcript(不走磁盘、不进 workspace jail),支持范围与 query。摘要 prompt 采用「scratchpad 草稿 + summary 正文」九个小节的结构,manual 的指令追加在末尾;**措辞与节名自己写**(2026-09-02 review:专有产品的提示词与它的源码同一类,不抄),prompt 全英文但要求摘要用用户主要使用的语言写。

## 验收

compaction 测试里的「投影:段 → 一条 user/harness」「summary:摘要经框定、含 transcript_read 提示、manual 指令追加」「transcript_read:按下标读原文、query、截断续读」三条。
