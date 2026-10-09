import { getDeepaaDatabase } from "@/lib/db/connection";
import { resolveDeepaaDataDir } from "@/lib/data-paths";
import {
  notFoundResponse,
  workbenchRouteErrorResponse,
} from "@/lib/db/route-responses";
import {
  loadStoredStepArtifact,
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
    const artifact = resolvedStepId
      ? loadStoredStepArtifact(db, resolvedStepId, "context", dataDir)
      : undefined;
    if (!artifact) return notFoundResponse("Context Snapshot 不存在。");
    const state = readDerivationStatus(db);
    return Response.json({
      snapshot: artifact.value,
      truncated: artifact.truncated,
      completeness: artifact.completeness,
      sizeBytes: artifact.sizeBytes,
      derivedStatus: state.status,
      dataVersion: state.dataVersion,
      candidateCount: 1,
      processedCount: 1,
      limited: artifact.truncated,
    });
  } catch (error) {
    return workbenchRouteErrorResponse(error);
  }
}
