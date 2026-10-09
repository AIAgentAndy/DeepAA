import {jsonResponse} from "@/lib/app-state";
import {resolveDeepaaDataDir} from "@/lib/data-paths";
import {getDeepaaDatabase} from "@/lib/db/connection";
import {loadAnalyticsDashboard} from "@/lib/db/analytics-queries";
import {resolveDashboardRange} from "@/lib/analytics/range";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const url = new URL(request.url);
  try {
    const range = resolveDashboardRange({
      start: url.searchParams.get("start") ?? undefined,
      end: url.searchParams.get("end") ?? undefined,
      timezone: url.searchParams.get("timezone") ?? undefined,
      now: url.searchParams.get("now") ?? undefined,
    });
    const data = await loadAnalyticsDashboard(getDeepaaDatabase(resolveDeepaaDataDir()), {
      start: range.range.start,
      end: range.range.end,
      granularity: range.granularity,
      bucketStep: range.bucketStep,
      bucketCount: range.bucketCount,
      timezone: range.timezone,
      now: url.searchParams.get("now") ?? undefined,
      limit: Number(url.searchParams.get("limit") ?? 50),
    });
    return jsonResponse(data);
  } catch (error) {
    return jsonResponse({error: error instanceof Error ? error.message : "Dashboard 查询失败"}, 400);
  }
}
