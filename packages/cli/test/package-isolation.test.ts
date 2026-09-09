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
      // 2026-09-09 拆包之后 `echo-agent` 是**产品**，它上面还有两层：装配层与终端壳。
      // 三个都要拷出去，并把彼此的 workspace 链接换成 `file:`——这一条正是拆包之后最容易漏的接线。
      const coreDir = join(stage, "core");
      const baseDir = join(stage, "base");
      const tuiPkgDir = join(stage, "tui");
      const productDir = join(stage, "product");
      copyPackage(join(REPO_ROOT, "packages/core"), coreDir);
      copyPackage(join(REPO_ROOT, "packages/base"), baseDir);
      copyPackage(join(REPO_ROOT, "packages/tui"), tuiPkgDir);
      copyPackage(PKG_ROOT, productDir);

      const link = (dir: string, deps: Record<string, string>): void => {
        const path = join(dir, "package.json");
        const pkg = JSON.parse(readFileSync(path, "utf8")) as { dependencies?: Record<string, string> };
        pkg.dependencies = { ...(pkg.dependencies ?? {}), ...deps };
        writeFileSync(path, JSON.stringify(pkg, null, 2));
      };
      link(baseDir, { "@echo-agent/core": `file:${coreDir}` });
      link(tuiPkgDir, { "@echo-agent/core": `file:${coreDir}`, "@echo-agent/base": `file:${baseDir}` });

      const pkgPath = join(productDir, "package.json");
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { dependencies: Record<string, string> };
      // **先断言依赖声明齐全**——漏一条下面就装不出来，但报错会指向 npm 404，
      // 那时不容易一眼看出根因，所以这里先说清楚。产品**不该**再直接依赖终端库：那是壳的事。
      expect(Object.keys(pkg.dependencies).sort()).toEqual(["@echo-agent/base", "@echo-agent/core", "@echo-agent/tui"]);
      link(productDir, {
        "@echo-agent/core": `file:${coreDir}`,
        "@echo-agent/base": `file:${baseDir}`,
        "@echo-agent/tui": `file:${tuiPkgDir}`,
      });

      // **每个 file: 链进来的包各自装一次**：链接指向 stage 外的兄弟目录，模块解析从那个真实路径往上走，
      // 走不到产品的 node_modules——所以传递依赖得在各自那一层就位。真发布（tarball / npm）没有这个问题，
      // 那条路由分发门守着。
      for (const dir of [baseDir, tuiPkgDir]) {
        const r = sh(["bun", "install"], dir);
        expect([dir, r.ok, r.out.slice(-300)]).toEqual([dir, true, r.out.slice(-300)]);
      }
      const install = sh(["bun", "install"], productDir);
      expect([install.ok, install.out.slice(-500)]).toEqual([true, install.out.slice(-500)]);

      const help = sh(["bun", "bin/echo-agent.ts", "--help"], productDir);
      expect([help.ok, help.out.slice(0, 900)]).toEqual([true, help.out.slice(0, 900)]);
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
