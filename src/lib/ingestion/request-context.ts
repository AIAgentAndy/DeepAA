import { createHash } from "node:crypto";
import type {
  ConversationRequestContext,
  RequestContextMode,
} from "../conversation-semantics";
import type {
  ContextBoundaryCandidate,
  ExchangeContentFilterItem,
} from "./projection-types";

export type RequestDedupeState =
  | "not_required"
  | "compared"
  | "unconfirmed"
  | "not_applicable";

export type RequestItemFreshness =
  | "current_new"
  | "inherited"
  | "unconfirmed";

export interface StoredRequestProjectionState {
  exchangeId: string;
  projectionVersion?: number;
  contextMode: RequestContextMode;
  contextEpoch?: number;
  effectiveBoundaryId?: string;
  producedBoundaryId?: string;
  requestFilterState: "complete" | "limited";
  nativeTurnId?: string;
  nativeTurnStable: boolean;
  filterItems: ExchangeContentFilterItem[];
}

export interface CurrentRequestProjectionState {
  exchangeId: string;
  projectionVersion?: number;
  contextMode: RequestContextMode;
  requestFilterState: "complete" | "limited";
  nativeTurnId?: string;
  nativeTurnStable: boolean;
  filterItems: ExchangeContentFilterItem[];
  boundaryCandidates: ContextBoundaryCandidate[];
}

export interface RequestOccurrenceDecision {
  item: ExchangeContentFilterItem;
  freshness: RequestItemFreshness;
}

export interface ResolvedRequestContextProjection {
  context: ConversationRequestContext;
  requestDedupeState: RequestDedupeState;
  decisions: RequestOccurrenceDecision[];
}

/** 消失容忍上限：基线中有界数量的条目消失时仍继续比较（缺失项永不标记 inherited）。 */
const MAX_BASELINE_MISSING_ITEMS = 3;

export function resolveRequestContextProjection(input: {
  current: CurrentRequestProjectionState;
  previous?: StoredRequestProjectionState;
}): ResolvedRequestContextProjection {
  const { current, previous } = input;
  if (
    previous
    && (current.projectionVersion ?? null) !== (previous.projectionVersion ?? null)
  ) {
    return unconfirmed(current, previous.contextEpoch);
  }
  const beforeBoundaryId = lastBoundaryId(
    current.exchangeId,
    current.boundaryCandidates,
    "before_request",
  );
  const producedBoundaryId = lastBoundaryId(
    current.exchangeId,
    current.boundaryCandidates,
    "after_exchange",
  );

  // epoch 持续化（2026-09-17）：unconfirmed 也物化可推导的 epoch，下一步以上一步
  // items 为新基线恢复比较——单步排重失败不再级联到会话结束。
  const carriedEpoch = previous?.contextEpoch === undefined
    ? undefined
    : previous.contextEpoch
      + (previous.producedBoundaryId !== undefined ? 1 : 0)
      + (beforeBoundaryId !== undefined ? 1 : 0);

  if (
    current.contextMode === "stateful_delta"
    || current.contextMode === "unknown"
  ) {
    return {
      context: {
        contextMode: current.contextMode,
        contextEpoch: previous?.contextEpoch ?? 0,
        producedBoundaryId,
        comparisonKind: "none",
        resolution: "resolved",
      },
      requestDedupeState: "not_applicable",
      decisions: current.filterItems.map(item => ({
        item,
        freshness: "current_new",
      })),
    };
  }

  if (
    previous
    && (
      previous.contextEpoch === undefined
      || previous.requestFilterState !== "complete"
    )
  ) {
    return unconfirmed(current, carriedEpoch);
  }

  const priorBoundaryAdvance = previous?.producedBoundaryId !== undefined;
  const currentBoundaryAdvance = beforeBoundaryId !== undefined;
  const contextEpoch = previous
    ? previous.contextEpoch!
      + (priorBoundaryAdvance ? 1 : 0)
      + (currentBoundaryAdvance ? 1 : 0)
    : currentBoundaryAdvance ? 1 : 0;
  const effectiveBoundaryId = beforeBoundaryId
    ?? previous?.producedBoundaryId
    ?? previous?.effectiveBoundaryId;

  if (current.requestFilterState !== "complete") return unconfirmed(current, carriedEpoch);

  if (!previous) {
    if (beforeBoundaryId) return unconfirmed(current, contextEpoch);
    return {
      context: {
        contextMode: current.contextMode,
        contextEpoch,
        producedBoundaryId,
        comparisonKind: "none",
        resolution: "resolved",
      },
      requestDedupeState: "not_required",
      decisions: current.filterItems.map(item => ({
        item,
        freshness: "current_new",
      })),
    };
  }

  const boundaryCarryover = priorBoundaryAdvance || currentBoundaryAdvance;
  const decisions = boundaryCarryover
    ? compareBoundaryCarryover(current, previous)
    : compareSameEpoch(current.filterItems, previous.filterItems);
  if (!decisions) return unconfirmed(current, contextEpoch);

  return {
    context: {
      contextMode: current.contextMode,
      contextEpoch,
      effectiveBoundaryId,
      producedBoundaryId,
      comparisonKind: boundaryCarryover
        ? "boundary_carryover"
        : "same_epoch",
      baselineExchangeId: previous.exchangeId,
      resolution: "resolved",
    },
    requestDedupeState: "compared",
    decisions,
  };
}

