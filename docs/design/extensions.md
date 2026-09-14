# 扩展、装配与所有权（审阅稿）

> 状态：审阅中；基线为 2026-09-14 当前实现，包含盘上扩展热重载与模型触发入口。§9 初版登记的两条承诺差异已于 2026-09-14 修复（实现改到与承诺一致，判据与测试见 §9）<br>
> 读者：编写产品或 extension、接入 service、排查挂载失败及热重载行为的人<br>
> 范围：发现、依赖图、注册、effect、回滚、卸载、安全时机与重载报告；不展开各能力自己的业务契约<br>
> 退出条件：复核 §9 的判据与本文对代码的断言后移除审阅稿状态；不复制出另一份设计契约

**解决什么**：产品、壳、内建能力与第三方文件都要往同一个 agent 里装东西，又要能卸得干净、换得回去。本文写清一条 extension 从文件到运行实例经过哪几步、每一步谁拥有什么、失败停在哪一层、热重载能碰什么不能碰什么。

**Non-Goals**（已决，不在本文范围）：不重载产品代码与壳、不监听文件变化、不做依赖方连带重装、不在 run 中途换代、不回收已求值的旧模块。每条走哪条路见 §6 与[热重载决策](../decisions/implemented/2026-09-14-extension-hot-reload.md)的 Non-Goals。

**待拍板**：无。§9 原列的两条已拍板修实现；软依赖的读法已拍板加 `tryGet()`（[决策](../decisions/implemented/2026-09-14-inject-soft-dependency-tryget.md)）。

**验收判据**：§10 的命令全绿，且 §9 两条 `bun -e` 判据的输出与文中写的一致。

## 1. 扩展的边界

