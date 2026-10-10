/**
 * DeepAA — Core Type Definitions
 *
 * 仅保留与新 UI（Harness Workbench）和代理配置相关的共享类型。
 * 旧的双数据模型（过渡类型）
 * 已在阶段一清理中移除，代理直接构造单一原始抓包模型。
 */

// ─── Session ─────────────────────────────────────────────────────────────────

export interface SessionMeta {
  id: string;
  provider: string;
  label: string;
  sessionKey?: string;
  sessionDate?: string;
  model?: string;
  targetNames?: string[];
  generation?: number;
  startTime: string;
  lastActivityTime: string;
  turnCount: number;
  fileSize?: number;
  filePath?: string;
}

// ─── Content Blocks ──────────────────────────────────────────────────────────

export type ContentBlock =
  | ThinkingBlock
  | TextBlock
  | ToolUseBlock
  | ToolResultBlock;

export interface ThinkingBlock {
  type: "thinking";
  thinking?: string;
}

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: "tool_result";
  toolUseId: string;
  content: string | ContentBlock[];
  isError?: boolean;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  cacheCreation5mTokens?: number;
  cacheCreation1hTokens?: number;
  totalTokens: number;
}

// ─── Proxy Config ───────────────────────────────────────────────────────────

export type ProxyFormat = "anthropic" | "openai";

/** 协议族：openai / anthropic；与具体 wire API 分离。 */
export type WireProtocol = "openai" | "anthropic";

/** 真实 wire API：responses、chat_completions、messages。 */
export type WireApi = "responses" | "chat_completions" | "messages";

/** 模型输入模态（2026-09-21 能力下发）：目录声明、价格中心投影、各 Agent 按自身 schema 能力映射。 */
export type InputModality = "text" | "image" | "audio";

/** GET /v1/models 合成响应的输出格式。 */
export type ModelsResponseFormat = "openai" | "anthropic";

/**
 * 计费通道类型：一个代理供应商只代表一个计费通道（B 方案）。
 * pay_as_you_go=按量 API；plan=官方套餐（Coding/Token/Agent Plan）；subscription=订阅账号通道。
 */
export type BillingChannel = "pay_as_you_go" | "plan" | "subscription";

/**
 * Agent 大类标识，由 KNOWN_AGENT_IDS 唯一常量推导；
 * 新增 Agent 只改常量，类型与网关 /{agent}/v1 路径自动扩展。
 */
export const KNOWN_AGENT_IDS = ["codex", "claude", "opencode", "dsh", "zcode"] as const;
export type AgentId = typeof KNOWN_AGENT_IDS[number];

/** 可参与密钥/模型适用的 Agent 范围（与 KNOWN_AGENT_IDS 同一常量派生）。 */
export const KNOWN_AGENT_IDS_ALL: readonly AgentId[] = KNOWN_AGENT_IDS;

/**
 * 判断字符串是否为已知 Agent ID。
 * 未知值（未来 Agent）允许透传保留，但不参与当前网关过滤语义。
 */
export function isKnownAgentId(value: string): value is AgentId {
  return (KNOWN_AGENT_IDS as readonly string[]).includes(value);
}

/**
 * 归一化适用 Agent 列表：缺省与空数组都表示“不允许任何 Agent”（默认拒绝）；
 * 未知 Agent 直接丢弃，避免透传未知值绕过网关白名单。保存 API 仍应单独拒绝未知值。
 */
export function normalizeAgentScope(value: unknown): AgentId[] {
  if (!Array.isArray(value)) return [];
  const agents = value
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0 && item.length <= 32)
    .map(item => item.trim())
    .filter((item): item is AgentId => isKnownAgentId(item));
  return [...new Set(agents)];
}

/** 判断某适用 Agent 列表是否包含指定 Agent；缺省/空数组一律不允许。 */
export function agentScopeIncludes(scope: readonly string[] | undefined, agent: string): boolean {
  return Array.isArray(scope) && scope.includes(agent);
}

/** 四价稀疏覆盖集（fast 档价/促销价/长上下文绝对档位价共用）：未声明字段沿用下层解析值。 */
export interface SparsePricingRates {
  input?: number;
  output?: number;
  cachedInput?: number;
  cacheWrite?: number;
  cacheWrite5m?: number;
  cacheWrite1h?: number;
}

