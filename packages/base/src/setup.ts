// 凭据的**判据与验证**（不碰界面）：这家配好了没、这把 key 能不能用。
//
// 2026-09-09 拆包：终端里那个收 key 的组件（`CredentialSetup`）跟着壳走进 `@echo-agent/tui`，
// 判据留在装配层——管道形态也要用它决定「缺 key 就在启动前报错退出」，而管道形态没有界面。
//
// 一条纪律贯穿本文件：**key 不进任何返回给人看的字符串**。验证失败的原因、写盘失败的报错里都没有它，
// 它只出现在 Authorization 头里。

import { errText, Models, type CredentialStore, type Provider } from "@echo-agent/core";

/** 验一把 key 能不能用。`reason` 是给人看的，**不许包含 key**。 */
export type VerifyOutcome = Readonly<{ ok: true }> | Readonly<{ ok: false; reason: string }>;

export type VerifyFn = (
  input: Readonly<{ provider: Provider; apiKey: string; signal?: AbortSignal }>,
) => Promise<VerifyOutcome>;

/**
 * 「这家配好了没」——与请求路径**同一个判据**（`Models.checkAuth()`：环境变量 → 凭据文件 → 没有）。
 * 壳子启动时问一次，决定要不要把配置流程摆出来；管道形态用它决定要不要在启动前就报错退出。
 */
export async function isConfigured(provider: Provider, credentials: CredentialStore): Promise<boolean> {
  const models = new Models(credentials);
  models.setProvider(provider);
  return (await models.checkAuth(provider.id)) !== undefined;
}

/**
 * 拿一把 key 去问端点「你认不认」。**只读**：`GET {baseUrl}/models`。
 *
 * key 只出现在 Authorization 头里——不进 URL（会被日志与代理记下来），
 * 也不进任何返回的 `reason`。
 */
export async function verifyApiKey(
  input: Readonly<{ provider: Provider; apiKey: string; signal?: AbortSignal; fetchFn?: typeof fetch }>,
): Promise<VerifyOutcome> {
  const baseUrl = input.provider.baseUrl;
  if (baseUrl === undefined) {
    // 五家内建的都有 baseUrl；自定义 provider 没有就**说清楚验不了**，不要假装验过。
    return { ok: false, reason: `provider '${input.provider.id}' 没有 baseUrl，没法验证这把 key` };
  }
  const url = `${baseUrl.replace(/\/+$/, "")}/models`;
  const doFetch = input.fetchFn ?? fetch;
  let res: Response;
  try {
    res = await doFetch(url, {
      method: "GET",
      headers: { ...input.provider.headers, authorization: `Bearer ${input.apiKey}` },
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    });
  } catch (e) {
    return { ok: false, reason: `连不上 ${url}：${errText(e)}` };
  }
  if (res.ok) return { ok: true };
  if (res.status === 401 || res.status === 403) return { ok: false, reason: `这把 key 被端点拒了（HTTP ${res.status}）` };
  // 5xx / 429 之类不是「key 不对」，但也**没能证明它对**——不能凭这个就落盘。
  return { ok: false, reason: `${url} 回了 HTTP ${res.status}，没能确认这把 key 可用` };
}
