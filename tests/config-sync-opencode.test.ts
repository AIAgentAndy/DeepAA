import {expect, test} from "vitest";
import {parse as parseJsonc} from "jsonc-parser";
import type {CatalogTemplate} from "../src/lib/config-sync/catalog-template.js";
import {opencodeCliConfigAdapter, resolveOpenCodeConfigPath} from "../src/lib/config-sync/adapters/opencode.js";
import {createCliSyncContext} from "../src/lib/config-sync/core/sync-context.js";
import type {CliSyncPaths} from "../src/lib/config-sync/core/types.js";
import type {AgentId, ProxyConfig, ProxyTarget, WireApi} from "../src/types.js";

const LEGACY_BRAND_KEBAB = ["llm", "inspector"].join("-");

const template: CatalogTemplate = {
  defaults: {
    contextWindow: 272000,
    inputModalities: ["text"],
    supportedReasoningLevels: [
      {effort: "low", description: "Fast responses with lighter reasoning"},
      {effort: "high", description: "Extra high reasoning depth for complex problems"},
      {effort: "max", description: "Maximum reasoning depth for the hardest problems"},
    ],
    defaultReasoningLevel: "high",
  },
  families: {},
  agents: {},
};

const paths: CliSyncPaths = {
  codexConfigPath: "/tmp/codex/config.toml",
  codexCatalogPath: "/tmp/codex/catalogs/all.json",
  claudeUserSettingsPath: "/tmp/claude/settings.json",
  claudeProjectSettingsPaths: {},
  gatewayBaseUrl: "http://localhost:3211",
  gatewayBearerToken: "deepaa-gateway",
};

function target(overrides: Partial<ProxyTarget> & Pick<ProxyTarget, "id">): ProxyTarget {
  const supportedModels = overrides.supportedModels || ["deepseek-v4-flash", "claude-sonnet-4-5"];
  const supportedModelScopes = overrides.supportedModelScopes
    || Object.fromEntries(supportedModels.map(model => [model, ["codex", "claude", "opencode", "dsh"]]));
  const supportedModelWireApis = overrides.supportedModelWireApis || {
    "deepseek-v4-flash": ["responses", "chat_completions"] as WireApi[],
    "claude-sonnet-4-5": ["messages"] as WireApi[],
  };
  const base: ProxyTarget = {
    id: overrides.id,
    name: overrides.id,
    enabled: true,
    openaiUrl: `https://${overrides.id}/v1`,
    anthropicUrl: `https://${overrides.id}/anthropic/v1`,
    supportedModels,
    supportedModelScopes,
    supportedModelWireApis,
    pricing: {
      vendor: "test",
      rateMultiplier: 1,
      modelVendors: Object.fromEntries(supportedModels.map(modelId => [modelId, {vendor: "test", priceEntryId: `test:${modelId}`}])),
    },
    development: {
      defaultModels: {opencode: "deepseek-v4-flash"},
      defaultCredentials: {opencode: "cred-opencode"},
    },
    ...overrides,
  };
  return base;
}

function config(overrides: Partial<ProxyConfig> = {}): ProxyConfig {
  return {
    version: 3,
    revision: 1,
    agentConnections: {
      opencode: {
        boundTargetIds: ["shared-provider"],
        defaultTargetId: "shared-provider",
        cliSyncEnabled: true,
      },
    },
    targets: [target({id: "shared-provider"})],
    localProxyBaseUrl: "http://localhost:3211",
    updatedAt: "2026-08-13T00:00:00.000Z",
    ...overrides,
  };
}

function context(cfg: ProxyConfig, pathOverrides: Partial<CliSyncPaths> = {}, env: NodeJS.ProcessEnv = {}): ReturnType<typeof createCliSyncContext> {
  return createCliSyncContext({
    config: cfg,
    paths: {...paths, ...pathOverrides},
    template,
    overrides: {},
    homeDir: "/Users/test",
    env,
    platform: "darwin",
  });
}

