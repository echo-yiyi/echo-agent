// 工具层。
//
// 两条判据：
//   ① 工具在**值层面**天然开放（多给一个实例就是扩展），所以没有 CustomAgentTools 类型扩展位。
//   ② **工具的本质是能力，谁调用是另一维** → ModelTool（模型经 tool_use 调）
//      与 InternalTool（harness 侧调：定时任务、改完文件自动 format、权限询问）。
//
// 铁律（继承自 v1，打过仗的）：**execute 绝不 reject**——abort/超时/错误一律 resolve 成
// error 结果，保 tool_use ↔ tool_result 配对。抛出会撕裂配对，模型下一轮就看到残缺历史。

import type { ImageBlock, ToolSchema } from "../messages.ts";

export type AgentToolResult<TMeta = Record<string, unknown>> = {
  /** 给模型看的正文（InternalTool 场景下给触发方看）。 */
  content: string;
  isError: boolean;
  images?: ImageBlock[];
  /** 只观测，**永不进模型**。从 v1 的裸 Record 升为具名泛型，堵掉零-any 逃逸口。 */
  metadata: TMeta | null;
};

export type ToolExecutionContext = {
  /** 本次调用的关联键：模型调用 = 模型给的 id；内部调用 = harness 生成的。 */
  readonly toolCallId: string;
  /** session 的工作目录：相对路径的起点，也是文件工具的边界（2026-09-01 起一个字段，归 session）。 */
  readonly workspace: string;
  readonly sessionId: string | null;
  readonly iteration: number;
  readonly signal?: AbortSignal;
  /** 执行中途上报进度 → tool_execution_update 事件（30s 的 bash 不再黑屏）。 */
  onUpdate?(partial: string): void;
};

type ToolBase<TParams, TMeta> = {
  /** 机器 id：循环与线上协议用。 */
  readonly name: string;
  /** 人读名：UI 用，**模型看不到**。三个读者三个字段，谁也不将就谁。 */
  readonly label: string;
  /**
   * 禁用原因。**有值 = 禁用中**（undefined = 能用）。
   *
   * 「能用 / 禁用」是**工具自己的状态**，所以它住在工具身上，不外挂一个 `ToolEntry`
   * 之类的包装（2026-08-05 用户拍定）。一个字段同时回答两件事：禁没禁、为什么禁——
   * 于是模型点到一个刚断线的 MCP 工具时，看到的是「服务器已断开」而不是含糊的「未知工具」。
   *
   * 三处联动：不进模型菜单（`activeTools()` 排除它）；执行时给**准确原因**；
   * 来源恢复时把它设回 undefined 即可，**不必重新注册**。
   */
  disabled?: string;
  /**
   * 延迟披露（2026-09-02 用户拍板）：**冷门工具标 true**——注册在池里、能被点名解析，但不上模型菜单，
   * 直到模型经 `tool_search` 取过它的 schema（下一轮起可调）。与 `disabled` 同一条规矩：状态住在工具身上，
   * 改缺省 = 改工具的定义；执行层只在 `visibleTools()` / `resolveTool()` 各看一眼这个字段。
   * 用途只有一个：schema 全塞进每轮请求会先把上下文吃掉，接了 MCP 之后工具一多这是唯一的止损。
   */
  readonly deferred?: boolean;
  execute(params: TParams, ctx: ToolExecutionContext): Promise<AgentToolResult<TMeta>>;
};

export type ModelTool<TParams = Record<string, unknown>, TMeta = Record<string, unknown>> = ToolBase<
  TParams,
  TMeta
> & {
  readonly kind: "model";
  /** 模型读的正文——**这是 prompt 资产，不是注释**。 */
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  /**
   * 抹平模型间出参怪癖：数字发成字符串、布尔发成 "true"、字段多包一层、漏引号。
   * 站在「provider 解出的 raw JSON → TParams」这道边界上。不提供 = 恒等 + 形状垫片。
   *
   * 类型用 TParams 而非 TypeBox 的 Static<TSchema>：内核零依赖是硬约束——
   * 上层尽可用 TypeBox 定义 schema、拿 Static 推出类型再喂进来，内核只认最终类型。
   * 抛错 → 循环兜成该次调用的 error 结果（工具作者可以放心 throw）。
   */
  prepareArguments?(raw: unknown): TParams;
};

export type InternalTool<TParams = Record<string, unknown>, TMeta = Record<string, unknown>> = ToolBase<
  TParams,
  TMeta
> & {
  readonly kind: "internal";
  // 没有 description/parameters：不投影给任何模型，一个 token 都不占。
};

/**
 * MCP 服务器提供的工具。**模型可见**，但带着来源身份。
 *
 * 为什么单独一个 kind 而不是塞进 ModelTool：产品要**按类型施加策略**
 * （禁用全部 MCP 工具 / MCP 工具一律先问人 / 服务器白名单）。有 kind 就是
 * `t.kind === "mcp"`；没有就得去 `source.startsWith("mcp:")` 猜字符串——脆，IDE 也帮不上。
 */
export type McpTool<TParams = any, TMeta = any> = ToolBase<TParams, TMeta> & {
  readonly kind: "mcp";
  /** 服务器给的描述。**半可信文本**——进模型上下文前必须消毒与限长。 */
  readonly description: string;
  /** 服务器给的 JSON Schema。 */
  readonly parameters: Record<string, unknown>;
  /** 哪个服务器（与 registry 的 source `mcp:<server>` 对应）。 */
  readonly server: string;
  /** 服务器上的原名（未加前缀）——callTool 用它。 */
  readonly remoteName: string;
};

export type AgentTool<TParams = any, TMeta = any> =
  | ModelTool<TParams, TMeta>
  | InternalTool<TParams, TMeta>
  | McpTool<TParams, TMeta>;

export function toolOk<TMeta = Record<string, unknown>>(
  content: string,
  metadata: TMeta | null = null,
  images?: ImageBlock[],
): AgentToolResult<TMeta> {
  const r: AgentToolResult<TMeta> = { content, isError: false, metadata };
  if (images !== undefined && images.length > 0) r.images = images;
  return r;
}

export function toolError<TMeta = Record<string, unknown>>(
  content: string,
  metadata: TMeta | null = null,
): AgentToolResult<TMeta> {
  return { content, isError: true, metadata };
}

/** 只判「原生模型工具」——需要 `prepareArguments` 的那条路用它。 */
export function isModelTool(t: AgentTool): t is ModelTool {
  return t.kind === "model";
}

/**
 * **模型能看见的工具**（进 schema 清单、可被模型点名的那些）。
 * 加新的模型可见种类时**只改这里**——别在各调用点各判各的。
 */
/**
 * tools 参数的唯一投影点。**按名排序**——tools 在请求最前面,它的字节一变,整个前缀缓存全灭;
 * 而注册顺序天然不稳定(MCP 异步连接,谁先连上谁先注册),所以确定性只能靠显式排序:
 * 同一个集合,永远同一个字节序列。排序用码元比较,不用 localeCompare(它随环境变)。
 */
export function toolSchemas(tools: readonly AgentTool[]): ToolSchema[] {
  return tools
    .filter(isModelVisible)
    .map((t) => ({
      name: t.name,
      // MCP 的 description 在 SDK 里是可选的;空描述的工具模型基本不会用,但不该因此崩
      description: t.description ?? "",
      input_schema: t.parameters,
    }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

export function isModelVisible(t: AgentTool): t is ModelTool | McpTool {
  return t.kind === "model" || t.kind === "mcp";
}
