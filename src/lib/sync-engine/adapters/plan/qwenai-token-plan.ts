import type {
  PlanQuotaSnapshotInput,
  PlanSyncConnector,
  PlanSyncInput,
  SyncResult,
} from "../../types";
import {SyncUnsupportedError} from "../../types";
import {asRecord, finiteNumber, normalizeResetAt} from "./shared";

/** 千问 Token Plan 模型调用 Base URL；个人版套餐 usage 查询无稳定公开 API。 */
export const QWENAI_TOKEN_PLAN_BASE_URL = "https://token-plan.maas.qianwenaiapi.com/compatible-mode/v1";

/**
 * 千问 Token Plan 套餐适配器。
 *
 * 千问官方公开文档确认了专属 API Key/Base URL，但个人版套餐 usage 查询没有
 * 稳定公开的服务端契约；因此同步明确降级为控制台查看，不再错误调用旧 ACS3
 * GetSubscriptionStats。模型调用本身仍通过 preset 的专属 Base URL 工作。
 */
export class QwenAiTokenPlanAdapter implements PlanSyncConnector {
  readonly providerType = "qwenai-token-plan" as const;
  readonly capabilities = {
    balance: false,
    rates: false,
    quota: false,
    auth: "api_key" as const,
  };

  constructor(private readonly _fetchImpl: typeof fetch = fetch) {}

  async sync(input: PlanSyncInput): Promise<SyncResult> {
    void input;
    throw new SyncUnsupportedError("QWENAI_TOKEN_PLAN_USAGE_CONSOLE_ONLY");
  }
}

interface StatsSeatItem {
  SeatType?: string;
  SeatCredits?: number;
  SeatRemainingCredits?: number;
  SeatRefreshTime?: number;
  TotalSeats?: number;
}

/**
 * GetSubscriptionStats → 月度 Credits 快照：Data.Items[] 按席位规格分组（字段为
 * 官方 PascalCase 契约），已用量 = SeatCredits - SeatRemainingCredits；重置时间
 * 优先 SeatRefreshTime（本周期刷新时刻），回退订阅结束时间。
 */
export function parseQwenAiTokenPlanQuota(payload: unknown): PlanQuotaSnapshotInput[] {
  const body = asRecord(payload);
  const data = asRecord(body?.Data);
  const rawItems = Array.isArray(data?.Items) ? data.Items : [];
  const subscriptionEndTime = data?.SubscriptionEndTime;
  const snapshots: PlanQuotaSnapshotInput[] = [];
  for (const item of rawItems) {
    const record = asRecord(item);
    if (!record) continue;
    const seat = record as StatsSeatItem;
    const total = finiteNumber(seat.SeatCredits);
    const remaining = finiteNumber(seat.SeatRemainingCredits);
    if (total === undefined || total <= 0) continue;
    const used = remaining !== undefined ? Math.max(total - remaining, 0) : undefined;
    if (used === undefined) continue;
    const seatType = typeof seat.SeatType === "string" && seat.SeatType.trim() ? seat.SeatType.trim() : "";
    snapshots.push({
      planName: `百炼 Token Plan${seatType ? ` ${seatType}` : ""}`,
      windowLabel: "monthly",
      used,
      total,
      ...(remaining !== undefined && remaining >= 0 ? {remaining} : {}),
      unit: "credits",
      resetAt: normalizeResetAt(seat.SeatRefreshTime) ?? normalizeResetAt(subscriptionEndTime),
      raw: record,
    });
  }
  return snapshots;
}
