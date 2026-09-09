# 摘掉 OAuth 半接线：凭据只有 api key 一种

> 状态:implemented · 提出 2026-09-07（review 批 6 顺带，#50）· 拍板 2026-09-09（用户，选 B）· 实现 2026-09-09 · 来源 [`Credential`](../../../packages/core/src/provider/types.ts#symbol=Credential) 与 [`FileCredentialStore`](../../../packages/core/src/provider/file-credentials.ts#symbol=FileCredentialStore)

## 现状(拍板前)

`Credential` 有 `oauth` 变体（access / refresh / expires），`ProviderAuth` 有 `oauth.refresh / login` 两个口，凭据文件能存能读，`Models.resolveAuth()` 见到 oauth 凭据就报「配好了」。但没有一家 provider 实现过 `oauth`，请求路径（`Models.stream()` → 方言）从不读它：一份 oauth 凭据在 `checkAuth` 里算配好、发请求时没有任何头。`StreamOptions.apiKey` 的注释还在拿「短命 OAuth token 会过期」解释为什么 key 每轮重解析。

## 不拍板的代价

公共类型承诺一种没人兑现的鉴权；凭据文件格式多一种永远读不出用处的记录；新接 provider 的人会以为照着 `oauth` 口写就能用。

## 选项

- **A. 接上**：`Models.stream()` 见 oauth 凭据先看 `expires`，过期走 `p.auth.oauth.refresh()` 再写回 store，请求带 `Authorization: Bearer <access>`；至少一家 provider 实现 refresh。凭据文件格式不变。
- **B. 摘掉**：`Credential` 只剩 `api_key`，`ProviderAuth.oauth` 删，凭据文件只认 `{ apiKey }`——老文件里的 oauth 记录判「认不出」而不是静默跳过；将来要 OAuth 时按当时那家的协议重新设计。

## 决定

**B**（2026-09-09 用户拍板）。理由：预发布阶段不留没人兑现的公共面；接上要有一家真实 provider 做验证，目前五家都是 api key，接了也没法用真 API 证明。`Credential.type` 判别字段保留，将来真接第二种时不改调用方。

## 验收

`Credential` 类型只有 `api_key` 一个成员；`ProviderAuth` 没有 `oauth`；凭据文件里 `{ access, refresh, expires }` 那种记录读出来抛「认不出来」（`packages/core/test/file-credentials.test.ts#test=老文件里的-oauth-那种记录access-refresh-expires认不出判红不静默当成没配2026-09-09-摘掉-oauth-半接线`）；仓内 `grep -rn oauth packages/*/src` 只剩本记录指向的注释。
