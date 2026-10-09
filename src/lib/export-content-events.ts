import type {DeepaaDatabase} from "@/lib/db/sqlite-driver";
import {
  conversationFingerprintKey,
  auxiliaryKindFromEndpoint,
  iterateConversationBodyEvents,
  previewConversationCategory,
  type AuxiliaryKind,
  type ConversationCategory,
  type ConversationBodyEvent,
  type ConversationSide,
  type ConversationStepDiff,
  type ExportFilters,
} from "./export-conversation";
import { categorySelectedForSide } from "./conversation-categories";
import {
  planExportContentPage,
  type ExportThreadBaselinePlan,
  type ExportThreadDedupeStatus,
} from "./export-page-plan";
import {
  selectPreviousExportModelRefForThread,
  type ExportExchangeRef,
} from "./db/export-queries";
import {
  loadExchangeProjectionDetail,
  type ExchangeProjectionDetail,
} from "./db/exchange-projection-queries";
import {
  locateRawExchange,
  RawLocatorError,
} from "./harness/raw-locator";
import { isKnownSemanticAgentKind } from "./agent-registry";
import {
  classifyRawReadGate,
  rawReadGateMessage,
} from "./ingestion/raw-read-gate";
import {
  openRawBodyStream,
  RawBodyStreamError,
} from "./harness/raw-body-stream";
import type { CaptureFailover, RawCapturedExchange } from "./harness/types";
import type { RawBodyStorage } from "./db/models";
import {
  conversationContentKindsFor,
  type AgentKind,
  type ConversationContentKind,
  type ConversationProvenance,
} from "./conversation-semantics";
import {
  consumePersistedRequestFreshness,
  loadPersistedRequestDedupe,
  type PersistedRequestDedupe,
} from "./export-request-dedupe";
import { loadExportListRows } from "./export-list-rows";

const MAX_TEXT_CHUNK_BYTES = 16 * 1024;
/** 单条目缓冲上限：超过即放弃「服务端跳过继承正文」，绝不无界缓存。 */
const MAX_BUFFERED_ITEM_BYTES = 8 * 1024 * 1024;
const MAX_BASELINE_FINGERPRINTS = 4_096;
const HARD_BASELINE_REQUEST_RAW_BYTES = 128 * 1024 * 1024;

export type ExportContentCompleteness = "complete" | "partial";

export type ExportThreadDedupeFailureCode =
  | "request_parse_failed"
  | "raw_body_unavailable"
  | "raw_body_integrity_failed"
  | "baseline_raw_budget_exceeded"
  | "fingerprint_limited"
  | "context_unconfirmed";

export interface ExportThreadDedupeDetail {
  status: ExportThreadDedupeStatus;
  affectedExchangeId: string;
  selectedBaselineExchangeId?: string;
  attemptedBaselineCount: number;
  skippedBaselineCount: number;
  lastSkippedExchangeId?: string;
  failureCode?: ExportThreadDedupeFailureCode;
}

export type ExportContentEvent =
  | {
      /**
       * 列表行摘要（summaryOnly 模式）：只含 SQLite 物化的代表项摘要，
       * 不含任何 raw 正文——全局时间线滚动因此可以做到零 raw 读取。
       */
      type: "exchange_summary";
      exchangeId: string;
      agentStepId?: string;
      capturedAt: string;
      threadId: string;
      turnId?: string;
      agentSessionId: string;
      targetId: string;
      targetName: string;
      agentName: string;
      model?: string;
      httpStatus?: number;
      durationMs?: number;
      isAuxiliary: boolean;
      auxiliaryKind?: AuxiliaryKind;
      requestSummary?: string;
      responseSummary?: string;
      /** 排重状态：deferred 表示该行未参与线程排重（全局视图按需解析）。 */
      dedupeState: "compared" | "not_applicable" | "unconfirmed" | "deferred";
      /** 列表行摘要是否来自受限/缺失的投影。 */
      summaryLimited: boolean;
      /** 正文是否仍可读（raw 已清理时展开会失败，列表先如实标注）。 */
      rawAvailable: boolean;
      degraded?: "skeleton_missing" | "skeleton_borrowed" | "parts_incomplete";
    }
  | {
      type: "page_start";
      /** 未请求统计时缺省（skipCandidateCount）；UI 显示「未统计」。 */
      candidateCount?: number;
      candidateCountExact: boolean;
      filterProjectionMissingCount: number;
      filterProjectionLimitedCount: number;
      visibleExchangeLimit: number;
      visibleExchangeIds: string[];
      visibleProcessedCount: number;
      baselineProcessedCount: number;
      processedCount: number;
      visibleRawBytes: number;
      baselineRawBytes: number;
      processedRawBytes: number;
      nextCursor?: string;
      previousCursor?: string;
      hasMoreOlder: boolean;
      hasMoreNewer: boolean;
      hasMore: boolean;
      limitedByBytes: boolean;
      dedupeStatusByThread: Record<string, ExportThreadDedupeStatus>;
      dedupeDetailsByThread: Record<string, ExportThreadDedupeDetail>;
      contentCompleteness: ExportContentCompleteness;
    }
  | {
      type: "exchange_start";
      /** 内部 AgentStep.id：客户端按步深链与按需展开的唯一锚点。 */
      agentStepId?: string;
      exchangeId: string;
      capturedAt: string;
      threadId: string;
      turnId?: string;
      agentSessionId: string;
      targetId: string;
      targetName: string;
      model?: string;
      /** 模型故障转移元数据（代理捕获记录；缺省表示按主模型正常服务）。 */
      failover?: CaptureFailover;
      isAuxiliary: boolean;
      auxiliaryKind?: AuxiliaryKind;
      agentProtocol: string;
      httpStatus?: number;
      durationMs?: number;
      diagnosticCodes: string[];
      diagnosticCandidateCount: number;
      diagnosticProcessedCount: number;
      diagnosticsLimited: boolean;
    }
  | {
      type: "item_start";
      exchangeId: string;
      itemOrdinal: number;
      category: ConversationCategory;
      side: ConversationSide;
      jsonPath: string;
      /** 统一 Preview/Raw 的逻辑 lane；旧响应缺省时回退 itemOrdinal。 */
      logicalId?: string;
      toolName?: string;
      toolUseId?: string;
      mediaSha256?: string[];
    }
  | {
      type: "text_chunk";
      exchangeId: string;
      itemOrdinal: number;
      value: string;
    }
  | {
      type: "media_descriptor";
      exchangeId: string;
      itemOrdinal: number;
      bodySide: "request" | "response";
      ordinal: number;
      jsonPath: string;
      mediaType: string;
      encodedBytes: number;
      decodedBytes: number;
      sha256: string;
      sourceStorage: Exclude<RawBodyStorage, "none">;
    }
  | {
      type: "item_end";
      exchangeId: string;
      itemOrdinal: number;
      textSha256: string;
      originalTextBytes: number;
      stepDiff: ConversationStepDiff;
    }
  | {
      type: "exchange_end";
      exchangeId: string;
      /** includeInherited=false 时服务端未下发的继承条数（正文已省略）。 */
      hiddenInheritedInputCount?: number;
    }
  | {
      type: "exchange_error";
      exchangeId: string;
      code:
        | "raw_body_unavailable"
        | "raw_body_integrity_failed"
        | "raw_purged"
        | "raw_expired";
      message: string;
    }
  | {
      type: "page_end";
      contentCompleteness: ExportContentCompleteness;
      processedExchangeCount: number;
      /**
       * 因本地导入降级（缺 system/tools 骨架）而未参与线程排重基线推进的 Exchange。
       * 这些记录的「继承/新增」判定基于更早一次健康请求，必须在 UI 如实标注。
       */
      degradedBaselineExchangeIds?: string[];
    };

