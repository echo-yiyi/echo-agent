# 落单的 `tool_use`：中止之后没跑的那几个调用，transcript 里没有配对的结果

> 状态:implemented · 提出 2026-09-07 · 拍板 2026-09-07(口头,选 B) · 合入 2026-09-07 · 来源 2026-09-07 [并行工具](../implemented/2026-09-07-parallel-tools.md) 实现时点出的既有缺口(不是它引入的)

## 现状

一条 assistant 消息可以带多个 `tool_use`。工具批在 `packages/core/src/loop/run-turn.ts` 里逐批执行,每批之后判一次 `signal.aborted`——**中止了就不再跑后面的,也不给它们任何结果**。于是 transcript 里留下几个没有 toolResult 的 `tool_use`,而**没有任何一层补它**:投影(`messages.ts` 的 `defaultConvertToLlm`)原样带过去,run 收尾合成的是**事件**不是工具结果(`agent.ts` 的终结事件合成),压缩也不认识这种配对。

实测(仓库根跑):

```bash
bun -e 'const {Agent}=await import("./packages/core/src/agent.ts");const {FAKE_MODEL,scriptedStreamFn}=await import("./packages/core/src/testing.ts");const t=(n,e)=>({kind:"model",name:n,label:n,description:n,parameters:{type:"object",properties:{}},execute:e});const turn=[{type:"start"},{type:"done",message:{role:"assistant",content:[{type:"tool_use",id:"a",name:"a",input:{}},{type:"tool_use",id:"b",name:"b",input:{}}],stopReason:"tool_use",usage:null}}];let ag;ag=new Agent({model:FAKE_MODEL,streamFunction:scriptedStreamFn([turn]),tools:[t("a",async()=>{ag.abort("probe");return{ok:true,content:"a"}}),t("b",async()=>({ok:true,content:"b"}))]});await ag.prompt("go");const m=ag.messages;console.log("TOOL_USE=",m.flatMap(x=>x.role==="assistant"?x.content.filter(c=>c.type==="tool_use").map(c=>c.id):[]));console.log("TOOL_RESULT=",m.filter(x=>x.role==="toolResult").map(x=>x.toolCallId));'
```

输出:`TOOL_USE= [ "a", "b" ]`,`TOOL_RESULT= [ "a" ]`。

**线上的后果**:`defaultConvertToLlm` 把两个 `tool_use` 原样交给方言,`provider/openai.ts` 据此发出 `tool_calls: [a, b]`,而后面只跟一条 `{ role: "tool", tool_call_id: "a" }`。OpenAI 兼容端点要求每个 `tool_call_id` 都有对应的 `tool` 消息——本仓配的五家(kimi / deepseek / openai / zai / minimax)走的都是这条方言。所以**这一段会话再想续下去,第一个请求就是非法的**:`--resume` 它、或在同一段里 followUp,都撞这条。

不是并行引入的:改之前逐个 `await` 的循环里那句 `if (signal.aborted) break` 是同一个形状。并行之后多了一条同源的路径——同一批里某个 `runOneTool` 抛错(emit / hook 违约)时,排在它后面、**已经跑完**的那几个结果会被丢掉,`tool_use` 同样落单。

## 不拍板的代价

用户按一次 Esc,这段会话就可能续不了了——而症状是下一句话报一个 provider 400,没人会把它联想到上一次中止。本仓的规矩是「订阅方永远看不到缺一拍的事件流」(`agent.ts` 的终结事件合成)与「配对由结构保证,不靠外层补」([Run Loop 的四层](../../design/run-loop-layers.md) §2),**账本这一侧却没有同样的保证**。

## 选项

- **A. turn 收尾补齐。** 落地消息里每个没拿到结果的 `tool_use`,按出现顺序补一条 error toolResult(内容如「aborted before execution」),照常走 `message_end`——于是状态投影、session 账本、观测、压缩、UI 一次全对。代价:transcript 里多出模型没要求过的消息,但那与今天「被拒 / 执行失败」合成的 error 结果是同一类东西。
- **B. 投影时补齐。** `defaultConvertToLlm` 清点每条 assistant 消息的 `tool_use`,没配上的就地补一条 error 结果(内容如「No result provided」)。账本一个字不动。代价:直接读 transcript 的消费者(观测渲染、UI、压缩)看到的仍是不配对的账本;`convertToLlm` 可整体替换,换一份实现就得再写一遍这条规则。
- **C. A + B。** 账本补齐,投影再兜一道底(防外部写入的坏档)。
- **D. 不做,登记为已知限制。**

