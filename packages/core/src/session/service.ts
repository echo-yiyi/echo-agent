// Session Service —— **语义在 core**（D3 / §13.12.2）。
//
// 这个文件存在的理由：`SessionManager` 把 create/load/append 的语义交给了注入方，
// 于是「坏档 fail-loud、不给半截 session」只是注释里的一句自觉——换一个实现就可以返回半截、
// 可以静默吞掉 append，`Agent` 无从保证。而 core 里其实已经拥有另一半语义
// （`agent.ts` 的 persist 决定哪些事件入账、loadSession 决定恢复顺序），**语义被劈成了两半**。
// 本 Service 把那半截收回来；注入的 `SessionStore` 只剩字节面。
//
// **纯的**：只依赖 `StorageDir`，不碰 `node:`。
//
// 盘上布局（属于本 Service，不是端口契约的一部分，可改）：
//
//   sessions/<id>/meta.json            SessionInfo
//   sessions/<id>/entries/000001.json  一条 entry 一个文件
//
// 为什么一条一文件而不是单个 append 文件：`StorageDir` 只有全量 `write`，
// 单文件追加要「读全量 → 拼接 → 写全量」，长会话下是 O(n²)，而且中途崩溃会毁掉整份。
// 一条一文件时 append 就是写一个新文件——**天然满足「一次 write 要么整份生效」**，
// 且 `list(prefix)` 正好把它们读得回来。

import type { AgentError } from "../errors.ts";
import type { AgentMessage } from "../messages.ts";
import { assertMessageShape } from "../message-shape.ts";
import { assertSafePathSegment } from "../storage/path-safety.ts";
import type { SessionData, SessionEntry, SessionInfo, SessionStore } from "./types.ts";

/** entry 文件名的序号宽度。定长才能让字典序 = 时间序，`list()` 拿回来直接排序即可。 */
const SEQ_WIDTH = 6;
const SEQ_MAX = 10 ** SEQ_WIDTH - 1;
const META_FILE = "meta.json";
const ENTRIES_DIR = "entries";

function seqName(seq: number): string {
  if (seq > SEQ_MAX) {
    // 定长序号溢出会让字典序失效（1000000 会排到 999999 前面）。不静默换格式，先判红。
    throw new Error(`会话 entry 超过 ${SEQ_MAX} 条，定长序号溢出——需先扩宽 SEQ_WIDTH 并迁移存量`);
  }
  return `${String(seq).padStart(SEQ_WIDTH, "0")}.json`;
}

/**
 * 会话 id 的合法字符集。**id 会被直接拼进路径**，不校验的话
 * `sessionId="../../escaped"` 会写到状态根外面（实测过）。
 * 判据与 `agentId` 共用一份（`storage/path-safety.ts`）——两处各写一份就会各漏各的。
 */
export function assertSafeSessionId(sessionId: string): void {
  assertSafePathSegment("会话 id ", sessionId);
}

/** 会话在 store 里的根前缀。`agentId` 不进路径——一个状态根就是一个 agent（D6）。 */
function sessionRoot(sessionId: string): string {
  return `sessions/${sessionId}`;
}

type Loaded = {
  readonly info: SessionInfo;
  readonly entries: readonly SessionEntry[];
};

/** 调用方给的内容——**没有 id / parentId**，那两个由 Service 生成。 */
export type SessionEntryInput =
  | { kind: "message"; message: AgentMessage }
  | { kind: "compaction"; at: number; summary: string; coveredUpTo: string }
  | { kind: "error"; at: number; error: AgentError };

/**
 * 会话的语义所有者。一个实例管一个 `SessionStore`，可以开多个会话。
 *
 * **不提供列表 / 删除 / 重命名**：那是产品的会话管理界面，core 自己用不到（§13.12.2）。
 * 产品要就自己在 Store 之上做——它拿到的是同一个字节面。
 */
