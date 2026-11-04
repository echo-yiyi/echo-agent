# 工具带回的图片要发给模型：接上 `image_url`，不删 `images`

> 状态:implemented · 提出 2026-09-07（review 批 6 顺带，#53）· 拍板 2026-09-09（用户，选 A）· 实现 2026-09-09 · **修订 2026-11-03**（用户贴图也不抛，见文末「2026-11-03 修订」）· 来源 [`ProviderToolResultBlock`](../../../packages/core/src/messages.ts#symbol=ProviderToolResultBlock) 与 `packages/core/src/provider/openai.ts` 的消息转换

## 现状(拍板前)

`AgentToolResult.images` → 账本 `toolResult.images` → 线上块 `ProviderToolResultBlock.images` 一路都有字段，压缩估算也按每张 1 200 token 计入；但唯一的方言（OpenAI 兼容）把 `tool_result` 块转成 `role:"tool"` 消息时只取 `content`，`images` 静默丢弃。一件截图工具返回的图，模型永远看不到，账本却为它付了压缩预算。

## 不拍板的代价

字段存在即承诺：写工具的人按类型给图，模型收不到，没有任何报错。

## 选项

- **A. 接上**：OpenAI 的 `role:"tool"` 只收文本，图放进紧随其后的那条 user 消息（`image_url` 部件），并标一句「这几张来自哪次工具调用」；编码与用户贴图同一条路。不收图的模型**不抛**：图省掉、把那句标签改成「omitted: model does not accept image input」——抛会被归成可重试的 provider 错误，而带图的 tool_result 已经入账，之后每次请求都同样炸（review 2026-09-09 复现）；用户贴图那条仍本地抛，因为它还没入账、改一下就能重发。
- **B. 删净**：`AgentToolResult` / `ToolResultEntry` / `ProviderToolResultBlock` 三处去掉 `images`，压缩估算随之改。账本格式变更。

## 决定

**A**（2026-09-09 用户拍板）。理由：coding 工具批次已登记「读图片 / PDF」是下一件事，字段是为它留的；删了再加是两次账本格式变更。

## 验收

`tool_result` 块带 `images` 且模型标了 `vision` 时，请求体消息序列是 `… → tool → user`，user 的 content 是「一条文本标签 + 每张一个 `image_url`」；没标 `vision` 时本地抛、请求不发。判据在 `packages/core/test/openai.test.ts#test=工具带回的图role-tool-后面跟一条-user-消息发-image-url并标明来自哪次调用目录没标-vision-一样本地抛2026-09-09-拍板接上此前静默丢`。

## 2026-11-03 修订：用户贴图也不抛

选项 A 里「用户贴图那条仍本地抛，因为它还没入账、改一下就能重发」前提不成立：用户输入在调模型**之前**就已 `message_end` 入账、落盘。方言抛出的异常又在 fetch 的 `try` 里被归成可重试的 `network`，于是在收图模型上贴过图、换到不收图的模型之后，每个 run 都重试到上限再失败，压缩摘要走同一方言也失败——会话卡死。

修订（2026-11-03 用户「按推荐修」）：用户贴图与工具回图同一做法——目录没标 `vision` 时省略，换一句 `[image omitted: model does not accept image input]`，请求照发；构造请求体挪到 fetch 之前，构造失败归成不可重试的 `internal`、请求不发。上面验收里「没标 `vision` 时本地抛、请求不发」一句随之作废（选项 A 那段本来就写着工具回图不抛）：两种图都省略、请求照发。判据：[用户贴图](../../../packages/core/test/openai.test.ts#test=用户贴图遇上不收图的模型图省掉换一句英文标签请求照发不再本地抛输入已经入账抛了就每次都炸)、[换模型不卡死](../../../packages/core/test/openai.test.ts#test=收图模型上贴过图换成不收图的模型之后的-prompt-照常完成每次都真发了请求此前每个-run-重试到上限后失败会话卡死)、[构造失败不重试](../../../packages/core/test/openai.test.ts#test=请求体构造失败不发请求以不可重试的-internal-错误收场此前在-fetch-的-try-里求值被归成-network-可重试)。
