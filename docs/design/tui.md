# 产品级 TUI 设计方案

> 状态：P0–P2 与 P3 的 `/model`、`/clear` 已落地（2026-09-01 前后）；2026-09-08 从 `docs/review/` 搬入 `docs/design/` 并登记（八处源码与测试把它当设计权威引用，不该住在免门目录里）。正文仍按当时的方案写、未按现状重写——「现在的 TUI」指 2026-08-31 的样子。§九 的 D1–D8 是这条线的决策留痕，尚未各自成条进 `docs/decisions/`。

## 导读

**给谁看**：要实现这份方案的人。假设你已经知道 `AgentRuntime` 是什么、`packages/cli/` 现在长什么样，
所以下面不解释这两件事。

**解决什么问题**：现在的 TUI（`packages/cli/src/app.ts`，373 行）是个能跑的最小壳——
用了 pi-tui 里最弱的 `Input` 组件（注释里写的理由是「零配置」），键位一条没绑，
`AgentState` 里已有的 model / usage / tasks / activeSkills 一样都没显示。
目标是把它做成产品级：**能正常打字、能看见自己在用什么、输出可读**。

**最终形态**：三段式布局（文档流 / 输入行 / 状态栏），多行编辑器带历史与补全，
状态栏显示模型与用量，消息按类型分组件渲染，**键位与 pi 一致**。参考 pi 的 `interactive-mode.ts`。

**为什么参考 pi**：我们用的就是它的 TUI 库（`@earendil-works/pi-tui`）。
库里已经有 `Editor`、`Container`、`Markdown`、`SelectList`、`setKeybindings`、`fuzzyFilter` 这些——
现在一个都没用。参考它不是抄产品，是**把已经装了的库用起来**。
键位也照它（§九 D2）：库的缺省键就是 pi 的键，用户在别的工具里已经学过这一套，
自创一套只会和库的缺省打架。

### Non-Goals（明确不做）

- **不做 slash 命令的完整体系**。P3 只做最少的几条（`/model`、`/clear`），
  pi 那套有几十条命令 + 扩展注册机制，不是这一轮的事。
- **不做主题系统**。pi 有 1336 行的 `theme.ts` 和 theme-selector，我们先用固定配色——
  但「固定配色」不是「没有主题对象」：`Editor` 与 `Markdown` 的构造函数都要求一份主题，
  所以 P0 / P2 各交一份**常量**（见 §二、§五）。
- **不做 session 选择器 / 恢复界面**。协议现在也不支持（见 §六）。
- **不做扩展提供的自定义编辑器**（pi 的 `setEditorComponent` 那套）。
- **不自创键位**。照 pi（§九 D2）；pi 没有的键不加。
- **运行中不换 provider / 模型**。首次运行的引导设置里可以选（D4，那时还没装配）；装配之后换家换模型是 P3 `/model` 的事（§三）。
- **不动 core**。P0–P2 一行协议都不改——这是刻意的，见 §七。

### 已决（记录见 §九）

- 首次运行没有凭据 → **起来，进配置流程**，已落地 main（D1）。
- 键位**照 pi**（D2）。
- **配置是运行态，不阻塞启动**（D3）；首次运行是**引导设置**：欢迎 → 选 provider → 贴 key → 选模型，样子照 Claude Code 的选择器（D4）。

### 待拍板

1. **P3b-b：`/sessions`。** 跨 provider 换模已落地（D7）；会话面在 Agent 上只有半套
   （`sessions.create` 在、列表/切换的公共形状没定），往封闭协议加一组它，要带着具体界面单独来提。
   **2026-09-01 用户暂缓**：「这涉及到核心层面的更改」——等核心侧想清楚由用户发起，UI 线不推进它。
### 验收判据

每阶段各自的判据写在对应小节。总的两条：

- **P0–P2 结束时，`packages/core` 的 `api-snapshot.txt` 逐字未变**——如果变了，说明有人在壳里
  做不下去就去改协议，那正是这份方案要避免的顺序。
