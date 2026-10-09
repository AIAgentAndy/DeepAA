import { getDeepaaDatabase } from "@/lib/db/connection";
import {
  notFoundResponse,
  workbenchRouteErrorResponse,
} from "@/lib/db/route-responses";
import {
  loadApiAgentSteps,
  loadApiAgentTurns,
  loadApiAuxiliaryRequests,
  readDerivationStatus,
} from "@/lib/db/workbench-queries";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  _request: Request,
  context: { params: Promise<{ turnId: string }> },
): Promise<Response> {
  try {
    const { turnId } = await context.params;
    const decodedTurnId = decodeURIComponent(turnId);
    const db = getDeepaaDatabase();
    const turn = loadApiAgentTurns(
      db,
      new URLSearchParams({ turn: decodedTurnId, limit: "1" }),
    ).items[0];
    if (!turn) return notFoundResponse("Agent Turn 不存在。");
    const params = new URLSearchParams({ turn: decodedTurnId, limit: "100" });
    const steps = loadApiAgentSteps(db, params);
    const auxiliary = loadApiAuxiliaryRequests(db, params);
    const state = readDerivationStatus(db);
    return Response.json({
      turn,
      steps,
      auxiliaryExchanges: auxiliary,
      derivedStatus: state.status,
      dataVersion: state.dataVersion,
    });
  } catch (error) {
    return workbenchRouteErrorResponse(error);
  }
}
