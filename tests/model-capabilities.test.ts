import {expect, test} from "vitest";
import type {CatalogOverrides, CatalogTemplate} from "../src/lib/config-sync/catalog-template.js";
import {
  FALLBACK_CONTEXT_WINDOW,
  resolveDefaultReasoningLevel,
  resolveModelRuntimeCaps,
} from "../src/lib/config-sync/model-capabilities.js";
import {
  collectCapabilityModelChanges,
  resolveAgentsForModelChanges,
} from "../src/lib/config-sync/capability-follow.js";
import {modelFamilyOf} from "../src/lib/model-family.js";
import type {ModelPriceEntry, PricingConfig, PricingConfigV2} from "../src/lib/pricing.js";
import type {ProxyConfig, ProxyTarget} from "../src/types.js";

const template: CatalogTemplate = {
  defaults: {
    contextWindow: 272000,
    inputModalities: ["text"],
    supportedReasoningLevels: [
      {effort: "low", description: "low"},
      {effort: "high", description: "high"},
      {effort: "max", description: "max"},
    ],
    defaultReasoningLevel: "high",
  },
  families: {
    "gpt-5.6": {contextWindow: 350000},
    gpt: {inputModalities: ["text", "image"]},
    claude: {inputModalities: ["text", "image"]},
  },
  agents: {},
};

function target(overrides: Partial<ProxyTarget> & Pick<ProxyTarget, "id">): ProxyTarget {
  return {
    id: overrides.id,
    name: overrides.id,
    enabled: true,
    openaiUrl: "https://example.com/v1",
    supportedModels: overrides.supportedModels ?? ["glm-5.3-flashx"],
    ...overrides,
  } as ProxyTarget;
}

function priceEntry(overrides: Partial<ModelPriceEntry> & Pick<ModelPriceEntry, "id" | "vendor">): ModelPriceEntry {
  return {
    id: overrides.id,
    vendor: overrides.vendor,
    runtimeModelId: "glm-5.3-flashx",
    match: "glm-5.3-flashx",
    patterns: ["glm-5.3-flashx"],
    mode: "chat",
    pricing: {input: 1, output: 2},
    confidence: "official",
    ...overrides,
  } as ModelPriceEntry;
}

const emptyOverrides: CatalogOverrides = {};

test("解析链四级优先：覆盖 > 价格中心 > 模板家族/全局 > 常量", () => {
  const t = target({id: "bigmodel.cn"});
  // ④ 常量兜底：无价格中心、模板无 glm 家族条目。
  expect(resolveModelRuntimeCaps({target: t, modelId: "unknown-model", template, overrides: emptyOverrides}))
    .toMatchObject({contextWindow: FALLBACK_CONTEXT_WINDOW, inputModalities: ["text"]});

  // ③ 模板家族层：gpt 家族模态、gpt-5.6 家族窗口（产品级兜底，与目标是否官方无关）。
  expect(resolveModelRuntimeCaps({target: t, modelId: "gpt-5.6-sol", template, overrides: emptyOverrides}))
    .toMatchObject({contextWindow: 350000, inputModalities: ["text", "image"]});

  // ② 价格中心条目（priceEntryId 精确命中）：窗口与模态均为运行时真相。
  const withMapping = target({
    id: "bigmodel.cn",
    pricing: {vendor: "zhipu", modelVendors: {"glm-5.3-flashx": {vendor: "zhipu", priceEntryId: "entry-1"}}},
  });
  const entries = new Map<string, ModelPriceEntry>([
    ["entry-1", priceEntry({id: "entry-1", vendor: "zhipu", contextWindow: 1048576, inputModalities: ["text", "image"]})],
  ]);
  expect(resolveModelRuntimeCaps({target: withMapping, modelId: "glm-5.3-flashx", pricingEntriesById: entries, template, overrides: emptyOverrides}))
    .toMatchObject({contextWindow: 1048576, inputModalities: ["text", "image"]});

  // ① 用户编目覆盖（蛇形兼容键）优先于一切。
  const overrides: CatalogOverrides = {"glm-5.3-flashx": {context_window: 999000, input_modalities: ["text"]}};
  expect(resolveModelRuntimeCaps({target: withMapping, modelId: "glm-5.3-flashx", pricingEntriesById: entries, template, overrides}))
    .toMatchObject({contextWindow: 999000, inputModalities: ["text"]});

  // 价格中心条目字段缺省（如 litellm 条目无模态）：该级视为未声明，回落模板层。
  const noModalityEntries = new Map<string, ModelPriceEntry>([
    ["entry-1", priceEntry({id: "entry-1", vendor: "zhipu", contextWindow: 1048576})],
  ]);
  expect(resolveModelRuntimeCaps({target: withMapping, modelId: "glm-5.3-flashx", pricingEntriesById: noModalityEntries, template, overrides: emptyOverrides}))
    .toMatchObject({contextWindow: 1048576, inputModalities: ["text"]});
});

