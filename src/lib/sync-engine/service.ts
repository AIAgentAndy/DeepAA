import {spawn} from "node:child_process";
import {createHash} from "node:crypto";
import {resolve} from "node:path";
import {resolveDeepaaDataDir} from "@/lib/data-paths";
import {getDeepaaDatabase} from "@/lib/db/connection";
import {findProxyTarget, ProxyConfigStore} from "@/proxy-config";
import {AGENT_REGISTRY} from "@/lib/agent-registry";
import {inferCustomTargetModelWireApis} from "@/lib/wire-api-infer";
import type {ProxyTarget} from "@/types";
import {normalizePricingConfig, readPricingConfig} from "@/lib/pricing";
import {
  matchDiscoveredModels,
  probeOpenAiModels,
  resolveConfirmedModelBindings,
  type ModelDiscoveryResult,
} from "./model-discovery";
import {CredentialMetadataRepository, fingerprintForSecret} from "@/lib/development-launch/credential-metadata";
import {
  ConsoleCredentialRepository,
  defaultConsoleCredentialsPath,
  type ConsoleAccountSecret,
} from "./console-credentials";
import {
  SyncStore,
  type ConsoleAccountRow,
  type PlanSyncConfigRow,
} from "./store";
import {
  newApiLoginWithSession,
  parseNewApiPayloads,
  type NewApiPayloads,
} from "./adapters/newapi";
import {newApiSyncViaPlaywright} from "./adapters/newapi-playwright";
import {
  parseSub2ApiPayloads,
  sub2ApiLogin,
  type Sub2ApiPayloads,
} from "./adapters/sub2api";
// 对账复核的登录会话复用（reconciliation/session-cache 内部引用上面两个登录器）。
import {
  invalidateNewApiSession, invalidateSub2ApiSession,
  newApiSessionCached, sub2ApiLoginCached,
} from "./reconciliation/session-cache";
import {sub2ApiSyncViaPlaywright} from "./adapters/sub2api-playwright";
import {createBalanceConnectorRegistry} from "../provider-plugins";
import {NoBalanceConsoleAdapter} from "./adapters/no-balance";
import {createPlanAdapterRegistry} from "./plan-registry";
import {pickPrimaryPlanQuotaWindow} from "@/lib/plan-quota-display";
import {rateUnconfirmedCredentials, rateUnconfirmedNotes} from "./rate-warning";
import {
  MAX_OVERVIEW_TARGETS,
  OVERVIEW_PLAN_WINDOW_LIMIT,
  type SyncOverviewPayload,
  type SyncOverviewTargetSummary,
} from "./overview-types";
import {resolvePlanProviderForTarget} from "./plan-provider";
import {resolveOfficialPresetForTarget} from "@/lib/provider-preset-capabilities";
import {firstAgentDefaultCredentialId} from "@/lib/proxy-management-domain";
import {derivePresetCurrency} from "@/lib/provider-presets";
import {runPlanEstimateBackfill} from "@/lib/plan-estimate/backfill";
import {loadProviderCatalog} from "@/lib/provider-catalog/cache";
import {matchPlanTierMonthlyFee, resolvePlanTierFee} from "@/lib/provider-catalog/plan-tiers";
import type {ProviderCatalog} from "@/lib/provider-catalog/types";
import {
  SyncAuthRequiredError,
  SyncUnsupportedError,
  DEFAULT_SYNC_INTERVAL_MINUTES,
  isSyncIntervalMinutes,
  type CredentialComparisonItem,
  type PlanProviderType,
  type PlanSyncConnector,
  type PlanSyncInput,
  type RateSnapshotInput,
  type SyncConnector,
  type SyncInput,
  type SyncIntervalMinutes,
  type SyncProviderType,
  type SyncResult,
} from "./types";
import type {DeepaaDatabase} from "@/lib/db/sqlite-driver";
import {ReconciliationStore, type HourRow} from "./reconciliation/store";
import {
  accountingMatchesForHour, reviewDueReconciliationHours, siteEvidenceHash,
} from "./reconciliation/service";
import {
  fetchNewApiHour, fetchNewApiStatLight, fetchSub2ApiDayTotalLight, fetchSub2ApiHour,
} from "./reconciliation/site-usage";
import {matchSiteUsage} from "./reconciliation/matching";

const SYNC_JITTER_RATIO = 0.1;
const FAIL_RETRY_MS = 5 * 60_000;
const AUTH_RETRY_MS = 30 * 60_000;
const CREDENTIAL_TIMEOUT_MS = 10_000;
/** 待复核对账窗口每页条数上限（2026-09-17 用户确认 100 条/页）。 */
const RECONCILIATION_PAGE_SIZE = 100;

export interface SyncServiceOptions {
  db: DeepaaDatabase;
  configStore: ProxyConfigStore;
  /** 套餐档位表目录加载器；缺省不启用月费自动回填（测试注入桩目录保持离线）。 */
  loadPlanCatalog?: () => Promise<ProviderCatalog | undefined>;
  developmentCredentialsPath?: string;
  consoleCredentialsPath?: string;
  credentialHelperPath?: string;
  /** 订阅适配器只读 Codex auth.json 的目录（缺省使用真实 HOME）。 */
  subscriptionCodexHome?: string;
  /** 订阅适配器只读 Claude 凭据的目录（缺省使用真实 HOME）。 */
  subscriptionClaudeHome?: string;
  fetchImpl?: typeof fetch;
}

/** 保存后立即执行的首次同步结果；失败不回滚保存，由页面负责提醒。 */
export interface SyncOutcome {
  ok: boolean;
  /** 登录/密钥鉴权失败：页面据此提示用户检查填写的账号（套餐）信息。 */
  authRequired: boolean;
  message: string | null;
}

export interface SyncStatusPayload {
  account: (Omit<ConsoleAccountRow, "passwordRef"> & {
    /** 中转站已识别出的底层类型；未识别或非中转站为 null。 */
    resolvedProvider: "sub2api" | "newapi" | null;
    /** 控制台密码/会话凭据的打码串（前4+****+后4），供页面展示；明文只能经 reveal 接口取回。 */
    credentialMasked?: string;
  }) | null;
  balance: Awaited<ReturnType<SyncStore["latestBalance"]>> | null;
  rates: Array<{
    credentialId: string;
    tokenGroup: string | null;
    ratio: number;
    source: string;
    capturedAt: string;
  }>;
  /** 最近一次成功同步的按密钥远程对比结果（系统密钥 vs 对方网站密钥）。 */
  credentialComparison: CredentialComparisonItem[] | null;
  runs: Awaited<ReturnType<SyncStore["latestSyncRuns"]>>;
  capabilities: SyncConnector["capabilities"];
  plan: {
    config: (Omit<PlanSyncConfigRow, "accessKeyRef" | "secretKeyRef"> & {
      hasAccessKey: boolean;
      hasSecretKey: boolean;
      accessKeyMasked?: string;
      secretKeyMasked?: string;
    }) | null;
    quota: ReturnType<SyncStore["latestPlanQuotas"]>;
    capabilities: PlanSyncConnector["capabilities"] | null;
  };
}

const LEGACY_PLAN_QUOTA_RAW_MAX_CHARS = 64 * 1024;

/**
 * 供应商同步概览的读取上限与返回契约统一定义在 `./overview-types`
 * （零依赖类型模块，客户端组件可安全 import type）。
 */
export {
  MAX_OVERVIEW_TARGETS,
  OVERVIEW_PLAN_WINDOW_LIMIT,
  type SyncOverviewPayload,
  type SyncOverviewTargetSummary,
} from "./overview-types";

/**
 * 兼容旧版套餐快照：旧适配器曾把智谱真实积分降级保存为 percent，
 * 但 raw_json 仍保留 usage/currentValue/remaining。仅对 status 已经有界读取的
 * 最多 20 条、小于 64 KiB 的快照做投影还原，不回写历史行、不扫描其它数据。
 */
function restoreLegacyZhipuQuota(row: ReturnType<SyncStore["latestPlanQuotas"]>["items"][number]): typeof row {
  if (row.providerType !== "zhipu"
    || row.unit !== "percent"
    || !row.rawJson
    || row.rawJson.length > LEGACY_PLAN_QUOTA_RAW_MAX_CHARS
    || row.remaining !== null && row.remaining !== undefined) return row;
  try {
    const parsed = JSON.parse(row.rawJson) as Record<string, unknown>;
    const total = finiteNonNegativeNumber(parsed.usage);
    const used = finiteNonNegativeNumber(parsed.currentValue);
    const remaining = finiteNonNegativeNumber(parsed.remaining);
    if (total === undefined || used === undefined || remaining === undefined) return row;
    return {...row, used, total, remaining, unit: "credits"};
  } catch {
    return row;
  }
}

function finiteNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export class SyncService {
  readonly store: SyncStore;
  readonly reconciliation: ReconciliationStore;
  private readonly db: DeepaaDatabase;
  private readonly configStore: ProxyConfigStore;
  private readonly credentialHelperPath: string;
  private readonly credentialsRepository: CredentialMetadataRepository;
  private readonly consoleCredentials: ConsoleCredentialRepository;
  private readonly adapters = new Map<SyncProviderType, SyncConnector>();
  private readonly planAdapters: Map<PlanProviderType, PlanSyncConnector>;
  private readonly loadPlanCatalog: SyncServiceOptions["loadPlanCatalog"];
  /** 侧栏概览短 TTL 缓存（见 overview 注释）；键为目标 id 列表的规范化拼接。 */
  private static readonly OVERVIEW_CACHE_TTL_MS = 30_000;
  private overviewCache: {key: string; payload: SyncOverviewPayload; at: number} | undefined;

  /** 任何会改变 overview 可见数据（账号/余额/套餐快照/同步状态）的写路径调用。 */
  private invalidateOverviewCache(): void {
    this.overviewCache = undefined;
  }

  constructor(options: SyncServiceOptions) {
    this.store = new SyncStore(options.db);
    this.reconciliation = new ReconciliationStore(options.db);
    this.db = options.db;
    this.configStore = options.configStore;
    const dataDir = resolveDeepaaDataDir();
    this.credentialHelperPath = options.credentialHelperPath || resolve(process.cwd(), "bin", "credential-helper.mjs");
    this.credentialsRepository = new CredentialMetadataRepository(
      options.developmentCredentialsPath
      || resolve(dataDir, "config", "development-credentials.json"),
    );
    this.consoleCredentials = new ConsoleCredentialRepository(
      options.consoleCredentialsPath || defaultConsoleCredentialsPath(dataDir),
    );
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.loadPlanCatalog = options.loadPlanCatalog;
    // 余额适配器注册表唯一装配点已收敛到 provider-plugins（P1-9）。
    for (const [providerType, connector] of createBalanceConnectorRegistry(options.fetchImpl)) {
      this.adapters.set(providerType, connector);
    }
    this.planAdapters = createPlanAdapterRegistry({
      fetchImpl: options.fetchImpl,
      codexHome: options.subscriptionCodexHome,
      claudeHome: options.subscriptionClaudeHome,
    });
  }

  async saveConsoleAccount(input: {
    targetId: string;
    providerType: SyncProviderType;
    consoleBaseUrl: string;
    username: string;
    password: string;
    /** api_key 余额站点（DeepSeek/智谱/Kimi/OpenRouter）的余额查询密钥；编辑留空保持已保存值。 */
    credentialId?: string;
    /** 同步周期（分钟）；缺省保留存量值，首次保存默认 5 分钟。 */
    syncIntervalMinutes?: SyncIntervalMinutes;
  }): Promise<{account: ConsoleAccountRow; sync: SyncOutcome}> {
    // 供应商可能刚在页面新建/保存：先 reload 持久化配置，避免缓存旧配置导致 TARGET_NOT_FOUND。
    await this.configStore.reload().catch(() => undefined);
    const target = findProxyTarget(this.configStore.getConfig(), input.targetId);
    if (!target) throw new Error("TARGET_NOT_FOUND");
    if (!this.adapters.has(input.providerType)) throw new Error("SYNC_PROVIDER_UNSUPPORTED");
    const consoleBaseUrl = normalizeConsoleBaseUrl(input.consoleBaseUrl);
    const existing = await this.consoleCredentials.find(input.targetId);
    const existingRow = this.store.getConsoleAccount(input.targetId);
    const username = input.username.trim() || existing?.username || "";
    const password = input.password || existing?.password || "";
    // 中转站（New API / Sub2API）用网页账号登录，必须提供用户名/密码；
    // api_key 余额站点（DeepSeek/智谱/Kimi/OpenRouter）余额经所选 API Key 查询，
    // 用户名/密码不参与同步（2026-10-11 用户确认分流，表单已改为密钥下拉）。
    const adapter = this.adapters.get(input.providerType)!;
    // 无公开余额接口的官方预设不保存控制台账号：保存后既无法取数又会在调度器反复报错，
    // 统一在保存入口拒绝，避免制造无法自愈的无效配置；存量账号仍可通过删除接口清理。
    if (adapter instanceof NoBalanceConsoleAdapter) {
      throw new SyncUnsupportedError("ACCOUNT_SYNC_UNSUPPORTED");
    }
    const needsWebLogin = adapter.capabilities.auth === "http" || adapter.capabilities.auth === "playwright";
    if (needsWebLogin && (!username || !password)) throw new Error("CONSOLE_ACCOUNT_INCOMPLETE");
    // api_key 余额站点的查询密钥显式选择并服务端校验归属本目标（与套餐同步同口径），
    // 不再借启动默认密钥表；编辑留空保持已保存密钥（与用户名/密码编辑语义一致）。
    let balanceCredentialId: string | null = null;
    if (adapter.capabilities.auth === "api_key") {
      const explicit = input.credentialId?.trim() || existingRow?.credentialId || "";
      if (!explicit) throw new Error("CONSOLE_CREDENTIAL_REQUIRED");
      const credential = await this.credentialsRepository.find(explicit);
      if (!credential || credential.targetId !== input.targetId) {
        throw new Error("CONSOLE_CREDENTIAL_TARGET_MISMATCH");
      }
      balanceCredentialId = credential.id;
    }
    const now = new Date().toISOString();
    const secret: ConsoleAccountSecret = {
      targetId: input.targetId,
      providerType: input.providerType,
      consoleBaseUrl,
      username,
      password,
      // 中转站编辑时保留已识别出的底层类型；站点类型一经识别不可更换。
      ...(input.providerType === "relay" && existing?.resolvedProvider
        ? {resolvedProvider: existing.resolvedProvider}
        : {}),
      updatedAt: now,
    };
    await this.consoleCredentials.upsert(secret);
    const syncIntervalMinutes = input.syncIntervalMinutes
      ?? existingRow?.syncIntervalMinutes
      ?? DEFAULT_SYNC_INTERVAL_MINUTES;
    const row: Omit<ConsoleAccountRow, "createdAt" | "updatedAt"> = {
      id: `console_${input.targetId.replace(/[^a-z0-9]/giu, "_")}`,
      targetId: input.targetId,
      providerType: input.providerType,
      consoleBaseUrl,
      username: secret.username,
      passwordRef: secret.targetId,
      credentialId: balanceCredentialId,
      loginMode: adapter.capabilities.auth,
      status: "idle",
      lastSyncAt: null,
      lastSyncError: null,
      consecutiveAutoFailures: 0,
      consecutiveFailureKind: null,
      nextSyncAt: new Date(Date.now() + 30_000).toISOString(),
      syncIntervalMinutes,
    };
    this.store.upsertConsoleAccount(row);
    this.invalidateOverviewCache();
    // 保存后立即执行首次同步：结果随响应返回给页面提醒；失败不回滚保存。
    const sync = await this.runSyncOnce(input.targetId);
    return {account: this.store.getConsoleAccount(input.targetId)!, sync};
  }

  async removeConsoleAccount(targetId: string): Promise<boolean> {
    const removed = await this.consoleCredentials.remove(targetId);
    const removedRow = this.store.removeConsoleAccount(targetId);
    this.invalidateOverviewCache();
    return removed || removedRow;
  }

  /** 保存供应商级套餐同步；API Key 必须显式选择且在服务端重新校验供应商归属。 */
  async savePlanSyncConfig(input: {
    targetId: string;
    providerType: PlanProviderType;
    credentialId?: string;
    accessKeyId?: string;
    secretAccessKey?: string;
    expectedRevision: number;
    /** 同步周期（分钟）；缺省保留存量值，首次保存默认 5 分钟。 */
    syncIntervalMinutes?: SyncIntervalMinutes;
    /**
     * 套餐档位 id（2026-09-30 OpenCode Go）：上游 usage 接口不返回档位标识，
     * opencode-go 必选（目录 planTiers id，如 go/go-plus）；其它供应商不接受。
     */
    planTier?: string;
  }): Promise<{config: PlanSyncConfigRow; sync: SyncOutcome}> {
    await this.configStore.reload();
    const config = this.configStore.getConfig();
    if (input.expectedRevision !== config.revision) throw new Error("CONFIG_REVISION_CONFLICT");
    const target = findProxyTarget(config, input.targetId);
    if (!target) throw new Error("TARGET_NOT_FOUND");
    if (!this.planAdapters.has(input.providerType)) throw new Error("PLAN_PROVIDER_UNSUPPORTED");
    // 套餐模块只对声明 planSync 适配器的供应商开放：DeepSeek 等供应商即使被选中也不得保存。
    if (resolvePlanProviderForTarget(target) !== input.providerType) {
      throw new Error("PLAN_PROVIDER_TARGET_MISMATCH");
    }
    /* 档位先于同步落盘（估算分母在同步钩子与派生期都要用）：格式恒校验；
       目录可解析时校验档位 ∈ planTiers id（目录不可达时放行格式合法值——运行时
       解析不到额度只会按 market_blocked 诚实降级，不会错算钱）。 */
    if (input.providerType === "opencode-go") {
      const planTier = input.planTier?.trim() ?? "";
      if (!/^[a-z0-9][a-z0-9-]{0,63}$/u.test(planTier)) throw new Error("PLAN_TIER_REQUIRED");
      const tierIds = await this.resolvePlanTierIds(target);
      if (tierIds && !tierIds.includes(planTier)) throw new Error("PLAN_TIER_INVALID");
      if (target.pricing?.planTier !== planTier) {
        await this.configStore.updateConfig({
          targetPatch: {id: target.id, target: {pricing: {...target.pricing, planTier}}},
        });
      }
    } else if (input.planTier) {
      throw new Error("PLAN_TIER_UNSUPPORTED");
    }

    const existing = this.store.getPlanSyncConfig(input.targetId);
    let credentialId: string | null = null;
    let accessKeyRef: string | null = null;
    let secretKeyRef: string | null = null;
    if (isVolcenginePlanProvider(input.providerType)) {
      accessKeyRef = existing?.accessKeyRef ?? planSecretReference(input.targetId, "ak");
      secretKeyRef = existing?.secretKeyRef ?? planSecretReference(input.targetId, "sk");
      const accessKeyId = input.accessKeyId?.trim();
      const secretAccessKey = input.secretAccessKey?.trim();
      if (!existing && (!accessKeyId || !secretAccessKey)) {
        throw new Error("VOLCENGINE_AK_SK_REQUIRED");
      }
      if ((accessKeyId && !secretAccessKey) || (!accessKeyId && secretAccessKey)) {
        throw new Error("VOLCENGINE_AK_SK_REQUIRED");
      }
      if (accessKeyId && secretAccessKey) {
        await this.putPlanSecrets([
          {reference: accessKeyRef, label: `${input.targetId} Volcengine AccessKey`, value: accessKeyId},
          {reference: secretKeyRef, label: `${input.targetId} Volcengine SecretKey`, value: secretAccessKey},
        ]);
      }
    } else if (input.providerType !== "openai-subscription"
      && input.providerType !== "anthropic-subscription") {
      if (!input.credentialId) throw new Error("PLAN_CREDENTIAL_REQUIRED");
      const credential = await this.credentialsRepository.find(input.credentialId);
      if (!credential || credential.targetId !== input.targetId) {
        throw new Error("PLAN_CREDENTIAL_TARGET_MISMATCH");
      }
      credentialId = credential.id;
    }

    this.store.upsertPlanSyncConfig({
      id: existing?.id ?? `plan_${createHash("sha256").update(input.targetId).digest("hex").slice(0, 24)}`,
      targetId: input.targetId,
      providerType: input.providerType,
      credentialId,
      accessKeyRef,
      secretKeyRef,
      status: "idle",
      lastSyncAt: existing?.lastSyncAt ?? null,
      lastSyncError: null,
      consecutiveAutoFailures: 0,
      consecutiveFailureKind: null,
      nextSyncAt: new Date(Date.now() + 30_000).toISOString(),
      syncIntervalMinutes: input.syncIntervalMinutes
        ?? existing?.syncIntervalMinutes
        ?? DEFAULT_SYNC_INTERVAL_MINUTES,
    });
    this.invalidateOverviewCache();
    // 保存后立即执行首次同步：结果随响应返回给页面提醒；失败不回滚保存。
    const sync = await this.runPlanSyncOnce(input.targetId);
    return {config: this.store.getPlanSyncConfig(input.targetId)!, sync};
  }

  /** 保存后立即同步控制台账号一次；失败折叠为可展示结果，不向调用方抛错。 */
  private async runSyncOnce(targetId: string): Promise<SyncOutcome> {
    try {
      await this.runSync(targetId, {automatic: true});
      return {ok: true, authRequired: false, message: null};
    } catch (error) {
      return {
        ok: false,
        authRequired: error instanceof SyncAuthRequiredError,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /** 保存后立即同步套餐一次；失败折叠为可展示结果，不向调用方抛错。 */
  private async runPlanSyncOnce(targetId: string): Promise<SyncOutcome> {
    try {
      await this.runPlanSync(targetId, {automatic: true});
      return {ok: true, authRequired: false, message: null};
    } catch (error) {
      return {
        ok: false,
        authRequired: error instanceof SyncAuthRequiredError,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async removePlanSyncConfig(targetId: string, expectedRevision: number): Promise<boolean> {
    await this.configStore.reload();
    const config = this.configStore.getConfig();
    if (expectedRevision !== config.revision) throw new Error("CONFIG_REVISION_CONFLICT");
    const existing = this.store.getPlanSyncConfig(targetId);
    const removed = this.store.removePlanSyncConfig(targetId);
    this.invalidateOverviewCache();
    for (const reference of [existing?.accessKeyRef, existing?.secretKeyRef]) {
      if (reference) await this.spawnCredential(["delete", reference]).catch(() => undefined);
    }
    return removed;
  }

  /**
   * 模型发现只产生只读候选，不直接修改供应商。用户确认差异后由
   * confirmDiscoveredModels 执行第二次服务端校验并写入 Agent 可见模型。
   */
  async discoverModels(targetId: string, credentialId?: string): Promise<ModelDiscoveryResult> {
    // 供应商可能刚在页面保存：先 reload 持久化配置，避免缓存旧配置导致 TARGET_NOT_FOUND。
    await this.configStore.reload().catch(() => undefined);
    const target = findProxyTarget(this.configStore.getConfig(), targetId);
    if (!target) throw new Error("TARGET_NOT_FOUND");
    // 官方预设的模型来自受维护的目录，并已在创建时完成价格映射；禁止再走上游 /models，
    // 同时把门禁放在凭据读取和网络请求之前，避免把官方供应商误报成鉴权失败。
    if (target.presetId || resolveOfficialPresetForTarget(target)) {
      throw new Error("PRESET_MODEL_DISCOVERY_UNSUPPORTED");
    }
    const baseUrl = target.openaiUrl || target.anthropicUrl;
    if (!baseUrl) throw new Error("PROTOCOL_URL_REQUIRED");
    if (!credentialId) {
      return {
        ok: false,
        authRequired: true,
        total: 0,
        matched: [],
        unpriced: [],
        skipped: 0,
        added: [],
        existing: [],
        removed: [],
        message: "模型发现必须先选择已保存的供应商密钥。",
      };
    }
    const credential = await this.credentialsRepository.find(credentialId);
    if (!credential || credential.targetId !== targetId) throw new Error("MODEL_DISCOVER_CREDENTIAL_INVALID");
    const apiKey = await this.spawnCredential(["get", credentialId]);
    const probe = await probeOpenAiModels(baseUrl, apiKey);
    if (probe.authRequired) throw new Error("MODEL_DISCOVER_AUTH_INVALID");
    const pricing = await readPricingConfig(resolveDeepaaDataDir());
    // 自定义供应商不提供额外“供应商选择”层：仅按固定模型家族供应商映射，
    // 再以供应商 + 完整运行时模型 ID 精确匹配价格中心。
    const {matched, unpriced, skipped} = matchDiscoveredModels(probe.models, pricing);
    const remoteIds = new Set(probe.models);
    const existingIds = matched.filter(item => target.supportedModels.includes(item.modelId)).map(item => item.modelId);
    const added = matched.filter(item => !target.supportedModels.includes(item.modelId));
    const removed = target.supportedModels.filter(modelId => !remoteIds.has(modelId));
    return {
      ok: true,
      authRequired: false,
      total: probe.models.length,
      matched,
      unpriced,
      skipped,
      added,
      existing: existingIds,
      removed,
      message: matched.length > 0
        ? `发现 ${matched.length} 个可定价对话模型，请确认新增、移除和 Agent 可见范围后保存。`
        : "自动发现未匹配到可定价模型，请先在价格中心补充供应商、模型和价格映射。",
    };
  }

  async confirmDiscoveredModels(
    targetId: string,
    credentialId: string,
    selectedModelIds: string[],
  ): Promise<ModelDiscoveryResult> {
    const discovery = await this.discoverModels(targetId, credentialId);
    if (!discovery.ok) throw new Error("MODEL_DISCOVER_CREDENTIAL_REQUIRED");
    const selected = [...new Set(selectedModelIds.filter(id => typeof id === "string" && id.trim()))];
    await this.configStore.reload().catch(() => undefined);
    const target = findProxyTarget(this.configStore.getConfig(), targetId);
    if (!target) throw new Error("TARGET_NOT_FOUND");
    const pricing = await readPricingConfig(resolveDeepaaDataDir());
    // 模型确认是增量确认语义：本密钥未返回、但价格映射仍可解析的存量模型强制保留，
    // 不同密钥探测到的模型集合互补，不能因换密钥确认而互相覆盖；显式移除只走模型行
    // 的删除按钮。价格条目已失效的存量模型不保留，避免阻塞本次确认（需先修复价格中心）。
    const priceEntryIds = new Set(normalizePricingConfig(pricing).models.map(entry => entry.id));
    const retainedRemoved = discovery.removed.filter(modelId => {
      const mapping = target.pricing?.modelVendors?.[modelId];
      return Boolean(mapping?.priceEntryId && priceEntryIds.has(mapping.priceEntryId));
    });
    // 本密钥返回且已在白名单的模型（existing）强制保留：UI 置灰不可取消，
    // 移除只走模型行删除按钮；防止误取消勾选导致静默下线。
    const retainedExisting = discovery.existing.filter(modelId => target.supportedModels.includes(modelId));
    const bindings = resolveConfirmedModelBindings(
      target,
      discovery.matched,
      [...new Set([...selected, ...retainedRemoved, ...retainedExisting])],
      pricing,
    );
    // 初始模型适用按「模型 wire API × Agent binding 交集」计算：gpt 系列（responses）
    // 适用 Codex/OpenCode，chat 模型适用 OpenCode/dsh，messages 适用 Claude/OpenCode；
    // 不再只按协议 URL 写入 codex/claude 单值，避免接入多个 Agent 后只有 codex 可用。
    const nextScopes = Object.fromEntries(bindings.supportedModels.map(modelId => {
      const existingScope = target.supportedModelScopes?.[modelId];
      if (existingScope) return [modelId, existingScope];
      const wireApis = inferCustomTargetModelWireApis(modelId, target);
      const agents = AGENT_REGISTRY
        .filter(entry => entry.bindings.some(binding =>
          (binding.protocol === "openai" ? Boolean(target.openaiUrl) : Boolean(target.anthropicUrl))
          && wireApis.includes(binding.wireApi)))
        .map(entry => entry.id);
      return agents.length > 0 ? [modelId, agents] : [modelId, []];
    }));
    // 自定义供应商没有目录/预设级协议声明：按 URL + 模型家族推断落库 wire API，
    // 与网关路由兜底保持一致（gpt-*/o 系列 → responses，其余 OpenAI 模型 → chat）。
    const nextWireApis = Object.fromEntries(bindings.supportedModels.map(modelId => [
      modelId,
      inferCustomTargetModelWireApis(modelId, target),
    ]));
    await this.configStore.updateConfig({
      targetPatch: {
        id: targetId,
        target: {
          supportedModels: bindings.supportedModels,
          supportedModelWireApis: nextWireApis,
          pricing: {...target.pricing, modelVendors: bindings.modelVendors},
          ...(Object.keys(nextScopes).length > 0 ? {supportedModelScopes: nextScopes} : {supportedModelScopes: undefined}),
        },
      },
    });
    return {
      ...discovery,
      message: `已确认 ${selected.length} 个模型${retainedRemoved.length > 0
        ? `，并保留 ${retainedRemoved.length} 个本密钥未返回的既有模型` : ""}。`,
    };
  }

  async status(targetId: string): Promise<SyncStatusPayload> {
    const planConfig = this.store.getPlanSyncConfig(targetId);
    const [accessKeyMasked, secretKeyMasked] = await Promise.all([
      this.maskedPlanSecret(planConfig?.accessKeyRef),
      this.maskedPlanSecret(planConfig?.secretKeyRef),
    ]);
    let account = this.store.getConsoleAccount(targetId);
    let secret: ConsoleAccountSecret | undefined;
    // 用户名以凭据文件明文为准：老数据 SQLite 曾存脱敏值，这里自愈为明文并回写。
    if (account) {
      secret = await this.consoleCredentials.find(targetId);
      if (secret && secret.username !== account.username) {
        this.store.updateConsoleUsername(targetId, secret.username);
        account = {...account, username: secret.username};
      }
    }
    // 余额严格跟随控制台账号：未配置账号时绝不展示任何历史快照，
    // 避免删除供应商/账号后残留快照被重建的同名供应商「复活」。
    const balance = account ? this.store.latestBalance(targetId) : undefined;
    const credentialRows = await this.credentialsRepository.list(targetId);
    const rates = credentialRows
      .map(credential => this.store.latestRate(credential.id))
      .filter((row): row is NonNullable<typeof row> => row !== undefined);
    const capabilities = account
      ? this.adapters.get(account.providerType as SyncProviderType)?.capabilities
        ?? {balance: false, rates: false, quota: false, auth: "manual" as const}
      : {balance: false, rates: false, quota: false, auth: "manual" as const};
    // 最近一次成功同步的密钥对比结果（存于 run detail，供页面按密钥展示同步成败与原因）。
    const runs = account || planConfig ? this.store.latestSyncRuns(targetId, 10) : [];
    const latestOkRun = runs.find(run => run.status === "ok");
    const credentialComparison = latestOkRun
      ? (JSON.parse(latestOkRun.detailJson) as SyncResult).credentialComparison ?? null
      : null;
    return {
      account: account
        ? {
            id: account.id,
            targetId: account.targetId,
            providerType: account.providerType,
            resolvedProvider: secret?.resolvedProvider ?? null,
            credentialMasked: secret ? fingerprintForSecret(secret.password) : undefined,
            consoleBaseUrl: account.consoleBaseUrl,
            username: account.username,
            credentialId: account.credentialId,
            loginMode: account.loginMode,
            status: account.status,
            lastSyncAt: account.lastSyncAt,
            lastSyncError: account.lastSyncError,
            consecutiveAutoFailures: account.consecutiveAutoFailures,
            consecutiveFailureKind: account.consecutiveFailureKind,
            nextSyncAt: account.nextSyncAt,
            syncIntervalMinutes: account.syncIntervalMinutes,
            createdAt: account.createdAt,
            updatedAt: account.updatedAt,
          }
        : null,
      balance,
      rates,
      credentialComparison,
      runs,
      capabilities,
      plan: {
        config: planConfig
          ? {
              id: planConfig.id,
              targetId: planConfig.targetId,
              providerType: planConfig.providerType,
              credentialId: planConfig.credentialId,
              status: planConfig.status,
              lastSyncAt: planConfig.lastSyncAt,
              lastSyncError: planConfig.lastSyncError,
              consecutiveAutoFailures: planConfig.consecutiveAutoFailures,
              consecutiveFailureKind: planConfig.consecutiveFailureKind,
              nextSyncAt: planConfig.nextSyncAt,
              syncIntervalMinutes: planConfig.syncIntervalMinutes,
              createdAt: planConfig.createdAt,
              updatedAt: planConfig.updatedAt,
              hasAccessKey: Boolean(planConfig.accessKeyRef),
              hasSecretKey: Boolean(planConfig.secretKeyRef),
              accessKeyMasked,
              secretKeyMasked,
            }
          : null,
        quota: planConfig
          ? (() => {
              const quota = this.store.latestPlanQuotas(targetId, {
                credentialId: planConfig.credentialId,
                limit: 20,
              });
              return {...quota, items: quota.items.map(restoreLegacyZhipuQuota)};
            })()
          : {items: [], candidateCount: 0, processedCount: 0, limited: false},
        capabilities: planConfig
          ? this.planAdapters.get(planConfig.providerType as PlanProviderType)?.capabilities ?? null
          : null,
      },
    };
  }

  /** 套餐同步独立执行并追加快照；失败只更新状态与 run，不删除最近成功数据。 */
  async runPlanSync(targetId: string, options: {automatic?: boolean} = {}): Promise<SyncResult> {
    const planConfig = this.store.getPlanSyncConfig(targetId);
    if (!planConfig) throw new Error("PLAN_SYNC_NOT_CONFIGURED");
    // 周期来自配置行（迁移回填 30 分钟，新保存默认 5 分钟），账号与套餐链路各自独立。
    const intervalMs = planConfig.syncIntervalMinutes * 60_000;
    await this.configStore.reload();
    const target = findProxyTarget(this.configStore.getConfig(), targetId);
    if (!target) throw new Error("TARGET_NOT_FOUND");
    if (!target.enabled) throw new Error("TARGET_DISABLED");
    const adapter = this.planAdapters.get(planConfig.providerType as PlanProviderType);
    if (!adapter) throw new Error("PLAN_PROVIDER_UNSUPPORTED");
    const needsCredential = !isVolcenginePlanProvider(planConfig.providerType as PlanProviderType)
      && planConfig.providerType !== "openai-subscription"
      && planConfig.providerType !== "anthropic-subscription";
    if (needsCredential) {
      if (!planConfig.credentialId) throw new Error("PLAN_CREDENTIAL_REQUIRED");
      const credential = await this.credentialsRepository.find(planConfig.credentialId);
      if (!credential || credential.targetId !== targetId) {
        throw new Error("PLAN_CREDENTIAL_TARGET_MISMATCH");
      }
    }
    const baseUrl = target.openaiUrl || target.anthropicUrl;
    if (!baseUrl) throw new Error("PROTOCOL_URL_REQUIRED");
    this.store.setPlanSyncConfigStatus(targetId, "running", {
      nextSyncAt: nextSchedule(intervalMs, undefined),
    });
    const startedAt = new Date().toISOString();
    const adapterInput: PlanSyncInput = {
      targetId,
      baseUrl,
      credentialId: planConfig.credentialId ?? undefined,
      accessKeyRef: planConfig.accessKeyRef ?? undefined,
      secretKeyRef: planConfig.secretKeyRef ?? undefined,
      resolveCredential: async credentialId => await this.spawnCredential(["get", credentialId]),
      resolveSecretReference: async reference => await this.spawnCredential(["get", reference]),
    };
    try {
      const result = await adapter.sync(adapterInput);
      const capturedAt = new Date().toISOString();
      if (result.planQuota?.length) {
        this.store.insertPlanQuotaSnapshots(result.planQuota.map(snapshot => ({
          targetId,
          planSyncId: planConfig.id,
          consoleAccountId: null,
          credentialId: planConfig.credentialId,
          providerType: result.providerType,
          planFamily: snapshot.planFamily ?? null,
          planName: snapshot.planName ?? null,
          windowLabel: snapshot.windowLabel,
          used: snapshot.used ?? null,
          total: snapshot.total ?? null,
          remaining: snapshot.remaining ?? null,
          unit: snapshot.unit ?? null,
          resetAt: snapshot.resetAt ?? null,
          rawJson: JSON.stringify(snapshot.raw ?? {}),
          capturedAt,
        })));
      }
      this.store.setPlanSyncConfigStatus(targetId, "ok", {
        lastSyncAt: capturedAt,
        nextSyncAt: nextSchedule(intervalMs, undefined),
        // 任何一次成功（自动或手动）都清零连续失败计数与类别：标识立即消失。
        autoFailure: {op: "reset"},
      });
      this.store.insertSyncRun({
        consoleAccountId: null,
        targetId,
        status: "ok",
        mode: "plan",
        detailJson: JSON.stringify({
          providerType: result.providerType,
          quotaCount: result.planQuota?.length ?? 0,
        }),
        startedAt,
        finishedAt: new Date().toISOString(),
      });
      // 用户未手动录入月费且同步已返回套餐档位名时，按目录档位表自动回填（best-effort，失败不影响同步结果）。
      const autofilledFee = await this.autofillPlanMonthlyFeeFromCatalog(
        target,
        (result.planQuota ?? []).map(snapshot => snapshot.planName),
      );
      // 额度差分估算回填（2026-09-29 二期，docs/额度差分估算回填机制设计文档.md）：
      // 新快照即新差分信号；门禁按账本待补写行存在性短路（积分公式供应商零开销）。
      // best-effort：任何失败只记日志，绝不影响同步结果与状态。月费优先读目标配置，
      // 刚被档位表自动回填的取回填结果（target 内存对象不反映本次落盘值）。
      try {
        const monthlyFee = target.pricing?.planMonthlyFee ?? autofilledFee?.monthlyFee;
        const feeCurrency = target.pricing?.settlementCurrency === "USD" || target.pricing?.settlementCurrency === "CNY"
          ? target.pricing.settlementCurrency
          : autofilledFee?.feeCurrency
            ?? derivePresetCurrency(resolveOfficialPresetForTarget(target));
        const outcome = runPlanEstimateBackfill(this.store.database, {
          targetId,
          providerType: result.providerType,
          monthlyFee,
          feeCurrency,
        });
        /* 只记真实产出（estimated）；skip 是稳态预期（percent 粒度不足、无正差分属
           常态），逐条打印只会刷屏（2026-09-30 用户确认）。 */
        if (outcome.status === "estimated") {
          console.info(`[deepaa] plan-estimate-backfill ${targetId}: ${JSON.stringify(outcome)}`);
        }
      } catch (error) {
        console.error(`[deepaa] plan-estimate-backfill ${targetId} failed`, error);
      }
      return result;
    } catch (error) {
      const authRequired = error instanceof SyncAuthRequiredError;
      const message = error instanceof Error ? error.message : String(error);
      this.store.setPlanSyncConfigStatus(targetId, authRequired ? "auth_required" : "failed", {
        error: message,
        nextSyncAt: nextSchedule(intervalMs, authRequired ? AUTH_RETRY_MS : FAIL_RETRY_MS),
        // 连续失败计数只看自动链路；手动失败页面已有即时反馈，不加也不清。
        // 类别随最近一次失败更新：鉴权/凭证类（auth）一次即亮，其余走默认「连续两次」门槛。
        autoFailure: options.automatic === true
          ? {op: "increment", kind: authRequired ? "auth" : "default"}
          : undefined,
      });
      this.store.insertSyncRun({
        consoleAccountId: null,
        targetId,
        status: authRequired ? "auth_required" : "failed",
        mode: "plan",
        detailJson: JSON.stringify({error: message}),
        startedAt,
        finishedAt: new Date().toISOString(),
      });
      throw error;
    } finally {
      // 同步结束（成功或失败）都会写状态/快照：概览缓存必须让位给新数据。
      this.invalidateOverviewCache();
    }
  }

  /**
   * 额度差分估算复跑扫描（2026-10-09 水位线制，F3 双触发之一）：
   * 对账本存在待补写行（unavailable）的目标复跑回填，闭合「派生落库晚于同步钩子」
   * 的竞争窗口——结算游标保证同一差分段绝不重复分摊。只读已落盘月费
   * （同步链路自动回填后配置即持有），不做档位表回填；单目标失败不阻断其它目标。
   */
  async runPlanEstimateBackfillSweep(): Promise<void> {
    const targetRows = this.db.prepare(`
      SELECT DISTINCT target_id FROM usage_ledger
      WHERE billing_channel IN ('plan', 'subscription')
        AND (plan_credit_unit IS NULL OR plan_credit_unit = '')
        AND plan_estimated_status = 'unavailable'
      LIMIT 50`).all() as Array<{target_id: string}>;
    if (targetRows.length === 0) return;
    await this.configStore.reload();
    const config = this.configStore.getConfig();
    for (const {target_id: targetId} of targetRows) {
      try {
        const target = findProxyTarget(config, targetId);
        if (!target || !target.enabled) continue;
        const providerRow = this.db.prepare(`
          SELECT provider_type FROM plan_quota_snapshots
          WHERE target_id = ? ORDER BY captured_at DESC LIMIT 1`).get(targetId) as
          {provider_type: string} | undefined;
        if (!providerRow?.provider_type) continue;
        const monthlyFee = target.pricing?.planMonthlyFee;
        if (monthlyFee === undefined || !Number.isFinite(monthlyFee) || monthlyFee < 0) continue;
        const feeCurrency = target.pricing?.settlementCurrency === "USD"
          || target.pricing?.settlementCurrency === "CNY"
          ? target.pricing.settlementCurrency
          : derivePresetCurrency(resolveOfficialPresetForTarget(target));
        const outcome = runPlanEstimateBackfill(this.db, {
          targetId,
          providerType: providerRow.provider_type,
          monthlyFee,
          feeCurrency,
        });
        if (outcome.status === "estimated") {
          console.info(`[deepaa] plan-estimate-backfill-sweep ${targetId}: ${JSON.stringify(outcome)}`);
        }
      } catch (error) {
        console.error(`[deepaa] plan-estimate-backfill-sweep ${targetId} failed`, error);
      }
    }
  }

  /**
   * 套餐同步成功后按官方目录档位表回填月费：仅当用户尚未手动录入
   * （pricing.planMonthlyFee === undefined）且档位可命中时生效；best-effort，
   * 任何失败只记日志，不影响同步结果。
   * 取价（2026-10-10 智谱 Coding Plan）：目标已显式选择档位（pricing.planTier）
   * 时优先按档位 id 精确命中，不依赖上游 planName 是否带档位词；否则按套餐名
   * 匹配。月费按付款周期（pricing.planBillingCycle）取目录折算价（如 Pro 按季
   * 430.4/月），缺省周期保持按月价（兼容旧行为）。
   */
  private async autofillPlanMonthlyFeeFromCatalog(
    target: ProxyTarget,
    planNames: ReadonlyArray<string | null | undefined>,
  ): Promise<{monthlyFee: number; feeCurrency: "CNY" | "USD"} | undefined> {
    const loadPlanCatalog = this.loadPlanCatalog;
    if (!loadPlanCatalog) return;
    try {
      if (target.pricing?.planMonthlyFee !== undefined) return undefined;
      const preset = resolveOfficialPresetForTarget(target);
      if (!preset) return undefined;
      const catalog = await loadPlanCatalog();
      const provider = catalog?.providers[preset.catalogKey];
      if (!provider?.planTiers?.length) return undefined;
      const cycle = target.pricing?.planBillingCycle;
      const pinnedTier = target.pricing?.planTier
        ? provider.planTiers.find(tier => tier.id === target.pricing?.planTier)
        : undefined;
      const monthlyFee = pinnedTier
        ? resolvePlanTierFee(pinnedTier, cycle)
        : matchPlanTierMonthlyFee(provider.planTiers, planNames, cycle);
      if (monthlyFee === undefined) return undefined;
      /* 月费币种随回填一并落盘（2026-09-28）：显式 settlementCurrency 优先，
         缺失时按目录供应商币种兜底（provider.currency；目录行缺声明时退注册表预设币种），
         避免后续派生继续依赖兜底路径。 */
      const feeCurrency = target.pricing?.settlementCurrency
        ?? provider.currency
        ?? derivePresetCurrency(preset);
      await this.configStore.updateConfig({
        targetPatch: {
          id: target.id,
          target: {
            pricing: {
              ...target.pricing,
              planMonthlyFee: monthlyFee,
              ...(feeCurrency ? {settlementCurrency: feeCurrency} : {}),
            },
          },
        },
      });
      return {monthlyFee, feeCurrency: feeCurrency === "USD" ? "USD" : "CNY"};
    } catch (error) {
      console.error("[deepaa] plan monthly fee autofill failed", error);
      return undefined;
    }
  }

  /** 解析目标所属预设的套餐档位 id 集合（目录不可达/无预设返回 undefined，由调用方决定放行）。 */
  private async resolvePlanTierIds(target: ProxyTarget): Promise<string[] | undefined> {
    const loadPlanCatalog = this.loadPlanCatalog;
    if (!loadPlanCatalog) return undefined;
    try {
      const preset = resolveOfficialPresetForTarget(target);
      if (!preset) return undefined;
      const catalog = await loadPlanCatalog();
      const provider = catalog?.providers[preset.catalogKey];
      return provider?.planTiers
        ?.map(tier => tier.id?.trim())
        .filter((id): id is string => Boolean(id));
    } catch {
      return undefined;
    }
  }

  /** 立即或定时同步单个供应商；自动模式允许降级 Playwright 登录。 */
  async runSync(
    targetId: string,
    options: {automatic?: boolean} = {},
  ): Promise<SyncResult> {
    const account = this.store.getConsoleAccount(targetId);
    if (!account) throw new Error("CONSOLE_ACCOUNT_NOT_CONFIGURED");
    // 周期来自配置行（迁移回填 30 分钟，新保存默认 5 分钟），账号与套餐链路各自独立。
    const intervalMs = account.syncIntervalMinutes * 60_000;
    const secret = await this.consoleCredentials.find(targetId);
    if (!secret) throw new Error("CONSOLE_CREDENTIALS_MISSING");
    // 供应商可能刚在页面保存/启用：先 reload 持久化配置，
    // 避免缓存旧配置把已启用的供应商误判为 TARGET_DISABLED。
    await this.configStore.reload();
    const target = findProxyTarget(this.configStore.getConfig(), targetId);
    if (!target) throw new Error("TARGET_NOT_FOUND");
    if (!target.enabled) throw new Error("TARGET_DISABLED");
    // 标记 running：防止调度器在本次同步未结束时重复拉起同一账号；
    // 卡死超过 10 分钟由 dueAccounts 的陈旧判定重新调度。
    this.store.setConsoleAccountStatus(targetId, "running", {nextSyncAt: nextSchedule(intervalMs, undefined)});

    const adapter = this.adapters.get(secret.providerType as SyncProviderType);
    if (!adapter) throw new Error("SYNC_PROVIDER_UNSUPPORTED");
    const credentials = await this.credentialsRepository.list(targetId);
    const startedAt = new Date().toISOString();
    const input: SyncInput = {
      targetId,
      consoleBaseUrl: secret.consoleBaseUrl,
      username: secret.username,
      password: secret.password,
      ...(secret.resolvedProvider ? {resolvedProvider: secret.resolvedProvider} : {}),
      credentials: credentials.map(item => ({id: item.id, label: item.label, fingerprintSuffix: item.fingerprintSuffix})),
      // 余额查询密钥：账号行显式值优先（api_key 站点保存时已校验归属）；
      // 存量账号（v53 前无显式值）回退 Agent 默认密钥表按注册表顺序取第一个——
      // codex/claude 在序首，与旧 `codex || claude` 行为完全一致，同时让只接
      // opencode/dsh/zcode 的目标不再凭空 MISSING。
      defaultCredentialId: account.credentialId ?? firstAgentDefaultCredentialId(target),
      allowPlaywright: options.automatic !== false,
      resolveCredential: async credentialId => {
        const token = await this.spawnCredential(["get", credentialId]);
        return token;
      },
    };

    try {
      const result = await this.runAdapter(adapter, input, options);
      // 中转站首次同步识别成功后记录底层类型，后续同步不再循环探测。
      if (secret.providerType === "relay"
        && !secret.resolvedProvider
        && (result.providerType === "sub2api" || result.providerType === "newapi")) {
        await this.consoleCredentials.upsert({
          ...secret,
          resolvedProvider: result.providerType,
          updatedAt: new Date().toISOString(),
        });
      }
      if (result.balance) {
        this.store.insertBalance({
          targetId,
          consoleAccountId: account.id,
          providerType: result.providerType,
          currency: result.balance.currency,
          amount: result.balance.amount,
          quota: result.balance.quota ?? null,
          usedQuota: result.balance.usedQuota ?? null,
          source: result.balance.source,
          rawJson: JSON.stringify(result.balance.raw ?? {}),
          capturedAt: new Date().toISOString(),
        });
      }
      if (result.rates?.length) {
        const capturedAt = new Date().toISOString();
        this.store.insertRates(result.rates.map(rate => ({
          targetId,
          credentialId: rate.credentialId,
          tokenGroup: rate.tokenGroup ?? null,
          ratio: rate.ratio,
          source: rate.source,
          capturedAt,
        })));
        // 自动对齐：同步到的倍率写回密钥元数据（覆盖手动值），
        // 使密钥列表展示与计费读取链与中转站保持一致；写回失败不影响同步结果。
        await this.applyRateWriteBack(result.rates);
      }
      // 远端匹配成功但未返回有效倍率：只产出黄标提醒（概览/侧栏/密钥列表据此展示），
      // 绝不改动密钥适用、默认密钥、目标绑定与 Agent 连接（2026-09-18 用户决策）。
      const rateWarnings = rateUnconfirmedNotes(result.credentialComparison);
      if (rateWarnings.length > 0) result.rateSyncWarnings = rateWarnings;
      // 远程密钥名对齐：一旦能从控制台拿到匹配成功的远程名称，本地密钥自动改名跟随，
      // 免去用户手动维护两套名称；失败不阻断同步。
      for (const comparison of result.credentialComparison ?? []) {
        if (!comparison.matched || !comparison.remoteName) continue;
        await this.credentialsRepository.updateLabel(comparison.credentialId, comparison.remoteName)
          .catch(error => console.error(`[deepaa] sync label write-back failed for ${comparison.credentialId}`, error));
      }
      // 同步不再预种对账小时（2026-09-28 用户确认）：小时行由复核轮按本地活动发现创建。
      this.store.setConsoleAccountStatus(targetId, "ok", {
        lastSyncAt: new Date().toISOString(),
        nextSyncAt: nextSchedule(intervalMs, undefined),
        // 任何一次成功（自动或手动）都清零连续失败计数与类别：标识立即消失。
        autoFailure: {op: "reset"},
      });
      this.store.insertSyncRun({
        consoleAccountId: account.id,
        targetId,
        status: "ok",
        mode: "http",
        detailJson: JSON.stringify(result),
        startedAt,
        finishedAt: new Date().toISOString(),
      });
      return result;
    } catch (error) {
      const authRequired = error instanceof SyncAuthRequiredError;
      // 不支持自动同步的存量账号：记录失败状态但不再进入调度重试，等待用户清理。
      const unsupported = error instanceof SyncUnsupportedError && error.message === "ACCOUNT_SYNC_UNSUPPORTED";
      const message = error instanceof Error ? error.message : String(error);
      this.store.setConsoleAccountStatus(targetId, authRequired ? "auth_required" : "failed", {
        error: message,
        nextSyncAt: unsupported
          ? null
          : nextSchedule(intervalMs, authRequired ? AUTH_RETRY_MS : FAIL_RETRY_MS),
        // 连续失败计数只看自动链路；手动失败页面已有即时反馈，不加也不清。
        // 类别随最近一次失败更新：鉴权/凭证类（auth）一次即亮，其余走默认「连续两次」门槛。
        autoFailure: options.automatic === true
          ? {op: "increment", kind: authRequired ? "auth" : "default"}
          : undefined,
      });
      this.store.insertSyncRun({
        consoleAccountId: account.id,
        targetId,
        status: authRequired ? "auth_required" : "failed",
        mode: "http",
        detailJson: JSON.stringify({error: message}),
        startedAt,
        finishedAt: new Date().toISOString(),
      });
      throw error;
    } finally {
      // 同步结束（成功或失败）都会写状态/快照：概览缓存必须让位给新数据。
      this.invalidateOverviewCache();
    }
  }

  /**
   * 同步倍率写回密钥元数据（自动对齐，覆盖手动值）；单条失败不阻断同步。
   *
   * 只处理远端**确实返回了有效倍率**的密钥。远端没返回倍率的密钥保持原值不动
   * （2026-09-18 用户决策）：倍率参与计费读取链，静默清空会让历史口径无声漂移，
   * 因此改为在供应商列表 / 密钥同步列表出黄标，由用户到站点确认后手工修正。
   */
  async applyRateWriteBack(rates: RateSnapshotInput[]): Promise<void> {
    for (const rate of rates) {
      await this.credentialsRepository.updateRateMultiplier(rate.credentialId, rate.ratio).catch(error => {
        console.error(`[deepaa] sync rate write-back failed for ${rate.credentialId}`, error);
      });
    }
  }

  /**
   * 旧五分钟窗口只读诊断接口，保留历史证据而不提供按旧 diff 补账能力；
   * 新页面只展示旧窗口数量，小时明细走 ReconciliationStore 的 keyset。
   */
  listPendingReconciliationWindows(targetId?: string, options?: {page?: number; pageSize?: number}): {
    windows: Array<{
      id: number;
      targetId: string;
      windowStart: string;
      windowEnd: string;
      siteSpend: number;
      localSpend: number;
      diffAmount: number;
      requestCount: number;
      successCount: number;
      errorNoUsageCount: number;
    }>;
    total: number;
    page: number;
    pageSize: number;
    pageCount: number;
  } {
    const page = Math.max(1, Math.floor(Number(options?.page) || 1));
    const pageSize = Math.max(1, Math.min(Math.floor(Number(options?.pageSize) || RECONCILIATION_PAGE_SIZE), RECONCILIATION_PAGE_SIZE));
    const where = targetId ? "WHERE target_id = ? AND status = 'needs_review'" : "WHERE status = 'needs_review'";
    const params: unknown[] = targetId ? [targetId] : [];
    const total = (this.db.prepare(
      `SELECT COUNT(*) AS total FROM reconciliation_windows ${where}`,
    ).get(...params) as {total: number}).total;
    const pageCount = Math.max(1, Math.ceil(total / pageSize));
    const rows = this.db.prepare(
      `SELECT id, target_id, window_start, window_end, site_spend, local_spend, diff_amount
       FROM reconciliation_windows ${where}
       ORDER BY window_end DESC, id DESC LIMIT ? OFFSET ?`,
    ).all(...params, pageSize, (page - 1) * pageSize) as Array<Record<string, unknown>>;
    const windows = rows.map(row => {
      const stats = this.db.prepare(
        `SELECT COUNT(*) AS total,
           SUM(CASE WHEN COALESCE(result_class, '') = 'success' THEN 1 ELSE 0 END) AS ok,
           SUM(CASE WHEN COALESCE(result_class, '') NOT IN ('success', 'cancelled', 'incomplete', 'reconciled')
             AND COALESCE(usage_source, '') NOT IN ('provider_usage', 'reconstructed_stream_usage') THEN 1 ELSE 0 END) AS errNoUsage
         FROM usage_ledger
         WHERE target_id = ? AND created_at > ? AND created_at <= ?`,
      ).get(row.target_id, row.window_start, row.window_end) as {total: number; ok: number | null; errNoUsage: number | null};
      return {
        id: Number(row.id),
        targetId: String(row.target_id),
        windowStart: String(row.window_start),
        windowEnd: String(row.window_end),
        siteSpend: Number(row.site_spend),
        localSpend: Number(row.local_spend),
        diffAmount: Number(row.diff_amount),
        requestCount: Number(stats.total || 0),
        successCount: Number(stats.ok || 0),
        errorNoUsageCount: Number(stats.errNoUsage || 0),
      };
    });
    return {windows, total, page, pageSize, pageCount};
  }

  /** 旧五分钟快照的差额可能虚高；永久拒绝按旧值直接写账本。 */
  async applyReconciliationWindow(windowId: number): Promise<{targetId: string; diffAmount: number}> {
    void windowId;
    throw new Error("LEGACY_WINDOW_RECHECK_REQUIRED");
  }

  /** 有界小时复核由 web 调度器驱动；单小时异常只改变该小时状态，不影响账号同步。 */
  async reconcileDueHours(nowIso = new Date().toISOString()): Promise<void> {
    await this.discoverReconciliationHours(nowIso);
    await reviewDueReconciliationHours({
      store: this.reconciliation, nowIso,
      fetchSite: hour => this.fetchReconciliationSiteHour(hour),
      remoteKeyIds: hour => this.reconciliationRemoteKeys(hour),
      lightCheck: hour => this.lightCheckReconciliationHour(hour),
      eligible: hour => this.reconciliationHourEligible(hour),
      settlementFx: hour =>
        findProxyTarget(this.configStore.getConfig(), hour.targetId)?.pricing?.settlementFx ?? 1,
    });
  }

  /**
   * 活动驱动发现（2026-09-28 用户确认）：不再按同步预种小时；每轮从完成时刻
   * 索引发现「近 48 小时内有本地活动但没有小时行」的整小时并为它们建行。
   * 空小时零记录、零站点流量；停用目标/异常账号不发现（与复核资格同口径）。
   */
  private async discoverReconciliationHours(nowIso: string): Promise<void> {
    const now = Date.parse(nowIso);
    if (!Number.isFinite(now)) return;
    const since = new Date(now - 48 * 3_600_000).toISOString();
    const accounts = this.db.prepare(
      `SELECT id, target_id, provider_type FROM console_accounts
       WHERE provider_type IN ('relay','sub2api','newapi') AND status IN ('ok','idle','running')`,
    ).all() as Array<{id: string; target_id: string; provider_type: string}>;
    for (const account of accounts) {
      if (!this.reconciliationTargetEligible(account.target_id)) continue;
      let provider: "sub2api" | "newapi" | undefined
        = account.provider_type === "sub2api" || account.provider_type === "newapi"
          ? account.provider_type : undefined;
      if (!provider) {
        const secret = await this.consoleCredentials.find(account.target_id).catch(() => undefined);
        const resolved = secret?.providerType === "relay" ? secret.resolvedProvider : undefined;
        provider = resolved === "sub2api" || resolved === "newapi" ? resolved : undefined;
      }
      if (!provider) continue;
      for (const bucket of this.reconciliation.missingActivityHours(account.target_id, since)) {
        this.reconciliation.seedHour(account.target_id, account.id, provider, bucket);
      }
    }
  }

  /** 复核/发现资格：目标启用且按量；账号存在且状态正常（2026-09-28 用户确认）。 */
  private reconciliationTargetEligible(targetId: string): boolean {
    const target = findProxyTarget(this.configStore.getConfig(), targetId);
    if (!target?.enabled || (target.billingChannel && target.billingChannel !== "pay_as_you_go")) {
      return false;
    }
    const account = this.store.getConsoleAccount(targetId);
    return Boolean(account) && ["ok", "idle", "running"].includes(account!.status);
  }

  private reconciliationHourEligible(hour: HourRow): boolean {
    const account = this.store.getConsoleAccount(hour.targetId);
    if (!account || account.id !== hour.consoleAccountId
      || !["ok", "idle", "running"].includes(account.status)) return false;
    return this.reconciliationTargetEligible(hour.targetId);
  }

  /** 已定稿小时的轻量复查：只拉 stat/日总数，键未变时跳过整段明细重拉。 */
  private async lightCheckReconciliationHour(hour: HourRow): Promise<string | undefined> {
    const {secret} = await this.resolveReconciliationAccess(hour);
    if (hour.providerType === "sub2api") {
      const token = await sub2ApiLoginCached(secret.consoleBaseUrl, secret.username,
        secret.password, this.fetchImpl);
      return fetchSub2ApiDayTotalLight(secret.consoleBaseUrl, token, hour.hourStartUtc,
        this.fetchImpl);
    }
    const session = await newApiSessionCached(secret.consoleBaseUrl,
      secret.username, secret.password, this.fetchImpl);
    return fetchNewApiStatLight(secret.consoleBaseUrl, session, hour.hourStartUtc,
      this.fetchImpl);
  }

  /** 复核与轻量复查共用的目标/账号/身份/币种门禁；不满足即抛错走失败记账。 */
  private async resolveReconciliationAccess(hour: HourRow) {
    const account = this.store.getConsoleAccount(hour.targetId);
    const target = findProxyTarget(this.configStore.getConfig(), hour.targetId);
    const secret = await this.consoleCredentials.find(hour.targetId);
    if (!account || account.id !== hour.consoleAccountId
      || !target?.enabled || target.billingChannel && target.billingChannel !== "pay_as_you_go"
      || !secret) {
      throw new Error("对账目标/账号已变化或停用");
    }
    if (!hour.consoleIdentityHash
      || hour.consoleIdentityHash !== this.reconciliation.currentConsoleIdentityHash(
        hour.targetId, account.id, hour.providerType)
      || secret.consoleBaseUrl.replace(/\/+$/u, "") !== account.consoleBaseUrl.replace(/\/+$/u, "")
      || secret.username !== account.username
      || (secret.providerType === "relay" ? secret.resolvedProvider : secret.providerType)
        !== hour.providerType) {
      throw new Error("对账小时的控制台站点/账号身份已改变");
    }
    return {account, target, secret};
  }

  private async fetchReconciliationSiteHour(hour: HourRow) {
    const {secret} = await this.resolveReconciliationAccess(hour);
    // 登录会话短期复用（内存、TTL 10 分钟），避免每次复核都打登录接口。
    if (hour.providerType === "sub2api") {
      const token = await sub2ApiLoginCached(secret.consoleBaseUrl, secret.username,
        secret.password, this.fetchImpl);
      const snapshot = await fetchSub2ApiHour(secret.consoleBaseUrl, token,
        hour.hourStartUtc, this.fetchImpl);
      if (snapshot.httpStatus === 401 || snapshot.httpStatus === 403) {
        invalidateSub2ApiSession(secret.consoleBaseUrl, secret.username);
      }
      return snapshot;
    }
    const session = await newApiSessionCached(secret.consoleBaseUrl,
      secret.username, secret.password, this.fetchImpl);
    const snapshot = await fetchNewApiHour(secret.consoleBaseUrl, session,
      hour.hourStartUtc, this.fetchImpl);
    if (snapshot.httpStatus === 401 || snapshot.httpStatus === 403) {
      invalidateNewApiSession(secret.consoleBaseUrl, secret.username);
    }
    return snapshot;
  }

  private async reconciliationRemoteKeys(hour: HourRow): Promise<string[]> {
    const account = this.store.getConsoleAccount(hour.targetId);
    if (!account) return [];
    // 共用同一个控制台账号时，远端账单范围不等于单个目标，禁止自动归属。
    const reused = this.db.prepare(
      `SELECT 1 FROM console_accounts
       WHERE target_id <> ? AND console_base_url = ? AND username = ? LIMIT 1`,
    ).get(hour.targetId, account.consoleBaseUrl, account.username);
    if (reused) return [];
    const credentials = await this.credentialsRepository.list(hour.targetId);
    const comparisons = this.store.latestCredentialComparison(hour.targetId);
    const currentIds = new Set(credentials.map(item => item.id));
    if (currentIds.size === 0 || comparisons.length !== currentIds.size
      || comparisons.some(item =>
        !currentIds.has(item.credentialId) || !item.matched || !item.remoteKeyId)
      || new Set(comparisons.map(item => item.credentialId)).size !== currentIds.size) return [];
    const ids = comparisons.map(item => item.remoteKeyId!);
    return new Set(ids).size === ids.length ? ids : [];
  }

  listReconciliationHours(options: {
    targetId?: string; limit?: number; cursor?: string;
  } = {}) {
    const result = this.reconciliation.listHours(options);
    // 面板摘要（2026-09-28 用户确认）：全部走小表有界聚合；面板静默化——
    // 待复核为 0 时整个区块不渲染，退避仅作为摘要异常信息出现。
    const prefix = options.targetId ? "target_id = ? AND " : "";
    const scopeParams = options.targetId ? [options.targetId] : [];
    const needsReview = this.db.prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(residual_nano), 0) AS residualNano
       FROM relay_reconciliation_hours WHERE ${prefix}status = 'needs_review'`,
    ).get(...scopeParams) as {n: number; residualNano: number};
    /* 近 24 小时已自动补差（2026-09-28 修正口径）：
       ① 金额读 actual_cost_nano（补差行入账时已按原请求冻结 fx 物化的人民币 nano），
         而非 USD 原币 actual_cost——面板该卡是消费结论，按全站人民币口径展示；
       ② 只统计自动补差（exchange_id 前缀 recon:matched: 逐条归属与
         recon:residual: 小时残差），与卡片文案「已自动补差」一致，
         人工补差（recon:manual:）不混入；
       ③ 携带 target 过滤（scopeParams 与待复核查询同源），面板按目标筛选时摘要跟随该目标。 */
    const autoApplied = this.db.prepare(
      `SELECT COALESCE(SUM(actual_cost_nano), 0) AS nano, COUNT(*) AS n,
         COALESCE(SUM(CASE WHEN exchange_id LIKE 'recon:residual:%' THEN 1 ELSE 0 END), 0) AS residualN
       FROM usage_ledger
       WHERE ${prefix}request_kind = 'reconciliation'
         AND (exchange_id LIKE 'recon:matched:%' OR exchange_id LIKE 'recon:residual:%')
         AND created_at >= ?`,
    ).get(...scopeParams, new Date(Date.now() - 24 * 3_600_000).toISOString()) as {
      nano: number; n: number; residualN: number;
    };
    const backoffs = (this.db.prepare(
      `SELECT b.target_id AS targetId, b.retry_after AS retryAfter, b.last_error AS lastError
       FROM relay_site_backoff b
       ${options.targetId ? "WHERE b.target_id = ?" : ""}
       ORDER BY b.target_id`,
    ).all(...scopeParams) as Array<{targetId: string; retryAfter: string | null;
      lastError: string | null}>)
      .filter(row => row.retryAfter !== null);
    return {
      ...result,
      summary: {
        needsReviewCount: needsReview.n,
        needsReviewResidualNano: needsReview.residualNano,
        autoApplied24hNano: autoApplied.nano ?? 0,
        autoApplied24hCount: autoApplied.n,
        autoApplied24hResidualCount: autoApplied.residualN ?? 0,
        backoffs,
      },
    };
  }

  /**
   * 人工点击后重新取站点与本地金额；快照变化先退回复核，不使用之前的 diff。
   * 即使账号范围只能作为候选，用户仍可看到明确提示后自行决定。
   */
  async confirmReconciliationHour(
    targetId: string, hourStartUtc: string,
    expectedResidualNano: number, expectedLastCheckedAt: string,
  ): Promise<number> {
    const hour = this.reconciliation.getHour(targetId, hourStartUtc);
    if (!hour || hour.status !== "needs_review" || hour.stableCount < 2) {
      throw new Error("RECONCILIATION_HOUR_NOT_PENDING");
    }
    const target = findProxyTarget(this.configStore.getConfig(), targetId);
    if (hour.residualNano !== expectedResidualNano
      || hour.lastCheckedAt !== expectedLastCheckedAt) {
      throw new Error("RECONCILIATION_SNAPSHOT_CHANGED");
    }
    const [site, keys] = await Promise.all([
      this.fetchReconciliationSiteHour(hour),
      this.reconciliationRemoteKeys(hour),
    ]);
    const local = this.reconciliation.loadLocalHour(targetId, hourStartUtc);
    if (!site.complete || site.amountNano === null || !local.complete
      || this.reconciliation.hasPendingDerivation(targetId, hourStartUtc)) {
      throw new Error("RECONCILIATION_SOURCE_INCOMPLETE");
    }
    const scopeVerified = site.detailsComplete && keys.length > 0
      && site.records.every(row => row.apiKeyId !== undefined);
    const scoped = scopeVerified
      ? site.records.filter(row => keys.includes(row.apiKeyId!)) : site.records;
    const amount = scopeVerified
      ? scoped.reduce((sum, row) => sum + row.amountNano, 0) : site.amountNano;
    const matches = matchSiteUsage(scoped, local.records, targetId, scopeVerified);
    const comparable = this.reconciliation.comparableLocalHour(
      targetId, hourStartUtc, local,
      accountingMatchesForHour(this.reconciliation, hour, matches.matched),
    );
    const evidenceHash = siteEvidenceHash(site, keys);
    if (amount !== hour.siteAmountNano || comparable !== hour.localAmountNano
      || evidenceHash !== hour.siteEvidenceHash) {
      this.reconciliation.observeHour({
        targetId, hourStartUtc, siteAmountNano: amount,
        localAmountNano: comparable,
        candidateCount: site.candidateCount, processedCount: site.processedCount,
        limited: site.limited, detailsComplete: site.detailsComplete,
        localComplete: comparable !== null, localCandidateCount: local.candidateCount,
        localProcessedCount: local.processedCount,
        matchedCount: hour.matchedCount, unmatchedSiteCount: hour.unmatchedSiteCount,
        source: site.source, observedAt: new Date().toISOString(),
        siteEvidenceHash: evidenceHash,
        ...(site.complete && site.lightCheckKey
          ? {siteLightCheck: site.lightCheckKey} : {}),
        reason: "人工确认时金额或站点明细证据变化，需再次稳定复核",
      });
      throw new Error("RECONCILIATION_SNAPSHOT_CHANGED");
    }
    return this.reconciliation.applyManual(
      targetId, hourStartUtc, expectedResidualNano, expectedLastCheckedAt,
      target?.pricing?.settlementFx ?? 1);
  }

  ignoreReconciliationHour(targetId: string, hourStartUtc: string, reason: string): void {
    this.reconciliation.ignoreHour(targetId, hourStartUtc, reason);
  }

  /**
   * 供应商同步概览（只读、有界）：供应商管理侧栏与仪表盘供应商列表共用。
   *
   * 每个目标只做「有界小表 + LIMIT 1」读取：
   *   `console_accounts`（是否有账号/最近状态）、`balance_snapshots`（最近余额）、
   *   `plan_quota_snapshots`（最近若干时间窗）、`sync_runs`（只解析最新一条 ok run）。
   * 目标数上限 `MAX_OVERVIEW_TARGETS`；单目标时间窗上限 `OVERVIEW_PLAN_WINDOW_LIMIT`。
   * 绝不在本方法里打开 raw capture / blob，也不触发任何网络请求。
   *
   * 结果带短 TTL 缓存：多目标的同步 SQLite 读（窗口函数）在首屏是最大 CPU 块，
   * 而数据本身按分钟级周期变化（同步任务默认 5 分钟）。写路径（同步完成 /
   * 账号与套餐配置增删改）主动失效，TTL 兜底旁路写入；负载只含时间戳与计数，
   * 路由层仅 JSON 序列化不改写，直接共享返回。
   */
  async overview(targetIds: readonly string[]): Promise<SyncOverviewPayload> {
    const requested = [...new Set(targetIds.map(id => id.trim()).filter(Boolean))];
    const cacheKey = requested.join(",");
    const cached = this.overviewCache;
    if (cached && cached.key === cacheKey && Date.now() - cached.at < SyncService.OVERVIEW_CACHE_TTL_MS) {
      return cached.payload;
    }
    const limited = requested.length > MAX_OVERVIEW_TARGETS;
    const ids = requested.slice(0, MAX_OVERVIEW_TARGETS);
    const targets: SyncOverviewTargetSummary[] = [];
    for (const targetId of ids) {
      const account = this.store.getConsoleAccount(targetId);
      const balance = account ? this.store.latestBalance(targetId) : undefined;
      const planConfig = this.store.getPlanSyncConfig(targetId);
      const quota = planConfig
        ? this.store.latestPlanQuotas(targetId, {limit: OVERVIEW_PLAN_WINDOW_LIMIT})
        : undefined;
      const primaryQuota = pickPrimaryPlanQuotaWindow(quota?.items ?? []);
      const rateUnconfirmed = rateUnconfirmedCredentials(
        account ? this.store.latestCredentialComparison(targetId) : [],
      );
      targets.push({
        targetId,
        hasConsoleAccount: Boolean(account),
        accountStatus: account?.status ?? null,
        accountLastSyncAt: account?.lastSyncAt ?? null,
        accountConsecutiveFailures: account?.consecutiveAutoFailures ?? 0,
        accountLastError: account?.lastSyncError ?? null,
        accountFailureKind: account?.consecutiveFailureKind ?? null,
        balance: balance
          ? {
              currency: balance.currency,
              amount: balance.amount,
              capturedAt: balance.capturedAt,
            }
          : null,
        plan: primaryQuota
          ? {
              windowLabel: primaryQuota.windowLabel,
              windowCount: quota?.items.length ?? 0,
              used: primaryQuota.used ?? null,
              total: primaryQuota.total ?? null,
              remaining: primaryQuota.remaining ?? null,
              unit: primaryQuota.unit ?? null,
              resetAt: primaryQuota.resetAt ?? null,
              capturedAt: primaryQuota.capturedAt,
            }
          : null,
        hasPlanConfig: Boolean(planConfig),
        planLastSyncAt: planConfig?.lastSyncAt ?? null,
        planConsecutiveFailures: planConfig?.consecutiveAutoFailures ?? 0,
        planLastError: planConfig?.lastSyncError ?? null,
        planFailureKind: planConfig?.consecutiveFailureKind ?? null,
        /** 远端倍率待确认的密钥（黄标提醒；数量与名称都只用于展示）。 */
        rateUnconfirmedCount: rateUnconfirmed.length,
        rateUnconfirmedLabels: rateUnconfirmed.map(item => item.label),
      });
    }
    const payload: SyncOverviewPayload = {targets, processedCount: targets.length, limited};
    this.overviewCache = {key: cacheKey, payload, at: Date.now()};
    return payload;
  }

  private async runAdapter(
    adapter: SyncConnector,
    input: SyncInput,
    options: {automatic?: boolean},
  ): Promise<SyncResult> {
    try {
      return await adapter.sync(input);
    } catch (error) {
      if (
        (adapter.providerType === "newapi" || adapter.providerType === "sub2api")
        && error instanceof SyncAuthRequiredError
        && input.allowPlaywright
      ) {
        try {
          const payloads = adapter.providerType === "sub2api"
            ? await sub2ApiSyncViaPlaywright(input)
            : await newApiSyncViaPlaywright(input);
          const resolved = await Promise.all(input.credentials.map(async credential => ({
            id: credential.id,
            label: credential.label,
            key: await input.resolveCredential(credential.id),
          })));
          return adapter.providerType === "sub2api"
            ? parseSub2ApiPayloads(payloads as Sub2ApiPayloads, resolved)
            : parseNewApiPayloads(payloads as NewApiPayloads, resolved);
        } catch (playwrightError) {
          // 保留 HTTP 登录根因，避免用户只看到 playwright 未安装而误判为环境问题。
          const reason = playwrightError instanceof Error
            ? playwrightError.message
            : String(playwrightError);
          throw new Error(`${reason}；HTTP 登录失败原因：${error.message}`);
        }
      }
      throw error;
    }
  }

  private spawnCredential(args: string[], secret?: string): Promise<string> {
    return new Promise((resolvePromise, reject) => {
      // Windows 无法直接执行带 shebang 的 .mjs 脚本（spawn EFTYPE），统一经 process.execPath 启动。
      const win32 = process.platform === "win32";
      const child = spawn(
        win32 ? process.execPath : this.credentialHelperPath,
        win32 ? [this.credentialHelperPath, ...args] : args,
        {
          stdio: [secret === undefined ? "ignore" : "pipe", "pipe", "ignore"],
        },
      );
      let stdout = "";
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error("CREDENTIAL_HELPER_TIMEOUT"));
      }, CREDENTIAL_TIMEOUT_MS);
      child.stdout?.on("data", chunk => {
        stdout += chunk.toString("utf8");
      });
      child.once("error", error => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("close", code => {
        clearTimeout(timer);
        if (code !== 0) {
          reject(new Error(`CREDENTIAL_HELPER_EXIT_${String(code)}`));
          return;
        }
        resolvePromise(stdout.replace(/[\r\n]+$/u, ""));
      });
      if (secret !== undefined) child.stdin?.end(`${secret}\n`);
    });
  }

  private async putPlanSecrets(
    values: Array<{reference: string; label: string; value: string}>,
  ): Promise<void> {
    for (const item of values) {
      await this.spawnCredential(["put", item.reference, item.label], item.value);
    }
  }

  /** 套餐 AK/SK 打码串：只回前4+****+后4；带 5 分钟内存缓存，避免状态轮询反复拉起 helper。 */
  private async maskedPlanSecret(reference: string | null | undefined): Promise<string | undefined> {
    if (!reference) return undefined;
    const cached = SyncService.maskedPlanSecretCache.get(reference);
    if (cached && Date.now() - cached.at < 300_000) return cached.value ?? undefined;
    let masked: string | null = null;
    try {
      masked = fingerprintForSecret(await this.spawnCredential(["get", reference]));
    } catch {
      masked = null;
    }
    SyncService.maskedPlanSecretCache.set(reference, {value: masked, at: Date.now()});
    return masked ?? undefined;
  }

  /**
   * 凭据明文取回：仅供同源 + nonce 保护的 reveal 接口调用。
   * 三种 kind 都先校验归属（目标一致/引用一致），防止跨目标越权取回。
   */
  async revealSecret(input: {kind: "credential" | "console" | "plan-ak" | "plan-sk"; targetId: string; credentialId?: string}): Promise<string> {
    if (input.kind === "console") {
      const secret = await this.consoleCredentials.find(input.targetId);
      if (!secret) throw new Error("CONSOLE_CREDENTIALS_MISSING");
      return secret.password;
    }
    if (input.kind === "credential") {
      if (!input.credentialId) throw new Error("INVALID_REQUEST");
      const credential = await this.credentialsRepository.find(input.credentialId);
      if (!credential || credential.targetId !== input.targetId) throw new Error("CREDENTIAL_NOT_FOUND");
      return this.spawnCredential(["get", input.credentialId]);
    }
    const config = this.store.getPlanSyncConfig(input.targetId);
    const suffix = input.kind === "plan-ak" ? "ak" as const : "sk" as const;
    const expected = suffix === "ak" ? config?.accessKeyRef : config?.secretKeyRef;
    if (!expected || expected !== planSecretReference(input.targetId, suffix)) {
      throw new Error("PLAN_SECRET_NOT_CONFIGURED");
    }
    return this.spawnCredential(["get", expected]);
  }

  private static readonly maskedPlanSecretCache = new Map<string, {value: string | null; at: number}>();
  private readonly fetchImpl: typeof fetch;
}

function isVolcenginePlanProvider(providerType: PlanProviderType): boolean {
  return providerType === "volcengine-plan" || providerType === "volcengine-coding-plan";
}

export function planSecretReference(targetId: string, suffix: "ak" | "sk"): string {
  return `plan_${createHash("sha256").update(targetId).digest("hex").slice(0, 24)}_${suffix}`;
}

/** 下次同步时间：成功 = interval + jitter；失败 = 固定重试间隔。 */
export function nextSchedule(intervalMs: number, retryMs: number | undefined): string {
  const base = retryMs ?? intervalMs;
  const jitter = retryMs === undefined
    ? base * SYNC_JITTER_RATIO * (Math.random() * 2 - 1)
    : 0;
  return new Date(Date.now() + base + jitter).toISOString();
}

function normalizeConsoleBaseUrl(value: string): string {
  const url = new URL(value.trim());
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("INVALID_CONSOLE_BASE_URL");
  }
  return url.toString().replace(/\/+$/u, "");
}

let syncServicePromise: Promise<SyncService> | undefined;

/**
 * 生产共享单例：首次调用时按运行数据目录装配。
 * 内部新建的 ProxyConfigStore 必须先 init 读入持久化配置，
 * 否则配置为空默认值，findProxyTarget 必然命中不到供应商（TARGET_NOT_FOUND）。
 */
export function getSyncService(options?: {
  db?: DeepaaDatabase;
  configStore?: ProxyConfigStore;
  developmentCredentialsPath?: string;
  consoleCredentialsPath?: string;
}): Promise<SyncService> {
  if (syncServicePromise) return syncServicePromise;
  syncServicePromise = (async () => {
    const configStore = options?.configStore ?? new ProxyConfigStore();
    // 无论内部新建还是外部传入，都必须先 init 读入持久化配置，
    // 否则配置为空默认值，findProxyTarget 必然命中不到供应商（TARGET_NOT_FOUND）。
    await configStore.init();
    return new SyncService({
      db: options?.db ?? getDeepaaDatabase(resolveDeepaaDataDir()),
      configStore,
      developmentCredentialsPath: options?.developmentCredentialsPath,
      consoleCredentialsPath: options?.consoleCredentialsPath,
      // 生产默认启用套餐月费自动回填：按官方目录档位表匹配套餐同步返回的档位名。
      loadPlanCatalog: async () => (await loadProviderCatalog(resolveDeepaaDataDir())).catalog,
    });
  })();
  return syncServicePromise;
}

/** 测试用：重置单例并返回新建服务。 */
export function resetSyncServiceForTests(): void {
  syncServicePromise = undefined;
}
