import { getDeepaaDatabase } from "@/lib/db/connection";
import { workbenchRouteErrorResponse } from "@/lib/db/route-responses";
import { loadApiAuxiliaryRequests } from "@/lib/db/workbench-queries";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  request: Request,
  context: { params: Promise<{ turnId: string }> },
): Promise<Response> {
  try {
    const { turnId } = await context.params;
    const params = new URL(request.url).searchParams;
    params.set("turn", decodeURIComponent(turnId));
    const page = loadApiAuxiliaryRequests(getDeepaaDatabase(), params);
    return Response.json({ ...page, auxiliaryExchanges: page.items });
  } catch (error) {
    return workbenchRouteErrorResponse(error);
  }
}
