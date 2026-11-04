# 产品入口兜住进程级 unhandledRejection：stderr 一行，进程继续

> 状态:implemented · 提出 2026-11-03（review：扩展里一个没接住的 rejection 让 `--serve` 宿主跟着退）· 拍板 2026-11-03（用户：「全部按推荐修，并参考成熟实现」）· 落地 `packages/base/src/cli.ts#mainFor`，判据见文末

**给谁看**：写扩展、维护产品可执行入口的人。假设已知 [坏扩展不阻塞启动](2026-09-01-bad-extension-does-not-block-startup.md)。

## 现状（拍板前）

全仓没有进程级 rejection 处理器。Bun 的缺省是：任何一个没接住的 Promise rejection 让进程以 1 退出。扩展的 `apply` 里起一个 timer、里面一个没 `await` 也没 `.catch` 的 Promise 失败了，交互会话、管道里正跑着的 run、`--serve` 常驻宿主全跟着没了，退出前什么都不说。坏扩展不阻塞启动那条只管到装载失败，管不到装上之后的异步失败。

## 选项

- **A. 产品入口的共用路径装 `unhandledRejection` 处理器**：stderr 一行（消息 + 栈的第一帧），进程继续。`uncaughtException` 保持缺省。
- **B. 不兜**：扩展自己的 bug 自己负责。代价是一个扩展的疏忽拖垮整个容器，用户看不出是谁。
- **C. 两样都兜**：同步抛出、没人接的异常发生时栈已经展开，进程状态说不清，继续跑是赌；Node 的缺省也是退出。

## 决定

**A**（2026-11-03 用户拍板）。

1. 装在 [mainFor()](../../../packages/base/src/cli.ts#symbol=mainFor) 返回的那个入口函数里：每个产品（`echo-agent`、`echo-coding`）的 bin 都经过它，包括 `observe` 子命令。进入时 `process.on`，返回时 `process.off`。
2. 一行格式：`[unhandledRejection] <消息> <栈里第一个 at 帧>`；不是 `Error` 的就 `String()` 它、不带帧。帧里有文件路径，看得出是哪个扩展。
3. 进程继续；退出码不因此改变。
4. `uncaughtException` 不装处理器，保持 Bun 的缺省（退出）。

## Non-Goals

- 不把 rejection 归到某个扩展、不卸那个扩展、不记观测：只说一句。
- 不在 core 里装：`createEcho()` 是库，进程策略归嵌入它的程序。
- 交互形态下这一行同样写 stderr，不另走界面的旁白通道；与 TUI 的画面会有一次交叠，下一次重绘覆盖。

## 验收

- [扩展里没接住的 rejection 不让进程退出](../../../packages/cli/test/cli.test.ts#test=bin扩展里一个没接住的-rejection-不让进程退出stderr-一行说清是什么在哪个文件run-照常跑完)：bin 级，扩展装上 10ms 后 reject、假端点 800ms 后才回答；退出码 0、回答照到、stderr 那一行带消息和 `leaky.ts`。变异：去掉 `process.on` 即红（Bun 以 1 退出）。
