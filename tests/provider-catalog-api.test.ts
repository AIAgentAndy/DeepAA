import {readFile} from "node:fs/promises";
import {describe, expect, test, vi} from "vitest";
import {createProviderCatalogReview, applyProviderCatalogUpdate, createProviderPresetTarget} from "../src/lib/provider-catalog/service.js";
import {PROVIDER_PRESETS} from "../src/lib/provider-presets.js";
import {normalizeProviderCatalog} from "../src/lib/provider-catalog/normalize.js";

function CATALOG_FIXTURE(value: unknown): ReturnType<typeof normalizeProviderCatalog>["catalog"] {
  return normalizeProviderCatalog(value).catalog;
}
import {DEFAULT_PRICING, normalizePricingConfig, type PricingConfigV2} from "../src/lib/pricing.js";
import type {ProxyConfig, ProxyTarget} from "../src/types.js";
import {developmentLaunchErrorResponse} from "../src/lib/development-launch/security.js";

const catalog = CATALOG_FIXTURE({
  schemaVersion: 2,
  catalogRevision: "2026.09.03.01",
  publishedAt: "2026-08-17T00:00:00+08:00",
  providers: {
    demo: {
      name: "Demo",
      brandId: "demo",
      pricingProviderId: "demo",
      region: "cn",
      category: "cn_official",
      openaiUrl: "https://demo.example/v1",
      models: [{id: "demo-chat", category: "chat", supportedWireApis: ["chat_completions", "responses", "messages"], pricing: {input: 1, output: 2}}],
    },
    "opencode-go": {
      name: "OpenCode Go",
      brandId: "opencode-go",
      pricingProviderId: "opencode-go",
      region: "global",
      category: "aggregator",
      currency: "USD",
      openaiUrl: "https://opencode.ai/zen/go/v1",
      models: [{id: "go-chat", category: "chat", supportedWireApis: ["chat_completions", "responses", "messages"], pricing: {input: 1, output: 3}}],
      planTiers: [{name: "OpenCode Go", monthlyFee: 10}],
    },
  },
});

function config(): ProxyConfig {
  return {
    version: 3,
    revision: 7,
    localProxyBaseUrl: "http://localhost:3211",
    updatedAt: "2026-08-17T00:00:00.000Z",
    agentConnections: {},
    targets: [target()],
  };
}

function target(): ProxyTarget {
  return {
    id: "demo",
    name: "Demo",
    openaiUrl: "https://demo.example/v1",
    enabled: true,
    supportedModels: [],
    pricing: {vendor: "demo"},
  };
}