## 两条参考(都是事实,不是判据)

**本仓的先例更像 B。** [失败 attempt 的 assistant 消息留在 transcript,投影时丢](../implemented/2026-09-05-failed-attempt-in-transcript.md) 拍的就是这个形状:账本留住「那次 provider 挂了」这个事实,`convertToLlm` 负责别送回去,理由原话是「与压缩『transcript 全量原文、送模前投影』同一口径」。那条也接受了「过滤住在一个可替换的扩展点里」这个代价。

**pi 的做法是 B,而且在生产里跑着**(2026-09-07 读源,`~/Code/pi`;pi 是另一条血脉,只作参考不作依据)。它的 agent / session 层与本仓一样:中止后 `break`,剩下的 tool call 没有事件、没有结果、在会话文件里落单,整层没有任何清点步骤。补齐发生在**构造 provider 请求**那一层(pi 的 `ai` 包里那个 `transform-messages` 模块;这里不写全路径,那是另一个仓的路径,写了会被本仓的 filerefs 门当成死链):按 assistant 逐条清点 pending 的 tool call id,没配上的插一条 `"No result provided"`、`isError: true`,六条 provider 路径全都调它。它多一条讲究:`stopReason` 是 error / aborted 的 assistant 消息**整条丢掉**、压根不登记 pending——所以流中途中止不需要补,只有「消息完整、工具批被砍断」才补,正好是本条描述的场景。反过来,pi 下一代 harness 的**规格文档**写的是「计划中的 tool call 给一个 aborted 错误结果」(往 A 走),但那只是规格,代码里没有对应实现。

## 决定

**B**(2026-09-07 用户拍板;记录里一度写过倾向 A,被上面两条推翻)。理由是**口径一致**:本仓已经拍过「账本记真实发生的事、送模前投影」,失败 attempt 与压缩都在这条线上;orphan 的账本状态本身是真实的——模型确实要了三件、确实只跑了一件,往账本里塞一条它没收到过的结果反而是在记一件没发生的事。

A 还剩一条没被驳倒的理由:`Agent.convertToLlm` 是公共可替换字段,把「请求必须合法」这条不变量放进缺省实现,换一份实现就悄悄丢了。但失败 attempt 那条已经接受了同样的代价,再为这一条单开一种口径就是两套规矩。

落点:`defaultConvertToLlm` 里的 `healOrphanToolUses`——按 assistant 逐条登记 `tool_use` id,配上的划掉,欠账在**下一条 assistant 或下一条真正的 user 消息之前**、以及会话末尾结清,补出来的是 `is_error: true` 的 `tool_result`,随后由 `mergeAdjacentToolResults` 并进同一条 user 消息。`stopReason === "error"` 的 assistant 在 `projectOne` 里已整条隐形,它的 `tool_use` 不登记也就不补——与 pi 的「错误 assistant 不登记 pending」同一个效果。

**相邻的那一条,当天就拍了**:本条上线时 `stopReason === "aborted"` 的 assistant 消息还**不**被投影丢掉(只有 `error` 丢),于是它若带 `tool_use`,这次补齐会给这条半截回复补上结果再送回去。同日([失败 attempt ⋯ 投影时丢](2026-09-05-failed-attempt-in-transcript.md) 的「2026-09-07 修订」)把丢弃范围扩到 `error | aborted`,`aborted` 的消息因此在 `projectOne` 里就整条隐形,不再进到这里登记 pending。

## 验收

一条测试:一条 assistant 消息带三个 `tool_use`,第一个工具在执行中 `abort()`。

拍 B 时:`defaultConvertToLlm` 的输出里,每个 `tool_use` 都有配对的 `tool_result`,补出来的两条标 `isError`;**transcript 不变**(仍只有一条 toolResult)。同批某个工具抛出内部错误时同样成立。

拍 A 时:transcript 里 toolResult 的 `toolCallId` 集合等于三个 `tool_use` 的 id 集合、顺序一致、后两条标 error;投影自然配对,不另加过滤。
