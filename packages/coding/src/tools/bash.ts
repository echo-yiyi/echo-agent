// shell 一组:bash(前台跑命令;background: true 时挂进 agent.background)+ job_output / job_stop(后台作业的回读与停止)。
//
// **执行体在这层,队列在 core**——这正是「队列在 core,跑什么在产品」那句话的落地:
// core 的 startBackground / getBackground / killBackground 管闸/缓冲/收摊,这里只填「怎么起一个进程」
// 和「怎么把缓冲与取消口摆给模型」。
//
// job_output / job_stop 是 2026-09-01 补的:此前 background: true 起了 dev server / watcher 之后,
// 结果「以后作为通知送达」,模型中途看不到输出、也停不掉——「跑起来看日志再改」这条最常见的循环走不通。

import { getBackground, killBackground, listBackground, startBackground } from "@echo-agent/core/background";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { toolError, toolOk, type AgentBackground, type AgentToolResult, type ModelTool } from "@echo-agent/core";

/** 命令跑在什么环境里：`tool:shell` 段据此写明平台与 bash 版本（macOS 的 BSD 工具链、bash 3.2 的缺口）。 */
export type ShellEnvironment = { platform: NodeJS.Platform; bashVersion: string | null };

/**
 * 取一次运行环境：平台读 `process.platform`，bash 版本问一次 `bash` 自己（`$BASH_VERSION` 去掉括号后缀）。
 * 装配时调（`echo:shell` 的 apply），不是每轮——段在 run 之间不变，前缀缓存才接得上。问不出来版本 = null。
 */
export function detectShellEnvironment(): ShellEnvironment {
  let bashVersion: string | null = null;
  try {
    const r = spawnSync("bash", ["-c", 'printf %s "$BASH_VERSION"'], { encoding: "utf8", timeout: 2_000, stdio: ["ignore", "pipe", "ignore"] });
    const v = /^\d+(\.\d+)*/.exec(r.stdout ?? "")?.[0];
    if (r.status === 0 && v !== undefined) bashVersion = v;
  } catch {
    // 没有 bash：段里只写平台
  }
  return { platform: process.platform, bashVersion };
}

/**
 * 前台命令最多收这么多字符（2026-11-02）：不再在这里截到 30,000 丢掉后半——报错多在末尾。
 * 收全了交给 core：超过内联上限时全文外存、对话里只留头尾预览（`@echo-agent/core` 的工具结果外存）。
 * 这个上限只防内存失控。
 */
const CAPTURE_CAP = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;
/** job_output 缺省回读的字符数:够看清最近的日志,又不至于一次把缓冲全倒进上下文。 */
const JOB_TAIL_DEFAULT = 4_000;

/**
 * 工作目录跨调用保留（2026-09-03，照 Claude Code：cd 保留、shell 变量不保留）。
 * 每次前台命令包一层——命令跑完打印 `$PWD` 标记再以原退出码退出；解析到的目录就是下一次的起点（后台命令也从那里起）。
 * 标记用 RS（0x1e）包着,普通输出里不会出现。找**最后一个**标记、不要求它在末尾：`cmd &` 起的后台进程可能在标记之后
 * 还写了几行。正文被截断时标记在截断点之后，另在末尾几百字节里留了一份。
 */
const CWD_TAIL_KEEP = 512;
const CWD_MARK = "\u001e__ECHO_CWD__";

/**
 * 主 shell 退出之后等输出管道关的时间：管道里剩下的输出读完就关（通常几毫秒）；关不上说明命令起的后台进程
 * （`cmd &`）还攥着它——那就不等了，收尾返回已有输出并说明，后台进程不杀。窗口在有输出到达时顺延（主进程退出前
 * 写进管道的最后一截还在路上），但总共不超过 `DRAIN_MAX_MS`，一直在写的后台进程拖不住这一次调用。
 */
// 500 而不是 100（2026-11-09）：慢机器上起一个子进程就要一两百毫秒（macOS CI 实测 `(sleep 0.02; echo late) &` 的输出
// 连着两次赶不上 100 ms），刚起的后台子进程写完的那几行会被当成「攥着输出」丢掉。只有留了后台进程的那次调用多等，封顶仍是 DRAIN_MAX_MS
const DRAIN_IDLE_MS = 500;
const DRAIN_MAX_MS = 1_000;

