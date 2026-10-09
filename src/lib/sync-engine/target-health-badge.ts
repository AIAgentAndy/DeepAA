/**
 * 供应商健康标识（2026-09-20 用户确认设计）。
 *
 * 供应商管理侧栏与仪表盘供应商卡的「单标识」机制：每个目标同一时刻最多展示
 * 一个健康标识，按声明式优先级表取唯一赢家。现有标识全集：
 * - `account_gap`    「账号未设置」        红：按量 + 分组倍率目标没配控制台账号；
 * - `plan_gap`       「套餐（订阅）未设置」 红：套餐/订阅目标没保存套餐同步；
 * - `sync_failure`   「同步失败」          红：账号链或套餐链连续两次自动同步失败；
 * - `rate_unverified`「倍率未校验」        黄红：有远端倍率证据但同步未正常运行；
 * - `rate_unconfirmed`「倍率待确认」       黄：同步正常但远端这一次没返回倍率。
 *
 * 判定只做提醒，绝不影响同步任务的自动执行；任何一次成功（自动或手动）
 * 都会把连续失败计数清零，标识随之自动消失（2026-09-20 用户确认）。
 *
 * 本模块与 `rate-warning.ts` 的关系：倍率类判定完全复用 `resolveRateWarning`
 * （不重写口径），本模块只负责叠加「同步失败」信号并按优先级收敛为唯一标识。
 * 未来新增标识 = 在 kind 联合类型、优先级表与文案构造处各加一行。
 */

import {
  rateWarningTitle,
  resolveRateWarning,
  type RateWarningInput,
  type RateWarningState,
} from "@/lib/sync-engine/rate-warning";
import {resolveOfficialPresetForTarget} from "@/lib/provider-preset-capabilities";
import {resolvePlanProviderForTarget} from "@/lib/sync-engine/plan-provider";
import type {SyncOverviewTargetSummary} from "@/lib/sync-engine/overview-types";
import type {ProxyTarget} from "@/types";

/**
 * 「同步失败」红标的触发门槛按**失败类别**策略化（2026-09-20 用户确认）：
 * 「连续两次」只是默认场景——凭证/鉴权类失败基本会持续失败且需要尽快人工
 * 介入（换密钥/重新登录），一次即亮；未来新类别（如链接不通需更容忍再亮）
 * 在 `TargetSyncFailureKind` 联合类型与本表各加一行即可。
 * 读取端对未知类别一律回退默认门槛，保证旧库/新版数据前向兼容。
 */
export const SYNC_FAILURE_THRESHOLDS: Readonly<Record<string, number>> = {
  auth: 1,
  default: 2,
};

/** 默认门槛（未知类别 / 未声明类别的回退值）。 */
export const SYNC_FAILURE_DEFAULT_THRESHOLD = SYNC_FAILURE_THRESHOLDS.default!;

function syncFailureThreshold(kind: string | null | undefined): number {
  return SYNC_FAILURE_THRESHOLDS[kind ?? "default"] ?? SYNC_FAILURE_DEFAULT_THRESHOLD;
}

/** 标识种类；新增标识时在此追加并在优先级表登记。 */
export type TargetBadgeKind =
  | "account_gap"
  | "plan_gap"
  | "sync_failure"
  | "rate_unverified"
  | "rate_unconfirmed";

/**
 * 唯一标识的展示优先级（高 → 低）：
 * 配置缺口（永远不会同步成功）> 同步失败（配了但连续失败）> 倍率类提醒。
 */
export const BADGE_PRIORITY: readonly TargetBadgeKind[] = [
  "account_gap",
  "plan_gap",
  "sync_failure",
  "rate_unverified",
  "rate_unconfirmed",
];

/** 视觉严重度：severe = 红（配置缺口 / 同步失败 / 倍率未校验）；normal = 黄。 */
export type TargetBadgeSeverity = "normal" | "severe";

export interface TargetHealthBadge {
  kind: TargetBadgeKind;
  severity: TargetBadgeSeverity;
  /** 标记内文字（如「同步失败」）。 */
  label: string;
  /** 悬浮说明：事实 + 下一步动作。 */
  title: string;
}

