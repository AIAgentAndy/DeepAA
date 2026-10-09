import { getDeepaaDatabase } from "@/lib/db/connection";
import { workbenchRouteErrorResponse } from "@/lib/db/route-responses";
import { readDerivationOverview } from "@/lib/db/workbench-queries";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  try {
    const state = readDerivationOverview(getDeepaaDatabase());
    const {
      status,
      dataVersion,
      error,
      ...overview
    } = state;
    return Response.json({
      derivedStatus: status,
      dataVersion,
      error,
      ...overview,
      candidateCount: 1,
      processedCount: 1,
      limited: false,
    });
  } catch (error) {
    return workbenchRouteErrorResponse(error);
  }
}