- **P0 起，`packages/cli/src/` 里按键判定只走 `matchesKey()` / `isKeyRelease()` / `decodeKittyPrintable()`**，
  且 `packages/cli/test/` 里有一条**真 PTY** 测试把 Kitty 编码与应用光标键编码送进去。
  为什么是硬门而不是纪律，见 §二「按键处理的纪律」。

---

## 一、布局（P1 起按行拼三段；P2 起对话区是 Container）

照 pi 的三段式（`interactive-mode.ts:589-611`）：

```
┌─ documentContainer ──────────────── 文档流，随内容增长，终端负责滚动
│  ├─ headerContainer      欢迎信息（启动时一次）
│  └─ chatContainer        对话：用户消息 / 助手消息 / 工具调用 / 权限询问
├─ editorContainer ────────────────── 输入行，固定在底部上方
└─ footerContainer ────────────────── 状态栏，最底部一行
```

用 pi-tui 的 `Container` 拼，不自己算坐标。`TuiMainScreen` 已经在用了。

**换 Container 买到的是结构，不是重绘性能。** 两件事分开说：

- **原地更新现在就有**：`app.ts` 的 `message_update` 走 `transcript.setAssistantText(streamingIndex, partial)`，
  `tool_execution_end` 走 `transcript.updateTool(row, …)`。这不是换 Container 才做得到的。
- **重绘粒度由 TUI 决定，不由组件树决定**：pi-tui 的 `TUI` 本身就是 differential rendering
  （`dist/tui.js:2`、`:70`），给它一个大字符串还是一棵组件树，它都按行 diff。

Container 真正带来的是：**每条消息是一个组件，持有自己的状态、响应自己的按键**——
工具调用能不能折叠 / 展开（P2 的重点，pi 的 Ctrl+O），取决于那一条有没有自己的状态。
现在的 `Transcript` 是一份扁平数组，条目没有状态，折叠做不了。

---

## 二、输入行（P0，**已落地** `eff6dec`）

### 用 `Editor`，不是 `Input`

```text
import { Editor, setKeybindings } from "@earendil-works/pi-tui";
```

`EditorComponent` 是接口（安装包 `dist/editor-component.d.ts`；源码在 pi 仓
`packages/tui/src/editor-component.ts`），`Editor` 是实现（pi-tui 根入口导出）。
**多行是这个组件本身就有的行为**，不需要我们决定。

接口里已经给了的（我们不用自己实现）：

| 能力 | 接口方法 |
|---|---|
| 取值 / 设值 | `getText()` / `setText()` |
| 提交 | `onSubmit?: (text) => void` |
| 变更通知 | `onChange?: (text) => void` |
| **历史** | `addToHistory?(text)` ← **编辑器自己管，不是应用层** |
| 光标处插入 | `insertTextAtCursor?(text)` |
| 补全 | `setAutocompleteProvider?(provider)` |
| 边框色 / 内边距 | `borderColor?` / `setPaddingX?()` |

pi-tui 里还有这些现成的，属于 `Editor` 内部行为，接上就有：
`word-navigation.ts`（按词移动）、`undo-stack.ts`（撤销）、`kill-ring.ts`（Ctrl+K/U 删到行首尾）。

### 主题：P0 要交一份 `EditorTheme` 常量

`Editor` 的构造函数是 `new Editor(tui, theme: EditorTheme, options?)`（`dist/components/editor.d.ts:72`）——
**主题不是可选项**。「不做主题系统」的意思是不做切换、不做加载，不是不给主题：
P0 交付物里要有一份写死的 `EditorTheme` 常量（放 `packages/cli/src/theme.ts`，P2 的 `MarkdownTheme` 也进去）。

### 键位：照 pi

两层。**编辑器内**的键是 pi-tui 的缺省（`dist/keybindings.js`），一条都不改；
**应用级**的键照 pi 的 `app.*`（pi 仓 `packages/coding-agent/src/core/keybindings.ts:92-130`）。
表里的行号都是这两个文件的。

