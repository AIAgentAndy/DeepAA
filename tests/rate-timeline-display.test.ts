import {describe, expect, test} from "vitest";
import {
  groupRateTimeline,
  segmentRangeText,
  segmentRateText,
  segmentTimeText,
  type DisplayRateSegment,
} from "../src/lib/rate-timeline-display.js";

/**
 * 价格时间线展示分组（终极方案 2026-09-10）：
 * 当前生效置顶（右端 = 下一段生效时刻）→ 待生效紧随 → 历史倒序折叠。
 */

const timeline: DisplayRateSegment[] = [
  {pricing: {input: 3, output: 9, cachedInput: 0.1}},
  {effectiveFrom: "2026-09-10T12:00:00+08:00", pricing: {input: 2, output: 8, cachedInput: 0.04}, changeNote: "9 月 10 日 12:00 起调整 flash 系列定价"},
  {effectiveFrom: "2026-09-15T12:00:00+08:00", pricing: {input: 1, output: 4, cachedInput: 0.02}},
];

describe("价格时间线分组", () => {
  test("三段场景（当前 09-12）：当前段置顶、待生效紧随、历史倒序折叠", () => {
    const grouped = groupRateTimeline(timeline, new Date("2026-09-12T10:00:00+08:00"));
    expect(grouped.current?.pricing.input).toBe(2);
    expect(grouped.currentFrom).toBe("2026-09-10T12:00:00+08:00");
    // 当前段区间右端 = 下一段生效时刻。
    expect(grouped.currentUntil).toBe("2026-09-15T12:00:00+08:00");
    expect(grouped.upcoming.map(segment => segment.pricing.input)).toEqual([1]);
    expect(grouped.expired.map(segment => segment.pricing.input)).toEqual([3]);
    expect(grouped.current?.changeNote).toContain("调整 flash 系列定价");
  });

  test("首段（无 effectiveFrom）在生效前为当前段，区间右端为下一段时刻", () => {
    const grouped = groupRateTimeline(timeline, new Date("2026-09-09T10:00:00+08:00"));
    expect(grouped.current?.pricing.input).toBe(3);
    expect(grouped.currentFrom).toBeUndefined();
    expect(grouped.currentUntil).toBe("2026-09-10T12:00:00+08:00");
    expect(grouped.upcoming).toHaveLength(2);
    expect(grouped.expired).toHaveLength(0);
  });

  test("全部段已生效（末段）：无待生效、区间长期有效，历史含前两段", () => {
    const grouped = groupRateTimeline(timeline, new Date("2026-10-01T10:00:00+08:00"));
    expect(grouped.current?.pricing.input).toBe(1);
    expect(grouped.currentUntil).toBeUndefined();
    expect(grouped.upcoming).toEqual([]);
    expect(grouped.expired.map(segment => segment.pricing.input)).toEqual([2, 3]);
  });

  test("单段/无时间线：单段按顶层展示，空时间线返回空分组", () => {
    const single = groupRateTimeline([{pricing: {input: 5, output: 30}}], new Date("2026-09-12T10:00:00+08:00"));
    expect(single.current?.pricing.input).toBe(5);
    expect(single.upcoming).toEqual([]);
    expect(single.expired).toEqual([]);
    const empty = groupRateTimeline(undefined);
    expect(empty.current).toBeUndefined();
    expect(empty.upcoming).toEqual([]);
  });
});

describe("价格段时间线文案", () => {
  test("段价格摘要含高峰与闲时两档", () => {
    const segment: DisplayRateSegment = {
      pricing: {input: 2, output: 8, cachedInput: 0.04},
      priceSchedules: [{label: "闲时", rates: {input: 1, output: 4, cachedInput: 0.02}}],
    };
    expect(segmentRateText(segment)).toBe("高峰 2/8/0.04 ｜ 闲时 1/4/0.02");
  });

  test("无闲时档时只显示高峰；无 effectiveFrom 显示「历史价格」", () => {
    expect(segmentRateText({pricing: {input: 5, output: 30}})).toBe("高峰 5/30");
    expect(segmentTimeText(undefined)).toBe("历史价格");
    expect(segmentTimeText("2026-09-10T12:00:00+08:00")).toBe("2026-09-10 12:00");
  });

  test("区间文案：起点 + 右端 / 长期有效", () => {
    expect(segmentRangeText("2026-09-10T12:00:00+08:00", "2026-09-15T12:00:00+08:00"))
      .toBe("2026-09-10 12:00 起 至 2026-09-15 12:00");
    expect(segmentRangeText("2026-09-10T12:00:00+08:00", undefined))
      .toBe("2026-09-10 12:00 起 · 长期有效");
    expect(segmentRangeText(undefined, "2026-09-10T12:00:00+08:00"))
      .toBe("历史 至 2026-09-10 12:00");
  });
});
