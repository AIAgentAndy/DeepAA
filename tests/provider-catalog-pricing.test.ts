import {readFileSync} from "node:fs";
import {describe, expect, test} from "vitest";
import {mergeProviderCatalogPricing, providerCatalogToPricingEntries, reconcileOfficialTargetModelVendors} from "../src/lib/provider-catalog/pricing.js";
import {normalizeProviderCatalog, parseProviderCatalogText} from "../src/lib/provider-catalog/normalize.js";
import type {ProviderCatalog} from "../src/lib/provider-catalog/types.js";
import {DEFAULT_PRICING, normalizePricingConfig, removePricingConfigModels, type PricingConfigV2} from "../src/lib/pricing.js";

function catalog(input: number, publishedAt = "2026-08-17T00:00:00+08:00"): ProviderCatalog {
  return normalizeProviderCatalog({
    schemaVersion: 2,
    catalogRevision: "2026.08.17.01",
    publishedAt,
    providers: {
      "zhipu-cn": {
        name: "智谱中国",
        brandId: "zhipu",
        pricingProviderId: "zhipu-cn",
        region: "cn",
        category: "cn_official",
        models: [{id: "glm-5.2", category: "chat", pricing: {input, output: 2}}],
      },
      "zhipu-global": {
        name: "智谱国际",
        brandId: "zhipu",
        pricingProviderId: "zhipu-global",
        region: "global",
        category: "global_official",
        models: [{id: "glm-5.2", category: "chat", pricing: {input: 3, output: 4}}],
      },
    },
  }).catalog;
}

function minimaxPlanCatalog(): ProviderCatalog {
  // v2：套餐规则走供应商级 planProfiles + 模型 planProfileRef/planFactors（编译投影为条目规则）。
  return normalizeProviderCatalog({
    schemaVersion: 2,
    catalogRevision: "2026.08.20.01",
    publishedAt: "2026-08-20T00:00:00+08:00",
    providers: {
      deepseek: {
        name: "DeepSeek",
        brandId: "deepseek",
        pricingProviderId: "deepseek",
        region: "cn",
        category: "official",
        planProfiles: {
          "minimax-token-v1": {
            calculator: {kind: "money_to_credits", currency: "CNY", creditsPerCurrency: 142.85714285714286},
            quotaWindows: [{id: "5h", label: "5 小时", reset: "rolling_5h"}],
          },
        },
        models: [{
          id: "deepseek-v4-flash",
          category: "chat",
          pricing: {input: 0.44, output: 1.32},
          planProfileRef: "minimax-token-v1",
        }],
      },
    },
  }).catalog;
}

