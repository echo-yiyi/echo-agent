# inject 软依赖有读法：`ctx.tryGet()` 缺 provider 返回 undefined，`ctx.get()` 照抛

> 状态:implemented · 提出 2026-09-14（审 [扩展设计](../../design/extensions.md) 时登记：`required?: boolean` 的软依赖只能靠抓 `ExtensionAbiError` 读）· 拍板 2026-09-14（用户：「按照 1 的方式去改」）· 落地 `packages/core/src/extension/abi.ts` / `fiber.ts`，判据 `packages/core/test/extension-host.test.ts`

**给谁看**：写 extension、或给 `agentRegistries()` 加可选 Service 的人。假设已知 inject / provide 与 PREPARE（[扩展设计](../../design/extensions.md) §3）。

## 现状（拍板前）

`inject` 的 `required` 自初始提交起就是硬 / 软依赖开关：硬依赖缺 provider 整代在 PREPARE 判红；软依赖缺 provider 照常 mount，但 `ctx.get()` 抛「当前没有 provider」，ABI 上没有不抛的读法。软依赖的唯一用法是 try/catch 抓 `ExtensionAbiError`，`registries.ts` 三段注释因此劝人一律声明 required，仓内没有一处软依赖。

## 不拍板的代价

软依赖有真实场景：`agentRegistries()` 在没装记忆时不提供 `AgentMemory`、没给 skill 池时不提供 `AgentSkills`。一个「有记忆就顺手注册模块、没记忆也照常装工具」的第三方扩展只能靠软依赖，而抓异常当控制流是这套 ABI 别处都不允许的。

## 选项

- **A. 加不抛的读法** `ctx.tryGet(key): T | undefined`，软依赖成为一等公民。ABI 加一个成员。
- **B. 删掉 `required`，一律硬依赖。** 最小，但 `--no-memory` 下上面那类扩展整代装不上。
- **C. 保持现状，把 try/catch 写成正式用法。**

## 决定

**A**（2026-09-14 用户拍板）。附三条：

1. `tryGet` 与 `get` 同一套门：只能读 `inject` 里声明过的（未声明照抛）、Fiber 已卸载照抛；区别只在「声明了但当前没有 provider」这一种情形——`get` 抛、`tryGet` 返回 undefined。
2. `get` 在软依赖缺 provider 时**仍然抛**：不改既有语义，报文加一句「要降级请用 tryGet()」。
3. 口径：恒有的 Service（Host 自带的 registry、能力端口）声明 `required: true`；只有真会缺席的（`AgentMemory` / `AgentSkills`）才用软依赖 + `tryGet`。`registries.ts`、`echo:shell` 与 [会话设计](../../design/sessions.md) §7 的注释按此改口。

## Non-Goals

- 不加 `has()`：`tryGet() !== undefined` 就是它。
- 不做「后来出现 provider 自动重绑」：边仍在 PREPARE 一次性解析（[扩展设计](../../design/extensions.md) §3）。

## 验收

`packages/core/test/extension-host.test.ts`：软依赖缺 provider 时 `tryGet` 为 undefined、`get` 抛；有 provider 时两者同值；未声明的 `tryGet` 抛。用 `agentRegistries()` 不给 skills 装一条软依赖 `AgentSkills` 的扩展：工具照装、不注册技能；给了 skills 再装，技能也注册上。
