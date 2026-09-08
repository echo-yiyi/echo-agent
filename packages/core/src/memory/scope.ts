// 记忆的**作用域**轴。模块(记的是什么)是另一个轴,两者不是笛卡尔积——哪层有哪些模块由
// types.ts 的 `scopes` 声明,见 `docs/decisions/implemented/2026-09-07-memory-scopes-by-product.md`。
//
// **core 不认识任何具体层名**(2026-09-07 用户拍板)。它只定义"作用域"这个位置:一个有序的、
// 各带一个根的命名集合。名字、前缀、有几层全由**产品在装配期声明**——不同产品要的分层本来
// 就不一样(coding 要 user / role / project,常驻产品要产品级 / role)。所以本文件里不出现
// 任何具体层名,缺省那份声明属于装配层(`create-agent.ts`),与"能力层不带落盘默认件"同一条。
//
// **声明是纯数据,不是回调**:`MemoryScopeDef` 可 JSON 序列化,能写进配置文件或 markdown
// frontmatter——与 types.ts 开头那条"Memory 是配置,不是对象机器"同一个理由。锚点闭合、
// 变量闭合、名字开放:core 只认这几个起点和这几个变量,取值是产品的。
//
// 落盘上每一层是一个不相干的根,所以这里出一个按第一段路由的 `StorageDir`:上面那层只看见
// 一棵带作用域前缀的树,装配层负责把各层的字节面接上。

import type { StorageDir } from "../storage/types.ts";

/** 层名。**开放集合**——合法与否由当前的作用域表说了算,不由类型说了算。 */
export type MemoryScope = string;

/* ───────────────────────── 声明(产品给) ───────────────────────── */

/**
 * 落盘锚点。**闭合**:core 只认这几个起点。
 *
 * 从锚点到字节面的解析归装配层(它才有 `node:` 与各个 store);core 只定义有哪几种起点,
 * 以及它们各自要什么事实。
 */
export type MemoryAnchor =
  /** `<ECHO_HOME>`(缺省 `~/.echo`)。 */
  | Readonly<{ kind: "home" }>
  /** 这段 session 的 workspace。 */
  | Readonly<{ kind: "workspace" }>
  /** `<ECHO_HOME>/agents/<角色名>/`。**没有角色名时这一层不存在**(见 `resolveMemoryScopes`)。 */
  | Readonly<{ kind: "agent" }>
  /** 指定地址(绝对路径)。 */
  | Readonly<{ kind: "path"; path: string }>;

/**
 * 一层的声明。`name` 是模型看见的路径第一段,`order` 同时是注入顺序与**宽度序**(小 = 宽),
 * `describe` 是给模型的一句话"这一层谁看得见"——core 不认识层名,却靠这句话拼得出选层说明。
 */
export type MemoryScopeDef = Readonly<{
  name: string;
  order: number;
  describe: string;
  anchor: MemoryAnchor;
  /** 锚点下的相对前缀,支持 `{{}}` 变量;恒以 `/` 结尾。 */
  prefix: string;
  /**
   * 挂 `workspace.json` 留痕 + 打开时对一遍。**显式开,不按变量推断**:只有"把长路径缩成短
   * 哈希"的前缀才有撞车风险,而隐式挂会让产品在不知情时被塞一个文件、还可能因此判红。
   */
  stamp?: boolean;
}>;

/** 解析作用域要的那组事实。**权威值要到 session 加载完才有**,所以解析发生在那之后。 */
export type MemoryScopeFacts = Readonly<{
  workspace: string;
  /** `AgentRef.name`。**可选**——没有角色名的 session 就没有 `agent` 锚点的那些层。 */
  role?: string;
  product: string;
  sessionId: string;
}>;

/* ───────────────────────── 变量 ───────────────────────── */

/** 前缀里认得的变量,**闭合**。`{{role}}` 不设——它和 `agent` 锚点是同一件事的两种写法。 */
export const MEMORY_PREFIX_VARIABLES = ["workspaceHash", "workspace", "product", "sessionId"] as const;

export type MemoryPrefixVariable = (typeof MEMORY_PREFIX_VARIABLES)[number];

/** 路径段消毒:变量值(以及角色名这类外部来的名字)可能含 `/`、`..`、控制字符,直接拼进前缀就是越界。 */
export function safeScopeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "_") || "_";
}

/**
 * 展开前缀里的 `{{}}` 变量。认不出的变量名 **fail-loud**——静默留下 `{{typo}}` 就是
 * 所有 session 共用一个字面量目录,而且没人会发现。
 */
