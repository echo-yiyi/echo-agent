// shell 一组:bash(前台跑命令;background: true 时挂进 agent.background)+ job_output / job_stop(后台作业的回读与停止)。
//
// **执行体在这层,队列在 core**——这正是 §5B「队列在 core,跑什么在产品」那句话的落地:
// core 的 startBackground / getBackground / killBackground 管闸/缓冲/收摊,这里只填「怎么起一个进程」
// 和「怎么把缓冲与取消口摆给模型」。
//
// job_output / job_stop 是 2026-09-01 补的:此前 background: true 起了 dev server / watcher 之后,
// 结果「以后作为通知送达」,模型中途看不到输出、也停不掉——「跑起来看日志再改」这条最常见的循环走不通。

import { getBackground, killBackground, listBackground, startBackground } from "@echo-agent/core/background";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { toolError, toolOk, type AgentBackground, type AgentToolResult, type ModelTool } from "@echo-agent/core";

const OUTPUT_CAP = 30_000;
const DEFAULT_TIMEOUT_MS = 120_000;
/** job_output 缺省回读的字符数:够看清最近的日志,又不至于一次把缓冲全倒进上下文。 */
const JOB_TAIL_DEFAULT = 4_000;

/**
 * 工作目录跨调用保留（2026-09-03，照 Claude Code：cd 保留、shell 变量不保留）。
 * 每次前台命令包一层——命令跑完打印 `$PWD` 标记再以原退出码退出；解析到的目录就是下一次的起点（后台命令也从那里起）。
 * 标记用 RS（0x1e）包着,普通输出里不会出现;它只在末尾几百字节里找,输出再长也截不掉它。
 */
const CWD_TAIL_KEEP = 512;
const CWD_MARK_RE = /\u001e__ECHO_CWD__([^\u001e]*)\u001e\n?$/;

export type BashDeps = {
  /** 给了才支持 background: true(接 agent.background);job_output / job_stop 也读同一张表。 */
  background?: AgentBackground;
};

/** shell 一组共享的状态:当前工作目录。`undefined` = 还没 cd 过,用 session 的 workspace。 */
export type ShellState = { cwd: string | undefined };

/** shell 一组的全部工具。`echo:shell` 注册的与 `codingAgentIdentity()` 列的是**同一份**,不各写各的名单。 */
export function makeShellTools(deps: BashDeps = {}): ModelTool[] {
  const state: ShellState = { cwd: undefined };
  return [makeBashTool(deps, state), jobOutputTool(deps), jobStopTool(deps)] as ModelTool[];
}

export function makeBashTool(deps: BashDeps = {}, state: ShellState = { cwd: undefined }): ModelTool<{ command: string; timeout_ms?: number; background?: boolean }> {
  /** 本次命令从哪起：保留的目录还在就用它；被删了就退回 workspace，并把这件事告诉模型。 */
  const startDir = (workspace: string): { cwd: string; note: string } => {
    if (state.cwd === undefined) return { cwd: workspace, note: "" };
    if (existsSync(state.cwd)) return { cwd: state.cwd, note: "" };
    const gone = state.cwd;
    state.cwd = undefined;
    return { cwd: workspace, note: `\n(previous working directory ${gone} no longer exists; back in the workspace root)` };
  };
  return {
    kind: "model",
    name: "bash",
    label: "跑命令",
    description:
      "Run one bash command and return stdout and stderr (merged). The working directory carries over between calls " +
      "(it starts at the workspace root; cd persists), shell variables and functions do not. " +
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
              const child = spawnShell(command, startDir(ctx.workspace).cwd);
              child.stdout!.on("data", (d: Buffer) => bg.write(d.toString()));
              child.stderr!.on("data", (d: Buffer) => bg.write(d.toString()));
              bg.signal.addEventListener("abort", () => killTree(child), { once: true });
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

      const start = startDir(ctx.workspace);
      const result = await runForeground(command, start.cwd, timeout_ms ?? DEFAULT_TIMEOUT_MS, ctx.signal);
      // 命令跑到了末尾才有标记（exec / 被杀 / 语法错都没有）：没有就保持原来的目录
      const changed = result.cwd !== undefined && result.cwd !== start.cwd;
      if (result.cwd !== undefined) state.cwd = result.cwd === ctx.workspace ? undefined : result.cwd;
      const note = `${start.note}${changed ? `\n(working directory is now ${result.cwd})` : ""}`;
      return note === "" ? result : { ...result, content: `${result.content}${note}` };
    },
  };
}

/** 把命令包一层：跑完打印 `$PWD` 标记、再以命令自己的退出码退出。`{ … }` 分组让多行命令与末尾注释都成立。 */
function withCwdMarker(command: string): string {
  return `{\n${command}\n}\n__echo_rc=$?\nprintf '\\n\\036__ECHO_CWD__%s\\036\\n' "$PWD"\nexit $__echo_rc`;
}

/**
 * 起 shell 时自成一个进程组（detached）：杀的时候按组杀（{@link killTree}）。
 * 不然 `sleep 10`、dev server 这类由 bash 再起的子进程会活过 bash，攥着输出管道不放——超时/中止要等它自己结束，job_stop 也留孤儿。
 */
function spawnShell(command: string, cwd: string): ChildProcess {
  return spawn("bash", ["-lc", command], { cwd, stdio: ["ignore", "pipe", "pipe"], detached: true });
}

function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
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
): Promise<AgentToolResult & { cwd?: string }> {
  return new Promise((resolvePromise) => {
    const child = spawnShell(withCwdMarker(command), cwd);
    let out = "";
    let truncated = false;
    let tail = ""; // 末尾几百字节单独留着：cwd 标记在这里找，输出被截断也丢不了
    const append = (d: Buffer): void => {
      const chunk = d.toString();
      tail = (tail + chunk).slice(-CWD_TAIL_KEEP);
      if (out.length >= OUTPUT_CAP) {
        truncated = true;
        return;
      }
      out += chunk;
    };
    child.stdout!.on("data", append);
    child.stderr!.on("data", append);

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);
    const onAbort = (): void => {
      killTree(child);
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    const finish = (code: number | null, spawnError?: string): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      // 先把 cwd 标记摘出来（在 tail 里），再从正文里剥掉——正文没被截断时标记就在正文末尾
      const marked = CWD_MARK_RE.exec(tail);
      const newCwd = marked?.[1];
      const body = marked === null ? out : out.replace(CWD_MARK_RE, "").replace(/\n$/, "");
      let text = body.slice(0, OUTPUT_CAP);
      if (truncated || body.length > OUTPUT_CAP) text += `\n…[output truncated: over ${OUTPUT_CAP} characters]`;
      const withCwd = (r: AgentToolResult): AgentToolResult & { cwd?: string } => (newCwd === undefined ? r : { ...r, cwd: newCwd });
      if (spawnError !== undefined) {
        resolvePromise(toolError(`The command could not start: ${spawnError}`));
      } else if (timedOut) {
        resolvePromise(toolError(`Timed out after ${timeoutMs} ms and was killed. Output:\n${text}`));
      } else if (signal?.aborted === true) {
        resolvePromise(toolError(`Aborted. Output:\n${text}`));
      } else if (code !== 0) {
        // 非零退出是**结果**不是异常——模型要看到输出来决定下一步
        resolvePromise(withCwd(toolError(`exit code ${code}\n${text}`, { exitCode: code })));
      } else {
        resolvePromise(withCwd(toolOk(text === "" ? "(no output)" : text, { exitCode: 0 })));
      }
    };
    child.on("error", (e) => finish(null, String(e)));
    child.on("close", (code) => finish(code));
  });
}