type FingerprintMultiset = Map<string, number>;

/** 单侧输入统计：用于识别「请求骨架缺失」的降级行。 */
export interface ExchangeInputSummary {
  inputItemCount: number;
  hasSystemInput: boolean;
  /** includeInherited=false 时被服务端丢弃的继承条目数（不再下发正文）。 */
  hiddenInheritedInputCount: number;
}

/**
 * 请求骨架缺失判定（2026-09-17）：本地导入链路（agent_local_import）的系统提示与
 * 工具定义来自 Agent 客户端的 model-io 记录，取不到时合成的请求体只有 model+messages。
 * 这类请求不得推进线程排重基线，否则下一步的健康请求会被判成「系统提示凭空新增」。
 */
export function isDegradedRequestBaseline(
  ref: Pick<ExportExchangeRef, "origin" | "captureDiagnosticCodes">,
  summary: ExchangeInputSummary,
): boolean {
  if (ref.captureDiagnosticCodes.includes("request_skeleton_missing")) return true;
  if (ref.origin !== "agent_local_import") return false;
  return summary.inputItemCount > 0 && !summary.hasSystemInput;
}

export class ExportContentStreamError extends Error {
  constructor(
    readonly code: "oversized_visible_exchange" | "unsafe_raw_reference",
    message: string,
    readonly exchangeId?: string,
    readonly requiredBytes?: number,
  ) {
    super(message);
    this.name = "ExportContentStreamError";
  }
}

export interface IterateExportContentEventsOptions {
  db: DeepaaDatabase;
  dataDir: string;
  filters: ExportFilters;
  signal?: AbortSignal;
}

/**
 * 当前页完整可读内容流。SQLite 规划完成前不会打开 Raw，且始终逐 Exchange、逐侧处理。
 */
