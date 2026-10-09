import {describe, expect, test, vi} from "vitest";
import {createProviderCatalogReview, createProviderPresetTarget} from "../src/lib/provider-catalog/service.js";
import {normalizeProviderCatalog} from "../src/lib/provider-catalog/normalize.js";

function CATALOG_FIXTURE(value: unknown): ReturnType<typeof normalizeProviderCatalog>["catalog"] {
  return normalizeProviderCatalog(value).catalog;
}
import {DEFAULT_PRICING, type PricingConfigV2} from "../src/lib/pricing.js";
import type {ProxyConfig, ProxyTarget} from "../src/types.js";

const catalog = CATALOG_FIXTURE({
  schemaVersion: 2,
  catalogRevision: "2026.08.21.01",
  publishedAt: "2026-08-18T00:00:00+08:00",
  providers: {
    deepseek: {
      name: "DeepSeek（官方）",
      brandId: "deepseek",
      pricingProviderId: "deepseek",
      region: "cn",
      category: "cn_official",
      openaiUrl: "https://api.deepseek.com",
      anthropicUrl: "https://api.deepseek.com/anthropic",
      models: [{id: "deepseek-v4-flash", category: "chat", pricing: {input: 1, output: 2}}],
    },
    "zhipu-cn": {
      name: "智谱 GLM（中国区）",
      brandId: "zhipu",
      pricingProviderId: "zhipu-cn",
      region: "cn",
      category: "cn_official",
      openaiUrl: "https://open.bigmodel.cn/api/paas/v4",
      anthropicUrl: "https://open.bigmodel.cn/api/anthropic",
      models: [
        {id: "glm-5.3", category: "chat", contextWindowK: 128, maxOutputK: 16, pricing: {input: 1, cachedInput: 0.2, output: 2}},
        {id: "glm-5-turbo", category: "chat", pricing: {input: 0.8, output: 1.6}},
        {id: "embedding-3", category: "embedding", pricing: {input: 0.1, output: 0}},
        {id: "glm-unpriced", category: "chat"},
      ],
    },
  },
});

function emptyConfig(): ProxyConfig {
  return {
    version: 3,
    revision: 7,
    localProxyBaseUrl: "http://localhost:3211",
    updatedAt: "2026-08-18T00:00:00.000Z",
    agentConnections: {},
    targets: [],
  };
}

function targetDraft(overrides: Partial<ProxyTarget> = {}): ProxyTarget {
  return {
    id: "zhipu-cn",
    name: "智谱 GLM",
    openaiUrl: "https://open.bigmodel.cn/api/paas/v4",
    anthropicUrl: "https://open.bigmodel.cn/api/anthropic",
    enabled: false,
    supportedModels: [],
    pricing: {vendor: "zhipu-cn", rateMultiplier: 1},
    createdAt: "2026-08-18T00:00:00.000Z",
    updatedAt: "2026-08-18T00:00:00.000Z",
    ...overrides,
  };
}