落点：`packages/cli/src/keybindings.ts`——`APP_KEYBINDINGS` 登记应用级键，`installKeybindings()` 把它与
`TUI_KEYBINDINGS` 合成一个 `KeybindingsManager` 并 `setKeybindings()` 装成全局（`Editor` 内部走
`getKeybindings()` 取键，不装就是两份真源）。`app.ts` 里所有判定都是 `keys.matches(data, "app.…")`。

编辑器内（缺省，不用注册）：

| 键 | 行为 | 出处 |
|---|---|---|
| **Enter** | **提交** | `tui.input.submit`（:75） |
| Shift+Enter / Ctrl+J | 换行 | `tui.input.newLine`（:74） |
| ↑ / ↓ | **首行且（空 / 正在翻历史 / 光标在行首）时翻历史**，否则移光标 | `dist/components/editor.js:675-681` |
| Alt+← / Alt+→（也认 Ctrl+←/→、Alt+B/F） | 按词移动 | `tui.editor.cursorWordLeft/Right`（:21-26） |
| Ctrl+A / Ctrl+E | 行首 / 行尾 | `tui.editor.cursorLineStart/End`（:29-34） |
| Ctrl+U / Ctrl+K | 删到行首 / 行尾 | `tui.editor.deleteToLineStart/End`（:63-68） |
| Ctrl+- | 撤销 | `tui.editor.undo`（:73） |
| Ctrl+D | **有字时**向前删一个字符 | `tui.editor.deleteCharForward`（:52） |

应用级（要用 `setKeybindings()` 注册，P0 只接前三个）：

| 键 | 行为 | pi 的名字 | 我们接哪个协议方法 |
|---|---|---|---|
| **Esc** | 中断当前这一轮 | `app.interrupt`（:92） | `runtime.abort()` |
| **Ctrl+C** | **清空输入行**（不是退出） | `app.clear`（:93） | `editor.setText("")` |
| **Ctrl+D** | **输入行为空时**退出 | `app.exit`（:94） | 结算 `exited`（`extension.ts`） |
| Ctrl+O | 展开 / 收起工具输出 | `app.tools.expand`（:112） | P2 |
| Ctrl+L | 打开模型选择器 | `app.model.select`（:111） | P3（要 `setModel`） |
| Ctrl+P | 切到下一个模型 | `app.model.cycleForward`（:103-106） | P3 |
| Alt+Enter | 跑着的时候追加一条 | `app.message.followUp`（:129-130） | `runtime.followUp()` 协议已有，本轮不排期 |

三条要写清楚的边界：

- **Ctrl+D 两个含义怎么并存**：应用级先看 `editor.getText() === ""`，空就退出，
  不空就放行给编辑器（它会删一个字符）。pi 的描述就是「Exit when editor is empty」。
- **Ctrl+C 不再退出**。现在 `app.ts` 是 Ctrl+C 退出，P0 之后变成清空输入行——这是照 pi 的代价，
  欢迎界面的提示行必须写「Ctrl+D 退出」，否则用户按 Ctrl+C 只会看到输入被清掉。
- **历史的专用键缺省是空的**：`tui.editor.historyPrevious/Next` 的 `defaultKeys: []`（:5-11）。
  ↑ 能翻历史靠的是上表那条回退规则——单行草稿时按 ↑ 直接翻，多行草稿时 ↑ 先移光标到首行。
  P0 不另绑专用键。

**权限询问那段的 `y` / `n`**：现在是在 `root.handleInput` 里判字符（`app.ts:281-282`），
那是临时做法，不该扩散。P0 把它也登记进 `setKeybindings()`，走同一条路。

### 按键处理的纪律（机器可判）

