import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { gzipSync, gunzipSync } from "node:zlib";
import {
  lstat,
  mkdir,
  open,
  realpath,
  writeFile,
  type FileHandle,
} from "fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "path";
import type { RawBodyPolicy, RawBodyReference } from "./types";
import { DEFAULT_RAW_BODY_POLICY } from "./types";

export interface ReadRawBodyTextOptions {
  maxBytes?: number;
  label?: "request" | "response";
  externalFileOpener?: (path: string, flags: number) => Promise<FileHandle>;
}

const RAW_BODY_HARD_MAX_BYTES = 8 * 1024 * 1024;
const RAW_BODY_READ_CHUNK_BYTES = 64 * 1024;

/** 仅标识引用边界或内容完整性错误；底层文件系统错误必须保留原始 code。 */
export class UnsafeRawBodyReferenceError extends Error {
  readonly code = "unsafe_raw_body_reference";

  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "UnsafeRawBodyReferenceError";
  }
}

/**
 * 代理层原始 body 存储：三级策略，防止大 body 全量驻留内存导致 OOM。
 * - ≤ inlineThresholdBytes：内联原文字符串（小 body 直接存在 exchange.rawBody）
 * - ≤ compressedInlineThresholdBytes：gzip 压缩后 base64 内联（中 body 不落地外文件）
 * - 超过阈值：写入 external-blob 磁盘文件（gzip 压缩），exchange 仅保留 externalPath 引用。
 *   代理 store 会在内存中缓存所有已抓取 exchange，若大 body 始终内联会随抓包量线性增长直至 OOM。
 *   external-blob 策略使内存中仅保留路径引用，大 body 只在磁盘 JSONL 和 blob 文件中存在。
 */
export async function storeRawBody(
  dataDir: string,
  rawBody: string,
  policy: RawBodyPolicy = DEFAULT_RAW_BODY_POLICY
): Promise<{ inline?: string; reference: RawBodyReference }> {
  const bytes = Buffer.from(rawBody, "utf-8");
  const sha256 = await sha256Hex(rawBody);

  if (bytes.length <= policy.inlineThresholdBytes) {
    return {
      inline: rawBody,
      reference: {
        storage: "inline",
        encoding: "identity",
        sha256,
        sizeBytes: bytes.length,
      },
    };
  }

  const compressed = gzipSync(bytes);
  if (bytes.length <= policy.compressedInlineThresholdBytes) {
    return {
      reference: {
        storage: "compressed-inline",
        encoding: "gzip",
        sha256,
        sizeBytes: bytes.length,
        compressedSizeBytes: compressed.length,
        inlineBase64: compressed.toString("base64"),
      },
    };
  }

  const externalPath = join("blobs", sha256.slice(0, 2), `${sha256}.body.gz`);
  const absolutePath = join(dataDir, externalPath);
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, compressed);
  return {
    reference: {
      storage: "external-blob",
      encoding: "gzip",
      sha256,
      sizeBytes: bytes.length,
      compressedSizeBytes: compressed.length,
      externalPath,
    },
  };
}

/**
 * 读取原始 body 文本：优先用内联 rawBody，其次解压 compressed-inline base64，
 * 最后从 external-blob 磁盘文件读取并 gunzip 解压。
 */
export async function readRawBodyText(dataDir: string, source: {
  rawBody?: string;
  rawBodyRef?: RawBodyReference;
}, options: ReadRawBodyTextOptions = {}): Promise<string> {
  const label = options.label || "request";
  const maxBytes = normalizeOptionalMaxBytes(options.maxBytes);
  assertSourceWithinBudget(source, maxBytes, label);
  const ref = source.rawBodyRef;
  if (typeof source.rawBody === "string") {
    return validateDecodedBody(
      Buffer.from(source.rawBody, "utf-8"),
      ref,
      label,
    );
  }
  if (!ref) return "";
  if (ref.storage === "compressed-inline") {
    if (!ref.inlineBase64) {
      throw new UnsafeRawBodyReferenceError(
        `${label} compressed-inline raw body reference is missing inlineBase64.`,
      );
    }
    const compressedSize = Buffer.byteLength(ref.inlineBase64, "base64");
    assertCompressedInputWithinBudget(compressedSize, maxBytes, label, "inline");
    const compressed = Buffer.from(ref.inlineBase64, "base64");
    assertCompressedSizeMatchesReference(compressed.length, ref, label);
    return validateDecodedBody(
      decodeStoredBody(compressed, ref.encoding, maxBytes, label),
      ref,
      label,
    );
  }
  if (ref.storage === "external-blob") {
    if (!ref.externalPath) {
      throw new UnsafeRawBodyReferenceError(
        `${label} external raw body reference is missing externalPath.`,
      );
    }
    const binding = await resolveExternalBlobBinding(dataDir, ref.externalPath, label);
    const raw = await readExternalBlob(
      binding,
      maxBytes,
      label,
      options.externalFileOpener || open,
    );
    assertCompressedSizeMatchesReference(raw.length, ref, label);
    return validateDecodedBody(
      decodeStoredBody(raw, ref.encoding, maxBytes, label),
      ref,
      label,
    );
  }
  throw new UnsafeRawBodyReferenceError(
    `${label} inline raw body reference is missing rawBody.`,
  );
}

