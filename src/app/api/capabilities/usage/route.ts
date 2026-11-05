import { getDeepaaDatabase } from "@/lib/db/connection";
import { jsonResponse } from "@/lib/app-state";
import { capabilityUsageForAgent } from "@/lib/db/capability-usage-queries";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * P2-b（2026-11-04）：能力利用率（只读，SQLite 聚合）。
 * GET /api/capabilities/usage?agent=<agentName>&days=7|30
 * 声明/调用覆盖率 + 执行侧聚合（zcode）+ 低调用候选（观察结论，非价值判断）。
 */
export async function GET(request: Request): Promise<Response> {
  try {
    const params = new URL(request.url).searchParams;
    const agent = params.get("agent")?.trim() || "";
    const daysParam = Number(params.get("days") ?? 7);
    const days = daysParam === 7 || daysParam === 30 ? daysParam : 7;
    if (!agent) {
      return Response.json({error: "MISSING_PARAMS", message: "agent 必填"}, {status: 400});
    }
    const db = getDeepaaDatabase();
    const result = capabilityUsageForAgent(db, {agentName: agent, windowDays: days});
    return jsonResponse(result);
  } catch (error) {
    return Response.json({error: "USAGE_FAILED", message: (error as Error).message}, {status: 500});
  }
}
