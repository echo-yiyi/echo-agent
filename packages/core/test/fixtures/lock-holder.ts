// 持锁进程（state-lock.test.ts 的 kill -9 判据用）：`bun lock-holder.ts <锁路径>`，拿到锁就一直待着，等着被杀。

import { fileStateLock } from "../../src/storage/file-lock.ts";

const lease = await fileStateLock(process.argv[2]!).acquire({ holder: "等着被杀的" });
if (lease === null) {
  console.error("拿不到锁");
  process.exit(1);
}
setInterval(() => {}, 1_000);
