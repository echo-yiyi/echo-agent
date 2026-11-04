# `echo-coding` 缺省开思考：`codingPreset()` 的思考档缺省 `medium`

> 状态:implemented · 提出 2026-11-03（echo-coding 工具线排查）· 拍板 2026-11-03（用户：「全部按推荐修」）· 实现 2026-11-03 · 来源 `packages/coding/src/agent.ts`（`codingPreset` 与 `CodingPresetOptions.thinkingLevel`），判据 [缺省与显式](../../../packages/coding/test/identity.test.ts#test=codingpreset-缺省开思考medium装出来的-agent-生效值就是它调用方显式给的档位照用)、[产品两种形态](../../../packages/coding/test/cli.test.ts#test=preset产品自带-echocoding-echoworkspace-echoshell不碰-workspace两种形态都不装权限策略缺省全放行)

## 现状(拍板前)

core 新建 agent 缺省 `thinkingLevel: "off"`（[off 要真关](2026-09-08-thinking-level-off.md)）。`codingPreset()` 不设档位，于是 echo-coding 一起来：能真关思考的模型（DeepSeek flash / pro、Kimi K2.6）发 `thinking: { type: "disabled" }`，真的不思考；关不掉的（Kimi K3、GLM 5.3）不发思考参数，按服务端缺省跑。交互形态要用户自己 Shift+Tab 切档，管道形态没有切档的入口。coding 是多步推理的活，缺省不思考是错的那一头。

## 选项

- **A. 不改**：要思考的用户自己切。管道形态切不了。
- **B. `codingPreset()` 缺省 `thinkingLevel: "medium"`，调用方显式给就用调用方的**（`CodingPresetOptions.thinkingLevel`，给 `"off"` 照样是关）。只动 coding 产品，core 的缺省不变。codex 的缺省 reasoning effort 也是 medium（`codex-rs/protocol/src/openai_models.rs` 的 `ReasoningEffort` 以 `Medium` 为 `#[default]`）。
- **C. 改 core 的缺省**：影响所有产品与评测，不在这条线的范围。

## 决定

**B**（2026-11-03 用户拍板）。两种形态都生效（`ECHO_CODING.preset` 不覆盖它）。交互形态里 Shift+Tab 照常切档；档位不落进会话，续会话时回到缺省 medium。

**随之而来的行为变化**（各家怎么映射见模型目录的 `thinkingLevelMap`）：

- DeepSeek flash / pro：从不思考变成 `reasoning_effort: high`（目录把 medium 折到 high）。
- Kimi K2.6：从不思考变成开思考。
- **Kimi K3（本产品的缺省模型）与 GLM 5.3**：从「不发参数、服务端缺省 max」变成 `reasoning_effort: high`——思考深度比此前**低一档**。要 max 的用户切到 max，或嵌入方传 `thinkingLevel: "max"`。

## 验收

`codingPreset().agent.thinkingLevel === "medium"`，`codingPreset({ thinkingLevel: "off" }).agent.thinkingLevel === "off"`；`createEcho({ ...codingPreset() })` 装出来的 agent 的 `state.thinkingLevel` 是 `medium`；`ECHO_CODING.preset` 两种形态的 `agent` 都带 `thinkingLevel: "medium"`。`codingAgentIdentity()` 的 digest 不含思考档（它记的是 prompt 段、缺省模型、执行预算与工具集），这条不改 digest。
