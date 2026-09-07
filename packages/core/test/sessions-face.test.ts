// 会话面（`docs/design/sessions.md` §5–§7）的判据：**一个容器里多段 agent 同时在跑，互相发消息**。
//
// 每条先写「没有这条会怎么错」——这一批盯的都是「看起来能用、其实不成立」的那类：
//   · 发出去的消息没落盘（同进程抄近路）→ 跨进程那条路就是另一套语义，迟早分叉；
//   · 关掉的段还能收信 → 消息永远没人读，发送方却收到 accepted；
//   · 崩在 working 的段被读成「正在忙」→ 拿一份死状态当真，模型据此一直等；
//   · runner 失败之后那段仍是 active → 一段活着但没人跑的孤儿会一直待在清单里。

import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EchoSessions, NO_SESSION_FACE, type SessionRow } from "../src/session/sessions.ts";
import { makeSessionTools, sessionToolsSection } from "../src/session/tools.ts";
import { listSessions, SessionService } from "../src/session/service.ts";
import type { AgentDefinition, AgentRef } from "../src/agent-def/types.ts";
import { InboxStore } from "../src/inbox/store.ts";
import { InMemoryDir } from "../src/storage/in-memory-dir.ts";
import { writeSessionPhase } from "../src/session/status.ts";
import { userMessage } from "../src/messages.ts";
import type { StorageDir } from "../src/storage/types.ts";

/** 前缀视图：会话目录的上一层是一个 store，每段各占一个子目录。 */
function scoped(base: StorageDir, prefix: string): StorageDir {
  return {
    read: (path) => base.read(prefix + path),
    write: (path, content) => base.write(prefix + path, content),
    remove: (path) => base.remove(prefix + path),
    list: async (sub) => (await base.list(prefix + sub)).map((k) => k.slice(prefix.length)),
  };
}

type Harness = {
  readonly root: InMemoryDir;
  readonly sessions: EchoSessions;
  readonly alive: Set<string>;
  readonly ran: SessionRow[];
};

function harness(
  opts: {
    selfId?: string;
    run?: (row: SessionRow) => Promise<void>;
    runTimeoutMs?: number;
    /** 创建者此刻的工作集——不越权检查读它。 */
    tools?: readonly string[];
    /** 容器认得的具名 agent 定义。不给 = 一份都没有，点名一律判红。 */
    agentDefs?: ReadonlyMap<string, AgentDefinition>;
  } = {},
): Harness {
  const root = new InMemoryDir();
  const alive = new Set<string>();
  const ran: SessionRow[] = [];
  const sessions = new EchoSessions({
    root,
    storeFor: (id) => scoped(root, `${id}/`),
    isAlive: async (id) => alive.has(id),
    self: () => ({ sessionId: opts.selfId ?? "s-self", product: "echo-agent", workspace: "/repo", tools: opts.tools ?? [] }),
    ...(opts.agentDefs !== undefined ? { agentDefs: () => opts.agentDefs! } : {}),
    ...(opts.run !== undefined
      ? {
          run: async (row: SessionRow) => {
            ran.push(row);
            await opts.run!(row);
          },
        }
      : {}),
    ...(opts.runTimeoutMs !== undefined ? { runTimeoutMs: opts.runTimeoutMs } : {}),
  });
  return { root, sessions, alive, ran };
}

/** 工具执行上下文：这组工具一个字段都不用，给一份最小的。 */
function ctx(): never {
  return { toolCallId: "c1", workspace: "/repo", sessionId: "s-self", iteration: 0 } as never;
}

/** 预置一段说过话的会话（一句话没说的段不落 meta，也就不在清单里）。 */
async function seed(root: InMemoryDir, id: string, opts: { product?: string; agent?: AgentRef; main?: boolean } = {}): Promise<void> {
  const svc = new SessionService(scoped(root, `${id}/`));
  await svc.createOrResume(id, {
    workspace: "/repo",
    product: opts.product ?? "echo-agent",
    ...(opts.agent !== undefined ? { agent: opts.agent } : {}),
    main: opts.main ?? true,
  });
  await svc.append(id, [{ kind: "message", message: userMessage("开场") }]);
  await svc.settle();
}

