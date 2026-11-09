# 观测白盒化：每个切点上「走了哪条路、用了什么、因为谁」都能从账本里找到

> 状态:proposed → **拍板 2026-11-08,分期实施中** · 提出 2026-11-03 · 来源:用户 2026-11-03「我们的观测，就是要把 agent 的整个过程白盒化，就是要在这些切点去看这些问题」「我们要守住，观测不影响 agent」;2026-11-08「现在观测没有把记忆这些做好诶，感觉我还是看不到prompt这些」→「按推荐的做，先推基线再做 A」<br>
> **进度**:A1(= P1:上下文镜像、`prompt.assembled`、`context.built` metadata 档、实际菜单、cache tokens、压缩判断与压缩调用入账)、A2(= P2:正文存储、`content` 档的 system / 视图 / 工具 schema 原文、过期清扫、`readBlob`)已实现,见下方「决定」;A3(面板)、B(记忆)未做。全部落地后本条移进 `implemented/`<br>
> 形态的家是 [观测:一次 run 留下的账本](../../design/observability.md);本条只写取舍与要补的清单,实现合入时形态并进那篇。

## 导读

**给谁看。** 要拍板的人,与实现它的 agent。假设已读设计文档 §2–§5(envelope、两条 lane、三档、观测线程)与 [观测不进主流程](../implemented/2026-09-14-observation-off-main-loop.md)。

**解决什么。** 今天的账本记了「发生了什么」的骨架(run / reply / turn / attempt、模型输出、工具调用),但三类东西看不见:

1. **上下文**:每次调模型时送进去的 system prompt、消息视图、每轮注入、工具菜单——内容、构成、各块大小,一样都没有(§3)。
2. **决定**:代码里有分支判断、账本里看不出走了哪条的位置,盘出来 80 处以上:输入被拒、hook 改写、权限的真实来源、为什么不再重试、压缩为什么没触发、提取为什么跳过……(§5)。
3. **因果**:所有记录的 `correlation` 都是空的;能力事实不带 `toolCallId`;热重载、手动压缩、后台子 agent 产生的 run 链不回触发它的地方(§6)。

**最终形态。** 每个切点能只凭账本回答三个问题——**走了哪条路**(决定 + 原因码)、**用了什么**(输入的构成与大小;`content` 档能逐字节重建送给模型的上下文)、**因为谁**(链回触发它的 run / 工具调用 / 消息)。做法的核心是 §2:**观测线程维护一份上下文镜像,主线程每次只交增量**——这是在「白盒」与「不影响 agent」之间唯一不打架的路。

**Non-Goals(已决,不做)。**

- **不为观测改 agent 的任何行为、分支、时序。** 盘点时顺带发现的 agent bug(§10)另起修复,不混进这条线。
- **不在主线程做任何与上下文总长成正比的事**:不哈希、不估 token、不 `JSON.stringify`、不深拷贝、不每次交整份上下文(§2)。
- **不订阅事件协议、不往协议里加成员**(沿用 2026-09-11)。
- **不记 provider 线上请求体的原始字节**:请求体只在方言内部存在、每次重建(MB 级)。记的是方言之前的上下文(可重建)加方言做了哪些调整(§3.4)。
- **自定义 `convertToLlm` / `transformContext` 下不承诺逐字节重建**:只记构成、改没改、标记来源。
- **不脱敏**(沿用):`content` 档明文落盘。
- **不做跨会话的合并账本**:各会话一份,合并在读面(已有)。

**决定(2026-11-08 拍板,用户:「按推荐的做」;原「待拍板」五条,全部按推荐)。**

1. **上下文镜像**(§2.2):做。实现与提案的差异见下方「A1 落地时定的」。
2. **正文存储加 blob**(§4):做(存储格式改动,已获同意)。A2。
3. **prompt 段记下注册者**(§3.2):做。宿主自带的 registry 给每个 Fiber 一份绑定了它 entryId 的视图(`FOR_ENTRY`,内部约定);段的注册者按段对象身份记在段表旁(`promptSectionOwners`),替代层记替代者。
4. **诊断入账**(§7):做,排在 A、B 之后。
5. **分期**(§9):做,但**按用户要看的东西重排**:A「看得到 prompt」= P1 + P2 + 面板里上下文那部分;B「记忆看得清」= §5 记忆那一行 + 记忆写入的正文进 `content` 档 + 面板的记忆时间线;其余(决定点、因果、诊断)排在后面。

