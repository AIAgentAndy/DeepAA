/**
 * 中转站模型族到价格中心供应商的固定映射。
 *
 * 中转站通常只返回模型 ID，不返回原厂 vendor；为了避免把 vendor 选择暴露给用户，
 * 这里以模型族和显式命名空间做确定性推断。未命中时返回 undefined，调用方必须拒绝
 * 把该模型加入供应商白名单。
 */

export type ModelVendorMapReason =
  | "openai_model_family"
  | "anthropic_model_family"
  | "moonshot_model_family"
  | "deepseek_model_family"
  | "zhipu_model_family"
  | "qwen_model_family"
  | "minimax_model_family";

export interface ModelVendorSuggestion {
  vendor: string;
  reason: ModelVendorMapReason;
}

interface ModelVendorRule {
  vendor: string;
  reason: ModelVendorMapReason;
  matches: (modelId: string) => boolean;
}

/**
 * 显式命名空间规则放在普通前缀前面；每个规则内部只处理归一化后的模型 ID。
 * 新增模型族必须同步补充单测，不能在探测调用点临时猜测 vendor。
 */
const MODEL_VENDOR_RULES: readonly ModelVendorRule[] = [
  {
    vendor: "anthropic",
    reason: "anthropic_model_family",
    matches: modelId => modelId.startsWith("anthropic/claude-"),
  },
  {
    vendor: "moonshot-cn",
    reason: "moonshot_model_family",
    matches: modelId => modelId.startsWith("moonshot/"),
  },
  {
    vendor: "deepseek-cn",
    reason: "deepseek_model_family",
    matches: modelId => modelId.startsWith("deepseek/"),
  },
  {
    vendor: "zhipu-cn",
    reason: "zhipu_model_family",
    matches: modelId => modelId.startsWith("zhipu/"),
  },
  {
    vendor: "qwenai-cn",
    reason: "qwen_model_family",
    matches: modelId => modelId.startsWith("qwen/"),
  },
  {
    vendor: "openai",
    reason: "openai_model_family",
    matches: modelId => /^o[1-9](?:[-.]|$)/u.test(modelId),
  },
  {
    vendor: "openai",
    reason: "openai_model_family",
    matches: modelId => modelId.startsWith("openai/"),
  },
  {
    vendor: "anthropic",
    reason: "anthropic_model_family",
    matches: modelId => modelId.startsWith("claude-"),
  },
  {
    vendor: "moonshot-cn",
    reason: "moonshot_model_family",
    matches: modelId => modelId.startsWith("kimi-"),
  },
  {
    vendor: "deepseek-cn",
    reason: "deepseek_model_family",
    matches: modelId => modelId.startsWith("deepseek-"),
  },
  {
    vendor: "zhipu-cn",
    reason: "zhipu_model_family",
    matches: modelId => modelId.startsWith("glm-"),
  },
  {
    vendor: "qwenai-cn",
    reason: "qwen_model_family",
    matches: modelId => modelId.startsWith("qwen-") || modelId.startsWith("qwen"),
  },
  {
    vendor: "minimax-cn",
    reason: "minimax_model_family",
    matches: modelId => modelId.startsWith("minimax-"),
  },
  {
    vendor: "openai",
    reason: "openai_model_family",
    matches: modelId => modelId.startsWith("gpt-"),
  },
];

export function inferModelVendor(modelId: string): ModelVendorSuggestion | undefined {
  const normalized = modelId.trim().toLowerCase();
  if (!normalized) return undefined;
  const rule = MODEL_VENDOR_RULES.find(item => item.matches(normalized));
  return rule ? {vendor: rule.vendor, reason: rule.reason} : undefined;
}
