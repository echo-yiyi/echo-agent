// `echo-agent observe`：看已落盘的 run 观测记录（CLI 最小面）。
//
//   observe last                      最近一次 run，人读文本
//   observe show <run-id>             指定 run
//   observe export <run-id> --format  json（缺省）或 text，原样进 stdout
//   observe health                    库在哪、每个 runtime 裁决到哪、多少 run / record
//   observe serve [--port N]          本地只读面板（页面轮询 SQLite，agent 跑着也能看），Ctrl+C 停
//
// **只调 `openObservationReader()`**：read-only SQLite 连接，不 `createEcho()`、不取 Agent StateLock、不起第二个 Agent；
// 活 writer（正在跑的 agent）旁边照样能读，只见已 COMMIT 的。每条命令结束关连接。
//
// 状态根与主命令同一条解析：`--state-dir` 是**会话目录的上一层**，`--session` 点名看哪一段。
// 观测库归 session（状态根 = session 目录，2026-09-03），所以「看哪一段」是必须回答的问题；
// 都不给就看**最近有记录的那一段**——那是「刚才那次跑」最常见的意思。
// 不认识的子命令 / 选项一律报错（退出码 2），不静默按缺省跑——与 `cli.ts` 同一条纪律。

import {
  expandHome,
  FileDir,
  listSessions,
  observationDatabasePath,
  ObservationDatabaseMissingError,
  openObservationReader,
  resolveSessionsRoot,
  resolveStateDir,
  type EchoObservationReader,
  type RunLookupResult,
  type RunObservationHeader,
} from "@echo-agent/core";
import { renderRunObservation } from "@echo-agent/core/observability";
import type { Sink } from "./run.ts";
import { startObserveServer } from "./observe/server.ts";

export type ObserveFormat = "text" | "json";

/** `serve` 缺省端口；0 = 随机（测试）。 */
export const OBSERVE_DEFAULT_PORT = 4321;

export type ObserveCommand =
  | Readonly<{ kind: "last"; format: ObserveFormat; body: boolean }>
  | Readonly<{ kind: "show"; runId: string; format: ObserveFormat; body: boolean }>
  | Readonly<{ kind: "export"; runId: string; format: ObserveFormat }>
  | Readonly<{ kind: "health" }>
  | Readonly<{ kind: "serve"; port: number; host: string }>;

export type ObserveOptions = Readonly<{
  /** 会话目录的上一层。缺省 `$ECHO_HOME/sessions`。 */
  stateDir?: string;
  /** 看哪一段。不给 = 最近更新的那一段。 */
  sessionId?: string;
  command: ObserveCommand;
}>;

/** 输出口，与 `run()` 同款：生产是 stdout / stderr，测试是收集器。`signal` 只对 `serve` 有意义：不给就接 SIGINT / SIGTERM。 */
export type ObserveIo = Readonly<{ out: Sink; err: Sink; signal?: AbortSignal }>;

export function observeUsage(name: string): string {
  return `用法：${name} observe <子命令> [选项]

子命令：
  last                     最近一次 run 的观测记录（人读文本）
  show <run-id>            指定 run 的观测记录
  export <run-id>          导出（缺省 --format json；--format text 给人读文本）
  health                   库的位置、各 runtime 已裁决到的 seq、run / record 计数
  serve                    本地只读面板：run 列表 + 时间线 + 摘要，页面轮询 SQLite，agent 跑着也能看；Ctrl+C 停

选项：
  --state-dir <路径>       会话目录的上一层（与主命令同义：缺省 $ECHO_HOME/sessions，再退到 ~/.echo/sessions）
  --session <id>           看哪一段会话（缺省：最近更新的那一段）
  --format <text|json>     输出格式（last / show 缺省 text；export 缺省 json）
  --body                   text 输出里带上每条记录的 body（缺省只有 name / attributes）
  --port <端口>            serve 监听的端口（缺省 ${OBSERVE_DEFAULT_PORT}；0 = 随机）
  --host <地址>            serve 绑定的地址（缺省 127.0.0.1；面板无鉴权，别暴露到局域网）
  -h, --help               显示本帮助

只读已落盘的记录：不启动 agent、不取锁；正在跑的 agent 旁边也能看，看到的是它已 COMMIT 的部分。
退出码：0 找到并打印 / 面板正常退出；1 没有记录 / run 不存在；2 参数错。`;
}

