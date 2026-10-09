import { getDeepaaDatabase } from "@/lib/db/connection";
import { resolveDeepaaDataDir } from "@/lib/data-paths";
import {
  notFoundResponse,
  workbenchRouteErrorResponse,
} from "@/lib/db/route-responses";
import { loadApiAgentStepDetail } from "@/lib/db/workbench-queries";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  _request: Request,
  context: { params: Promise<{ stepId: string }> },
): Promise<Response> {
  try {
    const { stepId } = await context.params;
    const step = loadApiAgentStepDetail(
      getDeepaaDatabase(),
      decodeURIComponent(stepId),
      resolveDeepaaDataDir(),
    );
    return step
      ? Response.json({ step })
      : notFoundResponse("Agent Step 不存在。");
  } catch (error) {
    return workbenchRouteErrorResponse(error);
  }
}
