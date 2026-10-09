import { resolveDeepaaDataDir } from "@/lib/data-paths";
import { getDeepaaDatabase } from "@/lib/db/connection";
import type { ProjectionBodySide } from "@/lib/ingestion/projection-types";
import {
  openRawMediaResponse,
  rawMediaGatewayErrorResponse,
  RawMediaGatewayError,
} from "@/lib/raw-media-gateway";
import {
  assertNoRawRange,
  assertRawStreamRequest,
} from "@/lib/raw-stream-gateway";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  request: Request,
  context: {
    params: Promise<{ exchangeId: string; side: string; ordinal: string }>;
  },
): Promise<Response> {
  try {
    assertRawStreamRequest(request);
    assertNoRawRange(request);
    const { exchangeId, side, ordinal } = await context.params;
    const dataDir = resolveDeepaaDataDir();
    return await openRawMediaResponse({
      db: getDeepaaDatabase(dataDir),
      dataDir,
      exchangeId: decodeExchangeId(exchangeId),
      side: parseSide(side),
      ordinal: parseOrdinal(ordinal),
    });
  } catch (error) {
    return rawMediaGatewayErrorResponse(error);
  }
}

function parseSide(value: string): ProjectionBodySide {
  if (value === "request" || value === "response") return value;
  throw new RawMediaGatewayError(
    "invalid_raw_media_side",
    400,
    "图片媒体 side 无效。",
  );
}

function parseOrdinal(value: string): number {
  if (!/^(?:0|[1-9]\d*)$/u.test(value)) {
    throw new RawMediaGatewayError(
      "invalid_raw_media_ordinal",
      400,
      "图片媒体 ordinal 无效。",
    );
  }
  const ordinal = Number(value);
  if (!Number.isSafeInteger(ordinal) || ordinal < 0 || ordinal >= 256) {
    throw new RawMediaGatewayError(
      "invalid_raw_media_ordinal",
      400,
      "图片媒体 ordinal 无效。",
    );
  }
  return ordinal;
}

function decodeExchangeId(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new RawMediaGatewayError(
      "invalid_exchange_id",
      400,
      "Exchange ID 无效。",
    );
  }
}
