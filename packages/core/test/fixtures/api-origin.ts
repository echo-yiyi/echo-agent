// api-snapshot 门的自检 fixture：**原始声明**都在这里。
// 探针入口经过一层中转再导出它们，用来验「origin 必须解到原始声明文件，不是停在中转站」。

export const originValue = 1;

export type OriginType = { readonly a: number };

export class OriginClass {
  readonly tag = "origin";
}

/** 同名的值与类型 → 期望判成 `both`，且不是 class。 */
export const DualShape = { k: 1 };
export type DualShape = { readonly k: number };

/** 负例：不导出的声明**不该**出现在清点结果里。 */
const notExported = 42;
export const usesNotExported = notExported;