test("create：建目录、立刻落 meta、第一条消息进对方 inbox，然后才叫 runner", async () => {
  // 没有「立刻落 meta」这条时：新建的段要等它自己第一次入账才在清单里出现，
  // 而它正等着 runner 来跑——runner 还没接手，`list()` 已经查无此段。
  const h = harness({ run: async () => {} });
  const row = await h.sessions.create({ name: "查一下 PR 42", message: "先看 PR 42" });

  expect(row.main).toBe(true);
  // product 与 workspace 继承建它的那一段；**角色不继承**——一段 reviewer 派出去的活
  // 默认不该也是 reviewer，那是它自己要说的事（`CreateSessionInput.agent`）
  expect([row.product, row.workspace, row.agent]).toEqual(["echo-agent", "/repo", "default"]);
  expect((await listSessions(h.root)).map((i) => [i.id, i.name, i.status])).toEqual([[row.id, "查一下 PR 42", "active"]]);

  // 第一条消息真的在对方的 inbox 里，而且是**盘上**那份
  const inbox = await new InboxStore(scoped(h.root, `${row.id}/`)).restore();
  expect(inbox).toHaveLength(1);
  expect(JSON.stringify(inbox[0]!.message)).toContain("先看 PR 42");
  expect(inbox[0]!.message.role).toBe("environment");
  expect((inbox[0]!.message as { source: string }).source).toBe("session");

  // runner 拿到的是那一行，且**建完才叫**——反过来的话它会去跑一段还没有 meta 的会话
  expect(h.ran.map((r) => r.id)).toEqual([row.id]);
});

test("create：没给 runner 照样建（宿主自己跑它）", async () => {
  const h = harness();
  const row = await h.sessions.create({ message: "开工" });
  expect((await listSessions(h.root)).map((i) => i.id)).toEqual([row.id]);
  expect(row.alive).toBe(false); // 还没人跑：诚实说没活着
});

test("create：runner 抛错 / 超时 → 判红，且那一段置 closed，不留一段没人跑的孤儿", async () => {
  // 没有这条时：runner 失败之后盘上留下一段 active 的会话，谁也不会去跑它，
  // 但它会一直待在 `list()` 里、`--continue` 也可能挑到它。
  const failed = harness({ run: async () => void (await Promise.reject(new Error("终端没开起来"))) });
  await expect(failed.sessions.create({ message: "开工" })).rejects.toThrow(/没跑起来.*已置 closed/);
  const afterFail = await listSessions(failed.root);
  expect(afterFail.map((i) => i.status)).toEqual(["closed"]);
  expect(await failed.sessions.list()).toEqual([]); // 缺省不列 closed

  const hung = harness({ run: () => new Promise<void>(() => {}), runTimeoutMs: 30 });
  await expect(hung.sessions.create({ message: "开工" })).rejects.toThrow(/30ms 内没让/);
  expect((await listSessions(hung.root)).map((i) => i.status)).toEqual(["closed"]);
});

test("刚起来、一句话没说的那段也发得到（活着就找得到，2026-09-04）", async () => {
  // 这条对应的是实测过的那个断点：B 正开着但没说过话 → A 的清单里没有它、send 给它 not-found，
  // 「打开第二个终端、从第一个带句话过去」这一步直接断掉。
  const h = harness();
  const svc = new SessionService(scoped(h.root, "s-fresh/"));
  await svc.createOrResume("s-fresh", { workspace: "/repo", product: "echo-agent" }); // 只 start，不说话
  h.alive.add("s-fresh");

  expect((await h.sessions.list()).map((r) => r.id)).toContain("s-fresh");
  expect(await h.sessions.send("s-fresh", "在吗")).toMatchObject({ kind: "accepted", alive: true });
});