**`handleInput` / `addInputListener` 里一律 `matchesKey()`，禁止比较字节。** 理由是真终端上撞到的
（2026-08-31）：pi-tui 的 `ProcessTerminal` 会探测并启用 Kitty 键盘协议（`dist/terminal.js:120`），
之后 Ctrl+C 到达是 `ESC[99;5u` 而不是字节 `0x03`，↓ 可能是应用光标键模式的 `ESC O B` 而不是 `ESC[B`
（`dist/keys.js:237-238` 两种都列着）。`app.ts:304` 那句 `data.includes(String.fromCharCode(3))`
在那种终端里一次都不成立——**退不出去**。Kitty 协议还会给同一次按键补发一条 release，
所以每个入口先 `isKeyRelease()` 滤掉，否则按一下等于按两下；数字直选要先 `decodeKittyPrintable()`
解码（`1` 在那种终端里是 `ESC[49u`）。

为什么是门不是纪律：**假 TUI 测不出这类 bug**——`fake-tui.ts` 的 `feed()` 直接把字符串交给
`handleInput`，绕过了终端编码这一层。所以：

- `packages/cli/test/key-discipline.test.ts`：`packages/cli/src/` 里（递归）`fromCharCode` 只许出现在拼 ANSI **输出**常量的
  那种行上（`const ESC = String.fromCharCode(27);`）与注释里，其余一律红；门自带正反例自检。
- `packages/cli/test/tui-pty.test.ts`（驱动在 `packages/cli/test/pty-driver.py`，python3 标准库的 `pty`——Bun 1.3 没有 pty）：
  真 PTY 里把 `ESC[100;5u`（Kitty 的 Ctrl+D）、`ESC[99;5u`（Kitty 的 Ctrl+C）、`ESC O B`（应用光标键 ↓）
  送进去，断言**行为**（退没退出、光标到没到下一家）而不是抓屏——差分渲染下旧帧还在缓冲里，
  抓屏会把「清掉了」误判成「还在」。没有 python3 时这条门**红而不是跳过**。

假 TUI 有一个坑，写测试时会撞到：`Editor.render()` 按 `tui.terminal.rows * 0.3` 算可见行数
（`dist/components/editor.js:386-387`），`fake-tui.ts` 的 `terminal` 必须给 `rows`（现在是 24），
给空对象会得到 `NaN` → 一行正文都不画、屏幕上只剩两条边框。

### P0 验收

- 能输入多行、能改中间的字、能撤销（Ctrl+-）
- 单行草稿下 ↑ 能翻出上一条输入
- Enter 提交、Shift+Enter 换行、Esc 中断、Ctrl+C 清空、**Ctrl+D 空时退出**——五条各一个假 TUI 测试
- 权限询问的 `y` / `n` 从 `handleInput` 里的字符比较移进 `setKeybindings()`
- `packages/cli/src/theme.ts` 里有 `EditorTheme` 常量
- 按键纪律那两条门（grep + 真 PTY）绿
- **`api-snapshot.txt` 逐字未变**

---

## 三、欢迎界面（P1，**已落地** `ac9f9c4`）

pi 的做法在 `packages/coding-agent/src/cli/startup-ui.ts`。它做了四件事，我们**只取第一件**：

| pi 做的 | 我们 |
|---|---|
| 建 TUI、设键位、初始化主题 | ✅ 取（主题用 §二那份常量） |
| 首次运行检测（`shouldRunFirstTimeSetup`，`startup-ui.ts:115-127`） | ❌ **不取，已有自己的**：它判的是 `isOfficialDistribution && areExperimentalFeaturesEnabled && settings 路径`，我们判的是 `Models.checkAuth()`，两回事 |
| 加载扩展主题、包管理器解析 | ❌ 不取 |
| OAuth / 登录对话框 | ❌ 不取 |

欢迎界面本身显示什么（一次性，进 `headerContainer`）：

```
echo-agent  <version>
<cwd>
模型 <model.id> · <provider>                       ← 来自 AgentState.model
Enter 发送 · Shift+Enter 换行 · Esc 中断 · Ctrl+D 退出 · ↑ 历史
```