/** 长上下文阶梯：输入侧合计超过阈值时整单换档（whole_request，与 sub2api/new-api 规则一致）。 */
export interface LongContextPricingTier {
  /** 阈值 token 数（判定量=净输入+缓存读+缓存写，不含输出）。 */
  thresholdTokens: number;
  /** 输入侧（含缓存读/写）倍率，如 2.0。 */
  inputMultiplier: number;
  /** 输出侧（含 reasoning 单价）倍率，如 1.5。 */
  outputMultiplier: number;
  /** 可选绝对档位价（字段级）：声明字段直接用绝对值、不再乘倍率；未声明字段仍按倍率换算。 */
  rates?: SparsePricingRates;
}

export interface ProxyTargetPricingRates {
  /** 非缓存输入或 cache miss 输入，单位：美元/百万 token。 */
  input: number;
  /** 输出 token，单位：美元/百万 token。 */
  output: number;
  /** cache hit / cache read 输入，单位：美元/百万 token。 */
  cachedInput?: number;
  /** cache write / cache creation 输入，单位：美元/百万 token。 */
  cacheWrite?: number;
  cacheWrite5m?: number;
  cacheWrite1h?: number;
  /** 推理 token 独立计费价，单位：美元/百万 token。 */
  reasoning?: number;
  /** 长上下文阶梯（可选）：超过阈值整单换档。 */
  longContext?: LongContextPricingTier;
}

/** 时段费率窗口：按 IANA 时区的星期与本地时刻匹配。 */
export interface TemporalPriceScheduleWindow {
  /** 0=周一 ... 6=周日；缺省表示每天生效。 */
  days?: number[];
  /** 本地时区 "HH:mm"；end 可为 "24:00"（表示当天最后一分钟之后）。 */
  start: string;
  end: string;
  /** 命中日期（YYYY-MM-DD，窗口时区本地日期）：includeHolidays 编译解析产物，命中即无视 days/时刻匹配。 */
  includeDates?: string[];
  /** 排除日期（YYYY-MM-DD）：excludeHolidays 编译解析产物，命中即本窗口不匹配。 */
  excludeDates?: string[];
}

/** 模型/覆盖级时段费率：base 保持基础价（高峰），窗口内使用 rates。 */
export interface TemporalPriceSchedule {
  /** IANA 时区，缺省 "Asia/Shanghai"。 */
  timezone?: string;
  /** 展示标签，如 "闲时"。 */
  label: string;
  windows: TemporalPriceScheduleWindow[];
  rates: ProxyTargetPricingRates;
  /** 节假日日期（YYYY-MM-DD，按 schedule 时区判断）；命中节假日一律按本时段费率计费。 */
  holidays?: string[];
}

export interface ProxyTargetModelPricingOverride {
  id: string;
  /** 当前供应商目标白名单中的模型键；与价格中心 runtimeModelId 分开。 */
  targetModelId: string;
  pricing: ProxyTargetPricingRates;
  /** 时段费率：支持分别覆盖高峰基础价与闲时窗口价；缺省表示固定覆盖。 */
  priceSchedules?: TemporalPriceSchedule[];
  currency?: string;
  /** relay_synced：历史中转站同步价（2026-09-03 移除该链路；枚举保留以解析旧配置，读取时被剔除）。 */
  confidence?: "user_override" | "third_party" | "provider_docs" | "relay_synced";
  sourceUrl?: string;
  sourceCheckedAt?: string;
  notes?: string;
}

/** 支持模型到价格中心的唯一映射：选模型时从价格中心条目落库，用于同名模型跨供应商消歧。 */
export interface ProxyTargetModelVendor {
  /** 价格中心条目的供应商（vendor 或 litellmProvider）。 */
  vendor?: string;
  /** 价格中心条目的唯一 ID；同名模型存在多个供应商条目时以此为准。 */
  priceEntryId?: string;
}