test("模型 limit 同时提供 context 与 output（新版 opencode 配置校验要求）", () => {
  const ctx = context(config());
  const plan = opencodeCliConfigAdapter.build(ctx, opencodeCliConfigAdapter.resolvePaths(ctx));
  const content = JSON.parse(plan.artifacts[0]!.content) as Record<string, unknown>;
  const providers = content.provider as Record<string, Record<string, unknown>>;
  const responsesModels = providers["opencode-deepaa-gateway-responses"]!.models as Record<string, Record<string, unknown>>;
  const model = Object.values(responsesModels)[0]!;
  expect(model.limit).toMatchObject({context: 272000, output: 32768});
});

test("OpenCode 活跃链路生成三个受管 provider 且模型按 wire API 过滤", () => {
  const ctx = context(config());
  const plan = opencodeCliConfigAdapter.build(ctx, opencodeCliConfigAdapter.resolvePaths(ctx));

  expect(plan.active).toBe(true);
  expect(plan.artifacts).toHaveLength(1);
  const content = JSON.parse(plan.artifacts[0]!.content) as Record<string, unknown>;
  const providers = content.provider as Record<string, Record<string, unknown>>;
  expect(Object.keys(providers).sort()).toEqual([
    "opencode-deepaa-gateway-anthropic",
    "opencode-deepaa-gateway-chat",
    "opencode-deepaa-gateway-responses",
  ]);
  const responsesModels = providers["opencode-deepaa-gateway-responses"]!.models as Record<string, unknown>;
  const chatModels = providers["opencode-deepaa-gateway-chat"]!.models as Record<string, unknown>;
  const messagesModels = providers["opencode-deepaa-gateway-anthropic"]!.models as Record<string, unknown>;
  expect(Object.keys(responsesModels)).toEqual(["deepseek-v4-flash_shared-provider"]);
  expect(Object.keys(chatModels)).toEqual(["deepseek-v4-flash_shared-provider"]);
  expect(Object.keys(messagesModels)).toEqual(["claude-sonnet-4-5_shared-provider"]);
  expect(content.model).toBe("opencode-deepaa-gateway-responses/deepseek-v4-flash_shared-provider");
  expect(content.small_model).toBe(content.model);
  // 分组显示名统一三协议文案（2026-10-10）。
  expect(providers["opencode-deepaa-gateway-anthropic"]!.name).toBe("DeepAA 网关（Messages）");
  expect(providers["opencode-deepaa-gateway-responses"]!.name).toBe("DeepAA 网关（Responses）");
  expect(providers["opencode-deepaa-gateway-chat"]!.name).toBe("DeepAA 网关（Chat Completions）");
  expect(providers["opencode-deepaa-gateway-responses"]).toMatchObject({
    npm: "@ai-sdk/openai",
    options: {baseURL: "http://127.0.0.1:3211/opencode/v1", apiKey: "deepaa-gateway"},
  });
});

test("preferredWireApi=messages 时默认模型切换到 Anthropic provider", () => {
  const cfg = config({
    agentConnections: {
      opencode: {
        boundTargetIds: ["shared-provider"],
        defaultTargetId: "shared-provider",
        cliSyncEnabled: true,
        preferredWireApi: "messages",
      },
    },
    targets: [target({
      id: "shared-provider",
      development: {defaultModels: {opencode: "claude-sonnet-4-5"}, defaultCredentials: {opencode: "cred-opencode"}},
    })],
  });
  const ctx = context(cfg);
  const plan = opencodeCliConfigAdapter.build(ctx, opencodeCliConfigAdapter.resolvePaths(ctx));
  const content = JSON.parse(plan.artifacts[0]!.content) as Record<string, unknown>;
  expect(content.model).toBe("opencode-deepaa-gateway-anthropic/claude-sonnet-4-5_shared-provider");
});

test("未接入 / 关闭同步输出清理层并保留 warning", () => {
  const ctx = context(config({agentConnections: {}}));
  const plan = opencodeCliConfigAdapter.build(ctx, opencodeCliConfigAdapter.resolvePaths(ctx));
  expect(plan.active).toBe(false);
  expect(plan.artifacts[0]!.content.trim()).toBe("{}");
  expect(plan.warnings.map(item => item.code)).toContain("AGENT_NOT_CONNECTED");
});

