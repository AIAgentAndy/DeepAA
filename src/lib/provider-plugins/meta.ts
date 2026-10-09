/**
 * Provider 插件元数据（client-safe 纯数据，docs/上线前架构升级改造.md P1-9）。
 *
 * 「新增官方供应商」的身份信息唯一来源：族标签、套餐适配器映射（vendor 别名 +
 * URL 命中）、自定义供应商 URL 推断规则（族 + 计费通道）。余额/套餐适配器的
 * server 装配在 provider-plugins/index.ts；UI 只 import 本文件，不引入任何
 * server 依赖。
 *
 * 数组顺序即 URL 规则的求值顺序（首个命中胜出）；现有条目的模式互不相交，
 * 新增供应商的模式也必须与既有模式不相交，否则必须显式调整顺序并回归测试。
 */

export interface ProviderPlanRouting {
  /** PlanProviderType（sync-engine/plan-registry 的注册键）。 */
  type: string;
  /** 套餐适配器展示标签（UI planProviderLabel 的唯一来源）。 */
  planLabel: string;
  /** pricing.vendor / presetId 命中该套餐适配器的别名集合（小写）。 */
  vendorAliases: string[];
  /** URL 子串（小写）无条件命中该套餐适配器。 */
  urlNeedles: string[];
  /** URL 子串命中后仍需显式订阅元数据（按量/订阅共用域名）。 */
  subscriptionGatedUrlNeedles?: string[];
}

export interface ProviderPluginMeta {
  /** 同步域稳定 id（SyncProviderType 值域或族级 id）。 */
  id: string;
  /** 展示标签（站点类型下拉 / 族分组标题）。 */
  label: string;
  /** 供应商族（preset-family key）。 */
  family: string;
  /** 是否在 provider-presets.ts 存在官方预设。 */
  hasPreset: boolean;
  /** 套餐适配器路由。 */
  plan?: ProviderPlanRouting;
  /** 自定义供应商 URL → 本族的判定正则源（i）。 */
  urlFamilyPattern?: string;
  /** 自定义供应商 URL → 套餐/订阅通道的判定正则源（i）与通道。 */
  urlChannelPattern?: string;
  urlChannel?: "plan" | "subscription";
}

