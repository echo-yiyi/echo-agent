// worktree 隔离（2026-09-03 用户拍板 B）：`worktree_enter` 在仓库里开一个 git worktree，并把 session 的工作目录
// 切过去——走 core 的 `AgentRuntime.setWorkspace`，**会话不断**（对话、任务清单都还在）；`worktree_exit` 切回
// 主检出，可顺手删掉 worktree。目录固定在 `<仓库根>/.echo/worktrees/<name>`，分支同名、基于本地 HEAD；
// 路径写进 `.git/info/exclude`，不碰 tracked 文件。
//
// core 不解释路径（纯 JS），「是不是 git 仓库、目录在不在」这些宿主知识全在这层。

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { toolError, toolOk, type ModelTool } from "@echo-agent/core";
import type { AgentRuntime } from "@echo-agent/core/extension";

export type WorktreeDeps = {
  /** 给了才能真的切目录（`echo:worktree` 从 `AgentRuntimeService` 拿）；不给的实例只用来报名字（identity）。 */
  runtime?: Pick<AgentRuntime, "setWorkspace">;
};

/** 一组共享的状态：进 worktree 之前的目录。resume 之后没有它，退出时从 `git worktree list` 找主检出。 */
type WorktreeState = { home: string | undefined };

const WORKTREES_DIR = join(".echo", "worktrees");
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** worktree 一组：`worktree_enter`（常驻）+ `worktree_exit`（延迟：进过才用得上）。 */
export function makeWorktreeTools(deps: WorktreeDeps = {}): ModelTool[] {
  const state: WorktreeState = { home: undefined };
  return [enterTool(deps, state), exitTool(deps, state)] as ModelTool[];
}

type GitResult = { ok: true; out: string } | { ok: false; err: string };

function git(cwd: string, args: string[]): Promise<GitResult> {
  return new Promise((resolvePromise) => {
    execFile("git", args, { cwd, encoding: "utf8", maxBuffer: 4_000_000 }, (error, stdout, stderr) => {
      if (error !== null) resolvePromise({ ok: false, err: (stderr.trim() !== "" ? stderr : error.message).trim() });
      else resolvePromise({ ok: true, out: stdout.trim() });
    });
  });
}

/** 在不在本产品开的 worktree 里——按路径判（`…/.echo/worktrees/<name>`），不认别人开的 worktree。 */
function inEchoWorktree(dir: string): boolean {
  return dir.includes(`${sep}${WORKTREES_DIR}${sep}`);
}

/**
 * 把 `.echo/worktrees/` 写进 `.git/info/exclude`（仓库私有、不 tracked）：不然主检出的 `git status`
 * 会把整个 worktree 目录当成未跟踪文件。写不进去不挡路，把原因带回给模型。
 */
async function excludeFromGit(root: string): Promise<string> {
  const p = await git(root, ["rev-parse", "--git-path", "info/exclude"]);
  if (!p.ok) return `\n(could not locate .git/info/exclude: ${p.err})`;
  const file = isAbsolute(p.out) ? p.out : resolve(root, p.out);
  const line = ".echo/worktrees/";
  try {
    const current = existsSync(file) ? await readFile(file, "utf8") : "";
    if (current.split("\n").some((l) => l.trim() === line)) return "";
    await mkdir(dirname(file), { recursive: true });
    await appendFile(file, `${current === "" || current.endsWith("\n") ? "" : "\n"}${line}\n`);
    return "";
  } catch (e) {
    return `\n(could not add ${line} to ${file}: ${e instanceof Error ? e.message : String(e)})`;
  }
}

