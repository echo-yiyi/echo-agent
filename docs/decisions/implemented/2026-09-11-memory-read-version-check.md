# 记忆写回前核对读到的版本，而不是把锁拉长到整个处理过程

> 状态:implemented · 提出 2026-09-11（用户指出提交锁没覆盖「读完 → 思考 → 写回」）· 拍板 2026-09-11（用户：「按照你的想法来改」）· 实现 2026-09-11 · 补 [记忆并发](2026-09-07-memory-concurrency.md) 的读改写保证

## 现状(拍板前)

提交锁（层 × 模块，[`commitUnderLock`](../../../packages/core/src/memory/harness.ts#symbol=commitUnderLock)）只罩住**一次**工具调用。模型的一次改动横跨好几次调用：先 view、再想、再写回。用户给的场景：

1. A 读到 `A B`，开始思考，没有持锁；
2. B 拿锁把内容改成 `A BB`，写完放锁；
3. A 想完拿锁，把凭旧内容整理出的 `AA B` 整份写回（`create`）；
4. 两次写入没有同时发生，B 的更新还是被覆盖了。

代码上：[`memoryView`](../../../packages/core/src/memory/harness.ts#symbol=memoryView) 不记读到的是哪一版；`create` 整份覆写不带 `basedOn`，[`assertFresh`](../../../packages/core/src/memory/lock.ts#symbol=assertFresh) 只挡一次调用内部的几毫秒。会丢更新的只有整份覆写、insert（按行号插在变了的文件上）、delete；`str_replace` 在锁里对最新内容替换、old_str 找不到就拒，rename 搬的是最新内容。

## 选项

- **A. 把锁拉长到整个处理过程**（用户起初的提议）：提取、整理一次跑几十秒到几分钟，期间整层冻结，别的 session 的写排队或 busy；前台 agent 的「读 → 想 → 写」横跨好几轮对话，根本锁不住，保护不完整；模型调用卡住时锁一直占着（崩溃接管只管死进程）；事先不知道模型会碰哪些文件，只能锁整层。
- **B. 写回前核对读到的版本**（乐观并发 / CAS）：每个读写方记下 view 看到的全文，覆写前核对「你看到的还是不是现在这一版」，不是就拒、让它重看。锁仍只罩一次提交。

## 决定

**B**（2026-09-11 用户拍板）。

- 每把记忆工具一本账 [`MemoryReads`](../../../packages/core/src/memory/harness.ts#symbol=MemoryReads)（路径 → 上次看到的全文），在 `createMemoryTool` 里建：前台那把、每次提取、每次整理各一本——共用一本的话，提取看过的版本会替前台作保。
- **核对**：`create` 覆写已有文件、`insert`、`delete` 之前，在提交锁里比对。没看过 → `not_read`；看过但变了、或看完之后被删了 → `stale_read`。新建文件不用先看。
- **记账**：view 记下全文；写成之后，写之前那一版就是它看着的（或文件是它新建的）→ 记下新内容，接着写不用重看；否则（凭过期的账做了一次 str_replace）作废这一条，下次覆写前得重看。rename 让账跟着文件搬。
- `str_replace` 不核对，rename 不核对（理由见上）。程序直接调写方法、不给账，就不核对。
- 同批两件（用户同意一起做）：整理前按层**试拿一次** `.dream/pass`（[`claimDreamPass`](../../../packages/core/src/memory/harness.ts#symbol=claimDreamPass)，不等），拿不到 = 别的 session 正在整理这一层，跳过，拿到之后再判一次门；Dream 状态（计数、startedAt）的读改写进这一层的短锁 `.dream/state`，多个 session 同时记数不丢增量。

**代价**：模型覆写或删除一个文件之前多一次 view；多个 session 同时改同一个文件时，后到的一方会被拒一次、重看再改。一次整理跨多个文件不是原子的——中途某个文件被拒，整理可能只做了一半，但不会丢别人的更新，下一次整理再补。

## 验收

判据在 `packages/core/test/memory.test.ts`：[用户给的场景](../../../packages/core/test/memory.test.ts#test=a-读完去想b-写了一笔a-凭旧内容整份写回被拒b-那一笔还在a-重看之后再写两边都在)；[没看过的已有文件不许覆写、插、删](../../../packages/core/test/memory.test.ts#test=没看过的已有文件不许整份覆写不许按行插不许删新建文件不用先看)；[一层同时只有一个整理者](../../../packages/core/test/memory.test.ts#test=同一层已有整理在跑再来一个试拿不到当场跳过不等放手之后能拿到两个-filedir-实例跨实例算数)；[多个实例同时记数不丢](../../../packages/core/test/memory.test.ts#test=两个实例同时往同一层的两个模块写两把提交锁互不相干这一层的写入计数一个不少)。