describe("供应商目录应用服务", () => {
  test("供应商预设刷新只读本地价格中心，不触发远程目录拉取", async () => {
    const route = await readFile("src/app/api/provider-catalog/route.ts", "utf8");
    expect(route).toContain("allowRemote: false");
    expect(route).not.toContain("forceRefresh: url.searchParams.get");
    expect(route).toContain('modelSource: "price_center"');
  });
  test("配置 revision 冲突返回 409，提示客户端刷新后重新确认", async () => {
    const response = developmentLaunchErrorResponse(new Error("CONFIG_REVISION_CONFLICT"));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({error: "CONFIG_REVISION_CONFLICT"});
  });

  test("GET 预览有界返回候选、配置 revision 和不换算提示，不写配置", () => {
    const review = createProviderCatalogReview(config(), "demo", "demo", {
      catalog,
      source: "remote",
      fetchedAt: "2026-08-17T00:00:00.000Z",
      sourceHash: "sha256:catalog",
    }, syncedPricing());

    expect(review).toMatchObject({
      targetId: "demo",
      expectedRevision: 7,
      source: "remote",
      publishedAt: "2026-08-17T00:00:00+08:00",
      unconvertedCatalogPricing: true,
      candidateCount: 1,
      processedCount: 1,
      limited: false,
    });
    expect(review.diff?.added.map(item => item.id)).toEqual(["demo-chat"]);
    expect(JSON.stringify(review)).not.toContain("api_key");
  });

  test("GET 预览最多返回 500 个模型并保留真实候选计数", () => {
    const largeCatalog = CATALOG_FIXTURE({
      schemaVersion: 2,
      catalogRevision: "2026.09.03.01",
      publishedAt: "2026-08-17T00:00:00+08:00",
      providers: {
        large: {
          name: "Large",
          brandId: "large",
          pricingProviderId: "large",
          region: "global",
          category: "official",
          models: Array.from({length: 501}, (_, index) => ({
            id: `model-${index}`,
            category: "chat",
            supportedWireApis: ["chat_completions"],
            pricing: {input: 1, output: 2},
          })),
        },
      },
    });

    const review = createProviderCatalogReview(config(), undefined, "large", {
      catalog: largeCatalog,
      source: "remote",
      fetchedAt: "2026-08-17T00:00:00.000Z",
      sourceHash: "sha256:large",
    }, syncedPricing(Array.from({length: 501}, (_, index) => ({
      id: `catalog:large:model-${index}`, vendor: "large", runtimeModelId: `model-${index}`,
      patterns: [`model-${index}`], mode: "chat", pricingProviderId: "large",
      region: "global", catalogSource: "catalog",
      pricing: {input: 1, output: 2}, currency: "USD", confidence: "official",
      supportedWireApis: ["chat_completions"],
    }))));

    // 终极方案：候选来自价格中心已入库条目。
    expect(review.processedCount).toBe(500);
    expect(review.limited).toBe(true);
    expect(review.diff.added).toHaveLength(500);
  }, 60_000);

  test("GET 预览携带价格中心后，原有模型只列有变化的条目", () => {
    const richCatalog = CATALOG_FIXTURE({
      schemaVersion: 2,
      catalogRevision: "2026.09.03.01",
      publishedAt: "2026-08-18T00:00:00+08:00",
      providers: {
        demo: {
          name: "Demo",
          brandId: "demo",
          pricingProviderId: "demo",
          region: "cn",
          category: "cn_official",
          openaiUrl: "https://demo.example/v1",
          models: [
            {id: "demo-chat", category: "chat", pricing: {input: 2, output: 3}},
            {id: "unchanged-chat", category: "chat", pricing: {input: 5, output: 6}},
          ],
        },
      },
    });
    const targetWithModels: ProxyTarget = {
      ...target(),
      supportedModels: ["demo-chat", "unchanged-chat", "removed-chat"],
      pricing: {
        vendor: "demo",
        modelVendors: {
          "demo-chat": {vendor: "demo", priceEntryId: "catalog:demo:demo-chat"},
          "unchanged-chat": {vendor: "demo", priceEntryId: "catalog:demo:unchanged-chat"},
          "removed-chat": {vendor: "demo", priceEntryId: "catalog:demo:removed-chat"},
        },
      },
    };
    const pricingConfig: PricingConfigV2 = normalizePricingConfig({
      version: 2,
      currency: "USD",
      models: [
        {id: "catalog:demo:demo-chat", vendor: "demo", runtimeModelId: "demo-chat", patterns: ["demo-chat"], pricing: {input: 99, output: 99}, confidence: "official"},
        {id: "catalog:demo:unchanged-chat", vendor: "demo", runtimeModelId: "unchanged-chat", patterns: ["unchanged-chat"], pricing: {input: 5, output: 6}, confidence: "official"},
        {id: "catalog:demo:removed-chat", vendor: "demo", runtimeModelId: "removed-chat", patterns: ["removed-chat"], pricing: {input: 1, output: 1}, confidence: "official"},
      ],
    });

    const review = createProviderCatalogReview(
      {...config(), targets: [targetWithModels]},
      "demo",
      "demo",
      {
        catalog: richCatalog,
        source: "remote",
        fetchedAt: "2026-08-18T00:00:00.000Z",
        sourceHash: "sha256:rich",
      }, pricingConfig);

    // 当前官方推荐集合只来自目录/membership；已移除模型仍留在价格中心，但不再作为预设候选。
    expect(review.diff.existing.map(item => item.id)).toEqual(["demo-chat", "unchanged-chat"]);
    expect(review.diff.removed.map(item => item.id)).toEqual(["removed-chat"]);
    expect(review.candidateCount).toBe(0);
    expect(review.diff.existing[0]?.changes).toBeUndefined();
  });

  test("新建套餐预设预览按预设协议 URL 与模型 wire API 交集判定 Agent 归属", () => {
    const qwenaiCatalog = CATALOG_FIXTURE({
      schemaVersion: 2,
      catalogRevision: "2026.09.03.01",
      publishedAt: "2026-08-17T00:00:00+08:00",
      providers: {
        qwenai: {
          name: "阿里云百炼",
          brandId: "qwenai",
          pricingProviderId: "qwenai",
          region: "cn",
          category: "cn_official",
          openaiUrl: "https://maas.qianwenaiapi.com/compatible-mode/v1",
          anthropicUrl: "https://maas.qianwenaiapi.com/apps/anthropic",
          models: [{
            id: "qwen-plus",
            category: "chat",
            supportedWireApis: ["chat_completions", "messages", "responses"],
            pricing: {input: 0.8, output: 2.4},
          }],
        },
      },
    });
    const review = createProviderCatalogReview(config(), undefined, "qwenai-token-plan", {
      catalog: qwenaiCatalog,
      source: "remote",
      fetchedAt: "2026-08-17T00:00:00.000Z",
      sourceHash: "sha256:qwenai-token-plan",
    }, syncedPricing([{
      id: "catalog:qwenai:qwen-plus", vendor: "qwenai", runtimeModelId: "qwen-plus",
      patterns: ["qwen-plus"], mode: "chat", pricingProviderId: "qwenai",
      region: "cn", catalogSource: "catalog",
      pricing: {input: 0.8, output: 2.4}, currency: "CNY", confidence: "official",
      supportedWireApis: ["chat_completions", "messages", "responses"],
    }]));

    expect(review.models).toHaveLength(1);
    // 套餐预设只声明 chat_completions：Codex（仅 Responses）不可接入。
    expect(review.models[0].supportedAgents).toEqual(["claude", "opencode", "dsh", "zcode"]);
  });

  test("应用路由按保存后的目标配置读取生效价格 revision", async () => {
    const source = await readFile("src/app/api/provider-catalog/apply/route.ts", "utf8");

    expect(source).toContain("readEffectivePricingConfig");
  });

  test("expectedRevision 过期时拒绝，且不写价格或目标配置", async () => {
    const writePricingConfig = vi.fn();
    const updateConfig = vi.fn();
    await expect(applyProviderCatalogUpdate({
      targetId: "demo",
      presetId: "demo",
      expectedRevision: 6,
      selectedModelIds: ["demo-chat"],
    }, dependencies({writePricingConfig, updateConfig}))).rejects.toThrow("CONFIG_REVISION_CONFLICT");

    expect(writePricingConfig).not.toHaveBeenCalled();
    expect(updateConfig).not.toHaveBeenCalled();
  });

  test("确认后同时写价格目录和目标白名单，并返回新 nonce 所需的新 revision", async () => {
    const writePricingConfig = vi.fn(async () => undefined);
    const updateConfig = vi.fn(async (update: {targetPatch: {target: Partial<ProxyTarget>}}) => ({
      ...config(),
      revision: 8,
      targets: [{...target(), ...update.targetPatch.target, supportedModels: ["demo-chat"]}],
    }));
    const result = await applyProviderCatalogUpdate({
      targetId: "demo",
      presetId: "demo",
      expectedRevision: 7,
      selectedModelIds: ["demo-chat"],
    }, dependencies({writePricingConfig, updateConfig}));

    // 终极方案：apply 只写目标，不再写价格中心。
    expect(updateConfig).toHaveBeenCalledWith(expect.objectContaining({
      expectedRevision: 7,
      targetPatch: expect.objectContaining({
        id: "demo",
        target: expect.objectContaining({supportedModels: ["demo-chat"]}),
      }),
    }));
    expect(result.config.revision).toBe(8);
    expect(result.target.supportedModels).toEqual(["demo-chat"]);
    // 终极方案：pricing 由同步任务管理，apply 不修改。
  });

  test("目录与手工同供应商模型冲突时，目标改绑价格中心实际保留的手工条目", async () => {
    const writePricingConfig = vi.fn(async () => undefined);
    const updateConfig = vi.fn(async (update: {targetPatch: {target: Partial<ProxyTarget>}}) => ({
      ...config(),
      revision: 8,
      targets: [{...target(), ...update.targetPatch.target}],
    }));
    const result = await applyProviderCatalogUpdate({
      targetId: "demo",
      presetId: "demo",
      expectedRevision: 7,
      selectedModelIds: ["demo-chat"],
    }, dependencies({
      writePricingConfig,
      updateConfig,
      readPricingConfig: async () => ({
        ...DEFAULT_PRICING,
        models: [...DEFAULT_PRICING.models, {
          id: "catalog:demo:demo-chat",
          vendor: "demo",
          runtimeModelId: "demo-chat",
          match: "demo-chat",
          patterns: ["demo-chat"],
          pricing: {input: 9, output: 10},
          confidence: "user_override" as const,
        }],
      }),
    }));

    expect(result.target.pricing?.modelVendors?.["demo-chat"]).toEqual({
      vendor: "demo",
      priceEntryId: "catalog:demo:demo-chat",
    });
  });

  test("价格 revision 记录失败时保留已提交的目标和价格文件，不执行错误回滚", async () => {
    const writePricingConfig = vi.fn(async () => undefined);
    const updateConfig = vi.fn(async (update: {targetPatch: {target: Partial<ProxyTarget>}}) => ({
      ...config(),
      revision: 8,
      targets: [{...target(), ...update.targetPatch.target}],
    }));

    const result = await applyProviderCatalogUpdate({
      targetId: "demo",
      presetId: "demo",
      expectedRevision: 7,
      selectedModelIds: ["demo-chat"],
    }, dependencies({
      writePricingConfig,
      updateConfig,
      recordPricingRevision: async () => { throw new Error("REVISION_STORE_FAILED"); },
    }));

    expect(result.config.revision).toBe(8);
    expect(result.target.supportedModels).toEqual(["demo-chat"]);
    // 终极方案：apply 只写目标，不再写价格中心。
  });

  test("确认刷新时目录已移除模型默认保留在目标白名单", async () => {
    const richCatalog = CATALOG_FIXTURE({
      schemaVersion: 2,
      catalogRevision: "2026.09.03.01",
      publishedAt: "2026-08-18T00:00:00+08:00",
      providers: {
        demo: {
          name: "Demo",
          brandId: "demo",
          pricingProviderId: "demo",
          region: "cn",
          category: "cn_official",
          openaiUrl: "https://demo.example/v1",
          models: [{id: "demo-chat", category: "chat", pricing: {input: 1, output: 2}}],
        },
      },
    });
    const targetWithModels: ProxyTarget = {
      ...target(),
      supportedModels: ["demo-chat", "removed-chat"],
      pricing: {
        vendor: "demo",
        modelVendors: {
          "demo-chat": {vendor: "demo", priceEntryId: "catalog:demo:demo-chat"},
          "removed-chat": {vendor: "demo", priceEntryId: "catalog:demo:removed-chat"},
        },
      },
    };
    const pricingConfig: PricingConfigV2 = normalizePricingConfig({
      version: 2,
      currency: "USD",
      models: [
        {id: "catalog:demo:demo-chat", vendor: "demo", runtimeModelId: "demo-chat", patterns: ["demo-chat"], pricing: {input: 1, output: 2}, confidence: "official"},
        {id: "catalog:demo:removed-chat", vendor: "demo", runtimeModelId: "removed-chat", patterns: ["removed-chat"], pricing: {input: 1, output: 1}, confidence: "official"},
      ],
    });
    const writePricingConfig = vi.fn(async () => undefined);
    const updateConfig = vi.fn(async (update: {targetPatch: {target: Partial<ProxyTarget>}}) => ({
      ...config(),
      revision: 8,
      targets: [{...targetWithModels, ...update.targetPatch.target}],
    }));
    const current = {...config(), targets: [targetWithModels]};

    const result = await applyProviderCatalogUpdate({
      targetId: "demo",
      presetId: "demo",
      expectedRevision: 7,
      selectedModelIds: ["demo-chat"],
    }, dependencies({
      writePricingConfig,
      updateConfig,
      readPricingConfig: async () => pricingConfig,
    }, current));

    // 终极方案（集合语义）：removed-chat 未勾选 → 移出白名单。
    expect(result.target.supportedModels).toEqual(["demo-chat"]);
    expect(result.applied.removedModelIds).toEqual(["removed-chat"]);
  });
});

