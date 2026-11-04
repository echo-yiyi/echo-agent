# `echo-coding` 的 grep 加两个参数：`ignore_case` 与 `output_mode`

> 状态:implemented · 提出 2026-11-03（echo-coding 工具线排查）· 拍板 2026-11-03（用户：「全部按推荐修」）· 实现 2026-11-03 · 来源 `packages/coding/src/tools/search.ts`（`grep` 工具），判据 [ignore_case](../../../packages/coding/test/search.test.ts#test=grep-ignorecase不分大小写写-i-时报错里指向-ignorecase)、[output_mode](../../../packages/coding/test/search.test.ts#test=grep-outputmodecontent缺省-fileswithmatches-count)

## 现状(拍板前)

`grep` 只有 `pattern` / `path` / `glob` 三个参数，结果恒为 `file:line:text`。两件事做不了：

- **不分大小写**：pattern 是 JavaScript 正则，没有 `(?i)` 这种内联写法。实测模型照 ripgrep / PCRE 的习惯写 `(?i)handlelogin`，拿回一句 `Invalid regular expression`，只能自己拼 `[Hh]andle[Ll]ogin`。
- **只要文件名或个数**：「这个符号在哪些文件里出现」「每个文件各几处」只能把每一行都搬进上下文再自己数；匹配多的时候撞 200 条上限，看到的还只是一部分。

## 选项

- **A. 不加**：模型改用 bash 跑 `rg -i` / `rg -l` / `rg -c`。绕开了工作区边界与排除规则，也和「搜索用 grep 工具」的指引相反。
- **B. 加 `ignore_case: boolean` 与 `output_mode: "content" | "files_with_matches" | "count"`**，缺省 `content`、输出与此前逐字相同。参数名与取值与 ripgrep 的 `-i` / `-l` / `-c` 一一对应；pi 的 grep 有 `ignoreCase`，opencode 的 grep 只回文件与行。

## 决定

**B**（2026-11-03 用户拍板）。

- `ignore_case: true` = 正则加 `i` 标志。pattern 以 `(?i)` 这类内联标志开头而编译失败时，报错里指向 `ignore_case`。
- `output_mode`：`content` 回 `file:line:text`；`files_with_matches` 每个有匹配的文件一行；`count` 回 `file:count`。三种都按路径排序，最多 200 条，超了说出总数（`content` 数行，另两种数文件）。取值不在三种之内是 error。

## 验收

`grep` 的 schema 有这两个参数、`output_mode` 带 enum；不给它们时输出与此前相同（`packages/coding/test/coding-agent.test.ts` 里已有的 grep 判据不改仍绿）；上面两条判据把「不分大小写」「三种输出」「`(?i)` 的提示」「非法取值」各钉住，改坏任一处即红。
