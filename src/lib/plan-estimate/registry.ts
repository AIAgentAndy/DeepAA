/**
 * 额度差分估算策略注册表（插件式）。
 *
 * 策略只决定「怎么算」（锚窗优先序 + 窗口天数）；「要不要算」由 backfill 门禁按账本
 * market_blocked 行存在性数据驱动短路，与本注册表无关——新供应商无逐请求积分
 * 公式时自动适用，无需注册。
 *
 * 2026-10-09 用户确认修订：锚窗制取代降级链。锚窗 = 目标实际存在快照的窗口中
 * 优先序第一个（monthly/30d > weekly 系 > 5h），选定后配对失败不降级到短窗——
 * 旧行为（周窗平Δ → 跌 5h）导致同一目标 42% 的行按 5h 时间份额计价、价值基数
 * 混用。5h 仅保留给「只有 5h 快照」的目标；窗口越长刻度跳动越慢是用户接受的
 * 取舍（准确优先于及时）。
 *
 * dual-window（5h 粒度预分摊 + 周窗校正）为预留位：仅当实测周窗 percent 为整数
 * 刻度（差分周期数小时级、粒度不足）时才有必要启用；OpenAI wham/usage 实测
 * used_percent 为整数（2026-10-09 本地 36 快照 + 社区文档核对），Anthropic
 * utilization 为 0-1 浮点精度充足。
 */

export interface PlanEstimateStrategy {
  id: string;
  /**
   * 锚窗优先序：同一目标取第一个实际存在快照的窗口作为唯一锚窗，
   * 不因瞬时配对失败（平Δ/reset 跨界）降级到更短窗口。
   */
  windowPriority: readonly string[];
  /** 窗口 → 覆盖天数（月费按 30 天折算窗口价值份额）。 */
  windowDays: Readonly<Record<string, number>>;
}

/** 与 plan-real-cost 的 PLAN_WINDOW_DAYS 同源的窗口天数（单一事实，避免两份表漂移）。 */
import {PLAN_WINDOW_DAYS} from "@/lib/db/plan-real-cost";

export const LONGEST_WINDOW_ANCHOR_STRATEGY: PlanEstimateStrategy = {
  id: "longest-window-anchor",
  windowPriority: ["monthly", "30d", "weekly_opus", "weekly_sonnet", "weekly", "5h"],
  windowDays: PLAN_WINDOW_DAYS,
};

/** 预留：双窗策略注册位（见文件头说明）。 */
export const DUAL_WINDOW_STRATEGY: PlanEstimateStrategy = {
  id: "dual-window",
  windowPriority: LONGEST_WINDOW_ANCHOR_STRATEGY.windowPriority,
  windowDays: PLAN_WINDOW_DAYS,
};

/** 当前全部供应商统一最长窗口锚定策略；未来按 providerType 精细化在此路由。 */
export function resolvePlanEstimateStrategy(_providerType: string): PlanEstimateStrategy {
  return LONGEST_WINDOW_ANCHOR_STRATEGY;
}
