// 文档门禁的**唯一判据源**。
//
// **一份逻辑,两个用途**:`bun scripts/docs-lint.ts` 打印人读报告;`test/docs.test.ts`
// 拿同样的函数当判据。不另造第二套数法——`api-inventory.ts` 立的规矩,这里照办。
//
// ## 只守五件事,每件都是硬事实
//
//   roster    花名册里的文档存在;全仓没有没登记的野 md;没有孤儿 .zh.md / .i18n.yaml
//   links     相对 Markdown 链接与锚点(含同页、引用式)指向真实位置
//   code      文档里的 ts 围栏能**独立**编译
//   filerefs  注释与散文里引用的文件路径真实存在
//   pairing   双语三文件成组、两侧 blob hash 与记录一致、结构签名一致
//
// ## 曾经有过、已经撤掉的:必备 H2 小节、字数预算、CHANGELOG 条目、决策三态目录
//
// 撤的理由是同一条:它们拿**结构近似**代替**内容判断**,两头都不准——签名相同而中文侧
// 只有骨架(假绿)、README 没有猜出来的那一节而 README 并没问题(假红)。一道两头不准的门
// 会训练人忽略它的红、相信它的绿,两件都比没有门坏。
//
// ## 这些门**不能**证明什么(如实标注,别声称有守)
//
//   · pairing **只能证明两侧字节与上次按确认键时相同**,证明不了两侧在说同一件事。
//     `--write-pairing <pair>` 是人按下的确认键;门记录这次按键,不评价按得对不对。
//   · 结构签名只覆盖标题层级序列、列表容器与项数、表格行、代码块字节。
//     **正文长度与标题含义都不进签名**——中文侧可以只有骨架没有肉而全绿。
//   · code 只证明示例能编译,证明不了它示范的用法是对的。
//   · filerefs 只证明路径存在,证明不了那份文件说的是引用者以为的事。
//
// 每个 parser 都必须在 `test/docs-lint-fixtures.test.ts` 里有正反例:
// **判据本身要能分辨对错,否则零输入下的绿毫无意义**(链接门就这么空绿过一轮)。

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

export const REPO_ROOT = resolve(import.meta.dir, "..");
const MANIFEST_PATH = join(REPO_ROOT, "docs", "docs.manifest.json");

export type DocEntry = { readonly path: string; readonly bilingual: boolean };
export type Manifest = {
  readonly docs: readonly DocEntry[];
  readonly orphanExclude: readonly string[];
  /** 按定义装「举例路径」的文件——filerefs 分不清引用与举例,豁免要写明理由。 */
  readonly fileRefsExclude: readonly string[];
};
export type Violation = { readonly gate: string; readonly path: string; readonly message: string };

export function loadManifest(): Manifest {
  return JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as Manifest;
}

/* ══════════════════ Markdown 解析 ══════════════════ */

export type Heading = { readonly depth: number; readonly text: string };
type ScannedLine = { line: string; lineNo: number; inFence: boolean; fenceInfo: string; isFenceMark: boolean };

/**
 * 逐行标注是否在代码围栏内。
 * **收尾围栏必须与开头同种、不短于开头、且其后只有空白**——否则示例里的三反引号能伪造收尾,
 * 把后面真正不同的内容藏进"代码块"里(pairing 因此会假绿)。
 */
function scanLines(text: string): ScannedLine[] {
  const out: ScannedLine[] = [];
  let fence: string | null = null;
  let info = "";
  text.split("\n").forEach((line, i) => {
    const m = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
    if (m !== null) {
      const mark = m[1]!;
      const rest = m[2]!;
      if (fence === null) {
        fence = mark; info = rest.trim();
        out.push({ line, lineNo: i + 1, inFence: true, fenceInfo: info, isFenceMark: true });
        return;
      }
      if (mark[0] === fence[0] && mark.length >= fence.length && rest.trim() === "") {
        out.push({ line, lineNo: i + 1, inFence: true, fenceInfo: info, isFenceMark: true });
        fence = null; info = "";
        return;
      }
    }
    out.push({ line, lineNo: i + 1, inFence: fence !== null, fenceInfo: info, isFenceMark: false });
  });
  return out;
}

export function headings(text: string): Heading[] {
  const out: Heading[] = [];
  for (const { line, inFence } of scanLines(text)) {
    if (inFence) continue;
    const m = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (m !== null) out.push({ depth: m[1]!.length, text: m[2]! });
  }
  return out;
}

