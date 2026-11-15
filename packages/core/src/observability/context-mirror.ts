// 上下文镜像的主线程这一半（观测白盒化 §2.2，docs/decisions/proposed/2026-11-03-observation-white-box.md，2026-11-08 拍板）。
//
// 观测要知道「每次调模型送进去的是什么」，但**主线程不许做与上下文总长成正比的事**（观测不进主循环的硬规矩）：
// 不哈希、不估 token、不序列化、不每次交整份上下文。做法：给每个对象发一个本进程内的编号（WeakMap，O(1)），
// **同一个对象一辈子只交一次值**，之后只交编号；观测线程按编号维护一份镜像（`context-mirror-host.ts`），
// 在那边重建视图、估 token、写正文。
//
// 两个编号空间，为的是 transcript 的编号连续、能压成几段：
//   · 消息（AgentMessage）用正数：transcript 只增，消息按出现顺序拿号，一整段 transcript 通常就是一两段连续编号；
//   · 其余（压缩状态、工具、system 串、每轮注入）用负数：它们每轮都可能是新对象，混进消息的编号会把连续段打碎。
//
// 每次交出去的：几十个编号 + 本次第一次见到的对象。transcript 按「同一个数组只增」增量编码——同一个 run 里的数组
// 每个 attempt 只看新增的那几条；换了数组（新的 run）才完整走一遍（O(条数) 次 WeakMap 查找，不碰内容）。
//
// **用完就丢的两样**（2026-11-13）：镜像里的值只增不删的话，观测线程的内存随模型调用次数一直涨。
//   · 每轮注入：每次调模型都是新造的对象，「只交一次」对它从来不成立。所以不给它记编号——每次现发一个只在
//     这次交接里有效的编号，观测线程用完当场删；
//   · system：这里只记最近的一份，换了就在 `drop` 里报出被换掉的那个编号，观测线程处理完这次交接就删。

import type { CompactionState } from "../compaction/types.ts";
import type { AgentMessage } from "../messages.ts";
import { isModelVisible, toolSchemas, type AgentTool } from "../tools/types.ts";

/** 镜像里的编号：消息为正，其余为负。 */
export type MirrorRef = number;
/** 连续编号的压缩写法：`[起始编号, 条数]`。 */
export type MirrorRuns = readonly (readonly [MirrorRef, number])[];
/** 本次第一次见到的对象：编号 → 值（工具交的是它的 schema，不是带函数的对象本身）。 */
export type MirrorFresh = readonly Readonly<{ ref: MirrorRef; value: unknown }>[];

/**
 * 一次模型调用的上下文在主线程交出去的样子。视图两种写法：
 *   · `rebuild`：没被 hook 改过——观测线程用同一个 `buildWorkingMessages` 从 transcript + 压缩状态重建，再接上注入；
 *   · `explicit`：被 `transformContext` / `contextBeforeBuild` 改过、或压缩阶段自己拼的——按顺序给出每条消息的编号。
 */
export type ContextHandoff = Readonly<{
  system: Readonly<{ ref: MirrorRef; chars: number }> | null;
  view:
    | Readonly<{ kind: "rebuild"; transcript: MirrorRuns; compaction: MirrorRef; injections: readonly MirrorRef[] }>
    | Readonly<{ kind: "explicit"; messages: MirrorRuns }>;
  /** 实际菜单（`isModelVisible` 之后），按顺序。 */
  tools: readonly MirrorRef[];
  fresh: MirrorFresh;
  /**
   * 主线程从此不会再提起的编号（被换掉的那份 system）：观测线程处理完这次交接就把它们的值删掉。
   * `view.injections` 里的编号不必列在这里——它们只在这一次交接里有效，观测线程用完当场删。
   */
  drop?: readonly MirrorRef[];
}>;

/** 工具交给观测线程的样子：就是送模的那份 schema（`toolSchemas`，同一个函数），不带函数。 */
function toolSchemaOf(t: AgentTool): unknown {
  return toolSchemas([t])[0];
}

/** 主线程的那一半：每个观测 runtime 一份（`Agent` 解析观测时造）。 */
export class ContextMirror {
  private readonly messages = new WeakMap<object, MirrorRef>();
  private readonly objects = new WeakMap<object, MirrorRef>();
  private nextMessage = 1;
  private nextObject = -1;
  /** system 串是字符串、进不了 WeakMap：记最近一次的那一份（同一个 run 里每个 attempt 是同一个串）。 */
  private system: { text: string; ref: MirrorRef } | null = null;
  /** 同一个 transcript 数组已经编到哪：只增的数组每次只看新增的。 */
  private readonly encoded = new WeakMap<readonly AgentMessage[], { length: number; last: AgentMessage | undefined; runs: [MirrorRef, number][] }>();

