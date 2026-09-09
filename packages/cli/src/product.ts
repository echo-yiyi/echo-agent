// `echo-agent` 这个产品自己：身份段、名字与版本，加上它的入口。
//
// 2026-09-09 拆包：`Product` / `PresetForm` 这两个**契约**归装配层（`@echo-agent/base`），
// 本文件只剩「echo-agent 是哪一个产品」这件事实。壳由产品挑——终端那份是 `@echo-agent/tui`。

import { readFileSync } from "node:fs";
import { conductEntry, mainFor, type Main, type Product } from "@echo-agent/base";
import { terminalShell } from "@echo-agent/tui";
import { identityEntry } from "./prompt.ts";

/** 本包的版本。`../package.json` 在源码树和 tarball 里都在这个相对位置（`files: ["src", …]`）。 */
const VERSION: string = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string })
  .version;

/** `echo-agent` 自己：通用 agent。身份段与纪律段都由它自己挂（2026-09-09：纪律归产品）。 */
export const ECHO_AGENT: Product = Object.freeze({
  name: "echo-agent",
  version: VERSION,
  preset: (form) => ({ extensions: [identityEntry(), conductEntry(form)] }),
});

/** 进程入口的实质：装配层的 `main` 绑上本产品与终端壳。 */
export const main: Main = mainFor(ECHO_AGENT, terminalShell);