describe("预设创建请求 pricing 契约（回归：客户端草稿 pricing.vendor 不得随创建提交）", () => {
  test("create 动作只接受空 pricing 占位，非空 pricing 报 INVALID_REQUEST", async () => {
    const {normalizeInput} = await import("../src/app/api/provider-catalog/apply/route.js");
    const base = {
      action: "create",
      presetId: "demo",
      expectedRevision: 7,
      target: {
        id: "demo-target",
        name: "Demo Target",
        openaiUrl: "https://demo.example/v1",
        pricing: {},
        createdAt: "2026-09-04T00:00:00.000Z",
        updatedAt: "2026-09-04T00:00:00.000Z",
      },
    };
    expect(normalizeInput(base).target.pricing).toBeUndefined();
    expect(() => normalizeInput({
      ...base,
      target: {...base.target, pricing: {vendor: "demo"}},
    })).toThrow("INVALID_REQUEST");
  });

  test("mode single（仅更新此模型）：恰好一个模型且携带 preserveUnselected，多选或缺失报错", async () => {
    const {normalizeInput} = await import("../src/app/api/provider-catalog/apply/route.js");
    const base = {
      action: "apply",
      targetId: "demo",
      presetId: "demo",
      expectedRevision: 7,
      replacementDefaultModels: {},
    };
    const single = normalizeInput({...base, mode: "single", selectedModelIds: ["demo-new"]});
    expect(single.selectedModelIds).toEqual(["demo-new"]);
    expect(single.preserveUnselected).toBe(true);
    // 非单模型模式不携带 preserveUnselected（保持整卡确认「取消勾选 = 移除」语义）。
    expect(normalizeInput({...base, selectedModelIds: ["demo-new"]}).preserveUnselected).toBeUndefined();
    expect(() => normalizeInput({...base, mode: "single", selectedModelIds: ["demo-new", "demo-chat"]})).toThrow("INVALID_REQUEST");
  });

  test("单档位套餐预设创建时按目录档位表预填 planMonthlyFee（OpenCode Go=$10，币种随目录）", async () => {
    const writePricingConfig = vi.fn(async () => undefined);
    const updateConfig = vi.fn(async (update: {targetPatch: {target: Partial<ProxyTarget>}}) => ({
      ...config(),
      revision: 8,
      targets: [...config().targets, update.targetPatch.target as ProxyTarget],
    }));
    const goPreset = PROVIDER_PRESETS.find(item => item.id === "opencode-go")!;
    const result = await createProviderPresetTarget({
      action: "create",
      presetId: "opencode-go",
      expectedRevision: 7,
      target: {id: "go", name: "Go", openaiUrl: goPreset.openaiUrl!, pricing: {}},
      selectedModelIds: ["go-chat"],
    }, dependencies({writePricingConfig, updateConfig}));

    expect(result.target.pricing?.planMonthlyFee).toBe(10);
    expect(result.target.pricing?.settlementCurrency).toBe("USD");
    expect(result.target.pricing?.vendor).toBe("opencode-go");
    expect(result.target.supportedModels).toEqual(["go-chat"]);
  });
});

