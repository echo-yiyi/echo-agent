// 提问（2026-09-05 用户拍板）：模型菜单上的一件工具 `ask_user`——模型有事要人拍板，问出来、等人答、
// 同一轮接着跑。**与权限询问是两条路**：权限是壳子在执行前拦截工具调用的工程机制，模型不知道有这回事；
// 提问是模型主动调的工具。两者只共用「壳子摆出来、人来答」这一层，各自一套事件与回答口，不互相改造。
//
// 形状照 `permission/types.ts` 复刻：ask 有 ID、宿主只引用 ID 回答、回答结果 accepted / stale / closed 三分。

/** 一个候选项。`label` 是回答里回给模型的那个词，要能望文生义。 */
export type QuestionOption = Readonly<{
  label: string;
  description?: string;
}>;

/** 一次正在等人的提问。壳子从 `question` 事件或 `pendingQuestions` 拿到它。 */
export type QuestionAsk = Readonly<{
  questionId: string;
  toolCallId: string;
  question: string;
  options: readonly QuestionOption[];
  multiSelect: boolean;
}>;

/**
 * 可信宿主的回答：选了哪些（按 `label`）、或自由文本，至少给一样。
 * 只引用 ID——同权限那边一样，不能夹带别的东西把问题换掉。
 */
export type QuestionAnswer = Readonly<{
  questionId: string;
  selected: readonly string[];
  text?: string;
}>;

/** `answerQuestion()` 的结果：accepted = 这次回答被收下；stale = 不认识的 id；closed = 早已封口（答过 / 超时 / 中止 / 收摊）。 */
export type QuestionAnswerResult =
  | Readonly<{ kind: "accepted"; questionId: string; toolCallId: string }>
  | Readonly<{ kind: "stale"; questionId: string; reason: "unknown" }>
  | Readonly<{ kind: "closed"; questionId: string; reason: "answered" | "timed-out" | "run-aborted" | "runtime-disposed" }>;

/** 一次提问的最终结算：工具据此给模型回话。 */
export type QuestionSettlement =
  | Readonly<{ kind: "answered"; selected: readonly string[]; text?: string }>
  | Readonly<{ kind: "unanswered"; reason: "no-responder" | "timed-out" | "run-aborted" | "runtime-disposed" }>;

/** 账本登记一次提问后交回的把手：`settled` 恰好 fulfill 一次（答了 / 超时 / 中止 / 收摊），绝不 reject。 */
export type QuestionAskHandle = Readonly<{
  questionId: string;
  ask: QuestionAsk;
  settled: Promise<QuestionSettlement>;
}>;

/**
 * Agent 构造期收的配置（`AgentOptions.questions`）。
 *
 * `responder:"host"` = 宿主会 `subscribeLifecycle()` 收 `question` 再 `answerQuestion()`；
 * `responder:"none"` = 诚实缺席（管道 / CI）：工具当场回「没人能答」，不生成 ask、不等人。
 * 不给 = `none`——库用法里没人坐在终端前是常态。`askTimeoutMs` 缺省 `null`（等人，不超时）。
 */
export type QuestionPolicy = Readonly<{
  responder: "host" | "none";
  askTimeoutMs?: number | null;
}>;
