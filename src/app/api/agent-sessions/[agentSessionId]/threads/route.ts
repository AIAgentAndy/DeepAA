import { getDeepaaDatabase } from "@/lib/db/connection";
import {
  notFoundResponse,
  workbenchRouteErrorResponse,
} from "@/lib/db/route-responses";
import { loadSessionThreads } from "@/lib/db/workbench-queries";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  request: Request,
  context: { params: Promise<{ agentSessionId: string }> },
): Promise<Response> {
  try {
    const { agentSessionId } = await context.params;
    const page = loadSessionThreads(
      getDeepaaDatabase(),
      decodeURIComponent(agentSessionId),
      new URL(request.url).searchParams,
    );
    return page
      ? Response.json(page)
      : notFoundResponse("Agent Session 不存在。");
  } catch (error) {
    return workbenchRouteErrorResponse(error);
  }
}
