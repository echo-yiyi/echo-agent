# 模型面全英文：system 段、注入、工具 description 与返回文本都用英文写

> 状态:implemented · 提出 2026-09-01 · 拍板 2026-09-01（prompt 设计会话，口头）· 合入 2026-09-01（prompt 重做那批）· 本条记录补写 2026-09-16：此前只散见于 [压缩摘要消息](2026-09-02-compaction-summary-message.md) 与 [记忆提取](2026-09-07-memory-extraction.md)，没有独立记录

**给谁看**：写或改任何模型会读到的文字的人——prompt 段、attempt 注入、工具的 description / 参数说明 / 返回文本、系统投进会话的 `environment` 消息。假设已知 [Prompt](../../design/prompt.md) 的三种载体。

**解决什么**：prompt 重做前，core 内建的记忆规则、skill 目录标题、任务清单注入、工具返回文本都是中文，而产品身份段是英文，一份 system 里两种语言。定下一条：**凡是给模型看的都写英文**；人面文字另议。

## 现状（拍板前）

`# 记忆 · …`、`# 任务清单`、`退出码 N`、`路径越界` 这类文本直接进模型上下文；tool description 也是中文。评测与自进化要把 prompt 当纯数据比较，两种语言混排让文本预算与对照都不干净。

## 不拍板的代价

每个模块各写各的语言，system 与工具面的口径随作者漂；同一个行为在不同 provider 上的遵循度也没法只归因于措辞。

## 选项

- **A. 模型面全英文，人面保持中文。** 模型读到的文字统一英文；CLI usage、TUI 文案、工具的 `label`、诊断、run 错误这些人看的文字不动。
- **B. 全仓一种语言。** 连人面一起换，UI 语言一起定。
- **C. 按模块各自决定。** 维持现状。

## 决定

**A**（2026-09-01 用户拍板）。口径：

- **DO**：system 段（含 core 内建段）、attempt 注入（skill 正文包装、任务清单）、工具的 `description` 与参数说明、工具返回文本（含拒绝与失败原因）、系统投进会话的 `environment` 消息（后台任务结束、定时触发、子 agent 回执、扩展重载报告）、压缩与记忆提取的固定 prompt，全部英文；措辞自行撰写，不抄专有产品的文案。
- **DON'T**：人面文字不改——`usage()`、`[设置]` / `[扩展]` / `[工具]` 这类通知、TUI 文案、工具的 `label`（模型看不到）、诊断 `message`、`PromptVariableError` 这类 run 错误。UI 语言是另一个决定，未拍。
- **边界**：`toolError(errText(e))` 会把能力层抛出的 `Error.message` 原样交给模型，所以创建闸这类校验抛错也算模型面，同样英文。

## 验收

没有机器门，只有纪律：模型面文件的**字符串字面量**里不含 CJK（注释里的中文不算）。核对命令：

```bash
grep -rn "[一-鿿]" packages/core/src packages/coding/src/tools packages/base/src/prompt.ts packages/base/src/instructions.ts \
  | grep -v "^\S*:\s*//" | grep -v "^\S*:\s*\*" | grep -v "label:"
```

剩下的命中应只有注释、`label:` 与人面文字。2026-09-16 复核时发现 `extension_reload` 拒因、`skill_create` 无租约提示、cron 与定时任务创建校验、任务清单落盘失败的回执仍是中文，已随本条记录一起改成英文。`addSkills()` 撞名、registry 撞名、`start()` 抢锁失败这类只对宿主抛的错误不在模型面，保持中文。**未定**：扩展重载报告里每条变更的 `reason`（`/reload` 面板与模型的 `echo:reload` 报告共用同一串）仍是中文，两边用哪种语言待拍板。
