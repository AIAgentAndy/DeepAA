import { describe, expect, test } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, truncate, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  DEFAULT_PRICING,
  isWithinTimeWindows,
  matchPriceEntry,
  mergeCostAggregate,
  computeTokenCost,
  resolveTemporalPricing,
  accumulate,
  accumulateAuxiliaryRequest,
  aggregateCosts,
  emptyAggregate,
  findPricingCatalogModel,
  MAX_PRICING_CONFIG_BYTES,
  readPersistedPricingConfig,
  readPricingConfig,
  readEffectivePricingConfig,
  withPricingConfigMutation,
  writePricingConfig,
  createUsageLedgerEntry,
  normalizePricingConfig,
  normalizeLiteLLMPricingCatalog,
  pricingEntrySourceCategory,
  applyProxyTargetPricing,
  mergeLiteLLMPricingConfig,
  queryPricingCatalog,
  queryPricingVendors,
  assertProxyTargetPriceMappings,
  upsertPricingConfigModels,
  removePricingConfigModels,
} from "../src/lib/pricing.js";
import {
  emptyPriceDrafts,
  isDecimalDraft,
  priceDraftsToPricing,
} from "../src/lib/pricing-drafts.js";

describe("模型价格表与费用换算", () => {
  test("空的自定义代理目标不因价格中心无关条目冲突而失败", () => {
    const conflicted = normalizePricingConfig({
      version: 2,
      currency: "USD",
      unit: "per_million_tokens",
      models: [
        {id: "shared-entry", vendor: "openai", runtimeModelId: "gpt-x", patterns: ["gpt-x"], pricing: {input: 1, output: 2}},
        {id: "shared-entry", vendor: "anthropic", runtimeModelId: "claude-x", patterns: ["claude-x"], pricing: {input: 3, output: 4}},
      ],
    });

    expect(() => assertProxyTargetPriceMappings(conflicted, {supportedModels: [], pricing: undefined})).not.toThrow();
  });

  test("有模型的代理目标仍必须拒绝价格中心冲突和缺失映射", () => {
    const conflicted = normalizePricingConfig({
      version: 2,
      currency: "USD",
      unit: "per_million_tokens",
      models: [
        {id: "shared-entry", vendor: "openai", runtimeModelId: "gpt-x", patterns: ["gpt-x"], pricing: {input: 1, output: 2}},
        {id: "shared-entry", vendor: "anthropic", runtimeModelId: "claude-x", patterns: ["claude-x"], pricing: {input: 3, output: 4}},
      ],
    });

    expect(() => assertProxyTargetPriceMappings(conflicted, {
      supportedModels: ["gpt-x"],
      pricing: {modelVendors: {"gpt-x": {vendor: "openai", priceEntryId: "shared-entry"}}},
    })).toThrow("PRICING_ENTRY_ID_CONFLICT");
    expect(() => assertProxyTargetPriceMappings(DEFAULT_PRICING, {supportedModels: ["missing"], pricing: undefined}))
      .toThrow("MODEL_PRICE_MAPPING_REQUIRED");
  });

  test("有模型目标只校验当前引用价格条目，不受无关条目冲突影响", () => {
    const conflicted = normalizePricingConfig({
      version: 2,
      currency: "USD",
      unit: "per_million_tokens",
      models: [
        {id: "openai:gpt-x", vendor: "openai", runtimeModelId: "gpt-x", patterns: ["gpt-x"], pricing: {input: 1, output: 2}},
        {id: "azure/eu/duplicate", vendor: "azure-eu", runtimeModelId: "model-a", patterns: ["model-a"], pricing: {input: 3, output: 4}},
        {id: "azure/eu/duplicate", vendor: "azure-us", runtimeModelId: "model-b", patterns: ["model-b"], pricing: {input: 5, output: 6}},
      ],
    });

    expect(() => assertProxyTargetPriceMappings(conflicted, {
      supportedModels: ["gpt-x"],
      pricing: {modelVendors: {"gpt-x": {vendor: "openai", priceEntryId: "openai:gpt-x"}}},
    })).not.toThrow();
  });

  test("当前引用模型存在供应商加模型冲突时仍严格拒绝", () => {
    const conflicted = normalizePricingConfig({
      version: 2,
      currency: "USD",
      unit: "per_million_tokens",
      models: [
        {id: "openai:gpt-x:a", vendor: "openai", runtimeModelId: "gpt-x", patterns: ["gpt-x"], pricing: {input: 1, output: 2}},
        {id: "openai:gpt-x:b", vendor: "openai", runtimeModelId: "gpt-x", patterns: ["gpt-x"], pricing: {input: 3, output: 4}},
      ],
    });

    expect(() => assertProxyTargetPriceMappings(conflicted, {
      supportedModels: ["gpt-x"],
      pricing: {modelVendors: {"gpt-x": {vendor: "openai", priceEntryId: "openai:gpt-x:a"}}},
    })).toThrow("PRICING_VENDOR_MODEL_CONFLICT");
  });

  test("模型目录按供应商和真实运行时模型 ID 精确匹配，不依赖内部条目 ID", () => {
    const config = normalizeLiteLLMPricingCatalog({
      "openai/gpt-5.6": {
        litellm_provider: "openai",
        input_cost_per_token: 0.000002,
        output_cost_per_token: 0.000012,
      },
      "anthropic/gpt-5.6": {
        litellm_provider: "anthropic",
        input_cost_per_token: 0.000003,
        output_cost_per_token: 0.000015,
      },
    });

    expect(findPricingCatalogModel(config, "OPENAI", "gpt-5.6")?.vendor).toBe("openai");
    expect(findPricingCatalogModel(config, "anthropic", "gpt-5.6")?.vendor).toBe("anthropic");
    expect(findPricingCatalogModel(config, "openai", "openai/gpt-5.6")).toBeUndefined();
  });

  test("LiteLLM 合并遇到跨供应商重复 priceEntryId 时生成稳定全局唯一条目", () => {
    const current = {
      ...DEFAULT_PRICING,
      models: [{
        id: "amazon-nova/nova-lite-v1",
        vendor: "amazon_nova",
        runtimeModelId: "nova-lite-v1",
        match: "amazon-nova/nova-lite-v1",
        patterns: ["amazon-nova/nova-lite-v1"],
        pricing: {input: 0.06, output: 0.24},
        confidence: "third_party" as const,
      }],
    };
    const imported = {
      ...DEFAULT_PRICING,
      models: [{
        id: "amazon-nova/nova-lite-v1",
        vendor: "bedrock_converse",
        runtimeModelId: "amazon.nova-lite-v1:0",
        match: "amazon.nova-lite-v1:0",
        patterns: ["amazon.nova-lite-v1:0"],
        pricing: {input: 0.06, output: 0.24},
        confidence: "third_party" as const,
      }],
    };

    const merged = mergeLiteLLMPricingConfig(current, imported);
    expect(new Set(merged.models.map(item => item.id)).size).toBe(merged.models.length);
    expect(merged.models).toHaveLength(2);
    expect(merged.models.some(item => item.vendor === "bedrock_converse" && item.id !== "amazon-nova/nova-lite-v1")).toBe(true);
  });

  test("LiteLLM 按供应商与运行时模型合并并保留已有内部价格条目引用", () => {
    const current = normalizePricingConfig({
      version: 2,
      currency: "USD",
      unit: "per_million_tokens",
      models: [{
        id: "existing-price-entry",
        vendor: "openai",
        runtimeModelId: "gpt-5.6-sol",
        match: "gpt-5.6-sol",
        patterns: ["gpt-5.6-sol"],
        pricing: {input: 1, output: 2},
        confidence: "third_party",
      }],
    });
    const imported = normalizePricingConfig({
      version: 2,
      currency: "USD",
      unit: "per_million_tokens",
      models: [{
        id: "openai/gpt-5.6-sol",
        vendor: "openai",
        runtimeModelId: "gpt-5.6-sol",
        match: "openai/gpt-5.6-sol",
        patterns: ["openai/gpt-5.6-sol"],
        pricing: {input: 3, output: 4},
        confidence: "third_party",
      }],
    });

    const merged = mergeLiteLLMPricingConfig(current, imported);
    expect(merged.models).toHaveLength(1);
    expect(merged.models[0]).toMatchObject({
      id: "existing-price-entry",
      vendor: "openai",
      runtimeModelId: "gpt-5.6-sol",
      pricing: {input: 3, output: 4},
    });
  });

  test("LiteLLM 不覆盖官方目录（official）与用户手工（user_override）价格", () => {
    const current = normalizePricingConfig({
      version: 2,
      currency: "USD",
      unit: "per_million_tokens",
      models: [
        {
          id: "catalog:openai:gpt-5.6-sol",
          vendor: "openai",
          runtimeModelId: "gpt-5.6-sol",
          match: "gpt-5.6-sol",
          patterns: ["gpt-5.6-sol"],
          pricing: {input: 4, output: 20},
          confidence: "official" as const,
        },
        {
          id: "price:anthropic:claude-opus-5",
          vendor: "anthropic",
          runtimeModelId: "claude-opus-5",
          match: "claude-opus-5",
          patterns: ["claude-opus-5"],
          pricing: {input: 15, output: 75},
          confidence: "user_override" as const,
        },
      ],
    });
    const imported = normalizePricingConfig({
      version: 2,
      currency: "USD",
      unit: "per_million_tokens",
      models: [
        {
          id: "openai/gpt-5.6-sol",
          vendor: "openai",
          runtimeModelId: "gpt-5.6-sol",
          match: "openai/gpt-5.6-sol",
          patterns: ["openai/gpt-5.6-sol"],
          pricing: {input: 5, output: 30},
          confidence: "third_party",
        },
        {
          id: "anthropic/claude-opus-5",
          vendor: "anthropic",
          runtimeModelId: "claude-opus-5",
          match: "anthropic/claude-opus-5",
          patterns: ["anthropic/claude-opus-5"],
          pricing: {input: 3, output: 15},
          confidence: "third_party",
        },
        {
          id: "openai/gpt-5.6-luna",
          vendor: "openai",
          runtimeModelId: "gpt-5.6-luna",
          match: "openai/gpt-5.6-luna",
          patterns: ["openai/gpt-5.6-luna"],
          pricing: {input: 0.2, output: 1.2},
          confidence: "third_party",
        },
      ],
    });

    const merged = mergeLiteLLMPricingConfig(current, imported);
    const sol = merged.models.find(item => item.runtimeModelId === "gpt-5.6-sol");
    const opus = merged.models.find(item => item.runtimeModelId === "claude-opus-5");
    const luna = merged.models.find(item => item.runtimeModelId === "gpt-5.6-luna");
    // official 与 user_override 价格保持原值，不被 LiteLLM 覆盖。
    expect(sol?.pricing).toEqual({input: 4, output: 20});
    expect(opus?.pricing).toEqual({input: 15, output: 75});
    // LiteLLM 补充官方目录没有的模型。
    expect(luna?.pricing).toEqual({input: 0.2, output: 1.2});
  });

  test("previousPricing 记录手动覆盖前的原始价格并在归一化/合并中保留", () => {
    const entry = normalizePricingConfig({
      version: 2,
      currency: "USD",
      unit: "per_million_tokens",
      models: [{
        id: "price:openai:gpt-5.6-sol",
        vendor: "openai",
        runtimeModelId: "gpt-5.6-sol",
        match: "gpt-5.6-sol",
        patterns: ["gpt-5.6-sol"],
        pricing: {input: 5, output: 30},
        previousPricing: {input: 4, output: 20, cachedInput: 0.4},
        confidence: "user_override" as const,
      }],
    });
    expect(entry.models[0]?.previousPricing).toEqual({input: 4, output: 20, cachedInput: 0.4});

    // upsert 更新同一业务条目时 previousPricing 随条目保留。
    const upserted = upsertPricingConfigModels(entry, [{
      id: "price:openai:gpt-5.6-sol",
      vendor: "openai",
      runtimeModelId: "gpt-5.6-sol",
      match: "gpt-5.6-sol",
      patterns: ["gpt-5.6-sol"],
      pricing: {input: 6, output: 36},
      previousPricing: {input: 4, output: 20, cachedInput: 0.4},
      confidence: "user_override" as const,
    }]);
    expect(upserted.models[0]?.pricing).toEqual({input: 6, output: 36});
    expect(upserted.models[0]?.previousPricing).toEqual({input: 4, output: 20, cachedInput: 0.4});
  });

  test("稀疏手工价格保存保留上下文、协议能力和官方来源字段", () => {
    const current = normalizePricingConfig({
      version: 2,
      currency: "USD",
      unit: "per_million_tokens",
      models: [{
        id: "catalog:openai:gpt-6-sol",
        vendor: "openai",
        runtimeModelId: "gpt-6-sol",
        patterns: ["gpt-6-sol"],
        mode: "chat",
        contextWindow: 272000,
        maxOutput: 32000,
        inputModalities: ["text", "image"],
        supportedWireApis: ["responses"],
        catalogRevision: "2026.09.23.01",
        catalogSourceHash: "sha256:catalog",
        confidence: "official",
        catalogSource: "catalog",
        pricing: {input: 4, output: 20},
      }],
    });

    const sparse = upsertPricingConfigModels(current, [{
      id: "catalog:openai:gpt-6-sol",
      vendor: "openai",
      runtimeModelId: "gpt-6-sol",
      patterns: ["gpt-6-sol"],
      pricing: {input: 5, output: 25},
      confidence: "user_override",
    }]);
    const saved = sparse.models[0];
    expect(saved?.pricing).toEqual({input: 5, output: 25});
    expect(saved).toMatchObject({
      contextWindow: 272000,
      maxOutput: 32000,
      inputModalities: ["text", "image"],
      supportedWireApis: ["responses"],
      catalogRevision: "2026.09.23.01",
      catalogSourceHash: "sha256:catalog",
    });
  });

  test("同名运行时模型在不同供应商下按供应商分别保留", () => {
    const merged = mergeLiteLLMPricingConfig(
      normalizePricingConfig({
        version: 2,
        currency: "USD",
        unit: "per_million_tokens",
        models: [{
          id: "openai-gpt-5.6-sol",
          vendor: "openai",
          runtimeModelId: "gpt-5.6-sol",
          patterns: ["gpt-5.6-sol"],
          pricing: {input: 1, output: 2},
          confidence: "third_party",
        }],
      }),
      normalizePricingConfig({
        version: 2,
        currency: "USD",
        unit: "per_million_tokens",
        models: [{
          id: "azure-gpt-5.6-sol",
          vendor: "azure",
          runtimeModelId: "gpt-5.6-sol",
          patterns: ["gpt-5.6-sol"],
          pricing: {input: 3, output: 4},
          confidence: "third_party",
        }],
      }),
    );

    expect(merged.models).toHaveLength(2);
    expect(merged.models.map(item => `${item.vendor}:${item.runtimeModelId}`)).toEqual([
      "azure:gpt-5.6-sol",
      "openai:gpt-5.6-sol",
    ]);
  });

  test("大模型目录先搜索完整供应商集合再按响应上限截断", () => {
    const config = normalizeLiteLLMPricingCatalog(Object.fromEntries(
      Array.from({ length: 250 }, (_, index) => [
        `openai/searchable-model-${String(index).padStart(3, "0")}`,
        {
          litellm_provider: "openai",
          input_cost_per_token: 0.000002,
          output_cost_per_token: 0.000012,
        },
      ]),
    ));

    const page = queryPricingCatalog(config, {
      vendor: "openai",
      search: "searchable-model",
      limit: 200,
      offset: 0,
    });

    expect(page.total).toBe(250);
    expect(page.items).toHaveLength(200);
    expect(page.items.every(item => item.vendor === "openai")).toBe(true);
    expect(queryPricingCatalog(config, {
      vendor: "openai",
      search: "searchable-model-249",
      limit: 200,
    }).items.map(item => item.id)).toEqual(["openai/searchable-model-249"]);
  });

  test("matchPriceEntry 按最长子串匹配，更具体的条目优先", () => {
    expect(matchPriceEntry(DEFAULT_PRICING, "claude-sonnet-4-20250514")?.id).toBe("claude-sonnet-4");
    expect(matchPriceEntry(DEFAULT_PRICING, "claude-haiku-3-5")?.id).toBe("claude-haiku");
    expect(matchPriceEntry(DEFAULT_PRICING, "gpt-4o-mini")?.id).toBe("gpt-4o-mini");
    expect(matchPriceEntry(DEFAULT_PRICING, "deepseek-reasoner-v2")?.id).toBe("deepseek-reasoner");
    expect(matchPriceEntry(DEFAULT_PRICING, "unknown-model")).toBeUndefined();
  });

  test("官方预设悬空映射优先回落官方目录 vendor（2026-10-06 deepseek 事故防御）", () => {
    // 事故形态：目录改键 deepseek→deepseek-cn 后，目标映射 priceEntryId 悬空、
    // vendor 值与 LiteLLM 第三方命名空间同名——旧链按 vendor 精确命中 LiteLLM USD 条目。
    const config = {
      version: 2 as const,
      currency: "USD",
      unit: "per_million_tokens",
      models: [
        {
          id: "catalog:deepseek-cn:deepseek-flash",
          vendor: "deepseek-cn",
          runtimeModelId: "deepseek-flash",
          patterns: ["deepseek-flash"],
          pricing: {input: 2, output: 8, cachedInput: 0.04},
          currency: "CNY",
          confidence: "official",
        },
        {
          id: "deepseek-flash",
          vendor: "deepseek",
          patterns: ["deepseek-flash"],
          pricing: {input: 0.3, output: 1.2, cachedInput: 0.006},
          currency: "USD",
          confidence: "third_party",
        },
      ],
      targetModelMappings: {
        "t-ds": {"deepseek-flash": {priceEntryId: "catalog:deepseek:deepseek-flash", vendor: "deepseek"}},
      },
      targetVendorPreferences: {"t-ds": "deepseek"},
    };
    const usage = {inputTokens: 1000, outputTokens: 1000};

    // 带官方预设 vendor：悬空映射回落 deepseek-cn 官方目录 CNY 条目，不再滑进 LiteLLM。
    const defended = computeTokenCost(config, "deepseek-flash", usage, {
      targetId: "t-ds",
      officialPresetVendor: "deepseek-cn",
    });
    expect(defended.priceEntryId).toBe("catalog:deepseek-cn:deepseek-flash");
    expect(defended.vendor).toBe("deepseek-cn");
    expect(defended.currency).toBe("CNY");
    expect(defended.pricingSnapshot?.matchStrategy).toBe("official_preset_vendor_exact");

    // 无官方预设 vendor（自定义目标/旧调用方）：保持旧行为，vendor 兜底命中 LiteLLM 条目。
    const legacy = computeTokenCost(config, "deepseek-flash", usage, {targetId: "t-ds"});
    expect(legacy.priceEntryId).toBe("deepseek-flash");
    expect(legacy.currency).toBe("USD");
    expect(legacy.pricingSnapshot?.matchStrategy).toBe("target_model_vendor_exact");

    // 用户显式映射到 LiteLLM 条目时仍最优先（priceEntryId 有效命中不被预设档覆盖）。
    const explicit = computeTokenCost({
      ...config,
      targetModelMappings: {
        "t-ds": {"deepseek-flash": {priceEntryId: "deepseek-flash", vendor: "deepseek"}},
      },
    }, "deepseek-flash", usage, {targetId: "t-ds", officialPresetVendor: "deepseek-cn"});
    expect(explicit.priceEntryId).toBe("deepseek-flash");
    expect(explicit.currency).toBe("USD");
    expect(explicit.pricingSnapshot?.matchStrategy).toBe("target_model_entry");

    // 官方目录 vendor 内无该模型时落回原有匹配链（不改变无目录条目时的行为）。
    const miss = computeTokenCost(config, "deepseek-flash", usage, {
      targetId: "t-ds",
      officialPresetVendor: "another-preset",
    });
    expect(miss.priceEntryId).toBe("deepseek-flash");
    expect(miss.pricingSnapshot?.matchStrategy).toBe("target_model_vendor_exact");
  });

  test("computeTokenCost 命中价格时换算费用，未命中时 priced=false", () => {
    const cost = computeTokenCost(DEFAULT_PRICING, "deepseek-v4-flash", {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    expect(cost.priced).toBe(true);
    expect(cost.matchedModel).toBe("deepseek-v4-flash");
    expect(cost.inputCost).toBeCloseTo(0.14, 9);
    expect(cost.outputCost).toBeCloseTo(0.28, 9);
    expect(cost.totalCost).toBeCloseTo(0.42, 9);

    const unknown = computeTokenCost(DEFAULT_PRICING, "mystery-model", {
      inputTokens: 100,
      outputTokens: 50,
    });
    expect(unknown.priced).toBe(false);
    expect(unknown.totalCost).toBeUndefined();
    expect(unknown.inputTokens).toBe(100);
  });

  test("aggregateCosts 按 Turn/Session 聚合 token 与费用", () => {
    const exchanges = [
      { exchangeId: "ex1", durationMs: 1_000, request: { parsedBody: { model: "deepseek-v4-flash" } } },
      { exchangeId: "ex2", durationMs: 3_000, request: { parsedBody: { model: "deepseek-v4-flash" } } },
      { exchangeId: "aux1", durationMs: 2_000, request: { parsedBody: {} } },
    ];
    const dataset = {
      steps: [
        { exchangeId: "ex1", turnId: "turn1", agentSessionId: "sess1", toolUseNames: ["Read"], toolUseIds: ["tool-1"], tokenUsage: { inputTokens: 1_000_000, outputTokens: 500_000 } },
        { exchangeId: "ex2", turnId: "turn1", agentSessionId: "sess1", toolUseNames: ["Read", "Write"], toolUseIds: ["tool-2", "tool-3"], tokenUsage: { inputTokens: 500_000, outputTokens: 250_000 } },
      ],
      auxiliaryExchanges: [{ exchangeId: "aux1", agentSessionId: "sess1", agentTurnId: "turn1" }],
    };
    const result = aggregateCosts(DEFAULT_PRICING, exchanges, dataset);
    const turnAgg = result.byTurn.get("turn1");
    expect(turnAgg?.inputTokens).toBe(1_500_000);
    expect(turnAgg?.outputTokens).toBe(750_000);
    expect(turnAgg?.pricedSteps).toBe(2);
    expect(turnAgg?.totalCost).toBeCloseTo(0.42, 6);
    expect(result.bySession.get("sess1")?.totalCost).toBeCloseTo(0.42, 6);
    expect(turnAgg?.byModel["deepseek-v4-flash"].stepCount).toBe(2);
    expect(turnAgg).toMatchObject({
      requestCount: 3,
      stepRequestCount: 2,
      auxiliaryRequestCount: 1,
      durationTotalMs: 6_000,
      durationSampleCount: 3,
      toolCallCount: 3,
      toolCallsByName: { Read: 2, Write: 1 },
    });
  });

  test("辅助请求不增加 Token 与费用，聚合合并时保留请求、耗时和工具统计", () => {
    const left = emptyAggregate("USD");
    const right = emptyAggregate("USD");
    accumulate(left, computeTokenCost(DEFAULT_PRICING, "deepseek-v4-flash", {
      inputTokens: 100,
      outputTokens: 20,
    }), "deepseek-v4-flash", "provider_usage", "exact", {
      durationMs: 1_500,
      toolUseNames: ["Bash"],
      toolUseIds: ["call-1"],
    });
    accumulateAuxiliaryRequest(right, { durationMs: 500 });

    mergeCostAggregate(left, right);

    expect(left.requestCount).toBe(2);
    expect(left.stepRequestCount).toBe(1);
    expect(left.auxiliaryRequestCount).toBe(1);
    expect(left.durationTotalMs).toBe(2_000);
    expect(left.durationSampleCount).toBe(2);
    expect(left.toolCallCount).toBe(1);
    expect(left.toolCallsByName).toEqual({ Bash: 1 });
    expect(left.inputTokens).toBe(100);
    expect(left.pricedSteps).toBe(1);
  });

  test("accumulate 兼容旧 checkpoint 中缺失的聚合 map 字段", () => {
    const legacyAggregate = {
      ...emptyAggregate("USD"),
      unpricedReasons: undefined,
      byUsageSource: undefined,
      byUsageConfidence: undefined,
      byModel: undefined,
    };

    accumulate(legacyAggregate as never, {
      currency: "USD",
      priced: false,
      priceVersion: 2,
      inputTokens: 100,
      outputTokens: 20,
      unpricedReason: "model_ambiguous",
    }, "gpt-5.5", "provider_usage", "exact");

    expect(legacyAggregate.unpricedReasons).toEqual({ model_ambiguous: 1 });
    expect(legacyAggregate.byUsageSource).toEqual({ provider_usage: 1 });
    expect(legacyAggregate.byUsageConfidence).toEqual({ exact: 1 });
    expect(legacyAggregate.byModel?.["gpt-5.5"].unpricedSteps).toBe(1);
    expect(legacyAggregate.requestCount).toBe(1);
    expect(legacyAggregate.stepRequestCount).toBe(1);
    expect(legacyAggregate.auxiliaryRequestCount).toBe(0);
  });

  test("readPricingConfig 回退默认，writePricingConfig 持久化覆盖", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "pricing-"));
    const before = await readPricingConfig(dataDir);
    expect(before.models.length).toBeGreaterThan(0);

    const custom = {
      version: 1 as const,
      currency: "USD",
      unit: "per_million_tokens",
      models: [{ id: "custom", match: "custom-model", vendor: "Test", input: 1, output: 2 }],
    };
    await writePricingConfig(dataDir, custom);
    const after = await readPricingConfig(dataDir);
    expect(after.models).toHaveLength(1);
    expect(after.models[0]?.id).toBe("custom");
    // 确认写入到 dataDir/config/model-pricing.json
    const raw = await readFile(join(dataDir, "config", "model-pricing.json"), "utf-8");
    expect(JSON.parse(raw).models[0].id).toBe("custom");
  });

  test("已有价格文件损坏时读取必须报错，不能静默伪装成内置默认目录", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "pricing-corrupt-read-"));
    const configDir = join(dataDir, "config");
    await mkdir(configDir, {recursive: true});
    await writeFile(join(configDir, "model-pricing.json"), "{broken-json", "utf8");

    await expect(readPricingConfig(dataDir)).rejects.toThrow("本地模型价格配置不是合法 JSON");
  });

  test("价格配置按 mtime 指纹缓存：未变文件命中共享对象，外部改写后失效", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "pricing-cache-"));
    const custom = {
      version: 1 as const,
      currency: "USD",
      unit: "per_million_tokens",
      models: [{ id: "cache-hit", match: "cache-model", vendor: "Test", input: 1, output: 2 }],
    };
    await writePricingConfig(dataDir, custom);
    const first = await readPersistedPricingConfig(dataDir);
    const second = await readPersistedPricingConfig(dataDir);
    expect(second).toBe(first);

    // 模拟绕过 writePricingConfig 的外部改写（如另一进程）：指纹变化必须失效缓存。
    // 内容长度刻意不同，避免同 mtime 粒度 + 同 size 的极端假命中。
    const pricingPath = join(dataDir, "config", "model-pricing.json");
    await writeFile(pricingPath, JSON.stringify({
      version: 2,
      currency: "USD",
      unit: "per_million_tokens",
      models: [{id: "external-write", vendor: "Test", runtimeModelId: "ext-model", patterns: ["ext-model"], pricing: {input: 9, output: 9}}],
    }), "utf-8");
    const third = await readPersistedPricingConfig(dataDir);
    expect(third?.models[0]?.id).toBe("external-write");
    expect(third).not.toBe(first);
  });

  test("价格模型 upsert 只按供应商与运行时模型更新，不删除未提交的历史模型", () => {
    const current = normalizePricingConfig({
      version: 2,
      currency: "USD",
      unit: "per_million_tokens",
      models: [{
        id: "zhipu-glm-5.2",
        vendor: "zhipu-cn",
        runtimeModelId: "glm-5.2",
        patterns: ["glm-5.2"],
        pricing: {input: 1, output: 2},
        confidence: "official",
      }, {
        id: "zhipu-glm-5.3",
        vendor: "zhipu-cn",
        runtimeModelId: "glm-5.3",
        patterns: ["glm-5.3"],
        pricing: {input: 3, output: 4},
        confidence: "official",
      }],
    });

    const merged = upsertPricingConfigModels(current, [{
      id: "incoming-glm-5.3",
      vendor: "zhipu-cn",
      runtimeModelId: "glm-5.3",
      patterns: ["glm-5.3"],
      pricing: {input: 5, output: 6},
      confidence: "official",
    }]);

    expect(merged.models).toEqual(expect.arrayContaining([
      expect.objectContaining({id: "zhipu-glm-5.2", runtimeModelId: "glm-5.2"}),
      expect.objectContaining({id: "zhipu-glm-5.3", runtimeModelId: "glm-5.3", pricing: {input: 5, output: 6}}),
    ]));
    expect(merged.models).toHaveLength(2);
  });

  test("删除价格中心条目后再次合并 LiteLLM 目录可恢复官方价格", () => {
    const current = normalizePricingConfig({
      version: 2,
      currency: "USD",
      unit: "per_million_tokens",
      models: [{
        id: "deepseek-v4-flash",
        vendor: "DeepSeek",
        runtimeModelId: "deepseek-v4-flash",
        patterns: ["deepseek-v4-flash"],
        pricing: {input: 1, output: 1, cachedInput: 1},
        confidence: "user_override",
      }],
    });

    const removed = removePricingConfigModels(current, [{vendor: "DeepSeek", runtimeModelId: "deepseek-v4-flash"}]);
    expect(removed.models).toHaveLength(0);

    const imported = normalizeLiteLLMPricingCatalog({
      "deepseek/deepseek-v4-flash": {
        litellm_provider: "deepseek",
        input_cost_per_token: 0.00000044,
        output_cost_per_token: 0.00000132,
      },
    });
    const merged = mergeLiteLLMPricingConfig(removed, imported);
    const restored = merged.models.find(item =>
      item.vendor === "deepseek"
      && item.runtimeModelId === "deepseek-v4-flash");
    expect(restored).toBeDefined();
    expect(restored?.pricing?.input).toBeCloseTo(0.44, 9);
    expect(restored?.confidence).not.toBe("user_override");
  });

  test("价格中心拒绝同一供应商和运行时模型存在多个冲突条目", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "pricing-unique-"));
    const duplicated = normalizePricingConfig({
      version: 2,
      currency: "USD",
      unit: "per_million_tokens",
      models: [
        {id: "manual:openai:gpt-5.6", vendor: "openai", patterns: ["gpt-5.6"], pricing: {input: 1, output: 2}, confidence: "user_override"},
        {id: "catalog:openai:gpt-5.6", vendor: "openai", patterns: ["gpt-5.6"], pricing: {input: 3, output: 4}, confidence: "official"},
      ],
    });

    await expect(writePricingConfig(dataDir, duplicated)).rejects.toThrow("PRICING_VENDOR_MODEL_CONFLICT");
  });

  test("价格中心条目 ID 必须全局唯一，不能跨供应商复用后依赖数组顺序计价", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "pricing-id-unique-"));
    const duplicatedId = normalizePricingConfig({
      version: 2,
      currency: "USD",
      unit: "per_million_tokens",
      models: [
        {id: "shared-entry", vendor: "openai", runtimeModelId: "gpt-x", patterns: ["gpt-x"], pricing: {input: 1, output: 2}},
        {id: "shared-entry", vendor: "anthropic", runtimeModelId: "claude-x", patterns: ["claude-x"], pricing: {input: 3, output: 4}},
      ],
    });

    await expect(writePricingConfig(dataDir, duplicatedId)).rejects.toThrow("PRICING_ENTRY_ID_CONFLICT");
  });

  test("旧条目的 alias 只参与匹配，不得改变供应商加运行时模型的唯一身份", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "pricing-alias-identity-"));
    const duplicated = normalizePricingConfig({
      version: 2,
      currency: "USD",
      unit: "per_million_tokens",
      models: [
        {id: "entry-a", vendor: "openai", match: "gpt-x", patterns: ["gpt-x"], aliases: ["alias-a"], pricing: {input: 1, output: 2}},
        {id: "entry-b", vendor: "openai", match: "gpt-x", patterns: ["gpt-x"], aliases: ["alias-b"], pricing: {input: 3, output: 4}},
      ],
    });

    await expect(writePricingConfig(dataDir, duplicated)).rejects.toThrow("PRICING_VENDOR_MODEL_CONFLICT");
  });

  test("严格读取在解析前拒绝超过 8 MiB 的本地价格文件", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "pricing-bounded-read-"));
    const configDir = join(dataDir, "config");
    const pricingPath = join(configDir, "model-pricing.json");
    await mkdir(configDir, { recursive: true });
    await writeFile(pricingPath, "{}");
    await truncate(pricingPath, MAX_PRICING_CONFIG_BYTES + 1);

    await expect(readPersistedPricingConfig(dataDir)).rejects.toThrow(/超过 8 MiB/u);
  });

  test("价格配置通过原子替换持久化且不残留临时文件", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "pricing-atomic-write-"));
    await writePricingConfig(dataDir, DEFAULT_PRICING);

    const configDir = join(dataDir, "config");
    expect((await readdir(configDir)).filter(name => name.includes(".tmp-"))).toEqual([]);
    expect(JSON.parse(await readFile(join(configDir, "model-pricing.json"), "utf-8")).version).toBe(2);
  });

  test("同一数据目录的价格修改严格串行执行", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "pricing-mutation-"));
    const order: string[] = [];
    let releaseFirst!: () => void;
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>(resolve => { markFirstStarted = resolve; });
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });

    const first = withPricingConfigMutation(dataDir, async () => {
      order.push("first:start");
      markFirstStarted();
      await firstGate;
      order.push("first:end");
    });
    await firstStarted;
    const second = withPricingConfigMutation(dataDir, async () => {
      order.push("second");
    });
    await Promise.resolve();

    expect(order).toEqual(["first:start"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(["first:start", "first:end", "second"]);
  });

  test("v2 默认价表包含可追溯官方价并按 cache hit/miss 分拆 DeepSeek v4", () => {
    expect(DEFAULT_PRICING.version).toBe(2);
    const matched = matchPriceEntry(DEFAULT_PRICING, "deepseek-v4-pro");
    expect(matched?.id).toBe("deepseek-v4-pro");
    expect(matched?.confidence).toBe("official");
    expect(matched?.sourceUrl).toContain("api-docs.deepseek.com");

    const cost = computeTokenCost(DEFAULT_PRICING, "deepseek-v4-pro", {
      inputTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    expect(cost.priced).toBe(true);
    expect(cost.matchedModel).toBe("deepseek-v4-pro");
    expect(cost.inputCost).toBeCloseTo(0.435, 9);
    expect(cost.cacheReadCost).toBeCloseTo(0.003625, 9);
    expect(cost.outputCost).toBeCloseTo(0.87, 9);
    expect(cost.totalCost).toBeCloseTo(1.308625, 9);
    expect(cost.formula).toContain("input 1000000 * 0.435 / 1000000");
  });

  test("v2 默认价表已移除 Kimi K2.7 Code 旧美元价，避免与人民币目录口径混淆", () => {
    expect(DEFAULT_PRICING.models.some(entry => entry.id === "kimi-k2.7-code-highspeed")).toBe(false);
    expect(DEFAULT_PRICING.models.some(entry => entry.id === "kimi-k2.7-code")).toBe(false);
    const cost = computeTokenCost(DEFAULT_PRICING, "moonshot-kimi-k2.7-code-highspeed", {
      inputTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    expect(cost.priced).toBe(false);
  });

  test("target override 只影响指定目标的实际费用，保留官方成本", () => {
    const config = {
      ...DEFAULT_PRICING,
      targetOverrides: [
        {
          id: "one-yuan-deepseek",
          targetId: "1yuanapi.com",
          patterns: ["deepseek-v4-pro"],
          currency: "USD",
          pricing: { input: 0.1, output: 0.2, cachedInput: 0.01 },
          confidence: "user_override" as const,
          sourceUrl: "local://target-overrides/1yuanapi.com",
          sourceCheckedAt: "2026-07-08",
        },
      ],
    };
    const cost = computeTokenCost(config, "deepseek-v4-pro", {
      inputTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
      outputTokens: 1_000_000,
    }, { targetId: "1yuanapi.com" });
    expect(cost.priced).toBe(true);
    expect(cost.matchedModel).toBe("deepseek-v4-pro");
    expect(cost.officialTotalCost).toBeCloseTo(1.308625, 9);
    expect(cost.totalCost).toBeCloseTo(0.31, 9);
    expect(cost.overrideId).toBe("one-yuan-deepseek");
    expect(cost.confidence).toBe("user_override");
  });

  test("目标级覆盖价未显式带币种时继承命中条目币种（2026-09-28 修复）", () => {
    // 智谱目录条目：CNY 计价。修复前覆盖价无 currency 会回退全局默认 USD，
    // 导致币种被标错且结算系数推导走错分支。
    const cnyEntry = {
      ...(DEFAULT_PRICING.models.find(model => (model.patterns ?? []).includes("deepseek-v4-pro")) ?? DEFAULT_PRICING.models[0]!),
      id: "zhipu-glm-53",
      vendor: "Zhipu",
      patterns: ["glm-5.3"],
      match: "glm-5.3",
      currency: "CNY" as const,
      pricing: {input: 2, output: 8, cachedInput: 0.5},
    };
    const config = {
      ...DEFAULT_PRICING,
      models: [cnyEntry],
      targetOverrides: [
        {
          id: "zhipu-relay-inherit",
          targetId: "relay-1",
          patterns: ["glm-5.3"],
          pricing: {input: 1, output: 4},
          confidence: "user_override" as const,
        },
        {
          id: "zhipu-relay-explicit",
          targetId: "relay-1",
          patterns: ["glm-5.3-explicit"],
          pricing: {input: 1, output: 4},
          currency: "USD",
          confidence: "user_override" as const,
        },
      ],
    };
    const cnyEntryExplicit = {...cnyEntry, patterns: ["glm-5.3-explicit"], match: "glm-5.3-explicit"};
    const configExplicit = {...config, models: [cnyEntry, cnyEntryExplicit]};

    const inherited = computeTokenCost(config, "glm-5.3", {
      inputTokens: 1_000_000, cacheReadTokens: 0, outputTokens: 1_000_000,
    }, {targetId: "relay-1"});
    expect(inherited.priced).toBe(true);
    // 修复点：无显式币种的覆盖继承条目 CNY，而不是回退全局 USD。
    expect(inherited.currency).toBe("CNY");

    const explicit = computeTokenCost(configExplicit, "glm-5.3-explicit", {
      inputTokens: 1_000_000, cacheReadTokens: 0, outputTokens: 1_000_000,
    }, {targetId: "relay-1"});
    expect(explicit.priced).toBe(true);
    // 显式币种仍然优先于条目币种。
    expect(explicit.currency).toBe("USD");
  });

  test("未官方确认的模型默认不计价并给出原因", () => {
    const cost = computeTokenCost(DEFAULT_PRICING, "glm-5.2", {
      inputTokens: 1000,
      outputTokens: 500,
    });
    expect(cost.priced).toBe(false);
    expect(cost.unpricedReason).toBe("price_unverified");
    expect(cost.matchedModel).toBe("glm-5.2");
    expect(cost.totalCost).toBeUndefined();
  });

  test("turn 级 usage ledger 记录价格版本、来源、公式和未计价原因", () => {
    const ledger = createUsageLedgerEntry(DEFAULT_PRICING, {
      targetId: "deepseek",
      agentFingerprintId: "agent-1",
      agentName: "Codex",
      sessionId: "session-1",
      turnId: "turn-1",
      nativeTurnId: "provider-turn-1",
      exchangeId: "ex-1",
      model: "deepseek-v4-flash",
      usage: { inputTokens: 1000, outputTokens: 500 },
      usageSource: "provider_usage",
      usageConfidence: "exact",
      createdAt: "2026-07-08T00:00:00.000Z",
    });
    expect(ledger.priced).toBe(true);
    expect(ledger.priceVersion).toBe(2);
    expect(ledger.priceEntryId).toBe("deepseek-v4-flash");
    expect(ledger.usageSource).toBe("provider_usage");
    expect(ledger.usageConfidence).toBe("exact");
    expect(ledger.formula).toContain("input 1000");
    expect(ledger.totalCost).toBeGreaterThan(0);
  });

  test("指定 target 供应商时优先匹配对应供应商模型并保存价格快照", () => {
    const config = normalizeLiteLLMPricingCatalog({
      "azure_ai/gpt-5.5": {
        litellm_provider: "azure_ai",
        input_cost_per_token: 0.000005,
        output_cost_per_token: 0.00003,
        cache_read_input_token_cost: 0.0000005,
      },
      "openai/gpt-5.5": {
        litellm_provider: "openai",
        input_cost_per_token: 0.000002,
        output_cost_per_token: 0.000012,
        cache_read_input_token_cost: 0.0000002,
      },
    });
    config.targetVendorPreferences = { "1yuanapi.com": "openai" };

    const cost = computeTokenCost(config, "gpt-5.5", {
      inputTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
      outputTokens: 1_000_000,
    }, { targetId: "1yuanapi.com" });

    expect(cost.priced).toBe(true);
    expect(cost.matchedModel).toBe("openai/gpt-5.5");
    expect(cost.vendor).toBe("openai");
    expect(cost.pricingSnapshot).toMatchObject({
      matchStrategy: "target_vendor_exact",
      rateMultiplier: 1,
      baseRates: { input: 2, cachedInput: 0.2, output: 12 },
      effectiveRates: { input: 2, cachedInput: 0.2, output: 12 },
    });
    expect(cost.totalCost).toBeCloseTo(14.2, 9);
  });

  test("目录未收录模型时按目标供应商偏好兜底 vendor，并用目标覆盖价计价", () => {
    const config = {
      ...normalizeLiteLLMPricingCatalog({}),
      targetVendorPreferences: { "api.deepseek.com": "deepseek" },
      targetOverrides: [
        {
          id: "deepseek-v4-flash-override",
          targetId: "api.deepseek.com",
          patterns: ["deepseek-v4-flash"],
          currency: "USD",
          pricing: { input: 1, output: 2, cachedInput: 0.02, cacheWrite: 0 },
          confidence: "user_override" as const,
          sourceUrl: "local://target-overrides/api.deepseek.com",
          sourceCheckedAt: "2026-07-31",
        },
      ],
    };
    const cost = computeTokenCost(config, "deepseek-v4-flash", {
      inputTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
      outputTokens: 100_000,
    }, { targetId: "api.deepseek.com" });
    expect(cost.priced).toBe(true);
    expect(cost.vendor).toBe("deepseek");
    expect(cost.overrideId).toBe("deepseek-v4-flash-override");
    expect(cost.officialTotalCost).toBeUndefined();
    expect(cost.totalCost).toBeCloseTo(1.22, 9);
    expect(cost.pricingSnapshot?.matchStrategy).toBe("target_override");
  });

  test("规范化带运行时后缀的模型名，避免 glm-5.2[1m] 误配 glm-5", () => {
    const config = normalizeLiteLLMPricingCatalog({
      "zai/glm-5": {
        litellm_provider: "zai",
        input_cost_per_token: 0.000001,
        output_cost_per_token: 0.0000032,
      },
      "zai/glm-5.2": {
        litellm_provider: "zai",
        input_cost_per_token: 0.000004,
        output_cost_per_token: 0.000016,
        cache_read_input_token_cost: 0.0000004,
      },
    });
    config.targetVendorPreferences = { "zhipu-target": "zai" };

    const cost = computeTokenCost(config, "glm-5.2[1m]", {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    }, { targetId: "zhipu-target" });

    expect(cost.priced).toBe(true);
    expect(cost.matchedModel).toBe("zai/glm-5.2");
    expect(cost.pricingSnapshot?.matchStrategy).toBe("target_vendor_normalized_exact");
    expect(cost.totalCost).toBeCloseTo(20, 9);
  });

  test("同名多供应商且未指定供应商时标记歧义而不是静默选择第一条", () => {
    const config = normalizeLiteLLMPricingCatalog({
      "azure_ai/gpt-5.5": {
        litellm_provider: "azure_ai",
        input_cost_per_token: 0.000005,
        output_cost_per_token: 0.00003,
      },
      "openai/gpt-5.5": {
        litellm_provider: "openai",
        input_cost_per_token: 0.000002,
        output_cost_per_token: 0.000012,
      },
    });

    const cost = computeTokenCost(config, "gpt-5.5", {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });

    expect(cost.priced).toBe(false);
    expect(cost.unpricedReason).toBe("model_ambiguous");
    expect(cost.pricingSnapshot?.matchStrategy).toBe("ambiguous");
    expect(cost.pricingSnapshot?.ambiguousCandidates?.map(item => item.id).sort()).toEqual([
      "azure_ai/gpt-5.5",
      "openai/gpt-5.5",
    ]);
  });

  test("目标保存价格中心条目映射时按条目 ID 精确计价并唯一解析供应商", () => {
    const config = normalizeLiteLLMPricingCatalog({
      "azure_ai/deepseek-v4-flash": {
        litellm_provider: "azure_ai",
        input_cost_per_token: 0.000003,
        output_cost_per_token: 0.000015,
      },
      "deepseek-v4-flash": {
        litellm_provider: "deepseek",
        input_cost_per_token: 0.00000014,
        output_cost_per_token: 0.00000028,
      },
    });
    config.targetModelMappings = {
      "api.deepseek.com": {
        "deepseek-v4-flash": { vendor: "deepseek", priceEntryId: "deepseek-v4-flash" },
      },
    };

    const cost = computeTokenCost(config, "deepseek-v4-flash", {
      inputTokens: 1_000_000,
      outputTokens: 100_000,
    }, { targetId: "api.deepseek.com" });

    expect(cost.priced).toBe(true);
    expect(cost.matchedModel).toBe("deepseek-v4-flash");
    expect(cost.vendor).toBe("deepseek");
    expect(cost.pricingSnapshot?.matchStrategy).toBe("target_model_entry");
    expect(cost.totalCost).toBeCloseTo(0.168, 9);
  });

  test("目标 priceEntryId 命中后仍校验供应商和运行时模型，错误引用不得直接计价", () => {
    const config = normalizePricingConfig({
      version: 2,
      currency: "USD",
      unit: "per_million_tokens",
      models: [{
        id: "shared-entry",
        vendor: "anthropic",
        runtimeModelId: "claude-x",
        patterns: ["claude-x"],
        pricing: {input: 3, output: 4},
      }],
      targetModelMappings: {
        relay: {
          "gpt-x": {vendor: "openai", priceEntryId: "shared-entry"},
        },
      },
    });

    const cost = computeTokenCost(config, "gpt-x", {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    }, {targetId: "relay"});

    expect(cost.priced).toBe(false);
    expect(cost.pricingSnapshot?.matchStrategy).not.toBe("target_model_entry");
  });

  test("映射条目已从价格中心移除时按映射供应商收敛全局歧义候选", () => {
    const config = normalizeLiteLLMPricingCatalog({
      "azure_ai/deepseek-v4-flash": {
        litellm_provider: "azure_ai",
        input_cost_per_token: 0.000003,
        output_cost_per_token: 0.000015,
      },
      "deepseek/deepseek-v4-flash": {
        litellm_provider: "deepseek",
        input_cost_per_token: 0.00000014,
        output_cost_per_token: 0.00000028,
      },
      "fireworks_ai/deepseek-v4-flash": {
        litellm_provider: "fireworks_ai",
        input_cost_per_token: 0.000004,
        output_cost_per_token: 0.00002,
      },
    });
    // 目标保存时映射的条目 ID 已失效，仅剩 vendor 可用于消歧。
    config.targetModelMappings = {
      "api.deepseek.com": {
        "deepseek-v4-flash": { vendor: "deepseek", priceEntryId: "deepseek-v4-flash" },
      },
    };

    const cost = computeTokenCost(config, "deepseek-v4-flash", {
      inputTokens: 1_000_000,
      outputTokens: 100_000,
    }, { targetId: "api.deepseek.com" });

    expect(cost.priced).toBe(true);
    expect(cost.matchedModel).toBe("deepseek/deepseek-v4-flash");
    expect(cost.vendor).toBe("deepseek");
    // 映射 vendor 先在供应商子集内精确命中，无需走到全局歧义收敛。
    expect(cost.pricingSnapshot?.matchStrategy).toBe("target_model_vendor_exact");
    expect(cost.totalCost).toBeCloseTo(0.168, 9);
  });

  test("applyProxyTargetPricing 从目标 modelVendors 派生价格中心映射", () => {
    const pricing = normalizeLiteLLMPricingCatalog({
      "deepseek-v4-flash": {
        litellm_provider: "deepseek",
        input_cost_per_token: 0.00000014,
        output_cost_per_token: 0.00000028,
      },
    });
    const applied = applyProxyTargetPricing(pricing, {
      version: 2,
      upstreamUrl: "https://api.deepseek.com",
      format: "openai",
      updatedAt: "2026-08-11T00:00:00.000Z",
      targets: [
        {
          id: "api.deepseek.com",
          name: "deepseek",
          upstreamUrl: "https://api.deepseek.com",
          format: "openai",
          enabled: true,
          supportedModels: ["deepseek-v4-flash"],
          pricing: {
            rateMultiplier: 1,
            modelVendors: {
              "deepseek-v4-flash": { vendor: "deepseek", priceEntryId: "deepseek-v4-flash" },
            },
          },
        },
      ],
    });

    expect(applied.targetModelMappings?.["api.deepseek.com"]?.["deepseek-v4-flash"]).toEqual({
      vendor: "deepseek",
      priceEntryId: "deepseek-v4-flash",
    });
    // 目标未显式声明 vendor 时不再自动回填供应商偏好。
    expect(applied.targetVendorPreferences).toBeUndefined();
  });

  test("applyProxyTargetPricing 注入目标级结算系数映射（2026-09-23 方案 B：随价格配置版本化）", () => {
    const pricing = normalizeLiteLLMPricingCatalog({
      "glm-5.3": {
        litellm_provider: "auto-code",
        input_cost_per_token: 0.000005,
        output_cost_per_token: 0.00003,
      },
    });
    const target = (settlementFx?: number) => ({
      id: "auto-code.net",
      name: "auto-code.net",
      enabled: true,
      supportedModels: ["glm-5.3"],
      ...(settlementFx === undefined ? {} : {pricing: {settlementFx}}),
    });
    // 显式系数（1:16 录入存 0.0625）进入映射；非法值与缺省不进入。
    const applied = applyProxyTargetPricing(pricing, {
      version: 2,
      upstreamUrl: "https://auto-code.net",
      format: "openai",
      updatedAt: "2026-09-23T00:00:00.000Z",
      targets: [
        target(0.0625),
        {...target(0), id: "zero-fx"},
        {...target(Number.NaN), id: "nan-fx"},
        target(),
      ] as never[],
    });
    expect(applied.targetSettlementFx).toEqual({"auto-code.net": 0.0625});
    // 全部缺省时映射归一为 undefined（不产生空对象噪音）。
    const withoutFx = applyProxyTargetPricing(pricing, {
      version: 2,
      upstreamUrl: "https://auto-code.net",
      format: "openai",
      updatedAt: "2026-09-23T00:00:00.000Z",
      targets: [target()] as never[],
    });
    expect(withoutFx.targetSettlementFx).toBeUndefined();
  });

  test("LiteLLM 价格表导入为本地每百万 token 目录并保留来源版本", () => {
    const imported = normalizeLiteLLMPricingCatalog({
      "openai/gpt-5.6": {
        litellm_provider: "openai",
        mode: "chat",
        max_input_tokens: 400000,
        input_cost_per_token: 0.000002,
        output_cost_per_token: 0.000012,
        cache_read_input_token_cost: 0.0000002,
        cache_creation_input_token_cost: 0.0000025,
        output_cost_per_reasoning_token: 0.000003,
      },
      "openai/image-only": {
        litellm_provider: "openai",
        mode: "image_generation",
        output_cost_per_image: 0.02,
      },
    }, {
      sourceUrl: "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json",
      fetchedAt: "2026-07-09T00:00:00.000Z",
      sourceHash: "sha256:test",
    });

    expect(imported.catalogSource).toMatchObject({
      type: "litellm",
      hash: "sha256:test",
      modelCount: 1,
    });
    expect(imported.models).toHaveLength(1);
    expect(imported.models[0]).toMatchObject({
      id: "openai/gpt-5.6",
      vendor: "openai",
      mode: "chat",
      contextWindow: 400000,
      confidence: "third_party",
      pricing: {
        input: 2,
        output: 12,
        cachedInput: 0.2,
        cacheWrite: 2.5,
        reasoning: 3,
      },
    });
  });

  test("LiteLLM 自动导入按供应商和运行时模型合并并保留用户修改", () => {
    const current = normalizePricingConfig({
      version: 2,
      currency: "USD",
      unit: "per_million_tokens",
      models: [
        {
          id: "openai/gpt-5.6",
          vendor: "openai",
          mode: "chat",
          match: "openai/gpt-5.6",
          patterns: ["openai/gpt-5.6"],
          pricing: { input: 99, output: 199 },
          currency: "USD",
          confidence: "user_override",
        },
        {
          id: "anthropic/claude-sonnet-4",
          vendor: "anthropic",
          mode: "chat",
          match: "anthropic/claude-sonnet-4",
          patterns: ["anthropic/claude-sonnet-4"],
          pricing: { input: 3, output: 15 },
          currency: "USD",
          confidence: "third_party",
        },
      ],
      targetOverrides: [{
        id: "target:oneapi:multiplier",
        targetId: "oneapi",
        patterns: ["*"],
        rateMultiplier: 0.8,
        confidence: "user_override",
      }],
    });
    const imported = normalizeLiteLLMPricingCatalog({
      "openai/gpt-5.6": {
        litellm_provider: "openai",
        mode: "chat",
        input_cost_per_token: 0.000002,
        output_cost_per_token: 0.000012,
      },
      "anthropic/claude-sonnet-4": {
        litellm_provider: "anthropic",
        mode: "chat",
        input_cost_per_token: 0.000004,
        output_cost_per_token: 0.00002,
      },
      "deepseek/deepseek-v4-pro": {
        litellm_provider: "deepseek",
        mode: "chat",
        input_cost_per_token: 0.000000435,
        output_cost_per_token: 0.00000087,
      },
    }, { fetchedAt: "2026-07-10T00:00:00.000Z", sourceHash: "sha256:new" });

    const merged = mergeLiteLLMPricingConfig(current, imported);

    expect(merged.models.find(item => item.id === "openai/gpt-5.6")?.pricing?.input).toBe(99);
    expect(merged.models.find(item => item.id === "openai/gpt-5.6")?.confidence).toBe("user_override");
    expect(merged.models.find(item => item.id === "anthropic/claude-sonnet-4")?.pricing?.input).toBe(4);
    expect(merged.models.find(item => item.id === "deepseek/deepseek-v4-pro")?.pricing?.output).toBe(0.87);
    expect(merged.targetOverrides).toEqual(current.targetOverrides);
    expect(merged.catalogSource?.hash).toBe("sha256:new");
  });

  test("价格目录查询服务端分页、搜索与分组，不要求 UI 全量加载", () => {
    const config = normalizeLiteLLMPricingCatalog({
      "openai/gpt-5.6": { litellm_provider: "openai", mode: "chat", input_cost_per_token: 0.000002, output_cost_per_token: 0.000012 },
      "deepseek/deepseek-v4-pro": { litellm_provider: "deepseek", mode: "chat", input_cost_per_token: 0.000000435, output_cost_per_token: 0.00000087 },
      "zhipu/glm-5.2": { litellm_provider: "zhipu", mode: "chat", input_cost_per_token: 0.000001, output_cost_per_token: 0.000004 },
    }, { fetchedAt: "2026-07-09T00:00:00.000Z" });

    const page = queryPricingCatalog(config, { search: "gpt", limit: 1, offset: 0 });
    expect(page.total).toBe(1);
    expect(page.items).toHaveLength(1);
    expect(page.items[0].id).toBe("openai/gpt-5.6");
    expect(page.limit).toBe(1);
    expect(page.offset).toBe(0);
    expect(page.facets.vendors).toContain("openai");
    expect(page.facets.modes).toContain("chat");
  });

  test("用户自定义模型使用模型 ID 作为默认匹配规则并参与成本计算", () => {
    const config = normalizePricingConfig({
      ...DEFAULT_PRICING,
      models: [
        ...DEFAULT_PRICING.models,
        {
          id: "custom/gpt-router",
          vendor: "custom-provider",
          mode: "responses",
          pricing: { input: 1.25, cachedInput: 0.25, cacheWrite: 1.5, output: 3.5, reasoning: 2 },
          currency: "USD",
          confidence: "user_override",
        },
      ],
    });

    const page = queryPricingCatalog(config, { search: "custom/gpt-router", limit: 50, offset: 0 });
    const cost = computeTokenCost(config, "custom/gpt-router", {
      inputTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
      cacheCreationTokens: 1_000_000,
      outputTokens: 1_000_000,
      reasoningTokens: 1_000_000,
    });

    expect(page.items.map(item => item.id)).toContain("custom/gpt-router");
    expect(page.items.find(item => item.id === "custom/gpt-router")?.patterns).toEqual(["custom/gpt-router"]);
    expect(cost.priced).toBe(true);
    expect(cost.matchedModel).toBe("custom/gpt-router");
    // reasoning 是 output 子集（主流供应商语义）：output 1M 全部为 reasoning，
    // 按 output 拆分后 output 段为 0，费用 = 1.25 + 0.25 + 1.5 + 0 + 2 = 5.0。
    expect(cost.totalCost).toBeCloseTo(5.0, 9);
    expect(cost.pricingSnapshot?.baseRates).toEqual({
      input: 1.25,
      cachedInput: 0.25,
      cacheWrite: 1.5,
      output: 3.5,
      reasoning: 2,
    });
  });

  test("Anthropic 5m 与 1h 缓存写入按各自价格独立计费", () => {
    const config = normalizePricingConfig({
      ...DEFAULT_PRICING,
      models: [
        ...DEFAULT_PRICING.models,
        {
          id: "anthropic/claude-ttl",
          vendor: "anthropic",
          mode: "messages",
          pricing: {
            input: 10,
            output: 20,
            cachedInput: 0.25,
            cacheWrite5m: 12.5,
            cacheWrite1h: 20,
          },
          currency: "USD",
          confidence: "provider_docs",
        },
      ],
    });
    const cost = computeTokenCost(config, "anthropic/claude-ttl", {
      inputTokens: 0,
      cacheCreation5mTokens: 1_000_000,
      cacheCreation1hTokens: 1_000_000,
      outputTokens: 0,
    });

    expect(cost.priced).toBe(true);
    expect(cost.cacheCreation5mCost).toBeCloseTo(12.5, 9);
    expect(cost.cacheCreation1hCost).toBeCloseTo(20, 9);
    expect(cost.cacheCreationCost).toBeCloseTo(32.5, 9);
    expect(cost.totalCost).toBeCloseTo(32.5, 9);
  });

  test("reasoning 单价与 output 相同时拆分等价于整段 output 计价", () => {
    const config = normalizePricingConfig({
      ...DEFAULT_PRICING,
      models: [
        ...DEFAULT_PRICING.models,
        {
          id: "gemini/gemini-x",
          vendor: "gemini",
          mode: "chat",
          pricing: { input: 0.3, output: 2.5, reasoning: 2.5 },
          currency: "USD",
          confidence: "provider_docs",
        },
      ],
    });
    const cost = computeTokenCost(config, "gemini/gemini-x", {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      reasoningTokens: 300_000,
    });
    expect(cost.priced).toBe(true);
    // 拆分：(1M - 0.3M) * 2.5 + 0.3M * 2.5 = 2.5 = 1M * 2.5，与不拆分一致。
    expect(cost.totalCost).toBeCloseTo(2.8, 9);
    expect(cost.outputCost).toBeCloseTo(1.75, 9);
    expect(cost.reasoningCost).toBeCloseTo(0.75, 9);
  });

  test("无 reasoning 单价时 reasoning 不单独计费（已含在 output 价内）", () => {
    const config = normalizePricingConfig({
      ...DEFAULT_PRICING,
      models: [
        ...DEFAULT_PRICING.models,
        {
          id: "deepseek/deepseek-x",
          vendor: "deepseek",
          mode: "chat",
          pricing: { input: 0.2, output: 1.0 },
          currency: "USD",
          confidence: "official",
        },
      ],
    });
    const cost = computeTokenCost(config, "deepseek/deepseek-x", {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      reasoningTokens: 300_000,
    });
    expect(cost.priced).toBe(true);
    expect(cost.totalCost).toBeCloseTo(1.2, 9);
    expect(cost.reasoningCost).toBeUndefined();
  });

  test("reasoning 超过 output 时 output 段不为负数", () => {
    const config = normalizePricingConfig({
      ...DEFAULT_PRICING,
      models: [
        ...DEFAULT_PRICING.models,
        {
          id: "custom/odd-usage",
          vendor: "custom",
          mode: "chat",
          pricing: { input: 1, output: 2, reasoning: 3 },
          currency: "USD",
          confidence: "user_override",
        },
      ],
    });
    const cost = computeTokenCost(config, "custom/odd-usage", {
      outputTokens: 100,
      reasoningTokens: 500,
    });
    expect(cost.priced).toBe(true);
    expect(cost.outputCost).toBe(0);
    expect(cost.reasoningCost).toBeCloseTo(0.0015, 9);
    expect(cost.totalCost).toBeGreaterThanOrEqual(0);
  });

  test("价格供应商查询只返回供应商列表和来源信息", () => {
    const config = normalizeLiteLLMPricingCatalog({
      "openai/gpt-5.6": { litellm_provider: "openai", mode: "chat", input_cost_per_token: 0.000002, output_cost_per_token: 0.000012 },
      "deepseek/deepseek-v4-pro": { litellm_provider: "deepseek", mode: "chat", input_cost_per_token: 0.000000435, output_cost_per_token: 0.00000087 },
      "zai/glm-5.2": { litellm_provider: "zai", mode: "chat", input_cost_per_token: 0.000001, output_cost_per_token: 0.000004 },
    }, { fetchedAt: "2026-07-09T00:00:00.000Z" });

    const vendors = queryPricingVendors(config);
    expect(vendors.vendors).toEqual(["deepseek", "openai", "zai"]);
    expect(vendors.catalogSource?.type).toBe("litellm");
    expect(JSON.stringify(vendors)).not.toContain("gpt-5.6");
  });

  test("价格输入草稿保留小数点中间态并在保存前转为数字", () => {
    expect(isDecimalDraft("0.")).toBe(true);
    expect(isDecimalDraft(".8")).toBe(true);
    expect(isDecimalDraft("0.8")).toBe(true);
    expect(isDecimalDraft("1.25")).toBe(true);
    expect(isDecimalDraft("1..25")).toBe(false);
    expect(isDecimalDraft("abc")).toBe(false);

    const result = priceDraftsToPricing({
      ...emptyPriceDrafts(),
      input: "0.",
      cachedInput: ".8",
      cacheWrite: "0.25",
      output: "1.2",
      reasoning: "",
    });

    expect(result).toEqual({
      pricing: {
        input: 0,
        cachedInput: 0.8,
        cacheWrite: 0.25,
        output: 1.2,
        reasoning: undefined,
      },
    });
  });

  test("峰谷模型草稿同时保存高峰与闲时费率，闲时只填一半不覆盖时段窗口", () => {
    const schedules = [{
      timezone: "Asia/Shanghai",
      label: "闲时",
      windows: [{days: [5, 6] as number[], start: "00:00", end: "24:00"}],
      rates: {input: 0.22, output: 0.66, cachedInput: 0.007},
    }];
    const withOffPeak = priceDraftsToPricing({
      ...emptyPriceDrafts(),
      input: "0.44",
      output: "1.32",
      offPeakInput: ".22",
      offPeakOutput: "0.66",
      offPeakCachedInput: "0.007",
    }, schedules);
    expect(withOffPeak?.pricing).toEqual({input: 0.44, output: 1.32});
    expect(withOffPeak?.priceSchedules?.[0]).toMatchObject({
      label: "闲时",
      rates: {input: 0.22, output: 0.66, cachedInput: 0.007},
    });

    // 闲时 input/output 缺一即视为未编辑，保留原时段费率。
    const partial = priceDraftsToPricing({
      ...emptyPriceDrafts(),
      input: "0.44",
      output: "1.32",
      offPeakInput: ".22",
    }, schedules);
    expect(partial?.priceSchedules).toBeUndefined();
  });

  test("readEffectivePricingConfig 合并代理目标模型级覆盖价", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "pricing-effective-"));
    await writePricingConfig(dataDir, DEFAULT_PRICING);
    await writeFile(join(dataDir, "proxy-config.json"), JSON.stringify({
      version: 2,
      defaultTargetId: "1yuanapi.com",
      localProxyBaseUrl: "http://localhost:3211",
      upstreamUrl: "https://1yuanapi.com/v1",
      format: "openai",
      updatedAt: "2026-07-09T00:00:00.000Z",
      targets: [{
        id: "1yuanapi.com",
        name: "一元 API",
        upstreamUrl: "https://1yuanapi.com/v1",
        format: "openai",
        enabled: true,
        pricing: {
          modelOverrides: [{
            id: "one-yuan-deepseek-flash",
            targetModelId: "deepseek-v4-flash",
            pricing: { input: 0.01, output: 0.02, cachedInput: 0.001 },
            confidence: "user_override",
          }],
        },
      }],
    }));

    const config = await readEffectivePricingConfig(dataDir);
    // 目标倍率概念已移除：价格中心条目按原价计
    const baseCost = computeTokenCost(config, "deepseek-v4-pro", {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    }, { targetId: "1yuanapi.com" });
    const overrideCost = computeTokenCost(config, "deepseek-v4-flash", {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    }, { targetId: "1yuanapi.com" });

    expect(baseCost.totalCost).toBeCloseTo(0.435 + 0.87, 9);
    expect(overrideCost.totalCost).toBeCloseTo(0.03, 9);
    expect(overrideCost.overrideId).toBe("one-yuan-deepseek-flash");
  });

  test("代理目标模型覆盖价优先于价格中心", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "pricing-target-model-override-"));
    await writePricingConfig(dataDir, normalizeLiteLLMPricingCatalog({
      "openai/gpt-5.5": {
        litellm_provider: "openai",
        input_cost_per_token: 0.000002,
        output_cost_per_token: 0.000012,
        cache_read_input_token_cost: 0.0000002,
      },
    }));
    await writeFile(join(dataDir, "proxy-config.json"), JSON.stringify({
      version: 2,
      defaultTargetId: "oneapi",
      localProxyBaseUrl: "http://localhost:3211",
      upstreamUrl: "https://oneapi.example/v1",
      format: "openai",
      updatedAt: "2026-07-09T00:00:00.000Z",
      targets: [{
        id: "oneapi",
        name: "One API",
        upstreamUrl: "https://oneapi.example/v1",
        format: "openai",
        enabled: true,
        pricing: {
          vendor: "openai",
          modelOverrides: [{
            id: "oneapi-openai-gpt-5.5",
            targetModelId: "openai/gpt-5.5",
            pricing: { input: 5, cachedInput: 1, cacheWrite: 6, output: 20, reasoning: 2 },
            confidence: "user_override",
          }],
        },
      }],
    }));

    const config = await readEffectivePricingConfig(dataDir);
    const cost = computeTokenCost(config, "gpt-5.5", {
      inputTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
      cacheCreationTokens: 1_000_000,
      outputTokens: 1_000_000,
      reasoningTokens: 1_000_000,
    }, { targetId: "oneapi" });

    expect(cost.priced).toBe(true);
    expect(cost.overrideId).toBe("oneapi-openai-gpt-5.5");
    expect(cost.officialTotalCost).toBeCloseTo(14.2, 9);
    // reasoning 是 output 子集：output 1M 全部为 reasoning，按拆分后 output 段为 0。
    expect(cost.totalCost).toBeCloseTo(5 + 1 + 6 + 2, 9);
    expect(cost.pricingSnapshot).toMatchObject({
      matchedModel: "openai/gpt-5.5",
      matchStrategy: "target_override",
      rateMultiplier: 1,
      baseRates: { input: 5, cachedInput: 1, cacheWrite: 6, output: 20, reasoning: 2 },
    });
    expect(cost.pricingSnapshot?.effectiveRates?.input).toBeCloseTo(5, 9);
    expect(cost.pricingSnapshot?.effectiveRates?.cachedInput).toBeCloseTo(1, 9);
    expect(cost.pricingSnapshot?.effectiveRates?.cacheWrite).toBeCloseTo(6, 9);
    expect(cost.pricingSnapshot?.effectiveRates?.output).toBeCloseTo(20, 9);
    expect(cost.pricingSnapshot?.effectiveRates?.reasoning).toBeCloseTo(2, 9);
  });
});

