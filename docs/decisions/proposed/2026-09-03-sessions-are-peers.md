# 会话对等无父子,通道是 inbox 落盘,`wait` 是通道上的等待;core 不管进程

> 状态:proposed · 提出 2026-09-03 · 拍板 2026-09-03(口头,实现后移入 implemented) · 来源 [会话与 agent 集群](../../design/sessions.md) §5、§7

## 现状(拍板前)

会话之间没有任何通道。inbox 的语义是「外面发生了一件事 → 入队、回 idle 开一轮」,落盘 at-least-once、带 dedupe 与 ack,但只在启动时读盘,别的进程写进来看不见。`BackgroundTask.kind` 预留了 `"subagent"`,没有实现。

## 不拍板的代价

多 agent 结构只能长成父子树(一个进程 spawn 另一个、阻塞等结果):嵌套、连坐、每层一套失败语义;常驻程序里「同时跟几十个对象聊」这种对等形态装不进去。反过来只做纯异步,交互式 coding 里最常用的「开一段去查、拿结果回来接着干」就废了。

## 选项

- **A. 对等 + inbox 通道 + `wait`。** 发消息 = 往对方 `inbox/` 写 record(environment 消息,`source = "session"`,`ref` = record id);**record id 由写者生成**(全局唯一、时间可排序),不再由 `InboxStore` 集中发号——集中发号在写者从 1 变成 N 之后会撞同一个文件名、后到的静默覆盖先到的(`store.ts` 的 `nextSeq` 只在 restore 时校准一次);同进程也先落盘再投;持有 lease 的进程 watch 自己的 inbox 目录、只有它消费与 ack;`send` 回对方活没活着;`session_send({ wait: true })` 挂着等 `replyTo` 指回来的回信,**命中即消费**(作为工具结果返回并 ack,不再以 environment 消息二次投递;超时不消费,回信走普通路径),本质仍是通道上的一条消息。core 不起进程、不管进程。
- **B. 父子树。** `session_create` 起子实例(同进程或子进程),阻塞等它跑到 idle 拿最后一条回来;可选后台变体投 inbox。
- **C. 对等纯异步,不给 `wait`。** 发了就走,回信落 inbox 下一轮才见。

## 决定

**A**(2026-09-03 用户拍板:「没有子 session 的概念」「就像一个 agent 集群」「core 不管进程」;`wait` 与不越权是本会话里用户接受的两条补充)。附带:执行体(谁把一段跑起来)不是 core 的概念,终端里人起、常驻程序进程内起、产品自己出 extension 起,都行;跨进程把别的 session 的事件拉到本壳(IPC)不做。

## 验收

A 进程 `session_send` 到 B,B 不重启,下一轮 provider 请求里含那条 environment 消息;同容器两段互发,盘上 `inbox/` 里有 record、消费后有 ack marker;两个进程同时往同一段各投 100 条,盘上恰好 200 个文件、200 条都进过 transcript;send 到没进程的段返回 `alive: false`,之后 `--resume` 那段第一轮看到它;`wait: true` 在回信落盘后返回且那条回信不再以 environment 消息出现,超时返回 `timedOut`、之后到的回信恰好出现一次。
