# 记忆的作用域由产品声明,core 不认识具体层名;按角色分层,session 层退场

> 状态:proposed · 提出 2026-09-07 · 拍板 2026-09-07(口头,实现后移入 implemented) · 替代 [记忆三级作用域](../implemented/2026-09-03-memory-three-scopes.md) 的作用域那一半(分区与作用域两个轴这条保留)

## 现状(拍板前)

[`MemoryScope`](../../../packages/core/src/memory/scope.ts#symbol=MemoryScope) 是闭合联合 `"user" | "project" | "session"`,`MEMORY_SCOPES` 定死顺序,`isMemoryScope()` 硬编码三个字符串,`memoryScopeDir()` 收一个恰好三键的 `Record`。三个根在 `createAgent` 的 `prepareCapabilities` 里接:user 是 `<ECHO_HOME>/memory/`,project 是 `<ECHO_HOME>/projects/<hash>/memory/`,session 是状态根的 `memory/`。`DREAM_SCOPE` 与 `DREAM_STATE_PATH` 也把 `"session"` 写死在常量里。

盘上的证据说明这套分法没被用起来:`~/.echo/memory/` 里只有 2026-09-04 一次冒烟测试留下的十个笔记,没有 `agent.md`、没有 `user.md`;`~/.echo/projects/` 目录不存在;五段真实 session 没有一段有 `memory/`。旧位置那份 dream 状态记着 `{"writes":3,"turns":320}`——自那次整理以来 320 轮对话,记忆写入 3 次,且全部发生在冒烟测试当天。

## 不拍板的代价

不同产品要的分层本来就不一样:coding 产品要 user / role / project,常驻产品(一个 HR agent 同时跟几十个对象聊)要产品级 / role,而它根本没有"这台机器的用户"这个概念。三层写死在 core 里,等于让内核认识具体产品的形态;每来一个新形态就往那个联合里加一个成员,而加进去的名字对别的产品全是死格子。

session 这一层同时是个已经证伪的设计:它没有跨层提升(明确的 Non-Goal),而 system prompt 又教模型"挑事实真正成立的最宽那层",两条合起来就是模型没有理由往那儿写。于是 dream 只整理它 = dream 没有整理对象——`minFiles` 那道门只数这一层,默认要攒 10 个笔记文件,真实会话里不会发生。

## 选项

- **A. 保持闭合三层。** 新形态来了就往联合里加成员。
- **B. 产品在装配期声明。** core 只定义"作用域"这个位置——一个有序的、各带一个根的命名集合;名字、前缀、有几层全由产品填。
- **C. extension registry。** 与 `AgentCompaction.stage()` 同款,运行期注册。

## 决定

**B**(2026-09-07 用户拍板)。C 第一步就卡住:作用域带着字节面,而 extension 是 mount 期注册进运行中的 Agent 的,它拿不到 `store` / `sharedStore`;而且作用域是**模型可见的路径契约**,运行中增删一层意味着 system 里那段选层说明会变、已写下的路径会失效,`reload:"turn"` 的语义在这里有害。

### 声明是纯数据,不是回调

```ts
export type MemoryAnchor =
  | { kind: "home" }                    // <ECHO_HOME>,缺省 ~/.echo
  | { kind: "workspace" }               // 这段 session 的 workspace
  | { kind: "agent" }                   // <ECHO_HOME>/agents/<角色名>/
  | { kind: "path"; path: string };     // 指定地址

export type MemoryScopeDef = Readonly<{
  name: string;      // 路径第一段,模型看见的就是它。core 不认识具体取值
  order: number;     // 注入顺序,同时是宽度序(小 = 宽)
  describe: string;  // 给模型的一句话:这一层谁看得见
  anchor: MemoryAnchor;
  prefix: string;    // 锚点下的相对前缀,支持 {{}} 变量
  stamp?: boolean;   // 见「留痕与撞车校验」
}>;
```

**不收 `open: (ctx) => StorageDir` 这种回调**:`memory/types.ts` 开头写着「Memory 可 JSON 序列化,能直接写进配置文件——它是配置,不是对象机器」,交函数正好破坏这条。声明式还让作用域能和角色定义一样写进 markdown frontmatter。

**锚点闭合、变量闭合、名字开放**:core 只认这几个起点(`home` / `workspace` / `agent` / `path`)和一组变量(`{{workspaceHash}}` / `{{workspace}}` / `{{product}}` / `{{sessionId}}`),名字与前缀是产品的。`{{role}}` 变量不设——它和 `agent` 锚点是同一件事的两种写法,留两种就是一个概念两个真源。

三种产品各自的写法:通用 `echo-agent` 给 `{home,"memory/"}` 与 `{home,"projects/{{workspaceHash}}/memory/"}`;coding 再加 `{agent,"memory/"}`;常驻产品给 `{home,"products/{{product}}/memory/"}` 加角色那条。**core 里从此不出现 "user" / "project" 这两个字面量。**

### 解析时机:session 加载完,一次,之后不变

今天是"装配期先按当时已知的 workspace 指着,`start()` 里 [`projectScopeBinding`](../../../packages/core/src/memory/scope.ts#symbol=projectScopeBinding) 重指一次"。改成:**装配期不解析**,给 harness 的是一个还没绑定的字节面(绑定前任何读写直接抛,与写入闸同一条 fail-closed);等 `start()` 里 `createOrResume` 返回、workspace / 角色 / 产品都是盘上权威值,才第一次解析,之后不变。

这一改消掉三样东西:**「重指」这个概念**(从"先指错再改"变成"先不指,加载完才指");**`setWorkspace()` 故意不跟这条纪律**(运行期不再有解析入口,想跟也跟不了,从纪律变成结构事实);**装配期那次 [`assertProjectWorkspace()`](../../../packages/core/src/memory/scope.ts#symbol=assertProjectWorkspace)**(它存在的理由是"早点判红比晚点好",只有一个解析点时早晚之分不成立)。

### 留痕与撞车校验:显式声明,不按变量推断

`stamp: true` 才挂 `workspace.json` 留痕 + 打开时对一遍。**不做成"看见 `{{workspaceHash}}` 就自动挂"**:那是隐式的——产品写了个前缀,core 悄悄往它目录里塞一个文件,启动时还会因为对不上判红,不读源码不会知道。只有"把长路径缩成短哈希"的前缀才有撞车风险,`{{product}}` 这种原样拼进去的不会撞。留痕仍归 [`withWorkspaceStamp`](../../../packages/core/src/memory/scope.ts#symbol=withWorkspaceStamp) 的"第一次真写时才落"。

### core 的默认:user + project + role

角色定义 2026-09-07 已落地(`agent-def/`,来源三处按优先级合并),所以 role 层不再是"默认一个还不存在的东西"。`echo-agent` 与 `echo-coding` 都要这一层,放默认里省得每个产品各写一遍、各错各的。

**角色记忆的家是 `<ECHO_HOME>/agents/<name>/memory/`**——和角色定义同一棵树(`AGENT_DEF_DIR = "agents"`),定义和记忆不分家。2026-09-01 那版状态根残留的 `agents/default/` 已在本次一并移走(它有 17 MB、5 段读不到的旧会话,当前代码没有任何一处读它)。

**`AgentRef.name` 可选,没有名字就没有 role 层**:`DEFAULT_AGENT_REF` 没有 name,容器自己开的段、`--continue` 的老会话、`session_create` 现写的 inline 定义都可能没有。这些 session 的记忆只落 user / project 两层。不退化到固定名 `default`(那实际上是第二个 user 层),也不按 definition 内容哈希(改一个字就换目录,记忆当场失联)。没有身份,就没有身份记忆。

### 记忆模块引用层名:注册时 fail-loud

模块声明 `scopes: ["project"]` 而当前产品没有 project 层 → 注册当场抛,与 [`addMemory`](../../../packages/core/src/memory/harness.ts#symbol=addMemory) 今天对撞名与路径重叠的处理同一条。不做"语义标签由产品映射":那会引入第二套词表,模型看见的路径仍是产品的名字,同一个概念两个名字要对照。

### 模型怎么知道该往哪层写

core 不认识层名,但拼得出那段说明:按 `order` 升序列出每层的 `name` 与 `describe`,再加一句"挑这条事实真正成立的最宽那层"。`order` 同时是注入顺序与宽度序,不多一个概念。

## 连带推翻

- **session 作用域退场**。[记忆三级作用域](../implemented/2026-09-03-memory-three-scopes.md) 里"session 层只放笔记、dream 只整理它"那一段作废,理由见「不拍板的代价」。dream 的计数与锁改为按层各一份,落在各层目录下(见 [dream 改造](2026-09-07-dream-rework.md))。
- **「agent 自动写的东西不该进 git」从设计约束降级成默认产品的选择**([会话与 agent 集群](../../design/sessions.md) §2 那句)。作用域由产品声明之后 core 不再有立场:产品想把某层记忆放进仓库,声明 `{anchor:"workspace", prefix:".echo/memory/"}` 即可。`echo-agent` / `echo-coding` 的默认仍然不进 git。

## 验收

- core 的 `packages/core/src/memory/` 下 grep 不到 `"user"` / `"project"` / `"session"` 这三个层名字面量(常量、类型、错误文案都算)。
- 产品声明两层、模块声明 `scopes: ["role"]` → 注册抛,错误文案列出当前可用的层名。
- `--resume` 一段在别的 workspace 建的会话:`start()` 之后往 project 层写的东西落在**盘上那个** workspace 的哈希目录下,装配期那个目录一个字节都没有;同一段里再 `setWorkspace()` 到第三个目录,project 层不动。
- 装配之后、`start()` 之前对记忆字节面的任何读写都抛(未绑定),错误文案说明它要等 session 加载。
- `stamp: false` 的层:目录里不出现 `workspace.json`,换个 workspace 指向同一目录也不判红。
- 没有 `AgentRef.name` 的 session:`view ''` 列不出 role 层,往 `agents/.../` 写判红。
- 同一 run 的 system prompt 里,层的顺序恒等于 `order` 升序;每层各出一行 `name` + `describe`。
