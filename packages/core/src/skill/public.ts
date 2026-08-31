// `@echo-agent/core/skill` —— skill 的构造器、渲染与工具（`Skill` / `ActiveSkill` 类型在根入口）。
//
// **为什么在子路径而不是根入口**（§13.5 / D13）：根入口只放「完整 Agent 的创建、命令、
// 状态和事件」——普通用户不 import 任何子路径就已经得到工作的默认能力（`createAgent` 装配好
// 一切）。**只有换默认件或开发扩展时才进来这一层**。
//
// 这里的东西**纯**（不碰 `node:`），所以 engine 面的调用方也能用。落盘默认件在根入口。

export * from "./harness.ts";
export * from "./compose.ts";
export * from "./tools.ts";
