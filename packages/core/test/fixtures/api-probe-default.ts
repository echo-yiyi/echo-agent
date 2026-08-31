// 自检入口 · `export default` 声明式。
//
// **模块对外的名字是 `default`，不是 `DefaultThing`。** 后者只是文件内部绑定，
// 外面 `import { DefaultThing }` 拿不到任何东西——Bun 实际导出的键就是 `["default"]`。
//
// 上一版把本地名加进了运行时集合，于是真正的 `default` 反而不在集合里、被判成纯类型。
// `export default function` 与匿名形式（`export default class {}`）同属这一支。

export default class DefaultThing {}