function compareSameEpoch(
  current: ExchangeContentFilterItem[],
  baseline: ExchangeContentFilterItem[],
): RequestOccurrenceDecision[] | undefined {
  const currentCounts = fingerprintCounts(current);
  const baselineCounts = new Map<string, number>();
  const controlFingerprints = new Set<string>();
  let nonControlTotal = 0;
  for (const item of baseline) {
    baselineCounts.set(item.fingerprint, (baselineCounts.get(item.fingerprint) ?? 0) + 1);
    if (item.category === "control") {
      controlFingerprints.add(item.fingerprint);
    } else {
      nonControlTotal += 1;
    }
  }
  // 有界消失容忍：客户端会整体替换个别 plumbing 消息（实测 claude-code 每步重写
  // 计数器信封）。control（compaction 标记/计数器等协议 Plumbing）豁免缺失校验——
  // 其消失/替换不影响对话连续性；其余条目缺失 ≤ 上限时继续比较，缺失项从消费池
  // 移除，永不冒充 inherited；大比例消失（真实 compaction）仍诚实 unconfirmed。
  let nonControlMissing = 0;
  const removed = new Map<string, number>();
  for (const [fingerprint, count] of baselineCounts) {
    if (controlFingerprints.has(fingerprint)) continue;
    const have = currentCounts.get(fingerprint) ?? 0;
    if (have >= count) continue;
    nonControlMissing += count - have;
    removed.set(fingerprint, count - have);
  }
  const maxMissingItems = Math.min(
    MAX_BASELINE_MISSING_ITEMS,
    Math.max(2, Math.floor(nonControlTotal * 0.05)),
  );
  if (nonControlMissing > maxMissingItems) return undefined;
  const remaining = new Map(baselineCounts);
  for (const [fingerprint, missing] of removed) {
    const left = (remaining.get(fingerprint) ?? 0) - missing;
    if (left > 0) remaining.set(fingerprint, left);
    else remaining.delete(fingerprint);
  }
  return current.map(item => ({
    item,
    freshness: consume(remaining, item.fingerprint)
      ? "inherited"
      : "current_new",
  }));
}

function compareBoundaryCarryover(
  current: CurrentRequestProjectionState,
  baseline: StoredRequestProjectionState,
): RequestOccurrenceDecision[] | undefined {
  const hasIdlessCurrent = current.filterItems.some(
    item => !item.providerLineageKey,
  );
  const stableTurnContinuity = current.nativeTurnStable
    && baseline.nativeTurnStable
    && !!current.nativeTurnId
    && current.nativeTurnId === baseline.nativeTurnId;
  if (hasIdlessCurrent && !stableTurnContinuity) return undefined;

  const lineageCounts = compositeCounts(
    baseline.filterItems.filter(item => !!item.providerLineageKey),
  );
  const idlessCounts = fingerprintCounts(
    baseline.filterItems.filter(item => !item.providerLineageKey),
  );
  return current.filterItems.map(item => {
    if (item.providerLineageKey) {
      return {
        item,
        freshness: consume(
          lineageCounts,
          compositeKey(item),
        )
          ? "inherited"
          : "current_new",
      };
    }
    return {
      item,
      freshness: consume(idlessCounts, item.fingerprint)
        ? "inherited"
        : "current_new",
    };
  });
}

function lastBoundaryId(
  exchangeId: string,
  candidates: ContextBoundaryCandidate[],
  phase: ContextBoundaryCandidate["effectivePhase"],
): string | undefined {
  const matching = candidates.filter(
    candidate => candidate.effectivePhase === phase,
  );
  const candidate = matching.at(-1);
  if (!candidate) return undefined;
  if (candidate.providerItemId) {
    return `boundary:provider:${boundedIdentity(candidate.providerItemId)}`;
  }
  return `boundary:${createHash("sha256").update(JSON.stringify({
    exchangeId,
    logicalId: candidate.logicalId,
    occurrenceOrdinal: candidate.occurrenceOrdinal,
    phase,
    encryptedContentSha256: candidate.encryptedContentSha256,
  })).digest("hex")}`;
}

function fingerprintCounts(
  items: ExchangeContentFilterItem[],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    counts.set(item.fingerprint, (counts.get(item.fingerprint) ?? 0) + 1);
  }
  return counts;
}

function compositeCounts(
  items: ExchangeContentFilterItem[],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const key = compositeKey(item);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function compositeKey(item: ExchangeContentFilterItem): string {
  return JSON.stringify([
    item.providerLineageKey ?? "",
    item.fingerprint,
  ]);
}

function consume(counts: Map<string, number>, key: string): boolean {
  const count = counts.get(key) ?? 0;
  if (count <= 0) return false;
  if (count === 1) counts.delete(key);
  else counts.set(key, count - 1);
  return true;
}

function unconfirmed(
  current: CurrentRequestProjectionState,
  contextEpoch?: number,
): ResolvedRequestContextProjection {
  return {
    context: {
      contextMode: current.contextMode,
      comparisonKind: "none",
      resolution: "unconfirmed",
      ...(contextEpoch !== undefined ? {contextEpoch} : {}),
    },
    requestDedupeState: "unconfirmed",
    decisions: current.filterItems.map(item => ({
      item,
      freshness: "unconfirmed",
    })),
  };
}

function boundedIdentity(value: string): string {
  return value.length <= 512 ? value : createHash("sha256").update(value).digest("hex");
}
