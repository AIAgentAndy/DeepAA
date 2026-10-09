import type {SiteUsageRecord} from "./site-usage";

const MATCH_TOLERANCE_MS = 30_000;
// 弱匹配时间容忍度（2026-09-26 用户确认）：不使用 Token 数值，仅凭
// 模型+协议端点+完成时间+唯一性归属，主要覆盖 502 等无真实用量的错误行。
const WEAK_TOLERANCE_MS = 60_000;
// 弱-B 簇由相邻 ≤60s 的行串成，簇直径可能超过 60s；配对后每对仍须 ≤120s。
const WEAK_PAIR_TOLERANCE_MS = 120_000;

/** 本地有界账本投影。requestId 若存在，只能来自经派生索引保存的站点响应 ID。 */
export interface LocalUsageRecord {
  exchangeId: string;
  targetId: string;
  requestId?: string;
  model: string;
  endpoint?: string;
  capturedAt: string;
  completedAt: string;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  actualCostNano: number;
  resultClass: string;
  usageSource: string;
}

export interface UsageMatch {
  site: SiteUsageRecord;
  local: LocalUsageRecord;
  confidence: "exact" | "high" | "weak";
  deltaNano: number;
}

export interface UsageMatchResult {
  matched: UsageMatch[];
  unmatchedSite: SiteUsageRecord[];
  unmatchedLocal: LocalUsageRecord[];
  ambiguousCount: number;
}

function sameModel(site: SiteUsageRecord, local: LocalUsageRecord): boolean {
  return !!site.model && site.model.toLowerCase() === local.model.toLowerCase();
}

function sameModelAndEndpoint(site: SiteUsageRecord, local: LocalUsageRecord): boolean {
  return sameModel(site, local) && !!site.endpoint && site.endpoint === local.endpoint;
}

/**
 * sub2api 账单把 client_request_id 存成 `client:<UUID>`（resolveUsageBillingRequestID），
 * 本地存的是响应头里的裸 UUID；比对前剥掉站点侧前缀。
 */
function normalizedSiteRequestId(site: SiteUsageRecord): string | undefined {
  if (!site.requestId) return undefined;
  return site.requestId.startsWith("client:") ? site.requestId.slice("client:".length) : site.requestId;
}

/** 双方都有请求 ID 且不相等，即是不同请求，任何档位都不得再配。 */
function requestIdContradicts(site: SiteUsageRecord, local: LocalUsageRecord): boolean {
  const siteId = normalizedSiteRequestId(site);
  return !!siteId && !!local.requestId && siteId !== local.requestId;
}

function timeWithin(site: SiteUsageRecord, local: LocalUsageRecord, toleranceMs: number): boolean {
  // 两端记录时间均是结算/采集完成点；站点开始点须由其 duration 反推。
  const completed = Math.abs(Date.parse(site.completedAt) - Date.parse(local.completedAt));
  const started = site.durationMs !== undefined
    ? Math.abs(Date.parse(site.completedAt) - site.durationMs - Date.parse(local.capturedAt))
    : Number.POSITIVE_INFINITY;
  return Math.min(completed, started) <= toleranceMs;
}

function highConfidence(site: SiteUsageRecord, local: LocalUsageRecord): boolean {
  if (!sameModelAndEndpoint(site, local)
    || !["success", "cancelled"].includes(local.resultClass)
    || !["provider_usage", "provider_count_tokens", "reconstructed_stream_usage"].includes(local.usageSource)
    || site.inputTokens === undefined || site.cacheReadTokens === undefined
    || site.cacheWriteTokens === undefined || site.outputTokens === undefined
    || site.inputTokens !== local.inputTokens || site.cacheReadTokens !== local.cacheReadTokens
    || site.cacheWriteTokens !== local.cacheWriteTokens || site.outputTokens !== local.outputTokens) {
    return false;
  }
  return timeWithin(site, local, MATCH_TOLERANCE_MS);
}

/** 弱-A：不用任何 Token 数值，模型+端点+完成时间 ≤60s，双方 ID 不矛盾。 */
function weakCandidate(site: SiteUsageRecord, local: LocalUsageRecord): boolean {
  return sameModelAndEndpoint(site, local)
    && !requestIdContradicts(site, local)
    && timeWithin(site, local, WEAK_TOLERANCE_MS);
}

/**
 * 单档唯一配对：站点行恰好一个候选本地行，且该本地行不再被同档其它站点行争抢。
 * 返回配对与「有候选但未唯一」的站点行数（计入歧义）。
 */
