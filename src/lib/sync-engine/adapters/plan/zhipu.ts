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

interface ZhipuEntry {
  classification?: "5h" | "weekly";
  percentage: number;
  used?: number;
  total?: number;
  remaining?: number;
  resetAt?: string;
  raw: unknown;
}

function zhipuQuotaBase(baseUrl: string): string {
  return baseUrl.toLowerCase().includes("bigmodel.cn")
    ? "https://bigmodel.cn"
    : "https://api.z.ai";
}

/** 显式 unit 优先；未知 unit 才按重置时间补齐尚未占用的窗口。 */
export function parseZhipuPlanQuota(payload: unknown): PlanQuotaSnapshotInput[] {
  const body = asRecord(payload);
  if (!body || body.success === false) return [];
  const data = asRecord(body.data);
  if (!data) return [];
  const planName = typeof data.level === "string" && data.level.trim()
    ? data.level.trim()
    : "智谱 Coding Plan";
  const limits = Array.isArray(data.limits) ? data.limits : [];
  const entries: ZhipuEntry[] = [];
  for (const item of limits) {
    const record = asRecord(item);
    const type = typeof record?.type === "string" ? record.type : "";
    if (!type.toUpperCase().includes("TOKENS_LIMIT")
      && !type.toUpperCase().includes("CREDIT_LIMIT")) continue;
    const percentage = finiteNumber(record?.percentage);
    if (percentage === undefined) continue;
    const usage = finiteNumber(record?.usage);
    const currentValue = finiteNumber(record?.currentValue);
    const remaining = finiteNumber(record?.remaining);
    const unit = finiteNumber(record?.unit);
    entries.push({
      classification: unit === 3 ? "5h" : unit === 6 ? "weekly" : undefined,
      percentage,
      ...(usage !== undefined && usage >= 0 && currentValue !== undefined && currentValue >= 0 && remaining !== undefined && remaining >= 0
        ? {used: currentValue, total: usage, remaining}
        : {}),
      resetAt: normalizeResetAt(record?.nextResetTime),
      raw: item,
    });
  }

  const assigned = new Map<"5h" | "weekly", ZhipuEntry>();
  const unclassified: ZhipuEntry[] = [];
  for (const entry of entries) {
    if (entry.classification && !assigned.has(entry.classification)) {
      assigned.set(entry.classification, entry);
    } else {
      unclassified.push(entry);
    }
  }
  unclassified.sort((left, right) => {
    if (!left.resetAt && right.resetAt) return -1;
    if (left.resetAt && !right.resetAt) return 1;
    return (left.resetAt ?? "").localeCompare(right.resetAt ?? "");
  });
  for (const entry of unclassified) {
    if (!assigned.has("5h")) assigned.set("5h", entry);
    else if (!assigned.has("weekly")) assigned.set("weekly", entry);
  }

  return (["5h", "weekly"] as const).flatMap(windowLabel => {
    const entry = assigned.get(windowLabel);
    return entry ? [{
      planName,
      windowLabel,
      used: entry.used ?? entry.percentage,
      total: entry.total ?? 100,
      ...(entry.remaining !== undefined ? {remaining: entry.remaining} : {}),
      unit: entry.total !== undefined ? "credits" : "percent",
      resetAt: entry.resetAt,
      raw: entry.raw,
    }] : [];
  });
}

export class ZhipuPlanAdapter implements PlanSyncConnector {
  readonly providerType = "zhipu" as const;
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
      `${zhipuQuotaBase(input.baseUrl)}/api/monitor/usage/quota/limit`,
      apiKey,
      this.fetchImpl,
    );
    return {providerType: this.providerType, planQuota: parseZhipuPlanQuota(payload)};
  }
}
