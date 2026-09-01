// Session：一系列对话，**在盘上**。设计见 docs/design/AGENT-CORE.md §9 与 §13.12.2。
//
// 边界：`messages` 是内存里的真源；Session 是它的持久面。
// **语义在 core，存储可替换**（D3）：create-or-resume、入账内容与时机、恢复顺序、坏档 fail-loud
// 都由 `SessionService` 拥有；注入进来的 `SessionStore` 只是字节面，换它只换介质。
//
// `SessionManager` 是 D3 之前的形状——语义在实现方手里。它仍导出供现有调用方过渡，
// **新代码走 `SessionService`**。

import type { StorageDir } from "../storage/types.ts";
import type { AgentError } from "../errors.ts";
import type { AgentMessage } from "../messages.ts";

/**
 * Session 的存储端口：**与 `StorageDir` 同形，就是它**。
 *
 * 不另立一个结构相同的接口——那只会让 `FileDir` / `InMemoryDir` 要各写一遍适配。
 * 这个别名的作用是标出「这个注入位要的是存储端口」，语义一个字都不在这里。
 */
export type SessionStore = StorageDir;

/**
 * 存储单元 = 消息 + 少量过程事实。
 * 只存消息的话，重启后「有内容无经历」——压缩发生过、哪次失败过全丢。
 *
 * **形状是树，用法是线**：entry 带 parentId，第一版只长一条枝、不提供分支命令。
 * 形状现在定只值一个字段；等线性 log 落地再改树就是一次存量迁移。
 */
export type SessionEntry = {
  readonly id: string;
  readonly parentId: string | null;
} & (
  | { kind: "message"; message: AgentMessage }
  | { kind: "compaction"; at: number; summary: string; coveredUpTo: string }
  | { kind: "error"; at: number; error: AgentError }
);

export type SessionInfo = {
  readonly id: string;
  readonly name: string;
  /**
   * 这个 session 在哪个目录里干活（2026-09-01 起是 **session 级事实**）：文件工具的边界与起点、
   * prompt 里的 `{{workspace}}`。新建时由宿主给（绝对路径），resume 时以盘上为准。
   * **必填**：没有它的 meta 是坏档，resume 判红（pre-release，不留可选兼容）。
   */
  readonly workspace: string;
  /**
   * 归哪个 agent（产品）：会话身份的第二维（2026-09-01 用户拍板）。`echo-agent` 与 `echo-coding`
   * 在同一目录里各有各的对话，靠的就是这个字段——只按 workspace 分的话，谁先起谁定义那段对话，
   * 后来的产品只能续（实测：coding 续了通用 agent「我没有文件工具」的结论）。
   * 由宿主给（`AgentOptions.agentName`，缺省与 `agentId` 相同）；resume 时以盘上为准。
   * **必填**：没有它的 meta 是坏档，resume 判红（pre-release，不留可选兼容）。
   */
  readonly agent: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly messageCount: number;
};

/**
 * 新会话的 id（2026-09-01 用户拍板：**缺省每次启动新建会话**，续上次是显式动作）。
 *
 * 之前缺省按 workspace 派生（`main-<hash>`）、启动即 create-or-resume——于是同一目录里起的任何
 * 产品都落进同一段对话，而且壳一个字不显示，用户以为是全新开始、模型脑子里却带着上一场的结论。
 * 现在一次启动一段：时间戳保证按名排序即按时间排序，随机尾巴防同一毫秒撞名。
 * 形状受 `assertSafeSessionId` 约束（字母数字与 `-`，字母开头）。
 */
export function newSessionId(now: number = Date.now()): string {
  const rand = Math.floor(Math.random() * 36 ** 4)
    .toString(36)
    .padStart(4, "0");
  return `s-${now.toString(36)}-${rand}`;
}

export type SessionData = {
  readonly info: SessionInfo;
  readonly messages: AgentMessage[];
  readonly checkpoint: string | null;
};

export interface SessionManager {
  create(opts?: { name?: string; workspace?: string; agent?: string }): Promise<SessionInfo>;
  /** 坏档 **fail-loud**，不给半截 session。 */
  load(id: string): Promise<SessionData>;
  /** 轻量清单，不读全量 entries。 */
  list(): Promise<SessionInfo[]>;
  delete(id: string): Promise<void>;
  rename(id: string, name: string): Promise<void>;
  /** Agent 每次入账调它；**落盘时机（逐条 / 攒批 / 轮末）由实现决定**。 */
  append(id: string, entries: SessionEntry[]): Promise<void>;
  flush?(id: string): Promise<void>;
}

/** core 自带的内存实现：一次性跑、评测、单测用。 */
export class InMemorySessionManager implements SessionManager {
  private readonly sessions = new Map<string, { info: SessionInfo; entries: SessionEntry[] }>();
  private seq = 0;

  async create(opts?: { name?: string; workspace?: string; agent?: string }): Promise<SessionInfo> {
    const id = `s${++this.seq}`;
    const now = Date.now();
    const info: SessionInfo = {
      id,
      name: opts?.name ?? id,
      workspace: opts?.workspace ?? "/",
      agent: opts?.agent ?? "default",
      createdAt: now,
      updatedAt: now,
      messageCount: 0,
    };
    this.sessions.set(id, { info, entries: [] });
    return info;
  }

  async load(id: string): Promise<SessionData> {
    const s = this.sessions.get(id);
    if (s === undefined) throw new Error(`会话不存在：${id}`);
    const messages: AgentMessage[] = [];
    let checkpoint: string | null = null;
    for (const e of s.entries) {
      if (e.kind === "message") messages.push(e.message);
      else if (e.kind === "compaction") checkpoint = e.id;
    }
    return { info: s.info, messages, checkpoint };
  }

  async list(): Promise<SessionInfo[]> {
    return [...this.sessions.values()].map((s) => s.info);
  }

  async delete(id: string): Promise<void> {
    this.sessions.delete(id);
  }

  async rename(id: string, name: string): Promise<void> {
    const s = this.sessions.get(id);
    if (s === undefined) throw new Error(`会话不存在：${id}`);
    s.info = { ...s.info, name, updatedAt: Date.now() };
  }

  async append(id: string, entries: SessionEntry[]): Promise<void> {
    const s = this.sessions.get(id);
    if (s === undefined) throw new Error(`会话不存在：${id}`);
    s.entries.push(...entries);
    s.info = {
      ...s.info,
      updatedAt: Date.now(),
      messageCount: s.entries.filter((e) => e.kind === "message").length,
    };
  }

  /** 内存实现的树身份：线性使用下 parent 恒为前一条。 */
  nextEntryId(id: string): { entryId: string; parentId: string | null } {
    const s = this.sessions.get(id);
    const entries = s?.entries ?? [];
    const last = entries[entries.length - 1];
    return { entryId: `${id}-e${entries.length + 1}`, parentId: last?.id ?? null };
  }
}