/** 标题里的行内标记先还原成纯文本:`[文字](链接)` → `文字`,去掉反引号与强调符。 */
function headingPlainText(t: string): string {
  return t
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\[[^\]]*\]/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/[*_~]/g, "");
}

/** GitHub 锚点:先还原行内标记,再小写、去标点(CJK 与下划线保留)、空格转连字符。 */
export function slug(headingText: string): string {
  return headingPlainText(headingText)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .trim()
    .replace(/\s+/g, "-");
}

/** 一份文档的全部锚点;重复标题按 GitHub 规则补 `-1`、`-2`。 */
export function anchors(text: string): Set<string> {
  const seen = new Map<string, number>();
  const out = new Set<string>();
  for (const h of headings(text)) {
    const base = slug(h.text);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.add(n === 0 ? base : `${base}-${n}`);
  }
  return out;
}

export type DocLink = { readonly target: string | null; readonly anchor: string | null; readonly line: number };

/** 行内、引用式、同页锚点三种都收;只收 `.md` 目标与同页锚点,外链与图片不管。 */
export function docLinks(text: string): DocLink[] {
  const out: DocLink[] = [];
  const refs = new Map<string, string>();
  const lines = scanLines(text);
  for (const { line, inFence } of lines) {
    if (inFence) continue;
    const d = /^\s*\[([^\]]+)\]:\s*(\S+)/.exec(line);
    if (d !== null) refs.set(d[1]!.toLowerCase(), d[2]!);
  }
  const push = (href: string, line: number): void => {
    if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//")) return;
    const hash = href.indexOf("#");
    const target = hash === -1 ? href : href.slice(0, hash);
    const anchor = hash === -1 ? "" : href.slice(hash + 1);
    if (target === "") { if (anchor !== "") out.push({ target: null, anchor, line }); return; }
    if (!target.endsWith(".md")) return;
    out.push({ target, anchor: anchor === "" ? null : anchor, line });
  };
  for (const { line, lineNo, inFence } of lines) {
    if (inFence) continue;
    if (/^\s*\[[^\]]+\]:\s*\S+/.test(line)) continue;
    for (const m of line.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) push(m[1]!, lineNo);
    for (const m of line.matchAll(/\[[^\]]*\]\[([^\]]+)\]/g)) {
      const href = refs.get(m[1]!.toLowerCase());
      if (href !== undefined) push(href, lineNo);
    }
  }
  return out;
}

/**
 * 结构签名:双语两侧必须逐项相同的东西。**只含结构,不含文字**。
 *
 * 列表按**容器**记(空行、标题、表格断开一个容器),所以「两张各一项的列表」与
 * 「一张两项的列表」签名不同——上一版把它们算成相同,是实测出来的假绿。
 */
export function structuralSignature(text: string): string[] {
  const sig: string[] = [];
  let fenceBody: string[] = [];
  let fenceOpen = false;
  let listRun = 0;
  let listKind = "";
  const flushList = (): void => {
    if (listRun > 0) sig.push(`list:${listKind}:${listRun}`);
    listRun = 0; listKind = "";
  };
  for (const { line, inFence, fenceInfo, isFenceMark } of scanLines(text)) {
    if (inFence) {
      if (isFenceMark && !fenceOpen) { flushList(); fenceOpen = true; fenceBody = []; continue; }
      if (isFenceMark && fenceOpen) { sig.push(`code:${fenceInfo}:${fenceBody.join("\n")}`); fenceOpen = false; continue; }
      fenceBody.push(line);
      continue;
    }
    const h = /^(#{1,6})\s+/.exec(line);
    if (h !== null) { flushList(); sig.push(`h${h[1]!.length}`); continue; }
    const li = /^(\s*)([-*+]|(\d+)[.)])\s/.exec(line);
    if (li !== null) {
      const kind = li[3] === undefined ? "ul" : "ol";
      if (listRun === 0) listKind = kind;
      listRun += 1;
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line)) { flushList(); sig.push(`tr:${(line.match(/\|/g) ?? []).length}`); continue; }
    if (line.trim() === "") flushList();
  }
  flushList();
  return sig;
}

/* ══════════════════ 扫描面 ══════════════════ */

const ALWAYS_SKIP = ["node_modules", ".git", "dist"];

