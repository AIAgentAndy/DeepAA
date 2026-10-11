import {createHash, randomUUID} from "node:crypto";
import {createReadStream, createWriteStream, type WriteStream} from "node:fs";
import {mkdir, readFile, rename, rm, stat} from "node:fs/promises";
import {dirname, join} from "node:path";
import {pipeline} from "node:stream/promises";
import {TextDecoder} from "node:util";
import {createGzip} from "node:zlib";
import type {CollectedRawBody, RawBodyReference} from "./raw-v2-contract.js";

export interface RawBodyPolicy {
  inlineThresholdBytes: number;
  compressedInlineThresholdBytes: number;
}

const DEFAULT_POLICY: RawBodyPolicy = {
  inlineThresholdBytes: 256 * 1024,
  compressedInlineThresholdBytes: 2 * 1024 * 1024,
};
const DEFAULT_PENDING_BYTES = 64 * 1024 * 1024;
const DEFAULT_COLLECTOR_PENDING_BYTES = 4 * 1024 * 1024;
const DEFAULT_FINALIZERS = 2;
const DEFAULT_QUEUED_FINALIZERS = 64;
const PREVIEW_BYTES = 64 * 1024;

export class CaptureBudget {
  readonly maxPendingBytes: number;
  readonly maxConcurrentFinalizers: number;
  readonly maxQueuedFinalizers: number;
  pendingBytes = 0;
  activeFinalizers = 0;
  peakActiveFinalizers = 0;
  private readonly finalizerWaiters: Array<() => void> = [];

  constructor(options: {
    maxPendingBytes?: number;
    maxConcurrentFinalizers?: number;
    maxQueuedFinalizers?: number;
  } = {}) {
    this.maxPendingBytes = options.maxPendingBytes ?? DEFAULT_PENDING_BYTES;
    this.maxConcurrentFinalizers = options.maxConcurrentFinalizers ?? DEFAULT_FINALIZERS;
    this.maxQueuedFinalizers = options.maxQueuedFinalizers ?? DEFAULT_QUEUED_FINALIZERS;
  }

  get queuedFinalizers(): number { return this.finalizerWaiters.length; }

  reserve(bytes: number): boolean {
    if (bytes < 0 || this.pendingBytes + bytes > this.maxPendingBytes) return false;
    this.pendingBytes += bytes;
    return true;
  }

  release(bytes: number): void {
    this.pendingBytes = Math.max(0, this.pendingBytes - bytes);
  }

  async runFinalizer<T>(operation: () => Promise<T>): Promise<T> {
    if (this.activeFinalizers >= this.maxConcurrentFinalizers) {
      if (this.finalizerWaiters.length >= this.maxQueuedFinalizers) {
        throw new Error("FINALIZER_QUEUE_FULL");
      }
      await new Promise<void>(resolve => this.finalizerWaiters.push(resolve));
    }
    this.activeFinalizers += 1;
    this.peakActiveFinalizers = Math.max(this.peakActiveFinalizers, this.activeFinalizers);
    try {
      return await operation();
    } finally {
      this.activeFinalizers -= 1;
      this.finalizerWaiters.shift()?.();
    }
  }
}

interface RawBodyCollectorOptions {
  dataDir: string;
  policy?: Partial<RawBodyPolicy>;
  budget?: CaptureBudget;
  directoryReady?: boolean;
}

export class RawBodyCollector {
  private readonly dataDir: string;
  private readonly policy: RawBodyPolicy;
  private readonly budget: CaptureBudget;
  private readonly decoder = new TextDecoder("utf-8", {fatal: false});
  private readonly hash = createHash("sha256");
  private readonly temporaryDirectory: string;
  private readonly rawTemporaryPath: string;
  private readonly gzipTemporaryPath: string;
  private readonly inlineChunks: Buffer[] = [];
  private readonly previewChunks: Buffer[] = [];
  private previewSize = 0;
  private bodySize = 0;
  private pendingWriteBytes = 0;
  private stream?: WriteStream;
  private streamCompletion?: Promise<void>;
  private completeStream?: () => void;
  private degraded = false;
  private finished = false;
  private finishPromise?: Promise<CollectedRawBody>;
  /** finish 后到达被丢弃的尾块字节数（诊断/测试用）。 */
  droppedAfterFinishBytes = 0;

