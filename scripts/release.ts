// 发布的**唯一执行路径**：本地首发与 `.github/workflows/release.yml` 走同一段代码。
//
//   bun scripts/release.ts                               缺省是演练：打包、跑守卫、`npm publish --dry-run`，不上传
//   bun scripts/release.ts --publish                     真发。**只有显式给了 `--publish` 才会上传**
//   bun scripts/release.ts --publish --git-tag v0.2.0    真发，并断言 tag 与版本一致（CI 用这一行）
//
// 上传不可撤回，所以默认值必须落在无害的一边：缺省演练，真发要显式开关；任何不认识的参数都退出 2，
// 不会被当成别的意思。
//
// 凭据由调用方给：本地是 `~/.npmrc`，CI 是 trusted publishing（OIDC）。本脚本不碰凭据。
//
// ## 为什么是「bun 打包 + npm 发布」，不是 `bun publish`
//
//   · 只有 bun 会把 `workspace:*` 改写成版本号。`npm pack` 原样保留，发出去的包装不上
//     （实测：包目录里跑、仓库根 `-w` 跑都一样）。
//   · 只有 npm 能走 trusted publishing。`bun publish` 的认证只有 `NPM_CONFIG_TOKEN` 与 OTP。
//   · npm 直接收 bun 打出的 tarball：`npm publish ./x.tgz`（dry-run 实测）。
//
// ## 守卫：任何一条不满足，一个包都不发
//
//   · `packages/` 下每个包都在 `ORDER` 里——新加的包不会被静默漏发。
//   · 所有包版本相同；给了 `--git-tag` 时它等于 `v<版本>`。包之间是精确版本依赖，只能锁步发版。
//   · 每个 tarball 里对别的工作区包的依赖**恰好钉在这个版本**。抓的是「改了版本号、没重建
//     bun.lock」：那时 bun 按旧 lockfile 写出旧版本号，发出去的包依赖一个永远不存在的版本。
//     修法是删掉 bun.lock 重跑 `bun install`——`bun install --force` 也不刷新它（实测）。
//   · tarball 里没有 `test/`、`*.test.ts`、tsconfig。
//
// 先把全部包打完、全部过完守卫，才发第一个——守卫红了不能留下半套已发布的包。
//
// ## 能重跑
//
// 按依赖顺序发；registry 上已有这个版本的包跳过。中途失败，修好后原样重跑即可。只有 E404 算
// 「还没发」；网络、权限之类的错误直接红——不能把「查不到」当成「没发过」。
//
// ## 证明不了什么
//
//   · 守卫只看 tarball 的形状，不看代码对不对——那是 typecheck 与测试的事，CI 在调本脚本前跑。
//   · `--dry-run` 证明不了 OIDC 那一步：`repository.url` 是否与仓库精确匹配只在服务端比对，
//     第一次由 CI 发版时才验。
//   · core 的 `dist/` 由它的 `prepack`（`bun run build`）在打包时产出，本脚本不另外 build。

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

/** 发布顺序即依赖顺序：每个包只依赖排在它前面的。 */
const ORDER = ["core", "base", "tui", "cli", "coding"] as const;

type Manifest = { name: string; version: string; dependencies?: Record<string, string> };
type Packed = { name: string; version: string; tgz: string };

