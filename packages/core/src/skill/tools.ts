// skill 的模型可见面：两个**内核工具**。
//
// 判据（2026-08-04 拍定）：
//   **内核工具 = 对 agent 自己的能力面动手的工具**（激活 skill、创建 skill、将来的搜工具）
//   **产品层工具 = 对外部世界动手的工具**（读写文件、跑命令、访问网络）
// 前者是内核机制的模型可见面——没有 skill_activate，渐进式披露根本不成立。
//
// **core 仍然不认识文件系统**：`skill_create` 只把新 skill 放进池，落盘是调用方的事。
//
// ⚠️ 两个工具的 `description` 是**模型逐字读的 prompt 资产**，这里是临时措辞；
// 定稿与治理（版本、指纹）归 prompt 那一轮。

import { toolError, toolOk, type ModelTool } from "../tools/types.ts";
import { activateSkill, createSkill, type ActiveSkillMap, type SkillMap } from "./harness.ts";

export type SkillToolsDeps = {
  skills: SkillMap;
  active: ActiveSkillMap;
  /** 工具面的权威在 agent——校验 `requiredTools` 靠它。 */
  hasTool?: (name: string) => boolean;
  /**
   * 不给 = 这个 agent 不支持创建 skill，`skill_create` 就不会被造出来。
   *
   * 可以返回 Promise：工具**等它 settle 才回执**（Task 面上吃过的亏——只排一个
   * microtask 就说成功，慢 Store 下模型收到「已创建」而盘上什么都没有）。
   * 抛错 = 落盘失败，工具会如实告诉模型「进程内已建、盘上没有」。
   */
  onCreate?: (name: string) => void | Promise<void>;
};

/**
 * 造 skill 的两个模型可见工具。装配方决定装不装——
 * **零 skill 时别装**（v1 的教训：空可选集的工具每轮白占 token，且严格 provider 会拒收）。
 */
export function makeSkillTools(deps: SkillToolsDeps): ModelTool[] {
  // **`skill_create` 只在给了 `onCreate` 时才造**——这本来就是 `SkillToolsDeps.onCreate`
  // 的注释写着的契约（「不给 = 这个 agent 不支持创建 skill，`skill_create` 就不会被造出来」），
  // 而实现一直是无条件造。后果不是「多一个工具」：没有 `onCreate` 就没人把新 skill 落盘，
  // 工具**返回成功、重启即消失**——比不给这个工具坏得多。
  return (deps.onCreate === undefined ? [activateTool(deps)] : [activateTool(deps), createTool(deps)]) as ModelTool[];
}

function activateTool(deps: SkillToolsDeps): ModelTool<{ name: string; instructions?: string }> {
  return {
    kind: "model",
    name: "skill_activate",
    label: "启用 skill",
    description:
      "启用一个 skill：它的完整指令会从下一轮起出现在你的上下文里，直到本次任务结束。" +
      "system 的「可用 skill」段列出了每个 skill 的名字与适用场景；当前任务命中某条描述时，先启用再动手。" +
      "已启用的无需重复调用。可用 instructions 附一句「这次要用它做什么」。",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "skill 名（见 system 的可用 skill 段）" },
        instructions: { type: "string", description: "可选：这次具体要用它做什么" },
      },
      required: ["name"],
    },
    async execute(params) {
      const { name, instructions } = params;
      const skill = deps.skills.get(name);
      // 模型这条路要查 modelInvocable——方法层不查（人和 hook 有权启用任何一个）。
      if (skill !== undefined && !skill.modelInvocable) {
        return toolError(`skill '${name}' 不对模型开放`);
      }
      const r = activateSkill(deps.skills, deps.active, name, {
        ...(instructions !== undefined ? { instructions } : {}),
        ...(deps.hasTool !== undefined ? { hasTool: deps.hasTool } : {}),
      });
      if (r.ok) return toolOk(`已启用 skill：${name}（指令从下一轮起可见）`);
      if (r.reason === "not_found") {
        const available = [...deps.skills.values()].filter((s) => s.modelInvocable).map((s) => s.name);
        return toolError(`未知 skill '${name}'（可用：${available.join("、") || "无"}）`);
      }
      // missing_tools：把缺什么说清楚，别让模型试半天
      return toolError(`skill '${name}' 需要这些工具，当前没有：${r.missing.join("、")}`);
    },
  };
}

function createTool(deps: SkillToolsDeps): ModelTool<{ name: string; description: string; content: string }> {
  return {
    kind: "model",
    name: "skill_create",
    label: "创建 skill",
    description:
      "把一套做法固化成新的 skill，供以后遇到同类任务时启用。" +
      "适合：这次摸索出的可复用流程、踩过的坑与规避方式、某类产出的固定格式。" +
      "不适合：只对当前这一次有效的信息（那些直接说就行）。" +
      "description 要写清「什么情况下该用它」——将来的你靠这一句判断要不要启用。",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "小写字母、数字、连字符；全局唯一" },
        description: { type: "string", description: "什么情况下该用它（这句决定它以后会不会被想起来）" },
        content: { type: "string", description: "完整指令正文（markdown）" },
      },
      required: ["name", "description", "content"],
    },
    async execute(params) {
      const r = createSkill(deps.skills, params);
      if (!r.ok) {
        if (r.reason === "exists") return toolError(`skill '${params.name}' 已存在`);
        return toolError(`创建失败：${r.message}`);
      }
      try {
        await deps.onCreate?.(r.skill.name);
      } catch (e) {
        // **措辞与真实状态一致**（Task 面同款教训）：skill 已进池、skill_activate 已可用，
        // 只是没写到盘上。说「创建失败」的话，模型会重试——而重试只会撞「已存在」。
        return toolError(
          `skill '${r.skill.name}' **已经在当前进程里创建**（skill_activate 已可用），` +
            `但没能写到盘上：${e instanceof Error ? e.message : String(e)}。` +
            `这个进程重启后它会丢失。**不要重试**——重试只会报「已存在」；请把这件事告诉用户。`,
        );
      }
      return toolOk(`已创建 skill：${r.skill.name}（可用 skill_activate 启用）`);
    },
  };
}
