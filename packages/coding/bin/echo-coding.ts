#!/usr/bin/env bun
// `echo-coding` —— coding agent 产品的**唯一**可执行入口。形状照 `echo-agent` 的 `bin/echo-agent.ts`。
//
// **这里只做一件事**：把 argv 交给 `main()`，把它的返回值当退出码。
// 逻辑一行都不放这儿——放了就只能靠 spawn 才测得到。

import { main } from "../src/cli.ts";

process.exitCode = await main(process.argv.slice(2));
