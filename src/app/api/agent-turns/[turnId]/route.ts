import { getDeepaaDatabase } from "@/lib/db/connection";
import {
  notFoundResponse,
  workbenchRouteErrorResponse,
} from "@/lib/db/route-responses";
import { loadApiAgentTurns } from "@/lib/db/workbench-queries";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  _request: Request,
  context: { params: Promise<{ turnId: string }> },
): Promise<Response> {
  try {
    const { turnId } = await context.params;
    const page = loadApiAgentTurns(
      getDeepaaDatabase(),
      new URLSearchParams({ turn: decodeURIComponent(turnId), limit: "1" }),
    );
    return page.items[0]
      ? Response.json({ turn: page.items[0] })
      : notFoundResponse("Agent Turn 不存在。");
  } catch (error) {
    return workbenchRouteErrorResponse(error);
  }
}
