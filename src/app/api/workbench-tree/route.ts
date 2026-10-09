import { getDeepaaDatabase } from "@/lib/db/connection";
import { workbenchRouteErrorResponse } from "@/lib/db/route-responses";
import { loadWorkbenchTree } from "@/lib/db/workbench-queries";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    return Response.json(loadWorkbenchTree(
      getDeepaaDatabase(),
      url.searchParams,
      { includeAllTargets: url.searchParams.get("treeScope") === "global" },
    ));
  } catch (error) {
    return workbenchRouteErrorResponse(error);
  }
}
