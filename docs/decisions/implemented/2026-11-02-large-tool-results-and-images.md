# 大工具结果与图片做成 core 的基础能力（照 Claude Code）

> 状态:implemented · 提出 2026-11-02（用户反馈大工具结果与图片「很差劲」）· 拍板 2026-11-02（用户：「按照 claude code 的方法去做，同时把图片也处理一下」）· 落地 `packages/core/src/tools/output.ts` / `image.ts` / `loop/run-turn.ts` / `compaction/pipeline.ts`、`packages/base/src/image.ts`、`packages/coding/src/tools/{bash,fs}.ts`、`packages/tui/src/app.ts`，判据见文末

**给谁看**：改工具结果入账、压缩、图片入口的人。假设已知 [消息账本](../../design/context-and-message-flow.md) §2 与 [压缩](../../design/compaction.md) §4–§5。

## 现状（拍板前）

- **大工具结果**全靠各工具自截：`read_file` 50 000 字符、`bash` 30 000（保留开头、丢掉后半——报错多在末尾）、`grep` 200 条、`web_fetch` 20 000；core 没有通用上限，扩展与第三方工具返回几 MB 也原样入账、落盘、之后每轮重发。压缩要到「窗口 − 16k」才清旧结果，1M 窗口的模型基本走不到；清掉的只能用 `transcript_read` 读回前 4 000 字符。
- **图片**：消息里有 `ImageBlock`（base64 内联），方言会转成 `image_url`；但产品里没有任何入口产生图片——`read_file` 按文本读，TUI 不能贴图。估算每张固定 1 200 token，不看尺寸。

## Claude Code 的做法（参照，只看机制）

- 结果超过约 30 000 字符**当场外存**：存进会话目录（64 MiB 截断），模型拿到路径加前 2 000 字符预览，要看剩下的再读或搜（官方文档 Tools reference · Output limits）。读文件单次 25 000 token、整文件超 256 KB 要分页；每个工具可声明 `maxResultSizeChars`。
- **空闲清理旧结果**：只清最近 K 条之前的、挑会话空闲（缓存已凉）的时候、省下的不够阈值不清（本机 2.1.314：`tengu_time_based_microcompact`、`keepRecent`、`idleSeconds`）。
- **图片**：PNG / JPEG / GIF / WebP 按图返回；大图缩放、重新压缩到模型的尺寸限制以内；超 128 MB 拒读。

## 选项（拍板时讨论过的）

- **A. 当场外存**（Claude Code）：预览一次定格、缓存稳定；代价是要看中间得再调一次工具。
- **B. 这轮给全文、用完再清**（用户提出的思路）：本轮不用回读；但全文在这一条 reply 的每一轮都重发，清的那一刻还会让之后的缓存断一次，几 MB 的输出连一次都发不下。
- 讨论结论：A 管「当场多大算大」，用户「用完就清」的思路落在**另一套**机制上——清旧结果。

## 决定

**A + 空闲清理 + 图片入口**（2026-11-02 用户拍板）。

1. **入账时外存**（`spillToolResult`，所有工具都过）：正文估计超过 `TOOL_OUTPUT_INLINE_TOKENS = 7 500`（中日韩一字一 token、其余四字符一 token——英文约 3 万字符，与 Claude Code 同一量级；中文不吃亏）就把全文写进会话目录 `tool-outputs/<工具调用 id>.txt`（64 MiB 截断），账本里记**说明在前、开头 2 000、结尾 1 000 字符**的预览（结尾那段是我们加的：日志的报错在末尾）。工具可用 `ToolBase.maxInlineTokens` 声明自己的上限，`Infinity` = 自己管尺寸（`read_file`、`tool_output_read` 本身）。事件与 hook 仍拿全文。写盘失败只留预览并说清。读回工具不在本轮菜单上时照样外存，但说明不点它的名。
2. **`tool_output_read({ id, offset?, limit?, query? })`**：内建 `echo:tool-output`，恒装、常驻菜单（菜单不随它变、缓存不断）。先找外存文件，找不到再去 transcript 按 id 找原文——被压缩清掉的旧结果也从这里取回。分页缺省 10 000、最多 40 000 字符；`query` 只给匹配行（最多 200 行）。
3. **空闲清理**（`reason: "idle"`）：每轮轮首 `auto` 没触发时，**两道门都过**才清——上一条助手回复到此刻超过 60 分钟（provider 缓存多半已过期），且最近 3 批之前还没清的旧工具结果估计至少 1 万 token。只清工具结果（摘要、折叠阶段对 `idle` 返回 null，不调模型）；`tool-results` 阶段没注册（产品关了内建压缩）就不看。**拍板时说的是「攒够量就清」，实现时补了空闲这道门**：缓存热的时候清，被清那条之后的整段历史要按未命中重付一次，往往比省下的多——这正是 Claude Code 挑空闲时清的原因，也符合用户「照 Claude Code」的要求。清理占位带上工具调用 id，不点工具名（占位常驻视图，读回工具可能不在菜单上）；怎么读回由压缩的 prompt 段讲。
4. **图片基础件**（core `image.ts`，零依赖）：`imageFromBytes` 按魔数认四种格式、从文件头读宽高，超过 5 MB 或长边 8 000 像素返回 `too_large` 交调用方缩放；`imageTokens` 按宽 × 高 ÷ 750 估，认不出尺寸退回 1 200。
5. **缩放与入口**（base `loadImageFile`）：长边超过 1 568 或超上限，借系统自带的 `sips` / ImageMagick 缩放、重新压缩（PNG 保持 PNG，其余转 JPEG）；都没有时没超上限原样用、超了拒收并说清。`read_file` 读图片返回图片本身加一行说明，太大报错并教「先缩小一份再读」；TUI 把输入里指向已存在图片文件的路径（终端拖入文件粘贴的就是路径）读出来附上，模型不收图就不附并说清。
6. **`bash` 不再丢后半**：最多收 8 MiB，交给 core 外存。

