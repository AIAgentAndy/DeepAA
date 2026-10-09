/**
 * OpenAI 订阅（ChatGPT/Codex OAuth）套餐适配器。
 *
 * 只读本机 Codex CLI 凭据（~/.codex/auth.json，auth_mode=chatgpt），
 * 调用官方 wham/usage 接口同步 5h/周/30 天等百分比窗口。
 * 凭据绝不落盘、绝不自行刷新；过期时提示重新执行 codex login。
 */

import {
  fetchOfficialUsage,
  parseOpenAiWhamUsage,
  readCodexOAuthAuth,
} from "../../subscription-oauth";
import {
  SyncAuthRequiredError,
  type PlanSyncConnector,
  type PlanSyncInput,
  type SyncResult,
} from "../../types";

const OPENAI_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const REQUEST_TIMEOUT_MS = 15_000;

export class OpenAiSubscriptionPlanAdapter implements PlanSyncConnector {
  readonly providerType = "openai-subscription" as const;
  readonly capabilities = {
    balance: false,
    rates: false,
    quota: true,
    auth: "oauth" as const,
  };

  constructor(private readonly options: {
    codexHome?: string;
    fetchImpl?: typeof fetch;
  } = {}) {}

  async sync(_input: PlanSyncInput): Promise<SyncResult> {
    const auth = await readCodexOAuthAuth(this.options.codexHome);
    if (!auth) throw new SyncAuthRequiredError("SUBSCRIPTION_OAUTH_NOT_FOUND");
    const response = await fetchOfficialUsage(OPENAI_USAGE_URL, {
      headers: {
        authorization: `Bearer ${auth.accessToken}`,
        accept: "application/json",
        "user-agent": "codex-cli",
        ...(auth.accountId ? {"chatgpt-account-id": auth.accountId} : {}),
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }, this.options.fetchImpl);
    if (response.status === 401 || response.status === 403) {
      throw new SyncAuthRequiredError("SUBSCRIPTION_OAUTH_REJECTED");
    }
    if (!response.ok) throw new Error(`PLAN_HTTP_${response.status}`);
    const payload: unknown = await response.json();
    return {providerType: this.providerType, planQuota: parseOpenAiWhamUsage(payload)};
  }
}
