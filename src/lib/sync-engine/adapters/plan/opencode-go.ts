import {
  SyncUnsupportedError,
  type PlanQuotaSnapshotInput,
  type PlanSyncConnector,
  type PlanSyncInput,
  type SyncResult,
} from "../../types";
import {
  asRecord,
  fetchPlanJson,
  finiteNumber,
  normalizeResetAt,
} from "./shared";

/** OpenCode Go 官方 usage 接口：rolling 映射为 5 小时窗口。 */
const OPENCODE_GO_WINDOWS = [
  ["rolling", "5h"],
  ["weekly", "weekly"],
  ["monthly", "monthly"],
] as const;

/** 兼容官方 percent + resetsAt、美元额度以及旧版 used/total 三种结构。 */
function openCodeGoWindowSnapshot(
  windowLabel: string,
  item: Record<string, unknown>,
): PlanQuotaSnapshotInput | undefined {
  // 状态字段存在且不是 ok 时视为该窗口不可用，避免把错误数据展示成余额。
  const status = typeof item.status === "string" ? item.status.trim() : "";
  if (status && status !== "ok") return undefined;
  const resetAt = openCodeGoResetAt(item);
  // 固定套餐名：目录档位表（llm_catalog planTiers）按该名精确匹配回填月费。
  const planName = "OpenCode Go";

  const percent =
    finiteNumber(item.percent)
    ?? finiteNumber(item.usagePercent)
    ?? finiteNumber(item.percentUsed)
    ?? finiteNumber(item.usage_percent)
    ?? finiteNumber(item.percent_used);
  if (percent !== undefined && percent >= 0 && percent <= 100) {
    return {
      planName,
      windowLabel,
      used: percent,
      total: 100,
      unit: "percent",
      resetAt,
      raw: item,
    };
  }

  const usageDollars = finiteNumber(item.usageDollars) ?? finiteNumber(item.usage_dollars);
  const limitDollars = finiteNumber(item.limitDollars) ?? finiteNumber(item.limit_dollars);
  if (usageDollars !== undefined || limitDollars !== undefined) {
    return {
      planName,
      windowLabel,
      used: usageDollars,
      total: limitDollars,
      unit: "USD",
      resetAt,
      raw: item,
    };
  }

  const used = finiteNumber(item.used);
  const total = finiteNumber(item.total);
  if (used === undefined && total === undefined) return undefined;
  return {planName, windowLabel, used, total, unit: "requests", resetAt, raw: item};
}

/** resetsAt/resetAt 为绝对时间；resetInSec 为秒级相对偏移，需单独换算。 */
function openCodeGoResetAt(item: Record<string, unknown>): string | undefined {
  for (const key of ["resetsAt", "resetAt", "resetAtISO", "reset_time"]) {
    const normalized = normalizeResetAt(item[key]);
    if (normalized) return normalized;
  }
  const resetInSec =
    finiteNumber(item.resetInSec)
    ?? finiteNumber(item.reset_in_sec)
    ?? finiteNumber(item.reset_in);
  if (resetInSec !== undefined && resetInSec >= 0) {
    return new Date(Date.now() + resetInSec * 1000).toISOString();
  }
  return undefined;
}

export class OpenCodeGoPlanAdapter implements PlanSyncConnector {
  readonly providerType = "opencode-go" as const;
  readonly capabilities = {balance: false, rates: false, quota: true, auth: "api_key" as const};

  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async sync(input: PlanSyncInput): Promise<SyncResult> {
    if (!input.credentialId) throw new SyncUnsupportedError("OPENCODE_GO_CREDENTIAL_REQUIRED");
    const apiKey = await input.resolveCredential(input.credentialId);
    if (!apiKey) throw new SyncUnsupportedError("OPENCODE_GO_CREDENTIAL_EMPTY");
    const payload = await fetchPlanJson(
      `${input.baseUrl.replace(/\/+$/u, "")}/usage`,
      `Bearer ${apiKey}`,
      this.fetchImpl,
    );
    const root = asRecord(payload);
    const usage = asRecord(root?.usage) ?? {};
    const planQuota = OPENCODE_GO_WINDOWS.flatMap(([source, windowLabel]) => {
      const item = asRecord(usage[source]);
      if (!item) return [];
      const snapshot = openCodeGoWindowSnapshot(windowLabel, item);
      return snapshot ? [snapshot] : [];
    });
    if (planQuota.length === 0) throw new SyncUnsupportedError("OPENCODE_GO_USAGE_INVALID");
    return {providerType: this.providerType, planQuota};
  }
}
