# `echo-coding` 的缺省权限策略是黑名单：三件先问，其余放行

> 状态:implemented · 提出 2026-09-07（review 批 6 顺带，#36）· 拍板 2026-09-09（用户，选 B）· 实现 2026-09-09 · 来源 [`DEFAULT_PERMISSION`](../../../packages/coding/src/permission.ts#symbol=DEFAULT_PERMISSION)

## 现状(拍板前)

`DEFAULT_PERMISSION` 是 `{ rules: { bash: "ask", write_file: "ask", edit_file: "ask" }, fallback: "allow" }`：点名三件先问，没点名的一律放行。没点名的里面也有动东西的——`worktree_enter` / `worktree_exit` 改分支与目录，`web_fetch` / `web_search` 出网，core 内建的记忆 / 任务 / 技能 / 闹钟落盘。review 指出注释只写「动手的先问」，与表不符；更深一层的问题是：以后每加一件动手的工具，缺省都是**放行**，没人会想起来往这张表里加一行。

## 不拍板的代价

注释与表继续两说；新工具默认放行这件事没人拍过板，只是黑名单的副作用。

## 选项

- **A. 改成白名单**：`fallback: "ask"`，把只读的（`read_file` / `grep` / `list` / `web_search` …）逐个点名 `allow`。新工具缺省先问，安全面向前；代价是每加一件只读工具都要来这里加一行，漏加就多一次无意义的询问，而且 `ask` 在管道形态（`responder: "none"`）直接折成 deny——漏加一件只读工具，管道里它就用不了。
- **B. 维持黑名单**，把「为什么这些不问」写成决策记录，注释指过来。新工具默认放行，由加工具的人在 PR 里说明要不要进 `rules`。

## 决定

**B**（2026-09-09 用户拍板）。理由：三条 `ask` 挡的是**用户的世界**（shell、改文件）；其余的要么可逆（worktree_enter 开新分支新目录）、要么 git 自己挡（worktree_exit 有未提交改动就拒）、要么已单独拍过（web_fetch / web_search 出网不问，2026-09-03）、要么写的是 agent 自己的状态（记忆 / 任务 / 技能 / 闹钟）。管道形态下 ask 折成 deny，白名单漏一件就少一件工具，代价比黑名单漏一件高。

**随之而来的纪律**（不是门）：给 `echo-coding` 加会动用户世界的工具时，PR 里要说明它进不进 `rules`。要更严的产品自己给 `rules`。

## 验收

`DEFAULT_PERMISSION.fallback === "allow"` 且 `rules` 恰好是 bash / write_file / edit_file 三条 `ask`；`packages/coding/src/permission.ts` 的注释指向本条而不是复述论证。
