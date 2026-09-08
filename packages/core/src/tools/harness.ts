// 工具的操作方法。
//
// **这个文件里全是方法,没有 interface、没有类、没有状态**（2026-08-05 用户拍定）:
// 数据是 agent 的（`agent.tools` 就是一个 `Map<string, AgentTool>`,装的是**工具本体**,
// 不是什么 `ToolEntry` 包装），这里只封装对它的操作。
//
// **工具与 skill 本质不同,不强行对称**（2026-08-04 用户拍定）:
//   skill 是**数据**（markdown + frontmatter）——上层扫盘产出 Skill[] 喂进来,所以它有加载器;
//   tool 是**代码**（实现 AgentTool 接口的对象）——上层写实现直接 register,**没有加载器**。
//   skill 有「激活」概念（正文进 prompt,要控体积）;tool 注册即可用。

import type { ToolSchema } from "../messages.ts";
import { toolSchemas as projectToolSchemas, type AgentTool } from "./types.ts";
import { TOOL_SEARCH_NAME } from "./tool-search.ts";

/** agent 的工具面。键是 `tool.name`,值就是工具本体。 */
export type ToolMap = Map<string, AgentTool>;

/**
 * **收紧工作集**的那一叠（2026-09-07，角色定义）：每条 `restrict()` 往里压一个名字集合，
 * 工作集 = 池 ∩ 所有集合。池一个字不动——别的 extension 照常 `register()`，只是露不出来。
 *
 * 为什么不复用 `disabled`：那个字段是「来源断了」（MCP 掉线），语义是**这件工具坏了**，
 * 而且是一次性打在对象上的——收紧之后**新注册**的工具不会被打上，于是角色一边限着、
 * 池里一边冒出没限住的工具。这里是**动态过滤**，查的时候才求交，后来的照样被挡在外面。
 */
export type ToolRestrictions = ReadonlySet<string>[];

/**
 * 压一条收紧。返回的 disposer 只摘自己那一条（认对象身份，与别处的 disposer 同款）。
 * 多条并存 = 交集，叠加只会更小——**任何一条都不能把工作集放大**。
 */
export function restrictTools(list: ToolRestrictions, names: ReadonlySet<string>): () => void {
  const own = new Set(names);
  list.push(own);
  return () => {
    const i = list.indexOf(own);
    if (i !== -1) list.splice(i, 1);
  };
}

/** 当前有效的收紧集合；一条都没有 = `undefined`（**不是空集**，那会把工作集清成零件）。 */
export function effectiveRestriction(list: ToolRestrictions): ReadonlySet<string> | undefined {
  if (list.length === 0) return undefined;
  const [first, ...rest] = list as [ReadonlySet<string>, ...ReadonlySet<string>[]];
  if (rest.length === 0) return first;
  const out = new Set<string>();
  for (const name of first) if (rest.every((s) => s.has(name))) out.add(name);
  return out;
}

/**
 * 装一个工具。撞名 **fail-loud**,要盖掉必须显式 `replace: true`——不许静默影子。
 *
 * 返回的卸载器**只认对象身份**：池里这个名字若已被别人显式 replace 成
 * 另一个对象,它什么都不做——按名字删会把新条目一起误删。返回 true = 真卸掉了。
 */
export function registerTool(tools: ToolMap, tool: AgentTool, opts?: { replace?: boolean }): () => boolean {
  if (tools.has(tool.name) && opts?.replace !== true) {
    throw new Error(`工具 '${tool.name}' 已注册；覆盖须显式 replace:true`);
  }
  tools.set(tool.name, tool);
  return () => unregisterExact(tools, tool);
}

/** 批量装。任一条撞名即抛,**先查后写**——不留半批。卸载器逐条认对象身份,返回真卸掉的名字。 */
export function registerTools(
  tools: ToolMap,
  list: readonly AgentTool[],
  opts?: { replace?: boolean },
): () => readonly string[] {
  // **先拷一份**：`list` 是调用方的数组，注册后它可以合法地清空/复用；卸载器若还指着它，
  // 热重载时就会留下旧 generation 的 orphan（实测：注册后 `list.length = 0`，卸载器什么都不卸）。
  const registered = [...list];
  if (opts?.replace !== true) {
    const clash = registered.find((t) => tools.has(t.name));
    if (clash !== undefined) throw new Error(`工具 '${clash.name}' 已注册；覆盖须显式 replace:true`);
  }
  for (const t of registered) tools.set(t.name, t);
  return () => registered.filter((t) => unregisterExact(tools, t)).map((t) => t.name);
}

/** 只在当前条目**仍是这个对象**时才删。名字被 replace 成别的对象后返回 false、池不动。 */
export function unregisterExact(tools: ToolMap, tool: AgentTool): boolean {
  if (tools.get(tool.name) !== tool) return false;
  return tools.delete(tool.name);
}

