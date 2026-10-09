import {expect, test} from "vitest";
import {parse as parseYaml, stringify as stringifyYaml} from "yaml";
import type {CatalogTemplate} from "../src/lib/config-sync/catalog-template.js";
import {dshCliConfigAdapter, resolveDshCredentialsPath, resolveDshSettingsPath} from "../src/lib/config-sync/adapters/dsh.js";
import {createCliSyncContext} from "../src/lib/config-sync/core/sync-context.js";
import type {CliSyncPaths} from "../src/lib/config-sync/core/types.js";
import type {ProxyConfig, ProxyTarget} from "../src/types.js";

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
  const supportedModels = overrides.supportedModels || ["deepseek-v4-flash"];
  return {
    id: overrides.id,
    name: overrides.id,
    enabled: true,
    openaiUrl: `https://${overrides.id}/v1`,
    supportedModels,
    supportedModelScopes: Object.fromEntries(supportedModels.map(model => [model, ["dsh"]])),
    supportedModelWireApis: Object.fromEntries(supportedModels.map(model => [model, ["chat_completions"]])),
    pricing: {
      vendor: "test",
      rateMultiplier: 1,
      modelVendors: Object.fromEntries(supportedModels.map(modelId => [modelId, {vendor: "test", priceEntryId: `test:${modelId}`}])),
    },
    development: {
      defaultModels: {dsh: "deepseek-v4-flash"},
      defaultCredentials: {dsh: "cred-dsh"},
    },
    ...overrides,
  };
}