describe("供应商目录与价格中心唯一条目", () => {
  test("中国区与国际区同名模型按 pricingProviderId 分开生成稳定条目", () => {
    const entries = providerCatalogToPricingEntries(catalog(1));

    expect(entries.map(entry => entry.id)).toEqual([
      "catalog:zhipu-cn:glm-5.2",
      "catalog:zhipu-global:glm-5.2",
    ]);
    expect(entries[0]).toMatchObject({
      vendor: "zhipu-cn",
      pricingProviderId: "zhipu-cn",
      region: "cn",
      catalogSource: "catalog",
      currency: "USD",
      pricing: {input: 1, output: 2},
    });
    expect(entries[1]?.id).not.toBe(entries[0]?.id);
  });

  test("同一供应商与模型冲突时目录价格更新原条目，且不做币种换算", () => {
    const old = normalizePricingConfig({
      ...DEFAULT_PRICING,
      models: [{
        id: "catalog:zhipu-cn:glm-5.2",
        vendor: "zhipu-cn",
        patterns: ["glm-5.2"],
        pricingProviderId: "zhipu-cn",
        region: "cn",
        catalogSource: "catalog",
        pricing: {input: 99, output: 99},
        currency: "USD",
        confidence: "official",
      }],
    });
    const merged = mergeProviderCatalogPricing(old, catalog(1));

    expect(merged.models.filter(item => item.pricingProviderId === "zhipu-cn")).toHaveLength(1);
    expect(merged.models.find(item => item.id === "catalog:zhipu-cn:glm-5.2")?.pricing?.input).toBe(1);
    expect(merged.currency).toBe("USD");
    expect(merged.unconvertedCatalogPricing).toBe(true);
    expect(merged.catalogSource?.type).toBe("provider_catalog");
  });

  test("官方目录更新同一供应商与模型时保留已有内部价格条目引用", () => {
    const old = normalizePricingConfig({
      ...DEFAULT_PRICING,
      models: [{
        id: "existing-zhipu-glm-5.2",
        vendor: "zhipu-cn",
        runtimeModelId: "glm-5.2",
        patterns: ["glm-5.2"],
        pricingProviderId: "zhipu-cn",
        region: "cn",
        catalogSource: "catalog",
        pricing: {input: 99, output: 99},
        currency: "USD",
        confidence: "official",
      }],
    });

    const merged = mergeProviderCatalogPricing(old, catalog(1));
    const entry = merged.models.find(item => item.vendor === "zhipu-cn" && item.runtimeModelId === "glm-5.2");
    expect(entry).toMatchObject({id: "existing-zhipu-glm-5.2", pricing: {input: 1, output: 2}});
  });

  test("官方目录切换模型时保留价格中心中的历史模型", () => {
    const first = mergeProviderCatalogPricing(DEFAULT_PRICING, catalog(1));
    const nextCatalog = normalizeProviderCatalog({
      schemaVersion: 2,
      catalogRevision: "2026.08.18.01",
      publishedAt: "2026-08-18T00:00:00+08:00",
      providers: {
        "zhipu-cn": {
          ...catalog(1).providers["zhipu-cn"],
          models: [{id: "glm-5.3", category: "chat", pricing: {input: 5, output: 6}}],
        },
        "zhipu-global": catalog(1).providers["zhipu-global"],
      },
    }).catalog;

    const merged = mergeProviderCatalogPricing(first, nextCatalog);
    expect(merged.models.some(item => item.vendor === "zhipu-cn" && item.runtimeModelId === "glm-5.2")).toBe(true);
    expect(merged.models.some(item => item.vendor === "zhipu-cn" && item.runtimeModelId === "glm-5.3")).toBe(true);
  });

  test("官方目标缺失模型映射时按供应商与运行时模型补齐，不改变白名单", () => {
    const pricing = mergeProviderCatalogPricing(DEFAULT_PRICING, catalog(1));
    const target = {
      id: "zhipu-cn",
      name: "智谱中国",
      openaiUrl: "https://open.bigmodel.cn/api/paas/v4",
      anthropicUrl: "https://open.bigmodel.cn/api/anthropic",
      enabled: false,
      supportedModels: ["glm-5.2"],
      pricing: {vendor: "zhipu-cn", rateMultiplier: 1},
    };

    const patch = reconcileOfficialTargetModelVendors(target, pricing);
    expect(patch?.supportedModels).toBeUndefined();
    expect(patch?.pricing?.modelVendors?.["glm-5.2"]).toEqual({
      vendor: "zhipu-cn",
      priceEntryId: expect.any(String),
    });
  });

  test("价格变化会生成新的目录来源 hash，供历史 revision 追加而不是重算", () => {
    const first = mergeProviderCatalogPricing(DEFAULT_PRICING, catalog(1));
    const second = mergeProviderCatalogPricing(first, normalizeProviderCatalog({
      schemaVersion: 2,
      catalogRevision: "2026.08.18.01",
      publishedAt: "2026-08-18T00:00:00+08:00",
      providers: {
        ...catalog(1).providers,
        "zhipu-cn": {
          ...catalog(1).providers["zhipu-cn"],
          models: [{id: "glm-5.2", category: "chat", pricing: {input: 1.5, output: 2}}],
        },
      },
    }).catalog);

    expect(first.catalogSource?.hash).not.toBe(second.catalogSource?.hash);
    expect((second as PricingConfigV2).models.find(item => item.id === "catalog:zhipu-cn:glm-5.2")?.pricing?.input).toBe(1.5);
  });

  test("官方目录合并不会覆盖同供应商同模型的用户手工价格", () => {
    const manual = normalizePricingConfig({
      version: 2,
      currency: "USD",
      unit: "per_million_tokens",
      models: [{
        id: "manual:zhipu-cn:glm-5.2",
        vendor: "zhipu-cn",
        match: "glm-5.2",
        patterns: ["glm-5.2"],
        mode: "chat",
        pricing: {input: 8, output: 9},
        confidence: "user_override",
      }],
    });

    const merged = mergeProviderCatalogPricing(manual, catalog(1));

    expect(merged.models.filter(item => item.vendor === "zhipu-cn" && item.patterns.includes("glm-5.2"))).toEqual([
      expect.objectContaining({id: "manual:zhipu-cn:glm-5.2", pricing: {input: 8, output: 9}}),
    ]);
  });

  test("user_override 官方能力跟随包含 contextWindow 与 maxOutput", () => {
    const manual = normalizePricingConfig({
      version: 2,
      currency: "USD",
      unit: "per_million_tokens",
      models: [{
        id: "manual:zhipu-cn:glm-5.2",
        vendor: "zhipu-cn",
        runtimeModelId: "glm-5.2",
        match: "glm-5.2",
        patterns: ["glm-5.2"],
        pricing: {input: 8, output: 9},
        contextWindow: 4096,
        maxOutput: 1024,
        confidence: "user_override",
      }],
    });
    const catalogWithCapabilities = normalizeProviderCatalog({
      schemaVersion: 2,
      catalogRevision: "2099.01.02.01",
      publishedAt: "2099-01-02T00:00:00+08:00",
      providers: {
        zhipu: {
          name: "智谱",
          brandId: "zhipu",
          pricingProviderId: "zhipu-cn",
          region: "cn",
          category: "cn_official",
          models: [{
            id: "glm-5.2",
            category: "chat",
            contextWindowK: 128,
            maxOutputK: 16,
            pricing: {input: 1, output: 2},
          }],
        },
      },
    }).catalog;

    const merged = mergeProviderCatalogPricing(manual, catalogWithCapabilities);
    const entry = merged.models.find(item => item.runtimeModelId === "glm-5.2");
    expect(entry?.pricing).toEqual({input: 8, output: 9});
    expect(entry?.contextWindow).toBe(128 * 1024);
    expect(entry?.maxOutput).toBe(16 * 1024);
  });

  test("目录条目透传 priceSchedules 与编译投影的 planCreditRules", () => {
    const withSchedules = normalizeProviderCatalog({
      schemaVersion: 2,
      catalogRevision: "2026.08.20.01",
      publishedAt: "2026-08-20T00:00:00+08:00",
      providers: {
        deepseek: {
          name: "DeepSeek",
          brandId: "deepseek",
          pricingProviderId: "deepseek",
          region: "cn",
          category: "official",
          models: [{
            id: "deepseek-v4-flash",
            category: "chat",
            pricing: {input: 0.44, output: 1.32},
            priceSchedules: [{
              label: "闲时",
              windows: [{start: "00:00", end: "24:00"}],
              rates: {input: 0.22, output: 0.66},
            }],
          }],
        },
      },
    }).catalog;
    const entries = providerCatalogToPricingEntries(withSchedules);
    expect(entries[0].priceSchedules?.[0].label).toBe("闲时");

    const planEntries = providerCatalogToPricingEntries(minimaxPlanCatalog());
    expect(planEntries[0].planCreditRules?.formula).toBe("money_to_credits");
    expect(planEntries[0].planCreditRules?.creditsPerCurrency).toBeCloseTo(142.85714285714286);

    const normalized = normalizePricingConfig({version: 2, currency: "USD", models: [...entries, ...planEntries]});
    expect(normalized.models[0].priceSchedules?.[0].rates.input).toBe(0.22);
    expect(normalized.models[1].planCreditRules?.quotaWindows[0].id).toBe("5h");
  });

  test("用户覆盖缺失套餐积分规则时从目录回填规则，价格保持手工值", () => {
    const withRules = minimaxPlanCatalog();
    // 历史版本的价格覆盖曾把条目重写为无 planCreditRules 的极简条目。
    const overridden = normalizePricingConfig({
      version: 2,
      currency: "USD",
      unit: "per_million_tokens",
      models: [{
        id: "catalog:deepseek:deepseek-v4-flash",
        vendor: "deepseek",
        runtimeModelId: "deepseek-v4-flash",
        match: "deepseek-v4-flash",
        patterns: ["deepseek-v4-flash"],
        pricing: {input: 0.2, output: 0.6},
        currency: "USD",
        confidence: "user_override",
      }],
    });

    const merged = mergeProviderCatalogPricing(overridden, withRules);
    const entry = merged.models.find(item =>
      item.vendor === "deepseek" && item.runtimeModelId === "deepseek-v4-flash");
    // 手工价格不被覆盖，仅回填积分规则，套餐通道派生恢复可用。
    expect(entry).toMatchObject({
      pricing: {input: 0.2, output: 0.6},
      confidence: "user_override",
    });
    expect(entry?.planCreditRules?.formula).toBe("money_to_credits");
  });

  test("两组字段组：覆盖条目的套餐规则随目录更新，不因 payg 覆盖冻结（设计 6.1）", () => {
    const withRules = minimaxPlanCatalog();
    const overridden = normalizePricingConfig({
      version: 2,
      currency: "USD",
      unit: "per_million_tokens",
      models: [{
        id: "catalog:deepseek:deepseek-v4-flash",
        vendor: "deepseek",
        runtimeModelId: "deepseek-v4-flash",
        match: "deepseek-v4-flash",
        patterns: ["deepseek-v4-flash"],
        pricing: {input: 0.2, output: 0.6},
        planCreditRules: {
          formula: "zhipu",
          divisor: 10000,
          modelFactors: {"deepseek-v4-flash": {input: 1, output: 1}},
          quotaWindows: [{id: "5h", label: "5 小时", reset: "rolling_5h"}],
        },
        currency: "USD",
        confidence: "user_override",
      }],
    });

    const merged = mergeProviderCatalogPricing(overridden, withRules);
    const entry = merged.models.find(item =>
      item.vendor === "deepseek" && item.runtimeModelId === "deepseek-v4-flash");
    // payg 价字段组保持手工值；plan 字段组被官方目录更新（zhipu 旧规则 → minimax 官方规则）。
    expect(entry?.pricing).toEqual({input: 0.2, output: 0.6});
    expect(entry?.planCreditRules?.formula).toBe("money_to_credits");
  });

  test("删除用户覆盖条目后再次合并官方目录可恢复峰谷价格", () => {
    const withRules = normalizeProviderCatalog({
      schemaVersion: 2,
      catalogRevision: "2026.08.20.01",
      publishedAt: "2026-08-20T00:00:00+08:00",
      providers: {
        deepseek: {
          name: "DeepSeek",
          brandId: "deepseek",
          pricingProviderId: "deepseek",
          region: "cn",
          category: "official",
          models: [{
            id: "deepseek-v4-flash",
            category: "chat",
            pricing: {input: 0.44, output: 1.32, cachedInput: 0.014},
            priceSchedules: [{
              timezone: "Asia/Shanghai",
              label: "闲时",
              windows: [{days: [5, 6], start: "00:00", end: "24:00"}],
              rates: {input: 0.22, output: 0.66, cachedInput: 0.007},
            }],
          }],
        },
      },
    }).catalog;
    const current = normalizePricingConfig({
      version: 2,
      currency: "USD",
      unit: "per_million_tokens",
      models: [{
        id: "deepseek-v4-flash",
        vendor: "deepseek",
        runtimeModelId: "deepseek-v4-flash",
        patterns: ["deepseek-v4-flash"],
        pricing: {input: 1, output: 1, cachedInput: 1},
        confidence: "user_override",
      }],
    });

    const removed = removePricingConfigModels(current, [{vendor: "deepseek", runtimeModelId: "deepseek-v4-flash"}]);
    expect(removed.models).toHaveLength(0);

    const merged = mergeProviderCatalogPricing(removed, withRules);
    const restored = merged.models.find(item =>
      item.vendor === "deepseek"
      && item.runtimeModelId === "deepseek-v4-flash");
    expect(restored).toMatchObject({
      pricing: {input: 0.44, output: 1.32, cachedInput: 0.014},
      priceSchedules: [expect.objectContaining({
        label: "闲时",
        rates: {input: 0.22, output: 0.66, cachedInput: 0.007},
      })],
    });
    expect(restored?.confidence).not.toBe("user_override");
  });
});

