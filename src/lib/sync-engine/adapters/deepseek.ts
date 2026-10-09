import {
  SyncUnsupportedError,
  type SyncConnector,
  type SyncInput,
  type SyncResult,
} from "../types";

const DEEPSEEK_TIMEOUT_MS = 15_000;

interface DeepSeekBalanceInfo {
  currency?: string;
  total_balance?: string | number;
  granted_balance?: string | number;
  topped_up_balance?: string | number;
}

/**
 * DeepSeek 官方余额适配器：GET {consoleBaseUrl}/user/balance（官方文档端点），
 * 使用供应商默认密钥（Agent 级默认密钥之一）作为 Bearer 凭据；
 * 官方价格为基准价，倍率恒为 1.0，无需同步。
 */
export class DeepSeekAdapter implements SyncConnector {
  readonly providerType = "deepseek" as const;
  readonly capabilities = {balance: true, rates: false, quota: false, auth: "manual" as const};

  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async sync(input: SyncInput): Promise<SyncResult> {
    const defaultCredentialId = input.defaultCredentialId;
    if (!defaultCredentialId) throw new SyncUnsupportedError("DEEPSEEK_DEFAULT_CREDENTIAL_MISSING");
    const apiKey = await input.resolveCredential(defaultCredentialId);
    if (!apiKey) throw new SyncUnsupportedError("DEEPSEEK_CREDENTIAL_EMPTY");

    const response = await this.fetchImpl(
      `${input.consoleBaseUrl.replace(/\/+$/u, "")}/user/balance`,
      {
        headers: {authorization: `Bearer ${apiKey}`},
        signal: AbortSignal.timeout(DEEPSEEK_TIMEOUT_MS),
      },
    );
    if (!response.ok) {
      throw new Error(`SYNC_HTTP_${response.status}`);
    }
    const json = (await response.json()) as {
      is_available?: boolean;
      balance_infos?: DeepSeekBalanceInfo[];
    };
    const info = json.balance_infos?.[0];
    const amount = Number(info?.total_balance);
    if (info === undefined || !Number.isFinite(amount)) {
      throw new SyncUnsupportedError("DEEPSEEK_BALANCE_INVALID");
    }
    return {
      providerType: "deepseek",
      balance: {
        currency: info.currency || "CNY",
        amount,
        source: "deepseek",
        raw: json,
      },
    };
  }
}
