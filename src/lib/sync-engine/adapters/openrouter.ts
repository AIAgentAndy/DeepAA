import {
  SyncAuthRequiredError,
  SyncUnsupportedError,
  type SyncConnector,
  type SyncInput,
  type SyncResult,
} from "../types";

const TIMEOUT_MS = 15_000;

function finiteNumber(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

/**
 * OpenRouter 普通 API Key 优先走 /api/v1/key（limit_remaining/limit/usage）；
 * 不可用时回退 /api/v1/credits（Management Key，total_credits - total_usage）。
 */
export class OpenRouterBalanceAdapter implements SyncConnector {
  readonly providerType = "openrouter" as const;
  readonly capabilities = {balance: true, rates: false, quota: false, auth: "api_key" as const};

  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async sync(input: SyncInput): Promise<SyncResult> {
    if (!input.defaultCredentialId) throw new SyncUnsupportedError("OPENROUTER_DEFAULT_CREDENTIAL_MISSING");
    const apiKey = await input.resolveCredential(input.defaultCredentialId);
    if (!apiKey) throw new SyncUnsupportedError("OPENROUTER_CREDENTIAL_EMPTY");
    const base = input.consoleBaseUrl.replace(/\/+$/u, "");
    const headers = {authorization: `Bearer ${apiKey}`};
    const signal = AbortSignal.timeout(TIMEOUT_MS);
    const keyResponse = await this.fetchImpl(`${base}/api/v1/key`, {headers, signal});
    if (keyResponse.ok) {
      const json = await keyResponse.json() as {data?: Record<string, unknown>};
      const data = json.data;
      if (data) {
        const usage = finiteNumber(data.usage);
        const limit = finiteNumber(data.limit);
        const remaining = finiteNumber(data.limit_remaining);
        if (
          usage !== undefined
          || limit !== undefined
          || remaining !== undefined
          || data.is_free_tier === true
        ) {
          const amount = remaining
            ?? (limit !== undefined && usage !== undefined ? Math.max(0, limit - usage) : 0);
          return {
            providerType: this.providerType,
            balance: {
              currency: "USD",
              amount,
              ...(limit !== undefined ? {quota: limit} : {}),
              ...(usage !== undefined ? {usedQuota: usage} : {}),
              source: "openrouter",
              raw: json,
            },
          };
        }
      }
    }

    // 普通 API Key 接口不可用时回退 credits；401/403 统一映射为需人工鉴权。
    const creditsResponse = await this.fetchImpl(`${base}/api/v1/credits`, {headers, signal});
    if (creditsResponse.status === 401 || creditsResponse.status === 403) {
      throw new SyncAuthRequiredError(`SYNC_AUTH_${creditsResponse.status}`);
    }
    if (!creditsResponse.ok) throw new Error(`SYNC_HTTP_${creditsResponse.status}`);
    const creditsJson = await creditsResponse.json() as {data?: {total_credits?: number | string; total_usage?: number | string}};
    const total = Number(creditsJson.data?.total_credits);
    const used = Number(creditsJson.data?.total_usage ?? 0);
    if (!Number.isFinite(total) || !Number.isFinite(used)) throw new SyncUnsupportedError("OPENROUTER_CREDITS_INVALID");
    return {
      providerType: this.providerType,
      balance: {
        currency: "USD",
        amount: Math.max(0, total - used),
        quota: total,
        usedQuota: used,
        source: "openrouter",
        raw: creditsJson,
      },
    };
  }
}