/**
 * 子进程的环境：继承父进程（`bash -c`，不读 profile），再关掉会等人的东西——没有 TTY、stdin 已关，
 * 编辑器 / 分页器 / 凭据提示只会挂到超时、什么也不输出。取舍照 codex 给子进程设的非交互变量：
 * - `GIT_EDITOR=true`：commit / merge / rebase --continue 不开编辑器——带着现成的消息走，没有消息就因空消息中止；
 * - `GIT_PAGER` / `PAGER` / `GH_PAGER` = `cat`：输出直接出来，不进分页器；
 * - `GIT_TERMINAL_PROMPT=0`：要账号密码时直接失败，不等输入。
 * `EDITOR` / `VISUAL` 不动：git 先认 `GIT_EDITOR`，别的程序要编辑器时失败比被换成 `true` 静默「编辑成功」更好懂。
 */
const NON_INTERACTIVE_ENV = {
  GIT_EDITOR: "true",
  GIT_PAGER: "cat",
  PAGER: "cat",
  GH_PAGER: "cat",
  GIT_TERMINAL_PROMPT: "0",
} as const;

export type BashDeps = {
  /** 给了才支持 background: true(接 agent.background);job_output / job_stop 也读同一张表。 */
  background?: AgentBackground;
};

/**
 * shell 一组共享的状态:当前工作目录,以及它是在哪个 workspace 下记的。`cwd` 为 `undefined` = 还没 cd 过,
 * 用 session 的 workspace;workspace 变了(worktree 隔离切了目录)cwd 作废,从新 workspace 起。
 */
export type ShellState = { cwd: string | undefined; workspace: string | undefined };

/** shell 一组的全部工具。`echo:shell` 注册的与 `codingAgentIdentity()` 列的是**同一份**,不各写各的名单。 */
export function makeShellTools(deps: BashDeps = {}): ModelTool[] {
  const state: ShellState = { cwd: undefined, workspace: undefined };
  return [makeBashTool(deps, state), jobOutputTool(deps), jobStopTool(deps)] as ModelTool[];
}

