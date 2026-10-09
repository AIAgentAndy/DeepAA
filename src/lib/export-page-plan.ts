import type {DeepaaDatabase} from "@/lib/db/sqlite-driver";
import {
  encodeExportCursor,
  selectExportExchangeRefs,
  selectPreviousExportModelRefForThread,
  type ExportExchangeRef,
} from "./db/export-queries";
import { loadExchangeProjectionDetail } from "./db/exchange-projection-queries";
import type { ExportFilters } from "./export-conversation";

const DEFAULT_VISIBLE_EXCHANGE_LIMIT = 5;

export type ExportThreadDedupeStatus =
  | "not_required"
  | "sqlite_fingerprint"
  | "raw_fallback"
  | "unavailable"
  | "fingerprint_limited";

export interface ExportThreadBaselinePlan {
  threadId: string;
  affectedExchangeId: string;
  ref?: ExportExchangeRef;
  status: ExportThreadDedupeStatus;
  rawBytes: number;
}

export interface ExportContentPagePlan {
  visibleRefs: ExportExchangeRef[];
  baselinesByThread: Map<string, ExportThreadBaselinePlan>;
  /** 未请求统计（skipCandidateCount）时缺省；UI 显示「未统计」而不是 0。 */
  candidateCount?: number;
  candidateCountExact: boolean;
  filterProjectionMissingCount: number;
  filterProjectionLimitedCount: number;
  visibleExchangeLimit: number;
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
  blocked?: {
    code: "oversized_visible_exchange";
    exchangeId: string;
    requiredBytes: number;
  };
}

/**
 * 仅使用 SQLite 元数据规划当前页；Raw JSONL/blob 必须在本函数成功返回后才能打开。
 */
export function planExportContentPage(
  db: DeepaaDatabase,
  filters: ExportFilters,
): ExportContentPagePlan {
  const selected = selectExportExchangeRefs(db, filters);
  const visibleExchangeLimit = normalizeVisibleLimit(filters);
  // summaryOnly 不读任何 raw：行摘要只来自 SQLite，字节预算不应把列表行数截断成「假受限」。
  const maxBytes = filters.summaryOnly === true ? undefined : normalizeByteBudget(filters);
  const visibleRefs: ExportExchangeRef[] = [];
  let baselinesByThread = new Map<string, ExportThreadBaselinePlan>();
  let visibleRawBytes = 0;
  let baselineRawBytes = 0;
  let limitedByBytes = false;
  let blocked: ExportContentPagePlan["blocked"];

  const planningRefs = filters.direction === "newer"
    ? [...selected.refs].reverse()
    : selected.refs;
  for (const ref of planningRefs) {
    const nextVisibleRefs = [...visibleRefs, ref];
    const nextVisibleRawBytes = sumRawBytes(nextVisibleRefs);
    // deferBaseline（全局时间线/列表模式）：不为了「本步骤新增」去读上一条请求的
    // raw——滚动期间任何 raw 读取都会让全局视图退化成 O(页数 × 请求体)。
    // 行摘要标注「未排重」，用户展开单条时再按需解析。
    const nextBaselines = filters.side === "response"
      || filters.deferBaseline === true
      || filters.includeInherited === true
      ? new Map<string, ExportThreadBaselinePlan>()
      : planThreadBaselines(db, nextVisibleRefs);
    const nextBaselineRawBytes = sumBaselineRawBytes(nextBaselines);

    if (maxBytes !== undefined && nextVisibleRawBytes > maxBytes) {
      limitedByBytes = true;
      if (visibleRefs.length === 0 && rawBytes(ref) > maxBytes) {
        blocked = {
          code: "oversized_visible_exchange",
          exchangeId: ref.exchangeId,
          requiredBytes: rawBytes(ref),
        };
        break;
      }
      break;
    }

    visibleRefs.push(ref);
    visibleRawBytes = nextVisibleRawBytes;
    baselinesByThread = nextBaselines;
    baselineRawBytes = nextBaselineRawBytes;
  }

  if (filters.direction === "newer") visibleRefs.reverse();

  const limitedWithinSelected = visibleRefs.length < selected.refs.length;
  const hasMoreOlder = selected.hasMoreOlder
    || (filters.direction !== "newer" && limitedWithinSelected);
  const hasMoreNewer = selected.hasMoreNewer
    || (filters.direction === "newer" && limitedWithinSelected);
  const nextCursor = hasMoreOlder && visibleRefs.length > 0
    ? encodeExportCursor(visibleRefs.at(-1)!)
    : undefined;
  const previousCursor = hasMoreNewer && visibleRefs.length > 0
    ? encodeExportCursor(visibleRefs[0]!)
    : undefined;
  const baselineProcessedCount = [...baselinesByThread.values()]
    .filter((baseline) => baseline.ref !== undefined).length;
  return {
    visibleRefs,
    baselinesByThread,
    candidateCount: selected.candidateCount,
    candidateCountExact: selected.candidateCountExact,
    filterProjectionMissingCount: selected.filterProjectionMissingCount,
    filterProjectionLimitedCount: selected.filterProjectionLimitedCount,
    visibleExchangeLimit,
    visibleProcessedCount: visibleRefs.length,
    baselineProcessedCount,
    processedCount: visibleRefs.length + baselineProcessedCount,
    visibleRawBytes,
    baselineRawBytes,
    processedRawBytes: visibleRawBytes + baselineRawBytes,
    nextCursor,
    previousCursor,
    hasMoreOlder,
    hasMoreNewer,
    hasMore: hasMoreOlder,
    limitedByBytes,
    blocked,
  };
}

