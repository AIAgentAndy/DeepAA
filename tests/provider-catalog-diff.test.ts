import {describe, expect, test} from "vitest";
import {computeProviderCatalogDiff, applyProviderCatalogSelection} from "../src/lib/provider-catalog/diff.js";
import {normalizeProviderCatalog} from "../src/lib/provider-catalog/normalize.js";
import {compileProviderModelEntries} from "../src/lib/provider-catalog/compiler.js";

function CATALOG_FIXTURE(value: unknown): ReturnType<typeof normalizeProviderCatalog>["catalog"] {
  return normalizeProviderCatalog(value).catalog;
}
import {normalizePricingConfig, type PricingConfigV2} from "../src/lib/pricing.js";
import type {ProxyTarget} from "../src/types.js";

const fixtureCatalog = CATALOG_FIXTURE({
  schemaVersion: 2,
  catalogRevision: "2026.09.03.01",
  publishedAt: "2026-08-17T00:00:00+08:00",
  providers: {
    "demo-cn": {
      name: "Demo",
      brandId: "demo",
      pricingProviderId: "demo-cn",
      region: "cn",
      category: "cn_official",
      models: [
        {
          id: "new-chat",
          category: "chat",
          supportedWireApis: ["chat_completions", "responses", "messages"],
          contextWindowK: 128,
          maxOutputK: 16,
          pricing: {input: 1, output: 2, cachedInput: 0.1},
          priceSchedules: [{
            timezone: "Asia/Shanghai",
            label: "闲时",
            windows: [{days: [0], start: "00:00", end: "24:00"}],
            rates: {input: 0.5, output: 1, cachedInput: 0.05},
            holidays: ["2026-10-01"],
          }],
          sourceUrl: "https://demo.example/pricing",
          notes: "峰谷模型",
        },
        {
          id: "old-chat",
          category: "chat",
          supportedWireApis: ["chat_completions", "responses", "messages"],
          contextWindowK: 64,
          maxOutputK: 8,
          pricing: {input: 3, output: 4},
          priceSchedules: [{
            label: "闲时",
            windows: [{start: "18:00", end: "24:00"}],
            rates: {input: 1.5, output: 2},
          }],
        },
        {id: "old-unpriced", category: "chat", supportedWireApis: ["chat_completions", "responses", "messages"]},
        {id: "unchanged-chat", category: "chat", supportedWireApis: ["chat_completions", "responses", "messages"], contextWindowK: 32, maxOutputK: 4, pricing: {input: 5, output: 6}},
      ],
    },
  },
});
const provider = fixtureCatalog.providers["demo-cn"]!;
const compiled = compileProviderModelEntries(fixtureCatalog, "demo-cn");

function target(): ProxyTarget {
  return {
    id: "demo",
    name: "Demo",
    enabled: true,
    openaiUrl: "https://demo.example/v1",
    anthropicUrl: "https://demo.example/anthropic",
    supportedModels: ["old-chat", "removed-chat", "old-unpriced", "unchanged-chat"],
    supportedModelScopes: {"old-chat": ["codex"], "removed-chat": ["claude"]},
    pricing: {
      vendor: "demo-cn",
      modelVendors: {
        "old-chat": {vendor: "demo-cn", priceEntryId: "catalog:demo-cn:old-chat"},
        "removed-chat": {vendor: "demo-cn", priceEntryId: "catalog:demo-cn:removed-chat"},
        "unchanged-chat": {vendor: "demo-cn", priceEntryId: "catalog:demo-cn:unchanged-chat"},
      },
      modelOverrides: [
        {id: "override-old", targetModelId: "old-chat", pricing: {input: 1, output: 1}},
        {id: "override-removed", targetModelId: "removed-chat", pricing: {input: 1, output: 1}},
      ],
    },
    development: {defaultModels: {codex: "removed-chat"}},
  };
}

function pricing(): PricingConfigV2 {
  return normalizePricingConfig({
    version: 2,
    currency: "USD",
    unit: "per_million_tokens",
    models: [
      {
        id: "catalog:demo-cn:new-chat",
        vendor: "demo-cn",
        runtimeModelId: "new-chat",
        patterns: ["new-chat"],
        pricing: {input: 1, output: 2, cachedInput: 0.1},
        confidence: "official",
      },
      {
        id: "catalog:demo-cn:old-chat",
        vendor: "demo-cn",
        runtimeModelId: "old-chat",
        patterns: ["old-chat"],
        pricing: {input: 99, output: 99},
        confidence: "official",
      },
      {
        id: "catalog:demo-cn:removed-chat",
        vendor: "demo-cn",
        runtimeModelId: "removed-chat",
        patterns: ["removed-chat"],
        pricing: {input: 1, output: 1},
        confidence: "official",
      },
      {
        id: "catalog:demo-cn:unchanged-chat",
        vendor: "demo-cn",
        runtimeModelId: "unchanged-chat",
        patterns: ["unchanged-chat"],
        pricing: {input: 5, output: 6},
        contextWindow: 32 * 1024,
        maxOutput: 4 * 1024,
        confidence: "official",
      },
    ],
  });
}

