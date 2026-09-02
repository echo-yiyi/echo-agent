// 测试替身。**不在生产面上**——走 `@echo-agent/core/testing` 子路径。
//
// 有了 Dialect 工厂，假后端就是「一个不发网络请求的方言」：它跟真方言过同一个外壳
// （累积 / 重试 / 抢救 / 流包装），所以测的是真路径，不是另一条平行实现。

import { createProviderStreams, type Dialect } from "./provider/dialect.ts";
import type { ProviderEvent } from "./events.ts";
import type { Context } from "./messages.ts";
import type { Model, ProviderStreams, StreamFn, StreamOptions } from "./provider/types.ts";


export type ScriptedTurn = ProviderEvent[];

/**
 * 脚本化方言：按轮吐事先写好的事件序列。同样输入 → 同样事件序列，
 * 这就是确定性回归的立足点。
 */
export function scriptedDialect(turns: ScriptedTurn[], api = "fake"): Dialect {
  let turnIndex = 0;
  return {
    api,
    async *request(): AsyncGenerator<ProviderEvent> {
      const turn = turns[turnIndex++];
      if (turn === undefined) {
        yield {
          type: "error",
          error: { source: "provider", code: "protocol", retryable: false, message: `脚本用尽（第 ${turnIndex} 轮）` },
        };
        return;
      }
      for (const ev of turn) yield structuredClone(ev); // 防脚本被消费方改写
    },
  };
}

export function scriptedStreams(turns: ScriptedTurn[]): ProviderStreams {
  return createProviderStreams(scriptedDialect(turns));
}

export function scriptedStreamFn(turns: ScriptedTurn[]): StreamFn {
  const streams = scriptedStreams(turns);
  return (model: Model, context: Context, options?: StreamOptions) => streams.stream(model, context, options);
}

export const FAKE_MODEL: Model = {
  provider: "fake",
  id: "fake-1",
  api: "fake",
  capabilities: { contextWindow: 100_000 },
};

/* ── 造事件序列的小助手，让测试读起来像剧本 ── */

export function textTurn(text: string, stopReason: "end_turn" | "max_tokens" = "end_turn"): ScriptedTurn {
  return [
    { type: "start" },
    { type: "text_start" },
    { type: "text_delta", text },
    { type: "text_end" },
    {
      type: "done",
      message: { role: "assistant", content: [{ type: "text", text }], stopReason, usage: null },
    },
  ];
}

export function toolTurn(toolCallId: string, name: string, input: Record<string, unknown>): ScriptedTurn {
  return [
    { type: "start" },
    { type: "toolcall_start", toolCallId, name },
    { type: "toolcall_delta", argsText: JSON.stringify(input) },
    { type: "toolcall_end" },
    {
      type: "done",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: toolCallId, name, input }],
        stopReason: "tool_use",
        usage: null,
      },
    },
  ];
}

/** 只发 done 的退化后端（CLI 那类无流式的）——用来验「补发 start」的不变量。 */
export function bareDoneTurn(text: string): ScriptedTurn {
  return [
    {
      type: "done",
      message: { role: "assistant", content: [{ type: "text", text }], stopReason: "end_turn", usage: null },
    },
  ];
}

export function errorTurn(code: string, message: string, retryable: boolean): ScriptedTurn {
  return [
    { type: "start" },
    {
      type: "error",
      error: { source: "provider", code: code as never, retryable, message },
    },
  ];
}

// §14.2.4：durable ingress 的答复口径。standalone `Agent.ingress` 与 O3 的 Runtime/AgentHandle stable ingress
// 跑同一 suite——第二个实现最容易跑偏的正是口径（拒绝用不用 rejection、去重回不回原 recordId）。
export {
  runDedupeKeyProducerConformance,
  runDurableIngressConformance,
  type DedupeKeyProducerUnderTest,
  type DurableIngressControls,
  type DurableIngressUnderTest,
} from "./inbox/testing.ts";

// §14.2.4：admission 的 fake 与共享 conformance——StandaloneRunAdmission 与将来完整 Runtime 的 admission 都跑同一 suite。
export {
  createFakeAgentAdmission,
  runAgentAdmissionConformance,
  runModelSnapshotConformance,
  type AdmissionUnderTest,
  type FakeAgentAdmission,
  type FakePendingRequest,
  type ModelSnapshotUnderTest,
} from "./admission/testing.ts";
