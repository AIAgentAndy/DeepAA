import {createReadStream, createWriteStream, openSync, type ReadStream, type WriteStream} from "node:fs";
import {mkdir, rm} from "node:fs/promises";
import {join} from "node:path";
import {PassThrough, Readable, type ReadableOptions} from "node:stream";

/**
 * 故障转移请求体重放缓冲（有界 tee）。
 *
 * 仅当主模型配置了备份链时启用：请求体在流向首个上游的同时被被动复制，
 * 失败换候选重试时从缓冲重建完整请求体。设计约束（大数据红线）：
 * - 内存上限 `memoryLimitBytes`（默认 8 MiB）；超出后整段序列溢写 `tempDir` 临时文件
 *   （文件内容 = 从 0 开始的完整字节序列），小请求全程不触盘；
 * - 单请求硬上限 `maxBytes`（默认 64 MiB）、待写字节预算 `pendingLimitBytes`
 *   （默认 4 MiB）：任一超出即标记 overflowed——重试需要完整请求体，
 *   此时放弃后续重试能力，当前请求按现状继续，绝不阻塞客户端上传；
 * - 每个读者独立消费（先内存后文件），读者之间互不影响；
 * - `release()` 提前释放（删除临时文件、清空内存），请求收尾时必须调用。
 *
 * 缓冲侧任何异常都只降级为「放弃重试」，绝不抛错阻断正常转发。
 */

const DEFAULT_MEMORY_LIMIT_BYTES = 8 * 1024 * 1024;
// 待写预算必须大于内存上限：内存段搬移文件是顺序追加写，回调释放存在滞后，
// 预算 < 内存上限会让 >8 MiB 的请求在搬移瞬间必然触发溢出（P0 修复，2026-09-13）。
const DEFAULT_PENDING_LIMIT_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;

export interface ReplayBodyStoreOptions {
  tempDir: string;
  memoryLimitBytes?: number;
  pendingLimitBytes?: number;
  maxBytes?: number;
}

const IDLE_WAIT_MS = 1;

export class ReplayBodyStore {
  private readonly memoryLimitBytes: number;
  private readonly pendingLimitBytes: number;
  private readonly maxBytes: number;
  readonly tempFilePath: string;
  private readonly progressWaiters: Array<() => void> = [];
  private memoryChunks: Buffer[] = [];
  private memoryBytes = 0;
  private fileStream?: WriteStream;
  private pendingWriteBytes = 0;
  /** 已交付给文件流的字节数（顺序追加，等于文件逻辑长度下界）。 */
  private fileBytesWritten = 0;
  private totalBytes = 0;
  private ended = false;
  private failed = false;
  /** true 表示缓冲不完整，不再允许创建新读者（后续重试被放弃）。 */
  private overflowed = false;
  private released = false;

  private constructor(options: ReplayBodyStoreOptions) {
    this.memoryLimitBytes = options.memoryLimitBytes ?? DEFAULT_MEMORY_LIMIT_BYTES;
    this.pendingLimitBytes = options.pendingLimitBytes ?? DEFAULT_PENDING_LIMIT_BYTES;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.tempFilePath = join(
      options.tempDir,
      `failover-replay-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.body`,
    );
  }

  /** 预创建临时目录，保证写入路径全同步、无切换竞态。 */
  static async create(options: ReplayBodyStoreOptions): Promise<ReplayBodyStore> {
    try {
      await mkdir(options.tempDir, {recursive: true});
    } catch {
      // 目录不可用时仍返回实例：首次溢写会触发 overflow 降级。
    }
    return new ReplayBodyStore(options);
  }

  /** 请求体总字节数（含溢出后未缓冲的部分）。 */
  get totalBytesValue(): number {
    return this.totalBytes;
  }

  /** 是否可以为「新尝试」重建完整请求体；对已在读取中的读者没有影响。 */
  get canReplay(): boolean {
    return !this.overflowed && !this.released;
  }