  private constructor(options: RawBodyCollectorOptions) {
    this.dataDir = options.dataDir;
    this.policy = {...DEFAULT_POLICY, ...options.policy};
    this.budget = options.budget ?? new CaptureBudget();
    this.temporaryDirectory = join(this.dataDir, "blobs", ".tmp");
    const instanceId = `${process.pid}-${randomUUID()}`;
    this.rawTemporaryPath = join(this.temporaryDirectory, `${instanceId}.body`);
    this.gzipTemporaryPath = join(this.temporaryDirectory, `${instanceId}.body.gz`);
    if (options.directoryReady === false) this.degraded = true;
  }

  static async create(options: RawBodyCollectorOptions): Promise<RawBodyCollector> {
    const collector = new RawBodyCollector(options);
    if (options.directoryReady !== undefined) return collector;
    try {
      await mkdir(collector.temporaryDirectory, {recursive: true});
    } catch {
      collector.degraded = true;
    }
    return collector;
  }

  /**
   * finish 后到达的尾块只能丢弃：捕获结果已按 finish 前数据定稿（哈希已取），
   * 事后追加无法改写已返回的定稿；且调用方处于流事件回调（reverse-proxy 的
   * data 监听器），此处抛错会以未捕获异常杀死整个代理进程——2026-10-11
   * Windows 实证：上游流被中途销毁（连接错误/空闲超时）后解码器/套接字缓冲
   * 尾块在 finish() 之后到达，抛错导致 20 连败重试期间进程崩溃、3211 死亡。
   */
  capture(chunk: Uint8Array): void {
    if (this.finished) {
      this.droppedAfterFinishBytes += chunk.byteLength;
      return;
    }
    if (chunk.byteLength === 0) return;
    const decoded = this.decoder.decode(chunk, {stream: true});
    if (decoded) this.captureLogical(Buffer.from(decoded, "utf8"));
  }

  previewText(): string {
    return Buffer.concat(this.previewChunks, this.previewSize).toString("utf8");
  }

  finish(): Promise<CollectedRawBody> {
    this.finishPromise ??= this.finishOnce();
    return this.finishPromise;
  }

  private captureLogical(logical: Buffer): void {
    this.bodySize += logical.length;
    this.hash.update(logical);
    if (this.previewSize < PREVIEW_BYTES) {
      const preview = logical.subarray(0, PREVIEW_BYTES - this.previewSize);
      this.previewChunks.push(preview);
      this.previewSize += preview.length;
    }
    if (this.degraded) return;
    const inlineSize = this.inlineChunks.reduce((sum, item) => sum + item.length, 0);
    if (!this.stream && inlineSize + logical.length <= this.policy.inlineThresholdBytes) {
      this.inlineChunks.push(logical);
      return;
    }
    if (!this.stream) {
      this.openTemporaryStream();
      for (const buffered of this.inlineChunks.splice(0)) this.enqueue(buffered);
    }
    this.enqueue(logical);
  }

  private openTemporaryStream(): void {
    if (this.degraded) return;
    this.stream = createWriteStream(this.rawTemporaryPath, {flags: "wx", mode: 0o600});
    this.streamCompletion = new Promise<void>(resolve => {
      this.completeStream = resolve;
      this.stream!.once("finish", resolve);
      this.stream!.once("close", resolve);
      this.stream!.once("error", () => {
        this.degraded = true;
        resolve();
      });
    });
  }

  private enqueue(buffer: Buffer): void {
    if (this.degraded || !this.stream) return;
    if (this.pendingWriteBytes + buffer.length > DEFAULT_COLLECTOR_PENDING_BYTES
      || !this.budget.reserve(buffer.length)) {
      this.degraded = true;
      this.stream.destroy();
      return;
    }
    this.pendingWriteBytes += buffer.length;
    this.stream.write(buffer, error => {
      this.pendingWriteBytes = Math.max(0, this.pendingWriteBytes - buffer.length);
      this.budget.release(buffer.length);
      if (error) this.degraded = true;
    });
  }

