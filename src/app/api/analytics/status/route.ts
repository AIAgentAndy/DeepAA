import {jsonResponse} from "@/lib/app-state";
import {resolveDeepaaDataDir} from "@/lib/data-paths";
import {getDeepaaDatabase} from "@/lib/db/connection";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const db = getDeepaaDatabase(resolveDeepaaDataDir());
  const state = db.prepare("SELECT * FROM analytics_worker_state WHERE id = 1").get() ?? {status: "idle"};
  const dirty = db.prepare("SELECT COUNT(*) AS count FROM analytics_dirty_buckets WHERE status <> 'completed'").get() as {count: number};
  const latest = db.prepare("SELECT MAX(created_at) AS latest FROM usage_ledger").get() as {latest?: string};
  return jsonResponse({state, staleBuckets: dirty.count, ledgerLatestAt: latest.latest ?? null, candidateCount: dirty.count, processedCount: 0, limited: false, hasMore: false});
}
