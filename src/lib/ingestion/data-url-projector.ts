import { createHash, type Hash } from "node:crypto";
import type { RawBodyStorage } from "../db/models";
import { boundedUtf8 } from "./content-preview";
import type {
  ExchangeMediaDescriptorDraft,
  ProjectionBodySide,
} from "./projection-types";

const DATA_PREFIX = "data:";
const DATA_URL_HEADER_MAX_CHARS = 256;
const DEFAULT_MEDIA_DESCRIPTOR_LIMIT = 256;
const DECODED_MEDIA_CHUNK_BYTES = 16 * 1024;
const BASE64_CHAR = /^[A-Za-z0-9+/=]$/;
const MEDIA_TYPE = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/;

export interface DataUrlProjectorOptions {
  exchangeId: string;
  bodySide: ProjectionBodySide;
  jsonPath: string;
  rawBodySha256: string;
  sourceStorage: Exclude<RawBodyStorage, "none">;
  ordinal: number;
  maxDescriptors?: number;
  decodedMediaOrdinal?: number;
  onText: (value: string) => void;
  onDescriptor: (descriptor: ExchangeMediaDescriptorDraft) => void;
  onDecodedBytes?: (
    value: Uint8Array,
    media: { ordinal: number; mediaType: string },
  ) => void;
  onDiagnostic?: (code: string) => void;
}

export interface DataUrlProjectionResult {
  candidateCount: number;
  processedCount: number;
  limited: boolean;
}

type ScannerState = "text" | "header" | "base64" | "discard-invalid";

/**
 * 逐字符串 token 过滤 Data URL。Base64 仅以四字符小缓冲参与解码和 hash，
 * 永远不会回传到预览、诊断或其他派生对象。
 */
export class DataUrlProjector {
  private readonly maxDescriptors: number;
  private state: ScannerState = "text";
  private pendingText = "";
  private header = "";
  private active?: Base64Accumulator;
  private candidateCount = 0;
  private processedCount = 0;
  private limited = false;
  private nextOrdinal: number;
  private finished = false;

  constructor(private readonly options: DataUrlProjectorOptions) {
    this.maxDescriptors = options.maxDescriptors ?? DEFAULT_MEDIA_DESCRIPTOR_LIMIT;
    this.nextOrdinal = options.ordinal;
    if (!Number.isSafeInteger(this.nextOrdinal) || this.nextOrdinal < 0) {
      throw new RangeError("媒体 ordinal 必须是非负安全整数。");
    }
    if (!Number.isSafeInteger(this.maxDescriptors) || this.maxDescriptors < 0) {
      throw new RangeError("maxDescriptors 必须是非负安全整数。");
    }
    if (
      options.decodedMediaOrdinal !== undefined
      && (
        !Number.isSafeInteger(options.decodedMediaOrdinal)
        || options.decodedMediaOrdinal < 0
        || options.decodedMediaOrdinal >= 256
        || !options.onDecodedBytes
      )
    ) {
      throw new RangeError("decodedMediaOrdinal 必须指向可回调的媒体 ordinal。");
    }
    if (options.onDecodedBytes && options.decodedMediaOrdinal === undefined) {
      throw new RangeError("onDecodedBytes 必须与 decodedMediaOrdinal 一起使用。");
    }
  }

  push(value: string): void {
    this.assertOpen();
    let offset = 0;
    while (offset < value.length) {
      if (this.state === "text") {
        offset = this.consumeText(value, offset);
      } else if (this.state === "header") {
        offset = this.consumeHeader(value, offset);
      } else if (this.state === "base64") {
        offset = this.consumeBase64(value, offset);
      } else {
        offset = this.consumeInvalid(value, offset);
      }
    }
  }

  finish(): DataUrlProjectionResult {
    this.assertOpen();
    this.finished = true;
    if (this.state === "base64") {
      this.finishActive();
    } else if (this.state === "discard-invalid") {
      this.options.onText("[invalid-media]");
    } else {
      this.options.onText(this.pendingText + this.header);
    }
    this.pendingText = "";
    this.header = "";
    return {
      candidateCount: this.candidateCount,
      processedCount: this.processedCount,
      limited: this.limited,
    };
  }

