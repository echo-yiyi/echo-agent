import { describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// **Distribution Gate**（第二层门）：`@echo-agent/core` 这个 npm 包**真的可消费吗**。
//
// 它回答的问题与另一道门不同：
//   · `packages/cli/test/package-isolation.test.ts` 看的是**拷出去的目录**能不能独立 typecheck；
//   · 本门看的是**打包产物**——`pack` 出来的 tarball 装到一个干净项目里，
//     照着 `exports` 表 import，能不能真的跑起来。
//
// 为什么那道门盖不住这一条：它还在 workspace 里，`@echo-agent/core` 是软链，
// `exports` 写错、`files` 漏文件、依赖漏声明——**一个都发现不了**，因为源码就在旁边。
// 只有装一次真实产物才谈得上「用户拿到的东西能用」。
//
// **Node 与 Bun 两侧都覆盖**（§13.9 的要求）。
// Node 侧一度只能 skip——`exports` 直接指向 `.ts`，Node 不转译 TypeScript。
// 2026-08-18 补上 build（`tsc` 出 `.js` + `.d.ts`，`exports` 改条件导出：
// `bun` 支给 workspace 与 Bun，`import`/`default` 支给 Node），这条才真跑得起来。

const ROOT = join(import.meta.dir, "..");
const CORE = join(ROOT, "packages", "core");

function sh(cmd: string[], cwd: string): { ok: boolean; out: string } {
  const r = Bun.spawnSync(cmd, { cwd, env: { ...process.env } });
  return { ok: r.exitCode === 0, out: `${r.stdout.toString()}\n${r.stderr.toString()}`.trim() };
}

/** build → pack。返回工作目录与 tarball 的**绝对**路径。 */
function packCore(): { work: string; tarball: string; cleanup: () => void } {
  const work = mkdtempSync(join(tmpdir(), "echo-dist-"));
  const cleanup = (): void => rmSync(work, { recursive: true, force: true });

  // **先 build**：产物不在仓库里，`files` 只收 `dist/`，不 build 就 pack 出一个空壳。
  const built = sh(["bun", "run", "build"], CORE);
  if (!built.ok) {
    cleanup();
    throw new Error(`build 失败（拿不到产物就是红，不跳过）：${built.out}`);
  }
  const packed = sh(["bun", "pm", "pack", "--destination", work], CORE);
  if (!packed.ok) {
    cleanup();
    throw new Error(`pack 失败（拿不到产物就是红，不跳过）：${packed.out}`);
  }
  const tarball = readdirSync(work).find((f) => f.endsWith(".tgz"));
  if (tarball === undefined) {
    cleanup();
    throw new Error(`pack 没产出 .tgz：${readdirSync(work).join("、")}`);
  }
  return { work, tarball: join(work, tarball), cleanup };
}

/** 打包 → 建一个只依赖它的消费者项目。返回消费者目录。 */
function packAndInstall(): { consumer: string; cleanup: () => void } {
  const { work, tarball, cleanup } = packCore();

  const consumer = join(work, "consumer");
  mkdirSync(consumer, { recursive: true });
  writeFileSync(
    join(consumer, "package.json"),
    JSON.stringify({ name: "dist-gate-consumer", private: true, dependencies: { "@echo-agent/core": `file:${tarball}` } }),
  );
  const installed = sh(["bun", "install", "--no-save"], consumer);
  if (!installed.ok) {
    cleanup();
    throw new Error(`装产物失败：${installed.out}`);
  }
  return { consumer, cleanup };
}

/**
 * 把一个包的 **git tracked** 文件原样拷进目标目录（同 `packages/cli/test/package-isolation.test.ts`）。
 * 只拷 tracked 的，顺带证明「这个包在 git 里是完整的」——漏 add 一个文件，这里会红在缺文件上。
 */
function copyTracked(pkgRel: string, dest: string): number {
  const listed = sh(["git", "ls-files", pkgRel], ROOT);
  if (!listed.ok) throw new Error(`git ls-files 失败（取不到文件清单就是红）：${listed.out}`);
  const files = listed.out.split("\n").filter(Boolean);
  for (const f of files) {
    const target = join(dest, f.slice(pkgRel.length + 1));
    mkdirSync(dirname(target), { recursive: true });
    cpSync(join(ROOT, f), target);
  }
  return files.length;
}

/**
 * pack `echo-agent`（`packages/cli`）自己：拷 tracked 文件、把它对 core 的 workspace 链接换成
 * core 的真 tarball、`bun pm pack`。返回 tarball 的绝对路径。
 *
 * 两处要它：`echo-agent` 自己的分发门，以及**依赖它的产品**（`echo-coding`）——后者装到别处时，
 * `echo-agent: workspace:*` 同样解析不了，得指向一个真 tarball。
 */
function packCli(work: string, coreTgz: string): string {
  const src = join(work, "tui-src");
  expect(copyTracked("packages/cli", src)).toBeGreaterThan(5);
  const srcPkgPath = join(src, "package.json");
  const srcPkg = JSON.parse(readFileSync(srcPkgPath, "utf8")) as {
    bin: Record<string, string>;
    dependencies: Record<string, string>;
  };
  // bin 字段是分发门的前提：它没了，`.bin` 那条断言的失败原因会指向别处
  expect(Object.keys(srcPkg.bin)).toEqual(["echo-agent"]);
  srcPkg.dependencies["@echo-agent/core"] = `file:${coreTgz}`;
  writeFileSync(srcPkgPath, JSON.stringify(srcPkg, null, 2));

  const out = join(work, "tui-pack");
  mkdirSync(out, { recursive: true });
  const packed = sh(["bun", "pm", "pack", "--destination", out], src);
  expect([packed.ok, packed.out.slice(-400)]).toEqual([true, packed.out.slice(-400)]);
  const tgz = readdirSync(out).find((f) => f.endsWith(".tgz"));
  expect([out, tgz !== undefined]).toEqual([out, true]);
  return join(out, tgz!);
}

/**
 * **点名的消费者，逐个验一遍**。
 *
 * 它们平时靠 workspace 软链吃到 `@echo-agent/core` 的**源码**，于是「只用公开面」「产物够它用」
 * 两句话都没验过：软链下面 `exports` 写漏、`files` 漏文件、深 import 越界——一个都暴露不出来。
 *
 * 这里把那条软链换成**真 tarball**，其余一律不动（各自的 tsconfig、各自的单测），
 * 然后跑它**既有的**两道门。故意不另写 smoke：能 typecheck 说明 `src` 与 `.d.ts` 两条解析
 * 路径都在产物里，全套单测绿说明运行时也真跑得起来，比现编一个 hello-world 强。
 *
 * @param minFiles 该包 tracked 文件数的下限，防「拷了个空目录然后一切皆绿」。
 */
function isolatedConsumer(pkgRel: string, minFiles: number, extraDeps: readonly string[] = []): void {
  const { work, tarball, cleanup } = packCore();
  try {
    const dir = join(work, pkgRel.split("/").at(-1)!);
    expect(copyTracked(pkgRel, dir)).toBeGreaterThan(minFiles);

    // `workspace:*` 在没有 workspace 的地方解析不了——换成同等语义的 `file:` 指 tarball。
    // **改的是协议不是依赖**：依赖仍恰好是「`@echo-agent/core` + 显式登记的那几条」，这里当场断言住。
    //
    // `extraDeps` 是 2026-08-31 加的，只为 TUI 一家：它有一条真实的外部运行时依赖
    // （`@earendil-works/pi-tui`，终端渲染库）。**不是把判据放宽成「随便几条都行」**——
    // 要多一条就得在调用处写出来，写不出来就是红。判据仍然是「恰好等于」，只是等号右边由调用方声明。
    const pkgPath = join(dir, "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { dependencies: Record<string, string> };
    expect([pkgRel, Object.keys(pkg.dependencies).sort()]).toEqual([pkgRel, ["@echo-agent/core", ...extraDeps].sort()]);
    pkg.dependencies["@echo-agent/core"] = `file:${tarball}`;
    // 依赖 `echo-agent` 的产品（`echo-coding`）：那条 workspace 链接同样换成真 tarball——
    // 它对 core 的依赖已经在 `packCli()` 里指向了同一个 core tarball。
    if (pkg.dependencies["echo-agent"] === "workspace:*") pkg.dependencies["echo-agent"] = `file:${packCli(work, tarball)}`;
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));

    const install = sh(["bun", "install"], dir);
    expect([install.ok, install.out.slice(-400)]).toEqual([true, install.out.slice(-400)]);

    const tsc = sh(["bunx", "tsc", "--noEmit"], dir);
    expect([tsc.ok, tsc.out.slice(0, 800)]).toEqual([true, tsc.out.slice(0, 800)]);

    const t = sh(["bun", "test", "test"], dir);
    expect([t.ok, t.out.slice(-800)]).toEqual([true, t.out.slice(-800)]);
  } finally {
    cleanup();
  }
}