/** 解析 `observe` 之后的 argv。返回 `null` = 打帮助以 0 退出；不认识的一律 throw。 */
export function parseObserveArgs(argv: readonly string[], name: string): ObserveOptions | null {
  if (argv.length === 0 || argv[0] === "-h" || argv[0] === "--help") return null;
  let stateDir: string | undefined;
  let sessionId: string | undefined;
  let format: ObserveFormat | undefined;
  let body = false;
  let port: number | undefined;
  let host: string | undefined;
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const value = (): string => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("-")) throw new Error(`${arg} 后面缺一个值`);
      return v;
    };
    switch (arg) {
      case "--state-dir":
        stateDir = value();
        break;
      case "--session":
        sessionId = value();
        break;
      case "--format": {
        const v = value();
        if (v !== "text" && v !== "json") throw new Error(`--format 只认 text | json，不认识 '${v}'`);
        format = v;
        break;
      }
      case "--body":
        body = true;
        break;
      case "--port": {
        const v = value();
        const n = Number(v);
        if (!Number.isInteger(n) || n < 0 || n > 65535) throw new Error(`--port 要 0–65535 的整数，不认识 '${v}'`);
        port = n;
        break;
      }
      case "--host":
        host = value();
        break;
      case "-h":
      case "--help":
        return null;
      default:
        if (arg.startsWith("-")) throw new Error(`不认识的选项 '${arg}'\n\n${observeUsage(name)}`);
        positional.push(arg);
    }
  }
  const [sub, ...rest] = positional;
  const only = (n: number): void => {
    if (rest.length !== n) throw new Error(`observe ${sub} 需要 ${n} 个参数，给了 ${rest.length} 个\n\n${observeUsage(name)}`);
  };
  if ((port !== undefined || host !== undefined) && sub !== "serve") throw new Error("--port / --host 只对 serve 有意义");
  let command: ObserveCommand;
  switch (sub) {
    case "serve":
      only(0);
      if (format !== undefined || body) throw new Error("serve 没有 --format / --body");
      command = { kind: "serve", port: port ?? OBSERVE_DEFAULT_PORT, host: host ?? "127.0.0.1" };
      break;
    case "last":
      only(0);
      command = { kind: "last", format: format ?? "text", body };
      break;
    case "show":
      only(1);
      command = { kind: "show", runId: rest[0]!, format: format ?? "text", body };
      break;
    case "export":
      only(1);
      if (body) throw new Error("--body 只对 last / show 的 text 输出有意义");
      command = { kind: "export", runId: rest[0]!, format: format ?? "json" };
      break;
    case "health":
      only(0);
      if (format !== undefined || body) throw new Error("health 没有 --format / --body");
      command = { kind: "health" };
      break;
    case undefined:
      throw new Error(`observe 缺子命令\n\n${observeUsage(name)}`);
    default:
      throw new Error(`不认识的子命令 'observe ${sub}'\n\n${observeUsage(name)}`);
  }
  return { ...(stateDir === undefined ? {} : { stateDir }), ...(sessionId === undefined ? {} : { sessionId }), command };
}

function headerLine(h: RunObservationHeader): string {
  return `${h.runId} · ${h.status} · observation ${h.integrity} · source ${h.source.kind} · accepted ${new Date(h.acceptedAt).toISOString()}`;
}

function printLookup(lookup: RunLookupResult, what: string, format: ObserveFormat, body: boolean, io: ObserveIo): number {
  switch (lookup.kind) {
    case "found": {
      const rendered = renderRunObservation(lookup.observation, { format, includeBody: body });
      io.out.write(rendered.content.endsWith("\n") ? rendered.content : `${rendered.content}\n`);
      return 0;
    }
    case "pruned":
      // body 已清、header 还在窗口内（O3b 的 retention 才会产生）：把 header 与 gap 如实打出来，不冒充完整记录
      io.out.write(`${headerLine(lookup.header)}\nbody pruned by retention · gaps ${lookup.gaps.length}\n`);
      return 0;
    case "unknown":
      io.err.write(`${what}：没有这条 run 的记录（从未有过，或已超出 header 保留窗口）\n`);
      return 1;
  }
}

/**
 * `observe` 的入口：argv 是 `observe` 之后的部分。返回退出码，自己不调 `process.exit`（与 `main` 同款）。
 * `name` 只进帮助文本（`echo-agent` 自己，或依赖本包的产品）。
 */
