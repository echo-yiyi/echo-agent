// 记忆的**作用域**轴(user / project / session)。分区(agent.md / user.md / 笔记与 INDEX.md)
// 是另一个轴,两者不是笛卡尔积——哪层有哪些分区由 types.ts 的 `scopes` 声明,见
// `docs/decisions/implemented/2026-09-03-memory-three-scopes.md` 的「切法」。
//
// **选层走路径前缀,工具不加参数**(2026-09-07 用户拍板):记忆树里的每条路径都是
// `<scope>/<分区内路径>`——`user/agent.md`、`project/user.md`、`session/memory/x.md`。
// 六动词工具的形状因此一个字都不用改:模型改哪一层,就写哪一层的路径。
//
// 落盘上这三层是**三个不相干的根**(user 在 `<ECHO_HOME>/memory/`、project 在
// `<ECHO_HOME>/projects/<hash>/memory/`、session 在 session 目录的 `memory/` 下),
// 所以这里出一个按第一段路由的 `StorageDir`:上面那层只看见一棵带作用域前缀的树,
// 装配层负责把三个字节面接上(`createAgent` 的 `prepareCapabilities`)。

import type { StorageDir } from "../storage/types.ts";

export type MemoryScope = "user" | "project" | "session";

/**
 * 注入与展示的固定顺序:**user → project → session**(「切法」第 2 条)。
 * 同一分区的多层都渲染、不去重,顺序恒定——顺序漂移会白白打掉 prompt cache。
 */
export const MEMORY_SCOPES: readonly MemoryScope[] = ["user", "project", "session"];

export function isMemoryScope(value: string): value is MemoryScope {
  return value === "user" || value === "project" || value === "session";
}

/** 按 `MEMORY_SCOPES` 的顺序排一遍并去重:声明顺序不影响注入顺序。 */
export function orderScopes(scopes: readonly MemoryScope[]): readonly MemoryScope[] {
  return MEMORY_SCOPES.filter((s) => scopes.includes(s));
}

/**
 * 拆作用域前缀。`user/agent.md` → `{ scope: "user", rest: "agent.md" }`。
 * 第一段不是作用域名、或后面空着 → `null`(**不归任何分区**,写入会被拒并列出可用分区)。
 */
export function splitScopePath(path: string): { scope: MemoryScope; rest: string } | null {
  const i = path.indexOf("/");
  if (i <= 0) return null;
  const head = path.slice(0, i);
  if (!isMemoryScope(head)) return null;
  const rest = path.slice(i + 1);
  if (rest === "") return null;
  return { scope: head, rest };
}

/**
 * 三层各一个字节面,按路径第一段路由。**认不出的第一段 fail-loud**——
 * 悄悄兜到某一层就是「写进了另一个人的记忆而没人发现」。
 *
 * `list` 的返回仍是**可直接 read 的路径**(带作用域前缀),与 `StorageDir.list` 的约定一致;
 * `list("")` 把三层并起来,`view ''` 的分区概览靠它。
 */
export function memoryScopeDir(dirs: Readonly<Record<MemoryScope, StorageDir>>): StorageDir {
  const route = (path: string): { scope: MemoryScope; rest: string } => {
    const at = splitScopePath(path);
    if (at === null) throw new Error(`记忆路径必须以作用域开头(user/、project/、session/):'${path}'`);
    return at;
  };
  return {
    read: (path) => {
      const at = route(path);
      return dirs[at.scope].read(at.rest);
    },
    write: (path, content) => {
      const at = route(path);
      return dirs[at.scope].write(at.rest, content);
    },
    remove: (path) => {
      const at = route(path);
      return dirs[at.scope].remove(at.rest);
    },
    list: async (prefix) => {
      if (prefix === "") {
        const out: string[] = [];
        for (const scope of MEMORY_SCOPES) out.push(...(await dirs[scope].list("")).map((p) => `${scope}/${p}`));
        return out;
      }
      const i = prefix.indexOf("/");
      const head = i < 0 ? prefix : prefix.slice(0, i);
      if (!isMemoryScope(head)) throw new Error(`记忆路径必须以作用域开头(user/、project/、session/):'${prefix}'`);
      const rest = i < 0 ? "" : prefix.slice(i + 1);
      return (await dirs[head].list(rest)).map((p) => `${head}/${p}`);
    },
  };
}