export function expandMemoryPrefix(prefix: string, facts: MemoryScopeFacts): string {
  return prefix.replace(/\{\{(\w+)\}\}/g, (_, name: string) => {
    switch (name) {
      case "workspaceHash":
        return projectDirName(facts.workspace);
      case "workspace":
        return safeScopeSegment(facts.workspace);
      case "product":
        return safeScopeSegment(facts.product);
      case "sessionId":
        return safeScopeSegment(facts.sessionId);
      default:
        throw new Error(`记忆作用域前缀里有认不出的变量 '{{${name}}}'(可用:${MEMORY_PREFIX_VARIABLES.join(" / ")})`);
    }
  });
}

/* ───────────────────────── 作用域表(装配层造好交进来) ───────────────────────── */

/** 一层:声明 + 它的字节面。 */
export type MemoryScopeEntry = Readonly<{ def: MemoryScopeDef; dir: StorageDir }>;

/**
 * 当前这段 session 的全部层,**按 `order` 升序**。注册与路由都查它;
 * core 里凡是要"这个名字合不合法""这几层怎么排"的地方,答案都在这。
 */
export type MemoryScopeTable = Readonly<{
  /** 按 order 升序。 */
  entries: readonly MemoryScopeEntry[];
  byName: ReadonlyMap<string, MemoryScopeEntry>;
}>;

/** 撞名 fail-loud(两层同名 = 路径二义);排序在这里做一次,之后所有读取都不用再排。 */
export function memoryScopeTable(entries: readonly MemoryScopeEntry[]): MemoryScopeTable {
  const byName = new Map<string, MemoryScopeEntry>();
  for (const e of entries) {
    const name = e.def.name;
    if (name === "" || name.includes("/")) throw new Error(`记忆作用域名不能为空、不能含 '/':'${name}'`);
    if (name.startsWith(".")) throw new Error(`记忆作用域名不能以 '.' 开头(点开头的段是内部状态):'${name}'`);
    if (byName.has(name)) throw new Error(`记忆作用域 '${name}' 重复:一个名字只能是一层`);
    byName.set(name, e);
  }
  const sorted = [...entries].sort((a, b) => a.def.order - b.def.order);
  return { entries: sorted, byName };
}

export const EMPTY_MEMORY_SCOPES: MemoryScopeTable = memoryScopeTable([]);

/** 按 `order` 排一遍并去重,只留表里有的名字。模块注册时调一次,之后 `scopes` 就是可信且有序的。 */
export function orderScopes(table: MemoryScopeTable, scopes: readonly string[]): readonly string[] {
  const want = new Set(scopes);
  return table.entries.filter((e) => want.has(e.def.name)).map((e) => e.def.name);
}

/**
 * 拆作用域前缀。`user/agent.md` → `{ scope: "user", rest: "agent.md" }`。
 * **只拆,不验证**——"这个名字是不是本次装配里的一层"要查表,那是调用方的事。
 */
export function splitScopePath(path: string): { scope: string; rest: string } | null {
  const i = path.indexOf("/");
  if (i <= 0) return null;
  const rest = path.slice(i + 1);
  if (rest === "") return null;
  return { scope: path.slice(0, i), rest };
}

/**
 * 各层一个字节面,按路径第一段路由。**认不出的第一段 fail-loud**——
 * 悄悄兜到某一层就是「写进了另一个人的记忆而没人发现」。
 *
 * `list` 的返回仍是**可直接 read 的路径**(带作用域前缀),与 `StorageDir.list` 的约定一致;
 * `list("")` 把各层按 `order` 并起来,`view ''` 的概览靠它。
 */
export function memoryScopeDir(table: MemoryScopeTable): StorageDir {
  const known = (): string => table.entries.map((e) => e.def.name).join(" / ") || "(本次装配没有任何记忆作用域)";
  const route = (path: string): MemoryScopeEntry & { rest: string } => {
    const at = splitScopePath(path);
    const hit = at === null ? undefined : table.byName.get(at.scope);
    if (at === null || hit === undefined) throw new Error(`记忆路径必须以作用域开头(${known()}):'${path}'`);
    return { ...hit, rest: at.rest };
  };
  return {
    read: (path) => {
      const at = route(path);
      return at.dir.read(at.rest);
    },
    write: (path, content) => {
      const at = route(path);
      return at.dir.write(at.rest, content);
    },
    remove: (path) => {
      const at = route(path);
      return at.dir.remove(at.rest);
    },
    list: async (prefix) => {
      if (prefix === "") {
        const out: string[] = [];
        for (const e of table.entries) out.push(...(await e.dir.list("")).map((p) => `${e.def.name}/${p}`));
        return out;
      }
      const i = prefix.indexOf("/");
      const head = i < 0 ? prefix : prefix.slice(0, i);
      const hit = table.byName.get(head);
      if (hit === undefined) throw new Error(`记忆路径必须以作用域开头(${known()}):'${prefix}'`);
      const rest = i < 0 ? "" : prefix.slice(i + 1);
      return (await hit.dir.list(rest)).map((p) => `${head}/${p}`);
    },
  };
}

