import {describe, expect, test} from "vitest";
import type {ProxyConfig, ProxyTarget} from "../src/types.js";
import type {DevelopmentCredentialMetadata} from "../src/lib/development-launch/types.js";
import {resolveAgentConnection} from "../src/lib/agent-connections.js";

function makeTarget(overrides: Partial<ProxyTarget> = {}): ProxyTarget {
  return {
    id: "ai98pro",
    name: "ai98pro",
    enabled: true,
    openaiUrl: "https://proxy.example/v1",
    supportedModels: ["gpt-5.6"],
    supportedModelScopes: {"gpt-5.6": ["codex", "claude", "opencode", "dsh"]},
    supportedModelWireApis: {"gpt-5.6": ["responses", "chat_completions", "messages"]},
    pricing: {
      rateMultiplier: 1,
      modelVendors: {
        "gpt-5.6": {
          vendor: "openai",
          priceEntryId: "openai:gpt-5.6",
        },
      },
    },
    development: {
      defaultModels: {codex: "gpt-5.6"},
      defaultCredentials: {codex: "cred-codex"},
    },
    ...overrides,
  };
}

function makeConfig(overrides: Partial<ProxyConfig> = {}): ProxyConfig {
  return {
    version: 3,
    revision: 1,
    agentConnections: {},
    targets: [makeTarget()],
    localProxyBaseUrl: "http://localhost:3211",
    updatedAt: "2026-08-13T00:00:00.000Z",
    ...overrides,
  };
}

const credentials: DevelopmentCredentialMetadata[] = [
  {id: "cred-codex", targetId: "ai98pro", label: "Codex key", fingerprint: "****1234", agentScope: ["codex"]},
];

describe("resolveAgentConnection", () => {
  test("未接入 Agent 返回 disconnected，且不推断默认目标", () => {
    const result = resolveAgentConnection(makeConfig(), "codex", credentials);

    expect(result.status).toBe("disconnected");
    expect(result.target).toBeUndefined();
    expect(result.reasonCodes).toEqual(["AGENT_NOT_CONNECTED"]);
  });

  test("已接入但没有默认目标返回 pending", () => {
    const result = resolveAgentConnection(
      makeConfig({agentConnections: {codex: {cliSyncEnabled: true}}}),
      "codex",
      credentials,
    );

    expect(result.status).toBe("pending");
    expect(result.proxyReady).toBe(false);
    expect(result.reasonCodes).toContain("DEFAULT_TARGET_REQUIRED");
  });

  test("默认目标、模型、凭据和协议完整时返回 ready", () => {
    const result = resolveAgentConnection(
      makeConfig({agentConnections: {codex: {defaultTargetId: "ai98pro", cliSyncEnabled: true}}}),
      "codex",
      credentials,
    );

    expect(result.status).toBe("ready");
    expect(result.proxyReady).toBe(true);
    expect(result.cliSyncReady).toBe(true);
    expect(result.defaultModel).toBe("gpt-5.6");
    expect(result.defaultCredentialId).toBe("cred-codex");
    expect(result.defaultGatewayModel).toBe("gpt-5.6_ai98pro");
  });

  test("CLI 同步关闭不影响代理就绪度", () => {
    const result = resolveAgentConnection(
      makeConfig({agentConnections: {codex: {defaultTargetId: "ai98pro", cliSyncEnabled: false}}}),
      "codex",
      credentials,
    );

    expect(result.proxyReady).toBe(true);
    expect(result.cliSyncReady).toBe(false);
    expect(result.reasonCodes).toContain("CLI_SYNC_DISABLED");
  });

  test("模型归属不匹配时不可用", () => {
    const target = makeTarget({
      supportedModelScopes: {"gpt-5.6": ["claude"]},
    });
    const result = resolveAgentConnection(
      makeConfig({targets: [target], agentConnections: {codex: {defaultTargetId: "ai98pro", cliSyncEnabled: true}}}),
      "codex",
      credentials,
    );

    expect(result.status).toBe("pending");
    expect(result.reasonCodes).toContain("DEFAULT_MODEL_AGENT_SCOPE_MISMATCH");
  });

  test("凭据归属不匹配时不可用", () => {
    const result = resolveAgentConnection(
      makeConfig({agentConnections: {codex: {defaultTargetId: "ai98pro", cliSyncEnabled: true}}}),
      "codex",
      [{...credentials[0]!, agentScope: ["claude"]}],
    );

    expect(result.status).toBe("pending");
    expect(result.reasonCodes).toContain("DEFAULT_CREDENTIAL_AGENT_SCOPE_MISMATCH");
  });

  test("默认模型缺少 wire API 交集时不可用", () => {
    const target = makeTarget({
      supportedModelWireApis: {"gpt-5.6": ["messages"]},
    });
    const result = resolveAgentConnection(
      makeConfig({targets: [target], agentConnections: {codex: {defaultTargetId: "ai98pro", cliSyncEnabled: true}}}),
      "codex",
      credentials,
    );

    expect(result.status).toBe("pending");
    expect(result.reasonCodes).toContain("DEFAULT_MODEL_WIRE_API_MISMATCH");
  });
});
