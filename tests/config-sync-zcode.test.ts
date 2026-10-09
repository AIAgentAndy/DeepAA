import {expect, test} from "vitest";
import {zcodeCliConfigAdapter, resolveZcodeConfigPath, resolveZcodeStatePath, resolveZcodeProviderConfigPath} from "../src/lib/config-sync/adapters/zcode.js";
import {createCliSyncContext} from "../src/lib/config-sync/core/sync-context.js";
import type {CatalogTemplate} from "../src/lib/config-sync/catalog-template.js";
import type {CliSyncPaths, CliSyncContext} from "../src/lib/config-sync/core/types.js";
import type {ProxyConfig, ProxyTarget} from "../src/types.js";

const LEGACY_BRAND_KEBAB = ["llm", "inspector"].join("-");

const template: CatalogTemplate = {
  defaults: {
    contextWindow: 272000,
    inputModalities: ["text"],
    supportedReasoningLevels: [
      {effort: "low", description: "Fast responses with lighter reasoning"},
      {effort: "high", description: "Extra high reasoning depth for complex problems"},
      {effort: "xhigh", description: "Extra extra high reasoning depth for complex problems"},
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
  zcodeConfigPath: "/tmp/zcode/v2/config.json",
  zcodeProviderConfigPath: "/tmp/zcode/v2/provider_config.json",
  zcodeStatePath: "/tmp/zcode/v2/deepaa/gateway-state.json",
  gatewayBaseUrl: "http://localhost:3211",
  gatewayBearerToken: "deepaa-gateway",
};

function buildContext(config: ProxyConfig, env: Record<string, string> = {}): CliSyncContext {
  return createCliSyncContext({
    config,
    paths,
    template,
    overrides: {},
    homeDir: "/tmp/home",
    env,
    platform: "linux",
    gatewayBaseUrl: "http://localhost:3211",
    gatewayBearerToken: "deepaa-gateway",
  });
}

function zcodeTarget(overrides: Partial<ProxyTarget> & Pick<ProxyTarget, "id">): ProxyTarget {
  const supportedModels = overrides.supportedModels || ["glm-5.3"];
  return {
    id: overrides.id,
    name: overrides.id,
    enabled: true,
    anthropicUrl: overrides.anthropicUrl ?? `https://${overrides.id}/anthropic`,
    supportedModels,
    supportedModelScopes: Object.fromEntries(supportedModels.map(model => [model, ["zcode"]])),
    supportedModelWireApis: Object.fromEntries(supportedModels.map(model => [model, ["messages"]])),
    pricing: {
      vendor: "zhipu",
      rateMultiplier: 1,
      modelVendors: Object.fromEntries(supportedModels.map(modelId => [modelId, {vendor: "zhipu", priceEntryId: `zhipu:${modelId}`}]) as Array<[string, {vendor: string; priceEntryId: string}]>),
    },
    development: {
      defaultModels: {zcode: supportedModels[0]},
      defaultCredentials: {zcode: "cred-zcode"},
    },
    ...overrides,
  };
}

function connectedConfig(targetValue: ProxyTarget): ProxyConfig {
  return {
    version: 3,
    revision: 1,
    agentConnections: {
      zcode: {
        boundTargetIds: [targetValue.id],
        defaultTargetId: targetValue.id,
        cliSyncEnabled: true,
      },
    },
    targets: [targetValue],
    localProxyBaseUrl: "http://localhost:3211",
    updatedAt: "2026-08-27T00:00:00.000Z",
  };
}

/** BigModel Coding Plan 内置条目（与真实 ~/.zcode/v2/config.json 同构的样例）。 */
function sampleZcodeConfigFile(): string {
  return `${JSON.stringify({
    provider: {
      "builtin:bigmodel-coding-plan": {
        name: "BigModel - Coding Plan",
        kind: "anthropic",
        options: {apiKey: "test-coding-plan-key", baseURL: "https://open.bigmodel.cn/api/anthropic"},
        enabled: true,
        source: "custom",
        models: {
          "GLM-5.3": {
            reasoning: {enabled: true, variants: ["low", "max"], defaultVariant: "max"},
            limit: {context: 1000000, output: 128000},
            modalities: {input: ["text"], output: ["text"]},
            zcode: {modified: false, priority: 99},
          },
          "GLM-5.2": {
            limit: {context: 1000000, output: 128000},
            modalities: {input: ["text"], output: ["text"]},
            zcode: {modified: false, priority: 100},
          },
        },
      },
      "builtin:bigmodel": {
        name: "Bigmodel - API Key",
        kind: "anthropic",
        options: {apiKey: "", baseURL: "https://open.bigmodel.cn/api/anthropic"},
        source: "custom",
        models: {},
      },
    },
  }, null, 2)}\n`;
}

function configArtifact(plan: ReturnType<typeof zcodeCliConfigAdapter.build>) {
  const artifact = plan.artifacts.find(item => item.specId === "zcode-config");
  if (!artifact) throw new Error("missing zcode-config artifact");
  return artifact;
}

function personalArtifact(plan: ReturnType<typeof zcodeCliConfigAdapter.build>) {
  const artifact = plan.artifacts.find(item => item.specId === "zcode-provider-config");
  if (!artifact) throw new Error("missing zcode-provider-config artifact");
  return artifact;
}

/** 与真实 ~/.zcode/v2/provider_config.json 同构的样例（2026-10-06 实机导出形状）：
 * 含 9月28日 importLegacy 迁移的旧 deepaa-gateway 规则（旧模型集）、deepaa-state
 * 残留、用户自有供应商与手动模型规则。 */
function sampleProviderConfigFile(): string {
  return `${JSON.stringify({
    schemaVersion: 1,
    config: {
      providerConfigRules: {
        providerRules: [
          {
            providerId: "my-own",
            providerName: "我的自建供应商",
            enabled: true,
            config: {
              group: "standard-personal",
              access: {type: "api-key", apiKey: "sk-user-own"},
              api: {type: "openai-chat-completions", baseUrl: "https://own.example.com/v1"},
              personalModelIds: ["own-model"],
              modelOrder: ["own-model"],
            },
          },
          {
            providerId: "deepaa-gateway",
            providerName: "DeepAA 网关",
            enabled: true,
            config: {
              group: "standard-personal",
              access: {type: "api-key", apiKey: "deepaa-gateway"},
              api: {type: "anthropic-messages", baseUrl: "http://127.0.0.1:3211/zcode"},
              personalModelIds: ["glm-5.3_old-target"],
              modelOrder: ["glm-5.3_old-target"],
            },
          },
          {
            providerId: "deepaa-state",
            config: {
              group: "standard-personal",
              access: {type: "api-key"},
              api: {type: "openai-chat-completions", baseUrl: ""},
            },
          },
        ],
      },
      modelConfigRules: {
        providerModelRules: [
          {modelId: "own-model", config: {properties: {contextWindow: 8192}}, providerId: "my-own"},
          {modelId: "glm-5.3_old-target", config: {properties: {contextWindow: 1048576}}, providerId: "deepaa-gateway"},
        ],
        manualProviderModelRules: [
          {modelId: "own-model", providerId: "my-own", note: "手动规则必须原样保留"},
        ],
      },
    },
  }, null, 2)}\n`;
}

test("路径解析：显式注入优先，其次 $ZCODE_DATA_BASE_DIR，缺省 ~/.zcode/v2", () => {
  // 显式注入（与其它 Agent 的测试隔离方式一致）。
  const injected = buildContext(connectedConfig(zcodeTarget({id: "zhipu-plan"})));
  expect(resolveZcodeConfigPath(injected)).toBe(paths.zcodeConfigPath);
  expect(resolveZcodeProviderConfigPath(injected)).toBe(paths.zcodeProviderConfigPath);
  // 未注入时按 env 覆盖或 home 目录推导。
  const basePaths = {...paths} as CliSyncPaths;
  delete basePaths.zcodeConfigPath;
  delete basePaths.zcodeStatePath;
  delete basePaths.zcodeProviderConfigPath;
  const derived = createCliSyncContext({
    config: connectedConfig(zcodeTarget({id: "zhipu-plan"})),
    paths: basePaths,
    template,
    overrides: {},
    homeDir: "/tmp/home",
    env: {},
    platform: "linux",
    gatewayBaseUrl: "http://localhost:3211",
    gatewayBearerToken: "deepaa-gateway",
  });
  expect(resolveZcodeConfigPath(derived)).toBe("/tmp/home/.zcode/v2/config.json");
  expect(resolveZcodeStatePath(derived)).toBe("/tmp/home/.zcode/v2/deepaa/gateway-state.json");
  expect(resolveZcodeProviderConfigPath(derived)).toBe("/tmp/home/.zcode/v2/provider_config.json");
  const overridden = createCliSyncContext({
    config: connectedConfig(zcodeTarget({id: "zhipu-plan"})),
    paths: basePaths,
    template,
    overrides: {},
    homeDir: "/tmp/home",
    env: {ZCODE_DATA_BASE_DIR: "/data/zcode"},
    platform: "linux",
    gatewayBaseUrl: "http://localhost:3211",
    gatewayBearerToken: "deepaa-gateway",
  });
  expect(resolveZcodeConfigPath(overridden)).toBe("/data/zcode/v2/config.json");
  expect(resolveZcodeStatePath(overridden)).toBe("/data/zcode/v2/deepaa/gateway-state.json");
});

test("登录透传：接管 builtin:bigmodel-coding-plan，只改 baseURL/models，保留 apiKey 与其它条目", () => {
  const targetValue = zcodeTarget({
    id: "zhipu-plan",
    anthropicUrl: "https://open.bigmodel.cn/api/anthropic",
    credentialMode: "passthrough",
    // passthrough 目标没有系统凭据也不需要。
    development: {defaultModels: {zcode: "glm-5.3"}},
  });
  const context = buildContext(connectedConfig(targetValue));
  const plan = zcodeCliConfigAdapter.build(context, zcodeCliConfigAdapter.resolvePaths(context));
  expect(plan.active).toBe(true);
  zcodeCliConfigAdapter.validate(plan);

  const merged = JSON.parse(zcodeCliConfigAdapter.mergeFile({
    file: zcodeCliConfigAdapter.files[0]!,
    existingRaw: sampleZcodeConfigFile(),
    artifact: configArtifact(plan),
  })) as {provider: Record<string, any>};
  const entry = merged.provider["builtin:bigmodel-coding-plan"];
  // 只允许改这两个字段；apiKey 永不触碰（登录态凭据仍归 ZCode 管理）。
  expect(entry.options.baseURL).toBe("http://127.0.0.1:3211/zcode");
  expect(entry.options.apiKey).toBe("test-coding-plan-key");
  expect(Object.keys(entry.models).sort()).toEqual(["glm-5.3_zhipu-plan"]);
  // 受管标记（2026-10-06）记录原始值于被接管条目内部，供清理层精确还原；
  // 不再写独立 deepaa-state 供应商条目（避免泄漏到客户端供应商列表）。
  const marker = entry.deepaaManaged;
  expect(marker.originalBaseURL).toBe("https://open.bigmodel.cn/api/anthropic");
  expect(marker.originalModels["GLM-5.2"]).toBeDefined();
  expect(merged.provider["deepaa-state"]).toBeUndefined();
  // 用户其它条目原样保留。
  expect(merged.provider["builtin:bigmodel"].name).toBe("Bigmodel - API Key");
});

test("登录透传：重复同步不覆盖首次记录的原始值，且模型列表可随配置刷新", () => {
  const targetValue = zcodeTarget({
    id: "zhipu-plan",
    anthropicUrl: "https://open.bigmodel.cn/api/anthropic",
    credentialMode: "passthrough",
    development: {defaultModels: {zcode: "glm-5.3"}},
  });
  const spec = zcodeCliConfigAdapter.files[0]!;
  const firstPlan = zcodeCliConfigAdapter.build(buildContext(connectedConfig(targetValue)), zcodeCliConfigAdapter.resolvePaths(buildContext(connectedConfig(targetValue))));
  const once = zcodeCliConfigAdapter.mergeFile({file: spec, existingRaw: sampleZcodeConfigFile(), artifact: configArtifact(firstPlan)});
  // 第二次同步切换模型白名单（例如用户取消 GLM-5.3 归属）。
  const narrowed = zcodeTarget({
    id: "zhipu-plan",
    anthropicUrl: "https://open.bigmodel.cn/api/anthropic",
    credentialMode: "passthrough",
    supportedModels: ["glm-5.3"],
    development: {defaultModels: {zcode: "glm-5.3"}},
  }) as ProxyTarget;
  narrowed.supportedModelScopes = {"glm-5.3": ["zcode"]};
  const secondPlan = zcodeCliConfigAdapter.build(buildContext(connectedConfig(narrowed)), zcodeCliConfigAdapter.resolvePaths(buildContext(connectedConfig(narrowed))));
  const twice = JSON.parse(zcodeCliConfigAdapter.mergeFile({file: spec, existingRaw: once, artifact: configArtifact(secondPlan)})) as {provider: Record<string, any>};
  // 原始值仍是首次捕获的完整 builtin models，不被第二次同步覆盖（条目内受管标记）。
  const marker = twice.provider["builtin:bigmodel-coding-plan"].deepaaManaged;
  expect(marker.originalModels["GLM-5.3"]).toBeDefined();
  expect(marker.originalModels["GLM-5.2"]).toBeDefined();
  expect(marker.originalBaseURL).toBe("https://open.bigmodel.cn/api/anthropic");
});

test("清理层：按自还原因子还原 baseURL/models、删除自有条目并移除因子", () => {
  const targetValue = zcodeTarget({
    id: "zhipu-plan",
    anthropicUrl: "https://open.bigmodel.cn/api/anthropic",
    credentialMode: "passthrough",
    development: {defaultModels: {zcode: "glm-5.3"}},
  });
  const spec = zcodeCliConfigAdapter.files[0]!;
  const activePlan = zcodeCliConfigAdapter.build(buildContext(connectedConfig(targetValue)), zcodeCliConfigAdapter.resolvePaths(buildContext(connectedConfig(targetValue))));
  const takenOver = zcodeCliConfigAdapter.mergeFile({file: spec, existingRaw: sampleZcodeConfigFile(), artifact: configArtifact(activePlan)});
  // 关闭同步 → inactive 清理层。
  const disconnected = connectedConfig(targetValue);
  (disconnected.agentConnections.zcode as {cliSyncEnabled: boolean}).cliSyncEnabled = false;
  const inactivePlan = zcodeCliConfigAdapter.build(buildContext(disconnected), zcodeCliConfigAdapter.resolvePaths(buildContext(disconnected)));
  expect(inactivePlan.active).toBe(false);
  const restored = JSON.parse(zcodeCliConfigAdapter.mergeFile({file: spec, existingRaw: takenOver, artifact: configArtifact(inactivePlan)})) as {provider: Record<string, any>};
  expect(restored.provider["builtin:bigmodel-coding-plan"].options.baseURL).toBe("https://open.bigmodel.cn/api/anthropic");
  expect(restored.provider["builtin:bigmodel-coding-plan"].models["GLM-5.3"].reasoning.defaultVariant).toBe("max");
  expect(restored.provider["deepaa-gateway"]).toBeUndefined();
  expect(restored.provider["deepaa-state"]).toBeUndefined();
  // 还原后与原文件语义等价。
  const original = JSON.parse(sampleZcodeConfigFile());
  expect(restored.provider["builtin:bigmodel-coding-plan"].models).toEqual(original.provider["builtin:bigmodel-coding-plan"].models);
});

test("API Key 注入：新增自有条目写占位 token 与网关模型，validate 校验非法路由后缀", () => {
  const targetValue = zcodeTarget({id: "zhipu-payg"});
  const context = buildContext(connectedConfig(targetValue));
  const plan = zcodeCliConfigAdapter.build(context, zcodeCliConfigAdapter.resolvePaths(context));
  expect(plan.active).toBe(true);
  zcodeCliConfigAdapter.validate(plan);
  const instruction = JSON.parse(configArtifact(plan).content) as {additions: Record<string, any>};
  const entry = instruction.additions["deepaa-gateway"];
  expect(entry.kind).toBe("anthropic");
  expect(entry.options.apiKey).toBe("deepaa-gateway");
  expect(entry.options.baseURL).toBe("http://127.0.0.1:3211/zcode");
  expect(Object.keys(entry.models)).toEqual(["glm-5.3_zhipu-payg"]);

  const merged = JSON.parse(zcodeCliConfigAdapter.mergeFile({
    file: zcodeCliConfigAdapter.files[0]!,
    existingRaw: sampleZcodeConfigFile(),
    artifact: configArtifact(plan),
  })) as {provider: Record<string, any>};
  expect(merged.provider["deepaa-gateway"].enabled).toBe(true);
  expect(merged.provider["builtin:bigmodel-coding-plan"].options.baseURL).toBe("https://open.bigmodel.cn/api/anthropic");

  // 非法模型路由后缀在 validate 直接拒绝。
  const broken = plan.artifacts.map(item => item.specId === "zcode-config"
    ? {...item, content: JSON.stringify({version: 1, mode: "inject", additions: {"deepaa-gateway": {...entry, models: {"glm-no-prefix": {baseId: "glm-no-prefix"}}}}})}
    : item);
  expect(() => zcodeCliConfigAdapter.validate({...plan, artifacts: broken})).toThrow(/合法供应商路由后缀/);
});

test("同步时清理前身 gateway/state 条目并保留用户 Provider", () => {
  const targetValue = zcodeTarget({id: "zhipu-payg"});
  const context = buildContext(connectedConfig(targetValue));
  const plan = zcodeCliConfigAdapter.build(context, zcodeCliConfigAdapter.resolvePaths(context));
  const existing = JSON.parse(sampleZcodeConfigFile()) as {provider: Record<string, unknown>};
  const legacyGateway = `${LEGACY_BRAND_KEBAB}-gateway`;
  const legacyState = `${LEGACY_BRAND_KEBAB}-state`;
  existing.provider[legacyGateway] = {
    name: "旧网关",
    options: {apiKey: legacyGateway, baseURL: "http://127.0.0.1:3211/zcode"},
    models: {},
  };
  existing.provider[legacyState] = {managed: {version: 1, addedKeys: [legacyGateway]}};
  existing.provider["user-provider"] = {name: "用户 Provider", options: {baseURL: "https://user.example"}};
  const merged = JSON.parse(zcodeCliConfigAdapter.mergeFile({
    file: zcodeCliConfigAdapter.files[0]!,
    existingRaw: `${JSON.stringify(existing, null, 2)}\n`,
    artifact: configArtifact(plan),
  })) as {provider: Record<string, unknown>};
  expect(merged.provider[legacyGateway]).toBeUndefined();
  expect(merged.provider[legacyState]).toBeUndefined();
  expect(merged.provider["deepaa-gateway"]).toBeDefined();
  // 2026-10-06：自还原因子改为条目内标记，不再出现独立 state 供应商条目。
  expect(merged.provider["deepaa-state"]).toBeUndefined();
  expect(merged.provider["user-provider"]).toBeDefined();
});

test("未接入输出清理层；无可用模型 / 非 BigModel 端点透传目标跳过写入（preserve）", () => {
  const base = zcodeTarget({id: "zhipu-plan"});
  const noConnection = buildContext({...connectedConfig(base), agentConnections: {}});
  const noConn = zcodeCliConfigAdapter.build(noConnection, zcodeCliConfigAdapter.resolvePaths(noConnection));
  expect(noConn.active).toBe(false);

  const emptyModels = buildContext(connectedConfig(
    zcodeTarget({id: "zhipu-plan", supportedModels: []})));
  const noModels = zcodeCliConfigAdapter.build(emptyModels, zcodeCliConfigAdapter.resolvePaths(emptyModels));
  expect(noModels.active).toBe(false);
  expect(noModels.preserve).toBe(true);

  const foreignPassthrough = zcodeTarget({
    id: "relay",
    anthropicUrl: "https://relay.example.com/anthropic",
    credentialMode: "passthrough",
    development: {defaultModels: {zcode: "glm-5.3"}},
  });
  const foreign = buildContext(connectedConfig(foreignPassthrough));
  const foreignPlan = zcodeCliConfigAdapter.build(foreign, zcodeCliConfigAdapter.resolvePaths(foreign));
  expect(foreignPlan.active).toBe(false);
  expect(foreignPlan.preserve).toBe(true);
  expect(foreignPlan.warnings.some(warning => warning.code === "ADAPTER_WARNING")).toBe(true);
});

test("安全红线：目标文件不存在时不创建壳文件；非对象内容拒绝改写；指令含密钥时 validate 拒绝", () => {
  const targetValue = zcodeTarget({id: "zhipu-plan"});
  const context = buildContext(connectedConfig(targetValue));
  const plan = zcodeCliConfigAdapter.build(context, zcodeCliConfigAdapter.resolvePaths(context));
  const spec = zcodeCliConfigAdapter.files[0]!;
  expect(zcodeCliConfigAdapter.mergeFile({file: spec, existingRaw: undefined, artifact: configArtifact(plan)})).toBe("");
  // 用户文件被外部改成非法 JSON 时保持原样返回。
  expect(zcodeCliConfigAdapter.mergeFile({file: spec, existingRaw: "[1,2", artifact: configArtifact(plan)})).toBe("[1,2");
  // 未受管的既有文件：清理层必须返回空串（引擎跳过写入），绝不改写用户配置。
  const disconnectedPlan = (() => {
    const cfg = connectedConfig(targetValue);
    (cfg.agentConnections.zcode as {cliSyncEnabled: boolean}).cliSyncEnabled = false;
    const ctx = buildContext(cfg);
    return zcodeCliConfigAdapter.build(ctx, zcodeCliConfigAdapter.resolvePaths(ctx));
  })();
  const sampleWithoutState = JSON.stringify({provider: {"builtin:bigmodel-coding-plan": {options: {apiKey: "k", baseURL: "https://open.bigmodel.cn/api/anthropic"}}}});
  expect(zcodeCliConfigAdapter.mergeFile({
    file: spec,
    existingRaw: sampleWithoutState,
    artifact: configArtifact(disconnectedPlan),
  })).toBe("");
  // 受管层中混入真实密钥样式的占位符必须被拒绝。
  const poisoned = plan.artifacts.map(item => item.specId === "zcode-config"
    ? {...item, content: `${configArtifact(plan).content.slice(0, -1)},"note":"sk-abcdefghijklmnopqrstuvwx"}`}
    : item);
  expect(() => zcodeCliConfigAdapter.validate({...plan, artifacts: poisoned})).toThrow(/SECRET_IN_CLI_CONFIG/);
});

test("API Key 注入：落盘模型条目为规范 ZCode 元数据，不再泄漏 baseId 等内部字段", () => {
  const targetValue = zcodeTarget({id: "zhipu-payg"});
  const context = buildContext(connectedConfig(targetValue));
  const plan = zcodeCliConfigAdapter.build(context, zcodeCliConfigAdapter.resolvePaths(context));
  expect(plan.active).toBe(true);
  const merged = JSON.parse(zcodeCliConfigAdapter.mergeFile({
    file: zcodeCliConfigAdapter.files[0]!,
    existingRaw: sampleZcodeConfigFile(),
    artifact: configArtifact(plan),
  })) as {provider: Record<string, any>};
  const entry = merged.provider["deepaa-gateway"].models["glm-5.3_zhipu-payg"];
  expect(entry.baseId).toBeUndefined();
  expect(entry.contextWindow).toBeUndefined();
  expect(entry.name).toBe("zhipu-payg · glm-5.3");
  // 目录兜底档位（low/high/max）+ 家族默认档位（glm 非 gpt/claude 系 -> max）+ limit 双字段 + modalities + 受管标记。
  expect(entry.reasoning).toEqual({enabled: true, variants: ["low", "high", "xhigh", "max"], defaultVariant: "max"});
  expect(entry.limit).toEqual({context: 272000, output: 128000});
  expect(entry.modalities).toEqual({input: ["text"], output: ["text"]});
  expect(entry.zcode).toEqual({modified: true});
});

test("开发启动偏好：reasoningEffort 覆盖默认档位，contextWindows 按网关模型 ID 覆盖上下文（注入与透传同路径）", () => {
  const targetValue = zcodeTarget({id: "zhipu-payg"});
  const cfg = connectedConfig(targetValue);
  cfg.agentConnections.zcode!.launchPreferences = {
    reasoningEffort: "low",
    // 键为网关模型 ID（目标+模型复合键）：同一模型跨目标（简配 vs 大窗）可各自覆盖。
    contextWindows: {"glm-5.3_zhipu-payg": 262144},
  };
  const context = buildContext(cfg);
  const plan = zcodeCliConfigAdapter.build(context, zcodeCliConfigAdapter.resolvePaths(context));
  const merged = JSON.parse(zcodeCliConfigAdapter.mergeFile({
    file: zcodeCliConfigAdapter.files[0]!,
    existingRaw: sampleZcodeConfigFile(),
    artifact: configArtifact(plan),
  })) as {provider: Record<string, any>};
  const injected = merged.provider["deepaa-gateway"].models["glm-5.3_zhipu-payg"];
  expect(injected.reasoning.defaultVariant).toBe("low");
  expect(injected.limit.context).toBe(262144);

  // 透传接管路径使用同一 modelInstruction → buildManagedModels 链路。
  const passthroughTarget = zcodeTarget({
    id: "zhipu-plan",
    anthropicUrl: "https://open.bigmodel.cn/api/anthropic",
    credentialMode: "passthrough",
  });
  const passthroughCfg = connectedConfig(passthroughTarget);
  passthroughCfg.agentConnections.zcode!.launchPreferences = {
    reasoningEffort: "max",
    contextWindows: {"glm-5.3_zhipu-plan": 524288},
  };
  const passthroughContext = buildContext(passthroughCfg);
  const passthroughPlan = zcodeCliConfigAdapter.build(passthroughContext, zcodeCliConfigAdapter.resolvePaths(passthroughContext));
  expect(passthroughPlan.active).toBe(true);
  const passthroughMerged = JSON.parse(zcodeCliConfigAdapter.mergeFile({
    file: zcodeCliConfigAdapter.files[0]!,
    existingRaw: sampleZcodeConfigFile(),
    artifact: configArtifact(passthroughPlan),
  })) as {provider: Record<string, any>};
  const takenOver = passthroughMerged.provider["builtin:bigmodel-coding-plan"].models["glm-5.3_zhipu-plan"];
  expect(takenOver.reasoning.defaultVariant).toBe("max");
  expect(takenOver.limit.context).toBe(524288);
});

test("三协议注入：messages/responses/chat 模型分流到对应网关条目，客户端 UI 不出现独立状态供应商（2026-10-06 ZCode 官方三协议支持）", () => {
  const mixed = zcodeTarget({
    id: "relay",
    openaiUrl: "https://relay.example/v1",
    supportedModels: ["glm-5.3", "gpt-5.6-sol", "deepseek-chat"],
    supportedModelScopes: {"glm-5.3": ["zcode"], "gpt-5.6-sol": ["zcode"], "deepseek-chat": ["zcode"]},
    supportedModelWireApis: {
      "glm-5.3": ["messages", "chat_completions"],
      "gpt-5.6-sol": ["responses"],
      "deepseek-chat": ["chat_completions"],
    },
  });
  const context = buildContext(connectedConfig(mixed));
  const plan = zcodeCliConfigAdapter.build(context, zcodeCliConfigAdapter.resolvePaths(context));
  expect(plan.active).toBe(true);
  expect(plan.warnings.some(warning => warning.code === "ADAPTER_WARNING")).toBe(false);
  zcodeCliConfigAdapter.validate(plan);

  const merged = JSON.parse(zcodeCliConfigAdapter.mergeFile({
    file: zcodeCliConfigAdapter.files[0]!,
    existingRaw: sampleZcodeConfigFile(),
    artifact: configArtifact(plan),
  })) as {provider: Record<string, any>};
  // messages（defaultBinding 优先）进主条目。
  const anthropicRoute = merged.provider["deepaa-gateway"];
  expect(anthropicRoute.kind).toBe("anthropic");
  expect(Object.keys(anthropicRoute.models)).toEqual(["glm-5.3_relay"]);
  // responses → kind "openai"（App 官方 apiFormat↔kind 映射），baseURL 带 /v1。
  const responsesRoute = merged.provider["deepaa-gateway-responses"];
  expect(responsesRoute.kind).toBe("openai");
  expect(responsesRoute.options.baseURL).toBe("http://127.0.0.1:3211/zcode/v1");
  expect(Object.keys(responsesRoute.models)).toEqual(["gpt-5.6-sol_relay"]);
  // chat → kind "openai-compatible"。
  const chatRoute = merged.provider["deepaa-gateway-chat"];
  expect(chatRoute.kind).toBe("openai-compatible");
  expect(Object.keys(chatRoute.models)).toEqual(["deepseek-chat_relay"]);
  // 自还原因子挂在条目内部（deepaaManaged），不再有独立 state 供应商。
  expect(merged.provider["deepaa-state"]).toBeUndefined();
  expect(anthropicRoute.deepaaManaged.added).toBe(true);
  expect(responsesRoute.deepaaManaged.added).toBe(true);
});

test("应用内默认模型选择：跟随默认链写入归一路由，用户自选第三方供应商保留，清理层移除（2026-10-06）", () => {
  const mixed = zcodeTarget({
    id: "relay",
    openaiUrl: "https://relay.example/v1",
    supportedModels: ["glm-5.3", "gpt-5.6-sol"],
    supportedModelScopes: {"glm-5.3": ["zcode"], "gpt-5.6-sol": ["zcode"]},
    supportedModelWireApis: {"glm-5.3": ["messages"], "gpt-5.6-sol": ["responses"]},
    development: {
      defaultModels: {zcode: "gpt-5.6-sol"},
      defaultCredentials: {zcode: "cred-zcode"},
    },
  });
  const spec = zcodeCliConfigAdapter.files[0]!;
  const ctx = buildContext(connectedConfig(mixed));
  const plan = zcodeCliConfigAdapter.build(ctx, zcodeCliConfigAdapter.resolvePaths(ctx));
  zcodeCliConfigAdapter.validate(plan);
  // 用户此前自选了第三方供应商：DeepAA 写入的默认选择只接管 DeepAA/复合键形态。
  const existing = JSON.parse(sampleZcodeConfigFile()) as Record<string, unknown>;
  existing.defaultModelSelection = {providerId: "builtin:bigmodel", modelId: "GLM-5.3"};
  const merged = JSON.parse(zcodeCliConfigAdapter.mergeFile({
    file: spec,
    existingRaw: `${JSON.stringify(existing, null, 2)}\n`,
    artifact: configArtifact(plan),
  })) as Record<string, any>;
  // 用户自选非 DeepAA 项保留（模型非复合键、provider 非 deepaa-gateway*）。
  expect(merged.defaultModelSelection).toEqual({providerId: "builtin:bigmodel", modelId: "GLM-5.3"});

  // 无既有选择/既有选择指向受管项：写入默认链（gpt-5.6-sol → responses 路由）。
  const fresh = JSON.parse(sampleZcodeConfigFile()) as Record<string, unknown>;
  const mergedFresh = JSON.parse(zcodeCliConfigAdapter.mergeFile({
    file: spec,
    existingRaw: `${JSON.stringify(fresh, null, 2)}\n`,
    artifact: configArtifact(plan),
  })) as Record<string, any>;
  expect(mergedFresh.defaultModelSelection).toMatchObject({
    providerId: "deepaa-gateway-responses",
    modelId: "gpt-5.6-sol_relay",
  });
  expect(typeof mergedFresh.defaultModelSelection.options?.reasoningLevel).toBe("string");

  // 指向受管项的既有选择会被接管刷新。
  const ours = JSON.parse(sampleZcodeConfigFile()) as Record<string, unknown>;
  ours.defaultModelSelection = {providerId: "deepaa-gateway", modelId: "glm-5.3_relay"};
  const mergedOurs = JSON.parse(zcodeCliConfigAdapter.mergeFile({
    file: spec,
    existingRaw: `${JSON.stringify(ours, null, 2)}\n`,
    artifact: configArtifact(plan),
  })) as Record<string, any>;
  expect(mergedOurs.defaultModelSelection.modelId).toBe("gpt-5.6-sol_relay");

  // 关闭同步 → 清理层：受管默认选择删除；用户自选项保留。
  const disconnected = connectedConfig(mixed);
  (disconnected.agentConnections.zcode as {cliSyncEnabled: boolean}).cliSyncEnabled = false;
  const inactivePlan = zcodeCliConfigAdapter.build(
    buildContext(disconnected), zcodeCliConfigAdapter.resolvePaths(buildContext(disconnected)));
  expect(inactivePlan.active).toBe(false);
  const userKept = JSON.parse(zcodeCliConfigAdapter.mergeFile({
    file: spec,
    existingRaw: JSON.stringify(mergedFresh),
    artifact: configArtifact(inactivePlan),
  })) as Record<string, any>;
  expect(userKept.defaultModelSelection).toBeUndefined();
});

test("透传接管：默认模型选择指向被接管的内置条目", () => {
  const targetValue = zcodeTarget({
    id: "zhipu-plan",
    anthropicUrl: "https://open.bigmodel.cn/api/anthropic",
    credentialMode: "passthrough",
    development: {defaultModels: {zcode: "glm-5.3"}},
  });
  const context = buildContext(connectedConfig(targetValue));
  const plan = zcodeCliConfigAdapter.build(context, zcodeCliConfigAdapter.resolvePaths(context));
  zcodeCliConfigAdapter.validate(plan);
  const merged = JSON.parse(zcodeCliConfigAdapter.mergeFile({
    file: zcodeCliConfigAdapter.files[0]!,
    existingRaw: sampleZcodeConfigFile(),
    artifact: configArtifact(plan),
  })) as Record<string, any>;
  expect(merged.defaultModelSelection).toMatchObject({
    providerId: "builtin:bigmodel-coding-plan",
    modelId: "glm-5.3_zhipu-plan",
  });
});

test("路由缩容：某协议模型清空后，对应网关条目在下次同步自动移除", () => {
  const wide = zcodeTarget({
    id: "relay",
    openaiUrl: "https://relay.example/v1",
    supportedModels: ["glm-5.3", "gpt-5.6-sol"],
    supportedModelScopes: {"glm-5.3": ["zcode"], "gpt-5.6-sol": ["zcode"]},
    supportedModelWireApis: {"glm-5.3": ["messages"], "gpt-5.6-sol": ["responses"]},
  });
  const spec = zcodeCliConfigAdapter.files[0]!;
  const wideCtx = buildContext(connectedConfig(wide));
  const widePlan = zcodeCliConfigAdapter.build(wideCtx, zcodeCliConfigAdapter.resolvePaths(wideCtx));
  const once = zcodeCliConfigAdapter.mergeFile({file: spec, existingRaw: sampleZcodeConfigFile(), artifact: configArtifact(widePlan)});
  expect(JSON.parse(once).provider["deepaa-gateway-responses"]).toBeDefined();

  const narrowed = zcodeTarget({
    id: "relay",
    openaiUrl: "https://relay.example/v1",
    supportedModels: ["glm-5.3"],
    supportedModelScopes: {"glm-5.3": ["zcode"]},
    supportedModelWireApis: {"glm-5.3": ["messages"]},
  });
  const narrowCtx = buildContext(connectedConfig(narrowed));
  const narrowPlan = zcodeCliConfigAdapter.build(narrowCtx, zcodeCliConfigAdapter.resolvePaths(narrowCtx));
  const twice = JSON.parse(zcodeCliConfigAdapter.mergeFile({file: spec, existingRaw: once, artifact: configArtifact(narrowPlan)})) as {provider: Record<string, any>};
  expect(twice.provider["deepaa-gateway-responses"]).toBeUndefined();
  expect(Object.keys(twice.provider["deepaa-gateway"].models)).toEqual(["glm-5.3_relay"]);
});

test("开发启动偏好：推理档不在模板表内时回退推断档并记 LAUNCH_PREFERENCE_EFFORT_UNSUPPORTED（对齐 codex，不静默吞掉）", () => {
  const targetValue = zcodeTarget({id: "zhipu-payg"});
  const cfg = connectedConfig(targetValue);
  cfg.agentConnections.zcode!.launchPreferences = {reasoningEffort: "medium"};
  const context = buildContext(cfg);
  const plan = zcodeCliConfigAdapter.build(context, zcodeCliConfigAdapter.resolvePaths(context));
  expect(plan.warnings.some(warning =>
    warning.code === "LAUNCH_PREFERENCE_EFFORT_UNSUPPORTED" && warning.message.includes("medium"),
  )).toBe(true);
  const merged = JSON.parse(zcodeCliConfigAdapter.mergeFile({
    file: zcodeCliConfigAdapter.files[0]!,
    existingRaw: sampleZcodeConfigFile(),
    artifact: configArtifact(plan),
  })) as {provider: Record<string, any>};
  // glm 非 anthropic/gpt 家族 → 共享推断链落表回退 max。
  const entry = merged.provider["deepaa-gateway"].models["glm-5.3_zhipu-payg"];
  expect(entry.reasoning.defaultVariant).toBe("max");
});

// ———————— 个人规则层（provider_config.json，新架构真相文件，2026-10-06 实证） ————————

function personalSpec() {
  const spec = zcodeCliConfigAdapter.files.find(file => file.id === "zcode-provider-config");
  if (!spec) throw new Error("missing zcode-provider-config spec");
  return spec;
}

/** 三协议目标：messages/responses/chat 各一个模型，走注入模式。 */
function triWireTarget(): ProxyTarget {
  const supportedModels = ["glm-5.3", "gpt-6.1-sol", "deepseek-v4.1-flash"];
  return zcodeTarget({
    id: "catapi.chat",
    openaiUrl: "https://catapi.chat/v1",
    supportedModels,
    supportedModelScopes: Object.fromEntries(supportedModels.map(model => [model, ["zcode"]])),
    supportedModelWireApis: {
      "glm-5.3": ["messages"],
      "gpt-6.1-sol": ["responses"],
      "deepseek-v4.1-flash": ["chat_completions"],
    },
    development: {defaultModels: {zcode: "gpt-6.1-sol"}, defaultCredentials: {zcode: "cred-zcode"}},
  });
}

test("个人层注入：三路由 rules 全量重建受管键，迁移残留与旧模型规则回收，用户内容逐字保留", () => {
  const context = buildContext(connectedConfig(triWireTarget()));
  const plan = zcodeCliConfigAdapter.build(context, zcodeCliConfigAdapter.resolvePaths(context));
  expect(plan.active).toBe(true);
  zcodeCliConfigAdapter.validate(plan);

  const merged = JSON.parse(zcodeCliConfigAdapter.mergeFile({
    file: personalSpec(),
    existingRaw: sampleProviderConfigFile(),
    artifact: personalArtifact(plan),
  }));
  const rules = merged.config.providerConfigRules.providerRules as Array<Record<string, any>>;
  const byId = new Map(rules.map(rule => [rule.providerId, rule]));
  // 三路由落位：api.type 与 baseUrl 严格按协议映射（openai 系带 /zcode/v1）。
  expect(byId.get("deepaa-gateway").config.api).toEqual({type: "anthropic-messages", baseUrl: "http://127.0.0.1:3211/zcode"});
  expect(byId.get("deepaa-gateway-responses").config.api).toEqual({type: "openai-responses", baseUrl: "http://127.0.0.1:3211/zcode/v1"});
  expect(byId.get("deepaa-gateway-chat").config.api).toEqual({type: "openai-chat-completions", baseUrl: "http://127.0.0.1:3211/zcode/v1"});
  for (const [providerId, modelId] of [
    ["deepaa-gateway", "glm-5.3_catapi.chat"],
    ["deepaa-gateway-responses", "gpt-6.1-sol_catapi.chat"],
    ["deepaa-gateway-chat", "deepseek-v4.1-flash_catapi.chat"],
  ] as const) {
    const rule = byId.get(providerId);
    expect(rule.providerName).toBeTruthy();
    expect(rule.enabled).toBe(true);
    expect(rule.config.group).toBe("standard-personal");
    expect(rule.config.access).toEqual({type: "api-key", apiKey: "deepaa-gateway"});
    expect(rule.config.personalModelIds).toEqual([modelId]);
    expect(rule.config.modelOrder).toEqual([modelId]);
  }
  // 迁移残留（deepaa-state）与旧受管模型（glm-5.3_old-target）被回收。
  expect(byId.get("deepaa-state")).toBeUndefined();
  const modelRules = merged.config.modelConfigRules.providerModelRules as Array<Record<string, any>>;
  expect(modelRules.some(rule => rule.providerId === "deepaa-state")).toBe(false);
  expect(modelRules.some(rule => rule.modelId === "glm-5.3_old-target")).toBe(false);
  // 新模型 contextWindow 规则生成；用户 modelRules 与 manual 规则原样保留。
  expect(modelRules).toContainEqual({modelId: "glm-5.3_catapi.chat", config: {properties: {contextWindow: 272000}}, providerId: "deepaa-gateway"});
  expect(modelRules).toContainEqual({modelId: "own-model", config: {properties: {contextWindow: 8192}}, providerId: "my-own"});
  expect(merged.config.modelConfigRules.manualProviderModelRules).toEqual([
    {modelId: "own-model", providerId: "my-own", note: "手动规则必须原样保留"},
  ]);
  expect(byId.get("my-own").config.access.apiKey).toBe("sk-user-own");
  // 受管默认选择写入 config.defaultModelSelection（跟随默认模型 gpt-6.1-sol → responses 路由）。
  expect(merged.config.defaultModelSelection).toEqual({
    providerId: "deepaa-gateway-responses",
    modelId: "gpt-6.1-sol_catapi.chat",
    options: {reasoningLevel: expect.any(String)},
  });
  expect(merged.schemaVersion).toBe(1);
});

test("个人层默认选择：用户自选第三方供应商保留；受管指向可被刷新", () => {
  const context = buildContext(connectedConfig(triWireTarget()));
  const plan = zcodeCliConfigAdapter.build(context, zcodeCliConfigAdapter.resolvePaths(context));
  const withUserChoice = JSON.parse(sampleProviderConfigFile());
  withUserChoice.config.defaultModelSelection = {providerId: "my-own", modelId: "own-model"};
  const merged = JSON.parse(zcodeCliConfigAdapter.mergeFile({
    file: personalSpec(),
    existingRaw: `${JSON.stringify(withUserChoice, null, 2)}\n`,
    artifact: personalArtifact(plan),
  }));
  expect(merged.config.defaultModelSelection).toEqual({providerId: "my-own", modelId: "own-model"});
  // 指向受管路由的旧选择（迁移残留）会被指令刷新。
  const withManagedChoice = JSON.parse(sampleProviderConfigFile());
  withManagedChoice.config.defaultModelSelection = {providerId: "deepaa-gateway", modelId: "glm-5.3_old-target"};
  const refreshed = JSON.parse(zcodeCliConfigAdapter.mergeFile({
    file: personalSpec(),
    existingRaw: `${JSON.stringify(withManagedChoice, null, 2)}\n`,
    artifact: personalArtifact(plan),
  }));
  expect(refreshed.config.defaultModelSelection.providerId).toBe("deepaa-gateway-responses");
});

test("个人层清理：停用同步删除全部受管痕迹；用户内容保留；无痕迹文件 no-op；文件缺失不创建", () => {
  const connected = connectedConfig(triWireTarget());
  (connected.agentConnections.zcode as {cliSyncEnabled: boolean}).cliSyncEnabled = false;
  const context = buildContext(connected);
  const inactivePlan = zcodeCliConfigAdapter.build(context, zcodeCliConfigAdapter.resolvePaths(context));
  expect(inactivePlan.active).toBe(false);
  zcodeCliConfigAdapter.validate(inactivePlan);
  const restored = JSON.parse(zcodeCliConfigAdapter.mergeFile({
    file: personalSpec(),
    existingRaw: sampleProviderConfigFile(),
    artifact: personalArtifact(inactivePlan),
  }));
  const ruleIds = (restored.config.providerConfigRules.providerRules as Array<Record<string, any>>).map(rule => rule.providerId);
  expect(ruleIds).toEqual(["my-own"]);
  expect((restored.config.modelConfigRules.providerModelRules as Array<Record<string, any>>).map(rule => rule.providerId)).toEqual(["my-own"]);
  expect(restored.config.defaultModelSelection).toBeUndefined();
  expect(restored.config.modelConfigRules.manualProviderModelRules).toHaveLength(1);

  // 用户纯净文件（无任何受管痕迹）：清理层必须是 no-op，返回空串由公共引擎跳过写入。
  const pristine = `${JSON.stringify({
    schemaVersion: 1,
    config: {
      providerConfigRules: {providerRules: [{providerId: "my-own", config: {group: "standard-personal"}}]},
      modelConfigRules: {providerModelRules: []},
    },
  }, null, 2)}\n`;
  expect(zcodeCliConfigAdapter.mergeFile({
    file: personalSpec(),
    existingRaw: pristine,
    artifact: personalArtifact(inactivePlan),
  })).toBe("");

  // 文件不存在：不创建（新架构 App 首启会从 legacy config.json importLegacy 自动生成）。
  expect(zcodeCliConfigAdapter.mergeFile({
    file: personalSpec(),
    existingRaw: undefined,
    artifact: personalArtifact(inactivePlan),
  })).toBe("");
  const activePlan = zcodeCliConfigAdapter.build(
    buildContext(connectedConfig(triWireTarget())),
    zcodeCliConfigAdapter.resolvePaths(buildContext(connectedConfig(triWireTarget()))),
  );
  expect(zcodeCliConfigAdapter.mergeFile({
    file: personalSpec(),
    existingRaw: undefined,
    artifact: personalArtifact(activePlan),
  })).toBe("");
});

test("个人层防破坏：无法解析或未知 schemaVersion 的用户文件拒绝改写", () => {
  const context = buildContext(connectedConfig(triWireTarget()));
  const plan = zcodeCliConfigAdapter.build(context, zcodeCliConfigAdapter.resolvePaths(context));
  const corrupted = "{ not json";
  expect(zcodeCliConfigAdapter.mergeFile({
    file: personalSpec(),
    existingRaw: corrupted,
    artifact: personalArtifact(plan),
  })).toBe(corrupted);
  const futureSchema = `${JSON.stringify({schemaVersion: 2, config: {providerConfigRules: {providerRules: []}}})}\n`;
  expect(zcodeCliConfigAdapter.mergeFile({
    file: personalSpec(),
    existingRaw: futureSchema,
    artifact: personalArtifact(plan),
  })).toBe(futureSchema);
});

test("个人层透传模式：不写受管规则，只清理 inject 时代残留", () => {
  const targetValue = zcodeTarget({
    id: "zhipu-plan",
    anthropicUrl: "https://open.bigmodel.cn/api/anthropic",
    credentialMode: "passthrough",
    development: {defaultModels: {zcode: "glm-5.3"}},
  });
  const context = buildContext(connectedConfig(targetValue));
  const plan = zcodeCliConfigAdapter.build(context, zcodeCliConfigAdapter.resolvePaths(context));
  expect(plan.active).toBe(true);
  zcodeCliConfigAdapter.validate(plan);
  const instruction = JSON.parse(personalArtifact(plan).content);
  expect(instruction.mode).toBe("cleanup");
  const merged = JSON.parse(zcodeCliConfigAdapter.mergeFile({
    file: personalSpec(),
    existingRaw: sampleProviderConfigFile(),
    artifact: personalArtifact(plan),
  }));
  const ruleIds = (merged.config.providerConfigRules.providerRules as Array<Record<string, any>>).map(rule => rule.providerId);
  expect(ruleIds).toEqual(["my-own"]);
});

test("个人层 validate：非法路由键 / 非网关 baseUrl / 非复合模型 ID / 默认选择越权均拒绝", () => {
  const context = buildContext(connectedConfig(triWireTarget()));
  const plan = zcodeCliConfigAdapter.build(context, zcodeCliConfigAdapter.resolvePaths(context));
  const base = JSON.parse(personalArtifact(plan).content);
  const mutate = (mutation: (instruction: Record<string, any>) => void) => {
    const instruction = JSON.parse(JSON.stringify(base));
    mutation(instruction);
    const artifacts = plan.artifacts.map(item => item.specId === "zcode-provider-config"
      ? {...item, content: JSON.stringify(instruction)}
      : item);
    expect(() => zcodeCliConfigAdapter.validate({...plan, artifacts})).toThrow(/ZCODE_PLAN_INVALID/);
  };
  mutate(instruction => {instruction.rules[0].providerId = "not-ours";});
  mutate(instruction => {instruction.rules[0].baseUrl = "https://upstream.example.com";});
  mutate(instruction => {instruction.rules[0].modelIds = ["glm-no-prefix"];});
  mutate(instruction => {instruction.rules[0].apiType = "openai-responses";});
  mutate(instruction => {instruction.defaultModelSelection = {providerId: "my-own", modelId: "own-model"};});
  mutate(instruction => {instruction.rules[0].contextWindows = {"unknown-model": 123};});
});
