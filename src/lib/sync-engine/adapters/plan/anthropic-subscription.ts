/**
 * Anthropic 订阅（Claude Max/Pro OAuth）套餐适配器。
 *
 * 只读本机 Claude CLI 凭据（macOS Keychain "Claude Code-credentials" 或
 * ~/.claude/.credentials.json），调用官方 api/oauth/usage 接口同步
 * 5h/周/模型级周窗口与 Extra Usage 美元额度。
 * 凭据绝不落盘、绝不自行刷新；过期时提示重新登录 Claude CLI。
 */

import {
  fetchOfficialUsage,
  parseAnthropicOAuthUsage,
  readClaudeOAuthCredentials,
} from "../../subscription-oauth";
import {
  SyncAuthRequiredError,
  type PlanSyncConnector,
  type PlanSyncInput,
  type SyncResult,
} from "../../types";

const ANTHROPIC_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const REQUEST_TIMEOUT_MS = 15_000;

export class AnthropicSubscriptionPlanAdapter implements PlanSyncConnector {
  readonly providerType = "anthropic-subscription" as const;
  readonly capabilities = {
    balance: false,
    rates: false,
    quota: true,
    auth: "oauth" as const,
  };

  constructor(private readonly options: {
    claudeHome?: string;
    fetchImpl?: typeof fetch;
  } = {}) {}

  async sync(_input: PlanSyncInput): Promise<SyncResult> {
    const accessToken = await readClaudeOAuthCredentials(this.options.claudeHome);
    if (!accessToken) throw new SyncAuthRequiredError("SUBSCRIPTION_OAUTH_NOT_FOUND");
    const response = await fetchOfficialUsage(ANTHROPIC_USAGE_URL, {
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: "application/json",
        "content-type": "application/json",
        "anthropic-beta": "oauth-2025-04-20",
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }, this.options.fetchImpl);
    if (response.status === 401 || response.status === 403) {
      throw new SyncAuthRequiredError("SUBSCRIPTION_OAUTH_REJECTED");
    }
    if (!response.ok) throw new Error(`PLAN_HTTP_${response.status}`);
    const payload: unknown = await response.json();
    return {providerType: this.providerType, planQuota: parseAnthropicOAuthUsage(payload)};
  }
}
