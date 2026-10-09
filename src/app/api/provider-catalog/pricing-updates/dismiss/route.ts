import {jsonResponse} from "@/lib/app-state";
import {resolveDeepaaDataDir} from "@/lib/data-paths";
import {getDeepaaDatabase} from "@/lib/db/connection";
import {ackCatalogNotifications, countUnackedCatalogNotifications} from "@/lib/provider-catalog/notification-store";
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
 * 版本号格式（2026-09-10）：官方预设 `YYYY.MM.DD.NN`；人工覆盖 `manual-YYYY.MM.DD.HHmmss`；
 * LiteLLM 导入 `litellm-YYYY.MM.DD.HHmmss`。三者共用同一张通知表，均可标记已阅
 * （此前只接受官方格式，导致人工/LiteLLM 记录被拒为 INVALID_REQUEST）。
 */
const OFFICIAL_REVISION_PATTERN = /^\d{4}\.\d{2}\.\d{2}\.\d{2}$/u;
const CHANGE_REVISION_PATTERN = /^(?:manual|litellm)-\d{4}\.\d{2}\.\d{2}\.\d{6}$/u;
const MAX_ACK_REVISIONS = 50;

/**
 * 标记官方目录更新通知已阅（v2 七章「通知已阅制」，取代原确认制 dismiss/忽略）：
 * 知情动作不改变计费——变化在同步时已自动生效。支持逐条（revisions: string[]）
 * 或全部未阅（all: true）；幂等：重复已阅只刷新该通知 ackedAt，不改其余状态。
 */
export async function POST(request: Request): Promise<Response> {
  try {
    assertLocalMutationRequest(request);
    const body = await readBoundedJson(request);
    requireLaunchNonce(body);
    const input = normalizeAckInput(body);
    const ackedAt = new Date().toISOString();
    const db = getDeepaaDatabase(DATA_DIR);
    const acked = ackCatalogNotifications(db, input, ackedAt);
    return jsonResponse({
      ok: true,
      ackedAt,
      ackedCount: acked,
      unreadCount: countUnackedCatalogNotifications(db),
      nonce: getLaunchNonceStore().issue(),
    });
  } catch (error) {
    return developmentLaunchErrorResponse(error);
  }
}

export interface AckInput {
  revisions?: string[];
  all?: boolean;
}

export function normalizeAckInput(body: Record<string, unknown>): AckInput {
  const revisions = body.revisions;
  if (revisions !== undefined) {
    if (!Array.isArray(revisions) || revisions.length === 0 || revisions.length > MAX_ACK_REVISIONS) {
      throw new Error("INVALID_REQUEST");
    }
    for (const item of revisions) {
      if (typeof item !== "string"
        || (!OFFICIAL_REVISION_PATTERN.test(item) && !CHANGE_REVISION_PATTERN.test(item))) {
        throw new Error("INVALID_REQUEST");
      }
    }
  }
  const all = body.all === true;
  if (revisions === undefined && !all) throw new Error("INVALID_REQUEST");
  return {revisions: revisions as string[] | undefined, all};
}
