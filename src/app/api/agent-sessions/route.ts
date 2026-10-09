import { getDeepaaDatabase } from "@/lib/db/connection";
import { workbenchRouteErrorResponse } from "@/lib/db/route-responses";
import { loadApiAgentSessions } from "@/lib/db/workbench-queries";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  try {
    const page = loadApiAgentSessions(
      getDeepaaDatabase(),
      new URL(request.url).searchParams,
    );
    return Response.json({ ...page, sessions: page.items });
  } catch (error) {
    return workbenchRouteErrorResponse(error);
  }
}
