import { resolveDeepaaDataDir } from "@/lib/data-paths";
import { getDeepaaDatabase } from "@/lib/db/connection";
import {
  assertRawStreamRequest,
  loadRawStreamMetadata,
  rawStreamGatewayErrorResponse,
  RawStreamGatewayError,
} from "@/lib/raw-stream-gateway";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  request: Request,
  context: { params: Promise<{ exchangeId: string }> },
): Promise<Response> {
  try {
    assertRawStreamRequest(request);
    const { exchangeId } = await context.params;
    const decodedId = decodeExchangeId(exchangeId);
    const dataDir = resolveDeepaaDataDir();
    const metadata = loadRawStreamMetadata(
      getDeepaaDatabase(dataDir),
      decodedId,
    );
    if (!metadata) {
      throw new RawStreamGatewayError("raw_not_found", 404, "Exchange 不存在。");
    }
    return Response.json(metadata, {
      headers: {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Cross-Origin-Resource-Policy": "same-origin",
      },
    });
  } catch (error) {
    return rawStreamGatewayErrorResponse(error);
  }
}

function decodeExchangeId(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new RawStreamGatewayError("invalid_exchange_id", 400, "Exchange ID 无效。");
  }
}