**首次运行（没有凭据）走引导设置**（D4，2026-09-01）：`first-run.ts` 的 `runFirstRunSetup()`，
欢迎头 → **选择 provider**（编号列表 + 光标，描述列派生自目录）→ 贴 key（掩码，回车验证并保存）→
**选择模型**（该家目录，缺省 ✓ 预选中，回车即用；这次会话生效，`--model` 固定）→ 直接进对话。
样子照 Claude Code 的选择器：标题与说明在上、列表在下。列表用 pi-tui 的 `SelectList`
（↑↓/回车/Esc 内置，Kitty 编码天然认得），数字直选与 Ctrl+D 退出走 `matchesKey`。

**它跑在 `createEcho()` 之前**：选哪家、哪个模型本来就得在装配前定（模型解析在装配期，
运行中换模型是 P3）。**这不是回退 D3**——装配仍不看凭据；两条运行态路径都在：

- key **中途**失效（端点报 `auth`）：主界面里摆出配置段（`setup.ts` 的 `CredentialSetup`，
  只收当前那家的 key），配好不用重启；
- 读不了凭据文件：不挡启动，说一句、当成没配。
- 管道 / CI 形态不变：启动前同一个 `isConfigured()` 拦下，退出码 1。

模型选择的**持久化**（记住上次选的）是一个新落盘格式，没拍板不做——列在待拍板。

P1 对这块的视觉对齐已并入 D4 的实现。

### P1 验收

- 状态栏显示模型、用量、状态三项起
- 欢迎界面显示版本、cwd、模型、键位提示（提示行的键与 §二一致）
- 配置段与输入行同一套边框与配色
- **`api-snapshot.txt` 逐字未变**

---

## 四、状态栏（P1，**已落地** `ac9f9c4`）

pi 的 `footer.ts` + `FooterDataProvider`。这是**验证 UI 协议够不够用的地方**——
它显示的每一项都必须能从 `AgentRuntime.state` 拿到。

依据只有一行：`AgentRuntime.state` 就是**整个** `AgentState`（`packages/core/src/extension/runtime.ts:50-54`，
「给整个 `AgentState`（2026-08-31 用户拍板），不收窄成『UI 以为要的那几项』」）。所以下表的 ✅ 不是逐项查出来的，
是那一行的推论：

| 显示 | 来源 | 有没有 |
|---|---|---|
| 当前模型 | `state.model.id` / `.provider` | ✅ |
| token 用量 | `state.usage` | ✅ |
| 运行状态 | `state.status` | ✅ |
| 当前轮次 | `state.iteration` | ✅ |
| 待办任务数 | `state.tasks` | ✅ |
| 激活的 skill 数 | `state.activeSkills.length` | ✅ |
| MCP 服务器状态 | `state.mcp` | ✅ |
| cwd / git 分支 | **壳自己拿**（`process.cwd()` + git 命令） | — |

**八项里七项现成**。这一步不需要动协议，做完就能回答「现有 state 够不够渲染一个状态栏」。

成本（$）显不显示见「待拍板 1」——P1 先只显示 token。

---

## 五、消息渲染（P2，**已落地** `db2a36d`）

现在所有消息都是纯文本拼进 transcript。换成按类型分组件（对照 pi 的
`modes/interactive/components/`）：

| 消息类型 | 组件 | pi 的对应 | 要点 |
|---|---|---|---|
| 用户消息 | `UserMessage` | `user-message.ts` | 缩进 + 前缀，与助手消息区分 |
| 助手消息 | `AssistantMessage` | `assistant-message.ts` | **走 pi-tui 的 `Markdown` 组件**，不要自己拼（pi 就是 `new Markdown(…)`，`assistant-message.ts:111`） |
| 工具调用 | `ToolExecution` | `tool-execution.ts` | **可折叠**：默认收起，显示工具名 + 一行摘要；**Ctrl+O** 展开看完整参数与结果（pi 的 `app.tools.expand`） |
| thinking | 单独样式 | — | 暗色/斜体，与正文区分 |
| 权限询问 | 已有 | — | 保留现有逻辑，只换渲染 |

