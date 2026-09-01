// 落盘的 `CredentialStore`：`$ECHO_HOME/credentials.json`（没设 `ECHO_HOME` 就是 `~/.echo/credentials.json`）。
//
// **node-only**（`node:fs` / `node:path`），和 `FileDir` / `fileStateLock` 一样是 first-party 落盘默认件。
// `node:` 内置模块不违反「core 零运行时依赖」——那道门查的是 `package.json` 的三个依赖字段
// 与 MCP SDK 的 import（`test/zero-runtime-deps.test.ts`），不是内置模块。
//
// ## 为什么在 `ECHO_HOME` 根下，而不是状态根里
//
// 状态根是 `$ECHO_HOME/agents/<agentId>/`——**一个 agent 一份**。凭据不是：换个 `--agent-id`
// 不该要求用户重配一次 key。所以它住在根上，**不进 `agents/`**。
//
// ## 明文存储（已拍板）
//
// gh / aws / npm 都这么做，用户对「home 底下有个明文凭据文件」有预期。系统钥匙串要原生依赖，
// 与 core 的零运行时依赖冲突，留给以后——那时它只是 `CredentialStore` 的**另一个实现**，
// 端口已经在了，加它不用改别处。眼下的防线是文件 0600 + （由我们创建时的）父目录 0700。
//
// ## 两条纪律
//
// ① **key 的值不进任何错误信息、日志或诊断，截断也不行。** 所以 JSON 解析失败时
//    **不带上底层解析器的报错**——`JSON.parse` 的消息会把出错位置附近的原文抄进去，
//    而那段原文恰好就是 key。同理，认不出来的记录只报 provider id，不报记录内容。
//
// ② **读不动就报错，不当成「没有凭据」。** 权限不对、JSON 坏了却静默返回 `undefined`，
//    用户会以为自己没配过、重配一遍还是坏的——那是「假装在工作」的又一种形态。
//    只有 **ENOENT** 才是 `undefined`：没配过是常态，不是错。

import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { errText } from "../errors.ts";
import { echoHome, expandHome } from "../storage/file-dir.ts";
import type { Credential, CredentialStore } from "./types.ts";

/** 凭据文件名。它在 `ECHO_HOME` 根下，与 `agents/` 平级。 */
export const CREDENTIALS_FILE = "credentials.json";

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

/**
 * 盘上一条记录。**值是对象不是裸字符串**——给以后可能出现的 `baseUrl`、token 过期时间留位置，
 * 那时加字段不用改文件格式的形状。
 *
 * ```json
 * { "kimi": { "apiKey": "sk-…" }, "deepseek": { "apiKey": "sk-…" } }
 * ```
 */
type CredentialRecord = {
  apiKey?: unknown;
  access?: unknown;
  refresh?: unknown;
  expires?: unknown;
};

/** 临时文件名的进程内序号。理由同 `FileDir.write()`：只靠 pid + 毫秒会在并发写时碰撞。 */
let tempSeq = 0;

/**
 * 把凭据存在一个文件里的 `CredentialStore`：缺省 `$ECHO_HOME/credentials.json`
 *（没设 `ECHO_HOME` 就是 `~/.echo/credentials.json`），权限 0600，**跨 agent 共享**。
 *
 * ```ts
 * const credentials = new FileCredentialStore();
 * await credentials.write("kimi", { type: "api_key", key: "sk-…" });
 * const echo = await createEcho({ provider: kimiProvider(), credentials });
 * ```
 *
 * **它不是解析顺序的全部**：provider 自己的 `auth.apiKey.resolve()` 排在前面，
 * 内建那几家读的是环境变量。完整顺序是「环境变量 → 本 store → 没有」，
 * 收口在 `Models.checkAuth()` 与 `Models.stream()`（两处逐字相同）。
 *
 * 每次读写都现读现写文件，**不缓存**：外面改了文件、或另一个进程写了新凭据，下一次调用就看得见。
 */
export class FileCredentialStore implements CredentialStore {
  /**
   * @param file 显式路径。**不给就跟着 `ECHO_HOME` 走**，见 `path()`。
   */
  constructor(private readonly file?: string) {}

  /**
   * 当前的凭据文件路径。**缺省路径每次现算**，不在构造期定死——`ECHO_HOME` 正是
   * 「测试与多实例隔离」的那个旋钮（见 `echoHome()`），构造完才设它是常见用法。
   * `~` 会展开：`ECHO_HOME=~/x` 不展开会建出一个名叫 `~` 的目录。
   */
  path(): string {
    return this.file ?? join(expandHome(echoHome()), CREDENTIALS_FILE);
  }

  async read(providerId: string): Promise<Credential | undefined> {
    return toCredential((await this.load())[providerId], providerId, this.path());
  }

  async write(providerId: string, credential: Credential): Promise<void> {
    const all = await this.load();
    all[providerId] = toRecord(credential);
    await this.save(all);
  }

