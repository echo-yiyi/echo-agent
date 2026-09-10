// agent 定义（角色）：**产品内的一个角色**——identity 段、工具子集、模型缺省。
// 设计见 docs/design/sessions.md §4，决策见 docs/decisions/implemented/2026-09-07-role-agent.md。
//
// **产品不是 agent 定义**（2026-09-07 用户纠正）：一个 echo-coding 容器开出来的段全是 coding
// 方向，那是容器级的事；agent 定义是这个产品内部的 reviewer / 前端 / 缺省。
//
// **能替代什么是封闭的三项**：identity、tools、model。别的 prompt 段（纪律段、工具习惯段）
// 是产品对自己工具的承诺，角色换掉它们等于换了产品；权限策略同理，继承产品的。
// 真要开第四项，按 registry 那条规矩单独拍——不在这里悄悄加字段。

/**
 * 一份 agent 定义。三项**全都可选**：没给的那项产品原样生效。
 *
 * 这个对象会**整份**存进 session 的 meta（`AgentRef.definition`），从那一刻起它就是这段
 * session 的权威定义——`--resume` 不回头按名去找任何文件（那份文件可能已经改了、没了，
 * 而创建者可能早就 closed）。
 */
export type AgentDefinition = {
  /**
   * 替换产品的 `identity` 段（同名 `replace`，见 `AgentPromptRegistry.section`）。
   * 不给 = 产品的 identity 原样生效。
   */
  readonly identity?: string;
  /**
   * 工具子集。**必须 ⊆ 创建者当前的工具集**——这条在 `sessions.create` 里验，越权判红、
   * 盘上不建目录。不给 = 产品全套。
   *
   * `--resume` 时取「快照 ∩ 容器此刻能提供的」：只会更小。快照里有、容器没有的不挂也不报错
   * （同一份定义在装得少的容器里照样能开，只是能干的事更少）。
   */
  readonly tools?: readonly string[];
  /** 模型 id。不给 = 产品的缺省模型。 */
  readonly model?: string;
  /** 人读的一句话（frontmatter 的 `description`）。给清单看的，**不进 prompt**。 */
  readonly description?: string;
};

/**
 * session 挂的那份 agent 定义，**连同它的来历**。
 *
 * `name` 只是来历——按名建的记下名字，方便人在清单里认；现写（inline）的没有名字。
 * 权威永远是 `definition` 那份快照，不是名字：名字指向的文件随时可能变，而一段 session
 * 是什么不该在它跑着的时候被别人从盘上改掉。
 */
export type AgentRef = {
  readonly name?: string;
  readonly definition: AgentDefinition;
};

/** 缺省（产品原样，没有角色）。`--continue` 的老会话、容器自己开的段都是它。 */
export const DEFAULT_AGENT_REF: AgentRef = { definition: {} };

/**
 * agent 的名字能不能用（2026-09-10）。名字是身份：同名的 session 共用一份个人记忆，目录就是
 * `<ECHO_HOME>/agents/<名字>/`——所以它必须是一个干净的路径段：字母或数字开头，其后只有字母、数字、
 * `.`、`_`、`-`，最长 64。不在这里收紧的话，`a/b` 与 `a_b` 消毒后会落进同一个目录，两个身份悄悄合并。
 */
export function isValidAgentName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name);
}

/** `{ name?, definition }`（一份带来历的引用）还是裸的定义。两者只差 `definition` 这一个键。 */
export function isAgentRef(x: AgentDefinition | AgentRef): x is AgentRef {
  return typeof (x as { definition?: unknown }).definition === "object" && (x as { definition?: unknown }).definition !== null;
}

/** 这份定义有没有真的要改什么。全空 = 挂它等于不挂，`echo:inline-agent` 因此不必上场。 */
export function isEmptyDefinition(d: AgentDefinition): boolean {
  return d.identity === undefined && d.tools === undefined && d.model === undefined;
}

/**
 * 人读的名字，清单 / 诊断 / 报错共用这一份措辞：
 * 按名建的用名字；没名字但确实改了什么的是 `inline`；什么都没改的是 `default`（产品原样）。
 *
 * 三种说法必须分得开——`default` 与 `inline` 都没有名字，混成一个词的话，
 * 人在清单里就分不出「这段是产品缺省」和「这段挂了一份现写的定义」。
 */
export function describeAgentRef(ref: AgentRef): string {
  if (ref.name !== undefined) return ref.name;
  return isEmptyDefinition(ref.definition) ? "default" : "inline";
}
