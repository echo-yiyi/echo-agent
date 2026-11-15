# 锁看心跳判死活；显式续会话一定续得上，被接管的一方丢锁停手

> 状态:implemented · 提出 2026-11-15（用户：「锁住了会话如果没有结束，异常结束没有释放锁，这个会话不能继续」「我们现在在沙箱里面发现，当沙箱异常退出，拉起来会话，现在不行」）· 拍板 2026-11-15（用户：「按心跳那个方案做」——锁照留、看心跳、显式续会话一定能接管；不采用「把锁整个去掉、允许同一段同时开两份」）· 落地 `packages/core/src/storage/generation-lock.ts` / `file-lock.ts` / `lock.ts`、`agent.ts`、`create-agent.ts`、`create-echo.ts`、`packages/base/src/cli.ts` / `shell.ts`、`packages/tui/src/takeover.ts`，判据见验收 · 修改 [带递增编号的锁](2026-09-10-generation-lock-takeover.md) 的「确认已死只有一种」与「仍要人来的情形」、[可让位的租约](2026-09-07-preemptible-lease.md) 的「core 不抢占」

**给谁看**：改单写者锁、续会话或宿主启动路径的人。假设已知 [会话](../../design/sessions.md) §5 与 [带递增编号的锁](2026-09-10-generation-lock-takeover.md)。

## 现状（拍板前）

持有者「已经不在了」只有一种判法（`holderGone`）：记录里的 host 等于本机 `os.hostname()`，且 `process.kill(pid, 0)` 报 ESRCH。两项在常见情形下都立不住：

- **机器名会变。** macOS 没设固定主机名（`scutil --get HostName` 为 not set）时按网络取名：实测同一个会话里从 `hainans-MacBook-Pro.local` 变成了 `Mac.lan`。之前崩掉留下的锁（`~/.echo/sessions/s-mv0ubufq-b1ip`，pid 33873 已 ESRCH）因此被判成「别的机器、还活着」，`acquire` 返回 null——那一段从此续不上。
- **沙箱重建。** 主机名是新容器的，pid 从头分配、很可能撞上旧持有者的 pid（甚至就是新进程自己），两项都判「还活着」。
- 文件锁的 `Lease.lost` 是一个永不 settle 的 Promise：持有者根本不知道自己被接管，所以也不敢接管还活着（或判不出死活）的持有者。

## 选项

- **A. 去掉锁**，像 Claude Code 那样允许同一段同时开两份。被否：echo 的一段会话是一直在跑的 agent（消费 inbox 并 ack、到点触发提醒、后台提取与整理记忆、后台任务），两份同时活着会每条提醒响两次、同一条 inbox 处理两次、`tasks.json` 互相覆盖、对话记录被交替追加。
- **B. 用硬件 UUID 认本机**（macOS 的 IOPlatformUUID、Linux 的 machine-id）替代主机名。只解决换网络，沙箱重建照样卡。
- **C. 锁照留，判死活看心跳，显式续会话一定能接管、被接管的一方丢锁停手。**

## 决定

**C**（2026-11-15 用户拍板）。

