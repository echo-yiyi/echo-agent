// 装配器:PromptSection[] + 变量表 → system prompt 字符串。每次 run 由 Agent.assemblePrompt 调一次
// (冻结的是时刻,不是内容)。本文件不认识任何机制的格式——只管排序、渲染、插值、丢空段、连接。

import { PROMPT_VARIABLE_NAME, type AssembleContext, type PromptSection, type PromptVariable } from "./types.ts";

export type SectionFailure = (info: { section: string; error: unknown }) => void;

/**
 * 变量引用错:未注册的名字、provider 返回 undefined、畸形的 `{{…}}`。
 * 这是**作者错误**(段文本是产品 / extension 写的受信文本),装配失败、本次 run 以 error 结束——
 * 不像 `render()` 抛错那样隐形:一个写错的 `{{modle}}` 静默发给模型,没人会发现。
 */
export class PromptVariableError extends Error {
  constructor(
    readonly section: string,
    readonly variable: string | null,
    message: string,
  ) {
    super(message);
    this.name = "PromptVariableError";
  }
}

/**
 * 按 order 升序(同数保数组序 = 注册序)→ 逐段 `render(ctx)` → `{{name}}` 插值 → 空段丢弃 → "\n\n" join。
 * 两种失败两种档位:
 *   · `render()` 抛错 = 该段隐形 + onFailure 留痕——段是增强面,运行时数据坏一段不许击穿整个 run;
 *   · 变量错 = **抛** {@link PromptVariableError}——作者错误要响。
 * 全空返回 null(与「没有 systemPrompt」同义,不发空字符串)。
 */
export async function assembleSystem(
  sections: readonly PromptSection[],
  variables: ReadonlyMap<string, PromptVariable>,
  ctx: AssembleContext,
  onFailure?: SectionFailure,
): Promise<string | null> {
  const ordered = [...sections].sort((a, b) => a.order - b.order); // Array#sort 稳定:同 order 保注册序
  const values = resolveVariables(variables, ctx);
  const blocks: string[] = [];
  for (const s of ordered) {
    let raw: string;
    try {
      raw = await s.render(ctx);
    } catch (error) {
      onFailure?.({ section: s.name, error });
      continue;
    }
    const text = interpolate(raw, values, s.name).trim();
    if (text !== "") blocks.push(text);
  }
  return blocks.length > 0 ? blocks.join("\n\n") : null;
}

/** 变量表在装配开始时**一次性**解析:同一次装配里同名同值,provider 只调一次。 */
function resolveVariables(variables: ReadonlyMap<string, PromptVariable>, ctx: AssembleContext): Map<string, string | undefined> {
  const out = new Map<string, string | undefined>();
  for (const [name, provider] of variables) out.set(name, provider(ctx));
  return out;
}

/**
 * 严格插值(照 dsh `renderPrompt` 的规则):
 *   · 完整的 `{{name}}`:名字合法且已注册且有值 → 替换;否则抛;
 *   · `{{` 之后有 `}}` 但中间不是合法名字(含花括号、空白、非法字符)→ 抛(畸形);
 *   · 孤立的 `{{` 后面再没有 `}}` → 当普通文本原样保留;
 *   · 替换进去的值**不再扫描**——值里的 `{{` 不会被二次解释。
 */
export function interpolate(text: string, values: ReadonlyMap<string, string | undefined>, section: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf("{{", i);
    if (open === -1) {
      out += text.slice(i);
      break;
    }
    const close = text.indexOf("}}", open + 2);
    if (close === -1) {
      out += text.slice(i); // 孤立 `{{`:原样
      break;
    }
    out += text.slice(i, open);
    const name = text.slice(open + 2, close);
    if (!PROMPT_VARIABLE_NAME.test(name)) {
      throw new PromptVariableError(section, null, `prompt 段 '${section}' 里有畸形的变量引用 '{{${name}}}'（名字只能是 [a-z][a-z0-9_]*）`);
    }
    if (!values.has(name)) {
      throw new PromptVariableError(section, name, `prompt 段 '${section}' 引用了未注册的变量 '{{${name}}}'`);
    }
    const value = values.get(name);
    if (value === undefined) {
      throw new PromptVariableError(section, name, `prompt 段 '${section}' 引用的变量 '{{${name}}}' 本次没有值`);
    }
    out += value;
    i = close + 2;
  }
  return out;
}