/**
 * examples 是第三个消费者（§13.11）。它们**不是 workspace 成员**——判据就是「装 tarball 能用」，
 * 进了 workspace 会被软链掉，那句话当场失效。所以这里的 `file:` 替换是它们**唯一**的装法。
 *
 * 两档判据，分开是因为**诚实**：需要模型凭据的样例在 CI 里跑不了，那就只验它 typecheck，
 * 不假装跑过；不需要凭据的样例**真的执行**并检查输出。
 *
 * @param runnable 不需要凭据、可以真跑的样例：额外执行 `bun index.ts` 并把 stdout 交给校验。
 */
function isolatedExample(name: string, runnable?: (stdout: string) => void): void {
  const { work, tarball, cleanup } = packCore();
  try {
    const dir = join(work, `example-${name}`);
    expect(copyTracked(`examples/${name}`, dir)).toBeGreaterThan(2);

    const pkgPath = join(dir, "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { dependencies: Record<string, string> };
    // 样例只许依赖这一个包——多一条就说明「装一个包就能用」这句话是假的
    expect([name, Object.keys(pkg.dependencies)]).toEqual([name, ["@echo-agent/core"]]);
    pkg.dependencies["@echo-agent/core"] = `file:${tarball}`;
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));

    const install = sh(["bun", "install"], dir);
    expect([install.ok, install.out.slice(-400)]).toEqual([true, install.out.slice(-400)]);

    // 样例的 tsconfig 是**普通用户会写的那种**（没有 `customConditions`），
    // 于是这里走的是 `types` 支的 `.d.ts`——顺带验了产物的类型面对外真能用。
    const tsc = sh(["bunx", "tsc", "--noEmit"], dir);
    expect([tsc.ok, tsc.out.slice(0, 800)]).toEqual([true, tsc.out.slice(0, 800)]);

    if (runnable !== undefined) {
      const r = sh(["bun", "index.ts"], dir);
      expect([r.ok, r.out.slice(-800)]).toEqual([true, r.out.slice(-800)]);
      runnable(r.out);
    }
  } finally {
    cleanup();
  }
}