describe("官方预设一次提交创建", () => {
  test("模型级协议能力决定 Agent scope：Chat 模型按 chat binding 开放给 OpenCode/dsh，Codex 仅 Responses", async () => {
    const fixture = dependencies({
      catalog: CATALOG_FIXTURE({
        schemaVersion: 2,
        catalogRevision: "2026.08.21.01",
        publishedAt: "2026-08-18T00:00:00+08:00",
        providers: {
          "opencode-go": {
            name: "OpenCode Go", brandId: "opencode", pricingProviderId: "opencode-go", region: "global", category: "aggregator",
            openaiUrl: "https://opencode.ai/zen/go/v1", anthropicUrl: "https://opencode.ai/zen/go/v1",
            models: [
              {id: "gpt-5.6-sol", category: "chat", supportedWireApis: ["responses"], pricing: {input: 1, output: 2}},
              {id: "claude-sonnet-5", category: "chat", supportedWireApis: ["messages"], pricing: {input: 1, output: 2}},
              {id: "glm-5.3", category: "chat", supportedWireApis: ["chat_completions"], pricing: {input: 1, output: 2}},
            ],
          },
        },
      }),
      presetId: "opencode-go",
    });
    const result = await createProviderPresetTarget({presetId: "opencode-go", expectedRevision: 7, target: targetDraft({id: "opencode-go", name: "OpenCode Go", openaiUrl: "https://opencode.ai/zen/go/v1", anthropicUrl: "https://opencode.ai/zen/go/v1"}), selectedModelIds: ["gpt-5.6-sol", "claude-sonnet-5", "glm-5.3"]}, fixture.dependencies);
    expect(result.target.supportedModels).toEqual(["gpt-5.6-sol", "claude-sonnet-5", "glm-5.3"]);
    expect(result.target.supportedModelScopes).toEqual({
      "gpt-5.6-sol": ["codex", "opencode", "dsh", "zcode"],
      // 2026-10-06 dsh 三协议：responses/messages 模型同样对 dsh 开放。
      "claude-sonnet-5": ["claude", "opencode", "dsh", "zcode"],
      // Codex 只支持 Responses，chat_completions 模型不对 Codex 开放。
      "glm-5.3": ["opencode", "dsh", "zcode"],
    });
  });
  test("未提交模型选择时默认只选目录首位推荐模型（2026-10-07 取代默认全选）", async () => {
    const fixture = dependencies();
    const result = await createProviderPresetTarget({
      presetId: "zhipu-cn",
      expectedRevision: 7,
      target: targetDraft(),
    }, fixture.dependencies);

    expect(result.target.supportedModels).toEqual(["glm-5.3"]);
    expect(result.target.presetId).toBe("zhipu-cn");
    expect(result.target.billingChannel).toBe("pay_as_you_go");
    expect(result.target.vendorFamily).toBe("zhipu");
    expect(result.target.supportedModelScopes).toEqual({
      // zhipu-cn 预设只声明 chat_completions + messages：Codex（仅 Responses）不归属。
      "glm-5.3": ["claude", "opencode", "dsh", "zcode"],
    });
    expect(result.target.pricing?.modelVendors?.["glm-5.3"]).toEqual({
      vendor: "zhipu-cn",
      priceEntryId: "catalog:zhipu-cn:glm-5.3",
    });
    expect(fixture.updateConfig).toHaveBeenCalledTimes(1);
  });

  test("默认选择与预览顺序跟随目录编辑序而非价格中心文件序（回归：OpenAI 目录首位 gpt-6.1-sol 曾被字典序 gpt-5.6-luna 顶掉）", async () => {
    const scrambledCatalog = CATALOG_FIXTURE({
      schemaVersion: 2,
      catalogRevision: "2026.10.08.01",
      publishedAt: "2026-10-08T00:36:51+08:00",
      providers: {
        "zhipu-cn": {
          name: "智谱 GLM（中国区）",
          brandId: "zhipu",
          pricingProviderId: "zhipu-cn",
          region: "cn",
          category: "cn_official",
          openaiUrl: "https://open.bigmodel.cn/api/paas/v4",
          anthropicUrl: "https://open.bigmodel.cn/api/anthropic",
          models: [
            {id: "glm-5.3", category: "chat", pricing: {input: 1, output: 2}},
            {id: "glm-5.9-alpha", category: "chat", pricing: {input: 1, output: 2}},
            {id: "glm-5-turbo", category: "chat", pricing: {input: 0.8, output: 1.6}},
          ],
        },
      },
    });
    // 价格中心按条目 ID 字典序维护（真实文件即如此）：glm-5-turbo 会排到目录首位 glm-5.3 之前。
    const dictionaryOrder = syncedFromCatalog(scrambledCatalog);
    const byRuntime = new Map(dictionaryOrder.models.map(model => [model.runtimeModelId as string, model] as const));
    dictionaryOrder.models = [byRuntime.get("glm-5-turbo")!, byRuntime.get("glm-5.3")!, byRuntime.get("glm-5.9-alpha")!];
    const fixture = dependencies({catalog: scrambledCatalog, pricing: dictionaryOrder});

    const result = await createProviderPresetTarget({
      presetId: "zhipu-cn",
      expectedRevision: 7,
      target: targetDraft(),
    }, fixture.dependencies);
    expect(result.target.supportedModels).toEqual(["glm-5.3"]);

    const review = createProviderCatalogReview(emptyConfig(), undefined, "zhipu-cn", {
      catalog: scrambledCatalog,
      source: "remote",
      fetchedAt: "2026-10-08T00:36:51.000Z",
      sourceHash: "sha256:order-regression",
    }, dictionaryOrder);
    expect(review.models.map(model => model.id)).toEqual(["glm-5.3", "glm-5.9-alpha", "glm-5-turbo"]);
    expect(review.diff.added[0]?.id).toBe("glm-5.3");
  });

  test("显式选择只创建用户保留的目录模型", async () => {
    const fixture = dependencies();
    const result = await createProviderPresetTarget({
      presetId: "zhipu-cn",
      expectedRevision: 7,
      target: targetDraft(),
      selectedModelIds: ["glm-5-turbo"],
    }, fixture.dependencies);

    expect(result.target.supportedModels).toEqual(["glm-5-turbo"]);
    expect(Object.keys(result.target.pricing?.modelVendors || {})).toEqual(["glm-5-turbo"]);
  });

  test("用户清空预设的一个协议 URL 后服务端不自动补齐", async () => {
    const fixture = dependencies();
    const result = await createProviderPresetTarget({
      presetId: "deepseek",
      expectedRevision: 7,
      target: targetDraft({
        id: "deepseek",
        name: "DeepSeek",
        openaiUrl: "https://api.deepseek.com",
        anthropicUrl: undefined,
      }),
    }, fixture.dependencies);

    expect(result.target.openaiUrl).toBe("https://api.deepseek.com");
    expect(result.target.anthropicUrl).toBeUndefined();
  });

  test("不存在、未定价或空模型选择都在写价格和配置前拒绝", async () => {
    for (const selectedModelIds of [["missing"], ["glm-unpriced"], []] as string[][]) {
      const fixture = dependencies();
      await expect(createProviderPresetTarget({
        presetId: "zhipu-cn",
        expectedRevision: 7,
        target: targetDraft(),
        selectedModelIds,
      }, fixture.dependencies)).rejects.toThrow(selectedModelIds.length === 0 ? "MODEL_SELECTION_REQUIRED" : "MODEL_PRICE_MAPPING_REQUIRED");
      expect(fixture.writePricingConfig).not.toHaveBeenCalled();
      expect(fixture.updateConfig).not.toHaveBeenCalled();
    }
  });

  test("重复路由 ID 或规范化 URL 在任何写入前返回稳定错误码", async () => {
    for (const existing of [
      targetDraft({id: "zhipu-cn", openaiUrl: "https://other.example/v1", anthropicUrl: undefined}),
      targetDraft({id: "other", openaiUrl: "https://open.bigmodel.cn/api/paas/v4/", anthropicUrl: undefined}),
    ]) {
      const fixture = dependencies({config: {...emptyConfig(), targets: [existing]}});
      await expect(createProviderPresetTarget({
        presetId: "zhipu-cn",
        expectedRevision: 7,
        target: targetDraft(),
      }, fixture.dependencies)).rejects.toThrow(existing.id === "zhipu-cn" ? "DUPLICATE_TARGET_ID" : "DUPLICATE_TARGET_URL");
      expect(fixture.updateConfig).not.toHaveBeenCalled();
    }
  });

  test("Kimi For Coding 预设使用独立目录模型并写入 plan 通道元数据", async () => {
    const fixture = dependencies({
      catalog: CATALOG_FIXTURE({
        schemaVersion: 2,
        catalogRevision: "2026.08.21.01",
        publishedAt: "2026-08-18T00:00:00+08:00",
        providers: {
          "kimi-coding": {
            name: "Kimi For Coding（中国区）",
            brandId: "moonshot",
            pricingProviderId: "moonshot-cn",
            region: "cn",
            category: "cn_official",
            openaiUrl: "https://api.kimi.com/coding/v1",
            anthropicUrl: "https://api.kimi.com/coding/",
            codingPlan: "kimi-coding",
            models: [
              {id: "kimi-for-coding", category: "chat", pricing: {input: 0.95, output: 4}},
            ],
          },
        },
      }),
      presetId: "kimi-coding",
    });
    const result = await createProviderPresetTarget({
      presetId: "kimi-coding",
      expectedRevision: 7,
      target: targetDraft({
        id: "kimi-coding",
        name: "Kimi For Coding",
        openaiUrl: "https://api.kimi.com/coding/v1",
        anthropicUrl: "https://api.kimi.com/coding/",
      }),
    }, fixture.dependencies);

    expect(result.target.supportedModels).toEqual(["kimi-for-coding"]);
    expect(result.target.billingChannel).toBe("plan");
    expect(result.target.vendorFamily).toBe("kimi");
    expect(result.target.pricing?.modelVendors?.["kimi-for-coding"]).toEqual({
      vendor: "moonshot-cn",
      priceEntryId: "catalog:moonshot-cn:kimi-for-coding",
    });
  });

  test("Anthropic 订阅目标模型只开放给 Claude，不误开放给 Codex", async () => {
    const fixture = dependencies({
      catalog: CATALOG_FIXTURE({
        schemaVersion: 2,
        catalogRevision: "2026.08.21.01",
        publishedAt: "2026-08-18T00:00:00+08:00",
        providers: {
          anthropic: {
            name: "Anthropic（官方）",
            brandId: "anthropic",
            pricingProviderId: "anthropic",
            region: "global",
            category: "global_official",
            anthropicUrl: "https://api.anthropic.com",
            models: [
              {id: "claude-opus-5", category: "chat", pricing: {input: 5, output: 25}},
              {id: "claude-sonnet-5", category: "chat", pricing: {input: 2, output: 10}},
            ],
          },
        },
      }),
      presetId: "anthropic-subscription",
    });
    const result = await createProviderPresetTarget({
      presetId: "anthropic-subscription",
      expectedRevision: 7,
      target: targetDraft({
        id: "anthropic-subscription",
        name: "Anthropic 订阅",
        openaiUrl: undefined,
        anthropicUrl: "https://api.anthropic.com",
      }),
      // 显式选择两个模型：本测试验证 scope 语义（默认缺省行为另测，2026-10-07 已改为首位）。
      selectedModelIds: ["claude-opus-5", "claude-sonnet-5"],
    }, fixture.dependencies);

    expect(result.target.supportedModels).toEqual(["claude-opus-5", "claude-sonnet-5"]);
    expect(result.target.supportedModelScopes).toEqual({
      "claude-opus-5": ["claude", "zcode"],
      "claude-sonnet-5": ["claude", "zcode"],
    });
  });

  test("百炼 Coding Plan 按实际套餐 URL 判定能力，chat binding 对 Codex 开放", async () => {
    const fixture = dependencies({
      catalog: CATALOG_FIXTURE({
        schemaVersion: 2,
        catalogRevision: "2026.08.21.01",
        publishedAt: "2026-08-18T00:00:00+08:00",
        providers: {
          qwenai: {
            name: "阿里云百炼",
            brandId: "qwenai",
            pricingProviderId: "qwenai",
            region: "cn",
            category: "cn_official",
            openaiUrl: "https://token-plan.maas.qianwenaiapi.com/compatible-mode/v1",
            anthropicUrl: "https://token-plan.maas.qianwenaiapi.com/apps/anthropic",
            models: [
              {id: "qwen-max", category: "chat", supportedWireApis: ["chat_completions", "messages"], pricing: {input: 2.4, output: 9.6}},
              {id: "qwen-plus", category: "chat", supportedWireApis: ["chat_completions", "messages", "responses"], pricing: {input: 0.8, output: 2.4}},
            ],
          },
        },
      }),
      presetId: "qwenai-token-plan",
    });
    const result = await createProviderPresetTarget({
      presetId: "qwenai-token-plan",
      expectedRevision: 7,
      target: targetDraft({
        id: "qwenai-token-plan",
        name: "百炼 Token Plan",
        // 2026-09-29 体系更新：预设端点切换为 Token Plan 专属域名（sk-sp- Key）。
        openaiUrl: "https://token-plan.maas.qianwenaiapi.com/compatible-mode/v1",
        anthropicUrl: "https://token-plan.maas.qianwenaiapi.com/apps/anthropic",
      }),
      // 显式选择两个模型：本测试验证协议能力与 scope 语义（缺省默认行为另测，2026-10-07 已改为首位）。
      selectedModelIds: ["qwen-max", "qwen-plus"],
    }, fixture.dependencies);

    expect(result.target.supportedModels).toEqual(["qwen-max", "qwen-plus"]);
    // 套餐通道只声明 chat_completions 时，Codex（仅 Responses）不可命中；
    // 目录中 qwen-plus 的 responses 声明不会让 Codex 绕过 chat 能力；
    // claude/zcode 走 messages、opencode/dsh 通过各自 chat binding 获得归属。
    expect(result.target.supportedModelScopes).toEqual({
      "qwen-max": ["claude", "opencode", "dsh", "zcode"],
      "qwen-plus": ["claude", "opencode", "dsh", "zcode"],
    });
    expect(result.target.billingChannel).toBe("plan");
    expect(result.target.vendorFamily).toBe("qwenai");
  });
});

