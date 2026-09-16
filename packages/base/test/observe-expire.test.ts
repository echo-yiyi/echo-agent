// 产品的观测过期：规则（`retainRecentDays`）与时机（`expireSessionObservations` 扫会话根）。
// 「谁在启动时调它」那一半的判据在 `packages/cli/test/cli.test.ts`。

import { test, expect, describe, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expireObservations } from "@echo-agent/core";
import { expireSessionObservations, retainRecentDays } from "../src/observe/expire.ts";

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;
const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function sessionsRoot(): string {
  const d = mkdtempSync(join(tmpdir(), "echo-expire-"));
  dirs.push(d);
  return d;
}

/** 盘上的一条 RunIndex：`closed` = 有终态记录（过期只删已封口的）。 */
function writeRun(root: string, sessionId: string, runId: string, acceptedAt: number, closed = true): string {
  const runs = join(root, sessionId, "observability", "runs");
  mkdirSync(runs, { recursive: true });
  const entry = {
    schemaVersion: 1,
    runtimeId: "rt",
    runId,
    acceptedRecordId: "rt:1",
    ...(closed ? { terminalRecordId: "rt:2" } : {}),
    header: {
      schemaVersion: 1,
      runId,
      source: { kind: "user" },
      runtimeId: "rt",
      agentId: "a",
      agentInstanceId: "a#1",
      sessionId,
      runtimeGeneration: "g",
      capturePolicy: "metadata",
      acceptedAt,
      startedAt: null,
      endedAt: closed ? acceptedAt + 1 : null,
      status: closed ? "completed" : "running",
      integrity: "complete",
      persistence: "stored",
    },
    firstSeq: 1,
    lastSeq: 2,
  };
  const path = join(runs, `${runId}.json`);
  writeFileSync(path, JSON.stringify(entry));
  return path;
}

describe("retainRecentDays：只留最近 N 天", () => {
  test("超期且已封口的删；最近的留；超期但没封口的不删，列进 openRuns", async () => {
    const root = sessionsRoot();
    const stateRoot = join(root, "s1");
    const old = writeRun(root, "s1", "r-old", NOW - 60 * DAY);
    const recent = writeRun(root, "s1", "r-recent", NOW - 2 * DAY);
    const openOld = writeRun(root, "s1", "r-open", NOW - 60 * DAY, false);

    const result = await expireObservations({ stateRoot, rule: retainRecentDays(30), now: NOW });
    expect(result.removedRuns).toEqual(["r-old"]);
    expect(result.openRuns).toEqual(["r-open"]); // 还没封口的一律不删——可能正在跑
    expect(existsSync(old)).toBe(false);
    expect(existsSync(recent)).toBe(true);
    expect(existsSync(openOld)).toBe(true);
  });

  test("边界：恰好在保留线之内的一天不删", async () => {
    const root = sessionsRoot();
    const keep = writeRun(root, "s1", "r-29d", NOW - 29 * DAY);
    const drop = writeRun(root, "s1", "r-31d", NOW - 31 * DAY);
    await expireObservations({ stateRoot: join(root, "s1"), rule: retainRecentDays(30), now: NOW });
    expect(existsSync(keep)).toBe(true);
    expect(existsSync(drop)).toBe(false);
  });
});

describe("expireSessionObservations：扫会话根下每一段", () => {
  test("每段各清各的——只清自己这一段等于什么都不清（缺省每次启动都新建一段）", async () => {
    const root = sessionsRoot();
    const oldA = writeRun(root, "s-a", "r-a-old", NOW - 90 * DAY);
    const recentA = writeRun(root, "s-a", "r-a-new", NOW - 1 * DAY);
    const oldB = writeRun(root, "s-b", "r-b-old", NOW - 90 * DAY);
    mkdirSync(join(root, "s-no-store"), { recursive: true }); // 还没记过观测的一段：跳过，不报错

    await expireSessionObservations({ sessionsRoot: root, rule: retainRecentDays(30), now: NOW });
    expect(existsSync(oldA)).toBe(false);
    expect(existsSync(oldB)).toBe(false);
    expect(existsSync(recentA)).toBe(true);
  });

  test("某一段坏了只跳过那一段，别的段照清，也绝不抛给调用方", async () => {
    const root = sessionsRoot();
    const broken = join(root, "s-broken", "observability", "runs");
    mkdirSync(broken, { recursive: true });
    writeFileSync(join(broken, "r-x.json"), "{ 不是 JSON");
    const oldGood = writeRun(root, "s-good", "r-old", NOW - 90 * DAY);

    await expireSessionObservations({ sessionsRoot: root, rule: retainRecentDays(30), now: NOW });
    expect(existsSync(oldGood)).toBe(false); // 坏的那段没挡住好的那段
    expect(existsSync(join(broken, "r-x.json"))).toBe(true); // 坏的原样留着给人看
  });

  test("会话根不存在：什么都不做，不抛", async () => {
    await expireSessionObservations({ sessionsRoot: join(sessionsRoot(), "nope"), rule: retainRecentDays(30), now: NOW });
  });

  test("规则自己抛错也只影响那一段", async () => {
    const root = sessionsRoot();
    const kept = writeRun(root, "s-a", "r-old", NOW - 90 * DAY);
    await expireSessionObservations({
      sessionsRoot: root,
      rule: () => {
        throw new Error("规则坏了");
      },
      now: NOW,
    });
    expect(existsSync(kept)).toBe(true);
  });
});
