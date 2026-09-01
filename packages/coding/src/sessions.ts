// SessionManager 的文件实现——core 定端口(session/types.ts),磁盘布局归产品层。
//
// 布局:<dir>/<id>.meta.json(SessionInfo)+ <id>.jsonl(SessionEntry 逐行 append)。
// append-only:落盘即持久,进程死也只丢「还没发生的」;坏档 fail-loud,不给半截 session。

import { appendFile, mkdir, readdir, readFile, rename as renameFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SessionData, SessionEntry, SessionInfo, SessionManager } from "@echo-agent/core";

export class FileSessionManager implements SessionManager {
  private seq = 0;
  private ready: Promise<void>;

  constructor(private readonly dir: string) {
    this.ready = mkdir(dir, { recursive: true }).then(() => {});
  }

  async create(opts?: { name?: string }): Promise<SessionInfo> {
    await this.ready;
    const id = `s-${Date.now().toString(36)}-${++this.seq}`;
    const now = Date.now();
    const info: SessionInfo = { id, name: opts?.name ?? id, createdAt: now, updatedAt: now, messageCount: 0 };
    await writeFile(this.metaPath(id), JSON.stringify(info, null, 2), "utf8");
    await writeFile(this.logPath(id), "", "utf8");
    return info;
  }

  async load(id: string): Promise<SessionData> {
    const info = await this.readMeta(id);
    const raw = await readFile(this.logPath(id), "utf8");
    const messages: SessionData["messages"] = [];
    let checkpoint: string | null = null;
    for (const [i, line] of raw.split("\n").entries()) {
      if (line.trim() === "") continue;
      let entry: SessionEntry;
      try {
        entry = JSON.parse(line) as SessionEntry;
      } catch {
        // 坏档 fail-loud:半截 JSON(多半是写入中途断电)不静默跳过
        throw new Error(`会话 ${id} 第 ${i + 1} 行损坏,拒绝加载半截 session`);
      }
      if (entry.kind === "message") messages.push(entry.message);
      else if (entry.kind === "compaction") checkpoint = entry.id;
    }
    return { info, messages, checkpoint };
  }

  async list(): Promise<SessionInfo[]> {
    await this.ready;
    const files = await readdir(this.dir).catch(() => [] as string[]);
    const out: SessionInfo[] = [];
    for (const f of files) {
      if (!f.endsWith(".meta.json")) continue;
      try {
        out.push(JSON.parse(await readFile(join(this.dir, f), "utf8")) as SessionInfo);
      } catch {
        /* 坏 meta 不进清单;load 那条路会 fail-loud */
      }
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async delete(id: string): Promise<void> {
    await rm(this.metaPath(id), { force: true });
    await rm(this.logPath(id), { force: true });
  }

  async rename(id: string, name: string): Promise<void> {
    const info = await this.readMeta(id);
    await this.writeMeta({ ...info, name, updatedAt: Date.now() });
  }

  async append(id: string, entries: SessionEntry[]): Promise<void> {
    if (entries.length === 0) return;
    await appendFile(this.logPath(id), entries.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
    const info = await this.readMeta(id);
    const added = entries.filter((e) => e.kind === "message").length;
    await this.writeMeta({ ...info, updatedAt: Date.now(), messageCount: info.messageCount + added });
  }

  /* ─────────────── 私有 ─────────────── */

  private metaPath(id: string): string {
    return join(this.dir, `${id}.meta.json`);
  }
  private logPath(id: string): string {
    return join(this.dir, `${id}.jsonl`);
  }
  private async readMeta(id: string): Promise<SessionInfo> {
    let raw: string;
    try {
      raw = await readFile(this.metaPath(id), "utf8");
    } catch {
      throw new Error(`会话不存在:${id}`);
    }
    return JSON.parse(raw) as SessionInfo;
  }
  private async writeMeta(info: SessionInfo): Promise<void> {
    // 先写临时再 rename:meta 是单文件真源,不能留半份
    const tmp = this.metaPath(info.id) + ".tmp";
    await writeFile(tmp, JSON.stringify(info, null, 2), "utf8");
    await renameFile(tmp, this.metaPath(info.id));
  }
}