export class SessionService {
  /**
   * 每个会话的游标：下一个序号、末条 id，以及**当前的 SessionInfo**。
   *
   * `info` 在这里，是因为 meta 是 entries 的**派生缓存**，不是第二份真相。此前 `bumpMeta`
   * 走「读盘 meta → 加一 → 写回」，两个后果：① meta 丢了就静默 return，写照样继续；
   * ② 崩溃留下的落后计数会**永远落后**（读到旧值再加一）。现在计数只从内存里这份走，
   * 打开会话时由 entries 现算，盘上的 meta 只是快照。
   */
  private readonly cursors = new Map<
    string,
    { nextSeq: number; lastEntryId: string | null; info: SessionInfo }
  >();
  /** 未 settle 的写。`stop()` 等的就是它（§13.12.2：Store 面上没有 flush）。 */
  private readonly pending = new Set<Promise<unknown>>();
  /** 封存后拒绝一切写入。丢锁时置真（§13.12.3 的第 ① 步）。 */
  private sealed = false;
  /**
   * 每个会话一条**串行写链**。两个理由：
   *   ① meta 是读改写（在旧 `messageCount` 上加），并发跑会丢更新——
   *      实测 10 次并发 append 之后计数只剩 1。
   *   ② 并发写同一路径会撞 `FileDir` 的临时文件名，那一次写静默丢失。
   * 串行之后两个问题都不存在，代价是同一会话的写不再并行——它本来也不该并行。
   */
  private readonly chain = new Map<string, Promise<unknown>>();
  /**
   * **中毒的会话** → 它遇到的第一个持久化错误。这是错误状态的**唯一真相源**：
   * `settle()` / `hasPendingError` 都读它，没有第二个「报过就清掉」的标志位。
   *
   * 记住而不是吞掉：此前 `track()` 造 rejected promise、`settle()` 用 `allSettled` 丢结果——
   * Store 返回「盘挂了」之后 `settle()` 照样 resolve，还会甩出 unhandled rejection。
   *
   * 中毒之后一律拒绝再写。
   *
   * 没有这条时实测过：e1 写失败之后 e2/e3 照样往下落盘，而它们的 `parentId` 指向一条
   * **盘上并不存在**的 e1——恢复时会撞「序号断链」，也就是说**失败之后的每一次写都在
   * 制造坏档**。更糟的是第二次 `settle()` 还会返回绿（错误报过一次就被清掉了），
   * 调用方据此以为已经存下了。
   *
   * 恢复方式只有一种：**重新 `createOrResume` 或换新实例**——即让人显式确认盘上是什么状态，
   * 而不是由 Service 自己猜「上次那次失败也许不要紧」。
   */
  private readonly poisoned = new Map<string, unknown>();

  constructor(private readonly store: SessionStore) {}

