import {createHash} from "node:crypto";
import {matchSiteUsage, type UsageMatch, type UsageMatchResult} from "./matching";
import type {HourRow} from "./store";
import {ReconciliationStore, RESIDUAL_AUTO_APPLY_MAX_NANO} from "./store";
import type {SiteUsageSnapshot} from "./site-usage";

/** 两轮稳定观测要核验同一批规范化明细，而非只比合计和条数。 */
export function siteEvidenceHash(site: SiteUsageSnapshot, remoteKeyIds: readonly string[]): string {
  const rows = [...site.records].sort((a, b) => a.siteLogId.localeCompare(b.siteLogId));
  return createHash("sha256").update(JSON.stringify({
    source: site.source, amountNano: site.amountNano, complete: site.complete,
    detailsComplete: site.detailsComplete, limited: site.limited,
    candidateCount: site.candidateCount, processedCount: site.processedCount,
    remoteKeyIds: [...remoteKeyIds].sort(), rows,
  })).digest("hex");
}

/** 人工残差已经入账后，只有此前确立的匹配可参加后续金额更正与跨小时归桶。 */
export function accountingMatchesForHour(
  store: ReconciliationStore, hour: HourRow, matches: readonly UsageMatch[],
): UsageMatch[] {
  return hour.manualRevision > 0
    ? matches.filter(match => store.hasMatchedPair(
      hour.targetId, hour.providerType, match.site.siteLogId, match.local.exchangeId))
    : [...matches];
}

export interface ResidualAutoApplyDecision {
  eligible: boolean;
  unmatchedSiteSumNano: number;
  /** 本可自动但被上限拦下时，写给小时 reason 的人工可读解释。 */
  annotateReason?: string;
}

/**
 * 小时残差自动补判定（2026-09-28 用户确认）：瀑布四档跑完、匹配落账后，
 * 残差为正、满足恒等式 `残差 = 未匹配站点行金额之和 − 已残差补偿额`
 * （本地未匹配行金额为零）、两轮稳定、明细完整未截断、scope 已验证、
 * 本小时从未人工补过、未超上限时，残差自动落账。每一分自动补的钱都有站点
 * 明细行背书，不是笼统的差额平账；负残差（折扣/免单/归属歧义）与其它
 * 证据不足情形一律留人工。
 */
export function residualAutoApplyDecision(
  hour: HourRow, matches: UsageMatchResult, scopeVerified: boolean,
): ResidualAutoApplyDecision {
  let unmatchedSiteSumNano = 0;
  for (const row of matches.unmatchedSite) {
    unmatchedSiteSumNano += row.amountNano;
    if (!Number.isSafeInteger(unmatchedSiteSumNano)) {
      return {eligible: false, unmatchedSiteSumNano: Number.NaN};
    }
  }
  const start = Date.parse(hour.hourStartUtc);
  const end = start + 3_600_000;
  let unmatchedLocalSumNano = 0;
  for (const record of matches.unmatchedLocal) {
    const completed = Date.parse(record.completedAt);
    if (completed >= start && completed < end) {
      unmatchedLocalSumNano += record.actualCostNano;
    }
  }
  const baseQualifies = scopeVerified && hour.status === "needs_review"
    && hour.stableCount >= 2 && hour.siteDetailsComplete && !hour.siteLimited
    && !hour.localLimited && hour.manualRevision === 0
    && hour.residualNano !== null && hour.residualNano > 0
    && hour.residualNano === unmatchedSiteSumNano - hour.residualAppliedNano
    && unmatchedLocalSumNano === 0;
  return {
    eligible: baseQualifies && hour.residualNano! <= RESIDUAL_AUTO_APPLY_MAX_NANO,
    unmatchedSiteSumNano,
    ...(baseQualifies && hour.residualNano! > RESIDUAL_AUTO_APPLY_MAX_NANO
      ? {annotateReason:
        `小时残差 $${(hour.residualNano! / 1e9).toFixed(2)} 超过自动补上限 $10，需人工复核`}
      : {}),
  };
}

/**
 * 站点取数、密钥归属与本地投影三者都完成后才计算小时余额。
 * 本模块不接触登录凭据，也不扫描 raw；账号访问由 SyncService 注入。
 */