function config(overrides: Partial<ProxyConfig> = {}): ProxyConfig {
  return {
    version: 3,
    revision: 1,
    agentConnections: {
      dsh: {
        boundTargetIds: ["deepseek-provider"],
        defaultTargetId: "deepseek-provider",
        cliSyncEnabled: true,
      },
    },
    targets: [target({id: "deepseek-provider"})],
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

test("dsh 活跃链路生成独立 Deepaa Provider 与 agent-default-model 受管分节", () => {
  const ctx = context(config());
  const plan = dshCliConfigAdapter.build(ctx, dshCliConfigAdapter.resolvePaths(ctx));
  expect(plan.active).toBe(true);
  const content = plan.artifacts[0]!.content;
  expect(content).toContain("baseURL: http://127.0.0.1:3211/dsh/v1");
  expect(content).toContain("apiKeyEnv: DEEPAA_GATEWAY_TOKEN");
  expect(content).toContain("id: deepseek-v4-flash_deepseek-provider");
  expect(content).toContain("contextWindow: 272000");
  expect(content).toContain("input:");
  expect(content).toContain("- text");
  expect(content).toContain("provider: deepaa-gateway");
  expect(content).toContain("model: deepseek-v4-flash_deepseek-provider");
});

test("dsh 配置同步不替上游模型能力选择 agent preset", () => {
  const ctx = context(config());
  const plan = dshCliConfigAdapter.build(ctx, dshCliConfigAdapter.resolvePaths(ctx));

  expect(plan.artifacts[0]!.content).not.toContain("agent-presets");
});

test("dsh 配置同步保留用户自己的 agent preset 设置", () => {
  const ctx = context(config());
  const plan = dshCliConfigAdapter.build(ctx, dshCliConfigAdapter.resolvePaths(ctx));
  const existing = "agent-presets:\n  default: custom\n";

  const merged = dshCliConfigAdapter.mergeFile({
    file: dshCliConfigAdapter.files[0]!,
    existingRaw: existing,
    artifact: plan.artifacts[0]!,
  });

  expect(merged).toContain("agent-presets:");
  expect(merged).toContain("default: custom");
});

test("dsh 使用独立 Deepaa Provider，官方模型设置不会夺走网关模型列表", () => {
  const ctx = context(config());
  const plan = dshCliConfigAdapter.build(ctx, dshCliConfigAdapter.resolvePaths(ctx));
  const content = plan.artifacts[0]!.content;
  expect(content).toContain("llm-pi-ai:");
  expect(content).toContain("deepaa-gateway:");
  expect(content).toContain("api: openai-completions");
  expect(content).toContain("provider: deepaa-gateway");
  expect(content).not.toContain("provider: deepseek-official");

  const existing = `# 用户 settings 注释\nllm-pi-ai:\n  providers:\n    # 用户 Provider 注释\n    acme:\n      api: openai-completions\n      baseURL: https://acme.example/v1\n      models:\n        - id: acme-model\nagent-default-model:\n  provider: acme\n  model: acme-model\n`;
  const merged = dshCliConfigAdapter.mergeFile({
    file: dshCliConfigAdapter.files[0]!,
    existingRaw: existing,
    artifact: plan.artifacts[0]!,
  });
  const parsed = parseYaml(merged) as Record<string, any>;
  expect(parsed["llm-pi-ai"].providers.acme.baseURL).toBe("https://acme.example/v1");
  expect(parsed["llm-pi-ai"].providers["deepaa-gateway"].baseURL).toBe("http://127.0.0.1:3211/dsh/v1");
  expect(parsed["agent-default-model"].provider).toBe("deepaa-gateway");
  expect(merged).toContain("# 用户 settings 注释");
  expect(merged).toContain("# 用户 Provider 注释");

  const officialExisting = `llm-deepseek:\n  baseURL: https://api.deepseek.com/v1\n  apiKeyEnv: DEEPSEEK_API_KEY\n  models:\n    - id: deepseek-v4-flash\n`;
  const officialMerged = dshCliConfigAdapter.mergeFile({
    file: dshCliConfigAdapter.files[0]!,
    existingRaw: officialExisting,
    artifact: {...plan.artifacts[0]!, active: false, content: ""},
  });
  expect(officialMerged).toContain("llm-deepseek:");
  expect(officialMerged).toContain("DEEPSEEK_API_KEY");
});

test("dsh 活跃链路同时写入凭据文件占位键（任意方式启动都可被网关接管）", () => {
  const ctx = context(config());
  const plan = dshCliConfigAdapter.build(ctx, dshCliConfigAdapter.resolvePaths(ctx));
  expect(plan.artifacts).toHaveLength(2);
  const credentials = plan.artifacts[1]!;
  expect(credentials.specId).toBe("dsh-credentials");
  expect(credentials.content).toContain("version: 1");
  expect(credentials.content).toContain("DEEPAA_GATEWAY_TOKEN: deepaa-gateway");
  // 合并：保留用户已有 DEEPSEEK_API_KEY 等 refs 键，仅 patch 占位键。
  const existing = "# 用户凭据注释\nversion: 1\nrefs:\n  # 用户密钥注释\n  DEEPSEEK_API_KEY: sk-user-real-key\nrecords: {}\n";
  const merged = dshCliConfigAdapter.mergeFile({
    file: {id: "dsh-credentials", kind: "yaml", managedNamespaces: ["refs"], description: "", sensitive: true},
    existingRaw: existing,
    artifact: credentials,
  });
  expect(merged).toContain("DEEPSEEK_API_KEY: sk-user-real-key");
  expect(merged).toContain("DEEPAA_GATEWAY_TOKEN: deepaa-gateway");
  expect(merged).toContain("records:");
  expect(merged).toContain("# 用户凭据注释");
  expect(merged).toContain("# 用户密钥注释");
  // 清理层：删除占位键但保留用户密钥。
  const cleaned = dshCliConfigAdapter.mergeFile({
    file: {id: "dsh-credentials", kind: "yaml", managedNamespaces: ["refs"], description: "", sensitive: true},
    existingRaw: merged,
    artifact: {...credentials, active: false, content: ""},
  });
  expect(cleaned).not.toContain("DEEPAA_GATEWAY_TOKEN");
  expect(cleaned).toContain("DEEPSEEK_API_KEY: sk-user-real-key");
  // 旧 flat 布局迁移为 version 1 + refs 嵌套。
  const migrated = dshCliConfigAdapter.mergeFile({
    file: {id: "dsh-credentials", kind: "yaml", managedNamespaces: ["refs"], description: "", sensitive: true},
    existingRaw: "DEEPSEEK_API_KEY: sk-flat-key\n",
    artifact: credentials,
  });
  expect(migrated).toContain("version: 1");
  expect(migrated).toContain("DEEPSEEK_API_KEY: sk-flat-key");
  expect(migrated).toContain("DEEPAA_GATEWAY_TOKEN: deepaa-gateway");
});

test("三协议路由：chat/responses/messages 模型分流，默认模型落在其归一路由（2026-10-06 pi-ai 官方三协议支持）", () => {
  const mixed = target({
    id: "tri-relay",
    openaiUrl: "https://tri.example/v1",
    anthropicUrl: "https://tri.example/anthropic",
    supportedModels: ["deepseek-v4-flash", "gpt-5.6-sol", "glm-5.3"],
    supportedModelScopes: {"deepseek-v4-flash": ["dsh"], "gpt-5.6-sol": ["dsh"], "glm-5.3": ["dsh"]},
    supportedModelWireApis: {
      "deepseek-v4-flash": ["chat_completions"],
      "gpt-5.6-sol": ["responses"],
      "glm-5.3": ["messages"],
    },
  });
  const ctx = context(config({
    targets: [mixed],
    agentConnections: {
      dsh: {boundTargetIds: ["tri-relay"], defaultTargetId: "tri-relay", cliSyncEnabled: true},
    },
  }));
  const plan = dshCliConfigAdapter.build(ctx, dshCliConfigAdapter.resolvePaths(ctx));
  expect(plan.active).toBe(true);
  dshCliConfigAdapter.validate(plan);
  const settings = plan.artifacts.find(artifact => artifact.specId === "dsh-settings")!;
  const parsed = parseYaml(settings.content) as Record<string, any>;
  const providers = parsed["llm-pi-ai"].providers;
  // chat（defaultBinding 优先）主路由沿用既有 provider id。
  expect(providers["deepaa-gateway"].api).toBe("openai-completions");
  expect(providers["deepaa-gateway"].baseURL).toBe("http://127.0.0.1:3211/dsh/v1");
  expect(providers["deepaa-gateway"].compat).toEqual({supportsDeveloperRole: false, maxTokensField: "max_tokens"});
  expect(providers["deepaa-gateway"].models.map((m: any) => m.id)).toEqual(["deepseek-v4-flash_tri-relay"]);
  // responses 路由：api openai-responses。
  expect(providers["deepaa-gateway-responses"].api).toBe("openai-responses");
  expect(providers["deepaa-gateway-responses"].models.map((m: any) => m.id)).toEqual(["gpt-5.6-sol_tri-relay"]);
  expect(providers["deepaa-gateway-responses"].compat).toBeUndefined();
  // messages 路由：api anthropic-messages，baseURL 不带 /v1（pi-ai 拼 /v1/messages）。
  expect(providers["deepaa-gateway-anthropic"].api).toBe("anthropic-messages");
  expect(providers["deepaa-gateway-anthropic"].baseURL).toBe("http://127.0.0.1:3211/dsh");
  expect(providers["deepaa-gateway-anthropic"].models.map((m: any) => m.id)).toEqual(["glm-5.3_tri-relay"]);
  // 默认模型 deepseek-v4-flash（chat）落在主路由。
  expect(parsed["agent-default-model"]).toMatchObject({provider: "deepaa-gateway", model: "deepseek-v4-flash_tri-relay"});
});

test("dsh 默认模型不适用（归属排除）时跳过写入（preserve）", () => {
  // 2026-10-06 起 dsh 三协议（chat/responses/messages）全消费，wire 维度不再有
  // 不兼容；默认模型因 scope 不含 dsh 而无法归一时仍按 preserve 保留磁盘现状。
  const unsupported = target({
    id: "deepseek-provider",
    supportedModelScopes: {"deepseek-v4-flash": ["codex"]},
  });
  const ctx = context(config({targets: [unsupported]}));
  const plan = dshCliConfigAdapter.build(ctx, dshCliConfigAdapter.resolvePaths(ctx));
  expect(plan.active).toBe(false);
  expect(plan.preserve).toBe(true);
  expect(plan.artifacts).toHaveLength(0);
  expect(plan.warnings.map(item => item.code)).toContain("NO_MODELS");
});

test("瞬时不合格（默认供应商不存在）输出 preserve 计划而非清理层", () => {
  const ctx = context(config({
    agentConnections: {
      dsh: {boundTargetIds: ["deepseek-provider"], defaultTargetId: "missing-provider", cliSyncEnabled: true},
    },
  }));
  const plan = dshCliConfigAdapter.build(ctx, dshCliConfigAdapter.resolvePaths(ctx));
  expect(plan.active).toBe(false);
  expect(plan.preserve).toBe(true);
  expect(plan.artifacts).toHaveLength(0);
  expect(plan.warnings.map(item => item.code)).toContain("DEFAULT_TARGET_NOT_FOUND");
});

test("活跃同步把 dsh 默认模型覆盖为网关默认模型（覆盖官方误选）", () => {
  const ctx = context(config());
  const resolved = dshCliConfigAdapter.resolvePaths(ctx);
  const plan = dshCliConfigAdapter.build(ctx, resolved);
  const misPicked = "llm-pi-ai:\n  providers:\n    deepaa-gateway:\n      baseURL: http://127.0.0.1:3211/dsh/v1\nagent-default-model:\n  provider: deepseek-official\n  model: deepseek-v4-flash\n";
  const merged = dshCliConfigAdapter.mergeFile({
    file: dshCliConfigAdapter.files[0]!,
    existingRaw: misPicked,
    artifact: plan.artifacts[0]!,
  });
  const parsed = parseYaml(merged) as Record<string, any>;
  expect(parsed["agent-default-model"].provider).toBe("deepaa-gateway");
  expect(parsed["agent-default-model"].model).toBe("deepseek-v4-flash_deepseek-provider");
});

test("未接入 / 关闭同步输出空清理层并保留 warning", () => {
  const ctx = context(config({agentConnections: {}}));
  const plan = dshCliConfigAdapter.build(ctx, dshCliConfigAdapter.resolvePaths(ctx));
  expect(plan.active).toBe(false);
  expect(plan.artifacts[0]!.content).toBe("");
  expect(plan.warnings.map(item => item.code)).toContain("AGENT_NOT_CONNECTED");
});

test("订阅通道目标被排除并返回 SUBSCRIPTION_UNSUPPORTED", () => {
  const ctx = context(config({
    targets: [target({id: "deepseek-provider", billingChannel: "subscription"})],
  }));
  const plan = dshCliConfigAdapter.build(ctx, dshCliConfigAdapter.resolvePaths(ctx));
  expect(plan.active).toBe(false);
  expect(plan.warnings.map(item => item.code)).toContain("SUBSCRIPTION_UNSUPPORTED");
});

test("YAML 深合并保留其它分节，清理层只删除受管分节", () => {
  const existing = `custom-section:\n  enabled: true\nllm-deepseek:\n  baseURL: http://127.0.0.1:3211/dsh/v1\n  apiKeyEnv: DEEPAA_GATEWAY_TOKEN\nagent-default-model:\n  provider: deepseek-official\n  model: old_model_target\n`;
  const ctx = context(config());
  const resolved = dshCliConfigAdapter.resolvePaths(ctx);
  const plan = dshCliConfigAdapter.build(ctx, resolved);
  const merged = dshCliConfigAdapter.mergeFile({
    file: dshCliConfigAdapter.files[0]!,
    existingRaw: existing,
    artifact: plan.artifacts[0]!,
  });
  expect(merged).toContain("custom-section:");
  expect(merged).not.toContain("http://old/v1");
  expect(merged).toContain("http://127.0.0.1:3211/dsh/v1");

  const inactive = dshCliConfigAdapter.mergeFile({
    file: dshCliConfigAdapter.files[0]!,
    existingRaw: merged,
    artifact: {specId: "dsh-settings", path: "x", kind: "yaml", active: false, content: ""},
  });
  expect(inactive).toContain("custom-section:");
  expect(inactive).not.toContain("llm-deepseek:");
  expect(inactive).not.toContain("agent-default-model:");
});

test("validate 拒绝真实密钥与非法模型前缀", () => {
  const ctx = context(config());
  const resolved = dshCliConfigAdapter.resolvePaths(ctx);
  const plan = dshCliConfigAdapter.build(ctx, resolved);
  const bad = {
    ...plan,
    artifacts: [{
      ...plan.artifacts[0]!,
    content: "llm-pi-ai:\n  providers:\n    deepaa-gateway:\n      baseURL: http://127.0.0.1:3211/dsh/v1\n      apiKeyEnv: DEEPSEEK_API_KEY\n      api: openai-completions\n      models:\n        - id: bad_model\n",
    }],
  };
  expect(() => dshCliConfigAdapter.validate(bad)).toThrow(/DSH_PLAN_INVALID|SECRET_IN_CLI_CONFIG/);
});

test("路径解析：显式路径 > DSH_HOME > ~/.dsh", () => {
  expect(resolveDshSettingsPath(context(config(), {dshSettingsPath: "/custom/settings.yaml"})))
    .toBe("/custom/settings.yaml");
  expect(resolveDshCredentialsPath(context(config(), {dshCredentialsPath: "/custom/.credentials.yaml"})))
    .toBe("/custom/.credentials.yaml");
  expect(resolveDshSettingsPath(context(config(), {}, {DSH_HOME: "/data/dsh"})))
    .toBe("/data/dsh/settings.yaml");
  expect(resolveDshCredentialsPath(context(config(), {}, {DSH_HOME: "/data/dsh"})))
    .toBe("/data/dsh/.credentials.yaml");
  expect(resolveDshSettingsPath(context(config())))
    .toBe("/Users/test/.dsh/settings.yaml");
  expect(resolveDshCredentialsPath(context(config())))
    .toBe("/Users/test/.dsh/.credentials.yaml");
});

test("多个目标时模型列表去重前保留各自前缀", () => {
  const second = target({id: "relay.example", development: {defaultModels: {dsh: "deepseek-v4-flash"}, defaultCredentials: {dsh: "cred-relay"}}});
  const cfg = config({
    agentConnections: {
      dsh: {
        boundTargetIds: ["deepseek-provider", "relay.example"],
        defaultTargetId: "deepseek-provider",
        cliSyncEnabled: true,
      },
    },
    targets: [target({id: "deepseek-provider"}), second],
  });
  const ctx = context(cfg);
  const plan = dshCliConfigAdapter.build(ctx, dshCliConfigAdapter.resolvePaths(ctx));
  const content = plan.artifacts[0]!.content;
  expect(content).toContain("id: deepseek-v4-flash_deepseek-provider");
  expect(content).toContain("id: deepseek-v4-flash_relay.example");
});

test("开发启动偏好：reasoningEffort/permission/按网关模型 ID 覆盖上下文写入受管分节，清理层一并移除", () => {
  const cfg = config();
  cfg.agentConnections.dsh!.launchPreferences = {
    reasoningEffort: "low",
    permissionMode: "read-only",
    // 键为网关模型 ID：只覆盖 deepseek-provider 目标上的 deepseek-v4-flash，
    // relay.example 目标上的同名模型保持目录能力值（简配 vs 大窗各自独立）。
    contextWindows: {"deepseek-v4-flash_deepseek-provider": 262144},
  };
  const ctx = context(cfg);
  const plan = dshCliConfigAdapter.build(ctx, dshCliConfigAdapter.resolvePaths(ctx));
  expect(plan.active).toBe(true);
  dshCliConfigAdapter.validate(plan);
  const content = plan.artifacts[0]!.content;
  // 部署默认与默认模型两处都写推理强度；权限预设独立分节；上下文按模型覆盖。
  expect(content).toContain("reasoningEffort: low");
  expect(content).toContain("defaultPreset: read-only");
  expect(content).toContain("contextWindow: 262144");
  // 非法推理强度在 validate 拒绝。
  const broken = parseYaml(content) as Record<string, any>;
  broken["llm-pi-ai"].providers["deepaa-gateway"].reasoning = "ultra";
  const poisoned = plan.artifacts.map(item => item.specId === "dsh-settings"
    ? {...item, content: stringifyYaml(broken)}
    : item);
  expect(() => dshCliConfigAdapter.validate({...plan, artifacts: poisoned})).toThrow(/reasoningEffort/);

  // 清理层：permission 分节与受管键一并删除。
  const inactive = dshCliConfigAdapter.build(
    context({...cfg, agentConnections: {}}),
    dshCliConfigAdapter.resolvePaths(ctx),
  );
  const merged = parseYaml(dshCliConfigAdapter.mergeFile({
    file: dshCliConfigAdapter.files[0]!,
    existingRaw: `${content}\nuser-section:\n  keep: true\n`,
    artifact: inactive.artifacts[0]!,
  })) as Record<string, any>;
  expect(merged["llm-pi-ai"]).toBeUndefined();
  expect(merged["agent-default-model"]).toBeUndefined();
  expect(merged["permission"]).toBeUndefined();
  expect(merged["user-section"]).toEqual({keep: true});
});

// ———————— dsh ≥0.1.7 profile patch（cordis.patch.yml）布局 ————————

const patchPaths: Record<string, string> = {
  web: "/tmp/dsh-home/profiles/web/cordis.patch.yml",
  desktop: "/tmp/dsh-home/profiles/desktop/cordis.patch.yml",
};

function patchContext(cfg: ProxyConfig, env: NodeJS.ProcessEnv = {}): ReturnType<typeof createCliSyncContext> {
  return createCliSyncContext({
    config: cfg,
    paths: {...paths, dshProfilePatchPaths: patchPaths},
    template,
    overrides: {},
    homeDir: "/Users/test",
    env,
    platform: "darwin",
  });
}

test("profile-patch 布局：受管行写每个已初始化 profile 的 cordis.patch.yml（顶层数组）", () => {
  const ctx = patchContext(config());
  expect(ctx.dshConfigLayout).toBe("profile-patch");
  const resolved = dshCliConfigAdapter.resolvePaths(ctx);
  expect(resolved.filePaths["dsh-profile-patch:web"]).toBe(patchPaths.web!);
  expect(resolved.filePaths["dsh-profile-patch:desktop"]).toBe(patchPaths.desktop!);
  expect(resolved.filePaths["dsh-settings"]).toBeUndefined();

  const plan = dshCliConfigAdapter.build(ctx, resolved);
  expect(plan.active).toBe(true);
  dshCliConfigAdapter.validate(plan);
  const patchArtifacts = plan.artifacts.filter(item => item.specId === "dsh-profile-patch");
  expect(patchArtifacts).toHaveLength(2);
  const rows = parseYaml(patchArtifacts[0]!.content) as Array<Record<string, any>>;
  expect(Array.isArray(rows)).toBe(true);
  expect(rows.map(row => row.id)).toEqual(["llm-pi-ai", "agent-default-model"]);
  const provider = rows[0]!.config.providers["deepaa-gateway"];
  expect(provider.baseURL).toBe("http://127.0.0.1:3211/dsh/v1");
  expect(provider.api).toBe("openai-completions");
  expect(provider.apiKeyEnv).toBe("DEEPAA_GATEWAY_TOKEN");
  expect(provider.models[0].id).toBe("deepseek-v4-flash_deepseek-provider");
  expect(provider.models[0].reasoningEfforts).toEqual({off: null, low: "low", high: "high", max: "max"});
  expect(rows[1]!.config).toEqual({provider: "deepaa-gateway", model: "deepseek-v4-flash_deepseek-provider"});
});

test("profile-patch 布局：permission 行全表自持（read-only 不在 dsh 内置默认表）", () => {
  const cfg = config();
  cfg.agentConnections.dsh!.launchPreferences = {permissionMode: "read-only"};
  const ctx = patchContext(cfg);
  const plan = dshCliConfigAdapter.build(ctx, dshCliConfigAdapter.resolvePaths(ctx));
  dshCliConfigAdapter.validate(plan);
  const rows = parseYaml(plan.artifacts[0]!.content) as Array<Record<string, any>>;
  const permission = rows.find(row => row.id === "permission")!;
  expect(permission.config.defaultPreset).toBe("read-only");
  expect(Object.keys(permission.config.presets).sort()).toEqual(
    ["danger-full-access", "read-only", "workspace-write"],
  );
});

test("profile-patch 合并：空模板追加受管行，保留既有用户行与注释", () => {
  const ctx = patchContext(config());
  const plan = dshCliConfigAdapter.build(ctx, dshCliConfigAdapter.resolvePaths(ctx));
  const artifact = plan.artifacts.find(item => item.specId === "dsh-profile-patch")!;
  const existingRaw = "# user-managed rows below\n"
    + stringifyYaml([{id: "ui-theme", config: {preference: "dark"}}]);
  const merged = dshCliConfigAdapter.mergeFile({
    file: dshCliConfigAdapter.files.find(file => file.id === "dsh-profile-patch")!,
    existingRaw,
    artifact,
  });
  expect(merged).toContain("# user-managed rows below");
  const rows = parseYaml(merged) as Array<Record<string, any>>;
  expect(rows.map(row => row.id)).toEqual(["ui-theme", "llm-pi-ai", "agent-default-model"]);
  expect(rows.find(row => row.id === "ui-theme")!.config).toEqual({preference: "dark"});
  // 追加行的 config 结构（2026-10-05 桌面端事故回归）：providers 必须直接位于
  // 行 config 下，绝不允许 config.config 双层嵌套（dsh 剥未知键后 provider 不注册）。
  const appendedLlmRow = rows.find(row => row.id === "llm-pi-ai")!;
  expect(Object.keys(appendedLlmRow.config)).toEqual(["providers"]);
  expect(Object.keys(appendedLlmRow.config.providers)).toEqual(["deepaa-gateway"]);
  expect(appendedLlmRow.config.providers["deepaa-gateway"].api).toBe("openai-completions");
});

test("profile-patch 合并：已有 llm-pi-ai/permission 行定点修改，保留用户 providers 与自定义 presets", () => {
  const cfg = config();
  cfg.agentConnections.dsh!.launchPreferences = {permissionMode: "workspace-write"};
  const ctx = patchContext(cfg);
  const plan = dshCliConfigAdapter.build(ctx, dshCliConfigAdapter.resolvePaths(ctx));
  const artifact = plan.artifacts.find(item => item.specId === "dsh-profile-patch")!;
  const existing = [
    {
      id: "llm-pi-ai",
      config: {
        providers: {
          "my-relay": {api: "openai-completions", baseURL: "https://relay.example/v1", models: [{id: "gpt-x"}]},
          "deepaa-gateway": {api: "openai-completions", baseURL: "http://127.0.0.1:9999/dsh/v1"},
        },
      },
    },
    {
      id: "permission",
      config: {
        presets: {
          "my-custom": {sandbox: "workspace-write", approval: "ask"},
        },
        defaultPreset: "my-custom",
      },
    },
  ];
  const merged = dshCliConfigAdapter.mergeFile({
    file: dshCliConfigAdapter.files.find(file => file.id === "dsh-profile-patch")!,
    existingRaw: stringifyYaml(existing),
    artifact,
  });
  const rows = parseYaml(merged) as Array<Record<string, any>>;
  const llmRow = rows.find(row => row.id === "llm-pi-ai")!;
  // 用户 provider 原样保留；deepaa-gateway 定点替换为最新受管条目。
  expect(llmRow.config.providers["my-relay"]).toEqual(existing[0]!.config.providers["my-relay"]);
  expect(llmRow.config.providers["deepaa-gateway"].baseURL).toBe("http://127.0.0.1:3211/dsh/v1");
  const permissionRow = rows.find(row => row.id === "permission")!;
  // 用户自定义 presets 保留；defaultPreset 接管 + read-only 官方预设补齐。
  expect(permissionRow.config.presets["my-custom"]).toEqual({sandbox: "workspace-write", approval: "ask"});
  expect(permissionRow.config.presets["read-only"]).toEqual({sandbox: "read-only", approval: "ask"});
  expect(permissionRow.config.defaultPreset).toBe("workspace-write");
  // agent-default-model 为整行受管：追加到末尾（同 id 多行最后一行胜）。
  const defaultRows = rows.filter(row => row.id === "agent-default-model");
  expect(defaultRows).toHaveLength(1);
  expect(rows[rows.length - 1]!.id).toBe("agent-default-model");
});

test("profile-patch 清理层：受管键与受管行移除，用户行与非官方等价 presets 保留", () => {
  const cfg = config();
  cfg.agentConnections.dsh!.launchPreferences = {permissionMode: "read-only"};
  const ctx = patchContext(cfg);
  const active = dshCliConfigAdapter.build(ctx, dshCliConfigAdapter.resolvePaths(ctx));
  const inactive = dshCliConfigAdapter.build(
    patchContext({...cfg, agentConnections: {}}),
    dshCliConfigAdapter.resolvePaths(ctx),
  );
  const artifact = inactive.artifacts.find(item => item.specId === "dsh-profile-patch")!;
  // 现有文件 = 我们 active 写入的内容 + 用户行 + 用户自定义 permission presets。
  const activeRows = parseYaml(active.artifacts[0]!.content) as Array<Record<string, any>>;
  const existing = [
    ...activeRows,
    {id: "ui-theme", config: {preference: "dark"}},
    {id: "permission", config: {presets: {"my-custom": {sandbox: "workspace-write", approval: "ask"}}}},
  ];
  const merged = dshCliConfigAdapter.mergeFile({
    file: dshCliConfigAdapter.files.find(file => file.id === "dsh-profile-patch")!,
    existingRaw: stringifyYaml(existing),
    artifact,
  });
  const rows = parseYaml(merged) as Array<Record<string, any>>;
  expect(rows.find(row => row.id === "llm-pi-ai")).toBeUndefined();
  expect(rows.find(row => row.id === "agent-default-model")).toBeUndefined();
  expect(rows.find(row => row.id === "ui-theme")).toEqual({id: "ui-theme", config: {preference: "dark"}});
  // 官方等价 presets 行整行删除（我们追加的），用户自定义 presets 行保留（受管键已清）。
  const permissionRows = rows.filter(row => row.id === "permission");
  expect(permissionRows).toHaveLength(1);
  expect(permissionRows[0]!.config).toEqual({presets: {"my-custom": {sandbox: "workspace-write", approval: "ask"}}});
});

test("profile-patch 清理层：全受管内容清空时文件回落 []（dsh 拒绝空文件）", () => {
  const ctx = patchContext(config());
  const active = dshCliConfigAdapter.build(ctx, dshCliConfigAdapter.resolvePaths(ctx));
  const inactive = dshCliConfigAdapter.build(
    patchContext({...config(), agentConnections: {}}),
    dshCliConfigAdapter.resolvePaths(ctx),
  );
  const merged = dshCliConfigAdapter.mergeFile({
    file: dshCliConfigAdapter.files.find(file => file.id === "dsh-profile-patch")!,
    existingRaw: active.artifacts[0]!.content,
    artifact: inactive.artifacts.find(item => item.specId === "dsh-profile-patch")!,
  });
  expect(parseYaml(merged)).toEqual([]);
  // 目标文件不存在时清理层为 no-op。
  expect(dshCliConfigAdapter.mergeFile({
    file: dshCliConfigAdapter.files.find(file => file.id === "dsh-profile-patch")!,
    existingRaw: undefined,
    artifact: inactive.artifacts.find(item => item.specId === "dsh-profile-patch")!,
  })).toBe("");
});

test("profile-patch 解析失败（非顶层数组）原样返回，绝不破坏用户文件", () => {
  const ctx = patchContext(config());
  const plan = dshCliConfigAdapter.build(ctx, dshCliConfigAdapter.resolvePaths(ctx));
  const artifact = plan.artifacts.find(item => item.specId === "dsh-profile-patch")!;
  const broken = "llm-pi-ai:\n  providers: {}\n";
  expect(dshCliConfigAdapter.mergeFile({
    file: dshCliConfigAdapter.files.find(file => file.id === "dsh-profile-patch")!,
    existingRaw: broken,
    artifact,
  })).toBe(broken);
});

test("布局探测：settings.yaml.imported 迁移痕迹切换 profile-patch，目录存在性限定写入目标", async () => {
  const {mkdtempSync, mkdirSync, writeFileSync, existsSync} = await import("node:fs");
  const {tmpdir} = await import("node:os");
  const {join} = await import("node:path");
  const dshHome = mkdtempSync(join(tmpdir(), "dsh-layout-"));
  // 无迁移痕迹：legacy 布局。
  const legacyCtx = createCliSyncContext({
    config: config(), paths, template, overrides: {},
    homeDir: "/Users/test", env: {DSH_HOME: dshHome}, platform: "darwin",
  });
  expect(legacyCtx.dshConfigLayout).toBe("legacy-settings");
  expect(legacyCtx.dshProfileNames).toEqual([]);
  // dsh web 已初始化但未迁移：仍 legacy，且 profile 名单含 web。
  mkdirSync(join(dshHome, "profiles", "web"), {recursive: true});
  expect(legacyCtx.dshConfigLayout).toBe("legacy-settings");
  // 迁移痕迹出现（0.1.7+ 完成一次性导入改名）：切换 profile-patch。
  writeFileSync(join(dshHome, "settings.yaml.imported"), "ui-theme:\n  preference: light\n");
  const migratedCtx = createCliSyncContext({
    config: config(), paths, template, overrides: {},
    homeDir: "/Users/test", env: {DSH_HOME: dshHome}, platform: "darwin",
  });
  expect(migratedCtx.dshConfigLayout).toBe("profile-patch");
  expect(migratedCtx.dshProfileNames).toEqual(["web"]);
  // 只为已初始化 profile 生成受管 artifact（desktop 未创建不写）。
  const resolved = dshCliConfigAdapter.resolvePaths(migratedCtx);
  const plan = dshCliConfigAdapter.build(migratedCtx, resolved);
  expect(plan.artifacts.filter(item => item.specId === "dsh-profile-patch")).toHaveLength(1);
  expect(resolved.filePaths["dsh-profile-patch:web"]).toBe(join(dshHome, "profiles", "web", "cordis.patch.yml"));
  // legacy 布局的 settings.yaml 路径解析与 DSH_HOME 对齐（既有注入语义不变）。
  const legacyResolved = dshCliConfigAdapter.resolvePaths(legacyCtx);
  expect(legacyResolved.filePaths["dsh-settings"]).toBe(join(dshHome, "settings.yaml"));
  expect(existsSync(dshHome)).toBe(true);
});

test("profile-patch 自愈：config.config 双层嵌套坏行（2026-10-05 桌面端事故产物）下次同步自动修复", () => {
  const ctx = patchContext(config());
  const plan = dshCliConfigAdapter.build(ctx, dshCliConfigAdapter.resolvePaths(ctx));
  const artifact = plan.artifacts.find(item => item.specId === "dsh-profile-patch")!;
  // 事故形态：llm-pi-ai 行 config 下只有嵌套的 config.providers（追加分支旧 bug 产物）。
  const corrupted = stringifyYaml([
    {id: "ui-chat", config: {transcriptView: "standard"}},
    {
      id: "llm-pi-ai",
      config: {
        config: {
          providers: {
            "deepaa-gateway": {api: "openai-completions", baseURL: "http://127.0.0.1:9999/dsh/v1"},
          },
        },
      },
    },
  ]);
  const merged = dshCliConfigAdapter.mergeFile({
    file: dshCliConfigAdapter.files.find(file => file.id === "dsh-profile-patch")!,
    existingRaw: corrupted,
    artifact,
  });
  const rows = parseYaml(merged) as Array<Record<string, any>>;
  const healed = rows.find(row => row.id === "llm-pi-ai")!;
  expect(Object.keys(healed.config)).toEqual(["providers"]);
  expect(healed.config.providers["deepaa-gateway"].baseURL).toBe("http://127.0.0.1:3211/dsh/v1");
  // 非事故特征的用户行绝不被触碰。
  expect(rows.find(row => row.id === "ui-chat")!.config).toEqual({transcriptView: "standard"});
});

test("profile-patch 清理层也能自愈坏嵌套行（受管键删除后不残留 config.config 脏结构）", () => {
  const corrupted = stringifyYaml([
    {
      id: "llm-pi-ai",
      config: {
        config: {
          providers: {
            "deepaa-gateway": {api: "openai-completions", baseURL: "http://127.0.0.1:3211/dsh/v1"},
          },
        },
      },
    },
  ]);
  const inactive = dshCliConfigAdapter.build(
    patchContext({...config(), agentConnections: {}}),
    dshCliConfigAdapter.resolvePaths(patchContext(config())),
  );
  const merged = dshCliConfigAdapter.mergeFile({
    file: dshCliConfigAdapter.files.find(file => file.id === "dsh-profile-patch")!,
    existingRaw: corrupted,
    artifact: inactive.artifacts.find(item => item.specId === "dsh-profile-patch")!,
  });
  // heal 提升后 providers.deepaa-gateway 落到正确路径，清理层删除键、行内已无
  // 受管内容 → 整行删除，文件回落 []。
  expect(parseYaml(merged)).toEqual([]);
});
