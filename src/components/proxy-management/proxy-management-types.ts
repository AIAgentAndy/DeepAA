import type {DevelopmentCredentialMetadata} from "@/lib/development-launch/types";
import type {ConfigFileDisplayManifest} from "@/lib/config-sync/file-display";

export type CredentialItem = DevelopmentCredentialMetadata;

export interface ModelDiscoverResponse {
  ok?: boolean;
  authRequired?: boolean;
  total?: number;
  matched?: DiscoveredModelItem[];
  unpriced?: Array<{modelId: string; reason: string; suggestedVendor?: string}>;
  added?: DiscoveredModelItem[];
  existing?: string[];
  removed?: string[];
  skipped?: number;
  message?: string;
}

export interface DiscoveredModelItem {
  modelId: string;
  vendor: string;
  priceEntryId: string;
  mode?: string;
  pricing?: {input: number; output: number; cachedInput?: number; cacheWrite?: number; reasoning?: number};
  contextWindow?: number;
  maxOutput?: number;
}

export interface ProxySyncStatus {
  account: {
    id: string;
    targetId: string;
    providerType: string;
    /** 中转站已识别出的底层类型；未识别或非中转站为 null。 */
    resolvedProvider: "sub2api" | "newapi" | null;
    consoleBaseUrl: string;
    username: string;
    loginMode: string;
    status: string;
    lastSyncAt: string | null;
    lastSyncError: string | null;
    /** 账号链连续自动同步失败次数（成功即清零）；供「同步失败」红标判定。 */
    consecutiveAutoFailures: number;
    /** 账号链最近一次失败的类别（auth = 凭证/鉴权一次即亮；null = 无失败链）。 */
    consecutiveFailureKind: string | null;
    nextSyncAt: string | null;
    /** 该供应商账号（余额/倍率）的自动同步周期（分钟）。 */
    syncIntervalMinutes: number;
    /** 控制台密码/会话凭据打码串（前4+****+后4）；明文只能经 reveal 接口取回。 */
    credentialMasked?: string;
  } | null;
  balance: {
    currency: string;
    amount: number;
    quota: number | null;
    usedQuota: number | null;
    source: string;
    capturedAt: string;
  } | null;
  rates: Array<{
    credentialId: string;
    tokenGroup: string | null;
    ratio: number;
    source: string;
    capturedAt: string;
  }>;
  /** 最近一次成功同步的按密钥远程对比结果（系统密钥 vs 对方网站密钥）。 */
  credentialComparison: Array<{
    credentialId: string;
    label: string;
    matched: boolean;
    remoteName?: string;
    ratio?: number;
    reason?: string;
  }> | null;
  runs: Array<{
    id: number;
    status: string;
    mode: string;
    startedAt: string;
    finishedAt: string | null;
  }>;
  capabilities: {balance: boolean; rates: boolean; quota: boolean; auth: string};
  plan: {
    config: {
      id: string;
      targetId: string;
      providerType: "kimi-coding" | "zhipu" | "minimax" | "volcengine-plan" | "volcengine-coding-plan"
        | "qwenai-token-plan" | "opencode-go"
        | "openai-subscription" | "anthropic-subscription";
      credentialId: string | null;
      status: string;
      lastSyncAt: string | null;
      lastSyncError: string | null;
      /** 套餐链连续自动同步失败次数（成功即清零）；供「同步失败」红标判定。 */
      consecutiveAutoFailures: number;
      /** 套餐链最近一次失败的类别（auth = 凭证/鉴权一次即亮；null = 无失败链）。 */
      consecutiveFailureKind: string | null;
      nextSyncAt: string | null;
      /** 该供应商套餐用量的自动同步周期（分钟）；与账号周期独立。 */
      syncIntervalMinutes: number;
      hasAccessKey: boolean;
      hasSecretKey: boolean;
      /** 火山 AK/SK 打码串（前4+****+后4）；明文只能经 reveal 接口取回。 */
      accessKeyMasked?: string;
      secretKeyMasked?: string;
    } | null;
    quota: {
      items: Array<{
        id: number;
        targetId: string;
        credentialId: string | null;
        providerType: string;
        planName: string | null;
        windowLabel: string;
        used: number | null;
        total: number | null;
        remaining: number | null;
        unit: string | null;
        resetAt: string | null;
        capturedAt: string;
      }>;
      candidateCount: number;
      processedCount: number;
      limited: boolean;
    };
    capabilities: {balance: boolean; rates: boolean; quota: boolean; auth: string} | null;
  };
}

/** 保存账号/套餐后立即执行的首次同步结果；失败时页面据此立刻提醒。 */
export interface SyncOutcomePayload {
  ok: boolean;
  /** 登录/密钥鉴权失败：提示用户检查填写的账号（套餐）信息是否正确。 */
  authRequired: boolean;
  message: string | null;
}

export interface CliSyncStatus {
  ok?: boolean;
  nonce?: string;
  /** 与 /api/config-sync 返回的 CliSyncWarning 结构一致（对象数组，非字符串）。 */
  warnings?: Array<{targetId: string; code: string; message: string}>;
  errors?: string[];
  lastMessage?: string;
  /** 按 Agent 分组的脱敏预览（config-sync 阶段 3 起提供）。 */
  previews?: Record<string, {
    agent?: string;
    active?: boolean;
    files?: Array<{specId?: string; path?: string; kind?: string; active?: boolean; bytes?: number; note?: string}>;
    warnings?: Array<{targetId?: string; code?: string; message?: string}>;
    notes?: string[];
  }>;
  paths?: {
    codexConfigPath?: string;
    codexCatalogPath?: string;
    claudeUserSettingsPath?: string;
  };
  /** 首屏文件清单不含正文；用户展开后通过受管 fileId 单独加载服务端脱敏预览。 */
  fileDisplays?: Partial<Record<string, ConfigFileDisplayManifest[]>>;
}

export type Notice = {kind: "success" | "error" | "warning"; message: string} | null;
