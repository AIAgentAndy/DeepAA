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
  loadStepCapabilityItems,
  loadStepCapabilitySummary,
} from "@/lib/db/step-capability-queries";
import {
  STEP_CAPABILITY_ITEMS_DEFAULT_LIMIT,
  STEP_CAPABILITY_ITEMS_MAX_LIMIT,
} from "@/lib/agent-harness/contracts";
import {
  readDerivationStatus,
  resolveApiAgentStepId,
} from "@/lib/db/workbench-queries";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * P1-2（2026-11-03）：新增显式 view 契约——
 * - view=capability-summary：传递 × 使用 × 诚实性单对象摘要；
 * - view=capability-items：kind（tools/observed/skills/mcp）+ name keyset 分页分类页。
 * 不带 view 的旧客户端契约保持不变。
 */
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
    if (!resolvedStepId) return notFoundResponse("Step Harness 不存在。");
    const searchParams = new URL(request.url).searchParams;
    const view = searchParams.get("view");

    if (view === "capability-summary") {
      const summary = loadStepCapabilitySummary(db, resolvedStepId, dataDir);
      if (!summary) return notFoundResponse("Step Harness 不存在。");
      const state = readDerivationStatus(db);
      return Response.json({...summary, derivedStatus: state.status, dataVersion: state.dataVersion});
    }
    if (view === "capability-items") {
      const kindParam = searchParams.get("kind") ?? "tools";
      if (kindParam !== "tools" && kindParam !== "observed" && kindParam !== "skills" && kindParam !== "mcp") {
        return Response.json({error: "INVALID_KIND"}, {status: 400});
      }
      const limitParam = Number(searchParams.get("limit") ?? STEP_CAPABILITY_ITEMS_DEFAULT_LIMIT);
      const limit = Number.isFinite(limitParam)
        ? Math.max(1, Math.min(Math.trunc(limitParam), STEP_CAPABILITY_ITEMS_MAX_LIMIT))
        : STEP_CAPABILITY_ITEMS_DEFAULT_LIMIT;
      const cursor = searchParams.get("cursor") || undefined;
      const page = loadStepCapabilityItems(
        db,
        resolvedStepId,
        {kind: kindParam, limit, ...(cursor ? {cursor} : {})},
        dataDir,
      );
      if (!page) return notFoundResponse("Step Harness 不存在。");
      return Response.json(page);
    }

    const harness = loadAgentStepHarness(db, resolvedStepId, dataDir);
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