function normalizeOptionalMaxBytes(value: number | undefined): number {
  const maxBytes = value ?? RAW_BODY_HARD_MAX_BYTES;
  if (
    !Number.isSafeInteger(maxBytes)
    || maxBytes < 0
    || maxBytes > RAW_BODY_HARD_MAX_BYTES
  ) {
    throw new UnsafeRawBodyReferenceError(
      `raw body maxBytes must be a non-negative safe integer no greater than ${RAW_BODY_HARD_MAX_BYTES}.`,
    );
  }
  return maxBytes;
}

function assertSourceWithinBudget(
  source: { rawBody?: string; rawBodyRef?: RawBodyReference },
  maxBytes: number,
  label: "request" | "response"
): void {
  if (typeof source.rawBody === "string") {
    const inlineBytes = Buffer.byteLength(source.rawBody);
    if (inlineBytes > maxBytes) {
      throw new UnsafeRawBodyReferenceError(
        `${label} inline raw body size ${inlineBytes} exceeds ${maxBytes}-byte hydration budget.`,
      );
    }
  }
  const ref = source.rawBodyRef;
  if (!ref) return;
  if (!Number.isSafeInteger(ref.sizeBytes) || ref.sizeBytes < 0) {
    throw new UnsafeRawBodyReferenceError(`${label} raw body declared size is invalid.`);
  }
  if (ref.sizeBytes > maxBytes) {
    throw new UnsafeRawBodyReferenceError(
      `${label} raw body declared size ${ref.sizeBytes} exceeds ${maxBytes}-byte hydration budget.`,
    );
  }
  if (ref.compressedSizeBytes !== undefined) {
    if (!Number.isSafeInteger(ref.compressedSizeBytes) || ref.compressedSizeBytes < 0) {
      throw new UnsafeRawBodyReferenceError(
        `${label} raw body declared compressed size is invalid.`,
      );
    }
    if (ref.compressedSizeBytes > maxBytes) {
      throw new UnsafeRawBodyReferenceError(
        `${label} raw body declared compressed size ${ref.compressedSizeBytes} exceeds ${maxBytes}-byte hydration budget.`,
      );
    }
  }
  if (ref.encoding === "gzip" && ref.compressedSizeBytes === undefined) {
    throw new UnsafeRawBodyReferenceError(
      `${label} gzip raw body reference is missing compressedSizeBytes.`,
    );
  }
}

function assertCompressedInputWithinBudget(
  size: number,
  maxBytes: number,
  label: "request" | "response",
  storage: "inline" | "external"
): void {
  if (size > maxBytes) {
    throw new UnsafeRawBodyReferenceError(
      `${label} ${storage} compressed file size ${size} exceeds ${maxBytes}-byte hydration budget.`,
    );
  }
}

function decodeStoredBody(
  raw: Buffer,
  encoding: RawBodyReference["encoding"],
  maxBytes: number,
  label: "request" | "response"
): Buffer {
  if (encoding === "identity") return raw;
  try {
    return gunzipSync(raw, { maxOutputLength: maxBytes });
  } catch (error) {
    if (
      error instanceof Error
      && "code" in error
      && error.code === "ERR_BUFFER_TOO_LARGE"
    ) {
      throw new UnsafeRawBodyReferenceError(
        `${label} raw body decompressed output exceeds ${maxBytes}-byte hydration budget.`,
        error,
      );
    }
    throw new UnsafeRawBodyReferenceError(
      `${label} raw body gzip decompression failed: ${error instanceof Error ? error.message : String(error)}`,
      error,
    );
  }
}

export interface ExternalBlobBinding {
  candidatePath: string;
  realDataDir: string;
  realBlobRoot: string;
  realCandidatePath: string;
  dataDevice: number;
  dataInode: number;
  blobDevice: number;
  blobInode: number;
  device: number;
  inode: number;
}

