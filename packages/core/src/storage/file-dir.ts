// 真盘实现(default):最小可执行 agent 的持久化落点。
//
// 缺省根目录 = `~/.echo/`(环境变量 ECHO_HOME 覆盖——测试与多实例隔离靠它)。
// 写入原子:临时文件 → rename,读者永远看到旧完整文件或新完整文件,不会看到半截。
// 单进程假设:不做跨进程文件锁(两个进程共写同一 root 的并发防护列为后续,先诚实写明)。

import { DEFAULT_LOCK_TIMEOUT_MS, StorageLockBusy } from "./name-lock.ts";
import { claimGeneration, describeRecord } from "./generation-lock.ts";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve as resolvePath, sep } from "node:path";
import type { StorageDir } from "./types.ts";

/**
 * `~` 展开——`ECHO_HOME=~/x` 这种写法很常见，不展开会建出一个名叫 `~` 的目录。
 *
 * **住在这里是因为它是「解析落盘根」的一部分**：`create-agent.ts` 的状态根与
 * `FileCredentialStore` 的凭据路径都要它，各写一份就是同一条规则的两个真源。
 */
export function expandHome(p: string): string {
  return p === "~" || p.startsWith("~/") ? join(homedir(), p.slice(1)) : p;
}

/** 一切落盘的系统级缺省根。 */
export function echoHome(): string {
  const env = process.env["ECHO_HOME"];
  return env !== undefined && env !== "" ? env : join(homedir(), ".echo");
}

export class FileDir implements StorageDir {
  /**
   * 把相对路径解析成绝对路径，并**确保它没跑出 root**。
   *
   * 不能只靠调用方校验 id：那是把 containment 交给了每一个使用者，漏一个就漏一片。
   * 实测过 `sessionId="../../escaped"` 会在 stateDir 外写出 `escaped/meta.json`——
   * 端口自己不设防，上层的每处拼接都成了攻击面。
   */
  private resolve(path: string): string {
    const target = resolvePath(this.root, path);
    const root = resolvePath(this.root);
    // 前缀比较要带分隔符，否则 `/a/bc` 会被当成 `/a/b` 的子路径
    if (target !== root && !target.startsWith(root.endsWith(sep) ? root : root + sep)) {
      throw new Error(`路径逃出了状态根：'${path}'（解析到 ${target}，根是 ${root}）`);
    }
    return target;
  }

  /** 临时文件名的进程内序号。见 `write()` 里的说明——只靠时间戳会碰撞。 */
  private static tempSeq = 0;

  /**
   * 词法 containment 只能挡 `../`。**符号链接照样出得去**：实测把 `root/sessions`
   * 链到外部目录之后，`createOrResume("main")` 会在外部写出 `main/meta.json`——
   * 每一段路径都在 root 底下，`resolve()` 全程没话说。
   *
   * 所以真正的边界要问文件系统：把**最近的已存在祖先** realpath 之后再比一次。
   * 用祖先是因为目标本身通常还不存在（正要创建它）；祖先在 root 之内，
   * 那么在它下面新建的东西也在 root 之内。
   *
   * **必须在 `mkdir` 之前调**：`mkdir(..., {recursive:true})` 会顺着符号链接
   * 在外面把目录建出来，那时再检查已经晚了。
   */
  private async resolveSafe(path: string): Promise<string> {
    const target = this.resolve(path);
    let realRoot: string;
    try {
      realRoot = await fs.realpath(this.root);
    } catch (e) {
      if (isNotFound(e)) return target; // 根还不存在 → 里面不可能有符号链接
      throw e;
    }

    let cursor = target;
    let real: string | null = null;
    while (real === null) {
      try {
        real = await fs.realpath(cursor);
      } catch (e) {
        if (!isNotFound(e)) throw e;
        const parent = dirname(cursor);
        if (parent === cursor) return target; // 一路到文件系统根都不存在
        cursor = parent;
      }
    }

    const prefix = realRoot.endsWith(sep) ? realRoot : realRoot + sep;
    if (real !== realRoot && !real.startsWith(prefix)) {
      throw new Error(`路径经符号链接逃出了状态根：'${path}'（${cursor} 实际指向 ${real}，根是 ${realRoot}）`);
    }
    return target;
  }

