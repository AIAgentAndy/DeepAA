import {expect, test} from "vitest";
import {buildCodexGatewayConfig} from "../src/lib/config-sync/adapters/codex.js";
import {buildClaudeUserSettings} from "../src/lib/config-sync/adapters/claude.js";
import type {CatalogTemplate} from "../src/lib/config-sync/catalog-template.js";
import type {ProxyConfig, ProxyTarget} from "../src/types.js";

const template: CatalogTemplate = {
  defaults: {
    supportedReasoningLevels: [
      {effort: "low", description: "Fast responses with lighter reasoning"},
      {effort: "high", description: "Extra high reasoning depth for complex problems"},
      {effort: "max", description: "Maximum reasoning depth for the hardest problems"},
    ],
    defaultReasoningLevel: "high",
  },
  families: {
    "gpt-5.6": {contextWindow: 350000},
  },
  agents: {
    codex: {
      defaults: {
        wire_api: "responses",
        visibility: "list",
        base_instructions: "You are Codex.",
      },
    },
  },
};

const paths = {
  codexConfigPath: "/tmp/.codex/config.toml",
  codexCatalogPath: "/tmp/.codex/deepaa/catalogs/all.json",
  claudeUserSettingsPath: "/tmp/.claude/settings.json",
  claudeProjectSettingsPaths: {},
  gatewayBaseUrl: "http://localhost:3211",
};

function target(overrides: Partial<ProxyTarget> = {}): ProxyTarget {
  return {
    id: "shared-provider",
    name: "共享供应商",
    enabled: true,
    openaiUrl: "https://provider.example/openai/v1",
    anthropicUrl: "https://provider.example/anthropic/v1",
    supportedModels: ["gpt-5.6", "claude-sonnet-4-5"],
    pricing: {vendor: "test", rateMultiplier: 1, modelVendors: {
      "gpt-5.6": {vendor: "test", priceEntryId: "test:gpt-5.6"},
      "claude-sonnet-4-5": {vendor: "test", priceEntryId: "test:claude-sonnet-4-5"},
    }},
    supportedModelScopes: {
      "gpt-5.6": ["codex"],
      "claude-sonnet-4-5": ["claude"],
    },
    development: {
      defaultModels: {codex: "gpt-5.6", claude: "claude-sonnet-4-5"},
      defaultCredentials: {codex: "cred-codex", claude: "cred-claude"},
    },
    ...overrides,
  };
}

function config(overrides: Partial<ProxyConfig> = {}): ProxyConfig {
  return {
    version: 3,
    revision: 1,
    agentConnections: {},
    targets: [target()],
    localProxyBaseUrl: "http://localhost:3211",
    updatedAt: "2026-08-13T00:00:00.000Z",
    ...overrides,
  };
}

test("未接入 Agent 时生成空 Codex 受管层用于清理", () => {
  const result = buildCodexGatewayConfig(config(), paths, template, {});

  expect(result.active).toBe(false);
  expect(JSON.parse(result.catalog)).toEqual({models: []});
  expect(result.warnings.map(item => item.code)).toContain("AGENT_NOT_CONNECTED");
});

test("Codex 已接入且默认链完整时生成默认模型和目标目录", () => {
  const result = buildCodexGatewayConfig(
    config({agentConnections: {codex: {defaultTargetId: "shared-provider", cliSyncEnabled: true}}}),
    paths,
    template,
    {},
  );

  expect(result.active).toBe(true);
  expect(result.toml).toContain('model = "gpt-5.6_shared-provider"');
  expect(result.catalog).toContain("gpt-5.6_shared-provider");
  expect(result.catalog).not.toContain("claude-sonnet-4-5");
});

