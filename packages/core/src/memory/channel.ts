// 记忆的**后台通道**:提取一条、整理一条,**都不进 admission**(2026-09-07 用户拍板)。
//
// 为什么不进 admission:admission 一次只发一个执行许可(`StandaloneRunAdmission`)。后台活要是也拿许可,
// 只有两种排法,都不行:和前台排同一条队——用户的下一句要等整理 / 提取跑完;或者开一个会被前台
// 抢占的低优先档——用户连着说十句话,每条 reply 结束排的提取十次全被抢,实际提取 0 次。
// 所以两条活各走各的通道,与前台并行(决策见 docs/decisions/implemented/2026-09-07-memory-extraction.md)。
//
// 并行是安全的,因为这两条活与前台**没有共享可变状态**:独立 context(主 transcript 一字不动)、
// 事件不外发、只碰记忆文件。唯一的交叉是记忆文件本身,那归文件锁(`lock.ts`),不归许可。
//
// 单许可本来也不是 core 的架构约束:`admission/types.ts` 写着「RunPermit、并发裁决、失败
// 规范化都是 Host 私有」,`AgentAdmissionPort` 可替换——挡着的是那一个实现。

import { errText } from "../errors.ts";
import type { Diagnostic } from "../errors.ts";

/**
 * 一条后台通道:**同时最多一个在跑**,重复排队会被折叠成"跑完再跑一次"。
 *
 * 折叠而不是排队:在跑的时候又排进来几次,跑完只再跑**最后排进来的那一次**。回调捕获的是排它那一刻的
 * 材料——提取的 transcript 就在闭包里——而最后那份包含前面被折叠掉的几次(transcript 只增不减,被压缩的
 * 部分以摘要留着)。所以折叠丢的是重复,不是材料;攒一个队列只会在忙的时候越积越多。
 */
export class MemoryChannel {
  private inflight: Promise<void> | null = null;
  private aborter: AbortController | null = null;
  /** 在跑的时候最后排进来的那一次:跑完就跑它(只留一个,不排队)。 */
  private next: ((signal: AbortSignal) => Promise<void>) | null = null;

  constructor(
    private readonly name: string,
    private readonly report?: (d: Diagnostic) => void,
  ) {}

  /** 有没有活在飞。测试与 `status` 用。 */
  get busy(): boolean {
    return this.inflight !== null;
  }

  /**
   * 排一次。**不 await**——调用方(reply 收尾、回 idle)不该被后台活拖住。
   * 已经在跑就把这次记成"下一个"(顶掉之前记下的),等它跑完再跑。
   */
  schedule(run: (signal: AbortSignal) => Promise<void>): void {
    if (this.inflight !== null) {
      this.next = run;
      return;
    }
    this.start(run);
  }

  private start(run: (signal: AbortSignal) => Promise<void>): void {
    const aborter = new AbortController();
    this.aborter = aborter;
    this.inflight = (async () => {
      try {
        await run(aborter.signal);
      } catch (e) {
        // **绝不外抛**:后台活失败不该变成 unhandled rejection,更不该影响前台
        this.report?.({ code: `memory_${this.name}_failed`, message: errText(e) });
      }
    })().then(() => {
      this.inflight = null;
      this.aborter = null;
      const next = this.next;
      if (next !== null) {
        this.next = null;
        this.start(next);
      }
    });
  }

  /**
   * 中断并**等它真的收完**。`stop()` 用。
   *
   * 为什么必须等:lease 是跨进程的单写者保证,它不区分写者是主循环还是后台通道——
   * 只要这个进程还在往记忆里写,锁就不能交出去。这个坑 dream 踩过(见 `agent.ts` 里
   * `settleDream` 那段注释:不等的话租约已经归了别人、旧 dream 还在写)。
   */
  async settle(): Promise<void> {
    // **不永久关闭**:`settle()` 也在丢锁 / 暂停时调,那之后 agent 可能再起来。
    // "停了之后别再起新的"由调用点的 `memoryWorkAllowed` 判,不由通道自己记一个终态。
    this.next = null;
    this.aborter?.abort();
    const inflight = this.inflight;
    if (inflight !== null) await inflight;
  }
}