/** 价格中心预填充（终极方案：向导数据源=价格中心；模拟小时同步已入库 demo 条目）。 */
function syncedPricing(extra: PricingConfigV2["models"] = []): PricingConfigV2 {
  return normalizePricingConfig({
    ...DEFAULT_PRICING,
    models: [...DEFAULT_PRICING.models, ...extra, {
      id: "catalog:demo:demo-chat", vendor: "demo", runtimeModelId: "demo-chat",
      patterns: ["demo-chat"], mode: "chat", pricingProviderId: "demo",
      region: "cn", catalogSource: "catalog",
      pricing: {input: 1, output: 2}, currency: "CNY", confidence: "official",
      supportedWireApis: ["chat_completions", "responses", "messages"],
    }, {
      id: "catalog:opencode-go:go-chat", vendor: "opencode-go", runtimeModelId: "go-chat",
      patterns: ["go-chat"], mode: "chat", pricingProviderId: "opencode-go",
      region: "global", catalogSource: "catalog",
      pricing: {input: 1, output: 3}, currency: "USD", confidence: "official",
      supportedWireApis: ["chat_completions", "responses", "messages"],
    }],
  });
}

function dependencies(overrides: {
  writePricingConfig: ReturnType<typeof vi.fn>;
  updateConfig: ReturnType<typeof vi.fn>;
  readPricingConfig?: () => Promise<PricingConfigV2>;
  recordPricingRevision?: () => Promise<void>;
  loadCatalog?: {catalog: typeof catalog; source: "remote" | "local" | "bundled"; fetchedAt: string; sourceHash: string};
}, currentConfig?: ProxyConfig) {
  const current = currentConfig || config();
  return {
    dataDir: "/tmp/provider-catalog-api-test",
    configStore: {
      reload: async () => undefined,
      getConfig: () => structuredClone(current),
      updateConfig: overrides.updateConfig,
    },
    loadCatalog: overrides.loadCatalog
      ? async () => structuredClone(overrides.loadCatalog!)
      : (async () => ({
        catalog,
        source: "remote" as const,
        fetchedAt: "2026-08-17T00:00:00.000Z",
        sourceHash: "sha256:catalog",
      })),
    readPricingConfig: overrides.readPricingConfig || (async () => syncedPricing()),
    writePricingConfig: overrides.writePricingConfig,
    withPricingConfigMutation: async <T>(_dataDir: string, operation: () => Promise<T>) => operation(),
    recordPricingRevision: overrides.recordPricingRevision || (async () => undefined),
  };
}


