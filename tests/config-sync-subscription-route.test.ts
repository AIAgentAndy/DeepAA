import {mkdtemp, readFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {expect, test, describe} from "vitest";
import type {CatalogOverrides, CatalogTemplate} from "../src/lib/config-sync/catalog-template.js";
import {buildCodexGatewayConfig} from "../src/lib/config-sync/adapters/codex.js";
import {buildClaudeUserSettings} from "../src/lib/config-sync/adapters/claude.js";
import {syncCliConfigs, type CliSyncPaths} from "../src/lib/config-sync/sync-manager.js";
import type {ProxyConfig, ProxyTarget} from "../src/types.js";

/**
 * 订阅路由形态守卫（2026-10-09 用户确认修订）：
 * - codex：ChatGPT 原生 wire（请求体无 model 字段，0.160 桌面 / 0.161 CLI 双端
 *   实证）无法经网关路由 → CLI 配置恒写占位 token（与登录态、订阅路由存在性
 *   无关）；订阅账号走「官方模式 + 通道 B 直连导入」。
 * - claude：messages wire 不随认证模式变化 → 保留路由级判据（存在
 *   anthropic-subscription 预设路由 + 本机 Claude 已登录 → 省略占位 token）。
 */

const GATEWAY_PATHS = {
  gatewayBaseUrl: "http://127.0.0.1:3211",
  gatewayBearerToken: "deepaa-gateway",
};

const TEST_TEMPLATE: CatalogTemplate = {
  defaults: {
    contextWindow: 272000,
    inputModalities: ["text"],
    supportedReasoningLevels: [
      {effort: "low", description: "low"},
      {effort: "high", description: "high"},
    ],
    defaultReasoningLevel: "high",
  },
  families: {},
  agents: {
    codex: {
      defaults: {
        wire_api: "responses",
        shell_type: "shell_command",
        visibility: "list",
        supported_in_api: true,
        priority: 0,
        support_verbosity: true,
        default_verbosity: "low",
        truncation_policy: {mode: "tokens", limit: 10000},
        supports_parallel_tool_calls: true,
        apply_patch_tool_type: "freeform",
        web_search_tool_type: "text",
        experimental_supported_tools: [],
        supports_image_detail_original: false,
        base_instructions: "You are Codex.",
      },
    },
  },
};

const TEST_OVERRIDES: CatalogOverrides = {};

function openAiSubscriptionTarget(): ProxyTarget {
  return {
    id: "chatgpt.com",
    name: "OpenAI 订阅",
    enabled: true,
    openaiUrl: "https://chatgpt.com/backend-api/codex",
    presetId: "openai-subscription",
    billingChannel: "subscription",
    supportedModels: ["gpt-6.1-sol"],
    supportedModelScopes: {"gpt-6.1-sol": ["codex"]},
    supportedModelWireApis: {"gpt-6.1-sol": ["responses"]},
    development: {defaultModels: {codex: "gpt-6.1-sol"}},
    createdAt: "2026-10-08T00:00:00.000Z",
  };
}

function anthropicSubscriptionTarget(): ProxyTarget {
  return {
    id: "api.anthropic.com",
    name: "Claude 订阅",
    enabled: true,
    anthropicUrl: "https://api.anthropic.com",
    presetId: "anthropic-subscription",
    billingChannel: "subscription",
    supportedModels: ["claude-sonnet-4-6"],
    supportedModelScopes: {"claude-sonnet-4-6": ["claude"]},
    supportedModelWireApis: {"claude-sonnet-4-6": ["messages"]},
    development: {defaultModels: {claude: "claude-sonnet-4-6"}},
    createdAt: "2026-10-08T00:00:00.000Z",
  };
}

function relayTarget(): ProxyTarget {
  return {
    id: "relay.example",
    name: "中转站",
    enabled: true,
    openaiUrl: "https://relay.example/v1",
    anthropicUrl: "https://relay.example",
    supportedModels: ["glm-5.3"],
    supportedModelScopes: {"glm-5.3": ["codex", "claude"]},
    supportedModelWireApis: {"glm-5.3": ["responses", "chat_completions", "messages"]},
    pricing: {
      vendor: "test",
      rateMultiplier: 1,
      modelVendors: {"glm-5.3": {vendor: "test", priceEntryId: "test:glm-5.3"}},
    },
    development: {
      defaultModels: {codex: "glm-5.3", claude: "glm-5.3"},
      defaultCredentials: {codex: "cred-relay-codex", claude: "cred-relay-claude"},
    },
    createdAt: "2026-10-08T00:00:00.000Z",
  };
}

function codexConfig(targets: ProxyTarget[]): ProxyConfig {
  return {
    version: 3,
    revision: 7,
    agentConnections: {
      codex: {boundTargetIds: targets.map(target => target.id), defaultTargetId: "relay.example", cliSyncEnabled: true},
    },
    targets,
    localProxyBaseUrl: "http://127.0.0.1:3211",
    updatedAt: "2026-10-08T00:00:00.000Z",
  };
}

function claudeConfig(targets: ProxyTarget[]): ProxyConfig {
  return {
    version: 3,
    revision: 7,
    agentConnections: {
      claude: {boundTargetIds: targets.map(target => target.id), defaultTargetId: "relay.example", cliSyncEnabled: true},
    },
    targets,
    localProxyBaseUrl: "http://127.0.0.1:3211",
    updatedAt: "2026-10-08T00:00:00.000Z",
  };
}

describe("Codex provider 恒占位形态（2026-10-09 ChatGPT wire 阻断回退）", () => {
  test("存在订阅路由模型时也恒写占位 token，绝不写 requires_openai_auth", () => {
    const result = buildCodexGatewayConfig(
      codexConfig([relayTarget(), openAiSubscriptionTarget()]),
      {codexCatalogPath: "/tmp/codex/deepaa/catalogs/all.json", ...GATEWAY_PATHS},
      TEST_TEMPLATE,
      TEST_OVERRIDES,
    );
    expect(result.active).toBe(true);
    expect(result.toml).toContain("experimental_bearer_token = \"deepaa-gateway\"");
    expect(result.toml).not.toContain("requires_openai_auth");
    expect(result.toml).toContain('name = "DeepAA 网关"');
    expect(result.toml).toContain("supports_websockets = false");
    // 中转站与订阅路由模型都进目录（订阅路由模型被选时由网关 401 防御引导官方模式）。
    expect(result.catalog).toContain("glm-5.3_relay.example");
    expect(result.catalog).toContain("gpt-6.1-sol_chatgpt.com");
  });

  test("仅中转站目标：行为与历史一致", () => {
    const result = buildCodexGatewayConfig(
      codexConfig([relayTarget()]),
      {codexCatalogPath: "/tmp/codex/deepaa/catalogs/all.json", ...GATEWAY_PATHS},
      TEST_TEMPLATE,
      TEST_OVERRIDES,
    );
    expect(result.toml).toContain("experimental_bearer_token = \"deepaa-gateway\"");
    expect(result.toml).not.toContain("requires_openai_auth");
  });
});

describe("Claude 凭据形态", () => {
  test("anthropic-subscription 路由 + 已登录 → 省略 ANTHROPIC_AUTH_TOKEN（默认目标为中转站）", () => {
    const result = buildClaudeUserSettings(
      claudeConfig([relayTarget(), anthropicSubscriptionTarget()]),
      GATEWAY_PATHS,
      {claudeCliLoggedIn: true},
    );
    expect(result.active).toBe(true);
    expect((result.settings.env as Record<string, string>).ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  });

  test("anthropic-subscription 路由 + 未登录 → 写占位 token（网关防御兜底）", () => {
    const result = buildClaudeUserSettings(
      claudeConfig([relayTarget(), anthropicSubscriptionTarget()]),
      GATEWAY_PATHS,
      {claudeCliLoggedIn: false},
    );
    expect((result.settings.env as Record<string, string>).ANTHROPIC_AUTH_TOKEN).toBe("deepaa-gateway");
  });

  test("无订阅路由 + 已登录 → 占位 token", () => {
    const result = buildClaudeUserSettings(
      claudeConfig([relayTarget()]),
      GATEWAY_PATHS,
      {claudeCliLoggedIn: true},
    );
    expect((result.settings.env as Record<string, string>).ANTHROPIC_AUTH_TOKEN).toBe("deepaa-gateway");
  });
});

describe("sync-manager 编排层登录态探测（claude-only）", () => {
  test("无 anthropic-subscription 路由时不探测；有路由时探测（codex 侧不再探测）", async () => {
    const root = await mkdtemp(join(tmpdir(), "cli-login-probe-"));
    const paths: CliSyncPaths = {
      codexConfigPath: join(root, "config.toml"),
      codexCatalogPath: join(root, "deepaa/catalogs/all.json"),
      claudeUserSettingsPath: join(root, "claude-settings.json"),
      claudeProjectSettingsPaths: {},
      gatewayBaseUrl: "http://127.0.0.1:3211",
      gatewayBearerToken: "deepaa-gateway",
    };
    let probeCalls = 0;
    const probe = async () => {
      probeCalls += 1;
      return {claude: true};
    };

    const codexOnlySubscription = await syncCliConfigs(
      codexConfig([relayTarget(), openAiSubscriptionTarget()]),
      {paths, credentialHelperPath: "/nonexistent/credential-helper", cliLoginProbe: probe},
    );
    expect(probeCalls).toBe(0);
    expect(codexOnlySubscription.ok).toBe(true);
    expect(await readFile(paths.codexConfigPath, "utf8")).not.toContain("requires_openai_auth");

    const claudeSubscription = await syncCliConfigs(
      claudeConfig([relayTarget(), anthropicSubscriptionTarget()]),
      {paths, credentialHelperPath: "/nonexistent/credential-helper", cliLoginProbe: probe},
    );
    expect(probeCalls).toBe(1);
    expect(claudeSubscription.ok).toBe(true);
    const claudeSettings = await readFile(paths.claudeUserSettingsPath, "utf8");
    expect(claudeSettings).not.toContain("ANTHROPIC_AUTH_TOKEN");
  });
});
