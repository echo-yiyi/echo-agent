// shell 一组:bash(前台跑命令;background: true 时挂进 agent.background)+ job_output / job_stop(后台作业的回读与停止)。
//
// **执行体在这层,队列在 core**——这正是「队列在 core,跑什么在产品」那句话的落地:
// core 的 startBackground / getBackground / killBackground 管闸/缓冲/收摊,这里只填「怎么起一个进程」
// 和「怎么把缓冲与取消口摆给模型」。
//
// job_output / job_stop 是 2026-09-01 补的:此前 background: true 起了 dev server / watcher 之后,
// 结果「以后作为通知送达」,模型中途看不到输出、也停不掉——「跑起来看日志再改」这条最常见的循环走不通。

import { getBackground, killBackground, listBackground, startBackground } from "@echo-agent/core/background";
import { spawn } from "node:child_process";
import { toolError, toolOk, type AgentBackground, type AgentToolResult, type ModelTool } from "@echo-agent/core";

const OUTPUT_CAP = 30_000;
const DEFAULT_TIMEOUT_MS = 120_000;
/** job_output 缺省回读的字符数:够看清最近的日志,又不至于一次把缓冲全倒进上下文。 */
const JOB_TAIL_DEFAULT = 4_000;

export type BashDeps = {
  /** 给了才支持 background: true(接 agent.background);job_output / job_stop 也读同一张表。 */
  background?: AgentBackground;
};

/** shell 一组的全部工具。`echo:shell` 注册的与 `codingAgentIdentity()` 列的是**同一份**,不各写各的名单。 */
export function makeShellTools(deps: BashDeps = {}): ModelTool[] {
  return [makeBashTool(deps), jobOutputTool(deps), jobStopTool(deps)] as ModelTool[];
}

export function makeBashTool(deps: BashDeps = {}): ModelTool<{ command: string; timeout_ms?: number; background?: boolean }> {
  return {
    kind: "model",
    name: "bash",
    label: "跑命令",
    description:
      "Run one bash command in the workspace and return stdout and stderr (merged). " +
      "Times out after 120 s by default; for long-running work (dev servers, watchers) pass background: true — " +
      "read its output with job_output, stop it with job_stop, and you are notified when it ends.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string" },
        timeout_ms: { type: "number", description: "Timeout in milliseconds, default 120000" },
        background: { type: "boolean", description: "Run in the background (does not block this turn)" },
      },
      required: ["command"],
    },
    async execute({ command, timeout_ms, background }, ctx) {
      if (background === true) {
        if (deps.background === undefined) return toolError("This agent has no background queue; background: true is not supported");
        const r = startBackground(deps.background, {
          kind: "process",
          label: command.slice(0, 60),
          run: (bg) =>
            new Promise<void>((resolvePromise, rejectPromise) => {
              const child = spawn("bash", ["-lc", command], { cwd: ctx.workspace, stdio: ["ignore", "pipe", "pipe"] });
              child.stdout.on("data", (d: Buffer) => bg.write(d.toString()));
              child.stderr.on("data", (d: Buffer) => bg.write(d.toString()));
              bg.signal.addEventListener("abort", () => child.kill("SIGKILL"), { once: true });
              child.on("error", rejectPromise);
              child.on("close", (code) => {
                if (code === 0 || bg.signal.aborted) resolvePromise();
                else rejectPromise(new Error(`exit code ${code}`));
              });
            }),
        });
        if (!r.ok) {
          return toolError(
            r.reason === "too_many_running"
              ? `${r.running}/${r.max} background jobs are already running; collect some first`
              : `The background queue is full (${r.tasks}/${r.max})`,
          );
        }
        return toolOk(
          `Started in the background: ${r.task.id} (job_output ${r.task.id} to read its output, job_stop to stop it; you will be notified when it finishes)`,
          { taskId: r.task.id },
        );
      }

      return runForeground(command, ctx.workspace, timeout_ms ?? DEFAULT_TIMEOUT_MS, ctx.signal);
    },
  };
}