describe("时段费率窗口匹配", () => {
  const schedule = {
    timezone: "Asia/Shanghai",
    label: "闲时",
    windows: [
      { days: [5, 6], start: "00:00", end: "24:00" },
      { days: [1, 2, 3, 4, 5], start: "00:00", end: "09:00" },
      { days: [1, 2, 3, 4, 5], start: "12:00", end: "14:00" },
      { days: [1, 2, 3, 4, 5], start: "18:00", end: "24:00" },
    ],
    rates: { input: 0.22, output: 0.66, cachedInput: 0.007 },
  };

  test("工作日 10:00 命中高峰（无窗口匹配，返回高峰标签）", () => {
    const resolved = resolveTemporalPricing(
      {
        pricing: { input: 0.44, output: 1.32, cachedInput: 0.014 },
        priceSchedules: [schedule],
      },
      "2026-08-20T10:00:00+08:00",
    );
    expect(resolved?.label).toBe("高峰");
    expect(resolved?.rates.input).toBe(0.44);
  });

  test("工作日 13:00 命中闲时窗口", () => {
    const resolved = resolveTemporalPricing(
      {
        pricing: { input: 0.44, output: 1.32, cachedInput: 0.014 },
        priceSchedules: [schedule],
      },
      "2026-08-20T13:00:00+08:00",
    );
    expect(resolved?.label).toBe("闲时");
    expect(resolved?.rates.input).toBe(0.22);
  });

  test("没有 capturedAt 时不匹配", () => {
    expect(resolveTemporalPricing(
      { pricing: { input: 0.44, output: 1.32 }, priceSchedules: [schedule] },
      undefined,
    )).toBeUndefined();
  });

  test("没有 priceSchedules 时不匹配", () => {
    expect(resolveTemporalPricing(
      { pricing: { input: 0.44, output: 1.32 } },
      "2026-08-20T13:00:00+08:00",
    )).toBeUndefined();
  });

  test("isWithinTimeWindows 支持 24:00 结束与缺省 days", () => {
    expect(isWithinTimeWindows(
      [{ start: "00:00", end: "24:00" }],
      new Date("2026-08-20T23:59:00+08:00"),
      "Asia/Shanghai",
    )).toBe(true);
  });

  test("节假日日期按闲时费率计费，即使落在高峰窗口", () => {
    const resolved = resolveTemporalPricing(
      {
        pricing: { input: 0.44, output: 1.32, cachedInput: 0.014 },
        priceSchedules: [{
          ...schedule,
          holidays: ["2026-10-01"],
        }],
      },
      "2026-10-01T10:00:00+08:00",
    );
    expect(resolved?.label).toBe("闲时");
    expect(resolved?.rates.input).toBe(0.22);
  });

  test("非节假日的同一时刻仍按高峰计费", () => {
    const resolved = resolveTemporalPricing(
      {
        pricing: { input: 0.44, output: 1.32, cachedInput: 0.014 },
        priceSchedules: [{
          ...schedule,
          holidays: ["2026-10-01"],
        }],
      },
      "2026-10-08T10:00:00+08:00",
    );
    expect(resolved?.label).toBe("高峰");
    expect(resolved?.rates.input).toBe(0.44);
  });

  test("价格中心浅校验保留节假日字段", () => {
    const normalized = normalizePricingConfig({
      version: 2,
      currency: "USD",
      models: [{
        id: "deepseek-v4-flash",
        vendor: "deepseek",
        patterns: ["deepseek-v4-flash"],
        pricing: {input: 0.44, output: 1.32},
        priceSchedules: [{
          label: "闲时",
          windows: [{start: "00:00", end: "24:00"}],
          rates: {input: 0.22, output: 0.66},
          holidays: ["2026-10-01", "2026-10-02"],
        }],
      }],
    });
    expect(normalized.models[0]?.priceSchedules?.[0].holidays).toEqual(["2026-10-01", "2026-10-02"]);
  });
});

