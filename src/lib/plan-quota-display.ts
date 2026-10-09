/**
 * 套餐/订阅用量窗口的统一展示口径（纯函数，无 React / 无 DB 依赖）。
 *
 * 为什么必须共用一份：窗口标签、主窗口挑选与百分比口径同时被
 * 仪表盘供应商卡（`dashboard/dashboard-launcher.tsx`）与供应商管理侧栏
 * （`proxy-management/proxy-target-sidebar.tsx`）消费。两处各写一份必然漂移，
 * 用户会在两个页面看到不同的「5 小时 / 1 周」标签或不同的百分比取整结果。
 */

/** 窗口标签：适配器落库的是机器可读短标签，展示层统一翻译为中文。 */
export const PLAN_QUOTA_WINDOW_LABELS: Record<string, string> = {
  "5h": "5 小时",
  "5h-2": "5 小时（2）",
  "5h-3": "5 小时（3）",
  weekly: "1 周",
  monthly: "月",
  rolling: "滚动窗口",
};

export function planQuotaWindowLabel(label: string): string {
  return PLAN_QUOTA_WINDOW_LABELS[label] ?? label;
}

/** 主窗口优先级：短周期窗口是用户最关心的限流口径，长周期作为补充。 */
const WINDOW_PRIORITY = ["5h", "5h-2", "5h-3", "rolling", "weekly", "monthly"];

export interface PlanQuotaWindowLike {
  windowLabel: string;
  used?: number | null;
  total?: number | null;
  remaining?: number | null;
  unit?: string | null;
  resetAt?: string | null;
}

/**
 * 主窗口：按优先级取第一个可用窗口；无命中时退回第一条。
 * 多密钥站点可能落多条同窗口快照，调用方负责先做有界去重。
 */
export function pickPrimaryPlanQuotaWindow<T extends PlanQuotaWindowLike>(
  items: readonly T[],
): T | undefined {
  if (items.length === 0) return undefined;
  for (const label of WINDOW_PRIORITY) {
    const matched = items.find(item => item.windowLabel === label);
    if (matched) return matched;
  }
  return items[0];
}

/** 已用占比（0-100，含边界夹紧）；total 缺失或非正数时无法判断，返回 null。 */
export function planQuotaPercent(item: PlanQuotaWindowLike | undefined): number | null {
  if (!item) return null;
  const used = item.used;
  const total = item.total;
  if (used === null || used === undefined) return null;
  if (total === null || total === undefined || !Number.isFinite(total) || total <= 0) return null;
  if (!Number.isFinite(used)) return null;
  return Math.min(100, Math.max(0, (used / total) * 100));
}

/**
 * 剩余数值（2026-10-07 用户确认，与 zcode 官方客户端对齐的余量主口径）：
 * 优先供应商原始 remaining（2026-08-30 设计规范：可能与 total-used 有舍入差异，
 * UI 必须优先展示原始值）；缺失且 used/total 齐备时用 total-used 推导。
 */
export function planQuotaRemainingValue(item: PlanQuotaWindowLike | undefined): number | null {
  if (!item) return null;
  if (item.remaining !== null && item.remaining !== undefined && Number.isFinite(item.remaining)) {
    return item.remaining;
  }
  const used = item.used;
  const total = item.total;
  if (used === null || used === undefined || !Number.isFinite(used)) return null;
  if (total === null || total === undefined || !Number.isFinite(total) || total <= 0) return null;
  return Math.max(total - used, 0);
}

/** 剩余占比（0-100，含边界夹紧）；无法计算（total 缺失/无剩余依据）时返回 null。 */
export function planQuotaRemainingPercent(item: PlanQuotaWindowLike | undefined): number | null {
  if (!item) return null;
  const total = item.total;
  if (total === null || total === undefined || !Number.isFinite(total) || total <= 0) return null;
  const remaining = planQuotaRemainingValue(item);
  if (remaining === null || !Number.isFinite(remaining)) return null;
  return Math.min(100, Math.max(0, (remaining / total) * 100));
}

/** 紧凑数值：整数不带小数点，小数最多两位（1.25 / 12 / 1200）。 */
function compactNumber(value: number): string {
  if (!Number.isFinite(value)) return "—";
  if (Number.isInteger(value)) return String(value);
  return String(Math.round(value * 100) / 100);
}

/**
 * 余量文本（用于悬浮提示与副行；2026-10-07 用户确认改为余量主口径，与 zcode 一致）：
 * - remaining（原始或推导）+ total → `剩余 1.9 / 5 credits`；
 * - 只有 remaining → `剩余 7 credits`；
 * - 只有 used → `已用 3.1 credits`；
 * - 都没有 → `—`。
 * percent 单位本身就是 0-100 的百分比，不再重复拼单位。
 */
export function formatPlanQuotaAmount(item: PlanQuotaWindowLike | undefined): string {
  if (!item) return "—";
  const unit = item.unit && item.unit !== "percent" ? ` ${item.unit}` : "";
  const remaining = planQuotaRemainingValue(item);
  const total = item.total;
  if (remaining !== null && total !== null && total !== undefined && Number.isFinite(total)) {
    return `剩余 ${compactNumber(remaining)} / ${compactNumber(total)}${unit}`;
  }
  if (remaining !== null) return `剩余 ${compactNumber(remaining)}${unit}`;
  const used = item.used;
  if (used !== null && used !== undefined && Number.isFinite(used)) {
    return `已用 ${compactNumber(used)}${unit}`;
  }
  return "—";
}

/** 已用文本（余量主口径下的补充行）：`已用 3.1 credits`；无数据为 `—`。 */
export function formatPlanQuotaUsedAmount(item: PlanQuotaWindowLike | undefined): string {
  if (!item) return "—";
  const unit = item.unit && item.unit !== "percent" ? ` ${item.unit}` : "";
  const used = item.used;
  if (used === null || used === undefined || !Number.isFinite(used)) return "—";
  return `已用 ${compactNumber(used)}${unit}`;
}

/**
 * 侧栏/卡片共用的一行摘要（2026-10-07 余量主口径）：`5 小时 剩 38%`，无法计算剩余时
 * 降级为 `5 小时 剩余 1.9 / 5 credits`，仍无数据则为 null（调用方展示自己的空态文案）。
 */
export function formatPlanQuotaHeadline(item: PlanQuotaWindowLike | undefined): string | null {
  if (!item) return null;
  const percent = planQuotaRemainingPercent(item);
  const label = planQuotaWindowLabel(item.windowLabel);
  if (percent !== null) return `${label} 剩 ${Math.round(percent)}%`;
  const amount = formatPlanQuotaAmount(item);
  return amount === "—" ? label : `${label} ${amount}`;
}

/**
 * 「用量/余额拿不到」时的兜底文案（供应商侧栏与仪表盘供应商卡共用一份）。
 *
 * 2026-09-18 用户确认的口径：按量通道看的是控制台账号，套餐/订阅通道看的是套餐同步，
 * 因此「没设置」的提示必须分别说清楚到底缺什么，而不是笼统地说「去控制台查看」：
 * - 按量：`账号未设置`
 * - 套餐 / 订阅：`套餐（订阅）未设置`
 * 已经设置好但暂时没有快照时才用各自的「待同步」文案。
 */
export type UsageFallbackKind = "account" | "plan" | "balance-unavailable" | "pending";

export function usageFallbackLabel(kind: UsageFallbackKind): string {
  if (kind === "account") return "账号未设置";
  if (kind === "plan") return "套餐（订阅）未设置";
  if (kind === "pending") return "用量待同步";
  return "余额控制台查看";
}