test("订阅通道目标被排除并返回 SUBSCRIPTION_UNSUPPORTED", () => {
  const cfg = config({
    targets: [target({id: "shared-provider", billingChannel: "subscription"})],
  });
  const ctx = context(cfg);
  const plan = opencodeCliConfigAdapter.build(ctx, opencodeCliConfigAdapter.resolvePaths(ctx));
  expect(plan.active).toBe(false);
  expect(plan.warnings.map(item => item.code)).toContain("SUBSCRIPTION_UNSUPPORTED");
});

test("JSONC 深合并保留用户注释与其它 provider，清理层只删除受管段", () => {
  const legacyProvider = `opencode-${LEGACY_BRAND_KEBAB}-gateway-responses`;
  const existing = `{
  // 用户注释
  "provider": {
    "custom": { "npm": "@ai-sdk/custom", "models": {} },
    "${legacyProvider}": { "npm": "@ai-sdk/openai", "models": {} },
    "opencode-deepaa-gateway-responses": { "npm": "@ai-sdk/openai", "models": {} }
  },
  "model": "opencode-deepaa-gateway-responses/deepseek-v4-flash_shared-provider",
  "plugins": ["demo"]
}`;
  const ctx = context(config());
  const resolved = opencodeCliConfigAdapter.resolvePaths(ctx);
  const plan = opencodeCliConfigAdapter.build(ctx, resolved);
  const merged = opencodeCliConfigAdapter.mergeFile({
    file: opencodeCliConfigAdapter.files[0]!,
    existingRaw: existing,
    artifact: plan.artifacts[0]!,
  });
  expect(merged).toContain("// 用户注释");
  expect(merged).toContain('"custom"');
  expect(merged).toContain('"plugins"');
  const parsed = parseJsonc(merged) as Record<string, unknown>;
  const providers = parsed.provider as Record<string, unknown>;
  expect(Object.keys(providers).sort()).toEqual([
    "custom",
    "opencode-deepaa-gateway-anthropic",
    "opencode-deepaa-gateway-chat",
    "opencode-deepaa-gateway-responses",
  ]);
  expect(merged).not.toContain(`opencode-${LEGACY_BRAND_KEBAB}-gateway`);

  const inactive = opencodeCliConfigAdapter.mergeFile({
    file: opencodeCliConfigAdapter.files[0]!,
    existingRaw: merged,
    artifact: {specId: "opencode-global", path: "x", kind: "jsonc", active: false, content: "{}\n"},
  });
  const inactiveParsed = parseJsonc(inactive) as Record<string, unknown>;
  expect(Object.keys(inactiveParsed.provider as Record<string, unknown>)).toEqual(["custom"]);
  expect(inactiveParsed.model).toBeUndefined();
  expect(inactiveParsed.small_model).toBeUndefined();
  expect(inactive).toContain("// 用户注释");
});

test("validate 拒绝真实密钥与非法 provider 前缀", () => {
  const ctx = context(config());
  const resolved = opencodeCliConfigAdapter.resolvePaths(ctx);
  const plan = opencodeCliConfigAdapter.build(ctx, resolved);
  const badPlan = {
    ...plan,
    artifacts: [{
      ...plan.artifacts[0]!,
      content: JSON.stringify({
        provider: {"evil-provider": {options: {apiKey: "sk-real-key-123456789012345678"}}},
        model: "evil-provider/m",
      }),
    }],
  };
  expect(() => opencodeCliConfigAdapter.validate(badPlan)).toThrow(/OPENCODE_PLAN_INVALID|SECRET_IN_CLI_CONFIG/);
});

