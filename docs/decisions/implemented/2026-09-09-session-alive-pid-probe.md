# 会话面判「活着」加 pid 探针：锁合法且持有者进程还在

> 状态:implemented · 提出 2026-09-07（review 批 6 顺带，#90）· 拍板 2026-09-09（用户，选 A）· 实现 2026-09-09 · 来源 `packages/core/src/create-echo.ts` 里给 `EchoSessions` 的 `isAlive`

## 现状(拍板前)

`createEcho()` 给会话面的 `isAlive(id)` 只看 `<sessionDir>/.lock` 是否合法（`inspectStateLock().state === "valid"`）。文件锁**不做 stale takeover**（崩溃后人工删锁，[`state-lock.test.ts`](../../../packages/core/test/state-lock.test.ts#test=文件锁不做-stale-takeover哪怕持有者-pid-早就没了也拒绝)），所以崩溃留下的锁在盘上是合法的：会话面据此判它「活着」，`send` 直接投递并回「它会读」，消息躺在没人读的 inbox 里——这正是 2026-09-07「先确保它活着再投递」那条要消灭的空话。

## 不拍板的代价

一段崩过的会话在 `session_list` 里永远显示在跑；发给它的消息全部石沉大海，而叫醒路径（`SessionRunner`）永远不会被触发。

## 选项

- **A. `isAlive` 加 pid 探针**：`process.kill(pid, 0)`，ESRCH 判没了，EPERM 判在（别人的进程，存在但杀不了），其余按在算。只用于会话面的「直投还是叫醒」判定，**不碰锁**——core 仍不删锁、不抢锁。
- **B. 不猜死活**：保持现状，文档写清「崩溃后要人工删锁，否则别人发不进来」。

## 决定

**A**（2026-09-09 用户拍板）。「core 不接管锁」那条针对的是**所有权**（删 / 抢会双授），探活不改所有权：pid 复用的极端情形下最多把一段死会话判成活的，与今天一样；不会把活的判成死的（EPERM 与未知错误都按在算）。

## 验收

锁记录合法但 `pid` 不存在的会话，`echo.sessions.send()` 走叫醒路径（没 runner 时 `unreachable`）；`pid` 是本进程时照旧 `accepted`。判据在 `packages/core/test/create-echo.test.ts#test=会话面判活着看的是锁-持有者进程崩溃留下的锁pid-没了算没在跑发过去走叫醒review-2026-09-07-902026-09-09-拍板加-pid-探针`。