test("openai 官方预设 gpt-5.6 系自带 272K 长上下文档位并进入价格中心条目", () => {
  const catalog = parseProviderCatalogText(readFileSync("data/defaults/llm_catalog.jsonl", "utf8")).catalog;
  const entries = providerCatalogToPricingEntries(catalog);
  const sol = entries.find(entry => entry.runtimeModelId === "gpt-5.6-sol");
  const terra = entries.find(entry => entry.runtimeModelId === "gpt-5.6-terra");
  const luna = entries.find(entry => entry.runtimeModelId === "gpt-5.6-luna");
  // 272K 分界：input 侧 ×2（含缓存），output ×1.5，整单切档。
  // 2026-10-07 起目录只保留倍率：绝对价 rates 会阻断通道基数复合
  // （官方促销期长档 = 促销价×倍率、中转站长档 = 牌价×倍率），倍率自动推导各通道长档价。
  expect(sol?.pricing.longContext).toEqual({thresholdTokens: 272000, inputMultiplier: 2, outputMultiplier: 1.5});
  expect(terra?.pricing.longContext).toEqual({thresholdTokens: 272000, inputMultiplier: 2, outputMultiplier: 1.5});
  expect(luna?.pricing.longContext).toEqual({thresholdTokens: 272000, inputMultiplier: 2, outputMultiplier: 1.5});
});