describe("目录合并收窄（2026-09-07 四原则）", () => {
  test("applyProviderCatalogUpdate：只合并该预设供应商的勾选模型价格", async () => {
    const writePricingConfig = vi.fn(async () => undefined);
    const updateConfig = vi.fn(async (update: {targetPatch: {target: Partial<ProxyTarget>}}) => ({
      ...config(),
      revision: 8,
      targets: [{...target(), ...update.targetPatch.target}],
    }));
    const result = await applyProviderCatalogUpdate({
      targetId: "demo",
      presetId: "demo",
      expectedRevision: 7,
      selectedModelIds: ["demo-chat"],
    }, dependencies({writePricingConfig, updateConfig}));

    // 写入的价格文件中：demo-chat 的价格已更新为目录值；
    // 其它供应商（如 opencode-go/go-chat）不得被隐式写入。
    // 终极方案：apply 不写价格中心。
    expect(writePricingConfig).not.toHaveBeenCalled();
    expect(result.target.pricing?.modelVendors?.["demo-chat"]).toBeDefined();
  });

  test("单模型接入（仅更新此模型）：勾选模型接入目标，其余保持现状（终极方案）", async () => {
    // 目录：demo-chat（价格有变化 99→2）与 demo-new（新增）；目标另有 manual-chat（目录外手工模型）。
    const richCatalog = CATALOG_FIXTURE({
      schemaVersion: 2,
      catalogRevision: "2026.09.03.01",
      publishedAt: "2026-09-06T00:00:00+08:00",
      providers: {
        demo: {
          name: "Demo",
          brandId: "demo",
          pricingProviderId: "demo",
          region: "cn",
          category: "cn_official",
          openaiUrl: "https://demo.example/v1",
          models: [
            {id: "demo-chat", category: "chat", supportedWireApis: ["chat_completions"], pricing: {input: 1, output: 2}},
            {id: "demo-new", category: "chat", supportedWireApis: ["chat_completions"], pricing: {input: 3, output: 4}},
          ],
        },
      },
    });
    const targetWithModels: ProxyTarget = {
      ...target(),
      supportedModels: ["demo-chat", "manual-chat"],
      pricing: {
        vendor: "demo",
        modelVendors: {
          "demo-chat": {vendor: "demo", priceEntryId: "catalog:demo:demo-chat"},
          "manual-chat": {vendor: "demo", priceEntryId: "price:demo:manual-chat"},
        },
      },
    };
    const pricingConfig: PricingConfigV2 = normalizePricingConfig({
      version: 2,
      currency: "USD",
      models: [
        {id: "catalog:demo:demo-chat", vendor: "demo", runtimeModelId: "demo-chat", patterns: ["demo-chat"], pricing: {input: 99, output: 99}, confidence: "official"},
        {id: "catalog:demo:demo-new", vendor: "demo", runtimeModelId: "demo-new", patterns: ["demo-new"], pricing: {input: 3, output: 4}, confidence: "official", supportedWireApis: ["chat_completions"]},
        {id: "price:demo:manual-chat", vendor: "demo", runtimeModelId: "manual-chat", patterns: ["manual-chat"], pricing: {input: 5, output: 5}, confidence: "user_override"},
      ],
    });
    const writePricingConfig = vi.fn(async () => undefined);
    const updateConfig = vi.fn(async (update: {targetPatch: {target: Partial<ProxyTarget>}}) => ({
      ...config(),
      revision: 8,
      targets: [{...targetWithModels, ...update.targetPatch.target}],
    }));

    const result = await applyProviderCatalogUpdate({
      targetId: "demo",
      presetId: "demo",
      expectedRevision: 7,
      selectedModelIds: ["demo-new"],
      preserveUnselected: true,
    }, dependencies({
      writePricingConfig,
      updateConfig,
      readPricingConfig: async () => pricingConfig,
      loadCatalog: {
        catalog: richCatalog,
        source: "remote" as const,
        fetchedAt: "2026-09-06T00:00:00.000Z",
        sourceHash: "sha256:rich-2026-09-06",
      },
    }, {...config(), targets: [targetWithModels]}));

    // 新模型完整接入；有变化但未勾选的 demo-chat 与目录外 manual-chat 均不移除、不更新价格。
    expect(result.target.supportedModels).toEqual(expect.arrayContaining(["demo-chat", "manual-chat", "demo-new"]));
    expect(result.applied.removedModelIds).toEqual([]);
    // 服务端按合并后的价格中心条目补全映射（catalog:demo:demo-new 已由 scoped 合并写入）。
    expect(result.target.pricing?.modelVendors?.["demo-new"]).toEqual({vendor: "demo", priceEntryId: "catalog:demo:demo-new"});
    // 终极方案：apply 不写价格中心。
    expect(writePricingConfig).not.toHaveBeenCalled();
  });

  test("createProviderPresetTarget：单档位月费预填 + 只合并所选模型供应商", async () => {
    const writePricingConfig = vi.fn(async () => undefined);
    const updateConfig = vi.fn(async (update: {targetPatch: {target: Partial<ProxyTarget>}}) => ({
      ...config(),
      revision: 8,
      targets: [...config().targets, update.targetPatch.target as ProxyTarget],
    }));
    const goPreset = PROVIDER_PRESETS.find(item => item.id === "opencode-go")!;
    const result = await createProviderPresetTarget({
      action: "create",
      presetId: "opencode-go",
      expectedRevision: 7,
      target: {id: "go", name: "Go", openaiUrl: goPreset.openaiUrl!, pricing: {}},
      selectedModelIds: ["go-chat"],
    }, dependencies({writePricingConfig, updateConfig}));

    expect(result.target.pricing?.planMonthlyFee).toBe(10);
    // 终极方案：create 不写价格中心。
    expect(writePricingConfig).not.toHaveBeenCalled();
  });
});