test("send：只跟活着的段说话——对方在跑就直投，往对方 inbox 落盘一条", async () => {
  // 「同进程直接投内存队列」的抄近路会让同进程与跨进程成为两套语义——所以这里盯的是**盘上**有没有。
  const h = harness();
  await seed(h.root, "s-peer");
  h.alive.add("s-peer");
  const away = await h.sessions.send("s-peer", "HR 回你了");
  expect(away).toMatchObject({ kind: "accepted", alive: true });

  const live = await h.sessions.send("s-peer", "再问一句");
  expect(live).toMatchObject({ kind: "accepted", alive: true });

  // **顺序不许乱**：同一个发送方连着发的两条，恢复出来还是这个先后。
  // 没有这条时实测过：每发一条就 new 一个 InboxStore，同毫秒计数器从 0 重来，两条被随机尾巴排反了。
  const inbox = await new InboxStore(scoped(h.root, "s-peer/")).restore();
  expect(inbox.map((r) => JSON.stringify(r.message))).toEqual([
    expect.stringContaining("HR 回你了"),
    expect.stringContaining("再问一句"),
  ]);
  // ref 由**发送方**落款：收方据此知道是谁发的
  expect((inbox[0]!.message as { ref?: string }).ref).toStartWith("s-self:");
});

test("send：不存在 / 已关 / 名字不合法各有各的说法，不含糊成一个失败", async () => {
  const h = harness();
  expect(await h.sessions.send("s-nope", "在吗")).toMatchObject({ kind: "rejected", reason: "not-found" });
  expect(await h.sessions.send("../escaped", "在吗")).toMatchObject({ kind: "rejected", reason: "invalid" });

  await seed(h.root, "s-gone");
  await h.sessions.close("s-gone");
  // 关掉的段**不再收信**：不然这条消息永远没人读，而发送方拿到的是 accepted
  expect(await h.sessions.send("s-gone", "还在吗")).toMatchObject({ kind: "rejected", reason: "closed" });
});

test("close：只改 meta 的 status，盘上的对话一个字不删", async () => {
  const h = harness();
  await seed(h.root, "s-old");
  await h.sessions.close("s-old");
  const [info] = await listSessions(h.root);
  expect(info!.status).toBe("closed");
  // 账本还在：`--resume` 回来还看得到
  const resumed = await new SessionService(scoped(h.root, "s-old/")).createOrResume("s-old");
  expect(resumed.messages).toHaveLength(1);
});

test("list：alive 为假时 phase 恒为 null——崩在 working 的段不许被读成「正在忙」", async () => {
  // 没有这条时：进程被杀之后盘上的 status.json 永远停在 working，
  // 三个消费者（工具 / 壳 / 宿主）各组合一遍 alive 与 phase，就会各错一遍。
  const h = harness();
  await seed(h.root, "s-busy");
  await writeSessionPhase(scoped(h.root, "s-busy/"), "working");

  expect((await h.sessions.list()).map((r) => [r.alive, r.phase])).toEqual([[false, null]]);
  h.alive.add("s-busy");
  expect((await h.sessions.list()).map((r) => [r.alive, r.phase])).toEqual([[true, "working"]]);
});

test("list：按 workspace / product / 角色筛，closed 要显式要", async () => {
  const h = harness();
  await seed(h.root, "s-a", { product: "echo-agent" });
  await seed(h.root, "s-b", { product: "echo-coding" });
  await seed(h.root, "s-c", { product: "echo-agent", main: false });
  await seed(h.root, "s-r", { product: "echo-agent", agent: { name: "reviewer", definition: { identity: "审查" } } });
  await h.sessions.close("s-c");

  expect((await h.sessions.list({ product: "echo-agent" })).map((r) => r.id).sort()).toEqual(["s-a", "s-r"]);
  expect((await h.sessions.list({ product: "echo-agent", includeClosed: true })).map((r) => r.id).sort()).toEqual(["s-a", "s-c", "s-r"]);
  // 角色是另一维：没挂角色的是 `default`,挂了具名角色的是它的名字
  expect((await h.sessions.list({ agent: "reviewer" })).map((r) => r.id)).toEqual(["s-r"]);
  expect((await h.sessions.list({ agent: "default" })).map((r) => r.id).sort()).toEqual(["s-a", "s-b"]);
  expect((await h.sessions.list({ workspace: "/elsewhere" }))).toEqual([]);
  expect((await h.sessions.list()).find((r) => r.id === "s-c")).toBeUndefined();
});

test("会话 id 不许逃出目录：create 用自己发的 id，close / send 校验传进来的", async () => {
  const h = harness();
  await expect(h.sessions.close("../../escaped")).rejects.toThrow(/会话 id/);
  expect(await h.sessions.send("../../escaped", "x")).toMatchObject({ kind: "rejected", reason: "invalid" });
});

