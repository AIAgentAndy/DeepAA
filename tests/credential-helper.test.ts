import { describe, expect, test } from "vitest";
import { readFile } from "fs/promises";
import {
  buildMacCredentialCommand,
  buildWindowsCredentialCommand,
  resolveCredentialAccess,
  validateCredentialId,
} from "../bin/credential-helper.mjs";

describe("credential helper command construction", () => {
  test("rejects unsafe credential ids", () => {
    expect(() => validateCredentialId("../../secret")).toThrow("INVALID_CREDENTIAL_ID");
    expect(validateCredentialId("cred_safe-123")).toBe("cred_safe-123");
  });

  test("uses a macOS pseudo-terminal helper without placing the secret in argv", () => {
    const command = buildMacCredentialCommand("put", "cred_safe", "主密钥");

    expect(command.command).toBe("/usr/bin/expect");
    expect(command.args.join(" ")).toContain("macos-keychain-write.exp");
    expect(command.args.join(" ")).not.toContain("secret-value");
    // 服务名（2026-10-05 用户确认）：本地可见标识去个人化，锁死 dev.deepaa。
    expect(command.args).toContain("dev.deepaa");
  });

  test("macOS get/exists/delete 均使用 dev.deepaa 服务名", () => {
    for (const operation of ["get", "exists", "delete"] as const) {
      const command = buildMacCredentialCommand(operation, "cred_safe");
      expect(command.args).toContain("dev.deepaa");
      expect(command.args).not.toContain("com.aiagentandy.deepaa");
    }
  });

  test("answers both macOS Keychain password prompts", async () => {
    const source = await readFile(
      new URL("../bin/macos-keychain-write.exp", import.meta.url),
      "utf-8",
    );

    expect(source).toContain("password data for new item:");
    expect(source).toContain("retype password for new item:");
  });

  test("uses the bundled Windows credential adapter", () => {
    const command = buildWindowsCredentialCommand(
      "get",
      "cred_safe",
      "主密钥",
      "C:\\app\\bin\\windows-credential.ps1",
    );

    expect(command.command.toLowerCase()).toContain("powershell");
    expect(command.args).toContain("C:\\app\\bin\\windows-credential.ps1");
    expect(command.args).toContain("DeepAA:cred_safe");
  });

  test("OAuth 凭据只在有效期充足时返回 access token 引用", () => {
    const metadata = {
      id: "cred_oauth",
      kind: "oauth",
      oauth: {
        provider: "openai",
        expiresAt: "2026-08-17T01:00:00.000Z",
        accessTokenCredentialId: "cred_oauth",
        refreshTokenCredentialId: "cred_oauth_refresh",
      },
    };
    expect(resolveCredentialAccess(metadata, Date.parse("2026-08-17T00:00:00.000Z"))).toEqual({
      credentialId: "cred_oauth",
      kind: "oauth",
    });
    expect(() => resolveCredentialAccess(metadata, Date.parse("2026-08-17T00:56:00.000Z")))
      .toThrow("CREDENTIAL_OAUTH_EXPIRED");
  });

  test("API Key 和未知元数据保持旧凭据 ID，不读取 refresh token", () => {
    expect(resolveCredentialAccess(undefined, Date.now())).toEqual({credentialId: undefined, kind: "api_key"});
    expect(resolveCredentialAccess({id: "cred_api", kind: "api_key"}, Date.now())).toEqual({
      credentialId: "cred_api",
      kind: "api_key",
    });
  });
});
