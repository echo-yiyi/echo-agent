// agent 集群的**跨进程**判据（docs/design/sessions.md §5、§10）。
//
// 这一条盯的是整份设计里最容易被同进程测试骗过去的那句话：
// **「A 发给 B，B 不重启就在下一轮看到」**。同进程时读盘的和写盘的是同一份内存账本，
// 摘掉 `InboxStore.refresh()` 与轮询照样绿；只有让**写的人在另一个进程**，这条才有区分力。
//
// 另一条同样只有跨进程才成立：两段 session 各拿各的锁、能同时活着——旧布局（状态根按 agent 分）
// 下第二个进程直接 fail-loud。

import { test, expect } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EchoSessions } from "../src/session/sessions.ts";
import { SessionService } from "../src/session/service.ts";
import { FileDir } from "../src/storage/file-dir.ts";
import { inspectStateLock } from "../src/storage/file-lock.ts";
import { userMessage } from "../src/messages.ts";

const PEER = join(import.meta.dir, "fixtures", "session-peer.ts");

type PeerReport = { ok: boolean; sessionId?: string; saw?: boolean; texts?: string[]; error?: string };

/** 起一个真进程守着某一段 session。返回它退出时的报告（stdout 最后一行的 JSON）。 */
function spawnPeer(home: string, sessionId: string, waitMs: number): Promise<{ report: PeerReport | null; out: string }> {
  const proc = Bun.spawn(["bun", PEER, home, sessionId, String(waitMs)], { stdout: "pipe", stderr: "pipe" });
  return (async () => {
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    await proc.exited;
    const last = out.trim().split("\n").at(-1) ?? "";
    let report: PeerReport | null = null;
    try {
      report = JSON.parse(last) as PeerReport;
    } catch {
      report = null;
    }
    return { report, out: `${out}\n${err}` };
  })();
}

/** 预置一段说过话的会话——一句话没说的段不落 meta，`send` 就找不到它。 */
async function seed(home: string, id: string): Promise<void> {
  const svc = new SessionService(new FileDir(join(home, "sessions", id)));
  await svc.createOrResume(id, { workspace: "/repo", agent: "echo-agent" });
  await svc.append(id, [{ kind: "message", message: userMessage("开场") }]);
  await svc.settle();
}

function sessionsOn(home: string): EchoSessions {
  const root = new FileDir(join(home, "sessions"));
  return new EchoSessions({
    root,
    storeFor: (id) => new FileDir(join(home, "sessions", id)),
    isAlive: async (id) => (await inspectStateLock(join(home, "sessions", id, ".lock"))).state === "valid",
    self: () => ({ sessionId: "s-sender", agent: "echo-agent", workspace: "/repo" }),
  });
}

test(
  "另一个进程写进来的一条，守着的那段不重启就看见并开了一轮",
  async () => {
    const home = await mkdtemp(join(tmpdir(), "echo-cluster-"));
    await seed(home, "s-peer");

    // 真进程 B：起来、待着、什么都不主动做
    const peer = spawnPeer(home, "s-peer", 10_000);

    // 等它真的拿到锁再发——否则这条会在它 restore 之前落盘，被那一次 restore 顺手读走，
    // 那证明的是「重启时读得到」，不是「不重启也看得见」。
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      if ((await inspectStateLock(join(home, "sessions", "s-peer", ".lock"))).state === "valid") break;
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(existsSync(join(home, "sessions", "s-peer", ".lock")), "peer 进程没起来（锁没出现）").toBe(true);
    // 再多等一拍：确保它已经 restore 完、进了 running，这条是**它跑起来之后**才到的
    await new Promise((r) => setTimeout(r, 300));

    const outcome = await sessionsOn(home).send("s-peer", "另一个进程发来的一句");
    expect(outcome).toMatchObject({ kind: "accepted", alive: true }); // 对方活着 = 对话，不是留言

    const { report, out } = await peer;
    expect(report, `peer 没吐出报告：\n${out}`).not.toBeNull();
    expect(report!.ok, `peer 挂了：${report?.error ?? out}`).toBe(true);
    expect(report!.saw, "peer 没看见别的进程写进它 inbox 的那条（refresh / 轮询没生效）").toBe(true);
    expect(JSON.stringify(report!.texts)).toContain("另一个进程发来的一句");
  },
  60_000,
);

test(
  "两段 session 各拿各的锁：同一台机器上两个进程同时活着",
  async () => {
    // 旧布局（状态根 = agents/<agentId>）下这里是同一把锁，第二个进程直接 fail-loud——
    // 「一个做前端、一个做后端」在那时候起不来。
    const home = await mkdtemp(join(tmpdir(), "echo-cluster-"));
    await seed(home, "s-front");
    await seed(home, "s-back");

    const a = spawnPeer(home, "s-front", 3_000);
    const b = spawnPeer(home, "s-back", 3_000);

    // 两把锁同时在
    const deadline = Date.now() + 8_000;
    let bothHeld = false;
    while (Date.now() < deadline && !bothHeld) {
      const [x, y] = await Promise.all([
        inspectStateLock(join(home, "sessions", "s-front", ".lock")),
        inspectStateLock(join(home, "sessions", "s-back", ".lock")),
      ]);
      bothHeld = x.state === "valid" && y.state === "valid";
      if (!bothHeld) await new Promise((r) => setTimeout(r, 25));
    }
    expect(bothHeld, "两段没能同时持锁").toBe(true);

    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.report?.ok, `s-front 挂了：${ra.out}`).toBe(true);
    expect(rb.report?.ok, `s-back 挂了：${rb.out}`).toBe(true);
    // 收摊之后两把锁都还回去了
    expect(existsSync(join(home, "sessions", "s-front", ".lock"))).toBe(false);
    expect(existsSync(join(home, "sessions", "s-back", ".lock"))).toBe(false);
  },
  60_000,
);
