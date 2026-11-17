# 从进程外往会话的 inbox 投递

> 状态:implemented · 提出 2026-11-16（使用者的群聊场景：agent 常驻，后台运维要通过 inbox 让 agent 做事）· 拍板 2026-11-16（用户：「inbox 要对外暴露」「同一个容器，按你说的做」——三件：core 开一个跨进程的投递口、产品层加 `send` 子命令、收方扫盘时按 dedupeKey 去重；同日拍板「没在跑的照样收下，就这样定」）· 落地 `packages/core/src/session/ingress.ts`、`packages/core/src/inbox/foreign.ts` / `store.ts`、`packages/base/src/send.ts` / `cli.ts`，判据见验收

**给谁看**：要从 agent 进程之外让常驻 agent 做事的部署方，以及改 inbox、会话面的人。假设已知 [会话](../../design/sessions.md) §5 的 inbox。

## 现状（拍板前）

- inbox 本来就能跨进程：`session_send` 就是往对方会话目录的 `inbox/` 写一个 record 文件，对方每秒扫一次盘（`InboxStore.refresh`）收进来。
- 但进程外没有公开的写法：写 record 的那段是 `EchoSessions` 的私有方法，而且只写「来自某段会话」的环境消息；进程内的投递口 `agent.ingress` 不在运行协议上，别的进程更够不到。手写 record 文件不行——记录 id 要按时间有序，格式要过校验。
- 收方扫盘时只按记录 id 认新旧，**不按 dedupeKey 去重**：外部投递重试一次，同一件事就做两遍。进程内投递是按 dedupeKey 去重的。

## 决定

1. **core 开一个进程外的投递口，协议沿用 `DurableIngressPort`**：[`openSessionIngress({ sessionsRoot?, sessionId })`](../../../packages/core/src/session/ingress.ts#symbol=openSessionIngress)。打开时核对那段会话存在、没关，否则抛；之后 `deliverDurable({ message, dedupeKey })` 不抛，结果是现成的 `DurableDeliveryResult`：
   - `accepted`：record 已落盘。同一个 dedupeKey 还有一条没处理完（盘上有、没被 ack）时不写新的，返回那条的 `recordId` 与 `deduplicated: true`——与进程内投递同一条规矩。
   - `rejected{invalid-request}`：dedupeKey 为空（`empty-dedupe-key`）或消息形状不对（`message-shape`）。
   - `rejected{runtime-disposed}`：打开之后那段会话被关（`session-closed`）或没了（`session-missing`）。
   - `rejected{store-error}`：写不进盘（`write-failed`）。
2. **写 record 的那段抽出来共用**：[`writeInboxRecord`](../../../packages/core/src/inbox/foreign.ts#symbol=writeInboxRecord)，`session_send` 与新投递口走同一个函数。
3. **消息算谁说的由调用方给的 `message` 决定**：`userMessage(text)` 是用户的话——当指令执行，安全分类器也认它是用户要的；`environmentMessage(text, source)` 是材料，按「谁的话算数」不当指令。能写那段会话目录的进程就能投，边界是容器与沙箱，不是这个函数（[安全加固](2026-11-15-security-hardening.md)）。
4. **收方扫盘时按 dedupeKey 去重**（[`InboxStore.refresh`](../../../packages/core/src/inbox/store.ts#symbol=InboxStore.refresh)）：同一个 dedupeKey 还有没处理完的（pending 或已领走、还没 ack），后来扫到的那份不收、从盘上删掉，记一条 `deduplicated` 的观测事实；那个 key 所在的整批正在 ack 时先不判，下一拍再看。两个写者同时投同一个 key 时靠这一条只做一次。
5. **投给没在跑的会话照样收下**（2026-11-16 用户拍板：「没在跑的照样收下，就这样定」）。这个投递口不叫醒：对方没在跑时 `accepted` 只说明落了盘，消息等它下次起来处理。与 `session_send` 的「先叫醒再投递，叫不醒就拒、一条不留」（[会话](../../design/sessions.md) §5）不同，因为调用方是宿主那一侧的进程，要的是一个持久的队列——agent 重启期间投的不丢；不是一句对话。没采用的另一种：对方没在跑就拒（`rejected{runtime-not-ready}`），由运维重试。
6. **产品层加 `send` 子命令**：`<产品名> send <会话 id> [--dedupe <键>] [--state-dir <路径>] <要它做的事>`（[`runSend`](../../../packages/base/src/send.ts#symbol=runSend)）。与 `observe` 一样不装配、不取锁、不看凭据；投一条用户消息，成功时 stdout 打记录 id。不给 `--dedupe` 就每次生成一个新键（等于不去重）。退出码：0 投进去了（或同一个键的那条还在等处理）、1 没投进去、2 参数错。

## Non-Goals

- 不开网络端口。运维后台与 agent 在同一个容器里（用户确认），能读写同一个 `~/.echo`；跨机器要另做带认证的投递口。
- 不起进程、不叫醒：core 不起进程（[会话](../../design/sessions.md) 的 Non-Goals）。
- 不回结果。要知道那件事做完没有，按观测查（inbox 的观测事实带 `recordId`，消费时记下处理它的 runId）；不做「等回执」。
- 不分「运维说的」与「群成员说的」：都是用户消息。要分再给用户消息的来源加一种。
- `send` 不提示「会话没在跑」：判断要读会话的锁文件，锁文件名是 core 的私有约定，不在产品层抄一份。

## 验收

去掉对应改动，标注的那条是红的：

- [投递口的结果](../../../packages/core/test/session-ingress.test.ts#test=opensessioningress投进去的一条落在那段会话的-inbox同一个-dedupekey-还没处理完再投返回原来那条空-key形状不对的拒会话不存在或关了打开就抛打开后被关了拒成-runtime-disposed)
- [跑着的 agent 收下并当成用户的话跑](../../../packages/core/test/session-ingress.test.ts#test=跑着的-agent-不重启就收下别处投来的用户消息当成用户的话跑一轮处理完之后同一个-dedupekey-再投是新的一条2026-11-16)
- [扫盘去重](../../../packages/core/test/session-ingress.test.ts#test=refresh同一个-dedupekey-还有没处理完的别处写进来的重复那条不收从盘上删掉先前那条-ack-之后同一个-key-再来是新的一条2026-11-16)（修前红：两份都收）
- [`send` 子命令](../../../packages/base/test/send.test.ts#test=runsend投进去打记录-id一条用户消息落在那段会话的-inbox同一个---dedupe-还没处理完不重复投会话不存在退-1参数错退-2)、[在启动逻辑之前分走](../../../packages/cli/test/cli.test.ts#test=mainforsend-子命令在一切启动逻辑之前分走不装配不看凭据会话不存在退-1不是把-send-当未知参数退-22026-11-16)