test("编译条目携带目录版本与智谱活动的 priority 排序投影", () => {
  const catalog = parseProviderCatalogText(readFileSync("data/defaults/llm_catalog.jsonl", "utf8")).catalog;
  const entries = providerCatalogToPricingEntries(catalog);
  // 编译条目版本必须与目录元信息一致（随发布动态变化，不做具体值钉住）。
  expect(entries.every(entry => entry.catalogRevision === catalog.catalogRevision)).toBe(true);
  const flash = entries.find(entry => entry.vendor === "zhipu-cn" && entry.runtimeModelId === "glm-5.3-flash");
  const promotions = flash?.planCreditRules?.promotions ?? [];
  // 2026-09-30：新增庆双节活动（priority 100，工作日 14:00-18:00 ×0.5）。
  expect(promotions.map(promotion => promotion.priority)).toEqual([300, 200, 100, 100]);
  // origins 限定（双链路观测 2026-09-15）：官方活动现覆盖 ZCode/AutoClaw，
  // 仅直连导入通道命中。
  expect(promotions[0]).toMatchObject({multiplier: 0, origins: ["agent_local_import"]});
  expect(promotions[0]?.agents).toEqual(expect.arrayContaining(["zcode", "autoclaw"]));
  expect(promotions[1]).toMatchObject({multiplier: 2});
  expect(promotions[1]?.origins).toEqual(["agent_local_import"]);
  // 两个 priority=100 活动（同优先级间顺序不保证，按内容断言）：
  // ① 2026-09-23 目录升版：官方口径 2/3 精化为 67/100（等值 0.67）。
  expect(promotions).toContainEqual(expect.objectContaining(
    {multiplier: 0.67, agents: ["zcode"], origins: ["agent_local_import"]}));
  // ② 2026-09-30 庆双节（09-25 至 10-07）：无模型/Agent 限定，仅命中高峰窗 ×0.5。
  const festival = promotions.find(promotion => promotion.label === "庆双节·全天按非高峰抵扣");
  expect(festival).toMatchObject({multiplier: 0.5});
  expect(festival?.windows).toEqual([{days: [0, 1, 2, 3, 4], start: "14:00", end: "18:00", timezone: "Asia/Shanghai"}]);
  expect(festival?.agents).toBeUndefined();
  expect(festival?.origins).toBeUndefined();
});