export async function* iterateExportContentEvents(
  options: IterateExportContentEventsOptions,
): AsyncGenerator<ExportContentEvent> {
  const plan = planExportContentPage(options.db, options.filters);
  if (plan.blocked) {
    throw new ExportContentStreamError(
      plan.blocked.code,
      `Exchange ${plan.blocked.exchangeId} 需要 ${plan.blocked.requiredBytes} 字节。`,
      plan.blocked.exchangeId,
      plan.blocked.requiredBytes,
    );
  }
  throwIfAborted(options.signal);

  const previousByThread = new Map<string, FingerprintMultiset | undefined>();
  const persistedByExchange = new Map<string, PersistedRequestDedupe>();
  const degradedBaselineExchangeIds = new Set<string>();
  const dedupeStatusByThread: Record<string, ExportThreadDedupeStatus> = {};
  const dedupeDetailsByThread: Record<string, ExportThreadDedupeDetail> = {};
  const baselineRawBudget: BaselineRawBudget = {
    usedBytes: 0,
    hardLimitBytes: HARD_BASELINE_REQUEST_RAW_BYTES,
  };
  let baselineProcessedCount = 0;
  let baselineRawBytes = 0;
  for (const [threadId, baseline] of plan.baselinesByThread) {
    const persisted = loadPersistedRequestDedupe(
      options.db,
      baseline.affectedExchangeId,
    );
    if (persisted) {
      persistedByExchange.set(baseline.affectedExchangeId, persisted);
    }
    // 派生期 unconfirmed 只代表「派生时证据不足」（如边界跨越 + 无 lineage 项、或投影受限），
    // 不代表真实不可排重；展示层有独立的 Raw/SQLite 回溯能力（128 MiB 预算保护），
    // 必须回退重试而不是直接采信 0 候选结论——否则一次派生期误判会让整个 Thread 永远无法排重。
    const resolved = persisted && persisted.state !== "unconfirmed"
      ? resolvedPersistedBaseline(baseline, persisted)
      : await resolveThreadBaseline(
          options.db,
          options.dataDir,
          baseline,
          baselineRawBudget,
          options.signal,
        );
    previousByThread.set(threadId, resolved.fingerprints);
    dedupeStatusByThread[threadId] = resolved.detail.status;
    dedupeDetailsByThread[threadId] = resolved.detail;
    baselineProcessedCount += resolved.detail.attemptedBaselineCount;
    baselineRawBytes += resolved.rawBytes;
  }

  yield {
    type: "page_start",
    ...(plan.candidateCount !== undefined ? {candidateCount: plan.candidateCount} : {}),
    candidateCountExact: plan.candidateCountExact,
    filterProjectionMissingCount: plan.filterProjectionMissingCount,
    filterProjectionLimitedCount: plan.filterProjectionLimitedCount,
    visibleExchangeLimit: plan.visibleExchangeLimit,
    visibleExchangeIds: plan.visibleRefs.map((ref) => ref.exchangeId),
    visibleProcessedCount: plan.visibleProcessedCount,
    baselineProcessedCount,
    processedCount: plan.visibleProcessedCount + baselineProcessedCount,
    visibleRawBytes: plan.visibleRawBytes,
    baselineRawBytes,
    processedRawBytes: plan.visibleRawBytes + baselineRawBytes,
    nextCursor: plan.nextCursor,
    previousCursor: plan.previousCursor,
    hasMoreOlder: plan.hasMoreOlder,
    hasMoreNewer: plan.hasMoreNewer,
    hasMore: plan.hasMore,
    limitedByBytes: plan.limitedByBytes,
    dedupeStatusByThread,
    dedupeDetailsByThread,
    contentCompleteness: plan.candidateCountExact ? "complete" : "partial",
  };

  if (options.filters.summaryOnly === true) {
    // 列表行摘要：零 raw 读取（摘要来自 SQLite 物化的 overviewCandidates）。
    yield* iterateExchangeSummaries(options, plan);
    yield {
      type: "page_end",
      contentCompleteness: "complete",
      processedExchangeCount: 0,
    };
    return;
  }

  let completeness: ExportContentCompleteness = plan.candidateCountExact
    ? "complete"
    : "partial";
  let processedExchangeCount = 0;
  for (const ref of [...plan.visibleRefs].reverse()) {
    throwIfAborted(options.signal);
    const projection = loadExchangeProjectionDetail(options.db, ref.exchangeId);
    yield exchangeStartEvent(ref, projection);
    // raw 读取门禁：已清理/超窗的 Exchange 逐条标记错误事件，不让整页失败。
    const gate = classifyRawReadGate(options.db, options.dataDir, ref.exchangeId);
    if (gate && gate.state !== "active") {
      completeness = "partial";
      yield {
        type: "exchange_error",
        exchangeId: ref.exchangeId,
        code: gate.state === "purged" ? "raw_purged" : "raw_expired",
        message: rawReadGateMessage(gate),
      };
      continue;
    }
    try {
      const persisted = ref.isModelCall
        ? persistedByExchange.get(ref.exchangeId)
          ?? loadPersistedRequestDedupe(options.db, ref.exchangeId)
        : undefined;
      // 派生期 unconfirmed 的持久化结论不采信：回退到同 Thread 滚动指纹多重集做实时排重，
      // 避免一次派生期误判沿 Thread 链向后传染，让全部后续请求都显示「排重未确认」。
      const persistedUsable = persisted !== undefined && persisted.state !== "unconfirmed";
      const previous = ref.isModelCall && !persistedUsable
        ? cloneFingerprintMultiset(previousByThread.get(ref.agentThreadId))
        : undefined;
      const current = new Map<string, number>();
      const summary: ExchangeInputSummary = {
        inputItemCount: 0,
        hasSystemInput: false,
        hiddenInheritedInputCount: 0,
      };
      for await (const event of iterateVisibleExchange(
        options.db,
        options.dataDir,
        ref,
        projection,
        previous,
        persistedUsable ? persisted : undefined,
        current,
        options.filters,
        options.signal,
        summary,
      )) yield event;
      if (ref.isModelCall) {
        // 降级请求（本地导入缺 system/tools 骨架）不参与线程基线推进：否则被它
        // 清空的多重集会令下一步的系统提示与工具定义全部被判成「本 Step 新增」，
        // 在页面上表现为一段凭空出现的 system（系统）内容。
        if (isDegradedRequestBaseline(ref, summary)) {
          dedupeStatusByThread[ref.agentThreadId] =
            dedupeStatusByThread[ref.agentThreadId] ?? "sqlite_fingerprint";
          degradedBaselineExchangeIds.add(ref.exchangeId);
        } else {
          previousByThread.set(ref.agentThreadId, current);
        }
      }
      processedExchangeCount += 1;
      yield {
        type: "exchange_end",
        exchangeId: ref.exchangeId,
        ...(summary.hiddenInheritedInputCount > 0
          ? {hiddenInheritedInputCount: summary.hiddenInheritedInputCount}
          : {}),
      };
    } catch (error) {
      if (error instanceof ExportContentStreamError) throw error;
      throwIfAborted(options.signal);
      completeness = "partial";
      yield {
        type: "exchange_error",
        exchangeId: ref.exchangeId,
        code: error instanceof RawBodyStreamError
          && error.code === "raw_body_integrity_failed"
          ? "raw_body_integrity_failed"
          : "raw_body_unavailable",
        message: "该 Exchange 的完整正文当前不可用。",
      };
    }
  }
  yield {
    type: "page_end",
    contentCompleteness: completeness,
    processedExchangeCount,
    ...(degradedBaselineExchangeIds.size > 0
      ? {degradedBaselineExchangeIds: [...degradedBaselineExchangeIds].slice(0, 64)}
      : {}),
  };
}

