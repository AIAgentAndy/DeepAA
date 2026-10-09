import {mkdir, mkdtemp, readFile, readdir, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {expect, test} from "vitest";
import type {CatalogOverrides, CatalogTemplate} from "../src/lib/config-sync/catalog-template.js";
import {buildCodexGatewayConfig, codexCliConfigAdapter} from "../src/lib/config-sync/adapters/codex.js";
import {
  buildClaudeProjectSettings,
  buildClaudeUserSettings,
} from "../src/lib/config-sync/adapters/claude.js";
import {syncCliConfigs, type CliSyncPaths} from "../src/lib/config-sync/sync-manager.js";
import type {AgentId, ProxyConfig, ProxyTarget} from "../src/types.js";

const LEGACY_BRAND_SNAKE = ["llm", "inspector"].join("_");
const LEGACY_BRAND_KEBAB = ["llm", "inspector"].join("-");

const GATEWAY_PATHS: CliSyncPaths = {
  codexConfigPath: "/tmp/codex/config.toml",
  codexCatalogPath: "/tmp/codex/deepaa/catalogs/all.json",
  claudeUserSettingsPath: "/tmp/claude/settings.json",
  claudeProjectSettingsPaths: {"/tmp/project-a": "/tmp/project-a/.claude/settings.json"},
  gatewayBaseUrl: "http://localhost:3211",
  gatewayBearerToken: "deepaa-gateway",
};

const TEST_TEMPLATE: CatalogTemplate = {
  defaults: {
    contextWindow: 272000,
    inputModalities: ["text"],
    supportedReasoningLevels: [
      {effort: "low", description: "Fast responses with lighter reasoning"},
      {effort: "medium", description: "Balances speed and reasoning depth for everyday tasks"},
      {effort: "high", description: "Greater reasoning depth for complex problems"},
      {effort: "xhigh", description: "Extra high reasoning depth for complex problems"},
      {effort: "max", description: "Maximum reasoning depth for the hardest problems"},
    ],
    defaultReasoningLevel: "high",
  },
  families: {
    "gpt-5.6": {contextWindow: 350000},
    gpt: {inputModalities: ["text", "image"]},
    deepseek: {},
  },
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

function target(overrides: Partial<ProxyTarget> & Pick<ProxyTarget, "id">): ProxyTarget {
  const supportedModels = overrides.supportedModels || ["deepseek-v4-flash", "deepseek-reasoner"];
  const base: ProxyTarget = {
    id: overrides.id,
    name: overrides.id,
    enabled: true,
    openaiUrl: `https://${overrides.id}/v1`,
    supportedModels,
    supportedModelScopes: Object.fromEntries(supportedModels.map(model => [model, ["codex", "claude", "opencode", "dsh"]])),
    // 2026-10-06 起 codex 目录条目与弹窗同口径（仅 responses 模型入目录），
    // 夹具显式声明全协议能力以保持各 Agent 测试语义不变。
    supportedModelWireApis: Object.fromEntries(supportedModels.map(model => [model, ["responses", "chat_completions", "messages"]])),
    pricing: {
      vendor: "test",
      rateMultiplier: 1,
      modelVendors: Object.fromEntries(supportedModels.map(modelId => [modelId, {vendor: "test", priceEntryId: `test:${modelId}`}])) ,
    },
    development: {
      defaultModels: {codex: "deepseek-v4-flash"},
      defaultCredentials: {codex: `cred-${overrides.id.replace(/[^a-z0-9]/g, "-")}`},
    },
    createdAt: "2026-08-01T00:00:00.000Z",
  };
  return {...base, ...overrides};
}

function configWith(
  targets: ProxyTarget[],
  defaults: Partial<Record<AgentId, string>>,
): ProxyConfig {
  return {
    version: 3,
    revision: 7,
    agentConnections: {
      ...(defaults.codex ? {codex: {boundTargetIds: targets.map(target => target.id), defaultTargetId: defaults.codex, cliSyncEnabled: true}} : {}),
      ...(defaults.claude ? {claude: {boundTargetIds: targets.map(target => target.id), defaultTargetId: defaults.claude, cliSyncEnabled: true}} : {}),
    },
    targets,
    localProxyBaseUrl: "http://localhost:3211",
    updatedAt: "2026-08-13T00:00:00.000Z",
  };
}

test("Codex 网关配置只包含满足 V3 同步条件的 OpenAI 目标", () => {
  const ready = target({id: "api.deepseek.com", supportedModels: ["deepseek-v4-flash"]});
  const noProtocol = target({
    id: "api.anthropic.com",
    openaiUrl: undefined,
    anthropicUrl: "https://api.anthropic.com/v1",
    supportedModels: ["claude-sonnet-4-5"],
    development: {defaultModels: {claude: "claude-sonnet-4-5"}, defaultCredentials: {claude: "cred-claude"}},
  });
  const noCredential = target({id: "no-key.example", development: {defaultModels: {codex: "deepseek-v4-flash"}}});
  const noDefaultModel = target({id: "no-model.example", development: {defaultCredentials: {codex: "cred-no-model"}}});

  const result = buildCodexGatewayConfig(
    configWith([ready, noProtocol, noCredential, noDefaultModel], {codex: ready.id}),
    GATEWAY_PATHS,
    TEST_TEMPLATE,
    TEST_OVERRIDES,
  );

  expect(result.active).toBe(true);
  expect(result.toml).toContain("[model_providers.deepaa_gateway]");
  expect(result.toml).toContain('base_url = "http://127.0.0.1:3211/codex/v1"');
  expect(result.toml).toContain('model = "deepseek-v4-flash_api.deepseek.com"');
  expect(result.toml).not.toContain("[profiles.");
  expect(result.catalog).not.toContain("api.anthropic.com");
  expect(result.catalog).not.toContain("no-key.example");
  expect(result.warnings.map(item => item.code).sort()).toEqual([
    "CREDENTIAL_MISSING",
    "NO_MODELS",
    "PROTOCOL_EXCLUDED",
  ]);
});

test("Codex 合并清理前身 provider/profile/default 引用并保留用户配置", () => {
  const ready = target({id: "api.deepseek.com", supportedModels: ["deepseek-v4-flash"]});
  const generated = buildCodexGatewayConfig(
    configWith([ready], {codex: ready.id}),
    GATEWAY_PATHS,
    TEST_TEMPLATE,
    TEST_OVERRIDES,
  );
  const legacyProvider = `${LEGACY_BRAND_SNAKE}_gateway`;
  const existing = [
    'model = "legacy_api.deepseek.com"',
    `model_provider = "${legacyProvider}"`,
    `model_catalog_json = "/tmp/${LEGACY_BRAND_KEBAB}/catalog.json"`,
    "",
    `[model_providers.${legacyProvider}]`,
    'base_url = "http://127.0.0.1:3211/codex/v1"',
    `experimental_bearer_token = "${LEGACY_BRAND_KEBAB}-gateway"`,
    "",
    "[model_providers.user_provider]",
    'base_url = "https://user.example/v1"',
    "",
    `[profiles.${LEGACY_BRAND_SNAKE}_api_deepseek_com]`,
    'model = "legacy_api.deepseek.com"',
    `model_provider = "${legacyProvider}"`,
    "",
    "[mcp_servers.demo]",
    'command = "demo"',
  ].join("\n");
  const merged = codexCliConfigAdapter.mergeFile({
    file: codexCliConfigAdapter.files[0]!,
    existingRaw: existing,
    artifact: {specId: "codex-config", path: GATEWAY_PATHS.codexConfigPath, kind: "toml", active: true, content: generated.toml},
  });
  expect(merged).not.toContain(LEGACY_BRAND_SNAKE);
  expect(merged).not.toContain(LEGACY_BRAND_KEBAB);
  expect(merged).not.toContain("[profiles.");
  expect(merged).toContain("[model_providers.user_provider]");
  expect(merged).toContain("[mcp_servers.demo]");
  expect(merged).toContain('[model_providers.deepaa_gateway]');
});

test("Codex Catalog 条目满足 schema 且模板外模型自动补齐推理档位", () => {
  const ready = target({
    id: "ai98pro.xyz",
    supportedModels: ["deepseek-v4-flash", "j2-mid"],
    development: {defaultModels: {codex: "j2-mid"}, defaultCredentials: {codex: "cred-ai98"}},
  });
  const result = buildCodexGatewayConfig(
    configWith([ready], {codex: ready.id}),
    GATEWAY_PATHS,
    TEST_TEMPLATE,
    TEST_OVERRIDES,
  );
  const catalog = JSON.parse(result.catalog) as {models: Array<Record<string, unknown>>};
  expect(catalog.models).toHaveLength(2);

  for (const entry of catalog.models) {
    expect(entry.slug).toMatch(/^.+_ai98pro\.xyz$/);
    expect(entry.base_instructions).toEqual(expect.any(String));
    expect(entry.support_verbosity).toEqual(expect.any(Boolean));
    expect(entry.supports_parallel_tool_calls).toEqual(expect.any(Boolean));
    expect(entry.experimental_supported_tools).toEqual(expect.any(Array));
    expect(entry.truncation_policy).toMatchObject({mode: "tokens", limit: expect.any(Number)});
    expect(entry.visibility).toBe("list");
    expect(entry.apply_patch_tool_type).toBe("freeform");
    expect(entry.web_search_tool_type).toMatch(/^(text|text_and_image)$/);
    const levels = entry.supported_reasoning_levels as Array<Record<string, unknown>>;
    expect(levels.length).toBeGreaterThan(0);
    expect(levels.map(level => level.effort)).toContain(entry.default_reasoning_level);
    expect(levels.map(level => level.effort)).toContain("xhigh");
    expect(levels.map(level => level.effort)).toContain("max");
    expect(levels.every(level => typeof level.description === "string")).toBe(true);
  }
  // 推理档位兜底：模板外模型（无预设条目）按家族默认——j2-mid 非 gpt/claude 系 -> max
  const j2mid = catalog.models.find(item => item.slug === "j2-mid_ai98pro.xyz");
  expect(j2mid?.default_reasoning_level).toBe("max");
});

test("Codex Catalog 的 max_context_window 与 context_window 同源覆写", () => {
  // 模板 families 层为 gpt-5.6 家族兜底 350000（产品级保守值）；目标无价格中心映射时
  // 按家族兜底解析，max_context_window 必须跟随解析结果，不允许两字段矛盾。
  const ready = target({
    id: "ai98pro.xyz",
    supportedModels: ["gpt-5.6-sol", "deepseek-v4-flash"],
    development: {defaultModels: {codex: "gpt-5.6-sol"}, defaultCredentials: {codex: "cred-ai98"}},
  });
  const result = buildCodexGatewayConfig(
    configWith([ready], {codex: ready.id}),
    GATEWAY_PATHS,
    TEST_TEMPLATE,
    TEST_OVERRIDES,
  );
  const catalog = JSON.parse(result.catalog) as {models: Array<Record<string, number | string>>};
  const bySlug = Object.fromEntries(catalog.models.map(entry => [entry.slug as string, entry]));

  expect(bySlug["gpt-5.6-sol_ai98pro.xyz"]).toMatchObject({
    context_window: 350000,
    max_context_window: 350000,
    auto_compact_token_limit: 332500,
    // 推理档位推断：gpt 系列偏好 xhigh（表内存在）
    default_reasoning_level: "xhigh",
  });
  // deepseek 家族无模板兜底：走全局兜底 272000；档位推断非 gpt/claude 系 -> max
  expect(bySlug["deepseek-v4-flash_ai98pro.xyz"]).toMatchObject({default_reasoning_level: "max"});
  expect(bySlug["deepseek-v4-flash_ai98pro.xyz"]).toMatchObject({
    context_window: 272000,
    max_context_window: 272000,
    auto_compact_token_limit: 258400,
  });
});

test("Codex Catalog 开发启动偏好按网关模型 ID 覆盖窗口/压缩阈值/默认档（档位门控）", () => {
  const ready = target({
    id: "ai98pro.xyz",
    supportedModels: ["gpt-5.6-sol", "deepseek-v4-flash"],
    development: {defaultModels: {codex: "gpt-5.6-sol"}, defaultCredentials: {codex: "cred-ai98"}},
  });
  const cfg = configWith([ready], {codex: ready.id});
  cfg.agentConnections.codex!.launchPreferences = {
    reasoningEffort: "low",
    contextWindows: {"gpt-5.6-sol_ai98pro.xyz": 900000},
    autoCompactTokenLimits: {"gpt-5.6-sol_ai98pro.xyz": 850000},
  };
  const result = buildCodexGatewayConfig(cfg, GATEWAY_PATHS, TEST_TEMPLATE, TEST_OVERRIDES);
  const catalog = JSON.parse(result.catalog) as {models: Array<Record<string, any>>};
  const bySlug = Object.fromEntries(catalog.models.map(entry => [entry.slug as string, entry]));

  // 偏好覆盖（键为网关模型 ID = 目标+模型复合键）：双窗口字段/压缩阈值/默认档全部生效。
  expect(bySlug["gpt-5.6-sol_ai98pro.xyz"]).toMatchObject({
    context_window: 900000,
    max_context_window: 900000,
    auto_compact_token_limit: 850000,
    default_reasoning_level: "low",
  });
  // 同目标其它模型未被窗口/压缩阈值命中：保持共享解析层目录值与 95% 压缩线；
  // reasoningEffort 是 Agent 级偏好（与 zcode/dsh/opencode 语义一致），对该 Agent
  // 全部目录条目生效。
  expect(bySlug["deepseek-v4-flash_ai98pro.xyz"]).toMatchObject({
    context_window: 272000,
    max_context_window: 272000,
    auto_compact_token_limit: 258400,
    default_reasoning_level: "low",
  });

  // 档位门控：偏好档位不在档位表内时回退推断默认档并出 warning，不产生半应用状态。
  const gated = configWith([ready], {codex: ready.id});
  gated.agentConnections.codex!.launchPreferences = {reasoningEffort: "ultra"};
  const gatedResult = buildCodexGatewayConfig(gated, GATEWAY_PATHS, TEST_TEMPLATE, TEST_OVERRIDES);
  const gatedCatalog = JSON.parse(gatedResult.catalog) as {models: Array<Record<string, any>>};
  const gatedEntry = gatedCatalog.models.find(entry => entry.slug === "gpt-5.6-sol_ai98pro.xyz")!;
  expect(gatedEntry.default_reasoning_level).toBe("xhigh");
  expect(gatedResult.warnings.some(item => item.code === "LAUNCH_PREFERENCE_EFFORT_UNSUPPORTED")).toBe(true);

  // 未提供压缩阈值偏好时按覆盖后窗口重算 95% 压缩线（900000 × 0.95 = 855000）。
  const recomputed = configWith([ready], {codex: ready.id});
  recomputed.agentConnections.codex!.launchPreferences = {
    contextWindows: {"gpt-5.6-sol_ai98pro.xyz": 900000},
  };
  const recomputedResult = buildCodexGatewayConfig(recomputed, GATEWAY_PATHS, TEST_TEMPLATE, TEST_OVERRIDES);
  const recomputedCatalog = JSON.parse(recomputedResult.catalog) as {models: Array<Record<string, any>>};
  const recomputedEntry = recomputedCatalog.models.find(entry => entry.slug === "gpt-5.6-sol_ai98pro.xyz")!;
  expect(recomputedEntry.auto_compact_token_limit).toBe(855000);
});

test("Claude 用户与项目配置只消费显式默认目标、模型和 Agent 全局别名", () => {
  const anthropic = target({
    id: "api.anthropic.com",
    openaiUrl: undefined,
    anthropicUrl: "https://api.anthropic.com/v1",
    supportedModels: ["claude-sonnet-4-5", "claude-haiku-4-5"],
    development: {
      defaultModels: {claude: "claude-sonnet-4-5"},
      defaultCredentials: {claude: "cred-claude"},
    },
  });
  const config = configWith([anthropic], {claude: anthropic.id});
  config.agentConnections.claude!.modelAliases = {
    sonnet: "claude-sonnet-4-5_api.anthropic.com",
    haiku: "claude-haiku-4-5_api.anthropic.com",
  };

  const result = buildClaudeUserSettings(config, GATEWAY_PATHS);
  expect(result.active).toBe(true);
  expect(result.settings).toMatchObject({
    env: {
      ANTHROPIC_BASE_URL: "http://127.0.0.1:3211/claude",
      ANTHROPIC_AUTH_TOKEN: "deepaa-gateway",
      ANTHROPIC_MODEL: "claude-sonnet-4-5_api.anthropic.com",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "claude-sonnet-4-5_api.anthropic.com",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "claude-haiku-4-5_api.anthropic.com",
      ANTHROPIC_SMALL_FAST_MODEL: "claude-haiku-4-5_api.anthropic.com",
    },
    model: "claude-sonnet-4-5_api.anthropic.com",
  });
  expect(buildClaudeProjectSettings(anthropic)).toEqual({model: "claude-sonnet-4-5_api.anthropic.com"});
});

test("模型归属、目标排除和 Agent 级默认资源控制 CLI 目录", () => {
  const mixed = target({
    id: "modelport.link",
    anthropicUrl: "https://modelport.link/anthropic/v1",
    supportedModels: ["gpt-5.6", "claude-sonnet-4", "deepseek-v4-flash"],
    // scope 缺省=拒绝（与网关一致）：deepseek-v4-flash 显式归属 codex，
    // claude-sonnet-4 只归属 claude（codex 目录必须排除）。
    supportedModelScopes: {"gpt-5.6": ["codex"], "claude-sonnet-4": ["claude"], "deepseek-v4-flash": ["codex"]},
    development: {
      defaultModels: {codex: "gpt-5.6", claude: "claude-sonnet-4"},
      defaultCredentials: {codex: "cred-codex", claude: "cred-claude"},
    },
  });
  const config = configWith([mixed], {codex: mixed.id, claude: mixed.id});

  const codex = buildCodexGatewayConfig(config, GATEWAY_PATHS, TEST_TEMPLATE, TEST_OVERRIDES);
  expect(codex.catalog).toContain("gpt-5.6");
  expect(codex.catalog).toContain("deepseek-v4-flash");
  expect(codex.catalog).not.toContain("claude-sonnet-4");
  expect(codex.toml).toContain('model = "gpt-5.6_modelport.link"');

  const claude = buildClaudeUserSettings(config, GATEWAY_PATHS);
  expect(JSON.stringify(claude.settings)).not.toContain("gpt-5.6");
  expect(claude.settings).toMatchObject({model: "claude-sonnet-4_modelport.link"});

  const excluded = buildCodexGatewayConfig(
    {...config, targets: [{...mixed, cliSyncExclusions: ["codex"]}]},
    GATEWAY_PATHS,
    TEST_TEMPLATE,
    TEST_OVERRIDES,
  );
  expect(excluded.active).toBe(false);
  expect(excluded.warnings.map(item => item.code)).toContain("CLI_SYNC_TARGET_EXCLUDED");
});

test("syncCliConfigs 备份、幂等合并并保留用户其它配置且不写真实密钥", async () => {
  const root = await mkdtemp(join(tmpdir(), "config-sync-v3-"));
  const codexDir = join(root, "codex");
  const claudeDir = join(root, "claude");
  const projectDir = join(root, "project-a");
  const dshDir = join(root, "dsh");
  const opencodeDir = join(root, "opencode");
  const zcodeDir = join(root, "zcode", "v2");
  await Promise.all([
    mkdir(codexDir, {recursive: true}),
    mkdir(claudeDir, {recursive: true}),
    mkdir(projectDir, {recursive: true}),
    mkdir(dshDir, {recursive: true}),
    mkdir(opencodeDir, {recursive: true}),
    mkdir(zcodeDir, {recursive: true}),
  ]);
  // 全部 Agent 的受管路径都必须指向临时目录：syncCliConfigs 会真实写文件，
  // 缺省路径会解析到真实 HOME，曾把本机 dsh/opencode/zcode 受管配置清掉。
  const paths: CliSyncPaths = {
    codexConfigPath: join(codexDir, "config.toml"),
    codexCatalogPath: join(codexDir, "catalogs", "all.json"),
    claudeUserSettingsPath: join(claudeDir, "settings.json"),
    claudeProjectSettingsPaths: {[projectDir]: join(projectDir, ".claude", "settings.json")},
    dshSettingsPath: join(dshDir, "settings.yaml"),
    dshCredentialsPath: join(dshDir, ".credentials.yaml"),
    opencodeConfigPath: join(opencodeDir, "opencode.json"),
    zcodeConfigPath: join(zcodeDir, "config.json"),
    zcodeStatePath: join(zcodeDir, "deepaa", "gateway-state.json"),
    gatewayBaseUrl: "http://localhost:3211",
    gatewayBearerToken: "deepaa-gateway",
  };
  await writeFile(paths.codexConfigPath, '[mcp_servers.demo]\ncommand = "demo"\n', "utf8");
  await writeFile(paths.claudeUserSettingsPath, JSON.stringify({hooks: {demo: true}}), "utf8");

  const openai = target({id: "api.deepseek.com", supportedModels: ["deepseek-v4-flash"]});
  const anthropic = target({
    id: "api.anthropic.com",
    openaiUrl: undefined,
    anthropicUrl: "https://api.anthropic.com/v1",
    supportedModels: ["claude-sonnet-4-5"],
    development: {defaultModels: {claude: "claude-sonnet-4-5"}, defaultCredentials: {claude: "cred-claude"}},
  });
  const config = configWith([openai, anthropic], {codex: openai.id, claude: anthropic.id});

  const first = await syncCliConfigs(config, {paths, credentialHelperPath: "/bin/true"});
  expect(first.ok).toBe(true);
  const codexToml = await readFile(paths.codexConfigPath, "utf8");
  expect(codexToml).toContain("[mcp_servers.demo]");
  expect(codexToml).toContain("[model_providers.deepaa_gateway]");
  const claudeSettings = JSON.parse(await readFile(paths.claudeUserSettingsPath, "utf8")) as Record<string, unknown>;
  expect(claudeSettings).toMatchObject({hooks: {demo: true}, env: {ANTHROPIC_AUTH_TOKEN: "deepaa-gateway"}});

  const second = await syncCliConfigs(config, {paths, credentialHelperPath: "/bin/true"});
  expect(second.ok).toBe(true);
  expect(await readFile(paths.codexConfigPath, "utf8")).toBe(codexToml);
  expect((await readdir(join(codexDir, "deepaa"))).some(file => /^config\.toml_bk_\d{8}_\d{6}$/.test(file))).toBe(true);
  expect((await readdir(join(claudeDir, "deepaa"))).some(file => /^settings\.json_bk_\d{8}_\d{6}$/.test(file))).toBe(true);

  const outputs = await Promise.all([
    readFile(paths.codexConfigPath, "utf8"),
    readFile(paths.codexCatalogPath, "utf8"),
    readFile(paths.claudeUserSettingsPath, "utf8"),
    readFile(paths.claudeProjectSettingsPaths[projectDir]!, "utf8"),
  ]);
  expect(outputs.join("\n")).not.toMatch(/sk-[A-Za-z0-9_-]{16,}/);
  expect(outputs.join("\n")).not.toContain("secret-token");
});
