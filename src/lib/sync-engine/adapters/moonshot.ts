import {
  SyncUnsupportedError,
  type SyncConnector,
  type SyncInput,
  type SyncResult,
} from "../types";

const TIMEOUT_MS = 15_000;

/**
 * 官方余额端点固定在 API 域 api.moonshot.cn（platform.moonshot.cn / platform.kimi.com
 * 是控制台域，/v1 API 路径不提供且 platform.moonshot.cn 已 301 跳转 kimi.com 并 404，
 * 2026-09-30 实测确认；consoleBaseUrl 拼接方案随之废弃，不再依赖目标控制台地址）。
 */
const MOONSHOT_BALANCE_URL = "https://api.moonshot.cn/v1/users/me/balance";

/**
 * Moonshot / Kimi 官方余额适配器：GET https://api.moonshot.cn/v1/users/me/balance（官方文档端点），
 * 使用供应商默认密钥作为 Bearer 凭据。可用余额优先取 available_balance，其次 total_balance。
 */
export class MoonshotBalanceAdapter implements SyncConnector {
  readonly providerType = "kimi-coding" as const;
  readonly capabilities = {balance: true, rates: false, quota: false, auth: "api_key" as const};

  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async sync(input: SyncInput): Promise<SyncResult> {
    const defaultCredentialId = input.defaultCredentialId;
    if (!defaultCredentialId) throw new SyncUnsupportedError("MOONSHOT_DEFAULT_CREDENTIAL_MISSING");
    const apiKey = await input.resolveCredential(defaultCredentialId);
    if (!apiKey) throw new SyncUnsupportedError("MOONSHOT_CREDENTIAL_EMPTY");

    const response = await this.fetchImpl(
      MOONSHOT_BALANCE_URL,
      {
        headers: {authorization: `Bearer ${apiKey}`},
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
    );
    if (!response.ok) throw new Error(`SYNC_HTTP_${response.status}`);
    const json = (await response.json()) as {
      available_balance?: string | number;
      total_balance?: string | number;
      cash_balance?: string | number;
      data?: {
        available_balance?: string | number;
        total_balance?: string | number;
        cash_balance?: string | number;
      };
    };
    // 官方文档与 new-api/sub2api 实现均为 {code, data:{available_balance,...}} 嵌套
    // 结构（2026-10-05 三源核对）；顶层字段保留为旧形态回退，双形态兼容。
    const data = json.data ?? {};
    const amount = Number(
      data.available_balance ?? data.total_balance ?? data.cash_balance
      ?? json.available_balance ?? json.total_balance ?? json.cash_balance,
    );
    if (!Number.isFinite(amount)) {
      throw new SyncUnsupportedError("MOONSHOT_BALANCE_INVALID");
    }
    return {
      providerType: "kimi-coding",
      balance: {
        currency: "CNY",
        amount,
        source: "moonshot",
        raw: json,
      },
    };
  }
}