test("非官方中转模型使用产品窗口兜底：普通模型 272000，GPT-5.6-* 为 350000", () => {
  const relay = target({
    id: "relay.example",
    supportedModels: ["vendor-model", "gpt-5.6-sol"],
    supportedModelScopes: {"vendor-model": ["codex"], "gpt-5.6-sol": ["codex"]},
    // 2026-10-06 codex 目录与弹窗同口径（仅 responses 模型），夹具显式声明。
    supportedModelWireApis: {"vendor-model": ["responses"], "gpt-5.6-sol": ["responses"]},
    development: {
      defaultModels: {codex: "gpt-5.6-sol"},
      defaultCredentials: {codex: "cred-relay"},
    },
    pricing: {vendor: "test", rateMultiplier: 1, modelVendors: {
      "vendor-model": {vendor: "test", priceEntryId: "test:vendor-model"},
      "gpt-5.6-sol": {vendor: "test", priceEntryId: "test:gpt-5.6-sol"},
    }},
  });
  const result = buildCodexGatewayConfig(
    config({
      agentConnections: {codex: {defaultTargetId: relay.id, cliSyncEnabled: true}},
      targets: [relay],
    }),
    paths,
    {...template, defaults: {...template.defaults, context_window: 1048576}},
    {},
  );
  const models = (JSON.parse(result.catalog) as {models: Array<{slug: string; context_window: number}>}).models;
  expect(models.find(model => model.slug === "vendor-model_relay.example")?.context_window).toBe(272000);
  expect(models.find(model => model.slug === "gpt-5.6-sol_relay.example")?.context_window).toBe(350000);
});

test("关闭 CLI 同步或目标排除时生成空受管层但不改变代理配置", () => {
  const disabled = buildCodexGatewayConfig(
    config({agentConnections: {codex: {defaultTargetId: "shared-provider", cliSyncEnabled: false}}}),
    paths,
    template,
    {},
  );
  const excluded = buildCodexGatewayConfig(
    config({
      agentConnections: {codex: {defaultTargetId: "shared-provider", cliSyncEnabled: true}},
      targets: [target({cliSyncExclusions: ["codex"]})],
    }),
    paths,
    template,
    {},
  );

  expect(disabled.active).toBe(false);
  expect(disabled.warnings.map(item => item.code)).toContain("CLI_SYNC_DISABLED");
  expect(excluded.active).toBe(false);
  expect(excluded.warnings.map(item => item.code)).toContain("CLI_SYNC_TARGET_EXCLUDED");
});

test("默认模型缺少价格中心映射时仍生成受管配置并只告警", () => {
  const result = buildCodexGatewayConfig(
    config({
      agentConnections: {codex: {defaultTargetId: "shared-provider", cliSyncEnabled: true}},
      targets: [target({pricing: {vendor: "test", rateMultiplier: 1}})],
    }),
    paths,
    template,
    {},
  );

  expect(result.active).toBe(true);
  expect(result.warnings.map(item => item.code)).toContain("MODEL_PRICE_MAPPING_REQUIRED");
});

test("官方预设仅支持 chat/completions 时 Codex 不生成受管配置", () => {
  const glm = target({
    id: "zhipu-cn",
    openaiUrl: "https://open.bigmodel.cn/api/paas/v4",
    anthropicUrl: "https://open.bigmodel.cn/api/anthropic",
  });
  const result = buildCodexGatewayConfig(
    config({
      agentConnections: {codex: {boundTargetIds: [glm.id], defaultTargetId: glm.id, cliSyncEnabled: true}},
      targets: [glm],
    }),
    paths,
    template,
    {},
  );

  // Codex 只支持 Responses，chat 预设不可用时目标被排除并输出 warning。
  expect(result.active).toBe(false);
  expect(result.warnings.map(item => item.code)).toContain("PRESET_WIRE_API_UNSUPPORTED");
});

test("Codex CLI 目录只同步 Agent 已绑定的目标", () => {
  const defaultTarget = target({id: "default.example"});
  const boundTarget = target({id: "bound.example"});
  const cfg = config({
    agentConnections: {
      codex: {
        boundTargetIds: [defaultTarget.id],
        defaultTargetId: defaultTarget.id,
        cliSyncEnabled: true,
      },
    },
    targets: [defaultTarget, boundTarget],
  });

  const result = buildCodexGatewayConfig(cfg, paths, template, {});

  expect(result.catalog).toContain("gpt-5.6_default.example");
  expect(result.catalog).not.toContain("gpt-5.6_bound.example");
});

