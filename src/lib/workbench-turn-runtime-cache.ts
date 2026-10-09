import type {
  WorkbenchContextSnapshot,
  WorkbenchStepDiff,
} from "./app-state";
import type {
  AgentStep,
  AuxiliaryExchange,
  HarnessLearningInsight,
} from "./harness";

export const WORKBENCH_TURN_RUNTIME_CACHE_CAPACITY = 8;

export interface TurnStepsPageCacheEntry {
  candidateCount: number;
  loaded: number;
  hasMore: boolean;
  nextCursor?: string;
}

export interface WorkbenchTurnRuntimeCache {
  /** 从最近访问到最久未访问排序。 */
  lruTurnIds: string[];
  pages: Record<string, TurnStepsPageCacheEntry>;
  steps: AgentStep[];
  snapshots: WorkbenchContextSnapshot[];
  diffs: WorkbenchStepDiff[];
  auxiliaryExchanges: AuxiliaryExchange[];
  learningInsights: HarnessLearningInsight[];
}

export type WorkbenchTurnRuntimeCacheMutation = Partial<Omit<
  WorkbenchTurnRuntimeCache,
  "lruTurnIds"
>>;

/**
 * 合并一次已成功的请求结果，并按 Turn 一致淘汰所有运行时详情。
 * mutation 缺失代表请求未成功，必须保持原引用，避免失败请求推进 LRU。
 */
export function retainTurnRuntimeCaches(
  current: WorkbenchTurnRuntimeCache,
  mutation: WorkbenchTurnRuntimeCacheMutation | undefined,
  accessedTurnIds: readonly string[],
  protectedTurnIds: readonly string[],
): WorkbenchTurnRuntimeCache {
  if (!mutation) return current;

  const candidate: WorkbenchTurnRuntimeCache = {
    ...current,
    ...mutation,
    lruTurnIds: current.lruTurnIds,
  };
  const stepTurnById = new Map(candidate.steps.map(item => [item.id, item.turnId]));
  const knownTurnIds = collectKnownTurnIds(candidate, stepTurnById);
  const protectedKnownTurnIds = uniqueTurnIds(protectedTurnIds)
    .filter(turnId => knownTurnIds.has(turnId));
  if (protectedKnownTurnIds.length > WORKBENCH_TURN_RUNTIME_CACHE_CAPACITY) {
    throw new RangeError("受保护的 Workbench Turn 数量超过运行时缓存容量");
  }

  const lruTurnIds = uniqueTurnIds(current.lruTurnIds)
    .filter(turnId => knownTurnIds.has(turnId));
  for (const turnId of uniqueTurnIds(accessedTurnIds)) {
    if (!knownTurnIds.has(turnId)) continue;
    const previousIndex = lruTurnIds.indexOf(turnId);
    if (previousIndex >= 0) lruTurnIds.splice(previousIndex, 1);
    lruTurnIds.unshift(turnId);
  }
  for (const turnId of knownTurnIds) {
    if (!lruTurnIds.includes(turnId)) lruTurnIds.push(turnId);
  }

  const retainedTurnIds = new Set(protectedKnownTurnIds);
  for (const turnId of lruTurnIds) {
    if (retainedTurnIds.size >= WORKBENCH_TURN_RUNTIME_CACHE_CAPACITY) break;
    retainedTurnIds.add(turnId);
  }
  const retainedLruTurnIds = lruTurnIds.filter(turnId => retainedTurnIds.has(turnId));
  const retainedSteps = candidate.steps.filter(item => retainedTurnIds.has(item.turnId));
  const retainedStepIds = new Set(retainedSteps.map(item => item.id));

  return {
    lruTurnIds: retainedLruTurnIds,
    pages: Object.fromEntries(
      Object.entries(candidate.pages).filter(([turnId]) => retainedTurnIds.has(turnId)),
    ),
    steps: retainedSteps,
    snapshots: candidate.snapshots.filter(item => retainedStepIds.has(item.stepId)),
    diffs: candidate.diffs.filter(item => retainedStepIds.has(item.toStepId)),
    auxiliaryExchanges: candidate.auxiliaryExchanges.filter(
      item => Boolean(item.agentTurnId && retainedTurnIds.has(item.agentTurnId)),
    ),
    learningInsights: candidate.learningInsights.filter(item => retainedTurnIds.has(item.turnId)),
  };
}

function collectKnownTurnIds(
  cache: WorkbenchTurnRuntimeCache,
  stepTurnById: ReadonlyMap<string, string>,
): Set<string> {
  return new Set([
    ...Object.keys(cache.pages),
    ...cache.steps.map(item => item.turnId),
    ...cache.snapshots.map(item => stepTurnById.get(item.stepId) || ""),
    ...cache.diffs.map(item => stepTurnById.get(item.toStepId) || ""),
    ...cache.auxiliaryExchanges.map(item => item.agentTurnId || ""),
    ...cache.learningInsights.map(item => item.turnId),
  ].filter(Boolean));
}

function uniqueTurnIds(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