function pairUniquely(
  siteIndices: number[],
  sites: readonly SiteUsageRecord[],
  locals: readonly LocalUsageRecord[],
  usedLocal: Set<number>,
  candidateOf: (site: SiteUsageRecord) => number[],
): Array<{siteIndex: number; localIndex: number}> {
  const candidates = new Map<number, number[]>();
  const localPopularity = new Map<number, number>();
  for (const siteIndex of siteIndices) {
    const list = candidateOf(sites[siteIndex]!).filter(index => !usedLocal.has(index));
    if (list.length === 0) continue;
    candidates.set(siteIndex, list);
    for (const index of list) {
      localPopularity.set(index, (localPopularity.get(index) ?? 0) + 1);
    }
  }
  const pairs: Array<{siteIndex: number; localIndex: number}> = [];
  for (const [siteIndex, list] of candidates) {
    if (list.length === 1 && localPopularity.get(list[0]!) === 1) {
      pairs.push({siteIndex, localIndex: list[0]!});
    }
  }
  // 同档内新配对互不争抢（每行唯一性已双向核对，此处仅登记占用）。
  for (const pair of pairs) usedLocal.add(pair.localIndex);
  return pairs;
}

interface WeakClusterEvent {
  time: number;
  siteIndex?: number;
  localIndex?: number;
}

/**
 * 弱-B 等量保序：同一模型+端点内把剩余行按时间串簇（相邻间隔 ≤60s）；
 * 簇内站点行数 = 本地行数时按时间顺序一一配对（每对仍须 ≤120s），
 * 行数不等的簇整体留给人工——数量相等本身是强证据，不等则证据不足。
 */
function pairOrderedClusters(
  siteIndices: number[],
  sites: readonly SiteUsageRecord[],
  locals: readonly LocalUsageRecord[],
  usedLocal: Set<number>,
  targetId: string,
): Array<{siteIndex: number; localIndex: number}> {
  // 按站点行自身的（模型, 端点）分组；缺端点的行不参与弱-B。
  const groups = new Map<string, number[]>();
  for (const siteIndex of siteIndices) {
    const site = sites[siteIndex]!;
    if (!site.model || !site.endpoint) continue;
    const key = `${site.model.toLowerCase()}\0${site.endpoint}`;
    const list = groups.get(key) ?? [];
    list.push(siteIndex);
    groups.set(key, list);
  }
  const pairs: Array<{siteIndex: number; localIndex: number}> = [];
  for (const [key, groupSiteIndices] of groups) {
    const [modelLower, endpoint] = key.split("\0");
    const localIndices: number[] = [];
    for (let index = 0; index < locals.length; index++) {
      if (usedLocal.has(index)) continue;
      const local = locals[index]!;
      // 同组本地候选：模型+端点一致，且不与组内任何站点行的请求 ID 矛盾。
      if (local.targetId === targetId
        && local.endpoint === endpoint && local.model.toLowerCase() === modelLower
        && !groupSiteIndices.some(siteIndex =>
          requestIdContradicts(sites[siteIndex]!, local))) {
        localIndices.push(index);
      }
    }
    if (groupSiteIndices.length === 0 || localIndices.length === 0) continue;
    const events: WeakClusterEvent[] = [
      ...groupSiteIndices.map(siteIndex => ({
        time: Date.parse(sites[siteIndex]!.completedAt), siteIndex,
      })),
      ...localIndices.map(localIndex => ({
        time: Date.parse(locals[localIndex]!.completedAt), localIndex,
      })),
    ].sort((a, b) => a.time - b.time);
    let cluster: WeakClusterEvent[] = [];
    const flush = () => {
      const clusterSites = cluster.filter(event => event.siteIndex !== undefined)
        .map(event => event.siteIndex!);
      const clusterLocals = cluster.filter(event => event.localIndex !== undefined)
        .map(event => event.localIndex!);
      if (clusterSites.length > 0 && clusterSites.length === clusterLocals.length) {
        // 时间并列时保序配对的方向不可判定（并发相同请求），整簇留给人工。
        const siteTimes = clusterSites.map(index => sites[index]!.completedAt);
        const localTimes = clusterLocals.map(index => locals[index]!.completedAt);
        if (new Set(siteTimes).size !== siteTimes.length
          || new Set(localTimes).size !== localTimes.length) {
          cluster = [];
          return;
        }
        clusterSites.sort((a, b) =>
          Date.parse(sites[a]!.completedAt) - Date.parse(sites[b]!.completedAt));
        clusterLocals.sort((a, b) =>
          Date.parse(locals[a]!.completedAt) - Date.parse(locals[b]!.completedAt));
        const zipped = clusterSites.map((siteIndex, position) => ({
          siteIndex, localIndex: clusterLocals[position]!,
        }));
        if (zipped.every(({siteIndex, localIndex}) =>
          Math.abs(Date.parse(sites[siteIndex]!.completedAt)
            - Date.parse(locals[localIndex]!.completedAt)) <= WEAK_PAIR_TOLERANCE_MS)) {
          pairs.push(...zipped);
          for (const {localIndex} of zipped) usedLocal.add(localIndex);
        }
      }
      cluster = [];
    };
    for (const event of events) {
      if (cluster.length > 0 && event.time - cluster[cluster.length - 1]!.time > WEAK_TOLERANCE_MS) {
        flush();
      }
      cluster.push(event);
    }
    flush();
  }
  return pairs;
}