  private consumeText(value: string, offset: number): number {
    const combined = this.pendingText + value.slice(offset);
    const found = combined.indexOf(DATA_PREFIX);
    if (found >= 0) {
      this.options.onText(combined.slice(0, found));
      this.pendingText = "";
      this.header = DATA_PREFIX;
      this.state = "header";
      return value.length - Math.max(0, combined.length - found - DATA_PREFIX.length);
    }
    const keep = Math.min(DATA_PREFIX.length - 1, combined.length);
    const emitEnd = combined.length - keep;
    this.options.onText(combined.slice(0, emitEnd));
    this.pendingText = combined.slice(emitEnd);
    return value.length;
  }

  private consumeHeader(value: string, offset: number): number {
    for (let index = offset; index < value.length; index += 1) {
      const character = value[index]!;
      this.header += character;
      if (this.header.length > DATA_URL_HEADER_MAX_CHARS) {
        this.restoreNonMediaHeader();
        return index + 1;
      }
      if (character !== ",") continue;
      const mediaType = mediaTypeFromHeader(this.header);
      if (!mediaType) {
        this.restoreNonMediaHeader();
        return index + 1;
      }
      this.candidateCount += 1;
      const ordinal = this.nextOrdinal;
      const onDecodedBytes = ordinal === this.options.decodedMediaOrdinal
        && this.options.onDecodedBytes
        ? (value: Uint8Array) => this.options.onDecodedBytes!(
            value,
            { ordinal, mediaType },
          )
        : undefined;
      this.active = new Base64Accumulator(mediaType, onDecodedBytes);
      this.header = "";
      this.state = "base64";
      return index + 1;
    }
    return value.length;
  }

  /** 未通过合法媒体头验证的 `data:` 只是普通文本，必须无损回放。 */
  private restoreNonMediaHeader(): void {
    this.options.onText(this.header);
    this.header = "";
    this.pendingText = "";
    this.state = "text";
  }

  private consumeBase64(value: string, offset: number): number {
    for (let index = offset; index < value.length; index += 1) {
      const character = value[index]!;
      if (BASE64_CHAR.test(character)) {
        try {
          this.active!.push(character);
        } catch {
          this.active = undefined;
          this.limited = true;
          this.options.onDiagnostic?.("data_url_base64_invalid");
          this.state = "discard-invalid";
          return index + 1;
        }
        continue;
      }
      this.finishActive();
      this.state = "text";
      this.pendingText = "";
      return index;
    }
    return value.length;
  }

  private consumeInvalid(value: string, offset: number): number {
    for (let index = offset; index < value.length; index += 1) {
      if (BASE64_CHAR.test(value[index]!)) continue;
      this.options.onText("[invalid-media]");
      this.state = "text";
      this.pendingText = "";
      this.header = "";
      return index;
    }
    return value.length;
  }

  private finishActive(): void {
    const active = this.active;
    this.active = undefined;
    if (!active) return;
    let decoded: Base64Decoded;
    try {
      decoded = active.finish();
    } catch {
      this.limited = true;
      this.options.onDiagnostic?.("data_url_base64_invalid");
      this.options.onText("[invalid-media]");
      return;
    }
    if (this.processedCount >= this.maxDescriptors || this.nextOrdinal >= 256) {
      this.limited = true;
      this.options.onDiagnostic?.("media_descriptor_limit_exceeded");
      this.options.onText("[media]");
      return;
    }
    const descriptor: ExchangeMediaDescriptorDraft = {
      exchangeId: this.options.exchangeId,
      bodySide: this.options.bodySide,
      ordinal: this.nextOrdinal,
      jsonPath: boundedUtf8(this.options.jsonPath, 512),
      mediaType: boundedUtf8(active.mediaType, 128),
      encodedBytes: decoded.encodedBytes,
      decodedBytes: decoded.decodedBytes,
      sha256: decoded.sha256,
      rawBodySha256: this.options.rawBodySha256,
      sourceStorage: this.options.sourceStorage,
    };
    this.nextOrdinal += 1;
    this.processedCount += 1;
    this.options.onDescriptor(descriptor);
    this.options.onText("[media]");
  }

