import type {DeepaaDatabase} from "@/lib/db/sqlite-driver";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import type {
  ProcessExchangeInput,
  ProcessExchangeResult,
  ResolvedAgentPath,
  ScopeType,
} from "../db/models";
import {
  agentTurnMetadata,
  buildAgentStep,
  isOpenTurnBoundaryRequestAction,
  requestActionForTurnBoundary,
  type AgentStep,
  type AgentTurn,
} from "../harness/agent";
import { fingerprintAgent } from "../harness/fingerprint";
import {
  diffContextSnapshots,
  type ObservedContextSnapshot,
  type RemoteStateReference,
  type StepDiff,
} from "../harness/context-snapshot";
import { projectParamDetails } from "../harness/param-details";
import {
  deriveHarnessLearningInsights,
  type HarnessLearningInsight,
} from "../harness/derived";
import { classifyProtocol } from "../harness/protocol";
import {
  normalizeExchange,
  stableHash,
  type NormalizedExchange,
  type NormalizedHarnessPayload,
} from "../harness/normalizer";
import { contextCompositionFor } from "../harness/context-composition";
import {
  compactHarnessPayload,
  COMPACT_HARNESS_PAYLOAD_KEY,
  maybeExpandHarnessPayload,
  normalizeStoredContextSnapshot,
} from "./harness-payload-compact";
import {
  buildHarnessSnapshotIdentity,
  borrowHarnessInventoryFromPeers,
  upsertHarnessSnapshotForStep,
} from "./harness-snapshot-store";
import {
  DERIVED_ARTIFACT_INLINE_MAX_BYTES,
  externalDerivedArtifactPlaceholder,
  extractFailoverFromArtifactJson,
  placeDerivedArtifact,
  resolveDerivedArtifactJson,
} from "./derived-artifact-store";
import {
  resolveParamsFingerprint,
  type ParamsFingerprint,
} from "../harness/params-fingerprint";
import type { Confidence, EvidencePointer, RawCapturedExchange, StreamConnectionStatus } from "../harness/types";
import {
  computeTokenCost,
  effectiveEntryAt,
  normalizePricingConfig,
  readEffectivePricingConfig,
  type PricingConfig,
  type PricingConfigV2,
  type TokenCost,
} from "../pricing";
import {computePlanCredit} from "../plan-credit";
import {planCalculatorBaseRates} from "../provider-catalog/channel-boundary";
import { readCredentialRateMultiplier } from "../development-launch/credential-metadata";
import {
  ensurePricingConfigRevision,
  loadPricingConfigAt,
} from "./pricing-revisions";
import {
  tokenUsageFromExchange,
  type TokenUsageSummary,
} from "../harness/stream-response";
import { applyAgentLocalIdentityOverride, resolveAgentPath } from "./thread-identity";
import {
  DSH_IDENTITY_DEFER_DELAY_MS,
  DSH_IDENTITY_PENDING_MAX_AGE_MS,
  DSH_SCAN_WAIT_DEFER_DELAY_MS,
  isAgentLocalIdentityAgent,
  lookupAgentLocalIdentityLink,
} from "../agent-local-source/identity-links";
import {shouldWaitForAgentScanConvergence} from "../agent-local-source/scan-readiness";
import { upsertAgentPath } from "./hierarchy-repository";
import {
  readTargetBillingMetadata,
  targetMetadataSignature,
  type TargetBillingMetadata,
} from "./target-metadata";
import type {BillingChannel} from "@/types";
import {PROVIDER_PRESETS, resolvePlanFeeCurrency} from "@/lib/provider-presets";
import {resolveFxRate} from "@/lib/pricing";
import {
  computePlanEstimateForLedger,
  loadPlanQuotaWindows,
  resolveMarketShareQuotaTotal,
  resolvePlanQuotaTotal,
  type PlanQuotaTotal,
} from "@/lib/db/plan-real-cost";

/** 套餐额度快照缓存 TTL：plan_quota_snapshots 为低频小表（同步任务分钟级更新）。 */
const PLAN_QUOTA_CACHE_TTL_MS = 60_000;
import {
  buildLedgerMetrics,
  type CostBasis,
  type ReasoningSemantics,
  type RequestKind,
} from "../analytics/ledger-metrics";
import {
  advanceSourceCursor,
  type SourceCursorAdvance,
} from "./raw-source-reader";
import {
  createExchangeProjector,
  type ExchangeProjection,
} from "./exchange-projector";
import {
  CONTENT_PREVIEW_MAX_BYTES,
  mergeContentPreviews,
} from "./content-preview";
import type {
  ExchangeContentFilterItem,
  ProjectionBodySide,
} from "./projection-types";
import {
  resolveRequestContextProjection,
  type CurrentRequestProjectionState,
  type RequestItemFreshness,
  type StoredRequestProjectionState,
} from "./request-context";
import {
  markDerivationJobSucceeded,
  type DerivationJobClaim,
} from "./job-repository";
import { assertWorkerLease } from "./worker-lease";

const DEFAULT_HYDRATE_MAX_BYTES = 8 * 1024 * 1024;
const CONTEXT_ARTIFACT_MAX_BYTES = 256 * 1024;
const LEARNING_ARTIFACT_MAX_BYTES = 128 * 1024;
const LEARNING_STEP_LIMIT = 500;
const LEARNING_TOOL_LIMIT = 2_000;
const CONTEXT_PROMPT_LIMIT = 64;
const CONTEXT_CONVERSATION_LIMIT = 256;
const CONTEXT_TOOL_SCHEMA_LIMIT = 128;
const CONTEXT_TOOL_EVENT_LIMIT = 256;
const CONTEXT_REASONING_LIMIT = 64;
const CONTEXT_REMOTE_STATE_LIMIT = 64;
const ARTIFACT_EVIDENCE_LIMIT = 32;
const DIFF_ITEM_LIMIT = 128;
/** 参数值级变化条目上限（与 param-details 的 MAX_CHANGES 对齐）。 */
const PARAM_DETAIL_LIMIT = 24;
/** 系统/开发者提示块预览上限（块级结构化预览，P2）。 */
const SYSTEM_PROMPT_PREVIEW_MAX_BYTES = 240;
const LEARNING_OBSERVATION_LIMIT = 64;
const ARTIFACT_ID_MAX_BYTES = 256;
const ARTIFACT_TEXT_MAX_BYTES = 512;
const ARTIFACT_PARAM_ITEM_LIMIT = 64;
const LEARNING_TOOL_NAME_MAX_BYTES = 128;
const LEARNING_TEMPLATE_MAX_BYTES = 4 * 1024;
// SQLite substr 按字符截断；按 UTF-8 最坏 4 bytes/字符计算整批返回上限。
const LEARNING_SQL_ID_MAX_CHARS = ARTIFACT_ID_MAX_BYTES;
const LEARNING_SQL_TIMESTAMP_MAX_CHARS = 64;
const LEARNING_SQL_LABEL_MAX_CHARS = 128;
const LEARNING_SQL_TOOL_NAME_MAX_CHARS = LEARNING_TOOL_NAME_MAX_BYTES;

type HydrateExchange = (
  dataDir: string,
  exchange: RawCapturedExchange,
  options: { maxBytes?: number },
) => Promise<RawCapturedExchange>;

export interface CreateExchangeProcessorOptions {
  db: DeepaaDatabase;
  dataDir: string;
  hydrateMaxBytes?: number;
  hydrateExchange?: HydrateExchange;
  pricingConfig?: PricingConfig;
  /** 派生物内联阈值覆盖：默认 16 KiB；测试可用极大值固定内联形态。 */
  artifactInlineMaxBytes?: number;
}

export interface ExchangeProcessor {
  refreshPricingConfig(): Promise<void>;
  processExchangeRecord(
    input: ProcessExchangeInput,
  ): Promise<ProcessExchangeResult>;
  processExchangeRecordAndAdvance(
    input: ProcessExchangeInput,
    commit: ProcessExchangeCommit,
  ): Promise<ProcessExchangeResult>;
  processDerivationJob(
    input: ProcessExchangeInput,
    claim: DerivationJobClaim,
  ): Promise<ProcessExchangeResult>;
}

/** Worker 唯一允许使用的固定提交描述，不接受任意事务回调。 */
export interface ProcessExchangeCommit {
  cursor: SourceCursorAdvance;
  leaseOwnerId: string;
}

interface OpenTurnRow {
  id: string;
  native_turn_id: string | null;
  segment_index: number;
  step_count: number;
}

interface PreparedExchange {
  hydrated: RawCapturedExchange;
  projection: ExchangeProjection;
  normalized: NormalizedExchange;
  path: ResolvedAgentPath;
  /** dsh 本地原生身份覆写后的原生 Turn 键（session:turn:N）；无标注时缺省。 */
  identityNativeTurnId?: string;
  /** dsh 原生 Step 键（session:step:N，来自身份标注或导入合成头）；无则缺省。 */
  identityNativeStepId?: string;
  /** dsh 网关行未命中身份标注（已按现状降级，需写诊断）。 */
  identityUnannotated?: boolean;
  model?: string;
  pricingConfig: PricingConfigV2;
  /** 本次请求实际计价使用的价格版本（来自 pricing_config_revisions）；无则 NULL。 */
  pricingRevisionId?: number;
  priceEffectiveAt?: string;
  catalogHash?: string;
  tokenUsage: TokenUsageSummary;
  /** 请求密钥对应的价格倍率，来自凭据元数据；无则按供应商级配置。 */
  credentialRateMultiplier?: number;
  /** 供应商计费通道（B 方案），随账本落库；无元数据时保持 undefined。 */
  billingChannel?: BillingChannel;
  /** 供应商族，随账本落库；无元数据时保持 undefined。 */
  vendorFamily?: string;
  /** 官方预设 ID：官方通道命中目录 promo 促销实扣价时使用。 */
  targetPresetId?: string;
  /** 预设级积分公式声明（2026-10-07）：`"none"` = 官方未公开逐请求积分公式（火山 Coding Plan），不落积分列。 */
  targetPlanCreditFormula?: "none";
  /** 计价币种（四层分离）；缺省 USD 记账。 */
  targetSettlementCurrency?: "CNY" | "USD";
  /** 计价数字→人民币折算系数（显式配置）；缺省按币种规则解析。 */
  targetSettlementFx?: number;
  /** 套餐月费（原币种数值）；套餐估算入账冻结用。 */
  targetPlanMonthlyFee?: number;
  /** 套餐档位 id（如 opencode-go 的 go/go-plus）；market_share 估算分母解析用。 */
  targetPlanTier?: string;
  /** 该目标的套餐周期额度（已按请求时汇率解析）；无快照时缺省。 */
  planQuotaTotal?: PlanQuotaTotal;
  /** 请求捕获时间，用于时段费率与套餐积分窗口匹配。 */
  capturedAt: string;
}

type PreparedExchangeRecord =
  | { kind: "duplicate"; exchangeId: string }
  | { kind: "unsupported"; exchangeId: string }
  | { kind: "identity_wait"; exchangeId: string; deferMs?: number }
  | { kind: "prepared"; exchangeId: string; value: PreparedExchange };

/** 按捕获时间解析出的价格配置及对应版本审计信息。 */
interface ResolvedPricingConfig {
  config: PricingConfigV2;
  pricingRevisionId?: number;
  priceEffectiveAt?: string;
  catalogHash?: string;
}

interface ArtifactCompleteness {
  complete: boolean;
  originalEstimatedBytes: number;
  candidateItemCount: number;
  processedItemCount: number;
  candidateTextBytes: number;
  processedTextBytes: number;
  /** true = 条目被条数上限真实丢弃（区别于字段级预览截断）。 */
  itemsDropped?: boolean;
}

interface StoredContextSnapshot {
  snapshot?: ObservedContextSnapshot;
  completeness: ArtifactCompleteness;
}

interface ProjectionTracker {
  candidateItemCount: number;
  processedItemCount: number;
  candidateTextBytes: number;
  processedTextBytes: number;
  limited: boolean;
  /** 条目被条数上限丢弃（真截断）；字段级预览截断只置 limited。 */
  itemsDropped: boolean;
  /** 参数指纹遍历被深度/容器上限截断（结构性受限）。 */
  paramsLimited: boolean;
}

interface ProjectedArtifact<T> {
  value: T;
  completeness: ArtifactCompleteness;
}

/**
 * 将异步 raw/blob 水合与同步 SQLite 事务分离，避免在同步事务中跨 await。
 */
export function createExchangeProcessor(
  options: CreateExchangeProcessorOptions,
): ExchangeProcessor {
  const hydrateMaxBytes = normalizeHydrateBudget(options.hydrateMaxBytes);
  const artifactInlineMaxBytes = options.artifactInlineMaxBytes ?? DERIVED_ARTIFACT_INLINE_MAX_BYTES;
  const projector = createExchangeProjector({
    dataDir: options.dataDir,
    hydrateMaxBytes,
    hydrateExchange: options.hydrateExchange,
  });
  let pricingConfigPromise: Promise<PricingConfigV2> | undefined;
  let pricingConfigSignature: string | undefined;
  let pricingRevisionInitialized = false;
  let pricingRefreshPromise: Promise<void> | undefined;
  let targetMetadataSnapshot: Map<string, TargetBillingMetadata> | undefined;
  let targetMetadataSignatureValue: string | undefined;
  let targetMetadataRefreshPromise: Promise<void> | undefined;
  /* 套餐额度原始窗口缓存：fx 无关，解析按请求时汇率在 prepareRecord 内完成。 */
  let planQuotaWindowsCache: {at: number; value: Map<string, Parameters<typeof resolvePlanQuotaTotal>[0]>} | undefined;
  const planQuotaWindows = (): Map<string, Parameters<typeof resolvePlanQuotaTotal>[0]> => {
    const now = Date.now();
    if (!planQuotaWindowsCache || now - planQuotaWindowsCache.at > PLAN_QUOTA_CACHE_TTL_MS) {
      planQuotaWindowsCache = {at: now, value: loadPlanQuotaWindows(options.db)};
    }
    return planQuotaWindowsCache.value;
  };
  const refreshTargetMetadata = (): Promise<void> => {
    if (targetMetadataRefreshPromise) return targetMetadataRefreshPromise;
    targetMetadataRefreshPromise = (async () => {
      const signature = await targetMetadataSignature(options.dataDir);
      if (!targetMetadataSnapshot || targetMetadataSignatureValue !== signature) {
        targetMetadataSignatureValue = signature;
        targetMetadataSnapshot = await readTargetBillingMetadata(options.dataDir);
      }
    })().finally(() => {
      targetMetadataRefreshPromise = undefined;
    });
    return targetMetadataRefreshPromise;
  };
  const targetMetadata = async (): Promise<Map<string, TargetBillingMetadata>> => {
    if (!targetMetadataSnapshot) await refreshTargetMetadata();
    return targetMetadataSnapshot!;
  };
  const refreshPricingConfig = (): Promise<void> => {
    if (pricingRefreshPromise) return pricingRefreshPromise;
    pricingRefreshPromise = (async () => {
      // 结算通道元数据（billingChannel/vendorFamily/settlementFx/planMonthlyFee）与
      // 价格配置同批刷新（2026-09-23 修复）：targetMetadata() 首次加载后永不重读，
      // 保存结算系数后 Worker 会一直按旧 fx 入账直到重启。签名（mtime+size）未变时
      // 只花一次 stat，不重读文件。
      await refreshTargetMetadata();
      if (options.pricingConfig) {
        pricingConfigSignature = "provided";
        pricingConfigPromise = Promise.resolve(normalizePricingConfig(options.pricingConfig));
        pricingRevisionInitialized = true;
        return;
      }
      const signature = await pricingFilesSignature(options.dataDir);
      if (!pricingConfigPromise || pricingConfigSignature !== signature || !pricingRevisionInitialized) {
        pricingConfigSignature = signature;
        const nextConfig = await readEffectivePricingConfig(options.dataDir);
        ensurePricingConfigRevision(options.db, nextConfig);
        pricingConfigPromise = Promise.resolve(nextConfig);
        pricingRevisionInitialized = true;
      }
    })().finally(() => {
      pricingRefreshPromise = undefined;
    });
    return pricingRefreshPromise;
  };
  const pricingConfig = async (capturedAt: string): Promise<ResolvedPricingConfig> => {
    if (!pricingConfigPromise) await refreshPricingConfig();
    const current = await pricingConfigPromise!;
    if (options.pricingConfig) return { config: current };
    const loaded = loadPricingConfigAt(options.db, capturedAt);
    if (loaded) {
      return {
        config: loaded.config,
        pricingRevisionId: loaded.revisionId,
        priceEffectiveAt: loaded.effectiveAt,
        catalogHash: loaded.catalogHash,
      };
    }
    return { config: current };
  };

  const prepareRecord = async (
    input: ProcessExchangeInput,
    verifiedFileSize?: number,
    projectionVersion?: number,
    allowIdentityWait = false,
  ): Promise<PreparedExchangeRecord> => {
    const exchangeId = assertProcessInput(
      options.db,
      input,
      verifiedFileSize,
    );

    // 重放必须零水合，最终事务仍会复核 source、租约和重复状态。
    if (hasRawExchange(options.db, exchangeId)) {
      return { kind: "duplicate", exchangeId };
    }
    if ((input.exchange as { schemaVersion?: unknown }).schemaVersion !== 2) {
      return { kind: "unsupported", exchangeId };
    }

    const projection = await projector.project(input.exchange, projectionVersion);
    const hydrated = projection.exchange;
    const normalized = normalizeExchange(hydrated);
    // dsh 双链路（2026-09-17）：经网关的 dsh 行 wire 上无会话身份，但其本地
    // session v3 的 responseId 与网关捕获响应的 providerItemId 完全一致——
    // 命中标注即用原生 session/turn/step 身份；未命中时按两种等待边界返回
    // identity_wait 哨兵（2026-09-22：worker 在调度层顺延重新领取，零错误码、
    // 零 attempt 消耗）——实时竞态看行龄（<90s 顺延 2s），重启追赶期看扫描
    // 可生产性（已启动未收敛顺延 5s）；两者都不满足才按现状诚实降级并写诊断。
    // 只有持久派生任务路径允许等待；内联处理路径（legacy 修复等）保持即时派生。
    let path = resolveAgentPath(hydrated);
    let identityNativeTurnId: string | undefined;
    let identityNativeStepId: string | undefined;
    let identityUnannotated = false;
    // 导入行同样受益：合成响应体的 id = 本地 responseId（assembleChatResponseRawBody），
    // 命中标注即获得原生 turn/step（与网关行同会话同 turn 折叠）。
    if (isAgentLocalIdentityAgent(path.agentName)) {
      // 官方直连导入行（origin=agent_local_import）身份由合成头自带（x-session-id/
      // x-dsh-turn-id，见适配器 buildSyntheticRequestHeaders），且其 responseId 属
      // 直连流量、永不进入链接表（链接表只记网关行 responseId）——跳过查找，避免
      // 必然 miss 被误标 dsh_identity_missing（2026-09-17 实测导入行全量误报）。
      const isImportRow = hydrated.routing.origin === "agent_local_import";
      const responseId = isImportRow ? undefined : responseIdFromBody(hydrated);
      const link = responseId
        ? lookupAgentLocalIdentityLink(options.db, "dsh", responseId)
        : undefined;
      if (link) {
        const applied = applyAgentLocalIdentityOverride(path, {
          externalSessionId: link.externalSessionId,
          ...(link.parentExternalSessionId ? {parentExternalSessionId: link.parentExternalSessionId} : {}),
          ...(link.rootExternalSessionId ? {rootExternalSessionId: link.rootExternalSessionId} : {}),
          ...(link.turnNumber !== undefined ? {turnNumber: link.turnNumber} : {}),
          ...(link.stepNumber !== undefined ? {stepNumber: link.stepNumber} : {}),
        });
        path = applied.path;
        identityNativeTurnId = applied.nativeTurnId;
        identityNativeStepId = applied.nativeStepId;
      } else if (!isImportRow) {
        const completedMs = Date.parse(hydrated.completedAt || hydrated.capturedAt);
        const ageMs = Number.isFinite(completedMs) ? Date.now() - completedMs : Number.POSITIVE_INFINITY;
        if (allowIdentityWait && ageMs >= 0) {
          if (ageMs < DSH_IDENTITY_PENDING_MAX_AGE_MS) {
            // 实时竞态：等 2s 扫描节拍落标注。
            return { kind: "identity_wait", exchangeId, deferMs: DSH_IDENTITY_DEFER_DELAY_MS };
          }
          // 扫描就绪门控（2026-09-22）：重启追赶期的旧行——行龄不再代表「链接不会
          // 来」，改按可生产性等待（扫描已启动未收敛未熔断，见 scan-readiness.ts）。
          if (shouldWaitForAgentScanConvergence(path.agentName).waitable) {
            return { kind: "identity_wait", exchangeId, deferMs: DSH_SCAN_WAIT_DEFER_DELAY_MS };
          }
        }
        identityUnannotated = true;
      }
      // 导入行的原生 Step 键由合成头 x-dsh-step-id 携带（session:step:N）。
      identityNativeStepId = identityNativeStepId
        ?? (typeof hydrated.request.headers["x-dsh-step-id"] === "string"
          ? hydrated.request.headers["x-dsh-step-id"]
          : undefined);
    }
    const targetMeta = (await targetMetadata()).get(path.targetId);
    const resolvedPricing = await pricingConfig(hydrated.capturedAt);
    return {
      kind: "prepared",
      exchangeId,
      value: {
        hydrated,
        projection,
        normalized,
        path,
        ...(identityNativeTurnId ? {identityNativeTurnId} : {}),
        ...(identityNativeStepId ? {identityNativeStepId} : {}),
        ...(identityUnannotated ? {identityUnannotated} : {}),
        model: normalized.request.model ?? normalized.response.model,
        pricingConfig: resolvedPricing.config,
        pricingRevisionId: resolvedPricing.pricingRevisionId,
        priceEffectiveAt: resolvedPricing.priceEffectiveAt,
        catalogHash: resolvedPricing.catalogHash,
        tokenUsage: tokenUsageFromExchange(hydrated),
        credentialRateMultiplier: await readCredentialRateMultiplier(
          join(options.dataDir, "config", "development-credentials.json"),
          hydrated.routing?.clientCredentialId,
          options.db,
        ),
        billingChannel: targetMeta?.billingChannel,
        vendorFamily: targetMeta?.vendorFamily,
        targetPresetId: targetMeta?.presetId,
        targetPlanCreditFormula: targetMeta?.planCreditFormula,
        targetSettlementCurrency: targetMeta?.settlementCurrency,
        targetSettlementFx: targetMeta?.settlementFx,
        targetPlanMonthlyFee: targetMeta?.planMonthlyFee,
        targetPlanTier: targetMeta?.planTier,
        planQuotaTotal: resolvePlanQuotaTotal(
          planQuotaWindows().get(path.targetId),
          resolveFxRate(resolvedPricing.config.fx, "USD", "CNY"),
        ),
        capturedAt: hydrated.capturedAt,
      },
    };
  };

  const commitRecord = (
    input: ProcessExchangeInput,
    prepared: PreparedExchangeRecord,
    commit?: ProcessExchangeCommit,
    jobClaim?: DerivationJobClaim,
  ): ProcessExchangeResult => runTransaction(options.db, () => {
    assertSourceMatches(options.db, input, commit?.cursor.nextFileSize);
    if (commit) {
      assertProcessCommit(input, commit);
      assertWorkerLease(options.db, commit.leaseOwnerId);
    }
    if (jobClaim) assertDerivationJobInput(input, jobClaim);

    let result: ProcessExchangeResult;
    if (hasRawExchange(options.db, prepared.exchangeId)) {
      result = { exchangeId: prepared.exchangeId, duplicate: true };
    } else if (prepared.kind === "duplicate") {
      throw new Error(
        `Exchange ${prepared.exchangeId} 在重复检查期间被删除。`,
      );
    } else if (prepared.kind === "unsupported") {
      writeUnsupportedSchemaDiagnostic(options.db, input, prepared.exchangeId);
      result = { exchangeId: prepared.exchangeId, duplicate: false };
    } else if (prepared.kind === "identity_wait") {
      // 身份等待哨兵不得进入提交路径：processDerivationJob 必须先行短路交由
      // worker 顺延；内联路径（allowIdentityWait=false）不应产出该哨兵。
      throw new Error(
        `Exchange ${prepared.exchangeId} 的身份等待哨兵非法进入提交路径。`,
      );
    } else {
      result = writePreparedExchange(
        options.db,
        options.dataDir,
        artifactInlineMaxBytes,
        input,
        prepared.value,
      );
      augmentProjectionCompleteness(options.db, input, prepared.value);
      writeExchangeProjection(options.db, input, prepared.value, result);
    }

    if (commit) {
      advanceSourceCursor(options.db, commit.cursor);
      incrementDataVersion(options.db);
    }
    if (jobClaim) {
      if (prepared.kind !== "prepared") {
        throw new Error("持久派生任务缺少可提交的投影结果。");
      }
      markDerivationJobSucceeded(options.db, jobClaim, {
        completeness: prepared.value.projection.completeness,
        limitedDimensions: prepared.value.projection.limitedDimensions,
        requestVerification: prepared.value.projection.requestVerification,
        responseVerification: prepared.value.projection.responseVerification,
        onCommit: () => incrementDataVersion(options.db),
      });
      // 仅在持久化任务成功提交的同一事务中移除 Registrar 的待派生标记；
      // retry/permanent_error 均保留，小时对账不能误认本地账本已齐。
      options.db.prepare(
        "DELETE FROM relay_pending_ingestions WHERE exchange_id=?",
      ).run(prepared.exchangeId);
    }
    return result;
  });

  return {
    refreshPricingConfig,
    async processExchangeRecord(
      input: ProcessExchangeInput,
    ): Promise<ProcessExchangeResult> {
      return commitRecord(input, await prepareRecord(input));
    },
    async processExchangeRecordAndAdvance(
      input: ProcessExchangeInput,
      commit: ProcessExchangeCommit,
    ): Promise<ProcessExchangeResult> {
      assertProcessCommit(input, commit);
      return commitRecord(
        input,
        await prepareRecord(input, commit.cursor.nextFileSize),
        commit,
      );
    },
    async processDerivationJob(
      input: ProcessExchangeInput,
      claim: DerivationJobClaim,
    ): Promise<ProcessExchangeResult> {
      assertDerivationJobInput(input, claim);
      const prepared = await prepareRecord(
        input,
        undefined,
        claim.projectionVersion,
        true,
      );
      if (prepared.kind === "identity_wait") {
        // 交还 worker 顺延：不提交、不写成功终态、不进入错误管道。
        return {
          exchangeId: prepared.exchangeId,
          duplicate: false,
          identityWait: true,
          identityWaitDeferMs: prepared.deferMs,
        };
      }
      return commitRecord(input, prepared, undefined, claim);
    },
  };
}

