# Context 与 Message Flow（审阅稿）

> 状态：审阅中，尚未成为设计契约<br>
> 基线：2026-09-01 当前源码与测试<br>
> 范围：消息账本、system prompt、每轮注入、送模投影、上下文变换、压缩与会话恢复<br>
> 暂不处理：具体 provider 方言、thinking 字段的厂商兼容、Memory 的提取与写回策略、UI 如何展示消息<br>
> 退出条件：第 10 节每一项分别形成决策记录，结论吸收到正式设计后删除本稿；历史由 Git 保留

这份文档回答四个问题：什么是会话事实，什么只是本轮给模型看的工作材料，哪一步可以改写它们，以及长会话如何压缩和恢复。未经拍板的现状不会被写成目标设计。

## 结论先行

当前实现已经有一条值得保留的主轴：

- `AgentMessage` 是本地账本形状，`ProviderMessage` 是临时线上形状；两者不混存。
- system prompt 每个 run 装配一次，每轮动态内容作为 injection 追加，不进入 transcript。
- 工具结果、环境事件与人类输入在账本里角色分明，出门时再投影成 provider 支持的两种角色。
- 每条真正入账的消息都经 `message_end`，并由同一事件驱动运行时投影和 session append。

但是“账本是事实、context 是投影”这句话目前还不能成立为公开契约。源码里有七个必须先处理或明确接受的问题：

1. ~~**compaction 只生成并持久化摘要，不替换送模上下文。**~~ 已修（2026-09-02）：压缩成为作用在 transcript 上的视图状态，策略走 extension 阶梯，撞窗有应急，见 [Compaction](compaction.md) 与 §7。
2. **消息没有所有权隔离。** `prompt(message)`、`Agent.messages`、context snapshot 与 `transformContext` 共享嵌套对象；调用方或 transform 能在没有新事件、没有新 session entry 的情况下改写已经入账的历史。
3. ~~**`contextBeforeBuild` 的 block 是假能力。**~~ 已修（2026-09-01）：block 让 run 以 `aborted` 结束、模型不被调用，见 §6。
4. **`followUp` 的来源只在 hook event 中如实，账本里仍记成 `human`。** 现有测试标题声称 transcript 来源如实，但没有断言消息的 `source`。
5. **`PromptSource.toolSchemas()` 是死接口。** 类型和注释声称每轮读取，实际工具菜单来自 `getTools() → toolSchemas()`，这个方法从未被调用。
6. **上下文扩展点的失败契约与实现相反。** 注释要求 `transformContext`、`convertToLlm` 和 turn injection “绝不抛、失败安全回退”；实际任一抛错都会让整个 run 以 internal error 结束。
7. **消息只在恢复时严格验形，prompt 入站不验。** 一个 JavaScript 调用方可以让 Agent 自己把坏消息写进 session，本次 run 成功，下一次恢复才判坏档。

第二项直接破坏长会话正确性和审计可信度，第四、第五项是公开接口或测试声称的行为并不存在，后两项是失败发生位置与承诺不一致。它们都不是靠改文案可以解决的问题。

## 术语与分层

| 术语 | 本文含义 | 是否持久化 | 是否直接送模型 |
| --- | --- | --- | --- |
| transcript | 按入账顺序排列的 `AgentMessage[]`，是 Agent 对会话事实的运行时视图 | 是 | 否 |
| session ledger | 盘上的 message / compaction / error entries | 是 | 否 |
| system prompt | 一个 run 装配出的固定前缀 | 否，装备与来源数据另行持久化 | 是 |
| turn injection | 当前 turn 临时追加的 instruction-like 消息 | 否 | 是 |
| working context | transcript 快照、injection 和 hook/transform 处理后的 `AgentMessage[]` | 否 | 否 |
| provider context | `systemPrompt + ProviderMessage[] + ToolSchema[]` | 否 | 是 |
| projection | `AgentMessage[] → ProviderMessage[]` 的单向转换 | 否 | 产物送模型 |
| compaction | 作用在 transcript 上的视图状态（哪些段被摘要 / 省略、旧工具结果清到哪），送模前投影；transcript 本身不动 | 状态持久化（session 的 compaction entry） | 投影后的上下文送模型 |