export const PROVIDER_PLUGINS: readonly ProviderPluginMeta[] = [
  {
    id: "zhipu",
    label: "智谱 GLM",
    family: "zhipu",
    hasPreset: true,
    plan: {
      type: "zhipu",
      planLabel: "智谱 Coding Plan",
      vendorAliases: ["zhipu-cn", "zhipu-global", "zhipu", "zhipu-coding-plan"],
      urlNeedles: ["bigmodel.cn", "api.z.ai"],
    },
    urlFamilyPattern: "bigmodel\\.cn|api\\.z\\.ai",
    urlChannelPattern: "bigmodel\\.cn/api/coding|api\\.z\\.ai/api/coding",
    urlChannel: "plan",
  },
  {
    id: "kimi-coding",
    label: "Kimi / Moonshot",
    family: "kimi",
    hasPreset: true,
    plan: {
      type: "kimi-coding",
      planLabel: "Kimi For Coding",
      vendorAliases: ["moonshot-cn", "moonshot-global", "moonshot", "kimi-coding"],
      urlNeedles: ["moonshot.cn", "api.moonshot", "api.kimi.com/coding"],
    },
    urlFamilyPattern: "api\\.moonshot\\.cn|api\\.kimi\\.com",
    urlChannelPattern: "api\\.kimi\\.com/coding",
    urlChannel: "plan",
  },
  {
    id: "minimax",
    label: "MiniMax",
    family: "minimax",
    hasPreset: true,
    plan: {
      type: "minimax",
      planLabel: "MiniMax Coding Plan",
      vendorAliases: ["minimax-cn", "minimax-global", "minimax", "minimax-plan"],
      urlNeedles: ["minimax"],
    },
    urlFamilyPattern: "api\\.minimaxi?\\.com|api\\.minimax\\.(cn|io)",
  },
  {
    id: "volcengine-plan",
    label: "火山方舟",
    family: "volcengine",
    hasPreset: true,
    plan: {
      type: "volcengine-plan",
      planLabel: "火山方舟 Agent / Coding Plan",
      vendorAliases: ["volcengine-plan", "volcengine-coding-plan"],
      urlNeedles: ["volces.com/api/plan", "volces.com/api/coding"],
    },
    urlFamilyPattern: "volces\\.com",
    urlChannelPattern: "volces\\.com/api/(plan|coding)",
    urlChannel: "plan",
  },
  {
    id: "opencode-go",
    label: "OpenCode Go",
    family: "opencode-go",
    hasPreset: true,
    plan: {
      type: "opencode-go",
      planLabel: "OpenCode Go",
      vendorAliases: ["opencode-go"],
      urlNeedles: ["opencode.ai/zen/go"],
    },
    urlFamilyPattern: "opencode\\.ai/zen/go",
    urlChannelPattern: "opencode\\.ai/zen/go",
    urlChannel: "plan",
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    family: "deepseek",
    hasPreset: true,
    urlFamilyPattern: "api\\.deepseek\\.com",
  },
  {
    id: "openai",
    label: "OpenAI",
    family: "openai",
    hasPreset: true,
    plan: {
      type: "openai-subscription",
      planLabel: "OpenAI 订阅（ChatGPT/Codex）",
      vendorAliases: ["openai"],
      urlNeedles: ["chatgpt.com/backend-api/codex"],
      subscriptionGatedUrlNeedles: ["api.openai.com"],
    },
    urlFamilyPattern: "api\\.openai\\.com|chatgpt\\.com/backend-api/codex",
    urlChannelPattern: "chatgpt\\.com/backend-api/codex",
    urlChannel: "subscription",
  },
  {
    id: "anthropic",
    label: "Anthropic / Claude",
    family: "anthropic",
    hasPreset: true,
    plan: {
      type: "anthropic-subscription",
      planLabel: "Anthropic 订阅（Claude Max/Pro）",
      vendorAliases: ["anthropic"],
      urlNeedles: [],
      subscriptionGatedUrlNeedles: ["api.anthropic.com"],
    },
    urlFamilyPattern: "api\\.anthropic\\.com",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    family: "openrouter",
    hasPreset: true,
    urlFamilyPattern: "openrouter\\.ai",
  },
  {
    id: "siliconflow",
    label: "SiliconFlow（硅基流动）",
    family: "siliconflow",
    hasPreset: true,
    urlFamilyPattern: "api\\.siliconflow\\.(cn|com)",
  },
  {
    id: "qwenai",
    label: "千问 AI",
    family: "qwenai",
    hasPreset: true,
    plan: {
      type: "qwenai-token-plan",
      planLabel: "千问 AI Token Plan",
      // 旧 dashscope 别名只用于读取归一化，不再作为新配置/目录输出。
      vendorAliases: ["qwenai", "qwenai-cn", "qwenai-token-plan", "dashscope-cn", "dashscope"],
      urlNeedles: ["qianwenaiapi.com", "token-plan.maas.qianwenaiapi.com", "token-plan.cn-beijing.maas.aliyuncs.com", "coding.dashscope.aliyuncs.com"],
    },
    urlFamilyPattern: "qianwenaiapi\\.com|dashscope\\.aliyuncs\\.com|token-plan\\.cn-beijing\\.maas\\.aliyuncs\\.com",
    urlChannelPattern: "token-plan\\.maas\\.qianwenaiapi\\.com|coding\\.dashscope\\.aliyuncs\\.com|token-plan\\.cn-beijing\\.maas\\.aliyuncs\\.com",
    urlChannel: "plan",
  },
  {
    id: "tencent-hunyuan",
    label: "腾讯 TokenHub",
    family: "tencent-hunyuan",
    hasPreset: true,
    plan: {
      type: "tencent-tokenhub-plan",
      planLabel: "腾讯 TokenHub Token Plan",
      vendorAliases: ["tencent-tokenhub-plan"],
      urlNeedles: ["lkeap.cloud.tencent.com/plan"],
    },
    urlFamilyPattern: "hunyuan\\.cloud\\.tencent\\.com|api\\.lkeap\\.cloud\\.tencent\\.com",
    urlChannelPattern: "api\\.lkeap\\.cloud\\.tencent\\.com/plan",
    urlChannel: "plan",
  },
];

/** 供应商族标签（派生自插件元数据；preset-family 的唯一来源）。 */
export const PRESET_FAMILY_LABELS_FROM_PLUGINS: Record<string, string> =
  Object.fromEntries(PROVIDER_PLUGINS.map(plugin => [plugin.family, plugin.label]));

/** pricing.vendor / presetId → PlanProviderType 的稳定映射（派生）。 */
export const PLAN_VENDOR_ALIASES_FROM_PLUGINS: Record<string, string> =
  Object.fromEntries(
    PROVIDER_PLUGINS.flatMap(plugin =>
      (plugin.plan?.vendorAliases ?? []).map(alias => [alias, plugin.plan!.type] as const),
    ),
  );

/** 站点类型合法 id 集合（官方插件 + 中转站三件套 + 手动）；供一致性守护使用。 */
export const KNOWN_ACCOUNT_PROVIDER_IDS: ReadonlySet<string> = new Set([
  ...PROVIDER_PLUGINS.map(plugin => plugin.id),
  "newapi",
  "sub2api",
  "relay",
  "manual",
]);

/** 套餐适配器展示标签（派生自 planLabel）。 */
export function planProviderLabelFromPlugins(providerType: string): string {
  if (providerType === "volcengine-coding-plan") return "火山方舟 Coding Plan";
  if (providerType === "qwenai-token-plan") return "千问 AI Token Plan";
  const plugin = PROVIDER_PLUGINS.find(item => item.plan?.type === providerType);
  return plugin?.plan?.planLabel ?? providerType;
}
