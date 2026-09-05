// 隔离安装门：**把包拷出去、只按它自己的 `package.json` 装一次、真跑一次 `--help`**。
//
// 为什么必须有这道门（review 实测的 P0）：`bin/echo-agent.ts` 里 `import ... from "@echo-agent/core"`，
// 而 `dependencies` 里原本没有它——仓库里跑得通，是因为 workspace 的 `bun install` 把所有包的依赖
// 平铺进同一个 `node_modules`。装到别处就 `Cannot find module '@echo-agent/core'`，连 `--help` 都出不来。
// **「在仓库里能跑」证明不了「装出去能跑」**，只有隔离安装能证明。
//
// 手法：拷贝 → 把 `workspace:` 换成同等语义的 `file:` → 装 → 跑。
// **改的是协议不是依赖**：依赖条目本身一条不增不减。

import { test, expect } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PKG_ROOT = join(import.meta.dir, "..");
const REPO_ROOT = join(PKG_ROOT, "../..");

/**
 * **本门只在仓库里成立**：它要拿 `packages/core` 的源码去装。
 *
 * 为什么要这条守卫（2026-08-31 实测）：仓库级的分发门会把**本包整个拷出去**再跑一遍它自己的单测，
 * 于是这条测试在那个副本里又要去找 `../core`——找不到，红。**那不是缺陷，是前提不成立**：
 * 「装出去还能再打一次包」从来不是这道门要证明的事。
 * 缺前提就诚实跳过，而不是让它在一个它管不着的场景里判红。
 */
const IN_REPO = existsSync(join(REPO_ROOT, "packages/core/package.json"));

function sh(cmd: string[], cwd: string): { ok: boolean; out: string } {
  const p = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  return { ok: p.exitCode === 0, out: `${p.stdout.toString()}${p.stderr.toString()}` };
}

/** 拷一个包（跳过 node_modules 与构建产物——它们本来就不该进发布物）。 */
function copyPackage(from: string, to: string): void {
  cpSync(from, to, {
    recursive: true,
    filter: (src) => !src.includes("node_modules") && !src.endsWith("/dist"),
  });
}

(IN_REPO ? test : test.skip)(
  "隔离安装：拷出去、按自己的 package.json 装、`echo-agent --help` 退出码 0",
  () => {
    const stage = mkdtempSync(join(tmpdir(), "echo-tui-isolation-"));
    try {
      const coreDir = join(stage, "core");
      const tuiDir = join(stage, "tui");
      copyPackage(join(REPO_ROOT, "packages/core"), coreDir);
      copyPackage(PKG_ROOT, tuiDir);

      const pkgPath = join(tuiDir, "package.json");
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { dependencies: Record<string, string> };
      // **先断言依赖声明齐全**——漏了 `@echo-agent/core` 下面就装不出来，但报错会指向 npm 404，
      // 那时不容易一眼看出根因，所以这里先说清楚。
      expect(Object.keys(pkg.dependencies).sort()).toEqual(["@earendil-works/pi-tui", "@echo-agent/core"]);
      pkg.dependencies["@echo-agent/core"] = `file:${coreDir}`;
      writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));

      const install = sh(["bun", "install"], tuiDir);
      expect([install.ok, install.out.slice(-500)]).toEqual([true, install.out.slice(-500)]);

      const help = sh(["bun", "bin/echo-agent.ts", "--help"], tuiDir);
      expect([help.ok, help.out.slice(0, 500)]).toEqual([true, help.out.slice(0, 500)]);
      expect(help.out).toContain("用法：echo-agent");
      expect(help.out).toContain("--provider");
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }
  },
  180_000,
);

test("exports 不许承诺不存在的产物", () => {
  const pkg = JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8")) as {
    exports?: Record<string, unknown>;
    scripts?: Record<string, string>;
  };
  const root = pkg.exports?.["."] as Record<string, string> | undefined;
  // 本包不构建、不发 dist：上一版照抄 core 的四支形状，于是 exports 指向一个不存在的
  // `dist/index.js`——干净安装后 `import("echo-agent")` 直接找不到文件（review 实测）。
  // 要发 npm 就补 build / prepack / files 与产物门；在那之前**只留 `bun` 一条支**，不写空头支票。
  expect(Object.keys(root ?? {})).toEqual(["bun"]);
  expect(pkg.scripts?.["build"]).toBeUndefined();
});