/**
 * 列表行摘要流：零 raw 读取。摘要来自 SQLite 物化的 overviewCandidates，
 * 候选总数 COUNT 只在首屏请求（filters.skipCandidateCount 控制）。
 */
/**
 * 缓冲单条目的下发行；超出上限（或条目已被判定必须可见）时立即下发，
 * 保证「继承条目不下发」不以无界内存为代价。
 */
function* emitOrBufferActiveEvent(
  active: {
    pending: ExportContentEvent[];
    pendingBytes: number;
    startEmitted: boolean;
  },
  event: ExportContentEvent,
): Generator<ExportContentEvent> {
  if (active.startEmitted) {
    yield event;
    return;
  }
  const size = event.type === "text_chunk" ? event.value.length : 0;
  if (active.pendingBytes + size > MAX_BUFFERED_ITEM_BYTES) {
    // 超大条目：放弃「服务端跳过继承正文」（诚实优先于省流量），改为立即下发。
    active.startEmitted = true;
    yield event;
    return;
  }
  active.pendingBytes += size;
  active.pending.push(event);
}

async function* iterateExchangeSummaries(
  options: IterateExportContentEventsOptions,
  plan: ReturnType<typeof planExportContentPage>,
): AsyncGenerator<ExportContentEvent> {
  const dedupeStates = loadRequestDedupeStates(options.db, plan.visibleRefs);
  const rows = loadExportListRows(options.db, plan.visibleRefs, {
    requestDedupeStates: dedupeStates,
    deferred: options.filters.deferBaseline === true,
  });
  for (const row of rows) {
    throwIfAborted(options.signal);
    yield {
      type: "exchange_summary",
      exchangeId: row.exchangeId,
      ...(row.agentStepId !== undefined ? {agentStepId: row.agentStepId} : {}),
      capturedAt: row.capturedAt,
      threadId: row.threadId,
      ...(row.turnId !== undefined ? {turnId: row.turnId} : {}),
      agentSessionId: row.agentSessionId,
      targetId: row.targetId,
      targetName: row.targetName,
      agentName: row.agentName,
      ...(row.model !== undefined ? {model: row.model} : {}),
      ...(row.httpStatus !== undefined ? {httpStatus: row.httpStatus} : {}),
      ...(row.durationMs !== undefined ? {durationMs: row.durationMs} : {}),
      isAuxiliary: row.isAuxiliary,
      ...(row.auxiliaryKind !== undefined ? {auxiliaryKind: row.auxiliaryKind} : {}),
      ...(row.requestSummary !== undefined ? {requestSummary: row.requestSummary} : {}),
      ...(row.responseSummary !== undefined ? {responseSummary: row.responseSummary} : {}),
      dedupeState: row.dedupeState === "not_applicable" ? "not_applicable" : row.dedupeState,
      summaryLimited: row.summaryLimited,
      rawAvailable: row.rawAvailable,
      ...(row.degraded !== undefined ? {degraded: row.degraded} : {}),
    };
  }
}

/**
 * 单次 SQLite 查询取回本页各 Exchange 的物化排重状态（compared / not_applicable /
 * unconfirmed）。只有 compared 才允许声称「本步骤新增」；首步（not_applicable）
 * 与未确认（unconfirmed）必须在 UI 上区分，不能一律显示「未排重」。
 */
function loadRequestDedupeStates(
  db: DeepaaDatabase,
  refs: readonly ExportExchangeRef[],
): Map<string, string> {
  if (refs.length === 0) return new Map();
  const placeholders = refs.map(() => "?").join(",");
  const rows = db.prepare(
    `SELECT exchange_id, request_dedupe_state FROM exchange_content_filter_status
     WHERE exchange_id IN (${placeholders})`,
  ).all(...refs.map(ref => ref.exchangeId)) as Array<{
    exchange_id: string;
    request_dedupe_state: string | null;
  }>;
  return new Map(rows.map(row => [row.exchange_id, row.request_dedupe_state ?? "unconfirmed"]));
}