/** 错误里把已知作业列出来:模型丢了 id（压缩之后常见）也能找回来,不用再多一件 job_list。 */
function knownJobs(bg: AgentBackground): string {
  const all = listBackground(bg.tasks);
  return all.length === 0 ? "there are no background jobs" : `known jobs: ${all.map((t) => `${t.id} [${t.status}] ${t.label}`).join("; ")}`;
}

function jobOutputTool(deps: BashDeps): ModelTool<{ id: string; tail?: number }> {
  return {
    kind: "model",
    name: "job_output",
    label: "看后台输出",
    description:
      "Show the status and the most recent output of a background job started with bash background: true. " +
      "The output is a bounded buffer; tail limits how many trailing characters come back (default 4000).",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "The job id returned by bash" },
        tail: { type: "number", description: "Trailing characters to return, default 4000" },
      },
      required: ["id"],
    },
    async execute({ id, tail }) {
      if (deps.background === undefined) return toolError("This agent has no background queue");
      const task = getBackground(deps.background.tasks, id);
      if (task === undefined) return toolError(`No such job: ${id}; ${knownJobs(deps.background)}`);
      // `tail()` 只看一眼不动游标:结束通知那条路走的是 readNew(),两边互不吃掉对方的增量
      const text = task.buffer.tail(Math.max(1, tail ?? JOB_TAIL_DEFAULT));
      const head = `${task.id} [${task.status}] ${task.label}${task.error === null ? "" : ` — ${task.error}`}`;
      return toolOk(`${head}\n${text === "" ? "(no output yet)" : text}`, { id, status: task.status });
    },
  };
}

function jobStopTool(deps: BashDeps): ModelTool<{ id: string }> {
  return {
    kind: "model",
    name: "job_stop",
    label: "停后台作业",
    description: "Stop a running background job (it is killed). A job that already ended is left as it is.",
    parameters: {
      type: "object",
      properties: { id: { type: "string", description: "The job id returned by bash" } },
      required: ["id"],
    },
    async execute({ id }) {
      if (deps.background === undefined) return toolError("This agent has no background queue");
      const task = getBackground(deps.background.tasks, id);
      if (task === undefined) return toolError(`No such job: ${id}; ${knownJobs(deps.background)}`);
      if (task.status !== "running") return toolOk(`${id} had already ended (${task.status})`, { id, status: task.status });
      const stopped = await killBackground(deps.background.tasks, id);
      return stopped
        ? toolOk(`Stopped ${id} (${task.label})`, { id, status: task.status })
        : toolError(`Could not stop ${id}; it is ${task.status}`);
    },
  };
}

function runForeground(
  command: string,
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<AgentToolResult> {
  return new Promise((resolvePromise) => {
    const child = spawn("bash", ["-lc", command], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let truncated = false;
    const append = (d: Buffer): void => {
      if (out.length >= OUTPUT_CAP) {
        truncated = true;
        return;
      }
      out += d.toString();
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    const onAbort = (): void => {
      child.kill("SIGKILL");
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    const finish = (code: number | null, spawnError?: string): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      let text = out.slice(0, OUTPUT_CAP);
      if (truncated || out.length > OUTPUT_CAP) text += `\n…[output truncated: over ${OUTPUT_CAP} characters]`;
      if (spawnError !== undefined) {
        resolvePromise(toolError(`The command could not start: ${spawnError}`));
      } else if (timedOut) {
        resolvePromise(toolError(`Timed out after ${timeoutMs} ms and was killed. Output:\n${text}`));
      } else if (signal?.aborted === true) {
        resolvePromise(toolError(`Aborted. Output:\n${text}`));
      } else if (code !== 0) {
        // 非零退出是**结果**不是异常——模型要看到输出来决定下一步
        resolvePromise(toolError(`exit code ${code}\n${text}`, { exitCode: code }));
      } else {
        resolvePromise(toolOk(text === "" ? "(no output)" : text, { exitCode: 0 }));
      }
    };
    child.on("error", (e) => finish(null, String(e)));
    child.on("close", (code) => finish(code));
  });
}