/* ───────────────────────── project 层的目录解析 ───────────────────────── */

/** project 一层都在 home 下这一格里(以后还会放项目级 skill / agent 定义,不只记忆)。 */
export const PROJECTS_DIR = "projects";

/** 目录里那份「我是哪个 workspace」的留痕。哈希只有 48 位,撞了要有人发现。 */
export const WORKSPACE_STAMP_FILE = "workspace.json";

/**
 * FNV-1a 64 位,十六进制 16 位。**自己实现**:core 不引运行时依赖,而这里要的是
 * 一个稳定、无盐、跨进程一致的短名,不是密码学哈希(那是 observability/hash.ts 的活)。
 */
export function fnv1a64hex(input: string): string {
  const PRIME = 0x100000001b3n;
  const MASK = 0xffffffffffffffffn;
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(input)) {
    hash = ((hash ^ BigInt(byte)) * PRIME) & MASK;
  }
  return hash.toString(16).padStart(16, "0");
}

/** `hash = fnv1a64hex(workspace)` 前 12 位(sessions.md §2)。 */
export function projectDirName(workspace: string): string {
  return fnv1a64hex(workspace).slice(0, 12);
}

/** 一个 workspace 的 project 层前缀:`projects/<hash>/`。 */
export function projectPrefix(workspace: string): string {
  return `${PROJECTS_DIR}/${projectDirName(workspace)}/`;
}

/**
 * **打开时对一遍**:目录里那份 `workspace.json` 与本次的 workspace 不一致 = 48 位哈希撞了,
 * 判红(装配当场失败)。不判的话就是两个项目的记忆混在一起而没人发现。
 *
 * 目录还没有留痕(第一次在这个项目里跑)时什么都不做——**留痕由第一次写落**,
 * 见 `withWorkspaceStamp`:装配期租约还没拿到,这一层任何写都是 fail-closed 的。
 */
export async function assertProjectWorkspace(root: StorageDir, prefix: string, workspace: string): Promise<void> {
  const raw = await root.read(`${prefix}${WORKSPACE_STAMP_FILE}`);
  if (raw === null) return;
  let recorded: unknown;
  try {
    recorded = (JSON.parse(raw) as { workspace?: unknown }).workspace;
  } catch (e) {
    throw new Error(`project 层的 ${prefix}${WORKSPACE_STAMP_FILE} 坏了,读不出原路径:${String(e)}`);
  }
  if (recorded !== workspace) {
    throw new Error(
      `project 层目录撞了:${prefix} 记的是 '${String(recorded)}',这一段的 workspace 是 '${workspace}'。` +
        `目录名是 workspace 的 48 位哈希,撞了就是两个项目的记忆混在一起——先挪走那个目录再起。`,
    );
  }
}

/**
 * 第一次往 project 层写东西时顺手把 `workspace.json` 落下。
 *
 * 为什么不在装配期落:那时租约还没到手,`StateWriteGate` 把一切写拒在门外(fail-closed)。
 * 为什么不在读的时候落:没人往这个项目里记过东西,就不该在 home 下留一个空目录。
 * 留痕失败 = 这次记忆写入也失败(不吞):没有留痕的目录下次起来就查不出撞车。
 */
export function withWorkspaceStamp(root: StorageDir, workspace: string): StorageDir {
  let stamped: Promise<void> | undefined;
  const stamp = (): Promise<void> => (stamped ??= root.write(WORKSPACE_STAMP_FILE, JSON.stringify({ workspace })));
  return {
    read: (path) => root.read(path),
    list: (prefix) => root.list(prefix),
    write: async (path, content) => {
      await stamp();
      return root.write(path, content);
    },
    remove: (path) => root.remove(path),
  };
}
