// scratch：打印交互形态 echo-coding 真正会发给模型的 system prompt。
// 走真实的 createEcho() 装配路径（builtin + echo:conduct + echo:instructions + codingPreset），
// 不联网（allowNetwork: false）、不跑 UI（surface 段直接注册，不挂 echo:tui）、不碰真实状态根（临时目录）。
import { createEcho, kimiProvider } from "@echo-agent/core";
import { definePromptPack } from "@echo-agent/core/extension";
import { conductEntry, surfaceSection } from "../packages/cli/src/prompt.ts";
import { instructionsEntry } from "../packages/cli/src/instructions.ts";
import { codingPreset } from "../packages/coding/src/agent.ts";

const ECHO_SURFACE = definePromptPack("echo:surface-dump");

const echo = await createEcho({
  provider: kimiProvider(),
  allowNetwork: false,
  stateDir: "/tmp/echo-prompt-dump-state",
  workspace: process.cwd(),
  agentName: "echo-coding",
  extensions: [
    conductEntry(),
    instructionsEntry(),
    ...codingPreset().extensions,
    // echo:tui 对 prompt 的贡献就是 surface(terminal) 一段；不真挂壳，壳会把 UI 跑起来
    { entryId: "echo:surface-dump", definition: ECHO_SURFACE as never, config: { sections: [surfaceSection("terminal")] } },
  ],
});

try {
  const prompt = await echo.agent.assemblePrompt();
  console.log(prompt === null ? "(null)" : prompt);
  console.log("── 段注册顺序（mount 序）──");
  for (const e of echo.extensions) console.log(`  ${e.entryId} (${e.name})`);
} finally {
  await echo.stop();
}
