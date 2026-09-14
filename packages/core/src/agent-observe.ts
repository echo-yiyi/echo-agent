// Agent 自身的观测探针：不属于循环、也不属于某个能力模块，而是 Agent 这个实例上发生的事——
// 生命周期相位变了、队列长度变了、资源（工具 / skill …）装上或卸下了。在 `agent.ts` 的执行节点上记。
//
// 相位是 Agent **自己**做的状态迁移（start / pause / stop / 丢锁善后），不是观测推断出来的进程死活：
// 丢锁那一拍也在这里当场记下（`setPhase("lost")`），与其余相位同一个节点、同一种事实。
//
// 与 `loop/observe.ts` 同一条规矩：**观测是插桩，不是事件协议**——不转发 `queue_update / resource_changed`
// 这两个给壳的事件，节点上与 emit 并列调探针。
//
// 纯 Web-standard（不碰 `node:`）。

import type { AgentLifecyclePhase, RestoredReason } from "./agent.ts";
import type { ResourceChange } from "./events.ts";
import type { CapabilityFactDescriptor, CapabilityFactSink, ObservationFactProjection } from "./observability/fact-sink.ts";
import { materializeObservableState } from "./observability/terminal.ts";
import type { EchoObservableState, ObservationCapturePolicy } from "./observability/types.ts";

export const AGENT_INSTRUMENTATION = { name: "echo.agent", version: "1" } as const;

export type AgentFactBody =
  /**
   * 生命周期相位迁移。进 `restored` 时带上是哪一种 restored（启动恢复完 / handoff 暂停完）。
   * 账本里不会出现 `→ stopped`：写入端在 stop 流程里先关了，见 `Agent.setPhase`。
   */
  | { kind: "phase_changed"; from: AgentLifecyclePhase; to: AgentLifecyclePhase; restoredReason?: RestoredReason }
  /**
   * 装备换了（只能在 idle 时换，setter 先守 idle）：模型记 `provider/id`，思考档记档名。工具的增删走 `resource_changed`。
   * `LifecycleEvent` 里声明过一个 `equipmentChanged`，但全仓没有任何地方发它——这里是观测自己的节点，不依赖它。
   */
  | { kind: "equipment_changed"; field: "model" | "thinkingLevel"; from: string; to: string }
  /**
   * run 开头的整体状态，与 `run.closed` 里的 finalSnapshot **同形、同一个校验器**（`terminal.ts#materializeObservableState`），
   * 两份一比就知道这个 run 改了什么。结尾那份不从这里发——它是 run.closed 这条边界的一部分，唯一 owner 在 ObservationRuntime。
   */
  | { kind: "state_snapshot"; moment: "run_started"; state: EchoObservableState }
  | { kind: "queue_updated"; queue: "steering" | "followUp" | "inbox"; size: number }
  /** `ResourceChange` 自带一个 `kind`（tool / skill / mcp …），与本联合的判别字段同名，所以整个嵌进 `change`。 */
  | { kind: "resource_changed"; change: ResourceChange };

export type AgentFact = AgentFactBody & Readonly<{ at: number }>;

export type AgentProbe = CapabilityFactSink<AgentFact>;

/** 节点上调它：补发生时刻，交给探针。没给探针就什么都不做。 */
export function probeAgent(sink: AgentProbe | undefined, fact: AgentFactBody): void {
  sink?.offer({ ...fact, at: Date.now() } as AgentFact);
}

export function projectAgentFact(fact: AgentFact, policy: ObservationCapturePolicy): ObservationFactProjection | null {
  if (policy === "off") return null;
  const base = { occurredAt: fact.at } as const;
  switch (fact.kind) {
    case "phase_changed": {
      const attrs: Record<string, string> = { from: fact.from, to: fact.to };
      if (fact.restoredReason !== undefined) attrs.restoredReason = fact.restoredReason;
      return { ...base, kind: "event", name: "agent.phase.changed", scope: {}, attributes: attrs, body: { ...attrs } };
    }
    case "state_snapshot": {
      // 物化不合法会抛：fact-sink 把投影抛错变成 hole + gap，不会静默丢
      const state = materializeObservableState(fact.state);
      return {
        ...base,
        kind: "snapshot",
        name: "agent.state",
        scope: {},
        attributes: { moment: fact.moment, capabilities: state.capabilities.length },
        body: { moment: fact.moment, state },
      };
    }
    case "equipment_changed": {
      const attrs = { field: fact.field, from: fact.from, to: fact.to };
      return { ...base, kind: "event", name: "agent.equipment.changed", scope: {}, attributes: attrs, body: { ...attrs } };
    }
    case "queue_updated":
      return { ...base, kind: "event", name: "agent.queue.updated", scope: {}, attributes: { queue: fact.queue }, body: { queue: fact.queue, size: fact.size } };
    case "resource_changed":
      return {
        ...base,
        kind: "event",
        name: "agent.resource.changed",
        scope: {},
        attributes: { kind: fact.change.kind, action: fact.change.action, source: fact.change.source },
        body: { kind: fact.change.kind, action: fact.change.action, name: fact.change.name, source: fact.change.source },
      };
  }
}

export const agentFactDescriptor: CapabilityFactDescriptor<AgentFact> = {
  instrumentation: AGENT_INSTRUMENTATION,
  project: projectAgentFact,
};
