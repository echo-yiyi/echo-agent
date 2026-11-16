# 装载的时限放进 Host：挂住的 apply 到点被放弃并回滚，不再堵住事务队列

> 状态:implemented · 提出 2026-11-03（全仓 review 留下的待拍板：启动时盘上扩展的 apply 挂住，`createEcho()` 一直等）· 拍板 2026-11-13（用户：「都按你的推荐来做」）· 落地 [`ExtensionHost`](../../../packages/core/src/extension/host.ts#symbol=ExtensionHost)、[`EffectStack`](../../../packages/core/src/extension/effects.ts#symbol=EffectStack)、[`createEcho`](../../../packages/core/src/create-echo.ts#symbol=createEcho) · 判据见验收 · 修改 [收摊与等待上限](2026-11-03-stop-quiesce-and-bounded-waits.md)：当时否掉的选项 B（Host 加超时）在装载这一半改为采纳，「热部署装载在装配层限时、迟到的结果补记」与「不覆盖：启动时挂住」两条被本条取代

**给谁看**：写 extension 的人、改 Host 事务或装配层热部署的人。假设已知 [扩展、装配与所有权](../../design/extensions.md) §5（挂载、卸载）与 §6（热重载）。

**一句话**：每个 Extension 的装载在 Host 的事务里与一个时限（30 秒）和调用方的 signal 赛跑，到点或中止就被放弃、按装载失败回滚。启动、热部署、换代因此是同一个行为，装配层那层「到点不等、迟到补记」删掉。

## 现状（拍板前）

Host 的 mount / unmount / replace 排在一条串行队列上，事务只有 apply 返回才结束。2026-11-03 给热部署在装配层加了限时：到点不再等、把 permit 交还，但事务本身还挂在队列上。后果有三：

1. **启动没法限时**。启动时盘上扩展一个接一个装，后面还有角色那一代。第一个挂住，在外面不等它也没用——后面的装载排在它后面，`createEcho()` 永远不返回，没有任何提示。
2. **热部署到点之后队列仍被占着**。之后每一次装载、卸载都排在挂住的那次后面：再部署一次又等满 30 秒，`stop()` 的卸载等满 10 秒后带着错误收场。
3. **「迟到的结果补记」是另一套账**。到点后那次事务可能在之后任何时刻装上，装配层靠回调把它记回清单。收摊正好撞上时，这一代既不在清单里也没被卸，快照也没人删。

## 选项

- **A. 时限放进 Host 的装载事务。** 到点 Host 放弃这个 Extension，按装载失败走现成的回滚，事务结束。
- **B. 启动时把盘上扩展挪到角色之后装，仍在外面限时。** `createEcho()` 能返回，但队列照样被占着，第 2、3 条不变；还改了角色与盘上扩展谁覆盖谁。
- **C. 启动时到点让 `createEcho()` 抛错。** 把一直等变成明确失败，但违背「盘上扩展坏了只记诊断、不挡启动」。

2026-11-03 那次否掉「Host 加超时」的理由是「强制中止不了不合作的代码，收益与装配层限时相同」。前半句成立，后半句不成立：放弃不需要中止它，只需要让事务结束、让它之后登记不上，而这正是装配层限时做不到的。

## 决定

**A**。

1. **时限与中止**：每个 Extension 的装载——`apply` 加上它在 apply 期间登记的 Effect start——与 [`EXTENSION_APPLY_LIMIT_MS`](../../../packages/core/src/extension/host.ts#symbol=EXTENSION_APPLY_LIMIT_MS)（30 秒）及 `mount()` / `replace()` 收到的 `signal` 赛跑。到点或中止，这次装载以 `ExtensionMountError` 失败，`cause` 是 [`ExtensionApplyAbandoned`](../../../packages/core/src/extension/host.ts#symbol=ExtensionApplyAbandoned)（`reason` 为 `timeout` 或 `aborted`）。已经中止的 signal 不再起 apply。
2. **被放弃之后**：Host 中断不了那个 apply，它照跑，但 Context 在回滚时已失效，之后 `get` / `provide` / `effect` 一律抛。回滚不等还在飞的 Effect start（挂住的可能正是它）；已经拿到的 lease 照常逆序卸，之后才交出的 lease 当场卸掉。
3. **对所有代生效**，包括产品自带的、inline、角色、builtin。它们本来就是 fail-loud：到点 `createEcho()` 抛错，而不是一直等。
4. **换代**：新代的装载被放弃时与 apply 抛错同一条路，把旧代装回去（`rolled_back`）；装回也被放弃才是 `lost`。
5. **装配层**：启动时盘上扩展的装载被放弃，记诊断 `extension_apply_timeout`、其余照常装。热部署把 permit 的 signal 传给 Host，去掉自己的限时与迟到补记；到点新文件报 `failed`，换代报 `rolled_back`（此前是 `lost`）。`RELOAD_APPLY_LIMIT_MS` 删掉。
6. 时限由 Host 构造时的 `applyLimitMs` 与 `clock` 给，缺省 30 秒、真时钟；`createEcho()` 传装配用的那个钟。

## Non-Goals

- **不给卸载（disposer）加时限**。挂住的 disposer 仍会占着队列；收摊由 `STOP_UNMOUNT_LIMIT_MS` 兜着，热部署里卸旧代（含文件删掉的那条路）没有上限。
- **不拦绕过 `ctx.effect()` 直接写 registry 的注册**。被放弃的 apply 之后这样写进去的东西 Host 收不回来——卸载时本来就收不回来，惯用写法把注册放在 `ctx.effect()` 的 start 里。
- 不把时限做成扩展可声明、或产品可配的选项。
- 不改 ACTIVE 之后新建 Effect 的失败语义。

## 验收

Host：

- [apply 不返回](../../../packages/core/test/extension-host.test.ts#test=装载到时限apply-不返回的那一代被放弃并回滚排在它后面的-mount-照常执行被放弃的-apply-之后再登记一律抛)：排在它后面的 mount 照常执行；被放弃的 apply 之后登记抛 `ExtensionDisposedError`。
- [Effect start 挂住](../../../packages/core/test/extension-host.test.ts#test=装载到时限挂住的是-effect-start回滚不等它已经起来的那个照常卸它之后才交出的-lease-当场卸掉)：回滚不等它；之后才交出的 lease 当场卸。
- [中止](../../../packages/core/test/extension-host.test.ts#test=装载听中止signal-中止时正在装的那个被放弃并回滚已经中止的-signal-不再起-apply)。
- [换代装回旧代](../../../packages/core/test/extension-host.test.ts#test=换代时新代的装载到时限旧代按原样装回去rolledback不是-lost)。

装配：

- [启动时盘上扩展挂住](../../../packages/core/test/extension-reload.test.ts#test=启动时盘上扩展的-apply-挂住host-到时限放弃它只记一条诊断createecho-照常返回排在它后面的扩展照常装上用得上)：`createEcho()` 返回、诊断 `extension_apply_timeout`、排在后面的扩展用得上。
- [启动时显式装配的扩展挂住](../../../packages/core/test/extension-reload.test.ts#test=启动时显式装配的扩展-apply-挂住到时限-createecho-抛错fail-loud不是一直等)：`createEcho()` 抛错。
- [热部署挂住](../../../packages/core/test/extension-reload.test.ts#test=热部署时新版-apply-挂住host-到时限放弃它把旧版装回去rolledback放开-admission事务队列没被堵住改好再部署照常换上stop-不用等)：`rolled_back`、permit 放开、改好再部署 `replaced`、`stop()` 直接完成。
- [disposer 挂住时收摊](../../../packages/core/test/extension-reload.test.ts#test=stop扩展的-disposer-挂住卸载到时限不再等照常停-agent交还-lease)：卸载上限仍在。

把 Host 里到点放弃那一行关掉，Host 的前两条与换代那条、装配的启动盘上与热部署两条都红（等不到）。
