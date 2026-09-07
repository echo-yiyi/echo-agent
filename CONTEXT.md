# echo-agent 词表

全仓的规范用词，一词一处定义。设计稿各自的术语表只列本文用到的、并指向这里；代码注释与决策记录用词以本表为准。只放本仓特有的概念，不放通用编程词。

## 装配与产品

**装配现场**：
把 provider、端口、内建能力与 extension 装成一个能跑的 agent 的那一处代码。全仓只有一处（`createEcho()`）。
_Avoid_：第二个装配、各产品自己装

**产品**：
交给 echo-agent 启动逻辑的名字、版本与装配片段；echo-agent 自己、echo-coding、findjob 都是。产品是容器级的事，一个容器只跑一个产品；一段 session 记着自己是哪个产品开的。
_Avoid_：agent、agentId、agentName、bundle

**壳**：
把 `AgentRuntime` 协议渲染给人的那条 extension（终端里的 TUI、将来的 Web）。壳不装配、不启停进程。
_Avoid_：前端、UI 层、外面套的一层

**容器**：
一个 OS 进程，装一个或多个 session。终端里的 echo-coding 装一个，常驻程序装几十个。
_Avoid_：宿主进程、runner 进程

## 会话与作用域

**session**：
agent 定义的一个运行实例：盘上一个目录，运行时一个 Agent 实例。session 与运行中的 agent 是同一个实体的两个视角。
_Avoid_：会话记录（那是 transcript）、对话

**agent 定义**：
产品内的一个角色：identity 段、工具子集、模型缺省，写成一个 markdown 文件。reviewer、前端、缺省都是；产品本身不是 agent 定义。
_Avoid_：产品、bundle、模版、subagent 定义

**main**：
容器自己起的 session（人起的、宿主程序起的）。只有 main 能经 `session_create` 再开一段；开出来的都不是 main。
_Avoid_：父 session、根 session

**状态根**：
一段 session 的目录：transcript 账本、inbox、tasks、schedule、lease、状态文件、观测库都在它下面。
_Avoid_：agent 目录、数据目录

**作用域**：
记忆等共享内容按谁看得见分的三层：session / project / user。
_Avoid_：层级、level

**分区**：
记忆按记的是什么分的三种：`agent.md`、`user.md`、笔记及其索引。分区与作用域是两个轴。
_Avoid_：记忆类型、层

**workspace**：
一段 session 工作的目录，是 session 的字段，不是状态根的一部分。
_Avoid_：cwd、项目目录（project 是作用域名）

**lease**：
一段 session 的单写者租约。持有它的进程才能写状态根；core 不猜对面死没死，也不抢占没有自称可让位的持有者。
_Avoid_：锁文件（那是它的实现）、mutex

**可让位**：
一个自称可以被请走的 session 实例：有人来要它的 lease 时它交还并退出。只给「为处理一条消息被叫醒」的临时宿主用；人开的会话不可让位。代码里叫 `preemptible`。
_Avoid_：抢占（那是对面的动作，不是这一方的属性）、后台实例

**subagent**：
同一容器内、由模型在调用时定形（指令、工具子集、预算）的一次性子循环：独立 transcript，没有状态根、lease 和 inbox，随父收摊。不是 session，只扇一层。
_Avoid_：子 session、子进程、委派会话

**消息来源**：
一条入账消息是谁给的：人、steer、harness（stop hook 注入之类），或环境（schedule、session、subagent 回信）。它决定壳怎么显示、评测怎么归因，不改变 role。
_Avoid_：sender、origin

**inbox**：
一段 session 的收件箱：外部发生的事落盘成 record，回 idle 后开一轮处理。会话之间的唯一通道。
_Avoid_：消息队列、IPC

## 循环

**run**：
一次 admission 到 `agent_end`，可含多条 reply。
_Avoid_：一次调用、一次对话

**reply**：
agent 对一条输入（prompt / followUp / stop hook 注入 / 续跑）的完整回应。steer 不开新 reply。
_Avoid_：task、answer、exchange

**turn**：
reply 里的一次迭代：调一次模型、处理它落地的响应及其工具批。
_Avoid_：一条消息（Anthropic Messages API 的 turn）

**attempt**：
turn 里的一次模型请求。重试 = 同一 turn 的下一个 attempt。
_Avoid_：retry

**steer**：
run 进行中插进当前 reply 的一条输入，打断它的原计划。
_Avoid_：打断、插话（口语可用，代码与文档用 steer）

**followUp**：
run 进行中排到当前 reply 之后的一条输入。
_Avoid_：排队消息

**admission**：
决定一件工作能不能开成一个 run、以什么优先级的那一步。同一时刻只发一个执行许可。
_Avoid_：调度器

**dream**：
agent 回 idle 后自己起的一次维护 run，整理 session 层的记忆。
_Avoid_：后台整理、GC

## 上下文

**transcript**：
按入账顺序排列的消息账本，会话事实的唯一真源。只增不改。
_Avoid_：history、messages（那是字段名）

**working context**：
本轮真正送给模型的那份：transcript 的投影加每轮注入，经 transform 与 hook 之后。不落盘。
_Avoid_：context（不带层级的裸词）

**compaction**：
作用在 transcript 上的视图状态：哪些段被摘要、省略，旧工具结果清到哪。transcript 本身不动，送模前投影。
_Avoid_：截断、清历史

**工作集**：
本轮摆给模型的那部分工具或 skill；池是注册进来的全部。
_Avoid_：菜单（口语可用）

**延迟工具**：
在池里但不上菜单、模型经 `tool_search` 取过 schema 才可调的工具。延迟是工具自己的标记。
_Avoid_：懒加载工具、隐藏工具

**skill**：
一份给模型的可激活知识或流程（`SKILL.md`），池与激活分开；激活后进本轮的工作集。与 agent 定义（角色）不同：skill 是会什么，角色是是谁。
_Avoid_：技能包、插件

**task**：
任务清单里的一条，带依赖边的 DAG 节点，由模型经 Task 工具增删改。不是 run，也不是 reply。
_Avoid_：任务（口语指 run 时别用这个词）、job

## 扩展

**extension**：
经 `defineExtension()` 声明、由 ExtensionHost 装卸的一个单元。内建的 `echo:*`、产品自带的、`extensions/` 下用户写的、壳，全是。
_Avoid_：插件、plugin

**registry**：
extension 往 agent 里注册东西的口：工具、prompt 段、压缩阶段、hook、skill。
_Avoid_：注册表（可用作译名，代码用 registry）

**能力端口**：
extension 用 agent 已有东西的口：后台队列、会话面、观测发口。
_Avoid_：service（那是 ABI 里的泛称）

**代**：
一批一起装、一起卸、全有或全无的 extension。
_Avoid_：批次、generation（代码里用它，文档用「代」）

**builtin**：
从内置模块表解析、进 ExtensionHost 后与第三方同等对待的 `echo:*` extension。它只出缺省内容；能力的机制与状态在 core。
_Avoid_：内置插件、特权扩展

**观测事实**：
运行期发进观测层、JSON-safe、按 run 归档的一条记录。extension 经能力端口发，core 自己的能力经内部 sink 发。
_Avoid_：日志、trace