  /** root 缺省 `~/.echo`;各模块用子目录隔域(memory/、schedule/)。 */
  constructor(private readonly root: string = echoHome()) {}

  async read(path: string): Promise<string | null> {
    const target = await this.resolveSafe(path);
    try {
      return await fs.readFile(target, "utf8");
    } catch (e) {
      if (isNotFound(e)) return null;
      throw e;
    }
  }

  async write(path: string, content: string): Promise<void> {
    // 检查在 mkdir **之前**——否则递归建目录会先顺着符号链接把路径实体化到外面。
    const target = await this.resolveSafe(path);
    await fs.mkdir(dirname(target), { recursive: true });
    // 临时名必须**在同进程内也唯一**：只用 pid + 毫秒时会碰撞——同一毫秒内并发写同一路径时，
    // 两个调用生成同名临时文件，先到的 rename 走了，后到的 rename 就 ENOENT，
    // 那一次写**静默丢失**（2026-08-18 在 CI 上真炸过：SessionService 并发 append 撞上它）。
    // 加一个进程内单调计数器就够；跨进程仍靠 pid 区分。
    const temp = `${target}.${process.pid}.${(++FileDir.tempSeq).toString(36)}.${Date.now().toString(36)}.tmp`;
    await fs.writeFile(temp, content, "utf8");
    await fs.rename(temp, target); // 原子替换:不留半截文件
  }

  /**
   * 锁目录 `<name>.lock/`，带递增编号的锁（`generation-lock.ts`）——跨实例、跨进程互斥；
   * 持有者崩在持锁期间（同一台机器、pid 查无此号）时，下一个来拿的人自动接管。
   * 活着的持有者占着就轮询到 `timeoutMs`，然后抛 `StorageLockBusy`（带持有者与锁的位置）。
   * 释放只放**自己那一代**。
   */
  async lock(name: string, opts?: { timeoutMs?: number }): Promise<() => Promise<void>> {
    const lockDir = `${await this.resolveSafe(name)}.lock`;
    const deadline = Date.now() + (opts?.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS);
    for (;;) {
      const got = await claimGeneration(lockDir, { holder: `FileDir.lock ${name}` });
      if (got.ok) return () => got.claim.release();
      if (Date.now() >= deadline) {
        const who = got.seen.kind === "held" ? describeRecord(got.seen.record) : `锁是坏的（${got.seen.why}）`;
        throw new StorageLockBusy(name, `${who}；锁 ${lockDir}`);
      }
      await new Promise((r) => setTimeout(r, 5 + Math.floor(Math.random() * 20)));
    }
  }

  async remove(path: string): Promise<boolean> {
    const target = await this.resolveSafe(path);
    try {
      await fs.unlink(target);
      return true;
    } catch (e) {
      if (isNotFound(e)) return false;
      throw e;
    }
  }

  async list(prefix: string): Promise<string[]> {
    const out: string[] = [];
    // 只走 prefix 所在的那棵子树（review 2026-09-07：此前一律全树遍历再过滤，每秒一拍的 inbox 轮询代价随 transcript 长度线性涨）。
    // 起点经 resolveSafe：prefix 目录是逃出 root 的符号链接时照样抛；起点不存在时 walk 自己返回空。
    const cut = prefix.lastIndexOf("/") + 1;
    const dirPart = prefix.slice(0, cut);
    const start = dirPart === "" ? this.root : await this.resolveSafe(dirPart);
    await this.walk(start, out);
    return out.filter((p) => p.startsWith(prefix)).sort();
  }

  private async walk(dir: string, out: string[]): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (e) {
      if (isNotFound(e)) return; // 根还没建 = 空
      throw e;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await this.walk(full, out);
      else if (entry.isFile() && !entry.name.endsWith(".tmp")) {
        out.push(relative(this.root, full).split(sep).join("/"));
      }
    }
  }
}

function isNotFound(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: string }).code === "ENOENT";
}
