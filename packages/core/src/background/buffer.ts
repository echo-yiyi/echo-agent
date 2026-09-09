// 后台任务的有界输出缓冲。**属于 background 自己**——它不是通用资产，
// 别的模块一个都没用过（2026-08-05 从原 store.ts 搬出来）。

/**
 * 有界输出缓冲：绝对游标（UTF-16 code unit 计）+ 驱逐标记。
 * 「绝对」是关键——驱逐之后旧游标仍然可比，读的人拿到 `…[dropped N chars]…` + 真正的新内容，
 * 而不是静默少一段。驱逐按字符切、不按整块：**最近 `max` 个字符永远留着**（review 2026-09-07：
 * 此前整块 shift，一个大 chunk 进来会把整段输出丢光、留 0 个字符）。
 */
export class OutputBuffer {
  private chunks: string[] = [];
  private total = 0;
  private dropped = 0;
  private cursor = 0;

  constructor(private readonly max: number) {}

  write(chunk: string): void {
    this.chunks.push(chunk);
    this.total += chunk.length;
    let excess = this.total - this.dropped - this.max;
    while (excess > 0) {
      const head = this.chunks[0];
      if (head === undefined) break;
      if (head.length <= excess) {
        this.chunks.shift();
        this.dropped += head.length;
        excess -= head.length;
      } else {
        this.chunks[0] = head.slice(excess); // 只切队头块的前半，后半留着
        this.dropped += excess;
        excess = 0;
      }
    }
  }

  /** 只看一眼末尾，**不动游标**——读一眼不该消耗掉别人的增量。 */
  tail(maxChars: number): string {
    const buffered = this.chunks.join("");
    return buffered.length <= maxChars ? buffered : buffered.slice(-maxChars);
  }

  readNew(): string {
    const buffered = this.chunks.join("");
    if (this.cursor >= this.total) return "";
    const lost = Math.max(0, this.dropped - this.cursor);
    const from = Math.max(0, this.cursor - this.dropped);
    const out = buffered.slice(from);
    this.cursor = this.total;
    return lost > 0 ? `…[dropped ${lost} chars]…${out}` : out;
  }
}
