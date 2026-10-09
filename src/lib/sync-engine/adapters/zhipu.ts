import {
  SyncUnsupportedError,
  type SyncConnector,
  type SyncInput,
  type SyncResult,
} from "../types";

const TIMEOUT_MS = 15_000;

interface ZhipuBalanceEntry {
  used?: number;
  remaining?: number;
  currency?: string;
}

/**
 * 智谱官方余额适配器：GET {consoleBaseUrl}/api/paas/v4/balance（官方文档端点），
 * 使用供应商默认密钥（Agent 级默认密钥之一）作为 Bearer 凭据。
 * 与 DeepSeek 一致：余额查询走 API Key，不走网页账号密码登录。
 */
export class ZhipuBalanceAdapter implements SyncConnector {
  readonly providerType = "zhipu" as const;
  readonly capabilities = {balance: true, rates: false, quota: false, auth: "api_key" as const};

  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async sync(input: SyncInput): Promise<SyncResult> {
    const defaultCredentialId = input.defaultCredentialId;
    if (!defaultCredentialId) throw new SyncUnsupportedError("ZHIPU_DEFAULT_CREDENTIAL_MISSING");
    const apiKey = await input.resolveCredential(defaultCredentialId);
    if (!apiKey) throw new SyncUnsupportedError("ZHIPU_CREDENTIAL_EMPTY");

    const response = await this.fetchImpl(
      `${input.consoleBaseUrl.replace(/\/+$/u, "")}/api/paas/v4/balance`,
      {
        headers: {authorization: `Bearer ${apiKey}`},
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
    );
    if (!response.ok) throw new Error(`SYNC_HTTP_${response.status}`);
    const json = (await response.json()) as {balance?: ZhipuBalanceEntry[]};
    const first = json.balance?.[0];
    const amount = Number(first?.remaining ?? first?.used);
    if (first === undefined || !Number.isFinite(amount)) {
      throw new SyncUnsupportedError("ZHIPU_BALANCE_INVALID");
    }
    return {
      providerType: "zhipu",
      balance: {
        currency: first.currency || "CNY",
        amount,
        source: "zhipu",
        raw: json,
      },
    };
  }
}
