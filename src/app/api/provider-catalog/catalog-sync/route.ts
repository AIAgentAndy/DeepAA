import {jsonResponse} from "@/lib/app-state";
import {resolveDeepaaDataDir} from "@/lib/data-paths";
import {getDeepaaDatabase} from "@/lib/db/connection";
import {ensurePricingConfigRevision} from "@/lib/ingestion/pricing-revisions";
import {runOfficialCatalogSync} from "@/lib/provider-catalog/catalog-runner";
import {readEffectivePricingConfig} from "@/lib/pricing";
import {
  assertLocalMutationRequest,
  developmentLaunchErrorResponse,
  getLaunchNonceStore,
  readBoundedJson,
  requireLaunchNonce,
} from "@/lib/development-launch/security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const DATA_DIR = resolveDeepaaDataDir();

/**
 * 手动触发 DeepAA 官方预设同步（价格中心「导入 DeepAA 官方预设」按钮）：
 * 复用四原则执行器（在线优先→离线兜底、版本闸门、静默集落盘、使用中变更留给角标确认）。
 * 与右上角定时任务同一条写入路径；user_override 手工价由合并逻辑保护，永不覆盖。
 */
export async function POST(request: Request): Promise<Response> {
  try {
    assertLocalMutationRequest(request);
    const body = await readBoundedJson(request);
    requireLaunchNonce(body);
    const result = await runOfficialCatalogSync(DATA_DIR, {
      forceRefresh: true,
      recordRevision: async (dir, config, effectiveAt) => {
        try {
          // 与 instrumentation 调度器同口径：按落盘后生效配置追加拉价格版本。
          const effective = await readEffectivePricingConfig(dir);
          ensurePricingConfigRevision(getDeepaaDatabase(dir), effective, effectiveAt);
        } catch (error) {
          // 价格文件已保存；版本记录失败由 Worker 后续补建，不回滚同步。
          console.error("[deepaa] provider catalog sync revision failed", error);
        }
        void config;
      },
    });
    return jsonResponse({
      ok: true,
      skippedByVersion: result.skippedByVersion,
      insertedCount: result.insertedCount,
      autoUpdatedCount: result.autoUpdatedCount,
      toleranceSilentCount: result.toleranceSilentCount,
      notificationCount: result.notificationCount,
      publishedAt: result.publishedAt,
      nonce: getLaunchNonceStore().issue(),
    });
  } catch (error) {
    return developmentLaunchErrorResponse(error);
  }
}