1. **心跳**：认领记录多一个 `beat`；持有期间每 `LOCK_BEAT_MS`（2 秒）刷一次（写临时文件、rename 回 `g<n>`）。lease 与记忆的提交锁同一个实现，都有心跳。
2. **被接管就丢锁**：刷心跳前先看一眼，上面叠了更大的代、或自己那一代的记录不见了 / 换了人，`Claim.lost` / `Lease.lost` 带着原因触发、不再刷。Agent 已有的丢锁善后（`watchLease`：revoke 写入格、封会话、中止在跑的、停轮询与闹钟）接住它。被接管之后的 `release()` 正常返回，不报「单写者约束可能被破坏」。
3. **判死活**（[`holderGone()`](../../../packages/core/src/storage/generation-lock.ts#symbol=holderGone)）：心跳超过 `LOCK_STALE_MS`（10 秒）没刷；或者 host 是本机且 pid 查无此号（刚崩的不必干等心跳过期）。没有 `beat` 的旧记录只能按后一种。`inspectStateLock` 的 `valid` 带上 `alive`，会话面判「活着」、宿主判「要不要问」都用它。
4. **强行接管**（[`StateLock.takeOver`](../../../packages/core/src/storage/lock.ts#symbol=StateLock)，可选方法）：不管持有者在不在，叠一代。当前代记录坏了也照样叠；旧版本的单文件锁先挪到 `<锁>.legacy-<时刻>` 再认领。活着的持有者在下一次刷心跳前发现、停手，这之间至多差一个 `LOCK_BEAT_MS`，它可能还写进一条——只发生在人明确要接管一个还在跑的会话时；沙箱异常退出的情形对方已经没了。
5. **谁接管**（[`CreateAgentOptions.takeover`](../../../packages/core/src/create-agent.ts#symbol=CreateAgentOptions)）：`start()` 拿不到锁、请过让位也没让成，带 `takeover` 的就 `takeOver()`，并报一条 `lease_takeover` 诊断说出原持有者。`preemptible` 的实例给了也不生效。宿主按形态给：
   - 管道形态 `--resume` / `--continue`：一律带。
   - 交互形态：装配之前看一眼锁（[`takeoverQuestion()`](../../../packages/base/src/cli.ts#symbol=takeoverQuestion)），持有者还活着又不可让位、或锁坏了，经 `Shell.confirmTakeover`（可选，终端壳实现为一屏选择，缺省「不接管」）问一句；不用问的一律带。`/resume` 换段同样。
   - `--serve` 被叫醒的临时宿主：不带。
6. **盘上格式**：认领记录多 `beat` 字段；旧记录照读（按旧判法）。不迁移。

## Non-Goals

- 不允许同一段同时开两份（选项 A）。
- 不做服务端 / 跨机器的租约。共享盘上两台机器靠墙钟比心跳，钟差远小于 10 秒才可靠。
- 不改记忆提交锁的等待时限（`DEFAULT_LOCK_TIMEOUT_MS`）。
- 旧版本（没有心跳）的进程仍在跑时被新版本强行接管，它不会发现自己丢锁——混跑新旧版本时不要对它显式接管。

## 验收

每条在改动之前的代码上跑都是红的（「后台宿主不抢」守的是原本就成立的规矩，改前改后都绿）：

- 沙箱残锁：[机器名换了、pid 被复用，心跳过期就接管](../../../packages/core/test/state-lock.test.ts#test=沙箱重建之后机器名换了pid-又被复用甚至就是自己心跳过期就接管此前判成别的机器还活着崩掉的会话续不上)、[端到端不带 takeover 也续上](../../../packages/core/test/lease-handoff.test.ts#test=沙箱重建留下的残锁机器名换了pid-被复用心跳早停了不带-takeover-也直接续上)
- 心跳：[只看心跳不看名字](../../../packages/core/test/state-lock.test.ts#test=心跳没过期就当活着机器名对不上也不抢只看心跳不看名字)、[心跳在刷](../../../packages/core/test/state-lock.test.ts#test=持有期间心跳在刷别人读到的-beat-一拍比一拍新)
- 强行接管与丢锁：[活着的也接管、被接管方 lost](../../../packages/core/test/state-lock.test.ts#test=takeover活着的持有者也接管被接管的一方在一拍心跳内-lost-触发它的-release-不报单写者被破坏)、[旧单文件锁与坏档](../../../packages/core/test/state-lock.test.ts#test=takeover旧版本的单文件锁挪到一边再接管当前代记录坏了也照样叠上去)、[两人同时接管只剩一个](../../../packages/core/test/state-lock.test.ts#test=两个人同时-takeover-同一把最后只有一个还持有原来的和另一个-lost-触发)
- 续会话路径：[显式续会话接管、原来那段停手](../../../packages/core/test/lease-handoff.test.ts#test=显式续会话takeover另一个终端开着不肯让的那段也接管原来那段丢锁停手新来的续上对话不带-takeover-照旧挡在门外)、[后台宿主不抢](../../../packages/core/test/lease-handoff.test.ts#test=被叫醒的后台宿主preemptible带了-takeover-也不抢人开着的那段照旧挡住它)
- 要不要问：[活着又不可让位才问](../../../packages/base/test/takeover-question.test.ts#test=还活着又不可让位问并说出是哪个进程多久前还有心跳)