function augmentProjectionCompleteness(
  db: DeepaaDatabase,
  input: ProcessExchangeInput,
  prepared: PreparedExchange,
): void {
  const projection = prepared.projection;
  const dimensions = new Set(projection.limitedDimensions);
  const diagnostics = new Set(projection.diagnosticCodes);
  const artifactRows = db.prepare(
    `SELECT code FROM derivation_diagnostics
     WHERE exchange_id = ? AND code IN(
       'context_snapshot_limited', 'step_diff_limited',
       'learning_insight_limited', 'prior_projection_gap',
       'dsh_turn_unconfirmed', 'dsh_identity_missing'
     )
     ORDER BY id DESC LIMIT 16`,
  ).pluck().all(prepared.hydrated.exchangeId) as string[];
  for (const code of artifactRows) {
    diagnostics.add(code);
    if (code === "context_snapshot_limited") dimensions.add("context_snapshot");
    if (code === "step_diff_limited") dimensions.add("step_diff");
    if (code === "learning_insight_limited") dimensions.add("learning_insight");
    if (code === "prior_projection_gap") dimensions.add("dependency_gap");
    if (code === "dsh_turn_unconfirmed") dimensions.add("dependency_gap");
  }
  if (input.ingestionRecordId && hasPriorProjectionGap(db, input.ingestionRecordId)) {
    dimensions.add("dependency_gap");
    diagnostics.add("prior_projection_gap");
  }
  if (dimensions.size === 0) return;
  projection.completeness = "limited";
  projection.limitedDimensions = [...dimensions];
  projection.diagnosticCodes = [...diagnostics];
  projection.preview = mergeContentPreviews({
    exchangeId: projection.preview.exchangeId,
    projectionVersion: projection.preview.projectionVersion,
    protocol: projection.preview.protocol,
    agentKind: projection.preview.agentKind,
    endpointKind: projection.preview.endpointKind,
    streamLifecycle: projection.preview.streamLifecycle,
    drafts: [{
      ...projection.preview,
      limited: true,
      truncated: true,
      limitedDimensions: [...dimensions],
      diagnosticCodes: [...diagnostics],
    }],
  });
}

function hasPriorProjectionGap(
  db: DeepaaDatabase,
  ingestionRecordId: number,
): boolean {
  return !!db.prepare(
    `SELECT 1
     FROM ingestion_records current
     JOIN ingestion_records earlier
       ON earlier.source_id = current.source_id
      AND earlier.source_generation = current.source_generation
      AND earlier.byte_offset < current.byte_offset
     JOIN derivation_jobs job ON job.ingestion_record_id = earlier.id
     WHERE current.id = ? AND job.job_status = 'permanent_error'
     LIMIT 1`,
  ).get(ingestionRecordId);
}

function assertDerivationJobInput(
  input: ProcessExchangeInput,
  claim: DerivationJobClaim,
): void {
  if (
    input.ingestionRecordId !== claim.ingestionRecordId
    || input.sourceId !== claim.sourceId
    || input.sourceRelativePath !== claim.sourceRelativePath
    || input.byteOffset !== claim.byteOffset
    || input.lineLengthBytes !== claim.lineLengthBytes
    || input.exchange.exchangeId !== claim.exchangeId
  ) {
    throw new Error("派生任务 claim 与 Raw 输入位置不一致。");
  }
}

async function pricingFilesSignature(dataDir: string): Promise<string> {
  const stats = await Promise.all([
    stat(
      /* turbopackIgnore: true */ join(
        /* turbopackIgnore: true */ dataDir,
        "config",
        "model-pricing.json",
      ),
    ).catch(() => undefined),
    stat(
      /* turbopackIgnore: true */ join(
        /* turbopackIgnore: true */ dataDir,
        "proxy-config.json",
      ),
    ).catch(() => undefined),
  ]);
  return stats.map(value => `${value?.mtimeMs ?? 0}:${value?.size ?? 0}`).join("|");
}