export interface ProxyTargetPricingPolicy {
  /**
   * 该代理供应商对应的模型供应商。只用于价格中心匹配同名模型，
   * 不改变真实请求路由，也不会写入上游请求。
   */
  vendor?: string;
  /**
   * 供应商套餐月费：官方目录牌价的原始币种数值（币种随 settlementCurrency，
   * 如 OpenCode Go 10 = 10 USD、智谱 430.4 = 430.4 CNY）。录入时不得预先折算。
   */
  planMonthlyFee?: number;
  /**
   * 套餐档位 id（2026-09-30 OpenCode Go）：上游 usage 接口不返回档位标识，
   * 由用户在套餐同步配置中显式选择（目录 planTiers id，如 go/go-plus）；
   * market_share 估算按「条目 × 档位」解析模型月度额度作分母。
   */
  planTier?: string;
  /**
   * 套餐付款周期（2026-10-10 智谱 Coding Plan）：目录档位 billingCycles 键
   * （monthly/quarterly/yearly）。与 planTier/套餐名匹配一起决定目录折算月价
   * （如 Pro 按季 430.4/月），作为套餐同步月费自动回填的取价依据；
   * 不影响已手动录入的月费（回填守卫仍以 planMonthlyFee 为准）。
   */
  planBillingCycle?: "monthly" | "quarterly" | "yearly";
  currency?: string;
  /**
   * 结算展示币种元数据（2026-09-15 名实收口）：官方预设带出——cn 区 CNY、global 区 USD、
   * 中转站按 USD 记账（牌价数字）。只用于套餐月费币种判定与展示，不参与按量换算。
   */
  settlementCurrency?: "CNY" | "USD";
  /**
   * 结算系数（计价数字 → 实际人民币）：显式配置时优先于默认规则。
   * 默认规则：CNY 条目=1；官方全球预设（openai/anthropic/openrouter/opencode-go）
   * =价格版本 fx 快照；中转站/自定义=1（美元牌价数字即人民币，1:1 站点惯例）。
   * 按真实美元汇率结算的中转站在此显式覆盖（如 7.1）。
   */
  settlementFx?: number;
  modelOverrides?: ProxyTargetModelPricingOverride[];
  /** 支持模型 → 价格中心条目映射；保存时由所选价格中心条目落库，避免同名模型歧义。 */
  modelVendors?: Record<string, ProxyTargetModelVendor>;
}

export interface ProxyTargetDevelopmentSettings {
  /**
   * Agent 级默认凭据引用。这里只保存系统凭据 ID，不包含真实密钥；
   * 显式值必须归属当前供应商且允许对应 Agent 使用。
   */
  defaultCredentials?: Partial<Record<AgentId, string>>;
  /**
   * Agent 级默认模型。显式值必须命中 supportedModels，且模型适用允许对应 Agent 使用。
   */
  defaultModels?: Partial<Record<AgentId, string>>;
  /** 当前平台已知终端 ID；启动时仍会重新校验可用性。 */
  preferredTerminal?: string;
  /** 最近一次在该代理供应商下成功启动开发时使用的项目目录（仅 CLI 模式记录，用于下次弹窗预填）。 */
  lastProjectDir?: string;
}

export interface AgentModelAliases {
  opus?: string;
  sonnet?: string;
  haiku?: string;
}

/**
 * Agent 级启动偏好：开发启动弹窗高级设置的可持久化默认值。
 * 只服务 config-sync 受管配置与弹窗默认展示，绝不包含任何密钥；
 * 模型能力类覆盖（上下文窗口/压缩阈值/推理档）统一经该字段写入受管配置
 * （codex → 模型目录条目，zcode/dsh/opencode → 各自受管模型条目）。
 */
export interface AgentLaunchPreferences {
  /** 默认推理强度：值域由所选模型目录档位约束（适配器按模型档位校验后写入）。 */
  reasoningEffort?: string;
  /** 权限/沙箱预设：当前仅 dsh 使用（read-only / workspace-write / danger-full-access）。 */
  permissionMode?: string;
  /** 按网关模型 ID（<模型ID>_<目标路由ID>）覆盖上下文窗口（token 数）；同一模型跨目标可各自覆盖。 */
  contextWindows?: Record<string, number>;
  /** 按网关模型 ID 覆盖自动压缩阈值（token 数）；仅 codex 目录条目消费，缺省取窗口×95%。 */
  autoCompactTokenLimits?: Record<string, number>;
}

