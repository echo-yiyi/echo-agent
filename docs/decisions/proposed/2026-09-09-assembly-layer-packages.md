# 装配层独立成 `@echo-agent/base` 与 `@echo-agent/tui`；产品只剩身份与自带扩展；启动器从模板方法改成部件

> 状态:proposed · 提出 2026-09-09 · 拍板 2026-09-09(口头,实现后移入 implemented) · 来源 2026-09-09 设计对话 · 上位记录:[受众与版本](2026-09-07-audience-and-versioning.md) · 相关:[`Agent` 类内部化](2026-09-07-agent-class-internal.md)、[角色定义](2026-09-07-role-agent.md)

## 现状(拍板前)

`packages/cli/`(包名 `echo-agent`,3836 行)同时是四样东西:

| 角色 | 代表文件 | 行数 |
|---|---|---|
| 产品 `echo-agent` 本身 | `product.ts` 的身份段与 preset、`bin/` | 123 |
| 产品框架 | `cli.ts` 的 `mainFor`、`Product` / `PresetForm` 契约 | 662 |
| 两个壳 | TUI 一组(`app.ts`、transcript、键位、slash、主题)与管道壳 | 2063 |
| 宿主能力 | 凭据、设置、读 AGENTS.md、`observe` 面板 | 900+ |

由此长出四处后果,都能落到代码:

1. **产品依赖另一个产品**。`@echo-agent/coding` 的 `dependencies` 里写着 `echo-agent`,只为了 `mainFor`。产品本体(`packages/coding/`,470 行)只依赖 core。
2. **产品能加不能减**。`mainFor` 是模板方法:产品经 `Product.preset` 填空,返回值被限定为 `createEcho()` 的 `agent` 与 `extensions`;纪律段与项目指令段由 `echoOptions` 硬挂在 `preset` 之外。这与 [prompt 设计](../../design/prompt.md) §2 的所有权表冲突——那张表写着「通用 / coding 身份与**纪律**」的 owner 是产品。
3. **症状已经在评测里出现**。纪律段有「动手前先确认」一条,而非交互跑(Docker 里的 SWE 评测)没有人能答:模型照着它去调 `ask_user`,白费一轮。产品想换掉这条也换不了。
4. **`PresetForm` 被迫夹带资源**。`credentials` 塞在「形态」里(2026-09-04),因为产品需要宿主能力而契约里没有通道。
5. **做 web 壳的第三方被迫装终端库**。`@earendil-works/pi-tui` 是 `echo-agent` 包的依赖;装配层与壳同包,取装配就得取壳。

词表也把一种接线写进了定义:`CONTEXT.md` 的「产品」是「**交给 echo-agent 启动逻辑的**名字、版本与装配片段」。按这个定义,自己写壳的产品不叫产品。

## 不拍板的代价

每加一个产品,都要在「复制一份启动器」和「继承 echo-agent 的 prompt 与依赖」之间二选一。前者踩 `cli.ts` 头注记着的那个坑(两套参数解析会分家,实测过加 provider 只改了一边);后者就是今天评测里那个问题。而 [受众与版本](2026-09-07-audience-and-versioning.md) 已经把受众定成「第三方可装的内核」,这两条都不该是第三方要面对的选择。

## 选项

- **A. 拆成 `@echo-agent/base` 与 `@echo-agent/tui`,启动器改组合,产品只剩身份与自带扩展。**
- **B. 只把纪律段挪进产品的 preset,包不动。** 止血,但依赖方向、`PresetForm` 夹带、终端库连坐都还在。
- **C. 每个产品自己写启动器。** 依赖方向干净,代价是为 470 行的产品本体复制 1300 到 3200 行,并踩上面那个已实测的坑。

## 决定

**A**(2026-09-09 用户拍板:「启动器至少现在看起来,我认为是装配层」「我们应该加一个 base 包,把最基础的放到那个里面去」)。**B 作为 A 的第一批先落地**,因为它单独就能解掉评测里的症状。C 否掉。

### 包图

```
@echo-agent/core     机制。零运行时依赖,不出可执行文件
@echo-agent/base     装配层:产品身份契约、启动器部件(参数、凭据、会话解析、装配、收摊)、
                     宿主能力(凭据落盘、设置、读 AGENTS.md、observe)、管道壳
@echo-agent/tui      终端壳。依赖 pi-tui
echo-agent           产品:身份段、纪律段、bin
@echo-agent/coding   产品:身份段、纪律段、四条工具扩展、bin
```

依赖:core ← base ← {tui, 各产品};产品之间平级,互不依赖。**base 不 import 任何壳**——「交互形态起哪个壳」由产品的 bin 决定,不再由装配层写死。

### 三档形态(本条第一次写下来)

| 档 | 用户做什么 | 产品是谁 | 能带来新工具的实现吗 |
|---|---|---|---|
| 配置 | 角色文件(identity、工具子集、模型)、skills、MCP | 仍是 echo-agent | 不能,只能从已有的里挑 |
| 本地扩展 | `extensions/` 目录里写代码 | 仍是 echo-agent,能力变了 | 能 |
| 独立产品 | 自己的包与 bin,选我们的壳或自己写 | 新产品 | 能 |

`echo-coding` 属于第三档:它的核心是文件、shell、worktree、web 这些工具的**实现**,是代码不是配置。它今天却按第一档接线(把 preset 交给 `mainFor` 填空),这就是上面四处后果的共同来源。

### `Product` 契约:留身份,去填空

`Product` 从「填空表」收成「身份牌」。`preset` 回调随组装式启动器消失——产品的 bin 自己列扩展与 agent 选项。**产品名必须留**:它经 `createEcho({ product })` 写进会话 meta,`--continue` 跨进程按「本目录 + 本产品 + 自己起的」三维筛(`cli.ts` 的 `resolveSessionId`),observe 面板也按它反查。去掉它,同一目录里两个产品的会话会重新混在一起——那是 2026-09-01 修过的实测缺陷(coding 续了通用 agent「我没有文件工具」的结论)。`version` 只进欢迎头,去留随意。

### 纪律段

base **导出**缺省纪律段,产品**显式挂**。共享文本仍是一份,但没有人能塞给产品。非交互形态要换掉「先确认」那条,是产品自己的事,不必给装配层加开关。

## 待拍板(本条未议)

- **扩展能不能声明 agent 级选项**(`permission` / `maxIterations` / `questions`)。今天只有产品的 preset 能给,扩展的 registry 里没有对应的口(`packages/core/src/extension/registries.ts` 有 tools / hooks / skills / prompt / compaction / memory,没有 options)。不开这个口,上表的第二档与第三档不等效——本地扩展能加工具、改 prompt,但改不了权限与预算。
- **`observe` 是否独立成包**。本次决定留在 base:它现在拆没有收益。

## 验收

`@echo-agent/coding` 的 `dependencies` 里没有 `echo-agent`;`@echo-agent/base` 的 `dependencies` 里没有终端库;`packages/base/src` 里 grep 不到任何壳的入口(`runTui`);两个产品的 system prompt 与工具集逐字不变(`packages/coding/test/identity.test.ts` 的 digest 不变);`PresetForm` 不再携带 `credentials`;非交互形态下 `echo-coding` 的纪律段不含「先确认」那条。
