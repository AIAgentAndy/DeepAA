import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { createGunzip } from "node:zlib";
import {
  resolveExternalBlobBinding,
  type ExternalBlobBinding,
} from "./raw-body";
import type { RawBodyReference } from "./types";

const RAW_BODY_CHUNK_BYTES = 64 * 1024;
const DEFAULT_PROJECTION_MAX_BYTES = 256 * 1024 * 1024;

export type RawBodyStreamErrorCode =
  | "raw_body_unavailable"
  | "raw_body_integrity_failed"
  | "unsafe_raw_reference";

export class RawBodyStreamError extends Error {
  constructor(
    readonly code: RawBodyStreamErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "RawBodyStreamError";
  }
}

export interface RawBodyStreamSource {
  rawBody?: string;
  rawBodyRef?: RawBodyReference;
  bodySizeBytes?: number;
  bodySha256?: string;
}

export interface OpenRawBodyStreamOptions {
  purpose: "projection" | "raw";
  label: "request" | "response";
  maxDecodedBytes?: number;
}

export type RawBodyStreamVerification =
  | { status: "verified"; decodedBytes: number; sha256: string }
  | { status: "not_verified_budget"; decodedBytes: number; sha256?: never }
  | { status: "failed"; decodedBytes: number; errorCode: RawBodyStreamErrorCode };

export interface RawBodyStreamResult {
  stream: Readable;
  expectedSizeBytes: number;
  expectedSha256: string;
  verification: Promise<RawBodyStreamVerification>;
}

interface OpenedSource {
  readable: Readable;
  compressedSize?: number;
  close: () => Promise<void>;
  assertUnchanged: () => Promise<void>;
}

/**
 * 正文流只保留固定 chunk、增量 hash 和少量解压状态。完整 Raw 与 Worker 投影
 * 共用同一安全打开逻辑，但预算策略必须由调用方明确选择。
 */
export async function openRawBodyStream(
  dataDir: string,
  source: RawBodyStreamSource,
  options: OpenRawBodyStreamOptions,
): Promise<RawBodyStreamResult> {
  const expected = expectedIdentity(source, options.label);
  const maxDecodedBytes = projectionBudget(options);
  const opened = await openStoredSource(dataDir, source, options.label);
  if (
    source.rawBodyRef?.compressedSizeBytes !== undefined
    && opened.compressedSize !== source.rawBodyRef.compressedSizeBytes
  ) {
    await opened.close();
    throw integrityError(options.label, "压缩字节数与 Raw 引用不一致。");
  }
  const decoded = source.rawBodyRef?.encoding === "gzip"
    ? opened.readable.pipe(createGunzip({ chunkSize: RAW_BODY_CHUNK_BYTES }))
    : opened.readable;
  const verification = deferredVerification();
  const output = Readable.from(projectValidatedChunks({
    decoded,
    opened,
    expectedSizeBytes: expected.sizeBytes,
    expectedSha256: expected.sha256,
    maxDecodedBytes,
    purpose: options.purpose,
    label: options.label,
    complete: verification.resolve,
  }), { highWaterMark: RAW_BODY_CHUNK_BYTES });
  return {
    stream: output,
    expectedSizeBytes: expected.sizeBytes,
    expectedSha256: expected.sha256,
    verification: verification.promise,
  };
}

async function* projectValidatedChunks(input: {
  decoded: Readable;
  opened: OpenedSource;
  expectedSizeBytes: number;
  expectedSha256: string;
  maxDecodedBytes: number;
  purpose: "projection" | "raw";
  label: "request" | "response";
  complete: (value: RawBodyStreamVerification) => void;
}): AsyncGenerator<Buffer> {
  const hash = createHash("sha256");
  let decodedBytes = 0;
  let finished = false;
  try {
    for await (const rawChunk of input.decoded) {
      const chunk = Buffer.from(rawChunk as Uint8Array);
      let offset = 0;
      while (offset < chunk.length) {
        const remainingBudget = input.maxDecodedBytes - decodedBytes;
        if (remainingBudget <= 0) {
          input.complete({ status: "not_verified_budget", decodedBytes });
          finished = true;
          return;
        }
        const size = Math.min(
          RAW_BODY_CHUNK_BYTES,
          chunk.length - offset,
          remainingBudget,
        );
        const projected = chunk.subarray(offset, offset + size);
        const nextBytes = decodedBytes + projected.length;
        if (input.purpose === "raw" && nextBytes > input.expectedSizeBytes) {
          throw integrityError(input.label, "解压正文超过 Raw 声明大小。");
        }
        hash.update(projected);
        decodedBytes = nextBytes;
        offset += size;
        yield projected;
      }
    }
    await input.opened.assertUnchanged();
    if (decodedBytes !== input.expectedSizeBytes) {
      throw integrityError(input.label, "正文大小与 Raw 声明不一致。");
    }
    const digest = hash.digest("hex");
    if (digest !== input.expectedSha256) {
      throw integrityError(input.label, "正文 SHA-256 与 Raw 声明不一致。");
    }
    input.complete({ status: "verified", decodedBytes, sha256: digest });
    finished = true;
  } catch (error) {
    const classified = classifyStreamError(error, input.label);
    input.complete({
      status: "failed",
      decodedBytes,
      errorCode: classified.code,
    });
    finished = true;
    throw classified;
  } finally {
    input.decoded.destroy();
    await input.opened.close().catch(() => undefined);
    if (!finished) {
      input.complete({
        status: "failed",
        decodedBytes,
        errorCode: "raw_body_unavailable",
      });
    }
  }
}

