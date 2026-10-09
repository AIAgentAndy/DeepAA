import type {DeepaaDatabase} from "@/lib/db/sqlite-driver";
import type { RawBodyStorage, RawBodyAvailability } from "../db/models";
import type { RawCapturedExchangeV2 } from "./types";
import {
  readLegacySourceRecord,
  readRegisteredSourceRecord,
} from "../ingestion/raw-source-reader";

export type RawIndexVerification = "current" | "legacy";

export class RawLocatorError extends Error {
  readonly code = "unsafe_raw_reference";

  constructor(message = "Raw 索引或原始记录无法安全定位。", cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "RawLocatorError";
  }
}

export interface LocatedRawExchange {
  exchange: RawCapturedExchangeV2;
  indexVerification: RawIndexVerification;
}

interface LocatorRow {
  exchange_id: string;
  raw_source_id: number;
  raw_byte_offset: number;
  raw_line_length_bytes: number;
  relative_path: string;
  current_file_id: string;
  current_generation: number;
  ingestion_record_id: number | null;
  registered_source_id: number | null;
  source_generation: number | null;
  source_file_id: string | null;
  registered_byte_offset: number | null;
  registered_line_length_bytes: number | null;
  line_sha256: string | null;
  request_body_bytes: number | null;
  response_body_bytes: number | null;
  request_body_sha256: string | null;
  response_body_sha256: string | null;
  request_body_storage: RawBodyStorage | null;
  response_body_storage: RawBodyStorage | null;
  request_body_state: RawBodyAvailability | null;
  response_body_state: RawBodyAvailability | null;
}

/** 只按唯一索引读取一个 JSONL range；此模块不提供目录扫描或 exchangeId 搜索。 */
export async function locateRawExchange(
  db: DeepaaDatabase,
  dataDir: string,
  exchangeId: string,
): Promise<LocatedRawExchange | undefined> {
  const row = db.prepare(
    `SELECT r.exchange_id, r.source_id AS raw_source_id,
      r.byte_offset AS raw_byte_offset,
      r.line_length_bytes AS raw_line_length_bytes,
      s.relative_path, s.file_id AS current_file_id,
      s.generation AS current_generation,
      ir.id AS ingestion_record_id, ir.source_id AS registered_source_id,
      ir.source_generation, ir.source_file_id,
      ir.byte_offset AS registered_byte_offset,
      ir.line_length_bytes AS registered_line_length_bytes,
      ir.line_sha256, ir.request_body_bytes, ir.response_body_bytes,
      ir.request_body_sha256, ir.response_body_sha256,
      ir.request_body_storage, ir.response_body_storage,
      ir.request_body_state, ir.response_body_state
     FROM raw_exchange_refs r
     JOIN ingestion_sources s ON s.id = r.source_id
     LEFT JOIN ingestion_records ir ON ir.exchange_id = r.exchange_id
     WHERE r.exchange_id = ? LIMIT 1`,
  ).get(exchangeId) as LocatorRow | undefined;
  if (!row) return undefined;

  try {
    if (row.ingestion_record_id !== null) {
      assertCurrentLocator(row);
      const record = await readRegisteredSourceRecord(db, dataDir, {
        exchangeId: row.exchange_id,
        sourceId: row.registered_source_id!,
        sourceGeneration: row.source_generation!,
        sourceFileId: row.source_file_id!,
        sourceRelativePath: row.relative_path,
        byteOffset: row.registered_byte_offset!,
        lineLengthBytes: row.registered_line_length_bytes!,
        lineSha256: row.line_sha256!,
      });
      assertRegisteredBodies(row, record.exchange);
      return { exchange: record.exchange, indexVerification: "current" };
    }
    const record = await readLegacySourceRecord(db, dataDir, {
      exchangeId: row.exchange_id,
      sourceId: row.raw_source_id,
      sourceGeneration: row.current_generation,
      sourceFileId: row.current_file_id,
      sourceRelativePath: row.relative_path,
      byteOffset: row.raw_byte_offset,
      lineLengthBytes: row.raw_line_length_bytes,
    });
    return { exchange: record.exchange, indexVerification: "legacy" };
  } catch (error) {
    if (error instanceof RawLocatorError) throw error;
    throw new RawLocatorError(undefined, error);
  }
}

function assertCurrentLocator(row: LocatorRow): void {
  if (
    row.registered_source_id !== row.raw_source_id
    || row.registered_byte_offset !== row.raw_byte_offset
    || row.registered_line_length_bytes !== row.raw_line_length_bytes
    || !Number.isSafeInteger(row.source_generation)
    || !row.source_file_id
    || !validSha256(row.line_sha256)
  ) {
    throw new RawLocatorError();
  }
}

function assertRegisteredBodies(
  row: LocatorRow,
  exchange: RawCapturedExchangeV2,
): void {
  for (const side of ["request", "response"] as const) {
    const body = exchange[side];
    const bytes = side === "request" ? row.request_body_bytes : row.response_body_bytes;
    const sha256 = side === "request" ? row.request_body_sha256 : row.response_body_sha256;
    const storage = side === "request"
      ? row.request_body_storage
      : row.response_body_storage;
    const state = side === "request" ? row.request_body_state : row.response_body_state;
    if (
      bytes !== body.bodySizeBytes
      || sha256?.toLowerCase() !== body.bodySha256.toLowerCase()
      || storage !== bodyStorage(body)
      || state !== bodyAvailability(exchange, side)
    ) {
      throw new RawLocatorError("Raw 正文登记身份与原始记录不一致。");
    }
  }
}

function bodyStorage(
  body: RawCapturedExchangeV2["request"] | RawCapturedExchangeV2["response"],
): RawBodyStorage {
  return body.rawBodyRef?.storage
    ?? (typeof body.rawBody === "string" ? "inline" : "none");
}

function bodyAvailability(
  exchange: RawCapturedExchangeV2,
  side: "request" | "response",
): RawBodyAvailability {
  const body = exchange[side];
  if (body.bodySizeBytes === 0) return "empty";
  if (bodyStorage(body) !== "none") return "available";
  return exchange.captureDiagnostics.some(
    diagnostic => diagnostic.code === "missing_raw_body",
  ) ? "missing_declared" : "available";
}

function validSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}