export async function reviewDueReconciliationHours(input: {
  store: ReconciliationStore;
  nowIso: string;
  fetchSite: (hour: HourRow) => Promise<SiteUsageSnapshot>;
  remoteKeyIds: (hour: HourRow) => Promise<readonly string[]>;
  /** 已定稿小时的轻量复查（stat/日总数键）；键未变时跳过完整取数。 */
  lightCheck?: (hour: HourRow) => Promise<string | undefined>;
  /** 复核资格门禁（2026-09-28 用户确认）：目标停用/账号异常时不发起任何站点请求。 */
  eligible?: (hour: HourRow) => boolean;
  /** 残差补差行的人民币物化系数：目标当前 settlementFx（与人工补差同口径）。 */
  settlementFx?: (hour: HourRow) => number;
}): Promise<void> {
  for (const hour of input.store.dueHours(input.nowIso)) {
    try {
      if (input.eligible && !input.eligible(hour)) {
        input.store.touchHourChecked(hour.targetId, hour.hourStartUtc, input.nowIso,
          "目标停用或账号异常，暂停核对");
        continue;
      }
      if (input.lightCheck && hour.siteLightCheck
        && ["balanced", "applied", "ignored", "needs_review"].includes(hour.status)) {
        const light = await input.lightCheck(hour).catch(() => undefined);
        if (light !== undefined && light === hour.siteLightCheck) {
          input.store.touchHourChecked(hour.targetId, hour.hourStartUtc, input.nowIso);
          continue;
        }
      }
      const site = await input.fetchSite(hour);
      // 站点连续失败按目标指数退避，成功立即清零；防止 5 分钟重试形成登录风暴。
      input.store.recordSiteOutcome(hour.targetId, site.complete,
        site.reason ?? "站点取数不完整", input.nowIso);
      const local = input.store.loadLocalHour(hour.targetId, hour.hourStartUtc);
      const keyIds = new Set(await input.remoteKeyIds(hour));
      // 只有完整逐条明细才能剥除同账号其它目标使用的密钥；统计额不提供密钥 ID。
      const scopeVerified = site.complete && site.detailsComplete
        && keyIds.size > 0 && site.records.every(row => row.apiKeyId !== undefined);
      const scoped = scopeVerified
        ? site.records.filter(row => keyIds.has(row.apiKeyId!)) : site.records;
      const scopedAmount = scopeVerified
        ? scoped.reduce((sum, row) => sum + row.amountNano, 0) : site.amountNano;
      const matches = matchSiteUsage(scoped, local.records, hour.targetId,
        scopeVerified && local.complete);
      const accountingMatches = accountingMatchesForHour(input.store, hour, matches.matched);
      const withheldMatches = matches.matched.length - accountingMatches.length;
      const comparable = input.store.comparableLocalHour(
        hour.targetId, hour.hourStartUtc, local, accountingMatches,
      );
      const hourEnd = Date.parse(hour.hourStartUtc) + 3_600_000;
      const currentMatchedIds = new Set(accountingMatches.map(match => match.local.exchangeId));
      const boundaryPending = scopeVerified && site.detailsComplete
        && Date.parse(input.nowIso) < hourEnd + 3 * 3_600_000 + 20 * 60_000
        && local.records.some(record => {
          const ended = Date.parse(record.completedAt);
          return ended >= hourEnd - 30_000 && ended < hourEnd
            && !currentMatchedIds.has(record.exchangeId)
            && !input.store.hasMatchedLocal(record.exchangeId);
        });
      const localComplete = local.complete && comparable !== null && !boundaryPending
        && !input.store.hasPendingDerivation(hour.targetId, hour.hourStartUtc);
      const checked = input.store.observeHour({
        targetId: hour.targetId, hourStartUtc: hour.hourStartUtc,
        siteAmountNano: site.complete ? scopedAmount : null,
        localAmountNano: comparable,
        candidateCount: site.candidateCount, processedCount: site.processedCount,
        limited: site.limited, detailsComplete: site.detailsComplete,
        localComplete, localCandidateCount: local.candidateCount,
        localProcessedCount: local.processedCount,
        matchedCount: accountingMatches.length,
        unmatchedSiteCount: matches.unmatchedSite.length + withheldMatches,
        source: site.source, observedAt: input.nowIso,
        siteEvidenceHash: siteEvidenceHash(site, [...keyIds]),
        ...(site.complete && site.lightCheckKey
          ? {siteLightCheck: site.lightCheckKey} : {}),
        reason: site.reason ?? (withheldMatches > 0
          ? "人工补差后出现新的逐条归属，为防重复补账仅展示证据，不再自动补同一差额"
          : boundaryPending
          ? "整点附近请求等待下一小时归属，不得按临时差额补账"
          : !scopeVerified ? "站点密钥范围未唯一验证，仅供人工复核" : undefined),
      });
      if (checked.status !== "ignored"
        && checked.stableCount >= 2 && scopeVerified && localComplete
        && accountingMatches.length > 0) {
        input.store.applyMatches(hour.targetId, hour.hourStartUtc, accountingMatches);
      }
      // 小时残差自动补（2026-09-28）：匹配落账后重读小时再判定，残差以
      // 本轮逐条差额入账后的净额为准；快照竞态只退回人工，不算站点失败。
      const settled = checked.status === "ignored"
        ? undefined : input.store.getHour(hour.targetId, hour.hourStartUtc);
      if (settled) {
        const decision = residualAutoApplyDecision(settled, matches, scopeVerified);
        if (decision.eligible) {
          try {
            input.store.applyResidual(hour.targetId, hour.hourStartUtc, {
              expectedResidualNano: settled.residualNano!,
              unmatchedSiteSumNano: decision.unmatchedSiteSumNano,
              ...(input.settlementFx
                ? {fxRateToCny: input.settlementFx(hour)} : {}),
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : "";
            if (message !== "RECONCILIATION_SNAPSHOT_CHANGED"
              && message !== "RECONCILIATION_RESIDUAL_NOT_ELIGIBLE") {
              throw error;
            }
            input.store.touchHourChecked(hour.targetId, hour.hourStartUtc, input.nowIso,
              "小时残差自动补前快照变化，需人工复核");
          }
        } else if (decision.annotateReason) {
          input.store.touchHourChecked(hour.targetId, hour.hourStartUtc,
            input.nowIso, decision.annotateReason);
        }
      }
    } catch (error) {
      const message = error instanceof Error
        ? error.message.slice(0, 256) : "站点小时复核失败";
      input.store.recordSiteOutcome(hour.targetId, false, message, input.nowIso);
      input.store.recordObservationFailure(
        hour.targetId,
        hour.hourStartUtc,
        message,
        input.nowIso,
      );
    }
  }
}