test("默认推理档推断：anthropic/responses 家族 xhigh、其余 max，落表校验", () => {
  expect(resolveDefaultReasoningLevel("claude-sonnet-5", template)).toBe("max"); // xhigh 不在表内 → 回退最高档
  expect(resolveDefaultReasoningLevel("glm-5.3", template)).toBe("max");
  expect(resolveDefaultReasoningLevel("deepseek-flash", template)).toBe("max");
  const withXhigh: CatalogTemplate = {
    ...template,
    defaults: {
      ...template.defaults,
      supportedReasoningLevels: [
        {effort: "low", description: "low"},
        {effort: "xhigh", description: "xhigh"},
        {effort: "max", description: "max"},
      ],
    },
  };
  expect(resolveDefaultReasoningLevel("claude-sonnet-5", withXhigh)).toBe("xhigh");
  expect(resolveDefaultReasoningLevel("gpt-5.6-sol", withXhigh)).toBe("xhigh");
});

test("模型家族判定：命名空间前缀剥除、大写归一、具体前缀优先", () => {
  expect(modelFamilyOf("gpt-5.6-sol")).toBe("gpt-5.6");
  expect(modelFamilyOf("openai/gpt-5.6-sol")).toBe("gpt-5.6");
  expect(modelFamilyOf("gpt-5.5")).toBe("gpt");
  expect(modelFamilyOf("o3-mini")).toBe("gpt");
  expect(modelFamilyOf("claude-opus-5")).toBe("claude");
  expect(modelFamilyOf("anthropic/claude-sonnet-5")).toBe("claude");
  expect(modelFamilyOf("MiniMax-M3")).toBe("minimax");
  expect(modelFamilyOf("minimax-m3")).toBe("minimax");
  expect(modelFamilyOf("glm-5.3-flashx")).toBe("glm");
  expect(modelFamilyOf("unknown-thing")).toBeUndefined();
});

function pricingConfig(entries: ModelPriceEntry[]): PricingConfig {
  return {version: 2, currency: "USD", unit: "per_million_tokens", models: entries} as unknown as PricingConfig;
}

test("能力变化门控：纯价格变化与新模型不进集合，能力字段变化进集合", () => {
  const before = pricingConfig([
    priceEntry({id: "e1", vendor: "zhipu", contextWindow: 1048576, inputModalities: ["text"]}),
    priceEntry({id: "e2", vendor: "deepseek", contextWindow: 1048576, inputModalities: ["text", "image"]}),
  ]);
  // 纯价格变化（input 1→3）：不触发。
  const priceOnly = pricingConfig([
    priceEntry({id: "e1", vendor: "zhipu", contextWindow: 1048576, inputModalities: ["text"], pricing: {input: 3, output: 2}}),
    priceEntry({id: "e2", vendor: "deepseek", contextWindow: 1048576, inputModalities: ["text", "image"]}),
  ]);
  expect(collectCapabilityModelChanges(before, priceOnly)).toEqual(new Set());

  // 模态变化（text→text+image）：触发。
  const modalityChanged = pricingConfig([
    priceEntry({id: "e1", vendor: "zhipu", contextWindow: 1048576, inputModalities: ["text", "image"]}),
    priceEntry({id: "e2", vendor: "deepseek", contextWindow: 1048576, inputModalities: ["text", "image"]}),
  ]);
  expect(collectCapabilityModelChanges(before, modalityChanged))
    .toEqual(new Set(["zhipu\u0000glm-5.3-flashx"]));

  // 窗口变化：触发。
  const windowChanged = pricingConfig([
    priceEntry({id: "e1", vendor: "zhipu", contextWindow: 2097152, inputModalities: ["text"]}),
    priceEntry({id: "e2", vendor: "deepseek", contextWindow: 1048576, inputModalities: ["text", "image"]}),
  ]);
  expect(collectCapabilityModelChanges(before, windowChanged).size).toBe(1);

  // 新插入条目（无既有条目）：不进集合。
  const withNew = pricingConfig([
    ...JSON.parse(JSON.stringify(before.models)),
    priceEntry({id: "e3", vendor: "moonshot", runtimeModelId: "kimi-k3", match: "kimi-k3", patterns: ["kimi-k3"], contextWindow: 1048576, inputModalities: ["text", "image"]}),
  ]);
  expect(collectCapabilityModelChanges(before, withNew)).toEqual(new Set());
});

