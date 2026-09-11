# 文件锁改成带递增编号的锁：持有者确认已死就自动接管（lease 与记忆提交锁一起换）

> 状态:implemented · 提出 2026-09-10（记忆并发验收「kill -9 后别的进程能继续」与 2026-08-18「不自动接管」冲突）· 拍板 2026-09-10（用户：「lease 和记忆锁一起换」）· 实现 2026-09-10 · 取代 `packages/core/src/storage/file-lock.ts` 头注里 2026-08-18 那条「不做自动 stale takeover」

## 现状(拍板前)

session 的 lease（`fileStateLock`）与记忆的提交锁（`FileDir.lock`）都是单个锁文件 + `open(…, "wx")`，且不自动接管：2026-08-18 实测「读 → 判陈旧 → 删 → 重建」三步之间没有互斥，压测第 136 次两个调用同时拿到 lease；「刚建好还没写完」的锁文件也会被当成坏档删掉。

代价是进程崩在持锁期间，锁就一直留着：`--resume` 那一段起不来（「已被另一个写者持有」），记忆模块在那一层一直返回 `busy`，都要人去找锁文件删。

## 不拍板的代价

任何一次崩溃（kill -9、OOM、断电）都要人工删锁；[记忆并发](2026-09-07-memory-concurrency.md)的验收「持锁进程被 kill -9，别的进程能继续」做不到。

## 选项

- **A. 带递增编号的锁**（generation / epoch，fencing token 的思路）：锁是目录，认领记录只增不删当前代，接管 = 往上叠一代。纯文件系统，Node 与 Bun 都能跑。
- **B. 内核仲裁的 advisory lock**（`flock` / `fcntl`）：进程死了内核自动放锁。Node 标准库没有，要原生依赖。
- **C. SQLite 事务做锁**：仓内只有 `bun:sqlite`，且是动态 import；core 在 Node 下也要能加载（分发门跑 Node）。
- **D. 维持现状**，文档写清「崩溃后人工删锁」。

## 决定

**A**（2026-09-10 用户拍板），lease 与记忆提交锁用同一个实现（[`claimGeneration()`](../../../packages/core/src/storage/generation-lock.ts#symbol=claimGeneration)）。

盘上：锁目录里 `g<n>` 是第 n 代的认领记录（holder / pid / host / at / token），`r<n>` 是第 n 代已释放，**当前代 = 最大的 n**。

- **拿锁**：当前代 m 已释放、或它的持有者确认已死，就写临时文件并 fsync，再 `link` 成 `g<m+1>`；EEXIST = 别人先认领了，重看。link 成功后复核：没有更大的代、且据以判断的 `g<m>` 原文未变，才算拿到；否则把自己这一代标成已释放、重来。
- **确认已死只有一种**（[`holderGone()`](../../../packages/core/src/storage/generation-lock.ts#symbol=holderGone)）：记录里的 host 是本机，且 `process.kill(pid, 0)` 报 ESRCH。EPERM、别的机器、没写 host、读不出来，一律当活着。
- **释放** = 写 `r<n>`；只放 token 对得上的那一代，已经不是自己的就抛、不动它。认领到第 n 代的人清掉 n-2 代及更早的记录和 pid 已死的临时文件。

为什么这回不会双授：2026-08-18 的双授出在「删」——两个接管者都删掉旧锁、都建新锁。这里当前代从来不删，接管是 link 出下一代，同一个名字文件系统只让一个人建成；内容先写好再 link，也不会再有「刚建好还没写完」被当成坏档。

会话面的 `isAlive` 与接管共用同一个死活判法（`holderGone`），替换 `create-echo.ts` 里单独的 pid 探针——[会话存活探针](2026-09-09-session-alive-pid-probe.md)的判法没变，只多了「host 是本机」一项。

**仍要人来的情形**：共享盘上别的机器崩掉留下的锁、pid 恰好已被别的进程复用的锁、被外力写坏的记录、旧版本留下的单文件锁——都照旧拿不到，报错里说清是谁、锁在哪。

**盘上格式变了**：`<session>/.lock` 与记忆层的 `.locks/<模块>.lock` 从文件变成目录，释放后目录留着。`existsSync(.lock)` 不再表示「被持有」，要看 `inspectStateLock()` 的 `state`。

## 验收

判据在 `packages/core/test/state-lock.test.ts`：

- 崩溃接管：[伪造的死持有者](../../../packages/core/test/state-lock.test.ts#test=崩溃之后自动接管持有者在本机pid-查无此号下一个-acquire-叠一代拿到此前要人工删锁)、[真进程 kill -9](../../../packages/core/test/state-lock.test.ts#test=持锁进程被-kill--9它活着时拿不到死了之后下一个-acquire-直接接管)。
- 零双授：[32 个人同时接管同一个死持有者，100 轮每轮恰好一个](../../../packages/core/test/state-lock.test.ts#test=p0-反证接管同一个死掉的持有者32-个人同时来接管每一轮恰好一个拿到)；[多进程压测](../../../packages/core/test/state-lock.test.ts#test=多进程压测6-个进程各拿放-300-次其间陆续有进程拿到锁就崩不释放零双授计数一个不少)——6 个进程各拿放 300 次，其间陆续有进程死在持锁期间，锁内占位文件零冲突、计数 1800 一个不少。
- 确认不了死活不接管：[别的机器、没写机器、持有者还活着](../../../packages/core/test/state-lock.test.ts#test=确认不了死活就不接管别的机器没写机器持有者还活着一律当它活着)。
- 端到端：`packages/core/test/resident-v0.test.ts` 崩溃之后下一个进程直接起来、重放那条入站事实；[写者崩在提交中途，下一个写者接着写](../../../packages/core/test/memory.test.ts#test=写者崩在提交中途锁没放就死了下一个写者自动接管不再一直-busy)。