/** 按名卸——这是显式操作（调用方明知要删的是「叫这个名字的那条」），不是 lease 卸载器。 */
export function unregisterTool(tools: ToolMap, name: string): boolean {
  return tools.delete(name);
}

/** 按名整批卸（MCP 断开时它自己记着给过哪些名字）。返回真卸掉的那些。 */
export function unregisterTools(tools: ToolMap, names: readonly string[]): readonly string[] {
  return names.filter((n) => tools.delete(n));
}

export function getTool(tools: ToolMap, name: string): AgentTool | undefined {
  return tools.get(name);
}

export function listTools(tools: ToolMap): readonly AgentTool[] {
  return [...tools.values()];
}

/**
 * **摆给模型的那些**：池里没被禁用的，再交上 `only`（角色收紧的工作集，见 `ToolRestrictions`）。
 * 禁用的工具不从池里删——来源恢复时一行复原，不必重新注册。
 *
 * `only` 不给 = 没人收紧；给了就是池 ∩ 它，**只会更小**。
 */
export function activeTools(tools: ToolMap, only?: ReadonlySet<string>): readonly AgentTool[] {
  return [...tools.values()].filter((t) => t.disabled === undefined && (only === undefined || only.has(t.name)));
}

/**
 * **本轮摆给模型的菜单**（渐进式披露，2026-09-02 用户拍板）：没被禁用、且（不延迟 或 已加载）。
 * 延迟是工具自己的标记（`ToolBase.deferred`）；`loaded` 是本 agent 经 `tool_search` 取过 schema 的名字。
 * `tool_search` 自己只在池里**还有没加载的延迟工具**时上菜单——没什么可取时不多占一格。
 * `getTools()` 的实现，循环契约不变。
 */
export function visibleTools(tools: ToolMap, loaded?: ReadonlySet<string>, only?: ReadonlySet<string>): readonly AgentTool[] {
  const active = activeTools(tools, only);
  if (loaded === undefined) return active;
  const pending = active.some((t) => t.deferred === true && !loaded.has(t.name));
  return active.filter((t) => {
    if (t.name === TOOL_SEARCH_NAME) return pending;
    return t.deferred !== true || loaded.has(t.name);
  });
}

/** 禁用一批（MCP 断线时它自己知道给过哪些名字）。返回真禁掉的个数。 */
export function disableTools(tools: ToolMap, names: readonly string[], reason: string): number {
  let n = 0;
  for (const name of names) {
    const t = tools.get(name);
    if (t === undefined || t.disabled !== undefined) continue;
    t.disabled = reason;
    n += 1;
  }
  return n;
}

/** 来源恢复：转回可用。返回复原了几个。 */
export function enableTools(tools: ToolMap, names: readonly string[]): number {
  let n = 0;
  for (const name of names) {
    const t = tools.get(name);
    if (t === undefined || t.disabled === undefined) continue;
    delete t.disabled;
    n += 1;
  }
  return n;
}

export type ToolResolution =
  | { ok: true; tool: AgentTool }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "disabled"; message: string }
  /** 延迟工具、还没经 tool_search 取过 schema：模型直接点名时要看到这句，而不是「未知工具」 */
  | { ok: false; reason: "deferred"; message: string };

/**
 * 执行时解析一个工具名。**给准确原因**，不是含糊的「未知工具」——
 * 模型点了一个刚断线的 MCP 工具，它该看到「服务器已断开」；点了一个没加载的延迟工具，该看到「先 tool_search」。
 */
export function resolveTool(tools: ToolMap, name: string, loaded?: ReadonlySet<string>, only?: ReadonlySet<string>): ToolResolution {
  const tool = tools.get(name);
  if (tool === undefined) return { ok: false, reason: "not_found" };
  // 被角色收紧挡在工作集外：对这一段 session 来说这个名字**就是不存在**——它从没上过菜单，
  // 点它只可能是幻觉或从别处抄来的。所以是 `not_found`，不另立一种原因（联合类型是公共面，
  // 加成员要单独拍；而这里没有第二种处置方式需要区分）。
  if (only !== undefined && !only.has(name)) return { ok: false, reason: "not_found" };
  if (tool.disabled !== undefined) return { ok: false, reason: "disabled", message: tool.disabled };
  if (loaded !== undefined && tool.deferred === true && !loaded.has(name)) {
    return { ok: false, reason: "deferred", message: `Tool '${name}' is deferred: load it with ${TOOL_SEARCH_NAME} first, then call it` };
  }
  return { ok: true, tool };
}

/**
 * tools 参数的确定性投影（**按名排序**）。
 *
 * tools 在请求最前面,字节一变整个前缀缓存全灭;而注册顺序天然不稳定（MCP 异步连接先到先得）,
 * 所以这里必须给出「同一个集合,永远同一个字节序列」。
 */
export function toolSchemasOf(tools: ToolMap): readonly ToolSchema[] {
  return projectToolSchemas(activeTools(tools));
}
