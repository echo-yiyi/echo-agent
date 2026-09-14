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
- CI 那条要分清三种情况：**绿**就往下走；**红**先查清再说，别急着发；**长时间 queued 且没分配 job**（`gh run view <id> --json jobs` 为空）是 GitHub 调度侧的事，跟本仓无关——此时 main 并没有红，而 `v*` tag 触发的 Release 自己会重跑 typecheck 与全套测试，可以继续，但要如实告诉用户这一条没跑完。
- 目标版本合法且比线上新：`npm dist-tag ls echo-agent` 看当前 `latest`。0.x 阶段，有破坏性变更就升次版本号（0.1 → 0.2），否则升修订号。
- trusted publishing **没法从命令行核对**，别浪费时间试。这个账号的包设了「要求 2FA 并禁用 token」，本机 npm CLI 恒为 401：`npm whoami` / `token list` / `trust list` / `stage list` 全部用不了；而 `npm view`、`npm dist-tag ls`、安装这些公开读不受影响（发布脚本判断「版本发过没有」照常工作）。
- 所以这一条的实际做法：问用户五个包是否都在 npmjs.com 网页上配好了，**尤其「Allowed actions」要勾上允许 `npm publish`**（只给 stage 的话发布会停在待批准）。账户类操作一律走网页——用户的 2FA 只有 passkey、没有一次性码，服务端不给命令行认证机会。没配好也不会造成半套发布：CI 会在第一个包就失败。

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
- **但「重跑还红」就不是抖动。** 判据是三方对照：本地多次、CI 的另一个平台、CI 的同一平台重跑。2026-09-13 那次 ubuntu 连红 4 次而 macOS 与本地全绿，根因是测试等错了就绪判据（等「inbox 账本空了」而不是 `agent.acceptsWork`）——那种情况要去读代码，别靠一遍遍重跑。
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

- **发布后有几分钟的传播窗口，别在窗口里下结论。** 2026-09-14 实测约 5–8 分钟：元数据（packument、`dist-tags`）已经显示新版本，**tarball 还取不到**，`npm i` 报 404 / ETARGET。当时据此判过一次「这个版本是坏的」，实际只是没到。
- 因此 `dist-tag ls` **不足以证明发布成功**（它会先于 tarball 变成新版本）。以这两条为准：`curl -s -o /dev/null -w '%{http_code}' https://registry.npmjs.org/<包名>/-/<去掉 scope 的名字>-$V.tgz` 返回 200，以及下面的真安装。都还没好就等几分钟重试。
- 在干净目录里实装冒烟：
  - npm 装 `@echo-agent/core@$V`，用 Node import，能拿到导出；
  - bun 装 `echo-agent@$V` 和 `@echo-agent/coding@$V`，`echo-agent --help` 与 `echo-coding --help` 都能打出用法。

完成判据：五个包的 `latest` 都是 `$V`，五个 tarball 都返回 200，三项冒烟全部通过。

## 8. 汇报

开头 2–3 句白话：发了哪个版本、来自哪个提交、装下来能不能用。细节放在后面：门禁读数、Release 运行链接、冒烟结果。

## 出错时

- **Release 挂在测试**：多半是那几条已知抖动，`gh run rerun <id> --failed` 即可。发布脚本可以重跑，已经发过的会跳过。
- **Release 挂在发布（403 / 404 / OIDC 相关）**：要么 trusted publishing 没配，要么 `repository.url` 和仓库没有精确匹配（这一项只有 CI 真发时才验得到）。修好之后：一个包都还没发出去的话，删掉远端 tag 重推（`git push --delete origin "v$V"` 之后再推一次）；已经发出去一部分的话，重跑那次运行，脚本会跳过已发的。
- **Release 成功了但装不上**：先按上面那条当作传播窗口处理——等几分钟，用 tarball 直接 GET 加真安装复核，别急着补发。超过十几分钟仍取不到才当成事故。另注意 `scripts/release.ts` 目前在 `npm publish` 成功时只打自己的「✓ 发布」、吞掉了 npm 的原始输出，所以日志里分不出「真发布」和「进了 staging」——排查时别指望从日志看出来。
- **要在本地发**（CI 不可用）：只有用户明确要求时，才跑 `bun scripts/release.ts --publish --git-tag "v$V"`。用户的 npm 2FA 是 passkey，没有 6 位验证码，本地真发只能用恢复码（一次性），或者临时建一个 granular token、发完就删。
- **测发布脚本本身**：在 PATH 前面放一个只记录参数的假 `npm`，并把 `NPM_CONFIG_REGISTRY` 指向一个连不上的地址，这样测试不可能真发。