`AgentContext` 目前只含 `systemPrompt` 与 `messages`，工具故意每 turn 重取，见 [`AgentContext`](../../packages/core/src/loop/types.ts#symbol=AgentContext)。“context”在源码里有时指这个 Agent 层工作对象，有时指最终 provider 请求；正式文档应始终带上层级，避免把账本、工作副本和线上电报叫成同一个东西。

## 1. 当前数据流

```mermaid
flowchart TD
    A["prompt / steer / followUp / inbox"] --> B["userPromptSubmit admission"]
    B -->|block| X["不入账，不开 run 或丢弃该队列项"]
    B -->|continue / patch| C["message_end"]
    C --> D["runtime transcript"]
    C --> E["session message entry"]
    D --> F["run 开始时浅拷贝 messages 数组"]
    P["PromptSection sources"] --> Q["每 run 组装 system prompt"]
    Q --> R["AgentContext.systemPrompt"]
    F --> G["每 turn 追加 injections"]
    G --> H["transformContext"]
    H --> I["contextBeforeBuild hook"]
    I --> J["convertToLlm"]
    J --> K["ProviderMessage[]"]
    T["active tools"] --> U["每 turn 投影并按名排序"]
    U --> V["ToolSchema[]"]
    R --> W["provider request"]
    K --> W
    V --> W
    W --> Y["assistant message / tool results"]
    Y --> C
```

输入准入见 [`Agent.admitUserMessages()`](../../packages/core/src/agent.ts#symbol=Agent.admitUserMessages)，run snapshot 见 [`Agent.createContextSnapshot()`](../../packages/core/src/agent.ts#symbol=Agent.createContextSnapshot)，turn 内顺序见 [`runTurn()`](../../packages/core/src/loop/run-turn.ts#symbol=runTurn)。

这条流水线里有两个正交通道：

- **prompt 通道**决定模型此刻看见什么：system、injections、transform、hook、projection、tools。
- **ledger 通道**决定什么成为会话事实：`message_end`、compaction entry、error entry。

一项数据可以只走其中一条。skill 正文 injection 只走 prompt 通道；工具 metadata 只走 ledger 通道；普通 user / assistant 消息先入账，再由 projection 进入 prompt 通道。这个区分是合理的，问题出在两条通道目前共享可变对象。

## 2. 消息账本

### 2.1 四种内建角色

| 角色 | 表示的事实 | 缺省投影 |
| --- | --- | --- |
| `user` | 人类、steer 或 harness 放入的输入 | provider `user`，剥掉 `at/source` |
| `assistant` | provider 的权威定稿、stop reason、usage 与 model 来源 | provider `assistant`，剥掉账本字段；空 content 隐形 |
| `toolResult` | 某个工具调用的结果及本地 metadata | provider `user` 中的 `tool_result`；metadata 不出门 |
| `environment` | 后台任务、定时器、webhook 等外部事实 | provider `user`，剥掉 `source/ref` |

形状定义与投影见 [`AgentMessage`](../../packages/core/src/messages.ts#symbol=AgentMessage) 和 [`defaultConvertToLlm`](../../packages/core/src/messages.ts#symbol=defaultConvertToLlm)。自定义 role 缺省只进入 transcript 与 session，不送模型；这是忘记实现 projection 时的安全缺省。

把 `toolResult` 和 `environment` 留作一等账本角色是正确的。provider 只有两种 role 是线上协议限制，不应该倒过来污染本地事实模型。相邻工具结果只在 projection 时合并，也保留了逐条审计能力。已有判据见 [toolResult 投影与相邻合并](../../packages/core/test/invariants.test.ts#test=投影toolresult-包回-user-角色的-toolresult-块相邻的合并成一条)。

### 2.2 来源字段没有覆盖所有入账路径

`UserMessage.source` 只有 `human | steer | harness`，见 [`UserMessage`](../../packages/core/src/messages.ts#symbol=UserMessage)。`Agent.followUp("next")` 用 `userMessage(..., "human")` 建消息，见 [`Agent.followUp()`](../../packages/core/src/agent.ts#symbol=Agent.followUp)；之后 `userPromptSubmit` hook 单独收到 `source: "followUp"`，但 admission 不会修正消息本身。

复现：

```bash
bun -e 'import { Agent } from "./packages/core/src/agent.ts"; import { FAKE_MODEL, scriptedStreamFn, textTurn } from "./packages/core/src/testing.ts"; const a=new Agent({model:FAKE_MODEL,streamFunction:scriptedStreamFn([textTurn("one"),textTurn("two")])}); a.subscribe(async e=>{if(e.type==="agent_start") await a.followUp("next")}); await a.prompt("first"); console.log(a.state.messages.filter(m=>m.role==="user").map(m=>({text:m.content[0].text,source:m.source})));'
```

当前输出中 `next` 的来源是 `human`。现有 [steer / followUp 来源测试](../../packages/core/test/seams.test.ts#test=run-里-steer-followup-进-transcript-时-source-也如实标steer-轮末followup-收尾后) 只断言 hook 收到的 `seenSources`，没有检查 transcript，测试名比判据更强。

这会让恢复后的 session、UI 和离线评测无法区分原始 prompt 与 run 内 follow-up。若 `source` 表示“谁发起内容”，两者都可以叫 human；若它表示“从哪个 admission 通道入账”，就必须增加 `followUp` 并在入口规范化。当前注释和测试明显采用后一个解释，代码却采用前一个解释，必须选一个。

### 2.3 入站验形发生得太晚

[`assertMessageShape()`](../../packages/core/src/message-shape.ts#symbol=assertMessageShape) 会闭合校验内建 role 和 content block，但它用于 session 恢复与 inbox 接收；[`normalizePrompt()`](../../packages/core/src/agent.ts#symbol=normalizePrompt) 对对象和数组原样返回。TypeScript 调用方通常会在编译期被挡住，JavaScript、`any`、反序列化输入和自定义宿主不会。

已经复现：传入缺 `text` 的 `{type:"text"}`，本次 run 可以完成并把它落盘；新 Agent 恢复同一 session 时才报“text 块缺 text”。这使“坏档在读进来时判红”成立，却没有阻止 core 自己写出坏档。

审阅结论：内建消息在所有 durable ingress 进入 transcript 之前必须跑同一份闭合验形；自定义 role 继续只验公共信封。恢复期校验仍要保留，它防的是旧版本、人工修改和外部坏写，不能替代写入前校验。

## 3. System prompt 与每轮 injection

### 3.1 System prompt

`Agent.assemblePrompt()` 每个 run 从 `AgentPrompt` registry 的两张表（段、变量）取材，再交给 [`assembleSystem()`](../../packages/core/src/prompt/assemble.ts#symbol=assembleSystem)。**段只从 registry 来**（2026-09-01）：内建的 environment / skills / memory 由 `echo:agent` / `echo:skills` / `echo:memory` builtin 注册，产品与壳的段由各自的 extension 注册（`definePromptPack` / `defineToolPack` 的 `sections`）；构造参数上不再有 `systemPrompt` / `promptSections` / `promptSources`。装配规则是：

1. 按 `order` 升序，同数保注册序。约定带见 [`PROMPT_ORDER`](../../packages/core/src/prompt/types.ts#symbol=PROMPT_ORDER)：identity 0、conduct 10、surface 20、工具习惯 100–199、environment 300、instructions 400、skills 500、memory 900——按**变化频率**排，越稳定越靠前；
2. 每段单独 `render(ctx)` 和 trim，`ctx` 是本次装配的事实（workspace、admission 冻结的模型、agentId、sessionId）；
3. `{{name}}` 从本次装配一次性解析出的变量表取值，**严格**：未注册、无值、畸形都不放行；
4. 空段丢弃；非空段以两个换行连接；全空得到 `null`。

`order` **只表示排序**，core 没有 prompt cache，也不按 order 选择刷新频率。它把更稳定的字节放在前面，给 provider 的 prefix cache 创造命中条件；是否缓存、缓存多久由 provider 决定。字节级判据见 [order 排序与空段语义](../../packages/core/test/prompt.test.ts#test=按-order-升序同数保注册序空段丢弃全空返回-null) 与 [严格插值](../../packages/core/test/prompt.test.ts#test=未注册-无值-畸形三种都抛-promptvariableerror带段名)。

失败语义（2026-09-01 定了两档）：

- `PromptSection.render()` 抛错：省略该段并发诊断，run 继续——段是增强面，运行时数据坏一段不许击穿整个 run；
- 变量引用错：抛 `PromptVariableError`，本次 run 以 error 结束——段文本是产品 / extension 写的受信文本，写错变量名是作者错误，要响。判据见 [变量错让 run 以 error 收场](../../packages/core/test/prompt.test.ts#test=变量错-run-以-error-收场不静默发一份错的-system)。

仍然没有的：段上的“必需 / 可选”属性。产品身份段的 `render` 抛错依旧静默隐形；今天产品与壳的段都是字面量（`render` 不会抛），唯一读盘的段是 `echo:instructions`，它失败 = 没有项目指令，可接受。真出现「必需段」再加属性。

### 3.2 Turn injection

`PromptSource.turnInjections()` 每 turn 重算，结果追加到 transcript snapshot 的末尾，不发 `message_end`，因此不进入运行时 transcript 和 session。当前 skill 正文与 task snapshot 走这条路，接线见 [`Agent.promptSources()`](../../packages/core/src/agent.ts#symbol=Agent.promptSources) 和 [`Agent.createLoopConfig()`](../../packages/core/src/agent.ts#symbol=Agent.createLoopConfig)。

这个边界适合“当前有效、但不是对话事实”的材料：激活 skill、任务清单、短期运行说明。已有测试验证激活正文下一 turn 可见、system 字节不变且 injection 不入 transcript，见 [skill injection 接线](../../packages/core/test/prompt.test.ts#test=内建段经-echo-进-system环境段带-workspacemodelskills-目录在激活后下一轮注入可见system-逐字节不变)。

injection 里的**工具门控读本轮冻结的菜单**（`runTurn` 把冻结的工具名集传给 `getTurnInjections`），不读活池：`turn_start` 里才注册的工具，这轮菜单上没有，注入也不许提它——菜单与注入永远是同一份 turn 快照。判据见 [冻结菜单门控](../../packages/core/test/prompt.test.ts#test=注入的工具门控读本轮冻结的菜单turnstart-里才注册的-tasklist本轮菜单与清单都没有下一轮一起出现)。

激活 skill 的注入有**总预算**（`SKILL_ACTIVE_TOTAL_CAP`，64 000 字符，各条正文按单条上限计）：闸在 `activateSkill`，超了拒绝并把现状告诉模型；不在渲染末端静默截掉已声明激活的指令。判据见 [激活总预算](../../packages/core/test/skill.test.ts#test=激活总预算合计超过-skillactivetotalcap-就拒回执带现状重复激活不重复计费超长正文按单条上限计)。

但注释中的“契约：绝不抛；没有返回 `[]`”没有调用侧兜底。任一 source 抛错会结束整个 run。这里需要的是明确选择，不是模糊承诺：

- 如果 injection 是完成任务所必需的上下文，失败应使 run fail-loud；
- 如果它只是增强，失败应记录诊断并按该 source 返回空列表；
- 不同来源可能需要不同档位，不能由聚合器统一猜测。

### 3.3 `PromptSource` 只剩 `turnInjections()`

2026-09-01 起 [`PromptSource`](../../packages/core/src/prompt/types.ts#symbol=PromptSource) 只有 `turnInjections()` 一个方法，且只在 Agent 内部用（skill 正文、任务清单两条注入）。原先的 `toolSchemas()` 从未被消费（工具菜单一直由 [`runTurn()`](../../packages/core/src/loop/run-turn.ts#symbol=runTurn) 从 turn 工作集调 [`toolSchemas()`](../../packages/core/src/tools/types.ts#symbol=toolSchemas) 得到），`promptSections()` 的职责被 `AgentPrompt` registry 接走。工具菜单因此只有 `getTools() → toolSchemas()` 一条真源；system 里也不再列工具目录——单工具语义只在 description，跨工具的习惯由拥有该工具的 extension 出段。

## 4. Working context 与对象所有权

### 4.1 现在只有数组快照，没有消息快照

`Agent.createContextSnapshot()` 使用 `[...this._state.messages]`，只复制最外层数组。`processEvents(message_end)` 也把事件里的原对象追加进 `_state.messages`；`Agent.state` 只浅拷贝 state 对象，`Agent.messages` 直接返回同一个消息数组的 readonly 类型视图。见 [`Agent.createContextSnapshot()`](../../packages/core/src/agent.ts#symbol=Agent.createContextSnapshot)、[`Agent.processEvents()`](../../packages/core/src/agent.ts#symbol=Agent.processEvents) 和 [`Agent.state`](../../packages/core/src/agent.ts#symbol=Agent.state)。

因此 readonly 只是 TypeScript 表面约束，不是运行时所有权边界。两个探针都已复现：

```text
prompt(message) 完成后修改 message.content[0].text
→ agent.state.messages[0] 同步变成 CALLER_MUTATED

transformContext 内修改 messages[0].content[0].text
→ agent.state.messages[0] 同步变成 TRANSFORM_MUTATED
```

这两次改写都没有新的 `message_end`，不会追加新的 session entry。内存 transcript 与已经排队或已经落盘的 session 因此可以静默分叉；如果 mutation 发生在 session append 序列化之前，盘上结果还取决于异步时序。

### 4.2 目标所有权边界

要让“transcript 是事实账本”成立，最低判据应是：

1. 外部消息在 admission 时验形并取得所有权；之后修改调用方原对象不影响 transcript。
2. `state`、`messages`、event listener 和 hook 获得的只读视图不能原地改写账本。
3. `transformContext` 与 `contextBeforeBuild` 操作独立 working copy；它们可以增删改送模材料，但不能回写 transcript。
4. 同一条 `message_end` 在运行时投影与 session ledger 中具有相同的不可变值。

实现可以选择 ingress 时 `structuredClone + deepFreeze`，也可以采用内部不可变消息和 copy-on-write；设计不应预先指定性能策略。但上述四条必须有行为测试，否则“快照”和“账本”仍只是类型注释。

## 5. Projection：账本到 provider 电报

缺省 projection 做四件事：

- 去掉本地字段：时间、来源、usage、error、model、metadata、environment ref；
- 把 `toolResult` 变回 provider `user` 消息里的 `tool_result` block；
- 合并相邻的纯 tool-result provider messages；
- 对未知自定义 role 和空 assistant 返回 invisible。

实现见 [`defaultConvertToLlm`](../../packages/core/src/messages.ts#symbol=defaultConvertToLlm)。它每 turn 从 working context 重算，产物不持久化，这一设计应该保留：provider 方言和模型切换不应改写历史账本。

但“投影绝不回写”当前只对缺省实现自己的代码成立，不对可替换的 `Agent.convertToLlm` 成立。它收到的仍是与 transcript 共享嵌套对象的数组。正式契约应把输入定义为不可变 working copy，并把返回值验到 provider context 所需的最小形状；否则第三方 converter 可以同时破坏账本并产出坏线上协议。

## 6. `contextBeforeBuild` 的 block（2026-09-01 起生效）

`contextBeforeBuild` 被列入 hook runtime 的可拦截事件，类型允许 `continue / block / patch`，见 [`INTERCEPTABLE`](../../packages/core/src/hooks/runtime.ts#symbol=INTERCEPTABLE)。2026-09-01 之前 [`runTurn()`](../../packages/core/src/loop/run-turn.ts#symbol=runTurn) 只取 `r.event.messages`、不读 `r.decision`——hook 说别调模型，模型照调，run 还是 `completed`。

现在的语义：block = **这一轮不发**。`runTurn` 抛 [`ContextBuildBlocked`](../../packages/core/src/loop/run-turn.ts#symbol=ContextBuildBlocked)，`runLoop` 把它折成 `{ kind: "aborted", reason }`（reason 透传自 hook），模型不被调用，transcript 里**不合成** assistant 消息（什么都没说过，账本里就不该有一条）。选 aborted 而不是 error：这不是故障，是有人在送模前叫停，和 `userPromptSubmit` 的 block 同一档。判据见 [block 不调模型](../../packages/core/test/prompt.test.ts#test=contextbeforebuild-返回-block不调模型run-以-aborted-收场reason-透传transcript-不多一条)。

复现（现在应打印 `{ kind: "aborted", reason: "DO_NOT_CALL_MODEL" } 0`）：

```bash
bun -e 'import { Agent } from "./packages/core/src/agent.ts"; import { HookRuntime } from "./packages/core/src/hooks/runtime.ts"; import { FAKE_MODEL, scriptedStreamFn, textTurn } from "./packages/core/src/testing.ts"; const h=new HookRuntime(); h.on("contextBeforeBuild",()=>({decision:"block",reason:"DO_NOT_CALL_MODEL"})); let calls=0; const base=scriptedStreamFn([textTurn("done")]); const a=new Agent({model:FAKE_MODEL,hooks:h,streamFunction:(m,c,o)=>{calls++;return base(m,c,o)}}); console.log((await a.prompt("go")).outcome,calls);'
```

## 7. Compaction 与恢复（2026-09-02 起见独立设计）

正式设计与实现见 [Compaction](compaction.md)。本节原先记录的四个问题（只摘要不缩上下文、checkpoint 运行前后两种语义、字符估不是上界、重复摘要）都已按那份设计落地；当时列出的六条机器判据现在各有测试：

| 判据 | 测试 |
| --- | --- |
| 触发后紧接着的 provider request 不含已覆盖原文、含摘要与尾巴 | [auto 触发](../../packages/core/test/compaction.test.ts#test=auto超阈值-轮首压缩-紧接着的-provider-请求只含摘要不含原文压完下一轮不重复压状态与-session-都记下) |
| 摘要带 harness 来源，不伪装成人或 assistant 原话 | [投影](../../packages/core/test/compaction.test.ts#test=投影段-一条-userharness清掉的-toolresult-换占位但-toolcallid-iserror-不动transcript-原对象一个字不改) |
| tool_use / tool_result 配对不被切断 | [切点](../../packages/core/test/compaction.test.ts#test=切点toolresult-前面不能切snapback-优先轮起点其次合法切点都没有回-min) |
| 压缩后立即续与恢复后续，下一次 provider context 逐字节相同 | [恢复一致](../../packages/core/test/compaction.test.ts#test=压缩后立即续跑-vs-重启恢复后续跑下一次送模消息逐字节相同) |
| 游标只有一种：transcript 下标，运行时与盘上同一套 | [session 恢复](../../packages/core/test/session-service.test.ts#test=不变量①-恢复后-messages-与-compaction-同源同一份-entries-投影出来取最后一次压缩的状态) |
| 压到预算内之后下一轮不重复摘要 | 同第一条 |

`AgentState.checkpoint` 已删除，换成 `compaction`（视图状态）与 `contextTokens`。

## 8. 失败语义

源码给上下文接缝写了不同承诺：section render 失败 omit、transform 和 converter 失败安全回退、hook 按 fail-open / fail-closed 折叠。但实际调用链是：

| 失败点 | 当前行为 | 注释或接口暗示 |
| --- | --- | --- |
| `PromptSection.render()` 抛错 | 省略该段，诊断后继续 | fail-soft enhancement |
| 段里 `{{变量}}` 未注册 / 无值 / 畸形 | `PromptVariableError`，run 以 error 结束 | 设计如此：作者错误要响 |
| `turnInjections()` 抛错 | run 以 internal error 结束 | “绝不抛；没有返回 []” |
| `transformContext()` 抛错 | run 以 internal error 结束 | “失败原样返回入参” |
| `convertToLlm()` 抛错 | run 以 internal error 结束 | “绝不抛” |
| `contextBeforeBuild` 返回 block | run 以 `aborted` 结束、reason 透传，provider 不被调用 | interceptable / block（2026-09-01 起一致） |

三个抛错探针都得到结构化 `outcome.kind === "error"`；Agent 的 terminal normalizer 保住了完整封口，但它不是安全回退。这里要先按“缺失这项上下文后继续调用模型是否安全”分类，再让类型、实现和测试使用同一个答案。

## 9. 哪些由机器守，哪些只是纪律

### 已有机器判据

| 性质 | 机器判据 |
| --- | --- |
| 缺省 projection 剥掉本地字段 | [账本字段不出门](../../packages/core/test/invariants.test.ts#test=投影剥壳atsourceusagemetadata-不出门) |
| tool result 在线上合并、账本中逐条保留 | [toolResult 投影与相邻合并](../../packages/core/test/invariants.test.ts#test=投影toolresult-包回-user-角色的-toolresult-块相邻的合并成一条) |
| 空 assistant 不进入 provider context | [空 assistant 隐形](../../packages/core/test/invariants.test.ts#test=投影空-content-的-assistant-消息整条隐形空消息是协议违规) |
| system section 排序、空段与 render 失败 | [assembleSystem 行为](../../packages/core/test/prompt.test.ts#test=按-order-升序同数保注册序空段丢弃全空返回-null)、[坏段隐形并留痕](../../packages/core/test/prompt.test.ts#test=render-抛错-该段隐形不击穿onfailure-留痕) |
| skill / task injection 每轮刷新且不入 transcript | [skill injection](../../packages/core/test/prompt.test.ts#test=内建段经-echo-进-system环境段带-workspacemodelskills-目录在激活后下一轮注入可见system-逐字节不变)、[task injection](../../packages/core/test/prompt.test.ts#test=任务清单每轮注入空清单不占位建完下一轮就可见不打-system-缓存不进-transcript) |
| session 恢复时拒绝坏内建消息 | [坏 message payload 恢复判红](../../packages/core/test/session-service.test.ts#test=坏-message-payload-在恢复时判红只有-role-是不够的)、[content block 闭合验形](../../packages/core/test/session-service.test.ts#test=内容块闭合验形缺字段与不认识的-type-都判红) |

### 当前没有门守

- ingress 后调用方不能改写 transcript。
- transform、converter 和 context hook 不能回写 transcript。
- `contextBeforeBuild` 的 decision 被调用点正确消费。
- `followUp` 在 transcript 中保留真实 admission 来源。
- `PromptSource` 的每个公开方法都有消费者。
- programmatic prompt source 的失败档位与 section 重要性一致。

（compaction 缩短下一次 provider context、恢复前后一致、游标只有一种语义：2026-09-02 起有机器判据，见 §7。）

这些都可以写出确定的行为判据，应该进入相关单测；不能把它们留成文档纪律。

## 10. 审阅需要拍板的事项

### 必须在发布前解决

1. ~~**实现或移除 compaction。**~~ 已实现（2026-09-02），见 [Compaction](compaction.md) 与六条决策记录。
2. **建立消息所有权边界。** admission 取得消息所有权，账本只读，working context 与 transcript 断开对象别名。
3. **修正 `contextBeforeBuild` ABI。** 要么只允许 patch，要么兑现 block；不能保留被忽略的 decision。
4. **删除 `PromptSource.toolSchemas()`。** 已于 2026-09-01 删除（见 §3.3）；工具 schema 只由 turn workset 投影。
5. **在 durable ingress 前验消息形状。** 同一份 validator 同时守写入和恢复，不能让 Agent 自己产毒档。

### 需要产品语义确认

1. `UserMessage.source` 表示内容作者，还是入账通道；据此决定 follow-up 是否是独立来源。
2. 哪些 prompt sections 属于关键策略，渲染失败必须阻止模型调用；哪些只是增强，可以省略。
3. turn injection、transform 与 converter 失败时，是 fail-loud 结束 run，还是使用明确的 fallback；每个扩展点分别决定。
4. 自定义 AgentMessage 是否默认永远 model-invisible，还是注册自定义 role 时必须同时注册 projection。
5. ~~compaction summary 在账本中采用独立 role、environment role，还是只作为 session entry 经恢复投影。~~ 已决（2026-09-02）：只作为 session entry，送模时投影成 user/harness 消息带固定框定，见 [决策记录](../decisions/implemented/2026-09-02-compaction-summary-message.md)。

### 本轮明确延期

- provider-specific thinking 的同源回放与跨模型迁移。
- Memory 如何从 transcript 提取、何时写回、如何与 compaction summary 分工。
- UI 对 raw transcript、working context 和 compacted view 的展示方式。
- 分支会话、合并会话与跨会话引用。

## 11. 复核命令

已有相关测试：

```bash
bun test packages/core/test/prompt.test.ts \
  packages/core/test/seams.test.ts \
  packages/core/test/invariants.test.ts \
  packages/core/test/session-service.test.ts \
  packages/core/test/intake.test.ts
```

当前全绿。它说明既有判据仍成立，不说明本稿列出的缺口不存在。

核实死接口和 compaction 消费路径：

```bash
rg -n 'toolSchemas|PromptSource|compactionStages|buildWorkingMessages' \
  packages/core/src packages/core/test
```

核实消息所有权探针：

```bash
bun -e 'import { Agent } from "./packages/core/src/agent.ts"; import { userMessage } from "./packages/core/src/messages.ts"; import { FAKE_MODEL, scriptedStreamFn, textTurn } from "./packages/core/src/testing.ts"; const m=userMessage("ORIGINAL"); const a=new Agent({model:FAKE_MODEL,streamFunction:scriptedStreamFn([textTurn("done")])}); await a.prompt(m); m.content[0].text="CALLER_MUTATED"; console.log(a.state.messages[0].content[0].text);'
```

当前输出：`CALLER_MUTATED`。
