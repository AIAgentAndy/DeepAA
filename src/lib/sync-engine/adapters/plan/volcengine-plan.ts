import type {
  PlanQuotaSnapshotInput,
  PlanSyncConnector,
  PlanSyncInput,
  SyncResult,
} from "../../types";
import {SyncAuthRequiredError, SyncUnsupportedError} from "../../types";
import {asRecord, finiteNumber, normalizeResetAt, readBoundedPlanJson} from "./shared";
import {
  buildVolcengineCanonicalQuery,
  createVolcengineSignature,
  VOLCENGINE_CONTENT_TYPE,
  VOLCENGINE_OPENAPI_HOST,
} from "./volcengine-signature";

const DEFAULT_REGION = "cn-beijing";

function volcengineRegion(baseUrl: string): string {
  try {
    const matched = new URL(baseUrl).hostname.split(".")
      .find(part => /^(cn|ap)-[a-z0-9-]+$/u.test(part));
    return matched ?? DEFAULT_REGION;
  } catch {
    return DEFAULT_REGION;
  }
}

function authErrorCode(code: string): boolean {
  return /auth|signature|accessdenied|denied|unauthorized|forbidden|credential|token/iu.test(code);
}

function responseError(payload: unknown): {code: string; message: string} | undefined {
  const body = asRecord(payload);
  const metadata = asRecord(body?.ResponseMetadata);
  const error = asRecord(metadata?.Error) ?? asRecord(body?.Error);
  const code = typeof error?.Code === "string" ? error.Code : "";
  const message = typeof error?.Message === "string" ? error.Message : "";
  return code || message ? {code, message} : undefined;
}

/** 只保留官方控制台显示的 5 小时、周、月窗口，daily 不作为套餐约束展示。 */
export function parseVolcengineAfpQuota(payload: unknown): PlanQuotaSnapshotInput[] {
  const result = asRecord(payload);
  if (!result) return [];
  const planType = typeof result.PlanType === "string" && result.PlanType.trim()
    ? `火山方舟 Agent Plan ${result.PlanType.trim()}`
    : "火山方舟 Agent Plan";
  return [
    ["AFPFiveHour", "5h"],
    ["AFPWeekly", "weekly"],
    ["AFPMonthly", "monthly"],
  ].flatMap(([key, windowLabel]) => {
    const record = asRecord(result[key]);
    const total = finiteNumber(record?.Quota);
    const used = finiteNumber(record?.Used);
    if (total === undefined || used === undefined || total <= 0) return [];
    return [{
      planName: planType,
      windowLabel,
      used,
      total,
      unit: "AFP",
      resetAt: normalizeResetAt(record?.ResetTime),
      raw: record,
    }];
  });
}

function codingWindow(label: string): string | undefined {
  switch (label.toLowerCase()) {
    case "session":
    case "5h":
    case "fivehour":
    case "five_hour":
    case "rolling_5h":
      return "5h";
    case "weekly":
    case "week":
    case "7d":
      return "weekly";
    case "monthly":
    case "month":
      return "monthly";
    default:
      return undefined;
  }
}

/** Coding Plan 只返回已用百分比，故以 total=100 的百分比快照保存。 */
export function parseVolcengineCodingPlanQuota(payload: unknown): PlanQuotaSnapshotInput[] {
  const result = asRecord(payload);
  const rows = Array.isArray(result?.QuotaUsage)
    ? result.QuotaUsage
    : Array.isArray(result?.Usages)
      ? result.Usages
      : Array.isArray(result?.Details)
        ? result.Details
        : [];
  const snapshots: PlanQuotaSnapshotInput[] = [];
  for (const item of rows) {
    const record = asRecord(item);
    const label = [record?.Level, record?.Type, record?.Period, record?.Label, record?.Window]
      .find((value): value is string => typeof value === "string");
    const windowLabel = label ? codingWindow(label) : undefined;
    const used = finiteNumber(record?.Percent)
      ?? finiteNumber(record?.UsedPercent)
      ?? finiteNumber(record?.UsagePercent);
    if (!windowLabel || used === undefined) continue;
    snapshots.push({
      planName: "火山方舟 Coding Plan",
      windowLabel,
      used,
      total: 100,
      unit: "percent",
      resetAt: normalizeResetAt(record?.ResetTime ?? record?.ResetTimestamp),
      raw: record,
    });
  }
  return snapshots;
}

