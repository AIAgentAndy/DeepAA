import {getSyncService} from "@/lib/sync-engine/service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * 供应商同步概览（只读、有界）：供应商管理侧栏与仪表盘供应商列表共用。
 *
 * 与 `/api/proxy-sync/status` 的区别：status 面向「当前选中的单个供应商」，
 * 会带 runs / credentialComparison / 全量套餐窗口；本路由面向「一屏列出全部供应商」，
 * 每目标只读取有界小表的最新一行（余额 / 主时间窗 / 倍率黄标计数）。
 * 目标数上限由服务端 `MAX_OVERVIEW_TARGETS` 强制，超出时返回 `limited: true`。
 */
export async function GET(request: Request) {
  try {
    const raw = new URL(request.url).searchParams.get("targets") || "";
    const targetIds = raw.split(",").map(value => value.trim()).filter(Boolean);
    if (targetIds.length === 0) throw new Error("INVALID_REQUEST");
    return Response.json(await (await getSyncService()).overview(targetIds));
  } catch (error) {
    return Response.json({
      error: error instanceof Error ? error.message : String(error),
    }, {status: 400});
  }
}