**`Markdown` 也要主题**：`new Markdown(text, paddingX, paddingY, theme: MarkdownTheme, …)`
（`dist/components/markdown.d.ts:64`），`MarkdownTheme` 14 个必填字段。`theme.ts` 里的
`MARKDOWN_THEME` 就是那份常量，与 `EDITOR_THEME` 同放。

落点：`messages.ts`（四个组件）+ `text.ts`（`clean()` / `wrap()`，清洗仍在 `Transcript` 入口做）+
`transcript.ts`（一个 Container 装组件，对外方法不变，多了 `setAssistantContent` / `toggleTools`）。
实测 `Markdown` 的三个行为，写测试时要知道：单换行是**硬**换行（逐行输出的正文不会被挤成一段）；
四空格缩进**不会**被当代码块；每行右侧补空格到宽度，要 `trimEnd`（不然空行变一串空格、
「每行不超过宽度」那条老判据也过不了）。

**工具调用的折叠是这一阶段的重点。** 折叠之前工具的参数和结果全量打在流里，一个
`read_file` 就能刷屏。展开与否是**全局**开关（Ctrl+O 一键看全部，pi 同款），由 `Transcript` 持有、
每条 `ToolExecution` 现读——各条自己记一份就得逐条去按。折叠时一行「标记 + 名字 + 一行 JSON 摘要」，
展开时参数多行 JSON + 结果全文缩在 `│` 后面。**结果 `content` 也过 `clean()`**：它来自工具，
和模型正文一样不可信。

流式消息（`state.streamingMessage`）的原地更新**现在就有**（§一），P2 只是把它从
「改 transcript 里的一个字符串」换成「改那个 `AssistantMessage` 组件的文本」，行为不变。

### P2 验收

- Markdown 正确渲染（代码块、列表、表格）
- 工具调用默认折叠，Ctrl+O 展开 / 收起
- 长输出不刷屏
- `theme.ts` 里有 `MarkdownTheme` 常量
- **`api-snapshot.txt` 逐字未变**

---

## 六、交互能力（P3a **已落地**，提交见 git log「P3a」；P3b 待拍）

前三阶段一行协议都不用改。到这里会撞上：

| 想做 | 协议现状 | 缺什么 | pi 的键 |
|---|---|---|---|
| `/model` 切换模型 | 只能读 `state.model` | **`setModel()`** | Ctrl+L 选择器（`SelectList`）、Ctrl+P 轮换 |
| 切 thinking 档位 | 只能读 `state.thinkingLevel` | **`setThinkingLevel()`** | Shift+Tab |
| `/sessions` 切换会话 | 只有 `state.sessionId` | **会话列表 + 切换** | — |
| `/clear` 清空对话 | — | 待查（可能 `abort` + 新 session） | — |

这三条性质一致：都是**慢变装备的改动**。`AgentState` 的注释写着「装备（慢变；**仅 idle 可换**）」
（`packages/core/src/agent.ts:83`），说明底层支持换，只是没在 UI 协议上开口。

**开口的成本比「加两个方法」大**，两件事要一起算：

- **`AgentRuntime` 是封闭协议**（`runtime.ts:16-19`）：「加一支就是改契约……值得配一套 conformance」。
  所以每加一个方法 = 改契约 + 改 conformance suite + 两个壳都跟上。
- **「仅 idle 可换」是一条判定链**：非 idle 时 `setModel()` 怎么办——拒绝并返回原因（像 `steer` / `followUp`
  那样给显式结果，不抛不静默），还是排队到 idle 再换？这决定协议方法的返回类型，要先拍（待拍板 2）。

**到这一步再提协议扩展**，带着具体用例来提——这是分阶段的全部理由。

