// 懒桥：让「异步准备」不改同步签名。设计见 docs/design/AGENT-CORE.md §8.2 实现约束①。
//
// 为什么需要它：`stream()` 必须**同步返回**流对象——否则消费方要多一层 await，
// 而且事件会被憋到准备完成才开始流，逐字流式当场作废。lazyStream 立刻还你一个空流，
// 准备好之后把真流的条目接进来。
//
// 两个用途：① 鉴权/建连这类异步准备；② 懒加载重适配器（lazyApi）。

import { AssistantMessageEventStream, emptyAssistant, withPartial } from "../event-stream.ts";
import { classifyUnknown } from "../errors.ts";
import type { StreamItem } from "../events.ts";
import type { Context } from "../messages.ts";
import type { Model, ProviderStreams, StreamOptions } from "./types.ts";

export function lazyStream(
  prepare: () => Promise<AsyncIterable<StreamItem>>,
): AssistantMessageEventStream {
  const out = new AssistantMessageEventStream();
  // 生产挂后台：立刻返回流对象，边产边吐。
  void (async () => {
    try {
      for await (const item of await prepare()) out.push(item);
    } catch (e) {
      // 预期失败早该被编码成 error 事件；走到这 = 违约或 bug。
      // **仍不上抛**：编码成 error 条目推进流，保「恰好一个终结」对调用方永远成立。
      out.push(withPartial({ type: "error", error: classifyUnknown(e) }, emptyAssistant()));
    }
  })();
  return out;
}

/** 懒加载一个方言实现：注册时不加载，第一次真调才 import。 */
export function lazyApi(load: () => Promise<ProviderStreams>): ProviderStreams {
  return {
    stream: (model: Model, context: Context, options?: StreamOptions) =>
      lazyStream(async () => (await load()).stream(model, context, options)),
  };
}
