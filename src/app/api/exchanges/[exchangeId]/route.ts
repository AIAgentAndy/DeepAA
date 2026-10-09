import { getDeepaaDatabase } from "@/lib/db/connection";
import { loadExchangeProjectionDetail } from "@/lib/db/exchange-projection-queries";
import {
  selectExportExchangeRefs,
  selectPreviousExportModelRefForThread,
} from "@/lib/db/export-queries";
import {
  notFoundResponse,
  workbenchRouteErrorResponse,
} from "@/lib/db/route-responses";
import { resolveDeepaaDataDir } from "@/lib/data-paths";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  _request: Request,
  context: { params: Promise<{ exchangeId: string }> },
): Promise<Response> {
  try {
    const { exchangeId } = await context.params;
    const dataDir = resolveDeepaaDataDir();
    const db = getDeepaaDatabase(dataDir);
    const decodedExchangeId = decodeURIComponent(exchangeId);
    const exchange = loadExchangeProjectionDetail(db, decodedExchangeId);
    const currentRef = exchange
      ? selectExportExchangeRefs(db, {
          step: decodedExchangeId,
          scope: "step",
          categories: [],
          exchangeLimit: 1,
        }).refs[0]
      : undefined;
    const previousModelExchangeId = currentRef
      ? selectPreviousExportModelRefForThread(db, currentRef)?.exchangeId
      : undefined;
    return exchange
      ? Response.json({ exchange, previousModelExchangeId })
      : notFoundResponse("Exchange 不存在。");
  } catch (error) {
    return workbenchRouteErrorResponse(error);
  }
}
