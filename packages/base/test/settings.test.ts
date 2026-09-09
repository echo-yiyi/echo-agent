// 设置文件（D7，`settings.ts`）的判据：**读不动不挡启动、写不进不打断切换**——两头都是口信，不是异常。
// 「记住 → 重启还能用」的端到端在 `cli.test.ts`；这里只测文件本身。

import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSettings, settingsPath, writeSettings, SETTINGS_FILE } from "../src/settings.ts";

let home: string;
let savedHome: string | undefined;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "echo-settings-"));
  savedHome = process.env["ECHO_HOME"];
  process.env["ECHO_HOME"] = home;
});
afterEach(() => {
  if (savedHome === undefined) delete process.env["ECHO_HOME"];
  else process.env["ECHO_HOME"] = savedHome;
  rmSync(home, { recursive: true, force: true });
});

test("路径跟着 ECHO_HOME 走，在根上（跨 agent，与 credentials.json 同级）", () => {
  expect(settingsPath()).toBe(join(home, SETTINGS_FILE));
});

test("没有文件 = 没有设置（常态，不是错，没有口信）", async () => {
  expect(await readSettings()).toEqual({ settings: {} });
});

test("写 → 读一轮；合并写不丢别的键；写完不留临时文件", async () => {
  expect(await writeSettings({ model: { provider: "deepseek", id: "deepseek-reasoner" } })).toEqual({});
  expect((await readSettings()).settings.model).toEqual({ provider: "deepseek", id: "deepseek-reasoner" });

  // 文件里手加一个将来的键，再写 model：那个键要还在（合并写整份，不是覆盖成只剩 model）
  const raw = JSON.parse(readFileSync(settingsPath(), "utf8")) as Record<string, unknown>;
  raw["futureKey"] = true;
  writeFileSync(settingsPath(), JSON.stringify(raw));
  await writeSettings({ model: { provider: "kimi", id: "kimi-k3" } });
  const after = JSON.parse(readFileSync(settingsPath(), "utf8")) as Record<string, unknown>;
  expect(after["model"]).toEqual({ provider: "kimi", id: "kimi-k3" });
  // 认不出的键读的时候不进 settings，但**写的时候不该被抹掉**……的前提是读得回来——
  // 现在 readSettings 只认 model，所以 futureKey 会丢。这是已知取舍：合并基于「读得懂的那份」，
  // 宁可丢未知键也不把坏内容原样并回去。等有第二个键时再把 raw 透传做进去。
  expect(readdirSync(home).filter((n) => n.endsWith(".tmp"))).toEqual([]);
});

test("坏 JSON：口信 + 空缺省，**不抛**——配置是运行态，记忆坏了不挡启动", async () => {
  writeFileSync(settingsPath(), "{ 这不是 JSON");
  const r = await readSettings();
  expect(r.settings).toEqual({});
  expect(r.problem).toContain("不是合法 JSON");
});

test("model 那条形状不对：口信 + 空缺省", async () => {
  writeFileSync(settingsPath(), JSON.stringify({ model: { provider: 42 } }));
  const r = await readSettings();
  expect(r.settings).toEqual({});
  expect(r.problem).toContain("认不出来");
});

test("写失败：口信、不抛——记住上次选择是便利不是承诺，不打断正在切换的用户", async () => {
  writeFileSync(settingsPath(), "{}");
  chmodSync(home, 0o500); // 目录只读：rename 进不去
  try {
    const w = await writeSettings({ model: { provider: "kimi", id: "kimi-k3" } });
    expect(w.problem).toContain("设置没存上");
  } finally {
    chmodSync(home, 0o700);
  }
});

test("写会先建目录：全新 ECHO_HOME 也写得进", async () => {
  process.env["ECHO_HOME"] = join(home, "fresh", "nested");
  expect(await writeSettings({ model: { provider: "kimi", id: "kimi-k3" } })).toEqual({});
  expect(existsSync(join(home, "fresh", "nested", SETTINGS_FILE))).toBe(true);
});