function enterTool(deps: WorktreeDeps, state: WorktreeState): ModelTool<{ name?: string }> {
  return {
    kind: "model",
    name: "worktree_enter",
    label: "进 worktree",
    description:
      "Create a git worktree for this repository at .echo/worktrees/<name> on a new branch <name> (from the current HEAD) " +
      "and make it the workspace: from then on file tools, search and bash resolve paths there, while the original checkout " +
      "stays untouched. Use it when the work must not disturb the user's working copy or when tasks run in parallel. " +
      "Nothing is installed in the new worktree (no node_modules); run the project's install command if the task needs it. " +
      "Go back with worktree_exit.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Worktree and branch name (letters, digits, . _ -); default: a generated one" },
      },
    },
    async execute({ name }, ctx) {
      if (deps.runtime === undefined) return toolError("This agent cannot switch its workspace (no runtime)");
      if (inEchoWorktree(ctx.workspace)) return toolError(`Already inside a worktree (${ctx.workspace}); worktree_exit first`);
      const top = await git(ctx.workspace, ["rev-parse", "--show-toplevel"]);
      if (!top.ok) return toolError(`Not a git repository: ${ctx.workspace}\n${top.err}`);
      const wtName = name ?? `wt-${Date.now().toString(36)}`;
      if (!NAME_RE.test(wtName)) return toolError(`Invalid worktree name '${wtName}': use letters, digits, '.', '_' or '-'`);
      const root = top.out;
      const path = join(root, WORKTREES_DIR, wtName);
      if (existsSync(path)) return toolError(`${path} already exists; pick another name or remove it first (git worktree remove)`);
      const excludeNote = await excludeFromGit(root);
      const added = await git(root, ["worktree", "add", path, "-b", wtName, "HEAD"]);
      if (!added.ok) return toolError(`git worktree add failed:\n${added.err}`);
      const switched = await deps.runtime.setWorkspace(path);
      if (switched.kind === "rejected") {
        return toolError(`Worktree created at ${path} but the workspace could not be switched: ${switched.reason}`);
      }
      state.home = ctx.workspace;
      const head = await git(path, ["rev-parse", "--short", "HEAD"]);
      return toolOk(
        `Entered worktree ${path} on new branch ${wtName}${head.ok ? ` (from ${head.out})` : ""}. ` +
          `The workspace is now this directory; the checkout at ${root} is untouched. Dependencies are not installed here.${excludeNote}`,
        { path, branch: wtName },
      );
    },
  };
}

function exitTool(deps: WorktreeDeps, state: WorktreeState): ModelTool<{ remove?: boolean }> {
  return {
    kind: "model",
    name: "worktree_exit",
    label: "出 worktree",
    deferred: true,
    description:
      "Leave the worktree entered with worktree_enter: the workspace goes back to the main checkout. " +
      "With remove: true the worktree directory is deleted afterwards (git refuses while it has uncommitted changes); " +
      "the branch is kept either way.",
    parameters: {
      type: "object",
      properties: { remove: { type: "boolean", description: "Delete the worktree directory after leaving (default false)" } },
    },
    async execute({ remove }, ctx) {
      if (deps.runtime === undefined) return toolError("This agent cannot switch its workspace (no runtime)");
      const here = ctx.workspace;
      if (!inEchoWorktree(here)) return toolError(`Not inside a worktree: ${here}`);
      let home = state.home;
      if (home === undefined) {
        // resume 之后没有记忆：`git worktree list` 的第一条就是主检出
        const list = await git(here, ["worktree", "list", "--porcelain"]);
        if (!list.ok) return toolError(`git worktree list failed:\n${list.err}`);
        home = /^worktree (.+)$/m.exec(list.out)?.[1];
        if (home === undefined) return toolError("Could not find the main checkout in git worktree list");
      }
      const branch = await git(here, ["rev-parse", "--abbrev-ref", "HEAD"]);
      const b = branch.ok ? branch.out : "?";
      const switched = await deps.runtime.setWorkspace(home);
      if (switched.kind === "rejected") return toolError(`Could not switch the workspace back to ${home}: ${switched.reason}`);
      state.home = undefined;
      const meta = { path: home, worktree: here, branch: b };
      if (remove !== true) return toolOk(`Back in ${home}. Worktree ${here} kept (branch ${b}).`, { ...meta, removed: false });
      const removed = await git(home, ["worktree", "remove", here]);
      if (!removed.ok) return toolError(`Back in ${home}, but the worktree ${here} was not removed (branch ${b}):\n${removed.err}`);
      return toolOk(`Back in ${home}. Worktree ${here} removed (branch ${b} kept).`, { ...meta, removed: true });
    },
  };
}
