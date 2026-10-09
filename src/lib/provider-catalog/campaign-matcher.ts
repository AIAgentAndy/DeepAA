/**
 * Campaign 匹配与合成（设计 5.3/深检 4）：按 captured_at 的活动时间/窗口/作用域匹配，
 * 并把命中的多条活动合成为单一有效规则——creditMultiplier 全部相乘、freeWindow 命中即
 * 终局置 0、factorOverride 按最高 priority 唯一胜出。plan-credit 消费合成结果，
 * 不感知 Campaign 结构。
 */
import {isWithinTimeWindows, type PlanCreditPromotion} from "@/lib/pricing";

export interface ComposedPromotions {
  /** 合成后的活动倍率（含 freeWindow 终局 0）；无活动命中时为 undefined。 */
  multiplier?: number;
  /** factorOverride 胜出的输入系数覆盖。 */
  inputFactor?: number;
  /** factorOverride 胜出的输出系数覆盖。 */
  outputFactor?: number;
  /** factorOverride 胜出的缓存命中系数覆盖（2026-09-30 腾讯 tc-code 三因子活动价）。 */
  cachedInputFactor?: number;
  /** 命中活动的展示名（label/note 摘要，按优先级排序）。 */
  labels: string[];
  /** 任一命中活动标记 unverified 时为 true（实测校准口径）。 */
  unverified: boolean;
  /** 命中的活动明细（公式展示用，含倍率/系数）。 */
  matched: Array<{label: string; multiplier?: number; input?: number; output?: number; cachedInput?: number}>;
}

/**
 * 匹配并合成：promotions 需已按优先级降序排列（编译投影保证；priority 字段存在时二次保险排序）。
 * 时间语义与目录 v1 活动一致：from（含）≤ instant、to（含）内命中——投影层已把 v2 左闭右开
 * 的 period.to 统一转为含端点语义（+1ms 等价），本函数不做再解释。
 * origin（2026-09-15 双链路观测）：origins 限定的活动只在对应观测通道命中；
 * 缺省 gateway——仅 agent_local_import 限定的活动对经网关流量不可见。
 */
export function matchAndComposePromotions(
  promotions: PlanCreditPromotion[],
  resolvedModel: string,
  capturedAt: string | undefined,
  agentName: string | undefined,
  defaultTimezone: string,
  origin?: string,
): ComposedPromotions {
  const matched = matchPromotions(promotions, resolvedModel, capturedAt, agentName, defaultTimezone, origin);
  return composeMatchedPromotions(matched);
}

/** 按模型/Agent/通道/日期/每日窗口筛选命中的活动（优先级降序返回）。 */
export function matchPromotions(
  promotions: PlanCreditPromotion[],
  resolvedModel: string,
  capturedAt: string | undefined,
  agentName: string | undefined,
  defaultTimezone: string,
  origin?: string,
): PlanCreditPromotion[] {
  const instant = capturedAt ? new Date(capturedAt) : new Date();
  if (!Number.isFinite(instant.getTime())) return [];
  const effectiveOrigin = origin ?? "gateway";
  const ordered = [...promotions].sort((left, right) => (right.priority ?? 0) - (left.priority ?? 0));
  const result: PlanCreditPromotion[] = [];
  for (const promotion of ordered) {
    if (promotion.models?.length && !promotion.models.includes(resolvedModel)) continue;
    if (promotion.agents?.length && (!agentName || !promotion.agents.includes(agentName.trim().toLowerCase()))) continue;
    if (promotion.origins?.length && !promotion.origins.includes(effectiveOrigin)) continue;
    const from = new Date(promotion.from);
    if (!Number.isFinite(from.getTime()) || instant < from) continue;
    if (promotion.to !== undefined) {
      const to = new Date(promotion.to);
      if (!Number.isFinite(to.getTime()) || instant > to) continue;
    }
    if (promotion.windows?.length
      && !isWithinTimeWindows(promotion.windows, instant, promotion.timezone ?? defaultTimezone)) continue;
    result.push(promotion);
  }
  return result;
}

/** 合成命中活动：freeWindow（multiplier=0）终局；creditMultiplier 连乘；factorOverride 选胜。 */
export function composeMatchedPromotions(matched: PlanCreditPromotion[]): ComposedPromotions {
  const labels: string[] = [];
  const details: ComposedPromotions["matched"] = [];
  let multiplier: number | undefined;
  let inputFactor: number | undefined;
  let outputFactor: number | undefined;
  let cachedInputFactor: number | undefined;
  let unverified = false;
  let terminal = false;
  for (const promotion of matched) {
    const label = promotion.label ?? promotion.note?.split("；")[0] ?? "活动";
    if (terminal) {
      // freeWindow 已终局：后续更低优先级活动只保留标签用于审计，不再改变结果。
      labels.push(label);
      continue;
    }
    labels.push(label);
    if (promotion.multiplier === 0) {
      terminal = true;
      multiplier = 0;
      details.push({label, multiplier: 0});
      continue;
    }
    if (promotion.multiplier !== undefined) {
      multiplier = multiplier === undefined ? promotion.multiplier : multiplier * promotion.multiplier;
    }
    if (promotion.input !== undefined && inputFactor === undefined) inputFactor = promotion.input;
    if (promotion.output !== undefined && outputFactor === undefined) outputFactor = promotion.output;
    if (promotion.cachedInput !== undefined && cachedInputFactor === undefined) cachedInputFactor = promotion.cachedInput;
    if (promotion.unverified === true) unverified = true;
    details.push({
      label,
      ...(promotion.multiplier !== undefined ? {multiplier: promotion.multiplier} : {}),
      ...(promotion.input !== undefined ? {input: promotion.input} : {}),
      ...(promotion.output !== undefined ? {output: promotion.output} : {}),
      ...(promotion.cachedInput !== undefined ? {cachedInput: promotion.cachedInput} : {}),
    });
  }
  return {
    ...(multiplier !== undefined ? {multiplier} : {}),
    ...(inputFactor !== undefined ? {inputFactor} : {}),
    ...(outputFactor !== undefined ? {outputFactor} : {}),
    ...(cachedInputFactor !== undefined ? {cachedInputFactor} : {}),
    labels,
    unverified,
    matched: details,
  };
}