test("路径解析：显式文件 > 显式目录 > XDG_CONFIG_HOME > 平台默认", () => {
  expect(resolveOpenCodeConfigPath(context(config(), {opencodeConfigPath: "/custom/opencode.jsonc"})))
    .toBe("/custom/opencode.jsonc");
  expect(resolveOpenCodeConfigPath(context(config(), {}, {OPENCODE_CONFIG: "/env/config.json"})))
    .toBe("/env/config.json");
  expect(resolveOpenCodeConfigPath(context(config(), {}, {OPENCODE_CONFIG_DIR: "/env/dir"})))
    .toBe("/env/dir/opencode.jsonc");
  expect(resolveOpenCodeConfigPath(context(config(), {}, {XDG_CONFIG_HOME: "/xdg"})))
    .toBe("/xdg/opencode/opencode.jsonc");
  const win = createCliSyncContext({
    config: config(),
    paths,
    template,
    overrides: {},
    homeDir: "C:\\Users\\test",
    env: {APPDATA: "C:\\Users\\test\\AppData\\Roaming"},
    platform: "win32",
  });
  // opencode v2 在 Windows 同样读取 ~/.config/opencode（v2.0.26 实测 watcher
  // 订阅该目录）；%APPDATA%\opencode 是 2026-10-11 前的误写位置，TUI 读不到。
  expect(resolveOpenCodeConfigPath(win)).toBe("C:\\Users\\test\\.config\\opencode\\opencode.jsonc");
  // Windows 上显式 XDG_CONFIG_HOME 同样生效（与 opencode 路径库一致）。
  const winXdg = createCliSyncContext({
    config: config(),
    paths,
    template,
    overrides: {},
    homeDir: "C:\\Users\\test",
    env: {XDG_CONFIG_HOME: "C:\\xdg"},
    platform: "win32",
  });
  expect(resolveOpenCodeConfigPath(winXdg)).toBe("C:\\xdg\\opencode\\opencode.jsonc");
});

test("Agent 接入范围外的模型不会进入任何 provider", () => {
  const scoped = target({
    id: "shared-provider",
    supportedModels: ["deepseek-v4-flash", "claude-sonnet-4-5"],
    supportedModelScopes: {"deepseek-v4-flash": ["opencode"], "claude-sonnet-4-5": ["claude"]},
  });
  const ctx = context(config({targets: [scoped]}));
  const plan = opencodeCliConfigAdapter.build(ctx, opencodeCliConfigAdapter.resolvePaths(ctx));
  const content = JSON.parse(plan.artifacts[0]!.content) as Record<string, unknown>;
  const providers = content.provider as Record<string, Record<string, unknown>>;
  expect(Object.keys(providers["opencode-deepaa-gateway-responses"]!.models as Record<string, unknown>))
    .toEqual(["deepseek-v4-flash_shared-provider"]);
  expect(Object.keys(providers["opencode-deepaa-gateway-anthropic"]!.models as Record<string, unknown>))
    .toEqual([]);
});

test("AgentId 类型包含 opencode，注册表可穷尽遍历", () => {
  const agents: AgentId[] = ["codex", "claude", "opencode", "dsh"];
  expect(agents).toContain("opencode");
});

test("开发启动偏好：provider options 透传 reasoningEffort，limit.context 按网关模型 ID 覆盖", () => {
  const cfg = config();
  cfg.agentConnections.opencode!.launchPreferences = {
    reasoningEffort: "high",
    // 键为网关模型 ID（目标+模型复合键）。
    contextWindows: {"deepseek-v4-flash_shared-provider": 262144},
  };
  const ctx = context(cfg);
  const plan = opencodeCliConfigAdapter.build(ctx, opencodeCliConfigAdapter.resolvePaths(ctx));
  expect(plan.active).toBe(true);
  opencodeCliConfigAdapter.validate(plan);
  const generated = JSON.parse(plan.artifacts[0]!.content) as Record<string, any>;
  for (const providerId of Object.keys(generated.provider)) {
    expect(generated.provider[providerId].options.reasoningEffort).toBe("high");
  }
  // deepseek-v4-flash 的上下文被偏好覆盖，其它模型保持目录值。
  const responsesModels = generated.provider["opencode-deepaa-gateway-responses"].models;
  const overridden = Object.entries(responsesModels).find(([key]) => key.startsWith("deepseek-v4-flash_")) as [string, any];
  expect(overridden[1].limit.context).toBe(262144);
});
