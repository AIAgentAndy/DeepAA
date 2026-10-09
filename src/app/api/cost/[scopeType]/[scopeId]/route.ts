import { getDeepaaDatabase } from "@/lib/db/connection";
import {
  invalidParameterResponse,
  notFoundResponse,
  workbenchRouteErrorResponse,
} from "@/lib/db/route-responses";
import {
  loadScopeSummary,
  readDerivationStatus,
} from "@/lib/db/workbench-queries";
import type { ScopeType } from "@/lib/db/models";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  _request: Request,
  context: { params: Promise<{ scopeType: string; scopeId: string }> },
): Promise<Response> {
  try {
    const { scopeType: encodedScopeType, scopeId } = await context.params;
    const scopeType = decodeURIComponent(encodedScopeType);
    if (!isScopeType(scopeType)) {
      return invalidParameterResponse(
        "invalid_scope_type",
        "scopeType 只允许 session、thread、turn 或 step。",
      );
    }
    const db = getDeepaaDatabase();
    const summary = loadScopeSummary(
      db,
      scopeType,
      decodeURIComponent(scopeId),
    );
    if (!summary) return notFoundResponse("统计范围不存在。");
    return Response.json({
      summary,
      derivedStatus: readDerivationStatus(db).status,
    });
  } catch (error) {
    return workbenchRouteErrorResponse(error);
  }
}

function isScopeType(value: string): value is ScopeType {
  return value === "session" || value === "thread" || value === "turn" || value === "step";
}
