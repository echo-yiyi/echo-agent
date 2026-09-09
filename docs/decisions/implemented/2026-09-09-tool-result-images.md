# 工具带回的图片要发给模型：接上 `image_url`，不删 `images`

> 状态:implemented · 提出 2026-09-07（review 批 6 顺带，#53）· 拍板 2026-09-09（用户，选 A）· 实现 2026-09-09 · 来源 [`ProviderToolResultBlock`](../../../packages/core/src/messages.ts#symbol=ProviderToolResultBlock) 与 `packages/core/src/provider/openai.ts` 的消息转换

## 现状(拍板前)

`AgentToolResult.images` → 账本 `toolResult.images` → 线上块 `ProviderToolResultBlock.images` 一路都有字段，压缩估算也按每张 1 200 token 计入；但唯一的方言（OpenAI 兼容）把 `tool_result` 块转成 `role:"tool"` 消息时只取 `content`，`images` 静默丢弃。一件截图工具返回的图，模型永远看不到，账本却为它付了压缩预算。

## 不拍板的代价

字段存在即承诺：写工具的人按类型给图，模型收不到，没有任何报错。

## 选项

- **A. 接上**：OpenAI 的 `role:"tool"` 只收文本，图放进紧随其后的那条 user 消息（`image_url` 部件），并标一句「这几张来自哪次工具调用」；`capabilities.vision` 的判定与用户贴图同一条路（不收图的模型本地抛，不发出去等 400）。
- **B. 删净**：`AgentToolResult` / `ToolResultEntry` / `ProviderToolResultBlock` 三处去掉 `images`，压缩估算随之改。账本格式变更。

## 决定

**A**（2026-09-09 用户拍板）。理由：coding 工具批次已登记「读图片 / PDF」是下一件事，字段是为它留的；删了再加是两次账本格式变更。

## 验收

`tool_result` 块带 `images` 且模型标了 `vision` 时，请求体消息序列是 `… → tool → user`，user 的 content 是「一条文本标签 + 每张一个 `image_url`」；没标 `vision` 时本地抛、请求不发。判据在 `packages/core/test/openai.test.ts#test=工具带回的图role-tool-后面跟一条-user-消息发-image-url并标明来自哪次调用目录没标-vision-一样本地抛2026-09-09-拍板接上此前静默丢`。
