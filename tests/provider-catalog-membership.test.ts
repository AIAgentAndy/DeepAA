import {describe, expect, test} from "vitest";
import {normalizeProviderCatalog} from "../src/lib/provider-catalog/normalize.js";
import {mergeProviderCatalogPricing} from "../src/lib/provider-catalog/pricing.js";
import {normalizePricingConfig, type PricingConfigV2} from "../src/lib/pricing.js";

function catalog(models: Array<{id: string; input: number}>): ReturnType<typeof normalizeProviderCatalog>["catalog"] {
  return normalizeProviderCatalog({
    schemaVersion: 2,
    catalogRevision: "2099.01.02.01",
    publishedAt: "2099-01-02T00:00:00+08:00",
    providers: {
      openai: {
        name: "OpenAI",
        brandId: "openai",
        pricingProviderId: "openai",
        region: "global",
        category: "global_official",
        models: models.map(model => ({
          id: model.id,
          category: "chat",
          pricing: {input: model.input, output: model.input * 2},
        })),
      },
    },
  }).catalog;
}

function emptyPricing(): PricingConfigV2 {
  return normalizePricingConfig({
    version: 2,
    currency: "USD",
    unit: "per_million_tokens",
    models: [],
  });
}

describe("官方目录推荐集合独立索引", () => {
  test("目录合并只写入价格条目，推荐集合由独立 membership 表维护", () => {
    const merged = mergeProviderCatalogPricing(emptyPricing(), catalog([{id: "gpt-current", input: 1}]));
    expect(merged.models.find(item => item.runtimeModelId === "gpt-current")?.pricing)
      .toEqual({input: 1, output: 2});
  });

  test("目录合并不会删除历史价格中心条目", () => {
    const first = mergeProviderCatalogPricing(emptyPricing(), catalog([{id: "gpt-legacy", input: 1}]));
    const second = mergeProviderCatalogPricing(first, catalog([{id: "gpt-current", input: 2}]));
    const entry = second.models.find(item => item.runtimeModelId === "gpt-legacy");
    expect(entry).toBeDefined();
    expect(entry?.pricing).toEqual({input: 1, output: 2});
  });
});
