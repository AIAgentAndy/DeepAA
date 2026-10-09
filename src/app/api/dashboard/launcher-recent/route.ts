import {jsonResponse} from "@/lib/app-state";
import {resolveDeepaaDataDir} from "@/lib/data-paths";
import {getDeepaaDatabase} from "@/lib/db/connection";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** 最近使用窗口：只看 30 天，天然有界（索引 bucket_start_utc 前缀扫描）。 */
const RECENT_WINDOW_MS = 30 * 24 * 3_600_000;
const MAX_DIMENSION_ROWS = 512;

/**
 * 仪表盘启动区排序键：各 Agent / 供应商目标最近一次请求的小时桶时间。
 * 只读小时事实表（预聚合），不触碰 raw；返回值仅作展示排序，不参与计费。
 */
export async function GET() {
  try {
    const db = getDeepaaDatabase(resolveDeepaaDataDir());
    const since = new Date(Date.now() - RECENT_WINDOW_MS).toISOString();
    const agents = db.prepare(
      `SELECT COALESCE(agent_id, 'unknown') AS id, MAX(bucket_start_utc) AS latest
       FROM analytics_hourly_facts
       WHERE bucket_start_utc >= ?
       GROUP BY COALESCE(agent_id, 'unknown')
       ORDER BY latest DESC
       LIMIT ?`,
    ).all(since, MAX_DIMENSION_ROWS) as Array<{id: string; latest: string}>;
    const targets = db.prepare(
      `SELECT target_id AS id, MAX(bucket_start_utc) AS latest
       FROM analytics_hourly_facts
       WHERE bucket_start_utc >= ? AND target_id IS NOT NULL
       GROUP BY target_id
       ORDER BY latest DESC
       LIMIT ?`,
    ).all(since, MAX_DIMENSION_ROWS) as Array<{id: string; latest: string}>;
    return jsonResponse({
      agents: Object.fromEntries(agents.map(row => [row.id, row.latest])),
      targets: Object.fromEntries(targets.map(row => [row.id, row.latest])),
      windowDays: 30,
    });
  } catch (error) {
    return jsonResponse({
      error: error instanceof Error ? error.message : String(error),
    }, 500);
  }
}
