import { getDeepaaDatabase } from "@/lib/db/connection";
import { workbenchRouteErrorResponse } from "@/lib/db/route-responses";
import {
  readDerivationStatus,
  resolveCanonicalWorkbenchSelection,
  resolveWorkbenchSelection,
} from "@/lib/db/workbench-queries";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  try {
    const db = getDeepaaDatabase();
    const params = new URL(request.url).searchParams;
    const latestParams = new URLSearchParams();
    for (const key of ["target", "agent", "start", "end"] as const) {
      const value = params.get(key)?.trim();
      if (value) latestParams.set(key, value);
    }
    const state = readDerivationStatus(db);
    return Response.json({
      latestPath: resolveWorkbenchSelection(db, latestParams),
      resolvedPath: resolveCanonicalWorkbenchSelection(db, params),
      dataVersion: state.dataVersion,
      derivedStatus: state.status,
    });
  } catch (error) {
    return workbenchRouteErrorResponse(error);
  }
}