---

## 七、分阶段的理由

| 阶段 | 动协议吗 | 做完能回答什么问题 |
|---|---|---|
| P0 输入行 | 否 | 壳子的基本可用性 |
| P1 欢迎 + 状态栏 | 否 | **现有 `AgentState` 够不够渲染一个产品级界面** |
| P2 消息渲染 | 否 | 事件流够不够驱动一个可读的界面 |
| P3 交互能力 | **是**（封闭契约 + conformance 一起改） | 协议缺的到底是哪几个方法 |

前三阶段刻意不碰协议，是为了把「壳子做得不好」和「协议不够用」分开。
做完 P0–P2 还不好用，那是壳的问题；到 P3 卡住了，才是协议的问题——
而那时提出的每一条扩展需求，背后都有一个做不下去的具体界面。

## 八、参考位置速查

**装在本仓里的 pi-tui 是判据**（版本以 `bun.lock` 为准，现在是 0.84.4）；pi 仓的源码是拿来读注释的。

| 要看什么 | 位置 |
|---|---|
| 编辑器内缺省键位 | `node_modules/@earendil-works/pi-tui/dist/keybindings.js` |
| 编辑器构造 / `EditorTheme` | 同上 `dist/components/editor.d.ts` |
| `EditorComponent` 接口 | 同上 `dist/editor-component.d.ts` |
| `Markdown` 构造 / `MarkdownTheme` | 同上 `dist/components/markdown.d.ts` |
| 按键匹配 / Kitty 协议 | 同上 `dist/keys.js`、`dist/terminal.js` |

| 要抄什么 | pi 的文件（`~/Code/pi`） |
|---|---|
| **应用级键位缺省** | `packages/coding-agent/src/core/keybindings.ts:92-130` |
| 整体布局与容器拼装 | `packages/coding-agent/src/modes/interactive/interactive-mode.ts:589-611` |
| 编辑器构造 | 同上 `:600-606` |
| 欢迎 / 首次运行 | `packages/coding-agent/src/cli/startup-ui.ts` |
| 状态栏 | `packages/coding-agent/src/modes/interactive/components/footer.ts` |
| 工具调用渲染 | 同目录 `tool-execution.ts` |
| 助手消息渲染 | 同目录 `assistant-message.ts` |
| 键位提示 | 同目录 `keybinding-hints.ts` |

## 九、决策记录