  /**
   * create-or-resume（D5）：存在就恢复，不存在就新建。**启动时自动完成，不是用户的仪式。**
   *
   * 恢复顺序由本方法定：读 meta → 按序号读全部 entry → 投影出 messages 与 checkpoint。
   * 任何一条 entry 解不出来都**抛错，不返回半截**——半截 session 比没有 session 更危险，
   * 因为它看起来能用。
   */
  async createOrResume(sessionId: string, opts?: { name?: string; workspace?: string; agent?: string }): Promise<SessionData> {
    assertSafeSessionId(sessionId);
    // 封存之后连打开都不许：新建会写 meta，恢复则会给出一份**写不进去**的 session——
    // 后者看起来能用，比拿不到更危险。实测过启动期丢锁时这里仍会把 meta 写出去。
    if (this.sealed) throw new Error(`会话已封存（多半是丢了 single-writer lease）：拒绝打开 ${sessionId}`);
    // **解毒放在最后**：此前是先 `poisoned.delete` 再 `tryLoad`，于是恢复失败（比如
    // entry 断链）也照样解毒——实测抛错之后 `append` 仍被接受、`settle()` 还返回成功，
    // 继续往一个**已经确认损坏**的会话里写。解毒的前提是「确实恢复成功了」。
    const existing = await this.tryLoad(sessionId);
    if (existing !== null) {
      const projected = project(existing);
      this.cursors.set(sessionId, {
        nextSeq: existing.entries.length + 1,
        lastEntryId: existing.entries[existing.entries.length - 1]?.id ?? null,
        // **计数现算**：entries 是日志、是真相；meta 只是它的快照。崩在「写完 entry、
        // 还没刷 meta」之间是正常的崩溃形态，不该让会话打不开，但也不能让落后的计数
        // 一直落后下去（读旧值再加一 = 永远差那么多）。
        info: { ...projected.info, messageCount: projected.messages.length },
      });
      // 恢复完整成功、游标就位之后才解毒
      this.poisoned.delete(sessionId);
      return { ...projected, info: { ...projected.info, messageCount: projected.messages.length } };
    }

    const now = Date.now();
    const info: SessionInfo = {
      id: sessionId,
      name: opts?.name ?? sessionId,
      // 只在新建这一刻写；resume 走上面那条路，以盘上为准。缺省 "/" 与 AgentOptions.workspace 同一个缺省
      workspace: opts?.workspace ?? "/",
      // 归哪个 agent（产品）：会话身份的第二维（2026-09-01 用户拍板）。缺省与 `agentId` 缺省同一个字
      agent: opts?.agent ?? "default",
      createdAt: now,
      updatedAt: now,
      messageCount: 0,
    };
    await this.writeMeta(info);
    this.cursors.set(sessionId, { nextSeq: 1, lastEntryId: null, info });
    this.poisoned.delete(sessionId);
    return { info, messages: [], checkpoint: null };
  }