/**
 * 终极方案：向导数据源=价格中心。该帮助函数把目录模型投影为价格中心条目
 * （等价于小时同步任务已完成的入库结果），供 createProviderPresetTarget 消费。
 */
function syncedFromCatalog(source: ReturnType<typeof normalizeProviderCatalog>): PricingConfigV2 {
  // 目录已覆盖的供应商标识：DEFAULT_PRICING 中同 vendor 的预置条目必须排除，
  // 否则会污染价格中心数据源（测试场景只应看到目录模型）。
  const catalogVendors = new Set(Object.values(source.providers).map(provider => provider.pricingProviderId.trim().toLowerCase()));
  const baseModels = DEFAULT_PRICING.models.filter(model => !catalogVendors.has(model.vendor.trim().toLowerCase()));
  const models = Object.values(source.providers).flatMap(provider =>
    provider.models
      .filter(model => model.pricing !== undefined)
      .map(model => ({
        id: `catalog:${provider.pricingProviderId}:${model.id}`,
        vendor: provider.pricingProviderId,
        runtimeModelId: model.id,
        patterns: [model.id],
        mode: model.category,
        pricingProviderId: provider.pricingProviderId,
        region: provider.region,
        catalogSource: "catalog" as const,
        pricing: model.pricing!,
        currency: provider.currency === "CNY" ? "CNY" : "USD",
        confidence: "official" as const,
        ...(model.supportedWireApis ? {supportedWireApis: model.supportedWireApis} : {}),
        ...(model.contextWindowK !== undefined ? {contextWindow: model.contextWindowK * 1024} : {}),
        ...(model.maxOutputK !== undefined ? {maxOutput: model.maxOutputK * 1024} : {}),
      })));
  return {...DEFAULT_PRICING, models: [...baseModels, ...models]};
}