describe("computeTokenCost 时段费率", () => {
  const config = {
    version: 2 as const,
    currency: "USD",
    models: [{
      id: "catalog:deepseek:deepseek-v4-flash",
      vendor: "deepseek",
      patterns: ["deepseek-v4-flash"],
      pricing: {input: 0.44, output: 1.32, cachedInput: 0.014},
      priceSchedules: [{
        timezone: "Asia/Shanghai",
        label: "闲时",
        windows: [{days: [1, 2, 3, 4, 5], start: "12:00", end: "14:00"}],
        rates: {input: 0.22, output: 0.66, cachedInput: 0.007},
      }],
      confidence: "official" as const,
    }],
  };

  test("闲时请求使用闲时费率并写入快照标签", () => {
    const cost = computeTokenCost(
      config,
      "deepseek-v4-flash",
      {inputTokens: 1_000_000, outputTokens: 0},
      {capturedAt: "2026-08-20T13:00:00+08:00"},
    );
    expect(cost.totalCost).toBeCloseTo(0.22);
    expect(cost.pricingSnapshot?.scheduleLabel).toBe("闲时");
    expect(cost.pricingSnapshot?.timezone).toBe("Asia/Shanghai");
    expect(cost.pricingSnapshot?.baseRates?.input).toBe(0.22);
  });

  test("高峰请求使用基础价并标记高峰", () => {
    const cost = computeTokenCost(
      config,
      "deepseek-v4-flash",
      {inputTokens: 1_000_000, outputTokens: 0},
      {capturedAt: "2026-08-20T10:00:00+08:00"},
    );
    expect(cost.totalCost).toBeCloseTo(0.44);
    expect(cost.pricingSnapshot?.scheduleLabel).toBe("高峰");
  });

  test("无 schedule 的模型快照不带 scheduleLabel", () => {
    const cost = computeTokenCost(
      {version: 2 as const, currency: "USD", models: []},
      "some-model",
      {inputTokens: 100},
      {capturedAt: "2026-08-20T10:00:00+08:00"},
    );
    expect(cost.pricingSnapshot?.scheduleLabel).toBeUndefined();
  });
});

