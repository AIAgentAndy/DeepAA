import {jsonResponse} from "@/lib/app-state";
import {resolveDeepaaDataDir} from "@/lib/data-paths";
import {getDeepaaDatabase} from "@/lib/db/connection";
import {catalogOverridePath, loadProviderCatalog} from "@/lib/provider-catalog/cache";
import {
  countUnackedCatalogNotifications,
  importLegacyCatalogNotifications,
  loadCatalogNotification,
  queryCatalogNotifications,
} from "@/lib/provider-catalog/notification-store";
import {readPricingConfig} from "@/lib/pricing";
import {getLaunchNonceStore} from "@/lib/development-launch/security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const DATA_DIR = resolveDeepaaDataDir();

/**
 * 官方目录更新通知栏（v2 七章：自动生效 + 通知已阅制；2026-09-10 列表化改造）：
 * 只读且绝不触网（allowRemote:false——远程刷新只由 1 小时后端定时任务执行）。
 *
 * 查询参数：
 * - `revisions`：版本号多选筛选（逗号分隔，空 = 不过滤）
 * - `acked`：已阅状态多选（unread / read，逗号分隔，空 = 不过滤）
 * - `sources`：变更来源多选（official_preset / manual_override / litellm_auto）
 * - `page` / `pageSize`：分页（pageSize 仅接受 10/30/50/100，缺省 10）
 * - `detail`：指定版本号时返回该版本完整 Diff（展开明细）
 */
export async function GET(request: Request): Promise<Response> {
  const nonce = getLaunchNonceStore().issue();
  try {
    const url = new URL(request.url);
    // 只取一次性 nonce（变更前调用）：nonce 单次消费，长驻弹窗复用同一值必然失效。
    if (url.searchParams.get("nonceOnly") === "1") {
      return jsonResponse({nonce});
    }
    const db = getDeepaaDatabase(DATA_DIR);
    // 存量续承：旧版存在价格中心 JSON 的 notifications 首次导入 SQLite（幂等）。
    const pricing = await readPricingConfig(DATA_DIR);
    importLegacyCatalogNotifications(db, pricing.catalogSync?.notifications);

    const detailRevision = url.searchParams.get("detail");
    if (detailRevision) {
      const notification = loadCatalogNotification(db, detailRevision);
      return jsonResponse({nonce, notification: notification ?? null});
    }
    const page = queryCatalogNotifications(db, {
      revisions: splitParam(url.searchParams.get("revisions")),
      acked: splitParam(url.searchParams.get("acked")).filter(value => value === "unread" || value === "read") as Array<"unread" | "read">,
      sources: splitParam(url.searchParams.get("sources")).filter(value =>
        value === "official_preset" || value === "manual_override" || value === "litellm_auto") as Array<"official_preset" | "manual_override" | "litellm_auto">,
      page: Number(url.searchParams.get("page")) || 1,
      pageSize: Number(url.searchParams.get("pageSize")) || 10,
    });
    const envelope = await loadProviderCatalog(DATA_DIR, {allowRemote: false}).catch(() => undefined);
    return jsonResponse({
      nonce,
      ...page,
      unreadCount: page.unreadCount || countUnackedCatalogNotifications(db),
      hasUpdates: page.unreadCount > 0,
      publishedAt: envelope?.catalog.publishedAt,
      // 维护测试模式（DEEPAA_CATALOG_PATH）：通知弹窗据此给版本号加「测试」标注。
      maintenanceOverride: catalogOverridePath() !== undefined,
    });
  } catch (error) {
    console.error("[deepaa] provider catalog pricing updates query failed", error);
    return jsonResponse({
      nonce,
      rows: [], total: 0, page: 1, pageSize: 10, pageCount: 1,
      unreadCount: 0, revisions: [], hasUpdates: false,
    });
  }
}

function splitParam(value: string | null): string[] {
  if (!value) return [];
  return value.split(",").map(item => item.trim()).filter(Boolean).slice(0, 200);
}
