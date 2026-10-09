/** 官方供应商预设：公开 URL、协议和同步能力的唯一注册表。 */

import type {PlanProviderType, SyncProviderType} from "@/lib/sync-engine/types";
import type {BillingChannel} from "@/types";

export type OpenAiWireApi = "chat_completions" | "responses";

export type ProviderPlanCapability =
  | {kind: "adapter"; providerType: PlanProviderType; windows: readonly string[]; credential: "api_key" | "access_key" | "oauth"}
  | {kind: "not_applicable"; reason: string};

export interface ProviderAccountCapability {
  providerType: SyncProviderType;
  auth: "api_key" | "http" | "playwright" | "manual" | "access_key";
  balance: "supported" | "unsupported";
}

export interface ProviderPreset {
  id: string;
  name: string;
  /** 计费通道：按量 / 官方套餐 / 订阅账号（B 方案：一个供应商=一个通道）。 */
  billingChannel: BillingChannel;
  /**
   * 预设目录币种（与 llm_catalog 供应商行 currency 同源：cn=CNY、global=USD）。
   * 派生端在目标缺 pricing.settlementCurrency 时按此兜底套餐月费币种（2026-09-28）；
   * 展示端用于「原值 + 人民币括号等值」的换算规则选择。守护测试锁定与目录一致。
   */
  currency: "CNY" | "USD";
  /** 供应商族（如 kimi、zhipu、volcengine），UI 分组与统计归集使用。 */
  vendorFamily: string;
  vendor: string;
  pricingProviderId: string;
  catalogKey: string;
  category: "cn_official" | "global_official" | "official" | "aggregator";
  modelsPublishedAt: string;
  consoleUrl?: string;
  syncProvider?: SyncProviderType;
  openaiUrl?: string;
  anthropicUrl?: string;
  openaiWireApis?: readonly OpenAiWireApi[];
  /**
   * 预设级积分公式声明（2026-10-07 用户确认）：`"none"` = 官方套餐未公开逐请求积分
   * 公式/系数/额度（如火山 Coding Plan）——派生端不落积分列，估算走「市价参考 +
   * 一期量纲守卫 + 二期额度差分回填」管道。缺省 = 跟随价格中心条目公式（Agent Plan、
   * 智谱、OpenCode Go 等精确公式链路不受影响）。与 llm_catalog 预设行由守护测试锁定。
   */
  planCreditFormula?: "none";
  accountSync?: ProviderAccountCapability;
  planSync?: ProviderPlanCapability;
  /**
   * 临时下架标志：置 true 时 ready 为 false，预设不再出现在新建供应商的官方预设
   * 下拉；账号/套餐等能力字段保持完整，存量目标与后端消费链路不受影响。机制修复
   * 后移除该标志即可恢复。
   */
  creationHidden?: boolean;
  ready?: boolean;
  note: string;
}

/** 每个预设的计费通道与供应商族；新增套餐通道预设时在这里登记。 */
const PRESET_CHANNELS: Record<string, {billingChannel: BillingChannel; vendorFamily: string}> = {
  deepseek: {billingChannel: "pay_as_you_go", vendorFamily: "deepseek"},
  "openai-subscription": {billingChannel: "subscription", vendorFamily: "openai"},
  "anthropic-subscription": {billingChannel: "subscription", vendorFamily: "anthropic"},
  "zhipu-cn": {billingChannel: "pay_as_you_go", vendorFamily: "zhipu"},
  "zhipu-coding-plan": {billingChannel: "plan", vendorFamily: "zhipu"},
  "moonshot-cn": {billingChannel: "pay_as_you_go", vendorFamily: "kimi"},
  "kimi-coding": {billingChannel: "plan", vendorFamily: "kimi"},
  "minimax-cn": {billingChannel: "pay_as_you_go", vendorFamily: "minimax"},
  "minimax-plan": {billingChannel: "plan", vendorFamily: "minimax"},
  "volcengine-plan": {billingChannel: "plan", vendorFamily: "volcengine"},
  "volcengine-coding-plan": {billingChannel: "plan", vendorFamily: "volcengine"},
  openrouter: {billingChannel: "pay_as_you_go", vendorFamily: "openrouter"},
  siliconflow: {billingChannel: "pay_as_you_go", vendorFamily: "siliconflow"},
  qwenai: {billingChannel: "pay_as_you_go", vendorFamily: "qwenai"},
  "qwenai-token-plan": {billingChannel: "plan", vendorFamily: "qwenai"},
  "tencent-tokenhub": {billingChannel: "pay_as_you_go", vendorFamily: "tencent-hunyuan"},
  "tencent-tokenhub-plan": {billingChannel: "plan", vendorFamily: "tencent-hunyuan"},
  "opencode-go": {billingChannel: "plan", vendorFamily: "opencode-go"},
};

