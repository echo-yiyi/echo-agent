// observe 面板的术语表：后端枚举 → 界面文案只在这一处翻译。
//
// 条目四字段缺一不可：`zh` 主标签、`en` 原词（mono 小字并列显示）、`tone` 色调、`hint` **判定口径**（不是同义反复）。
// 页面通过 `lexiconJson()` 拿到整份，渲染层不再自己猜字面。

export type Tone = "neutral" | "accent" | "positive" | "caution" | "critical" | "info";

export type Term = Readonly<{ zh: string; en: string; tone: Tone; hint: string }>;

/**
 * run 的终态 / 进行态。`RunObservationStatus` 五值加一个派生值 `truncated`：
 * 设计系统要求「跑到上限被截断」与「自行收尾」严格区分，本仓里它是 `error` 且 `outcome.error.code === "max_iterations"`。
 */
export const RUN_STATUS: Readonly<Record<string, Term>> = {
  // 「running」是 RunIndex 里的原值：run.accepted 落了、run.closed 没落。离线读者只知道它没封口，不知道进程还在不在
  // （2026-09-06 用户定：agent 停没停不由观测判断），所以给人看的词是「未收尾」，不说「进行中」；页面仍会持续刷新它。
  running: { zh: "未收尾", en: "running", tone: "neutral", hint: "没有终态记录：可能还在跑，也可能进程没了——账本只知道它没封口" },
  completed: { zh: "已完成", en: "completed", tone: "positive", hint: "agent 自行收尾，run.closed 已 COMMIT" },
  truncated: { zh: "已截停", en: "truncated", tone: "caution", hint: "跑到迭代上限被截断、未自行收尾——产出可能不完整（error code = max_iterations）" },
  aborted: { zh: "已中止", en: "aborted", tone: "neutral", hint: "用户或宿主主动 abort；已产出的部分保留" },
  error: { zh: "失败", en: "error", tone: "critical", hint: "provider / 工具 / 内核的不可恢复错误；outcome.error.code 说明是哪一类" },
  interrupted: { zh: "已中断", en: "interrupted", tone: "neutral", hint: "进程崩溃后由下一次持锁启动封口的 run；它自己没有结局" },
};

export const RUN_SOURCE: Readonly<Record<string, Term>> = {
  user: { zh: "用户", en: "user", tone: "neutral", hint: "prompt / continue / 管道输入发起" },
  dream: { zh: "整理", en: "dream", tone: "info", hint: "agent 空闲时自动排的记忆整理，用隔离 transcript，不进主对话" },
  inbox: { zh: "收件", en: "inbox", tone: "info", hint: "Schedule / 外部投递进 inbox 后由 agent 自行消费的一批" },
  extension: { zh: "扩展", en: "extension", tone: "info", hint: "Extension 提交的 run（O2b）" },
};

/** 一条 reply 是被什么开出来的（四层循环，`docs/design/run-loop-layers.md`）。 */
export const REPLY_SOURCE: Readonly<Record<string, Term>> = {
  prompt: { zh: "用户输入", en: "prompt", tone: "neutral", hint: "run 的第一条 reply：用户那句话" },
  follow_up: { zh: "追加输入", en: "follow_up", tone: "neutral", hint: "上一条 reply 跑完时队列里还有输入，接着开一条" },
  stop_hook: { zh: "钩子续跑", en: "stop_hook", tone: "info", hint: "stop hook 拦下收尾并注入了新输入，于是又开一条" },
  resume: { zh: "续跑", en: "resume", tone: "neutral", hint: "从 transcript 未完的地方接着跑" },
};

export const INTEGRITY: Readonly<Record<string, Term>> = {
  complete: { zh: "完整", en: "complete", tone: "positive", hint: "本 run 没有任何 canonical gap" },
  partial: { zh: "有缺口", en: "partial", tone: "caution", hint: "至少一条 observation.gap：缓冲溢出 / 编码失败 / 采集上限 / 落盘失败；缺的是记录，不是 agent 的产出" },
};

export const PERSISTENCE: Readonly<Record<string, Term>> = {
  stored: { zh: "已落盘", en: "stored", tone: "positive", hint: "run.closed 已 COMMIT 且读回可见" },
  degraded: { zh: "未落盘", en: "degraded", tone: "caution", hint: "封口那笔没写进 SQLite（writer 降级 / 到期）；agent 的 outcome 不受影响" },
};

/**
 * 工具名 → 人话动词（设计系统的动词表：读取 / 搜索 / 写入 / 记住 / 回忆 / 运行 / 请求 / 打开 / 修改 / 删除）。
 * 没登记的工具用「调用」+ 原名。`memory` 工具的动作（记住 / 修改 / 删除 / 回忆）在紧随其后的 `memory.mutation.*` 事实里，
 * 工具 span 本身在 metadata 档看不到参数，所以只能是「调用」。
 */
export const TOOL_VERBS: Readonly<Record<string, string>> = {
  read_file: "读取",
  list_dir: "读取",
  job_output: "读取",
  TaskList: "读取",
  TaskGet: "读取",
  schedule_list: "读取",
  glob: "搜索",
  grep: "搜索",
  tool_search: "搜索",
  write_file: "写入",
  TaskCreate: "写入",
  schedule_create: "写入",
  edit_file: "修改",
  TaskUpdate: "修改",
  bash: "运行",
  job_stop: "删除",
  schedule_cancel: "删除",
};