export class VolcenginePlanAdapter implements PlanSyncConnector {
  readonly providerType = "volcengine-plan" as const;
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
    if (!input.accessKeyRef) throw new SyncUnsupportedError("VOLCENGINE_ACCESS_KEY_REQUIRED");
    if (!input.secretKeyRef) throw new SyncUnsupportedError("VOLCENGINE_SECRET_KEY_REQUIRED");
    if (!input.resolveSecretReference) {
      throw new SyncUnsupportedError("VOLCENGINE_SECRET_RESOLVER_REQUIRED");
    }
    const [accessKeyId, secretAccessKey] = await Promise.all([
      input.resolveSecretReference(input.accessKeyRef),
      input.resolveSecretReference(input.secretKeyRef),
    ]);
    if (!accessKeyId) throw new SyncUnsupportedError("VOLCENGINE_ACCESS_KEY_EMPTY");
    if (!secretAccessKey) throw new SyncUnsupportedError("VOLCENGINE_SECRET_KEY_EMPTY");

    const region = volcengineRegion(input.baseUrl);
    const agentResult = await this.call("GetAFPUsage", region, accessKeyId, secretAccessKey);
    const agentQuota = parseVolcengineAfpQuota(asRecord(agentResult)?.Result ?? agentResult);
    if (agentQuota.length > 0) {
      return {providerType: this.providerType, planQuota: agentQuota};
    }
    // 2026-09-30 官方文档核对：GetCodingPlanUsage 在文档中心不存在（全量 API 清单遍历），
    // Coding Plan 兜底改用真实存在的 GetPersonalPlan（个人套餐查询）；其响应字段契约
    // 未公开文档化，解析保持防御式多形态兼容，实测失败属预期降级。
    const codingResult = await this.call("GetPersonalPlan", region, accessKeyId, secretAccessKey);
    return {
      providerType: this.providerType,
      planQuota: parseVolcengineCodingPlanQuota(asRecord(codingResult)?.Result ?? codingResult),
    };
  }

  private async call(
    action: "GetAFPUsage" | "GetPersonalPlan",
    region: string,
    accessKeyId: string,
    secretAccessKey: string,
  ): Promise<unknown> {
    const canonicalQuery = buildVolcengineCanonicalQuery(action, region);
    const signature = createVolcengineSignature({
      accessKeyId,
      secretAccessKey,
      region,
      canonicalQuery,
      now: this.now(),
    });
    const response = await this.fetchImpl(
      `https://${VOLCENGINE_OPENAPI_HOST}/?${canonicalQuery}`,
      {
        method: "POST",
        headers: {
          "x-date": signature.xDate,
          "x-content-sha256": signature.xContentSha256,
          "content-type": VOLCENGINE_CONTENT_TYPE,
          authorization: signature.authorization,
        },
        body: "",
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (response.status === 401 || response.status === 403) {
      throw new SyncAuthRequiredError(`VOLCENGINE_AUTH_${response.status}`);
    }
    let payload: unknown;
    try {
      payload = await readBoundedPlanJson(response);
    } catch (error) {
      if (!response.ok) throw new Error(`PLAN_HTTP_${response.status}`);
      throw error;
    }
    const error = responseError(payload);
    if (error && authErrorCode(error.code)) {
      throw new SyncAuthRequiredError(`VOLCENGINE_AUTH_${error.code}`);
    }
    if (!response.ok) throw new Error(`PLAN_HTTP_${response.status}`);
    if (error) throw new Error(`VOLCENGINE_API_${error.code || "UNKNOWN"}`);
    return payload;
  }
}
