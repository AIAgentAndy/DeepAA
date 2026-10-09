/**
 * 价格时间线展示（终极方案 2026-09-10）：把模型的价格段按时间分组为
 * 「当前生效 / 即将生效 / 历史」，供价格中心、密钥与模型列表与通知项共用。
 *
 * 纯函数模块（无 Node 依赖）：客户端组件可直接导入，不经过 @/lib/pricing。
 */

/** 展示所需的价格段形状（与 ModelPriceEntry.rateTimeline 结构兼容）。 */
export interface DisplayRateSegment {
  effectiveFrom?: string;
  pricing: {input?: number; output?: number; cachedInput?: number; cacheWrite?: number};
  priceSchedules?: Array<{label: string; rates: {input?: number; output?: number; cachedInput?: number}}>;
  changeNote?: string;
}

export interface GroupedRateTimeline {
  /** 当前生效段（effectiveFrom ≤ now 的最后一段）。 */
  current?: DisplayRateSegment;
  /** 当前段的区间起点（首段/无 effectiveFrom 时为 undefined = 一直如此）。 */
  currentFrom?: string;
  /** 下一段生效时刻（当前段区间的右端；无则长期有效）。 */
  currentUntil?: string;
  /** 待生效段（按生效时刻升序）。 */
  upcoming: DisplayRateSegment[];
  /** 历史段（按生效时刻降序，UI 默认折叠）。 */
  expired: DisplayRateSegment[];
}

/**
 * 按时间分组价格段：当前生效置顶（右端 = 下一段生效时刻）、待生效紧随、历史折叠。
 * 无 effectiveFrom 的段视为「历史起点」（一直有效到下一个带时刻的段）。
 */
export function groupRateTimeline(
  timeline: DisplayRateSegment[] | undefined,
  now: Date = new Date(),
): GroupedRateTimeline {
  if (!timeline?.length) return {upcoming: [], expired: []};
  const nowMs = now.getTime();
  const sorted = [...timeline].sort((left, right) => {
    const leftMs = left.effectiveFrom ? Date.parse(left.effectiveFrom) : Number.NEGATIVE_INFINITY;
    const rightMs = right.effectiveFrom ? Date.parse(right.effectiveFrom) : Number.NEGATIVE_INFINITY;
    return leftMs - rightMs;
  });
  let currentIndex = 0;
  for (let index = 0; index < sorted.length; index += 1) {
    const from = sorted[index]!.effectiveFrom;
    if (from === undefined || Date.parse(from) <= nowMs) currentIndex = index;
  }
  const current = sorted[currentIndex];
  const upcoming = sorted.slice(currentIndex + 1);
  const expired = sorted.slice(0, currentIndex).reverse();
  return {
    ...(current ? {current} : {}),
    ...(current?.effectiveFrom ? {currentFrom: current.effectiveFrom} : {}),
    ...(upcoming[0]?.effectiveFrom ? {currentUntil: upcoming[0].effectiveFrom} : {}),
    upcoming,
    expired,
  };
}

/** 单段价格摘要：「高峰 2/8/0.04 ｜ 闲时 1/4/0.02」。 */
export function segmentRateText(segment: DisplayRateSegment): string {
  const peak = `高峰 ${segment.pricing.input ?? "-"}/${segment.pricing.output ?? "-"}`
    + (segment.pricing.cachedInput !== undefined ? `/${segment.pricing.cachedInput}` : "");
  const schedule = segment.priceSchedules?.[0];
  if (!schedule) return peak;
  const offPeak = `闲时 ${schedule.rates.input ?? "-"}/${schedule.rates.output ?? "-"}`
    + (schedule.rates.cachedInput !== undefined ? `/${schedule.rates.cachedInput}` : "");
  return `${peak} ｜ ${offPeak}`;
}

/** 生效时刻短格式（YYYY-MM-DD HH:mm，保留段自带时区偏移）。 */
export function segmentTimeText(effectiveFrom: string | undefined): string {
  if (!effectiveFrom) return "历史价格";
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(effectiveFrom);
  return match ? `${match[1]} ${match[2]}` : effectiveFrom;
}

/** 段区间文案：「2026-09-10 12:00 起 至 2026-09-15 12:00」/「长期有效」。 */
export function segmentRangeText(from: string | undefined, until: string | undefined): string {
  const start = from ? `${segmentTimeText(from)} 起` : "历史";
  return until ? `${start} 至 ${segmentTimeText(until)}` : `${start} · 长期有效`;
}
