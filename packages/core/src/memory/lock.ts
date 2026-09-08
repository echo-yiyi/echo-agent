// 记忆文件的并发保护。三件事各管各的,别混:
//
//   tmp + rename(`FileDir` 已有)  文件不会是半截内容
//   **本文件**                     「读—改—写」这一段不被插队,谁的修改都不会被静默盖掉
//   整理锁(按层,`dream.ts`)        两个 dream 不把同一层各重排一遍——省功,不是正确性
//
// 为什么正确性这一件要单独做:提取每条 reply 都跑、dream 现在整理共享层,而 dream 是
// 「读一批、改一批、写回」——中间别人写进来的那条会被它盖掉,**一点痕迹都没有**:
// 没有报错、没有诊断、没有观测事实,事后查不出来。用户只会发现「我记的那条不见了」。
//
// **落法是两半**,因为 `StorageDir` 上没有原子的 create-if-absent,建不了真正的跨进程互斥:
//   · 进程内:按 (记忆上下文, 路径) 串行——同一个 Agent 里的前台、提取、整理三个写者真互斥;
//   · 跨进程:乐观校验——基于旧内容的写在落盘前再读一次,变了就拒,让调用方重看再试。
// 合起来就是「读改写不被插队」:同进程被队列挡住,跨进程被校验挡住。

import type { StorageDir } from "../storage/types.ts";

/** 每个记忆上下文一张「路径 → 上一次操作」的表。放 WeakMap:它是实现细节,不进公共类型。 */
const chains = new WeakMap<object, Map<string, Promise<unknown>>>();

/**
 * 同一个 owner 上,同一个路径的操作**彼此串行**。不同路径互不影响(它们是不同的文件)。
 *
 * 与 dream 状态那条链同一个模式,同一个理由:「单写者」防的是跨进程,防不了同一个 Agent
 * 里的并发——两个写并发时会双双读到旧内容、双双写回,后一个把前一个盖掉。
 */
export async function withMemoryFileLock<T>(owner: object, path: string, run: () => Promise<T>): Promise<T> {
  let table = chains.get(owner);
  if (table === undefined) {
    table = new Map();
    chains.set(owner, table);
  }
  const prev = table.get(path) ?? Promise.resolve();
  // 前一次失败不该堵死后面的操作,所以两个分支都接上 work
  const next = prev.then(run, run);
  // 链上留一份吞掉错误的,免得别人 await 到一个 rejected 的前驱
  const guarded = next.catch(() => undefined);
  table.set(path, guarded);
  try {
    return await next;
  } finally {
    // 我这一格还在队尾(没人接在我后面)才清掉,免得长会话攒下一张只增不减的表
    if (table.get(path) === guarded) table.delete(path);
  }
}

/** 乐观校验的结论:`stale` = 我读它之后有人改过,这次写不能落。 */
export type FreshnessVerdict = { fresh: true } | { fresh: false; reason: string };

/**
 * 基于旧内容的写,落盘前再确认一次那份旧内容还在。
 *
 * `basedOn === undefined` = 这次写不基于旧内容(整文件覆写、新建),没什么可校验的。
 * 别的进程刚好在这几毫秒里写了同一个文件时,**拒绝而不是覆盖**——让模型重看一次再改,
 * 比无声吃掉别人一条记忆好。
 */
export async function assertFresh(dir: StorageDir, path: string, basedOn: string | undefined): Promise<FreshnessVerdict> {
  if (basedOn === undefined) return { fresh: true };
  const now = await dir.read(path);
  if (now === basedOn) return { fresh: true };
  return {
    fresh: false,
    reason:
      now === null
        ? `'${path}' was deleted by another session while you were editing it; nothing was written.`
        : `'${path}' changed since you read it (another session is writing to this layer); nothing was written. View it again and redo your edit.`,
  };
}
