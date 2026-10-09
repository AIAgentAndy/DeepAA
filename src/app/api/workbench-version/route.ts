import { getDeepaaDatabase } from "@/lib/db/connection";
import { workbenchRouteErrorResponse } from "@/lib/db/route-responses";
import { readDerivationStatus } from "@/lib/db/workbench-queries";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  try {
    const state = readDerivationStatus(getDeepaaDatabase());
    const version = `${state.dataVersion}:${state.status}`;
    const tag = `W/"${Buffer.from(version, "utf8").toString("base64url")}"`;
    if (request.headers.get("if-none-match") === tag) {
      return new Response(null, { status: 304, headers: { ETag: tag } });
    }
    return Response.json({
      version,
      dataVersion: state.dataVersion,
      derivedStatus: state.status,
      candidateCount: 1,
      processedCount: 1,
      limited: false,
    }, { headers: { ETag: tag } });
  } catch (error) {
    return workbenchRouteErrorResponse(error);
  }
}
