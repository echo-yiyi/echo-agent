# 「分区」改称记忆模块,走 registry 注册(内建的和第三方同一条),动词集按模块配置

> 状态:proposed · 提出 2026-09-07 · 拍板 2026-09-07(口头,实现后移入 implemented) · 与 [作用域由产品声明](2026-09-07-memory-scopes-by-product.md) 是同一次设计的两个轴

## 现状(拍板前)

**术语。** 今天叫「分区」([CONTEXT.md](../../../CONTEXT.md) 有词条),指"记的是什么"这一维——`agent.md` / `user.md` / 笔记及其索引。

**装配。** 内建三个是 [`createAgentMemories`](../../../packages/core/src/memory/harness.ts#symbol=createAgentMemories) 的默认值,`memories` 选项的注释写着"不传 = 内建三层;传了 = 完全接管,内建一个都不带"——这是**全有全无的开关,不是注册口**。`CustomMemories` 这个声明合并的扩展位存在,但没有任何注册路径,要让它生效得整体替换 `composeMemory` / `checkWrite` 两个分发函数。[docs/architecture.md](../../architecture.md) 那句"memory 的 registry 等第一个消费者"因此一直等着。

**动词。** 六动词(view / create / str_replace / insert / delete / rename)是**照抄 Anthropic memory tool 的命令面**(`memory/tool.ts` 开头写明判据是"别人训练好的行为能不能在我们这直接跑"),一把工具服务全部分区,任何分区都能收任何动词。

**语义。** `agentMemory` 的 instructions 是"your own stable knowledge — environment facts, project conventions, tool quirks, lessons learned",预算 2200 字符、全文常驻 system。

## 不拍板的代价

**扩展面。** 压缩那条线已经把这件事想明白并落地了:内建四阶段与第三方扩展走**同一条** `AgentCompaction.stage()`、同一份所有权账本,`compaction.builtin = false` 就不装(`compaction/builtin.ts` 开头)。memory 没跟上,于是"第一个消费者"一直等着——而内建那三个自己就是第一个消费者,只是它们走的是构造参数。产品想加一个自己的记忆模块(常驻产品的"对象档案"之类)今天没有路。

**动词。** `resident` 模块是一份固定路径的单文件,`rename` 对它没有意义;而 dream 现在要把放错模块的内容归位,归位又不许靠 rename 静默换预算域。这两件事今天都只能靠 prompt 里说一句,是纪律不是门。

**语义。** `agent.md` 那条 instructions 把"环境事实、项目约定"也划了进去——那是事实类记忆,一条常常 2–3 KB,塞进 2200 字符的全文常驻只会逼模型把有用的细节删掉。参照物:Claude Code 在本机这个项目下的 33 条记忆里,`type: feedback` 15 条、`type: project` 18 条,平均 2–3 KB,最大一条 17963 字节;`type: user` 一条都没有。

## 选项

- **A. 保持现状**,把内建三个的 instructions 调准就算了。
- **B. 加 registry,内建的挪进去走同一条**,与压缩同款。
- **C. 内建的挪给产品**,core 一个模块都不带。

## 决定

**B**(2026-09-07 用户拍板)。C 会让 `echo-agent`(它自己也是个产品)为了拿到默认模块先写一份 preset;而这三样按用户给的定义是通用的,不是哪个产品特有的。

### 术语:分区 → 记忆模块

「分区」这个词退役,统一叫**记忆模块**。改名跟着实现一次性做(枚举文件逐个过 diff,不全仓 `sed`),涉及 [CONTEXT.md](../../../CONTEXT.md) 词条、[会话与 agent 集群](../../design/sessions.md) §2、[记忆三级作用域](../implemented/2026-09-03-memory-three-scopes.md),以及 `memory/` 下的注释与错误文案。不留"新写的用新词、旧的不回填"的中间态——同一个概念两个词,正是词表存在的理由。

### 模块的形状

```ts
// 已有的三样,本条不改形状:tools/types.ts 的 AgentTool、extension 的 Disposer、
// harness 上那组唯一写路径的方法(create / strReplace / insert / delete / rename / view)
type AgentTool = unknown;
type Disposer = () => void;
type MemoryMethods = Readonly<Record<string, unknown>>;

type MemoryCommand = "view" | "create" | "str_replace" | "insert" | "delete" | "rename";

type MemoryModule = {
  name: string;
  mode: "resident" | "indexed";
  path: string;                       // 模块内位置,不带作用域前缀
  scopes: readonly string[];          // 引用产品声明的层名,对不上 → 注册时抛
  budget: number;                     // resident:全文上限;indexed:索引上限
  fileBudget?: number;                // indexed:单文件上限
  instructions: string;               // 拼进 system 的使用规则
  dream: boolean;                     // 归不归 dream 整理
  ops?: readonly MemoryCommand[];     // 支持的动词,不给则按 mode 取默认
  tools?: (m: MemoryMethods) => readonly AgentTool[];  // 自带工具
};

interface AgentMemoryRegistry {
  module(m: MemoryModule): Disposer;  // 撞名与路径重叠仍 fail-loud
}
```

### 动词集是模块配置的一部分

默认按 `mode` 取:

| mode | 默认动词 |
|---|---|
| `resident` | view / create / str_replace / insert / delete。**没有 rename**——它的路径是固定单文件,改名没有意义 |
| `indexed` | 六个全有 |

模块可以再收紧,不能放宽。**限制在工具里保证,不在 prompt 里说**:dream 要把一条记在 `agent.md` 里的事实挪进笔记,只能走"笔记里新建 → `str_replace` 从 `agent.md` 删掉那段"两步,因为 rename 在 resident 模块上压根不在它的工具面里。跨模块 / 跨层的 rename 仍然禁止(换预算域、换可见性都不许静默发生),这条不动。

### 模块可以自带工具,实现由模块作者写

自带的工具拿到的是 **harness 的方法**(`create` / `strReplace` / …),**拿不到 `dir`**。给 dir 就等于把唯一写路径拆成两条:预算校验、索引重建、观测事实、文件锁全会被绕过。这条与 `memory/tool.ts` 今天那句"上层写自己的工具,里面调 `memoryCreate()`"是同一个意思,只是从注释里的建议变成声明里的位置——谁拥有模块,谁拥有讲它怎么用的段和工具。

### 三个内建模块:保留,语义重写

| 模块 | mode | 装什么 | dream |
|---|---|---|---|
| `user.md` | resident | agent 对这个用户的认知 | true |
| `agent.md` | resident | agent 自己经常性的行为 | true |
| 笔记 | indexed | 事实类记忆,以及"东西在哪找" | true |

`agent.md` 收窄:环境事实、项目约定这类**事实**下放到笔记,它只留行为习惯。收窄之后 2200 字符重新够用——原来装不下,是因为 instructions 把事实类也划了进来。

**三个默认都 `dream: true`**(2026-09-07 用户拍板):agent 会把不属于某个模块的东西写进去,及时归位是 dream 的职责之一。这条推翻了本记录初稿里"resident 模块不该让后台 run 重写"的推荐——代价(dream 会改写 `agent.md` / `user.md`)记在 [dream 改造](2026-09-07-dream-rework.md) 的「不发明这条仍是纪律」一节。

内建这一组由 `echo:memory` builtin 经同一条 `module()` 注册,`memory.builtin === false` 就不装,与压缩内建阶梯同款。

## 验收

- 第三方 extension 经 `AgentMemory.module()` 注册一个模块,它出现在 `view ''` 的概览、system 的使用规则、以及写入路由里;disposer 卸载后下一个 run 就没有它。
- `memory.builtin === false` 时内建三个都不在,registry 与写入路径仍在。
- 对 `resident` 模块发 `rename` → 工具面里就没有这个动词(不是运行时拒),错误文案列出该模块支持的动词。
- 模块声明 `ops: ["view"]` → `create` 到它的路径被拒。
- 自带工具的模块:它的工具拿到的对象上没有 `read` / `write` / `list` / `remove`(拿不到 `dir`)。
- 全仓 grep 不到「分区」这个词(CONTEXT.md 词条、设计文档、代码注释、错误文案都换成「记忆模块」)。
