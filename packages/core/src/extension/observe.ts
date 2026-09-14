// ExtensionHost 的观测探针：一代 extension 装上 / 没装上 / 卸下 / 卸载被拒，在 Host 的串行事务链上当场记。
//
// **观测是插桩，不是事件协议**（docs/design/observability.md）：这里不是给壳的通知，是事后复盘时回答
// 「这次 run 背后装了哪些 extension、谁依赖谁、谁提供了什么、哪个没装上、为什么」。
//
// 按**代**记，不按 Fiber 记：装载是全有或全无的事务，一代就是事实的自然单位；Fiber 的 7 态转换是内部过程，
// 只在失败时有意义，而失败那条已经带上了是哪个 Entry、在哪个阶段。
//
// 纯 Web-standard（不碰 `node:`）。

import type { ExtensionScope, ReloadBoundary } from "./abi.ts";
import type { CapabilityFactDescriptor, CapabilityFactSink, ObservationFactProjection } from "../observability/fact-sink.ts";
import type { ObservationCapturePolicy } from "../observability/types.ts";

export const EXTENSION_INSTRUMENTATION = { name: "echo.extension", version: "1" } as const;

/** 一个装上的 extension。全是 id 与声明，不含 config 正文。 */
export type ExtensionFiberFact = Readonly<{
  entryId: string;
  name: string;
  scope: ExtensionScope;
  reload: ReloadBoundary;
  /** 装上时登记的 Effect 数。 */
  effects: number;
  /** 它 inject 的服务：是否 required，实际由谁提供（另一个 Entry 的 id / `host` / 没人提供时 null）。 */
  injects: readonly Readonly<{ service: string; required: boolean; provider: string | null }>[];
  /** 它 provide 的服务 id。 */
  provides: readonly string[];
}>;

export type ExtensionFactBody =
  | { kind: "generation_mounted"; generation: string; fibers: readonly ExtensionFiberFact[] }
  /**
   * 这一代没装上，已全部回滚。`stage`：`prepare` = 还没加载任何 Entry 就被拒（重复 / ABI / config / 依赖图）；
   * `apply` = 某个 Entry 的 apply 或 Effect start 失败，已 ACTIVE 的按逆序卸掉。
   */
  | { kind: "generation_mount_failed"; generation: string; entryIds: readonly string[]; stage: "prepare" | "apply"; failedEntryId?: string; error: unknown; unwindErrors: number }
  | { kind: "generation_unmounted"; generation: string; entryIds: readonly string[]; cleanupErrors: number }
  /** 别的代还有 consumer 绑在这一代的 provider 上，卸载被拒，这一代原样留着。 */
  | { kind: "generation_unmount_refused"; generation: string; entryIds: readonly string[]; error: unknown };

export type ExtensionFact = ExtensionFactBody & Readonly<{ at: number }>;

export type ExtensionProbe = CapabilityFactSink<ExtensionFact>;

/** 节点上调它：补发生时刻，交给探针。没给探针就什么都不做。 */
export function probeExtension(sink: ExtensionProbe | undefined, fact: ExtensionFactBody): void {
  sink?.offer({ ...fact, at: Date.now() } as ExtensionFact);
}

/** 错误的名字是低风险的标识（`TypeError` / `ExtensionAbiError`），metadata 档就记；消息可能带路径，只在 content 档记。 */
function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function projectExtensionFact(fact: ExtensionFact, policy: ObservationCapturePolicy): ObservationFactProjection | null {
  if (policy === "off") return null;
  const base = { occurredAt: fact.at } as const;
  const content = policy === "content";
  switch (fact.kind) {
    case "generation_mounted":
      return {
        ...base,
        kind: "event",
        name: "extension.generation.mounted",
        scope: {},
        attributes: { generation: fact.generation, fibers: fact.fibers.length },
        body: { generation: fact.generation, fibers: fact.fibers.map((f) => ({ ...f, injects: f.injects.map((i) => ({ ...i })), provides: [...f.provides] })) },
      };
    case "generation_mount_failed": {
      const attrs: Record<string, string | number> = { generation: fact.generation, stage: fact.stage, errorName: errorName(fact.error) };
      if (fact.failedEntryId !== undefined) attrs.failedEntryId = fact.failedEntryId;
      const body: Record<string, unknown> = { ...attrs, entryIds: [...fact.entryIds], unwindErrors: fact.unwindErrors };
      if (content) body.errorMessage = errorMessage(fact.error);
      return { ...base, kind: "event", name: "extension.generation.mount_failed", scope: {}, attributes: attrs, body };
    }
    case "generation_unmounted":
      return {
        ...base,
        kind: "event",
        name: "extension.generation.unmounted",
        scope: {},
        attributes: { generation: fact.generation, cleanupErrors: fact.cleanupErrors },
        body: { generation: fact.generation, entryIds: [...fact.entryIds], cleanupErrors: fact.cleanupErrors },
      };
    case "generation_unmount_refused": {
      const attrs = { generation: fact.generation, errorName: errorName(fact.error) };
      const body: Record<string, unknown> = { ...attrs, entryIds: [...fact.entryIds] };
      if (content) body.errorMessage = errorMessage(fact.error);
      return { ...base, kind: "event", name: "extension.generation.unmount_refused", scope: {}, attributes: attrs, body };
    }
  }
}

export const extensionFactDescriptor: CapabilityFactDescriptor<ExtensionFact> = {
  instrumentation: EXTENSION_INSTRUMENTATION,
  project: projectExtensionFact,
};