describe("computeTokenCost 目标计费覆盖峰谷", () => {
  const config = {
    version: 2 as const,
    currency: "USD",
    models: [{
      id: "catalog:deepseek:deepseek-v4-flash",
      vendor: "deepseek",
      patterns: ["deepseek-v4-flash"],
      pricing: {input: 0.44, output: 1.32, cachedInput: 0.014},
      priceSchedules: [{
        timezone: "Asia/Shanghai",
        label: "闲时",
        windows: [{days: [1, 2, 3, 4, 5], start: "12:00", end: "14:00"}],
        rates: {input: 0.22, output: 0.66, cachedInput: 0.007},
      }],
      confidence: "official" as const,
    }],
    targetOverrides: [{
      id: "override-deepseek-flash",
      targetId: "deepseek",
      patterns: ["deepseek-v4-flash"],
      pricing: {input: 0.88, output: 2.64, cachedInput: 0.028},
      priceSchedules: [{
        timezone: "Asia/Shanghai",
        label: "闲时",
        windows: [{days: [1, 2, 3, 4, 5], start: "12:00", end: "14:00"}],
        rates: {input: 0.33, output: 0.99, cachedInput: 0.0105},
      }],
      confidence: "user_override" as const,
    }],
  };

  test("带峰谷覆盖的请求在闲时使用闲时覆盖费率并保留标签", () => {
    const cost = computeTokenCost(
      config,
      "deepseek-v4-flash",
      {inputTokens: 1_000_000, outputTokens: 0},
      {targetId: "deepseek", capturedAt: "2026-08-20T13:00:00+08:00"},
    );
    expect(cost.totalCost).toBeCloseTo(0.33, 9);
    expect(cost.overrideId).toBe("override-deepseek-flash");
    expect(cost.pricingSnapshot?.scheduleLabel).toBe("闲时");
    expect(cost.pricingSnapshot?.baseRates?.input).toBe(0.33);
    expect(cost.pricingSnapshot?.matchStrategy).toBe("target_override");
  });

  test("带峰谷覆盖的请求在高峰使用覆盖基础价并标记高峰", () => {
    const cost = computeTokenCost(
      config,
      "deepseek-v4-flash",
      {inputTokens: 1_000_000, outputTokens: 0},
      {targetId: "deepseek", capturedAt: "2026-08-20T10:00:00+08:00"},
    );
    expect(cost.totalCost).toBeCloseTo(0.88, 9);
    expect(cost.pricingSnapshot?.scheduleLabel).toBe("高峰");
    expect(cost.pricingSnapshot?.baseRates?.input).toBe(0.88);
  });

  test("覆盖未带 priceSchedules 时保持固定覆盖价，不解析时段", () => {
    const fixedOverride = {
      ...config,
      targetOverrides: [{
        id: "fixed-override",
        targetId: "deepseek",
        patterns: ["deepseek-v4-flash"],
        pricing: {input: 0.5, output: 1, cachedInput: 0.01},
        confidence: "user_override" as const,
      }],
    };
    const cost = computeTokenCost(
      fixedOverride,
      "deepseek-v4-flash",
      {inputTokens: 1_000_000, outputTokens: 0},
      {targetId: "deepseek", capturedAt: "2026-08-20T13:00:00+08:00"},
    );
    expect(cost.totalCost).toBeCloseTo(0.5, 9);
    expect(cost.pricingSnapshot?.scheduleLabel).toBeUndefined();
  });
});

