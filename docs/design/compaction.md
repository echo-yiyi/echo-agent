# 上下文压缩（Compaction）

> 状态：已实现（2026-09-02）<br>
> 读者：要调压缩参数、换一套压缩策略、写自己的压缩 extension，或排查「模型为什么看不到那一段」的人<br>
> 假设已读：[Context 与 Message Flow](context-and-message-flow.md) 的术语表——transcript、working context、provider context、projection 在本文按那里的含义用<br>
> 决策记录（六条，本文只指向，不复述论证）：[策略是 extension](../decisions/implemented/2026-09-02-compaction-as-extension.md) · [状态是视图](../decisions/implemented/2026-09-02-compaction-state-is-a-view.md) · [四段阶梯与应急](../decisions/implemented/2026-09-02-compaction-ladder.md) · [摘要的送模形态](../decisions/implemented/2026-09-02-compaction-summary-message.md) · [阈值以 usage 为准](../decisions/implemented/2026-09-02-compaction-threshold.md) · [手动压缩与状态面](../decisions/implemented/2026-09-02-compaction-manual-and-state.md)

## 导读

**解决什么。** 长会话会超出模型窗口。2026-09-02 之前的 `maybeCompact()` 只把摘要写进 session、不缩短送模上下文，而且两个产品都没接它——长会话最后一律撞 `context_overflow`、run 以 error 收场。

**最终形态。** transcript 与 session 账本永远全量原文；压缩是一个作用在 transcript 上的**视图状态**（哪些段被摘要 / 省略、旧工具结果清到哪），送模前才投影。策略（怎么选段、怎么摘要）是 **extension**：core 只拥有状态、校验、投影、流水线、事件与落盘；`echo:compaction` builtin 注册缺省的四段阶梯（tool-results → collapse → summary → snip）和 `transcript_read` 工具，产品或第三方经同一个 `AgentCompaction` registry 换策略，装卸在轮边界生效。触发以 provider 报的 usage 为基准；撞窗后同一条流水线应急一次；`/compact` 走同一条流水线。

**Non-Goals（已决，不做）。**

- tokenizer 级精确计数：估算永远是「usage 基准 + 尾巴字符估」，不绑定任何厂商 tokenizer。
- 从摘要往 memory 提取：记忆的写入仍归 memory 工具与 dream。
- 压缩视图在 UI 怎么展示：TUI 只显示上下文占用与 `/compact` 结果，账本视图归 TUI 设计。
- 分支会话、跨会话引用。
- 厂商 cache 编辑接口（Claude Code 的 microcompact 靠它零成本改前缀）：本仓的 tool-results 清理按批触发、两次触发之间字节不动，用普通 prefix cache 就够。

**待拍板。** 无。六项决策已拍（2026-09-02），见决策记录。

**验收判据（机器可判）。** `bun test packages/core/test/compaction.test.ts` 全绿，其中：触发后紧接着的 provider 请求不含被覆盖原文、含摘要；切点永远不落在 tool_use 与 tool_result 之间；压完下一轮不重复压；撞窗应急一次、第二次按 error 收场；压缩后立即续跑与重启恢复后续跑，送模消息逐字节相同；extension 装卸后下一轮即生效；没有阶段时不压、撞窗直接 error。

## 1. 不变量

