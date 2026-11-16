// bash 的执行后端（2026-11-15）：命令直接起，还是包进操作系统的沙箱里起。
//
// 沙箱第一期只限**写**，外加一处读：命令只能写工作区、临时目录与几个包管理器缓存，读不到 echo 自己的凭据文件；
// 读别处、出网照旧。macOS 用系统自带的 `sandbox-exec`，Linux 用 bubblewrap（`bwrap`）。
//
// **没有可用的沙箱时不悄悄退回直接起**：带沙箱的那次 bash 拒跑并说明原因，模型要带 `sandbox: false` 重跑——
// 那一步明着写在参数里，看得见它是在沙箱外跑：内核的安全分类器开着时由它判，关着时 echo-coding 的权限规则让人看。
// 容器里（bubblewrap 通常起不来）走的就是这条路：每条命令都带 `sandbox: false`、每条都过分类器（或问人）。

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CREDENTIALS_FILE, echoHome } from "@echo-agent/core";

/** 一次 bash 从哪起、在哪个工作区里。 */
export type ShellLaunchSite = { readonly cwd: string; readonly workspace: string };

/**
 * bash 的执行后端：给一条 `bash -c` 的 argv，返回真正要起的 argv。起不了（沙箱不可用）返回原因。
 * `sandboxed` 说明它是不是沙箱——不是的话 bash 工具不出 `sandbox` 参数。
 */
export type ShellBackend = {
  /** 人读名，写进 prompt 与报错。 */
  readonly name: string;
  readonly sandboxed: boolean;
  argv(bash: readonly string[], at: ShellLaunchSite): { ok: true; argv: readonly string[] } | { ok: false; reason: string };
};

/** 直接起，不包。 */
export const DIRECT_BACKEND: ShellBackend = Object.freeze({
  name: "direct",
  sandboxed: false,
  argv: (bash: readonly string[]) => ({ ok: true as const, argv: bash }),
});

/** 包管理器的缓存目录（相对 home）。存在才放开：装依赖、跑构建要写它们，写这里不影响别的项目的行为。 */
const CACHE_DIRS = [
  ".bun/install/cache",
  ".npm",
  ".cache",
  "Library/Caches",
  ".cargo/registry",
  ".cargo/git",
  "go/pkg/mod",
  ".gradle/caches",
  ".m2/repository",
  ".pnpm-store",
  ".yarn/berry/cache",
];

/**
 * 这次命令可写的目录：工作区（git worktree 还要它的公共 `.git`，提交写在那里）、临时目录、存在的缓存目录。
 * 一律取真实路径（macOS 的 `/var` → `/private/var`，沙箱按真实路径判）。
 */
export function writableRoots(workspace: string, home = homedir()): string[] {
  const roots = new Set<string>();
  const add = (p: string): void => {
    try {
      roots.add(realpathSync(p));
    } catch {
      // 不存在就不放开
    }
  };
  add(workspace);
  const common = worktreeCommonGitDir(workspace);
  if (common !== undefined) add(common);
  add(tmpdir());
  add("/tmp");
  if (process.env.TMPDIR !== undefined && process.env.TMPDIR !== "") add(process.env.TMPDIR);
  for (const d of CACHE_DIRS) add(join(home, d));
  return [...roots];
}

/** 工作区是 git worktree 时（`.git` 是个文件：`gitdir: <主仓库>/.git/worktrees/<名>`），返回主仓库的 `.git`。 */
function worktreeCommonGitDir(workspace: string): string | undefined {
  const dotGit = join(workspace, ".git");
  try {
    if (!statSync(dotGit).isFile()) return undefined;
    const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf8"));
    if (m === null) return undefined;
    const gitdir = m[1]!.trim();
    // <common>/.git/worktrees/<name> → <common>/.git
    return dirname(dirname(gitdir));
  } catch {
    return undefined;
  }
}

