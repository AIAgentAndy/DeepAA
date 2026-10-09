import { getDeepaaDatabase } from "@/lib/db/connection";
import { workbenchRouteErrorResponse } from "@/lib/db/route-responses";
import { loadWorkbenchSessionSearch } from "@/lib/db/workbench-search";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    return Response.json(loadWorkbenchSessionSearch(getDeepaaDatabase(), url.searchParams));
  } catch (error) {
    return workbenchRouteErrorResponse(error);
  }
}