1. **transcript 只增不改。** 压缩不删消息、不改消息；`Agent.messages` 与 session 的 message entries 永远是全量原文。
2. **压缩是视图状态。** `CompactionState` 描述「怎么看 transcript」；运行时（`AgentState.compaction`、`AgentContext.compaction`）与盘上（session 的 compaction entry）**同一个形状、同一套下标**，恢复不换算。
3. **配对不破。** 切点永远不落在 tool_use 与它的 tool_result 之间；清理只换 `content` 不删消息、`toolCallId` 不动。这两条只在 core 的 [`normalizeCompaction()`](../../packages/core/src/compaction/view.ts#symbol=normalizeCompaction) 与 [`projectRange()`](../../packages/core/src/compaction/view.ts#symbol=projectRange) 里守，策略产出再离谱也过不了它。
4. **策略只产状态。** 阶段（`CompactionStage`）不碰消息数组、不发事件、不写盘；要调模型就用 core 给的 `callModel`。
5. **核心文案不提工具。** `summary === null` 的省略说明、被清工具结果的占位，都是 core 的固定英文文案，不提 `transcript_read`——怎么取回原文由拥有那个工具的 extension 出 prompt 段说明。

## 2. 状态

定义见 [`CompactionState`](../../packages/core/src/compaction/types.ts#symbol=CompactionState)。

```ts
type CompactionSpan = { from: number; to: number; summary: string | null }; // [from, to) 半开；null = 只省略
type CompactionState = { spans: readonly CompactionSpan[]; clearedBefore: number };
```

- `spans` 按 `from` 升序、互不重叠、每个边界都是合法切点。`summary` 是**完整的送模正文**（框定、正文、取回提示都由阶段写全），`null` 时投影用 `omissionNotice()`。
- `clearedBefore`：下标小于它、且不在任何 span 里的 `toolResult`，投影时正文换成 `clearedNotice()`。
- `EMPTY_COMPACTION = { spans: [], clearedBefore: 0 }`。

## 3. 视图与切点

实现见 [`buildWorkingMessages()`](../../packages/core/src/compaction/view.ts#symbol=buildWorkingMessages) 所在的文件。

| 函数 | 做什么 |
| --- | --- |
| `isLegalCut(messages, i)` | `i` 能不能当切点：`messages[i]` 是 `toolResult` 就不能；0 与 n 恒合法 |
| `isTurnStart(messages, i)` | `user` / `environment` 消息 = 一轮的开头；摘要与折叠优先切在这里 |
| `snapBack` / `snapForward` | 从一个下标向前 / 向后找切点 |
| `normalizeCompaction(messages, state)` | 阶段产出 → 可用状态：越界截断、空段丢弃、排序、边界吸到合法切点；**重叠抛**（记成该阶段的失败） |
| `assertCompactionFits(messages, state)` | 恢复期的**严格**验形：不吸附、不修，不成立就是坏档判红 |
| `projectRange` / `buildWorkingMessages` | 状态 × transcript → 送模消息；段 → 一条 `user`/`harness`；清掉的 toolResult → 占位副本；其余**同一个对象** |
| `measureContext` | 当前上下文估算：有 usage 基准就「基准 + 基准之后的字符估」，没有就「system + 整个视图的字符估」 |

`runTurn()` 第一步就是 `buildWorkingMessages(context.messages, context.compaction)`，之后再拼每轮注入、过 `transformContext` 与 `contextBeforeBuild`，见 [`runTurn()`](../../packages/core/src/loop/run-turn.ts#symbol=runTurn)。压缩之后模型看到的结构固定是：

```text
system                       不变，每 run 装配一次，不含摘要
[user · harness]             每个 span 一条：summary 原文；null 时 "[Messages #a–#b were omitted to save context.]"
[原文尾巴]                   下标 < clearedBefore 的 toolResult 正文换成
                             "[Tool result cleared to save context: N characters omitted (message #k).]"
[turn injections]            激活 skill 正文、任务清单：本来就每轮重注入，压缩自动不丢
```

## 4. 流水线

实现见 [`runCompaction()`](../../packages/core/src/compaction/pipeline.ts#symbol=runCompaction) 与 [`createCompactor()`](../../packages/core/src/compaction/pipeline.ts#symbol=createCompactor)。

**什么时候跑。** 三个入口，同一条流水线，只差 `reason`：

| reason | 入口 | 阈值 |
| --- | --- | --- |
| `auto` | 每轮轮首（`runLoop`） | `used ≥ target` 才跑；目录没标 `contextWindow` 就永不自动压 |
| `overflow` | 本轮 provider 报 `context_overflow` 之后 | 无视阈值；**一个 run 只准一次**，成功就 `iteration -= 1` 重跑本轮，否则按 error 收场 |
| `manual` | `Agent.compact(instructions?)`（TUI `/compact`） | 无视阈值；走 admission 拿 permit（忙时 rejected），但不是一个 run：没有 agent_start / agent_end |

**预算**（`compactionBudget()`）：

- `used`：以本 run 最近一次 `usage` 的 `inputTokens + outputTokens` 为基准（它量的是那条 assistant 之前的视图加它自己的输出），之后入账的消息按字符估；压缩一发生基准作废，回到「system + 视图」字符估，直到下一轮 usage 回来。provider 没报 usage 的路径（FakeProvider、测试）只有字符估。
- **校准比**：字符估（4 字符 ≈ 1 token）对中文低 2–4 倍，而阶段之间只能重新字符估——两个量纲直接比，中文会话会在第一段就「够了」。所以每次 usage 到达时算一次 `真 token / 同一份视图的字符估`，之后流水线里的 `used`、给阶段的 `input.estimate`、压完报出去的 `contextTokens` 都乘它（范围夹在 0.2–10）。判据：同一段对话的 ASCII 版与中文版，跑过的阶段一致。
- 图片按固定 `IMAGE_TOKEN_ESTIMATE`（1 200）估，绝不按 base64 长度；`toolResult.images` 也算进去。
- `target = contextWindow − reserveTokens`，`reserveTokens` 缺省 `max(maxOutputTokens, 16 000)`。
- `goal`：auto / manual 是 `target − 10% window`（免得下一轮又碰线），overflow 是半窗。

**怎么跑。** 阶段按 `order` 升序（`AgentLoopConfig.compaction.getStages()` **每次重取**）：

1. `preCompact` 拦截（block = 这次不压）；发 `compaction_start`。
2. 逐个 `stage.run(input)`：返回 `null` 跳过；返回状态先过 `normalizeCompaction`，与当前相同也跳过；否则采用、重估 `used`。auto 一旦 `used ≤ goal` 就停。
3. 阶段抛错：发 `compactionFailed { stage, message }`，跳到下一段。一段都没改：发 `compactionFailed`（不带 stage）。
4. 发 `compaction_end { reason, compaction, stages, contextTokens }`（start / end 成对，观测 span 要闭合）；改了才发 `postCompact`、才写 session entry。

**失败语义**：

| 情况 | 结果 |
| --- | --- |
| 阶段抛错 | 诊断 + 跳过该段，run 继续 |
| auto 跑完没压动 | 诊断，本轮照常发（超窗由 provider 报错兜底 → 走 overflow） |
| overflow 没压动 / 第二次撞窗 | run 以 `context_overflow` error 收场（与 2026-09-02 之前相同） |
| 没有任何阶段 | auto 静默不压；overflow / manual 直接按上面两条 |
| `preCompact` block | 这次不压，三种 reason 都尊重 |

## 5. 缺省阶梯：`echo:compaction`

实现见 [`defaultCompactionStages()`](../../packages/core/src/compaction/builtin.ts#symbol=defaultCompactionStages)。参照 Claude Code 的 microcompact → snip → collapse → auto compact 与 reactive compact 改成本仓形态：

| order | 阶段 | 只在 | 做什么 | 模型调用 |
| --- | --- | --- | --- | --- |
| 10 | `tool-results` | 三种 | 保留最近 `keepRecentToolResults`（缺省 3；overflow 时 1）批工具调用的结果，之前的标清（`clearedBefore`） | 0 |
| 20 | `collapse` | auto | 从最旧原文起，每 `sectionTokens`（缺省 32k）一段、在轮起点收口，折成一段摘要；`used ≤ goal` 就停；一次最多 8 段 | 每段 1 次 |
| 30 | `summary` | 三种 | 尾巴之前的全部（已有段摘要 + 剩余原文）折成一份九节结构化摘要；尾巴 = `keepRecentTokens`（缺省 8k；overflow 时 2k）吸到轮起点，在飞的一轮放不下就退到合法切点 | 1 次 |
| 40 | `snip` | overflow | summary 都失败时把尾巴之前直接省略（`summary: null`）——总好过再撞一次窗 | 0 |

**摘要 prompt**（全英文，`SUMMARY_SYSTEM` / `SUMMARY_INSTRUCTION`，措辞与节名都是自己写的）：先 `<scratchpad>` 草稿再 `<summary>` 正文，运行时 `extractSummary()` 只留正文；要求**用用户主要使用的语言写**（中文用户得到中文摘要）；九个小节：goal、ground rules、touched files、failures and fixes、findings、the user's messages（逐字）、open work、in progress、resume with；已有摘要要合并不重复；manual 的 `instructions` 作为附加要求追加在末尾。collapse 用更短的一段 prompt（`COLLAPSE_*`）。

**框定**：`frameFull()` 给整段摘要加来历（这段对话被压缩过）、范围（`#0–#k`）、取回提示（call `transcript_read`）；`frameSection()` 给折叠段加范围与取回提示。

**`transcript_read({ from, to?, query? })`**（[`transcriptReadTool()`](../../packages/core/src/compaction/tool.ts#symbol=transcriptReadTool)）：按下标读**内存里的完整 transcript**——不走磁盘、不进 workspace jail，没有文件工具的通用 agent 也能用；下标与压缩通知里的 `#12–#40` 同一套；单条 4 000 字符、一次 24 000 字符封顶，超了告诉模型从哪续。同组还有一个 prompt 段（`compactionSection()`，order 150）告诉模型压缩之后细节去哪拿。

## 6. 扩展与热插拔

**注册口**：[`AgentCompaction`](../../packages/core/src/extension/registries.ts#symbol=AgentCompaction)（`echo.agent.compaction`，`kind: "registry"`，`reload: "turn"`），方法只有 `stage(stage): Disposer`，同名 fail-loud、disposer 认对象身份——与 `AgentPrompt` 同款。Agent 侧是 `agent.compactionStages: Map`，`createLoopConfig()` 把 `getStages: () => [...map.values()]` 交给循环，流水线每次跑之前重取，所以装卸在**轮边界**生效。

**内建走同一条路**：[`ECHO_COMPACTION`](../../packages/core/src/extension/builtin.ts#symbol=ECHO_COMPACTION) inject `AgentTools` / `AgentPrompt` / `AgentCompaction`，工具、段、阶段在**同一个 effect**（`boundary: "turn"`）里注册，一起装、一起撤（`registerAll` 中途撞名整组回滚）。组在 Agent 构造期造（`defaultCompactionPack()`），注册不在构造期——"造在这里，注册不在这里"。

**换策略**：

```ts
import { createEcho, type CompactionStage, type Provider } from "@echo-agent/core";
import { AgentCompaction, defineExtension } from "@echo-agent/core/extension";

declare const provider: Provider; // 与平时一样从目录里解析出来

const myStage: CompactionStage = {
  name: "acme:keep-last-turn",
  order: 10,
  run(input) {
    // 只留最后一轮，之前的省略；input.messages 是只读的完整 transcript
    let cut = input.messages.length - 1;
    while (cut > 0 && input.messages[cut]!.role !== "user") cut -= 1;
    return cut <= 0 ? null : { spans: [{ from: 0, to: cut, summary: null }], clearedBefore: 0 };
  },
};

const ACME_COMPACTION = defineExtension({
  name: "acme:compaction",
  hostAbiVersion: 1,
  inject: { compaction: { service: AgentCompaction, required: true } },
  apply(ctx) {
    const reg = ctx.get(AgentCompaction);
    void ctx.effect({ boundary: "turn", start: () => ({ value: myStage.name, dispose: reg.stage(myStage) }) });
  },
});

// 不装内建那组，只用自己的
const echo = await createEcho({
  provider,
  agent: { compaction: { builtin: false } },
  extensions: [{ entryId: "acme:compaction", definition: ACME_COMPACTION }],
});
void echo;
```

要在内建阶梯**之外加**一段（比如 order 15 的「把大文件读取结果换成路径」），不关 `builtin`，直接注册；同名才冲突。

## 7. 产品用法

- 缺省什么都不用接：`createEcho()` / `createAgent()` 装出来的 agent 自带四段阶梯、应急、`/compact`、`transcript_read`。
- 调参：`createEcho({ agent: { compaction: { reserveTokens, keepRecentTokens, sectionTokens, keepRecentToolResults } } })`，形状见 `CompactionOptions`。
- TUI：`/compact [指令]` 调协议 `AgentRuntime.compact()`，结果如实显示（压了哪些阶段 / 没什么可压 / 被拒）；状态栏在 `contextTokens` 与 `model.capabilities.contextWindow` 都有时显示「上下文 12k/262k (5%)」。
- 状态：`AgentState.compaction`（视图状态）与 `AgentState.contextTokens`（每轮 usage、压缩后估算）；`reset()` 都归零。

## 8. 落盘与恢复

session entry：`{ kind: "compaction", at, reason, compaction: CompactionState }`——每次压缩之后的**整个**状态，不是增量；没压动的不入账。恢复（[`SessionService.project()`](../../packages/core/src/session/service.ts#symbol=project)）取最后一条的状态，再用 `assertCompactionFits()` 在恢复出来的 messages 上验：越界、重叠、切在配对中间都判红、不修——transcript 只增不改，写下去时合法的状态永远合法，不合法就是坏档。

判据：压缩后立即续跑与重启恢复后续跑，下一次 provider 请求的 messages 深度相等（`at` 在投影时剥掉，所以逐字节相同）。

## 9. 复核命令

```bash
bun test packages/core/test/compaction.test.ts packages/core/test/session-service.test.ts packages/core/test/create-echo.test.ts
rg -n 'AgentCompaction|compactionStages|getStages' packages/core/src
```
