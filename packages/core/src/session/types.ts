// Session：一段独立在跑的 agent，**在盘上**。设计见 docs/design/sessions.md。
//
// 边界：`messages` 是内存里的真源；Session 是它的持久面。
// **语义在 core，存储可替换**（D3）：create-or-resume、入账内容与时机、恢复顺序、坏档 fail-loud
// 都由 `SessionService` 拥有；注入进来的 `SessionStore` 只是字节面，换它只换介质。
//
// **一个 session 目录就是一个状态根**（2026-09-03，sessions.md §2–§3）：meta 与 entries 在目录根，
// 与 inbox / tasks / schedule / lease 平级。清单是另一件事——扫上一层目录，见 `listSessions()`。

import type { StorageDir } from "../storage/types.ts";
import type { AgentError } from "../errors.ts";
import type { AgentMessage } from "../messages.ts";
import type { CompactionReason, CompactionState } from "../compaction/types.ts";

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
  /** 一次压缩之后的**整个**状态（不是增量）：恢复只取最后一条。下标与运行时同一套。 */
  | { kind: "compaction"; at: number; reason: CompactionReason; compaction: CompactionState }
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
  /**
   * 谁建的这一段（2026-09-03，sessions.md §6）。**判据是谁调的 create**：经容器自己的路径建的
   * （cli 启动、`/clear`、宿主 `echo.sessions.create`）为 `true`；经 extension 面的 `session_create`
   * 工具建的为 `false`。只有 main 挂 `session_create`，所以扇出只有一层、不会自己繁殖。
   * `--continue` 只在 main 里挑——续到一段别人派的活不是「上次那段对话」。
   */
  readonly main: boolean;
  /**
   * 持久状态。`closed` 由 `session_close` 与 `/clear` 写；**容器退出不写**——退出的段仍是
   * `active`、只是没进程，`--continue` 才续得回来。`closed` 的段缺省不列、不收信。
   * 运行状态（idle / working）是另一份，在 `status.json`，不进 meta。
   */
  readonly status: SessionStatus;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly messageCount: number;
};

/**
 * 一段 session 的**持久**状态。运行状态（idle / working）是另一份，不在 meta 里。
 *
 * `active` = 还能收信、还能被续；`closed` = 显式关掉的（`session_close` / `/clear`），
 * 留在盘上可 `--resume`，但不进缺省清单、也不再收信。**容器退出不写 closed**——
 * 退出的段仍是 active，只是没进程。
 */
export type SessionStatus = "active" | "closed";

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
  /** 最后一次压缩之后的视图状态；没压过 = `EMPTY_COMPACTION`。 */
  readonly compaction: CompactionState;
};