/**
 * 分级瀑布匹配（2026-09-26 用户确认）：exact（request ID）→ high（四类真实
 * Token 全等）→ weak-A（模型+端点+时间唯一）→ weak-B（同簇等量保序）。
 * 每档只在上一档配对后的剩余双方之间寻找候选，先把能精准匹配的认领走，
 * 剩下的才是错误/不完整行的归属空间。估算 Token 不作为任何相等性证据。
 */
export function matchSiteUsage(
  siteRows: readonly SiteUsageRecord[],
  localRows: readonly LocalUsageRecord[],
  targetId: string,
  scopeVerified: boolean,
): UsageMatchResult {
  if (!scopeVerified) {
    return {matched: [], unmatchedSite: [...siteRows], unmatchedLocal: [...localRows], ambiguousCount: 0};
  }
  const usedLocal = new Set<number>();
  const matchedBySite = new Map<number, {localIndex: number; confidence: UsageMatch["confidence"]}>();
  const sites = [...siteRows];
  const locals = [...localRows];

  // —— 第 1 档 exact：归一化 request ID 相同 + 模型相同（ID 冲突的行保持歧义）。 ——
  const exactPairs = pairUniquely(
    sites.map((_, index) => index), sites, locals, usedLocal,
    site => locals.flatMap((local, index) =>
      local.targetId === targetId && site.requestId && local.requestId
        && normalizedSiteRequestId(site) === local.requestId
        && sameModel(site, local)
        && (!site.endpoint || !local.endpoint || site.endpoint === local.endpoint)
        ? [index] : []),
  );
  let exactAmbiguous = 0;
  for (const site of sites) {
    if (!site.requestId) continue;
    const candidateCount = locals.filter(local =>
      local.targetId === targetId && local.requestId
        && normalizedSiteRequestId(site) === local.requestId
        && sameModel(site, local)).length;
    if (candidateCount > 1) exactAmbiguous++;
  }
  for (const pair of exactPairs) {
    matchedBySite.set(pair.siteIndex, {localIndex: pair.localIndex, confidence: "exact"});
  }

  // —— 第 2 档 high：四类真实 Token 全等 + 30 秒；仅在剩余行之间。 ——
  const remainingAfterExact = sites
    .map((_, index) => index)
    .filter(index => !matchedBySite.has(index));
  const highPairs = pairUniquely(
    remainingAfterExact, sites, locals, usedLocal,
    site => locals.flatMap((local, index) =>
      local.targetId === targetId && !requestIdContradicts(site, local)
        && highConfidence(site, local) ? [index] : []),
  );
  for (const pair of highPairs) {
    matchedBySite.set(pair.siteIndex, {localIndex: pair.localIndex, confidence: "high"});
  }

  // —— 第 3 档 weak-A：模型+端点+≤60s+双向唯一；仅在剩余行之间。 ——
  const remainingAfterHigh = sites
    .map((_, index) => index)
    .filter(index => !matchedBySite.has(index));
  const weakPairs = pairUniquely(
    remainingAfterHigh, sites, locals, usedLocal,
    site => locals.flatMap((local, index) =>
      local.targetId === targetId && weakCandidate(site, local) ? [index] : []),
  );
  for (const pair of weakPairs) {
    matchedBySite.set(pair.siteIndex, {localIndex: pair.localIndex, confidence: "weak"});
  }

  // —— 第 4 档 weak-B：同模型+端点等量保序簇；仅在剩余行之间。 ——
  const remainingAfterWeakA = sites
    .map((_, index) => index)
    .filter(index => !matchedBySite.has(index));
  const orderedPairs = pairOrderedClusters(remainingAfterWeakA, sites, locals, usedLocal, targetId);
  for (const pair of orderedPairs) {
    matchedBySite.set(pair.siteIndex, {localIndex: pair.localIndex, confidence: "weak"});
  }

  const matched: UsageMatch[] = [];
  const unmatchedSite: SiteUsageRecord[] = [];
  let ambiguousCount = exactAmbiguous;
  sites.forEach((site, siteIndex) => {
    const hit = matchedBySite.get(siteIndex);
    if (hit) {
      const local = locals[hit.localIndex]!;
      matched.push({site, local, confidence: hit.confidence,
        deltaNano: site.amountNano - local.actualCostNano});
    } else {
      unmatchedSite.push(site);
      // 有任何本地候选（弱档）却未配上的站点行计入歧义，供 UI 提示需要人工。
      const hasWeakCandidate = locals.some((local, index) =>
        !usedLocal.has(index) && local.targetId === targetId && weakCandidate(site, local));
      if (hasWeakCandidate) ambiguousCount++;
    }
  });
  return {
    matched,
    unmatchedSite,
    unmatchedLocal: locals.filter((_, index) => !usedLocal.has(index)),
    ambiguousCount,
  };
}