test("中国区 vendor 改名迁移：官方目录条目迁往 -cn，LiteLLM/手工条目不动（2026-09-29）", () => {
  // 背景：deepseek/qwenai 改名 deepseek-cn/qwenai-cn，为 LiteLLM（USD）与未来
  // 美元区官方预设的同名 vendor key 让位。合并时只迁移「目录来源 + official」条目。
  const renamed = normalizeProviderCatalog({
    schemaVersion: 2,
    catalogRevision: "2026.09.29.02",
    publishedAt: "2026-09-29T19:40:00+08:00",
    providers: {
      deepseek: {
        name: "DeepSeek",
        brandId: "deepseek",
        pricingProviderId: "deepseek-cn",
        region: "cn",
        category: "official",
        currency: "CNY",
        models: [
          {id: "deepseek-flash", category: "chat", pricing: {input: 2, output: 8, cachedInput: 0.04}},
          {id: "deepseek-v4-pro", category: "chat", pricing: {input: 9, output: 27, cachedInput: 0.3}},
        ],
      },
    },
  }).catalog;
  const current = normalizePricingConfig({
    version: 2,
    currency: "USD",
    unit: "per_million_tokens",
    models: [
      { // 旧 vendor 名下的官方目录条目：应整体迁往 deepseek-cn，条目 id 保持不变。
        id: "catalog:deepseek:deepseek-flash",
        vendor: "deepseek",
        runtimeModelId: "deepseek-flash",
        patterns: ["deepseek-flash"],
        pricing: {input: 2, output: 8, cachedInput: 0.04},
        currency: "CNY",
        confidence: "official",
        catalogSource: "catalog",
      },
      { // LiteLLM USD 条目：不属于目录来源，必须留在 vendor=deepseek（美元区语义）。
        id: "deepseek/deepseek-chat",
        vendor: "deepseek",
        runtimeModelId: "deepseek-chat",
        patterns: ["deepseek/deepseek-chat"],
        pricing: {input: 0.28, output: 0.42},
        currency: "USD",
        confidence: "third_party",
      },
      { // 用户手工条目：不动。
        id: "manual-deepseek-v4-pro",
        vendor: "deepseek",
        runtimeModelId: "deepseek-v4-pro",
        patterns: ["deepseek-v4-pro"],
        pricing: {input: 8, output: 24},
        currency: "CNY",
        confidence: "user_override",
      },
    ],
  });
  const merged = mergeProviderCatalogPricing(current, renamed);
  const byIdentity = new Map(merged.models.map(entry => [
    `${entry.vendor}\u0000${entry.runtimeModelId}`, entry,
  ] as const));
  const rehomed = byIdentity.get("deepseek-cn\u0000deepseek-flash");
  expect(rehomed).toMatchObject({
    id: "catalog:deepseek:deepseek-flash",
    vendor: "deepseek-cn",
    pricingProviderId: "deepseek-cn",
    confidence: "official",
    currency: "CNY",
  });
  expect(byIdentity.get("deepseek\u0000deepseek-flash")).toBeUndefined();
  expect(byIdentity.get("deepseek\u0000deepseek-chat")).toMatchObject({
    vendor: "deepseek", confidence: "third_party", currency: "USD",
  });
  // 手工条目不被改名迁移；同身份下目录条目作为第二真相存在但不覆盖手工价。
  expect(byIdentity.get("deepseek\u0000deepseek-v4-pro")).toMatchObject({
    id: "manual-deepseek-v4-pro", confidence: "user_override",
  });
  expect(byIdentity.get("deepseek-cn\u0000deepseek-v4-pro")).toMatchObject({
    vendor: "deepseek-cn", confidence: "official",
  });
});