  /**
   * 一次 run 内调模型的上下文。`final` 给了（hook 改过视图）就按它逐条编号；否则交「transcript + 压缩状态 + 注入」，
   * 由观测线程重建。
   */
  handoff(input: {
    systemPrompt: string | null;
    transcript: readonly AgentMessage[];
    compaction: CompactionState;
    injections: readonly AgentMessage[];
    final?: readonly AgentMessage[];
    tools: readonly AgentTool[];
  }): ContextHandoff {
    const fresh: { ref: MirrorRef; value: unknown }[] = [];
    const drop: MirrorRef[] = [];
    const system = this.systemRef(input.systemPrompt, fresh, drop);
    const view: ContextHandoff["view"] =
      input.final !== undefined
        ? { kind: "explicit", messages: this.runsOf(input.final, fresh) }
        : {
            kind: "rebuild",
            transcript: this.transcriptRuns(input.transcript, fresh),
            compaction: this.objectRef(input.compaction, fresh, () => input.compaction),
            injections: input.injections.map((m) => this.onceRef(m, fresh)),
          };
    const tools = input.tools.filter(isModelVisible).map((t) => this.objectRef(t, fresh, () => toolSchemaOf(t)));
    return { system, view, tools, fresh, ...(drop.length === 0 ? {} : { drop }) };
  }

  /** 一段任意消息（压缩阶段自己拼的输入）：逐条编号。`tools`：随这次请求送出去的菜单（从循环分叉时与循环同一份）。 */
  explicit(input: { systemPrompt: string | null; messages: readonly AgentMessage[]; tools?: readonly AgentTool[] }): ContextHandoff {
    const fresh: { ref: MirrorRef; value: unknown }[] = [];
    const drop: MirrorRef[] = [];
    const system = this.systemRef(input.systemPrompt, fresh, drop);
    const view = { kind: "explicit" as const, messages: this.runsOf(input.messages, fresh) };
    const tools = (input.tools ?? []).filter(isModelVisible).map((t) => this.objectRef(t, fresh, () => toolSchemaOf(t)));
    return { system, view, tools, fresh, ...(drop.length === 0 ? {} : { drop }) };
  }

  private systemRef(text: string | null, fresh: { ref: MirrorRef; value: unknown }[], drop: MirrorRef[]): ContextHandoff["system"] {
    if (text === null) return null;
    // 同一个串对象先比指针；内容相同的新串（下一个 run 重新组装）逐字比一次，仍不交第二份
    if (this.system === null || this.system.text !== text) {
      // 被换掉的那一份这里不会再提起：报给观测线程，让它把值删掉（主循环与子 agent 交替时每次都换）
      if (this.system !== null) drop.push(this.system.ref);
      this.system = { text, ref: this.nextObject-- };
      fresh.push({ ref: this.system.ref, value: text });
    }
    return { ref: this.system.ref, chars: text.length };
  }

  /** 只在这一次交接里有效的编号：值每次都交，不进 WeakMap，观测线程用完就删。每轮注入用它。 */
  private onceRef(value: unknown, fresh: { ref: MirrorRef; value: unknown }[]): MirrorRef {
    const ref = this.nextObject--;
    fresh.push({ ref, value });
    return ref;
  }

  private messageRef(m: AgentMessage, fresh: { ref: MirrorRef; value: unknown }[]): MirrorRef {
    let ref = this.messages.get(m);
    if (ref === undefined) {
      ref = this.nextMessage++;
      this.messages.set(m, ref);
      fresh.push({ ref, value: m });
    }
    return ref;
  }

  private objectRef(o: object, fresh: { ref: MirrorRef; value: unknown }[], value: () => unknown): MirrorRef {
    let ref = this.objects.get(o);
    if (ref === undefined) {
      ref = this.nextObject--;
      this.objects.set(o, ref);
      fresh.push({ ref, value: value() });
    }
    return ref;
  }

  private runsOf(list: readonly AgentMessage[], fresh: { ref: MirrorRef; value: unknown }[]): [MirrorRef, number][] {
    const runs: [MirrorRef, number][] = [];
    for (const m of list) appendRun(runs, this.messageRef(m, fresh));
    return runs;
  }

  /** transcript 只增：同一个数组接着上次编到的地方往后编；数组变了（新 run）或前缀对不上就从头编。 */
  private transcriptRuns(list: readonly AgentMessage[], fresh: { ref: MirrorRef; value: unknown }[]): MirrorRuns {
    let state = this.encoded.get(list);
    if (state === undefined || state.length > list.length || (state.length > 0 && list[state.length - 1] !== state.last)) {
      state = { length: 0, last: undefined, runs: [] };
      this.encoded.set(list, state);
    }
    for (let i = state.length; i < list.length; i++) appendRun(state.runs, this.messageRef(list[i]!, fresh));
    state.length = list.length;
    state.last = list[list.length - 1];
    return state.runs.map(([start, count]) => [start, count] as const);
  }
}

function appendRun(runs: [MirrorRef, number][], ref: MirrorRef): void {
  const last = runs[runs.length - 1];
  if (last !== undefined && last[0] + last[1] === ref) last[1] += 1;
  else runs.push([ref, 1]);
}