function agentConfig(boundTargetIds: string[], agent: string, targetId: string): ProxyConfig {
  return {
    revision: 1,
    version: 3,
    localProxyBaseUrl: "http://127.0.0.1:3211",
    agentConnections: {
      [agent]: {
        boundTargetIds,
        defaultTargetId: targetId,
        cliSyncEnabled: true,
      },
    },
    targets: [target({id: targetId, pricing: {vendor: "zhipu", modelVendors: {}}})],
  } as unknown as ProxyConfig;
}

test("定向 Agent 判定：只有绑定目标包含受影响模型且开启同步的 Agent 受影响", () => {
  const changed = new Set(["zhipu\u0000glm-5.3-flashx"]);
  const config = {
    revision: 1,
    version: 3,
    localProxyBaseUrl: "http://127.0.0.1:3211",
    agentConnections: {
      dsh: {boundTargetIds: ["bigmodel.cn"], defaultTargetId: "bigmodel.cn", cliSyncEnabled: true},
      zcode: {boundTargetIds: ["bigmodel.cn"], defaultTargetId: "bigmodel.cn", cliSyncEnabled: true},
      codex: {boundTargetIds: ["bigmodel.cn"], defaultTargetId: "bigmodel.cn", cliSyncEnabled: false},
      claude: {boundTargetIds: ["bigmodel.cn"], defaultTargetId: "bigmodel.cn", cliSyncEnabled: true},
    },
    targets: [target({
      id: "bigmodel.cn",
      supportedModels: ["glm-5.3-flashx"],
      supportedModelScopes: {"glm-5.3-flashx": ["dsh", "zcode", "claude", "codex", "opencode"]},
      supportedModelWireApis: {"glm-5.3-flashx": ["chat_completions", "messages", "responses"]},
      pricing: {vendor: "zhipu", modelVendors: {"glm-5.3-flashx": {vendor: "zhipu", priceEntryId: "entry-1"}}},
      development: {
        defaultModels: {dsh: "glm-5.3-flashx", zcode: "glm-5.3-flashx", claude: "glm-5.3-flashx"},
        defaultCredentials: {dsh: "c", zcode: "c", claude: "c"},
      },
    })],
  } as unknown as ProxyConfig;
  // dsh/zcode 绑定且开启同步；codex 关闭同步；claude 无 dsh 系协议凭据链不完整也不会命中（此处凭据齐全但 claude 绑定目标含模型——claude 目标必须有 anthropicUrl，本目标只有 openaiUrl → 排除）。
  const agents = resolveAgentsForModelChanges(config, changed);
  expect(agents).toContain("dsh");
  expect(agents).toContain("zcode");
  expect(agents).not.toContain("codex");
  expect(agents).not.toContain("claude");

  // 未受影响模型（其它 vendor）：零 Agent。
  expect(resolveAgentsForModelChanges(config, new Set(["deepseek\u0000glm-5.3-flashx"]))).toEqual([]);

  // 空集合零开销。
  expect(resolveAgentsForModelChanges(agentConfig(["bigmodel.cn"], "dsh", "bigmodel.cn"), new Set())).toEqual([]);
});

test("定向 Agent 判定按逐模型 vendor 映射，不依赖目标级 pricing.vendor", () => {
  const config = {
    revision: 1,
    version: 3,
    localProxyBaseUrl: "http://127.0.0.1:3211",
    agentConnections: {
      opencode: {boundTargetIds: ["relay"], defaultTargetId: "relay", cliSyncEnabled: true},
    },
    targets: [target({
      id: "relay",
      openaiUrl: "https://relay.example/v1",
      supportedModels: ["claude-sonnet-5"],
      supportedModelScopes: {"claude-sonnet-5": ["opencode"]},
      supportedModelWireApis: {"claude-sonnet-5": ["responses"]},
      pricing: {
        vendor: "openai",
        modelVendors: {"claude-sonnet-5": {vendor: "anthropic", priceEntryId: "anthropic:claude-sonnet-5"}},
      },
      development: {
        defaultModels: {opencode: "claude-sonnet-5"},
        defaultCredentials: {opencode: "credential"},
      },
    })],
  } as unknown as ProxyConfig;
  expect(resolveAgentsForModelChanges(config, new Set(["anthropic\u0000claude-sonnet-5"])))
    .toEqual(["opencode"]);
});