function run(cmd: string[], cwd: string): { code: number; stdout: string; stderr: string } {
  const r = Bun.spawnSync(cmd, { cwd, env: process.env, stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode ?? 1, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
}

function fail(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

function manifest(dir: string): Manifest {
  return JSON.parse(readFileSync(join(ROOT, "packages", dir, "package.json"), "utf8")) as Manifest;
}

/** `packages/` 下的每个包都登记在 `ORDER` 里，反之亦然。 */
function checkComplete(): void {
  const onDisk = readdirSync(join(ROOT, "packages"))
    .filter((d) => existsSync(join(ROOT, "packages", d, "package.json")))
    .sort();
  const listed = [...ORDER].sort();
  if (JSON.stringify(onDisk) !== JSON.stringify(listed)) {
    fail(`packages/ 下的包 [${onDisk.join(", ")}] 与发布顺序 ORDER [${listed.join(", ")}] 不一致——增删包时同步改 ORDER`);
  }
}

function tarManifest(tgz: string): Manifest {
  const r = run(["tar", "-xzOf", tgz, "package/package.json"], ROOT);
  if (r.code !== 0) fail(`读不了 ${tgz} 里的 package.json：${r.stderr}`);
  return JSON.parse(r.stdout) as Manifest;
}

function tarList(tgz: string): string[] {
  const r = run(["tar", "-tzf", tgz], ROOT);
  if (r.code !== 0) fail(`读不了 ${tgz}：${r.stderr}`);
  return r.stdout.split("\n").filter(Boolean);
}

function pack(dir: string, out: string): string {
  const before = new Set(readdirSync(out));
  const r = run(["bun", "pm", "pack", "--destination", out], join(ROOT, "packages", dir));
  if (r.code !== 0) fail(`packages/${dir} 打包失败：${(r.stdout + r.stderr).slice(-600)}`);
  const made = readdirSync(out).filter((f) => f.endsWith(".tgz") && !before.has(f));
  if (made.length !== 1) fail(`packages/${dir} 打包后应恰好多出一个 tarball，实际 ${made.length} 个`);
  return join(out, made[0]!);
}

/** 这个版本在 registry 上已经有了吗？只有 E404 算「没有」，别的错误一律红。 */
function published(name: string, version: string): boolean {
  const r = run(["npm", "view", `${name}@${version}`, "version"], ROOT);
  if (r.code === 0 && r.stdout.trim() === version) return true;
  if (r.code !== 0 && /\bE404\b/.test(r.stderr)) return false;
  fail(`查不清 ${name}@${version} 是否已发布（npm view 退出码 ${r.code}）：${(r.stdout + r.stderr).slice(-400)}`);
}

if (import.meta.main) {
  // 逐个吃参数，不认识的一律退出 2——宁可拒跑，也不能把一个拼错的参数当成「真发」。
  const usage = (): never => {
    console.error("用法：bun scripts/release.ts [--publish] [--git-tag v<版本>]（缺省是演练，只有 --publish 才上传）");
    process.exit(2);
  };
  const args = process.argv.slice(2);
  let publish = false;
  let dryRunFlag = false;
  let gitTag: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--publish") publish = true;
    else if (a === "--dry-run") dryRunFlag = true; // 缺省就是演练；允许显式写出来
    else if (a === "--git-tag") {
      gitTag = args[++i];
      if (gitTag === undefined || gitTag.startsWith("--")) usage();
    } else usage();
  }
  if (publish && dryRunFlag) usage();
  const dryRun = !publish;

  checkComplete();

  const versions = ORDER.map((d) => [d, manifest(d).version] as const);
  const distinct = [...new Set(versions.map(([, v]) => v))];
  if (distinct.length !== 1) fail(`各包版本不一致：${versions.map(([d, v]) => `${d}=${v}`).join(" ")}——包之间是精确版本依赖，只能锁步发版`);
  const version = distinct[0]!;
  if (gitTag !== undefined && gitTag !== `v${version}`) fail(`tag ${gitTag} 与包版本 ${version} 不一致`);

  const names = new Set(ORDER.map((d) => manifest(d).name));
  const out = mkdtempSync(join(tmpdir(), "echo-release-"));
  try {
    const packed: Packed[] = [];
    for (const dir of ORDER) {
      const tgz = pack(dir, out);
      const m = tarManifest(tgz);
      if (m.version !== version) fail(`${m.name} 的 tarball 版本是 ${m.version}，应为 ${version}`);
      for (const [dep, spec] of Object.entries(m.dependencies ?? {})) {
        if (spec.startsWith("workspace:") || spec.startsWith("file:")) fail(`${m.name} 的 tarball 里 ${dep} 仍是 "${spec}"，发出去装不上`);
        if (names.has(dep) && spec !== version) {
          fail(`${m.name} 的 tarball 里 ${dep} 钉在 "${spec}"，应为 "${version}"——多半是改了版本号没重建 bun.lock：删掉它再 bun install`);
        }
      }
      const leaked = tarList(tgz).filter((f) => /^package\/test\/|\.test\.ts$|(^|\/)tsconfig[^/]*\.json$/.test(f));
      if (leaked.length > 0) fail(`${m.name} 的 tarball 混进了测试或 tsconfig：${leaked.join(", ")}`);
      packed.push({ name: m.name, version, tgz });
      console.log(`  ✓ 打包  ${m.name}@${version}`);
    }

    for (const p of packed) {
      if (published(p.name, p.version)) {
        console.log(`  · 跳过  ${p.name}@${p.version}（registry 上已有）`);
        continue;
      }
      const cmd = ["npm", "publish", `./${p.tgz.split("/").at(-1)}`];
      if (p.name.startsWith("@")) cmd.push("--access", "public"); // scoped 包缺省是 restricted
      if (dryRun) cmd.push("--dry-run");
      const r = run(cmd, out);
      if (r.code !== 0) fail(`${p.name}@${p.version} 发布失败（排在它前面的已发出，修好后原样重跑即可）：${r.stderr.slice(-800)}`);
      console.log(`  ✓ ${dryRun ? "演练" : "发布"}  ${p.name}@${p.version}`);
    }
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
  console.log(dryRun ? `\n演练完成：${version}，一个字节都没上传` : `\n已发布 ${version}`);
}
