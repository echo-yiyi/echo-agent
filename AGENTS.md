# AGENTS.md

本文件适用于整个仓库。echo-agent 有两个使用高度，但只有一个高层 composition root：产品与 CLI 通过 `createEcho()` 装配，定制 host 直接使用 `@echo-agent/core` 的 `Agent` 自行给端口。不要在其他入口复制装配逻辑。

## Pre-release：先把地基做对

**首次 tagged release 后重新审查并删除或改写本节。** 当前没有需要兼容的已发布版本；发现公共 API、package 边界或落盘格式设计错误时，优先修正根因并一次更新所有引用、测试与文档，不加兼容别名或静默 fallback 掩盖问题。

这不代表可以擅自扩大改动：公共 API、持久化格式、跨 package 边界或整体架构要变化时，先列出影响和迁移方式，得到用户确认后再改。

## Repository map

| 路径 | 职责 |
|---|---|
| `packages/core/` | Runtime、engine、provider adapters、状态、记忆、任务与 extension API |
| `packages/cli/` | `echo-agent`：通用 agent 产品，官方 CLI 与交互式 TUI；高层装配的消费者，不认识任何具体产品 |
| `packages/coding/` | `echo-coding`：coding agent 产品，依赖 `packages/cli`，在自己这层装 `echo:workspace` / `echo:shell` |
| `examples/` | 从 tarball 消费公共 API 的可运行示例 |
| `test/` | 仓库级分发门与文档门 |
| `scripts/` | inventory、文档检查与仓库工具 |

使用 Bun 管理 workspace、运行脚本和测试；不要引入另一套包管理器或 lockfile。

## Tests are evidence, not design authority

- 测试描述当前行为，不自动证明行为正确。设计决定改变时，应同时修改过时实现和测试，并说明为什么。
- 描述“现在做什么”时，以公共类型、实现和可复现行为为证据；描述“应该做什么”时，以用户确认的设计决定为准。
- 文档写不通可能是代码问题。如果同一概念存在两个真源、边界无法定义或失败语义冲突，列出双方的 `file:line` 与复现命令，不要替代码编一个自洽故事。
- 只有精确机器判据才能称为“有门守着”；注释、局部测试和 review 习惯只能称为“纪律”。
- 一条事实只保留一个权威归属；其他地方链接它，不复制一份会独立腐烂的说明。

## Writing documentation from source

1. 从读者要完成的动作或要理解的设计问题开始。
2. 从公共入口沿类型、实现、错误路径和测试追踪；不要只读 facade 或注释。
3. 实测命令、环境变量、默认值、生命周期与失败行为。fixture 只能证明 fixture 覆盖的部分，不能冒充真实服务验证。
4. 写清当前行为、设计理由、取舍和失败模式；不要把源码目录换成自然语言复述一遍。
5. 注释和文档写稳定的语义、时序、所有权与安全用法，不保留推理过程或 review 历史。

文档登记与双语规则：

- `docs/docs.manifest.json` 只登记已经存在并获准维护的文档；计划中的文件放 issue，不放死链占位。
- manifest 标为 bilingual 时，英文 `.md` 与中文 `.zh.md` 的章节、列表、表格和代码块保持同构，代码块逐字一致。
- 人工确认两侧语义一致后才能更新 `.i18n.yaml`。哈希只证明确认后未改动，不证明翻译正确。
- TypeScript 示例必须能独立编译；相对链接必须指向已经存在的目标。

## Commands and evidence

```bash
bun install
bun run typecheck
bun test <relevant-test-files>
bun test
bun scripts/docs-lint.ts
bun test test/docs.test.ts test/export-jsdoc.test.ts
```

- 行为改动先跑最小相关测试；不要默认用全仓测试代替定位。
- 公共导出变化跑 API snapshot；package/export/Node-Bun 消费面变化跑 distribution gate。
- provider 请求形状可用 mock/fixture 证明；声称真实 provider 可用必须有真实 API 证据。
- 文档变化跑 docs lint 与文档测试，但门绿不证明技术叙事或翻译语义正确，仍需人工 review。
- 全仓测试用于跨模块改动或最终集成验证，不必在同一状态下重复运行已经通过的检查。

如果基线已红，单独证明本次改动没有新增失败，并报告仍存在的失败；不要修改无关范围换取全绿，也不要把红说成绿。

## Editing and handoff

先读相关实现、测试和当前 diff。保留用户已有改动；删除文件、跨模块重构、改变公共 API / 架构、增删依赖或修改 CI / 构建配置前先征求同意。除非用户明确要求，不 commit、不 push、不发布 package。

交付时说明：改了什么、关键设计判断、实际运行的验证、仍存在的问题。