  /** 追加一个请求体 chunk。 */
  write(chunk: Buffer): void {
    if (this.ended || this.released) return;
    const data = Buffer.from(chunk);
    this.totalBytes += data.length;
    if (this.overflowed) return;
    if (this.totalBytes > this.maxBytes) {
      this.markOverflowed();
      return;
    }
    if (this.fileStream) {
      this.enqueueToFile(data);
      return;
    }
    if (this.memoryBytes + data.length <= this.memoryLimitBytes) {
      this.memoryChunks.push(data);
      this.memoryBytes += data.length;
      this.notifyProgress();
      return;
    }
    this.transitionToFile();
    this.enqueueToFile(data);
  }

  /** 请求体正常结束。 */
  end(): void {
    if (this.ended) return;
    this.ended = true;
    this.fileStream?.end();
    this.notifyProgress();
  }

  /** 上游/客户端侧异常终止：读者以错误收尾。 */
  abort(): void {
    this.failed = true;
    this.end();
  }

  /**
   * 为一次尝试创建读取器：先吐出内存段，再顺序读取文件段，最后跟随实时流。
   * 仅在 `canReplay` 时可调用；每个读者独立消费，互不影响。
   */
  createReader(options?: ReadableOptions): Readable | undefined {
    if (!this.canReplay) return undefined;
    const store = this;
    let memoryIndex = 0;
    let fileReader: ReadStream | undefined;
    let fileBytesConsumed = 0;
    let pumping = false;
    let closed = false;
    const cleanup = (): void => {
      if (closed) return;
      closed = true;
      fileReader?.destroy();
    };
    const source = new Readable({
      ...options,
      read() {
        void pump();
      },
      destroy(error, callback) {
        cleanup();
        callback(error);
      },
    });
    const sleep = (): Promise<void> => new Promise(resolve => { setTimeout(resolve, IDLE_WAIT_MS).unref(); });
    const pump = async (): Promise<void> => {
      if (pumping || closed) return;
      pumping = true;
      try {
        while (!closed) {
          if (memoryIndex < store.memoryChunks.length) {
            const chunk = store.memoryChunks[memoryIndex]!;
            memoryIndex += 1;
            if (!source.push(chunk)) return;
            continue;
          }
          // 文件段长度 = 总写入 - 内存段；读者从内存段末尾（文件偏移 memoryBytes）开始消费。
          const remainingInFile = store.fileBytesWritten - store.memoryBytes - fileBytesConsumed;
          if (remainingInFile > 0) {
            if (!fileReader) {
              try {
                fileReader = createReadStream(store.tempFilePath, {start: store.memoryBytes + fileBytesConsumed});
                fileReader.once("error", error => {
                  source.destroy(error instanceof Error ? error : new Error("REPLAY_FILE_READ_FAILED"));
                });
              } catch (error) {
                source.destroy(error instanceof Error ? error : new Error("REPLAY_FILE_READ_FAILED"));
                return;
              }
            }
            const chunk = fileReader.read(Math.min(256 * 1024, remainingInFile));
            if (chunk) {
              const data = chunk as Buffer;
              fileBytesConsumed += data.length;
              if (!source.push(data)) return;
              continue;
            }
            // fs 读流不跟随文件增长：写回调刷盘慢时（Windows 尤甚）读流会在逻辑
            // 长度内命中中间 EOF 并永久结束（read() 恒 null），从已消费偏移重开读流继续追。
            if (fileReader.readableEnded) {
              fileReader.destroy();
              fileReader = undefined;
              continue;
            }
            // 写流尚未把字节刷到磁盘：短暂让步后重试（写入是持续刷盘的，窗口极小）。
            await sleep();
            continue;
          }
          if (store.ended) {
            if (store.failed) {
              source.destroy(new Error("REPLAY_SOURCE_ABORTED"));
              return;
            }
            source.push(null);
            return;
          }
          if (store.overflowed) {
            // 溢出后不再有新字节进入缓冲：活动读者立即以错误终止（上游尝试随即
            // 失败并走换候选/提交路径），绝不让读者无限等待。
            source.destroy(new Error("REPLAY_OVERFLOW"));
            return;
          }
          await store.waitProgress();
        }
      } finally {
        pumping = false;
      }
    };
    return source;
  }

