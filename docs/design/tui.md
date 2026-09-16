# 终端交互界面（TUI）

> 读者：修改终端交互、接入壳协议或排查键盘与渲染问题的人<br>
> 范围：布局、输入、首次配置、消息呈现、运行状态及界面命令<br>
> 状态：当前实现说明；持久清空与协议边界见 §七

## 导读

**解决什么。** 在终端里完成输入、查看生成过程和工具结果、回答权限询问，并准确显示当前模型、运行状态与上下文占用。

**设计主线。** TUI 是独立壳，消费 AgentRuntime 与会话面，不自行持有 Agent 的启动和停止流程。界面用组件组织文档流、编辑器与状态栏；消息和状态由运行时驱动，选择模型、重载等操作调用协议并显示结果。

**边界。** 产品与启动装配归 base / 产品层；TUI 不负责 session 落盘、provider 协议或工具执行。固定主题不等于可切换主题系统；本文不引入自定义编辑器扩展接口。

## 一、布局

```text
文档区
  欢迎信息
  用户消息 / 助手消息 / 工具调用 / 通知与询问
编辑区
  多行输入、历史与补全
状态栏
  模型、运行状态、用量与能力摘要
```

布局由 [runTui()](../../packages/tui/src/app.ts#symbol=runTui) 与 [Transcript](../../packages/tui/src/transcript.ts#symbol=Transcript) 组合，组件库使用仓库安装的 pi-tui。文档流随内容增长，终端负责滚动；组件结构用于分离消息状态，不保证任意输出量下的渲染性能。

流式更新修改已有助手组件，工具完成更新对应 toolCallId 的组件，不为每个增量创建一条新消息。换行和裁切按终端可见列宽处理，不能用字符串字符数代替显示宽度。

## 二、输入行

输入使用 Editor，编辑历史、光标移动和基础补全由组件提供。主题由 [EDITOR_THEME](../../packages/tui/src/theme.ts#symbol=EDITOR_THEME) 固定提供，应用层不另造一份编辑器状态。

### 键位

应用键表的真源是 [APP_KEYBINDINGS](../../packages/tui/src/keybindings.ts#symbol=APP_KEYBINDINGS)。[installKeybindings()](../../packages/tui/src/keybindings.ts#symbol=installKeybindings) 将它和组件库默认编辑键合并，界面和 Editor 使用同一份 manager。

| 键 | 当前应用行为 |
| --- | --- |
| Enter | 提交输入 |
| Shift+Enter / Ctrl+J | 编辑器换行 |
| Esc | 中断当前工作 |
| Ctrl+C | 清空输入，不退出 |
| Ctrl+D | 输入为空时退出；非空时交给编辑器删除字符 |
| Ctrl+O | 全局展开或收起工具输出 |
| Ctrl+L | 打开模型选择器 |
| Shift+Tab | 轮换当前模型实际支持且请求参数不同的 thinking 档 |
| y / n | 在权限询问状态下回答允许或拒绝 |

历史导航遵循 Editor 的光标与草稿规则；方向键不无条件等于翻历史。Ctrl+P、Alt+Enter 等外部产品键位未在本应用键表登记，不能仅因“参考 pi”就视为支持。

### 按键处理的纪律与判据

按键经过 KeybindingsManager / matchesKey 识别，入口过滤 release，必要时解码 Kitty printable；不直接比较某一种终端编码的字节。

静态门在 packages/tui/test/key-discipline.test.ts，实际扫描本包 src 中的 fromCharCode 使用；它不等价于识别所有可能的裸字节比较。真 PTY 的 packages/cli/test/tui-pty.test.ts 将 Kitty 和应用光标键编码送进进程，验证行为。假组件测试可检查界面状态，但不能代替终端编码层测试。

## 三、欢迎界面与凭据配置

欢迎区显示产品版本、工作目录、模型与键位提示。首次运行的 [runFirstRunSetup()](../../packages/tui/src/first-run.ts#symbol=runFirstRunSetup) 完成 provider、凭据及模型选择，再交回装配层创建运行时；这与运行中凭据失效后的配置界面分开。

交互模式缺凭据时引导配置，运行中认证失败可重新输入；管道模式不能要求人操作选择器，按启动器的凭据检查返回错误。凭据的读取、验证、保存与模型选择持久化归宿主能力，TUI 只提供交互。

## 四、状态栏

[footerLine()](../../packages/tui/src/app.ts#symbol=footerLine) 从运行态投影生成状态栏，不自行推断业务状态。

| 显示 | 来源与显示条件 |
| --- | --- |
| 模型、运行状态 | state.model 与 state.status |
| 输入 / 输出 token | state.usage |
| 缓存用量及比例 | provider 给出 cachedInputTokens 且有输入基数时显示 |
| 上下文占用 | contextTokens 与模型 contextWindow 都可用时显示 |
| thinking | 映射表中实际请求参数；未映射时显示缺省，不声称已关闭思考 |
| tasks / skills / MCP | 对应状态摘要非空时显示 |

未报告缓存不显示为零命中，未给出窗口不伪造占用百分比。状态栏不估算美元费用；长行按可见宽度裁切，次要项位于后部。

## 五、消息渲染

| 内容 | 组件与行为 |
| --- | --- |
| 用户输入 | [UserMessage](../../packages/tui/src/messages.ts#symbol=UserMessage)，与助手输出区分 |
| 助手文本 / thinking | [AssistantMessage](../../packages/tui/src/messages.ts#symbol=AssistantMessage)，Markdown 与独立 thinking 样式 |
| 工具调用 | [ToolExecution](../../packages/tui/src/messages.ts#symbol=ToolExecution)，运行状态、参数摘要与结果 |
| 通知 | [Notice](../../packages/tui/src/messages.ts#symbol=Notice)，显示拒绝、失败或状态说明 |

工具默认折叠，Ctrl+O 控制全局展开状态；参数与结果不会默认全部铺开。工具输出和模型文本均经过 [clean()](../../packages/tui/src/text.ts#symbol=clean) 做终端输出清理，这不是判断文本语义可信的安全层。

Markdown 使用固定 [MARKDOWN_THEME](../../packages/tui/src/theme.ts#symbol=MARKDOWN_THEME)。流式片段与最终消息通过同一条 transcript 更新路径呈现；界面历史是消息投影，不是 session 账本的替代品。

## 六、交互能力

命令派发由 runTui 中的命令表负责，补全使用同一命令集合。

| 交互 | 所有者与边界 |
| --- | --- |
| /model、Ctrl+L | 壳选择，AgentRuntime 变更装备；忙时显示拒绝，不静默排队 |
| Shift+Tab | 使用模型 thinking 映射选择有效档位，运行时决定能否变更 |
| /compact | 调同一压缩流水线的手动入口，显示完成或拒绝 |
| /clear | 当前调用 reset 清内存投影；不等于持久创建新 session |
| /sessions | 通过会话面列其他 session，不自行组合 lease 与状态文件 |
| /resume | 壳选择目标并退出，由容器停止旧实例、装配目标实例 |
| /reload | 调运行时重载入口，逐项显示结果，不把 done 当作全部成功 |

会话切换、清空与失败回退以 [Sessions](sessions.md) 为准，重载范围与报告见 [Extensions](extensions.md)。其余命令以源码命令表为准，不在本文复制完整帮助文本。

## 七、当前限制

- /clear 尚未完成“关闭旧段、创建新段”的持久切换；恢复旧 session 可能带回清空前记录。
- TUI 无权自行启动、停止或替换 Agent，必须通过退出结果交给容器重装；切换不构成跨 session 原子事务。
- 固定主题、全局工具展开与现有 Editor 是当前产品选择，不是任意主题或编辑器可插拔的接口。
- 状态栏和组件测试不证明所有真实终端一致；终端编码与显示需要 PTY 和人工交互检查。

## 八、验证

```bash
bun test packages/tui/test/tui.test.ts packages/tui/test/first-run.test.ts \
  packages/tui/test/setup.test.ts packages/tui/test/extension.test.ts \
  packages/tui/test/key-discipline.test.ts
bun test packages/cli/test/tui-pty.test.ts
```

组件测试检查输入、命令、折叠、状态与主题；PTY 测试检查终端编码路径。真实 provider 凭据、长会话可读性和不同终端的视觉效果不由这些 fixture 证明。

## 九、决策记录

当前界面取舍的历史原因见以下记录；阶段计划不再作为当前实现说明维护。

| # | 日期 | 一句话 | 记录 |
|---|---|---|---|
| D1 | 2026-08-31 | 首次运行没有凭据时起来、进配置流程，不退出（后被 D3 / D4 细化） | [记录](../decisions/implemented/2026-08-31-tui-first-run-not-exit.md) |
| D2 | 2026-09-01 | 键位照 pi | [记录](../decisions/implemented/2026-09-01-tui-keybindings-follow-pi.md) |
| D3 | 2026-09-01 | 配置是运行态，不阻塞启动 | [记录](../decisions/implemented/2026-09-01-config-is-runtime-state.md) |
| D4 | 2026-09-01 | 首次运行走引导设置 | [记录](../decisions/implemented/2026-09-01-first-run-guided-setup.md) |
| D5 | 2026-09-01 | P3a 协议开 `setModel` / `setThinkingLevel` / `reset` 三支，忙时拒绝不排队 | [记录](../decisions/implemented/2026-09-01-runtime-protocol-set-model-thinking-reset.md) |
| D6 | 2026-09-01 | 坏扩展不阻塞启动 | [记录](../decisions/implemented/2026-09-01-bad-extension-does-not-block-startup.md) |
| D7 | 2026-09-01 | 跨 provider 换模 + 记住选择 | [记录](../decisions/implemented/2026-09-01-cross-provider-model-switch.md) |
| D8 | 2026-09-01 | 状态栏只显示 token 不显示 $，加缓存命中一格 | [记录](../decisions/implemented/2026-09-01-status-bar-tokens-and-cache.md) |
