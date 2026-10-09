import { resolveDeepaaDataDir } from "@/lib/data-paths";
import { getDeepaaDatabase } from "@/lib/db/connection";
import { collectStorageStats, previewRawPurge } from "@/lib/ingestion/raw-purge";
import { readAutoPurgeState } from "@/lib/ingestion/purge-scheduler";
import { readRetentionConfig } from "@/lib/retention";
import {
  assertLocalReadRequest,
  developmentLaunchErrorResponse,
  getLaunchNonceStore,
} from "@/lib/development-launch/security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * 存储管理总览（只读）：各目录体量（有界扫描 + truncated 标记）、保留配置、
 * 清理候选摘要与一次性 mutation nonce。走本地读取门禁（loopback + same-origin）。
 */
export async function GET(request: Request): Promise<Response> {
  try {
    assertLocalReadRequest(request);
    const dataDir = resolveDeepaaDataDir();
    const [stats, purgePreview] = await Promise.all([
      collectStorageStats(dataDir),
      previewRawPurge(getDeepaaDatabase(dataDir), dataDir),
    ]);
    return Response.json({
      stats,
      retention: readRetentionConfig(dataDir),
      autoPurge: readAutoPurgeState(dataDir)?.lastRun ?? null,
      purgePreview: {
        candidateCount: purgePreview.candidates.length,
        skippedCount: purgePreview.skipped.length,
        reclaimableBytes: purgePreview.reclaimableBytes,
        orphanReclaim: purgePreview.orphanReclaim,
        cutoff: purgePreview.cutoff,
        limited: purgePreview.limited,
      },
      nonce: getLaunchNonceStore().issue(),
    });
  } catch (error) {
    return developmentLaunchErrorResponse(error);
  }
}
