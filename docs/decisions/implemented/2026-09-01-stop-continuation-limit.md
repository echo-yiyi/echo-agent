# stop hook 最多继续三次是不是产品约束

> 状态:implemented · 提出 2026-09-01 · 拍板 2026-09-07(留硬编码) · 实现 2026-09-07(文档提一句) · 来源 [Lifecycle 与 Run Loop](../../design/lifecycle-and-run-loop.md) §9

## 现状

没有 follow-up 时,stop hook 最多可以注入三次继续工作,上限由 run loop 里的 `MAX_STOP_CONTINUATIONS` 常量硬编码为 3。

## 不拍板的代价

如果它是产品约束,使用者需要知道并能依赖;如果它只是防死循环的保险丝,那不该由 engine 写死一个魔法数——本仓的规矩是「部署会变的取舍应当可配置」。

## 选项

- **A. 认定为产品约束。** 公开这个数,写进文档并加测试。代价:从此它是契约,改动即破坏性变更。
- **B. 认定为保险丝。** 提成可配置项,给一个有理由的默认值。代价:多一个配置面。

## 决定

**留硬编码,不进配置**(2026-09-07 用户拍板)。它是防死循环的保险丝,不是产品约束;公开文档提一句「stop hook 最多把 agent 拉回三次」即可,不成为契约、不加配置面。验收改为:数字出现在 run loop 文档里,`MAX_STOP_CONTINUATIONS` 仍是 engine 常量。

## 验收

数字出现在 run loop 文档里(docs/design/run-loop-layers.md §2.1),`MAX_STOP_CONTINUATIONS` 仍是 engine 常量,不进配置、不加契约测试。