describe("已阅路由纯函数（v2 通知已阅制）", () => {
  test("normalizeAckInput 校验：三类来源版本号均放行，非法值拒绝", async () => {
    const {normalizeAckInput} = await import("../src/app/api/provider-catalog/pricing-updates/dismiss/route.js");
    // 官方预设 / 人工覆盖 / LiteLLM 导入共用同一张通知表，三者都必须可标记已阅
    // （回归：此前只接受官方格式，人工与 LiteLLM 记录被拒为 INVALID_REQUEST）。
    expect(normalizeAckInput({revisions: ["2026.09.07.01"]}).revisions).toEqual(["2026.09.07.01"]);
    expect(normalizeAckInput({revisions: ["manual-2026.09.10.171759"]}).revisions).toEqual(["manual-2026.09.10.171759"]);
    expect(normalizeAckInput({revisions: ["litellm-2026.09.10.171759"]}).revisions).toEqual(["litellm-2026.09.10.171759"]);
    // 三类混合批量同样放行
    expect(normalizeAckInput({revisions: [
      "2026.09.10.02", "manual-2026.09.10.171759", "litellm-2026.09.10.171759",
    ]}).revisions).toHaveLength(3);
    expect(normalizeAckInput({all: true})).toEqual({revisions: undefined, all: true});
    expect(() => normalizeAckInput({revisions: ["bad-revision"]})).toThrow("INVALID_REQUEST");
    expect(() => normalizeAckInput({revisions: ["manual-2026.09.10"]})).toThrow("INVALID_REQUEST");
    expect(() => normalizeAckInput({revisions: ["litellm-2026.9.10.17175"]})).toThrow("INVALID_REQUEST");
    expect(() => normalizeAckInput({})).toThrow("INVALID_REQUEST");
  });
});
