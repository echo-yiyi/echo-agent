// 后台任务的有界输出缓冲。**属于 background 自己**——它不是通用资产，
// 别的模块一个都没用过（2026-08-05 从原 store.ts 搬出来）。

/**
 * 有界输出缓冲：绝对码点游标 + 驱逐标记。
 * 「绝对」是关键——驱逐之后旧游标仍然可比，读的人拿到 `…[dropped N chars]…` + 真正的新内容，
 * 而不是静默少一段。
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
    while (this.total - this.dropped > this.max) {
      const head = this.chunks.shift();
      if (head === undefined) break;
      this.dropped += head.length;
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
