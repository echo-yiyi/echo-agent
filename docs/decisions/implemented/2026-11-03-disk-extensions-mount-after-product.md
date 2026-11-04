# 盘上发现的扩展排在产品自带的扩展之后挂载

> 状态:implemented · 提出 2026-11-03（全仓 review）· 拍板 2026-11-03（用户：按推荐修）· 来源 [`createEcho`](../../../packages/core/src/create-echo.ts#symbol=createEcho)

## 现状(拍板前)

`createEcho()` 的挂载顺序是 builtin → inline → 盘上发现的（各一代）→ `opts.extensions`（产品内容与壳，一代）→ role。[坏扩展不挡启动](2026-09-01-bad-extension-does-not-block-startup.md)（D6）只对盘上那几代生效：它们失败记诊断、跳过；显式那一代失败则整体构造失败。

后果（review 复现）：echo-coding 的用户在 `extensions/` 里写了一个名叫 `bash` 的工具，盘上那代先占了名字，接着产品的 `echo:shell` 注册 `bash` 时撞名、fail-loud，`createEcho` 整体抛——报错还指向 `echo:shell`，用户看不出是自己那个文件。同一个顺序还让启动与热部署不一致：启动时盘上扩展 inject 不到产品 provide 的 service、replace 不了产品的段，`/reload` 之后又可以（那时产品那代已经在），重启又不行。

## 不拍板的代价

D6「其他 extension 不能成为我们起不来的原因」不成立；启动与热部署对同一个扩展给出不同结果。

## 选项

- **A. 盘上的挪到产品那代之后、role 之前。** 撞名落在盘上那一代、成诊断；产品不能依赖盘上扩展提供的 service（本来也不该）。
- **B. 维持顺序，撞名时让显式那代跳过冲突项。** 产品缺工具照起，与「显式装配 fail-loud」冲突。

## 决定

**A**（2026-11-03 用户拍板「按推荐修」）。顺序变成 builtin → inline → `opts.extensions` → 盘上发现的（各一代）→ role；`Echo.extensions` 的列举顺序同步。机制以 [扩展、装配与所有权](../../design/extensions.md)「当前启动顺序」为准。

## 验收

`packages/core/test/create-echo.test.ts` 的「盘上扩展占了产品要用的工具名：只废它自己那代，产品照常起来」：盘上扩展与产品扩展注册同名工具时，`createEcho` 不抛，`echo.extensions` 含产品扩展、不含盘上那个，`echo.diagnostics` 恰好一条 `extension_mount_failed` 指向盘上那个文件。改回旧顺序该测试变红。
