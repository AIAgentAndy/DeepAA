/**
 * 仪表盘模块顺序（纯函数 + localStorage 持久化，2026-09-18 用户确认）。
 *
 * 需求：每个模块支持上移/下移，结果记到 localStorage；最上不超过时间选择器
 * （时间筛选条不参与排序，永远第一）。
 *
 * 这里只负责「顺序数据」：默认顺序、容错归一化、读写与相邻交换。
 * 越界/未知/重复值都必须被静默修复，绝不让一条脏的 localStorage 值
 * 把仪表盘渲染成缺模块或重复模块。
 */

export const DASHBOARD_MODULE_STORAGE_KEY = "deepaa.dashboard.moduleOrder";

/** 可排序模块（时间筛选条不在其中：它是页面固定首块）。 */
export const DASHBOARD_MODULE_IDS = [
  "overview",
  "leaderboard",
  "analysis",
  "trend",
  "plans",
  "heatmap",
] as const;

export type DashboardModuleId = (typeof DASHBOARD_MODULE_IDS)[number];

/** 默认顺序 = 现有页面既有信息层级，首次访问与旧值损坏时都回退到它。 */
export const DEFAULT_DASHBOARD_MODULE_ORDER: readonly DashboardModuleId[] = DASHBOARD_MODULE_IDS;

const KNOWN_IDS = new Set<string>(DASHBOARD_MODULE_IDS);

/** 模块中文名（按钮 aria-label 与 title 用）。 */
export const DASHBOARD_MODULE_LABELS: Record<DashboardModuleId, string> = {
  overview: "范围总览",
  leaderboard: "Token 成本排行榜",
  analysis: "模型 / 供应商 / Agent 分析",
  trend: "消耗趋势与构成",
  plans: "套餐 / 订阅供应商消耗",
  heatmap: "周期强度热力图",
};

/**
 * 归一化任意来源的顺序值：
 * 1. 只保留已知 id，丢弃未知项；
 * 2. 去重（保留首次出现位置）；
 * 3. 把缺失的 id 按默认顺序补到末尾 —— 保证「新增模块」在旧用户那里也一定出现。
 */
export function normalizeDashboardModuleOrder(raw: unknown): DashboardModuleId[] {
  const input = Array.isArray(raw)
    ? raw
    : typeof raw === "string"
      ? raw.split(",")
      : [];
  const seen = new Set<DashboardModuleId>();
  const result: DashboardModuleId[] = [];
  for (const value of input) {
    if (typeof value !== "string") continue;
    const id = value.trim();
    if (!KNOWN_IDS.has(id) || seen.has(id as DashboardModuleId)) continue;
    seen.add(id as DashboardModuleId);
    result.push(id as DashboardModuleId);
  }
  for (const id of DEFAULT_DASHBOARD_MODULE_ORDER) {
    if (!seen.has(id)) result.push(id);
  }
  return result;
}

/** 读取本地顺序；SSR / 读取失败 / 值损坏一律回退默认顺序。 */
export function readDashboardModuleOrder(): DashboardModuleId[] {
  if (typeof window === "undefined") return [...DEFAULT_DASHBOARD_MODULE_ORDER];
  try {
    const stored = window.localStorage.getItem(DASHBOARD_MODULE_STORAGE_KEY);
    if (!stored) return [...DEFAULT_DASHBOARD_MODULE_ORDER];
    return normalizeDashboardModuleOrder(JSON.parse(stored));
  } catch {
    return [...DEFAULT_DASHBOARD_MODULE_ORDER];
  }
}

/** 写入本地顺序；隐私模式等写入失败时静默降级（顺序仍在内存中生效）。 */
export function writeDashboardModuleOrder(order: readonly DashboardModuleId[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(DASHBOARD_MODULE_STORAGE_KEY, JSON.stringify(order));
  } catch {
    /* 写入失败不影响本次会话内的排序。 */
  }
}

/**
 * 相邻交换：把 `id` 与渲染顺序中的相邻模块对调。
 * `renderedOrder` 是当前真正渲染出来的模块（如「套餐 / 订阅」无数据时不渲染），
 * 因此跨过隐藏模块的交换不会产生「点了一下没反应」。
 * 返回新数组；越界或 id 不存在时原样返回。
 */
export function moveDashboardModule(
  order: readonly DashboardModuleId[],
  renderedOrder: readonly DashboardModuleId[],
  id: DashboardModuleId,
  delta: number,
): DashboardModuleId[] {
  const index = renderedOrder.indexOf(id);
  const targetIndex = index + delta;
  if (index < 0 || targetIndex < 0 || targetIndex >= renderedOrder.length) return [...order];
  const swapWith = renderedOrder[targetIndex]!;
  const next = [...order];
  const from = next.indexOf(id);
  const to = next.indexOf(swapWith);
  if (from < 0 || to < 0) return [...order];
  next[from] = swapWith;
  next[to] = id;
  return next;
}