async function* iterateVisibleExchange(
  db: DeepaaDatabase,
  dataDir: string,
  ref: ExportExchangeRef,
  projection: ExchangeProjectionDetail | undefined,
  inherited: FingerprintMultiset | undefined,
  persisted: PersistedRequestDedupe | undefined,
  current: FingerprintMultiset,
  filters: ExportFilters,
  signal?: AbortSignal,
  summary?: ExchangeInputSummary,
): AsyncGenerator<ExportContentEvent> {
  const located = await safeLocate(db, dataDir, ref.exchangeId);
  let itemOrdinal = 0;
  for (const bodySide of ["request", "response"] as const) {
    if (filters.side && filters.side !== bodySide) continue;
    throwIfAborted(signal);
    const body = located.exchange[bodySide];
    if (body.bodySizeBytes === 0) continue;
    const opened = await openRawBodyStream(dataDir, body, {
      purpose: "raw",
      label: bodySide,
    });
    let completed = false;
    // includeInherited=false 时服务端直接不下发继承条目的正文：继承/新增只有在
    // 条目结束时才能凭指纹判定，因此把该条目的 start/正文/描述符先按条目缓冲，
    // 结束时要么整体下发、要么整体丢弃（单条目上限见 MAX_BUFFERED_ITEM_BYTES）。
    const skipInherited = filters.includeInheritedExplicit === true
      && filters.includeInherited !== true;
    let active: {
      ordinal: number;
      category: ConversationCategory;
      side: ConversationSide;
      provenance: ConversationProvenance;
      providerItemType: string;
      contentKinds: ConversationContentKind[];
      jsonPath: string;
      logicalId?: string;
      toolName?: string;
      toolUseId?: string;
      providerLineageKey?: string;
      mediaSha256?: string[];
      previewHash?: string;
      stepDiff: ConversationStepDiff;
      emit: boolean;
      /** 继承条目候选：仅输入侧、且未超缓冲上限时才可能是 inherited。 */
      skippable: boolean;
      startEmitted: boolean;
      pending: ExportContentEvent[];
      pendingBytes: number;
    } | undefined;
    try {
      for await (const bodyEvent of iterateConversationBodyEvents({
        stream: opened.stream,
        format: bodySide === "response" && located.exchange.response.isStreaming
          ? "sse"
          : "json",
        exchangeId: ref.exchangeId,
        side: bodySide,
        rawBodySha256: body.bodySha256,
        sourceStorage: rawSourceStorage(body),
        protocol: projection?.preview.protocol ?? "unknown",
        agentKind: agentKindForName(ref.agentName),
        previewItems: projection?.preview.items,
        inheritedFingerprints: bodySide === "request" && !persisted
          ? inherited
          : undefined,
      })) {
        throwIfAborted(signal);
        if (bodyEvent.type === "item_start") {
          const category = ref.isAuxiliary ? "tool_result" : bodyEvent.category;
          if (summary && bodyEvent.side === "input") {
            summary.inputItemCount += 1;
            if (category === "system") summary.hasSystemInput = true;
          }
          active = {
            ordinal: itemOrdinal,
            category,
            side: bodyEvent.side,
            provenance: bodyEvent.provenance,
            providerItemType: bodyEvent.providerItemType,
            contentKinds: [...bodyEvent.contentKinds],
            toolName: bodyEvent.toolName,
            toolUseId: bodyEvent.toolUseId,
            providerLineageKey: bodyEvent.providerLineageKey,
            mediaSha256: bodyEvent.mediaSha256 ? [...bodyEvent.mediaSha256] : undefined,
            jsonPath: bodyEvent.jsonPath,
            logicalId: bodyEvent.logicalId,
            previewHash: bodyEvent.textSha256,
            stepDiff: bodyEvent.stepDiff ?? "unique",
            emit: categorySelectedForSide(bodyEvent.side, category, filters.categories, filters.categoriesExplicit),
            skippable: skipInherited && bodyEvent.side === "input",
            startEmitted: false,
            pending: [],
            pendingBytes: 0,
          };
          itemOrdinal += 1;
          if (active.emit && !active.skippable) {
            active.startEmitted = true;
            yield {
              type: "item_start",
              exchangeId: ref.exchangeId,
              itemOrdinal: active.ordinal,
              category,
              side: bodyEvent.side,
              jsonPath: bodyEvent.jsonPath,
              logicalId: bodyEvent.logicalId,
              toolName: bodyEvent.toolName,
              toolUseId: bodyEvent.toolUseId,
              mediaSha256: bodyEvent.mediaSha256,
            };
          }
        } else if (bodyEvent.type === "text" && active?.emit) {
          if (!/^\[media [^\]]+\]$/u.test(bodyEvent.value)) {
            for (const value of splitUtf8(bodyEvent.value, MAX_TEXT_CHUNK_BYTES)) {
              yield* emitOrBufferActiveEvent(active, {
                type: "text_chunk",
                exchangeId: ref.exchangeId,
                itemOrdinal: active.ordinal,
                value,
              });
            }
          }
        } else if (bodyEvent.type === "media_descriptor" && active?.emit) {
          yield* emitOrBufferActiveEvent(active, {
            type: "media_descriptor",
            exchangeId: ref.exchangeId,
            itemOrdinal: active.ordinal,
            bodySide: bodyEvent.side,
            ordinal: bodyEvent.ordinal,
            jsonPath: bodyEvent.jsonPath,
            mediaType: bodyEvent.mediaType,
            encodedBytes: bodyEvent.encodedBytes,
            decodedBytes: bodyEvent.decodedBytes,
            sha256: bodyEvent.sha256,
            sourceStorage: bodyEvent.sourceStorage,
          });
        } else if (bodyEvent.type === "item_end" && active) {
          const key = conversationFingerprintKey({
            category: active.category,
            side: active.side,
            provenance: active.provenance,
            providerItemType: active.providerItemType,
            textSha256: bodyEvent.textSha256,
            contentKinds: bodyEvent.contentKinds,
            mediaSha256: bodyEvent.mediaSha256,
            toolName: active.toolName,
            toolUseId: active.toolUseId,
          });
          if (active.side === "input") incrementFingerprint(current, key);
          const stepDiff = active.side === "output"
            ? "unique"
            : persisted
              ? consumePersistedRequestFreshness(persisted, {
                  fingerprint: key,
                  providerLineageKey: active.providerLineageKey,
                })
              : inherited === undefined
                ? "unconfirmed"
                : active.previewHash
                  ? active.stepDiff
                  : consumeFingerprint(inherited, key) ? "inherited" : "unique";
          if (active.emit) {
            const hidden = active.skippable && stepDiff === "inherited";
            if (hidden) {
              if (summary) summary.hiddenInheritedInputCount += 1;
            } else {
              if (!active.startEmitted) {
                active.startEmitted = true;
                yield {
                  type: "item_start",
                  exchangeId: ref.exchangeId,
                  itemOrdinal: active.ordinal,
                  category: active.category,
                  side: active.side,
                  jsonPath: active.jsonPath,
                  logicalId: active.logicalId,
                  toolName: active.toolName,
                  toolUseId: active.toolUseId,
                  mediaSha256: active.mediaSha256,
                };
              }
              for (const pendingEvent of active.pending) yield pendingEvent;
              yield {
                type: "item_end",
                exchangeId: ref.exchangeId,
                itemOrdinal: active.ordinal,
                textSha256: bodyEvent.textSha256,
                originalTextBytes: bodyEvent.originalTextBytes,
                stepDiff,
              };
            }
          }
          active = undefined;
        }
      }
      const verification = await opened.verification;
      if (verification.status !== "verified") {
        throw new RawBodyStreamError(
          verification.status === "failed"
            ? verification.errorCode
            : "raw_body_integrity_failed",
          "完整正文未通过校验。",
        );
      }
      completed = true;
    } finally {
      if (!completed) opened.stream.destroy();
    }
  }
}

