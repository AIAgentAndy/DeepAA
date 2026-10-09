import { resolveDeepaaDataDir } from "@/lib/data-paths";
import { getDeepaaDatabase } from "@/lib/db/connection";
import { executeRawPurge, previewRawPurge } from "@/lib/ingestion/raw-purge";
import {
  assertLocalMutationRequest,
  readBoundedJson,
  requireLaunchNonce,
  developmentLaunchErrorResponse,
  DevelopmentLaunchError,
  getLaunchNonceStore,
} from "@/lib/development-launch/security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * 历史 raw 清理（决策 D5：仅手动一键 + 二次确认）。
 * - action=preview：返回完整候选（文件级明细 + 跳过原因），只读；
 * - action=execute：必须携带 confirm=true，逐文件短事务执行，返回逐文件结果与
 *   释放字节数。永不删除 step/账本/聚合；raw_exchange_refs 保留墓碑。
 */
export async function POST(request: Request): Promise<Response> {
  try {
    assertLocalMutationRequest(request);
    const body = await readBoundedJson(request);
    requireLaunchNonce(body);
    const action = body.action;
    const dataDir = resolveDeepaaDataDir();
    const db = getDeepaaDatabase(dataDir);

    if (action === "preview") {
      return Response.json({
        preview: await previewRawPurge(db, dataDir),
        nonce: getLaunchNonceStore().issue(),
      });
    }
    if (action === "execute") {
      if (body.confirm !== true) {
        throw new DevelopmentLaunchError("PURGE_CONFIRM_REQUIRED", 400);
      }
      const result = await executeRawPurge(db, dataDir);
      const preview = await previewRawPurge(db, dataDir);
      return Response.json({result, preview, nonce: getLaunchNonceStore().issue()});
    }
    throw new DevelopmentLaunchError("INVALID_PURGE_ACTION", 400);
  } catch (error) {
    return developmentLaunchErrorResponse(error);
  }
}