## Non-Goals

- 不做「这轮给全文、用完再清」那一档（见选项 B）。
- 不做按 K 条持续清理普通大小的旧结果（Claude Code 另有的缓存热时的清理）；空闲清理之外仍由「窗口 − 16k」的常规压缩兜底。
- 图片不另存 blob、不做引用：仍 base64 内联在 transcript 里；旧图不重发属于另一件事。
- PDF、剪贴板直接贴图（非文件路径）、web_fetch 返回图片：未做。
- 空闲阈值、外存阈值不做成产品配置；`transcript_read` 的单条 4 000 字符上限不动。

## 落盘与公共面的变化

- 会话目录多一个 `tool-outputs/`（收摊清空目录时按 core 自有路径处理）。
- `CompactionReason` 多一个 `"idle"`，会话里的压缩记录会出现这个值：新版本写的会话旧版本读不了（发布前，按约定直接改）。
- 公共导出：`TOOL_OUTPUT_INLINE_TOKENS`、`TOOL_OUTPUT_READ`、`imageFromBytes`、`imageTokens`、`sniffImage`、`MAX_IMAGE_BYTES`、`MAX_IMAGE_EDGE` 与三个类型；`ToolBase.maxInlineTokens`、`BuiltinToolGroups.toolOutput` 两个新字段；`clearedNotice` 多一个工具调用 id 参数。

## 验收

- 外存与预览：[外存](../../../packages/core/test/tool-output.test.ts#test=外存全文落盘对话里是说明在前开头与结尾的预览其余字段原样没超就原样返回同一个对象)、[写盘失败](../../../packages/core/test/tool-output.test.ts#test=写盘失败这一轮不崩说明讲清全文没存下来只剩预览)
- 接线：[Agent 端到端](../../../packages/core/test/tool-output.test.ts#test=agent大结果入账的是预览事件里是全文模型请求里是预览模型用-tooloutputread-查得到中间那行)、[自管尺寸的工具不外存](../../../packages/core/test/tool-output.test.ts#test=声明-maxinlinetokens-infinity-的工具从不外存自己会分页的读文件就这样声明)、[会话目录与续会话](../../../packages/core/test/tool-output.test.ts#test=createecho全文落在会话目录的-tool-outputs-下续会话之后照样读得回)
- 读回：[外存文件与 transcript 原文](../../../packages/core/test/tool-output.test.ts#test=读回先找外存文件找不到再去-transcript-按-id-找原文分页按关键词查id-不存在都说清)
- 空闲清理：[清](../../../packages/core/test/tool-output.test.ts#test=空闲清理停了够久最近-3-批之前的旧结果又够多-只清那些旧结果保留最近-3-批原因记-idle占位带工具调用-id)、[缓存热不清](../../../packages/core/test/tool-output.test.ts#test=空闲清理缓存还热没停够不清清了会让之后整段历史按未命中重付)、[不够量不清](../../../packages/core/test/tool-output.test.ts#test=空闲清理停够了但可清的不够量就不清)、[没有清工具结果的阶段不触发](../../../packages/core/test/tool-output.test.ts#test=空闲清理产品关掉内建压缩换了自己的阶段没有清工具结果的那个就不触发也不发失败通知)
- 图片基础件：[认格式读尺寸](../../../packages/core/test/image.test.ts#test=认格式读宽高png-gif-jpeg要跳过前面的段-webp-三种块)、[太大](../../../packages/core/test/image.test.ts#test=太大长边超上限或字节超上限-toolarge带上认出的尺寸调用方缩放后再交回来)、[按尺寸估](../../../packages/core/test/image.test.ts#test=估-token按尺寸宽-高-750认不出尺寸退回固定值估算里用的就是它)
- 缩放与入口：[缩放](../../../packages/base/test/image.test.ts#test=长边超过上限的图有-sips-imagemagick-就缩到上限以内并记下原尺寸macos-上-sips-一定在)、[认路径](../../../packages/base/test/image.test.ts#test=从输入里认图片路径反斜杠转义的空格单双引号相对路径不存在的不是图片的不算去重保序)、[read_file 读图](../../../packages/coding/test/coding-agent.test.ts#test=readfile-读图片2026-11-02照-claude-code-的-read返回图片本身加一行说明扩展名是图片但内容不是就按文本读太大报错并教缩小)、[TUI 附图](../../../packages/tui/test/tui.test.ts#test=输入里有指向已存在图片文件的路径读出来作为图片附上原文照发屏幕上说附上了哪张)、[模型不收图](../../../packages/tui/test/tui.test.ts#test=当前模型不收图片一张都不附屏幕上说清楚文字照发)
