import { resolveDeepaaDataDir } from "@/lib/data-paths";
import { getDeepaaDatabase } from "@/lib/db/connection";
import {
  assertNoRawRange,
  assertRawStreamRequest,
  openRawStreamResponse,
  rawStreamGatewayErrorResponse,
  RawStreamGatewayError,
  type RawBodySide,
  type RawDisposition,
} from "@/lib/raw-stream-gateway";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  request: Request,
  context: { params: Promise<{ exchangeId: string; side: string }> },
): Promise<Response> {
  try {
    assertRawStreamRequest(request);
    assertNoRawRange(request);
    const { exchangeId, side } = await context.params;
    const dataDir = resolveDeepaaDataDir();
    return await openRawStreamResponse({
      db: getDeepaaDatabase(dataDir),
      dataDir,
      exchangeId: decodeExchangeId(exchangeId),
      side: parseSide(side),
      disposition: parseDisposition(new URL(request.url).searchParams.get("disposition")),
    });
  } catch (error) {
    return rawStreamGatewayErrorResponse(error);
  }
}

function parseSide(value: string): RawBodySide {
  if (value === "request" || value === "response") return value;
  throw new RawStreamGatewayError("invalid_raw_side", 400, "Raw side 无效。");
}

function parseDisposition(value: string | null): RawDisposition {
  if (value === null || value === "inline") return "inline";
  if (value === "attachment") return value;
  throw new RawStreamGatewayError(
    "invalid_raw_disposition",
    400,
    "Raw disposition 无效。",
  );
}

function decodeExchangeId(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new RawStreamGatewayError("invalid_exchange_id", 400, "Exchange ID 无效。");
  }
}
