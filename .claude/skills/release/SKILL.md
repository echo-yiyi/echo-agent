---
name: release
description: 发布 echo-agent 的新版本到 npm：五个包锁步升版本 → 本地演练 → 推 tag 让 CI 用 trusted publishing 发布 → 从 registry 实装验证。
argument-hint: "<版本号，如 0.2.0>"
disable-model-invocation: true
---

# 发布

目标版本号是 $ARGUMENTS；没给就先问用户。按顺序执行，每步满足完成判据再进下一步。

发布不可撤回：npm 上用过的 `包@版本` 永远不能再用。所以整个流程里**只有两个动作会上传**——第 6 步推 tag（由 CI 发布），以及用户明确要求时的本地 `bun scripts/release.ts --publish`。其余检查全部在**演练**模式下做；`bun scripts/release.ts` 不带参数就是演练。

发布机制与守卫以 `scripts/release.ts` 的头注释为准，CI 那一半在 `.github/workflows/release.yml`。本 skill 只写流程，和那两处看不出来的坑。

## 1. 核对前置（只信实时状态）

- `git fetch` 之后确认：在 `main`、工作树干净、HEAD 等于 `origin/main`，且 `origin/main` 最近一次 CI 双平台都绿（`gh run list --branch main --limit 1`）。
- 目标版本合法且比线上新：`npm dist-tag ls echo-agent` 看当前 `latest`。0.x 阶段，有破坏性变更就升次版本号（0.1 → 0.2），否则升修订号。
- trusted publishing 已配好：对五个包各跑一次 `npm trust list <包名>`，每个都应列出 `release.yml`。查不出结果（命令报错、要求 2FA）就把原话告诉用户，说明不配好的话 CI 会在发布那步失败，由用户决定先去配还是继续。

完成判据：一张小表列出以上每项的实际状态；全部满足，或者不满足的项已经由用户拍板。

## 2. 五个包锁步升版本，重建 lockfile

```bash
V=<版本号>
perl -0pi -e 's/("version":\s*")[^"]*(")/${1}'"$V"'${2}/' packages/*/package.json
rm bun.lock && bun install
```

- perl 只替换每个文件里第一处 `"version"`，也就是顶层那个字段，其余字节原样不动。不用 `npm pkg set`：它会顺手整理包清单（删掉 core 的空 `dependencies`、把 tui 的依赖按字母重排），这些改动会混进发版提交。
- 包之间是精确版本依赖，五个包必须同一个版本号。
- **必须删掉 `bun.lock` 再重建**：`bun install` 连同 `--force` 都不会刷新 lockfile 里记录的 workspace 版本，不重建的话，发出去的包会依赖一个永远不存在的旧版本。第 3 步的演练守卫能抓住它，但在这一步就做对。

完成判据：`git diff -U0 -- 'packages/*/package.json'` 里每个文件恰好改了一行，而且就是 `version` 那一行；`git diff --stat` 除此之外只有 `bun.lock`。

## 3. 本地门禁 + 演练

```bash
bun install --frozen-lockfile
bun run typecheck
bun test
bun scripts/docs-lint.ts
bun scripts/release.ts            # 演练：五个包打包、过守卫、npm publish --dry-run
```

- 判绿看每条命令的真实退出码。
- `bun test` 有几条已知的并跑抖动（resident-v0、cli setup、cli serve）。只红这几条时单独重跑，重跑绿了就按抖动处理。
- 演练要对五个包都打出「✓ 演练」，最后一行是「演练完成」。

完成判据：五条命令退出码全是 0，演练输出覆盖五个包。

## 4. 提交并推 main，等 CI

- 只暂存五个 `package.json` 和 `bun.lock`。提交信息按仓库格式：中文标题句、要点、门禁读数、`Co-Authored-By` 与 `Claude-Session` 两行 trailer。
- `git push origin main`，等这个提交在 main 上的 CI 双平台都绿。

完成判据：`origin/main` 就是这个版本提交，并且它的 CI 两个 job 都是 success。

## 5. 请用户确认

把版本号、提交哈希、演练结果、第 1 步那张表摆给用户，等到一句明确的「发」再继续。用户犹豫或者想改，就停在这一步。

完成判据：用户明确同意发布这个版本、这个提交。

## 6. 推 tag，盯 CI 发布

```bash
git tag -a "v$V" -m "v$V"
git push origin "v$V"
```

- tag 打在第 4 步那个提交上。推上去就会触发 `Release` workflow：先跑 typecheck 和测试，再按依赖顺序发布，已经发过的版本会跳过。
- 一直盯到它结束：`gh run list --workflow release.yml --limit 1`；失败时看 `gh run view <id> --log-failed`。

完成判据：这次 Release workflow 运行是 success。

## 7. 从 registry 验证

- 用 `npm dist-tag ls <包名>` 核对五个包的 `latest` 都是 `$V`。新发的 scoped 包在 CDN 上会负缓存 404 一段时间，所以以 dist-tag 为准，`npm view` 暂时查不到不代表没发出去。
- 在干净目录里实装冒烟：
  - npm 装 `@echo-agent/core@$V`，用 Node import，能拿到导出；
  - bun 装 `echo-agent@$V` 和 `@echo-agent/coding@$V`，`echo-agent --help` 与 `echo-coding --help` 都能打出用法。

完成判据：五个 `latest` 都是 `$V`，三项冒烟全部通过。

## 8. 汇报

开头 2–3 句白话：发了哪个版本、来自哪个提交、装下来能不能用。细节放在后面：门禁读数、Release 运行链接、冒烟结果。

## 出错时

- **Release 挂在测试**：多半是那几条已知抖动，`gh run rerun <id> --failed` 即可。发布脚本可以重跑，已经发过的会跳过。
- **Release 挂在发布（403 / 404 / OIDC 相关）**：要么 trusted publishing 没配，要么 `repository.url` 和仓库没有精确匹配（这一项只有 CI 真发时才验得到）。修好之后：一个包都还没发出去的话，删掉远端 tag 重推（`git push --delete origin "v$V"` 之后再推一次）；已经发出去一部分的话，重跑那次运行，脚本会跳过已发的。
- **要在本地发**（CI 不可用）：只有用户明确要求时，才跑 `bun scripts/release.ts --publish --git-tag "v$V"`。用户的 npm 2FA 是 passkey，没有 6 位验证码，本地真发只能用恢复码（一次性），或者临时建一个 granular token、发完就删。
- **测发布脚本本身**：在 PATH 前面放一个只记录参数的假 `npm`，并把 `NPM_CONFIG_REGISTRY` 指向一个连不上的地址，这样测试不可能真发。
