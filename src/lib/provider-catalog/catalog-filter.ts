/**
 * 官方目录更新的勾选模型过滤（2026-09-06 单模型/勾选更新）：
 * apply 请求可携带勾选集合（键 "<pricingProviderId>/<modelId>"），
 * 服务端据此过滤目录后合并——未勾选的模型不写入价格中心。
 */

export const MODEL_KEY_PATTERN = /^[a-zA-Z0-9._/@-]{1,256}$/;

/** 结构化最小契约：只约束过滤所需的字段，宿主目录类型可结构化代入。 */
export interface CatalogWithProviders {
  publishedAt: string;
  providers: Record<string, {
    pricingProviderId: string;
    models: Array<{id: string}>;
  }>;
}

/** 勾选集合解析：空/null 视为整包应用（返回 undefined）；非法键或超限抛 INVALID_REQUEST。 */
export function normalizeSelectedModels(value: unknown): Set<string> | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new Error("INVALID_REQUEST");
  if (value.length === 0) return undefined;
  if (value.length > 500) throw new Error("INVALID_REQUEST");
  const selected = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string" || !MODEL_KEY_PATTERN.test(item)) throw new Error("INVALID_REQUEST");
    selected.add(item);
  }
  return selected.size > 0 ? selected : undefined;
}

/** 按勾选集合过滤目录（pricingProviderId/modelId 精确匹配）；无命中模型的供应商整行剔除。 */
export function filterCatalogByModels<T extends CatalogWithProviders>(catalog: T, selected: Set<string>): T {
  const providers: CatalogWithProviders["providers"] = {};
  for (const [key, provider] of Object.entries(catalog.providers)) {
    const models = provider.models.filter(model => selected.has(`${provider.pricingProviderId}/${model.id}`));
    if (models.length > 0) providers[key] = {...provider, models};
  }
  return {...catalog, providers} as T;
}