test("anthropic 模型 ID 改名迁移：点号旧条目并入连字符新键，消除与 LiteLLM 的重复（2026-09-30）", () => {
  // 背景：目录曾用点号 claude-sonnet-5.5，与 LiteLLM/官方 API 的连字符键
  // claude-sonnet-5-5 身份不一致，价格中心形成同模型两条。合并时按改名表迁移
  // 「目录来源 + official」条目，与 LiteLLM 同键条目重新合并为单条（保留 LiteLLM 条目 id）。
  const catalog = normalizeProviderCatalog({
    schemaVersion: 2,
    catalogRevision: "2026.09.30.02",
    publishedAt: "2026-09-30T13:00:00+08:00",
    providers: {
      anthropic: {
        name: "Anthropic",
        brandId: "anthropic",
        pricingProviderId: "anthropic",
        region: "global",
        category: "global_official",
        currency: "USD",
        models: [
          {id: "claude-sonnet-5-5", category: "chat", pricing: {input: 2, output: 10, cachedInput: 0.2}},
        ],
      },
    },
  }).catalog;
  const current = normalizePricingConfig({
    version: 2,
    currency: "USD",
    unit: "per_million_tokens",
    models: [
      { // 旧点号目录条目：应迁移到连字符键，match/patterns 同步改写、id 保留。
        id: "catalog:anthropic:claude-sonnet-5.5",
        vendor: "anthropic",
        runtimeModelId: "claude-sonnet-5.5",
        patterns: ["claude-sonnet-5.5"],
        pricing: {input: 2, output: 10, cachedInput: 0.2},
        currency: "USD",
        confidence: "official",
        catalogSource: "catalog",
      },
      { // LiteLLM 连字符条目：保留自身 id，与迁移后的目录条目合并为单条。
        id: "claude-sonnet-5-5",
        vendor: "anthropic",
        runtimeModelId: "claude-sonnet-5-5",
        patterns: ["claude-sonnet-5-5"],
        pricing: {input: 2, output: 10, cachedInput: 0.2},
        currency: "USD",
        confidence: "third_party",
      },
    ],
  });
  const merged = mergeProviderCatalogPricing(current, catalog);
  const sonnet = merged.models.filter(entry => entry.runtimeModelId.toLowerCase().startsWith("claude-sonnet-5"));
  expect(sonnet).toHaveLength(1);
  expect(sonnet[0]).toMatchObject({
    // 条目内部 id 保留旧值：既有目标映射按条目 ID 精确解析，不因改名失效。
    id: "catalog:anthropic:claude-sonnet-5.5",
    runtimeModelId: "claude-sonnet-5-5",
    vendor: "anthropic",
    confidence: "official",
  });
  expect(merged.models.some(entry => entry.runtimeModelId === "claude-sonnet-5.5")).toBe(false);
});