/**
 * 每个预设的目录币种（llm_catalog 供应商行 currency 的注册表镜像；共享 catalogKey
 * 的预设取同一值）。这是静态注册数据：派生 Worker 只读 proxy-config 与本注册表、
 * 不加载目录文件，币种兜底必须有代码内来源；与目录的一致性由守护测试锁定。
 */
const PRESET_CURRENCIES: Record<string, "CNY" | "USD"> = {
  deepseek: "CNY",
  "openai-subscription": "USD",
  "anthropic-subscription": "USD",
  "zhipu-cn": "CNY",
  "zhipu-coding-plan": "CNY",
  "moonshot-cn": "CNY",
  "kimi-coding": "CNY",
  "minimax-cn": "CNY",
  "minimax-plan": "CNY",
  "volcengine-plan": "CNY",
  "volcengine-coding-plan": "CNY",
  openrouter: "USD",
  siliconflow: "CNY",
  qwenai: "CNY",
  "qwenai-token-plan": "CNY",
  "tencent-tokenhub": "CNY",
  "tencent-tokenhub-plan": "CNY",
  "opencode-go": "USD",
};

export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  // 2026-09-29 用户确认：中国区 vendor key 加 -cn 后缀（deepseek→deepseek-cn、qwenai→qwenai-cn），
  // 与 LiteLLM/未来美元区官方预设的 vendor key（deepseek/qwenai，USD）保持隔离，价格中心按币种语义分开落库。
  preset("deepseek", "DeepSeek（官方）", "deepseek-cn", "official", {openaiUrl: "https://api.deepseek.com", anthropicUrl: "https://api.deepseek.com/anthropic", openaiWireApis: ["chat_completions", "responses"], consoleUrl: "https://api.deepseek.com", syncProvider: "deepseek", accountSync: {providerType: "deepseek", auth: "api_key", balance: "supported"}, planSync: {kind: "not_applicable", reason: "DeepSeek 暂无 Coding Plan 用量接口"}}, "OpenAI 与 Anthropic 协议（均原生支持 Responses）；flash 系列当前主力模型为 deepseek-flash（DeepSeek-V4.1-Flash）。官方已撤销「deepseek-v4-pro 于 2026-09-14 起路由至 Flash 计费」的下线计划（2026-09-10 公告后于更新日志撤回）：V4 Pro 继续独立提供 API 且计费不变，目录 v4-pro 价格为现行独立价（2026-09-30 官网核对）"),
  preset("zhipu-cn", "智谱 GLM（中国区）", "zhipu-cn", "cn_official", {openaiUrl: "https://open.bigmodel.cn/api/paas/v4", anthropicUrl: "https://open.bigmodel.cn/api/anthropic", openaiWireApis: ["chat_completions"], consoleUrl: "https://open.bigmodel.cn", syncProvider: "zhipu", accountSync: {providerType: "zhipu", auth: "api_key", balance: "supported"}, planSync: {kind: "adapter", providerType: "zhipu", windows: ["5h", "weekly"], credential: "api_key"}}, "OpenAI Chat 与 Anthropic Messages"),
  preset("moonshot-cn", "Kimi / Moonshot（中国区）", "moonshot-cn", "cn_official", {openaiUrl: "https://api.moonshot.cn/v1", anthropicUrl: "https://api.moonshot.cn/anthropic", openaiWireApis: ["chat_completions"], consoleUrl: "https://platform.kimi.com", syncProvider: "kimi-coding", accountSync: {providerType: "kimi-coding", auth: "api_key", balance: "supported"}, planSync: {kind: "adapter", providerType: "kimi-coding", windows: ["5h", "weekly", "monthly"], credential: "api_key"}}, "OpenAI Chat 与 Anthropic Messages；官方文档站已更名 platform.kimi.com（API 主机 api.moonshot.cn 不变；余额接口固定走 api.moonshot.cn——platform 域 /v1 路径不提供 API，2026-09-30 实测 301→kimi.com 404）"),
  preset("minimax-cn", "MiniMax（中国区）", "minimax-cn", "cn_official", {openaiUrl: "https://api.minimax.cn/v1", anthropicUrl: "https://api.minimax.cn/anthropic", openaiWireApis: ["chat_completions", "responses"], consoleUrl: "https://platform.minimax.cn", syncProvider: "minimax", accountSync: {providerType: "minimax", auth: "manual", balance: "unsupported"}, planSync: {kind: "adapter", providerType: "minimax", windows: ["5h", "weekly"], credential: "api_key"}}, "OpenAI Chat/Responses 与 Anthropic Messages；官方 Codex 文档确认 /v1 原生支持 Responses；官方套餐现称 Token Plan（2026-09-29 起 M Plan 上线承接、Token Plan 停止新购，存量自动续费不变）；域名体系主推 minimax.cn（api.minimaxi.com 仍在线兼容，2026-09-30 预设端点切换至 .cn）"),
  preset("volcengine-plan", "火山方舟 Agent Plan（中国区）", "volcengine-plan", "cn_official", {openaiUrl: "https://ark.cn-beijing.volces.com/api/plan/v3", anthropicUrl: "https://ark.cn-beijing.volces.com/api/plan", openaiWireApis: ["chat_completions", "responses"], consoleUrl: "https://console.volcengine.com/ark", syncProvider: "volcengine-plan", accountSync: {providerType: "volcengine-plan", auth: "manual", balance: "unsupported"}, planSync: {kind: "adapter", providerType: "volcengine-plan", windows: ["5h", "weekly", "monthly"], credential: "access_key"}}, "Agent Plan（2026-09 档位换代：Small ¥40/Medium ¥200/Large ¥500/Max ¥1000，月度 AFP 额度制）OpenAI Chat/Responses 与 Anthropic Messages；官方 Codex 文档确认 /api/plan/v3 原生支持 Responses；限时活动：deepseek-v4.1-flash 抵扣 5 折至 2026-10-30 18:00、kimi-k2.8-preview 6 折（8→4.8）至 2026-10-14（2026-09-30 核对）"),
  preset("openrouter", "OpenRouter", "openrouter", "aggregator", {openaiUrl: "https://openrouter.ai/api/v1", anthropicUrl: "https://openrouter.ai/api/v1", openaiWireApis: ["chat_completions", "responses"], consoleUrl: "https://openrouter.ai", syncProvider: "openrouter", accountSync: {providerType: "openrouter", auth: "api_key", balance: "supported"}, planSync: {kind: "not_applicable", reason: "OpenRouter 按 credits/usage 计费，无独立 Coding Plan"}}, "OpenRouter Chat、Responses 与 Messages"),
  preset("siliconflow", "SiliconFlow（硅基流动）", "siliconflow", "aggregator", {openaiUrl: "https://api.siliconflow.cn/v1", anthropicUrl: "https://api.siliconflow.cn/v1", openaiWireApis: ["chat_completions"], consoleUrl: "https://www.siliconflow.cn", syncProvider: "siliconflow", accountSync: {providerType: "siliconflow", auth: "manual", balance: "unsupported"}, planSync: {kind: "not_applicable", reason: "SiliconFlow 暂无 Coding Plan"}}, "OpenAI Chat 与 Anthropic Messages；官方 /v1/user/info 余额接口已于 2026-08-14 下线且无替代（2026-09-29 调研确认），余额请在官方控制台查看；目录已换代为 V4-Flash/V4-Pro/GLM-5.3/Kimi-K2.7-Code/Qwen3.8-27B/Hy4-preview；官方 Anthropic 兼容端点 /v1/messages 已上线（支持 tool_use/thinking/SSE，2026-10-05 docs.siliconflow.cn 核对，预设 anthropicUrl 即 api.siliconflow.cn/v1）"),
  preset("qwenai", "千问 AI", "qwenai-cn", "cn_official", {openaiUrl: "https://maas.qianwenaiapi.com/compatible-mode/v1", anthropicUrl: "https://maas.qianwenaiapi.com/apps/anthropic", openaiWireApis: ["chat_completions", "responses"], consoleUrl: "https://platform.qianwenai.com", syncProvider: "qwenai", accountSync: {providerType: "qwenai", auth: "manual", balance: "unsupported"}, planSync: {kind: "not_applicable", reason: "该预设代表标准按量 API；Token Plan 使用独立套餐通道"}}, "千问 AI 标准 API Chat、Responses 与 Messages；模型与价格以千问 AI 官方目录为准"),
  preset("opencode-go", "OpenCode Go", "opencode-go", "aggregator", {openaiUrl: "https://opencode.ai/zen/go/v1", anthropicUrl: "https://opencode.ai/zen/go/v1", openaiWireApis: ["chat_completions", "responses"], consoleUrl: "https://opencode.ai/zen/go", syncProvider: "opencode-go", accountSync: {providerType: "opencode-go", auth: "manual", balance: "unsupported"}, planSync: {kind: "adapter", providerType: "opencode-go", windows: ["5h", "weekly", "monthly"], credential: "api_key"}}, "按模型族支持 Chat、Responses 或 Anthropic Messages（模型与价格以 https://opencode.ai/docs/go/ 官方文档为准）；套餐两档 Go $10/Go Plus $40，额度为按模型月度美元限额（5h=月限 20%、周=50%、月=100%）"),
  preset("openai-subscription", "OpenAI 订阅（ChatGPT/Codex OAuth）", "openai", "global_official", {catalogKey: "openai", openaiUrl: "https://chatgpt.com/backend-api/codex", openaiWireApis: ["responses"], consoleUrl: "https://chatgpt.com", syncProvider: "openai", accountSync: {providerType: "openai", auth: "manual", balance: "unsupported"}, planSync: {kind: "adapter", providerType: "openai-subscription", windows: ["5h", "weekly"], credential: "oauth"}}, "订阅通道：客户端 OAuth 透传，登录/刷新由 Codex 官方 CLI 维护；用量同步只读本机登录态；官方用量窗口为 5 小时 + 周两层（无月度窗口，2026-09-30 developers.openai.com/codex/pricing 口径）；官方档位命名为 Pro 100/200/500（$500 档官方倍率口径为 25× Plus）；Pro 200 已于 DevDay 2026-09-29 重开新订，新订户额度与老订户不同（官方未公布新订户倍率，2026-10-05 community.openai.com 官方员工帖核对）"),
  preset("anthropic-subscription", "Anthropic 订阅（Claude Max/Pro OAuth）", "anthropic", "global_official", {catalogKey: "anthropic", anthropicUrl: "https://api.anthropic.com", consoleUrl: "https://claude.ai", syncProvider: "anthropic", accountSync: {providerType: "anthropic", auth: "manual", balance: "unsupported"}, planSync: {kind: "adapter", providerType: "anthropic-subscription", windows: ["5h", "weekly"], credential: "oauth"}, creationHidden: true}, "订阅通道：客户端 OAuth 透传，登录/刷新由 Claude Code 官方 CLI 维护；用量同步只读本机登录态。预设机制待修复，暂不进入新建下拉（2026-10-09，存量目标不受影响）"),
  preset("zhipu-coding-plan", "智谱 GLM Coding Plan（中国区）", "zhipu-cn", "cn_official", {catalogKey: "zhipu-cn", openaiUrl: "https://open.bigmodel.cn/api/coding/paas/v4", anthropicUrl: "https://open.bigmodel.cn/api/anthropic", openaiWireApis: ["chat_completions"], consoleUrl: "https://open.bigmodel.cn", syncProvider: "zhipu", accountSync: {providerType: "zhipu", auth: "manual", balance: "unsupported"}, planSync: {kind: "adapter", providerType: "zhipu", windows: ["5h", "weekly"], credential: "api_key"}}, "GLM Coding Plan 套餐通道，用量同步走智谱 Coding Plan 适配器；积分口径（2026-09 官网改版，2026-09-30 核对）：非高峰=基础积分 50%、高峰（每周一至周五 14:00-18:00）1 倍（原 GLM-5.3 ×3 / Flash 专属 0.4/1.2 旧口径已移除，两模型统一系数链）；GLM-5.3 系数 6.9/24/1.7、Flash 2.3/8/0.56；双节活动（09-25 至 10-07）全天按非高峰；官方套餐当前仅直接支持 GLM-5.3 与 GLM-5.3-Flash，历史 GLM-5-Turbo/GLM-4.7 自动切换至 GLM-5.3-Flash、GLM-5.2/GLM-5.1 自动切换至 GLM-5.3；官方另提供 Responses 协议端点 open.bigmodel.cn/api/v1（暂未纳入预设 wireApis）"),
  preset("kimi-coding", "Kimi For Coding（中国区）", "moonshot-cn", "cn_official", {openaiUrl: "https://api.kimi.com/coding/v1", anthropicUrl: "https://api.kimi.com/coding/", openaiWireApis: ["chat_completions", "responses"], consoleUrl: "https://platform.kimi.com", syncProvider: "kimi-coding", accountSync: {providerType: "kimi-coding", auth: "manual", balance: "unsupported"}, planSync: {kind: "adapter", providerType: "kimi-coding", windows: ["5h", "weekly", "monthly"], credential: "api_key"}}, "Kimi For Coding 套餐通道（品牌已演变为 Kimi Code，端点不变）：官方 Codex 接入文档确认 /coding/v1 原生支持 OpenAI Responses API（wire_api=responses，2026-10-02 调研确认）；模型 ID 现有 kimi-for-coding（上游已升级解析为 K2.8 Preview、2026-09-11 全量上线）、k3（含 k3-256k 变体）、kimi-for-coding-highspeed；会员档位 2026-09 改版：新档 Go（免费）/Plus/Pro 上线（价格仅 App 内展示，公开后补录），新会员无周额度、仅 5h+月额度；老会员保留 Andante/Moderato/Allegretto/Allegro 四档（49/99/199/699 元）与周额度；新档门禁 Pro+ 解锁 k3 1M 上下文（2026-10-02 补记）"),
  preset("minimax-plan", "MiniMax Token Plan（中国区）", "minimax-cn", "cn_official", {catalogKey: "minimax-cn", openaiUrl: "https://api.minimax.cn/v1", anthropicUrl: "https://api.minimax.cn/anthropic", openaiWireApis: ["chat_completions", "responses"], consoleUrl: "https://platform.minimax.cn", syncProvider: "minimax", accountSync: {providerType: "minimax", auth: "manual", balance: "unsupported"}, planSync: {kind: "adapter", providerType: "minimax", windows: ["5h", "weekly"], credential: "api_key"}}, "MiniMax Token Plan 套餐通道（2026-09-29 官方公告：M Plan 上线承接并拓展 Token Plan、价格与文本额度保持不变，Token Plan 停止新购、存量自动续费保留），与按量供应商共享同一上游 URL（按计费通道区分）；原生支持 Responses；窗口口径为 5 小时固定窗口 + 周（非滚动，2026-09-30 官方 FAQ）；用量接口主链 www/api.minimax.cn 的 token_plan/remains（minimaxi.com 兜底）"),
  preset("volcengine-coding-plan", "火山方舟 Coding Plan（中国区）", "volcengine-plan", "cn_official", {catalogKey: "volcengine-plan", openaiUrl: "https://ark.cn-beijing.volces.com/api/coding/v3", anthropicUrl: "https://ark.cn-beijing.volces.com/api/coding", openaiWireApis: ["chat_completions", "responses"], consoleUrl: "https://console.volcengine.com/ark", syncProvider: "volcengine-coding-plan", accountSync: {providerType: "volcengine-plan", auth: "manual", balance: "unsupported"}, planSync: {kind: "adapter", providerType: "volcengine-coding-plan", windows: ["5h", "weekly", "monthly"], credential: "access_key"}, planCreditFormula: "none"}, "火山方舟 Coding Plan 独立套餐通道，适配器与 Agent Plan 分离但共享 AFP 规则基础设施；官方未公开 Coding Plan 积分公式/系数/额度（2026-10-07 官网核对：AFP 抵扣规则页属 Agent Plan 计费说明，Coding Plan 文档树无计费说明节），按无公式供应商处理——不落积分列，估算走市价参考 + 额度差分回填"),
  preset("qwenai-token-plan", "千问 AI Token Plan", "qwenai-cn", "cn_official", {catalogKey: "qwenai", openaiUrl: "https://token-plan.maas.qianwenaiapi.com/compatible-mode/v1", anthropicUrl: "https://token-plan.maas.qianwenaiapi.com/apps/anthropic", openaiWireApis: ["chat_completions"], consoleUrl: "https://platform.qianwenai.com", syncProvider: "qwenai-token-plan", accountSync: {providerType: "qwenai", auth: "manual", balance: "unsupported"}, planSync: {kind: "adapter", providerType: "qwenai-token-plan", windows: ["monthly"], credential: "api_key"}}, "千问 AI Token Plan 套餐通道，使用 sk-sp- 专属 API Key 与 token-plan.maas.qianwenaiapi.com 专属 Base URL；个人版 usage 查询无稳定公开 API 时明确降级控制台查看"),
  preset("tencent-tokenhub", "腾讯 TokenHub（按量）", "tencent-tokenhub", "cn_official", {openaiUrl: "https://api.lkeap.cloud.tencent.com/v1", openaiWireApis: ["chat_completions"], consoleUrl: "https://console.cloud.tencent.com/tokenhub", accountSync: {providerType: "tencent-hunyuan", auth: "manual", balance: "unsupported"}, planSync: {kind: "not_applicable", reason: "按量通道无套餐用量，额度与账单在官方控制台查看"}}, "TokenHub API 市场按量通道（广州地域，独立按量 API Key，OpenAI 兼容 Chat Completions）；官方按量数据面主域名已迁 tokenhub.tencentmaas.com/v1（支持有限模型 Responses 与 Anthropic Messages，另有 .cn 备用与 -intl 国际域、不支持跨地域调用），lkeap 旧域名仍在线（现承载套餐端点 plan/v3）、预设端点暂不切换（2026-09-30 二次核对修正拼写）；deepseek 系按量价含闲忙双档（deepseek/deepseek-flash 高峰 2/8/0.04、空闲 1/4/0.02）；与 Token Plan 套餐通道按计费通道区分、共享目录价格"),
  preset("tencent-tokenhub-plan", "腾讯 TokenHub Token Plan（个人版）", "tencent-tokenhub-plan", "cn_official", {catalogKey: "tencent-tokenhub", openaiUrl: "https://api.lkeap.cloud.tencent.com/plan/v3", anthropicUrl: "https://api.lkeap.cloud.tencent.com/plan/anthropic", openaiWireApis: ["chat_completions"], consoleUrl: "https://console.cloud.tencent.com/tokenhub/tokenplan", syncProvider: "tencent-tokenhub-plan", accountSync: {providerType: "tencent-hunyuan", auth: "manual", balance: "unsupported"}, planSync: {kind: "adapter", providerType: "tencent-tokenhub-plan", windows: ["monthly"], credential: "access_key"}}, "仅 OpenAI Chat 与 Anthropic Messages（按量新数据面 tokenhub.tencentmaas.com/v1 已支持有限模型 Responses，套餐端点暂不跟进）；通用/Hy 两系列共用端点与 Key（sk-tp-）；套餐用量经腾讯云 OpenAPI（host tokenhub.tencentcloudapi.com、版本 2026-03-22）DescribeTokenPlanList → DescribeTokenPlan 查询月度积分池——官方契约面向企业版（必填 TeamId），个人版无公开查询接口：同步失败属预期、请到控制台查看额度（2026-09-30 确认保留适配器供企业版与实测可查场景，公共降级路径不变）；积分制 token_weighted 系数（planFactors=官方积分价，divisor 1e6）与按量市价链（priceSchedules 闲忙）彻底解耦"),
];