  private invalidateMedia(code: string): void {
    this.limited = true;
    this.options.onDiagnostic?.(code);
    this.header = "";
    this.state = "discard-invalid";
  }

  private assertOpen(): void {
    if (this.finished) throw new Error("Data URL projector 已完成。");
  }
}

interface Base64Decoded {
  encodedBytes: number;
  decodedBytes: number;
  sha256: string;
}

class Base64Accumulator {
  private readonly hash: Hash = createHash("sha256");
  private readonly decodedChunk?: Buffer;
  private quartet = "";
  private encodedBytes = 0;
  private decodedBytes = 0;
  private decodedChunkBytes = 0;
  private paddingSeen = false;

  constructor(
    readonly mediaType: string,
    private readonly onDecodedBytes?: (value: Uint8Array) => void,
  ) {
    if (onDecodedBytes) this.decodedChunk = Buffer.allocUnsafe(DECODED_MEDIA_CHUNK_BYTES);
  }

  push(character: string): void {
    if (this.paddingSeen) throw new Error("Base64 padding 后存在额外数据。");
    this.encodedBytes += 1;
    this.quartet += character;
    if (this.quartet.length === 4) this.flushQuartet(false);
  }

  finish(): Base64Decoded {
    if (this.quartet.length === 1) throw new Error("Base64 尾部长度无效。");
    if (this.quartet.length > 0) {
      this.quartet = this.quartet.padEnd(4, "=");
      this.flushQuartet(true);
    }
    this.flushDecodedChunk();
    return {
      encodedBytes: this.encodedBytes,
      decodedBytes: this.decodedBytes,
      sha256: this.hash.digest("hex"),
    };
  }

  private flushQuartet(final: boolean): void {
    const value = this.quartet;
    this.quartet = "";
    if (!/^[A-Za-z0-9+/]{2}(?:[A-Za-z0-9+/]{2}|[A-Za-z0-9+/]=|==)$/.test(value)) {
      throw new Error("Base64 四字符组无效。");
    }
    const hasPadding = value.includes("=");
    if (hasPadding && !final && this.encodedBytes % 4 !== 0) {
      throw new Error("Base64 padding 位置无效。");
    }
    const bytes = Buffer.from(value, "base64");
    this.hash.update(bytes);
    this.decodedBytes += bytes.length;
    this.appendDecodedBytes(bytes);
    if (hasPadding) this.paddingSeen = true;
  }

  private appendDecodedBytes(value: Buffer): void {
    if (!this.decodedChunk || !this.onDecodedBytes) return;
    let offset = 0;
    while (offset < value.length) {
      const writable = Math.min(
        this.decodedChunk.length - this.decodedChunkBytes,
        value.length - offset,
      );
      value.copy(
        this.decodedChunk,
        this.decodedChunkBytes,
        offset,
        offset + writable,
      );
      this.decodedChunkBytes += writable;
      offset += writable;
      if (this.decodedChunkBytes === this.decodedChunk.length) {
        this.flushDecodedChunk();
      }
    }
  }

  private flushDecodedChunk(): void {
    if (!this.decodedChunk || !this.onDecodedBytes || this.decodedChunkBytes === 0) return;
    this.onDecodedBytes(this.decodedChunk.subarray(0, this.decodedChunkBytes));
    this.decodedChunkBytes = 0;
  }
}

function mediaTypeFromHeader(header: string): string | undefined {
  const match = /^data:([^;,]+);base64,$/i.exec(header);
  const mediaType = match?.[1]?.toLowerCase();
  return mediaType && MEDIA_TYPE.test(mediaType) ? mediaType : undefined;
}
