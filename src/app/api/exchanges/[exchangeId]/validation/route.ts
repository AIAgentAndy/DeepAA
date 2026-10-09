import { resolveDeepaaDataDir } from "@/lib/data-paths";
import { getDeepaaDatabase } from "@/lib/db/connection";
import {
  loadExchangeProjectionDetail,
  validationProjection,
} from "@/lib/db/exchange-projection-queries";
import {
  notFoundResponse,
  workbenchRouteErrorResponse,
} from "@/lib/db/route-responses";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  _request: Request,
  context: { params: Promise<{ exchangeId: string }> },
): Promise<Response> {
  try {
    const { exchangeId } = await context.params;
    const dataDir = resolveDeepaaDataDir();
    const exchange = loadExchangeProjectionDetail(
      getDeepaaDatabase(dataDir),
      decodeURIComponent(exchangeId),
    );
    return exchange
      ? Response.json({ validation: validationProjection(exchange) })
      : notFoundResponse("Exchange 不存在。");
  } catch (error) {
    return workbenchRouteErrorResponse(error);
  }
}
