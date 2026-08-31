// 通用存储接口:core 里一切要落盘的东西(memory、schedule、以后的 session)共用这一个哑文件面。
//
// 定位变更(2026-08-05 用户拍定):**我们做的不是代码级 agent 框架,是一个可以执行的最小 agent**
// ——所以 default 实现直接进 core(FileDir,node:fs),「core 零 node import」的旧宪法废除;
// 一切落盘缺省在系统级目录 ~/.echo/ 下(可用环境变量 ECHO_HOME 覆盖)。
// InMemoryDir 保留给评测与单测:零盘、零不确定性,这条线不变。

export interface StorageDir {
  /** 不存在返回 null,**不抛**。 */
  read(path: string): Promise<string | null>;
  write(path: string, content: string): Promise<void>;
  /** 删掉了 true,本来就没有 false。 */
  remove(path: string): Promise<boolean>;
  /** prefix 下全部文件的相对路径(递归,/ 分隔)。prefix "" = 全部。 */
  list(prefix: string): Promise<string[]>;
  close?(): Promise<void>;
}
