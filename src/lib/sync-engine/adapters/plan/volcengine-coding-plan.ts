import type {
  PlanSyncConnector,
  PlanSyncInput,
  SyncResult,
} from "../../types";
import {SyncAuthRequiredError, SyncUnsupportedError} from "../../types";
import {asRecord, readBoundedPlanJson} from "./shared";
import {parseVolcengineCodingPlanQuota} from "./volcengine-plan";
import {
  buildVolcengineCanonicalQuery,
  createVolcengineSignature,
  VOLCENGINE_CONTENT_TYPE,
  VOLCENGINE_OPENAPI_HOST,
} from "./volcengine-signature";

const DEFAULT_REGION = "cn-beijing";
const ACTION = "GetCodingPlanUsage";

function regionFromBaseUrl(baseUrl: string): string {
  try {
    const region = new URL(baseUrl).hostname
      .split(".")
      .find(part => /^(cn|ap)-[a-z0-9-]+$/u.test(part));
    return region ?? DEFAULT_REGION;
  } catch {
    return DEFAULT_REGION;
  }
}

function isAuthError(code: string): boolean {
  return /auth|signature|accessdenied|denied|unauthorized|forbidden|credential|token/iu.test(code);
}

function responseError(payload: unknown): {code: string; message: string} | undefined {
  const root = asRecord(payload);
  const metadata = asRecord(root?.ResponseMetadata);
  const error = asRecord(metadata?.Error) ?? asRecord(root?.Error);
  const code = typeof error?.Code === "string" ? error.Code : "";
  const message = typeof error?.Message === "string" ? error.Message : "";
  return code || message ? {code, message} : undefined;
}

/**
 * 火山 Coding Plan 独立用量适配器。
 *
 * Agent Plan 使用 GetAFPUsage；Coding Plan 使用官方 OpenTOP
 * GetCodingPlanUsage。两者共用签名与 bounded JSON 基础设施，但不共用 RPC
 * 选择和错误降级，避免 Coding Plan 被误当成 Agent Plan 查询。
 */
export class VolcengineCodingPlanAdapter implements PlanSyncConnector {
  readonly providerType = "volcengine-coding-plan" as const;
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
    if (!input.accessKeyRef) throw new SyncUnsupportedError("VOLCENGINE_CODING_ACCESS_KEY_REQUIRED");
    if (!input.secretKeyRef) throw new SyncUnsupportedError("VOLCENGINE_CODING_SECRET_KEY_REQUIRED");
    if (!input.resolveSecretReference) {
      throw new SyncUnsupportedError("VOLCENGINE_CODING_SECRET_RESOLVER_REQUIRED");
    }
    const [accessKeyId, secretAccessKey] = await Promise.all([
      input.resolveSecretReference(input.accessKeyRef),
      input.resolveSecretReference(input.secretKeyRef),
    ]);
    if (!accessKeyId) throw new SyncUnsupportedError("VOLCENGINE_CODING_ACCESS_KEY_EMPTY");
    if (!secretAccessKey) throw new SyncUnsupportedError("VOLCENGINE_CODING_SECRET_KEY_EMPTY");

    const region = regionFromBaseUrl(input.baseUrl);
    const payload = await this.call(region, accessKeyId, secretAccessKey);
    const result = asRecord(payload)?.Result ?? payload;
    return {
      providerType: this.providerType,
      planQuota: parseVolcengineCodingPlanQuota(result),
    };
  }

  private async call(
    region: string,
    accessKeyId: string,
    secretAccessKey: string,
  ): Promise<unknown> {
    const canonicalQuery = buildVolcengineCanonicalQuery(ACTION, region);
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
      throw new SyncAuthRequiredError(`VOLCENGINE_CODING_AUTH_${response.status}`);
    }
    let payload: unknown;
    try {
      payload = await readBoundedPlanJson(response);
    } catch (error) {
      if (!response.ok) throw new Error(`PLAN_HTTP_${response.status}`);
      throw error;
    }
    const error = responseError(payload);
    if (error && isAuthError(error.code)) {
      throw new SyncAuthRequiredError(`VOLCENGINE_CODING_AUTH_${error.code}`);
    }
    if (!response.ok) throw new Error(`PLAN_HTTP_${response.status}`);
    if (error) throw new Error(`VOLCENGINE_CODING_API_${error.code || "UNKNOWN"}`);
    return payload;
  }
}