function walk(exclude: readonly string[], pred: (p: string) => boolean, dir = REPO_ROOT, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (ALWAYS_SKIP.includes(name) || name.startsWith(".docs-typecheck-")) continue;
    const abs = join(dir, name);
    const rel = relative(REPO_ROOT, abs);
    if (exclude.some(x => rel === x || rel.startsWith(`${x}/`))) continue;
    if (statSync(abs).isDirectory()) walk(exclude, pred, abs, out);
    else if (pred(abs)) out.push(rel);
  }
  return out;
}

/** 全仓的 Markdown(排除 manifest 指定的豁免)。 */
export function allMarkdown(m: Manifest): string[] {
  return walk(m.orphanExclude, p => p.endsWith(".md")).sort();
}

/* ══════════════════ 门 ══════════════════ */

export function checkRoster(m: Manifest): Violation[] {
  const v: Violation[] = [];
  const listed = new Set(m.docs.map(d => d.path));
  const seen = new Set<string>();
  for (const d of m.docs) {
    if (seen.has(d.path)) v.push({ gate: "roster", path: d.path, message: "manifest 里重复登记" });
    seen.add(d.path);
    if (d.path.endsWith(".zh.md")) v.push({ gate: "roster", path: d.path, message: "中文侧不单独登记——它由 base 的 bilingual 决定" });
    if (!existsSync(join(REPO_ROOT, d.path))) {
      v.push({ gate: "roster", path: d.path, message: "登记了但文件不存在。**花名册只登记已存在且已批准的文档**,计划中的文档不进这里" });
    }
  }
  for (const rel of allMarkdown(m)) {
    if (rel.endsWith(".zh.md")) {
      const base = rel.replace(/\.zh\.md$/, ".md");
      if (!listed.has(base)) v.push({ gate: "roster", path: rel, message: `孤儿中文侧:${base} 不在花名册里` });
      continue;
    }
    if (!listed.has(rel)) v.push({ gate: "roster", path: rel, message: "全仓扫到没登记的 md——登记它、删掉它,或加进 orphanExclude" });
  }
  for (const rel of walk(m.orphanExclude, p => p.endsWith(".i18n.yaml"))) {
    const base = rel.replace(/\.i18n\.yaml$/, ".md");
    if (!listed.has(base)) v.push({ gate: "roster", path: rel, message: `孤儿配对记录:${base} 不在花名册里` });
  }
  return v;
}

export function checkLinks(m: Manifest): Violation[] {
  const v: Violation[] = [];
  for (const rel of allMarkdown(m)) {
    const abs = join(REPO_ROOT, rel);
    const text = readFileSync(abs, "utf8");
    const own = anchors(text);
    for (const { target, anchor, line } of docLinks(text)) {
      if (target === null) {
        if (anchor !== null && !own.has(anchor.toLowerCase())) {
          v.push({ gate: "links", path: `${rel}:${line}`, message: `同页锚点不存在:#${anchor}` });
        }
        continue;
      }
      const targetAbs = resolve(dirname(abs), target);
      if (!existsSync(targetAbs)) { v.push({ gate: "links", path: `${rel}:${line}`, message: `死链:${target}` }); continue; }
      if (anchor !== null && !anchors(readFileSync(targetAbs, "utf8")).has(anchor.toLowerCase())) {
        v.push({ gate: "links", path: `${rel}:${line}`, message: `锚点不存在:${target}#${anchor}` });
      }
    }
  }
  return v;
}

export type CodeBlock = { readonly doc: string; readonly index: number; readonly line: number; readonly code: string };

/** 抽出 `ts` / `typescript` 围栏;info 串带 `ignore-check` 的跳过。 */
export function tsBlocks(relPath: string, text?: string): CodeBlock[] {
  const src = text ?? readFileSync(join(REPO_ROOT, relPath), "utf8");
  const out: CodeBlock[] = [];
  let open: { info: string; line: number; body: string[] } | null = null;
  for (const { line, lineNo, inFence, fenceInfo, isFenceMark } of scanLines(src)) {
    if (inFence && isFenceMark && open === null) { open = { info: fenceInfo, line: lineNo + 1, body: [] }; continue; }
    if (inFence && isFenceMark && open !== null) {
      const { info, line: at, body } = open;
      open = null;
      if (!/^(ts|typescript)\b/.test(info) || info.includes("ignore-check")) continue;
      out.push({ doc: relPath, index: out.length, line: at, code: body.join("\n") });
      continue;
    }
    if (open !== null) open.body.push(line);
  }
  return out;
}