test("Claude 别名从 Agent 全局连接读取，无连接时清理受管 model", () => {
  const disconnected = buildClaudeUserSettings(config(), paths);
  expect(disconnected.active).toBe(false);
  expect(disconnected.settings).toEqual({env: {}, model: null});

  const connected = buildClaudeUserSettings(
    config({
      agentConnections: {
        claude: {
          defaultTargetId: "shared-provider",
          cliSyncEnabled: true,
          modelAliases: {sonnet: "claude-sonnet-4-5_shared-provider"},
        },
      },
    }),
    paths,
  );
  const env = connected.settings.env as Record<string, string>;
  expect(connected.active).toBe(true);
  expect(env.ANTHROPIC_MODEL).toBe("claude-sonnet-4-5_shared-provider");
  expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("claude-sonnet-4-5_shared-provider");
});

test("订阅默认目标：Codex 恒占位（wire 阻断回退），Claude 已登录省略 AUTH_TOKEN", () => {
  const subOpenai = target({
    id: "openai-sub",
    billingChannel: "subscription",
    openaiUrl: "https://chatgpt.com/backend-api/codex",
    anthropicUrl: undefined,
    supportedModels: ["gpt-5.6-sol"],
    supportedModelScopes: {"gpt-5.6-sol": ["codex"]},
    pricing: {vendor: "test", modelVendors: {"gpt-5.6-sol": {vendor: "test", priceEntryId: "test:gpt-5.6-sol"}}},
    development: {defaultModels: {codex: "gpt-5.6-sol"}},
  });
  const subClaude = target({
    id: "anthropic-sub",
    billingChannel: "subscription",
    openaiUrl: undefined,
    anthropicUrl: "https://api.anthropic.com",
    supportedModels: ["claude-sonnet-4-5"],
    supportedModelScopes: {"claude-sonnet-4-5": ["claude"]},
    pricing: {vendor: "test", modelVendors: {"claude-sonnet-4-5": {vendor: "test", priceEntryId: "test:claude-sonnet-4-5"}}},
    development: {defaultModels: {claude: "claude-sonnet-4-5"}},
  });
  const cfg = config({
    agentConnections: {
      codex: {defaultTargetId: "openai-sub", cliSyncEnabled: true},
      claude: {defaultTargetId: "anthropic-sub", cliSyncEnabled: true},
    },
    targets: [subOpenai, subClaude],
  });

  // 2026-10-09 用户确认回退：codex 因 ChatGPT 原生 wire（body 无 model 字段，
  // 0.160 桌面 / 0.161 CLI 双端实证）无法经网关路由，CLI 配置恒写占位 token——
  // 即使订阅目标为默认目标（订阅账号走「官方模式 + 通道 B 直连导入」）。
  const codex = buildCodexGatewayConfig(cfg, paths, template, {});
  expect(codex.active).toBe(true);
  expect(codex.toml).toContain("experimental_bearer_token = \"deepaa-gateway\"");
  expect(codex.toml).not.toContain("requires_openai_auth");
  expect(codex.toml).toContain("supports_websockets = false");
  expect(codex.toml).toContain('name = "DeepAA 网关"');

  const claude = buildClaudeUserSettings(cfg, paths, {claudeCliLoggedIn: true});
  const env = claude.settings.env as Record<string, string>;
  expect(claude.active).toBe(true);
  expect(env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:3211/claude");
  expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  expect(claude.warnings.map(item => item.code)).not.toContain("CREDENTIAL_MISSING");
});

test("按量默认目标仍写占位 token", () => {
  const codex = buildCodexGatewayConfig(
    config({agentConnections: {codex: {defaultTargetId: "shared-provider", cliSyncEnabled: true}}}),
    paths,
    template,
    {},
  );
  expect(codex.toml).toContain('experimental_bearer_token = "deepaa-gateway"');
  expect(codex.toml).not.toContain("requires_openai_auth");
  expect(codex.toml).toContain('name = "DeepAA 网关"');

  const claude = buildClaudeUserSettings(
    config({agentConnections: {claude: {defaultTargetId: "shared-provider", cliSyncEnabled: true}}}),
    paths,
  );
  expect((claude.settings.env as Record<string, string>).ANTHROPIC_AUTH_TOKEN)
    .toBe("deepaa-gateway");
});
