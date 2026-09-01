// bash 工具:前台跑命令;background: true 时挂进 agent.background(core 的后台队列)。
//
// **执行体在这层,队列在 core**——这正是 §5B「队列在 core,跑什么在产品」那句话的落地:
// core 的 startBackground 管闸/缓冲/收摊,这里只填「怎么起一个进程」。

import { startBackground } from "@echo-agent/core/background";
import { spawn } from "node:child_process";
import { toolError, toolOk, type AgentBackground, type AgentToolResult, type ModelTool } from "@echo-agent/core";

const OUTPUT_CAP = 30_000;
const DEFAULT_TIMEOUT_MS = 120_000;

export type BashDeps = {
  /** 给了才支持 background: true(接 agent.background)。 */
  background?: AgentBackground;
};

export function makeBashTool(deps: BashDeps = {}): ModelTool<{ command: string; timeout_ms?: number; background?: boolean }> {
  return {
    kind: "model",
    name: "bash",
    label: "跑命令",
    description:
      "在工作目录跑一条 bash 命令,返回 stdout+stderr(合并)。" +
      "缺省 120s 超时;长活(dev server、watch)用 background: true 挂后台,结果以后台通知回来。",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string" },
        timeout_ms: { type: "number", description: "超时毫秒,缺省 120000" },
        background: { type: "boolean", description: "后台跑(不阻塞本轮)" },
      },
      required: ["command"],
    },
    async execute({ command, timeout_ms, background }, ctx) {
      if (background === true) {
        if (deps.background === undefined) return toolError("本 agent 未接后台队列,不支持 background: true");
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
                else rejectPromise(new Error(`退出码 ${code}`));
              });
            }),
        });
        if (!r.ok) {
          return toolError(
            r.reason === "too_many_running"
              ? `后台已有 ${r.running}/${r.max} 个在跑,先收掉一些`
              : `后台任务总量已满(${r.tasks}/${r.max})`,
          );
        }
        return toolOk(`已挂后台:${r.task.id}(结束后会收到通知)`, { taskId: r.task.id });
      }

      return runForeground(command, ctx.workspace, timeout_ms ?? DEFAULT_TIMEOUT_MS, ctx.signal);
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
      if (truncated || out.length > OUTPUT_CAP) text += `\n…[输出截断:超过 ${OUTPUT_CAP} 字]`;
      if (spawnError !== undefined) {
        resolvePromise(toolError(`命令没能启动:${spawnError}`));
      } else if (timedOut) {
        resolvePromise(toolError(`超时(${timeoutMs}ms),已杀。输出:\n${text}`));
      } else if (signal?.aborted === true) {
        resolvePromise(toolError(`被中止。输出:\n${text}`));
      } else if (code !== 0) {
        // 非零退出是**结果**不是异常——模型要看到输出来决定下一步
        resolvePromise(toolError(`退出码 ${code}\n${text}`, { exitCode: code }));
      } else {
        resolvePromise(toolOk(text === "" ? "(无输出)" : text, { exitCode: 0 }));
      }
    };
    child.on("error", (e) => finish(null, String(e)));
    child.on("close", (code) => finish(code));
  });
}