describe("长上下文阶梯计价（272K 分界，input×2 / output×1.5）", () => {
  const tieredPricing = normalizePricingConfig({
    version: 2,
    currency: "USD",
    unit: "per_million_tokens",
    models: [{
      id: "tier:gpt-5.6-sol",
      vendor: "OpenAI",
      runtimeModelId: "gpt-5.6-sol",
      patterns: ["gpt-5.6-sol"],
      aliases: [],
      pricing: {
        input: 5,
        output: 30,
        cachedInput: 0.5,
        longContext: {thresholdTokens: 272000, inputMultiplier: 2, outputMultiplier: 1.5},
      },
      confidence: "official",
      sourceUrl: "https://example.com",
    }],
  });

  test("判定量=净输入+缓存读+缓存写，严格大于阈值才换档；缓存跟随输入倍率", () => {
    // 恰好等于阈值：不换档（严格大于才命中）
    const atThreshold = computeTokenCost(tieredPricing, "gpt-5.6-sol", {
      inputTokens: 272000, cacheReadTokens: 0, cacheCreationTokens: 0, outputTokens: 1000,
    });
    expect(atThreshold.totalCost).toBeCloseTo(272000 * 5 / 1e6 + 1000 * 30 / 1e6, 9);
    expect(atThreshold.pricingSnapshot?.longContext).toBeUndefined();

    // 超过阈值（缓存读计入判定量，输出不计）：input×2、cacheRead×2、output×1.5
    const above = computeTokenCost(tieredPricing, "gpt-5.6-sol", {
      inputTokens: 250000, cacheReadTokens: 30000, cacheCreationTokens: 0, outputTokens: 1000,
    });
    expect(above.totalCost).toBeCloseTo(
      250000 * 10 / 1e6 + 30000 * 1 / 1e6 + 1000 * 45 / 1e6, 9);
    expect(above.pricingSnapshot?.longContext).toMatchObject({
      thresholdTokens: 272000, contextTokens: 280000, inputMultiplier: 2, outputMultiplier: 1.5,
    });
    expect(above.formula).toContain("long-context>272000 x2/x1.5");
  });

  test("分组倍率与档位乘数叠加；官方成本（vendor_cost）同样套用档位", () => {
    const cost = computeTokenCost(tieredPricing, "gpt-5.6-sol", {
      inputTokens: 300000, cacheReadTokens: 0, cacheCreationTokens: 0, outputTokens: 1000,
    }, {targetId: "t", rateMultiplierOverride: 0.25});
    // 官方价：300000×(5×2)/1M + 1000×(30×1.5)/1M
    expect(cost.officialTotalCost).toBeCloseTo(300000 * 10 / 1e6 + 1000 * 45 / 1e6, 9);
    // 实际成本 = 官方 ×0.25（密钥倍率）
    expect(cost.totalCost).toBeCloseTo((300000 * 10 / 1e6 + 1000 * 45 / 1e6) * 0.25, 9);
  });

  test("存量 relay_synced 覆盖不再参与计价（链路已移除），user_override 仍生效", () => {
    const config = applyProxyTargetPricing(tieredPricing, {
      version: 3, revision: 1, agentConnections: {}, targets: [{
        id: "t",
        name: "t",
        enabled: true,
        supportedModels: ["gpt-5.6-sol", "gpt-5.6-terra"],
        pricing: {
          rateMultiplier: 1,
          modelVendors: {
            "gpt-5.6-sol": {vendor: "OpenAI", priceEntryId: "tier:gpt-5.6-sol"},
            "gpt-5.6-terra": {vendor: "OpenAI", priceEntryId: "tier:gpt-5.6-terra"},
          },
          modelOverrides: [
            {
              id: "relay-t-gpt",
              targetModelId: "gpt-5.6-sol",
              pricing: {input: 2.5, output: 15, longContext: {thresholdTokens: 272000, inputMultiplier: 2, outputMultiplier: 1.5}},
              confidence: "relay_synced",
            },
            {
              id: "manual-t-terra",
              targetModelId: "gpt-5.6-terra",
              pricing: {input: 1, output: 5},
              confidence: "user_override",
            },
          ],
        },
        createdAt: "2026-09-01T00:00:00.000Z",
      }],
      localProxyBaseUrl: "http://localhost:3211",
      updatedAt: "2026-09-01T00:00:00.000Z",
    } as never);
    // relay_synced：不计覆盖价（回到官方阶梯价），overrideId 不落快照。
    const relayCost = computeTokenCost(config, "gpt-5.6-sol", {
      inputTokens: 300000, cacheReadTokens: 0, cacheCreationTokens: 0, outputTokens: 1000,
    }, {targetId: "t"});
    expect(relayCost.pricingSnapshot?.overrideId).toBeUndefined();
    expect(relayCost.totalCost).toBeCloseTo(300000 * 10 / 1e6 + 1000 * 45 / 1e6, 9);
    // user_override：继续压制官方价。
    const manualCost = computeTokenCost(config, "gpt-5.6-terra", {
      inputTokens: 1000, cacheReadTokens: 0, cacheCreationTokens: 0, outputTokens: 1000,
    }, {targetId: "t"});
    expect(manualCost.pricingSnapshot?.overrideId).toBe("manual-t-terra");
    expect(manualCost.totalCost).toBeCloseTo(1000 * 1 / 1e6 + 1000 * 5 / 1e6, 9);
  });
});