interface ResolvedThreadBaseline {
  fingerprints: FingerprintMultiset | undefined;
  detail: ExportThreadDedupeDetail;
  rawBytes: number;
}

interface BaselineRawBudget {
  usedBytes: number;
  hardLimitBytes: number;
}

function resolvedPersistedBaseline(
  plan: ExportThreadBaselinePlan,
  persisted: PersistedRequestDedupe,
): ResolvedThreadBaseline {
  if (persisted.state === "compared") {
    return {
      fingerprints: new Map(),
      rawBytes: 0,
      detail: {
        status: "sqlite_fingerprint",
        affectedExchangeId: plan.affectedExchangeId,
        selectedBaselineExchangeId: persisted.baselineExchangeId,
        attemptedBaselineCount: persisted.baselineExchangeId ? 1 : 0,
        skippedBaselineCount: 0,
      },
    };
  }
  if (persisted.state === "unconfirmed") {
    return {
      fingerprints: undefined,
      rawBytes: 0,
      detail: {
        status: "unavailable",
        affectedExchangeId: plan.affectedExchangeId,
        attemptedBaselineCount: 0,
        skippedBaselineCount: 0,
        failureCode: "context_unconfirmed",
      },
    };
  }
  return {
    fingerprints: new Map(),
    rawBytes: 0,
    detail: {
      status: "not_required",
      affectedExchangeId: plan.affectedExchangeId,
      attemptedBaselineCount: 0,
      skippedBaselineCount: 0,
    },
  };
}

/**
 * 候选不受页面条数和字节预算影响，但始终使用 LIMIT 1 沿同 Thread 串行回溯。
 * 只读取 Request；独立硬上限用于避免损坏历史造成无界 Raw I/O。
 */
