// `export type * from` 的源。这条写法不产生 ExportSpecifier——符号的声明直接指向本文件，
// 所以「看出口标记」那条路看不见它，必须从入口 AST 一侧补。
//
// 故意放一个 **class**：它本身是值+类型，只有 `export type *` 那一跳能把它降成纯类型。
// 若判据漏了这条路，清点会把它记成 both，而用户 import 到的其实什么都没有。

export class StarOnlyType {
  readonly tag = "star-type";
}

export const starTypeValue = 1;