describe("fast 档倍率计价（2026-10-07 倍率制：作用于各通道实际命中的标准价）", () => {
  const pricing = normalizePricingConfig({
    version: 2, currency: "USD", unit: "per_million_tokens",
    models: [{
      id: "tier:fast", vendor: "OpenAI", runtimeModelId: "gpt-x", patterns: ["gpt-x"],
      pricing: {
        input: 5, output: 30, cachedInput: 0.5, cacheWrite: 7.5,
        longContext: {thresholdTokens: 272000, inputMultiplier: 2, outputMultiplier: 1.5},
      },
      serviceTierPricing: {fastMultiplier: 2},
      confidence: "official",
    }],
  });
  const capturedAt = "2026-09-01T00:00:00Z";

  test("service_tier=fast 全字段按倍率计价并写快照", () => {
    // 输入侧合计 270K（90K×3，≤272K 保持短上下文口径；1M 会触发长上下文档位）。
    const usage = {inputTokens: 90_000, cacheReadTokens: 90_000, cacheCreationTokens: 90_000, outputTokens: 1_000_000};
    const base = computeTokenCost(pricing, "gpt-x", usage, {capturedAt});
    expect(base.totalCost).toBeCloseTo(0.09 * 5 + 0.09 * 0.5 + 0.09 * 7.5 + 30, 9);
    const fast = computeTokenCost(pricing, "gpt-x", {...usage, serviceTier: "fast"}, {capturedAt});
    // 全字段 ×2（含 cacheWrite——倍率制无「未声明回落」语义，各通道自动取正确基数）。
    expect(fast.totalCost).toBeCloseTo(0.09 * 10 + 0.09 * 1 + 0.09 * 15 + 60, 9);
    expect(fast.pricingSnapshot?.serviceTier).toBe("fast");
    expect(fast.pricingSnapshot?.baseRates?.input).toBe(10);
    expect(fast.pricingSnapshot?.baseRates?.cachedInput).toBe(1);
    expect(fast.pricingSnapshot?.baseRates?.cacheWrite).toBe(15);
  });

  test("priority 请求参数同映射 fast 倍率；flex 本期不参与档位计价", () => {
    const usage = {inputTokens: 100_000, outputTokens: 100_000};
    const priority = computeTokenCost(pricing, "gpt-x", {...usage, serviceTier: "priority"}, {capturedAt});
    expect(priority.totalCost).toBeCloseTo(0.1 * 10 + 0.1 * 60, 9);
    const flex = computeTokenCost(pricing, "gpt-x", {...usage, serviceTier: "flex"}, {capturedAt});
    expect(flex.totalCost).toBeCloseTo(0.1 * 5 + 0.1 * 30, 9);
    expect(flex.pricingSnapshot?.serviceTier).toBeUndefined();
  });

  test("fast × 长上下文档位叠加：输入侧 ×2×2、输出 ×2×1.5", () => {
    const fast = computeTokenCost(pricing, "gpt-x", {
      inputTokens: 300_000, outputTokens: 1_000_000, serviceTier: "fast",
    }, {capturedAt});
    expect(fast.totalCost).toBeCloseTo(300_000 * 20 / 1e6 + 90, 9);
    expect(fast.pricingSnapshot?.longContext?.contextTokens).toBe(300_000);
  });

  test("通道正确性（2026-10-07 倍率制核心目标）：官方促销通道 fast=2×促销价；中转站 fast=2×牌价", () => {
    const config = normalizePricingConfig({
      version: 2, currency: "USD", unit: "per_million_tokens",
      models: [{
        id: "promo:gpt-x", vendor: "OpenAI", runtimeModelId: "gpt-x", patterns: ["gpt-x"],
        pricing: {input: 5, output: 30, cachedInput: 0.5, cacheWrite: 6.25},
        serviceTierPricing: {fastMultiplier: 2},
        promotions: [{from: "2026-07-01T00:00:00Z", to: "2026-11-21T00:00:00Z", priceOverride: {input: 4, output: 20, cachedInput: 0.4, cacheWrite: 5}}],
        confidence: "official",
      }],
    });
    const usage = {inputTokens: 1_000_000, outputTokens: 1_000_000, serviceTier: "fast"};
    const official = computeTokenCost(config, "gpt-x", usage, {capturedAt: "2026-10-01T00:00:00Z", officialPresetVendor: "OpenAI"});
    expect(official.totalCost).toBeCloseTo(8 + 40, 9);
    const relay = computeTokenCost(config, "gpt-x", usage, {capturedAt: "2026-10-01T00:00:00Z", targetId: "t-relay"});
    expect(relay.totalCost).toBeCloseTo(10 + 60, 9);
    expect(relay.pricingSnapshot?.promotionLabel).toBeUndefined();
  });

  test(">272K + fast 组合（gpt-5.6-sol 实价锚）：官方 促销×2×长档=16/60；中转 牌价×2×长档=20/90", () => {
    const make = normalizePricingConfig({
      version: 2, currency: "USD", unit: "per_million_tokens",
      models: [{
        id: "gpt-5.6-sol", vendor: "openai", runtimeModelId: "gpt-5.6-sol", patterns: ["gpt-5.6-sol"],
        pricing: {
          input: 5, output: 30, cachedInput: 0.5, cacheWrite: 6.25,
          longContext: {thresholdTokens: 272000, inputMultiplier: 2, outputMultiplier: 1.5},
        },
        serviceTierPricing: {fastMultiplier: 2},
        promotions: [{from: "2026-08-21T00:00:00Z", to: "2026-11-21T00:00:00Z", priceOverride: {input: 4, output: 20, cachedInput: 0.4, cacheWrite: 5}}],
        confidence: "official",
      }],
    });
    const usage = {inputTokens: 300_000, cacheReadTokens: 0, cacheCreationTokens: 0, outputTokens: 100_000, serviceTier: "fast"};
    // 官方：促销 4/20 → fast×2 = 8/40 → 长档 ×2/×1.5 = 16/60。
    const official = computeTokenCost(make, "gpt-5.6-sol", usage, {capturedAt: "2026-10-01T00:00:00Z", officialPresetVendor: "openai"});
    expect(official.totalCost).toBeCloseTo(300_000 * 16 / 1e6 + 100_000 * 60 / 1e6, 9);
    // 中转：牌价 5/30 → fast×2 = 10/60 → 长档 ×2/×1.5 = 20/90。
    const relay = computeTokenCost(make, "gpt-5.6-sol", usage, {capturedAt: "2026-10-01T00:00:00Z", targetId: "catapi"});
    expect(relay.totalCost).toBeCloseTo(300_000 * 20 / 1e6 + 100_000 * 90 / 1e6, 9);
    expect(relay.pricingSnapshot?.promotionLabel).toBeUndefined();
  });

  test("未配置 fastMultiplier 的模型携带 service_tier 不改价、不写档位快照", () => {
    const plain = normalizePricingConfig({
      version: 2, currency: "USD", unit: "per_million_tokens",
      models: [{
        id: "m", vendor: "OpenAI", runtimeModelId: "m", patterns: ["m"],
        pricing: {input: 5, output: 30}, confidence: "official",
      }],
    });
    const usage = {inputTokens: 1000, outputTokens: 100};
    const plainCost = computeTokenCost(plain, "m", usage, {capturedAt});
    const fastCost = computeTokenCost(plain, "m", {...usage, serviceTier: "fast"}, {capturedAt});
    expect(fastCost.totalCost).toBeCloseTo(plainCost.totalCost!, 9);
    expect(fastCost.pricingSnapshot?.serviceTier).toBeUndefined();
  });

  test("长上下文绝对价（rates）优先于倍率：声明字段不再乘倍率", () => {
    const absolute = normalizePricingConfig({
      version: 2, currency: "USD", unit: "per_million_tokens",
      models: [{
        id: "m", vendor: "OpenAI", runtimeModelId: "m", patterns: ["m"],
        pricing: {
          input: 5, output: 30,
          longContext: {thresholdTokens: 272000, inputMultiplier: 2, outputMultiplier: 1.5, rates: {input: 10}},
        },
        confidence: "official",
      }],
    });
    const cost = computeTokenCost(absolute, "m", {inputTokens: 300_000, outputTokens: 1_000_000}, {capturedAt});
    // input 用绝对价 10（不乘 2），输出仍按倍率 30×1.5。
    expect(cost.totalCost).toBeCloseTo(300_000 * 10 / 1e6 + 45, 9);
  });
});

