// 环的另一半：**反向重命名导出**。
//
// 它回头引用 `api-probe-cycle.ts`，而那边又 `export *` 引它——两个模块互相依赖。
// 判据若用「递归 + 遇到环就返回空集」，算这一跳时对面还没算完，`cycleValue` 拿不到，
// `cycleRenamed` 就永久漏掉；递归返回后没有任何机制回来补它。只有固定点迭代能收敛到正确解。

export { cycleValue as cycleRenamed } from "./api-probe-cycle.ts";
