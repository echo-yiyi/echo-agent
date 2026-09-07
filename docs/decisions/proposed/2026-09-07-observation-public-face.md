# 观测的公开线：读面与 extension 的发口公开，写面内部；观测 store 可注入

> 状态:proposed · 提出 2026-09-07 · 拍板 2026-09-07(口头,实现后移入 implemented) · 来源 2026-09-07 架构 review

## 现状(拍板前)

`observability/` 6,195 行,是 core 最大的模块;`observability/types.ts` 650 行经 `@echo-agent/core/observability` 子路径整份公开,唯一仓外消费者是 cli 的 `observe` 子命令。两半混在一个子路径里:**读面**(`RunObservation` 一族、reader、`renderRunObservation`)与**写面**(envelope、draft、sequencer、ingest、sink、identity、限额)。

观测 store 无条件在状态根开 SQLite(`packages/core/src/create-agent.ts` 里 `SqliteCanonicalObservationStore.open`,注释写明「固定在状态根下,与自定义 store 无关」),于是传了 `InMemoryDir` 的调用方仍会往真盘写观测库——正是 `sharedStore` 那条注释自己反对的事;也因此 `createEcho()` 没有零盘路径。

## 不拍板的代价

一个 650 行的类型面在没有第二个消费者之前就冻结,是拿未来换不到任何东西的承诺;但全收成内部又做不到——`Echo.observations` 与 `openObservationReader()` 的返回类型躲不掉。线不画清,API 快照就只能整份锁。

## 选项

- **A. 整个子路径公开,现在冻结。**
- **B. 按「extension 作者要什么」划线。** 公开 = 读面 + 一个让 extension 发观测事实的能力端口 + JSON-safe 值类型;内部 = sequencer、store、identity、限额、draft。子路径撤掉,读面放根入口。
- **C. 公开但标 experimental。**

## 决定

**B**(2026-09-07 用户拍板:「公开是为了当其他产品扩展 extension 的时候,可以对 extension 里面的东西进行观测」)。三条:

1. **发口**是一个能力端口,与 `AgentBackgroundService` 同款(`kind: "single"`):

   ```ts
   type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

   interface AgentObservation {
     /** 同步、不抛,与内部 sink 同一条契约;记录自动带本 extension 的 entryId 与当前 run。 */
     offer(fact: { name: string; body: JsonValue }): void;
   }
   ```

   读回来在 `RunObservation` 里按 `name` 可见。公开的类型 = 这个端口 + JSON-safe 值 + 读面。
2. **写面内部**:sequencer、store 接口与实现、identity、限额、draft 收进 core;`ObservationSubscribeOptions` 的双声明(`observability/types.ts` 与 `sequencer.ts` 各一份、字段不同)与三份错误形状在内部收敛,不经公共面重录。`./observability` 子路径撤,cli 改从根入口拿 `renderRunObservation`。
3. **观测 store 可注入**,和 `store` / `lock` / `sharedStore` 同一类端口:

   ```ts
   import type { ObservationCapturePolicy } from "@echo-agent/core";
   declare class CanonicalObservationStore {}

   type CreateAgentObservationOption = {
     observation?: {
       capture?: ObservationCapturePolicy;
       store?: CanonicalObservationStore; // 给了就用它
     };
   };
   ```

   缺省照 `sharedStore` 的先例:没给自定义 `store` → SQLite 在状态根下(今天的行为);给了自定义 `store` 却没给观测 store → 内存实现(`InMemoryCanonicalObservationStore`),**不碰真盘**。`Echo.send()` 回的 `observationPersistence` 报的是所给 store 的结果,不再暗含「一定落盘」。SQLite 作为缺省保留(2026-09-01 拍板不翻)。

## 验收

`package.json#exports` 里没有 `./observability`;API 快照里观测相关符号只剩读面、`AgentObservation` 端口与 JSON-safe 值类型;`createEcho({ store: new InMemoryDir(), lock: new InMemoryStateLock() })` 不在磁盘上留下任何文件;一条第三方 extension 经 `AgentObservation.offer()` 发的事实在 `openObservationReader().getRun()` 里按 name 读得到。
