// skill 加载器的契约门。判据:**别人写的 skill 能不能在我们这跑起来**。
// 用真临时目录——加载器的本职就是读盘,替身反而测不到它。

import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSkills, loadSkillsFromDir } from "../src/skill/loader.ts";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "echo-skill-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function put(rel: string, content: string): Promise<void> {
  const path = join(root, rel);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, content, "utf8");
}

test("目录式 skill:frontmatter + 正文 + 同目录文件清单(Claude Code 格式)", async () => {
  await put(
    "h5-page/SKILL.md",
    `---\nname: h5-page\ndescription: 做 H5 落地页\nrequired-tools: read_file, write_file\n---\n\n用单文件写。模板见 template.html。\n`,
  );
  await put("h5-page/template.html", "<html/>");
  await put("h5-page/assets/logo.svg", "<svg/>");

  const { skills, diagnostics } = await loadSkillsFromDir(root);
  expect(diagnostics).toEqual([]);
  expect(skills.length).toBe(1);
  const s = skills[0]!;
  expect(s.name).toBe("h5-page");
  expect(s.description).toBe("做 H5 落地页");
  expect(s.content).toBe("用单文件写。模板见 template.html。");
  expect(s.dir).toBe(join(root, "h5-page"));
  expect(s.files).toEqual(["assets/logo.svg", "template.html"]); // 排序稳定,SKILL.md 自身除外
  expect(s.requiredTools).toEqual(["read_file", "write_file"]);
  expect(s.modelInvocable).toBe(true);
});

test("name 缺省用目录名;根层单文件 .md 也认(pi 格式)", async () => {
  await put("deploy/SKILL.md", `---\ndescription: 部署流程\n---\n步骤`);
  await put("quick-note.md", `---\ndescription: 快速记录\n---\n直接写`);

  const { skills } = await loadSkillsFromDir(root);
  expect(skills.map((s) => s.name).sort()).toEqual(["deploy", "quick-note"]);
  const single = skills.find((s) => s.name === "quick-note")!;
  expect(single.dir).toBeUndefined(); // 单文件没有 dir,引用不了旁边的文件
});

test("坏 skill 跳过 + 诊断,不拖垮整批;没有 SKILL.md 的目录静静跳过", async () => {
  await put("good/SKILL.md", `---\ndescription: 好的\n---\nok`);
  await put("no-desc/SKILL.md", `---\nname: no-desc\n---\n没有描述`); // 致命:模型永远想不起来用它
  await put("Bad Name/SKILL.md", `---\nname: Bad Name\ndescription: 名字非法\n---\nx`);
  await mkdir(join(root, "just-a-dir"), { recursive: true }); // 不是 skill

  const { skills, diagnostics } = await loadSkillsFromDir(root);
  expect(skills.map((s) => s.name)).toEqual(["good"]);
  expect(diagnostics.map((d) => d.code).sort()).toEqual(["skill_invalid", "skill_missing_description"]);
});

test("多目录:先到先得(项目级赢过全局级)+ 撞名诊断;目录不存在 = 空不是错", async () => {
  const project = join(root, "project");
  const global_ = join(root, "global");
  await put("project/fmt/SKILL.md", `---\ndescription: 项目级格式化\n---\nA`);
  await put("global/fmt/SKILL.md", `---\ndescription: 全局格式化\n---\nB`);
  await put("global/extra/SKILL.md", `---\ndescription: 全局独有\n---\nC`);

  const { skills, diagnostics } = await loadSkills([project, global_, join(root, "nope")]);
  expect(skills.map((s) => s.name).sort()).toEqual(["extra", "fmt"]);
  expect(skills.find((s) => s.name === "fmt")!.description).toBe("项目级格式化"); // 先到先得
  expect(diagnostics.some((d) => d.code === "skill_name_clash")).toBe(true);
});

test("frontmatter 原样进 skill.frontmatter(不可信数据,渲染层绝不碰)", async () => {
  await put("x/SKILL.md", `---\ndescription: 有自定义字段\nowner: alice\nmodel-invocable: false\n---\n正文`);
  const { skills } = await loadSkillsFromDir(root);
  expect(skills[0]!.frontmatter.owner).toBe("alice");
  expect(skills[0]!.modelInvocable).toBe(false);
});