function writePreparedExchange(
  db: DeepaaDatabase,
  dataDir: string,
  artifactInlineMaxBytes: number,
  input: ProcessExchangeInput,
  prepared: PreparedExchange,
): ProcessExchangeResult {
  const { hydrated, normalized, model } = prepared;
  const classification = classifyProtocol(hydrated);
  const currentRequestItems = prepared.projection.preview.filterItems
    .filter(item => item.side === "request");
  // dsh 没有任何会话身份头，capture-session 回退身份只反映代理捕获批次（代理一重启
  // 就换新批次），不代表真实会话边界。当本请求可证明是上一捕获批次同会话的续接时，
  // 并入既有 Session/Thread，Turn 归属交给既有边界差分逻辑。
  // 命中本地原生身份标注（identityNativeTurnId）时跳过捕获批次缝合：原生身份
  // 是 exact，捕获批次拼接只是 capture-session 回退下的尽力推断。
  const stitchedPath = classification.isModelCall && !prepared.identityNativeTurnId
    ? stitchDshContinuationPath(db, prepared.path, currentRequestItems, hydrated.capturedAt)
    : undefined;
  const targetLevelAuxiliary = classification.isAuxiliary
    && !stitchedPath
    && prepared.path.sessionSource === "capture-session";
  const path = stitchedPath
    ?? (classification.isAuxiliary && !targetLevelAuxiliary
      ? reconcileAuxiliaryPath(db, prepared.path)
      : prepared.path);
  insertRawExchangeRef(db, input, { ...prepared, path });

  if (targetLevelAuxiliary) {
    return writeTargetLevelAuxiliaryRequest(db, {
      hydrated,
      normalized,
      pricingConfig: prepared.pricingConfig,
      tokenUsage: prepared.tokenUsage,
      credentialRateMultiplier: prepared.credentialRateMultiplier,
      path,
      model,
      endpointKind: classification.endpointKind,
      billingChannel: prepared.billingChannel,
      vendorFamily: prepared.vendorFamily,
      targetPresetId: prepared.targetPresetId,
      targetSettlementCurrency: prepared.targetSettlementCurrency,
      targetSettlementFx: prepared.targetSettlementFx,
      targetPlanMonthlyFee: prepared.targetPlanMonthlyFee,
      targetPlanTier: prepared.targetPlanTier,
      planQuotaTotal: prepared.planQuotaTotal,
      pricingRevisionId: prepared.pricingRevisionId,
      priceEffectiveAt: prepared.priceEffectiveAt,
      catalogHash: prepared.catalogHash,
    });
  }

  const priorThread = db.prepare(
    "SELECT is_placeholder FROM agent_threads WHERE id = ?",
  ).get(path.agentThreadId) as { is_placeholder: number } | undefined;
  const writtenPath = upsertAgentPath(db, path, hydrated.capturedAt, {
    model,
    exchangeId: hydrated.exchangeId,
    sourceId: input.sourceId,
  });
  const currentThread = db.prepare(
    "SELECT is_placeholder FROM agent_threads WHERE id = ?",
  ).get(writtenPath.threadId) as { is_placeholder: number } | undefined;
  const becameActualThread = currentThread?.is_placeholder === 0
    && (!priorThread || priorThread.is_placeholder === 1);

  if (classification.isAuxiliary) {
    return writeAuxiliaryRequest(db, {
      input,
      hydrated,
      normalized,
      pricingConfig: prepared.pricingConfig,
      tokenUsage: prepared.tokenUsage,
      credentialRateMultiplier: prepared.credentialRateMultiplier,
      path,
      sessionId: writtenPath.sessionId,
      threadId: writtenPath.threadId,
      model,
      becameActualThread,
      endpointKind: classification.endpointKind,
      billingChannel: prepared.billingChannel,
      vendorFamily: prepared.vendorFamily,
      targetPresetId: prepared.targetPresetId,
      targetSettlementCurrency: prepared.targetSettlementCurrency,
      targetSettlementFx: prepared.targetSettlementFx,
      targetPlanMonthlyFee: prepared.targetPlanMonthlyFee,
      targetPlanTier: prepared.targetPlanTier,
      planQuotaTotal: prepared.planQuotaTotal,
      pricingRevisionId: prepared.pricingRevisionId,
      priceEffectiveAt: prepared.priceEffectiveAt,
      catalogHash: prepared.catalogHash,
    });
  }

  const openTurn = findOpenTurn(db, writtenPath.threadId);
  const metadata = prepared.identityNativeTurnId
    ? {...agentTurnMetadata(hydrated), turnId: prepared.identityNativeTurnId}
    : agentTurnMetadata(hydrated);
  const agentName = fingerprintAgent(hydrated).agentName;
  let boundaryAction: AgentStep["requestAction"];
  let boundaryConfidence: Confidence;
  if (agentName === "dsh" || agentName === "zcode") {
    // 分支内收窄：isDsh=false 即 zcode，避免新增 agent 名字面量分派（扩展面守卫）。
    const isDsh = agentName === "dsh";
    const decision = projectionTurnBoundary(
      db,
      writtenPath.threadId,
      prepared.projection.preview.filterItems.filter(item => item.side === "request"),
      {currentRequestSha: hydrated.request.bodySha256},
    );
    boundaryAction = decision.action;
    boundaryConfidence = decision.confidence;
    // zcode 官方直连本地导入（双链路观测）：rollout 请求体不保留消息历史，内容推断
    // 不可用；原生 turn 头（x-zcode-turn-id，来自 model_usage.turn_id）变更即新用户
    // 输入，动作标签覆盖为 user_prompt（网关行无此头，行为不变）。
    const nativeTurnId = metadata.turnId;
    if (!isDsh && nativeTurnId
      && (!openTurn || nativeTurnId !== openTurn.native_turn_id)
      && boundaryAction !== "user_prompt") {
      boundaryAction = "user_prompt";
      boundaryConfidence = "exact";
    }
    if (decision.unconfirmed) {
      writeDshTurnUnconfirmedDiagnostic(
        db,
        input,
        hydrated,
        prepared.projection.preview.projectionVersion,
      );
    }
    if (prepared.identityUnannotated) {
      // 本地原生身份标注未命中（文件已清理/停机超窗/重试耗尽）：按 capture-session
      // 回退身份诚实降级，可观测、不冒充 exact。
      writeDshIdentityMissingDiagnostic(
        db,
        input,
        hydrated,
        prepared.projection.preview.projectionVersion,
      );
    }
  } else {
    // 重试折叠前置检查（2026-09-18，全 Agent 通用）：请求体 SHA 与同 Thread 上一
    // 请求完全一致的字面重发标记 retry_like 并沿用当前 Turn——claude-code 的
    // 502 重试链、opencode 的对冲重发此前被逐请求切成新 Turn。原生 Turn 头
    // 变化（nativeTurnChanged）仍按权威信号开新轮，不受此分支影响。
    const retryCheck = projectionTurnBoundary(
      db,
      writtenPath.threadId,
      prepared.projection.preview.filterItems.filter(item => item.side === "request"),
      {currentRequestSha: hydrated.request.bodySha256},
    );
    if (retryCheck.action === "retry_like") {
      boundaryAction = retryCheck.action;
      boundaryConfidence = retryCheck.confidence;
    } else {
      boundaryAction = requestActionForTurnBoundary(
        normalized,
        hydrated,
        openTurn?.native_turn_id ?? undefined,
      );
      boundaryConfidence = metadata.turnId ? "exact" : "medium";
    }
  }
  const nativeTurnChanged = !!openTurn
    && !!metadata.turnId
    && metadata.turnId !== openTurn.native_turn_id;
  // 失败尝试不换轮（2026-09-18）：响应 ≥400 的请求在已有 open Turn 时是同一逻辑
  // 请求的重发/对冲尝试（claude-code 主备模型对冲实测 21 次 502 各开一轮），折叠
  // 进当前轮并标 retry_like。无 open Turn 或原生 Turn 真实变化时保持原语义。
  const responseFailed = hydrated.response.status >= 400;
  if (responseFailed && openTurn && !nativeTurnChanged
    && isOpenTurnBoundaryRequestAction(boundaryAction)) {
    boundaryAction = "retry_like";
    boundaryConfidence = "high";
  }
  // 原生 Turn 身份优先（2026-09-18）：有可靠原生 turn id 且未变化时，内容边界
  // （user_prompt，含 dsh 注入的权限/计划等 user-role 项）不得开新轮——本地实测
  // 同一 native id 被切成 7 轮。zcode/codex 的真实换轮都来自原生 id 变化，不受影响。
  const opensNewTurn = !openTurn
    || nativeTurnChanged
    || (!metadata.turnId && isOpenTurnBoundaryRequestAction(boundaryAction));
  const turn = opensNewTurn
    ? openTurnForExchange(db, {
      path,
      threadId: writtenPath.threadId,
      model,
      hydrated,
      nativeTurnId: metadata.turnId,
      priorOpenTurn: openTurn,
      sourceId: input.sourceId,
    })
    : openTurn;
  if (!turn) {
    throw new Error(`无法为 Exchange ${hydrated.exchangeId} 建立 Turn。`);
  }

  const stepIndex = turn.step_count + 1;
  const identityEvidence = stepIdentityEvidence(
    agentName,
    metadata,
    boundaryConfidence,
  );
  const stepShape = buildAgentStep(
    agentTurnShape(turn, path, writtenPath.threadId, hydrated),
    hydrated,
    normalized,
    stepIndex,
    boundaryAction,
  );
  const ledger = buildUsageLedgerMetrics(prepared, path, {
    ...prepared,
    requestKind: "model",
    responseStatus: hydrated.response.status,
    isStreaming: hydrated.response.isStreaming,
    connectionStatus: connectionStatusFromDiagnostics(hydrated),
  });
  db.prepare(
    `INSERT INTO agent_steps(
      id, exchange_id, agent_session_id, agent_thread_id, agent_turn_id,
      step_index, native_step_id, identity_source, identity_confidence,
      timestamp, phase, request_action, response_action,
      request_intent_label, response_status_label, tool_schema_count,
      context_compressed, input_tokens, cache_read_tokens,
      cache_write_tokens, output_tokens, vendor_cost, actual_cost, duration_ms,
      stop_reason
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    stepShape.id,
    hydrated.exchangeId,
    writtenPath.sessionId,
    writtenPath.threadId,
    turn.id,
    stepIndex,
    prepared.identityNativeStepId ?? null,
    identityEvidence.identitySource,
    identityEvidence.identityConfidence,
    hydrated.capturedAt,
    stepShape.phase,
    stepShape.requestAction,
    stepShape.responseAction,
    stepShape.requestIntentLabel ?? null,
    stepShape.responseStatusLabel ?? null,
    stepShape.toolSchemaCount,
    ledger.inputTokens,
    ledger.cacheReadTokens,
    ledger.cacheWriteTokens,
    ledger.outputTokens,
    ledger.vendorCost,
    ledger.actualCost,
    safeDuration(hydrated.durationMs),
    normalized.response.stopReason ?? null,
  );

  const toolCallCount = writeToolCalls(
    db,
    writtenPath,
    turn.id,
    stepShape.id,
    hydrated,
    normalized,
  );
  writeUsageLedger(db, {
    exchange: hydrated,
    path,
    sessionId: writtenPath.sessionId,
    threadId: writtenPath.threadId,
    turnId: turn.id,
    stepId: stepShape.id,
    model,
    ledger,
    pricingRevisionId: prepared.pricingRevisionId,
    priceEffectiveAt: prepared.priceEffectiveAt,
    catalogHash: prepared.catalogHash,
  });
  const contextCompressed = writeContextArtifacts(db, {
    sourceId: input.sourceId,
    path,
    turnId: turn.id,
    stepId: stepShape.id,
    stepIndex,
    normalized,
    exchange: hydrated,
    dataDir,
    artifactInlineMaxBytes,
  });
  if (contextCompressed) {
    db.prepare(
      `UPDATE agent_steps SET context_compressed = 1 WHERE id = ?`,
    ).run(stepShape.id);
  }
  // Harness 证据层（v27）：内容寻址快照 upsert + step 引用列回写，同一事务内。
  // 导入行缺组件（tools/skills/rules）时从同 Agent 最近富快照借补（2026-09-18）：
  // 官方直连本地日志不落工具定义，借补等价清单并收敛到同一快照哈希；来源用
  // derivation diagnostic 可观测。
  const harnessIdentity = buildHarnessSnapshotIdentity(agentName, normalized);
  let finalHarnessIdentity = harnessIdentity;
  if (hydrated.routing.origin === "agent_local_import") {
    const borrowed = borrowHarnessInventoryFromPeers(db, harnessIdentity);
    finalHarnessIdentity = borrowed.identity;
    if (borrowed.borrowed.length > 0) {
      writeHarnessInventoryBorrowedDiagnostic(
        db,
        input,
        hydrated,
        prepared.projection.preview.projectionVersion,
        borrowed.borrowed,
      );
    }
  }
  upsertHarnessSnapshotForStep(
    db,
    finalHarnessIdentity,
    { stepId: stepShape.id, timestamp: hydrated.capturedAt },
  );
  updateDirectCounters(db, {
    sessionId: writtenPath.sessionId,
    threadId: writtenPath.threadId,
    turnId: turn.id,
    model,
    timestamp: hydrated.capturedAt,
    becameActualThread,
    openedTurn: opensNewTurn,
  });
  updateScopeAggregates(db, {
    sessionId: writtenPath.sessionId,
    threadId: writtenPath.threadId,
    turnId: turn.id,
    timestamp: hydrated.capturedAt,
    inputTokens: ledger.inputTokens,
    cacheReadTokens: ledger.cacheReadTokens,
    cacheWriteTokens: ledger.cacheWriteTokens,
    outputTokens: ledger.outputTokens,
    vendorCost: ledger.vendorCostCny ?? ledger.vendorCost,
    actualCost: ledger.actualCostCny ?? ledger.actualCost,
    durationMs: safeDuration(hydrated.durationMs),
    toolCallCount,
  });

  return {
    exchangeId: hydrated.exchangeId,
    duplicate: false,
    sessionId: writtenPath.sessionId,
    threadId: writtenPath.threadId,
    turnId: turn.id,
    stepId: stepShape.id,
  };
}

interface DshBoundaryDecision {
  action: AgentStep["requestAction"];
  confidence: Confidence;
  unconfirmed: boolean;
}

/**
 * dsh 续接拼接：无身份头的 dsh 请求按 capture-session 回退隔离时，新捕获批次
 * （代理重启、跨日分桶后）会被拆成独立 Session。当本请求完整包含最近一个同目标
 * 同 Agent dsh 捕获批次末次请求的全部去重指纹（set 包含）、历史足够丰富且时间
 * 相邻时，判定为同一会话续接，返回指向前一线程的路径；Turn 归属仍由既有边界
 * 差分决定。只读取 agent_sessions/agent_threads 有界候选（LIMIT 4）、agent_steps
 * 线程索引（LIMIT 1）与 exchange_request_fingerprints（单 Exchange 有界投影），
 * 禁止读取 raw 历史；上一请求投影受限或自身线程已有 Step 时不拼接，保持既有
 * 隔离行为。全新会话缺少前一会话的 tool_result/用户消息指纹，set 包含必然失败，
 * 不会误拼接。
 */
function stitchDshContinuationPath(
  db: DeepaaDatabase,
  path: ResolvedAgentPath,
  currentRequestItems: readonly ExchangeContentFilterItem[],
  currentCapturedAt: string,
): ResolvedAgentPath | undefined {
  if (path.agentName !== "dsh" || path.sessionSource !== "capture-session") return undefined;
  if (currentRequestItems.length === 0) return undefined;
  const ownThreadHasSteps = db.prepare(
    "SELECT 1 FROM agent_steps WHERE agent_thread_id = ? LIMIT 1",
  ).get(path.agentThreadId);
  if (ownThreadHasSteps) return undefined;
  const candidates = db.prepare(
    `SELECT t.id AS thread_id, t.agent_session_id AS session_id, t.is_root AS is_root,
            t.parent_agent_thread_id AS parent_thread_id
     FROM agent_threads t
     JOIN agent_sessions se ON se.id = t.agent_session_id
     WHERE se.target_id = ? AND se.agent_fingerprint_id = ?
       AND se.source = 'capture-session' AND t.id != ?
     ORDER BY se.end_time DESC, t.end_time DESC, t.id ASC
     LIMIT 4`,
  ).all(
    path.targetId,
    path.agentFingerprintId,
    path.agentThreadId,
  ) as Array<{
    thread_id: string;
    session_id: string;
    is_root: number;
    parent_thread_id: string | null;
  }>;
  for (const candidate of candidates) {
    const previousStep = db.prepare(
      `SELECT exchange_id, timestamp FROM agent_steps
       WHERE agent_thread_id = ?
       ORDER BY timestamp DESC, exchange_id DESC
       LIMIT 1`,
    ).get(candidate.thread_id) as { exchange_id: string; timestamp: string } | undefined;
    if (!previousStep) continue;
    if (!dshRequestsShareConversation(db, previousStep, currentRequestItems, currentCapturedAt)) continue;
    const rootThreadId = candidate.is_root === 1
      ? candidate.thread_id
      : (db.prepare(
        "SELECT id FROM agent_threads WHERE agent_session_id = ? AND is_root = 1 ORDER BY id ASC LIMIT 1",
      ).pluck().get(candidate.session_id) as string | undefined) ?? candidate.thread_id;
    return {
      ...path,
      agentSessionId: candidate.session_id,
      agentThreadId: candidate.thread_id,
      rootAgentThreadId: rootThreadId,
      parentAgentThreadId: candidate.is_root === 1
        ? undefined
        : candidate.parent_thread_id ?? rootThreadId,
      isRootThread: candidate.is_root === 1,
      diagnostics: [
        ...(path.diagnostics ?? []),
        {
          code: "dsh-session-stitched",
          message: "dsh 请求未携带会话身份，且本请求包含上一捕获批次同会话的全部历史指纹，已并入该 Session/Thread 续接。",
        },
      ],
    };
  }
  return undefined;
}

/** 续接拼接的相邻判定窗口：代理重启/跨日分桶后同会话续接通常在分钟级内到达。 */
const DSH_STITCH_MAX_GAP_MS = 30 * 60 * 1000;

/**
 * set 包含判定（与 projectionTurnBoundary 同源同界，但按去重指纹比较）：
 * 上一请求的全部去重指纹都出现在当前请求中（真实续接只会新增条目，偶发丢失的
 * 只是重复出现的相同指纹，去重后不受影响），且上一请求至少有 3 个指纹
 * （system + user 之外还有会话专属的 tool_result/后续用户消息，排除"新会话逐字
 * 重打同一句话"的误拼接），且两请求时间差在窗口内（压缩/重排导致大量指纹缺失
 * 时不拼接，保守回退隔离）。
 */
function dshRequestsShareConversation(
  db: DeepaaDatabase,
  previousStep: { exchange_id: string; timestamp: string },
  currentRequestItems: readonly ExchangeContentFilterItem[],
  currentCapturedAt: string,
): boolean {
  const filterState = db.prepare(
    "SELECT request_filter_state FROM exchange_content_filter_status WHERE exchange_id = ?",
  ).pluck().get(previousStep.exchange_id) as string | undefined;
  if (filterState !== "complete") return false;
  const gapMs = Date.parse(currentCapturedAt) - Date.parse(previousStep.timestamp);
  if (!(gapMs >= 0) || gapMs > DSH_STITCH_MAX_GAP_MS) return false;
  const rows = db.prepare(
    `SELECT DISTINCT fingerprint FROM exchange_request_fingerprints
     WHERE exchange_id = ? AND body_side = 'request'`,
  ).all(previousStep.exchange_id) as Array<{ fingerprint: Buffer }>;
  if (rows.length < 3) return false;
  const currentFingerprints = new Set(currentRequestItems.map(item => item.fingerprint));
  for (const row of rows) {
    if (!currentFingerprints.has(row.fingerprint.toString("hex"))) return false;
  }
  return true;
}

/**
 * dsh/zcode 等没有可靠 HTTP turn/step 头的 Agent：从 SQLite 有界 Request 指纹投影
 * 重建同 Thread 上一模型请求的 occurrence-aware 消息多重集，再与当前请求差分。
 * 只使用 agent_steps 的 thread 索引（LIMIT 1）与 exchange_request_fingerprints
 * （单 Exchange 上限 4096 行）；当前请求直接复用已构建的 preview.filterItems，
 * 与落库指纹同源，禁止为判 Turn 读取完整历史 raw。
 * 受管 provider 的 assistant/tool_result 历史属于 history_replay，不进入
 * filterItems，因此“无新增 user 消息”时只能声明 medium，不冒充 high/exact。
 * 上一请求指纹投影受限时无法可靠比较，沿用当前 Turn 并返回低置信度。
 * TurnSignal 与展示类别分离：Agent 注入信封、system/control 只产生 neutral，
 * 工具结果产生 continues_turn，只有真实用户输入的 opens_turn 才切换 Turn。
 */
function projectionTurnBoundary(
  db: DeepaaDatabase,
  threadId: string,
  currentRequestItems: readonly ExchangeContentFilterItem[],
  options: {currentRequestSha?: string},
): DshBoundaryDecision {
  const previousExchangeId = db.prepare(
    `SELECT exchange_id FROM agent_steps
     WHERE agent_thread_id = ?
     ORDER BY timestamp DESC, exchange_id DESC
     LIMIT 1`,
  ).pluck().get(threadId) as string | undefined;
  if (!previousExchangeId) {
    return { action: "user_prompt", confidence: "exact", unconfirmed: false };
  }
  const filterState = db.prepare(
    "SELECT request_filter_state FROM exchange_content_filter_status WHERE exchange_id = ?",
  ).pluck().get(previousExchangeId) as string | undefined;
  if (filterState !== "complete") {
    return {
      action: "conversation_continue",
      confidence: "low",
      unconfirmed: true,
    };
  }
  const rows = db.prepare(
    `SELECT fingerprint, SUM(occurrence_count) AS occurrence_count
     FROM exchange_request_fingerprints
     WHERE exchange_id = ? AND body_side = 'request' AND category != 'control'
     GROUP BY fingerprint`,
  ).all(previousExchangeId) as Array<{
    fingerprint: Buffer;
    occurrence_count: number;
  }>;
  const before = new Map<string, number>();
  for (const row of rows) {
    before.set(row.fingerprint.toString("hex"), row.occurrence_count);
  }
  const consumedFingerprints = new Set<string>();
  let newUserItems = 0;
  let newNonUserItems = 0;
  for (const item of currentRequestItems) {
    const count = before.get(item.fingerprint) ?? 0;
    if (count > 0) {
      if (count === 1) {
        before.delete(item.fingerprint);
      } else {
        before.set(item.fingerprint, count - 1);
      }
      consumedFingerprints.add(item.fingerprint);
      continue;
    }
    const turnSignal = item.turnSignal
      ?? (item.category === "user_real"
        ? "opens_turn"
        : item.category === "tool_result"
          ? "continues_turn"
          : "neutral");
    if (turnSignal === "opens_turn") {
      newUserItems += 1;
    } else {
      newNonUserItems += 1;
    }
  }
  if (newUserItems > 0) {
    return { action: "user_prompt", confidence: "high", unconfirmed: false };
  }
  if (newNonUserItems > 0) {
    // 新增项全部为工具结果时标记 tool_result（2026-09-17：zcode/dsh 的续接步骤
    // 此前恒标「远端状态续接」，工具回填语义在时间线与 phase 上全部丢失）。
    const newToolResultItems = currentRequestItems.filter(item =>
      item.category === "tool_result"
      && !consumedFingerprints.has(item.fingerprint));
    if (newToolResultItems.length > 0 && newToolResultItems.length === newNonUserItems) {
      return { action: "tool_result", confidence: "high", unconfirmed: false };
    }
    return {
      action: "conversation_continue",
      confidence: "high",
      unconfirmed: false,
    };
  }
  // 全消耗零新增有两种可能：字面重发（重试链），或仅推进了指纹域之外的历史
  // （如 assistant 消息不入指纹）。用「请求体 SHA 完全一致」作为重试的强证据，
  // 只有字节级同一请求才标 retry_like 并沿用当前 Turn（2026-09-18：claude-code
  // 11 次 502 曾被切成 11 个 Turn；dsh 429 链同理）。
  if (options.currentRequestSha) {
    const previousSha = db.prepare(
      `SELECT ir.request_body_sha256
       FROM ingestion_records ir
       WHERE ir.exchange_id = ?`,
    ).pluck().get(previousExchangeId) as string | undefined;
    if (previousSha && previousSha === options.currentRequestSha) {
      return { action: "retry_like", confidence: "high", unconfirmed: false };
    }
  }
  return {
    action: "conversation_continue",
    confidence: "medium",
    unconfirmed: false,
  };
}

/**
 * Step 身份证据：能读到原生 Turn/Step 头时标记 native-header/exact；
 * 否则只声明 structural，置信度按来源区分（dsh 用消息差分，其它 Agent 用
 * 保守的 medium，不伪造 exact）。
 */
function stepIdentityEvidence(
  agentName: string,
  metadata: ReturnType<typeof agentTurnMetadata>,
  structuralConfidence: Confidence,
): { identitySource: "native-header" | "structural"; identityConfidence: Confidence } {
  if (metadata.turnId) {
    return { identitySource: "native-header", identityConfidence: "exact" };
  }
  return {
    identitySource: "structural",
    identityConfidence: agentName === "dsh"
      ? structuralConfidence
      : "medium",
  };
}

/** dsh Turn 差分因上一请求指纹投影受限而不可用时，写可观测诊断而不是假装 exact。 */
function writeDshTurnUnconfirmedDiagnostic(
  db: DeepaaDatabase,
  input: ProcessExchangeInput,
  exchange: RawCapturedExchange,
  projectionVersion: number,
): void {
  db.prepare(
    `INSERT INTO derivation_diagnostics(
      exchange_id, source_id, ingestion_record_id, projection_version,
      code, severity, message, details_json, created_at
    ) SELECT ?, ?, ?, ?, 'dsh_turn_unconfirmed', 'warning', ?, '{}', ?
    WHERE NOT EXISTS(
      SELECT 1 FROM derivation_diagnostics
      WHERE exchange_id = ? AND code = 'dsh_turn_unconfirmed'
    )`,
  ).run(
    exchange.exchangeId,
    input.sourceId,
    input.ingestionRecordId ?? null,
    projectionVersion,
    "上一模型请求的指纹投影受限，无法可靠比较 dsh 消息差分，已沿用当前 Turn。",
    exchange.capturedAt,
    exchange.exchangeId,
  );
}

/** chat completions 响应体顶层的对象 id（dsh 本地 responseId 与此同值）。 */
function responseIdFromBody(exchange: RawCapturedExchange): string | undefined {
  const parsed = exchange.response.parsedBody;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const id = (parsed as Record<string, unknown>).id;
  return typeof id === "string" && id ? id : undefined;
}

/** 导入行 Harness 借补的可观测标注：缺哪些组件、从同 Agent 富快照补齐。 */
function writeHarnessInventoryBorrowedDiagnostic(
  db: DeepaaDatabase,
  input: ProcessExchangeInput,
  exchange: RawCapturedExchange,
  projectionVersion: number,
  borrowed: readonly string[],
): void {
  db.prepare(
    `INSERT INTO derivation_diagnostics(
      exchange_id, source_id, ingestion_record_id, projection_version,
      code, severity, message, details_json, created_at
    ) SELECT ?, ?, ?, ?, 'harness_inventory_borrowed', 'info', ?, ?, ?
    WHERE NOT EXISTS(
      SELECT 1 FROM derivation_diagnostics
      WHERE exchange_id = ? AND code = 'harness_inventory_borrowed'
        AND details_json = ?
    )`,
  ).run(
    exchange.exchangeId,
    input.sourceId,
    input.ingestionRecordId ?? null,
    projectionVersion,
    "官方直连本地日志不含 " + borrowed.join("/") + " 清单，已从同 Agent 最近快照借补（与网关 wire 侧同源）。",
    JSON.stringify({borrowed}),
    exchange.capturedAt,
    exchange.exchangeId,
    JSON.stringify({borrowed}),
  );
}

function writeDshIdentityMissingDiagnostic(  db: DeepaaDatabase,
  input: ProcessExchangeInput,
  exchange: RawCapturedExchange,
  projectionVersion: number,
): void {
  db.prepare(
    `INSERT INTO derivation_diagnostics(
      exchange_id, source_id, ingestion_record_id, projection_version,
      code, severity, message, details_json, created_at
    ) SELECT ?, ?, ?, ?, 'dsh_identity_missing', 'warning', ?, '{}', ?
    WHERE NOT EXISTS(
      SELECT 1 FROM derivation_diagnostics
      WHERE exchange_id = ? AND code = 'dsh_identity_missing'
    )`,
  ).run(
    exchange.exchangeId,
    input.sourceId,
    input.ingestionRecordId ?? null,
    projectionVersion,
    "dsh 本地原生身份标注未命中（本地会话文件不可得或标注未及时到达），已按捕获批次回退身份。",
    exchange.capturedAt,
    exchange.exchangeId,
  );
}

function writeAuxiliaryRequest(
  db: DeepaaDatabase,
  prepared: {
    input: ProcessExchangeInput;
    hydrated: RawCapturedExchange;
    normalized: NormalizedExchange;
    pricingConfig: PricingConfigV2;
    tokenUsage: TokenUsageSummary;
    credentialRateMultiplier?: number;
    path: ResolvedAgentPath;
    sessionId: string;
    threadId: string;
    model?: string;
    becameActualThread: boolean;
    endpointKind: string;
    billingChannel?: BillingChannel;
    vendorFamily?: string;
    targetPresetId?: string;
    targetSettlementCurrency?: "CNY" | "USD";
    targetSettlementFx?: number;
    targetPlanMonthlyFee?: number;
    targetPlanTier?: string;
    planQuotaTotal?: PlanQuotaTotal;
    pricingRevisionId?: number;
    priceEffectiveAt?: string;
    catalogHash?: string;
  },
): ProcessExchangeResult {
  const nativeTurnId = agentTurnMetadata(prepared.hydrated).turnId;
  const turnId = resolveAuxiliaryTurnId(
    db,
    prepared.threadId,
    nativeTurnId,
  );
  const auxiliaryId = `aux-${stableHash({
    exchangeId: prepared.hydrated.exchangeId,
    threadId: prepared.threadId,
  })}`;
  db.prepare(
    `INSERT INTO auxiliary_requests(
      id, exchange_id, agent_session_id, agent_thread_id, agent_turn_id,
      target_id, agent_fingerprint_id, agent_name, kind, timestamp, duration_ms
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    auxiliaryId,
    prepared.hydrated.exchangeId,
    prepared.sessionId,
    prepared.threadId,
    turnId ?? null,
    prepared.path.targetId,
    prepared.path.agentFingerprintId,
    prepared.path.agentName,
    auxiliaryKind(prepared.endpointKind, prepared.hydrated.response.status),
    prepared.hydrated.capturedAt,
    safeDuration(prepared.hydrated.durationMs),
  );
  const ledger = buildUsageLedgerMetrics({
    hydrated: prepared.hydrated,
    model: prepared.model,
    pricingConfig: prepared.pricingConfig,
    tokenUsage: prepared.tokenUsage,
    credentialRateMultiplier: prepared.credentialRateMultiplier,
    capturedAt: prepared.hydrated.capturedAt,
    // 辅助请求与主请求同一供应商通道：缺失会让套餐积分（AFP/积分）与参考价列保持 NULL。
    billingChannel: prepared.billingChannel,
    targetPresetId: prepared.targetPresetId,
    targetSettlementCurrency: prepared.targetSettlementCurrency,
    targetSettlementFx: prepared.targetSettlementFx,
    targetPlanMonthlyFee: prepared.targetPlanMonthlyFee,
    targetPlanTier: prepared.targetPlanTier,
    planQuotaTotal: prepared.planQuotaTotal,
  }, prepared.path, {
    ...prepared,
    requestKind: prepared.endpointKind === "token-count" ? "token_count"
      : prepared.endpointKind === "metadata" ? "metadata"
        : prepared.endpointKind === "health-check" ? "health_check" : "auxiliary",
    responseStatus: prepared.hydrated.response.status,
    isStreaming: prepared.hydrated.response.isStreaming,
    connectionStatus: connectionStatusFromDiagnostics(prepared.hydrated),
  });
  writeUsageLedger(db, {
    exchange: prepared.hydrated,
    path: prepared.path,
    sessionId: prepared.sessionId,
    threadId: prepared.threadId,
    turnId,
    model: prepared.model,
    ledger,
    pricingRevisionId: prepared.pricingRevisionId,
    priceEffectiveAt: prepared.priceEffectiveAt,
    catalogHash: prepared.catalogHash,
  });

  db.prepare(
    `UPDATE agent_sessions
     SET request_count = request_count + 1,
       thread_count = thread_count + ?,
       end_time = MAX(end_time, ?)
     WHERE id = ?`,
  ).run(
    prepared.becameActualThread ? 1 : 0,
    prepared.hydrated.capturedAt,
    prepared.sessionId,
  );
  db.prepare(
    `UPDATE agent_threads
     SET request_count = request_count + 1,
       end_time = MAX(end_time, ?)
     WHERE id = ?`,
  ).run(prepared.hydrated.capturedAt, prepared.threadId);
  if (turnId) {
    db.prepare(
      `UPDATE agent_turns
       SET auxiliary_request_count = auxiliary_request_count + 1,
         end_time = MAX(end_time, ?)
       WHERE id = ? AND agent_thread_id = ?`,
    ).run(prepared.hydrated.capturedAt, turnId, prepared.threadId);
  }

  const aggregateInput = {
    timestamp: prepared.hydrated.capturedAt,
    inputTokens: ledger.inputTokens,
    cacheReadTokens: ledger.cacheReadTokens,
    cacheWriteTokens: ledger.cacheWriteTokens,
    outputTokens: ledger.outputTokens,
    vendorCost: ledger.vendorCostCny ?? ledger.vendorCost,
    actualCost: ledger.actualCostCny ?? ledger.actualCost,
    durationMs: safeDuration(prepared.hydrated.durationMs),
  };
  addAuxiliaryScopeAggregate(db, "session", prepared.sessionId, aggregateInput);
  addAuxiliaryScopeAggregate(db, "thread", prepared.threadId, aggregateInput);
  if (turnId) {
    addAuxiliaryScopeAggregate(db, "turn", turnId, aggregateInput);
  }

  return {
    exchangeId: prepared.hydrated.exchangeId,
    duplicate: false,
    sessionId: prepared.sessionId,
    threadId: prepared.threadId,
    turnId,
  };
}

/** 无明确会话身份的供应商元数据请求只属于代理供应商，不能按时间猜测会话。 */
function writeTargetLevelAuxiliaryRequest(
  db: DeepaaDatabase,
  prepared: {
    hydrated: RawCapturedExchange;
    normalized: NormalizedExchange;
    pricingConfig: PricingConfigV2;
    tokenUsage: TokenUsageSummary;
    credentialRateMultiplier?: number;
    path: ResolvedAgentPath;
    model?: string;
    endpointKind: string;
    billingChannel?: BillingChannel;
    vendorFamily?: string;
    targetPresetId?: string;
    targetSettlementCurrency?: "CNY" | "USD";
    targetSettlementFx?: number;
    targetPlanMonthlyFee?: number;
    targetPlanTier?: string;
    planQuotaTotal?: PlanQuotaTotal;
    pricingRevisionId?: number;
    priceEffectiveAt?: string;
    catalogHash?: string;
  },
): ProcessExchangeResult {
  const auxiliaryId = `aux-${stableHash({
    exchangeId: prepared.hydrated.exchangeId,
    targetId: prepared.path.targetId,
  })}`;
  db.prepare(
    `INSERT INTO auxiliary_requests(
      id, exchange_id, agent_session_id, agent_thread_id, agent_turn_id,
      target_id, agent_fingerprint_id, agent_name, kind, timestamp, duration_ms
    ) VALUES(?, ?, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?)`,
  ).run(
    auxiliaryId,
    prepared.hydrated.exchangeId,
    prepared.path.targetId,
    prepared.path.agentFingerprintId,
    prepared.path.agentName,
    auxiliaryKind(prepared.endpointKind, prepared.hydrated.response.status),
    prepared.hydrated.capturedAt,
    safeDuration(prepared.hydrated.durationMs),
  );
  const ledger = buildUsageLedgerMetrics({
    hydrated: prepared.hydrated,
    model: prepared.model,
    pricingConfig: prepared.pricingConfig,
    tokenUsage: prepared.tokenUsage,
    credentialRateMultiplier: prepared.credentialRateMultiplier,
    capturedAt: prepared.hydrated.capturedAt,
    // 辅助请求与主请求同一供应商通道：缺失会让套餐积分（AFP/积分）与参考价列保持 NULL。
    billingChannel: prepared.billingChannel,
    targetPresetId: prepared.targetPresetId,
    targetSettlementCurrency: prepared.targetSettlementCurrency,
    targetSettlementFx: prepared.targetSettlementFx,
    targetPlanMonthlyFee: prepared.targetPlanMonthlyFee,
    targetPlanTier: prepared.targetPlanTier,
    planQuotaTotal: prepared.planQuotaTotal,
  }, prepared.path, {
    ...prepared,
    requestKind: prepared.endpointKind === "token-count" ? "token_count"
      : prepared.endpointKind === "metadata" ? "metadata"
        : prepared.endpointKind === "health-check" ? "health_check" : "auxiliary",
    responseStatus: prepared.hydrated.response.status,
    isStreaming: prepared.hydrated.response.isStreaming,
    connectionStatus: connectionStatusFromDiagnostics(prepared.hydrated),
  });
  writeUsageLedger(db, {
    exchange: prepared.hydrated,
    path: prepared.path,
    model: prepared.model,
    ledger,
    pricingRevisionId: prepared.pricingRevisionId,
    priceEffectiveAt: prepared.priceEffectiveAt,
    catalogHash: prepared.catalogHash,
  });
  return {
    exchangeId: prepared.hydrated.exchangeId,
    duplicate: false,
  };
}

function resolveAuxiliaryTurnId(
  db: DeepaaDatabase,
  threadId: string,
  nativeTurnId: string | undefined,
): string | undefined {
  if (nativeTurnId) {
    return db.prepare(
      `SELECT id FROM agent_turns
       WHERE agent_thread_id = ? AND native_turn_id = ?
       ORDER BY segment_index DESC, id DESC LIMIT 1`,
    ).pluck().get(threadId, nativeTurnId) as string | undefined;
  }
  const openTurnIds = db.prepare(
    `SELECT id FROM agent_turns
     WHERE agent_thread_id = ? AND status = 'open'
     ORDER BY segment_index DESC, id DESC LIMIT 2`,
  ).pluck().all(threadId) as string[];
  return openTurnIds.length === 1 ? openTurnIds[0] : undefined;
}

function auxiliaryKind(endpointKind: string, status: number): string {
  if (endpointKind === "token-count") return "token_count";
  if (endpointKind === "title-generation") return "title_generation";
  if (status === 401 || status === 403) return "auth_error";
  if (endpointKind === "health-check") return "health_check";
  if (endpointKind === "metadata") return "metadata";
  return "unknown";
}

function addAuxiliaryScopeAggregate(
  db: DeepaaDatabase,
  scopeType: ScopeType,
  scopeId: string,
  input: {
    timestamp: string;
    inputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    outputTokens: number;
    vendorCost: number;
    actualCost: number;
    durationMs: number;
  },
): void {
  addScopeAggregate(db, {
    scopeType,
    scopeId,
    stepRequests: 0,
    auxiliaryRequests: 1,
    inputTokens: input.inputTokens,
    cacheReadTokens: input.cacheReadTokens,
    cacheWriteTokens: input.cacheWriteTokens,
    outputTokens: input.outputTokens,
    vendorCost: input.vendorCost,
    actualCost: input.actualCost,
    durationMs: input.durationMs,
    durationSamples: 1,
    toolCalls: 0,
    updatedAt: input.timestamp,
  });
}

/**
 * 辅助 endpoint 的 protocol 会改变 fingerprint。这里只在供应商 Session 身份唯一匹配时，
 * 将它收敛到已存在层级；不会按时间或另一 Thread 的活动状态猜测身份。
 */
function reconcileAuxiliaryPath(
  db: DeepaaDatabase,
  path: ResolvedAgentPath,
): ResolvedAgentPath {
  const sessionRows = exactAuxiliarySessionRows(db, path);
  if (sessionRows.length !== 1) return path;
  const session = sessionRows[0]!;
  const root = db.prepare(
    `SELECT id FROM agent_threads
     WHERE agent_session_id = ? AND is_root = 1
     ORDER BY id LIMIT 2`,
  ).pluck().all(session.id) as string[];
  if (root.length !== 1) return path;
  const rootThreadId = root[0]!;
  const externalThreadIdentity = path.externalThreadId ?? path.externalAgentId;
  const existingThreadId = exactThreadId(
    db,
    session.id,
    path.externalThreadId,
    path.externalAgentId,
  );
  const threadId = existingThreadId
    ?? (externalThreadIdentity
      ? `athread-${stableHash({
        agentSessionId: session.id,
        providerThreadIdentity: externalThreadIdentity,
      })}`
      : rootThreadId);
  const parentThreadId = threadId === rootThreadId
    ? undefined
    : exactThreadId(
      db,
      session.id,
      path.externalParentThreadId,
      path.externalParentAgentId,
    ) ?? rootThreadId;
  return {
    ...path,
    agentSessionId: session.id,
    agentFingerprintId: session.agent_fingerprint_id,
    agentThreadId: threadId,
    rootAgentThreadId: rootThreadId,
    parentAgentThreadId: parentThreadId,
    isRootThread: threadId === rootThreadId,
  };
}

function exactAuxiliarySessionRows(
  db: DeepaaDatabase,
  path: ResolvedAgentPath,
): Array<{ id: string; agent_fingerprint_id: string }> {
  if (path.externalSessionId) {
    return db.prepare(
      `SELECT id, agent_fingerprint_id FROM agent_sessions
       WHERE target_id = ? AND agent_name = ? AND external_session_id = ?
       LIMIT 2`,
    ).all(
      path.targetId,
      path.agentName,
      path.externalSessionId,
    ) as Array<{ id: string; agent_fingerprint_id: string }>;
  }
  if (path.externalConversationId) {
    return db.prepare(
      `SELECT id, agent_fingerprint_id FROM agent_sessions
       WHERE target_id = ? AND agent_name = ? AND external_conversation_id = ?
       LIMIT 2`,
    ).all(
      path.targetId,
      path.agentName,
      path.externalConversationId,
    ) as Array<{ id: string; agent_fingerprint_id: string }>;
  }
  return [];
}

function exactThreadId(
  db: DeepaaDatabase,
  sessionId: string,
  externalThreadId: string | undefined,
  externalAgentId: string | undefined,
): string | undefined {
  if (externalThreadId) {
    const rows = db.prepare(
      `SELECT id FROM agent_threads
       WHERE agent_session_id = ? AND external_thread_id = ?
       ORDER BY id LIMIT 2`,
    ).pluck().all(sessionId, externalThreadId) as string[];
    return rows.length === 1 ? rows[0] : undefined;
  }
  if (externalAgentId) {
    const rows = db.prepare(
      `SELECT id FROM agent_threads
       WHERE agent_session_id = ? AND external_agent_id = ?
       ORDER BY id LIMIT 2`,
    ).pluck().all(sessionId, externalAgentId) as string[];
    return rows.length === 1 ? rows[0] : undefined;
  }
  return undefined;
}

function openTurnForExchange(
  db: DeepaaDatabase,
  input: {
    path: ResolvedAgentPath;
    threadId: string;
    model?: string;
    hydrated: RawCapturedExchange;
    nativeTurnId?: string;
    priorOpenTurn?: OpenTurnRow;
    sourceId: number;
  },
): OpenTurnRow {
  if (input.priorOpenTurn) {
    db.prepare(
      `UPDATE agent_turns SET status = 'closed'
       WHERE id = ? AND agent_thread_id = ? AND status = 'open'`,
    ).run(input.priorOpenTurn.id, input.threadId);
    writeLearningInsightForClosedTurn(db, {
      turnId: input.priorOpenTurn.id,
      exchangeId: input.hydrated.exchangeId,
      sourceId: input.sourceId,
      timestamp: input.hydrated.capturedAt,
    });
  }
  const segmentIndex = (db.prepare(
    `SELECT COALESCE(MAX(segment_index), 0) + 1
     FROM agent_turns WHERE agent_thread_id = ?`,
  ).pluck().get(input.threadId) as number);
  const turnId = `aturn-${stableHash({
    agentThreadId: input.threadId,
    nativeTurnIdentity: input.nativeTurnId
      ? {
        nativeTurnId: input.nativeTurnId,
        segmentIndex,
        segmentStartExchangeId: input.hydrated.exchangeId,
      }
      : {
        segmentIndex,
        segmentStartExchangeId: input.hydrated.exchangeId,
      },
  })}`;
  db.prepare(
    `INSERT INTO agent_turns(
      id, agent_session_id, agent_thread_id, native_turn_id, source,
      confidence, status, segment_index, start_exchange_id, start_time,
      end_time, model_set_json
    ) VALUES(?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO NOTHING`,
  ).run(
    turnId,
    input.path.agentSessionId,
    input.threadId,
    input.nativeTurnId ?? null,
    input.nativeTurnId ? "native-turn" : "segment-start",
    input.path.confidence,
    segmentIndex,
    input.hydrated.exchangeId,
    input.hydrated.capturedAt,
    input.hydrated.capturedAt,
    JSON.stringify(input.model ? [input.model] : []),
  );
  return {
    id: turnId,
    native_turn_id: input.nativeTurnId ?? null,
    segment_index: segmentIndex,
    step_count: 0,
  };
}

function findOpenTurn(
  db: DeepaaDatabase,
  threadId: string,
): OpenTurnRow | undefined {
  return db.prepare(
    `SELECT id, native_turn_id, segment_index, step_count
     FROM agent_turns
     WHERE agent_thread_id = ? AND status = 'open'
     ORDER BY segment_index DESC, id DESC
     LIMIT 1`,
  ).get(threadId) as OpenTurnRow | undefined;
}

function agentTurnShape(
  turn: OpenTurnRow,
  path: ResolvedAgentPath,
  threadId: string,
  exchange: RawCapturedExchange,
): AgentTurn {
  return {
    id: turn.id,
    agentSessionId: path.agentSessionId,
    agentFingerprintId: path.agentFingerprintId,
    source: "agent-session",
    exchangeIds: [exchange.exchangeId],
    auxiliaryExchangeIds: [],
    startTime: exchange.capturedAt,
    endTime: exchange.completedAt,
    modelSet: [],
    targetSet: [path.targetId],
    confidence: path.confidence,
    evidence: [],
    externalThreadId: threadId,
  };
}

function insertRawExchangeRef(
  db: DeepaaDatabase,
  input: ProcessExchangeInput,
  prepared: PreparedExchange,
): void {
  const { hydrated, path, model } = prepared;
  db.prepare(
    `INSERT INTO raw_exchange_refs(
      exchange_id, capture_session_id, source_id, byte_offset,
      line_length_bytes, captured_at, completed_at, target_id, target_name,
      agent_name, agent_fingerprint_id, model, wire_api, status, is_streaming,
      request_body_bytes, response_body_bytes, diagnostic_codes_json
      , origin
      , ingestion_record_id
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    hydrated.exchangeId,
    hydrated.captureSessionId,
    input.sourceId,
    input.byteOffset,
    input.lineLengthBytes,
    hydrated.capturedAt,
    hydrated.completedAt,
    path.targetId,
    path.targetName,
    path.agentName,
    path.agentFingerprintId,
    model ?? null,
    hydrated.routing.wireApi ?? null,
    hydrated.response.status,
    hydrated.response.isStreaming ? 1 : 0,
    hydrated.request.bodySizeBytes,
    hydrated.response.bodySizeBytes,
    JSON.stringify([...new Set(
      hydrated.captureDiagnostics.map(diagnostic => diagnostic.code),
    )]),
    hydrated.routing.origin ?? "gateway",
    input.ingestionRecordId ?? null,
  );
}

/** 业务事实、预览和媒体描述符共享 processor 的短事务，正文 I/O 已在事务外完成。 */
function writeExchangeProjection(
  db: DeepaaDatabase,
  input: ProcessExchangeInput,
  prepared: PreparedExchange,
  result: ProcessExchangeResult,
): void {
  const projection = prepared.projection;
  const preview = projection.preview;
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO exchange_content_previews(
      exchange_id, projection_version, preview_state, preview_json,
      size_bytes, candidate_item_count, processed_item_count,
      candidate_text_bytes, processed_text_bytes, candidate_count_exact,
      limited, truncated, limited_dimensions_json, created_at, updated_at
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(exchange_id) DO UPDATE SET
      projection_version = excluded.projection_version,
      preview_state = excluded.preview_state,
      preview_json = excluded.preview_json,
      size_bytes = excluded.size_bytes,
      candidate_item_count = excluded.candidate_item_count,
      processed_item_count = excluded.processed_item_count,
      candidate_text_bytes = excluded.candidate_text_bytes,
      processed_text_bytes = excluded.processed_text_bytes,
      candidate_count_exact = excluded.candidate_count_exact,
      limited = excluded.limited,
      truncated = excluded.truncated,
      limited_dimensions_json = excluded.limited_dimensions_json,
      updated_at = excluded.updated_at
    WHERE excluded.projection_version >= exchange_content_previews.projection_version`,
  ).run(
    prepared.hydrated.exchangeId,
    preview.projectionVersion,
    projection.completeness,
    preview.previewJson,
    preview.sizeBytes,
    preview.itemCandidateCount,
    preview.itemProcessedCount,
    preview.candidateTextBytes,
    preview.processedTextBytes,
    preview.itemCandidateCountExact ? 1 : 0,
    preview.limited ? 1 : 0,
    preview.truncated ? 1 : 0,
    JSON.stringify(projection.limitedDimensions.slice(0, 32)),
    now,
    now,
  );

  writeContentFilterProjection(db, prepared, result, now);

  db.prepare(
    "DELETE FROM exchange_media_descriptors WHERE exchange_id = ?",
  ).run(prepared.hydrated.exchangeId);
  const insertMedia = db.prepare(
    `INSERT INTO exchange_media_descriptors(
      exchange_id, body_side, ordinal, json_path, media_type,
      encoded_bytes, decoded_bytes, sha256, raw_body_sha256, source_storage
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const descriptor of projection.mediaDescriptors) {
    insertMedia.run(
      descriptor.exchangeId,
      descriptor.bodySide,
      descriptor.ordinal,
      descriptor.jsonPath,
      descriptor.mediaType,
      descriptor.encodedBytes,
      descriptor.decodedBytes,
      descriptor.sha256,
      descriptor.rawBodySha256,
      descriptor.sourceStorage,
    );
  }

  const insertDiagnostic = db.prepare(
    `INSERT INTO derivation_diagnostics(
      exchange_id, source_id, ingestion_record_id, projection_version,
      code, severity, message, details_json, created_at
    ) SELECT ?, ?, ?, ?, ?, 'warning', ?, '{}', ?
    WHERE NOT EXISTS(
      SELECT 1 FROM derivation_diagnostics
      WHERE exchange_id = ? AND code = ?
    )`,
  );
  for (const code of projection.diagnosticCodes.slice(0, 64)) {
    insertDiagnostic.run(
      prepared.hydrated.exchangeId,
      input.sourceId,
      input.ingestionRecordId ?? null,
      preview.projectionVersion,
      boundedText(code, 256),
      "派生按有界协议完成，详情请查看任务完整性与受限维度。",
      now,
      prepared.hydrated.exchangeId,
      boundedText(code, 256),
    );
  }
}

interface ContentCategoryAccumulator {
  totalCount: number;
  uniqueCount: number;
  inheritedCount: number;
  unconfirmedCount: number;
}

/**
 * 只以同一实际 Thread 紧邻的上一模型 Request 为基线。所有 occurrence 判定在
 * 当前短事务内先完成，再写入 stats/fingerprint/Preview，查询路径绝不打开 Raw。
 */
function writeContentFilterProjection(
  db: DeepaaDatabase,
  prepared: PreparedExchange,
  result: ProcessExchangeResult,
  now: string,
): void {
  const exchangeId = prepared.hydrated.exchangeId;
  const preview = prepared.projection.preview;
  const retainedFilterCountBySide = filterItemCountBySide(preview.filterItems);
  const requestFilterState = preview.filterItemCandidateCountExactBySide.request
    && retainedFilterCountBySide.request
      === preview.filterItemCandidateCountBySide.request
    ? "complete"
    : "limited";
  const responseFilterState = preview.filterItemCandidateCountExactBySide.response
    && retainedFilterCountBySide.response
      === preview.filterItemCandidateCountBySide.response
    ? "complete"
    : "limited";
  const filterState = requestFilterState === "complete"
    && responseFilterState === "complete"
    ? "complete"
    : "limited";
  const requestItems = preview.filterItems.filter(item => item.side === "request");
  const context = resolveRequestContextProjection({
    current: currentRequestContextState(
      db,
      result,
      preview.projectionVersion,
      preview.requestContextMode ?? "unknown",
      requestFilterState,
      requestItems,
      preview.contextBoundaryCandidates,
    ),
    previous: previousRequestContextState(db, result),
  });
  const requestFreshness = new Map<ExchangeContentFilterItem, RequestItemFreshness>(
    context.decisions.map(decision => [decision.item, decision.freshness]),
  );
  const stats = contentCategoryStats(preview.filterItems, requestFreshness);

  db.prepare(
    `INSERT INTO exchange_content_filter_status(
      exchange_id, projection_version, filter_state,
      request_filter_state, response_filter_state, request_dedupe_state,
      request_context_mode, request_comparison_kind, request_context_epoch,
      effective_context_boundary_id, produced_context_boundary_id,
      baseline_exchange_id, request_fingerprint_count, created_at, updated_at
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(exchange_id) DO UPDATE SET
      projection_version = excluded.projection_version,
      filter_state = excluded.filter_state,
      request_filter_state = excluded.request_filter_state,
      response_filter_state = excluded.response_filter_state,
      request_dedupe_state = excluded.request_dedupe_state,
      request_context_mode = excluded.request_context_mode,
      request_comparison_kind = excluded.request_comparison_kind,
      request_context_epoch = excluded.request_context_epoch,
      effective_context_boundary_id = excluded.effective_context_boundary_id,
      produced_context_boundary_id = excluded.produced_context_boundary_id,
      baseline_exchange_id = excluded.baseline_exchange_id,
      request_fingerprint_count = excluded.request_fingerprint_count,
      updated_at = excluded.updated_at
    WHERE excluded.projection_version >= exchange_content_filter_status.projection_version`,
  ).run(
    exchangeId,
    preview.projectionVersion,
    filterState,
    requestFilterState,
    responseFilterState,
    context.requestDedupeState,
    context.context.contextMode,
    context.context.comparisonKind,
    context.context.contextEpoch ?? null,
    context.context.effectiveBoundaryId ?? null,
    context.context.producedBoundaryId ?? null,
    context.context.baselineExchangeId ?? null,
    requestItems.length,
    now,
    now,
  );

  db.prepare(
    "DELETE FROM exchange_request_fingerprints WHERE exchange_id = ?",
  ).run(exchangeId);
  const insertFingerprint = db.prepare(
    `INSERT INTO exchange_request_fingerprints(
      exchange_id, body_side, category, fingerprint, provider_lineage_key,
      occurrence_count
    ) VALUES(?, ?, ?, ?, ?, ?)`,
  );
  for (const fingerprint of requestFingerprintCounts(requestItems)) {
    insertFingerprint.run(
      exchangeId,
      fingerprint.side,
      fingerprint.category,
      Buffer.from(fingerprint.value, "hex"),
      fingerprint.providerLineageKey,
      fingerprint.occurrenceCount,
    );
  }

  db.prepare(
    "DELETE FROM exchange_content_category_stats WHERE exchange_id = ?",
  ).run(exchangeId);
  const insertStats = db.prepare(
    `INSERT INTO exchange_content_category_stats(
      exchange_id, body_side, category, total_count, unique_count,
      inherited_count, unconfirmed_count
    ) VALUES(?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const stat of stats.values()) {
    insertStats.run(
      exchangeId,
      stat.side,
      stat.category,
      stat.totalCount,
      stat.uniqueCount,
      stat.inheritedCount,
      stat.unconfirmedCount,
    );
  }

  writePreviewRequestContext(
    db,
    exchangeId,
    prepared.projection.preview.previewJson,
    context.context,
  );
}

function filterItemCountBySide(
  items: readonly ExchangeContentFilterItem[],
): Record<ProjectionBodySide, number> {
  return {
    request: items.filter(item => item.side === "request").length,
    response: items.filter(item => item.side === "response").length,
  };
}

function currentRequestContextState(
  db: DeepaaDatabase,
  result: ProcessExchangeResult,
  projectionVersion: number,
  contextMode: CurrentRequestProjectionState["contextMode"],
  requestFilterState: CurrentRequestProjectionState["requestFilterState"],
  filterItems: ExchangeContentFilterItem[],
  boundaryCandidates: CurrentRequestProjectionState["boundaryCandidates"],
): CurrentRequestProjectionState {
  const nativeTurnValue = result.turnId
    ? db.prepare(
      "SELECT native_turn_id FROM agent_turns WHERE id = ?",
    ).pluck().get(result.turnId) as string | null | undefined
    : undefined;
  const nativeTurnId = nativeTurnValue ?? undefined;
  return {
    exchangeId: result.exchangeId,
    projectionVersion,
    contextMode,
    requestFilterState,
    nativeTurnId,
    nativeTurnStable: nativeTurnId !== undefined,
    filterItems,
    boundaryCandidates,
  };
}

function previousRequestContextState(
  db: DeepaaDatabase,
  result: ProcessExchangeResult,
): StoredRequestProjectionState | undefined {
  if (!result.stepId || !result.threadId) return undefined;
  const current = db.prepare(
    "SELECT timestamp, exchange_id FROM agent_steps WHERE id = ?",
  ).get(result.stepId) as { timestamp: string; exchange_id: string } | undefined;
  if (!current) throw new Error(`Step ${result.stepId} 缺少筛选投影定位。`);
  const previous = db.prepare(
    `SELECT step.exchange_id, turn.native_turn_id,
      status.projection_version,
      status.request_context_mode, status.request_context_epoch,
      status.effective_context_boundary_id, status.produced_context_boundary_id,
      status.request_filter_state
     FROM agent_steps step
     JOIN agent_turns turn ON turn.id = step.agent_turn_id
     LEFT JOIN exchange_content_filter_status status
       ON status.exchange_id = step.exchange_id
     WHERE step.agent_thread_id = ?
       AND (step.timestamp < ? OR (step.timestamp = ? AND step.exchange_id < ?))
     ORDER BY step.timestamp DESC, step.exchange_id DESC
     LIMIT 1`,
  ).get(
    result.threadId,
    current.timestamp,
    current.timestamp,
    current.exchange_id,
  ) as PreviousRequestContextRow | undefined;
  if (!previous) return undefined;
  const filterItems = previous.request_filter_state === "complete"
    ? requestFilterItemsForExchange(db, previous.exchange_id)
    : [];
  return {
    exchangeId: previous.exchange_id,
    projectionVersion: previous.projection_version ?? undefined,
    contextMode: isRequestContextMode(previous.request_context_mode)
      ? previous.request_context_mode
      : "unknown",
    contextEpoch: previous.request_context_epoch ?? undefined,
    effectiveBoundaryId: previous.effective_context_boundary_id ?? undefined,
    producedBoundaryId: previous.produced_context_boundary_id ?? undefined,
    requestFilterState: previous.request_filter_state === "complete"
      ? "complete"
      : "limited",
    nativeTurnId: previous.native_turn_id ?? undefined,
    nativeTurnStable: previous.native_turn_id !== null,
    filterItems,
  };
}

interface PreviousRequestContextRow {
  exchange_id: string;
  native_turn_id: string | null;
  projection_version: number | null;
  request_context_mode: string | null;
  request_context_epoch: number | null;
  effective_context_boundary_id: string | null;
  produced_context_boundary_id: string | null;
  request_filter_state: string | null;
}

function isRequestContextMode(
  value: string | null,
): value is CurrentRequestProjectionState["contextMode"] {
  return value === "full_replay"
    || value === "stateful_delta"
    || value === "unknown";
}

function requestFilterItemsForExchange(
  db: DeepaaDatabase,
  exchangeId: string,
): ExchangeContentFilterItem[] {
  const rows = db.prepare(
    `SELECT body_side, category, fingerprint, provider_lineage_key, occurrence_count
     FROM exchange_request_fingerprints
     WHERE exchange_id = ? AND body_side = 'request'
     ORDER BY category, fingerprint, provider_lineage_key`,
  ).all(exchangeId) as Array<{
    body_side: ProjectionBodySide;
    category: ExchangeContentFilterItem["category"];
    fingerprint: Buffer;
    provider_lineage_key: string;
    occurrence_count: number;
  }>;
  const result: ExchangeContentFilterItem[] = [];
  for (const row of rows) {
    for (let index = 0; index < row.occurrence_count; index += 1) {
      result.push({
        side: row.body_side,
        category: row.category,
        fingerprint: row.fingerprint.toString("hex"),
        providerLineageKey: row.provider_lineage_key || undefined,
      });
    }
  }
  return result;
}

interface StoredContentCategoryStats extends ContentCategoryAccumulator {
  side: ProjectionBodySide;
  category: ExchangeContentFilterItem["category"];
}

function contentCategoryStats(
  items: readonly ExchangeContentFilterItem[],
  requestFreshness: ReadonlyMap<ExchangeContentFilterItem, RequestItemFreshness>,
): Map<string, StoredContentCategoryStats> {
  const stats = new Map<string, StoredContentCategoryStats>();
  for (const item of items) {
    const key = `${item.side}:${item.category}`;
    const category = stats.get(key) ?? {
      side: item.side,
      category: item.category,
      totalCount: 0,
      uniqueCount: 0,
      inheritedCount: 0,
      unconfirmedCount: 0,
    };
    category.totalCount += 1;
    const freshness = item.side === "request"
      ? requestFreshness.get(item) ?? "unconfirmed"
      : "current_new";
    if (freshness === "inherited") category.inheritedCount += 1;
    else if (freshness === "unconfirmed") category.unconfirmedCount += 1;
    else category.uniqueCount += 1;
    stats.set(key, category);
  }
  return stats;
}

interface RequestFingerprintCount {
  side: ProjectionBodySide;
  category: ExchangeContentFilterItem["category"];
  value: string;
  providerLineageKey: string;
  occurrenceCount: number;
}

function requestFingerprintCounts(
  items: readonly ExchangeContentFilterItem[],
): RequestFingerprintCount[] {
  const counts = new Map<string, RequestFingerprintCount>();
  for (const item of items) {
    const providerLineageKey = item.providerLineageKey ?? "";
    const key = JSON.stringify([
      item.side,
      item.category,
      item.fingerprint,
      providerLineageKey,
    ]);
    const current = counts.get(key);
    if (current) {
      current.occurrenceCount += 1;
    } else {
      counts.set(key, {
        side: item.side,
        category: item.category,
        value: item.fingerprint,
        providerLineageKey,
        occurrenceCount: 1,
      });
    }
  }
  return [...counts.values()];
}

function writePreviewRequestContext(
  db: DeepaaDatabase,
  exchangeId: string,
  previewJson: string,
  requestContext: ReturnType<typeof resolveRequestContextProjection>["context"],
): void {
  const parsed = JSON.parse(previewJson) as Record<string, unknown>;
  parsed.requestContext = {
    contextMode: requestContext.contextMode,
    ...(requestContext.contextEpoch === undefined
      ? {}
      : { contextEpoch: requestContext.contextEpoch }),
    ...(requestContext.effectiveBoundaryId === undefined
      ? {}
      : { effectiveBoundaryId: requestContext.effectiveBoundaryId }),
    ...(requestContext.producedBoundaryId === undefined
      ? {}
      : { producedBoundaryId: requestContext.producedBoundaryId }),
    comparisonKind: requestContext.comparisonKind,
    ...(requestContext.baselineExchangeId === undefined
      ? {}
      : { baselineExchangeId: requestContext.baselineExchangeId }),
    resolution: requestContext.resolution,
  };
  const serialized = JSON.stringify(parsed);
  const sizeBytes = Buffer.byteLength(serialized);
  if (sizeBytes > CONTENT_PREVIEW_MAX_BYTES) {
    throw new Error("Request 上下文回写后超过 Content Preview 256 KiB 上限。");
  }
  db.prepare(
    `UPDATE exchange_content_previews
     SET preview_json = ?, size_bytes = ?
     WHERE exchange_id = ?`,
  ).run(serialized, sizeBytes, exchangeId);
}

function writeToolCalls(
  db: DeepaaDatabase,
  path: { sessionId: string; threadId: string },
  turnId: string,
  stepId: string,
  exchange: RawCapturedExchange,
  normalized: NormalizedExchange,
): number {
  for (const result of normalized.harnessPayload.providedToolResults) {
    if (!result.toolUseId) continue;
    db.prepare(
      `UPDATE tool_calls SET status = 'completed'
       WHERE agent_thread_id = ? AND agent_turn_id = ? AND tool_use_id = ?`,
    ).run(path.threadId, turnId, result.toolUseId);
  }

  normalized.response.toolUses.forEach((toolUse, index) => {
    const toolCallId = `tcall-${stableHash({
      exchangeId: exchange.exchangeId,
      occurrenceIndex: index,
      toolUseId: toolUse.id || null,
      toolName: toolUse.name || "unknown",
    })}`;
    const hasInlineResult = normalized.response.toolResults.some(
      result => !!toolUse.id && result.toolUseId === toolUse.id,
    );
    db.prepare(
      `INSERT INTO tool_calls(
        id, exchange_id, agent_session_id, agent_thread_id, agent_turn_id,
        agent_step_id, tool_use_id, tool_name, status, created_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      toolCallId,
      exchange.exchangeId,
      path.sessionId,
      path.threadId,
      turnId,
      stepId,
      toolUse.id || null,
      toolUse.name || "unknown",
      hasInlineResult ? "completed" : "awaiting_result",
      exchange.capturedAt,
    );
  });
  return normalized.response.toolUses.length;
}

interface UsageLedgerMetrics {
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  currency: string;
  vendorCost: number;
  actualCost: number;
  vendor: string;
  rateMultiplier: number;
  usageSource: string;
  usageConfidence: string;
  pricingSnapshotJson: string;
  billingChannel?: BillingChannel;
  vendorFamily?: string;
  planCreditCost?: number;
  planCreditUnit?: string;
  planCreditFormulaVersion?: string;
  requestKind: RequestKind;
  resultClass: string;
  usageQuality: string;
  pricingStatus: string;
  auditEligible: boolean;
  auditExclusionReason?: string;
  derivedTotalTokens?: number;
  providerTotalTokens?: number;
  totalTokensBasis: string;
  reasoningSemantics: ReasoningSemantics;
  referencePriceEntryId?: string;
  referenceCostNano?: number;
  referenceCurrency?: string;
  referenceCostStatus: string;
  costBasis: CostBasis;
  vendorCostNano?: number;
  actualCostNano?: number;
  /** 人民币口径物化（2026-09-05 四层分离）：计价数字×结算系数；供展示层拉平聚合。 */
  vendorCostCny?: number;
  actualCostCny?: number;
  /** 写入时锁定的结算系数（USD→CNY；CNY/中转记账为 1）。 */
  fxRateToCny?: number;
  /** 套餐成本估算（2026-09-15 入账冻结）：status=none 时其余字段缺省。 */
  planEstimatedStatus: "estimated" | "unavailable" | "none";
  /** 估算来源（v49）：formula=派生期公式/守卫；quota_delta=额度差分回填（plan-estimate）。 */
  planEstimatedMethod?: string;
  planEstimatedCost?: number;
  planEstimatedCurrency?: "CNY" | "USD";
  planEstimatedFx?: number;
  planEstimatedCostNano?: number;
  planEstimateDetailJson?: string;
  /** 耗时是否计入时长样本（断流/未完成请求不计）。 */
  durationSampleEligible: boolean;
}

function buildUsageLedgerMetrics(
  prepared: Pick<
    PreparedExchange,
    "hydrated" | "tokenUsage" | "pricingConfig" | "model" | "credentialRateMultiplier" | "capturedAt" | "billingChannel"
  > & Pick<PreparedExchange, "targetPresetId" | "targetSettlementCurrency" | "targetSettlementFx" | "targetPlanMonthlyFee" | "targetPlanTier" | "planQuotaTotal">,
  path: ResolvedAgentPath,
  channel: {billingChannel?: BillingChannel; vendorFamily?: string; requestKind?: RequestKind; responseStatus?: number; isStreaming?: boolean; connectionStatus?: StreamConnectionStatus} = {},
): UsageLedgerMetrics {
  const tokenUsage = prepared.tokenUsage;
  const usage = {
    inputTokens: safeTokenCount(tokenUsage.inputTokens),
    cacheReadTokens: safeTokenCount(tokenUsage.cacheReadTokens),
    cacheCreationTokens: safeTokenCount(tokenUsage.cacheCreationTokens),
    ...(tokenUsage.cacheCreation5mTokens !== undefined
      ? {cacheCreation5mTokens: safeTokenCount(tokenUsage.cacheCreation5mTokens)}
      : {}),
    ...(tokenUsage.cacheCreation1hTokens !== undefined
      ? {cacheCreation1hTokens: safeTokenCount(tokenUsage.cacheCreation1hTokens)}
      : {}),
    outputTokens: safeTokenCount(tokenUsage.outputTokens),
    reasoningTokens: safeTokenCount(tokenUsage.reasoningTokens),
    totalTokens: safeTokenCount(tokenUsage.totalTokens),
    // service_tier 计费参数：来自代理捕获的请求体前缀，命中价格乘数规则时整单乘系数。
    ...(prepared.hydrated.request.serviceTier ? {serviceTier: prepared.hydrated.request.serviceTier} : {}),
  };
  /* 官方通道促销判定：目标预设的价格供应商与命中条目 vendor 一致时启用按量促销
     （promotions 时间窗 + agent 限定；中转站仍按牌价）。 */
  const officialPreset = prepared.targetPresetId
    ? PROVIDER_PRESETS.find(preset => preset.id === prepared.targetPresetId)
    : undefined;
  const cost = computeTokenCost(
    prepared.pricingConfig,
    prepared.model,
    usage,
    {
      targetId: path.targetId,
      agentFingerprintId: path.agentFingerprintId,
      agentName: path.agentName,
      rateMultiplierOverride: prepared.credentialRateMultiplier,
      capturedAt: prepared.capturedAt,
      ...(officialPreset ? {officialPresetVendor: officialPreset.pricingProviderId} : {}),
      ...(prepared.billingChannel ? {billingChannel: prepared.billingChannel} : {}),
    },
  );
  /* 结算语义（2026-09-23 方案 B 版本化）：优先取按 captured_at 选定的价格版本里的目标
     结算系数——迟到行（捕获在改系数前、派生在其后，如 web 宕机补账）按捕获时刻的
     系数入账；历史版本 blob 尚无该字段时回退现读的目标元数据值。其余规则（2026-10-06
     修订，修复 deepseek 事故：CNY 区预设命中 USD 条目曾被 1:1 记人民币）：
     CNY=1；USD 且官方预设（任意 catalogKey——含 CNY 区预设上手工配置/LiteLLM 兜底
     命中的美元条目）=价格中心 fx 快照；无官方预设（中转站/自定义）默认 1:1 牌价。
     写入时锁定。 */
  const versionedSettlementFx = prepared.pricingConfig.targetSettlementFx?.[path.targetId];
  const costCurrency = cost.currency ?? "USD";
  const fxRateToCny = versionedSettlementFx
    ?? prepared.targetSettlementFx
    ?? (costCurrency === "CNY"
      ? 1
      : officialPreset
        ? resolveFxRate(prepared.pricingConfig.fx, "USD", "CNY")
        : 1);
  const planCredit = computePlanCreditForLedger(
    prepared,
    cost,
    usage,
    path.agentName,
    // 双链路观测（2026-09-15）：官方客户端活动（Campaign origins 限定）按观测通道判定——
    // 经网关的流量官方不认定为官方客户端，agent_local_import 限定活动不命中。
    prepared.hydrated.routing.origin,
  );
  const audit = buildLedgerMetrics({
    usage: tokenUsage,
    cost,
    requestKind: channel.requestKind,
    responseStatus: channel.responseStatus,
    isStreaming: channel.isStreaming,
    connectionStatus: channel.connectionStatus,
    terminalSeen: streamTerminalSeen(prepared.hydrated),
    billingChannel: channel.billingChannel,
  });
  const referenceCostNano = (prepared.billingChannel === "plan" || prepared.billingChannel === "subscription")
    && cost.priced
    ? Math.round(safeCost(cost.officialTotalCost) * fxRateToCny * 1_000_000_000)
    : undefined;
  /* 套餐成本估算入账冻结（2026-09-15）：月费/额度/汇率都以入账时可见值为准，
     查询端只读冻结值；额度已按请求时价格版本汇率解析（prepareRecord）。
     月费币种（2026-09-28 修复）：显式 settlementCurrency 优先；缺失时按官方预设
     目录币种兜底（cn→CNY、global→USD，如存量 OpenCode Go $10 曾被当 ¥10 低估约 fx 倍）；
     无 presetId 的自定义目标维持缺省 CNY 语义（写入端负责补币种）。
     market_share（2026-09-30 OpenCode Go）：分母优先取条目×档位月度额度
     （planCredit.marketShareQuotaTotal）；解析不到回退快照窗口额度，再不行即
     market_blocked（unavailable）诚实降级——绝不用写死常量兜底。 */
  const planQuota = planCredit.marketShareQuotaTotal ?? prepared.planQuotaTotal;
  const planEstimate = computePlanEstimateForLedger({
    billingChannel: channel.billingChannel,
    planCreditCost: planCredit.planCreditCost,
    planCreditUnit: planCredit.planCreditUnit,
    referenceCostNano,
    monthlyFee: prepared.targetPlanMonthlyFee,
    feeCurrency: resolvePlanFeeCurrency({explicit: prepared.targetSettlementCurrency, preset: officialPreset}),
    quotaTotal: planQuota?.total,
    quotaUnit: planQuota?.unit,
    windowDays: planQuota?.windowDays,
    windowLabel: planQuota?.windowLabel,
    fxUsdCny: resolveFxRate(prepared.pricingConfig.fx, "USD", "CNY"),
    ...(planCredit.marketShareQuotaTotal?.monthlyLimitUsd !== undefined ? {
      modelId: prepared.model,
      planTier: prepared.targetPlanTier,
      monthlyLimitUsd: planCredit.marketShareQuotaTotal.monthlyLimitUsd,
    } : {}),
  });
  return {
    inputTokens: usage.inputTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheCreationTokens,
    // SQLite 账本的双 TTL 列保持 NOT NULL；上游未拆分 TTL 时写 0，
    // 同时由 usageSource/usageConfidence 保留“未提供分项”的可审计语义。
    cacheWrite5mTokens: usage.cacheCreation5mTokens ?? 0,
    cacheWrite1hTokens: usage.cacheCreation1hTokens ?? 0,
    outputTokens: usage.outputTokens,
    reasoningTokens: usage.reasoningTokens,
    totalTokens: usage.totalTokens,
    /* 未计价请求不落 'USD' 占位：占位币种会进入 facts 币种维度，
       误触发仪表盘多币种金额拦截；'unknown' 只表示未定币种（金额必为 0）。 */
    currency: cost.currency ?? "unknown",
    // upstream_error 写入端金额归零（2026-09-17 用户确认）：上游 4xx/5xx 未真正
    // 服务（tokenizer_estimated 估算无实扣语义）；token 保留全量观测口径，
    // 仪表盘消费口径（result_class IN success/cancelled/reconciled）本就排除。
    vendorCost: audit.resultClass === "upstream_error" ? 0 : safeCost(cost.officialTotalCost),
    actualCost: audit.resultClass === "upstream_error" ? 0 : safeCost(cost.totalCost),
    vendorCostCny: (audit.resultClass === "upstream_error" ? 0 : safeCost(cost.officialTotalCost)) * fxRateToCny,
    actualCostCny: (audit.resultClass === "upstream_error" ? 0 : safeCost(cost.totalCost)) * fxRateToCny,
    fxRateToCny,
    vendor: cost.vendor ?? "unknown",
    rateMultiplier: cost.pricingSnapshot?.rateMultiplier ?? 1,
    usageSource: ledgerUsageSource(tokenUsage, prepared.hydrated.routing.origin),
    usageConfidence: ledgerUsageConfidence(tokenUsage, prepared.hydrated.routing.origin),
    billingChannel: channel.billingChannel,
    vendorFamily: channel.vendorFamily,
    planCreditCost: planCredit.planCreditCost,
    planCreditUnit: planCredit.planCreditUnit,
    planCreditFormulaVersion: planCredit.planCreditFormulaVersion,
    planEstimatedStatus: planEstimate.status,
    // 估算来源标记（v49）：派生期估算一律 formula；quota_delta 由额度差分回填写入。
    ...(planEstimate.status === "estimated" || planEstimate.status === "unavailable" ? {planEstimatedMethod: "formula"} : {}),
    ...(planEstimate.cost !== undefined ? {planEstimatedCost: planEstimate.cost} : {}),
    ...(planEstimate.currency ? {planEstimatedCurrency: planEstimate.currency} : {}),
    ...(planEstimate.fx !== undefined ? {planEstimatedFx: planEstimate.fx} : {}),
    ...(planEstimate.nano !== undefined ? {planEstimatedCostNano: planEstimate.nano} : {}),
    ...(planEstimate.detailJson ? {planEstimateDetailJson: planEstimate.detailJson} : {}),
    pricingSnapshotJson: JSON.stringify({
      ...cost.pricingSnapshot,
      priced: cost.priced,
      ...(cost.unpricedReason ? { unpricedReason: cost.unpricedReason } : {}),
      currency: cost.currency,
      fxRateToCny,
      ...(planCredit.planCreditFormula ? {planCreditFormula: planCredit.planCreditFormula} : {}),
      ...(planCredit.planCreditFormulaDetail ? {planCreditFormulaDetail: planCredit.planCreditFormulaDetail} : {}),
      ...(planCredit.planProfileId ? {planProfileId: planCredit.planProfileId} : {}),
      ...(planCredit.matchedCampaignLabels ? {matchedCampaignLabels: planCredit.matchedCampaignLabels} : {}),
    }),
    requestKind: audit.requestKind,
    resultClass: audit.resultClass,
    usageQuality: audit.usageQuality,
    pricingStatus: audit.pricingStatus,
    auditEligible: audit.auditEligible,
    auditExclusionReason: audit.auditExclusionReason,
    derivedTotalTokens: audit.derivedTotalTokens,
    providerTotalTokens: audit.providerTotalTokens,
    totalTokensBasis: audit.totalTokensBasis,
    reasoningSemantics: audit.reasoningSemantics,
    referencePriceEntryId: prepared.billingChannel === "plan" || prepared.billingChannel === "subscription"
      ? cost.pricingSnapshot?.priceEntryId
      : undefined,
    referenceCostNano,
    referenceCurrency: prepared.billingChannel === "plan" || prepared.billingChannel === "subscription"
      ? cost.currency ?? "USD"
      : undefined,
    referenceCostStatus: audit.referenceCostStatus,
    costBasis: audit.costBasis,
    vendorCostNano: Math.round((audit.resultClass === "upstream_error" ? 0 : safeCost(cost.officialTotalCost)) * fxRateToCny * 1_000_000_000),
    actualCostNano: Math.round((audit.resultClass === "upstream_error" ? 0 : safeCost(cost.totalCost)) * fxRateToCny * 1_000_000_000),
    durationSampleEligible: audit.durationSampleEligible,
  };
}

/**
 * 协议终态事件是否已见：用于"客户端在完整响应后立即断连"的 cancelled→success 收紧判定。
 * 只认三类流式协议的终态标记；非流式或无流事件返回 false。
 */
function streamTerminalSeen(hydrated: RawCapturedExchange): boolean {
  const events = hydrated.stream?.events || [];
  return events.some(event =>
    event.event === "message_stop"
    || event.event === "response.completed"
    || event.event === "[DONE]");
}

/**
 * 从 raw 捕获诊断推导连接收尾状态：客户端中止优先于上游中断。
 * 代理侧 diagnostic code 与 StreamConnectionStatus 的对应：
 * client_aborted / upstream_aborted / connection_reset / connection_error 同名，
 * proxy_error 对应 proxy_stream_error。
 */
type CaptureDiagnosticCode = RawCapturedExchange["captureDiagnostics"][number]["code"];

const DIAGNOSTIC_TO_CONNECTION_STATUS: ReadonlyArray<[CaptureDiagnosticCode, StreamConnectionStatus]> = [
  ["client_aborted", "client_aborted"],
  ["upstream_aborted", "upstream_aborted"],
  ["connection_reset", "connection_reset"],
  ["connection_error", "connection_error"],
  ["proxy_error", "proxy_stream_error"],
];

function connectionStatusFromDiagnostics(
  exchange: RawCapturedExchange,
): StreamConnectionStatus | undefined {
  const codes = new Set(exchange.captureDiagnostics.map(diagnostic => diagnostic.code));
  for (const [code, status] of DIAGNOSTIC_TO_CONNECTION_STATUS) {
    if (codes.has(code)) return status;
  }
  return undefined;
}

/**
 * 账本 usage 来源标注（双链路观测）：官方直连导入行的 token 数来自 Agent 客户端
 * 自报的权威记录（非 wire 解析），来源标 agent_local_import、置信标 client_declared，
 * 供账本审计区分「哪些金额来自导入」；网关行维持既有 wire 解析语义。
 */
function ledgerUsageSource(
  tokenUsage: TokenUsageSummary,
  origin: string | undefined,
): string {
  return origin === "agent_local_import" && tokenUsage.source === "provider_usage"
    ? "agent_local_import"
    : tokenUsage.source;
}

function ledgerUsageConfidence(
  tokenUsage: TokenUsageSummary,
  origin: string | undefined,
): string {
  return origin === "agent_local_import" && tokenUsage.source === "provider_usage"
    ? "client_declared"
    : tokenUsage.usageConfidence;
}

/**
 * 套餐通道按价格条目携带的 planCreditRules 折算本次请求积分；
 * 非套餐通道、无规则或官方未公开口径时返回空（账本列保持 NULL）。
 * 通道边界（2026-09-10 阶段 0）：money_to_credits 类公式的换算输入只允许官方基础牌价
 * （entry.pricing 原始快照），不得使用 PAYG 已生效费率（snapshot.baseRates 已叠加
 * 时段/促销/fast）——MiniMax 积分与按量促销彻底隔离。
 * origin（2026-09-15 双链路观测）：透传观测通道给活动匹配，origins 限定的 Campaign
 * 只在对应通道命中（如 zcode ×0.67 只在官方直连导入流量生效）。
 */
export function computePlanCreditForLedger(
  prepared: Pick<
    PreparedExchange,
    "pricingConfig" | "model" | "capturedAt" | "billingChannel" | "targetPlanTier" | "targetPlanCreditFormula"
  >,
  cost: TokenCost,
  usage: {inputTokens: number; cacheReadTokens: number; outputTokens: number; totalTokens: number},
  agentName?: string,
  origin?: string,
): Pick<UsageLedgerMetrics, "planCreditCost" | "planCreditUnit" | "planCreditFormulaVersion"> & {
  planCreditFormula?: string;
  planCreditFormulaDetail?: string;
  planProfileId?: string;
  matchedCampaignLabels?: string[];
  /** market_share 条目按目标档位解析出的估算分母（月度美元额度 × 请求时汇率）。 */
  marketShareQuotaTotal?: PlanQuotaTotal;
} {
  if (prepared.billingChannel !== "plan") return {};
  /* 预设声明「无公开逐请求积分公式」（2026-10-07 用户确认，火山 Coding Plan）：
     官方未公开该套餐的公式/系数/额度（AFP 抵扣规则页属 Agent Plan 计费说明），
     按无公式供应商处理——不落积分列，估算走市价参考 + 一期量纲守卫（percent 额度
     → market_blocked）+ 二期额度差分回填。条目仍带 AFP 公式（与 Agent Plan 共享
     vendor 行）但本预设不消费；Agent Plan/智谱/OpenCode Go 等精确公式链路零影响。 */
  if (prepared.targetPlanCreditFormula === "none") return {};
  const snapshot = cost.pricingSnapshot;
  if (!snapshot?.priceEntryId) return {};
  const entry = effectiveEntryAt(findPriceEntryById(prepared.pricingConfig, snapshot.priceEntryId), prepared.capturedAt);
  const rules = entry?.planCreditRules;
  if (!rules) return {};
  /* market_share（OpenCode Go）：无逐请求积分，行保持非积分形态（分子走市价回退）；
     只解析估算分母——条目 quotaTiers × 目标档位（pricing.planTier）。档位未选/额度
     缺失返回空 → 估算走 market_blocked（unavailable）诚实降级，绝不落
     plan_credit_unit（防误入积分 integral 路径）。 */
  if (rules.formula === "market_share") {
    return {
      marketShareQuotaTotal: resolveMarketShareQuotaTotal(
        rules,
        prepared.targetPlanTier,
        resolveFxRate(prepared.pricingConfig.fx, "USD", "CNY"),
      ),
    };
  }
  const baseRates = planCalculatorBaseRates(entry?.pricing, snapshot.baseRates);
  if (!baseRates) return {};
  const result = computePlanCredit({
    model: prepared.model ?? snapshot.matchedModel ?? entry.id,
    rules,
    rates: baseRates,
    usage,
    capturedAt: prepared.capturedAt,
    agentName,
    ...(origin !== undefined ? {origin} : {}),
  });
  return {
    planCreditCost: result.creditCost,
    planCreditUnit: result.unit,
    planCreditFormulaVersion: result.formulaVersion,
    ...(result.formula ? {planCreditFormula: result.formula} : {}),
    ...(result.formulaDetail ? {planCreditFormulaDetail: result.formulaDetail} : {}),
    // 9.1 排障定位字段：Profile 引用与命中活动展示名随快照落库（不回读当前目录）。
    ...(rules.profileId ? {planProfileId: rules.profileId} : {}),
    ...(result.matchedCampaignLabels?.length ? {matchedCampaignLabels: result.matchedCampaignLabels} : {}),
  };
}

function findPriceEntryById(
  pricingConfig: PricingConfigV2,
  priceEntryId: string,
): ReturnType<PricingConfigV2["models"]["find"]> {
  return normalizePricingConfig(pricingConfig).models.find(entry => entry.id === priceEntryId);
}

function writeUsageLedger(
  db: DeepaaDatabase,
  input: {
    exchange: RawCapturedExchange;
    path: ResolvedAgentPath;
    sessionId?: string;
    threadId?: string;
    turnId?: string;
    stepId?: string;
    model?: string;
    ledger: UsageLedgerMetrics;
    pricingRevisionId?: number;
    priceEffectiveAt?: string;
    catalogHash?: string;
  },
): void {
  db.prepare(
    `INSERT INTO usage_ledger(
      exchange_id, agent_session_id, agent_thread_id, agent_turn_id,
      agent_step_id, target_id, agent_fingerprint_id, agent_name, model,
      vendor, billing_channel, vendor_family, rate_multiplier,
      input_tokens, cache_read_tokens, cache_write_tokens, output_tokens,
      reasoning_tokens, total_tokens, currency, vendor_cost, actual_cost,
      vendor_cost_cny, actual_cost_cny, fx_rate_to_cny,
      duration_ms, usage_source, usage_confidence, pricing_snapshot_json,
      plan_credit_cost, plan_credit_unit, plan_credit_formula_version,
      request_kind, result_class, usage_quality, pricing_status,
      audit_eligible, audit_exclusion_reason, derived_total_tokens,
      provider_total_tokens, total_tokens_basis, reasoning_semantics,
      reference_price_entry_id, reference_cost_nano, reference_currency,
      reference_cost_status, cost_basis, vendor_cost_nano, actual_cost_nano,
      pricing_revision_id, price_effective_at, catalog_hash,
      latency_source, duration_sample_eligible, created_at, first_token_ms,
      service_tier, plan_estimated_cost, plan_estimated_currency,
      plan_estimated_fx, plan_estimated_cost_nano, plan_estimated_status,
      plan_estimate_detail_json, plan_estimated_method
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.exchange.exchangeId,
    input.sessionId ?? null,
    input.threadId ?? null,
    input.turnId ?? null,
    input.stepId ?? null,
    input.path.targetId,
    input.path.agentFingerprintId,
    input.path.agentName,
    input.model ?? "unknown",
    input.ledger.vendor,
    input.ledger.billingChannel ?? null,
    input.ledger.vendorFamily ?? null,
    input.ledger.rateMultiplier,
    input.ledger.inputTokens,
    input.ledger.cacheReadTokens,
    input.ledger.cacheWriteTokens,
    input.ledger.outputTokens,
    input.ledger.reasoningTokens,
    input.ledger.totalTokens,
    input.ledger.currency,
    input.ledger.vendorCost,
    input.ledger.actualCost,
    input.ledger.vendorCostCny ?? input.ledger.vendorCost,
    input.ledger.actualCostCny ?? input.ledger.actualCost,
    input.ledger.fxRateToCny ?? 1,
    safeDuration(input.exchange.durationMs),
    input.ledger.usageSource,
    input.ledger.usageConfidence,
    input.ledger.pricingSnapshotJson,
    input.ledger.planCreditCost ?? null,
    input.ledger.planCreditUnit ?? null,
    input.ledger.planCreditFormulaVersion ?? null,
    input.ledger.requestKind,
    input.ledger.resultClass,
    input.ledger.usageQuality,
    input.ledger.pricingStatus,
    input.ledger.auditEligible ? 1 : 0,
    input.ledger.auditExclusionReason ?? null,
    input.ledger.derivedTotalTokens ?? null,
    input.ledger.providerTotalTokens ?? null,
    input.ledger.totalTokensBasis,
    input.ledger.reasoningSemantics,
    input.ledger.referencePriceEntryId ?? null,
    input.ledger.referenceCostNano ?? null,
    input.ledger.referenceCurrency ?? null,
    input.ledger.referenceCostStatus,
    input.ledger.costBasis,
    input.ledger.vendorCostNano ?? null,
    input.ledger.actualCostNano ?? null,
    input.pricingRevisionId ?? null,
    input.priceEffectiveAt ?? null,
    input.catalogHash ?? null,
    "round_trip",
    input.ledger.durationSampleEligible ? 1 : 0,
    input.exchange.capturedAt,
    typeof input.exchange.firstTokenMs === "number" && Number.isFinite(input.exchange.firstTokenMs)
      ? Math.max(0, Math.round(input.exchange.firstTokenMs))
      : null,
    input.exchange.request.serviceTier ?? null,
    input.ledger.planEstimatedCost ?? null,
    input.ledger.planEstimatedCurrency ?? null,
    input.ledger.planEstimatedFx ?? null,
    input.ledger.planEstimatedCostNano ?? null,
    input.ledger.planEstimatedStatus ?? "none",
    input.ledger.planEstimateDetailJson ?? null,
    input.ledger.planEstimatedMethod ?? null,
  );
  if (input.ledger.cacheWrite5mTokens > 0 || input.ledger.cacheWrite1hTokens > 0) {
    db.prepare(
      `UPDATE usage_ledger
       SET cache_write_5m_tokens = ?, cache_write_1h_tokens = ?
       WHERE exchange_id = ?`,
    ).run(
      input.ledger.cacheWrite5mTokens,
      input.ledger.cacheWrite1hTokens,
      input.exchange.exchangeId,
    );
  }
  // 仅对已配置的按量中转站网关流量保存小型完成时间投影；不为其它供应商
  // 扩大账本写入量，也不扫描/回填已存在的历史大库。
  if (input.exchange.routing.origin !== "agent_local_import"
    && (!input.ledger.billingChannel || input.ledger.billingChannel === "pay_as_you_go")
    && db.prepare(
      `SELECT 1 FROM console_accounts WHERE target_id=?
       AND provider_type IN ('relay','sub2api','newapi') LIMIT 1`,
    ).get(input.path.targetId)) {
    // 请求 ID 头优先级（2026-09-26 源码核实）：new-api 用 x-oneapi-request-id；
    // sub2api 账单 request_id 与应用层必带的 x-client-request-id 同源（client:<UUID>），
    // x-request-id 常为代理链逗号拼接值、匹配价值最低，列末位兜底。
    const remoteRequestId = (
      input.exchange.response.headers["x-oneapi-request-id"]
      ?? input.exchange.response.headers["x-client-request-id"]
      ?? input.exchange.response.headers["x-request-id"]
    )?.trim();
    const providerRequestId = remoteRequestId && remoteRequestId.length <= 128
      && /^[A-Za-z0-9_.:-]+$/u.test(remoteRequestId) ? remoteRequestId : null;
    const upstreamPath = input.exchange.routing.upstreamPath;
    const endpoint = upstreamPath && upstreamPath.length <= 256 && upstreamPath.startsWith("/")
      ? upstreamPath.split("?", 1)[0] : null;
    db.prepare(
      `INSERT INTO relay_local_usage_events(
        exchange_id, target_id, completed_at, provider_request_id, endpoint
      ) VALUES(?, ?, ?, ?, ?) ON CONFLICT(exchange_id) DO NOTHING`,
    ).run(input.exchange.exchangeId, input.path.targetId,
      input.exchange.completedAt, providerRequestId, endpoint);
  }
  const bucketStart = new Date(Math.floor(Date.parse(input.exchange.capturedAt) / 3_600_000) * 3_600_000).toISOString();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO analytics_dirty_buckets(
      bucket_start_utc, reason, first_seen_at, last_seen_at, available_at
    ) VALUES(?, 'ledger_insert', ?, ?, ?)
    ON CONFLICT(bucket_start_utc) DO UPDATE SET
      last_seen_at = excluded.last_seen_at,
      reason = CASE WHEN analytics_dirty_buckets.reason = excluded.reason
        THEN analytics_dirty_buckets.reason
        ELSE analytics_dirty_buckets.reason || ',' || excluded.reason END,
      status = CASE WHEN analytics_dirty_buckets.status = 'completed' THEN 'pending'
        ELSE analytics_dirty_buckets.status END,
      available_at = MIN(analytics_dirty_buckets.available_at, excluded.available_at)`,
  ).run(bucketStart, now, now, now);
}

function writeContextArtifacts(
  db: DeepaaDatabase,
  input: {
    sourceId: number;
    path: ResolvedAgentPath;
    turnId: string;
    stepId: string;
    stepIndex: number;
    normalized: NormalizedExchange;
    exchange: RawCapturedExchange;
    dataDir?: string;
    artifactInlineMaxBytes?: number;
  },
): boolean {
  const previousRow = db.prepare(
    `SELECT context_snapshots.summary_json,
       context_snapshots.artifact_storage, context_snapshots.artifact_hash
     FROM agent_steps
     JOIN context_snapshots ON context_snapshots.agent_step_id = agent_steps.id
     WHERE agent_steps.agent_thread_id = ?
       AND agent_steps.agent_turn_id = ?
       AND agent_steps.step_index < ?
     ORDER BY agent_steps.step_index DESC, agent_steps.id DESC
     LIMIT 1`,
  ).get(
    input.path.agentThreadId,
    input.turnId,
    input.stepIndex,
  ) as {summary_json: string; artifact_storage: string | null; artifact_hash: string | null} | undefined;
  const previousJson = previousRow
    ? resolveDerivedArtifactJson(input.dataDir, {
      artifact_storage: previousRow.artifact_storage,
      artifact_hash: previousRow.artifact_hash,
      inline_json: previousRow.summary_json,
    })
    : undefined;
  const previous = previousJson ? snapshotFromStoredJson(previousJson) : undefined;
  const current = projectCurrentContextSnapshot(
    input.normalized,
    input.stepId,
    input.exchange.request.bodySizeBytes + input.exchange.response.bodySizeBytes,
  );
  const snapshotArtifact = encodeContextSnapshot(current);
  const diff = diffContextSnapshots(previous?.snapshot, current.value);
  const projectedDiff = projectStepDiff(diff, previous?.completeness, current.completeness);
  const diffArtifact = encodeProjectedArtifact(
    projectedDiff,
    CONTEXT_ARTIFACT_MAX_BYTES,
    "step_diff",
    {
      sourceCompleteness: {
        previous: previous?.completeness,
        current: current.completeness,
      },
    },
  );

  // 派生物外置（决策 D2）：>16 KiB 的摘要写内容寻址 gz 文件，SQLite 行只存
  // hash+size；diff 基线与读取端永久兼容 inline/external 双策略。
  const dataDir = input.dataDir;
  if (!dataDir) {
    throw new Error("派生上下文 artifact 写入缺少 dataDir。");
  }
  const snapshotPlacement = placeDerivedArtifact(
    dataDir,
    snapshotArtifact.json,
    input.artifactInlineMaxBytes,
  );
  const diffPlacement = placeDerivedArtifact(
    dataDir,
    diffArtifact.json,
    input.artifactInlineMaxBytes,
  );
  db.prepare(
    `INSERT INTO context_snapshots(
       agent_step_id, summary_json, size_bytes,
       artifact_storage, artifact_hash, artifact_size
     ) VALUES(?, ?, ?, ?, ?, ?)`,
  ).run(
    input.stepId,
    snapshotPlacement.storage === "inline"
      ? snapshotArtifact.json
      : externalDerivedArtifactPlaceholder(snapshotPlacement),
    snapshotArtifact.sizeBytes,
    snapshotPlacement.storage,
    snapshotPlacement.hash,
    snapshotPlacement.sizeBytes,
  );
  db.prepare(
    `INSERT INTO step_diffs(
       agent_step_id, diff_json, size_bytes,
       artifact_storage, artifact_hash, artifact_size
     ) VALUES(?, ?, ?, ?, ?, ?)`,
  ).run(
    input.stepId,
    diffPlacement.storage === "inline"
      ? diffArtifact.json
      : externalDerivedArtifactPlaceholder(diffPlacement),
    diffArtifact.sizeBytes,
    diffPlacement.storage,
    diffPlacement.hash,
    diffPlacement.sizeBytes,
  );
  // failover 元数据与派生物正文解耦（v30 agent_steps.failover_json）：外置行的
  // summary_json 是占位符，SQL json_extract 读不到，写入端同步落独立小列。
  const failoverJson = extractFailoverFromArtifactJson(snapshotArtifact.json);
  if (failoverJson) {
    db.prepare(
      `UPDATE agent_steps SET failover_json = ? WHERE id = ?`,
    ).run(failoverJson, input.stepId);
  }

  if (snapshotArtifact.limited) {
    writeArtifactLimitedDiagnostic(db, {
      exchangeId: input.exchange.exchangeId,
      sourceId: input.sourceId,
      code: "context_snapshot_limited",
      message: "Context snapshot 超过字节或字段投影预算，已写入受限摘要。",
      originalEstimatedBytes: snapshotArtifact.originalEstimatedBytes,
      completeness: snapshotArtifact.completeness,
      storedBytes: snapshotArtifact.sizeBytes,
      limitBytes: CONTEXT_ARTIFACT_MAX_BYTES,
      timestamp: input.exchange.capturedAt,
    });
  }
  if (diffArtifact.limited) {
    writeArtifactLimitedDiagnostic(db, {
      exchangeId: input.exchange.exchangeId,
      sourceId: input.sourceId,
      code: "step_diff_limited",
      message: "Step diff 超过字节或字段投影预算，已写入受限摘要。",
      originalEstimatedBytes: diffArtifact.originalEstimatedBytes,
      completeness: diffArtifact.completeness,
      storedBytes: diffArtifact.sizeBytes,
      limitBytes: CONTEXT_ARTIFACT_MAX_BYTES,
      timestamp: input.exchange.capturedAt,
    });
  }
  // 压缩标记语义（P1 校准）：真实裁剪（消息/工具结果移除）或压缩证据
  // （dsh purpose 头 / 续接摘要注入）才置 context_compressed；
  // remote_state_reference 是 previous_response_id/conversation 的正常续写，不算压缩。
  const hasCompressionEvidence = diff.contextTrimming.some(item =>
    item.kind === "message_removed"
    || item.kind === "tool_result_removed"
    || item.kind === "compaction_summary_injected"
    || item.kind === "compaction_purpose_header"
  );
  return hasCompressionEvidence;
}

function projectCurrentContextSnapshot(
  normalized: NormalizedExchange,
  stepId: string,
  originalEstimatedBytes: number,
): ProjectedArtifact<ObservedContextSnapshot> {
  const tracker = createProjectionTracker();
  const harnessPayload = projectHarnessPayload(normalized.harnessPayload, tracker);
  const remoteStateReferences = projectRemoteStateReferences(normalized, tracker);
  const snapshot = projectedContextSnapshot({
    id: `ctx-${stableHash({
      stepId: projectArtifactText(stepId, ARTIFACT_ID_MAX_BYTES, tracker),
      exchangeId: projectArtifactText(
        normalized.exchangeId,
        ARTIFACT_ID_MAX_BYTES,
        tracker,
      ),
      normalizerVersion: 1,
    })}`,
    stepId,
    exchangeId: normalized.exchangeId,
    protocol: normalized.protocol,
    model: normalized.request.model,
    inputTokenActual: normalized.response.usage?.inputTokens,
    outputTokenActual: normalized.response.usage?.outputTokens,
    totalTokenActual: normalized.response.usage?.totalTokens,
    messageCount: normalized.request.messages.length || undefined,
    inputItemCount: normalized.request.inputItems.length || undefined,
    toolSchemaCount: normalized.request.toolSchemas.length,
    totalStableHash: normalized.harnessPayload.stableHash,
    harnessPayload,
    contextComposition: contextCompositionFor(normalized, normalized.harnessEvidence),
    paramsDetail: projectParamDetails(normalized.harnessPayload.params),
    compaction: normalized.compaction,
    failover: normalized.failover,
    remoteStateReferences,
    evidence: projectEvidenceItems(normalized.harnessPayload.evidence, tracker),
  }, tracker);
  return {
    value: snapshot,
    completeness: completenessFromTracker(tracker, originalEstimatedBytes, true),
  };
}

function projectStoredContextSnapshot(
  snapshot: ObservedContextSnapshot,
  storedCompleteness: ArtifactCompleteness,
): StoredContextSnapshot {
  const tracker = createProjectionTracker();
  const harnessPayload = projectHarnessPayload(snapshot.harnessPayload, tracker);
  const projected = projectedContextSnapshot({
    id: snapshot.id,
    stepId: snapshot.stepId,
    exchangeId: snapshot.exchangeId,
    protocol: snapshot.protocol,
    model: snapshot.model,
    inputTokenEstimate: snapshot.inputTokenEstimate,
    inputTokenActual: snapshot.inputTokenActual,
    outputTokenActual: snapshot.outputTokenActual,
    totalTokenActual: snapshot.totalTokenActual,
    messageCount: snapshot.messageCount,
    inputItemCount: snapshot.inputItemCount,
    toolSchemaCount: snapshot.toolSchemaCount,
    totalStableHash: snapshot.totalStableHash,
    harnessPayload,
    remoteStateReferences: takeProjected(
      snapshot.remoteStateReferences,
      CONTEXT_REMOTE_STATE_LIMIT,
      tracker,
      item => projectRemoteStateReference(item, tracker),
    ),
    evidence: projectEvidenceItems(snapshot.evidence, tracker),
  }, tracker);
  return {
    snapshot: projected,
    completeness: completenessFromTracker(
      tracker,
      storedCompleteness.originalEstimatedBytes,
      storedCompleteness.complete,
      storedCompleteness,
    ),
  };
}

function projectedContextSnapshot(input: Omit<
  ObservedContextSnapshot,
  "systemPromptHashes" | "developerPromptHashes" | "conversationItemHashes"
  | "toolSchemaHashes" | "paramsHash"
>, tracker: ProjectionTracker): ObservedContextSnapshot {
  return {
    ...input,
    id: projectArtifactText(input.id, ARTIFACT_ID_MAX_BYTES, tracker),
    stepId: projectArtifactText(input.stepId, ARTIFACT_ID_MAX_BYTES, tracker),
    exchangeId: projectArtifactText(input.exchangeId, ARTIFACT_ID_MAX_BYTES, tracker),
    model: input.model
      ? projectArtifactText(input.model, ARTIFACT_ID_MAX_BYTES, tracker)
      : undefined,
    systemPromptHashes: boundedFieldValues(
      input.harnessPayload.systemPrompts,
      "textHash",
      tracker,
    ),
    developerPromptHashes: boundedFieldValues(
      input.harnessPayload.developerPrompts,
      "textHash",
      tracker,
    ),
    conversationItemHashes: boundedFieldValues(
      input.harnessPayload.conversationItems,
      "stableHash",
      tracker,
    ),
    toolSchemaHashes: boundedFieldValues(
      input.harnessPayload.toolSchemas,
      "stableHash",
      tracker,
    ),
    paramsHash: resolveParamsFingerprint(
      input.harnessPayload.params,
      input.harnessPayload.paramsFingerprint,
    ).stableHash,
    totalStableHash: projectArtifactText(
      input.totalStableHash,
      ARTIFACT_ID_MAX_BYTES,
      tracker,
    ),
  };
}

function projectHarnessPayload(
  payload: NormalizedHarnessPayload,
  tracker: ProjectionTracker,
): NormalizedHarnessPayload {
  const paramsFingerprint = resolveParamsFingerprint(
    payload.params,
    payload.paramsFingerprint,
  );
  mergeParamsFingerprintIntoTracker(tracker, paramsFingerprint);
  return {
    intent: {
      type: payload.intent.type,
      confidence: payload.intent.confidence,
      evidence: projectEvidenceItems(payload.intent.evidence, tracker),
    },
    systemPrompts: takeProjected(payload.systemPrompts, CONTEXT_PROMPT_LIMIT, tracker, item => ({
      textHash: projectArtifactText(item.textHash, ARTIFACT_ID_MAX_BYTES, tracker),
      textPreview: item.textPreview
        ? projectArtifactText(item.textPreview, SYSTEM_PROMPT_PREVIEW_MAX_BYTES, tracker)
        : undefined,
      providerRole: item.providerRole
        ? projectArtifactText(item.providerRole, ARTIFACT_ID_MAX_BYTES, tracker)
        : undefined,
      evidence: projectEvidenceItems(item.evidence, tracker),
    })),
    developerPrompts: takeProjected(
      payload.developerPrompts,
      CONTEXT_PROMPT_LIMIT,
      tracker,
      item => ({
        textHash: projectArtifactText(item.textHash, ARTIFACT_ID_MAX_BYTES, tracker),
        textPreview: item.textPreview
          ? projectArtifactText(item.textPreview, SYSTEM_PROMPT_PREVIEW_MAX_BYTES, tracker)
          : undefined,
        providerRole: item.providerRole
          ? projectArtifactText(item.providerRole, ARTIFACT_ID_MAX_BYTES, tracker)
          : undefined,
        evidence: projectEvidenceItems(item.evidence, tracker),
      }),
    ),
    conversationItems: takeProjected(
      payload.conversationItems,
      CONTEXT_CONVERSATION_LIMIT,
      tracker,
      item => ({
        kind: projectArtifactText(item.kind, ARTIFACT_ID_MAX_BYTES, tracker),
        semanticCategory: item.semanticCategory,
        provenance: item.provenance,
        confidence: item.confidence,
        displayPolicy: item.displayPolicy,
        dedupePolicy: item.dedupePolicy,
        logicalId: projectArtifactText(
          item.logicalId,
          ARTIFACT_ID_MAX_BYTES,
          tracker,
        ),
        providerItemType: projectArtifactText(
          item.providerItemType,
          ARTIFACT_ID_MAX_BYTES,
          tracker,
        ),
        providerLineageKey: item.providerLineageKey
          ? projectArtifactText(
            item.providerLineageKey,
            ARTIFACT_ID_MAX_BYTES,
            tracker,
          )
          : undefined,
        role: item.role
          ? projectArtifactText(item.role, ARTIFACT_ID_MAX_BYTES, tracker)
          : undefined,
        toolUseId: item.toolUseId
          ? projectArtifactText(item.toolUseId, ARTIFACT_ID_MAX_BYTES, tracker)
          : undefined,
        toolName: item.toolName
          ? projectArtifactText(item.toolName, ARTIFACT_TEXT_MAX_BYTES, tracker)
          : undefined,
        summary: projectArtifactText(
          `${item.kind}${item.role ? `:${item.role}` : ""}:${item.stableHash}`,
          ARTIFACT_TEXT_MAX_BYTES,
          tracker,
        ),
        stableHash: projectArtifactText(item.stableHash, ARTIFACT_ID_MAX_BYTES, tracker),
        evidence: projectEvidenceItems(item.evidence, tracker),
      }),
    ),
    toolSchemas: takeProjected(
      payload.toolSchemas,
      CONTEXT_TOOL_SCHEMA_LIMIT,
      tracker,
      item => ({
        name: projectArtifactText(item.name, ARTIFACT_TEXT_MAX_BYTES, tracker),
        kind: item.kind,
        mcpServer: item.mcpServer
          ? projectArtifactText(item.mcpServer, ARTIFACT_TEXT_MAX_BYTES, tracker)
          : undefined,
        descriptionHash: item.descriptionHash
          ? projectArtifactText(item.descriptionHash, ARTIFACT_ID_MAX_BYTES, tracker)
          : undefined,
        inputSchemaHash: item.inputSchemaHash
          ? projectArtifactText(item.inputSchemaHash, ARTIFACT_ID_MAX_BYTES, tracker)
          : undefined,
        providerType: item.providerType
          ? projectArtifactText(item.providerType, ARTIFACT_ID_MAX_BYTES, tracker)
          : undefined,
        schemaChars: item.schemaChars,
        schemaTokensEst: item.schemaTokensEst,
        stableHash: projectArtifactText(item.stableHash, ARTIFACT_ID_MAX_BYTES, tracker),
        evidence: projectEvidenceItems(item.evidence, tracker),
      }),
    ),
    requestedToolUses: takeProjected(
      payload.requestedToolUses,
      CONTEXT_TOOL_EVENT_LIMIT,
      tracker,
      item => ({
        id: projectArtifactText(item.id, ARTIFACT_ID_MAX_BYTES, tracker),
        name: projectArtifactText(item.name, ARTIFACT_TEXT_MAX_BYTES, tracker),
        providerType: item.providerType
          ? projectArtifactText(item.providerType, ARTIFACT_ID_MAX_BYTES, tracker)
          : undefined,
        evidence: projectEvidenceItems(item.evidence, tracker),
      }),
    ),
    providedToolResults: takeProjected(
      payload.providedToolResults,
      CONTEXT_TOOL_EVENT_LIMIT,
      tracker,
      item => ({
        toolUseId: projectArtifactText(item.toolUseId, ARTIFACT_ID_MAX_BYTES, tracker),
        isError: item.isError,
        providerType: item.providerType
          ? projectArtifactText(item.providerType, ARTIFACT_ID_MAX_BYTES, tracker)
          : undefined,
        evidence: projectEvidenceItems(item.evidence, tracker),
      }),
    ),
    reasoningItems: takeProjected(
      payload.reasoningItems,
      CONTEXT_REASONING_LIMIT,
      tracker,
      item => ({
        type: projectArtifactText(item.type, ARTIFACT_ID_MAX_BYTES, tracker),
        providerType: item.providerType
          ? projectArtifactText(item.providerType, ARTIFACT_ID_MAX_BYTES, tracker)
          : undefined,
        toolUseId: item.toolUseId
          ? projectArtifactText(item.toolUseId, ARTIFACT_ID_MAX_BYTES, tracker)
          : undefined,
        toolName: item.toolName
          ? projectArtifactText(item.toolName, ARTIFACT_TEXT_MAX_BYTES, tracker)
          : undefined,
        evidence: projectEvidenceItems(item.evidence, tracker),
      }),
    ),
    params: projectArtifactParams(payload.params, paramsFingerprint.stableHash, tracker),
    paramsFingerprint: {
      ...paramsFingerprint,
      stableHash: projectArtifactText(
        paramsFingerprint.stableHash,
        ARTIFACT_ID_MAX_BYTES,
        tracker,
      ),
    },
    stableHash: projectArtifactText(payload.stableHash, ARTIFACT_ID_MAX_BYTES, tracker),
    evidence: projectEvidenceItems(payload.evidence, tracker),
  };
}

function projectRemoteStateReferences(
  normalized: NormalizedExchange,
  tracker: ProjectionTracker,
): RemoteStateReference[] {
  const hints = normalized.request.sessionHints;
  const inspected = Math.min(hints.length, CONTEXT_REMOTE_STATE_LIMIT);
  tracker.candidateItemCount += hints.length;
  tracker.processedItemCount += inspected;
  if (hints.length > inspected) tracker.limited = true;
  const projected: RemoteStateReference[] = [];
  for (let index = 0; index < inspected; index += 1) {
    const hint = hints[index]!;
    if (hint.kind !== "previous-response-id" && hint.kind !== "conversation-field") continue;
    projected.push({
      kind: hint.kind === "previous-response-id" ? "previous_response_id" : "conversation",
      value: projectArtifactText(hint.value, ARTIFACT_TEXT_MAX_BYTES, tracker),
      observability: "remote_context_not_fully_observable",
      evidence: projectEvidenceItems(hint.evidence, tracker),
    });
  }
  return projected;
}

function projectRemoteStateReference(
  item: RemoteStateReference,
  tracker: ProjectionTracker,
): RemoteStateReference {
  return {
    kind: item.kind,
    value: projectArtifactText(item.value, ARTIFACT_TEXT_MAX_BYTES, tracker),
    observability: item.observability,
    evidence: projectEvidenceItems(item.evidence, tracker),
  };
}

function projectArtifactParams(
  params: Record<string, unknown>,
  paramsStableHash: string,
  tracker: ProjectionTracker,
): Record<string, unknown> {
  const keys: string[] = [];
  for (const key in params) {
    if (!Object.prototype.hasOwnProperty.call(params, key)) continue;
    tracker.candidateItemCount += 1;
    if (keys.length >= ARTIFACT_PARAM_ITEM_LIMIT) {
      tracker.limited = true;
      break;
    }
    tracker.processedItemCount += 1;
    keys.push(projectArtifactText(key, ARTIFACT_ID_MAX_BYTES, tracker));
  }
  keys.sort();
  return {
    keys,
    stableHash: projectArtifactText(paramsStableHash, ARTIFACT_ID_MAX_BYTES, tracker),
    redacted: true,
  };
}

function projectEvidenceItems(
  evidence: readonly EvidencePointer[],
  tracker: ProjectionTracker,
): EvidencePointer[] {
  return takeProjected(evidence, ARTIFACT_EVIDENCE_LIMIT, tracker, item => ({
    exchangeId: projectArtifactText(item.exchangeId, ARTIFACT_ID_MAX_BYTES, tracker),
    side: item.side,
    path: projectArtifactText(item.path, ARTIFACT_TEXT_MAX_BYTES, tracker),
    note: item.note
      ? projectArtifactText(item.note, ARTIFACT_TEXT_MAX_BYTES, tracker)
      : undefined,
  }));
}

function takeProjected<T, U>(
  items: readonly T[],
  limit: number,
  tracker: ProjectionTracker,
  project: (item: T) => U,
): U[] {
  const processed = Math.min(items.length, limit);
  tracker.candidateItemCount += items.length;
  tracker.processedItemCount += processed;
  if (items.length > processed) {
    tracker.limited = true;
    tracker.itemsDropped = true;
  }
  const result: U[] = [];
  for (let index = 0; index < processed; index += 1) {
    result.push(project(items[index]!));
  }
  return result;
}

function boundedFieldValues<T extends Record<K, string>, K extends keyof T>(
  items: readonly T[],
  key: K,
  tracker: ProjectionTracker,
): string[] {
  const values: string[] = [];
  for (let index = 0; index < items.length; index += 1) {
    values.push(projectArtifactText(items[index]![key], ARTIFACT_ID_MAX_BYTES, tracker));
  }
  return values;
}

function createProjectionTracker(): ProjectionTracker {
  return {
    candidateItemCount: 0,
    processedItemCount: 0,
    candidateTextBytes: 0,
    processedTextBytes: 0,
    limited: false,
    itemsDropped: false,
    paramsLimited: false,
  };
}

function mergeParamsFingerprintIntoTracker(
  tracker: ProjectionTracker,
  fingerprint: ParamsFingerprint,
): void {
  tracker.candidateItemCount += fingerprint.candidateItemCount;
  tracker.processedItemCount += fingerprint.processedItemCount;
  tracker.candidateTextBytes += fingerprint.candidateTextBytes;
  tracker.processedTextBytes += fingerprint.processedTextBytes;
  if (!fingerprint.complete
    || fingerprint.candidateItemCount > fingerprint.processedItemCount
    || fingerprint.candidateTextBytes > fingerprint.processedTextBytes) {
    tracker.limited = true;
    // 参数指纹遍历被截断属于结构性受限（影响 diff 判定的可靠性），计入不完整。
    tracker.paramsLimited = true;
  }
}

function completenessFromTracker(
  tracker: ProjectionTracker,
  originalEstimatedBytes: number,
  inheritedComplete: boolean,
  inherited: Partial<ArtifactCompleteness> = {},
): ArtifactCompleteness {
  const inheritedProcessedTextBytes = inherited.processedTextBytes;
  return {
    complete: inheritedComplete && !tracker.limited,
    // 真丢弃信号（条目被条数上限丢弃）：UI 据此把常亮告警降级为「仅真截断才告警」。
    itemsDropped: tracker.itemsDropped,
    originalEstimatedBytes: Math.max(
      originalEstimatedBytes,
      inherited.originalEstimatedBytes ?? 0,
      tracker.candidateTextBytes,
    ),
    candidateItemCount: Math.max(
      tracker.candidateItemCount,
      inherited.candidateItemCount ?? 0,
    ),
    processedItemCount: tracker.processedItemCount,
    candidateTextBytes: Math.max(
      tracker.candidateTextBytes,
      inherited.candidateTextBytes ?? 0,
    ),
    processedTextBytes: inheritedProcessedTextBytes === undefined
      ? tracker.processedTextBytes
      : Math.min(tracker.processedTextBytes, inheritedProcessedTextBytes),
  };
}

function projectArtifactText(
  value: string,
  maxBytes: number,
  tracker: ProjectionTracker,
  candidateBytes = Buffer.byteLength(value),
): string {
  const projected = boundedText(value, maxBytes);
  const processedBytes = Buffer.byteLength(projected);
  tracker.candidateTextBytes += Math.max(candidateBytes, processedBytes);
  tracker.processedTextBytes += processedBytes;
  if (candidateBytes > processedBytes) tracker.limited = true;
  return projected;
}

function encodeContextSnapshot(
  projected: ProjectedArtifact<ObservedContextSnapshot>,
): EncodedArtifact {
  let snapshot = projected.value;
  let completeness = projected.completeness;
  let json = JSON.stringify(contextEnvelope(snapshot, completeness));
  if (Buffer.byteLength(json) > CONTEXT_ARTIFACT_MAX_BYTES) {
    snapshot = minimalContextSnapshot(snapshot);
    completeness = {
      ...completeness,
      complete: false,
      processedItemCount: 0,
      processedTextBytes: 0,
    };
    json = JSON.stringify(contextEnvelope(snapshot, completeness));
  }
  if (Buffer.byteLength(json) > CONTEXT_ARTIFACT_MAX_BYTES) {
    json = JSON.stringify({
      truncated: true,
      originalEstimatedBytes: completeness.originalEstimatedBytes,
      kind: "context_snapshot",
      stepId: boundedText(snapshot.stepId, ARTIFACT_ID_MAX_BYTES),
      exchangeId: boundedText(snapshot.exchangeId, ARTIFACT_ID_MAX_BYTES),
      totalStableHash: boundedText(snapshot.totalStableHash, ARTIFACT_ID_MAX_BYTES),
      completeness,
    });
  }
  return encodedArtifact(
    json,
    !completeness.complete,
    completeness.originalEstimatedBytes,
    completeness,
  );
}

/**
 * 紧凑存储：harnessPayload 以短键结构落库（读取侧展开），并去掉可由
 * conversationItems 推导的 conversationItemHashes（瘦身 2026-09-11）。
 */
function contextEnvelope(
  snapshot: ObservedContextSnapshot,
  completeness: ArtifactCompleteness,
): Record<string, unknown> {
  const {harnessPayload, conversationItemHashes: _hashes, ...rest} = snapshot;
  const compactPayload = compactHarnessPayload(harnessPayload, boundedText);
  return {
    truncated: !completeness.complete,
    originalEstimatedBytes: completeness.originalEstimatedBytes,
    completeness,
    counts: {
      systemPrompts: snapshot.systemPromptHashes.length,
      developerPrompts: snapshot.developerPromptHashes.length,
      conversationItems: snapshot.conversationItemHashes.length,
      toolSchemas: snapshot.toolSchemaHashes.length,
    },
    snapshot: {
      ...rest,
      [COMPACT_HARNESS_PAYLOAD_KEY]: compactPayload,
    },
  };
}

function snapshotItemCount(snapshot: ObservedContextSnapshot): number {
  return snapshot.systemPromptHashes.length
    + snapshot.developerPromptHashes.length
    + snapshot.conversationItemHashes.length
    + snapshot.toolSchemaHashes.length
    + snapshot.harnessPayload.systemPrompts.length
    + snapshot.harnessPayload.developerPrompts.length
    + snapshot.harnessPayload.conversationItems.length
    + snapshot.harnessPayload.toolSchemas.length
    + snapshot.harnessPayload.requestedToolUses.length
    + snapshot.harnessPayload.providedToolResults.length
    + snapshot.harnessPayload.reasoningItems.length
    + snapshot.harnessPayload.evidence.length
    + snapshot.remoteStateReferences.length
    + snapshot.evidence.length;
}

function minimalContextSnapshot(
  snapshot: ObservedContextSnapshot,
): ObservedContextSnapshot {
  return {
    id: boundedText(snapshot.id, 256),
    stepId: boundedText(snapshot.stepId, 256),
    exchangeId: boundedText(snapshot.exchangeId, 256),
    protocol: snapshot.protocol,
    model: snapshot.model ? boundedText(snapshot.model, 256) : undefined,
    systemPromptHashes: [],
    developerPromptHashes: [],
    conversationItemHashes: [],
    toolSchemaHashes: [],
    paramsHash: snapshot.paramsHash,
    inputTokenEstimate: snapshot.inputTokenEstimate,
    inputTokenActual: snapshot.inputTokenActual,
    outputTokenActual: snapshot.outputTokenActual,
    totalTokenActual: snapshot.totalTokenActual,
    messageCount: snapshot.messageCount,
    inputItemCount: snapshot.inputItemCount,
    toolSchemaCount: snapshot.toolSchemaCount,
    totalStableHash: snapshot.totalStableHash,
    harnessPayload: {
      intent: {
        type: snapshot.harnessPayload.intent.type,
        confidence: snapshot.harnessPayload.intent.confidence,
        evidence: [],
      },
      systemPrompts: [],
      developerPrompts: [],
      conversationItems: [],
      toolSchemas: [],
      requestedToolUses: [],
      providedToolResults: [],
      reasoningItems: [],
      params: {},
      paramsFingerprint: snapshot.harnessPayload.paramsFingerprint,
      stableHash: snapshot.harnessPayload.stableHash,
      evidence: [],
    },
    remoteStateReferences: [],
    evidence: [],
  };
}

function snapshotFromStoredJson(value: string): StoredContextSnapshot | undefined {
  try {
    const parsed = JSON.parse(value) as {
      truncated?: unknown;
      originalEstimatedBytes?: unknown;
      completeness?: Partial<ArtifactCompleteness>;
      snapshot?: unknown;
    };
    const snapshot = parsed.snapshot && typeof parsed.snapshot === "object"
      ? normalizeStoredContextSnapshot(parsed.snapshot as Record<string, unknown>) as unknown as ObservedContextSnapshot
      : undefined;
    const processedItemCount = snapshot ? snapshotItemCount(snapshot) : 0;
    const originalEstimatedBytes = typeof parsed.completeness?.originalEstimatedBytes === "number"
      ? parsed.completeness.originalEstimatedBytes
      : typeof parsed.originalEstimatedBytes === "number"
        ? parsed.originalEstimatedBytes
        : Buffer.byteLength(value);
    const candidateItemCount = typeof parsed.completeness?.candidateItemCount === "number"
      ? parsed.completeness.candidateItemCount
      : processedItemCount;
    const storedTextBytes = Buffer.byteLength(value);
    const completeness = {
      complete: typeof parsed.completeness?.complete === "boolean"
        ? parsed.completeness.complete
        : parsed.truncated !== true,
      originalEstimatedBytes,
      candidateItemCount,
      processedItemCount: typeof parsed.completeness?.processedItemCount === "number"
        ? parsed.completeness.processedItemCount
        : processedItemCount,
      candidateTextBytes: typeof parsed.completeness?.candidateTextBytes === "number"
        ? parsed.completeness.candidateTextBytes
        : storedTextBytes,
      processedTextBytes: typeof parsed.completeness?.processedTextBytes === "number"
        ? parsed.completeness.processedTextBytes
        : storedTextBytes,
    };
    return snapshot
      ? projectStoredContextSnapshot(snapshot, completeness)
      : { completeness };
  } catch {
    return undefined;
  }
}

interface EncodedArtifact {
  json: string;
  sizeBytes: number;
  limited: boolean;
  originalEstimatedBytes: number;
  completeness?: ArtifactCompleteness;
}

function projectStepDiff(
  diff: StepDiff,
  previous: ArtifactCompleteness | undefined,
  current: ArtifactCompleteness,
): ProjectedArtifact<Record<string, unknown>> {
  const tracker = createProjectionTracker();
  for (const source of [previous, current]) {
    if (!source) continue;
    tracker.candidateTextBytes += source.candidateTextBytes;
    tracker.processedTextBytes += source.processedTextBytes;
    if (!source.complete || source.candidateTextBytes > source.processedTextBytes) {
      tracker.limited = true;
    }
  }
  const evidenceItem = (item: {
    evidence: EvidencePointer[];
  }): EvidencePointer[] => projectEvidenceItems(item.evidence, tracker);
  const fieldDiff = (item: StepDiff["changedSystem"][number]): Record<string, unknown> => ({
    path: projectArtifactText(item.path, ARTIFACT_TEXT_MAX_BYTES, tracker),
    beforeHash: item.beforeHash
      ? projectArtifactText(item.beforeHash, ARTIFACT_ID_MAX_BYTES, tracker)
      : undefined,
    afterHash: item.afterHash
      ? projectArtifactText(item.afterHash, ARTIFACT_ID_MAX_BYTES, tracker)
      : undefined,
    summary: projectArtifactText(item.summary, ARTIFACT_TEXT_MAX_BYTES, tracker),
    evidence: evidenceItem(item),
  });
  const value = {
    id: projectArtifactText(diff.id, ARTIFACT_ID_MAX_BYTES, tracker),
    fromStepId: diff.fromStepId
      ? projectArtifactText(diff.fromStepId, ARTIFACT_ID_MAX_BYTES, tracker)
      : undefined,
    toStepId: projectArtifactText(diff.toStepId, ARTIFACT_ID_MAX_BYTES, tracker),
    fromSnapshotId: diff.fromSnapshotId
      ? projectArtifactText(diff.fromSnapshotId, ARTIFACT_ID_MAX_BYTES, tracker)
      : undefined,
    toSnapshotId: projectArtifactText(diff.toSnapshotId, ARTIFACT_ID_MAX_BYTES, tracker),
    addedMessages: takeProjected(diff.addedMessages, DIFF_ITEM_LIMIT, tracker, item => ({
      role: projectArtifactText(item.role, ARTIFACT_ID_MAX_BYTES, tracker),
      stableHash: projectArtifactText(item.stableHash, ARTIFACT_ID_MAX_BYTES, tracker),
      summary: projectArtifactText(item.summary, ARTIFACT_TEXT_MAX_BYTES, tracker),
    })),
    removedMessages: takeProjected(diff.removedMessages, DIFF_ITEM_LIMIT, tracker, item => ({
      role: projectArtifactText(item.role, ARTIFACT_ID_MAX_BYTES, tracker),
      stableHash: projectArtifactText(item.stableHash, ARTIFACT_ID_MAX_BYTES, tracker),
      summary: projectArtifactText(item.summary, ARTIFACT_TEXT_MAX_BYTES, tracker),
    })),
    addedToolResults: takeProjected(diff.addedToolResults, DIFF_ITEM_LIMIT, tracker, item => ({
      toolUseId: projectArtifactText(item.toolUseId, ARTIFACT_ID_MAX_BYTES, tracker),
      stableHash: projectArtifactText(item.stableHash, ARTIFACT_ID_MAX_BYTES, tracker),
      summary: projectArtifactText(item.summary, ARTIFACT_TEXT_MAX_BYTES, tracker),
    })),
    removedToolResults: takeProjected(
      diff.removedToolResults,
      DIFF_ITEM_LIMIT,
      tracker,
      item => ({
        toolUseId: projectArtifactText(item.toolUseId, ARTIFACT_ID_MAX_BYTES, tracker),
        stableHash: projectArtifactText(item.stableHash, ARTIFACT_ID_MAX_BYTES, tracker),
        summary: projectArtifactText(item.summary, ARTIFACT_TEXT_MAX_BYTES, tracker),
      }),
    ),
    addedAssistantToolUses: takeProjected(
      diff.addedAssistantToolUses,
      DIFF_ITEM_LIMIT,
      tracker,
      item => ({
        id: projectArtifactText(item.id, ARTIFACT_ID_MAX_BYTES, tracker),
        name: projectArtifactText(item.name, ARTIFACT_TEXT_MAX_BYTES, tracker),
        stableHash: projectArtifactText(item.stableHash, ARTIFACT_ID_MAX_BYTES, tracker),
      }),
    ),
    removedAssistantToolUses: takeProjected(
      diff.removedAssistantToolUses,
      DIFF_ITEM_LIMIT,
      tracker,
      item => ({
        id: projectArtifactText(item.id, ARTIFACT_ID_MAX_BYTES, tracker),
        name: projectArtifactText(item.name, ARTIFACT_TEXT_MAX_BYTES, tracker),
        stableHash: projectArtifactText(item.stableHash, ARTIFACT_ID_MAX_BYTES, tracker),
      }),
    ),
    changedSystem: takeProjected(diff.changedSystem, DIFF_ITEM_LIMIT, tracker, fieldDiff),
    changedTools: {
      added: takeProjected(
        diff.changedTools.added,
        DIFF_ITEM_LIMIT,
        tracker,
        item => projectArtifactText(item, ARTIFACT_TEXT_MAX_BYTES, tracker),
      ),
      removed: takeProjected(
        diff.changedTools.removed,
        DIFF_ITEM_LIMIT,
        tracker,
        item => projectArtifactText(item, ARTIFACT_TEXT_MAX_BYTES, tracker),
      ),
      changed: takeProjected(
        diff.changedTools.changed,
        DIFF_ITEM_LIMIT,
        tracker,
        fieldDiff,
      ),
      beforeCount: diff.changedTools.beforeCount,
      afterCount: diff.changedTools.afterCount,
    },
    changedParams: takeProjected(diff.changedParams, DIFF_ITEM_LIMIT, tracker, fieldDiff),
    changedParamDetails: takeProjected(
      diff.changedParamDetails,
      PARAM_DETAIL_LIMIT,
      tracker,
      item => ({
        key: projectArtifactText(item.key, ARTIFACT_ID_MAX_BYTES, tracker),
        from: projectArtifactText(item.from, ARTIFACT_TEXT_MAX_BYTES, tracker),
        to: projectArtifactText(item.to, ARTIFACT_TEXT_MAX_BYTES, tracker),
      }),
    ),
    contextTrimming: takeProjected(diff.contextTrimming, DIFF_ITEM_LIMIT, tracker, item => ({
      kind: item.kind,
      stableHash: item.stableHash
        ? projectArtifactText(item.stableHash, ARTIFACT_ID_MAX_BYTES, tracker)
        : undefined,
      summary: projectArtifactText(item.summary, ARTIFACT_TEXT_MAX_BYTES, tracker),
      confidence: item.confidence,
      evidence: evidenceItem(item),
    })),
    tokenDelta: diff.tokenDelta,
    summary: takeProjected(
      diff.summary,
      DIFF_ITEM_LIMIT,
      tracker,
      item => projectArtifactText(item, ARTIFACT_TEXT_MAX_BYTES, tracker),
    ),
    evidence: projectEvidenceItems(diff.evidence, tracker),
  };
  const sourceCandidateCount = (previous?.candidateItemCount ?? 0)
    + current.candidateItemCount;
  const originalEstimatedBytes = Math.max(
    previous?.originalEstimatedBytes ?? 0,
    current.originalEstimatedBytes,
    1_024 + sourceCandidateCount * ARTIFACT_TEXT_MAX_BYTES,
  );
  return {
    value,
    completeness: completenessFromTracker(
      tracker,
      originalEstimatedBytes,
      (previous?.complete ?? true) && current.complete,
      { candidateItemCount: sourceCandidateCount },
    ),
  };
}

function encodeProjectedArtifact(
  projected: ProjectedArtifact<Record<string, unknown>>,
  limitBytes: number,
  kind: string,
  metadata: Record<string, unknown> = {},
): EncodedArtifact {
  let completeness = projected.completeness;
  let json = JSON.stringify({
    ...projected.value,
    truncated: !completeness.complete,
    originalEstimatedBytes: completeness.originalEstimatedBytes,
    completeness,
    kind,
    ...metadata,
  });
  if (Buffer.byteLength(json) > limitBytes) {
    completeness = {
      ...completeness,
      complete: false,
      processedItemCount: 0,
      processedTextBytes: 0,
    };
    json = JSON.stringify({
      truncated: true,
      originalEstimatedBytes: completeness.originalEstimatedBytes,
      completeness,
      kind,
      compactOmitted: true,
      ...metadata,
    });
  }
  if (Buffer.byteLength(json) > limitBytes) {
    json = JSON.stringify({
      truncated: true,
      originalEstimatedBytes: completeness.originalEstimatedBytes,
      completeness,
      kind,
      compactOmitted: true,
    });
  }
  return encodedArtifact(
    json,
    !completeness.complete,
    completeness.originalEstimatedBytes,
    completeness,
  );
}

function encodedArtifact(
  json: string,
  limited: boolean,
  originalEstimatedBytes: number,
  completeness?: ArtifactCompleteness,
): EncodedArtifact {
  return {
    json,
    sizeBytes: Buffer.byteLength(json),
    limited,
    originalEstimatedBytes,
    completeness,
  };
}

function writeLearningInsightForClosedTurn(
  db: DeepaaDatabase,
  input: {
    turnId: string;
    exchangeId: string;
    sourceId: number;
    timestamp: string;
  },
): void {
  const turn = db.prepare(
    `SELECT
       substr(agent_session_id, 1, ?) AS agent_session_id,
       length(CAST(agent_session_id AS BLOB)) AS agent_session_id_original_bytes,
       substr(agent_thread_id, 1, ?) AS agent_thread_id,
       length(CAST(agent_thread_id AS BLOB)) AS agent_thread_id_original_bytes,
       confidence,
       substr(start_time, 1, ?) AS start_time,
       length(CAST(start_time AS BLOB)) AS start_time_original_bytes,
       substr(end_time, 1, ?) AS end_time,
       length(CAST(end_time AS BLOB)) AS end_time_original_bytes
     FROM agent_turns WHERE id = ?`,
  ).get(
    LEARNING_SQL_ID_MAX_CHARS,
    LEARNING_SQL_ID_MAX_CHARS,
    LEARNING_SQL_TIMESTAMP_MAX_CHARS,
    LEARNING_SQL_TIMESTAMP_MAX_CHARS,
    input.turnId,
  ) as {
    agent_session_id: string;
    agent_session_id_original_bytes: number;
    agent_thread_id: string;
    agent_thread_id_original_bytes: number;
    confidence: ResolvedAgentPath["confidence"];
    start_time: string;
    start_time_original_bytes: number;
    end_time: string;
    end_time_original_bytes: number;
  } | undefined;
  if (!turn) return;
  const tracker = createProjectionTracker();
  const rows = db.prepare(
    `SELECT
       substr(id, 1, ?) AS id,
       length(CAST(id AS BLOB)) AS id_original_bytes,
       substr(exchange_id, 1, ?) AS exchange_id,
       length(CAST(exchange_id AS BLOB)) AS exchange_id_original_bytes,
       step_index,
       substr(timestamp, 1, ?) AS timestamp,
       length(CAST(timestamp AS BLOB)) AS timestamp_original_bytes,
       phase, request_action, response_action,
       substr(request_intent_label, 1, ?) AS request_intent_label,
       length(CAST(request_intent_label AS BLOB)) AS request_intent_label_original_bytes,
       substr(response_status_label, 1, ?) AS response_status_label,
       length(CAST(response_status_label AS BLOB)) AS response_status_label_original_bytes,
       tool_schema_count, context_compressed, input_tokens, cache_read_tokens,
       cache_write_tokens, output_tokens
     FROM agent_steps WHERE agent_turn_id = ?
     ORDER BY step_index, id LIMIT ?`,
  ).all(
    LEARNING_SQL_ID_MAX_CHARS,
    LEARNING_SQL_ID_MAX_CHARS,
    LEARNING_SQL_TIMESTAMP_MAX_CHARS,
    LEARNING_SQL_LABEL_MAX_CHARS,
    LEARNING_SQL_LABEL_MAX_CHARS,
    input.turnId,
    LEARNING_STEP_LIMIT + 1,
  ) as LearningStepRow[];
  const limitedByCount = rows.length > LEARNING_STEP_LIMIT;
  const selectedRows = rows.slice(0, LEARNING_STEP_LIMIT);
  const toolRows = db.prepare(
    `SELECT
       substr(agent_step_id, 1, ?) AS agent_step_id,
       length(CAST(agent_step_id AS BLOB)) AS agent_step_id_original_bytes,
       substr(tool_use_id, 1, ?) AS tool_use_id,
       length(CAST(tool_use_id AS BLOB)) AS tool_use_id_original_bytes,
       substr(tool_name, 1, ?) AS tool_name,
       length(CAST(tool_name AS BLOB)) AS tool_name_original_bytes
     FROM tool_calls WHERE agent_turn_id = ?
     ORDER BY tool_calls.tool_name LIMIT ?`,
  ).all(
    LEARNING_SQL_ID_MAX_CHARS,
    LEARNING_SQL_ID_MAX_CHARS,
    LEARNING_SQL_TOOL_NAME_MAX_CHARS,
    input.turnId,
    LEARNING_TOOL_LIMIT + 1,
  ) as Array<{
    agent_step_id: string;
    agent_step_id_original_bytes: number;
    tool_use_id: string | null;
    tool_use_id_original_bytes: number | null;
    tool_name: string;
    tool_name_original_bytes: number;
  }>;
  const limitedByTools = toolRows.length > LEARNING_TOOL_LIMIT;
  const tools = toolRows.slice(0, LEARNING_TOOL_LIMIT);
  const toolsByStep = new Map<string, typeof tools>();
  for (const tool of tools) {
    const current = toolsByStep.get(tool.agent_step_id);
    if (current) current.push(tool);
    else toolsByStep.set(tool.agent_step_id, [tool]);
  }
  const steps = selectedRows.map(row => learningStepFromRow(
    row,
    input.turnId,
    turn.agent_session_id,
    toolsByStep.get(row.id) ?? [],
    tracker,
  ));
  const agentTurn: AgentTurn = {
    id: projectArtifactText(input.turnId, ARTIFACT_ID_MAX_BYTES, tracker),
    agentSessionId: projectArtifactText(
      turn.agent_session_id,
      ARTIFACT_ID_MAX_BYTES,
      tracker,
      turn.agent_session_id_original_bytes,
    ),
    agentFingerprintId: "stored-lightweight",
    source: "agent-session",
    externalThreadId: projectArtifactText(
      turn.agent_thread_id,
      ARTIFACT_ID_MAX_BYTES,
      tracker,
      turn.agent_thread_id_original_bytes,
    ),
    exchangeIds: steps.map(step => step.exchangeId),
    auxiliaryExchangeIds: [],
    startTime: projectArtifactText(
      turn.start_time,
      ARTIFACT_TEXT_MAX_BYTES,
      tracker,
      turn.start_time_original_bytes,
    ),
    endTime: projectArtifactText(
      turn.end_time,
      ARTIFACT_TEXT_MAX_BYTES,
      tracker,
      turn.end_time_original_bytes,
    ),
    modelSet: [],
    targetSet: [],
    confidence: turn.confidence,
    evidence: [],
  };
  const insight = deriveHarnessLearningInsights({
    agentSessions: [],
    agentTurns: [agentTurn],
    steps,
    contextSnapshots: [],
    stepDiffs: [],
    auxiliaryExchanges: [],
  })[0];
  if (!insight) return;
  const projectedInsight = projectLearningInsight(
    insight,
    rows.length,
    selectedRows.length,
    toolRows.length,
    tools.length,
    limitedByCount || limitedByTools,
    tracker,
  );
  const artifact = encodeProjectedArtifact(
    projectedInsight,
    LEARNING_ARTIFACT_MAX_BYTES,
    "learning_insight",
    {
      processedStepCount: selectedRows.length,
      candidateStepCount: rows.length,
      limitedByCount,
      processedToolCallCount: tools.length,
      candidateToolCallCount: toolRows.length,
      limitedByTools,
    },
  );
  db.prepare(
    `INSERT INTO learning_insights(
      agent_turn_id, insight_json, size_bytes, updated_at
    ) VALUES(?, ?, ?, ?)
    ON CONFLICT(agent_turn_id) DO UPDATE SET
      insight_json = excluded.insight_json,
      size_bytes = excluded.size_bytes,
      updated_at = excluded.updated_at`,
  ).run(input.turnId, artifact.json, artifact.sizeBytes, input.timestamp);
  if (artifact.limited || limitedByCount || limitedByTools) {
    writeArtifactLimitedDiagnostic(db, {
      exchangeId: input.exchangeId,
      sourceId: input.sourceId,
      code: "learning_insight_limited",
      message: "Learning insight 超过字节、字段或行数预算，已写入受限摘要。",
      originalEstimatedBytes: artifact.originalEstimatedBytes,
      completeness: artifact.completeness,
      storedBytes: artifact.sizeBytes,
      limitBytes: LEARNING_ARTIFACT_MAX_BYTES,
      timestamp: input.timestamp,
    });
  }
}

function projectLearningInsight(
  insight: HarnessLearningInsight,
  candidateStepCount: number,
  processedStepCount: number,
  candidateToolCallCount: number,
  processedToolCallCount: number,
  sourceLimited: boolean,
  tracker: ProjectionTracker,
): ProjectedArtifact<Record<string, unknown>> {
  const observations = takeProjected(
    insight.observations,
    LEARNING_OBSERVATION_LIMIT,
    tracker,
    observation => ({
      kind: observation.kind,
      title: projectArtifactText(observation.title, ARTIFACT_TEXT_MAX_BYTES, tracker),
      detail: projectArtifactText(observation.detail, ARTIFACT_TEXT_MAX_BYTES, tracker),
      confidence: observation.confidence,
      evidence: projectEvidenceItems(observation.evidence, tracker),
    }),
  );
  const value = {
    turnId: projectArtifactText(insight.turnId, ARTIFACT_ID_MAX_BYTES, tracker),
    agentSessionId: projectArtifactText(
      insight.agentSessionId,
      ARTIFACT_ID_MAX_BYTES,
      tracker,
    ),
    summary: projectArtifactText(insight.summary, ARTIFACT_TEXT_MAX_BYTES, tracker),
    harnessPattern: insight.harnessPattern,
    confidence: insight.confidence,
    observations,
    copyableTemplate: projectArtifactText(
      insight.copyableTemplate,
      LEARNING_TEMPLATE_MAX_BYTES,
      tracker,
    ),
    evidence: projectEvidenceItems(insight.evidence, tracker),
  };
  const sourceCandidateCount = candidateStepCount + candidateToolCallCount;
  const sourceProcessedCount = processedStepCount + processedToolCallCount;
  tracker.candidateItemCount += sourceCandidateCount;
  tracker.processedItemCount += sourceProcessedCount;
  if (sourceLimited) tracker.limited = true;
  const originalEstimatedBytes = 1_024
    + candidateStepCount * ARTIFACT_TEXT_MAX_BYTES
    + candidateToolCallCount * ARTIFACT_TEXT_MAX_BYTES;
  return {
    value,
    completeness: completenessFromTracker(
      tracker,
      originalEstimatedBytes,
      !sourceLimited && originalEstimatedBytes <= LEARNING_ARTIFACT_MAX_BYTES,
    ),
  };
}

interface LearningStepRow {
  id: string;
  id_original_bytes: number;
  exchange_id: string;
  exchange_id_original_bytes: number;
  step_index: number;
  timestamp: string;
  timestamp_original_bytes: number;
  phase: AgentStep["phase"];
  request_action: AgentStep["requestAction"];
  response_action: AgentStep["responseAction"];
  request_intent_label: string | null;
  request_intent_label_original_bytes: number | null;
  response_status_label: string | null;
  response_status_label_original_bytes: number | null;
  tool_schema_count: number;
  context_compressed: number;
  input_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  output_tokens: number;
}

function learningStepFromRow(
  row: LearningStepRow,
  turnId: string,
  sessionId: string,
  tools: Array<{
    tool_use_id: string | null;
    tool_use_id_original_bytes: number | null;
    tool_name: string;
    tool_name_original_bytes: number;
  }>,
  tracker: ProjectionTracker,
): AgentStep {
  const toolUseNames: string[] = [];
  const toolUseIds: string[] = [];
  for (const tool of tools) {
    toolUseNames.push(projectArtifactText(
      tool.tool_name,
      LEARNING_TOOL_NAME_MAX_BYTES,
      tracker,
      tool.tool_name_original_bytes,
    ));
    if (tool.tool_use_id) {
      toolUseIds.push(projectArtifactText(
        tool.tool_use_id,
        ARTIFACT_ID_MAX_BYTES,
        tracker,
        tool.tool_use_id_original_bytes ?? Buffer.byteLength(tool.tool_use_id),
      ));
    }
  }
  return {
    id: projectArtifactText(
      row.id,
      ARTIFACT_ID_MAX_BYTES,
      tracker,
      row.id_original_bytes,
    ),
    turnId: projectArtifactText(turnId, ARTIFACT_ID_MAX_BYTES, tracker),
    agentSessionId: projectArtifactText(sessionId, ARTIFACT_ID_MAX_BYTES, tracker),
    exchangeId: projectArtifactText(
      row.exchange_id,
      ARTIFACT_ID_MAX_BYTES,
      tracker,
      row.exchange_id_original_bytes,
    ),
    index: row.step_index,
    timestamp: projectArtifactText(
      row.timestamp,
      ARTIFACT_TEXT_MAX_BYTES,
      tracker,
      row.timestamp_original_bytes,
    ),
    phase: row.phase,
    requestAction: row.request_action,
    responseAction: row.response_action,
    toolSchemaCount: row.tool_schema_count,
    toolUseNames,
    toolUseIds,
    toolResultIds: [],
    contextSnapshotId: projectArtifactText(
      `stored-${row.id}`,
      ARTIFACT_ID_MAX_BYTES,
      tracker,
    ),
    requestIntentLabel: row.request_intent_label
      ? projectArtifactText(
        row.request_intent_label,
        ARTIFACT_TEXT_MAX_BYTES,
        tracker,
        row.request_intent_label_original_bytes ?? Buffer.byteLength(row.request_intent_label),
      )
      : undefined,
    responseStatusLabel: row.response_status_label
      ? projectArtifactText(
        row.response_status_label,
        ARTIFACT_TEXT_MAX_BYTES,
        tracker,
        row.response_status_label_original_bytes ?? Buffer.byteLength(row.response_status_label),
      )
      : undefined,
    contextCompressed: row.context_compressed === 1,
    tokenUsage: {
      inputTokens: row.input_tokens,
      cacheReadTokens: row.cache_read_tokens,
      cacheCreationTokens: row.cache_write_tokens,
      outputTokens: row.output_tokens,
    },
  };
}

function writeArtifactLimitedDiagnostic(
  db: DeepaaDatabase,
  input: {
    exchangeId: string;
    sourceId: number;
    code: string;
    message: string;
    originalEstimatedBytes: number;
    completeness?: ArtifactCompleteness;
    storedBytes: number;
    limitBytes: number;
    timestamp: string;
  },
): void {
  const detailsJson = JSON.stringify({
    originalEstimatedBytes: input.originalEstimatedBytes,
    ...input.completeness,
    storedBytes: input.storedBytes,
    limitBytes: input.limitBytes,
  });
  db.prepare(
    `INSERT INTO derivation_diagnostics(
      exchange_id, source_id, code, severity, message, details_json, created_at
    ) SELECT ?, ?, ?, 'warning', ?, ?, ?
    WHERE NOT EXISTS(
      SELECT 1 FROM derivation_diagnostics
      WHERE exchange_id = ? AND source_id = ? AND code = ? AND details_json = ?
    )`,
  ).run(
    input.exchangeId,
    input.sourceId,
    input.code,
    input.message,
    detailsJson,
    input.timestamp,
    input.exchangeId,
    input.sourceId,
    input.code,
    detailsJson,
  );
}

function updateDirectCounters(
  db: DeepaaDatabase,
  input: {
    sessionId: string;
    threadId: string;
    turnId: string;
    model?: string;
    timestamp: string;
    becameActualThread: boolean;
    openedTurn: boolean;
  },
): void {
  db.prepare(
    `UPDATE agent_sessions
     SET request_count = request_count + 1,
       thread_count = thread_count + ?,
       end_time = MAX(end_time, ?)
     WHERE id = ?`,
  ).run(input.becameActualThread ? 1 : 0, input.timestamp, input.sessionId);
  db.prepare(
    `UPDATE agent_threads
     SET request_count = request_count + 1,
       turn_count = turn_count + ?,
       end_time = MAX(end_time, ?)
     WHERE id = ?`,
  ).run(input.openedTurn ? 1 : 0, input.timestamp, input.threadId);
  db.prepare(
    `UPDATE agent_turns
     SET step_count = step_count + 1,
       end_time = MAX(end_time, ?)
     WHERE id = ?`,
  ).run(input.timestamp, input.turnId);
  mergeTurnModel(db, input.turnId, input.model);
}

function mergeTurnModel(
  db: DeepaaDatabase,
  turnId: string,
  model: string | undefined,
): void {
  const normalized = model?.trim();
  if (!normalized) return;
  const raw = db.prepare(
    "SELECT model_set_json FROM agent_turns WHERE id = ?",
  ).pluck().get(turnId) as string;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = [];
  }
  const models = Array.isArray(parsed)
    ? parsed.filter((item): item is string => typeof item === "string")
    : [];
  db.prepare(
    "UPDATE agent_turns SET model_set_json = ? WHERE id = ?",
  ).run(JSON.stringify([...new Set([...models, normalized])].sort()), turnId);
}

function updateScopeAggregates(
  db: DeepaaDatabase,
  input: {
    sessionId: string;
    threadId: string;
    turnId: string;
    timestamp: string;
    inputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    outputTokens: number;
    vendorCost: number;
    actualCost: number;
    durationMs: number;
    toolCallCount: number;
  },
): void {
  const scopes: Array<[ScopeType, string]> = [
    ["session", input.sessionId],
    ["thread", input.threadId],
    ["turn", input.turnId],
  ];
  for (const [scopeType, scopeId] of scopes) {
    addScopeAggregate(db, {
      scopeType,
      scopeId,
      stepRequests: 1,
      auxiliaryRequests: 0,
      inputTokens: input.inputTokens,
      cacheReadTokens: input.cacheReadTokens,
      cacheWriteTokens: input.cacheWriteTokens,
      outputTokens: input.outputTokens,
      vendorCost: input.vendorCost,
      actualCost: input.actualCost,
      durationMs: input.durationMs,
      durationSamples: 1,
      toolCalls: input.toolCallCount,
      updatedAt: input.timestamp,
    });
  }
}

function addScopeAggregate(
  db: DeepaaDatabase,
  input: {
    scopeType: ScopeType;
    scopeId: string;
    stepRequests: number;
    auxiliaryRequests: number;
    inputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    outputTokens: number;
    vendorCost: number;
    actualCost: number;
    durationMs: number;
    durationSamples: number;
    toolCalls: number;
    updatedAt: string;
  },
): void {
  db.prepare(
    `INSERT INTO scope_aggregates(
      scope_type, scope_id, step_request_count, auxiliary_request_count,
      input_tokens, cache_read_tokens, cache_write_tokens, output_tokens,
      vendor_cost, actual_cost, duration_total_ms, duration_sample_count,
      tool_call_count, updated_at
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(scope_type, scope_id) DO UPDATE SET
      step_request_count = step_request_count + excluded.step_request_count,
      auxiliary_request_count = auxiliary_request_count + excluded.auxiliary_request_count,
      input_tokens = input_tokens + excluded.input_tokens,
      cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
      cache_write_tokens = cache_write_tokens + excluded.cache_write_tokens,
      output_tokens = output_tokens + excluded.output_tokens,
      vendor_cost = vendor_cost + excluded.vendor_cost,
      actual_cost = actual_cost + excluded.actual_cost,
      duration_total_ms = duration_total_ms + excluded.duration_total_ms,
      duration_sample_count = duration_sample_count + excluded.duration_sample_count,
      tool_call_count = tool_call_count + excluded.tool_call_count,
      updated_at = excluded.updated_at`,
  ).run(
    input.scopeType,
    input.scopeId,
    input.stepRequests,
    input.auxiliaryRequests,
    input.inputTokens,
    input.cacheReadTokens,
    input.cacheWriteTokens,
    input.outputTokens,
    input.vendorCost,
    input.actualCost,
    input.durationMs,
    input.durationSamples,
    input.toolCalls,
    input.updatedAt,
  );
}

function writeUnsupportedSchemaDiagnostic(
  db: DeepaaDatabase,
  input: ProcessExchangeInput,
  exchangeId: string,
): void {
  const schemaVersion = (input.exchange as { schemaVersion?: unknown }).schemaVersion;
  const detailsJson = JSON.stringify({
    schemaVersion: schemaVersion ?? null,
    sourceRelativePath: input.sourceRelativePath,
    byteOffset: input.byteOffset,
  });
  db.prepare(
    `INSERT INTO derivation_diagnostics(
      exchange_id, source_id, code, severity, message, details_json, created_at
    ) SELECT ?, ?, 'unsupported_raw_schema', 'warning', ?, ?, ?
    WHERE NOT EXISTS(
      SELECT 1 FROM derivation_diagnostics
      WHERE code = 'unsupported_raw_schema'
        AND exchange_id = ? AND source_id = ? AND details_json = ?
    )`,
  ).run(
    exchangeId,
    input.sourceId,
    `不支持 raw schemaVersion ${String(schemaVersion)}。`,
    detailsJson,
    safeTimestamp(input.exchange.capturedAt),
    exchangeId,
    input.sourceId,
    detailsJson,
  );
}

function assertProcessInput(
  db: DeepaaDatabase,
  input: ProcessExchangeInput,
  verifiedFileSize?: number,
): string {
  if (!Number.isSafeInteger(input.sourceId) || input.sourceId <= 0) {
    throw new Error("sourceId 必须是正安全整数。");
  }
  if (!Number.isSafeInteger(input.byteOffset) || input.byteOffset < 0) {
    throw new Error("byteOffset 必须是非负安全整数。");
  }
  if (!Number.isSafeInteger(input.lineLengthBytes) || input.lineLengthBytes <= 0) {
    throw new Error("lineLengthBytes 必须是正安全整数。");
  }
  const exchangeId = (input.exchange as { exchangeId?: unknown }).exchangeId;
  if (typeof exchangeId !== "string" || !exchangeId.trim()) {
    throw new Error("Exchange 缺少有效 exchangeId。");
  }
  assertSourceMatches(db, input, verifiedFileSize);
  return exchangeId;
}

function assertSourceMatches(
  db: DeepaaDatabase,
  input: ProcessExchangeInput,
  verifiedFileSize?: number,
): void {
  const source = db.prepare(
    "SELECT relative_path, file_size FROM ingestion_sources WHERE id = ?",
  ).get(input.sourceId) as {
    relative_path: string;
    file_size: number;
  } | undefined;
  if (!source || source.relative_path !== input.sourceRelativePath) {
    throw new Error(
      `sourceId ${input.sourceId} 与 sourceRelativePath ${input.sourceRelativePath} 不匹配。`,
    );
  }
  const rangeEnd = input.byteOffset + input.lineLengthBytes;
  const rangeLimit = verifiedFileSize ?? source.file_size;
  if (
    !Number.isSafeInteger(rangeLimit)
    || rangeLimit < source.file_size
    || !Number.isSafeInteger(rangeEnd)
    || rangeEnd > rangeLimit
  ) {
    throw new Error(
      `source 行范围 ${input.byteOffset}..${String(rangeEnd)} 超过文件大小 ${rangeLimit}。`,
    );
  }
}

function hasRawExchange(db: DeepaaDatabase, exchangeId: string): boolean {
  return db.prepare(
    "SELECT 1 FROM raw_exchange_refs WHERE exchange_id = ?",
  ).get(exchangeId) !== undefined;
}

function assertProcessCommit(
  input: ProcessExchangeInput,
  commit: ProcessExchangeCommit,
): void {
  const cursor = commit.cursor;
  const lineEnd = input.byteOffset + input.lineLengthBytes;
  if (!commit.leaseOwnerId.trim()) {
    throw new Error("leaseOwnerId 不能为空。");
  }
  if (
    !Number.isSafeInteger(cursor.generation)
    || cursor.generation < 0
    || !Number.isSafeInteger(cursor.expectedFileSize)
    || cursor.expectedFileSize < 0
    || !Number.isSafeInteger(cursor.nextFileSize)
    || cursor.nextFileSize < cursor.expectedFileSize
    || !Number.isSafeInteger(cursor.expectedScanOffset)
    || cursor.expectedScanOffset < input.byteOffset
    || !Number.isSafeInteger(cursor.nextScanOffset)
    || !Number.isSafeInteger(lineEnd)
    || cursor.nextFileSize < lineEnd
    || cursor.sourceId !== input.sourceId
    || cursor.relativePath !== input.sourceRelativePath
    || cursor.expectedByteOffset !== input.byteOffset
    || cursor.nextByteOffset !== lineEnd
    || cursor.nextScanOffset !== lineEnd
    || cursor.processedCount !== 1
  ) {
    throw new Error(`Exchange ${input.exchange.exchangeId} 的 source 提交边界不一致。`);
  }
}

function incrementDataVersion(db: DeepaaDatabase): void {
  const result = db.prepare(
    `UPDATE schema_meta
     SET data_version = data_version + 1,
       worker_status = 'running',
       worker_error = NULL
     WHERE id = 1`,
  ).run();
  if (result.changes !== 1) {
    throw new Error("无法递增 SQLite data_version。");
  }
}

function runTransaction<T>(db: DeepaaDatabase, body: () => T): T {
  return db.transaction(body)();
}

function normalizeHydrateBudget(value: number | undefined): number {
  const normalized = value ?? DEFAULT_HYDRATE_MAX_BYTES;
  if (!Number.isSafeInteger(normalized) || normalized < 0) {
    throw new Error("hydrateMaxBytes 必须是非负安全整数。");
  }
  if (normalized > DEFAULT_HYDRATE_MAX_BYTES) {
    throw new Error("hydrateMaxBytes 不能超过 8 MiB 硬上限。");
  }
  return normalized;
}

function safeDuration(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

function safeTokenCount(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.trunc(value))
    : 0;
}

function safeCost(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, value)
    : 0;
}

function safeTimestamp(value: unknown): string {
  return typeof value === "string" && value ? value : new Date(0).toISOString();
}

function boundedText(value: string, maxBytes: number): string {
  if (value.length <= maxBytes && Buffer.byteLength(value) <= maxBytes) return value;
  const suffix = maxBytes >= 3 ? "..." : "";
  const contentBudget = maxBytes - Buffer.byteLength(suffix);
  let low = 0;
  let high = Math.min(value.length, contentBudget);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, middle)) <= contentBudget) low = middle;
    else high = middle - 1;
  }
  if (low > 0) {
    const lastCodeUnit = value.charCodeAt(low - 1);
    if (lastCodeUnit >= 0xD800 && lastCodeUnit <= 0xDBFF) low -= 1;
  }
  return `${value.slice(0, low)}${suffix}`;
}

export type { ProcessExchangeInput, ProcessExchangeResult } from "../db/models";
