import {describe, expect, test} from "vitest";
import {
  buildNewTargetCatalogPatch,
  providerCatalogHasChanges,
} from "../src/lib/provider-catalog/review.js";

describe("供应商目录差异确认的展示规则", () => {
  test("只有新增或原有模型有变化时才展示差异确认，目录已移除不触发", () => {
    expect(providerCatalogHasChanges({added: [], existing: [{id: "glm-5.3", changed: false}], removed: []})).toBe(false);
    expect(providerCatalogHasChanges({added: [{id: "glm-6"}], existing: [], removed: []})).toBe(true);
    expect(providerCatalogHasChanges({added: [], existing: [{id: "glm-5.3", changed: true}], removed: []})).toBe(true);
    expect(providerCatalogHasChanges({added: [], existing: [], removed: [{id: "glm-4"}]})).toBe(false);
  });

  test("新建目标选择预设后直接生成白名单与价格映射补丁", () => {
    const patch = buildNewTargetCatalogPatch({
      pricingProviderId: "zhipu-cn",
      diff: {
        added: [
          {id: "glm-5.3", priced: true},
          {id: "glm-5-turbo", priced: true},
        ],
        existing: [],
        removed: [],
      },
    });

    expect(patch.supportedModels).toEqual(["glm-5.3", "glm-5-turbo"]);
    expect(patch.pricing?.modelVendors).toEqual({
      "glm-5.3": {vendor: "zhipu-cn"},
      "glm-5-turbo": {vendor: "zhipu-cn"},
    });
  });
});
