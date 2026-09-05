// MCP 端口：core 认识的全部 MCP 概念。**这个文件不 import MCP SDK，也不 import 任何实现**。
//
// 为什么是端口而不是实现（2026-08-11 开源计划 §4 拍定）：
// SDK-backed 的 MCP 实现会把 `@modelcontextprotocol/sdk` 拖进 core 的根依赖图——
// 装 `@echo-agent/core` 只想跑一个 agent 的人，被迫装上整套 MCP 协议栈。
// 所以 core 只留「怎么接」，「怎么连」出去到适配器一侧（不在本仓）。
//
// 边界一句话：**core 定义 Agent 能观测什么、能收摊什么；适配器定义服务器怎么配、怎么连**。
// 所以这里没有 McpServerConfig、没有 transport、没有超时选项——那些都是适配器的词汇。

import type { Diagnostic } from "../errors.ts";
import type { ResourceChange } from "../events.ts";
import type { AgentMessage } from "../messages.ts";
import type { ToolMap } from "../tools/harness.ts";

export const MCP_KIND = "mcp";

/**
 * 一台 MCP 服务器在 Agent 状态里的样子——**只读快照**。
 *
 * 刻意不含 `client` / `connecting` / `generation`：那三样是适配器的活物，
 * 露到 `AgentState` 上等于把 SDK 的连接对象塞进了 core 的公共面
 * （`AgentState` 会被 UI 序列化、被评测轨迹落盘，活物进去就是泄漏）。
 */
export type McpServerSnapshot = {
  readonly name: string;
  readonly status: "idle" | "connecting" | "ready" | "disconnected";
  readonly error?: string;
  readonly connectedAt?: number;
  /** 它注册进来的工具名（已加前缀）。 */
  readonly tools: readonly string[];
  readonly serverInfo?: { name: string; version?: string };
};

/**
 * core 交给适配器的东西：工具面 + 三条回调。
 *
 * 适配器**只认这个，不认 Agent**——所以适配器不依赖 `Agent` 类，
 * 测试里拿一个裸 `ToolMap` 就能把整套连接逻辑跑起来。
 */
export type McpHost = {
  tools: ToolMap;
  onChanged?: (change: ResourceChange) => void;
  deliver?: (message: AgentMessage) => void;
  report?: (d: Diagnostic) => void;
};

export type McpConnectOutcome =
  | { ok: true; name: string; tools: number }
  | { ok: false; name: string; error: string };

/**
 * 宿主装配进 Agent 的 MCP 端口。**core 只调这六个方法**。
 *
 * `attach` 是单向的：Agent 在构造末尾把自己的工具面和回调交出去，
 * 之后连接由宿主显式驱动（`agent.mcp?.connectAll()`）——
 * 「声明 ≠ 连接」这条仪式不变，只是搬到了端口上。
 */
export type AgentMcpPort = {
  attach(host: McpHost): void;
  connect(name: string): Promise<McpConnectOutcome>;
  connectAll(): Promise<McpConnectOutcome[]>;
  disconnect(name: string): Promise<void>;
  list(): readonly McpServerSnapshot[];
  /** Agent.dispose() 会调它——「agent 起的东西不能比 agent 活得久」由端口兑现。 */
  dispose(): Promise<void>;
};