test("真盘上跑一遍：两段各占一个目录，互发的消息落在对方目录里", async () => {
  // InMemoryDir 证明不了「目录布局对不对」——这条盯的就是盘上的形状。
  const home = mkdtempSync(join(tmpdir(), "echo-sessions-face-"));
  try {
    const { FileDir } = await import("../src/storage/file-dir.ts");
    const root = new FileDir(home);
    const alive = new Set<string>(["s-peer"]);
    const sessions = new EchoSessions({
      root,
      storeFor: (id) => new FileDir(join(home, id)),
      isAlive: async (id) => alive.has(id),
      self: () => ({ sessionId: "s-self", product: "echo-agent", workspace: "/repo" , tools: [] }),
    });
    const peerSvc = new SessionService(new FileDir(join(home, "s-peer")));
    await peerSvc.createOrResume("s-peer", { workspace: "/repo", product: "echo-agent" });
    await peerSvc.append("s-peer", [{ kind: "message", message: userMessage("开场") }]);
    await peerSvc.settle();

    expect(await sessions.send("s-peer", "盘上见")).toMatchObject({ kind: "accepted", alive: true });
    expect(existsSync(join(home, "s-peer", "meta.json"))).toBe(true);
    expect(existsSync(join(home, "s-peer", "inbox"))).toBe(true);
    const restored = await new InboxStore(new FileDir(join(home, "s-peer"))).restore();
    expect(JSON.stringify(restored[0]!.message)).toContain("盘上见");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

/* ═══════════════ 工具面：两条挂载条件 ═══════════════ */

test("工具面：main 且容器给了 runner 才挂 session_create；非 main / 没 runner 都只剩三件", () => {
  // 两条挂载条件各挡一种错：
  //   · 非 main 也能建 → 扇出没有边界，派出去的段会自己再派；
  //   · 没 runner 还挂着 → 模型调了 session_create、系统什么都不做，比没有这件工具更坏。
  const h = harness();
  const full = makeSessionTools(h.sessions, { canCreate: true }).map((t) => t.name);
  expect(full).toEqual(["session_create", "session_list", "session_send", "session_close"]);
  const limited = makeSessionTools(h.sessions, { canCreate: false }).map((t) => t.name);
  expect(limited).toEqual(["session_list", "session_send", "session_close"]);
  // 能回话、能找人、能收工——少的只有「派活」那一件
  expect(limited).toContain("session_send");
});

test("工具面：习惯段只在能派活时讲派活；异步这条两种情况都讲", () => {
  const withCreate = sessionToolsSection({ canCreate: true }).render({} as never);
  const without = sessionToolsSection({ canCreate: false }).render({} as never);
  expect(withCreate).toContain("session_create");
  expect(without).not.toContain("session_create");
  for (const text of [withCreate, without]) {
    expect(text).toContain("does not wait for a reply"); // 异步是这组工具最容易被误解的一条
  }
});

test("工具面：session_create 的 agent 参数——按名点中、现写一份、不点就是产品原样", async () => {
  // 没有这个参数时（2026-09-07 之前）模型开不出 reviewer 段：角色只有容器给得了，
  // 而「派一个只读审查去看 PR」正是这组工具最该能干的事。
  // 创建者手上要有 read_file——**不越权对具名定义一视同仁**：人写在 reviewer.md 里的工具，
  // 也不能让一个被收紧过的段派出比自己更宽的段。
  const h = harness({
    run: async () => {},
    tools: ["read_file", "shell"],
    agentDefs: new Map([["reviewer", { identity: "你是代码审查员。", tools: ["read_file"] }]]),
  });
  const create = makeSessionTools(h.sessions, { canCreate: true })[0]!;

  const byName = await create.execute({ message: "看 PR 42", agent: "reviewer" }, ctx());
  expect(byName.isError).toBe(false);
  expect(JSON.stringify(byName)).toContain("agent reviewer"); // 点中了要说出来，模型才确认得了
  expect((await listSessions(h.root)).find((i) => i.agent.name === "reviewer")?.agent.definition.identity).toBe("你是代码审查员。");

  const inline = await create.execute({ message: "跑一下", agent: { identity: "你只跑测试。", tools: ["read_file"] } }, ctx());
  expect(inline.isError).toBe(false);
  expect(JSON.stringify(inline)).toContain("agent inline");

  const plain = await create.execute({ message: "随便干点啥" }, ctx());
  expect(JSON.stringify(plain)).toContain("agent default"); // 不点 = 产品原样，**不继承创建者的**
});

test("工具面：agent 参数验形——名字不存在、越权、形状不对，各说各的且盘上不留半段", async () => {
  // 三条都必须在**动盘之前**判掉：判红却留下一个目录，清单里就多一段永远不会跑的会话。
  const h = harness({ run: async () => {}, tools: ["read_file"], agentDefs: new Map() });
  const create = makeSessionTools(h.sessions, { canCreate: true })[0]!;

  const noSuch = await create.execute({ message: "干活", agent: "nobody" }, ctx());
  expect(noSuch.isError).toBe(true);
  expect(JSON.stringify(noSuch)).toContain("nobody");

  // 越权：创建者手上只有 read_file，点了它没有的 shell
  const escalate = await create.execute({ message: "干活", agent: { tools: ["read_file", "shell"] } }, ctx());
  expect(escalate.isError).toBe(true);
  expect(JSON.stringify(escalate)).toContain("shell");

  const badShape = await create.execute({ message: "干活", agent: { identity: "x", persona: "y" } }, ctx());
  expect(badShape.isError).toBe(true);
  expect(JSON.stringify(badShape)).toContain("persona"); // 多出来的键不静默丢掉

  const empty = await create.execute({ message: "干活", agent: {} }, ctx());
  expect(empty.isError).toBe(true);

  expect(await listSessions(h.root)).toEqual([]); // 四次判红，盘上一段都没有
});

test("工具面：session_create 建出来的一律不是 main（扇出只有一层）", async () => {
  const h = harness({ run: async () => {} });
  const [create] = makeSessionTools(h.sessions, { canCreate: true });
  const r = await create!.execute({ message: "去看 PR 42" } as never, ctx());
  expect(r.isError ?? false).toBe(false);
  const [row] = await listSessions(h.root);
  expect(row!.main).toBe(false);
});

test("工具面：send 送到了就一句话；不存在 / 够不着各有各的原因", async () => {
  const h = harness();
  await seed(h.root, "s-peer");
  h.alive.add("s-peer");
  const send = makeSessionTools(h.sessions, { canCreate: false }).find((t) => t.name === "session_send")!;

  const live = await send.execute({ to: "s-peer", message: "在吗" } as never, ctx());
  expect(live.isError ?? false).toBe(false);
  expect(String(live.content)).toContain("Delivered");

  const missing = await send.execute({ to: "s-nope", message: "在吗" } as never, ctx());
  expect(missing.isError).toBe(true);
  expect(String(missing.content)).toContain("not-found");

  // 没在跑、又叫不醒：**不投**，如实说够不着——不留一条没人读的纸条
  await seed(h.root, "s-away");
  const away = await send.execute({ to: "s-away", message: "在吗" } as never, ctx());
  expect(away.isError).toBe(true);
  expect(String(away.content)).toContain("unreachable");
});

/* ═══════════════ 只跟活着的段说话（2026-09-07 拍板：虚拟 actor） ═══════════════ */

test("send 给没在跑的段：容器能叫醒就先叫醒再投，投完对方一定活着", async () => {
  // 没有这条时：消息被写进一个没人看的邮箱，工具却回「它下次起来会读」——
  // 而在没有 runner 的容器里，根本没有任何东西会让它起来。那是句空话。
  const woken: string[] = [];
  const h = harness({
    run: async (row) => {
      woken.push(row.id);
      h.alive.add(row.id); // runner 的契约：resolve = 那段已经持有自己的 lease
    },
  });
  await seed(h.root, "s-away");
  expect((await h.sessions.list()).map((r) => r.alive)).toEqual([false]);

  const out = await h.sessions.send("s-away", "醒醒");
  expect(out).toMatchObject({ kind: "accepted", alive: true });
  expect(woken).toEqual(["s-away"]); // 叫过它
  expect((await new InboxStore(scoped(h.root, "s-away/")).restore()).length).toBe(1);

  // 已经活着的不再叫第二次
  await h.sessions.send("s-away", "再说一句");
  expect(woken).toEqual(["s-away"]);
});

test("send 给没在跑的段：容器叫不醒就 unreachable，**一条消息都不留**", async () => {
  const h = harness(); // 没给 run
  expect(h.sessions.canWake).toBe(false);
  await seed(h.root, "s-away");

  const out = await h.sessions.send("s-away", "在吗");
  expect(out).toMatchObject({ kind: "rejected", reason: "unreachable" });
  expect(String((out as { detail: string }).detail)).toContain("起不了它");
  // 盘上只有 seed 那一条 entry，inbox 一条都没多
  expect((await new InboxStore(scoped(h.root, "s-away/")).restore()).length).toBe(0);
});

test("send：runner 抛错也算够不着，同样不留消息", async () => {
  const h = harness({ run: async () => void (await Promise.reject(new Error("终端没开起来"))) });
  await seed(h.root, "s-away");
  const out = await h.sessions.send("s-away", "在吗");
  expect(out).toMatchObject({ kind: "rejected", reason: "unreachable" });
  expect(String((out as { detail: string }).detail)).toContain("终端没开起来");
  expect((await new InboxStore(scoped(h.root, "s-away/")).restore()).length).toBe(0);
});

test("canWake：容器给没给 runner，会话面如实说", () => {
  expect(harness().sessions.canWake).toBe(false);
  expect(harness({ run: async () => {} }).sessions.canWake).toBe(true);
  expect(NO_SESSION_FACE.canWake).toBe(false);
});

test("工具面：list 把「活着 / 在忙 / 没进程」说清楚；一段都没有时也是一句话", async () => {
  const h = harness();
  const list = makeSessionTools(h.sessions, { canCreate: false }).find((t) => t.name === "session_list")!;
  expect(String((await list.execute({} as never, ctx())).content)).toContain("No other sessions");

  await seed(h.root, "s-peer");
  expect(String((await list.execute({} as never, ctx())).content)).toContain("not running");
  // 活着但状态还没落盘 = **不知道**，不能说成「空闲」：模型会据此以为马上有答复
  h.alive.add("s-peer");
  const unknown = String((await list.execute({} as never, ctx())).content);
  expect(unknown).toContain("running");
  expect(unknown).not.toContain("running, idle");
  await writeSessionPhase(scoped(h.root, "s-peer/"), "working");
  expect(String((await list.execute({} as never, ctx())).content)).toContain("running, busy");
  await writeSessionPhase(scoped(h.root, "s-peer/"), "idle");
  expect(String((await list.execute({} as never, ctx())).content)).toContain("running, idle");
});

/* ═══════════════ 会话命名 ═══════════════ */

test("SessionService.rename：只改自己那一段，空名字与同名忽略；改完落盘", async () => {
  const dir = new InMemoryDir();
  const svc = new SessionService(dir);
  const data = await svc.createOrResume("s-1", { workspace: "/repo", product: "echo-agent" });
  expect(data.info.name).toBe("s-1"); // 缺省名 = 会话 id，对人零信息量

  svc.rename("s-1", "  修 PR 42  ");
  await svc.settle();
  expect(svc.nameOf("s-1")).toBe("修 PR 42"); // 两头空白掐掉
  expect(JSON.parse((await dir.read("meta.json"))!).name).toBe("修 PR 42");

  // 空名字与同名都不写：不给「名字是空的」这种状态，也不为一次同名多刷一遍盘
  svc.rename("s-1", "   ");
  svc.rename("s-1", "修 PR 42");
  await svc.settle();
  expect(svc.nameOf("s-1")).toBe("修 PR 42");

  // 没打开过的那一段：不认识，不动
  svc.rename("s-别的", "不该生效");
  expect(svc.nameOf("s-别的")).toBeNull();
});

test("改过名之后，清单与 list 都按新名字认它", async () => {
  const h = harness();
  const svc = new SessionService(scoped(h.root, "s-1/"));
  await svc.createOrResume("s-1", { workspace: "/repo", product: "echo-agent" });
  await svc.append("s-1", [{ kind: "message", message: userMessage("一") }]);
  svc.rename("s-1", "改接口");
  await svc.settle();

  expect((await listSessions(h.root)).map((i) => i.name)).toEqual(["改接口"]);
  expect((await h.sessions.list()).map((r) => r.name)).toEqual(["改接口"]);
});
