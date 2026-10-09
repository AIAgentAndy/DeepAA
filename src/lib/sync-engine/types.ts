/**
 * 代理供应商控制台同步引擎类型定义。
 *
 * 控制台账号适配器与套餐适配器共享结果模型，但凭据输入分开：
 * 登录型同步使用 SyncInput，套餐同步必须使用显式选中的 PlanSyncInput。
 * 登录层与解析层分离：New API 的 HTTP 登录与 Playwright 登录复用同一解析逻辑。
 */

/** 控制台同步 Provider 类型。 */
export type PlanProviderType =
  | "kimi-coding"
  | "zhipu"
  | "minimax"
  | "volcengine-plan"
  | "volcengine-coding-plan"
  | "qwenai-token-plan"
  | "tencent-tokenhub-plan"
  | "opencode-go"
  | "openai-subscription"
  | "anthropic-subscription";

/**
 * 自动同步周期（分钟）：新保存默认 5 分钟；存量行迁移回填 30 分钟。
 * 账号（余额/倍率）与套餐（用量）两条链路各自独立配置。
 */
export const SYNC_INTERVAL_MINUTES_CHOICES = [1, 3, 5, 10, 30] as const;
export type SyncIntervalMinutes = (typeof SYNC_INTERVAL_MINUTES_CHOICES)[number];
export const DEFAULT_SYNC_INTERVAL_MINUTES: SyncIntervalMinutes = 5;

export function isSyncIntervalMinutes(value: unknown): value is SyncIntervalMinutes {
  return (SYNC_INTERVAL_MINUTES_CHOICES as readonly unknown[]).includes(value);
}

/** 同步 Provider 类型。 */
export type SyncProviderType =
  | "newapi"
  | "sub2api"
  | "relay"
  | "deepseek"
  | "manual"
  | "openai"
  | "anthropic"
  | "openrouter"
  | "siliconflow"
  | "qwenai"
  | "tencent-hunyuan"
  | PlanProviderType;

/** 适配器能力声明：UI 根据能力决定展示余额、倍率还是仅手动。 */
export interface SyncCapabilities {
  /** 是否支持自动获取余额。 */
  balance: boolean;
  /** 是否支持自动获取密钥级倍率。 */
  rates: boolean;
  /** 是否支持自动获取套餐时间窗用量。 */
  quota: boolean;
  /** 鉴权方式；套餐 API Key 与火山 AK/SK 不复用控制台登录账号。 */
  auth: "http" | "playwright" | "manual" | "api_key" | "access_key" | "oauth";
}

export interface BalanceSnapshotInput {
  currency: string;
  amount: number;
  quota?: number;
  usedQuota?: number;
  source: string;
  raw: unknown;
}

export interface RateSnapshotInput {
  credentialId: string;
  tokenGroup?: string;
  ratio: number;
  source: "auto_group" | "estimate" | "manual_override";
}

/** 单个套餐时间窗的追加快照输入。 */
export interface PlanQuotaSnapshotInput {
  planName?: string;
  /** 套餐共享同一 API Key 时的扣减池（如 Tencent 通用/Hy）。 */
  planFamily?: string;
  windowLabel: string;
  used?: number;
  total?: number;
  /** 供应商返回的原始剩余值，可能与 total-used 因舍入存在差异。 */
  remaining?: number;
  unit?: string;
  resetAt?: string;
  raw: unknown;
}

/** 单条密钥的远程同步对比结果：系统维护的密钥 vs 对方网站查到的密钥。 */
export interface CredentialComparisonItem {
  credentialId: string;
  /** 本地密钥名称。 */
  label: string;
  /** 远程是否找到匹配密钥。 */
  matched: boolean;
  /** 远程密钥名称（匹配成功且远程带名称时）。 */
  remoteName?: string;
  /** 只保存站点密钥的非敏感 ID；对账以此精确筛选该目标的消费行。 */
  remoteKeyId?: string;
  /** 匹配成功时的远程倍率。 */
  ratio?: number;
  /** 未匹配原因（如对方网站未找到、远程密钥已停用等）。 */
  reason?: string;
}

export interface SyncResult {
  providerType: SyncProviderType;
  balance?: BalanceSnapshotInput;
  rates?: RateSnapshotInput[];
  /**
   * 远端匹配成功但未返回有效倍率时的**非破坏性**黄标提醒（2026-09-18 用户决策）：
   * 只提示用户去供应商站点确认实际倍率；绝不再因此改动密钥适用、默认密钥、
   * 目标绑定或 Agent 连接（旧字段 cascadeNotes 的破坏性级联已整体移除）。
   */
  rateSyncWarnings?: string[];
  /** 按密钥粒度的远程对比结果（仅支持远程密钥列表的站点类型生成）。 */
  credentialComparison?: CredentialComparisonItem[];
  /** 套餐同步一次可返回多个独立时间窗。 */
  planQuota?: PlanQuotaSnapshotInput[];
}

/** 同步输入：由 SyncService 组装，凭据内容通过回调按需注入、用后即弃。 */
export interface SyncInput {
  targetId: string;
  consoleBaseUrl: string;
  username: string;
  password: string;
  /** 中转站已识别出的底层类型；未识别时为 undefined，由 RelayAdapter 先 Sub2API 再 New API 探测。 */
  resolvedProvider?: "sub2api" | "newapi";
  /** 供应商下全部密钥元数据（id + label + fingerprintSuffix），用于倍率快照与远程对比落库。 */
  credentials: Array<{id: string; label: string; fingerprintSuffix: string}>;
  /** 供应商默认密钥 ID（deepseek 官方余额查询使用；取 Agent 级默认密钥之一）。 */
  defaultCredentialId?: string;
  /** 读取指定密钥明文（web 侧 spawn credential-helper，用后即弃，绝不落盘）。 */
  resolveCredential: (credentialId: string) => Promise<string>;
  /** 是否允许降级 Playwright 登录；false 时登录失败直接抛 AuthRequired。 */
  allowPlaywright?: boolean;
}

export interface SyncConnector {
  readonly providerType: SyncProviderType;
  readonly capabilities: SyncCapabilities;
  sync(input: SyncInput): Promise<SyncResult>;
}

/**
 * 套餐同步输入只包含供应商、显式选中的凭据和按需解析回调。
 * 禁止从供应商第一条、最近一条或 Agent 默认密钥隐式回退。
 */
export interface PlanSyncInput {
  targetId: string;
  baseUrl: string;
  credentialId?: string;
  accessKeyRef?: string;
  secretKeyRef?: string;
  resolveCredential: (credentialId: string) => Promise<string>;
  resolveSecretReference?: (reference: string) => Promise<string>;
}

export interface PlanSyncConnector {
  readonly providerType: PlanProviderType;
  readonly capabilities: SyncCapabilities;
  sync(input: PlanSyncInput): Promise<SyncResult>;
}

/** 登录失败且可能需要人工介入（验证码 / 2FA / 会话过期）。 */
export class SyncAuthRequiredError extends Error {
  constructor(message = "SYNC_AUTH_REQUIRED") {
    super(message);
    this.name = "SyncAuthRequiredError";
  }
}

/** 站点不支持或接口被关闭（如 newapi 关闭定价模块）。 */
export class SyncUnsupportedError extends Error {
  constructor(message = "SYNC_UNSUPPORTED") {
    super(message);
    this.name = "SyncUnsupportedError";
  }
}
