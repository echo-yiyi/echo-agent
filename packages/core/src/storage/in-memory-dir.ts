// 内存实现:评测与单测零盘跑(确定性),或纯临时 agent。

import type { StorageDir } from "./types.ts";
import { NameMutex } from "./name-lock.ts";

export class InMemoryDir implements StorageDir {
  private readonly files = new Map<string, string>();
  private readonly mutex = new NameMutex();

  async read(path: string): Promise<string | null> {
    return this.files.get(path) ?? null;
  }

  async write(path: string, content: string): Promise<void> {
    this.files.set(path, content);
  }

  async remove(path: string): Promise<boolean> {
    return this.files.delete(path);
  }

  async list(prefix: string): Promise<string[]> {
    return [...this.files.keys()].filter((k) => k.startsWith(prefix)).sort();
  }

  /** 同一个实例内互斥（它本来就只活在这一个进程里）。 */
  lock(name: string, opts?: { timeoutMs?: number }): Promise<() => Promise<void>> {
    return this.mutex.acquire(name, opts?.timeoutMs);
  }
}
