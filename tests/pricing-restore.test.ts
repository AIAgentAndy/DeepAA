import {describe, expect, test} from "vitest";
import {normalizeProviderCatalog} from "../src/lib/provider-catalog/normalize.js";

function CATALOG_FIXTURE(value: unknown): ReturnType<typeof normalizeProviderCatalog>["catalog"] {
  return normalizeProviderCatalog(value).catalog;
}
import type {ProviderCatalogEnvelope} from "../src/lib/provider-catalog/types.js";
import {
  findReferencingTargets,
  describeRestoreSource,
  findPersistedRestoreSources,
  findRestoreSourceInCatalog,
  findRestoreSourceInLiteLLM,
  selectRestoreSource,
  repairTargetModelVendors,
  restorePricingEntry,
  type PricingRestoreIdentity,
} from "../src/lib/pricing-restore.js";
import {
  DEFAULT_PRICING,
  normalizePricingConfig,
  type ModelPriceEntry,
  type PricingConfigV2,
} from "../src/lib/pricing.js";
import type {ProxyConfig, ProxyTarget} from "../src/types.js";

const identity: PricingRestoreIdentity = {vendor: "deepseek", runtimeModelId: "deepseek-v4-flash"};

function envelope(): ProviderCatalogEnvelope {
  return {
    catalog: CATALOG_FIXTURE({
      schemaVersion: 2,
      catalogRevision: "2026.08.21.01",
      publishedAt: "2026-08-21T00:00:00+08:00",
      providers: {
        deepseek: {
          name: "DeepSeek",
          brandId: "deepseek",
          pricingProviderId: "deepseek",
          region: "cn",
          category: "cn_official",
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
    }),
    source: "bundled",
    fetchedAt: "2026-08-21T00:00:00.000Z",
    sourceHash: "sha256:test",
  };
}

function manualEntry(): ModelPriceEntry {
  return {
    id: "manual:deepseek-v4-flash",
    vendor: "deepseek",
    runtimeModelId: "deepseek-v4-flash",
    match: "deepseek-v4-flash",
    patterns: ["deepseek-v4-flash"],
    mode: "chat",
    pricing: {input: 99, output: 99},
    currency: "USD",
    confidence: "user_override",
  };
}

function target(id: string, modelVendors?: Record<string, {vendor?: string; priceEntryId?: string}>): ProxyTarget {
  return {
    id,
    name: `目标-${id}`,
    openaiUrl: `https://${id}.example/v1`,
    enabled: true,
    supportedModels: Object.keys(modelVendors || {}),
    pricing: modelVendors ? {vendor: "deepseek", modelVendors} : undefined,
  };
}

describe("价格中心恢复官方默认服务", () => {
  test("旧 LiteLLM 配置没有底稿表时，可用 previousPricing 构造 LiteLLM 恢复来源", () => {
    const entry: ModelPriceEntry = {
      id: "gpt-6-sol",
      vendor: "openai",
      runtimeModelId: "gpt-6-sol",
      patterns: ["gpt-6-sol"],
      pricing: {input: 2, output: 10},
      previousPricing: {input: 1.5, output: 8},
      confidence: "user_override",
    };
    const sources = findPersistedRestoreSources({
      ...DEFAULT_PRICING,
      catalogSource: {
        type: "litellm",
        fetchedAt: "2026-09-23T07:10:17.999Z",
        hash: "sha256:litellm",
      },
      models: [entry],
    }, entry);
    expect(sources.litellm?.kind).toBe("litellm_baseline");
    expect(sources.litellm && "entry" in sources.litellm ? sources.litellm.entry.pricing : undefined)
      .toEqual({input: 1.5, output: 8});
  });

  test("恢复来源按官方优先解析，并向界面透出来源状态与时间", () => {
    const currentOfficial = findRestoreSourceInCatalog(envelope(), identity);
    const liteLLMSnapshot = findRestoreSourceInLiteLLM(normalizePricingConfig({
      ...DEFAULT_PRICING,
      catalogSource: {type: "litellm", fetchedAt: "2026-08-20T00:00:00.000Z", hash: "sha256:lite"},
      models: [{
        id: "litellm/deepseek-v4-flash",
        vendor: "deepseek",
        runtimeModelId: "deepseek-v4-flash",
        patterns: ["deepseek-v4-flash"],
        pricing: {input: 0.5, output: 1.5},
        confidence: "third_party",
      }],
    }), identity);
    if (!currentOfficial || !liteLLMSnapshot) throw new Error("source expected");

    expect(selectRestoreSource({
      currentCatalogSource: currentOfficial,
      liteLLMSource: liteLLMSnapshot,
    })).toBe(currentOfficial);
    expect(describeRestoreSource(currentOfficial, [{
      targetId: "target-a",
      targetName: "目标 A",
      targetModelId: "deepseek-v4-flash",
    }])).toMatchObject({
      source: "official",
      sourceState: "current_official",
      sourceRevision: "2026.08.21.01",
      sourceCapturedAt: "2026-08-21T00:00:00+08:00",
      targetOverrides: [{targetId: "target-a"}],
    });
  });

  test("官方目录按供应商 + 运行时模型 ID 定位恢复来源，缺模型时返回 undefined", () => {
    const source = findRestoreSourceInCatalog(envelope(), identity);
    expect(source?.kind).toBe("catalog");
    if (source?.kind !== "catalog") throw new Error("should be catalog source");
    expect(Object.keys(source.catalog.providers)).toEqual(["deepseek"]);
    expect(source.catalog.providers.deepseek?.models.map(item => item.id)).toEqual(["deepseek-v4-flash"]);

    expect(findRestoreSourceInCatalog(envelope(), {vendor: "deepseek", runtimeModelId: "deepseek-v3"})).toBeUndefined();
    expect(findRestoreSourceInCatalog(envelope(), {vendor: "openai", runtimeModelId: "deepseek-v4-flash"})).toBeUndefined();
  });

  test("恢复后手工条目被官方条目替换，价格、峰谷与来源均来自官方目录", () => {
    const current = normalizePricingConfig({
      ...DEFAULT_PRICING,
      models: [manualEntry()],
      catalogSource: {
        type: "provider_catalog",
        url: "https://deepaa.dev/data/defaults/llm_catalog.jsonl",
        fetchedAt: "2026-08-20T00:00:00.000Z",
        hash: "sha256:previous-full-sync",
        modelCount: 42,
      },
      unconvertedCatalogPricing: true,
    });
    const source = findRestoreSourceInCatalog(envelope(), identity);
    if (!source) throw new Error("source expected");

    const restored = restorePricingEntry(current, source, identity);
    expect(restored.config.models).toHaveLength(1);
    expect(restored.config.models[0]).toMatchObject({
      id: "manual:deepseek-v4-flash",
      confidence: "official",
      catalogSource: "catalog",
      pricing: {input: 0.44, output: 1.32},
      priceSchedules: [{label: "闲时"}],
    });
    expect(restored.config.models.some(item => item.id === "manual:deepseek-v4-flash")).toBe(true);
    expect(restored.entry.id).toBe(restored.config.models[0]?.id);
    // 恢复单条目不得把整库来源 hash 改写成单模型 hash；保留上一次完整同步的来源元数据。
    expect(restored.config.catalogSource).toEqual({
      type: "provider_catalog",
      url: "https://deepaa.dev/data/defaults/llm_catalog.jsonl",
      fetchedAt: "2026-08-20T00:00:00.000Z",
      hash: "sha256:previous-full-sync",
      modelCount: 42,
    });
    expect(restored.config.unconvertedCatalogPricing).toBe(true);
  });

  test("恢复单个官方模型不会清掉同一目录供应商其他模型的推荐集合", () => {
    const current = normalizePricingConfig({
      ...DEFAULT_PRICING,
      models: [
        {
          ...manualEntry(),
          id: "manual:deepseek-v4-flash",
        },
        {
          id: "catalog:deepseek:deepseek-v4-pro",
          vendor: "deepseek",
          runtimeModelId: "deepseek-v4-pro",
          match: "deepseek-v4-pro",
          patterns: ["deepseek-v4-pro"],
          pricing: {input: 0.6, output: 1.8},
          confidence: "official",
          catalogSource: "catalog",
        },
      ],
    });
    const source = findRestoreSourceInCatalog(envelope(), identity);
    if (!source) throw new Error("source expected");

    const restored = restorePricingEntry(current, source, identity);
    const untouched = restored.config.models.find(item => item.runtimeModelId === "deepseek-v4-pro");
    expect(untouched?.pricing).toEqual({input: 0.6, output: 1.8});
    expect(untouched?.pricing).toEqual({input: 0.6, output: 1.8});
  });

  test("LiteLLM 快照作为目录缺失时的兜底来源", () => {
    const snapshot: PricingConfigV2 = normalizePricingConfig({
      version: 2,
      currency: "USD",
      unit: "per_million_tokens",
      models: [{
        id: "litellm/deepseek-v4-flash",
        vendor: "deepseek",
        runtimeModelId: "deepseek-v4-flash",
        patterns: ["deepseek-v4-flash"],
        pricing: {input: 0.5, output: 1.5},
        confidence: "third_party",
      }],
    });
    const source = findRestoreSourceInLiteLLM(snapshot, identity);
    expect(source?.kind).toBe("litellm");
    if (source?.kind !== "litellm") throw new Error("should be litellm source");

    const current = normalizePricingConfig({...DEFAULT_PRICING, models: [manualEntry()]});
    const restored = restorePricingEntry(current, source, identity);
    expect(restored.entry).toMatchObject({vendor: "deepseek", pricing: {input: 0.5, output: 1.5}});
  });

  test("目录与快照都找不到来源时返回 undefined（纯手工模型仍保留）", () => {
    const unknown: PricingRestoreIdentity = {vendor: "my-relay", runtimeModelId: "custom-model"};
    expect(findRestoreSourceInCatalog(envelope(), unknown)).toBeUndefined();
    expect(findRestoreSourceInLiteLLM(normalizePricingConfig({...DEFAULT_PRICING, models: []}), unknown)).toBeUndefined();
  });
});

describe("目标引用检测与恢复改绑", () => {
  test("删除引用拦截按条目 ID 与供应商 + 模型 ID 两种方式命中目标", () => {
    const entry = manualEntry();
    const config: ProxyConfig = {
      version: 3,
      revision: 1,
      localProxyBaseUrl: "http://localhost:3211",
      updatedAt: "2026-08-21T00:00:00.000Z",
      agentConnections: {},
      targets: [
        target("by-id", {"deepseek-v4-flash": {vendor: "deepseek", priceEntryId: "manual:deepseek-v4-flash"}}),
        target("by-vendor-model", {"DEEPSEEK-V4-FLASH": {vendor: "DeepSeek"}}),
        target("unrelated", {"other-model": {vendor: "deepseek", priceEntryId: "catalog:other"}}),
      ],
    };

    const referencing = findReferencingTargets(config, entry);
    expect(referencing.map(item => item.id)).toEqual(["by-id", "by-vendor-model"]);
    expect(referencing[0]?.models).toEqual(["deepseek-v4-flash"]);
    expect(referencing[1]?.models).toEqual(["DEEPSEEK-V4-FLASH"]);
  });

  test("恢复时把所有引用旧条目的目标改绑到恢复后条目，未引用目标保持原样", () => {
    const oldEntry = manualEntry();
    const restoredEntry: ModelPriceEntry = {
      ...oldEntry,
      id: "catalog:deepseek:deepseek-v4-flash",
      pricing: {input: 0.44, output: 1.32},
      confidence: "official",
      catalogSource: "catalog",
    };
    const byId = target("by-id", {"deepseek-v4-flash": {vendor: "deepseek", priceEntryId: "manual:deepseek-v4-flash"}});
    const byVendor = target("by-vendor-model", {"deepseek-v4-flash": {vendor: "DeepSeek"}});
    const untouched = target("untouched", {"other-model": {vendor: "deepseek", priceEntryId: "catalog:other"}});
    const noPricing = target("no-pricing");
    const config: ProxyConfig = {
      version: 3,
      revision: 1,
      localProxyBaseUrl: "http://localhost:3211",
      updatedAt: "2026-08-21T00:00:00.000Z",
      agentConnections: {},
      targets: [byId, byVendor, untouched, noPricing],
    };

    const repair = repairTargetModelVendors(config, oldEntry, restoredEntry);
    expect(repair.affectedTargetIds).toEqual(["by-id", "by-vendor-model"]);
    expect(repair.targets[0]?.pricing?.modelVendors?.["deepseek-v4-flash"]).toEqual({
      vendor: "deepseek",
      priceEntryId: "catalog:deepseek:deepseek-v4-flash",
    });
    expect(repair.targets[1]?.pricing?.modelVendors?.["deepseek-v4-flash"]).toEqual({
      vendor: "deepseek",
      priceEntryId: "catalog:deepseek:deepseek-v4-flash",
    });
    // 未引用的目标对象原样保留，不产生无意义写入。
    expect(repair.targets[2]).toBe(untouched);
    expect(repair.targets[3]).toBe(noPricing);
  });
});

describe("价格中心条目永久保留", () => {
  test("删除路由统一拒绝删除，恢复路由确定性读取来源", async () => {
    const {readFile} = await import("node:fs/promises");
    const deleteRoute = await readFile("src/app/api/model-pricing/route.ts", "utf8");
    const restoreRoute = await readFile("src/app/api/model-pricing/restore/route.ts", "utf8");
    const pricingDialog = await readFile("src/components/pricing-settings-dialog.tsx", "utf8");
    expect(deleteRoute).toContain("PRICE_ENTRY_DELETE_DISABLED");
    expect(deleteRoute).not.toContain("removePricingConfigModels(current, identities)");
    expect(pricingDialog).not.toContain('method: "DELETE"');
    expect(pricingDialog).toContain("取消手工覆盖");
    expect(pricingDialog).not.toContain('restoreSelectedModel("catalog")');
    expect(pricingDialog).not.toContain('restoreSelectedModel("litellm")');
    expect(pricingDialog).toContain("如需同步恢复，请先到供应商");
    expect(pricingDialog).toContain("sourceCapturedAt");
    expect(deleteRoute).toContain("readProxyConfigForPricing");
    expect(restoreRoute).toContain("findRestoreSourceInBaseline");
    expect(restoreRoute).toContain("targetOverrides");
    // 恢复路由同样确定性本地读取目录（allowRemote:false），恢复到用户所见目录版本。
    expect(restoreRoute).toContain('loadProviderCatalog(DATA_DIR, {forceRefresh: false, allowRemote: false})');
  });
});
