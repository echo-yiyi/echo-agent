// `echo-agent` 公共面：**通用 agent 这个产品**（2026-09-09 拆包之后它只剩产品，记录见
// `docs/decisions/proposed/2026-09-09-assembly-layer-packages.md`）。
//
// 拆之前本包同时是四样东西：产品、产品框架、两个壳、宿主能力。于是产品依赖另一个产品
// （`@echo-agent/coding` 的 dependencies 里写着 `echo-agent`），做 web 界面的第三方也被迫装终端库。
// 现在装配层是 `@echo-agent/base`、终端壳是 `@echo-agent/tui`，本包与 `@echo-agent/coding` 平级。
//
// 本包留下的只有：`echo-agent` 的身份段、它的 `Product`、可执行文件。

/** 通用 agent 的身份段——只属于本产品，`echo-coding` 有它自己的。 */
export { ECHO_AGENT_IDENTITY, identityEntry, identitySection } from "./prompt.ts";

/** 本产品的定义与入口。`bin/echo-agent.ts` 调的就是 `main`。 */
export { ECHO_AGENT, main } from "./product.ts";
