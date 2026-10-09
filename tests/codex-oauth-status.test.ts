import {describe, expect, test} from "vitest";
import {credentialOAuthStatus, requireUsableCredential} from "../src/lib/oauth/codex-status.js";
import type {DevelopmentCredentialMetadata} from "../src/lib/development-launch/types.js";

function oauth(expiresAt: string): DevelopmentCredentialMetadata {
  return {
    id: "cred_oauth",
    targetId: "openai",
    label: "Codex OAuth",
    kind: "oauth",
    store: "macos-keychain",
    account: "cred_oauth",
    fingerprintSuffix: "****",
    oauth: {
      provider: "openai",
      expiresAt,
      accessTokenCredentialId: "cred_oauth",
      refreshTokenCredentialId: "cred_oauth_refresh",
    },
    agentScope: ["codex"],
    createdAt: "2026-08-17T00:00:00.000Z",
    updatedAt: "2026-08-17T00:00:00.000Z",
  };
}

describe("Codex OAuth status", () => {
  test("区分有效、临期和已过期，并给出 codex login 引导", () => {
    const now = Date.parse("2026-08-17T00:00:00.000Z");
    expect(credentialOAuthStatus(oauth("2026-08-19T00:00:00.000Z"), now)).toMatchObject({state: "active"});
    expect(credentialOAuthStatus(oauth("2026-08-17T12:00:00.000Z"), now)).toMatchObject({
      state: "expiring",
      message: "Codex OAuth 登录将在 24 小时内到期，建议执行 codex login 重新登录（订阅通道无需重新导入）。",
    });
    expect(credentialOAuthStatus(oauth("2026-08-17T00:04:00.000Z"), now)).toEqual({
      state: "expired",
      expiresAt: "2026-08-17T00:04:00.000Z",
      message: "Codex OAuth 登录已过期，请执行 codex login 重新登录（订阅通道无需重新导入）。",
    });
  });

  test("过期 OAuth 阻止启动，API Key 不受影响", () => {
    const now = Date.parse("2026-08-17T00:00:00.000Z");
    expect(() => requireUsableCredential(oauth("2026-08-17T00:01:00.000Z"), now))
      .toThrow("CREDENTIAL_OAUTH_EXPIRED");
    expect(() => requireUsableCredential({...oauth("2026-08-17T00:01:00.000Z"), kind: "api_key", oauth: undefined}, now))
      .not.toThrow();
  });
});