/** Agent 的显式接入设置；该对象存在即表示已接入。 */
export interface AgentConnectionSettings {
  /** 显式接入的供应商集合；与 defaultTargetId 分离，默认供应商不能代表全部接入关系。 */
  boundTargetIds?: string[];
  /** Agent 是否参与当前产品的代理配置；缺省按旧 V3 数据视为已接入。 */
  enabled?: boolean;
  /** Agent 的全局默认代理供应商；缺失表示已接入但仍待配置。 */
  defaultTargetId?: string;
  /** 是否把 DeepAA 受管配置同步到该 Agent 的 CLI 配置文件。 */
  cliSyncEnabled: boolean;
  /** Claude Code 的全局模型别名；其它 Agent 不使用。 */
  modelAliases?: AgentModelAliases;
  /** OpenCode 首期新增：默认 wire API 偏好；必须命中已注册 binding 且默认供应商具备对应协议 URL。 */
  preferredWireApi?: WireApi;
  /** 开发启动高级设置的可持久化偏好（推理强度/权限模式/按模型上下文窗口）。 */
  launchPreferences?: AgentLaunchPreferences;
}

export interface ProxyTarget {
  id: string;
  name: string;
  /** 创建时命中的官方预设；URL 被用户改写后必须清除。 */
  presetId?: string;
  /** 计费通道类型；缺省由预设/URL 推断，仅作展示与统计归集，不改变网关路由。 */
  billingChannel?: BillingChannel;
  /**
   * 网关凭据模式：passthrough 表示透传客户端自带凭据（如 ZCode 登录态），
   * 网关不注入、不要求系统默认密钥；缺省 = inject 按系统凭据库注入。
   * 仅在 Agent binding 声明 supportsSubscription 时可用（复用订阅透传门禁）。
   */
  credentialMode?: "passthrough";
  /** 供应商族（如 kimi、zhipu、volcengine）；同族供应商在 UI 分组展示并按此归集统计。 */
  vendorFamily?: string;
  /** OpenAI 协议上游 URL；未配置时该供应商不参与 Codex 网关同步与 /v1/responses 路由。 */
  openaiUrl?: string;
  /** Anthropic 协议上游 URL；未配置时该供应商不参与 Claude Code 网关同步与 /v1/messages 路由。 */
  anthropicUrl?: string;
  enabled: boolean;
  createdAt?: string;
  updatedAt?: string;
  /** 网关模式允许使用的 Agent 可见模型；空数组表示未启用网关模型。 */
  supportedModels: string[];
  /**
   * 支持模型的适用 Agent 映射：模型 ID → Agent 列表；
   * 未记录或空数组的模型默认不允许任何 Agent（默认拒绝）。
   */
  supportedModelScopes?: Record<string, AgentId[]>;
  /**
   * 支持模型的 wire API 能力映射：模型 ID → 允许的 wire API；
   * 未记录或空数组表示该模型不允许任何协议路径。
   */
  supportedModelWireApis?: Record<string, readonly WireApi[]>;
  /**
   * 模型故障转移备份链：主模型 ID → 有序完整网关模型串
   * （`<备份模型ID>_<备份目标路由ID>`，可跨供应商，数组顺序即优先级，≤5 项）。
   * 存在非空链即对该主模型启用故障转移，无独立开关。
   */
  supportedModelFallbacks?: Record<string, string[]>;
  /** 当前供应商不参与指定 Agent 的 CLI 目录生成；不影响网关手工请求。 */
  cliSyncExclusions?: AgentId[];
  pricing?: ProxyTargetPricingPolicy;
  development?: ProxyTargetDevelopmentSettings;
}

export interface ProxyConfig {
  version: 3;
  revision: number;
  /** 键存在表示用户显式接入该 Agent；缺失表示未接入。 */
  agentConnections: Partial<Record<AgentId, AgentConnectionSettings>>;
  targets: ProxyTarget[];
  localProxyBaseUrl: string;
  updatedAt: string;
}
