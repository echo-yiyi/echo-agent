# 规则表进内核，通用产品挂上工具包

> 状态:implemented · 提出 2026-11-15（[工具独立成包](2026-11-15-tools-package.md) 的两条遗留）· 拍板 2026-11-15（用户：「那几个问题也都要做，没问题的」）· 实现 2026-11-15 · 落地 `packages/core/src/permission/rules.ts`、`packages/tools/src/preset.ts`、`packages/coding/src/permission.ts` / `agent.ts` / `cli.ts`、`packages/cli/src/product.ts`

**给谁看**：要给一个产品配权限、或让它挂文件 / shell / web 工具的人。假设已知 [工具独立成包](2026-11-15-tools-package.md) 与 [安全加固](2026-11-15-security-hardening.md) 里的安全分类器与沙箱。

**一句话**：按工具名的规则表是内核的；挂 bash 的产品都要回答的三件事（哪些工具不用过分类器、`sandbox: false` 是什么意思、越出沙箱谁来看）跟着工具包走；于是通用产品 `echo-agent` 用同一套共用件挂上了三条工具 extension，和 `echo-coding` 只差身份、编码纪律与 git worktree。

## 现状（拍板前）

- 规则表（allow / deny / ask、表里没有的走 fallback、有没有人答）的类型与翻译函数在 `packages/coding/src/permission.ts`，里面没有一行编码知识。别的产品想要「某件工具先问」只能重写。
- 交给安全分类器的免判名单与 bash 的说明、「越出沙箱从不悄悄放行」那一条也在 coding 里，但它们说的是工具包里的工具。第二个挂 bash 的产品要么依赖另一个产品，要么抄一份。
- `echo-agent` 一件对外的工具都不挂：自称通用 agent，却读不了文件、跑不了命令。

## 决定

