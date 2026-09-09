#!/usr/bin/env bun
// `echo-agent` —— **唯一的可执行入口**（管道形态与交互形态都从这儿进，见 `src/cli.ts` 文件头）。
//
// **这里只做一件事**：把 argv 交给 `main()`，把它的返回值当退出码。
// 逻辑一行都不放这儿——放了就只能靠 spawn 才测得到。

import { main } from "../src/product.ts";

process.exitCode = await main(process.argv.slice(2));
