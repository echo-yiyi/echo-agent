# `StorageDir` 加浅层列举 `children`，会话清单只看一层

> 状态:implemented · 提出 2026-11-03（全仓 review 留下的待拍板）· 拍板 2026-11-13（用户：「按照你的推荐来做」）· 落地 [`StorageDir`](../../../packages/core/src/storage/types.ts#symbol=StorageDir)、[`FileDir`](../../../packages/core/src/storage/file-dir.ts#symbol=FileDir)、[`InMemoryDir`](../../../packages/core/src/storage/in-memory-dir.ts#symbol=InMemoryDir)、[`listSessions`](../../../packages/core/src/session/service.ts#symbol=listSessions) · 判据 `packages/core/test/file-dir.test.ts`、`packages/core/test/session-service.test.ts`

**给谁看**：实现或包装 `StorageDir` 的人，以及改会话清单的人。假设已知 [会话](../../design/sessions.md) 的目录布局（一段一个目录、entry 一条一文件）。

**一句话**：端口多一个可选方法 `children(dir)`，只列一层；`listSessions()` 有它就用它，成本从「所有会话的文件总数」降到「会话段数」。

## 现状（拍板前）

`listSessions()` 用 `list("")` 递归列出会话根下每一段的全部文件（entries、inbox、观测文档），只为挑出 `<id>/meta.json`。`session_list`、`--continue`、`/sessions`、观测面板扫会话都走它，成本随全部会话的总历史线性涨。端口只有递归的 `list`，没有只看一层的办法。

## 选项

- **A. 端口加可选的 `children?`**，与 `lock?` 同一个口径：不实现 = 这个字节面没有该原语，调用方退回 `list`。
- **B. 加成必选方法。** 类型系统能逼每个包装层转发，但要同时改 core 里 9 处包装（含观测线程的跨线程代理）和 30 来个测试替身，而使用方只有会话清单一处；第三方字节面一升级就编译不过。
- **C. 不动端口，`listSessions()` 绕过 `StorageDir` 直接读目录。** 清单就只能跑在 `FileDir` 上，内存字节面与自定义 store 上失效。

## 决定

**A**。

1. `children?(dir: string): Promise<string[]>`：`dir` 是 `/` 分隔的相对目录，结尾的 `/` 可有可无，`""` = 根；这一层不存在返回空。文件给名字，子目录给名字加结尾的 `/`，按字典序排。只看这一层，不往下走。
2. `FileDir`：一次 `readdir`。只认普通文件与目录（符号链接不算）、原子写的临时文件不算——与 `list` 同一套取舍。空目录也会列出来。`InMemoryDir`：从键里切出第一层。
3. `listSessions()`：有 `children` 时取根下带 `/` 的名字当候选 id，逐个读 `<id>/meta.json`，没有 meta 的跳过；没有 `children` 时走原来的递归 `list`。两条路交出的清单相同。
4. 生产里三处调用（装配、`--continue` / `--resume` 挑段、观测面板）传的都是裸 `FileDir`，中间没有包装层。

## Non-Goals

- 不给前缀视图、写入闸、记忆的层视图、观测线程代理加 `children` 转发：它们现在没有使用方。谁要在视图上用浅层列举，届时在那一层加转发。
- 不改 `list` 的语义，不把现有的 `list` 调用方迁到 `children`。
- 不缓存会话清单。

## 验收判据

- `packages/core/test/file-dir.test.ts`「children(dir) 只看一层…」：`FileDir` 与 `InMemoryDir` 对同一组文件给出同一个答案；`s` 不匹配 `s-1`；不存在的层为空；临时文件不算。
- `packages/core/test/session-service.test.ts`「listSessions()：字节面有浅层列举（children）就只看一层…」：有 `children` 的字节面上，一次清单只发生一次 `children("")`、零次 `list`；没有 `children` 的字节面清单相同。把 `listSessions()` 改回 `list("")`，这条会红。