  /** 释放缓冲：删除临时文件并清空内存；此后不可再创建读者。请求收尾时必须调用。 */
  async release(): Promise<void> {
    this.released = true;
    this.memoryChunks = [];
    this.memoryBytes = 0;
    this.fileStream?.destroy();
    this.fileStream = undefined;
    await rm(this.tempFilePath, {force: true}).catch(() => undefined);
  }

  /** 内存段装满：把已有内存内容依序写入文件，此后全部内容走文件（文件含从 0 开始的完整序列）。 */
  private transitionToFile(): void {
    try {
      // 同步创建文件：保证读者的 ReadStream 打开时文件一定已存在（消除打开竞态）。
      const fd = openSync(this.tempFilePath, "wx", 0o600);
      this.fileStream = createWriteStream(this.tempFilePath, {fd});
      for (const buffered of this.memoryChunks) this.enqueueToFile(buffered);
    } catch {
      this.markOverflowed();
    }
  }

  private enqueueToFile(data: Buffer): void {
    if (!this.fileStream) {
      this.markOverflowed();
      return;
    }
    if (this.pendingWriteBytes + data.length > this.pendingLimitBytes) {
      this.markOverflowed();
      return;
    }
    this.pendingWriteBytes += data.length;
    this.fileBytesWritten += data.length;
    this.fileStream.write(data, error => {
      this.pendingWriteBytes = Math.max(0, this.pendingWriteBytes - data.length);
      if (error) this.markOverflowed();
    });
  }

  private markOverflowed(): void {
    if (this.overflowed) return;
    this.overflowed = true;
    // 保留已写文件：活动读者仍可继续读取已缓冲前缀；最终由 release() 统一删除。
    this.fileStream?.destroy();
    this.fileStream = undefined;
    // 唤醒等待中的读者：它们会看到 overflowed 并以 REPLAY_OVERFLOW 终止。
    this.notifyProgress();
  }

  /** 流已结束且无待写字节时尽早删除临时文件（内容仍在内存段或已无读者需要）。 */
  private async releaseIfIdle(): Promise<void> {
    if (this.ended && this.pendingWriteBytes === 0 && !this.overflowed && !this.released) {
      await rm(this.tempFilePath, {force: true}).catch(() => undefined);
    }
  }

  /** 流结束后无新内容的进度通知；等待中的读者被唤醒后重新检查缓冲与结束状态。 */
  private async waitProgress(): Promise<void> {
    if (this.ended) return;
    await new Promise<void>(resolve => { this.progressWaiters.push(resolve); });
  }

  private notifyProgress(): void {
    while (this.progressWaiters.length > 0) {
      this.progressWaiters.shift()!();
    }
  }
}

/**
 * 把请求体源流接入重放缓冲；返回的透传流保持原流的实时语义与背压，
 * 供首个尝试直接消费。源流异常时标记缓冲失败并向下传递错误。
 */
export function teeIntoReplayStore(source: NodeJS.ReadableStream, store: ReplayBodyStore): NodeJS.ReadableStream {
  const passthrough = new PassThrough();
  source.on("data", (chunk: Buffer) => {
    store.write(chunk);
    if (!passthrough.write(chunk)) {
      source.pause();
      passthrough.once("drain", () => source.resume());
    }
  });
  source.once("end", () => {
    store.end();
    passthrough.end();
  });
  source.once("error", error => {
    store.abort();
    passthrough.destroy(error);
  });
  return passthrough;
}