/** 按同步适配器类型读取官方预设账号能力，供 UI 与服务端统一判断余额能力。 */
export function resolveProviderAccountCapability(providerType: SyncProviderType): ProviderAccountCapability | undefined {
  return PROVIDER_PRESETS.find(preset => preset.accountSync?.providerType === providerType)?.accountSync;
}

/**
 * 预设目录币种兜底（2026-09-28 用户确认）：目标缺 pricing.settlementCurrency 时，
 * 官方预设目标按预设目录币种推导（cn→CNY、global→USD）；自定义目标（无 presetId）
 * 返回 undefined，维持缺省 CNY 语义。用于套餐月费币种解析与展示层换算规则选择。
 */
export function derivePresetCurrency(preset: ProviderPreset | undefined): "CNY" | "USD" | undefined {
  return preset?.currency;
}

/**
 * 套餐月费币种解析（2026-09-28 修复 P0）：显式 settlementCurrency 优先；缺失时按
 * 官方预设目录币种兜底（cn→CNY、global→USD，如存量 OpenCode Go $10 曾被当 ¥10
 * 低估约 fx 倍）；无 presetId 的自定义目标返回 undefined（写入端负责补币种，
 * 派生端维持缺省 CNY 语义）。非法显式值（非 CNY/USD）按缺失处理。
 */
