// 记忆的原子提交（2026-09-10 重做）。
//
// 上一版把锁挂在 **harness 对象**上（`WeakMap<AgentMemories, …>`）：同一个 Agent 里的写者互斥了，
// 可两个 harness 实例——两段 session、同进程或跨进程——写同一个共享层时谁也不等谁；再加上
// `assertFresh` 的「先读后比、再写」不是原子的，两边都能读到旧内容、都判新鲜、都写回，后写的吃掉
// 先写的，**双方都报告成功**（find_job 的并发探针实测：A B → A BB）。
//
// 现在锁挂在**那一层的字节面**上，名字是模块：`<层>/.locks/<模块>`。同一层、同一个模块的一次提交
// （读 → 改 → 预算校验 → 落盘 → 重建索引）整段独占——正文、预算、索引三件一起被罩住。
//   · 字节面有 `lock` 原语（`FileDir` 的锁文件、`InMemoryDir` 的实例内互斥，经视图一路转发）→ 用它，
//     跨实例、跨进程都互斥；
//   · 没有（测试替身、别人包的一层）→ 按**字节面对象**在进程内互斥：共用同一个对象的写者照样排队。
// 等不到锁抛 `StorageLockBusy`，调用方把它报成明确的冲突——**不自动接管陈旧锁**（`storage/name-lock.ts`）。
//
// `assertFresh` 留着：它挡的是**不守这套协议**的写者（人手改文件、旧版本的进程），落盘前内容变了就拒。

import type { StorageDir } from "../storage/types.ts";
import { NameMutex } from "../storage/name-lock.ts";

/** 没有 lock 原语的字节面：按对象身份在进程内互斥。放 WeakMap——字节面没了，它的锁跟着没。 */
const fallback = new WeakMap<object, NameMutex>();

/**
 * 在 `dir` 上独占 `name` 跑完 `run`。拿不到锁时抛 `StorageLockBusy`（由调用方报成冲突）。
 * 释放在 finally 里——`run` 抛错也不会把锁留在盘上。
 */
export async function withMemoryRegionLock<T>(dir: StorageDir, name: string, run: () => Promise<T>, timeoutMs?: number): Promise<T> {
  let release: () => Promise<void>;
  if (dir.lock !== undefined) {
    release = await dir.lock(name, timeoutMs === undefined ? undefined : { timeoutMs });
  } else {
    let mutex = fallback.get(dir);
    if (mutex === undefined) {
      mutex = new NameMutex();
      fallback.set(dir, mutex);
    }
    release = await mutex.acquire(name, timeoutMs);
  }
  try {
    return await run();
  } finally {
    await release();
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
