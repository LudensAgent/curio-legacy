/**
 * 观测溢出的磁盘 spool。
 *
 * 宿主的内存 handoff 队列有界；放不下的观测不能再按到达顺序丢掉，否则高速移动时
 * 空间记忆会留下整条走廊的缺口。这里把溢出的原始观测按到达顺序追加到世界库旁的
 * JSONL 文件，等驻留/容量允许时按批回放；只有磁盘预算耗尽才丢，并把丢弃条数交回
 * 调用方记成可见缺口。
 *
 * 约束：
 * - `append` 只写内存缓冲，绝不在这里做磁盘 I/O；`flush` 由后台任务串行调用。
 * - 读写用同一把 promise 锁；读取只返回完整行，游标只在成功解析后推进。
 * - 回放顺序就是到达顺序；格级新旧由库的 observedAt 规则裁决，spool 不重排。
 * - 文件只属于当前进程/会话；打开新会话时由调用方清理上一进程的遗留。
 */
import { appendFile, open, rename, rm, writeFile } from 'node:fs/promises';

export class HandoffSpool {
  private buffered: string[] = [];
  private bufferedBytes = 0;
  private writtenBytes = 0;
  private readOffset = 0;
  private lock: Promise<void> = Promise.resolve();

  constructor(readonly path: string, private readonly byteLimit: number) {}

  /** 已落盘 + 未落盘的总字节数（含已回放但尚未压缩的字节）。 */
  get bytes(): number {
    return this.writtenBytes + this.bufferedBytes;
  }

  /** 尚未回放的字节数：未落盘缓冲 + 读游标之后的文件内容。 */
  get unreadBytes(): number {
    return this.bufferedBytes + Math.max(0, this.writtenBytes - this.readOffset);
  }

  /** 没有待回放或待落盘的内容（文件本身可能还没压缩删除）。 */
  get empty(): boolean {
    return this.bufferedBytes === 0 && this.readOffset >= this.writtenBytes;
  }

  /**
   * 追加记录行（每条是完整的一行 JSON，不含换行）。
   * 返回因磁盘预算被丢弃的条数；调用方负责把它记成缺口，不得静默忽略。
   */
  append(lines: readonly string[]): number {
    let dropped = 0;
    for (const line of lines) {
      const bytes = Buffer.byteLength(line, 'utf8') + 1;
      if (this.writtenBytes + this.bufferedBytes + bytes > this.byteLimit) {
        dropped += 1;
        continue;
      }
      this.buffered.push(line);
      this.bufferedBytes += bytes;
    }
    return dropped;
  }

  /** 串行把缓冲写盘；失败时把行放回缓冲并抛出原始错误。 */
  flush(): Promise<void> {
    const run = this.lock.then(async () => {
      if (this.buffered.length === 0) return;
      const lines = this.buffered;
      const bytes = this.bufferedBytes;
      this.buffered = [];
      this.bufferedBytes = 0;
      try {
        await appendFile(this.path, `${lines.join('\n')}\n`, 'utf8');
        this.writtenBytes += bytes;
      } catch (error) {
        this.buffered = [...lines, ...this.buffered];
        this.bufferedBytes += bytes;
        throw error;
      }
    });
    this.lock = run.catch(() => {});
    return run;
  }

  /**
   * 按到达顺序读取至多 maxBytes / maxRecords 的完整行并推进读游标。
   * 先 flush：调用方看到的是“已经决定要留下的全部内容”。
   */
  async readChunk(maxBytes = 1 << 20, maxRecords = Number.POSITIVE_INFINITY): Promise<string[]> {
    await this.flush();
    if (this.readOffset >= this.writtenBytes) return [];
    const handle = await open(this.path, 'r');
    try {
      const length = Math.min(maxBytes, this.writtenBytes - this.readOffset);
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, this.readOffset);
      const text = buffer.subarray(0, bytesRead).toString('utf8');
      const end = text.lastIndexOf('\n');
      if (end < 0) return [];
      const lines = text.slice(0, end).split('\n').filter((line) => line.length > 0);
      const consumedLines = Number.isFinite(maxRecords) ? lines.slice(0, maxRecords) : lines;
      if (consumedLines.length === 0) return [];
      this.readOffset += Buffer.byteLength(`${consumedLines.join('\n')}\n`, 'utf8');
      return consumedLines;
    } finally {
      await handle.close();
    }
  }

  /** 已读部分超过一半时重写未读尾部，回收空间；全部读完则删除文件。 */
  async compact(): Promise<void> {
    await this.flush();
    if (this.readOffset === 0) return;
    if (this.readOffset < this.writtenBytes / 2) return;
    if (this.readOffset >= this.writtenBytes) {
      await this.clear();
      return;
    }
    const handle = await open(this.path, 'r');
    let remaining: Buffer;
    try {
      remaining = Buffer.alloc(this.writtenBytes - this.readOffset);
      await handle.read(remaining, 0, remaining.length, this.readOffset);
    } finally {
      // Windows 不允许替换仍被打开的文件：先关句柄，再改名。
      await handle.close();
    }
    await writeFile(`${this.path}.tmp`, remaining);
    await rename(`${this.path}.tmp`, this.path);
    this.writtenBytes = remaining.length;
    this.readOffset = 0;
  }

  /** 丢弃全部内容（作用域变化或关停）；失败保留原始错误。 */
  async clear(): Promise<void> {
    this.buffered = [];
    this.bufferedBytes = 0;
    this.writtenBytes = 0;
    this.readOffset = 0;
    const run = this.lock.then(() => rm(this.path, { force: true }));
    this.lock = run.catch(() => {});
    await run;
  }
}
