import type {
  PlanQuotaSnapshotInput,
  PlanSyncConnector,
  PlanSyncInput,
  SyncResult,
} from "../../types";
import {
  asRecord,
  fetchPlanJson,
  finiteNumber,
  normalizeResetAt,
  resolveRequiredPlanCredential,
} from "./shared";

const KIMI_USAGE_URL = "https://api.kimi.com/coding/v1/usages";

/** 兼容 limit/used 直接给出，或 limit/remaining 反推；缺失 total 时允许只展示 used。 */
function absoluteQuota(
  raw: unknown,
  windowLabel: string,
  unit = "quota",
): PlanQuotaSnapshotInput | undefined {
  const record = asRecord(raw);
  const total = finiteNumber(record?.limit);
  const remaining = finiteNumber(record?.remaining);
  let used = finiteNumber(record?.used);
  if (used === undefined && total !== undefined) {
    if (remaining !== undefined && total >= 0 && remaining >= 0) {
      used = Math.max(total - remaining, 0);
    }
  }
  if (used === undefined && total === undefined) return undefined;
  return {
    planName: "Kimi For Coding",
    windowLabel,
    used,
    total,
    ...(remaining !== undefined && remaining >= 0 ? {remaining} : {}),
    unit,
    resetAt: kimiResetAt(record),
    raw,
  };
}

/** 兼容 resetAt/resetTime 绝对时间与 resetIn/ttl/window.duration 相对秒数。 */
function kimiResetAt(record: Record<string, unknown> | undefined): string | undefined {
  if (!record) return undefined;
  for (const key of ["reset_at", "resetAt", "reset_time", "resetTime"]) {
    const normalized = normalizeResetAt(record[key]);
    if (normalized) return normalized;
  }
  for (const key of ["reset_in", "resetIn", "ttl"]) {
    const seconds = finiteNumber(record[key]);
    if (seconds !== undefined && seconds > 0) {
      return new Date(Date.now() + seconds * 1000).toISOString();
    }
  }
  const window = asRecord(record.window);
  if (window) {
    const duration = finiteNumber(window.duration);
    if (duration !== undefined && duration > 0) {
      return new Date(Date.now() + duration * 1000).toISOString();
    }
  }
  return undefined;
}

/** Kimi limits[] 是滚动短窗口，usage 是周窗口；monthly 为 2026-09 新档会员的月额度窗口（防御解析）。 */
export function parseKimiPlanQuota(payload: unknown): PlanQuotaSnapshotInput[] {
  const body = asRecord(payload);
  if (!body) return [];
  const data = asRecord(body.data);
  const usages = asRecord(data?.usages) ?? asRecord(body.usages);
  if (usages) {
    const snapshots: PlanQuotaSnapshotInput[] = [];
    const push = (keys: string[], windowLabel: string, unit = "quota"): void => {
      const raw = keys.map(key => usages[key]).find(value => value !== undefined);
      const snapshot = absoluteQuota(raw, windowLabel, unit);
      if (snapshot) snapshots.push(snapshot);
    };
    push(["limit5h", "limit_5h", "fiveHour"], "5h");
    push(["limit7d", "limit_7d", "sevenDay"], "weekly");
    push(["monthTotal", "month_total", "monthly"], "monthly");
    push(["monthCode", "month_code"], "monthly_code");
    push(["extraUsage", "extra_usage"], "extra_usage", "credits");
    if (snapshots.length > 0) return snapshots;
  }
  const rawLimits = data?.limits ?? body.limits;
  const limits = Array.isArray(rawLimits) ? rawLimits : [];
  const usage = data?.usage ?? body.usage;
  const snapshots: PlanQuotaSnapshotInput[] = [];
  for (const [index, item] of limits.entries()) {
    const detail = asRecord(item)?.detail;
    const snapshot = absoluteQuota(detail, index === 0 ? "5h" : `5h-${index + 1}`);
    if (snapshot) snapshots.push(snapshot);
  }
  const weekly = absoluteQuota(usage, "weekly");
  if (weekly) snapshots.push(weekly);
  // 新档会员（2026-09 改版 Go/Plus/Pro）官方口径仅 5h + 月额度、无周额度；
  // usages 响应的月窗字段名未经官方文档化，按 monthly/month 常见形态防御解析，
  // 命中即产出 monthly 快照，缺失时不影响老档周窗口语义。
  for (const key of ["monthly", "month"]) {
    const monthlyRaw = asRecord(data)?.[key] ?? body[key];
    const monthly = absoluteQuota(monthlyRaw, "monthly");
    if (monthly) {
      snapshots.push(monthly);
      break;
    }
  }
  return snapshots;
}

export class KimiCodingPlanAdapter implements PlanSyncConnector {
  readonly providerType = "kimi-coding" as const;
  readonly capabilities = {
    balance: false,
    rates: false,
    quota: true,
    auth: "api_key" as const,
  };

  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async sync(input: PlanSyncInput): Promise<SyncResult> {
    const apiKey = await resolveRequiredPlanCredential(
      input.credentialId,
      input.resolveCredential,
    );
    const payload = await fetchPlanJson(
      KIMI_USAGE_URL,
      `Bearer ${apiKey}`,
      this.fetchImpl,
    );
    return {providerType: this.providerType, planQuota: parseKimiPlanQuota(payload)};
  }
}
