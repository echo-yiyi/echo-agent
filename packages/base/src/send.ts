// `send` 子命令（2026-11-16）：从同一台机器（同一个容器）里的别的进程，往一段会话的 inbox 投一句话，
// 让那段常驻的 agent 去做——运维后台、脚本、cron 用。
//
// 与 `observe` 同款：不装配 agent、不取锁、不看凭据。内部是 core 的 `openSessionIngress()`，投进去的是一条用户消息
// （agent 当成用户的话执行）。投递语义见那边：落盘才算 accepted；同一个 `--dedupe` 的那条还没处理完时不重复投。

import { randomUUID } from "node:crypto";
import { expandHome, openSessionIngress, resolveSessionsRoot, userMessage } from "@echo-agent/core";
import type { Sink } from "./run.ts";

/** `send` 解析出来的参数。 */
export type SendCommandOptions = Readonly<{
  /** 会话目录的上一层（与主命令的 `--state-dir` 同义）。 */
  stateDir?: string;
  sessionId: string;
  /** 去重键。不给就每次生成一个新的（等于不去重）。 */
  dedupeKey?: string;
  text: string;
}>;

/** 输出口：生产是 stdout / stderr，测试是收集器。 */
export type SendIo = Readonly<{ out: Sink; err: Sink }>;

export function sendUsage(name: string): string {
  return `用法：${name} send <会话 id> [选项] <要它做的事>

往一段会话的 inbox 投一句话，那段会话的 agent 把它当成用户的话去做。给同一台机器（同一个容器）里的
别的进程用：运维后台、脚本、cron。不启动 agent、不取锁。
会话正在跑：它空下来就处理（每秒看一次 inbox）；没在跑：消息存着，它下次起来时处理。

选项：
  --state-dir <路径>   会话目录的上一层（与主命令同义：缺省 $ECHO_HOME/sessions，再退到 ~/.echo/sessions）
  --dedupe <键>        去重键：同一个键的那条还没处理完时，再投不会多出一条（重试时带上同一个键）。
                       不给就每次都是新的一条
  -h, --help           显示本帮助

成功时 stdout 打一行投进去的记录 id。
退出码：0 投进去了（或同一个键的那条还在等处理）；1 没投进去（会话不存在、已关、写不进盘）；2 参数错。`;
}

/** 解析 `send` 之后的 argv。返回 `null` = 打帮助以 0 退出；不认识的一律 throw。 */
export function parseSendArgs(argv: readonly string[]): SendCommandOptions | null {
  if (argv.length === 0 || argv[0] === "-h" || argv[0] === "--help") return null;
  let stateDir: string | undefined;
  let dedupeKey: string | undefined;
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
      case "--dedupe":
        dedupeKey = value();
        break;
      case "-h":
      case "--help":
        return null;
      default:
        if (arg.startsWith("-")) throw new Error(`不认识的选项：${arg}`);
        positional.push(arg);
    }
  }
  const [sessionId, ...words] = positional;
  if (sessionId === undefined) throw new Error("缺会话 id");
  const text = words.join(" ").trim();
  if (text === "") throw new Error("缺要它做的事（会话 id 后面的文字）");
  return { sessionId, text, ...(stateDir !== undefined ? { stateDir } : {}), ...(dedupeKey !== undefined ? { dedupeKey } : {}) };
}

/** 跑 `send`：返回退出码。 */
export async function runSend(argv: readonly string[], name: string, io: SendIo = { out: process.stdout, err: process.stderr }): Promise<number> {
  let opts: SendCommandOptions | null;
  try {
    opts = parseSendArgs(argv);
  } catch (e) {
    io.err.write(`${e instanceof Error ? e.message : String(e)}\n\n${sendUsage(name)}\n`);
    return 2;
  }
  if (opts === null) {
    io.out.write(`${sendUsage(name)}\n`);
    return 0;
  }
  const sessionsRoot = expandHome(opts.stateDir ?? resolveSessionsRoot());
  let inbox: Awaited<ReturnType<typeof openSessionIngress>>;
  try {
    inbox = await openSessionIngress({ sessionsRoot, sessionId: opts.sessionId });
  } catch (e) {
    io.err.write(`${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
  const result = await inbox.deliverDurable({ message: userMessage(opts.text), dedupeKey: opts.dedupeKey ?? `send:${randomUUID()}` });
  if (result.kind === "rejected") {
    io.err.write(`没投进去（${result.reason}${result.errorDigest === undefined ? "" : `：${result.errorDigest}`}）\n`);
    return 1;
  }
  if (result.deduplicated) io.err.write(`同一个 --dedupe 的那条还没处理完，这次没有再投一条\n`);
  io.out.write(`${result.recordId}\n`);
  return 0;
}