  /**
   * 盘上全部会话的清单（只读 meta，不读 entries），按 `updatedAt` 降序。
   *
   * 2026-09-01 用户拍板：**列表归 core**，不让产品各自去扫 meta 文件。会话身份是 workspace + agent
   * 两维，产品要挑「本产品在本目录的最近一段」（`--continue`）、要做会话列表，都得先看得到全部。
   * 坏 meta **判红**，与恢复同一姿态——清单里静默少一条比整个报错更危险：少的那条正好可能是用户要续的。
   */
  async list(): Promise<SessionInfo[]> {
    const prefix = "sessions/";
    const out: SessionInfo[] = [];
    for (const p of await this.store.list(prefix)) {
      const rel = p.startsWith(prefix) ? p.slice(prefix.length) : p;
      if (!rel.endsWith(`/${META_FILE}`)) continue;
      const id = rel.slice(0, -(META_FILE.length + 1));
      if (id.includes("/")) continue; // 只认 sessions/<id>/meta.json 这一层
      const raw = await this.store.read(`${prefix}${rel}`);
      if (raw === null) throw new Error(`会话 ${id} 的 ${META_FILE} 在 list 里有、read 却为空`);
      let info: SessionInfo;
      try {
        info = JSON.parse(raw) as SessionInfo;
      } catch (e) {
        throw new Error(`会话 ${id} 的 ${META_FILE} 解不开：${(e as Error).message}`);
      }
      assertSessionInfoShape(info, `会话 ${id} 的 ${META_FILE}`);
      out.push(info);
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /**
   * 入账。**id 与 parentId 由本 Service 生成**——调用方给的是内容，不是身份。
   *
   * 身份归 core 的理由：entry id 要在恢复后仍然唯一且有序，那是持久化语义的一部分；
   * 交给调用方就会出现「两条 entry 同 id」这类只在恢复期才炸的问题。
   */
  async append(sessionId: string, parts: readonly SessionEntryInput[]): Promise<SessionEntry[]> {
    if (this.sealed) throw new Error("会话已封存（多半是丢了 single-writer lease）：拒绝写入");
    if (this.poisoned.has(sessionId)) {
      const why = this.poisoned.get(sessionId);
      throw new Error(
        `会话 ${sessionId} 已因持久化失败封存，拒绝写入：${why instanceof Error ? why.message : String(why)}` +
          `——盘上状态需人工确认，确认后重新 createOrResume 才继续`,
      );
    }
    if (parts.length === 0) return [];
    const cursor = this.cursors.get(sessionId);
    if (cursor === undefined) throw new Error(`会话未打开：${sessionId}——先 createOrResume`);

    const written: SessionEntry[] = [];
    for (const part of parts) {
      const seq = cursor.nextSeq++;
      const entry = { ...part, id: `${sessionId}-e${seq}`, parentId: cursor.lastEntryId } as SessionEntry;
      cursor.lastEntryId = entry.id;
      written.push(entry);
    }
    // **一条串行链**：entry 逐条写，末尾合并一次 meta。顺序有保证，也不会撞同名临时文件。
    this.enqueue(sessionId, async () => {
      for (const entry of written) {
        const seq = Number(entry.id.slice(entry.id.lastIndexOf("e") + 1));
        await this.store.write(`${sessionRoot(sessionId)}/${ENTRIES_DIR}/${seqName(seq)}`, JSON.stringify(entry));
      }
      await this.bumpMeta(cursor, written);
    });
    return written;
  }

  /**
   * `stop()` 用：等所有未完成的 `write()` settle。**不是 flush**——Store 面上没有那个方法。
   *
   * **写失败会在这里抛**（fail-loud）。吞掉它等于「以为存下来了、其实没有」，
   * 那比崩溃更坏：崩溃至少看得见。
   */
  async settle(): Promise<void> {
    // 链上的 promise 本身不会 reject（enqueue 里已经捕获并记进 firstError），
    // 所以这里 await 完就能拿到确定的结论；上限防「settle 期间又冒出新写」的极端情形。
    for (let i = 0; i < 100 && this.pending.size > 0; i++) {
      await Promise.allSettled([...this.pending]);
    }
    // **settle() 自己从不清错**。曾经清过（「报过一次就别重复抛」），于是第二次 `settle()`
    // 返回绿——调用方（`stop()`）据此认为已经安全收摊，而盘上少了一条 entry。
    // 唯一的解毒点是显式 `createOrResume`：那是人确认过盘上状态之后才做的事。
    for (const e of this.poisoned.values()) {
      throw e instanceof Error ? e : new Error(String(e));
    }
  }

  /** 有没有攒着未报的持久化错误。`stop()` 之外的地方想探一眼时用。 */
  get hasPendingError(): boolean {
    return this.poisoned.size > 0;
  }

  /**
   * 封存：此后拒绝一切写入。丢锁时调（§13.12.3 的第 ① 步）。
   * **不等 pending**——丢锁后连已经在飞的写都不该再指望，等它只会拖长双写窗口。
   */
  seal(): void {
    this.sealed = true;
  }

  get isSealed(): boolean {
    return this.sealed;
  }

  /**
   * 把一段写排到该会话的串行链尾。**错误记下来而不是往外扔**——
   * 扔出去没人接就是 unhandled rejection，接住又会让 `deliver`/`persist` 这种
   * 同步命令面被迫处理 IO 错误。统一由 `settle()` 报。
   */
  private enqueue(sessionId: string, work: () => Promise<void>): void {
    const prev = this.chain.get(sessionId) ?? Promise.resolve();
    const next = prev
      .then(async () => {
        // 前面已经失败过就**不再执行**。此前是 `prev.then(work, work)`——失败之后照样跑，
        // 于是每一次后续写都在往盘上加一条 parent 指向不存在 entry 的坏档。
        if (this.poisoned.has(sessionId)) return;
        await work();
      })
      .catch((e: unknown) => {
        if (!this.poisoned.has(sessionId)) this.poisoned.set(sessionId, e);
      });
    this.chain.set(sessionId, next);
    this.track(next);
  }

  private track(p: Promise<unknown>): void {
    const wrapped: Promise<unknown> = p.finally(() => {
      this.pending.delete(wrapped);
    });
    this.pending.add(wrapped);
  }

  private async writeMeta(info: SessionInfo): Promise<void> {
    await this.store.write(`${sessionRoot(info.id)}/${META_FILE}`, JSON.stringify(info));
  }

  /**
   * 刷 meta 快照。**不读盘**——计数与身份都从内存游标走。
   *
   * 此前是「读盘 meta → 加一 → 写回」，两条坏路径：
   *   ① `raw === null` 时静默 `return`，注释里写着「恢复时会因缺 meta 判红」，
   *      而 `tryLoad` 实际把缺 meta 当成**新会话**——于是 entries 全成孤儿，
   *      下一次 append 从 000001.json 重新开始，**直接覆盖历史**（实测）。
   *   ② 读到的是崩溃时落后的计数，加一之后照样落后，差值永远补不回来。
   * 现在 meta 是 entries 的派生快照：写它不需要先问它。
   */
  private async bumpMeta(
    cursor: { info: SessionInfo },
    added: readonly SessionEntry[],
  ): Promise<void> {
    cursor.info = {
      ...cursor.info,
      updatedAt: Date.now(),
      messageCount: cursor.info.messageCount + added.filter((e) => e.kind === "message").length,
    };
    await this.writeMeta(cursor.info);
  }

  /** 不存在返回 `null`；存在但坏 → 抛。 */
  private async tryLoad(sessionId: string): Promise<Loaded | null> {
    const root = sessionRoot(sessionId);
    const raw = await this.store.read(`${root}/${META_FILE}`);
    if (raw === null) {
      // **缺 meta ≠ 新会话**。entries 还在就说明这是一份**丢了目录的旧会话**——
      // 当成新会话会让恢复出 0 条消息，下一次 append 从 000001.json 重新开始，
      // 直接盖掉历史（实测：删掉 meta.json 之后重启，原有消息全部消失）。
      const orphans = [...(await this.store.list(`${root}/${ENTRIES_DIR}/`))];
      if (orphans.length > 0) {
        throw new Error(
          `会话 ${sessionId} 缺 ${META_FILE}，但盘上还有 ${orphans.length} 条 entry——` +
            `这是坏档不是新会话，拒绝打开（接着写会覆盖历史）`,
        );
      }
      return null;
    }

    let info: SessionInfo;
    try {
      info = JSON.parse(raw) as SessionInfo;
    } catch (e) {
      throw new Error(`会话 ${sessionId} 的 meta.json 解不开：${(e as Error).message}`);
    }
    // **整份 SessionInfo 都验**：只验 id 的话，`name`/`createdAt` 缺了照样恢复成功，
    // 那份缺字段的 info 会直接进 `SessionData` 交给上层用。
    assertSessionInfoShape(info, `会话 ${sessionId} 的 ${META_FILE}`);

    const prefix = `${root}/${ENTRIES_DIR}/`;
    const paths = [...(await this.store.list(prefix))].sort();
    const entries: SessionEntry[] = [];
    const seen = new Set<string>();
    for (const p of paths) {
      const full = p.startsWith(prefix) ? p : `${prefix}${p}`;
      const text = await this.store.read(full);
      // list 报告了它、read 却说没有——store 自相矛盾，判红而不是跳过
      if (text === null) throw new Error(`会话 ${sessionId} 的 ${full} 在 list 里有、read 却为空`);
      let entry: SessionEntry;
      try {
        entry = JSON.parse(text) as SessionEntry;
      } catch (e) {
        throw new Error(`会话 ${sessionId} 的 ${full} 解不开：${(e as Error).message}`);
      }
      assertEntryShape(entry, `会话 ${sessionId} 的 ${full}`);
      if (seen.has(entry.id)) throw new Error(`会话 ${sessionId} 出现重复 entry id：${entry.id}`);
      seen.add(entry.id);

      // **文件名序号必须连续且与 entry id 对上**。
      // 没有这条时实测过：删掉中间的 000002.json 之后恢复，续号会从 e3 开始，
      // 于是下一次 append **直接覆盖原来的 000003.json**——静默毁掉一条历史。
      const expectedSeq = entries.length + 1;
      const nameSeq = Number(full.slice(full.lastIndexOf("/") + 1, full.lastIndexOf(".json")));
      if (nameSeq !== expectedSeq) {
        throw new Error(`会话 ${sessionId} 的 entry 序号断链：期望 ${expectedSeq}，实际文件是 ${full}`);
      }
      if (entry.id !== `${sessionId}-e${expectedSeq}`) {
        throw new Error(`会话 ${sessionId} 的 ${full} 里 id 是 ${entry.id}，与序号 ${expectedSeq} 对不上`);
      }
      // parent 链：第一条无 parent，其余必须指向前一条
      const expectedParent = entries[entries.length - 1]?.id ?? null;
      if (entry.parentId !== expectedParent) {
        throw new Error(
          `会话 ${sessionId} 的 ${entry.id} 的 parentId 是 ${String(entry.parentId)}，期望 ${String(expectedParent)}`,
        );
      }
      entries.push(entry);
    }

    // meta 的 id 必须与目录名一致——对不上说明状态根被人挪过或拼错，别接着往里写
    if (info.id !== sessionId) {
      throw new Error(`会话 ${sessionId} 的 meta.json 里 id 是 '${info.id}'，与目录名对不上`);
    }
    return { info, entries };
  }
}

/** 判别联合逐 kind 验形——**光有 id/kind 不够**，payload 缺了照样是半截 session。 */
function assertEntryShape(entry: SessionEntry, where: string): void {
  if (typeof entry?.id !== "string" || typeof entry?.kind !== "string") {
    throw new Error(`${where} 不是合法 entry（缺 id 或 kind）`);
  }
  if (entry.parentId !== null && typeof entry.parentId !== "string") {
    throw new Error(`${where} 的 parentId 形状不对`);
  }
  switch (entry.kind) {
    case "message":
      assertMessageShape((entry as { message?: unknown }).message, where);
      return;
    case "compaction":
      if (typeof entry.summary !== "string" || typeof entry.coveredUpTo !== "string") {
        throw new Error(`${where} 是 compaction 但缺 summary / coveredUpTo`);
      }
      if (typeof entry.at !== "number") throw new Error(`${where} 是 compaction 但缺 at`);
      return;
    case "error":
      if (entry.error === undefined) throw new Error(`${where} 是 error 但缺 error`);
      if (typeof entry.at !== "number") throw new Error(`${where} 是 error 但缺 at`);
      return;
    default:
      // 未知 kind：不猜、不跳过。多半是版本不匹配，接着写会写出更乱的东西。
      throw new Error(`${where} 的 kind 不认识：${String((entry as { kind?: unknown }).kind)}`);
  }
}

/**
 * `SessionInfo` 全字段验形。它会原样进 `SessionData` 交给上层，缺字段的 info
 * 不该以「恢复成功」的身份流出去。
 */
function assertSessionInfoShape(info: unknown, where: string): void {
  const i = info as Record<string, unknown> | null | undefined;
  if (i === null || i === undefined || typeof i !== "object") throw new Error(`${where} 不是对象`);
  for (const k of ["id", "name", "workspace", "agent"]) {
    if (typeof i[k] !== "string") {
      throw new Error(
        k === "workspace" || k === "agent"
          ? `${where} 缺 ${k}——2026-09-01 之前建的 session 没有这个字段；删掉旧的 sessions/<id>/ 目录或手工补上再启动`
          : `${where} 缺 ${k}（或不是字符串）`,
      );
    }
  }
  for (const k of ["createdAt", "updatedAt", "messageCount"]) {
    if (typeof i[k] !== "number") throw new Error(`${where} 缺 ${k}（或不是数字）`);
  }
}



/** entries → 运行时视图。**恢复顺序在这里定死**：messages 按入账序，checkpoint 取最后一次压缩。 */
function project(loaded: Loaded): SessionData {
  const messages: AgentMessage[] = [];
  let checkpoint: string | null = null;
  for (const e of loaded.entries) {
    if (e.kind === "message") messages.push(e.message);
    else if (e.kind === "compaction") checkpoint = e.id;
  }
  return { info: loaded.info, messages, checkpoint };
}
