import type {ProxyTarget} from "@/types";

/** 差异确认面板的只读投影，避免把服务端完整 review 类型带入浏览器。 */
export interface ProviderCatalogDiffProjection {
  added: ReadonlyArray<{id: string}>;
  existing: ReadonlyArray<{id: string; changed?: boolean}>;
  removed: ReadonlyArray<unknown>;
}

/**
 * 供应商目录差异确认只在「有新增或原有模型有变化」时展示：
 * 新建供应商自动应用候选，存量供应商无差异时不打扰用户。
 */
export function providerCatalogHasChanges(
  diff: Pick<ProviderCatalogDiffProjection, "added" | "existing">,
): boolean {
  return diff.added.length > 0 || diff.existing.some(item => item.changed === true);
}

/** 新建供应商选择预设后直接生成 Agent 可见模型与价格映射补丁，不需要用户再点一次确认。 */
export function buildNewTargetCatalogPatch(review: {
  pricingProviderId: string;
  diff: Pick<ProviderCatalogDiffProjection, "added">;
}): Pick<ProxyTarget, "supportedModels" | "pricing"> {
  const selectedModelIds = review.diff.added.map(model => model.id);
  return {
    supportedModels: selectedModelIds,
    pricing: {
      vendor: review.pricingProviderId,
      modelVendors: Object.fromEntries(selectedModelIds.map(modelId => [
        modelId,
        {vendor: review.pricingProviderId},
      ])),
    },
  };
}