**A1 落地时定的(与提案文字的差异,实现为准)。**

- **视图不按对象身份逐条镜像**:压缩摘要与工具结果占位每个 attempt 都是新造的对象,按身份镜像会让主线程交出的字节随「被清掉的结果条数」增长。改为:transcript 按消息编号交(消息与其余对象分两个编号空间,只增的 transcript 压成几段连续编号)、压缩状态按对象交,观测线程用**同一个** `buildWorkingMessages` 重建视图;hook 改过视图时才按给出的顺序逐条交(`ContextHandoff.view` 的 `rebuild` / `explicit` 两种写法)。
- **投影的增删**:不在 `messages.ts` 加计数(那会进公共面)。观测线程对重建出的视图再跑一遍 `defaultConvertToLlm` 得出送出条数、丢弃条数、补出的落单结果数;合并相邻工具结果不单独计。自定义投影只记「是自定义」。
- **`calibration` 不进 `context.built`**:它住在压缩簿记里,attempt 那一刻拿不到;压缩判断那条(`context.compact.evaluated`)带着它。
- **压缩阶段自己的模型调用**记成 `context.built`(`purpose: "compaction"`、带阶段名),与循环的 attempt 同一条记录、同一个镜像;生成的正文仍只在压缩结束那条里。
- **镜像不淘汰**:观测线程里的镜像随 runtime 收摊才丢,内存与本进程交过的上下文同量级。实测有压力再加淘汰。

**A2 落地时定的(与 §4 文字的差异,实现为准)。**

