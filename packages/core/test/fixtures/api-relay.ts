// 中转站：让探针入口到原始声明之间隔两层 alias。
// 清点若只解一层 alias，`originValue` 的 origin 会停在这个文件上——门就会红。

export { originValue } from "./api-origin.ts";
