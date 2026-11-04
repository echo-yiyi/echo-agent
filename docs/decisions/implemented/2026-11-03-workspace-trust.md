# 工作区信任：约定目录里的扩展只在受信的工作区里加载

> 状态:implemented · 提出 2026-11-03（review：克隆一个陌生仓库、在里面起 `echo-coding`，就执行了仓库里 `extensions/` 下的代码）· 拍板 2026-11-03（用户：「全部按推荐修，并参考成熟实现」）· 落地 `packages/base/src/cli.ts#trustConventionDir` / `#echoOptions`、`packages/base/src/settings.ts`、`packages/base/src/shell.ts#Shell`、`packages/tui/src/trust.ts`，判据见文末

**给谁看**：改启动逻辑、壳端口、扩展发现的人，以及在别人的仓库里用 `echo-coding` 的人。假设已知 [扩展、装配与所有权](../../design/extensions.md) §2 与 [坏扩展不阻塞启动](2026-09-01-bad-extension-does-not-block-startup.md)。

## 现状（拍板前）

用户不给 `--extensions` 时，`echoOptions()` 不传 `extensionDirs`，`createEcho()` 走约定目录 `<cwd>/extensions`，在装配阶段 `import()` 那里的每个文件。验形发生在模块求值之后，顶层代码在没有任何模型调用、没有任何人确认之前就跑了。`git clone` 一个陌生仓库、`cd` 进去、`echo-coding`，等于执行仓库作者写的代码。

## 参照（只看行为）

- **codex**：按项目记信任（`config.toml` 的 `[projects."<路径>"] trust_level = "trusted"`），第一次在某个目录里起来时问一次。
- **Claude Code**：公开文档描述的「信任这个文件夹」那一步——第一次在新目录里起来时确认一次，确认过就不再问。

## 选项

- **A. 按工作区记信任，约定目录只在受信时加载**：交互形态问一次、记住；没人可问的形态不加载、说一句；显式 `--extensions` 视为同意。
- **B. 永远不自动发现约定目录**：最安全，但自己写扩展的人每次都得敲 `--extensions`，热部署的日常用法也跟着变麻烦。
- **C. 照旧加载、只打一句警告**：代码已经执行了，警告来不及。

## 决定

**A**（2026-11-03 用户拍板）。全在 base / tui，不改 core。

1. **判据**：工作区 = 进程目录的 realpath。受信的工作区记在 `$ECHO_HOME/settings.json` 的 `trustedWorkspaces`（字符串列表，与 `model` 并列；形状不对按设置文件坏了处理：口信 + 当作没有设置）。
2. **装配入参**：没给 `--extensions` 时，受信 → 不传 `extensionDirs`（core 走约定目录）；不受信 → 显式 `extensionDirs: []`（core 的 `resolveExtensionDirs` 对空数组就是不发现，热部署也不去那儿找）。显式 `--extensions` 一律视为受信，不问、不查设置。
3. **什么时候问**：约定目录里有扩展文件、且工作区不受信时；在引导设置（缺凭据才有）之后、装配之前。约定目录里没有扩展文件就不问、也不交。
4. **交互形态**：壳端口新增 `Shell.trustWorkspace()`；终端实现列出工作区与将加载的文件（相对路径、清洗控制序列、最多 20 个），两个选项，**缺省选中「不信任」**。信任 → 记进设置、这次加载；不信任（含 Esc、Ctrl+D、被中止）→ 这次不加载，进界面后说一行。设置写不进去不挡启动，如实说一句、这次照样加载。
5. **管道与 `--serve`**：没人可问。不受信就不加载，stderr 一行：在哪个目录、几个扩展、怎么信任（显式 `--extensions ./extensions`，或在交互形态里信任一次）。被叫醒的 `--serve` 副本与父进程同一个进程目录，读同一份设置，判断一致。

## Non-Goals

- 不按文件记信任、不对文件内容做哈希：信任的是目录，之后目录里多了、改了文件也照样加载（与参照的两家一致）。
- 不提供「取消信任」的命令：要撤销就编辑 `settings.json`。
- 不管 `createEcho()` 的库用法：直接调 core 的程序自己决定发现哪些目录。
- 不管项目指令（`AGENTS.md` / `CLAUDE.md`）与 `.echo/` 下的角色定义：它们进 prompt、不执行代码，信任问题另议（`docs/design/prompt.md` §7）。

## 已知后果

- 不受信、且启动时约定目录是空的工作区：这次会话里新写进 `extensions/` 的扩展，`/reload` 与模型的 `extension_reload` 都发现不了，下次启动才会问。新目录里让模型现写现装扩展的用法因此要多一步（显式 `--extensions ./extensions` 起，或先信任一次）。

## 验收

- [装配入参按信任给](../../../packages/cli/test/cli.test.ts#test=echooptions没给---extensions-时受信才把约定目录交给-createecho不受信显式给-给了---extensions-不看信任)：变异 `echoOptions` 不看 `workspaceTrusted` 即红。
- [管道形态](../../../packages/cli/test/cli.test.ts#test=bin管道形态工作区不受信-约定目录里的代码不执行stderr-一行说怎么信任显式---extensions-extensions-或设置里记着受信-执行)：bin 级，探针扩展在模块求值时写标记文件；不受信无标记、stderr 那一行；`--extensions ./extensions` 与设置里记着受信都有标记。变异：信任判断恒真即红。
- [交互形态](../../../packages/cli/test/cli.test.ts#test=main交互形态工作区不受信-进对话前问一次列出文件选信任-加载并记住下次不再问选不信任-不加载界面说一行)：问一次、选信任 → 加载并按 realpath 记住；再起不问；另一个工作区按 Esc → 不加载、界面一行、设置不多记。
- 确认屏本身：[列出文件、缺省不信任](../../../packages/tui/test/trust.test.ts#test=列出工作区与将加载的每个文件相对路径两个选项缺省停在不信任直接回车是不加载)、[只有选信任才是 true](../../../packages/tui/test/trust.test.ts#test=选信任才是-true数字-2-直选或-再回车)、[文件名里的控制序列被洗掉](../../../packages/tui/test/trust.test.ts#test=文件名里的终端控制序列被洗掉陌生仓库的文件名改写不了这一屏)。
- 设置文件：[读写与 model 互不覆盖](../../../packages/base/test/settings.test.ts#test=信任的工作区2026-11-03写-读回与-model-互不覆盖)、[形状不对](../../../packages/base/test/settings.test.ts#test=trustedworkspaces-形状不对口信-空缺省不是字符串列表就一条都不信)。
