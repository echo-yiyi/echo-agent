# 管道形态：整段 stdin 是一条 prompt，跑一个 run

> 状态:implemented · 提出 2026-11-03（review：`cat task.md | echo-coding` 被拆成多次独立 run）· 拍板 2026-11-03（用户：「全部按推荐修，并参考成熟实现」）· 落地 `packages/base/src/cli.ts#runPiped`、`packages/base/src/stdin.ts#readAll`、`packages/base/src/prompt.ts#PIPE_SURFACE`，判据见文末

**给谁看**：改管道形态、写脚本 / CI 调 `echo-agent` / `echo-coding` 的人。假设已知 [CONTEXT](../../../CONTEXT.md) 里的 run。

## 现状（拍板前）

管道形态一行一个 prompt：[run()](../../../packages/base/src/run.ts#symbol=run) 吃 `linesOf(process.stdin)`，每个非空行各 `send()` 一次。`cat task.md | echo-coding` 于是被拆成几次独立 run：第一行「修登录测试」先跑完一整轮，「不要动 API」这类写在后面几行的约束要等它跑完才作为下一条输入到达，已经晚了。空 stdin 一个 run 都不跑、以 0 退出，调用方分不出「没给任务」和「做完了」。

## 选项

- **A. 照 `claude -p` / `codex exec`**：读到 EOF，整段当一条 prompt，跑一个 run，跑完收摊；空输入报错、非零退出。`codex exec` 在登录检查之后、起会话之前 `read_to_end` stdin，空的就报 `No prompt provided via stdin.` 并以 1 退出。
- **B. 保留逐行，另加一个整段的开关**：多一种「声明了却和事实不符」的错法，与 `cli.ts` 头注「形态由事实决定、不给开关」那条冲突。

## 决定

**A**（2026-11-03 用户拍板）。

1. 管道形态先 [readAll()](../../../packages/base/src/stdin.ts#symbol=readAll) 读完整段 stdin（UTF-8，多字节字符跨块不坏），**再装配**：空输入不拿锁、不建状态根。
2. 整段去掉首尾空白后为空 → stderr 一行 `stdin 是空的：…`，退出码 1。
3. 非空 → 整段作为**一条** prompt 交给 `run()`，一个 run；跑完照旧在 stderr 打一行 `[run] <run-id>`。
4. 读 stdin 期间被 Ctrl-C：半截输入不当 prompt，不装配、以 0 收摊（与 `run()` 被中止时一致）。
5. 管道形态的交互面段（`PIPE_SURFACE`）改说「整段 stdin 是一条请求」。

## Non-Goals

- 不加命令行位置参数当 prompt（`codex exec "..."` 那种），也不加「逐行」开关。
- `linesOf` 不删：它仍是公共导出，但已没有生产调用方——删不删是公共面的事，另议。
- `--serve` 不读 stdin，不受影响；交互形态不受影响。

## 验收

- [整段一条、一次请求、一个 run](../../../packages/cli/test/cli.test.ts#test=bin管道形态把整段-stdin-当一条-prompt一次-run一次模型请求后面几行约束跟着第一句一起到)（bin 级，假 OpenAI 兼容端点）；变异：把整段按行拆开再交给 `run()` 即红。
- [空 stdin 报错、不装配](../../../packages/cli/test/cli.test.ts#test=bin管道形态-stdin-是空的或全是空白-报错退出码-1不装配不碰状态根)。
- [readAll 整段与多字节](../../../packages/cli/test/cli.test.ts#test=readall整段读完才交出来多行原样保留多字节字符跨块不坏)、[预先 abort 不卡住](../../../packages/cli/test/cli.test.ts#test=readall已经-abort-过的-signal-不许卡在等-eof-上sigint-落在启动期间就是这个形状)。
