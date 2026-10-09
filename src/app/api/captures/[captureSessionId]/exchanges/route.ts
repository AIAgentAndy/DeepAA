import { resolveDeepaaDataDir } from "@/lib/data-paths";
import { getDeepaaDatabase } from "@/lib/db/connection";
import { loadCaptureExchangeProjectionPage } from "@/lib/db/exchange-projection-queries";
import { workbenchRouteErrorResponse } from "@/lib/db/route-responses";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_CAPTURE_EXCHANGE_DETAILS = 20;

export async function GET(
  request: Request,
  context: { params: Promise<{ captureSessionId: string }> },
): Promise<Response> {
  try {
    const { captureSessionId } = await context.params;
    const params = new URL(request.url).searchParams;
    const requestedLimit = Number(params.get("limit") || MAX_CAPTURE_EXCHANGE_DETAILS);
    params.set("limit", String(
      Number.isSafeInteger(requestedLimit)
        ? Math.max(1, Math.min(requestedLimit, MAX_CAPTURE_EXCHANGE_DETAILS))
        : MAX_CAPTURE_EXCHANGE_DETAILS,
    ));
    const dataDir = resolveDeepaaDataDir();
    const db = getDeepaaDatabase(dataDir);
    const page = loadCaptureExchangeProjectionPage(
      db,
      decodeURIComponent(captureSessionId),
      params,
    );
    return Response.json(page);
  } catch (error) {
    return workbenchRouteErrorResponse(error);
  }
}
