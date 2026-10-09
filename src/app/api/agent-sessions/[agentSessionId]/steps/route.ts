import { getDeepaaDatabase } from "@/lib/db/connection";
import { workbenchRouteErrorResponse } from "@/lib/db/route-responses";
import { loadApiAgentSteps } from "@/lib/db/workbench-queries";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  request: Request,
  context: { params: Promise<{ agentSessionId: string }> },
): Promise<Response> {
  try {
    const { agentSessionId } = await context.params;
    const params = new URL(request.url).searchParams;
    params.set("session", decodeURIComponent(agentSessionId));
    const page = loadApiAgentSteps(getDeepaaDatabase(), params);
    return Response.json({ ...page, steps: page.items });
  } catch (error) {
    return workbenchRouteErrorResponse(error);
  }
}