/** canonical record 名 → 时间线一行怎么念。没登记的用原名（设计系统：未知事件用 generic 呈现，不丢）。 */
export const RECORD_TERMS: Readonly<Record<string, Term>> = {
  "run.accepted": { zh: "接受 run", en: "run.accepted", tone: "neutral", hint: "admission 分配 runId、冻结模型绑定" },
  "run.assembly": { zh: "装配快照", en: "run.assembly", tone: "neutral", hint: "本 run 冻结的 builtin 槽与模型绑定 digest" },
  "run.started": { zh: "开始执行", en: "run.started", tone: "neutral", hint: "executor 进入 loop" },
  "run.closed": { zh: "封口", en: "run.closed", tone: "neutral", hint: "业务 outcome 冻结后落的终态记录" },
  "agent.loop.started": { zh: "循环开始", en: "agent.loop.started", tone: "neutral", hint: "agent_start" },
  "agent.loop.ended": { zh: "循环结束", en: "agent.loop.ended", tone: "neutral", hint: "agent_end，attributes.status 是 outcome" },
  "agent.message.appended": { zh: "消息入账", en: "agent.message.appended", tone: "neutral", hint: "非 assistant 消息进 transcript（用户 / 工具结果 / 环境）" },
  "reply.execute": { zh: "回应", en: "reply.execute", tone: "neutral", hint: "对一条输入的完整回应，可含多轮；一个 run 只有一条时不单独占行" },
  "turn.execute": { zh: "轮", en: "turn.execute", tone: "neutral", hint: "一次模型调用 + 其工具调用；iteration 是第几轮" },
  "attempt.execute": { zh: "尝试", en: "attempt.execute", tone: "neutral", hint: "turn 里的一次模型请求；重试就是同一 turn 的下一个 attempt，只跑了一次时不单独占行" },
  "model.generate": { zh: "模型生成", en: "model.generate", tone: "neutral", hint: "一次 provider 调用；span_end 带 stopReason / usage" },
  "model.usage": { zh: "用量", en: "model.usage", tone: "neutral", hint: "provider 回报的 token 数" },
  "model.retry.scheduled": { zh: "重试", en: "model.retry.scheduled", tone: "caution", hint: "provider 出错后内核安排的重试，attempt / cause" },
  "tool.execute": { zh: "工具", en: "tool.execute", tone: "neutral", hint: "一次工具执行；isError 是工具结果的成败，不是 run 的" },
  "context.compact": { zh: "上下文压缩", en: "context.compact", tone: "neutral", hint: "上下文被压缩——agent 忘掉了一部分" },
  "memory.mutation.committed": { zh: "记忆已写", en: "memory.mutation.committed", tone: "positive", hint: "create / replace / insert / delete / rename 成功落盘；indexOutcome 说索引重建结果" },
  "memory.mutation.rejected": { zh: "记忆拒写", en: "memory.mutation.rejected", tone: "caution", hint: "语义拒绝（越界 / 不存在 / 超预算），数据未变" },
  "memory.mutation.failed": { zh: "记忆写失败", en: "memory.mutation.failed", tone: "critical", hint: "主存储 I/O 抛错且数据未变，stage 说在哪一段" },
  "memory.mutation.partial": { zh: "记忆半提交", en: "memory.mutation.partial", tone: "critical", hint: "rename 目标已建、源删失败之类的半提交" },
  "memory.compose": { zh: "记忆入 prompt", en: "memory.compose", tone: "neutral", hint: "这次进 system 的模块数 / 块数 / 字符数" },
  "task.state.committed": { zh: "任务状态", en: "task.state.committed", tone: "neutral", hint: "内存清单已变（不等于已落盘）" },
  "task.store.saved": { zh: "任务已落盘", en: "task.store.saved", tone: "positive", hint: "真实 TaskStore.save() 成功" },
  "task.store.failed": { zh: "任务落盘失败", en: "task.store.failed", tone: "critical", hint: "真实 TaskStore.save() 抛错" },
  "schedule.created": { zh: "闹钟登记", en: "schedule.created", tone: "neutral", hint: "add 之后 save 成功" },
  "schedule.cancelled": { zh: "闹钟取消", en: "schedule.cancelled", tone: "neutral", hint: "cancel 之后 save 成功" },
  "schedule.delivered": { zh: "闹钟投递", en: "schedule.delivered", tone: "positive", hint: "到期投进 inbox 并被接受" },
  "schedule.missed": { zh: "闹钟错过", en: "schedule.missed", tone: "caution", hint: "重启补跑判定错过：过期删除或跳过欠账" },
  "schedule.bookkeeping-failed": { zh: "闹钟簿记失败", en: "schedule.bookkeeping-failed", tone: "critical", hint: "投递之后落盘失败，下次 tick 会再投" },
  "inbox.accepted": { zh: "收件", en: "inbox.accepted", tone: "neutral", hint: "一条投递进了 inbox 账本；via=refresh 是别的进程（另一段会话）写进来的" },
  "inbox.rejected": { zh: "收件被拒", en: "inbox.rejected", tone: "caution", hint: "账本没收：形状不对、空 key、落盘失败或账本已封" },
  "inbox.restored": { zh: "收件恢复", en: "inbox.restored", tone: "neutral", hint: "重启时从盘上恢复的、还没消费的那批" },
  "inbox.consumed": { zh: "收件消费", en: "inbox.consumed", tone: "info", hint: "这批消息交给了这条 run——它就是这次 run 的由头" },
  "inbox.acked": { zh: "收件已结", en: "inbox.acked", tone: "positive", hint: "run 之后整批 ack 落盘，不会再重投" },
  "inbox.released": { zh: "收件放回", en: "inbox.released", tone: "caution", hint: "整批放回队列：run 被拒、入队抛错或 ack 没提交，下次再投" },
  "inbox.sealed": { zh: "收件账本已封", en: "inbox.sealed", tone: "critical", hint: "ack 无法裁决，账本封了：之后一律拒收，要人来处理" },
  "agent.queue.updated": { zh: "队列变化", en: "agent.queue.updated", tone: "neutral", hint: "steering / followUp / inbox 队列长度" },
  "agent.resource.changed": { zh: "资源变化", en: "agent.resource.changed", tone: "neutral", hint: "工具 / skill / MCP 注册或卸载" },
  "agent.custom_event": { zh: "自定义事件", en: "agent.custom_event", tone: "neutral", hint: "上层 agent 的领域事件，metadata 档 body 恒空" },
  "observation.gap": { zh: "记录缺口", en: "observation.gap", tone: "caution", hint: "这段 seq 的记录没能进账本；reason 说为什么" },
};