describe("Distribution Gate：打包产物能被真实消费", () => {
  test(
    "Bun：装 tarball → 走 exports 表 import → 跑通一次模型调用 + 工具调用",
    () => {
      const { consumer, cleanup } = packAndInstall();
      try {
        // 消费脚本**只走公开 specifier**：根入口 + `/testing` 子路径。
        // 一旦 exports 表写错或产物漏文件，这里会直接 import 失败。
        writeFileSync(
          join(consumer, "run.ts"),
          [
            'import { Agent, toolOk } from "@echo-agent/core";',
            'import { FAKE_MODEL, scriptedStreamFn, textTurn, toolTurn } from "@echo-agent/core/testing";',
            "",
            "const agent = new Agent({",
            "  model: FAKE_MODEL,",
            '  streamFunction: scriptedStreamFn([toolTurn("c1", "ping", {}), textTurn("done")]),',
            "  tools: [{",
            '    kind: "model" as const,',
            '    name: "ping",',
            '    label: "ping",',
            '    description: "回一个 pong",',
            '    parameters: { type: "object" as const, properties: {} },',
            '    execute: async () => toolOk("pong"),',
            "  }],",
            "});",
            'const result = await agent.prompt("跑一次");',
            "console.log(JSON.stringify({",
            "  outcome: result.outcome.kind,",
            "  messages: agent.messages.length,",
            '  sawTool: agent.messages.some((m) => m.role === "toolResult"),',
            "}));",
          ].join("\n"),
        );

        const run = sh(["bun", "run", "run.ts"], consumer);
        expect(run.ok, `消费产物跑失败：\n${run.out}`).toBe(true);

        const line = run.out.split("\n").filter(Boolean).at(-1) ?? "{}";
        const got = JSON.parse(line) as { outcome: string; messages: number; sawTool: boolean };
        expect(got.outcome).toBe("completed");
        expect(got.messages).toBeGreaterThan(2); // user + assistant + tool_result 至少三条
        expect(got.sawTool).toBe(true); // 工具真的被执行了，不只是发出了 tool_use
      } finally {
        cleanup();
      }
    },
    120_000,
  );

  test(
    "产物里没有 node_modules，也没把 workspace 依赖打进去（零运行时依赖要在产物上成立）",
    () => {
      const { consumer, cleanup } = packAndInstall();
      try {
        const pkgDir = join(consumer, "node_modules", "@echo-agent", "core");
        const inner = readdirSync(pkgDir);
        expect(inner).not.toContain("node_modules");
        // `dependencies` 恒空这条，在装完的产物上再验一次——manifest 说空、装出来却带东西，
        // 那才是用户会踩到的形态
        const manifest = JSON.parse(
          Bun.spawnSync(["cat", join(pkgDir, "package.json")]).stdout.toString(),
        ) as Record<string, unknown>;
        expect(manifest["dependencies"] ?? {}).toEqual({});
        expect(manifest["optionalDependencies"] ?? {}).toEqual({});
        expect(manifest["peerDependencies"] ?? {}).toEqual({});
      } finally {
        cleanup();
      }
    },
    120_000,
  );

  test(
    "Node：装 tarball → 走 exports 表 import → 跑通一次模型调用 + 工具调用",
    () => {
      const { consumer, cleanup } = packAndInstall();
      try {
        // **与 Bun 那条同一份判据**，只换运行时。Node 走 `import`/`default` 支（dist 产物），
        // Bun 走 `bun` 支（源码）——两条路都得真能跑，否则「谁装谁能用」只对一半人成立。
        writeFileSync(
          join(consumer, "run.mjs"),
          [
            'import { Agent, toolOk } from "@echo-agent/core";',
            'import { FAKE_MODEL, scriptedStreamFn, textTurn, toolTurn } from "@echo-agent/core/testing";',
            "",
            "const agent = new Agent({",
            "  model: FAKE_MODEL,",
            '  streamFunction: scriptedStreamFn([toolTurn("c1", "ping", {}), textTurn("done")]),',
            "  tools: [{",
            '    kind: "model",',
            '    name: "ping",',
            '    label: "ping",',
            '    description: "回一个 pong",',
            '    parameters: { type: "object", properties: {} },',
            '    execute: async () => toolOk("pong"),',
            "  }],",
            "});",
            'const result = await agent.prompt("跑一次");',
            "console.log(JSON.stringify({",
            "  outcome: result.outcome.kind,",
            "  messages: agent.messages.length,",
            '  sawTool: agent.messages.some((m) => m.role === "toolResult"),',
            "}));",
          ].join("\n"),
        );

        const run = sh(["node", "run.mjs"], consumer);
        expect(run.ok, `Node 消费产物跑失败：\n${run.out}`).toBe(true);

        const line = run.out.split("\n").filter(Boolean).at(-1) ?? "{}";
        const got = JSON.parse(line) as { outcome: string; messages: number; sawTool: boolean };
        expect(got.outcome).toBe("completed");
        expect(got.messages).toBeGreaterThan(2);
        expect(got.sawTool).toBe(true);
      } finally {
        cleanup();
      }
    },
    180_000,
  );

  test(
    "exports 的每条 dist 支在装完之后都真实存在（含 .d.ts，不然 TS 用户拿到 any）",
    () => {
      // **仓内的静态检查守不到这一半**：仓库里只有源码（`bun` 支指源码），`dist/` 是 build
      // 产出、不在仓库，静态检查只能跳过。跳过的部分必须有人接着——就是这里：
      // build + pack + install 之后，逐条 dist 路径落地检查。
      // 少了这条，`./mcp` 之类子路径的 dist 写错了也没人管，直到 Node 用户 import 才炸。
      const { consumer, cleanup } = packAndInstall();
      try {
        const installed = join(consumer, "node_modules", "@echo-agent", "core");
        const table = JSON.parse(readFileSync(join(installed, "package.json"), "utf8")).exports as Record<
          string,
          string | Record<string, string>
        >;

        const missing: string[] = [];
        let checked = 0;
        for (const [key, target] of Object.entries(table)) {
          if (typeof target === "string") continue; // `./package.json` 这种单串条目
          for (const [cond, path] of Object.entries(target)) {
            if (!path.startsWith("./dist/")) continue;
            checked++;
            if (!existsSync(join(installed, path))) missing.push(`${key}(${cond}) → ${path}`);
          }
        }
        expect(missing).toEqual([]);
        // 一条都没检到 = 判据自己失效了（比如 exports 结构变了），别静默通过。
        expect(checked).toBeGreaterThan(0);

        // 类型不只是「文件在」，还得真带出符号来。
        expect(readFileSync(join(installed, "dist", "index.d.ts"), "utf8")).toContain("Agent");
      } finally {
        cleanup();
      }
    },
    180_000,
  );
  // 两个消费者。判据同形，理由见下面 coding 那条。
  // examples 是第三个：它们不是 workspace 成员，走的路不同，本门不覆盖。
  //
  // **`旧 runner 包` 2026-08-31 删包**（拍板方案 ③：两个 CLI 并成一个，`echo-agent` 归 `echo-agent`）。
  // 它守着的那两件事一件没丢，都并进 tui 这一条：
  //   · **`echo-agent` 真的能装出来并 spawn**——`bin` 参数，装完在隔离目录里真执行一次；
  //   · **`@echo-agent/core/extension` 扩展面够不够用**——tui 是它第一个隔离消费者。
  // 归并落点不选 `@echo-agent/core`：core 的运行时依赖恒空是硬门，而交互式终端要 `pi-tui`。
  test(
    "tui 隔离消费：把 workspace 链接换成 tarball 之后，它的 typecheck 与全套单测仍绿",
    () => {
      // pi-tui 是它真实的外部依赖（终端差分渲染），显式写出来——判据仍是「恰好等于」
      isolatedConsumer("packages/cli", 5, ["@earendil-works/pi-tui"]);
    },
    300_000,
  );

  // **`echo-agent` 的分发门**（2026-08-31 review 三轮 P1）。
  //
  // 上一版把它挂在 `isolatedConsumer` 上，那是**假门**：那条路径 pack 的只有 core，
  // TUI 本身是 `copyTracked()` 拷进临时目录、然后直接 `bun bin/echo-agent.ts` 跑**源文件**。
  // 于是三件真正要证明的事一件都没证明——
  //   · `echo-agent` 的 tarball 里到底收没收 `bin/` 与它 import 到的 `src/`；
  //   · 装完之后有没有生成 `node_modules/.bin/echo-agent`（`bin` 字段写错就没有）；
  //   · 用户敲那个命令时走的入口能不能执行（shebang、可执行位、依赖解析）。
  // 拷目录跑源文件对这三件事全都恒绿。这一条走真路：
  // patch 依赖 → **pack TUI 自己** → 干净 consumer 装 tarball → 从**装出来的** `.bin` 执行。
  test(
    "echo-agent 分发：pack `echo-agent` → 干净项目安装 → 从 `node_modules/.bin` 真执行",
    () => {
      const { work, tarball: coreTgz, cleanup } = packCore();
      try {
        // ①② 拷一份 TUI、把它对 core 的 workspace 链接换成 core 的真 tarball、pack 它自己（`packCli`）——
        //    不换链接的话，pack 出来的 tui 装到别处会解析不了 `workspace:*`。
        const tuiTgz = packCli(work, coreTgz);
        // tarball 里必须有 bin——`files` 字段写漏时这里当场红，而不是等用户装完发现没这个命令
        const listed = sh(["tar", "-tzf", tuiTgz], work);
        expect(listed.out).toContain("bin/echo-agent.ts");

        // ③ 干净项目，只依赖这一个 tarball——**用户拿到的就是这个**
        const consumer = join(work, "cli-consumer");
        mkdirSync(consumer, { recursive: true });
        writeFileSync(
          join(consumer, "package.json"),
          JSON.stringify({ name: "echo-cli-consumer", private: true, dependencies: { "echo-agent": `file:${tuiTgz}` } }),
        );
        const install = sh(["bun", "install"], consumer);
        expect([install.ok, install.out.slice(-400)]).toEqual([true, install.out.slice(-400)]);

        // ④ 装出来必须有这个命令
        const binPath = join(consumer, "node_modules", ".bin", "echo-agent");
        expect([binPath, existsSync(binPath)]).toEqual([binPath, true]);

        // ⑤ **从装出来的入口执行**，不是从源码目录。`--help` 是唯一不需要凭据也不起 Agent 的路径，
        //    它验的正是「这条命令能被执行」：shebang 找得到 bun、相对 import 一路解析到装进来的 core。
        const help = sh([binPath, "--help"], consumer);
        expect([help.ok, help.out.slice(0, 600)]).toEqual([true, help.out.slice(0, 600)]);
        expect(help.out).toContain("用法：echo-agent");
        expect(help.out).toContain("--provider");
      } finally {
        cleanup();
      }
    },
    300_000,
  );

  test(
    "coding 隔离消费：把 workspace 链接换成 tarball 之后，它的 typecheck 与全套单测仍绿",
    () => {
      // `echo-agent` 是它真实的依赖（启动逻辑从那儿复用，`packages/coding/src/cli.ts`），显式写出来——判据仍是「恰好等于」
      isolatedConsumer("packages/coding", 5, ["echo-agent"]);
    },
    300_000,
  );

  // **`echo-coding` 的分发门**（2026-09-01）：与 `echo-agent` 那条同形，多一层——它依赖 `echo-agent`，
  // 于是装出来的包要经过**两级** `file:` 依赖（coding → echo-agent → core）才谈得上「用户拿到的能用」。
  // 拷目录跑源文件对这一条同样恒绿（workspace 软链会把两级依赖全抹平），所以照样走真路。
  test(
    "echo-coding 分发：pack `echo-coding` → 干净项目安装 → 从 `node_modules/.bin` 真执行",
    () => {
      const { work, tarball: coreTgz, cleanup } = packCore();
      try {
        const tuiTgz = packCli(work, coreTgz);

        // ① 拷一份 coding，把它的两条 workspace 链接都换成真 tarball
        const src = join(work, "coding-src");
        expect(copyTracked("packages/coding", src)).toBeGreaterThan(5);
        const srcPkgPath = join(src, "package.json");
        const srcPkg = JSON.parse(readFileSync(srcPkgPath, "utf8")) as {
          bin: Record<string, string>;
          dependencies: Record<string, string>;
        };
        expect(Object.keys(srcPkg.bin)).toEqual(["echo-coding"]);
        srcPkg.dependencies["@echo-agent/core"] = `file:${coreTgz}`;
        srcPkg.dependencies["echo-agent"] = `file:${tuiTgz}`;
        writeFileSync(srcPkgPath, JSON.stringify(srcPkg, null, 2));

        // ② pack coding 自己
        const out = join(work, "coding-pack");
        mkdirSync(out, { recursive: true });
        const packed = sh(["bun", "pm", "pack", "--destination", out], src);
        expect([packed.ok, packed.out.slice(-400)]).toEqual([true, packed.out.slice(-400)]);
        const codingTgz = readdirSync(out).find((f) => f.endsWith(".tgz"));
        expect([out, codingTgz !== undefined]).toEqual([out, true]);
        // `files` 漏了 `bin` 就是发出去一个没有命令的包——在 tarball 上当场红
        const listed = sh(["tar", "-tzf", join(out, codingTgz!)], out);
        expect(listed.out).toContain("bin/echo-coding.ts");

        // ③ 干净项目，只依赖这一个 tarball——**用户拿到的就是这个**
        const consumer = join(work, "coding-consumer");
        mkdirSync(consumer, { recursive: true });
        writeFileSync(
          join(consumer, "package.json"),
          JSON.stringify({ name: "echo-coding-consumer", private: true, dependencies: { "echo-coding": `file:${join(out, codingTgz!)}` } }),
        );
        const install = sh(["bun", "install"], consumer);
        expect([install.ok, install.out.slice(-400)]).toEqual([true, install.out.slice(-400)]);

        // ④ 装出来必须有这个命令
        const binPath = join(consumer, "node_modules", ".bin", "echo-coding");
        expect([binPath, existsSync(binPath)]).toEqual([binPath, true]);

        // ⑤ **从装出来的入口执行**。`--help` 打的必须是**本产品**的用法：名字走的是 `Product`，
        //    所以这一步顺带证明 `echo-agent` 的 `mainFor()` 在装出来的包上真被复用了（两级依赖都解析到了）。
        const help = sh([binPath, "--help"], consumer);
        expect([help.ok, help.out.slice(0, 600)]).toEqual([true, help.out.slice(0, 600)]);
        expect(help.out).toContain("用法：echo-coding");
        expect(help.out).toContain("--provider");
      } finally {
        cleanup();
      }
    },
    300_000,
  );
  test(
    "examples/scripted：装 tarball → typecheck → **真的跑一遍**并检查输出",
    () => {
      isolatedExample("scripted", (out) => {
        const line = out.split("\n").filter(Boolean).at(-1) ?? "{}";
        const got = JSON.parse(line) as { outcome: string; toolOutput: string; toolErrored: boolean };
        expect(got.outcome).toBe("completed");
        // **判据落在工具真正返回的内容上**。第一版只数「有没有一条 toolResult」，
        // 于是把样例的工具整个摘掉它照样绿——工具不存在时循环也会回一条 toolResult
        // （内容是「没这个工具」）。摘工具能红，这条判据才算数。
        expect(got.toolErrored, "工具报错了（多半是压根没注册上）").toBe(false);
        expect(got.toolOutput, "工具没把 2026 返回回来").toContain("2026");
      });
    },
    300_000,
  );

  test(
    "examples/extension：装 tarball → typecheck → **真的跑一遍**，证明扩展自动发现在装出来的包上也成立",
    () => {
      isolatedExample("extension", (out) => {
        const line = out.split("\n").filter(Boolean).at(-1) ?? "{}";
        const got = JSON.parse(line) as {
          extensions: string[];
          tools: string[];
          outcome: string;
          toolOutput: string;
          toolErrored: boolean;
        };
        // ① 内建六条在前、扫到的 `extensions/current-year.ts` 在后——
        //    这就是「内部 extension 先、外部 extension 后」那条顺序在**装出来的包上**的样子。
        //    内建也走 extension 机制（§14 owner 表），所以它们出现在清单里不是噪音，是契约。
        //    `echo:agent`（provide `AgentRuntime`）2026-08-31 起也在这份清单里：**清单就是 Host
        //    实际挂上的那一份**，它挂了却不报，清单与真相就分了家（review 二轮 P1）。
        //    `echo:compaction`（缺省压缩阶梯 + transcript_read）2026-09-02 起同理。
        expect(got.extensions).toEqual([
          "echo:agent",
          "echo:tasks",
          "echo:skills",
          "echo:memory",
          "echo:scheduler",
          "echo:tool-search",
          "echo:compaction",
          "current-year",
        ]);
        // ② 工具**进了模型看得见的那一面**（样例一个工具都没显式传，全靠扩展）
        expect(got.tools).toContain("current_year");
        // ③ **真被行使**：不看条数看内容——工具不存在时也会回一条 toolResult（内容是「没这个工具」）。
        //    这条同时是 `@echo-agent/core/extension` 这条公共面真的能用的证明：装出来的包里若没有它，
        //    扩展文件在 typecheck 那一步就红了。
        expect(got.outcome).toBe("completed");
        expect(got.toolErrored, "工具报错了（多半是压根没注册上）").toBe(false);
        expect(got.toolOutput, "工具没把 2026 返回回来").toContain("2026");
      });
    },
    300_000,
  );

  test(
    "examples/hello：装 tarball → typecheck（需要凭据，**不假装跑过**）",
    () => {
      isolatedExample("hello");
    },
    300_000,
  );
  test(
    "LICENSE 随发布包走：tarball 里有，且与仓库根那份字节一致；声明了 license 的包目录里也有同一份",
    () => {
      // 2026-08-25 review：`license: "MIT"` 只是 SPDX 元数据，仓库根的 LICENSE **不会**自动进
      // workspace 子包——实跑 `npm pack --dry-run` 两个包都没带 LICENSE，core README 里
      // 「见仓库根 LICENSE」到了安装包里也不可达。这里从产物上断言，防以后再掉。
      const rootLicense = readFileSync(join(ROOT, "LICENSE"), "utf8");
      expect(rootLicense, "根 LICENSE 不是 MIT 正文").toContain("MIT License");

      // ① 每个声明了 license 的包目录里必须有同一份（不然 pack 出来的就没有）
      for (const name of readdirSync(join(ROOT, "packages"))) {
        const manifest = join(ROOT, "packages", name, "package.json");
        if (!existsSync(manifest)) continue;
        const pkg = JSON.parse(readFileSync(manifest, "utf8")) as { license?: string };
        if (pkg.license === undefined) continue;
        const copy = join(ROOT, "packages", name, "LICENSE");
        expect(existsSync(copy), `packages/${name} 声明了 license 却没有 LICENSE 文件`).toBe(true);
        expect(readFileSync(copy, "utf8") === rootLicense, `packages/${name}/LICENSE 与根不一致`).toBe(true);
      }

      // ② 真 pack 真装：装出来的 @echo-agent/core 里有它
      const { consumer, cleanup } = packAndInstall();
      try {
        const installed = join(consumer, "node_modules", "@echo-agent", "core", "LICENSE");
        expect(existsSync(installed), "tarball 里没有 LICENSE").toBe(true);
        expect(readFileSync(installed, "utf8") === rootLicense, "tarball 里的 LICENSE 与根不一致").toBe(true);
      } finally {
        cleanup();
      }
    },
    180_000,
  );
});