export interface TargetBadgeInput extends RateWarningInput {
  /** 账号链（余额/倍率）连续自动同步失败次数；未配置账号时保持 0。 */
  accountConsecutiveFailures?: number;
  accountLastError?: string | null;
  /** 账号链最近一次失败的类别（auth = 凭证/鉴权，一次即亮；null = 走默认门槛）。 */
  accountFailureKind?: string | null;
  /** 套餐链连续自动同步失败次数；未保存套餐同步时保持 0。 */
  planConsecutiveFailures?: number;
  planLastError?: string | null;
  /** 套餐链最近一次失败的类别（auth = 凭证/鉴权，一次即亮；null = 走默认门槛）。 */
  planFailureKind?: string | null;
}

/** 倍率类标识的视觉档位：只有「倍率待确认」是黄，其余（含配置缺口）均为红。 */
function rateKindSeverity(kind: TargetBadgeKind): TargetBadgeSeverity {
  return kind === "rate_unconfirmed" ? "normal" : "severe";
}

/** 倍率判定结果 → 标识 kind；none 不参与竞争。 */
function rateWarningKind(state: RateWarningState): TargetBadgeKind | null {
  if (state.severity === "none") return null;
  if (state.configurationGap && state.gap === "account") return "account_gap";
  if (state.configurationGap && state.gap === "plan") return "plan_gap";
  return state.severity === "severe" ? "rate_unverified" : "rate_unconfirmed";
}

const BADGE_LABEL: Record<TargetBadgeKind, string> = {
  account_gap: "账号未设置",
  plan_gap: "套餐（订阅）未设置",
  sync_failure: "同步失败",
  rate_unverified: "倍率未校验",
  rate_unconfirmed: "倍率待确认",
};

/** 鉴权/凭证类失败的类别提示：一次即亮的场景必须在文案里说清根因与动作。 */
const FAILURE_KIND_HINT: Readonly<Record<string, string>> = {
  auth: "（凭证/鉴权失败，请检查密钥或重新登录）",
};

function syncFailureTitle(input: TargetBadgeInput, targetName?: string): string {
  const subject = targetName ? `${targetName}：` : "";
  const chains: string[] = [];
  if ((input.accountConsecutiveFailures ?? 0) >= syncFailureThreshold(input.accountFailureKind)) {
    chains.push(`账号同步（余额/倍率）连续失败 ${input.accountConsecutiveFailures} 次`
      + (FAILURE_KIND_HINT[input.accountFailureKind ?? ""] ?? "")
      + (input.accountLastError ? `：${input.accountLastError}` : ""));
  }
  if ((input.planConsecutiveFailures ?? 0) >= syncFailureThreshold(input.planFailureKind)) {
    chains.push(`套餐同步连续失败 ${input.planConsecutiveFailures} 次`
      + (FAILURE_KIND_HINT[input.planFailureKind ?? ""] ?? "")
      + (input.planLastError ? `：${input.planLastError}` : ""));
  }
  return `${subject}${chains.join("；")}。自动同步仍在按周期重试，恢复成功后标识会自动消失；`
    + "可到概览检查账号与密钥配置，或手动「立即同步 / 同步套餐」定位问题";
}

/**
 * 解析单个供应商的唯一健康标识。
 * 门控与 `resolveRateWarning` 一致：停用目标不提醒；同步事实未返回（首帧）保持沉默。
 */
export function resolveTargetBadge(input: TargetBadgeInput, targetName?: string): TargetHealthBadge | null {
  if (input.enabled === false) return null;
  if (input.factsLoaded === false) return null;

  const candidates = new Set<TargetBadgeKind>();
  const rateState = resolveRateWarning(input);
  const rateKind = rateWarningKind(rateState);
  if (rateKind) candidates.add(rateKind);

  // 两条链（账号 / 套餐）任一达到「其最近一次失败类别」的门槛即命中；
  // 凭证/鉴权类（auth）一次即亮，默认类别连续两次。计数只在对应配置存在时才会增长。
  const accountFailing = input.hasConsoleAccount === true
    && (input.accountConsecutiveFailures ?? 0) >= syncFailureThreshold(input.accountFailureKind);
  const planFailing = input.hasPlanConfig === true
    && (input.planConsecutiveFailures ?? 0) >= syncFailureThreshold(input.planFailureKind);
  if (accountFailing || planFailing) candidates.add("sync_failure");

  for (const kind of BADGE_PRIORITY) {
    if (!candidates.has(kind)) continue;
    if (kind === "sync_failure") {
      return {kind, severity: "severe", label: BADGE_LABEL.sync_failure, title: syncFailureTitle(input, targetName)};
    }
    // 其余 kind 只能来自倍率判定，文案沿用 rate-warning 的口径。
    return {
      kind,
      severity: rateKindSeverity(kind),
      label: BADGE_LABEL[kind],
      title: rateWarningTitle(rateState, targetName),
    };
  }
  return null;
}

