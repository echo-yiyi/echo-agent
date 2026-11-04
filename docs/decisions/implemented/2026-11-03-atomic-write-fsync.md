# 落盘口共用一份原子写，写完 fsync 再 rename

> 状态:implemented · 提出 2026-11-03（存储线 bug 盘点）· 拍板 2026-11-03（用户：「全部按推荐修，并参考成熟实现」）· 落地 [`writeFileAtomic`](../../../packages/core/src/storage/atomic-write.ts#symbol=writeFileAtomic)，`FileDir.write` / `fileTaskStore` / `FileCredentialStore` 改用它 · 判据 `packages/core/test/file-dir.test.ts`

**给谁看**：改 core 落盘默认件（`FileDir`、任务清单文件、凭据文件）或排查「断电后会话打不开」的人。假设已知 [会话](../../design/sessions.md) §3 的持久化约束（坏档判红不给半截）。

**一句话**：原子写只剩一份实现，临时名唯一，写完先对文件 fsync、再 rename、再对父目录 fsync（尽力而为）；坏档判红的原则不动。

## 现状（拍板前）

- 原子写有四份：`FileDir.write`、`task/fs.ts` 的 `fileTaskStore`、`provider/file-credentials.ts` 的 `FileCredentialStore.save`、`packages/base/src/settings.ts`。都是「临时文件 → rename」，**都不 fsync**。
- `fileTaskStore` 的临时名固定是 `${path}.tmp`：两个写者同时写，后到的覆盖先到的临时文件，先到的 rename 走了，后到的 rename 就 ENOENT，那一次写丢失——正是 `FileDir` 注释里 2026-08-18 在 CI 上炸过的同一个坑。
- 不 fsync 的后果：断电时 rename 已经落盘、数据块还没落盘，目标是一个零长或半截的文件。transcript 一条 entry 一个文件、meta、inbox record 都经 `FileDir`，而这些文件读到坏档一律判红——会话打不开。

## 选项

- **A. 一份 helper，fsync 文件 + rename + fsync 父目录。** 三处 core 落盘口改用它；`settings.ts` 在 base，另一条线在改，不在本条。
- **B. 只修 `fileTaskStore` 的撞名，不 fsync。** 便宜，但零长文件照样会出现。
- **C. 放松坏档判红**：读到零长文件当成没有。会把「断电丢了最后一条」变成「静默少一条」，与 transcript 是唯一真源冲突。

参照（只借做法）：npm 的 `write-file-atomic` 缺省对临时文件 fsync 之后再 rename，临时名带进程与序号；rename 之后对父目录 fsync 是 POSIX 下让 rename 本身落盘的常规做法，有的平台打不开目录，所以只能尽力而为。

## 决定

**A**。

1. [`writeFileAtomic(target, content, { mode? })`](../../../packages/core/src/storage/atomic-write.ts#symbol=writeFileAtomic)：临时名 `<target>.<pid>.<序号>.<毫秒>.tmp`，以 `wx` 打开（万一撞上别人的临时文件，这次写失败，不去盖它）→ 写入 →（给了 `mode` 就显式 chmod）→ fsync → close → rename → 对父目录 fsync。前面任一步失败都删掉自己建的临时文件、原始错误照抛；父目录 fsync 打不开或不支持时不抛。
2. `FileDir.write`、`fileTaskStore().write`、`FileCredentialStore` 的写盘都走它；凭据文件仍是临时文件一出生 0600、rename 前再设一次。`FileDir.list` 跳过的临时文件后缀与 helper 用同一个常量。
3. 坏档判红不放松。

## 代价（本机实测，2026-11-03）

macOS（APFS，本机 SSD），临时目录里一条 entry 一个文件连写 1000 条，两轮：

| 路径 | 改前 p50 / p95 | 改后 p50 / p95 |
|---|---|---|
| `FileDir.write`（单条约 500 字节） | 0.31–0.43 ms / 0.59–0.82 ms | 0.42–0.49 ms / 0.66–0.92 ms |
| `SessionService.append` + `settle`（entry + meta） | 0.84–1.00 ms / 1.34–1.44 ms | 1.02–1.16 ms / 1.47–1.98 ms |

每条多 0.1–0.2 ms。**这组数在 macOS 上偏乐观**：macOS 的 `fsync` 只保证数据交给了磁盘，不保证磁盘自己的写缓存落盘（那要 `F_FULLFSYNC`，`node:fs` 不提供）；Linux 上 fsync 会等到设备确认，单次常见在毫秒级，长会话里 transcript 追加会更明显。没有在 Linux 上实测。

## Non-Goals

- 不做崩溃恢复（扫残留临时文件、修半截文件）：临时文件后缀照旧被 `list` 跳过，残留只占空间。
- 不在 macOS 上用 `F_FULLFSYNC`。
- `packages/base/src/settings.ts` 的那份原子写不在本条（另一条线在改），之后改用同一个 helper。
- `observation.store` 注入的存储持久到什么程度由注入方定。

## 验收

- [fileTaskStore 并发写不抛不丢](../../../packages/core/test/file-dir.test.ts#test=filetaskstore-并发写同一路径不抛不丢此前临时名固定是-pathtmp两个写者撞名后到的-rename-enoent)：30 个并发写全部成功、最终内容是其中一次的完整值、不留临时文件。改前 rename ENOENT。
- [三个落盘口的写盘顺序](../../../packages/core/test/file-dir.test.ts#test=filedir-filetaskstore-filecredentialstore-写盘都是fsync-临时文件-rename-fsync-父目录)：`FileDir`、`fileTaskStore`、`FileCredentialStore` 各写一次，记下的顺序都是「fsync 文件 → rename → fsync 父目录」。改前三者都没有 fsync。
- [写失败不留临时文件](../../../packages/core/test/file-dir.test.ts#test=写失败不留临时文件目标保持旧的完整内容)：rename 抛错时目标仍是旧的完整内容、目录里没有 `.tmp`。改前 `FileDir` 失败会留下临时文件。

三条判据在改前的代码上都红。
