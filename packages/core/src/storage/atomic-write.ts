// 原子写一个文件（node-only）：`FileDir.write`、`fileTaskStore`、`FileCredentialStore` 共用这一份。
//
// 顺序：唯一临时名 → 写入 → 对临时文件 fsync → rename 到目标 → 对父目录 fsync（尽力而为）。
//   · rename 让读者永远看到旧的完整文件或新的完整文件，不会看到半截；
//   · rename 之前 fsync 文件：断电后不会出现「目录项已指向新文件、数据块还没落盘」的零长 / 半截文件
//     ——坏档一律判红，那样的文件会让会话打不开；
//   · rename 之后 fsync 父目录：让这次 rename 本身落盘。有的平台打不开目录或不支持对目录 fsync，那时不抛。
// macOS 上 `fsync` 只保证数据交给了磁盘，不保证磁盘自己的写缓存落盘（那要 `F_FULLFSYNC`，`node:fs` 不提供）。

import { promises as fs } from "node:fs";
import { dirname } from "node:path";

/** 临时文件名的进程内序号：只靠 pid + 毫秒，同一毫秒内并发写同一路径会撞名（先到的 rename 走了，后到的 ENOENT，那次写静默丢失）。 */
let tempSeq = 0;

/** 临时文件的后缀。`FileDir.list` 靠它跳过正在写的文件。 */
export const ATOMIC_TEMP_SUFFIX = ".tmp";

/**
 * 原子替换 `target` 的内容。父目录要已经存在。失败时删掉自己建的临时文件，原始错误照抛。
 * `mode` 给了就是临时文件出生时的权限，并在 rename 之前显式再设一次（不依赖 umask）。
 */
export async function writeFileAtomic(target: string, content: string, opts?: Readonly<{ mode?: number }>): Promise<void> {
  const temp = `${target}.${process.pid}.${(++tempSeq).toString(36)}.${Date.now().toString(36)}${ATOMIC_TEMP_SUFFIX}`;
  // `wx`：临时名万一撞上别人的，宁可这次写失败，也不去盖别人正在写的文件
  const handle = await fs.open(temp, "wx", opts?.mode);
  try {
    try {
      await handle.writeFile(content, "utf8");
      if (opts?.mode !== undefined) await handle.chmod(opts.mode);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temp, target);
  } catch (e) {
    await fs.unlink(temp).catch(() => undefined);
    throw e;
  }
  await syncDir(dirname(target));
}

/** 对目录 fsync，让刚做的 rename 落盘。尽力而为：打不开、不支持都不抛。 */
async function syncDir(dir: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(dir, "r");
    await handle.sync();
  } catch {
    // 有的平台（Windows）打不开目录或不支持对目录 fsync
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
