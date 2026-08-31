// 任务清单的文件落盘 —— **node-only，住子路径 `@echo-agent/core/task/fs`**。
//
// 为什么单独一个入口：它 import `node:fs/promises`。一旦进 core 主入口，
// `/engine` 那条 Web-standard 承诺当场作废——与 `mcp/stdio` 同一个先例。
//
// **它只搬字节**（D3 / §13.12.2）：JSON 编解码、逐条验形、「不存在算空清单」这些语义
// 收在 `loadTasks()` 里。这里剩下的唯一职责是**原子写**——那是存储介质的事，
// Store 的 conformance 要求「一次 write 要么整份生效、要么完全不生效，不留半份」。
//
// 用法：
// ```ts
// import { fileTaskStore } from "@echo-agent/core/task/fs";
// const agent = new Agent({ …, taskStore: fileTaskStore("./.echo/tasks.json") });
// await loadTasks(agent.tasks, store);   // 跨会话：上次的清单回来了
// ```

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { TaskStore } from "./types.ts";

export function fileTaskStore(path: string): TaskStore {
  return {
    async read(): Promise<string | null> {
      try {
        return await readFile(path, "utf8");
      } catch (e) {
        // 还没有这个文件 = 还没有清单，不是错误。其余 IO 错照抛（**不静默降级**）。
        if ((e as { code?: string }).code === "ENOENT") return null;
        throw e;
      }
    },

    async write(text: string): Promise<void> {
      await mkdir(dirname(path), { recursive: true });
      // 先写临时文件再 rename：**这就是本 Store 对「要么整份生效」的兑现**。
      // 中途崩掉留下的是 .tmp，不是半份清单。
      const tmp = `${path}.tmp`;
      await writeFile(tmp, text, "utf8");
      await rename(tmp, path);
    },
  };
}
