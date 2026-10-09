import { getDeepaaDatabase } from "@/lib/db/connection";
import { resolveDeepaaDataDir } from "@/lib/data-paths";
import {
  notFoundResponse,
  workbenchRouteErrorResponse,
} from "@/lib/db/route-responses";
import {
  loadAgentStepHarness,
} from "@/lib/db/harness-queries";
import {
  readDerivationStatus,
  resolveApiAgentStepId,
} from "@/lib/db/workbench-queries";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  request: Request,
  context: { params: Promise<{ stepId: string }> },
): Promise<Response> {
  try {
    const { stepId } = await context.params;
    const dataDir = resolveDeepaaDataDir();
    const db = getDeepaaDatabase();
    const resolvedStepId = resolveApiAgentStepId(
      db,
      decodeURIComponent(stepId),
      new URL(request.url).searchParams.get("turnId") || undefined,
    );
    const harness = resolvedStepId
      ? loadAgentStepHarness(db, resolvedStepId, dataDir)
      : undefined;
    if (!harness) return notFoundResponse("Step Harness 不存在。");
    const state = readDerivationStatus(db);
    return Response.json({
      ...harness,
      derivedStatus: state.status,
      dataVersion: state.dataVersion,
    });
  } catch (error) {
    return workbenchRouteErrorResponse(error);
  }
}