async function resolveThreadBaseline(
  db: DeepaaDatabase,
  dataDir: string,
  plan: ExportThreadBaselinePlan,
  budget: BaselineRawBudget,
  signal?: AbortSignal,
): Promise<ResolvedThreadBaseline> {
  if (!plan.ref || plan.status === "not_required") {
    return {
      fingerprints: new Map(),
      rawBytes: 0,
      detail: {
        status: "not_required",
        affectedExchangeId: plan.affectedExchangeId,
        attemptedBaselineCount: 0,
        skippedBaselineCount: 0,
      },
    };
  }

  let candidate: ExportExchangeRef | undefined = plan.ref;
  let attemptedBaselineCount = 0;
  let skippedBaselineCount = 0;
  let rawBytes = 0;
  let lastSkippedExchangeId: string | undefined;
  let failureCode: ExportThreadDedupeFailureCode | undefined;

  while (candidate) {
    throwIfAborted(signal);
    attemptedBaselineCount += 1;
    const projection = loadExchangeProjectionDetail(db, candidate.exchangeId);
    if (projection && sqliteFingerprintComplete(projection)) {
      return {
        fingerprints: projectionFingerprintMultiset(candidate, projection),
        rawBytes,
        detail: {
          status: "sqlite_fingerprint",
          affectedExchangeId: plan.affectedExchangeId,
          selectedBaselineExchangeId: candidate.exchangeId,
          attemptedBaselineCount,
          skippedBaselineCount,
          lastSkippedExchangeId,
          failureCode,
        },
      };
    }

    const candidateRawBytes = safeDeclaredBytes(candidate.requestBodyBytes);
    if (budget.usedBytes + candidateRawBytes > budget.hardLimitBytes) {
      skippedBaselineCount += 1;
      lastSkippedExchangeId = candidate.exchangeId;
      failureCode = "baseline_raw_budget_exceeded";
      return unavailableBaselineResult({
        plan,
        attemptedBaselineCount,
        skippedBaselineCount,
        lastSkippedExchangeId,
        failureCode,
        rawBytes,
      });
    }
    budget.usedBytes += candidateRawBytes;
    rawBytes += candidateRawBytes;

    try {
      const fingerprints = await rawFingerprintMultiset(db, dataDir, candidate, signal);
      return {
        fingerprints,
        rawBytes,
        detail: {
          status: "raw_fallback",
          affectedExchangeId: plan.affectedExchangeId,
          selectedBaselineExchangeId: candidate.exchangeId,
          attemptedBaselineCount,
          skippedBaselineCount,
          lastSkippedExchangeId,
          failureCode,
        },
      };
    } catch (error) {
      throwIfAborted(signal);
      if (
        error instanceof ExportContentStreamError
        || (error instanceof RawBodyStreamError && error.code === "unsafe_raw_reference")
      ) {
        throw error instanceof ExportContentStreamError
          ? error
          : new ExportContentStreamError(
              "unsafe_raw_reference",
              "Raw 索引或原始记录无法安全定位。",
              candidate.exchangeId,
            );
      }
      if (isFingerprintLimit(error)) {
        return {
          fingerprints: undefined,
          rawBytes,
          detail: {
            status: "fingerprint_limited",
            affectedExchangeId: plan.affectedExchangeId,
            attemptedBaselineCount,
            skippedBaselineCount: skippedBaselineCount + 1,
            lastSkippedExchangeId: candidate.exchangeId,
            failureCode: "fingerprint_limited",
          },
        };
      }
      skippedBaselineCount += 1;
      lastSkippedExchangeId = candidate.exchangeId;
      failureCode = classifyBaselineFailure(error);
      candidate = selectPreviousExportModelRefForThread(db, candidate);
    }
  }

  return unavailableBaselineResult({
    plan,
    attemptedBaselineCount,
    skippedBaselineCount,
    lastSkippedExchangeId,
    failureCode,
    rawBytes,
  });
}

function unavailableBaselineResult(input: {
  plan: ExportThreadBaselinePlan;
  attemptedBaselineCount: number;
  skippedBaselineCount: number;
  lastSkippedExchangeId?: string;
  failureCode?: ExportThreadDedupeFailureCode;
  rawBytes: number;
}): ResolvedThreadBaseline {
  return {
    fingerprints: undefined,
    rawBytes: input.rawBytes,
    detail: {
      status: "unavailable",
      affectedExchangeId: input.plan.affectedExchangeId,
      attemptedBaselineCount: input.attemptedBaselineCount,
      skippedBaselineCount: input.skippedBaselineCount,
      lastSkippedExchangeId: input.lastSkippedExchangeId,
      failureCode: input.failureCode,
    },
  };
}

function sqliteFingerprintComplete(projection: ExchangeProjectionDetail): boolean {
  return (projection.projectionVersion ?? 0) >= 2
    && projection.previewState === "complete"
    && projection.preview.itemCandidateCountExact
    && projection.preview.itemProcessedCount === projection.preview.itemCandidateCount;
}

function classifyBaselineFailure(error: unknown): ExportThreadDedupeFailureCode {
  if (error instanceof RawBodyStreamError) {
    return error.code === "raw_body_integrity_failed"
      ? "raw_body_integrity_failed"
      : "raw_body_unavailable";
  }
  return "request_parse_failed";
}

