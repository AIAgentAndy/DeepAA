import { resolveDeepaaDataDir } from "@/lib/data-paths";
import {
  assertLocalMutationRequest,
  readBoundedJson,
  requireLaunchNonce,
  developmentLaunchErrorResponse,
  DevelopmentLaunchError,
  getLaunchNonceStore,
} from "@/lib/development-launch/security";
import {
  clampRawRetentionDays,
  MIN_RAW_RETENTION_DAYS,
  MAX_RAW_RETENTION_DAYS,
  readRetentionConfig,
  writeRetentionConfig,
} from "@/lib/retention";
import { requestIdlePurgeSoon } from "@/lib/ingestion/purge-scheduler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** 调整保留窗口（3~180 天）；nonce 单次有效，写 config/retention.json。 */
export async function PUT(request: Request): Promise<Response> {
  try {
    assertLocalMutationRequest(request);
    const body = await readBoundedJson(request);
    requireLaunchNonce(body);
    if (
      typeof body.rawRetentionDays !== "number"
      || !Number.isInteger(body.rawRetentionDays)
      || body.rawRetentionDays < MIN_RAW_RETENTION_DAYS
      || body.rawRetentionDays > MAX_RAW_RETENTION_DAYS
    ) {
      throw new DevelopmentLaunchError("INVALID_RETENTION_DAYS", 400);
    }
    const dataDir = resolveDeepaaDataDir();
    const written = writeRetentionConfig(dataDir, body.rawRetentionDays);
    // 保存动作本身零清理；请求调度器在当日空闲时按新窗口清理（2026-09-21 用户确认：
    // 调窗口（尤其调小）即表达清理意图，但不允许保存时立刻猛删）。
    requestIdlePurgeSoon(dataDir);
    return Response.json({
      retention: written,
      effective: readRetentionConfig(dataDir),
      nonce: getLaunchNonceStore().issue(),
    });
  } catch (error) {
    return developmentLaunchErrorResponse(error);
  }
}