test("随包目录（2026.09.30.02）：中国区 vendor 已带 -cn 后缀且峰谷口径为非高峰 50%/高峰 1 倍", () => {
  const catalog = parseProviderCatalogText(readFileSync("data/defaults/llm_catalog.jsonl", "utf8")).catalog;
  const entries = providerCatalogToPricingEntries(catalog);
  expect(entries.filter(entry => entry.vendor === "deepseek-cn").map(entry => entry.runtimeModelId))
    .toEqual(expect.arrayContaining(["deepseek-flash", "deepseek-v4-pro"]));
  expect(entries.some(entry => entry.vendor === "deepseek" && entry.confidence === "official")).toBe(false);
  expect(entries.filter(entry => entry.vendor === "qwenai-cn").length).toBeGreaterThan(0);
  const glm53 = entries.find(entry => entry.vendor === "zhipu-cn" && entry.runtimeModelId === "glm-5.3");
  const flash = entries.find(entry => entry.vendor === "zhipu-cn" && entry.runtimeModelId === "glm-5.3-flash");
  // 2026-09-30 官网改版统一口径：非高峰 50%、高峰 1 倍；Flash 专属 profile 已合并。
  expect(glm53?.planCreditRules).toMatchObject({offPeakMultiplier: 0.5, peakWindows: [{multiplier: 1}]});
  expect(flash?.planCreditRules).toMatchObject({offPeakMultiplier: 0.5, peakWindows: [{multiplier: 1}]});
  expect(flash?.planCreditRules?.profileId).toBe(glm53?.planCreditRules?.profileId);
  // 庆双节活动（09-25 至 10-07）：仅命中工作日 14:00-18:00 高峰窗 ×0.5，使全天归一非高峰。
  expect(glm53?.planCreditRules?.promotions?.some(promotion =>
    promotion.label === "庆双节·全天按非高峰抵扣"
    && promotion.multiplier === 0.5
    && promotion.windows?.some(window => window.start === "14:00" && window.end === "18:00"),
  )).toBe(true);
  // OpenAI：GPT-6 家族入目录，terra/luna fast 档为标准 2 倍。
  const ids = entries.filter(entry => entry.vendor === "openai").map(entry => entry.runtimeModelId);
  expect(ids).toEqual(expect.arrayContaining(["gpt-6-astra", "gpt-6-sol", "gpt-6-luna"]));
  expect(entries.find(entry => entry.runtimeModelId === "gpt-5.6-terra")?.serviceTierPricing)
    .toEqual({fastMultiplier: 2});
  // Anthropic：opus-5-5 官方新价 + sonnet 换代（API ID 连字符形式，2026-09-30 修正点号拼写）。
  expect(entries.find(entry => entry.runtimeModelId === "claude-opus-5-5")?.pricing)
    .toMatchObject({input: 4, output: 20, cachedInput: 0.2, cacheWrite5m: 5, cacheWrite1h: 8});
  expect(entries.some(entry => entry.runtimeModelId === "claude-sonnet-5-5")).toBe(true);
  expect(entries.some(entry => entry.runtimeModelId === "claude-sonnet-5.5" && entry.vendor === "anthropic")).toBe(false);
  expect(entries.some(entry => entry.runtimeModelId === "claude-sonnet-5")).toBe(false);
  // OpenRouter：换代模型 + 无失效促销（OpenRouter slug 保持点号风格）。
  // 2026-10-02 补录 anthropic/claude-fable-5.1（旗舰线，$10/$50）。
  const router = entries.filter(entry => entry.vendor === "openrouter");
  expect(router.map(entry => entry.runtimeModelId).sort()).toEqual([
    "anthropic/claude-fable-5.1",
    "anthropic/claude-opus-5.5",
    "anthropic/claude-sonnet-5.5",
    "deepseek/deepseek-v4-pro",
    "deepseek/deepseek-v4.1-flash",
    "minimax/minimax-m3",
    "moonshotai/kimi-k2.7-code",
    "moonshotai/kimi-k3",
    "openai/gpt-6-astra",
    "openai/gpt-6-sol",
    "openai/gpt-6.1-sol",
    "qwen/qwen3.8-flash",
    "qwen/qwen3.8-max",
    "z-ai/glm-5.3",
  ]);
  expect(router.every(entry => (entry.promotions ?? []).length === 0)).toBe(true);
  // 腾讯：deepseek/deepseek-flash 高峰输出 8、闲时 4；hy3-202608 按量价 1/4/0.25
  // （2026-09-30 用户裁决：tc-code-latest 与 hy3 不接入，档位差异化积分无逐请求档位维度）。
  const tencentFlash = entries.find(entry => entry.vendor === "tencent-tokenhub" && entry.runtimeModelId === "deepseek/deepseek-flash");
  expect(tencentFlash?.pricing).toMatchObject({input: 2, output: 8, cachedInput: 0.04});
  expect(tencentFlash?.priceSchedules?.[0]?.rates).toMatchObject({input: 1, output: 4, cachedInput: 0.02});
  expect(entries.find(entry => entry.vendor === "tencent-tokenhub" && entry.runtimeModelId === "hy3-202608")?.pricing)
    .toMatchObject({input: 1, output: 4, cachedInput: 0.25});
  const tencentIds = entries.filter(entry => entry.vendor === "tencent-tokenhub").map(entry => entry.runtimeModelId);
  expect(tencentIds).not.toContain("tc-code-latest");
  expect(tencentIds).toContain("hy3");
  // SiliconFlow 换代：V4-Flash/V4-Pro 等最新代次；旧 DeepSeek-V4/Qwen3-235B 不再入目录。
  const siliconflow = entries.filter(entry => entry.vendor === "siliconflow").map(entry => entry.runtimeModelId);
  expect(siliconflow).toContain("deepseek-ai/DeepSeek-V4-Flash");
  expect(siliconflow).not.toContain("deepseek-ai/DeepSeek-V4");
  expect(siliconflow).not.toContain("Qwen/Qwen3-235B-A22B-Instruct");
  // OpenCode Go：Go Plus 档位 + 下架模型清理。
  expect(catalog.providers["opencode-go"]?.planTiers?.map(tier => tier.monthlyFee)).toEqual([10, 40]);
  expect(catalog.providers["opencode-go"]?.models.map(model => model.id)).not.toContain("qwen3.7-max");
  // 火山：Agent Plan 新档位 + v4.1-flash 系数。
  expect(catalog.providers["volcengine-plan"]?.planTiers?.map(tier => tier.monthlyFee))
    .toEqual([40, 200, 500, 1000, 40, 200]);
  expect(entries.find(entry => entry.vendor === "volcengine-plan" && entry.runtimeModelId === "deepseek-v4.1-flash")
    ?.planCreditRules?.modelFactors).toMatchObject({"deepseek-v4.1-flash": {input: 2.5, output: 2.5}});
  // 百炼：Token Plan 档位 + qwen3.7-plus >256K 长上下文档。
  expect(catalog.providers.qwenai?.planTiers?.map(tier => tier.monthlyFee)).toEqual([39, 79, 139, 499]);
  expect(entries.find(entry => entry.vendor === "qwenai-cn" && entry.runtimeModelId === "qwen3.7-plus")?.pricing?.longContext)
    .toMatchObject({thresholdTokens: 256000, inputMultiplier: 3, outputMultiplier: 3});
  // Kimi 套餐：k3 与 highspeed 模型入目录。
  expect(entries.filter(entry => entry.vendor === "moonshot-cn").map(entry => entry.runtimeModelId))
    .toEqual(expect.arrayContaining(["kimi-for-coding", "k3", "kimi-for-coding-highspeed"]));
});
