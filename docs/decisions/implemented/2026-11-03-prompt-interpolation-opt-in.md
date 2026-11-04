# system 段的 `{{变量}}` 插值改由段自己声明

> 状态:implemented · 提出 2026-11-03（上下文线复查：AGENTS.md 或记忆里一行 `${{ secrets.X }}` 就让每个 run 失败）· 拍板 2026-11-03（用户：「全部按推荐修」）· 落地 `packages/core/src/prompt/types.ts` / `assemble.ts` / `sections.ts` / `import.ts`，判据 `packages/core/test/prompt.test.ts`、`packages/core/test/memory.test.ts`、`packages/cli/test/prompt.test.ts` · 修改 2026-09-01 prompt 设计会话拍板的「dsh 式 `{{变量}}`」一条（该次拍板没有单独入库，现行描述在 [Prompt](../../design/prompt.md) §3.2）：严格插值的作用范围从「所有段」收窄到「声明了插值的段」

**给谁看**：写 prompt 段、或把第三方 / 模型可控文本装进 system 的人。假设已知 [Prompt](../../design/prompt.md) §3 的装配顺序。

**一句话**：`PromptSection` 多一个可选的 `interpolate`；声明了才按 `{{name}}` 严格插值，不给就原样。环境段与产品导入的 md 段声明，项目指令、记忆、skill、角色正文一律原样。

## 现状（拍板前）

[`assembleSystem()`](../../../packages/core/src/prompt/assemble.ts#symbol=assembleSystem) 对**每一段**的渲染结果做严格插值：完整的 `{{…}}` 要么是已注册且有值的变量，要么抛 `PromptVariableError`，run 在调用模型前以 error 收场。2026-09-01 这么定的前提是「段文本是产品 / extension 写的受信文本，写错的 `{{modle}}` 要响」。

但 system 里有几段装的是第三方或模型写的文本：

- 项目指令：一个仓库的 AGENTS.md 里写着 GitHub Actions 的 `NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}`，在这个目录里**每个 run 都失败**；
- 记忆：模型记下一句「用户的项目用 Handlebars，比如 `{{ user.name }}`」，之后**每个会话每个 run 都失败**，连记忆提取（它用同一份 system）都起不来，模型没有机会自己改掉那一行；
- skill 目录、角色 identity 同理（Helm 的 `{{ .Values.x }}`、Jinja、Mustache 都是常见写法）。

## 选项

- A. 维持对所有段插值，给不可信文本加转义。要求每个装第三方文本的 owner 记得转义，漏一处就是同样的故障；转义后的字符也不再是原文。
- B. 插值改为段自己声明，缺省原样。只有作者有意写变量的段声明；写错变量名照旧 fail-loud。
- C. 不认识的变量原样保留、不抛。作者写错的 `{{modle}}` 会静默发给模型，正是 2026-09-01 要防的事。

## 决定

**B**。

1. `PromptSection.interpolate?: boolean`：`true` 才插值，规则不变（严格、孤立 `{{` 原样、替换值不重扫）；不给 = 原样。
2. 声明插值的只有两处：内建环境段（`environmentSection()`）与 `sectionFromMarkdown()` 导入的段（产品自己写的文件，作者有意写 `{{workspace}}`）。
3. 项目指令、记忆、skill 目录、角色 identity 不声明。第三方 extension 的段缺省原样，要用变量就显式声明。
4. 变量表仍在装配开始时一次性解析全部 provider（§3.2 第 2 步不变）。

## Non-Goals

- 不改变量的取值规则、不新增变量。
- 不给原样段做任何转义或改写。
- 不改 memory 作用域前缀里的 `{{workspaceHash}}`（那是另一套、闭合的前缀变量，见 `memory/scope.ts`）。

## 验收

- 未声明的段原样：[assembleSystem](../../../packages/core/test/prompt.test.ts#test=没声明-interpolate-的段原样第三方文本里的-secretsx-valuesx-workspace-都不当变量)
- 项目指令里的 `${{ secrets.X }}` 原样、run 照常：[instructions](../../../packages/cli/test/prompt.test.ts#test=instructionsagentsmd-里一行-github-actions-的-secretsx-原样进-systemrun-照常跑完项目指令不插值)
- 记忆里的 `{{ user.name }}` 原样、run 照常：[memory](../../../packages/core/test/memory.test.ts#test=记忆正文里写着-username-secretsx-原样进-systemrun-照常跑完记忆段不插值)
- 声明了插值的段写错变量照旧让 run 以 error 收场：[变量错](../../../packages/core/test/prompt.test.ts#test=变量错-run-以-error-收场不静默发一份错的-system)

变异：把 `assembleSystem` 改回对所有段插值，上面前三条变红。