1. **规则表进 core**：[`PermissionRules`](../../../packages/core/src/permission/rules.ts#symbol=PermissionRules) / [`PermissionRule`](../../../packages/core/src/permission/rules.ts#symbol=PermissionRule) 与 [`permissionPolicyFromRules()`](../../../packages/core/src/permission/rules.ts#symbol=permissionPolicyFromRules)，从 `@echo-agent/core` 导出。只按工具名判；要按参数判的策略自己写 `authorize`，或包在规则表外面。
2. **工具的共用件进工具包**（[`preset.ts`](../../../packages/tools/src/preset.ts#symbol=toolsEntries)）：
   - [`toolsEntries()`](../../../packages/tools/src/preset.ts#symbol=toolsEntries)：三条 extension 的条目，产品只说沙箱开不开、凭据从哪来；
   - [`TOOLS_SAFE_TOOLS`](../../../packages/tools/src/preset.ts#symbol=TOOLS_SAFE_TOOLS) 与 [`SHELL_CLASSIFIER_NOTES`](../../../packages/tools/src/preset.ts#symbol=SHELL_CLASSIFIER_NOTES)：交给安全分类器的形状；
   - [`askOutsideSandbox()`](../../../packages/tools/src/preset.ts#symbol=askOutsideSandbox)：包在任意策略外面，策略放行的 bash 带 `sandbox: false` 改成问人。
3. **`echo-coding` 只剩内容**：缺省规则表 [`DEFAULT_PERMISSION`](../../../packages/coding/src/permission.ts#symbol=DEFAULT_PERMISSION) 点哪三件、免判名单 [`CODING_SAFE_TOOLS`](../../../packages/coding/src/permission.ts#symbol=CODING_SAFE_TOOLS) 在工具包那份后面补 worktree 两件。`permissionPolicyFor()` 是规则表加 `askOutsideSandbox()` 的组合。它的公共面不再导出 `PermissionPolicy` / `PermissionRule` 两个类型（用 core 的），`CODING_CLASSIFIER_NOTES` 删掉（用工具包的），没有兼容转发。
4. **`echo-agent` 挂三条工具 extension**（[`ECHO_AGENT`](../../../packages/cli/src/product.ts#symbol=ECHO_AGENT)）：`echo:workspace` / `echo:shell` / `echo:web`。三个产品自己的决定与 `echo-coding` 相同，各自声明各自的：
   - 沙箱归使用者：`settings.json` 写了 `sandbox: true` 才包，缺省不包（2026-11-16 起，见[安全加固](2026-11-15-security-hardening.md)第 4 步）；
   - 交给分类器的形状取工具包那一份，开不开归使用者；
   - 开着沙箱、分类器关着时，越出沙箱的那一条问人（交互形态问终端里的人，管道形态没人可问就是拒）；
   - **管道形态全放行**：没人可问，分类器缺省关着。

## 承重约束

- DO：新加一个挂 bash 的产品，用 `toolsEntries()` + `TOOLS_SAFE_TOOLS` + `SHELL_CLASSIFIER_NOTES`，分类器可能关着时用 `askOutsideSandbox()` 包住它的策略。
- DON'T：在产品里另抄免判名单或 `sandbox: false` 的判断——工具包加了新工具，抄的那份不会跟着变。
- DON'T：以为挂了沙箱就够。只开沙箱、不装策略也没开分类器时，`sandbox: false` 那扇门没人看。

## Non-Goals

- 不给 `echo-agent` 加编码纪律、worktree 或更高的执行预算。它仍是 core 的缺省预算（每次回复 20 步）；工具多了之后够不够用，看了使用情况再定。
- 不改管道形态的缺省：两个产品都是全放行、不包沙箱、分类器关着。
- 不把工作区越界判定、echo 凭据的名单、外来内容的来源说明搬进 core（同 [工具独立成包](2026-11-15-tools-package.md) 的 Non-Goals）。

## 已知代价

- **`echo-agent` 的行为变了**：以前把内容管道进 `echo-agent` 只会得到一段文字；现在模型可以读写当前目录、跑命令、取网页，而且管道形态不问人。两个 README 都写了「在那里把它当作一个会跑命令、会改当前目录文件的脚本」。
- `echo-agent` 多一个依赖（`@echo-agent/tools`），隔离安装门与分发门各跟着多拷一个包。
- 两个产品各有一份「沙箱开着、分类器关着时装哪份策略」的几行声明。它们是产品的决定，不是装配逻辑，但改一边时要想起另一边。

## 验收

- 规则表：[三档](../../../packages/core/test/permission-rules.test.ts#test=规则表三档点名的工具照点名的走allow-放行deny-拒并说是策略拒的ask-问人并说要裁决人)、[fallback](../../../packages/core/test/permission-rules.test.ts#test=规则表里没有的工具走-fallbackfallback-不给就是放行)、[有没有人答](../../../packages/core/test/permission-rules.test.ts#test=规则表换出来的策略ask-等人不超时没说有人答就是-noneagent-把-ask-折成拒说了-host-就是-host)
- 工具包的共用件：[条目](../../../packages/tools/test/preset.test.ts#test=toolsentries三条顺序-echoworkspace-echoshell-echowebsandbox-true-才给-echoshell-配沙箱每次调用是一组新的工具对象)、[免判名单与真工具集对得上](../../../packages/tools/test/preset.test.ts#test=免判名单只读的只动工作区文件的后台作业的读与停都在能出这台机器的-bash-与-webfetch-不在名单里没有不存在的工具)、[越出沙箱必须问人](../../../packages/tools/test/preset.test.ts#test=askoutsidesandbox策略放行的-bash-带-sandbox-false-改问人不带的别的工具照放策略自己说拒或问的不动)
- `echo-coding`：[名单补了哪两件](../../../packages/coding/test/permission.test.ts#test=交给安全分类器的免判名单工具包那份原样加上本产品自己的-worktree-两件bash-与-webfetch-不在)、[identity 漂移测试](../../../packages/coding/test/identity.test.ts#test=identity-的工具集与-prompt-与真装出来的-coding-agent-一致漂移即红)（装出来的工具集与挂载顺序不变）
- `echo-agent`：[preset](../../../packages/cli/test/cli.test.ts#test=presetecho-agent-自带身份段纪律段与工具包的三条沙箱归使用者缺省不包写了-sandbox-才包给分类器的说明才带沙箱那一句开着沙箱而分类器关着时越出沙箱的那一条问人管道形态就是拒2026-11-16)、隔离安装（`packages/cli/test/package-isolation.test.ts`：依赖恰好是 core / base / tools / tui，拷出去装完 `--help` 退出码 0）
