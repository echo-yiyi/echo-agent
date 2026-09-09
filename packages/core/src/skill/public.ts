// `@echo-agent/core/skill` —— skill 的构造器、渲染与工具（`Skill` / `ActiveSkill` 类型在根入口）。
//
// **`package.json#exports` 里没有这条子路径**（review 2026-09-07）：包外 import 会撞 ERR_PACKAGE_PATH_NOT_EXPORTED，
// 仓内也没人 import 它。删掉还是开出去，待拍板；在那之前它只是随 `files: src` 发出去的一份死入口。
//
// **为什么在子路径而不是根入口**（D13）：根入口只放「完整 Agent 的创建、命令、
// 状态和事件」——普通用户不 import 任何子路径就已经得到工作的默认能力（`createAgent` 装配好
// 一切）。**只有换默认件或开发扩展时才进来这一层**。
//
// 这里的东西**纯**（不碰 `node:`）。落盘默认件在根入口。

export * from "./harness.ts";
export * from "./compose.ts";
export * from "./tools.ts";
