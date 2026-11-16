# 工具独立成包：文件、搜索、shell、web 四组工具从 `echo-coding` 搬到 `@echo-agent/tools`

> 状态:implemented · 提出 2026-11-15（用户：「core 稳定且强大，放在任何 agent，所有的设计都能用，coding 只是装配后的一个形态……coding 是不是有一些不属于他的」）· 拍板 2026-11-15（用户：「没问题，按照推荐走吧」，选项 A）· 实现 2026-11-15 · 落地 `packages/tools/`、`packages/coding/src/agent.ts` / `extensions.ts` / `prompt.ts` / `index.ts`、`scripts/release.ts`、`test/distribution-gate.test.ts`

**给谁看**：要给一个产品加文件 / shell / web 能力的人，和改这几组工具的人。假设已知 [装配层独立成包](2026-09-09-assembly-layer-packages.md) 定下的依赖方向与「产品之间平级」。

**一句话**：对外部世界动手的工具不属于哪个产品。它们住 `@echo-agent/tools`，只依赖 core 与 base；产品在自己的 preset 里挂要的那几条。`echo-coding` 只剩身份、编码纪律、缺省值、权限缺省与 git worktree。

## 现状（拍板前）

`packages/coding/src` 共 2619 行，其中文件（`fs.ts`）、搜索（`search.ts`）、shell 与沙箱（`bash.ts` / `sandbox.ts`）、web（`web.ts`）及它们的两段 prompt、三条 extension 定义约 1800 行，没有一行是编码才有的知识。产品之间互不依赖，于是通用产品 `echo-agent` 与任何第三个产品都拿不到它们：要读文件、跑命令、上网，只能依赖另一个产品或重写一遍——重写的那一遍会漏掉工作区越界判定、剥 echo 自己的 key、内网地址拒绝这些安全边界。

2026-08-04 的判据「对外部世界动手的工具不住 core」定的时候 core 上面只有一层；2026-09-09 拆成 base / tui / 两个产品之后，这些工具落进了其中一个产品，判据没说它们该归哪个包。

## 选项

- **A. 新开一个包**，依赖 core 与 base，产品按需挂。
- **B. 放进 core 作为可选扩展**。要推翻 08-04 判据（core 开始碰子进程与网络），还得把 base 的图片加载搬进 core；工具的文字改动最频繁，会搅动 core。
- **C. 放进 base**。不加包，但装配层的定义就糊了：base 是「把一个产品跑起来」，不是「agent 能做什么」。

## 决定

**A**。

- 包：`packages/tools`（`@echo-agent/tools`）。依赖方向 `core ← base ← tools ← 产品`；tools 与 tui 互不依赖。它依赖 base 只为 `read_file` 读图片用的图片加载。
- 搬过去的：`echo:workspace` / `echo:shell` / `echo:web` 三条 extension 定义、`makeFsTools` / `makeSearchTools` / `makeShellTools` / `makeBashTool` / `makeWebTools`、执行后端与沙箱（`ShellBackend` / `detectSandbox`）、越界守卫 `resolveSafe`、`tool:workspace` / `tool:shell` 两段 prompt，以及各自的测试。extension 名、工具名、段名与段文本一个字节不变。
- 留在 `echo-coding` 的：`echo:coding`（身份与编码纪律）、`echo:worktree`（git worktree）、`codingPreset()` 与产品缺省、权限策略。`codingPreset()` 挂上 tools 的三条。
- `@echo-agent/coding` 的公共面不再导出这些工具（`ECHO_SHELL`、`ECHO_WORKSPACE`、`makeFsTools`、`resolveSafe`、`makeBashTool`、`makeShellTools`、`makeSearchTools`、`BashDeps`）：没有兼容转发，要用的从 `@echo-agent/tools` 拿。
- `web_fetch` 的 `user-agent` 从 `echo-coding` 改成 `echo-agent`：共用的工具不该报某一个产品的名字。

## Non-Goals

- **不改 `echo-agent` 的工具集**。通用产品仍然一件对外的工具都不挂；它要不要挂、挂哪几条是另一个决定。
- **不把工作区越界判定、echo 凭据的名单、外来内容的来源说明搬进 core**。搬出产品之后它们已经是所有产品共用的一份；再进 core 要等出现「不装 tools 也需要它」的消费者。
- **不动权限策略与安全分类器**。分类器同日由另一条线搬进了 core（[安全加固](2026-11-15-security-hardening.md)）；规则表（allow / deny / ask）的归属本条不碰，`packages/coding/src/permission.ts` 没有改动。
- 不改任何工具的行为、描述与 prompt 文本（`user-agent` 除外）。

## 已知代价

- 多一个发布包：发布顺序、分发门、版本锁步各多一项；它第一次发版前要先在 npm 上建好并配 trusted publishing（见 release skill）。
- base 的 [动词表](../../../packages/base/src/observe/lexicon.ts#symbol=TOOL_VERBS) 仍按名字认这几件工具（`read_file` → 读取）。base 不能反过来依赖 tools，这张表现在认的是共用工具包的名字而不是某个产品的名字，改动工具名时要两边一起改，没有门。

## 验收

- [tools 隔离消费](../../../test/distribution-gate.test.ts#test=tools-隔离消费把-workspace-链接换成-tarball-之后它的-typecheck-与全套单测仍绿)：依赖恰好是 core 与 base，换成 tarball 后 typecheck 与全套单测仍绿——给它加一条对产品或壳的依赖就红。
- [coding 隔离消费](../../../test/distribution-gate.test.ts#test=coding-隔离消费把-workspace-链接换成-tarball-之后它的-typecheck-与全套单测仍绿)：依赖恰好是 core、base、tools、tui。
- [identity 漂移测试](../../../packages/coding/test/identity.test.ts#test=identity-的工具集与-prompt-与真装出来的-coding-agent-一致漂移即红)：搬迁前后 `echo-coding` 装出来的工具集与 prompt 段不变。
- 发布脚本的 `ORDER` 与 `packages/` 下的包一一对应（`scripts/release.ts` 的 `checkComplete`）。
