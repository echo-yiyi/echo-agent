# 上下文镜像：每轮注入与被换掉的 system 用完就丢

> 状态:implemented · 提出 2026-11-13（core 全量 review：观测线程的镜像只增不删）· 拍板 2026-11-13（用户：「可以，按这个做」）· 落地 [`ContextMirror`](../../../packages/core/src/observability/context-mirror.ts#symbol=ContextMirror)、[`ContextMirrorStore`](../../../packages/core/src/observability/context-mirror-host.ts#symbol=ContextMirrorStore) · 判据 `packages/core/test/observability-context.test.ts` · 修改 [观测白盒化](../proposed/2026-11-03-observation-white-box.md)「A1 落地时定的」里的「镜像不淘汰」

**给谁看**：改上下文镜像、`context.built` 的人，以及给常驻进程做容量规划的人。假设已知 [观测](../../design/observability.md) 里「主线程只交编号与第一次见到的对象、观测线程按编号留一份」的做法。

**一句话**：每轮注入的值处理完那次交接就删，被换掉的 system 由主线程报出来、观测线程随即删；镜像不再随模型调用次数涨。

## 现状（拍板前）

观测线程按编号留着主线程交过来的每一个值，只存不删，随 runtime 收摊才丢。A1 落地时定的是「实测有压力再加淘汰」。有两样东西每次调模型都会多留一份：

- **每轮注入**。它们每次调模型都是新造的对象（skill 正文、任务清单），主线程按对象身份查不到，于是每次都发一个新编号、重交一遍值。
- **system**。主线程只记最近的一份，换了就发新编号。主循环与子 agent（提取、整理、subagent）交替送模时每次都换。

常驻进程里，镜像的大小因此与「调过多少次模型」成正比，没有上界。

## 决定

1. **每轮注入不记编号**。主线程每次给它现发一个只在这次交接里有效的编号、把值交过去；观测线程处理完这次交接就删。主线程的开销不变——此前每次也是重交。
2. **被换掉的 system 报出来**。交接多一个可选字段 `drop`：主线程从此不会再提起的编号。system 换了，旧的那个编号进 `drop`；观测线程处理完这次交接，删掉它的值和它编过的 blob 引用。
3. **删在处理完之后、算不出来也删**。`context.built` 的构成与 `content` 档的正文都在处理这次交接时同步算完、编完，之后没有人再按这些编号来取。
4. **主线程不多做事**：没有新的 await、没有与上下文长度成正比的计算；`drop` 最多一个编号。

## Non-Goals

- 不淘汰其余的值：transcript 的消息（后面的调用还要用）、压缩状态、工具 schema、hook 改视图时新造的消息。后三样随出现过的不同对象数涨，常驻进程里仍没有上界——见 [观测](../../design/observability.md) §8 第 8 条。
- 不在主线程记多份 system 来省掉交替时的重交。
- 交接在到达观测线程之前丢了（ring 满）时，它带的 `drop` 也丢了，那一份 system 会留到收摊。不为此加补偿。

## 验收

`packages/core/test/observability-context.test.ts`：

- 「每轮注入用完就丢」：同一段 transcript 调 500 次模型、每次注入都是新对象，镜像里留着的值始终是 3 个，每次的注入构成照样算得出。
- 「被换掉的 system 用完就丢」：两份 system 交替 200 次，镜像里留着的值不变，每次的 system 字数与 token 照样量得出。
- 「主线程：注入每次都交值……」：同一个注入对象第二次也照交、编号不同；system 换了才有 `drop`。

把观测线程里删的那一步关掉，前两条红（第一条调一次就多一份，第二条攒到 203 份）。
