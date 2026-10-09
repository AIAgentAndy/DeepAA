import type {
  PlanQuotaSnapshotInput,
  PlanSyncConnector,
  PlanSyncInput,
  SyncResult,
} from "../../types";
import {SyncAuthRequiredError, SyncUnsupportedError} from "../../types";
import {asRecord, finiteNumber, normalizeResetAt, readBoundedPlanJson} from "./shared";
import {
  createTencentCloudSignature,
  TENCENT_CONTENT_TYPE,
  TENCENT_TOKENHUB_API_VERSION,
  TENCENT_TOKENHUB_HOST,
  TENCENT_TOKENHUB_REGION,
} from "./tencent-signature";

/** 个人版每账号最多持有 2 个套餐（通用 + Hy 各 1）；此处只做防御上限。 */
const MAX_TOKEN_PLANS_PER_SYNC = 4;

type TokenHubAction = "DescribeTokenPlanList" | "DescribeTokenPlan";

function authErrorCode(code: string): boolean {
  return /authfailure|invalidcredential|unauthorized|secretid|secretkey|missingcredential|accessdenied|denied|forbidden/iu.test(code);
}

function responseError(payload: unknown): {code: string; message: string} | undefined {
  const response = asRecord(payload)?.Response;
  const error = asRecord(asRecord(response)?.Error) ?? asRecord(asRecord(payload)?.Error);
  const code = typeof (error as {Code?: unknown} | undefined)?.Code === "string"
    ? (error as {Code: string}).Code
    : "";
  const message = typeof (error as {Message?: unknown} | undefined)?.Message === "string"
    ? (error as {Message: string}).Message
    : "";
  return code || message ? {code, message} : undefined;
}

function unwrapResponse(payload: unknown): unknown {
  return asRecord(payload)?.Response ?? payload;
}

/**
 * DescribeTokenPlanList → 套餐 TokenPlanId 列表。
 * 官方字段名未完全公开，按常见形态防御解析：TokenPlanSet/PlanList/TokenPlans
 * 数组的 TokenPlanId/PlanId，或顶层 PlanIds/TokenPlanIds 字符串数组。
 */
export function extractTokenPlanIds(payload: unknown): string[] {
  const result = unwrapResponse(payload);
  const record = asRecord(result);
  if (!record) return [];
  const ids: string[] = [];
  const rowArrays = ["TokenPlanSet", "PlanList", "TokenPlans", "PlanSet", "List"]
    .map(key => record[key])
    .filter(Array.isArray) as unknown[][];
  for (const rows of rowArrays) {
    for (const item of rows) {
      const row = asRecord(item);
      const id = [row?.TokenPlanId, row?.PlanId, row?.Id]
        .find((value): value is string => typeof value === "string" && value.trim().length > 0);
      if (id && !ids.includes(id)) ids.push(id);
    }
  }
  for (const key of ["PlanIds", "TokenPlanIds"]) {
    const raw = record[key];
    if (Array.isArray(raw)) {
      for (const item of raw) {
        if (typeof item === "string" && item.trim() && !ids.includes(item)) ids.push(item);
      }
    }
  }
  return ids.slice(0, MAX_TOKEN_PLANS_PER_SYNC);
}