/** 命令读不到的文件：echo 自己的凭据（各家模型的 key 都在里面）。存在才挡（bubblewrap 要盖的目标必须存在）。 */
export function secretFiles(): string[] {
  const out = new Set<string>();
  const file = join(echoHome(), CREDENTIALS_FILE);
  if (existsSync(file)) {
    out.add(file);
    try {
      out.add(realpathSync(file));
    } catch {
      // 读不到真实路径就只挡字面那一个
    }
  }
  return [...out];
}

/**
 * macOS 的沙箱规则（SBPL）。路径一律经 `-D` 参数传进来、规则里用 `(param "…")` 取，不拼进规则文本——
 * 路径里的引号、括号就改不了规则。缺省全放行，再收掉写（只留可写目录与几个设备文件）和凭据文件的读。
 */
export function macProfile(writable: number, secrets: number): string {
  const lines = [
    "(version 1)",
    "(allow default)",
    "(deny file-write*)",
    "(allow file-write*",
    '  (literal "/dev/null") (literal "/dev/zero") (literal "/dev/tty") (literal "/dev/dtracehelper")',
    '  (regex #"^/dev/fd/") (regex #"^/dev/ttys")',
    ...Array.from({ length: writable }, (_, i) => `  (subpath (param "W${i}"))`),
    ")",
  ];
  if (secrets > 0) lines.push(`(deny file-read* ${Array.from({ length: secrets }, (_, i) => `(literal (param "S${i}"))`).join(" ")})`);
  return lines.join("\n");
}

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

function macBackend(): ShellBackend {
  return {
    name: "macOS sandbox-exec",
    sandboxed: true,
    argv(bash, at) {
      const writable = writableRoots(at.workspace);
      const secrets = secretFiles();
      const params = [...writable.map((p, i) => ["-D", `W${i}=${p}`]), ...secrets.map((p, i) => ["-D", `S${i}=${p}`])].flat();
      return { ok: true, argv: [SANDBOX_EXEC, "-p", macProfile(writable.length, secrets.length), ...params, ...bash] };
    },
  };
}

function bwrapBackend(bin: string): ShellBackend {
  return {
    name: "bubblewrap",
    sandboxed: true,
    argv(bash, at) {
      const binds = writableRoots(at.workspace).flatMap((p) => ["--bind", p, p]);
      const hidden = secretFiles().flatMap((p) => ["--ro-bind", "/dev/null", p]);
      // 整个根只读挂进来，/dev 照原样（设备文件要能写），可写目录逐个盖成可写；凭据文件盖成空文件
      return { ok: true, argv: [bin, "--ro-bind", "/", "/", "--dev-bind", "/dev", "/dev", ...binds, ...hidden, "--chdir", at.cwd, "--", ...bash] };
    },
  };
}

/** 没有可用沙箱：每次都说明原因。 */
function unavailable(reason: string): ShellBackend {
  return {
    name: "unavailable",
    sandboxed: true,
    argv: () => ({ ok: false, reason }),
  };
}

/**
 * 找这台机器上能用的沙箱：真跑一条 `true` 试过才算（bubblewrap 装了但用户命名空间被禁、容器里起不来，都在这一步发现）。
 * 装配时调一次。
 */
export function detectSandbox(platform: NodeJS.Platform = process.platform): ShellBackend {
  if (platform === "darwin") {
    if (!existsSync(SANDBOX_EXEC)) return unavailable(`${SANDBOX_EXEC} is missing`);
    const probe = spawnSync(SANDBOX_EXEC, ["-p", "(version 1)(allow default)", "/usr/bin/true"], { stdio: "ignore", timeout: 5_000 });
    return probe.status === 0 ? macBackend() : unavailable(`sandbox-exec does not run here (exit ${String(probe.status)})`);
  }
  if (platform === "linux") {
    const probe = spawnSync("bwrap", ["--ro-bind", "/", "/", "--dev-bind", "/dev", "/dev", "true"], { stdio: "ignore", timeout: 5_000 });
    if (probe.error !== undefined) return unavailable("bubblewrap (bwrap) is not installed");
    return probe.status === 0 ? bwrapBackend("bwrap") : unavailable(`bubblewrap cannot create a sandbox here (exit ${String(probe.status)}; containers usually block it)`);
  }
  return unavailable(`no sandbox is supported on ${platform}`);
}
