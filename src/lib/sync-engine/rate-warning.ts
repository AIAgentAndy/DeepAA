/**
 * 中转站倍率同步提醒（2026-09-18 用户决策）。
 *
 * 背景：`newapi` / `sub2api` 适配器会按「系统密钥 vs 对方网站密钥」逐条对比，
 * 产出 `matched`（远端找到该密钥）与 `ratio`（远端返回的有效倍率）。
 * 当远端**找到了密钥但没返回有效倍率**（分组未配置倍率、站点未开放该分组等），
 * 旧实现会走破坏性级联：清密钥倍率 → 收回全部 Agent 适用 → 切换/清除默认密钥
 * → 解绑供应商 → 断开设入连接。
 *
 * 该级联会在站点侧数据不完整（而非用户配置错误）时误伤用户的接入配置，
 * 且用户无法从页面判断「到底是真的失效还是站点没返回」。新语义：
 * **只做提醒让用户去站点确认实际倍率，绝不改动密钥/模型/Agent 的任何关联。**
 *
 * 两级严重度（2026-09-18 追加用户确认）：
 * - `normal`（黄）：控制台账号同步正常，只是远端这一次没返回倍率 → 去站点核对即可；
 * - `severe`（黄红，更显眼）：根本没法校验倍率 —— 没有控制台账号、账号同步未成功，
 *   或者（按分组倍率计费的中转站目标）连账号同步都没配置。
 *
 * 本模块只提供纯函数判定，写入端（SyncService）与读取端（概览接口 / 页面）
 * 共用同一判定，避免「同步时判断一次、展示时又判断一次」产生口径漂移。
 */

import type {BillingChannel} from "@/types";
import type {CredentialComparisonItem} from "@/lib/sync-engine/types";

/** 黄标判定：远端匹配成功但倍率缺失。 */
export function isRateUnconfirmed(item: CredentialComparisonItem): boolean {
  return item.matched && item.ratio === undefined;
}

/** 全部需要黄标提醒的密钥（保持远端返回顺序）。 */
export function rateUnconfirmedCredentials(
  comparison: readonly CredentialComparisonItem[] | null | undefined,
): CredentialComparisonItem[] {
  return (comparison ?? []).filter(isRateUnconfirmed);
}

/**
 * 同步结果提示文案：只说明「远端没返回倍率、去站点确认」。
 * 供应商列表与概览密钥行的标记都从 `credentialComparison` 直接派生，
 * 不依赖这段文案。这里刻意不复述「本系统不会改动密钥/模型/Agent 关联」
 * 这类内部保证（2026-09-18 用户确认：没必要提醒到用户）。
 */
export function rateUnconfirmedNotes(
  comparison: readonly CredentialComparisonItem[] | null | undefined,
): string[] {
  return rateUnconfirmedCredentials(comparison).map(item => (
    `密钥「${item.label}」远端未返回有效倍率，请在供应商站点确认实际倍率`
  ));
}

/** 提醒严重度：none = 不展示；normal = 黄标；severe = 黄红标（更显眼）。 */
export type RateWarningSeverity = "none" | "normal" | "severe";

/** 配置缺口种类：决定「没设置」提示到底说的是账号还是套餐同步。 */
export type RateWarningGap = "none" | "account" | "plan";

export interface RateWarningState {
  severity: RateWarningSeverity;
  /** 受影响密钥数（配置缺口时为 0：具体是哪几条无从得知）。 */
  count: number;
  /** 受影响密钥名称（配置缺口时为空数组）。 */
  labels: string[];
  /**
   * true = 提醒的根因是「同步没配置好」（账号未设置 / 套餐同步未保存），
   * 而不是「远端这一次没返回倍率」。两种情况的文案与操作建议不同，UI 必须据此区分。
   */
  configurationGap: boolean;
  /** 配置缺口的具体种类：account（按量缺账号）/ plan（套餐订阅缺套餐同步）。 */
  gap: RateWarningGap;
}

export const NO_RATE_WARNING: RateWarningState = {
  severity: "none",
  count: 0,
  labels: [],
  configurationGap: false,
  gap: "none",
};

export interface RateWarningInput {
  /**
   * 最近一次成功同步的密钥对比明细（仪表盘供应商卡直接持有 status 时使用）。
   * 与 `unconfirmedCount` 二选一：给了明细就以明细为准。
   */
  unconfirmed?: readonly CredentialComparisonItem[] | null;
  /** 已聚合的未确认密钥数（侧栏只拿到概览接口的计数时使用）。 */
  unconfirmedCount?: number;
  /** 已聚合的未确认密钥名称。 */
  unconfirmedLabels?: readonly string[];
  /** 该目标是否配置了控制台账号。 */
  hasConsoleAccount: boolean;
  /** 控制台账号同步状态（ok / failed / auth_required / idle / running）。 */
  accountStatus?: string | null;
  /**
   * 是否属于「按站点分组倍率计费」的目标（自定义 / 中转站，非官方预设）。
   * 只有这类目标的密钥倍率需要靠站点分组核对；官方预设的密钥就是单条 API Key。
   */
  usesGroupRates: boolean;
  /** 计费通道：决定「没设置」提示说的是账号（按量）还是套餐同步（套餐/订阅）。 */
  billingChannel?: BillingChannel;
  /** 是否已保存套餐同步配置（套餐/订阅通道的配置就绪判定）。 */
  hasPlanConfig?: boolean;
  /**
   * 该目标是否存在可用的套餐适配器（`resolvePlanProviderForTarget`）。
   * 只有能匹配适配器的目标才值得提醒「去保存套餐同步」。
   */
  hasPlanAdapter?: boolean;
  /**
   * 是否把「同步配置缺口」也算作提醒（供应商列表专用，2026-09-18 用户确认）。
   * 密钥行只关心本条密钥的远端对比结果，配置缺口由概览的账号/套餐卡片负责播报，
   * 因此默认关闭。
   */
  includeConfigurationGaps?: boolean;
  /**
   * 目标是否启用（缺省视为启用）。停用目标不产生任何计费，
   * 也就没有「倍率不可信」的风险 —— 一律不提醒，避免新建草稿/临时停用刷屏。
   */
  enabled?: boolean;
  /**
   * 同步事实是否已加载（缺省视为已加载）。页面首帧只拿到 proxy-config、
   * 还没拿到同步概览时必须传 false：否则「账号未知」会被误判成「账号未配置」，
   * 于是每次打开仪表盘/供应商页都会先闪一片黄红标再消失（2026-09-18 用户反馈）。
   */
  factsLoaded?: boolean;
}

