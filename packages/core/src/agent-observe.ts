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
import type { ObservationCapturePolicy } from "./observability/types.ts";

export const AGENT_INSTRUMENTATION = { name: "echo.agent", version: "1" } as const;

export type AgentFactBody =
  /**
   * 生命周期相位迁移。进 `restored` 时带上是哪一种 restored（启动恢复完 / handoff 暂停完）。
   * 账本里不会出现 `→ stopped`：写入端在 stop 流程里先关了，见 `Agent.setPhase`。
   */
  | { kind: "phase_changed"; from: AgentLifecyclePhase; to: AgentLifecyclePhase; restoredReason?: RestoredReason }
  /**
   * 装备换了（只能在 idle 时换，setter 先守 idle）：模型记 `provider/id`，思考档记档名。
   * 与事件协议的 `equipment_changed` 同一个节点、各记各的——观测是插桩，不订阅事件。
   */
  | { kind: "equipment_changed"; field: "model" | "thinkingLevel"; from: string; to: string }
  | { kind: "queue_updated"; queue: "steering" | "followUp" | "inbox"; size: number }
  /**
   * 一条输入的终态之外的两拍（2026-11-05，docs/decisions/implemented/2026-11-05-input-lifecycle.md）。每条收下的输入恰好落在三处之一：
   * **进 transcript**（`agent.message.appended` 带 inputId，引出的那一轮的 `turn_started.inputs` 里有它）、
   * **交还**（`input_returned`：run 收尾时还在队列里，正文交回给壳）、**被拦下**（`input_blocked`：userPromptSubmit hook 说不）。
   * `input_accepted` 只给排队的两种（steer / followUp）：prompt 的输入当场就进 transcript。`turnId` 是收下时开着的那个 turn。
   */
  | { kind: "input_accepted"; inputId: string; channel: "steer" | "followUp"; runId: string; turnId?: string }
  | { kind: "input_returned"; inputId?: string; channel: "steer" | "followUp"; reason: string }
  | { kind: "input_blocked"; inputId?: string; channel: "human" | "steer" | "followUp" }
  /**
   * 这个 run 的 system prompt 是怎么拼成的（2026-11-08，观测白盒化 §3.2）：每一段的名字、order、谁注册的、
   * 渲染出来有字 / 空 / 抛错、进 system 的字符数，插值用到的变量名，拼起来的总长。每个 run 组装一次就记一次。
   * 段名、注册者、字符数都是标识与计数，metadata 档就记；正文在 content 档（正文存储，§4）。
   */
  | { kind: "prompt_assembled"; sections: readonly PromptSectionStat[]; variables: readonly string[]; chars: number }
  /** `ResourceChange` 自带一个 `kind`（tool / skill / mcp …），与本联合的判别字段同名，所以整个嵌进 `change`。 */
  | { kind: "resource_changed"; change: ResourceChange };

/** `prompt.assembled` 里的一段。`owner`：注册它的 extension entryId（不经 Fiber 直接塞进表的段没有）。 */
export type PromptSectionStat = Readonly<{ name: string; order: number; owner: string | null; status: "rendered" | "empty" | "failed"; chars: number }>;

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
    case "equipment_changed": {
      const attrs = { field: fact.field, from: fact.from, to: fact.to };
      return { ...base, kind: "event", name: "agent.equipment.changed", scope: {}, attributes: attrs, body: { ...attrs } };
    }
    case "queue_updated":
      return { ...base, kind: "event", name: "agent.queue.updated", scope: {}, attributes: { queue: fact.queue }, body: { queue: fact.queue, size: fact.size } };
    // 输入的身份与去向都是标识，metadata 档就记；正文不在这里（进了 transcript 的看 agent.message.appended）
    case "input_accepted": {
      const attrs: Record<string, string> = { inputId: fact.inputId, channel: fact.channel, runId: fact.runId };
      if (fact.turnId !== undefined) attrs.turnId = fact.turnId;
      return { ...base, kind: "event", name: "agent.input.accepted", scope: {}, attributes: attrs, body: { ...attrs } };
    }
    case "input_returned": {
      const attrs: Record<string, string> = { channel: fact.channel, reason: fact.reason };
      if (fact.inputId !== undefined) attrs.inputId = fact.inputId;
      return { ...base, kind: "event", name: "agent.input.returned", scope: {}, attributes: attrs, body: { ...attrs } };
    }
    case "input_blocked": {
      const attrs: Record<string, string> = { channel: fact.channel };
      if (fact.inputId !== undefined) attrs.inputId = fact.inputId;
      return { ...base, kind: "event", name: "agent.input.blocked", scope: {}, attributes: attrs, body: { ...attrs } };
    }
    case "prompt_assembled": {
      const failed = fact.sections.filter((s) => s.status === "failed").length;
      const attributes = { sections: fact.sections.length, chars: fact.chars, failed };
      return {
        ...base,
        kind: "event",
        name: "prompt.assembled",
        scope: {},
        attributes,
        body: { sections: fact.sections.map((s) => ({ ...s })), variables: [...fact.variables], chars: fact.chars },
      };
    }
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
