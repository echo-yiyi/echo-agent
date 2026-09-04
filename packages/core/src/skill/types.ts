// Skill 的数据与操作面。
//
// Skill 解决什么问题：把「磁盘上一坨文件」变成「一条能摆到模型面前的指令」，
// 并且让指令里能引用它旁边的模板与脚本。所以它必须同时回答三件事：
// **是什么**（name/description）、**说什么**（content）、**在哪**（dir/files）。
//
// 加载器（扫盘 + YAML + ignore 文件）**不在 core 里**——core 零依赖，而兼容外部生态
// （Claude Code / pi 写的 skill）要求真的 YAML 解析器。加载器产出 Skill[] 喂进来即可，
// core 只处理已经是数据的东西。

import type { Diagnostic } from "../errors.ts";


/**
 * 一个 skill = 一段按需调用的指令 + 它在磁盘上的位置。
 * **纯数据**：可 JSON 序列化、可缓存、可跨进程传——不挂方法。
 */
export type Skill = {
  /** 寻址键。加载器保证它等于目录名（类型层保证不了，只保证 harness 内唯一）。 */
  readonly name: string;
  /** 模型据此判断「这次要不要用它」。**唯一致命必填**：没有它，skill 只是模型永远想不起来的文本。 */
  readonly description: string;
  /** 指令正文（frontmatter 之后的全部，原文不加工）。加工是渲染时的事。 */
  readonly content: string;
  /**
   * **相对引用的锚**——多文件 skill 的全部支点。存目录不存 SKILL.md 路径：入口文件名是规则不是数据。
   *
   * **可缺**：磁盘上的 skill 有；进程内创建的（`SkillHarness.create` 的内存实现）没有，
   * 也就引用不了同目录文件。让它可缺比逼一个空字符串诚实。
   */
  readonly dir?: string;
  /** 同级文件清单（相对 dir）。加载时顺手收，省 agent 一轮 ls。 */
  readonly files: readonly string[];
  /** 自报依赖：缺了这些工具，激活时就说清楚，而不是让模型试半天。 */
  readonly requiredTools: readonly string[];
  /** 模型能不能自己调它。缺省 true；false = 只给人和 hook 用，不进模型的 catalog。 */
  readonly modelInvocable: boolean;
  /**
   * frontmatter 原样透传——上层自己的字段（owner、allowed-tools…）不用改这个类型。
   *
   * **是不可信数据**：渲染时绝不碰它（只碰 description 与 content，两者过消毒与上限）；
   * 要用某个字段必须显式白名单提升成 typed 字段。
   */
  readonly frontmatter: Readonly<Record<string, unknown>>;
};

/**
 * 激活中的 skill。
 * **按 name 引用而不是按值持有 Skill**：热重载（监听目录的 harness）之后，
 * 按值持有的那份会永远是旧内容。
 */
export type ActiveSkill = {
  readonly name: string;
  /** 激活时附的一段话（「用 h5-page 做一个关于 X 的页面」）——这就是「带参数调用 skill」的解法，
   *  不搞参数声明与 schema。**是模型可控文本**，渲染时必须过消毒。 */
  readonly instructions?: string;
  readonly activatedAt: number;
};

/**
 * 一次 skill 发现的产出（loader 扫盘、或 `skillSource` 端口从状态根恢复）。
 * 住 types.ts 而不是 loader.ts：`Agent`（engine 面）要引用它，loader 拖 `node:`。
 */
export type LoadedSkills = {
  skills: Skill[];
  /** 跳过了什么、为什么。**不上报就是静默失败**——调用方拿到就该往 report 送。 */
  diagnostics: Diagnostic[];
};

export type SkillCreation =
  | { ok: true; skill: Skill }
  | { ok: false; reason: "exists" }
  | { ok: false; reason: "invalid"; message: string };

export type SkillActivation =
  | { ok: true; skill: Skill }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "missing_tools"; missing: readonly string[] }
  /** 激活集合总预算不够（`SKILL_ACTIVE_TOTAL_CAP`）：`used` 是已激活的合计，`needed` 是这一个的开销。 */
  | { ok: false; reason: "budget"; used: number; needed: number; cap: number; active: readonly string[] };
