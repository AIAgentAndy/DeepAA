import { getDeepaaDatabase } from "@/lib/db/connection";
import {
  notFoundResponse,
  workbenchRouteErrorResponse,
} from "@/lib/db/route-responses";
import { loadApiAgentSessions } from "@/lib/db/workbench-queries";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  _request: Request,
  context: { params: Promise<{ agentSessionId: string }> },
): Promise<Response> {
  try {
    const { agentSessionId } = await context.params;
    const page = loadApiAgentSessions(
      getDeepaaDatabase(),
      new URLSearchParams({
        session: decodeURIComponent(agentSessionId),
        limit: "1",
      }),
    );
    return page.items[0]
      ? Response.json({ session: page.items[0] })
      : notFoundResponse("Agent Session 不存在。");
  } catch (error) {
    return workbenchRouteErrorResponse(error);
  }
}
