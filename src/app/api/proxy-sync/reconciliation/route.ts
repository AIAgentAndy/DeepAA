import {jsonResponse} from "@/lib/app-state";
import {getSyncService} from "@/lib/sync-engine/service";
import {
  assertLocalMutationRequest,
  developmentLaunchErrorResponse,
  getLaunchNonceStore,
  readBoundedJson,
  requireLaunchNonce,
} from "@/lib/development-launch/security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** 小时结算视图；只返回待人工复核的小时（面板静默化，其余状态零出现）。 */
export async function GET(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    const targetId = url.searchParams.get("targetId")?.trim() || undefined;
    const limit = Math.min(50, Math.max(1, Number(url.searchParams.get("limit")) || 20));
    const cursor = url.searchParams.get("cursor")?.trim() || undefined;
    const service = await getSyncService();
    const result = service.listReconciliationHours({targetId, limit, cursor});
    return jsonResponse({
      ...result,
      nonce: getLaunchNonceStore().issue(),
    });
  } catch (error) {
    return developmentLaunchErrorResponse(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    assertLocalMutationRequest(request);
    const body = await readBoundedJson(request);
    requireLaunchNonce(body);
    const targetId = body.targetId;
    const hourStartUtc = body.hourStartUtc;
    if (body.windowId !== undefined) throw new Error("LEGACY_WINDOW_RECHECK_REQUIRED");
    if (typeof targetId !== "string" || !/^[a-z0-9.-]{1,128}$/u.test(targetId)
      || typeof hourStartUtc !== "string" || !Number.isFinite(Date.parse(hourStartUtc))
      || new Date(Date.parse(hourStartUtc)).toISOString() !== hourStartUtc
      || Date.parse(hourStartUtc) % 3_600_000 !== 0) {
      throw new Error("INVALID_REQUEST");
    }
    const service = await getSyncService();
    if (body.action === "ignore") {
      if (typeof body.reason !== "string" || body.reason.trim().length < 4
        || body.reason.trim().length > 512) throw new Error("RECONCILIATION_REASON_INVALID");
      service.ignoreReconciliationHour(targetId, hourStartUtc, body.reason);
      return jsonResponse({ok: true, nonce: getLaunchNonceStore().issue()});
    }
    if (body.action !== "apply") throw new Error("INVALID_REQUEST");
    if (typeof body.expectedResidualNano !== "number"
      || !Number.isSafeInteger(body.expectedResidualNano)
      || typeof body.expectedLastCheckedAt !== "string"
      || !Number.isFinite(Date.parse(body.expectedLastCheckedAt))
      || new Date(Date.parse(body.expectedLastCheckedAt)).toISOString() !== body.expectedLastCheckedAt) {
      throw new Error("INVALID_REQUEST");
    }
    const amountNano = await service.confirmReconciliationHour(
      targetId, hourStartUtc, body.expectedResidualNano, body.expectedLastCheckedAt);
    return jsonResponse({ok: true, amountNano, nonce: getLaunchNonceStore().issue()});
  } catch (error) {
    return developmentLaunchErrorResponse(error);
  }
}