export async function runObserve(argv: readonly string[], name: string, io: ObserveIo = { out: process.stdout, err: process.stderr }): Promise<number> {
  let opts: ObserveOptions | null;
  try {
    opts = parseObserveArgs(argv, name);
  } catch (e) {
    io.err.write(`${e instanceof Error ? e.message : String(e)}\n`);
    return 2;
  }
  if (opts === null) {
    io.out.write(`${observeUsage(name)}\n`);
    return 0;
  }
  const sessionsRoot = expandHome(opts.stateDir ?? resolveSessionsRoot());
  let sessionId = opts.sessionId;
  if (sessionId === undefined) {
    // 观测库归 session：不点名就看**最近更新的那一段**。一段都没有时诚实说没有，
    // 而不是打开一个空目录再报「没有记录」——那两句话指的不是同一件事。
    const sessions = await listSessions(new FileDir(sessionsRoot)); // 已按 updatedAt 降序
    if (sessions.length === 0) {
      io.err.write(`${sessionsRoot} 下还没有任何会话\n`);
      return 1;
    }
    sessionId = sessions[0]!.id;
  }
  const stateRoot = resolveStateDir({ sessionsRoot, sessionId });
  let reader: Awaited<ReturnType<typeof openObservationReader>>;
  try {
    reader = await openObservationReader({ stateRoot });
  } catch (e) {
    if (e instanceof ObservationDatabaseMissingError) {
      io.err.write(`会话 ${sessionId} 还没有任何 run 的观测记录（${observationDatabasePath(stateRoot)} 不存在）\n`);
      return 1;
    }
    io.err.write(`打不开观测库：${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
  try {
    return await execute(opts.command, reader, io, stateRoot);
  } catch (e) {
    io.err.write(`${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  } finally {
    await reader.close();
  }
}

/** `serve` 的退出条件：给了 signal 就等它（测试），否则接 SIGINT / SIGTERM——与 `main` 的「怎么停只有一种回答」一致。 */
function waitForStop(signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (signal !== undefined) {
      if (signal.aborted) {
        resolve();
        return;
      }
      signal.addEventListener("abort", () => resolve(), { once: true });
      return;
    }
    const stop = (): void => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      resolve();
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });
}

async function execute(command: ObserveCommand, reader: Awaited<ReturnType<typeof openObservationReader>>, io: ObserveIo, stateRoot: string): Promise<number> {
  switch (command.kind) {
    case "serve": {
      const server = startObserveServer({ reader, stateRoot, hostname: command.host, port: command.port });
      io.out.write(`observe 面板：${server.url}（只读，agent 跑着也能看；Ctrl+C 停止）\n`);
      try {
        await waitForStop(io.signal);
      } finally {
        await server.stop();
      }
      return 0;
    }
    case "last": {
      const lookup = await reader.lastRun();
      if (lookup.kind === "unknown") {
        io.err.write("库里还没有任何 run\n");
        return 1;
      }
      return printLookup(lookup, "last", command.format, command.body, io);
    }
    case "show":
      return printLookup(await reader.getRun(command.runId), `show ${command.runId}`, command.format, command.body, io);
    case "export":
      return printLookup(await reader.getRun(command.runId), `export ${command.runId}`, command.format, false, io);
    case "health":
      return health(reader, io);
  }
}

async function health(reader: EchoObservationReader & { path: string; runtimeHeads(): Promise<readonly { runtimeId: string; committedPrefix: number }[]>; counts(): Promise<{ runs: number; records: number }> }, io: ObserveIo): Promise<number> {
  const heads = await reader.runtimeHeads();
  const counts = await reader.counts();
  const last = await reader.lastRun();
  const lines = [
    `observation database  ${reader.path}`,
    `runs                  ${counts.runs} · records ${counts.records}`,
    `runtime heads         ${heads.length === 0 ? "(none)" : heads.map((h) => `${h.runtimeId} → committed ${h.committedPrefix}`).join(" · ")}`,
    `last run              ${last.kind === "found" ? headerLine(last.observation) : last.kind === "pruned" ? `${headerLine(last.header)} (pruned)` : "(none)"}`,
    // 活 Runtime 的 phase / persistence / sink health 尚未落盘（O3b）：离线 reader 给不出，明说而不是编一个
    "live runtime health   not persisted yet (O3b); in-process use echo.observations.snapshot()",
  ];
  io.out.write(`${lines.join("\n")}\n`);
  return 0;
}