export function resolvePlanFeeCurrency(input: {
  explicit?: string | null;
  preset?: ProviderPreset;
}): "CNY" | "USD" | undefined {
  if (input.explicit === "CNY" || input.explicit === "USD") return input.explicit;
  return derivePresetCurrency(input.preset);
}

function preset(
  id: string,
  name: string,
  pricingProviderId: string,
  category: ProviderPreset["category"],
  // endpoints 支持可选 catalogKey：套餐/订阅通道复用基础供应商目录（模型与价格同源）。
  endpoints: Pick<ProviderPreset, "openaiUrl" | "anthropicUrl" | "openaiWireApis" | "consoleUrl" | "syncProvider" | "accountSync" | "planSync" | "planCreditFormula" | "creationHidden"> & {catalogKey?: string},
  note: string,
): ProviderPreset {
  const channel = PRESET_CHANNELS[id];
  if (!channel) throw new Error(`Provider preset channel metadata missing: ${id}`);
  const currency = PRESET_CURRENCIES[id];
  if (!currency) throw new Error(`Provider preset currency metadata missing: ${id}`);
  return {
    id,
    name,
    vendor: pricingProviderId,
    pricingProviderId,
    category,
    currency,
    modelsPublishedAt: "2026-09-04",
    ...endpoints,
    catalogKey: endpoints.catalogKey || id,
    billingChannel: channel.billingChannel,
    vendorFamily: channel.vendorFamily,
    ready: Boolean(endpoints.accountSync && endpoints.planSync) && !endpoints.creationHidden,
    note,
  };
}