/**
 * 时间线每行开头的类别记号。**按记录名前缀匹配，最长的前缀赢**；表在这里，与术语同一个出处。
 *
 * 为什么是文字记号而不是图标：设计系统的图标是 Lucide + 语义映射层（`spec/icons.md` §7），
 * 而这个面板是零外部资源的自足 HTML，拉不了图标库——那要先做 vendor 决策。
 * 而 `spec/agent-behavior.md` §2.3 规定工具条目本来就用文字记号（进行中 / 成功 `▸`、失败 `✕`），
 * 所以在这一处用文字记号是它认的做法。下面只在它之外补三个，且都从最通用的几何字符里挑，避免字体缺字：
 *
 * | 记号 | 给谁 | 为什么 |
 * |---|---|---|
 * | `▸` / `✕` | 工具执行 / 工具失败 | agent-behavior.md §2.3 逐字规定 |
 * | `◆` | 模型生成 | 一轮里最花时间的那件事，实心与工具的空心三角分开 |
 * | `◇` | 能力事实（记忆 / 任务 / 闹钟 / 收件） | 它们不是循环本身，是 agent 的能力留下的痕迹，归一类 |
 * | `⤓` | 上下文压缩 | 往下压 |
 * | `⚠` | 记录缺口 | 与警告同形 |
 * | `·` | 其余（循环开始 / 结束、消息入账、run 边界） | 只标记进度，不该有形状 |
 */
export const RECORD_MARKS: readonly (readonly [prefix: string, mark: string])[] = [
  // 容器（回应 / 轮 / 尝试）不给记号：它左边已经有折叠箭头，再来一个点是同一件事说两遍
  ["reply.execute", ""],
  ["turn.execute", ""],
  ["attempt.execute", ""],
  ["tool.execute", "▸"],
  ["model.generate", "◆"],
  ["memory.", "◇"],
  ["task.", "◇"],
  ["schedule.", "◇"],
  ["inbox.", "◇"],
  ["context.compact", "⤓"],
  ["observation.gap", "⚠"],
];

/** 记录名 → 类别记号；没有匹配就回落到 `·`。最长前缀优先，`tool.execute.progress` 不会被 `tool.` 抢走。 */
export function recordMark(name: string): string {
  let best = "·";
  let bestLen = -1;
  for (const [prefix, mark] of RECORD_MARKS) {
    if (name.startsWith(prefix) && prefix.length > bestLen) {
      best = mark;
      bestLen = prefix.length;
    }
  }
  return best;
}

export type Lexicon = Readonly<{
  runStatus: typeof RUN_STATUS;
  runSource: typeof RUN_SOURCE;
  replySource: typeof REPLY_SOURCE;
  integrity: typeof INTEGRITY;
  persistence: typeof PERSISTENCE;
  toolVerbs: typeof TOOL_VERBS;
  records: typeof RECORD_TERMS;
  /** 类别记号表，页面按最长前缀匹配（见 `recordMark`）。 */
  marks: typeof RECORD_MARKS;
}>;

export function lexicon(): Lexicon {
  return { runStatus: RUN_STATUS, runSource: RUN_SOURCE, replySource: REPLY_SOURCE, integrity: INTEGRITY, persistence: PERSISTENCE, toolVerbs: TOOL_VERBS, records: RECORD_TERMS, marks: RECORD_MARKS };
}