async function openStoredSource(
  dataDir: string,
  source: RawBodyStreamSource,
  label: "request" | "response",
): Promise<OpenedSource> {
  const ref = source.rawBodyRef;
  if (typeof source.rawBody === "string") {
    if (ref && ref.storage !== "inline") {
      throw unsafeError(label, "内联正文与 storage 不一致。");
    }
    const buffer = Buffer.from(source.rawBody, "utf8");
    return memorySource(buffer);
  }
  if (!ref) {
    if ((source.bodySizeBytes ?? 0) === 0) return memorySource(Buffer.alloc(0));
    throw new RawBodyStreamError(
      "raw_body_unavailable",
      `${label} Raw 正文不可用。`,
    );
  }
  if (ref.storage === "compressed-inline") {
    if (!ref.inlineBase64) throw unsafeError(label, "压缩内联正文缺少 Base64。 ");
    const compressedSize = base64DecodedSize(ref.inlineBase64);
    return {
      readable: Readable.from(decodeBase64Chunks(ref.inlineBase64)),
      compressedSize,
      close: async () => undefined,
      assertUnchanged: async () => undefined,
    };
  }
  if (ref.storage === "external-blob") {
    if (!ref.externalPath) throw unsafeError(label, "外置正文缺少路径。");
    return openExternalSource(dataDir, ref.externalPath, label);
  }
  throw unsafeError(label, "inline storage 缺少 rawBody。");
}

function memorySource(buffer: Buffer): OpenedSource {
  return {
    readable: Readable.from(chunkBuffer(buffer)),
    compressedSize: buffer.length,
    close: async () => undefined,
    assertUnchanged: async () => undefined,
  };
}