export function makeBashTool(
  deps: BashDeps = {},
  state: ShellState = { cwd: undefined, workspace: undefined },
): ModelTool<{ command: string; timeout_ms?: number; background?: boolean }> {
  /** 本次命令从哪起：保留的目录还在就用它；workspace 换了或目录被删了就退回 workspace（后者要告诉模型）。 */
  const startDir = (workspace: string): { cwd: string; note: string } => {
    if (state.workspace !== workspace) {
      state.workspace = workspace;
      state.cwd = undefined;
    }
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
      "Run one bash command (bash -c, not a login shell; it inherits this process's environment) and return stdout and stderr (merged). " +
      "There is no terminal and stdin is closed: use non-interactive flags (git commit -m, --yes); git's editor and pager are turned off. " +
      "The working directory carries over between calls (it starts at the workspace root; cd persists), shell variables and functions do not. " +
      "Times out after 120 s by default; for long-running work (dev servers, watchers) pass background: true — " +
      "read its output with job_output, stop it with job_stop, and you are notified when it ends. Do not use a trailing & for that: " +
      "the call returns once the command exits and the background process's later output is lost. " +
      "For files in the workspace use read_file, edit_file / write_file, grep and glob instead of cat, sed, echo >, find or rg.",
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
              // 每条流一只流式 decoder：跨 chunk 的多字节字符不再被解成替换符（review 2026-09-07）
              const outDec = new TextDecoder();
              const errDec = new TextDecoder();
              child.stdout!.on("data", (d: Buffer) => bg.write(outDec.decode(d, { stream: true })));
              child.stderr!.on("data", (d: Buffer) => bg.write(errDec.decode(d, { stream: true })));
              bg.signal.addEventListener("abort", () => killTree(child), { once: true });
              child.on("error", rejectPromise);
              child.on("close", (code) => {
                bg.write(outDec.decode()); // 冲残余
                bg.write(errDec.decode());
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
 *
 * `bash -c`，不是登录 shell：登录 shell 会读 profile，macOS 上 `path_helper` 还会把系统目录排到 PATH 前面，
 * 用户装的 git / ruby / node 就变成了系统那一份。命令看到的环境与启动 echo-coding 的那个 shell 一致。
 * `PWD` 例外，设成本次的起点：继承来的是父进程的目录，bash 发现它不指向当前目录就改用物理路径——
 * 工作区经软链时（macOS 的 `/var` → `/private/var`）`$PWD` 成了展开后的路径，第一条命令就被当成「cd 过了」。
 */
function spawnShell(command: string, cwd: string): ChildProcess {
  return spawn("bash", ["-c", command], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
    env: { ...process.env, ...NON_INTERACTIVE_ENV, PWD: cwd },
  });
}

/** 输出里摘掉最后一个 cwd 标记（连同它前后各一个换行），返回标记里的目录。没有标记 = 命令没跑到末尾（exec / 被杀 / 语法错）。 */
function takeCwdMarker(text: string): { cwd?: string; body: string } {
  const at = text.lastIndexOf(CWD_MARK);
  if (at < 0) return { body: text };
  const end = text.indexOf("\u001e", at + CWD_MARK.length);
  if (end < 0) return { body: text };
  const before = text.slice(0, at);
  const after = text.slice(end + 1);
  return {
    cwd: text.slice(at + CWD_MARK.length, end),
    body: (before.endsWith("\n") ? before.slice(0, -1) : before) + (after.startsWith("\n") ? after.slice(1) : after),
  };
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
    const append = (chunk: string): void => {
      tail = (tail + chunk).slice(-CWD_TAIL_KEEP);
      if (out.length >= CAPTURE_CAP) {
        truncated = true;
        return;
      }
      out += chunk;
    };
    // 主 shell 退出之后的排空窗口（见 `DRAIN_IDLE_MS`）：有输出到达就顺延，总长封顶
    let exited = false;
    let exitCode: number | null = null;
    let drainIdle: ReturnType<typeof setTimeout> | undefined;
    let drainMax: ReturnType<typeof setTimeout> | undefined;
    const armDrain = (): void => {
      clearTimeout(drainIdle);
      drainIdle = setTimeout(() => finish(exitCode, { held: true }), DRAIN_IDLE_MS);
    };
    // 每条流一只流式 decoder：跨 chunk 的多字节字符不再被解成替换符（review 2026-09-07：此前逐块 toString）
    const outDec = new TextDecoder();
    const errDec = new TextDecoder();
    const onData = (dec: TextDecoder) => (d: Buffer): void => {
      append(dec.decode(d, { stream: true }));
      if (exited) armDrain();
    };
    child.stdout!.on("data", onData(outDec));
    child.stderr!.on("data", onData(errDec));

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);
    const onAbort = (): void => {
      killTree(child);
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    let settled = false;
    const finish = (code: number | null, how: { spawnError?: string; held?: boolean } = {}): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(drainIdle);
      clearTimeout(drainMax);
      signal?.removeEventListener("abort", onAbort);
      if (how.held === true) {
        // 后台进程还攥着管道：我们这头不读了。进程本身不杀——它是命令有意起的
        child.stdout?.destroy();
        child.stderr?.destroy();
      }
      append(outDec.decode()); // 冲残余
      append(errDec.decode());
      // cwd 标记：正文里有就从正文摘（连同它前后各一个换行）；正文被截断、标记落在截断点之后，就从末尾那份里找
      const taken = takeCwdMarker(out);
      const newCwd = taken.cwd ?? takeCwdMarker(tail).cwd;
      const body = taken.body;
      let text = body.slice(0, CAPTURE_CAP);
      if (truncated || body.length > CAPTURE_CAP) text += `\n…[output truncated: over ${CAPTURE_CAP} characters]`;
      if (how.held === true) {
        text +=
          "\n(a background process started by this command is still running and holding the output; what it prints from now on is not captured. " +
          "Use background: true for long-running processes.)";
      }
      const withCwd = (r: AgentToolResult): AgentToolResult & { cwd?: string } => (newCwd === undefined ? r : { ...r, cwd: newCwd });
      if (how.spawnError !== undefined) {
        resolvePromise(toolError(`The command could not start: ${how.spawnError}`));
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
    child.on("error", (e) => finish(null, { spawnError: String(e) }));
    child.on("exit", (code) => {
      // 命令本身结束了：超时不再适用（剩下的只可能是它起的后台进程），进入排空窗口
      exited = true;
      exitCode = code;
      clearTimeout(timer);
      armDrain();
      drainMax = setTimeout(() => finish(code, { held: true }), DRAIN_MAX_MS);
    });
    child.on("close", (code) => finish(code ?? exitCode));
  });
}
