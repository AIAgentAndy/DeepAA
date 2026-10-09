import {describe, expect, test} from "vitest";
import {
  filterCatalogByModels,
  normalizeSelectedModels,
  type CatalogWithProviders,
} from "../src/lib/provider-catalog/catalog-filter.js";

const catalog: CatalogWithProviders = {
  publishedAt: "2026-09-05",
  providers: {
    anthropic: {
      pricingProviderId: "anthropic",
      models: [
        {id: "claude-fable-5", pricing: {input: 10, output: 50}},
        {id: "claude-sonnet-5", pricing: {input: 1, output: 5}},
      ],
    },
    opencodeGo: {
      pricingProviderId: "opencode-go",
      models: [{id: "deepseek-v4-pro", pricing: {input: 1.32, output: 3.96}}],
    },
  },
};

describe("官方目录更新勾选模型过滤", () => {
  test("按 pricingProviderId/modelId 精确过滤，无命中的供应商剔除", () => {
    const filtered = filterCatalogByModels(catalog, normalizeSelectedModels([
      "anthropic/claude-sonnet-5",
      "opencode-go/deepseek-v4-pro",
    ])!);
    expect(Object.keys(filtered.providers).sort()).toEqual(["anthropic", "opencodeGo"]);
    expect(filtered.providers.anthropic.models.map(m => m.id)).toEqual(["claude-sonnet-5"]);
    expect(filtered.providers.opencodeGo.models.map(m => m.id)).toEqual(["deepseek-v4-pro"]);
  });

  test("供应商全部模型未勾选时该供应商整行剔除", () => {
    const filtered = filterCatalogByModels(catalog, normalizeSelectedModels(["anthropic/claude-fable-5"])!);
    expect(Object.keys(filtered.providers)).toEqual(["anthropic"]);
    expect(filtered.publishedAt).toBe("2026-09-05");
  });

  test("normalizeSelectedModels：空/超限/非法键拒绝，合法键去重", () => {
    expect(normalizeSelectedModels(undefined)).toBeUndefined();
    expect(normalizeSelectedModels(null)).toBeUndefined();
    expect(normalizeSelectedModels([])).toBeUndefined();
    expect(() => normalizeSelectedModels(["bad key with spaces"])).toThrow("INVALID_REQUEST");
    expect(() => normalizeSelectedModels(Array.from({length: 501}, () => "a/b"))).toThrow("INVALID_REQUEST");
    const selected = normalizeSelectedModels(["anthropic/claude-fable-5", "anthropic/claude-fable-5"]);
    expect(selected?.size).toBe(1);
  });
});