  private async finishOnce(): Promise<CollectedRawBody> {
    this.finished = true;
    const trailing = this.decoder.decode();
    if (trailing) this.captureLogicalAfterFinish(Buffer.from(trailing, "utf8"));
    const bodySha256 = this.hash.digest("hex");
    if (!this.stream && !this.degraded) {
      const raw = Buffer.concat(this.inlineChunks, this.bodySize);
      const rawBody = raw.toString("utf8");
      return {
        rawBody,
        rawBodyRef: {
          storage: "inline",
          encoding: "identity",
          sha256: bodySha256,
          sizeBytes: this.bodySize,
        },
        bodySizeBytes: this.bodySize,
        bodySha256,
        missing: false,
      };
    }
    this.stream?.end();
    await this.streamCompletion;
    if (this.degraded) return await this.missingResult(bodySha256);
    try {
      const rawBodyRef = await this.budget.runFinalizer(() => this.finalizeStoredBody(bodySha256));
      return {
        rawBodyRef,
        bodySizeBytes: this.bodySize,
        bodySha256,
        missing: false,
      };
    } catch {
      return await this.missingResult(bodySha256);
    } finally {
      await rm(this.rawTemporaryPath, {force: true}).catch(() => undefined);
      await rm(this.gzipTemporaryPath, {force: true}).catch(() => undefined);
    }
  }

  private captureLogicalAfterFinish(logical: Buffer): void {
    this.bodySize += logical.length;
    this.hash.update(logical);
    if (this.previewSize < PREVIEW_BYTES) {
      const preview = logical.subarray(0, PREVIEW_BYTES - this.previewSize);
      this.previewChunks.push(preview);
      this.previewSize += preview.length;
    }
    if (this.degraded) return;
    if (!this.stream) {
      const inlineSize = this.inlineChunks.reduce((sum, item) => sum + item.length, 0);
      if (inlineSize + logical.length <= this.policy.inlineThresholdBytes) {
        this.inlineChunks.push(logical);
        return;
      }
      this.openTemporaryStream();
      for (const buffered of this.inlineChunks.splice(0)) this.enqueue(buffered);
    }
    this.enqueue(logical);
  }

  private async finalizeStoredBody(bodySha256: string): Promise<RawBodyReference> {
    await pipeline(
      createReadStream(this.rawTemporaryPath),
      createGzip(),
      createWriteStream(this.gzipTemporaryPath, {flags: "wx", mode: 0o600}),
    );
    const compressedSizeBytes = (await stat(this.gzipTemporaryPath)).size;
    if (this.bodySize <= this.policy.compressedInlineThresholdBytes) {
      const compressed = await readFile(this.gzipTemporaryPath);
      return {
        storage: "compressed-inline",
        encoding: "gzip",
        sha256: bodySha256,
        sizeBytes: this.bodySize,
        compressedSizeBytes,
        inlineBase64: compressed.toString("base64"),
      };
    }
    const externalPath = join("blobs", bodySha256.slice(0, 2), `${bodySha256}.body.gz`);
    const absolutePath = join(this.dataDir, externalPath);
    await mkdir(dirname(absolutePath), {recursive: true});
    try {
      const existing = await stat(absolutePath);
      if (!existing.isFile() || existing.size !== compressedSizeBytes) {
        throw new Error("Existing raw blob does not match the completed capture");
      }
      await rm(this.gzipTemporaryPath, {force: true});
    } catch (error) {
      if (!isFileNotFound(error)) throw error;
      await rename(this.gzipTemporaryPath, absolutePath);
    }
    return {
      storage: "external-blob",
      encoding: "gzip",
      sha256: bodySha256,
      sizeBytes: this.bodySize,
      compressedSizeBytes,
      externalPath,
    };
  }

  private async missingResult(bodySha256: string): Promise<CollectedRawBody> {
    this.completeStream?.();
    await rm(this.rawTemporaryPath, {force: true}).catch(() => undefined);
    await rm(this.gzipTemporaryPath, {force: true}).catch(() => undefined);
    return {
      bodySizeBytes: this.bodySize,
      bodySha256,
      missing: true,
    };
  }
}

function isFileNotFound(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as {code?: unknown}).code === "ENOENT";
}