describe("存量目标供应商目录刷新差异", () => {
  test("无价格中心参数时保留完整分组，候选计数只统计用户可见的新增与原有", () => {
    const diff = computeProviderCatalogDiff(target(), provider, undefined, compiled);

    expect(diff.added.map(item => item.id)).toEqual(["new-chat"]);
    expect(diff.existing.map(item => item.id)).toEqual(["old-chat", "old-unpriced", "unchanged-chat"]);
    expect(diff.removed.map(item => item.id)).toEqual(["removed-chat"]);
    expect(diff.candidateCount).toBe(1); // 终极方案：候选只统计新增
    expect(diff.processedCount).toBe(5); // added(1) + existing(3) + removed(1)
    expect(diff.limited).toBe(false);
  });

  test("刷新差异项携带价格、上下文、峰谷与协议归属完整字段", () => {
    const diff = computeProviderCatalogDiff(target(), provider, undefined, compiled);

    const added = diff.added.find(item => item.id === "new-chat");
    expect(added).toMatchObject({
      kind: "added",
      vendor: "demo-cn",
      pricing: {input: 1, output: 2, cachedInput: 0.1},
      priceSchedules: [expect.objectContaining({
        label: "闲时",
        rates: {input: 0.5, output: 1, cachedInput: 0.05},
        holidays: ["2026-10-01"],
      })],
      contextWindowK: 128,
      maxOutputK: 16,
      sourceUrl: "https://demo.example/pricing",
      notes: "峰谷模型",
      supportedAgents: ["codex", "claude", "opencode", "dsh", "zcode"],
    });

    const existing = diff.existing.find(item => item.id === "old-chat");
    expect(existing).toMatchObject({
      kind: "existing",
      pricing: {input: 3, output: 4},
      priceSchedules: [expect.objectContaining({label: "闲时"})],
      contextWindowK: 64,
      maxOutputK: 8,
    });
  });

  test("提供价格中心时，原有模型只列有变化的条目并携带变化明细", () => {
    const diff = computeProviderCatalogDiff(target(), provider, pricing(), compiled);

    // 终极方案：全部存量模型展示（价格自动跟随，无"有变化"过滤）。
    expect(diff.existing.map(item => item.id)).toEqual(["old-chat", "old-unpriced", "unchanged-chat"]);
    expect(diff.candidateCount).toBe(1);

    const changed = diff.existing.find(item => item.id === "old-chat");
    expect(changed?.changed).toBeUndefined(); // 终极方案：无字段级差异
    expect(changed?.changes).toBeUndefined();

    const missingMapping = diff.existing.find(item => item.id === "old-unpriced");
    expect(missingMapping?.changed).toBeUndefined();
    expect(missingMapping?.warning).toContain("价格映射");
  });

  test("确认选择后更新白名单（集合语义：未勾选=移出）", () => {
    const result = applyProviderCatalogSelection(target(), provider, {
      selectedModelIds: ["new-chat", "old-chat", "unchanged-chat", "removed-chat"],
      replacementDefaultModels: {},
    }, pricing());

    expect(result.targetPatch.supportedModels).toEqual(expect.arrayContaining([
      "new-chat",
      "old-chat",
      "unchanged-chat",
      "removed-chat",
    ]));
    expect(result.targetPatch.supportedModels).toHaveLength(4);
    expect(result.removedModelIds).toEqual(["old-unpriced"]);
    expect(result.targetPatch.development?.defaultModels?.codex).toBe("removed-chat");
    expect(result.targetPatch.pricing?.modelVendors).toMatchObject({
      "new-chat": {vendor: "demo-cn"},
      "old-chat": {vendor: "demo-cn", priceEntryId: "catalog:demo-cn:old-chat"},
      "unchanged-chat": {vendor: "demo-cn", priceEntryId: "catalog:demo-cn:unchanged-chat"},
      "removed-chat": {vendor: "demo-cn", priceEntryId: "catalog:demo-cn:removed-chat"},
    });
    expect(result.targetPatch.pricing?.modelOverrides?.map(item => item.targetModelId)).toEqual(["old-chat", "removed-chat"]);
    expect(result.targetPatch.supportedModelWireApis).toMatchObject({
      "new-chat": ["chat_completions", "responses", "messages"],
      "old-chat": ["chat_completions", "responses", "messages"],
      "unchanged-chat": ["chat_completions", "responses", "messages"],
    });
  });

  test("取消有变化的原有模型时从白名单移除并要求替代默认模型", () => {
    const changedDefault = {
      ...target(),
      development: {defaultModels: {codex: "old-chat"}},
    };
    expect(() => applyProviderCatalogSelection(changedDefault, provider, {
      selectedModelIds: ["new-chat"],
    }, pricing())).toThrow(/默认模型.*替代/u);

    const result = applyProviderCatalogSelection(changedDefault, provider, {
      selectedModelIds: ["new-chat", "unchanged-chat", "removed-chat"],
      replacementDefaultModels: {codex: "new-chat"},
    }, pricing());
    expect(result.targetPatch.supportedModels).toEqual(expect.arrayContaining(["new-chat", "unchanged-chat", "removed-chat"]));
    expect(result.targetPatch.supportedModels).not.toContain("old-chat");
    expect(result.removedModelIds).toEqual(["old-chat", "old-unpriced"]);
    expect(result.targetPatch.development?.defaultModels?.codex).toBe("new-chat");
  });

  test("目录无价格且目标也无既有映射的模型禁止继续留在白名单", () => {
    expect(() => applyProviderCatalogSelection(target(), provider, {
      selectedModelIds: ["new-chat", "old-chat", "old-unpriced"],
      replacementDefaultModels: {},
    }, pricing())).toThrow("MODEL_PRICE_MAPPING_REQUIRED");
  });

  test("用户取消新增模型时观察计数仍覆盖完整差异集合", () => {
    const result = applyProviderCatalogSelection(target(), provider, {
      selectedModelIds: ["old-chat", "removed-chat"],
      replacementDefaultModels: {},
    }, pricing());

    expect(result.candidateCount).toBe(1);
    expect(result.processedCount).toBe(5);
    expect(result.limited).toBe(false);
  });
});