/**
 * 严重度判定（2026-09-18 用户确认）：
 * 1. 有「远端未返回倍率」的证据 → 同步健康时 normal（黄），否则 severe（黄红）；
 * 2. 无证据但同步根本没配好 → severe，且文案直接说清缺什么：
 *    - 按量 + 按分组倍率计费的中转站目标没配控制台账号 → 「账号未设置」
 *    - 套餐/订阅目标没保存套餐同步（且存在套餐适配器）→ 「套餐（订阅）未设置」
 * 3. 其余 → none。
 *
 * 第 2 条是「提醒用户及时把同步配置补上」，因此必须给出可执行的动作，
 * 而不是像第 1 条那样抽象地说「倍率未校验」（2026-09-18 用户反馈：
 * 1yuanapi 明明没保存账号信息，却只提示「倍率未校验」，看不出要做什么）。
 */
export function resolveRateWarning(input: RateWarningInput): RateWarningState {
  if (input.enabled === false) return NO_RATE_WARNING;
  // 事实未到位时保持沉默：宁可晚一点出现，也不要先闪一片扎眼的黄红标。
  if (input.factsLoaded === false) return NO_RATE_WARNING;
  const channel = input.billingChannel ?? "pay_as_you_go";
  const syncHealthy = input.hasConsoleAccount && input.accountStatus === "ok";
  const detailed = input.unconfirmed === undefined || input.unconfirmed === null
    ? undefined
    : rateUnconfirmedCredentials(input.unconfirmed);
  const count = detailed ? detailed.length : Math.max(0, input.unconfirmedCount ?? 0);
  const labels = detailed ? detailed.map(item => item.label) : [...(input.unconfirmedLabels ?? [])];
  const missingAccount = !input.hasConsoleAccount && input.usesGroupRates;
  const missingPlanConfig = channel !== "pay_as_you_go"
    && input.hasPlanAdapter === true
    && input.hasPlanConfig !== true;
  if (count > 0) {
    // 有证据但同步不健康：根因是配置没补上时，直接说根因，别让用户猜。
    if (!syncHealthy && input.includeConfigurationGaps === true) {
      if (channel !== "pay_as_you_go" && missingPlanConfig) {
        return {severity: "severe", count, labels, configurationGap: true, gap: "plan"};
      }
      if (missingAccount) {
        return {severity: "severe", count, labels, configurationGap: true, gap: "account"};
      }
    }
    return {severity: syncHealthy ? "normal" : "severe", count, labels, configurationGap: false, gap: "none"};
  }
  if (input.includeConfigurationGaps === true) {
    if (missingPlanConfig) {
      return {severity: "severe", count: 0, labels: [], configurationGap: true, gap: "plan"};
    }
    if (missingAccount) {
      return {severity: "severe", count: 0, labels: [], configurationGap: true, gap: "account"};
    }
  }
  return NO_RATE_WARNING;
}

/**
 * 标记内文字。
 * - 配置缺口 → 直接说缺什么（「账号未设置」/「套餐（订阅）未设置」），可执行；
 * - 有证据但同步异常 → 「倍率未校验」；
 * - 同步正常但远端没返回倍率 → 「倍率待确认」。
 */
export function rateWarningBadgeLabel(state: RateWarningState): string {
  if (state.configurationGap && state.gap === "account") return "账号未设置";
  if (state.configurationGap && state.gap === "plan") return "套餐（订阅）未设置";
  return state.severity === "severe" ? "倍率未校验" : "倍率待确认";
}

/**
 * 悬浮说明：只陈述事实与下一步动作，不复述「本系统不会改动密钥/模型/Agent 关联」
 * 这类内部保证（2026-09-18 用户确认：没必要提醒到用户）。
 */
export function rateWarningTitle(state: RateWarningState, targetName?: string): string {
  const subject = targetName ? `${targetName}：` : "";
  if (state.configurationGap && state.gap === "account") {
    const suffix = state.count > 0 ? `；其中 ${state.count} 条密钥的远端倍率也未确认` : "";
    return `${subject}尚未配置控制台账号同步：余额无法自动获取、密钥分组倍率也无法校验${suffix}。`
      + "请在概览「账号信息」保存账号并开启同步，再到供应商站点确认实际倍率";
  }
  if (state.configurationGap && state.gap === "plan") {
    const suffix = state.count > 0 ? `；其中 ${state.count} 条密钥的远端倍率也未确认` : "";
    return `${subject}尚未保存套餐同步配置：套餐/订阅窗口用量无法自动获取${suffix}。`
      + "请在概览「套餐用量」保存配置并点「同步套餐」";
  }
  if (state.severity === "severe") {
    return `${subject}${state.count} 条密钥的远端倍率未确认，且控制台账号同步未正常运行；请到供应商站点确认实际倍率`;
  }
  return `${subject}${state.count} 条密钥的远端倍率未确认（${state.labels.join("、")}）；请到供应商站点确认实际倍率`;
}
