// scratch：打印 echo-coding 真正会发给模型的 system prompt。
//
// 走真实的 createEcho() 装配路径（builtin + echo:conduct + echo:instructions + codingPreset），
// 不联网（allowNetwork: false）、不跑 UI（surface 段直接注册，不挂 echo:tui）、不碰真实状态根（临时目录）。
//
// 形态由参数选，因为**两种形态的 prompt 不一样**（2026-09-09）：有人能答的那版纪律里有「动手前先确认」，
// 没人的那版换成「别等确认，自己判断、做完说清楚」；交互面段也各是各的。
//
//   bun scripts/dump-prompt.ts            # 交互形态（终端）
//   bun scripts/dump-prompt.ts pipe       # 非交互形态（管道 / CI / 评测）
import { createEcho, kimiProvider } from "@echo-agent/core";
import { definePromptPack } from "@echo-agent/core/extension";
import { conductEntry, pipeSurfaceSection } from "../packages/base/src/prompt.ts";
import { instructionsEntry } from "../packages/base/src/instructions.ts";
import { terminalSurfaceSection } from "../packages/tui/src/prompt.ts";
import { codingPreset } from "../packages/coding/src/agent.ts";

const interactive = process.argv[2] !== "pipe";
const ECHO_SURFACE = definePromptPack("echo:surface-dump");

const echo = await createEcho({
  provider: kimiProvider(),
  allowNetwork: false,
  stateDir: "/tmp/echo-prompt-dump-state",
  workspace: process.cwd(),
  extensions: [
    conductEntry({ interactive }),
    instructionsEntry(),
    ...codingPreset().extensions,
    // 壳对 prompt 的贡献就是 surface 一段；不真挂壳，壳会把 UI 跑起来
    {
      entryId: "echo:surface-dump",
      definition: ECHO_SURFACE as never,
      config: { sections: [interactive ? terminalSurfaceSection() : pipeSurfaceSection()] },
    },
  ],
});

try {
  const prompt = await echo.agent.assemblePrompt();
  console.log(`── 形态：${interactive ? "交互（终端）" : "非交互（管道）"} ──`);
  console.log(prompt === null ? "(null)" : prompt);
  console.log("── 段注册顺序（mount 序）──");
  for (const e of echo.extensions) console.log(`  ${e.entryId} (${e.name})`);
} finally {
  await echo.stop();
}