describe("按量促销计价（promotions 时间窗 + agent 限定 + 官方通道）", () => {
  const capturedAt = "2026-08-15T00:00:00Z";
  const usage = {inputTokens: 1_000_000, outputTokens: 1_000_000};

  function promoPricingConfig(options: {
    promotions?: Array<Record<string, unknown>>;
    pricing?: Record<string, unknown>;
    priceSchedules?: Array<Record<string, unknown>>;
  } = {}) {
    return normalizePricingConfig({
      version: 2, currency: "USD", unit: "per_million_tokens",
      models: [{
        id: "promo:gpt-x", vendor: "OpenAI", runtimeModelId: "gpt-x", patterns: ["gpt-x"],
        pricing: (options.pricing as never) ?? {input: 5, output: 30, cachedInput: 0.5, cacheWrite: 7.5},
        ...(options.promotions ? {promotions: options.promotions} : {}),
        ...(options.priceSchedules ? {priceSchedules: options.priceSchedules} : {}),
        confidence: "official",
      }],
    });
  }

  test("官方通道促销命中：按实扣价计费并写 promotionLabel 快照", () => {
    const config = promoPricingConfig({promotions: [{
      from: "2026-07-01T00:00:00Z", to: "2026-12-31T23:59:59Z", label: "官方限时 2/3 价",
      priceOverride: {input: 4, output: 20, cachedInput: 0.4, cacheWrite: 5},
    }]});
    const cost = computeTokenCost(config, "gpt-x", usage, {capturedAt, officialPresetVendor: "OpenAI"});
    expect(cost.totalCost).toBeCloseTo(4 + 20, 9);
    expect(cost.officialTotalCost).toBeCloseTo(4 + 20, 9);
    expect(cost.pricingSnapshot?.promotionLabel).toBe("官方限时 2/3 价");
    expect(cost.pricingSnapshot?.baseRates?.input).toBe(4);
  });

  test("未到 from / 超过 to 不命中（按牌价）；to 缺省=无限期", () => {
    const before = promoPricingConfig({promotions: [{from: "2026-09-01T00:00:00Z", priceOverride: {input: 4}}]});
    expect(computeTokenCost(before, "gpt-x", usage, {capturedAt, officialPresetVendor: "OpenAI"}).totalCost).toBeCloseTo(35, 9);
    const expired = promoPricingConfig({promotions: [{from: "2026-07-01T00:00:00Z", to: "2026-08-01T00:00:00Z", priceOverride: {input: 4}}]});
    expect(computeTokenCost(expired, "gpt-x", usage, {capturedAt, officialPresetVendor: "OpenAI"}).totalCost).toBeCloseTo(35, 9);
    const endless = promoPricingConfig({promotions: [{from: "2026-07-01T00:00:00Z", priceOverride: {input: 4}}]});
    // to 缺省：远期时刻仍命中；priceOverride 稀疏覆盖（output 未声明沿用牌价 30）。
    expect(computeTokenCost(endless, "gpt-x", usage, {capturedAt: "2099-01-01T00:00:00Z", officialPresetVendor: "OpenAI"}).totalCost).toBeCloseTo(34, 9);
  });

  test("agents 限定：非目标 Agent 不享受（按牌价）；目标 Agent 大小写归一后享受", () => {
    const config = promoPricingConfig({promotions: [{
      from: "2026-07-01T00:00:00Z", agents: ["zcode"], priceOverride: {input: 4, output: 20},
    }]});
    const outsider = computeTokenCost(config, "gpt-x", usage, {capturedAt, officialPresetVendor: "OpenAI", agentName: "codex"});
    expect(outsider.totalCost).toBeCloseTo(35, 9);
    expect(outsider.pricingSnapshot?.promotionLabel).toBeUndefined();
    const insider = computeTokenCost(config, "gpt-x", usage, {capturedAt, officialPresetVendor: "OpenAI", agentName: "ZCode"});
    expect(insider.totalCost).toBeCloseTo(24, 9);
  });

  test("中转站（无官方预设标识）不享受促销，始终按牌价", () => {
    const config = promoPricingConfig({promotions: [{from: "2026-07-01T00:00:00Z", priceOverride: {input: 4, output: 20}}]});
    const relay = computeTokenCost(config, "gpt-x", usage, {capturedAt});
    expect(relay.totalCost).toBeCloseTo(35, 9);
    expect(relay.pricingSnapshot?.promotionLabel).toBeUndefined();
  });

  test("multiplier 型促销整单乘（官方成本与实际成本同乘），叠加在长上下文档位之后", () => {
    const config = promoPricingConfig({
      promotions: [{from: "2026-07-01T00:00:00Z", multiplier: 0.5}],
      pricing: {input: 5, output: 30, longContext: {thresholdTokens: 272000, inputMultiplier: 2, outputMultiplier: 1.5}},
    });
    const cost = computeTokenCost(config, "gpt-x", {inputTokens: 300_000, outputTokens: 1_000_000}, {capturedAt, officialPresetVendor: "OpenAI"});
    const tiered = 300_000 * 10 / 1e6 + 45;
    expect(cost.officialTotalCost).toBeCloseTo(tiered * 0.5, 9);
    expect(cost.totalCost).toBeCloseTo(tiered * 0.5, 9);
  });

  test("促销与闲时叠加：促销声明字段覆盖闲时价，未声明字段沿用闲时价", () => {
    const config = promoPricingConfig({
      promotions: [{from: "2026-01-01T00:00:00Z", priceOverride: {input: 1}}],
      priceSchedules: [{
        timezone: "Asia/Shanghai", label: "闲时",
        windows: [{days: [0, 1, 2, 3, 4, 5, 6], start: "00:00", end: "24:00"}],
        rates: {input: 2.5, output: 15, cachedInput: 0.25},
      }],
    });
    // 闲时窗口全天命中 → 闲时价 2.5/15；促销 input 1 覆盖闲时输入，output 沿用闲时 15。
    const cost = computeTokenCost(config, "gpt-x", usage, {capturedAt, officialPresetVendor: "OpenAI"});
    expect(cost.totalCost).toBeCloseTo(1 + 15, 9);
    expect(cost.pricingSnapshot?.scheduleLabel).toBe("闲时");
    expect(cost.pricingSnapshot?.promotionLabel).toBe("促销实扣");
  });

  test("用户 override 固定价生效时跳过促销与 fast 档", () => {
    const withOverride = applyProxyTargetPricing(promoPricingConfig({
      promotions: [{from: "2026-01-01T00:00:00Z", priceOverride: {input: 4, output: 20}}],
    }), {
      version: 3, revision: 1, agentConnections: {}, targets: [{
        id: "t", name: "t", enabled: true, supportedModels: ["gpt-x"],
        pricing: {
          rateMultiplier: 1,
          modelVendors: {"gpt-x": {vendor: "OpenAI", priceEntryId: "promo:gpt-x"}},
          modelOverrides: [{
            id: "ov", targetModelId: "gpt-x",
            pricing: {input: 1, output: 2}, confidence: "user_override",
          }],
        },
        createdAt: "2026-09-01T00:00:00.000Z",
      }],
      localProxyBaseUrl: "http://localhost:3211",
      updatedAt: "2026-09-01T00:00:00.000Z",
    } as never);
    const cost = computeTokenCost(withOverride, "gpt-x", {...usage, serviceTier: "fast"}, {
      targetId: "t", capturedAt, officialPresetVendor: "OpenAI",
    });
    expect(cost.pricingSnapshot?.overrideId).toBe("ov");
    expect(cost.totalCost).toBeCloseTo(1 + 2, 9);
    expect(cost.pricingSnapshot?.promotionLabel).toBeUndefined();
    expect(cost.pricingSnapshot?.serviceTier).toBeUndefined();
  });

  test("归一化强制效果二选一：priceOverride 与 multiplier 并存的促销条目被丢弃", () => {
    const config = normalizePricingConfig({
      version: 2, currency: "USD", unit: "per_million_tokens",
      models: [{
        id: "m", vendor: "OpenAI", runtimeModelId: "m", patterns: ["m"],
        pricing: {input: 5, output: 30}, confidence: "official",
        promotions: [{from: "2026-07-01T00:00:00Z", priceOverride: {input: 4}, multiplier: 0.5}],
      }],
    });
    expect(config.models[0]?.promotions).toBeUndefined();
  });

  test("无 label 促销命中时快照回退通用文案「促销实扣」", () => {
    const config = promoPricingConfig({promotions: [{from: "2026-07-01T00:00:00Z", priceOverride: {input: 4}}]});
    const cost = computeTokenCost(config, "gpt-x", usage, {capturedAt, officialPresetVendor: "OpenAI"});
    expect(cost.pricingSnapshot?.promotionLabel).toBe("促销实扣");
  });

  test("套餐促销每日时间窗随归一化透传；非法钟点导致整个促销数组被丢弃", () => {
    const base = {
      version: 2 as const, currency: "USD", unit: "per_million_tokens" as const,
      models: [{
        id: "glm-5.3-flash", vendor: "zhipu-cn", runtimeModelId: "glm-5.3-flash", patterns: ["glm-5.3-flash"],
        pricing: {input: 0.8, output: 2.8, cachedInput: 0.23}, confidence: "official" as const,
        planCreditRules: {
          formula: "token_weighted" as const,
          divisor: 10000,
          modelFactors: {"glm-5.3-flash": {input: 2.3, output: 8, cachedInput: 0.56}},
          quotaWindows: [{id: "5h" as const, label: "5 小时", reset: "rolling_5h" as const}],
        },
      }],
    };
    const withWindows = normalizePricingConfig({
      ...base,
      models: [{
        ...base.models[0],
        planCreditRules: {
          ...base.models[0].planCreditRules,
          promotions: [{
            from: "2026-09-03T00:00:00+08:00",
            to: "2026-09-21T09:00:00+08:00",
            models: ["glm-5.3-flash"],
            windows: [{start: "23:00", end: "24:00"}, {days: [0, 1, 2, 3, 4, 5, 6], start: "00:00", end: "09:00"}],
            multiplier: 0.5,
          }],
        },
      }],
    });
    expect(withWindows.models[0]?.planCreditRules?.promotions?.[0]?.windows).toEqual([
      {start: "23:00", end: "24:00"},
      {days: [0, 1, 2, 3, 4, 5, 6], start: "00:00", end: "09:00"},
    ]);

    // 坏钟点（25:00）绝不能进入配置：引擎 isWithinTimeWindows 解析会抛错，必须整体丢弃。
    const withBadClock = normalizePricingConfig({
      ...base,
      models: [{
        ...base.models[0],
        planCreditRules: {
          ...base.models[0].planCreditRules,
          promotions: [{from: "2026-09-03T00:00:00+08:00", windows: [{start: "25:00", end: "26:00"}], multiplier: 0.5}],
        },
      }],
    });
    expect(withBadClock.models[0]?.planCreditRules?.promotions).toBeUndefined();
    // 规则本体（公式/系数/窗口）不受促销丢弃影响。
    expect(withBadClock.models[0]?.planCreditRules?.formula).toBe("token_weighted");
  });
});