/* ───────────────────────── 哈希与留痕(给 stamp 的层用) ───────────────────────── */

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

/** `{{workspaceHash}}` 的取值:`fnv1a64hex(workspace)` 前 12 位。 */
export function projectDirName(workspace: string): string {
  return fnv1a64hex(workspace).slice(0, 12);
}

/**
 * **打开时对一遍**:目录里那份 `workspace.json` 与本次的 workspace 不一致 = 48 位哈希撞了,
 * 判红。不判的话就是两个项目的记忆混在一起而没人发现。只有 `stamp: true` 的层走这条。
 *
 * 目录还没有留痕(第一次在这个项目里跑)时什么都不做——**留痕由第一次写落**,见 `withWorkspaceStamp`。
 */
export async function assertProjectWorkspace(root: StorageDir, prefix: string, workspace: string): Promise<void> {
  const raw = await root.read(`${prefix}${WORKSPACE_STAMP_FILE}`);
  if (raw === null) return;
  let recorded: unknown;
  try {
    recorded = (JSON.parse(raw) as { workspace?: unknown }).workspace;
  } catch (e) {
    throw new Error(`记忆作用域的 ${prefix}${WORKSPACE_STAMP_FILE} 坏了,读不出原路径:${String(e)}`);
  }
  if (recorded !== workspace) {
    throw new Error(
      `记忆作用域目录撞了:${prefix} 记的是 '${String(recorded)}',这一段的 workspace 是 '${workspace}'。` +
        `目录名是 workspace 的 48 位哈希,撞了就是两个项目的记忆混在一起——先挪走那个目录再起。`,
    );
  }
}

/**
 * 第一次往这一层写东西时顺手把 `workspace.json` 落下。
 *
 * 为什么不在解析时落:没人往这个项目里记过东西,就不该在 home 下留一个空目录。
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

/* ───────────────────────── 延迟绑定 ───────────────────────── */

/**
 * 记忆字节面的**延迟绑定**(2026-09-07 用户拍板)。
 *
 * 作用域的根**不在装配期解析**:workspace / 角色 / 产品都是 session 级事实,`--resume` 一段
 * 在别的目录、别的角色下建的会话时,权威值要到 `Agent.start()` 里 `createOrResume` 返回才知道
 * (盘上为准)。装配期先给这一份,任何读写都抛;`bind()` 一次之后才通。
 *
 * 这比从前那套"装配期先指着、`start()` 再重指一次"少一个概念:没有"重指",只有"还没指"和
 * "指好了"。运行期的 `setWorkspace()` 想跟也跟不了——**结构上没有第二个解析入口**,
 * 这条纪律因此不再建立在调用点自觉上。
 */
export type LateBoundMemoryDir = Readonly<{
  dir: StorageDir;
  /** 只生效一次;重复调是空操作(与从前 `pin` 的"一次"同一个结构性质)。 */
  bind: (table: MemoryScopeTable) => void;
  bound: () => boolean;
  /** 已绑定的表;没绑定时抛。harness 要按它排序、验证模块的 scopes。 */
  table: () => MemoryScopeTable;
}>;

export function lateBoundMemoryDir(): LateBoundMemoryDir {
  let table: MemoryScopeTable | undefined;
  let routed: StorageDir | undefined;
  const need = (): StorageDir => {
    if (routed === undefined) {
      throw new Error("记忆的作用域还没绑定:它要等 session 从盘上加载完(workspace / 角色 / 产品都是 session 级事实)才解析");
    }
    return routed;
  };
  return {
    // 方法都是 async:绑定前的失败要以 **rejected promise** 出现,不是同步 throw——
    // `StorageDir` 的契约是"返回 Promise",同步抛会让调用方的 try / catch 落在另一个位置。
    dir: {
      read: async (path) => need().read(path),
      write: async (path, content) => need().write(path, content),
      remove: async (path) => need().remove(path),
      list: async (prefix) => need().list(prefix),
      // 收摊时把各层的底层字节面一起关掉。没绑定过就没有可关的。
      close: async () => {
        for (const e of table?.entries ?? []) await e.dir.close?.();
      },
    },
    bind: (t) => {
      if (table !== undefined) return;
      table = t;
      routed = memoryScopeDir(t);
    },
    bound: () => table !== undefined,
    table: () => {
      if (table === undefined) throw new Error("记忆的作用域还没绑定");
      return table;
    },
  };
}