test("端到端：价格中心声明 image 的模型在 dsh 受管配置中放开贴图（GLM-5.3-FlashX 场景）", async () => {
  const {dshCliConfigAdapter} = await import("../src/lib/config-sync/adapters/dsh.js");
  const {createCliSyncContext} = await import("../src/lib/config-sync/core/sync-context.js");
  const entries = new Map<string, ModelPriceEntry>([
    ["entry-1", priceEntry({id: "entry-1", vendor: "zhipu", contextWindow: 1048576, inputModalities: ["text", "image"]})],
  ]);
  const config = {
    revision: 1,
    version: 3,
    localProxyBaseUrl: "http://127.0.0.1:3211",
    agentConnections: {
      dsh: {boundTargetIds: ["bigmodel.cn"], defaultTargetId: "bigmodel.cn", cliSyncEnabled: true},
    },
    targets: [target({
      id: "bigmodel.cn",
      name: "智谱",
      supportedModels: ["glm-5.3-flashx"],
      supportedModelScopes: {"glm-5.3-flashx": ["dsh", "zcode", "claude", "codex", "opencode"]},
      pricing: {vendor: "zhipu", modelVendors: {"glm-5.3-flashx": {vendor: "zhipu", priceEntryId: "entry-1"}}},
      supportedModelWireApis: {"glm-5.3-flashx": ["chat_completions"]},
      development: {defaultModels: {dsh: "glm-5.3-flashx"}, defaultCredentials: {dsh: "cred"}},
    })],
  } as unknown as ProxyConfig;
  const context = createCliSyncContext({
    config,
    paths: {
      codexConfigPath: "/tmp/x/config.toml",
      codexCatalogPath: "/tmp/x/all.json",
      claudeUserSettingsPath: "/tmp/x/settings.json",
      claudeProjectSettingsPaths: {},
      gatewayBaseUrl: "http://127.0.0.1:3211",
      gatewayBearerToken: "deepaa-gateway",
    },
    template,
    overrides: emptyOverrides,
    pricingEntriesById: entries,
  });
  const plan = dshCliConfigAdapter.build(context, dshCliConfigAdapter.resolvePaths(context));
  const artifact = plan.artifacts.find(item => item.specId === "dsh-settings")!;
  const parsed = JSON.parse(JSON.stringify(artifact.content)) as string;
  expect(parsed).toContain("glm-5.3-flashx_bigmodel.cn");
  expect(parsed).toContain("contextWindow: 1048576");
  expect(parsed).toContain("- text");
  expect(parsed).toContain("- image");
});

test("模板守护：随包模板结构合法、零模型条目、families/agents 键在合法值域", async () => {
  const {readFile} = await import("node:fs/promises");
  const {join} = await import("node:path");
  const {readCatalogTemplate} = await import("../src/lib/config-sync/catalog-template.js");
  const raw = JSON.parse(await readFile(join(process.cwd(), "config", "agents", "catalog-template.json"), "utf8")) as Record<string, unknown>;
  // 零模型条目红线：任何层级都不得出现 models 模型表。
  expect("models" in raw).toBe(false);
  const template = await readCatalogTemplate(join(process.cwd(), "config", "agents", "catalog-template.json"));
  expect(template.defaults.supportedReasoningLevels.length).toBeGreaterThan(0);
  for (const family of Object.keys(template.families)) {
    expect(modelFamilyOf(`dummy-${family}`) === undefined ? ["gpt-5.6", "gpt", "claude", "glm", "deepseek", "kimi", "minimax", "qwen", "grok", "hunyuan", "doubao"].includes(family) : true).toBe(true);
  }
  expect(Object.keys(template.agents).length).toBeGreaterThan(0);
  expect(template.agents.codex?.defaults?.base_instructions).toEqual(expect.any(String));
});

test("normalizePricingConfig 白名单放行 inputModalities（防静默丢弃）", async () => {
  const {normalizePricingConfig} = await import("../src/lib/pricing.js");
  const config = pricingConfig([priceEntry({id: "e1", vendor: "zhipu", inputModalities: ["text", "image"]})]) as PricingConfigV2;
  config.version = 2;
  config.currency = "USD";
  config.unit = "per_million_tokens";
  config.models = config.models as ModelPriceEntry[];
  const normalized = normalizePricingConfig(config as never);
  expect(normalized.models[0]!.inputModalities).toEqual(["text", "image"]);
});
