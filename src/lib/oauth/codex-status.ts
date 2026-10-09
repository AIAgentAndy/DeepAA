import type {DevelopmentCredentialMetadata} from "@/lib/development-launch/types";

const UNUSABLE_SKEW_MS = 5 * 60_000;
const EXPIRING_WINDOW_MS = 24 * 60 * 60_000;

export type CredentialOAuthStatus =
  | {state: "not_oauth"}
  | {state: "active" | "expiring" | "expired"; expiresAt: string; message: string};

/**
 * 官方未提供可依赖的稳定刷新协议，因此状态只负责本地判断与重新登录引导。
 * 到期前 5 分钟与 credential-helper 保持一致，直接视为不可用。
 */
export function credentialOAuthStatus(
  credential: DevelopmentCredentialMetadata,
  now = Date.now(),
): CredentialOAuthStatus {
  if (credential.kind !== "oauth" || !credential.oauth) return {state: "not_oauth"};
  const expiresAt = credential.oauth.expiresAt;
  const timestamp = Date.parse(expiresAt);
  if (!Number.isFinite(timestamp) || timestamp <= now + UNUSABLE_SKEW_MS) {
    return {
      state: "expired",
      expiresAt,
      message: "Codex OAuth 登录已过期，请执行 codex login 重新登录（订阅通道无需重新导入）。",
    };
  }
  if (timestamp <= now + EXPIRING_WINDOW_MS) {
    return {
      state: "expiring",
      expiresAt,
      message: "Codex OAuth 登录将在 24 小时内到期，建议执行 codex login 重新登录（订阅通道无需重新导入）。",
    };
  }
  return {
    state: "active",
    expiresAt,
    message: "Codex OAuth 登录有效。",
  };
}

export function requireUsableCredential(
  credential: DevelopmentCredentialMetadata,
  now = Date.now(),
): void {
  if (credentialOAuthStatus(credential, now).state === "expired") {
    throw new Error("CREDENTIAL_OAUTH_EXPIRED");
  }
}