/**
 * 每块写成独立文件后一次 `tsc --noEmit`。
 *
 * **每块补 `export {}` 且开 `moduleDetection: force`**:没有 import/export 的 `.ts` 是全局脚本,
 * 同一次编译里彼此可见——一个块声明的变量能让另一个块通过(假绿),两个块声明同名变量
 * 又互相报错(假红)。两种都实测发生过。
 *
 * 临时目录用 `mkdtemp` 而非仓库根的固定名字(固定名不支持并发,也是个「在仓库根删目录」的坏样板),
 * 但**必须落在仓内**:`@echo-agent/core` 靠 workspace 软链解析,出了仓解析不到。
 */
export function checkCodeBlocks(m: Manifest): Violation[] {
  const blocks: CodeBlock[] = [];
  for (const rel of allMarkdown(m)) blocks.push(...tsBlocks(rel));
  if (blocks.length === 0) return [];

  const dir = mkdtempSync(join(REPO_ROOT, ".docs-typecheck-"));
  try {
    const nameOf = (b: CodeBlock): string => `${b.doc.replace(/[^\w]+/g, "_")}__${b.index}.ts`;
    for (const b of blocks) Bun.write(join(dir, nameOf(b)), `${b.code}\nexport {};\n`);
    Bun.write(join(dir, "tsconfig.json"), JSON.stringify({
      extends: "../tsconfig.json",
      compilerOptions: { noEmit: true, skipLibCheck: true, moduleDetection: "force" },
      include: ["*.ts"],
    }, null, 2));

    const r = Bun.spawnSync(["bunx", "tsc", "-p", join(dir, "tsconfig.json")], { cwd: REPO_ROOT });
    if (r.exitCode === 0) return [];
    const output = `${r.stdout.toString()}${r.stderr.toString()}`;
    const byFile = new Map<string, string[]>();
    for (const line of output.split("\n")) {
      const mm = /^(?:.*[/\\])?([^/\\(]+\.ts)\((\d+),\d+\):\s*(.*)$/.exec(line);
      if (mm === null) continue;
      byFile.set(mm[1]!, [...(byFile.get(mm[1]!) ?? []), `第 ${mm[2]} 行: ${mm[3]}`]);
    }
    const v: Violation[] = [];
    for (const b of blocks) {
      const errs = byFile.get(nameOf(b));
      if (errs === undefined) continue;
      v.push({
        gate: "code", path: `${b.doc}:${b.line}`,
        message: `第 ${b.index + 1} 个 ts 块编译失败——补 \`declare const\` 让它自洽,或标 \`\`\`ts ignore-check:\n        ${errs.join("\n        ")}`,
      });
    }
    if (v.length === 0) v.push({ gate: "code", path: "(未定位)", message: `tsc 失败但无法映射回具体块:\n${output.trim().slice(0, 800)}` });
    return v;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 含 `abs` 的最近包根(有 package.json 的祖先),找不到就返回仓库根。 */
function packageRootOf(abs: string): string {
  let dir = dirname(abs);
  for (;;) {
    if (existsSync(join(dir, "package.json"))) return dir;
    const up = dirname(dir);
    if (up === dir || !dir.startsWith(REPO_ROOT)) return REPO_ROOT;
    dir = up;
  }
}

/**
 * 仓库根下的顶层目录名。**从文件系统读,不硬编码**——写死的清单会随目录增删而静默少查:
 * 不会红,只会看不见,而"清单会腐烂"正是这套门要防的东西。
 */
function topLevelDirs(): string[] {
  return readdirSync(REPO_ROOT).filter(n =>
    !ALWAYS_SKIP.includes(n) && !n.startsWith(".") && statSync(join(REPO_ROOT, n)).isDirectory());
}

/**
 * 一段文本里形似「仓库内文件路径」的字面量。**纯函数**,正反例见 docs-lint-fixtures。
 *
 * 前置用「前一个字符不是路径字符」的否定断言,而不是列举允许的前导字符:
 * 中文注释里路径前常常不留空格(「详见」直接接路径),列举法会漏——实测漏掉 10 条真死引用。
 * 后缀补 `(?![\w-])`,否则 `.tsx` 会被截成 `.ts`,报出一个引用者根本没写过的路径。
 */
export function fileRefCandidates(text: string, dirs: readonly string[]): string[] {
  if (dirs.length === 0) return [];
  const alt = dirs.map(d => d.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const re = new RegExp(`(?<![\\w./-])(?:${alt})/[\\w./-]+\\.(?:md|tsx|ts|json|yaml|yml)(?![\\w-])`, "g");
  return [...text.matchAll(re)].map(m => m[0]);
}

/**
 * 注释与散文里引用的文件路径必须存在。
 *
 * **先按引用者所在包解析,再退回仓库根**:某个包的源文件里写「test/ 开头」的相对路径,
 * 指的是那个包自己的 test 目录,不是仓库根的。只按仓库根解析会误报——实测过。
 *
 * 已知限制:它分不清「引用」与「举例」。散文里拿一条路径当例子写,这道门会当成引用。
 */
export function checkFileRefs(m: Manifest): Violation[] {
  const dirs = topLevelDirs();
  const v: Violation[] = [];
  const exempt = new Set(m.fileRefsExclude);
  for (const rel of walk(m.orphanExclude, p => p.endsWith(".ts") || p.endsWith(".tsx") || p.endsWith(".md"))) {
    if (exempt.has(rel)) continue;
    const abs = join(REPO_ROOT, rel);
    const pkgRoot = packageRootOf(abs);
    const seen = new Set<string>();
    for (const ref of fileRefCandidates(readFileSync(abs, "utf8"), dirs)) {
      if (seen.has(ref)) continue;
      seen.add(ref);
      if (existsSync(join(pkgRoot, ref)) || existsSync(join(REPO_ROOT, ref))) continue;
      v.push({ gate: "filerefs", path: rel, message: `引用了不存在的文件:${ref}` });
    }
  }
  return v;
}

export function blobHash(absPath: string): string {
  const r = Bun.spawnSync(["git", "hash-object", absPath], { cwd: REPO_ROOT });
  const out = r.stdout.toString().trim();
  if (r.exitCode !== 0 || !/^[0-9a-f]{40}$/.test(out)) {
    throw new Error(`git hash-object 失败(exit ${r.exitCode}):${r.stderr.toString().trim() || out}`);
  }
  return out;
}

const SWITCH_EN = (zh: string): string => `English | [中文](${zh})`;
const SWITCH_ZH = (en: string): string => `[English](${en}) | 中文`;

/**
 * 双语三文件成组、两侧 blob hash 与记录一致、结构签名一致。
 *
 * **这道门证明的是「两侧字节与上次按确认键时相同」,不是「两侧在说同一件事」。**
 * 后者没有机器判据,归人审——所以重录必须点名(见 writePairing)。
 */
export function checkPairing(m: Manifest): Violation[] {
  const v: Violation[] = [];
  for (const d of m.docs) {
    if (!d.bilingual) continue;
    const enAbs = join(REPO_ROOT, d.path);
    if (!existsSync(enAbs)) continue; // roster 已经报过
    const zhRel = d.path.replace(/\.md$/, ".zh.md");
    const yamlRel = d.path.replace(/\.md$/, ".i18n.yaml");
    const zhAbs = join(REPO_ROOT, zhRel);
    const yamlAbs = join(REPO_ROOT, yamlRel);
    if (!existsSync(zhAbs)) { v.push({ gate: "pairing", path: zhRel, message: "双语文档缺中文侧" }); continue; }
    if (!existsSync(yamlAbs)) { v.push({ gate: "pairing", path: yamlRel, message: `缺配对记录——两侧确认一致后跑 bun scripts/docs-lint.ts --write-pairing ${d.path}` }); continue; }

    const enText = readFileSync(enAbs, "utf8");
    const zhText = readFileSync(zhAbs, "utf8");
    const enBase = d.path.split("/").pop()!;
    const zhBase = zhRel.split("/").pop()!;
    if (!enText.includes(SWITCH_EN(zhBase))) v.push({ gate: "pairing", path: d.path, message: `缺语言切换行:${SWITCH_EN(zhBase)}` });
    if (!zhText.includes(SWITCH_ZH(enBase))) v.push({ gate: "pairing", path: zhRel, message: `缺语言切换行:${SWITCH_ZH(enBase)}` });

    const want: Record<string, string> = {};
    for (const line of readFileSync(yamlAbs, "utf8").split("\n")) {
      const mm = /^\s*([^\s:]+)\s*:\s*([0-9a-f]{40})\s*$/.exec(line);
      if (mm !== null) want[mm[1]!] = mm[2]!;
    }
    for (const [base, abs] of [[enBase, enAbs], [zhBase, zhAbs]] as const) {
      const recorded = want[base];
      if (recorded === undefined) { v.push({ gate: "pairing", path: yamlRel, message: `记录里没有 ${base} 的 blob hash` }); continue; }
      if (recorded !== blobHash(abs)) {
        v.push({ gate: "pairing", path: yamlRel, message: `${base} 改过但两侧未重新确认——把另一侧同步改到位,再 --write-pairing ${d.path}` });
      }
    }

    const a = structuralSignature(enText);
    const b = structuralSignature(zhText);
    if (a.length !== b.length) {
      v.push({ gate: "pairing", path: zhRel, message: `结构签名长度不一致(英 ${a.length} / 中 ${b.length})——章节、列表或代码块有增删` });
    } else {
      const at = a.findIndex((x, i) => x !== b[i]);
      if (at >= 0) v.push({ gate: "pairing", path: zhRel, message: `结构签名第 ${at + 1} 项不一致:英「${a[at]!.slice(0, 60)}」/ 中「${b[at]!.slice(0, 60)}」` });
    }
  }
  return v;
}

/**
 * 重录点名的那几对。**必须点名**——无参数重录全部等于顺手祝福没人看过的对,
 * 那是这道门唯一能被一键绕过的地方(dsh 原版同样要求点名)。
 */
function writePairing(m: Manifest, names: readonly string[]): void {
  if (names.length === 0) {
    console.error("--write-pairing 必须点名要确认的文档,例如:--write-pairing README.md");
    console.error("不接受无参数重录:那等于宣称你确认过每一对,而你没有。");
    process.exit(2);
  }
  const wanted = new Set(names.map(n => n.replace(/\.zh\.md$/, ".md").replace(/\.i18n\.yaml$/, ".md")));
  let done = 0;
  for (const d of m.docs) {
    if (!d.bilingual || !wanted.has(d.path)) continue;
    const enAbs = join(REPO_ROOT, d.path);
    const zhAbs = join(REPO_ROOT, d.path.replace(/\.md$/, ".zh.md"));
    if (!existsSync(enAbs) || !existsSync(zhAbs)) { console.error(`跳过 ${d.path}:两侧文件不齐`); continue; }
    Bun.write(
      join(REPO_ROOT, d.path.replace(/\.md$/, ".i18n.yaml")),
      `${enAbs.split("/").pop()}: ${blobHash(enAbs)}\n${zhAbs.split("/").pop()}: ${blobHash(zhAbs)}\n`,
    );
    console.log(`recorded  ${d.path}`);
    done += 1;
  }
  if (done !== wanted.size) {
    console.error(`点名 ${wanted.size} 份,只重录 ${done} 份——名字对不上花名册里的双语文档?`);
    process.exit(2);
  }
}

export function allViolations(m: Manifest = loadManifest()): Violation[] {
  return [...checkRoster(m), ...checkLinks(m), ...checkCodeBlocks(m), ...checkFileRefs(m), ...checkPairing(m)];
}

if (import.meta.main) {
  const m = loadManifest();
  const args = process.argv.slice(2);
  const w = args.indexOf("--write-pairing");
  if (w !== -1) { writePairing(m, args.slice(w + 1)); process.exit(0); }
  const v = allViolations(m);
  const byGate = new Map<string, Violation[]>();
  for (const x of v) byGate.set(x.gate, [...(byGate.get(x.gate) ?? []), x]);
  for (const gate of ["roster", "links", "code", "filerefs", "pairing"]) {
    const rows = byGate.get(gate) ?? [];
    console.log(`\n${rows.length === 0 ? "✓" : "✗"} ${gate}  (${rows.length})`);
    for (const r of rows.slice(0, 12)) console.log(`    ${r.path}\n      ${r.message}`);
    if (rows.length > 12) console.log(`    …还有 ${rows.length - 12} 条`);
  }
  console.log(`\n合计 ${v.length} 条违规`);
  process.exit(v.length === 0 ? 0 : 1);
}