- **引用沿用已有的 `ObservationBlobRef`**(`{ digest, size, mediaType? }`,公共类型里早就定了形、注明「CAS 接线在 O3b」),不另造 §4 写的 `{ blob, bytes }`——一个概念一个类型。`mediaType` 说怎么读:`text/plain` 原文、`application/json` canonical JSON、`OBSERVATION_BLOB_REFS` 引用列表。
- **文件内容是 `{ schemaVersion: 1, writtenAt, text }`**,不是裸的 canonical JSON 值:`StorageDir` 只写字符串,`writtenAt` 给清扫用(下一条)。`digest` 只覆盖 `text`。
- **清扫加宽限期**:§4 的「扫剩下的批、其余删掉」和活着的写者并排跑会删掉「已写、引用它的批还没提交」的 blob,而那正是先写 blob 后提交留下的空当。改为:没被引用且 `writtenAt` 早于此刻减 24 小时才删;写入端对仍在引用的正文每小时重写一次(刷新 `writtenAt`)。清扫只在过期真删了东西之后跑。
- **视图存成引用树,记录里只有一个引用**:§3.3 的 `view?: BlobRef[]` 逐条进记录,一万条消息就超 64 KiB,且每个 attempt 重写一整份清单、盘上随 attempt 数平方增长。改为每 64 条一块、块再成列表;transcript 只增,前面的块 digest 不变、不重写。工具菜单整份一个 blob(菜单很少变)。`context.built` 的 `content` 是 `{ system, view, tools }`。
- **`prompt.assembled` 的原文走通用的投影 `blobs` 声明**(descriptor 只在 `content` 档给;别的档观测线程不建写入端、不写):这一档每个 run 多一次把 system 串交给观测线程(与 `context.built` 第一次交的是同一份正文,盘上只有一个文件)。B 的记忆写入正文走同一条路。
- **还原函数先不公开**:[`readContextContent`](../../../packages/core/src/observability/context-mirror-host.ts#symbol=readContextContent) 在 core 内部,公开面只加 `readBlob(ref)`(`EchoObservations` / `EchoObservationReader`)与 `OBSERVATION_BLOB_REFS`;面板要用时(A3)再定从哪导出。

**验收判据(机器可判)。**

- **重建**:`content` 档跑一组脚本化 run(含压缩、每轮注入、工具、重试、子 agent),只凭账本 + blob 重建每个 attempt 的 `{ systemPrompt, 工作视图消息, 工具菜单 }`,与测试用 `streamFn` 截获的入参**逐项深相等**。
- **构成**:`metadata` 档每个 attempt 一条 `context.built`,各块字符数之和等于截获入参对应部分的长度。
- **开销**:transcript 10 条与 10,000 条两组对照,单个 attempt 主线程交给观测线程的字节数**不随 transcript 长度增长**(只随本次新增的对象增长)。
- **决定点**:一张「切点 → 原因码」对照表(§5),每一行一个触发它的测试,断言账本里有那条带原因码的记录。
- **反证**:每个新探针去掉 → 对应测试红。

---

## 1. 白盒的判据

一个切点算「看得见」,要求账本(加 `content` 档的 blob)能回答:

| 问题 | 账本里要有的 | 今天 |
|---|---|---|
| 走了哪条路 | 一条带**原因码**的记录:放行 / 拒绝 / 跳过 / 降级 / 改写,以及为什么 | 大量分支只有诊断通知(不进账本)或什么都没有 |
| 用了什么 | 输入的构成与大小;`content` 档能还原输入本身 | 只有模型**输出**与入账消息;送进模型的东西一样没有 |
| 因为谁 | `correlation` 与 scope 指回触发它的 run / 工具调用 / 消息 | `correlation` 恒空;能力事实无 `toolCallId` |

原因码是**封闭集合**,每类切点一个联合类型,在类型里登记(沿用 `ObservationGapReason` 的做法)——新增原因要改类型,不许塞自由字符串。

## 2. 守住「观测不影响 agent」

### 2.1 承重约束

**DO**

- 探针只交**已经存在的值的引用**,与 O(块数) 的计数(块数 = 段数、工具数、本次新增的消息数,都是几十的量级)。
- 正文按**对象身份**去重:同一个对象,一个进程里只交给观测线程一次(§2.2)。
- 哈希、估 token、算大小、写 blob、拼重建视图,**全在观测线程**。
- 超出探针预算的部分降级成计数 + `*Omitted` 标记,不截在半路、不报错。
- 每个新探针配一条**开销测试**:主线程交出的字节数与上下文总长无关。

**DON'T**

- 探针里 `await`;在主线程哈希 / 估 token / `JSON.stringify` / 深拷贝。
- 每次调模型都交整份上下文(transcript 可达百万 token 级,MB 级字节)。
- 为了让观测拿到数据而改 agent 的分支、返回值或调用顺序。
- 观测侧的任何失败外溢成 agent 的异常、通知或延迟(沿用 2026-09-15)。

### 2.2 上下文镜像:主线程只交增量

盘点出的事实让这件事可行:

- **system prompt 每个 run 只组装一次**([`Agent.createContextSnapshot`](../../../packages/core/src/agent.ts#symbol=Agent.createContextSnapshot)),本 run 所有 turn、attempt 复用同一个字符串。
- **transcript 只增不减**,每个 run 浅拷贝一次数组,元素对象跨 attempt、跨 run 是同一批引用;而且每条消息入账时**已经**作为 `agent.message.appended` 交给过观测线程。
- **工作视图每个 attempt 重建**([`buildWorkingMessages`](../../../packages/core/src/compaction/view.ts#symbol=buildWorkingMessages)),但元素大多复用 transcript 的对象;新对象只有压缩摘要消息、工具结果占位、每轮注入。

所以:

```ts
// 主线程(探针侧):一张 WeakMap,对象 → 本进程内的镜像 id。新对象才交正文,旧对象只交 id。
type MirrorRef = number;
interface ContextMirrorHandoff {
  /** 已交过就返回旧 id;没交过就分配新 id,并把这个对象(引用)放进本次的增量里。O(1)。 */
  refOf(obj: object): MirrorRef;
}

// 交给观测线程的一次增量:几十个 id + 本次新出现的对象。与 transcript 总长无关。
type ContextBuiltHandoff = Readonly<{
  attempt: number;
  view: readonly MirrorRef[];          // 工作视图(注入、hook 之后)按顺序的 id
  tools: readonly MirrorRef[];         // 实际菜单(isModelVisible 之后)按顺序的 id
  fresh: readonly Readonly<{ ref: MirrorRef; value: unknown }>[]; // 本次第一次见到的对象
  hooks: Readonly<{ transformContext?: "kept" | "replaced"; contextBeforeBuild?: "kept" | "patched" }>;
  converter: "default" | "custom";
}>;
```

`view` 是 id 数组,长度等于视图条数——O(n) 次 WeakMap 查找。这是唯一与视图长度相关的开销,量级是微秒(千条消息);数组本身不拷消息内容。若实测超出预算,退路是:transcript 前缀用「到第 k 条」一个整数表示,只把非 transcript 的对象(摘要、占位、注入)列成 id。两种表示观测线程都能还原。

观测线程侧拿到增量后:按 id 更新镜像,算各块大小与 token 估算,`content` 档把新对象写 blob(§4),写出一条 `context.built` 记录。**会话续上**时,第一次 `context.built` 会把续回来的 transcript 整份作为 `fresh` 交一次——一个进程只发生一次。

**`metadata` 档同样交新对象的值**,只是观测线程不把它写进 blob。理由:token 估算要与压缩用的是同一个函数(`compaction/view.ts` 的 `estimateMessage`:文本按长度、图片按尺寸、`tool_use` 按参数 JSON),在观测线程拿值重算,两边的数天然一致;而新对象的拷贝量等于本次新增内容,与上下文总长无关,仍在 §2.1 的约束内。若 P1 实测要更省,退路是新对象只交各块长度与图片尺寸。

## 3. 上下文:记什么

### 3.1 现状

送模型的那一刻在 [`runAttempt`](../../../packages/core/src/loop/run-turn.ts#symbol=runAttempt):按压缩状态投影 transcript → 拼每轮注入 → `transformContext` → `contextBeforeBuild` hook → `convertToLlm` → `streamFn({ systemPrompt, messages, tools: toolSchemas(tools) })`。这一段一个探针都没有。system prompt 在 [`assembleSystem`](../../../packages/core/src/prompt/assemble.ts#symbol=assembleSystem) 组装,也不接观测;段渲染失败只发一条 `[prompt_section_failed]` 通知。类型里留着的 [`TurnWorksetObservation`](../../../packages/core/src/observability/types.ts#symbol=TurnWorksetObservation) 的 `promptSources` / `hooks` 恒空。

### 3.2 `prompt.assembled`:每个 run 一条

```ts
type BlobRef = Readonly<{ blob: string; bytes: number }>; // §4

type PromptAssembledBody = Readonly<{
  sections: readonly Readonly<{
    name: string;
    order: number;
    owner: string | null;        // 注册它的 extension entryId(待拍板 3);内建写 "echo:<名>"
    status: "rendered" | "empty" | "failed";
    chars: number;               // empty / failed 为 0
  }>[];
  variables: readonly string[];  // 用到的变量名(值不记:值就在正文里)
  chars: number;                 // 拼接后总长
  // content 档:text 的 blob 引用
  text?: BlobRef;
}>;
```

段的 `chars` 在主线程算——每段一次 `.length`,O(段数)。估 token 在观测线程。

### 3.3 `context.built`:每个 attempt 一条(在 `streamFn` 之前)

为什么按 attempt 不按 turn:撞窗应急压缩会在同一 turn 的两次 attempt 之间改视图。

```ts
type BlobRef = Readonly<{ blob: string; bytes: number }>; // §4

type ContextBuiltBody = Readonly<{
  attempt: number;
  system: Readonly<{ promptSeq: number; chars: number }>;   // 指向本 run 的 prompt.assembled
  parts: readonly Readonly<{
    kind: "transcript" | "summary" | "cleared_placeholder" | "injection" | "hook_inserted";
    source?: string;             // injection:"skill:<name>" / "tasks";transcript:role
    count: number;
    chars: number;
    tokens: number;              // 观测线程用与压缩同一个估算器算
  }>[];
  tools: Readonly<{ count: number; schemaChars: number; tokens: number; names: readonly string[] }>;
  hooks: Readonly<{ transformContext?: "kept" | "replaced"; contextBeforeBuild?: "kept" | "patched" }>; // 与 §2.2 的增量同形
  converter: Readonly<{ kind: "default" | "custom"; dropped: number; healedOrphans: number; mergedToolResults: number }>;
  request: Readonly<{ model: string; thinkingLevel: string; maxOutputTokens: number | null }>;
  calibration: number;           // 此刻压缩用的 usage 校准比:tokens × calibration 才是压缩判断用的那个数
  // content 档:view 与 tools 的 blob 引用序列,可逐字节重建
  view?: readonly BlobRef[];
  toolSchemas?: readonly BlobRef[];
}>;
```

- `tools.names` 是**过滤之后的实际菜单**。今天 `turn.execute` 记的名单在 `isModelVisible` 之前,会混进不上菜单的内部工具——一并改正。
- `converter` 的三个计数:[`defaultConvertToLlm`](../../../packages/core/src/messages.ts#symbol=defaultConvertToLlm) 本来就逐条做这三件事(丢空 / 出错的 assistant、给孤儿 `tool_use` 补结果、合并相邻工具结果),在做的地方加计数顺手带出,不另扫一遍。

### 3.4 方言里的调整

请求体在方言内部成形(`provider/openai.ts`)。今天方言会静默做几件改变上下文的事:思考回放降级成正文或丢掉、非视觉模型省略工具图片、坏 chunk 跳过、解析不了参数的 `tool_use` 丢掉。补:

- `model.request.adjusted`:一次 attempt 一条,只在有调整时发,`{ thinkingDowngraded, thinkingDropped, imagesOmitted }` 计数。
- 流里的 `warning`(`bad_chunk` / `tool_call_dropped`)在 `metadata` 档投影出 `code`;今天两档都只有 `deltaType`。

### 3.5 顺手补齐的总量

- `model.usage` 补 `cachedInputTokens`(今天被丢);run 汇总与面板加 cache。
- 压缩:`context.compact.evaluated`,每轮判过一次就记 `{ used, window, target, goal, calibration, decision }`(`decision` 是封闭集:`no_stage` / `no_window` / `below_target` / `hook_blocked` / `run`)。压缩前的大小与预算今天在 [`compactionBudget`](../../../packages/core/src/compaction/pipeline.ts#symbol=compactionBudget) 算出来就丢了。
- 压缩生成摘要的那次模型调用([`modelCallFor`](../../../packages/core/src/compaction/pipeline.ts#symbol=modelCallFor))走同一组 `model.generate` / `model.retry.scheduled` 记录,挂在 `context.compact` span 下,计入 run 的模型汇总。

## 4. 正文存储:blob

**为什么要。** 单条记录 64 KiB([`OBSERVATION_SYNC_LIMITS`](../../../packages/core/src/observability/types.ts#symbol=OBSERVATION_SYNC_LIMITS)),正文实际上限 48 KiB。system prompt 带上项目指令、skills 目录、记忆段可达十万字符级;一条工具结果、一条消息都可能超。今天超了就截断或成缺口——逐字节重建做不到。

**形状。**

- 文件:`observability/blobs/<sha256>.json`,内容是一个 canonical JSON 值(字符串或消息对象)。
- 引用:`type BlobRef = Readonly<{ blob: string /* sha256 */; bytes: number }>`,出现在记录 body 里。
- **先写 blob,后提交引用它的批**:观测线程写完 blob(rename 完成)才把引用它的记录交给 Sequencer。不留悬空引用(2026-08-27 review 明禁)。
- 同一内容只存一份:跨轮、跨 run 复用的 system prompt、transcript 消息,天然去重。
- 只有 `content` 档写 blob;`metadata` 档一个都不写。

**过期。** [`expireObservations`](../../../packages/core/src/observability/expiry.ts#symbol=expireObservations) 删完 run 与批之后做一次标记-清扫:扫剩下的批,收集引用到的 blob,其余删掉。只凭盘上事实,与现有过期同一个前提;仍在产品的过期时机里跑,不进 agent 流程。

**读面。** reader 按引用取 blob;面板与 `observe show --body` 展开正文时才读。blob 缺失(被手动删了)显示为「正文已不在」,不判 corruption。

## 5. 决定点:要补的原因码

两份盘点合起来 80 处以上。按切点族归并成记录,每族一个封闭的原因码集合:

| 族 | 新记录 | 原因码(封闭集) | 今天在哪丢的 |
|---|---|---|---|
| 受理 | `agent.input.refused` `{ channel, reason }` | channel:`prompt` `continue` `steer` `follow_up` `deliver` `inbox_consume` `compact` `reload` `equip`;reason:`busy` `stopping` `disposed` `lease_lost` `not_ready` `no_active_turn` `no_active_run` `transcript_empty` `ends_with_assistant` `reconfiguring` `no_responder`… | `refuseWorkReason` 9 条、`continue()`、intake、`ingressGate`、`consumeInbox` 守卫、setter 拒绝 |
| admission | `admission.rejected` `{ reason }`;`run.accepted` 加 `waitedMs` | `paused` `stopping` `lease_lost` `closed_while_queued` | `admitUser` 关门、排队被清 |
| hook | `hook.decided` `{ hook, decision }`;`hook.failed` `{ hook, mode, cause }` | hook:`userPromptSubmit` `preToolUse` `postToolUse` `contextBeforeBuild` `stop` `preCompact`;decision:`block` `patch`(放行不记) | 改写前后、fail-open 的失败完全无痕(`onHookFailure` 没接线) |
| 模型 | `model.retry.stopped` `{ reason }` | `max_attempts` `not_retryable` `recover_used` `recover_failed` `aborted` | 为什么不再重试 |
| 工具 | `tool.rejected` 的 `cause` 细分;`tool.execute` 结束加 `crashed` `spilled` | lookup:`unknown` `unloaded` `disabled` `deferred` `not_yet_available` `not_visible`;permission:`policy` `responder_none` `no_subscriber` `invalid_verdict` `authorize_threw` `timeout` `cancelled` | 五种 not_found 合成一个;五种 deny 同为 `policy` |
| 压缩 | `context.compact.evaluated`(§3.5);span_end 加逐阶段结果 | 阶段:`applied` `no_change` `skipped_goal_met` `skipped_aborted` `failed`;应急:`recover_used` | 早退门、逐阶段裁决 |
| 记忆 | `memory.compose` 加 `reused: boolean`;`memory.extract.skipped` `{ reason }`;`memory.dream.evaluated` `{ layer, decision }` | 提取:`no_memory` `not_allowed` `no_scope` `no_modules` `overlap` `epoch_changed` `empty_range` `too_short` `too_few_turns` `aborted`;dream:锁、水位、间隔、写入数、轮数、文件数 | 提取 8 道门、dream 逐层门全无痕 |
| 子 agent | `run.accepted` 的 subagent source 加 `mode` `maxIterations` `seedMessages` `systemFrom` `backgroundId` | — | fresh/fork、预算、`bg-N` 链不回 |
| 收件 / 会话 / 定时 | `inbox.skipped` `{ reason }`;`session.woken` `{ result }`;`schedule.rejected` / `schedule.skipped` | 闸门 4 种、轮询跳拍、坏档、校验 6 种、重入跳拍、复核跳过 | 闸门拒绝到不了 inbox 账本 |
| extension | `extension.reload.completed` `{ reloadId, changes[] }` | change:`added` `removed` `replaced` `rolled_back` `lost` `unchanged` `skipped_stopping` `import_failed` | 没有总结论;import 失败只在 `Echo.diagnostics` |
| 生命周期 | `agent.phase.changed` 加 `cause`;`session.write.failed` | stop:`requested` `handoff` `lease_lost`;start 失败原因 | 让位与正常停止同为 `→stopping` |

规矩:**放行不记,只记偏离常规路径的那一支**(拒绝、跳过、降级、改写、放弃)——放行已经由后面那条正常记录证明了。例外是压缩评估:它每轮都判,判的结果本身就是要看的数据。

## 6. 因果:链回去

| 链 | 今天 | 补 |
|---|---|---|
| 能力事实 → 工具调用 | scope 只有此刻的 runId / turnId | 工具执行上下文带 `toolCallId`,能力模块经 ctx 显式拿到、写进 scope。**不用 AsyncLocalStorage**:主线程开销与并行工具下的不确定性 |
| 派生的 run → 触发者 | 热重载、手动 `/compact` 是 `source: user` | `correlation.causationId` 写触发它的 recordId;source 加 `trigger`(`reload_tool` / `compact_command` …) |
| run → 消费的消息 | `source: { kind: "inbox" }` 只有 kind | 加 `reservationId` 与 `recordIds` |
| 后台子 agent / 任务 → 回执 | inbox ref 是 `bg-N`,子 run header 里没有 | header 加 `backgroundId`;`agent.resource.changed` 加 `toolCallId` |
| 跨会话发送 → 接收 | 发送方 `metadata` 档没有 ref | `tool.execute` 结束在 `metadata` 档带 `ref` / `recordId`(是标识,不是正文) |
| schedule 投递 → inbox 记录 | 只能按值配对 | `schedule.delivered` 带 inbox `recordId` |

`correlation.links` 统一写「由谁引起」的那一条边,读面据此画因果图。

## 7. 诊断入账

`reportDiagnostic` 今天只变成一条 hook 通知;`createEcho` 的另一部分诊断只进 `Echo.diagnostics` 数组——两条都不进账本。补:每条诊断同时成一条 `agent.diagnostic` 记录,`metadata` 档 `{ code }` 加消息摘要,`content` 档带消息原文。

**与 2026-09-15「观测出问题不往外报」不冲突**:那条说的是观测**自己**的失败不往 agent 报;这条是 agent 的诊断往账本里记,方向相反。

## 8. 读面

- 面板每次模型调用一条**上下文构成条**:按 §3.3 的 `parts` 堆叠各块 token 占比(system 各段 / 工具 / 历史 / 摘要 / 注入 / 本次输入),点开看段清单与 hook / 转换的改动;`content` 档点块看正文。
- run 头部显示 `prompt.assembled` 的段清单。
- 决定点记录在时间线上显示原因码的人话(术语表登记);因果边可点跳。
- `observe show --context <run-id>`:文本形态的构成表。

界面形态按 echo-design 另做,本条只定它读什么。

## 9. 分期

| 期 | 内容 | 本期验收 |
|---|---|---|
| P1 | 上下文镜像(§2.2)+ `prompt.assembled` + `context.built`(metadata 档)+ 实际菜单 + cache tokens + 压缩评估与摘要调用入账 | 构成测试、开销测试、菜单与截获入参一致 |
| P2 | blob 存储 + `content` 档正文 + 过期清扫 | 重建测试(逐项深相等)、过期后无悬空引用 |
| P3 | §5 决定点 + `hook.failed` 接线 + §7 诊断入账 | 决定点对照表测试 |
| P4 | §6 因果 | 每条链一个测试:从派生记录走回触发者 |
| P5 | §8 读面 | 面板自检门、术语表覆盖 |

P1 做完先看开销测试的实测值,再定 §2.2 里两条退路要不要走。

## 10. 盘点时顺带发现、不在本线修的

这些是 agent 本身的问题,不是观测缺口。按 Non-Goals 第一条,另起修复,不混进观测的 PR:

1. **非视觉模型收到图片被当成网络错误重试**:方言在构造请求时本地抛错,被 [`classifyThrown`](../../../packages/core/src/provider/openai.ts#symbol=classifyThrown) 归成 `network`(可重试),白白重试到上限。
2. **hook 失败无处可去**:[`HookRuntime`](../../../packages/core/src/hooks/runtime.ts#symbol=HookRuntime) 支持 `onHookFailure`,Agent 构造时没传;fail-open 的 hook 失败完全无痕。(§5 的 `hook.failed` 需要先接上它。)
3. **`timeout` 错误码没有生产者**:provider 侧没有单请求超时,`timeout` 只在 run deadline 时出现。
4. **压缩摘要的 token 不计入 `_state.usage`**:用量统计少算。