/**
 * 仪表盘供应商卡消费的 status 投影的最小结构（`ProxySyncStatus` 结构兼容）。
 * 用结构化类型避免 lib 模块反向依赖组件层类型。
 */
export interface TargetSyncStatusLike {
  account: {
    status: string;
    lastSyncError: string | null;
    consecutiveAutoFailures?: number;
    consecutiveFailureKind?: string | null;
  } | null;
  credentialComparison?: ReadonlyArray<{
    credentialId: string;
    label: string;
    matched: boolean;
    remoteName?: string;
    ratio?: number;
    reason?: string;
  }> | null;
  plan: {
    config: {
      lastSyncError: string | null;
      consecutiveAutoFailures?: number;
      consecutiveFailureKind?: string | null;
    } | null;
  };
}

/** 两个列表共用的目标侧派生字段（预设判定与套餐适配器存在性）。 */
function targetDerivedFacts(target: ProxyTarget) {
  return {
    // 与概览页「密钥同步」模块同一判定：官方预设的密钥是无分组倍率的单条 API Key。
    usesGroupRates: !resolveOfficialPresetForTarget(target),
    billingChannel: target.billingChannel ?? "pay_as_you_go",
    hasPlanAdapter: Boolean(resolvePlanProviderForTarget(target)),
    // 列表要把「同步配置没补上」直接说成「账号未设置 / 套餐（订阅）未设置」（2026-09-18）。
    includeConfigurationGaps: true,
    enabled: target.enabled !== false,
  };
}

/** 供应商管理侧栏：从聚合概览接口构造徽标输入；概览未返回时首帧保持沉默。 */
export function badgeInputFromOverview(
  target: ProxyTarget,
  overview: SyncOverviewTargetSummary | undefined,
): TargetBadgeInput {
  if (!overview) {
    return {...targetDerivedFacts(target), hasConsoleAccount: false, factsLoaded: false};
  }
  return {
    ...targetDerivedFacts(target),
    unconfirmedCount: overview.rateUnconfirmedCount,
    unconfirmedLabels: overview.rateUnconfirmedLabels,
    hasConsoleAccount: overview.hasConsoleAccount,
    accountStatus: overview.accountStatus,
    hasPlanConfig: overview.hasPlanConfig,
    factsLoaded: true,
    accountConsecutiveFailures: overview.accountConsecutiveFailures,
    accountLastError: overview.accountLastError,
    accountFailureKind: overview.accountFailureKind,
    planConsecutiveFailures: overview.planConsecutiveFailures,
    planLastError: overview.planLastError,
    planFailureKind: overview.planFailureKind,
  };
}

/** 仪表盘供应商卡：从逐目标 status 接口构造徽标输入；status 未返回时首帧保持沉默。 */
export function badgeInputFromStatus(
  target: ProxyTarget,
  status: TargetSyncStatusLike | undefined,
): TargetBadgeInput {
  if (!status) {
    return {...targetDerivedFacts(target), hasConsoleAccount: false, factsLoaded: false};
  }
  return {
    ...targetDerivedFacts(target),
    unconfirmed: status.credentialComparison ?? null,
    hasConsoleAccount: Boolean(status.account),
    accountStatus: status.account?.status ?? null,
    hasPlanConfig: Boolean(status.plan.config),
    factsLoaded: true,
    accountConsecutiveFailures: status.account?.consecutiveAutoFailures ?? 0,
    accountLastError: status.account?.lastSyncError ?? null,
    accountFailureKind: status.account?.consecutiveFailureKind ?? null,
    planConsecutiveFailures: status.plan.config?.consecutiveAutoFailures ?? 0,
    planLastError: status.plan.config?.lastSyncError ?? null,
    planFailureKind: status.plan.config?.consecutiveFailureKind ?? null,
  };
}