describe("价格草稿：fast 档与促销（pricing-drafts）", () => {
  test("fast 倍率/促销草稿解析：倍率生效、时间窗与 agent 限定落库", () => {
    const result = priceDraftsToPricing({
      ...emptyPriceDrafts(),
      input: "5", output: "30",
      fastMultiplier: "2",
      promoInput: "4", promoOutput: "20", promoFrom: "2026-07-01", promoLabel: "限时 2/3 价", promoAgents: "zcode, ZCode",
    });
    expect(result).toBeDefined();
    expect(result!.serviceTierPricing).toEqual({fastMultiplier: 2});
    expect(result!.promotions).toEqual([{
      from: "2026-07-01", label: "限时 2/3 价", agents: ["zcode"],
      priceOverride: {input: 4, output: 20},
    }]);
  });

  test("促销草稿价格与起始缺失视为清除：不返回 promotions/serviceTierPricing", () => {
    const cleared = priceDraftsToPricing({...emptyPriceDrafts(), input: "5", output: "30"});
    expect(cleared).toBeDefined();
    expect(cleared!.promotions).toBeUndefined();
    expect(cleared!.serviceTierPricing).toBeUndefined();
  });

  test("促销价格已填但起始时间缺失或非法 → 整体视为非法输入", () => {
    const noFrom = priceDraftsToPricing({...emptyPriceDrafts(), input: "5", output: "30", promoInput: "4"});
    expect(noFrom).toBeUndefined();
    const badFrom = priceDraftsToPricing({...emptyPriceDrafts(), input: "5", output: "30", promoInput: "4", promoFrom: "不是日期"});
    expect(badFrom).toBeUndefined();
  });
});

describe("价格中心来源分类与多选筛选", () => {
  function mixedCatalogConfig() {
    return normalizePricingConfig({
      version: 2,
      currency: "USD",
      unit: "per_million_tokens",
      models: [
        {
          id: "gpt-x", vendor: "openai", runtimeModelId: "gpt-x", patterns: ["gpt-x"],
          pricing: {input: 1, output: 2}, confidence: "third_party",
        },
        {
          id: "gpt-y", vendor: "openai", runtimeModelId: "gpt-y", patterns: ["gpt-y"],
          pricing: {input: 2, output: 4}, confidence: "user_override",
        },
        {
          id: "claude-x", vendor: "anthropic", runtimeModelId: "claude-x", patterns: ["claude-x"],
          pricing: {input: 3, output: 6}, confidence: "official", catalogSource: "catalog",
        },
        {
          id: "glm-x", vendor: "zhipu", runtimeModelId: "glm-x", patterns: ["glm-x"],
          pricing: {input: 0.5, output: 1}, confidence: "unverified",
        },
        {
          id: "kimi-x", vendor: "moonshot", runtimeModelId: "kimi-x", patterns: ["kimi-x"],
          pricing: {input: 0.8, output: 1.6}, confidence: "provider_docs",
        },
      ],
    });
  }

  test("来源分类口径：user_override 一律人工维护，官方目录/官方置信为官方预设，third_party 为 LiteLLM，其余为待确认", () => {
    const config = mixedCatalogConfig();
    const byId = (id: string) => config.models.find(item => item.id === id)!;
    expect(pricingEntrySourceCategory(byId("gpt-x"))).toBe("litellm");
    // 在 LiteLLM 基础上修改过的条目 confidence=user_override → 归入人工维护。
    expect(pricingEntrySourceCategory(byId("gpt-y"))).toBe("manual");
    expect(pricingEntrySourceCategory(byId("claude-x"))).toBe("catalog");
    expect(pricingEntrySourceCategory(byId("kimi-x"))).toBe("catalog");
    expect(pricingEntrySourceCategory(byId("glm-x"))).toBe("pending");
  });

  test("多选筛选：类别、供应商、条目级模型三项独立与组合过滤", () => {
    const config = mixedCatalogConfig();

    const manual = queryPricingCatalog(config, {categories: ["manual"]});
    expect(manual.items.map(item => item.id)).toEqual(["gpt-y"]);

    const vendors = queryPricingCatalog(config, {vendors: ["OpenAI", "Zhipu"]});
    expect(vendors.items.map(item => item.id).sort()).toEqual(["glm-x", "gpt-x", "gpt-y"]);

    const modelEntries = queryPricingCatalog(config, {modelEntries: [
      {vendor: "anthropic", model: "claude-x"},
      {vendor: "OpenAI", model: "gpt-x"},
    ]});
    expect(modelEntries.items.map(item => item.id).sort()).toEqual(["claude-x", "gpt-x"]);

    const combined = queryPricingCatalog(config, {vendors: ["openai"], categories: ["litellm", "manual"]});
    expect(combined.items.map(item => item.id).sort()).toEqual(["gpt-x", "gpt-y"]);

    // 空数组 = 不过滤。
    expect(queryPricingCatalog(config, {modelEntries: [], vendors: [], categories: []}).total).toBe(5);
    // 未知值不命中任何条目，而不是退化为不过滤；供应商命中但模型不命中同样为 0。
    expect(queryPricingCatalog(config, {categories: ["catalog"], modelEntries: [{vendor: "moonshot", model: "nope"}]}).total).toBe(0);
    expect(queryPricingCatalog(config, {modelEntries: [{vendor: "openai", model: "claude-x"}]}).total).toBe(0);
  });

  test("facets.modelEntries：模型 × 供应商条目候选不去重同名模型，跨供应商按条目精确过滤", () => {
    const config = normalizePricingConfig({
      version: 2,
      currency: "USD",
      unit: "per_million_tokens",
      models: [
        {
          id: "p1", vendor: "vendorA", runtimeModelId: "deepseek-v4-pro", patterns: ["deepseek-v4-pro"],
          pricing: {input: 1, output: 2}, confidence: "third_party",
        },
        {
          id: "p2", vendor: "vendorB", runtimeModelId: "deepseek-v4-pro", patterns: ["deepseek-v4-pro"],
          pricing: {input: 1, output: 2}, confidence: "third_party",
        },
        {
          id: "p3", vendor: "vendorA", runtimeModelId: "deepseek-v4-flash", patterns: ["deepseek-v4-flash"],
          pricing: {input: 1, output: 2}, confidence: "third_party",
        },
        // 同供应商同模型的重复条目：候选按对去重，只保留一个。
        {
          id: "p4", vendor: "vendorA", runtimeModelId: "deepseek-v4-flash", patterns: ["deepseek-v4-flash"],
          pricing: {input: 1, output: 2}, confidence: "user_override",
        },
      ],
    });

    const page = queryPricingCatalog(config, {});
    expect(page.facets.models).toEqual(["deepseek-v4-flash", "deepseek-v4-pro"]);
    expect(page.facets.modelEntries).toEqual([
      {model: "deepseek-v4-flash", vendor: "vendorA"},
      {model: "deepseek-v4-pro", vendor: "vendorA"},
      {model: "deepseek-v4-pro", vendor: "vendorB"},
    ]);

    // 「deepseek-v4-pro - vendorB」只命中 vendorB 的条目，不扩散到同名其它供应商条目。
    const scoped = queryPricingCatalog(config, {modelEntries: [{vendor: "vendorB", model: "deepseek-v4-pro"}]});
    expect(scoped.total).toBe(1);
    expect(scoped.items[0]!.id).toBe("p2");
  });

  test("筛选分页：total 反映过滤后全集，offset/limit 正确切页", () => {
    const config = normalizePricingConfig({
      version: 2,
      currency: "USD",
      unit: "per_million_tokens",
      models: Array.from({length: 7}, (_, index) => ({
        id: `m-${index}`,
        vendor: "openai",
        runtimeModelId: `m-${index}`,
        patterns: [`m-${index}`],
        pricing: {input: 1, output: 2},
        confidence: "third_party" as const,
      })).concat(Array.from({length: 3}, (_, index) => ({
        id: `c-${index}`,
        vendor: "openai",
        runtimeModelId: `c-${index}`,
        patterns: [`c-${index}`],
        pricing: {input: 1, output: 2},
        confidence: "official" as const,
        catalogSource: "catalog" as const,
      }))),
    });

    const page = queryPricingCatalog(config, {categories: ["litellm"], limit: 3, offset: 3});
    expect(page.total).toBe(7);
    expect(page.items.map(item => item.runtimeModelId)).toEqual(["m-3", "m-4", "m-5"]);
    expect(page.facets.categoryCounts).toMatchObject({litellm: 7, catalog: 3, manual: 0, pending: 0});
    expect(page.facets.models).toHaveLength(10);
  });

  test("catalog 响应携带 litellmSync / catalogSync 版本标记", () => {
    const config = normalizePricingConfig({
      version: 2,
      currency: "USD",
      unit: "per_million_tokens",
      models: [{
        id: "gpt-x", vendor: "openai", runtimeModelId: "gpt-x", patterns: ["gpt-x"],
        pricing: {input: 1, output: 2}, confidence: "third_party",
      }],
      litellmSync: {syncedAt: "2026-09-07T04:58:59.000Z", modelCount: 3324},
      catalogSync: {lastSyncedPublishedAt: "2026-09-07T00:00:00.000Z", syncedAt: "2026-09-07T01:00:00.000Z"},
    });
    const page = queryPricingCatalog(config, {});
    expect(page.litellmSync).toMatchObject({syncedAt: "2026-09-07T04:58:59.000Z", modelCount: 3324});
    expect(page.catalogSync?.lastSyncedPublishedAt).toBe("2026-09-07T00:00:00.000Z");
  });
});

describe("价格中心筛选大数据边界", () => {
  test("5000 条目下 facets 与分页保持有界，多选过滤命中索引式过滤语义", () => {
    const total = 5000;
    const config = normalizePricingConfig({
      version: 2,
      currency: "USD",
      unit: "per_million_tokens",
      models: Array.from({length: total}, (_, index) => ({
        id: `bulk/model-${String(index).padStart(5, "0")}`,
        vendor: index % 2 === 0 ? "openai" : "anthropic",
        runtimeModelId: `model-${String(index).padStart(5, "0")}`,
        patterns: [`model-${String(index).padStart(5, "0")}`],
        pricing: {input: 1, output: 2},
        confidence: index % 3 === 0 ? ("user_override" as const) : ("third_party" as const),
      })),
    });

    const defaultPage = queryPricingCatalog(config, {});
    expect(defaultPage.items).toHaveLength(50);
    expect(defaultPage.total).toBe(total);
    expect(defaultPage.facets.models).toHaveLength(total);
    expect(defaultPage.facets.modelEntries).toHaveLength(total);
    // 条目级筛选同样在遍历前收窄：单个（供应商，模型）对只允许命中一条。
    const scoped = queryPricingCatalog(config, {
      modelEntries: [{vendor: "openai", model: `model-${String(6).padStart(5, "0")}`}],
    });
    expect(scoped.total).toBe(1);
    expect(scoped.items[0]!.id).toBe("bulk/model-00006");
    expect(defaultPage.facets.categoryCounts.manual + defaultPage.facets.categoryCounts.litellm).toBe(total);

    const filtered = queryPricingCatalog(config, {
      vendors: ["openai"],
      categories: ["manual"],
      limit: 200,
    });
    // openai ∩ user_override = 同时满足偶数下标与 3 的倍数（即 6 的倍数）→ 834 条。
    expect(filtered.total).toBe(834);
    expect(filtered.items.length).toBeLessThanOrEqual(200);
    expect(filtered.items.every(item =>
      item.vendor === "openai" && item.confidence === "user_override")).toBe(true);
  });
});