async function openExternalSource(
  dataDir: string,
  externalPath: string,
  label: "request" | "response",
): Promise<OpenedSource> {
  let binding: ExternalBlobBinding;
  try {
    binding = await resolveExternalBlobBinding(dataDir, externalPath, label);
  } catch (error) {
    throw classifyOpenError(error, label);
  }
  let handle: FileHandle;
  try {
    handle = await open(
      binding.candidatePath,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
  } catch (error) {
    throw classifyOpenError(error, label);
  }
  try {
    const size = await assertExternalIdentity(binding, handle, label);
    return {
      readable: handle.createReadStream({
        autoClose: false,
        highWaterMark: RAW_BODY_CHUNK_BYTES,
      }),
      compressedSize: size,
      close: async () => {
        await handle.close().catch(() => undefined);
      },
      assertUnchanged: async () => {
        const finalSize = await assertExternalIdentity(binding, handle, label);
        if (finalSize !== size) {
          throw integrityError(label, "外置正文在读取期间发生大小变化。");
        }
      },
    };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

async function assertExternalIdentity(
  binding: ExternalBlobBinding,
  handle: FileHandle,
  label: "request" | "response",
): Promise<number> {
  const [handleInfo, currentInfo, realDataDir, realBlobRoot, realCandidatePath,
    dataInfo, blobInfo] = await Promise.all([
    handle.stat(),
    lstat(binding.candidatePath),
    realpath(dirname(binding.realBlobRoot)),
    realpath(binding.realBlobRoot),
    realpath(binding.candidatePath),
    lstat(binding.realDataDir),
    lstat(binding.realBlobRoot),
  ]);
  if (
    !handleInfo.isFile()
    || !currentInfo.isFile()
    || realDataDir !== binding.realDataDir
    || realBlobRoot !== binding.realBlobRoot
    || realCandidatePath !== binding.realCandidatePath
    || !isStrictDescendant(realBlobRoot, realCandidatePath)
    || !dataInfo.isDirectory()
    || dataInfo.dev !== binding.dataDevice
    || dataInfo.ino !== binding.dataInode
    || !blobInfo.isDirectory()
    || blobInfo.dev !== binding.blobDevice
    || blobInfo.ino !== binding.blobInode
    || handleInfo.dev !== binding.device
    || handleInfo.ino !== binding.inode
    || currentInfo.dev !== handleInfo.dev
    || currentInfo.ino !== handleInfo.ino
    || !Number.isSafeInteger(handleInfo.size)
    || handleInfo.size < 0
  ) {
    throw unsafeError(label, "外置正文文件身份不安全或发生变化。");
  }
  return handleInfo.size;
}

function expectedIdentity(
  source: RawBodyStreamSource,
  label: "request" | "response",
): { sizeBytes: number; sha256: string } {
  const sizeBytes = source.rawBodyRef?.sizeBytes ?? source.bodySizeBytes;
  const sha256 = (source.rawBodyRef?.sha256 ?? source.bodySha256)?.toLowerCase();
  if (!Number.isSafeInteger(sizeBytes) || (sizeBytes as number) < 0) {
    throw unsafeError(label, "Raw 正文声明大小无效。");
  }
  if (!sha256 || !/^[0-9a-f]{64}$/.test(sha256)) {
    throw unsafeError(label, "Raw 正文 SHA-256 无效。");
  }
  if (
    source.bodySizeBytes !== undefined
    && source.bodySizeBytes !== sizeBytes
  ) {
    throw integrityError(label, "正文元数据与 Raw 引用大小不一致。");
  }
  if (
    source.bodySha256 !== undefined
    && source.bodySha256.toLowerCase() !== sha256
  ) {
    throw integrityError(label, "正文元数据与 Raw 引用 SHA-256 不一致。");
  }
  return { sizeBytes: sizeBytes as number, sha256 };
}

function projectionBudget(options: OpenRawBodyStreamOptions): number {
  if (options.purpose === "raw") return Number.MAX_SAFE_INTEGER;
  const value = options.maxDecodedBytes ?? DEFAULT_PROJECTION_MAX_BYTES;
  if (!Number.isSafeInteger(value) || value < 1 || value > DEFAULT_PROJECTION_MAX_BYTES) {
    throw new RangeError(
      `maxDecodedBytes 必须是 1 到 ${DEFAULT_PROJECTION_MAX_BYTES} 的安全整数。`,
    );
  }
  return value;
}

async function* chunkBuffer(buffer: Buffer): AsyncGenerator<Buffer> {
  for (let offset = 0; offset < buffer.length; offset += RAW_BODY_CHUNK_BYTES) {
    yield buffer.subarray(offset, offset + RAW_BODY_CHUNK_BYTES);
  }
}

async function* decodeBase64Chunks(value: string): AsyncGenerator<Buffer> {
  const encodedChunkBytes = Math.floor(RAW_BODY_CHUNK_BYTES / 4) * 4;
  for (let offset = 0; offset < value.length; offset += encodedChunkBytes) {
    const end = Math.min(value.length, offset + encodedChunkBytes);
    yield Buffer.from(value.slice(offset, end), "base64");
  }
}

function base64DecodedSize(value: string): number {
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new RawBodyStreamError(
      "unsafe_raw_reference",
      "压缩内联正文 Base64 结构无效。",
    );
  }
  return Buffer.byteLength(value, "base64");
}

function deferredVerification(): {
  promise: Promise<RawBodyStreamVerification>;
  resolve: (value: RawBodyStreamVerification) => void;
} {
  let resolvePromise!: (value: RawBodyStreamVerification) => void;
  const promise = new Promise<RawBodyStreamVerification>(resolve => {
    resolvePromise = resolve;
  });
  let completed = false;
  return {
    promise,
    resolve: value => {
      if (completed) return;
      completed = true;
      resolvePromise(value);
    },
  };
}

function classifyOpenError(
  error: unknown,
  label: "request" | "response",
): RawBodyStreamError {
  if (error instanceof RawBodyStreamError) return error;
  if (isNodeError(error) && error.code === "ENOENT") {
    return new RawBodyStreamError(
      "raw_body_unavailable",
      `${label} 外置 Raw 正文暂时不可用。`,
      { cause: error },
    );
  }
  return unsafeError(label, "外置正文无法安全打开。", error);
}

function classifyStreamError(
  error: unknown,
  label: "request" | "response",
): RawBodyStreamError {
  if (error instanceof RawBodyStreamError) return error;
  if (isNodeError(error) && error.code === "Z_DATA_ERROR") {
    return integrityError(label, "gzip 正文损坏。", error);
  }
  return new RawBodyStreamError(
    "raw_body_unavailable",
    `${label} Raw 正文流中断。`,
    { cause: error },
  );
}

function integrityError(
  label: "request" | "response",
  message: string,
  cause?: unknown,
): RawBodyStreamError {
  return new RawBodyStreamError(
    "raw_body_integrity_failed",
    `${label} ${message}`,
    cause === undefined ? undefined : { cause },
  );
}

function unsafeError(
  label: "request" | "response",
  message: string,
  cause?: unknown,
): RawBodyStreamError {
  return new RawBodyStreamError(
    "unsafe_raw_reference",
    `${label} ${message}`,
    cause === undefined ? undefined : { cause },
  );
}

function isStrictDescendant(parent: string, candidate: string): boolean {
  const child = relative(parent, candidate);
  return child !== ""
    && child !== ".."
    && !child.startsWith(`..${sep}`)
    && !isAbsolute(child);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