产品通过 [`createEcho()`](../../packages/core/src/create-echo.ts#symbol=createEcho) 装配；增加工具、prompt 段、记忆模块或压缩阶段走 extension；壳也是 extension，通过 [`AgentRuntime`](../../packages/core/src/extension/runtime.ts#symbol=AgentRuntime) 使用运行时。不要围绕内部 Agent 自行拼接第二个 composition root。

extension 是有生命周期的装配单元，不是新建 agent 的工厂，也不是安全沙箱。builtin 与第三方共享 Host、service、registry 和 effect 机制；区别在于来源、装配代和允许重载的范围。

需要分清三种动作：

| 动作 | 接口 | 所有权 |
| --- | --- | --- |
| 使用能力 | inject 声明后 `ctx.get(key)`；软依赖用 `ctx.tryGet(key)` | service 的 provider 仍拥有它 |
| 提供能力 | provide 声明后 `ctx.provide(key, value)` | 当前 Fiber 发布值；底层资源仍须登记清理 |
| 注册内容 | 调拿到的 registry，再把 disposer 交给 `ctx.effect()` | registry 维护内容，effect 持有撤销动作 |

registry 的“多”是多个扩展往同一个 registry 注册内容，不是同名 service 可以任意多 provider。各能力的规则另见 [Prompt](prompt.md)、[Compaction](compaction.md)、[Memory](memory.md)；其业务验证不由 ExtensionHost 统一完成。

## 2. 从文件到运行实例

[`ExtensionDefinition`](../../packages/core/src/extension/abi.ts#symbol=ExtensionDefinition) 是声明；[`ExtensionEntry`](../../packages/core/src/extension/host.ts#symbol=ExtensionEntry) 把声明与 entryId、原始 config 组合；[`Fiber`](../../packages/core/src/extension/fiber.ts#symbol=Fiber) 是某个 entry 在某一代里的运行实例。definition.name 是作者命名，entryId 是装配身份，generation 是一起挂载与卸载的批次，三者不要混用。

盘上扩展默认来自调用进程 cwd 下的 extensions 目录；显式 `extensionDirs` 整份替换发现目录，相对路径也按 cwd 解析。它不自动跟随恢复 session 后的 workspace 重选，见 [`resolveExtensionDirs()`](../../packages/core/src/create-echo.ts#symbol=resolveExtensionDirs)。

[`discoverExtensionFiles()`](../../packages/core/src/create-echo.ts#symbol=discoverExtensionFiles) 只认目录第一层的 ts / mts / js / mjs 文件，或第一层子目录里的 index 入口，不递归寻找更深的扩展入口。目录不存在视为空；无法读取的目录不是“没有扩展”。结果按路径排序，多个目录指到相同解析路径时去重。

发现只列文件；[`loadExtensionFile()`](../../packages/core/src/create-echo.ts#symbol=loadExtensionFile) 随后执行 import，取默认导出并用 `defineExtension()` 验形。**验形发生在模块求值之后**：顶层代码已执行，不能靠 ABI 检查阻止它读文件、连网络或启动 timer。模块求值和 config 保持无长期副作用，是作者纪律。

### 当前启动顺序

createEcho 的挂载顺序为：

1. builtin：由内建能力表生成，不从安装目录搜脚本。
2. inline：显式工具包以及启用时的会话工具。
3. discovered：盘上扩展按入口路径各自一代。
4. explicit：`opts.extensions` 一代，包含产品内容与壳。
5. role：角色覆盖最后挂载，确保产品 identity 已存在。

每代内部另按依赖图拓扑排序。盘上扩展不能因为“以后会装产品”就依赖那个尚不存在的 service；独立代也不会合并成一张等待未来 provider 的图。发现的坏文件或失败 apply 记诊断后跳过；显式装配失败则整体构造失败并尝试清理先前已挂代。

装配与启动分开：createEcho 返回不等于已经恢复 session 或开始自主工作，调用方仍需 `echo.start()`。但扩展 apply 已在 mount 时执行，因此“装配不启动 Agent”不等于“装配期无扩展副作用”。生命周期见 [Lifecycle 与 Run Loop](lifecycle-and-run-loop.md)。

## 3. Service 与依赖图

[`ServiceKey`](../../packages/core/src/extension/abi.ts#symbol=ServiceKey) 包含 id、version、kind、scope、reload。Host 内按 id 统一引用，同 id 的其余声明必须完全兼容，不做版本范围协商。规范表通过 staged 层提交，失败 mount 不占住新 key，见 [`ServiceKeyTable`](../../packages/core/src/extension/service-key.ts#symbol=ServiceKeyTable)。

[`resolveGraph()`](../../packages/core/src/extension/graph.ts#symbol=resolveGraph) 在任何 apply 前处理以下规则：

- required 依赖缺失、依赖成环、同代重复 provider 均拒绝。
- 省略 required 是软依赖：缺 provider 也允许 mount；之后 `ctx.get()` 仍抛，`ctx.tryGet()` 返回 undefined，两者都只能读 inject 里声明过的 key（[决策](../decisions/implemented/2026-09-14-inject-soft-dependency-tryget.md)）；已解析为缺失的依赖不会因后来出现 provider 自动重绑。
- provider 必须先 ACTIVE，consumer 才开始 LOADING；卸载顺序相反。
- process-scope 扩展不能依赖 agent-scope service；agent-scope 扩展不能提供 process-scope service。
- provider 的 reload 边界不得弱于它提供的 service。
- 不同 entryId 跨代重复提供同一 service 被拒；同一 entryId 的两代允许 overlap。消费者绑定具体 provider 实例，不是每次调用重新选最新 provider。

scope 是依赖寿命的校验信息，不会自动生成跨所有容器共享的 process 单例。Host 自带 service 也不能被扩展重复 provide。

## 4. 作者怎样交还资源

公共导入面是 `@echo-agent/core/extension`。下面是只提供一段 prompt、能在 run 间重载的最小定义；由产品放入 extensions entry，或作为盘上文件的默认导出：

```ts
import { defineExtension, AgentPrompt } from "@echo-agent/core/extension";

export default defineExtension({
  name: "review-guidance",
  hostAbiVersion: 1,
  reload: "run",
  inject: { prompt: { service: AgentPrompt, required: true } },
  async apply(ctx) {
    const prompt = ctx.get(AgentPrompt);
    await ctx.effect({
      boundary: "run",
      start: () => {
        const dispose = prompt.section({
          name: "review-guidance",
          order: 50,
          render: () => "When reviewing, separate observed behaviour from proposed changes.",
        });
        return { value: undefined, dispose };
      },
    });
  },
});
```

get / tryGet / provide 只能用声明过的 key。恒有的 Service（Host 自带的 registry、能力端口）声明 `required: true`；只有真会缺席的（没装记忆时的 AgentMemory、没给 skill 池时的 AgentSkills）才省略 required、用 `tryGet()` 读。effect 的 boundary 缺省是 agent，不能比 extension 声明的 reload 更强；只写 `reload: "run"` 却漏写 effect boundary，会因缺省 agent 而被拒。工具或 prompt pack 可复用 [`defineToolPack()`](../../packages/core/src/extension/builtin.ts#symbol=defineToolPack) / [`definePromptPack()`](../../packages/core/src/extension/builtin.ts#symbol=definePromptPack)，但不要把 pack 内弱 effect 边界误认为 definition 已承诺可重载。

**注册成功不等于 Host 已经拥有撤销动作。** registry 返回 disposer 后必须把它作为 lease.dispose 交还；直接注册而不登记 effect，卸载不会自动替作者查出并删除内容。provide 自动撤掉发布关系，也不自动 close 被发布的连接。

start 在返回 lease 前失败时，Host 尚无 disposer，已取得的部分资源要由 start 自己清理。批量注册同理：第三项失败时必须撤掉前两项，不能等一份根本没成功返回的 lease。[`registerAll()`](../../packages/core/src/extension/builtin.ts#symbol=registerAll) 从 `@echo-agent/core/extension` 导出，实现这种局部回滚，卸载时也按同一顺序逆序全撤：内建 pack、echo-coding 的 shell / worktree 扩展和角色定义都用它，第三方在 `ctx.effect()` 的 start 里直接返回它的结果即可。

## 5. 挂载、卸载与“原子”的范围

[`ExtensionHost.mount()`](../../packages/core/src/extension/host.ts#symbol=ExtensionHost.mount) 分为 PREPARE → LOADING → ACTIVE：先解析 config、构图，再依次 apply。apply 返回后，还会等待当时登记的 effect start；`void ctx.effect()` 在 mount 期失败不会被当成成功。声明了 provide 但没真正发布，也会导致失败。

失败时，当前 Fiber 及同代已激活 Fiber 按逆拓扑尝试清理。LOADING 失败抛 [`ExtensionMountError`](../../packages/core/src/extension/host.ts#symbol=ExtensionMountError)，保留 cause 和 unwindErrors；PREPARE 错误则可能直接是 ABI 错误。不能要求所有 mount 失败只有一种异常类型。

mount / unmount / replace 在同一条 Host 队列里按调用顺序串行，一个失败不阻断后续事务。这里的“原子”只覆盖这条装配流程的提交与已登记清理：外部文件、已发请求、被泄漏的 registry 注册、清理失败的资源都不能倒带，旁观者也可能看到 LOADING 期间已发生的注册。

[`ExtensionHost.unmount()`](../../packages/core/src/extension/host.ts#symbol=ExtensionHost.unmount) 拒绝卸掉仍被其他代 consumer 依赖的 provider；未知代是幂等空操作。开始卸载后 context 失效、signal abort、等待在飞 start，然后按登记顺序反向释放成功得到的 leases（栈位在 `ctx.effect()` 调用时占好，start 完成早晚不改变它；start 失败的那一位没有 lease，跳过），最后撤 service。每个 effect disposer 都会尝试，错误聚合上报；这不保证某个 disposer 内部的多项清理也全被尝试。

ACTIVE 后新建 effect 的失败与 mount 期不同：不会回滚 Fiber，也不自动进入诊断，登记者应 await 并处理。卸载后的旧 ctx.get/provide/effect 会拒绝，但以前拿到的原始 service 引用不会被统一撤销；异步回调停止使用它仍需遵守 signal 和 disposer 协议。

没有通用 start/dispose 超时或强制中止。忽略 abort 的 start、永不结束的 disposer 都可能让卸载及后续 Host 事务一直等待。Host 保证尝试清理的顺序，不保证不合作的扩展能被强制回收。

## 6. 热重载：时机与范围

三部分各有归属：[`Agent.betweenRuns()`](../../packages/core/src/agent.ts#symbol=Agent.betweenRuns) 获取前台 run 之间的执行许可；createEcho 发现和加载新代码；[`ExtensionHost.replace()`](../../packages/core/src/extension/host.ts#symbol=ExtensionHost.replace) 先 PREPARE 新代（config 解析、依赖图，把旧代当作已不在来算跨代 provider），过了才卸旧、装新，装不上再重装旧代。Host 本身不会探测 Agent 是否 idle，safePoint 是调用方给出的事实。

人经壳的 reload 命令、程序经 `echo.reloadExtensions()`，走同一入口。忙时 rejected，不排队。实际替换点是两次 run 之间：turn / run 声明可换，缺省 agent 和 process 声明拒绝。这不是 turn 边界热换，也不证明所有独立后台任务和外部回调均已静止。

当前只重扫盘上发现的扩展；builtin、显式产品扩展、壳和角色定义不在重载账上。没有文件 watcher，也不做依赖方连带重装。若另一代仍绑定旧 provider，替换被 refused。

### 新代码怎样被加载

[`hashExtension()`](../../packages/core/src/create-echo.ts#symbol=hashExtension) 对单文件比字节，对子目录比相对路径及文件内容；目录内 node_modules 与内部快照不参与哈希。内容未变且上一次装上了的不重复 import；上一次没装上的即使内容未变也再试一次。

[`snapshotExtension()`](../../packages/core/src/create-echo.ts#symbol=snapshotExtension) 将变更内容复制到入口旁边的新路径后 import，避开旧模块缓存。子目录扩展连目录内容一起复制，目录内 helper 可以刷新；单文件扩展外部的 helper 不随入口一起刷新。不是完整依赖图 HMR，改依赖包也不能只依赖该内容哈希被发现。

快照在对应代存活期间保留，换代、删除和正常收摊时清理；进程崩溃遗留副本不自动清理。删除文件副本不等于 JS 运行时卸载已求值模块，不能承诺无限重载不增长内存。

### 结果要按具体状态处理

[`ReloadChange`](../../packages/core/src/extension/reload.ts#symbol=ReloadChange) 按文件报告 added / removed / replaced / unchanged / refused / rolled_back / failed / lost。整次返回 done 只表示扫描完成，不等于每个文件成功；多文件 reload 不是一个整体事务。

import、定义验形、config 解析与依赖图（Host 的 PREPARE）失败时旧代未卸；apply 或 effect start（LOADING）失败时旧代已经卸过，再按原 entries 重新 config/apply。两种都报 rolled_back，前者的 unwindErrors 为空。rolled_back 不等于恢复原闭包状态、原连接或外部数据。旧代也装不回时是 lost，此时不能继续把它当成已挂载。卸旧时的清理错误不会阻止尝试装新，由 unwindErrors 保留。

## 7. 模型触发与报告回传

模型工具 [`extension_reload`](../../packages/core/src/extension/reload-tool.ts#symbol=makeExtensionReloadTool) 不在当前工具批里同步卸载扩展，而是登记 run 收尾工作；同一 run 重复登记会拒绝。当前 reply 结束不一定代表整个 run 结束，只有 run 收尾后才真正执行重载。

[`Agent.afterRun()`](../../packages/core/src/agent.ts#symbol=Agent.afterRun) 是内部挂点，任务在前台许可释放后、自主工作调度前执行。模型工具收到 scheduled 不是 replaced，更不表示新代码已验证。

createEcho 把实际报告作为 source 为 echo:reload 的 environment 消息投进自己的 durable inbox，之后由正常自主消费路径带给模型。若安全时机被其他工作占用，报告会说本次没有完成；投递失败报诊断，不保证总有下一条模型回复。模型是否再调用新工具验证仍是模型行为，系统不自动替它跑验收。

这一入口只在装配提供登记能力时出现。工具本身不带权限声明，放不放行由产品的权限策略按工具名裁决（echo-coding 没写规则的工具 fallback 是 allow，见 [`permissionPolicyFor()`](../../packages/coding/src/permission.ts#symbol=permissionPolicyFor)）；这不是代码沙箱，加载任意扩展代码仍使用宿主进程权限。完整取舍见 [热重载决策](../decisions/implemented/2026-09-14-extension-hot-reload.md) 与 [模型触发决策](../decisions/implemented/2026-09-14-model-triggered-reload.md)。

## 8. 观测与排障

Host 探针区分挂载成功、PREPARE / apply 失败、卸载拒绝、卸载完成及清理错误，见 [`probeExtension()`](../../packages/core/src/extension/observe.ts#symbol=probeExtension)。Echo 的 extensions 与 diagnostics 反映当前装配账；它们不证明业务注册都正确，也不证明失败回滚清空了外部资源。

排查时先区分：没发现文件、import 失败、依赖图拒绝、apply/start 失败、卸载被依赖方阻挡、disposer 失败、重新装回旧代失败。不要把这几种都归为“加载失败”；对应行动分别是检查发现根、模块导出、service 声明、资源获取、代间依赖和清理代码。

## 9. 两条曾经的承诺差异（2026-09-14 修复）

审阅稿初版在这里登记了两处「注释这么说、代码不这么做」。两处都改了实现，不改口；下面的 `bun -e` 判据保留为机器可检的验收，输出与文中写的不一致即回归。

### effect 按登记序逆序卸载

此前 [`Fiber.createContext()`](../../packages/core/src/extension/fiber.ts#symbol=Fiber.createContext) 在 start 完成拿到 lease 后才入栈，两个并行 start 按完成序排队，卸载成了完成序的逆序。现在栈位在 `ctx.effect()` 调用时占好（[`EffectStack.reserve()`](../../packages/core/src/extension/effects.ts#symbol=EffectStack.reserve)），lease 到手再填；start 失败的那一位没有 lease，卸载跳过。

```bash
bun -e 'import {defineExtension,ExtensionHost} from "./packages/core/src/extension/public.ts"; const events=[]; let release; const barrier=new Promise(r=>release=r); const d=defineExtension({name:"probe",hostAbiVersion:1,async apply(c){const first=c.effect({start:async()=>{await barrier;return {value:1,dispose:()=>{events.push("dispose-first")}}}});await c.effect({start:()=>({value:2,dispose:()=>{events.push("dispose-second")}})});release();await first;}});const h=new ExtensionHost();await h.mount("g",[{entryId:"probe",definition:d}]);await h.unmount("g");console.log(events);'
```

输出 `[ "dispose-second", "dispose-first" ]`：后登记的先卸，与 first 完成得更晚无关。门：[并行 start 按登记序逆序卸](../../packages/core/test/extension-host.test.ts#test=并行的-effect-start栈位按登记顺序占卸载是登记序的逆序先登记后完成的那个后卸)。

### 新代的 config 与依赖图在卸旧之前验

此前 [`ExtensionHost.replace()`](../../packages/core/src/extension/host.ts#symbol=ExtensionHost.replace) 先卸旧代再 mount 新代，而 config 解析与依赖图在 mount 的 PREPARE 里，于是 config 抛时旧代已经卸过、再装回来。现在 replace 先 PREPARE 新代（把旧代当作已不在来算跨代 provider），过了才卸旧代、进 LOADING；PREPARE 失败返回 rolled_back、unwindErrors 为空，旧代没被碰过，观测账本里只有一条 mount_failed（prepare）。

```bash
bun -e 'import {defineExtension,ExtensionHost} from "./packages/core/src/extension/public.ts";const events=[];const old=defineExtension({name:"old",hostAbiVersion:1,reload:"run",apply(c){events.push("old-apply");void c.effect({boundary:"run",start:()=>({value:null,dispose:()=>{events.push("old-dispose")}})});}});const next=defineExtension({name:"next",hostAbiVersion:1,reload:"run",config(){throw Error("bad-config")},apply(){}});const h=new ExtensionHost();await h.mount("old",[{entryId:"old",definition:old}]);const r=await h.replace("old",{generation:"new",entries:[{entryId:"new",definition:next}]},{safePoint:"run"});console.log({kind:r.kind,events});await h.unmount("old");'
```

输出 `{ kind: "rolled_back", events: [ "old-apply" ] }`：没有 old-dispose，也没有第二次 old-apply。门：[PREPARE 没过旧代不动](../../packages/core/test/extension-host.test.ts#test=replace新代-prepare-就没过config-抛-required-依赖没-provider-rolledback但旧代根本没卸过也没重装)、[新代只能绑到卸旧之后还在的 provider](../../packages/core/test/extension-host.test.ts#test=replace新代-inject-的-service-只有旧代自己-provide-prepare-把旧代当作已不在它马上要卸rolledback-且旧代原样)、[账本里没有「卸了又装回」](../../packages/core/test/extension-observe.test.ts#test=replace-新代-prepare-就没过config-抛只记-mountfailedprepare没有-unmounted旧代原样账本里也没有卸了又装回)。

replace 对未知旧代、已占用新代等非法调用仍会抛异常；「结果联合不抛」只适用于进入换代流程后的业务结果，不能写成绝对保证。

## 10. 验证与人工责任

本稿验证分两层：Host 测试使用受控扩展验证依赖、effect 和事务；重载测试走 createEcho 与临时目录里的真实文件，验证发现、加载、安全时机和回传。真实文件测试也不等于证明任意第三方扩展安全。

```bash
bun test packages/core/test/extension-host.test.ts \
  packages/core/test/extension-reload.test.ts \
  packages/core/test/extension-reload-tool.test.ts \
  packages/core/test/extension-cleanup.test.ts \
  packages/core/test/extension-observe.test.ts \
  packages/core/test/create-echo.test.ts
bun scripts/docs-lint.ts
bun test test/docs.test.ts test/export-jsdoc.test.ts
```

人工仍需确认：顶层/config 不泄漏长期副作用、start 失败自清理、disposer 能结束、旧回调停止使用资源、reload 边界与真实资源寿命一致、代码来源可信。机器能检查声明和执行路径，不能证明扩展作者说的寿命、权限或副作用范围是真的。
