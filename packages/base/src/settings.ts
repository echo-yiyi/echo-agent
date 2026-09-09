// CLI 的设置文件：`$ECHO_HOME/settings.json`（D7，2026-09-01 用户拍板「切换了之后重启还要能用」）。
//
// 现在只有一个键：上次选的模型。**显式 `--provider` / `--model` 永远赢**——设置只是「没说就用上次的」。
// 为什么在 cli 不在 core：记住哪个模型是**壳的启动策略**（选装配入参），core 没有对应的端口；
// 凭据不同——`CredentialStore` 端口在 core，所以它的文件实现在 core。
//
// 与 credentials.json 同一套纪律：ECHO_HOME 根下（跨 agent）、`~` 展开同一条规则（core 的
// `expandHome`）、临时文件 → rename 原子写。**读不动不挡启动**（D3/D6 同一原则：配置是运行态）：
// 坏 JSON / 权限不对 → 如实带一条口信回去、当没有设置用缺省，绝不静默、也绝不因此起不来。

import { echoHome, expandHome } from "@echo-agent/core";
import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";

export const SETTINGS_FILE = "settings.json";

export type CliSettings = Readonly<{
  /** 上次选的模型（Ctrl+L 或首次运行引导设置里选的）。provider 存的是 `--provider` 短名。 */
  model?: Readonly<{ provider: string; id: string }>;
}>;

export type SettingsReadResult = Readonly<{
  settings: CliSettings;
  /** 读不动时的口信（给壳显示 / 管道进 stderr）。有它 = settings 是空缺省，不是文件内容。 */
  problem?: string;
}>;

export function settingsPath(): string {
  return join(expandHome(echoHome()), SETTINGS_FILE);
}

let tempSeq = 0;

export async function readSettings(): Promise<SettingsReadResult> {
  const path = settingsPath();
  let text: string;
  try {
    text = await fs.readFile(path, "utf8");
  } catch (e) {
    if ((e as { code?: string }).code === "ENOENT") return { settings: {} }; // 没有设置是常态
    return { settings: {}, problem: `读不了设置文件 ${path}（${(e as Error).message}）——先用缺省` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { settings: {}, problem: `设置文件不是合法 JSON：${path}——先用缺省，修好或删掉它` };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { settings: {}, problem: `设置文件的顶层应当是一个对象：${path}——先用缺省` };
  }
  const raw = parsed as { model?: unknown };
  let model: CliSettings["model"];
  if (raw.model !== undefined) {
    const m = raw.model as { provider?: unknown; id?: unknown };
    if (typeof m === "object" && m !== null && typeof m.provider === "string" && typeof m.id === "string") {
      model = { provider: m.provider, id: m.id };
    } else {
      return { settings: {}, problem: `设置文件里 model 那条认不出来：${path}——先用缺省` };
    }
  }
  return { settings: model === undefined ? {} : { model } };
}

/**
 * 合并写回（读-改-写整份）。**失败不抛**：记住上次选择是便利不是承诺，写不进去
 * 不该打断正在切换模型的用户——返回口信让壳如实说一句。
 */
export async function writeSettings(patch: CliSettings): Promise<{ problem?: string }> {
  const path = settingsPath();
  try {
    const current = (await readSettings()).settings; // 读不动就当空：宁可丢旧设置也别把坏文件原样并进来
    const next = { ...current, ...patch };
    await fs.mkdir(dirname(path), { recursive: true });
    const temp = `${path}.${process.pid}.${(++tempSeq).toString(36)}.tmp`;
    await fs.writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    await fs.rename(temp, path); // 原子替换：读者永远看到完整文件
    return {};
  } catch (e) {
    return { problem: `设置没存上（下次启动记不住这次的选择）：${(e as Error).message}` };
  }
}