function planThreadBaselines(
  db: DeepaaDatabase,
  visibleRefs: ExportExchangeRef[],
): Map<string, ExportThreadBaselinePlan> {
  const earliestModelByThread = new Map<string, ExportExchangeRef>();
  for (const ref of visibleRefs) {
    if (!ref.isModelCall) continue;
    const current = earliestModelByThread.get(ref.agentThreadId);
    if (!current || comparePosition(ref, current) < 0) {
      earliestModelByThread.set(ref.agentThreadId, ref);
    }
  }
  const baselines = new Map<string, ExportThreadBaselinePlan>();
  for (const [threadId, earliest] of earliestModelByThread) {
    const ref = selectPreviousExportModelRefForThread(db, earliest);
    if (!ref) {
      baselines.set(threadId, {
        threadId,
        affectedExchangeId: earliest.exchangeId,
        status: "not_required",
        rawBytes: 0,
      });
      continue;
    }
    const projection = loadExchangeProjectionDetail(db, ref.exchangeId);
    const sqliteFingerprintComplete = (projection?.projectionVersion ?? 0) >= 2
      && projection?.previewState === "complete"
      && projection.preview.itemCandidateCountExact
      && projection.preview.itemProcessedCount === projection.preview.itemCandidateCount;
    baselines.set(threadId, {
      threadId,
      affectedExchangeId: earliest.exchangeId,
      ref,
      status: sqliteFingerprintComplete ? "sqlite_fingerprint" : "raw_fallback",
      rawBytes: sqliteFingerprintComplete ? 0 : requestRawBytes(ref),
    });
  }
  return baselines;
}

function normalizeVisibleLimit(filters: ExportFilters): number {
  const value = filters.exchangeLimit ?? filters.maxExchanges;
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_VISIBLE_EXCHANGE_LIMIT;
  }
  return Math.max(1, Math.floor(value));
}

function normalizeByteBudget(filters: ExportFilters): number | undefined {
  const value = filters.pageMaxBytes ?? filters.maxBytes;
  if (value === undefined || !Number.isFinite(value)) return undefined;
  return Math.max(0, Math.floor(value));
}

function sumRawBytes(refs: ExportExchangeRef[]): number {
  return refs.reduce((sum, ref) => sum + rawBytes(ref), 0);
}

function sumBaselineRawBytes(
  baselines: ReadonlyMap<string, ExportThreadBaselinePlan>,
): number {
  return [...baselines.values()].reduce((sum, baseline) => sum + baseline.rawBytes, 0);
}

function rawBytes(ref: ExportExchangeRef): number {
  return safeBytes(ref.requestBodyBytes) + safeBytes(ref.responseBodyBytes);
}

function requestRawBytes(ref: ExportExchangeRef): number {
  return safeBytes(ref.requestBodyBytes);
}

function safeBytes(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/** 负数表示 left 更早，正数表示 left 更新。 */
function comparePosition(left: ExportExchangeRef, right: ExportExchangeRef): number {
  const time = left.capturedAt.localeCompare(right.capturedAt);
  return time !== 0 ? time : left.exchangeId.localeCompare(right.exchangeId);
}