export async function resolveExternalBlobBinding(
  dataDir: string,
  externalPath: string,
  label: "request" | "response"
): Promise<ExternalBlobBinding> {
  if (isAbsolute(externalPath)) {
    throw new UnsafeRawBodyReferenceError(
      `${label} external raw body path must stay within dataDir/blobs.`,
    );
  }
  const blobRoot = resolve(dataDir, "blobs");
  const candidate = resolve(dataDir, externalPath);
  if (!isStrictDescendant(blobRoot, candidate)) {
    throw new UnsafeRawBodyReferenceError(
      `${label} external raw body path must stay within dataDir/blobs.`,
    );
  }
  const [realDataDir, realBlobRoot, realCandidate, candidateInfo] = await Promise.all([
    realpath(dataDir),
    realpath(blobRoot),
    realpath(candidate),
    lstat(candidate),
  ]);
  if (realBlobRoot !== resolve(realDataDir, "blobs")) {
    throw new UnsafeRawBodyReferenceError(
      `${label} external raw body root must stay within real dataDir/blobs.`,
    );
  }
  if (!isStrictDescendant(realBlobRoot, realCandidate)) {
    throw new UnsafeRawBodyReferenceError(
      `${label} external raw body path must stay within dataDir/blobs.`,
    );
  }
  if (!candidateInfo.isFile()) {
    throw new UnsafeRawBodyReferenceError(
      `${label} external raw body path is not a regular file.`,
    );
  }
  const [dataInfo, blobInfo] = await Promise.all([
    lstat(realDataDir),
    lstat(realBlobRoot),
  ]);
  if (!dataInfo.isDirectory() || !blobInfo.isDirectory()) {
    throw new UnsafeRawBodyReferenceError(
      `${label} external raw body root is not a stable directory.`,
    );
  }
  return {
    candidatePath: candidate,
    realDataDir,
    realBlobRoot,
    realCandidatePath: realCandidate,
    dataDevice: dataInfo.dev,
    dataInode: dataInfo.ino,
    blobDevice: blobInfo.dev,
    blobInode: blobInfo.ino,
    device: candidateInfo.dev,
    inode: candidateInfo.ino,
  };
}

async function readExternalBlob(
  binding: ExternalBlobBinding,
  maxBytes: number,
  label: "request" | "response",
  opener: (path: string, flags: number) => Promise<FileHandle>,
): Promise<Buffer> {
  const handle = await opener(
    binding.candidatePath,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const handleInfo = await handle.stat();
    const [
      currentInfo,
      realDataDir,
      realBlobRoot,
      realCandidatePath,
      dataInfo,
      blobInfo,
    ] =
      await Promise.all([
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
    ) {
      throw new UnsafeRawBodyReferenceError(
        `${label} external raw body changed during secure open.`,
      );
    }
    if (!Number.isSafeInteger(handleInfo.size) || handleInfo.size < 0) {
      throw new UnsafeRawBodyReferenceError(
        `${label} external raw body file size is invalid.`,
      );
    }
    assertCompressedInputWithinBudget(handleInfo.size, maxBytes, label, "external");
    const raw = Buffer.alloc(handleInfo.size);
    let offset = 0;
    while (offset < raw.length) {
      const readLength = Math.min(RAW_BODY_READ_CHUNK_BYTES, raw.length - offset);
      const result = await handle.read(raw, offset, readLength, offset);
      if (result.bytesRead === 0) {
        throw new UnsafeRawBodyReferenceError(
          `${label} external raw body changed during bounded read.`,
        );
      }
      offset += result.bytesRead;
    }
    const finalInfo = await handle.stat();
    if (
      finalInfo.dev !== handleInfo.dev
      || finalInfo.ino !== handleInfo.ino
      || finalInfo.size !== handleInfo.size
    ) {
      throw new UnsafeRawBodyReferenceError(
        `${label} external raw body changed during bounded read.`,
      );
    }
    return raw;
  } finally {
    await handle.close();
  }
}

function assertCompressedSizeMatchesReference(
  actualSize: number,
  ref: RawBodyReference,
  label: "request" | "response",
): void {
  if (
    ref.compressedSizeBytes !== undefined
    && actualSize !== ref.compressedSizeBytes
  ) {
    throw new UnsafeRawBodyReferenceError(
      `${label} raw body compressed size does not match its reference.`,
    );
  }
}

function validateDecodedBody(
  body: Buffer,
  ref: RawBodyReference | undefined,
  label: "request" | "response",
): string {
  if (ref && body.length !== ref.sizeBytes) {
    throw new UnsafeRawBodyReferenceError(
      `${label} raw body size does not match its reference.`,
    );
  }
  if (ref) {
    const digest = createHash("sha256").update(body).digest("hex");
    if (digest !== ref.sha256.toLowerCase()) {
      throw new UnsafeRawBodyReferenceError(
        `${label} raw body SHA-256 does not match its reference.`,
      );
    }
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch (error) {
    throw new UnsafeRawBodyReferenceError(
      `${label} raw body is not valid UTF-8.`,
      error,
    );
  }
  if (!Buffer.from(text, "utf-8").equals(body)) {
    throw new UnsafeRawBodyReferenceError(
      `${label} raw body is not valid UTF-8.`,
    );
  }
  return text;
}

function isStrictDescendant(parent: string, candidate: string): boolean {
  const child = relative(parent, candidate);
  return child !== "" && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map(byte => byte.toString(16).padStart(2, "0"))
    .join("");
}
