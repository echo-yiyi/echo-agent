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
      "Activate a skill: its full instructions appear in your context from the next turn on, for the rest of this session. " +
      "The Skills section of the system prompt lists each skill's name and when it applies; when the current task matches one, activate it before acting. " +
      "No need to call again for a skill that is already active. Optionally pass instructions saying what you need it for this time.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Skill name (from the Skills section of the system prompt)" },
        instructions: { type: "string", description: "Optional: what you need it for this time" },
      },
      required: ["name"],
    },
    async execute(params) {
      const { name, instructions } = params;
      const skill = deps.skills.get(name);
      // 模型这条路要查 modelInvocable——方法层不查（人和 hook 有权启用任何一个）。
      if (skill !== undefined && !skill.modelInvocable) {
        return toolError(`Skill '${name}' is not available to the model`);
      }
      const r = activateSkill(deps.skills, deps.active, name, {
        ...(instructions !== undefined ? { instructions } : {}),
        ...(deps.hasTool !== undefined ? { hasTool: deps.hasTool } : {}),
      });
      if (r.ok) return toolOk(`Activated skill ${name} (its instructions are visible from the next turn)`);
      if (r.reason === "not_found") {
        const available = [...deps.skills.values()].filter((s) => s.modelInvocable).map((s) => s.name);
        return toolError(`Unknown skill '${name}' (available: ${available.join(", ") || "none"})`);
      }
      // missing_tools：把缺什么说清楚，别让模型试半天
      return toolError(`Skill '${name}' needs tools that are not available: ${r.missing.join(", ")}`);
    },
  };
}

function createTool(deps: SkillToolsDeps): ModelTool<{ name: string; description: string; content: string }> {
  return {
    kind: "model",
    name: "skill_create",
    label: "创建 skill",
    description:
      "Save a way of working as a new skill so it can be activated for similar tasks later. " +
      "Good for: a reusable procedure worked out this time, pitfalls and how to avoid them, a fixed format for a kind of output. " +
      "Not for: information that only matters this once (just say it). " +
      "Write the description as the situation in which the skill applies; your future self decides from that one line whether to activate it.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Lowercase letters, digits, and hyphens; unique" },
        description: { type: "string", description: "When to use it (this line decides whether it gets picked up later)" },
        content: { type: "string", description: "Full instructions (markdown)" },
      },
      required: ["name", "description", "content"],
    },
    async execute(params) {
      const r = createSkill(deps.skills, params);
      if (!r.ok) {
        if (r.reason === "exists") return toolError(`Skill '${params.name}' already exists`);
        return toolError(`Could not create the skill: ${r.message}`);
      }
      try {
        await deps.onCreate?.(r.skill.name);
      } catch (e) {
        // **措辞与真实状态一致**（Task 面同款教训）：skill 已进池、skill_activate 已可用，
        // 只是没写到盘上。说「创建失败」的话，模型会重试——而重试只会撞「已存在」。
        return toolError(
          `Skill '${r.skill.name}' was created in this process (skill_activate works) ` +
            `but could not be written to disk: ${e instanceof Error ? e.message : String(e)}. ` +
            `It will be lost when the process restarts. Do not retry: a retry only reports "already exists". Tell the user.`,
        );
      }
      return toolOk(`Created skill ${r.skill.name} (activate it with skill_activate)`);
    },
  };
}
