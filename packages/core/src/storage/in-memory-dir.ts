// 内存实现:评测与单测零盘跑(确定性),或纯临时 agent。

import type { StorageDir } from "./types.ts";

export class InMemoryDir implements StorageDir {
  private readonly files = new Map<string, string>();

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
}