| # | 日期 | 决定 | 状态 | 理由 / 去处 |
|---|---|---|---|---|
| D1 | 2026-08-31 | 首次运行没有凭据时**起来、进配置流程**，而不是退出；配置流程跑在 `createEcho()` 之前 | 已落地 `59989b1`，**2026-09-01 被 D3 取代**（那一版是启动前一屏向导） | 管道 / CI 保持退出码 1；终端有人坐着就问。原「待拍板 1」 |
| D2 | 2026-09-01 | **键位照 pi**：编辑器内用 pi-tui 缺省，应用级照 pi 的 `app.*` | **已落地** main `eff6dec`（`keybindings.ts` / `app.ts`；P0 其余交付物同一提交） | 库的缺省就是 pi 的键；自创一套（原稿的 Enter 换行 / Ctrl+D 提交 / 双击 Ctrl+C 退出）和库缺省三处相撞。§二 |
| D3 | 2026-09-01 | **配置是运行态，不阻塞启动**：常驻 agent 的存活不以任何外围配置为前提（热部署、成熟产品）。装配不看凭据（core `create-agent.ts` 用完整目录解析模型）；key 中途失效在主界面里配，配好不用重启；管道 / CI 仍在启动前报错退出 | **已落地** main `b7c0338`（core `create-agent.ts`；cli `app.ts` / `setup.ts` / `cli.ts`） | pi / Claude Code 都是界面先起来、key 是进去之后的事；上一版把 SDK 的装配纪律直接暴露给了坐在终端前的人。扩展那条同一原则、另拍（待拍板） |
| D4 | 2026-09-01 | 首次运行走**引导设置**：欢迎 → 选 provider → 贴 key → 选模型（缺省 ✓ 预选中），样子照 Claude Code 的选择器，列表在说明下面；跑在装配前 | **已落地** main `5a6c417`（`first-run.ts`） | 用户拍板「进来是欢迎，然后指导用户去设置 api，可以选择模型」。选哪家 / 哪个模型只能在装配前定（换模型是 P3）；同时修掉「还没有凭据」说两遍的重复。§三 |
| D8 | 2026-09-01 | 状态栏**只显示 token，不显示 $**；加**缓存命中**一格（`缓存 600 (60%)`）。`Usage` 加可选 `cachedInputTokens`（provider 没报就缺席——0% 是没命中、缺席是没报，两回事）；方言认 OpenAI 系与 DeepSeek 两种上报形状 | **已落地**（core `messages.ts` / `openai.ts` / `agent.ts`；cli `app.ts`；提交见 git log「D8」） | 用户拍板「token 就够，但要看到 cache 缓存情况」。$ 若将来要，走目录里的 `Model.cost`（唯一真源），不建 CLI 价格表。原「待拍板 1」 |
| D7 | 2026-09-01 | **跨 provider 换模 + 记住选择**：装配全量注册五家（core 加 `CreateAgentOptions.providers`，Models 本来就是 map）；Ctrl+L 跨家平铺（未配 key 标在描述最前），选了没配 key 的家照样切、**主动**弹配置段；`$ECHO_HOME/settings.json` 记 `{model:{provider id, 模型 id}}`，向导与 Ctrl+L 都写入，显式 `--provider`/`--model` 永远赢，记忆坏了/过期了口信 + 回缺省、不挡启动 | **已落地**（core `create-agent.ts`；cli `settings.ts` / `app.ts` / `cli.ts`；提交见 git log「P3b-a + D7」） | 用户拍板「切换了之后重启还要能用」。原「待拍板 2 前半 + 待拍板 3」。§六 |
| D6 | 2026-09-01 | **坏扩展不阻塞启动**：盘上发现的扩展 load / mount 失败 → 记 `Diagnostic`（`Echo.diagnostics`）、跳过它，agent 照起，TUI 发「[扩展] 没装上」notice、管道模式写 stderr；**显式传入的**（`opts.extensions`、inline 工具）保持 fail-loud——那是代码 bug 不是运行态配置。实现：盘上每个扩展各占一个 generation（Host mount 按代全有或全无，跨代绑定成立），坏 apply 只回滚自己那代 | **已落地**（core `create-echo.ts`；cli `extension.ts` 的 `TuiShell.notify` / `cli.ts`；提交见 git log「D6」） | 用户拍板「没有其他 extension 都不能作为我们不能启动的原因——热部署、成熟产品」。原「待拍板 4」。三个子问题的答案：诊断走 `Echo.diagnostics` + 壳的旁白通道；坏的跳过、其余照装；O4 reload 到来时同一诊断路径复用 |
| D5 | 2026-09-01 | **P3a 协议开三支**：`setModel` / `setThinkingLevel` / `reset`，协议保持**封闭**；忙时 `rejected` 带原因、**不排队**（steer/followUp 同款显式结果）；绿灯 = 下一轮生效（admission 冻结 binding 保证本轮不撕裂）。UI：Ctrl+L 选择器（当前 ✓）、Shift+Tab 轮档、`/clear`（协议清真相 + 壳清投影）。跨 provider 与 `/sessions` 拆到 P3b | **已落地**（core `runtime.ts` / `builtin.ts`；cli `app.ts`；提交见 git log「P3a」） | 机制早在 Agent 上（装备 setter `agent.ts:787`、`reset()` `:1077`），缺的只是协议口；排队会让「我换了模型」几分钟后突然生效——那是惊吓不是功能。原「待拍板 2」。§六 |