function dependencies(options: {config?: ProxyConfig; pricing?: PricingConfigV2; catalog?: ReturnType<typeof normalizeProviderCatalog>; presetId?: string} = {}) {
  const current = options.config || emptyConfig();
  const writePricingConfig = vi.fn(async () => undefined);
  const updateConfig = vi.fn(async (update: {targetPatch?: {target: Partial<ProxyTarget>}}) => {
    const created = update.targetPatch?.target as ProxyTarget;
    return {...current, revision: current.revision + 1, updatedAt: "2026-08-18T00:00:01.000Z", targets: [...current.targets, created]};
  });
  return {
    writePricingConfig,
    updateConfig,
    dependencies: {
      dataDir: "/tmp/provider-preset-create-test",
      configStore: {
        reload: async () => undefined,
        getConfig: () => structuredClone(current),
        updateConfig,
      },
      loadCatalog: async () => ({
      catalog: options.catalog || catalog,
        source: "remote" as const,
        fetchedAt: "2026-08-18T00:00:00.000Z",
        sourceHash: "sha256:preset-create",
      }),
      readPricingConfig: async () => options.pricing || syncedFromCatalog(options.catalog || catalog),
      writePricingConfig,
      withPricingConfigMutation: async <T>(_dataDir: string, operation: () => Promise<T>) => operation(),
      recordPricingRevision: async () => undefined,
    },
  };
}
