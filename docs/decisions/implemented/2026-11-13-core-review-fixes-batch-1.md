# core review 第一批修复：会让会话打不开、卡死或丢数据的几条

> 状态:implemented · 提出 2026-11-13（对 main `7bb52c3` 的 `packages/core/src` 全量 review，加 2026-11-12 对 v0.7.0 三个提交的 review）· 拍板 2026-11-13（用户：「都按你的推荐来做」——先修不需要拍板的那几条）· 落地见各条 · 判据见验收 · 修改 [记忆提取没跑完](2026-11-12-memory-extraction-unfinished.md) 第 3 条的「被中止」

**给谁看**：改 OpenAI 方言的回放、工具执行、会话与 inbox 的恢复、记忆索引、定时任务加载、记忆提取收尾的人。各条彼此独立，按需读。

**一句话**：五处缺陷各修一处，外加两处不涉及行为的收尾。五处的共同点是「一个本该无害的输入让会话打不开、卡死或丢数据」。

## 逐条

### 1. 只有思考的 assistant 消息不再回放成 `content: null`

- **现状**：OpenAI 方言回放 assistant 消息时，「什么都不剩就整条不发」的守卫把「还有可回放的思考」排除在外。模型某一轮只出了 reasoning（正文为空，或截在思考里），这条消息之后每次请求都以 `{ content: null, reasoning_content }` 发出去，上游会拒；它留在 transcript 里，被压缩掉之前每次请求都失败。
- **决定**：没有正文也没有工具调用就整条不发，不看有没有思考。

### 2. 工具交回来的结果入账前验形

- **现状**：循环兜住了 `execute` 抛错，没兜住它返回的不是一份结果。忘了 return 的工具交回 `undefined`，后面读 `result.content` 抛错，run 以 internal 收场、tool_use 落单。`postToolUse` hook 把结果 patch 成 `null` 同样；patch 成 `{ content: 123 }` 则原样进 transcript，之后每次请求都带着这条坏消息。
- **决定**：
  - 工具的返回值不是一份结果（`content` 不是字符串、`isError` 不是布尔、`images` 给了却不是数组）时，与抛错同一条路：记成出错的工具结果、发 `toolUseFailed{crashed}`，这一轮照常往下走。
  - `postToolUse` 改写出来的结果同样验；写坏的当这条 hook 没说话，入账的是工具自己的那份（`postToolUse` 是 fail-open）。

### 3. 点开头的文件不当成记录读

- **现状**：`entries/` 与 `inbox/acks/` 下每个文件都当 entry / ack marker 解析，记忆模块目录下每个文件都进索引。用 Finder 打开过这些目录留下的 `.DS_Store`，让会话打不开、inbox 封账，或把二进制首行读进索引、随记忆段送给模型。
- **决定**：三处都跳过点开头的文件；记忆索引与整理的文件数门跳过任何带点开头的段的路径，与 `memoryView` 同一条规矩。**只放过这一种**：别的认不出的文件名照旧判红或封账，坏档不能靠跳过变成静默少一条。

### 4. 定时任务表读到了才算已加载

- **现状**：`ensureLoaded` 读盘之前就置 `loaded = true`。第一次读失败后，表被当成已加载的空表，下一次写把盘上原有的定时任务整份盖掉。
- **决定**：读成功之后才置 `loaded`；读失败照抛，下次重读。

### 5. 被 hook 拦下的记忆提取照没跑完算

- **现状**：`contextBeforeBuild` hook 拦下送模时，子循环以 aborted 收场，提取把所有 aborted 都当成收摊：不报、不计数、不推游标。那段已攒够轮数，之后每条 reply 都重装一次 prompt 再被拦一次，没有诊断，也永远到不了放弃。
- **决定**：signal 真的中止了才是收摊（`not_run`）。signal 没动却以 aborted 收场的，报 `memory_extract_failed`，写成过算看过、一条没写成算 `unfinished`，照常计入连续次数。

### 6. 两处不涉及行为的收尾

- `.gitignore` 加 `.DS_Store`。
- [降频](2026-10-30-memory-extraction-gate.md) 的头部补上 2026-11-12 那条「后续」。

## Non-Goals

- 不在工具执行前统一按 schema 验**参数**（模型给 null 的那一组问题）：那是改公共行为，另议。
- 不给 `FileDir.list` 加通用的点文件过滤：它是字节面，分不清哪些点开头的路径是调用方自己的内部状态（比如记忆的 `.dream/`）。
- 不改「provider 故障也计入提取的放弃次数」：另议。
- 不动观测线程的上下文镜像（只增不减）：要先定清理策略，另议。

## 验收

每条在改动之前的代码上都是红的：

- 1：`packages/core/test/openai.test.ts`「只有同源思考、没有正文也没有工具调用的 assistant 消息整条不发」。
- 2：`packages/core/test/seams.test.ts`「工具交回来的不是一份结果」「postToolUse 把结果改成了错的形状」。
- 3：`packages/core/test/session-service.test.ts`「entries/ 下点开头的文件」、`packages/core/test/inbox-durable.test.ts`「inbox/acks/ 下点开头的文件」、`packages/core/test/memory.test.ts`「点开头的文件（Finder 的 .DS_Store）不进索引」。
- 4：`packages/core/test/schedule.test.ts`「登记表第一次读盘失败」。
- 5：`packages/core/test/memory-extract.test.ts`「提取被 contextBeforeBuild hook 拦下（signal 没动）」。
