# 落单的 `tool_use`：中止之后没跑的那几个调用，transcript 里没有配对的结果

> 状态:proposed · 提出 2026-09-07 · **待拍板** · 来源 2026-09-07 [并行工具](../implemented/2026-09-07-parallel-tools.md) 实现时点出的既有缺口(不是它引入的)

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
- **B. 投影时丢掉落单的。** `defaultConvertToLlm` 过滤掉没有配对结果的 `tool_use` 块。代价:账本仍然是坏的,只是不给模型看;`convertToLlm` 可整体替换,换一份实现就得再写一遍这条规则;压缩的投影是另一条路,也要补。
- **C. A + B。** 账本补齐,投影再兜一道底(防外部写入的坏档)。
- **D. 不做,登记为已知限制。**

## 倾向

**A**。账本是会话事实的唯一真源,一个没有答复的调用在账本里就是错的,不是「送模时才需要处理」的事;补在 turn 这一层,配对由结构保证,与四层循环那条「每层只管自己的开与关」同一条规矩。B 把一条不变量挪进一个**可整体替换**的扩展点,与「一份逻辑一个数法」冲突。

真要拍 A,实现时三处别漏:同批里因抛错被丢掉的结果也算没拿到;补出来的结果要在**同一个 turn 内**入账(不能等到 run 收尾,否则 turn 事件已经关了);补的顺序按 `tool_use` 出现顺序,与并行批的入账顺序同一条规矩。

## 验收

一条测试:一条 assistant 消息带三个 `tool_use`,第一个工具在执行中 `abort()`;跑完之后 transcript 里 toolResult 的 `toolCallId` 集合等于三个 `tool_use` 的 id 集合,顺序一致,后两条标 error;`defaultConvertToLlm` 的输出里每个 `tool_calls` 项都有对应的 `tool` 消息。同批某个工具抛出内部错误时同样成立。