  async delete(providerId: string): Promise<void> {
    const all = await this.load();
    // 本来就没有就别写盘：省一次写，也避免把一个不存在的文件凭空创建出来。
    if (!Object.hasOwn(all, providerId)) return;
    delete all[providerId];
    await this.save(all);
  }

  /** 读全量。**只有 ENOENT 算「没配过」**，其余一律抛（见文件头纪律 ②）。 */
  private async load(): Promise<Record<string, unknown>> {
    const path = this.path();
    let text: string;
    try {
      text = await fs.readFile(path, "utf8");
    } catch (e) {
      if (isNotFound(e)) return {};
      // 系统错误的消息里只有路径与 errno，没有文件内容——可以原样带上。
      throw new Error(`读不了凭据文件（${errText(e)}）——先把它修好，不要当成「没配过」`, { cause: e });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      // **故意不带底层报错**：`JSON.parse` 的消息会把出错位置附近的原文抄进来，那就是 key。
      throw new Error(`凭据文件不是合法 JSON：${path}。修好它，或者删掉重新配一次。`);
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(`凭据文件的顶层应当是一个对象（按 provider id 分键）：${path}`);
    }
    return parsed as Record<string, unknown>;
  }

  /** 写全量。原子替换 + 权限显式设死。 */
  private async save(all: Record<string, unknown>): Promise<void> {
    const path = this.path();
    const dir = dirname(path);

    // **只在我们自己创建它的时候设 0700**：目录已经存在就是用户的，替他改权限属于越权
    //（`ECHO_HOME` 可能指向一个他有意共享的位置）。文件那一侧的 0600 是无条件的。
    try {
      await fs.stat(dir);
    } catch (e) {
      if (!isNotFound(e)) throw e;
      await fs.mkdir(dir, { recursive: true, mode: DIR_MODE });
      await fs.chmod(dir, DIR_MODE); // mkdir 的 mode 会被 umask 削掉，显式再来一次
    }

    // 临时文件 → rename：读者永远看到旧的完整文件或新的完整文件，不会看到半截。
    const temp = `${path}.${process.pid}.${(++tempSeq).toString(36)}.${Date.now().toString(36)}.tmp`;
    try {
      // **临时文件一出生就是 0600**：先按默认权限写出来、再 chmod，中间那一小段
      // key 已经落在盘上而权限还没收紧——那个窗口不必存在。
      await fs.writeFile(temp, `${JSON.stringify(all, null, 2)}\n`, { encoding: "utf8", mode: FILE_MODE });
      // `writeFile` 的 mode 同样被 umask 削（umask 022 时 0600 仍是 0600，但 umask 不由我们决定），
      // 所以**显式再设一次**，不依赖 umask——这是拍板要求的那条。
      await fs.chmod(temp, FILE_MODE);
      await fs.rename(temp, path); // rename 保留临时文件的权限位，落地就是 0600
    } catch (e) {
      // 失败别留下一个带着 key 的临时文件。清理失败不盖掉原始错误。
      await fs.unlink(temp).catch(() => undefined);
      throw e;
    }
  }
}

/**
 * 盘上记录 → `Credential`。认不出来**报错**，不返回 `undefined`——
 * 「这条我读不懂」和「你没配过」是两件事，混成一件就等于让用户重配一遍还是坏的。
 *
 * 报错里只出现 provider id 与路径，**不出现记录内容**（纪律 ①）。
 */
function toCredential(record: unknown, providerId: string, path: string): Credential | undefined {
  if (record === undefined) return undefined;
  if (typeof record !== "object" || record === null || Array.isArray(record)) {
    throw new Error(`凭据文件里 '${providerId}' 那条不是对象：${path}`);
  }
  const r = record as CredentialRecord;
  if (typeof r.apiKey === "string" && r.apiKey !== "") return { type: "api_key", key: r.apiKey };
  if (typeof r.access === "string" && typeof r.refresh === "string" && typeof r.expires === "number") {
    return { type: "oauth", access: r.access, refresh: r.refresh, expires: r.expires };
  }
  throw new Error(
    `凭据文件里 '${providerId}' 那条认不出来（既没有非空的 apiKey，也不是一份完整的 oauth 凭据）：${path}`,
  );
}

/**
 * `Credential` → 盘上记录。
 *
 * **`api_key` 的 `env` 不落盘**：它是「这把 key 是从哪个环境变量解析出来的」这个**来源标签**，
 * 对一份存在文件里的凭据没有意义，写进去只会让下次读出来的 `env` 说谎。
 */
function toRecord(credential: Credential): CredentialRecord {
  return credential.type === "api_key"
    ? { apiKey: credential.key }
    : { access: credential.access, refresh: credential.refresh, expires: credential.expires };
}

function isNotFound(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: string }).code === "ENOENT";
}
