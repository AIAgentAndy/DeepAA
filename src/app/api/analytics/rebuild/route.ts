import {jsonResponse} from "@/lib/app-state";
import {resolveDeepaaDataDir} from "@/lib/data-paths";
import {getDeepaaDatabase} from "@/lib/db/connection";
import {createRollupRepository} from "@/lib/analytics/rollup-repository";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({})) as {start?: unknown; end?: unknown};
  const end = typeof body.end === "string" ? Date.parse(body.end) : Date.now();
  const start = typeof body.start === "string" ? Date.parse(body.start) : end - 24 * 60 * 60 * 1_000;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return jsonResponse({error: "必须提供有效 start/end"}, 400);
  const hours = Math.ceil((end - start) / 3_600_000);
  if (hours > 24) return jsonResponse({error: "单次补算最多 24 小时，请分批提交", candidateCount: hours, processedCount: 0, limited: true, hasMore: true}, 413);
  const db = getDeepaaDatabase(resolveDeepaaDataDir());
  const repository = createRollupRepository(db);
  let processedCount = 0;
  for (let cursor = Math.floor(start / 3_600_000) * 3_600_000; cursor < end; cursor += 3_600_000) {
    const result = await repository.rebuildBucket(new Date(cursor).toISOString());
    processedCount += result.processedCount;
  }
  return jsonResponse({jobId: `rebuild-${Date.now()}`, candidateCount: hours, processedCount, limited: false, hasMore: false, status: "succeeded"});
}