function safeDeclaredBytes(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

async function rawFingerprintMultiset(
  db: DeepaaDatabase,
  dataDir: string,
  ref: ExportExchangeRef,
  signal?: AbortSignal,
): Promise<FingerprintMultiset> {
  const located = await safeLocate(db, dataDir, ref.exchangeId);
  const projection = loadExchangeProjectionDetail(db, ref.exchangeId);
  const fingerprints = new Map<string, number>();
  for (const bodySide of ["request"] as const) {
    throwIfAborted(signal);
    const body = located.exchange[bodySide];
    if (body.bodySizeBytes === 0) continue;
    const opened = await openRawBodyStream(dataDir, body, {
      purpose: "raw",
      label: bodySide,
    });
    let active: Extract<ConversationBodyEvent, { type: "item_start" }> | undefined;
    let completed = false;
    try {
      for await (const event of iterateConversationBodyEvents({
        stream: opened.stream,
        format: "json",
        exchangeId: ref.exchangeId,
        side: bodySide,
        rawBodySha256: body.bodySha256,
        sourceStorage: rawSourceStorage(body),
        protocol: projection?.preview.protocol ?? "unknown",
        agentKind: agentKindForName(ref.agentName),
        previewItems: projection?.preview.items,
      })) {
        throwIfAborted(signal);
        if (event.type === "item_start") active = event;
        if (event.type !== "item_end" || !active) continue;
        if (fingerprintCount(fingerprints) >= MAX_BASELINE_FINGERPRINTS) {
          throw new FingerprintLimitError();
        }
        incrementFingerprint(fingerprints, conversationFingerprintKey({
          category: active.category,
          side: active.side,
          provenance: active.provenance,
          providerItemType: active.providerItemType,
          textSha256: event.textSha256,
          mediaSha256: event.mediaSha256,
          contentKinds: event.contentKinds,
          toolName: active.toolName,
          toolUseId: active.toolUseId,
        }));
        active = undefined;
      }
      const verification = await opened.verification;
      if (verification.status !== "verified") {
        throw new RawBodyStreamError(
          verification.status === "failed"
            ? verification.errorCode
            : "raw_body_integrity_failed",
          "基线 Request 正文完整性校验失败。",
        );
      }
      completed = true;
    } finally {
      if (!completed) opened.stream.destroy();
    }
  }
  return fingerprints;
}

function projectionFingerprintMultiset(
  ref: ExportExchangeRef,
  projection: ExchangeProjectionDetail,
): FingerprintMultiset {
  const fingerprints = new Map<string, number>();
  for (const item of projection.preview.items) {
    if (item.side !== "request") continue;
    const category = previewConversationCategory(
      item,
      ref.isAuxiliary,
      projection.preview.protocol,
    );
    if (!category) continue;
    incrementFingerprint(fingerprints, conversationFingerprintKey({
      category,
      side: item.side === "request" ? "input" : "output",
      provenance: item.provenance,
      providerItemType: item.itemType,
      textSha256: item.textSha256,
      mediaSha256: item.mediaSha256,
      contentKinds: conversationContentKindsFor(
        item.itemType,
        item.mediaDescriptorOrdinals.length > 0,
      ),
      toolName: item.toolName,
      toolUseId: item.toolUseId,
    }));
  }
  return fingerprints;
}

function agentKindForName(name: string): AgentKind {
  // 注册表驱动：已知语义 AgentKind 原样通过；其余非空名按通用工具，空名未知。
  if (isKnownSemanticAgentKind(name)) return name as AgentKind;
  return name ? "generic" : "unknown";
}

function exchangeStartEvent(
  ref: ExportExchangeRef,
  projection: ExchangeProjectionDetail | undefined,
): Extract<ExportContentEvent, { type: "exchange_start" }> {
  const diagnosticCodes = projection?.diagnostics.items
    .slice(0, 16)
    .map(diagnostic => diagnostic.code) ?? [];
  return {
    type: "exchange_start",
    exchangeId: ref.exchangeId,
    ...(ref.agentStepId !== undefined ? {agentStepId: ref.agentStepId} : {}),
    capturedAt: ref.capturedAt,
    threadId: ref.agentThreadId,
    turnId: ref.agentTurnId,
    agentSessionId: ref.agentSessionId,
    targetId: ref.targetId,
    targetName: ref.targetName,
    model: projection?.model,
    ...(projection?.failover ? {failover: projection.failover} : {}),
    isAuxiliary: ref.isAuxiliary,
    auxiliaryKind: ref.isAuxiliary
      ? auxiliaryKindFromEndpoint(projection?.preview.endpointKind)
      : undefined,
    agentProtocol: projection?.preview.protocol ?? "unknown",
    httpStatus: projection?.response.status,
    durationMs: projection?.durationMs,
    diagnosticCodes,
    diagnosticCandidateCount: projection?.diagnostics.candidateCount ?? 0,
    diagnosticProcessedCount: diagnosticCodes.length,
    diagnosticsLimited: projection
      ? projection.diagnostics.limited
        || projection.diagnostics.items.length > diagnosticCodes.length
      : false,
  };
}

async function safeLocate(
  db: DeepaaDatabase,
  dataDir: string,
  exchangeId: string,
) {
  try {
    const located = await locateRawExchange(db, dataDir, exchangeId);
    if (!located) throw new RawBodyStreamError("raw_body_unavailable", "Raw 正文不存在。");
    return located;
  } catch (error) {
    if (error instanceof RawLocatorError) {
      throw new ExportContentStreamError(
        "unsafe_raw_reference",
        "Raw 索引或原始记录无法安全定位。",
        exchangeId,
      );
    }
    throw error;
  }
}

function rawSourceStorage(
  body: RawCapturedExchange["request"] | RawCapturedExchange["response"],
): Exclude<RawBodyStorage, "none"> {
  return body.rawBodyRef?.storage ?? "inline";
}

function cloneFingerprintMultiset(
  value: FingerprintMultiset | undefined,
): FingerprintMultiset | undefined {
  return value ? new Map(value) : undefined;
}

function consumeFingerprint(value: FingerprintMultiset | undefined, key: string): boolean {
  if (!value) return false;
  const count = value.get(key) ?? 0;
  if (count <= 0) return false;
  value.set(key, count - 1);
  return true;
}

function incrementFingerprint(value: FingerprintMultiset, key: string): void {
  incrementFingerprintBy(value, key, 1);
}

function incrementFingerprintBy(
  value: FingerprintMultiset,
  key: string,
  count: number,
): void {
  value.set(key, (value.get(key) ?? 0) + count);
}

function fingerprintCount(value: FingerprintMultiset): number {
  let count = 0;
  for (const occurrences of value.values()) count += occurrences;
  return count;
}

function* splitUtf8(value: string, maxBytes: number): Generator<string> {
  let chunk = "";
  let bytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character);
    if (bytes > 0 && bytes + characterBytes > maxBytes) {
      yield chunk;
      chunk = "";
      bytes = 0;
    }
    chunk += character;
    bytes += characterBytes;
  }
  if (chunk) yield chunk;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
}

class FingerprintLimitError extends Error {}

function isFingerprintLimit(error: unknown): error is FingerprintLimitError {
  return error instanceof FingerprintLimitError;
}