function firstFinite(...values: unknown[]): number | undefined {
  for (const value of values) {
    const parsed = finiteNumber(value);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

/**
 * DescribeTokenPlan → 月度积分快照（专业套餐额度中心单位=积分）。
 * 官方口径「套餐基本信息及额度中心主额度包余量」；余量字段按防御形态解析：
 * QuotaPackage 子对象或顶层 TotalCredits/RemainCredits/UsedCredits、
 * TotalQuota/RemainQuota/UsedQuota 组合。
 */
export function parseTokenPlanQuota(payload: unknown): PlanQuotaSnapshotInput | undefined {
  const result = asRecord(unwrapResponse(payload));
  if (!result) return undefined;
  const quota = asRecord(result.QuotaPackage) ?? asRecord(result.Quota) ?? result;
  const total = firstFinite(
    quota.TotalCredits, quota.TotalQuota, quota.Total,
    result.TotalCredits, result.TotalQuota,
  );
  const remain = firstFinite(
    quota.RemainCredits, quota.RemainingCredits, quota.RemainQuota, quota.Remain, quota.Remaining,
    result.RemainCredits, result.RemainingCredits, result.RemainQuota,
  );
  const used = firstFinite(
    quota.UsedCredits, quota.UsedQuota, quota.Used,
    result.UsedCredits, result.UsedQuota,
  );
  if (total === undefined || total <= 0) return undefined;
  const resolvedUsed = used !== undefined ? used
    : remain !== undefined ? Math.max(total - remain, 0)
    : undefined;
  if (resolvedUsed === undefined) return undefined;
  const planName = [result.PlanName, result.Name, result.PlanType, result.PlanLevel]
    .find((value): value is string => typeof value === "string" && value.trim().length > 0);
  const planFamily = /(^|[\s_-])hy([\s_-]|$)/iu.test(`${result.PlanName ?? ""} ${result.PlanType ?? ""} ${result.PlanLevel ?? ""}`)
    ? "hy"
    : "common";
  const resetAt = normalizeResetAt(
    [result.ExpireTime, result.EndTime, result.CurrentPeriodEnd,
      quota.ExpireTime, quota.EndTime, asRecord(quota.ResetInfo)?.ResetTime,
    ].find(value => value !== undefined),
  );
  return {
    planName: `腾讯 TokenHub Token Plan${planName ? ` ${planName.trim()}` : ""}`,
    planFamily,
    windowLabel: "monthly",
    used: resolvedUsed,
    total,
    unit: "credits",
    resetAt,
    raw: result,
  };
}

/** 腾讯 TokenHub Token Plan 个人版用量：TC3 管控面 DescribeTokenPlanList → DescribeTokenPlan。 */
export class TencentTokenHubPlanAdapter implements PlanSyncConnector {
  readonly providerType = "tencent-tokenhub-plan" as const;
  readonly capabilities = {
    balance: false,
    rates: false,
    quota: true,
    auth: "access_key" as const,
  };

  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async sync(input: PlanSyncInput): Promise<SyncResult> {
    if (!input.accessKeyRef) throw new SyncUnsupportedError("TENCENT_SECRET_ID_REQUIRED");
    if (!input.secretKeyRef) throw new SyncUnsupportedError("TENCENT_SECRET_KEY_REQUIRED");
    if (!input.resolveSecretReference) {
      throw new SyncUnsupportedError("TENCENT_SECRET_RESOLVER_REQUIRED");
    }
    const [secretId, secretKey] = await Promise.all([
      input.resolveSecretReference(input.accessKeyRef),
      input.resolveSecretReference(input.secretKeyRef),
    ]);
    if (!secretId) throw new SyncUnsupportedError("TENCENT_SECRET_ID_EMPTY");
    if (!secretKey) throw new SyncUnsupportedError("TENCENT_SECRET_KEY_EMPTY");

    const listPayload = await this.call("DescribeTokenPlanList", "{}", secretId, secretKey);
    const planIds = extractTokenPlanIds(listPayload);
    if (planIds.length === 0) {
      throw new SyncUnsupportedError("TENCENT_TOKEN_PLAN_NOT_FOUND");
    }
    const snapshots: PlanQuotaSnapshotInput[] = [];
    for (const planId of planIds) {
      const detailPayload = await this.call(
        "DescribeTokenPlan",
        JSON.stringify({TokenPlanId: planId}),
        secretId,
        secretKey,
      );
      const snapshot = parseTokenPlanQuota(detailPayload);
      if (snapshot) snapshots.push(snapshot);
    }
    return {providerType: this.providerType, planQuota: snapshots};
  }

  private async call(
    action: TokenHubAction,
    payload: string,
    secretId: string,
    secretKey: string,
  ): Promise<unknown> {
    const signature = createTencentCloudSignature({
      secretId,
      secretKey,
      action,
      payload,
      now: this.now(),
    });
    const response = await this.fetchImpl(`https://${TENCENT_TOKENHUB_HOST}/`, {
      method: "POST",
      headers: {
        authorization: signature.authorization,
        "content-type": TENCENT_CONTENT_TYPE,
        host: TENCENT_TOKENHUB_HOST,
        "x-tc-action": signature.xTcAction,
        "x-tc-version": TENCENT_TOKENHUB_API_VERSION,
        "x-tc-region": TENCENT_TOKENHUB_REGION,
        "x-tc-timestamp": signature.xTcTimestamp,
      },
      body: payload,
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 401 || response.status === 403) {
      throw new SyncAuthRequiredError(`TENCENT_AUTH_${response.status}`);
    }
    let json: unknown;
    try {
      json = await readBoundedPlanJson(response);
    } catch (error) {
      if (!response.ok) throw new Error(`PLAN_HTTP_${response.status}`);
      throw error;
    }
    const error = responseError(json);
    if (error && authErrorCode(error.code)) {
      throw new SyncAuthRequiredError(`TENCENT_AUTH_${error.code}`);
    }
    if (!response.ok) throw new Error(`PLAN_HTTP_${response.status}`);
    if (error) throw new Error(`TENCENT_API_${error.code || "UNKNOWN"}`);
    return json;
  }
}
