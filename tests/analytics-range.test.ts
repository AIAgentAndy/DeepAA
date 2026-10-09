import {describe, expect, test} from "vitest";
import {
  DASHBOARD_PRESETS,
  resolveAnalyticsRange,
  resolveDashboardRange,
} from "../src/lib/analytics/range.js";

describe("Dashboard 时间范围", () => {
  test("默认使用今天且只返回当前周期", () => {
    const result = resolveAnalyticsRange({
      preset: undefined,
      timezone: "Asia/Shanghai",
      now: "2026-08-25T08:30:00.000Z",
    });

    expect(result.preset).toBe("today");
    expect(result.timezone).toBe("Asia/Shanghai");
    expect(result.range).toEqual({
      start: "2026-08-24T16:00:00.000Z",
      end: "2026-08-25T08:30:00.000Z",
    });
    expect(result).not.toHaveProperty("comparisonRange");
    expect(result.granularity).toBe("hour");
  });

  test("只接受设计文档中的六个 preset", () => {
    expect(DASHBOARD_PRESETS).toEqual([
      "today",
      "24h",
      "this_week",
      "7d",
      "this_month",
      "30d",
    ]);
    expect(() => resolveAnalyticsRange({preset: "custom", timezone: "UTC"})).toThrow(
      "不支持的 Dashboard 时间范围",
    );
  });

  test("本周按周一开始，最近 7 天按滚动 168 小时", () => {
    const now = "2026-08-26T02:15:00.000Z";
    expect(resolveAnalyticsRange({preset: "this_week", timezone: "UTC", now}).range).toEqual({
      start: "2026-08-24T00:00:00.000Z",
      end: now,
    });
    expect(resolveAnalyticsRange({preset: "7d", timezone: "UTC", now}).range).toEqual({
      start: "2026-08-19T02:15:00.000Z",
      end: now,
    });
  });

  test("本月按本地边界生成当前范围", () => {
    const result = resolveAnalyticsRange({
      preset: "this_month",
      timezone: "Asia/Shanghai",
      now: "2026-03-31T04:15:00.000Z",
    });
    expect(result.range).toEqual({
      start: "2026-02-28T16:00:00.000Z",
      end: "2026-03-31T04:15:00.000Z",
    });
    expect(result).not.toHaveProperty("comparisonRange");
  });
});

describe("仪表盘自适应时间桶", () => {
  test.each([
    [24, "hour", 1, 24],
    [48, "hour", 2, 24],
    [72, "hour", 3, 24],
    [7 * 24, "hour", 6, 28],
    [30 * 24, "day", 1, 30],
    [90 * 24, "day", 3, 30],
    [180 * 24, "day", 7, 26],
    [365 * 24, "day", 14, 27],
    [400 * 24, "day", 30, 14],
  ] as const)("跨度 %i 小时选择 %s/%i，共 %i 桶", (hours, granularity, bucketStep, bucketCount) => {
    const start = new Date("2026-01-01T00:00:00.000Z");
    const result = resolveDashboardRange({
      start: start.toISOString(),
      end: new Date(start.getTime() + hours * 60 * 60 * 1000).toISOString(),
      timezone: "UTC",
    });
    expect(result).toMatchObject({granularity, bucketStep, bucketCount});
    expect(result).not.toHaveProperty("comparisonRange");
  });

  test("datetime-local 墙钟边界按时区解释，分钟取整到小时，end 为排他边界", () => {
    const result = resolveDashboardRange({
      start: "2026-08-27T00:30",
      end: "2026-08-27T23:59",
      timezone: "Asia/Shanghai",
    });
    expect(result.range).toEqual({
      start: "2026-08-26T16:00:00.000Z",
      end: "2026-08-27T15:00:00.000Z",
    });
    expect(result).toMatchObject({granularity: "hour", bucketStep: 1, bucketCount: 23});
  });

  test("缺省 start/end 时默认本地今天 00 到次日 00", () => {
    const result = resolveDashboardRange({
      timezone: "UTC",
      now: "2026-08-27T09:17:00.000Z",
    });
    expect(result.range).toEqual({
      start: "2026-08-27T00:00:00.000Z",
      end: "2026-08-28T00:00:00.000Z",
    });
    expect(result).toMatchObject({granularity: "hour", bucketStep: 1, bucketCount: 24});
  });

  test("跨度不再受 180 天上限限制（小时事实永久保存，2026-09-21 确认）", () => {
    const result = resolveDashboardRange({
      start: "2026-01-01T00:00",
      end: "2026-08-28T00:00",
      timezone: "UTC",
    });
    // 239 天跨度：day/14 桶，可正常解析。
    expect(result).toMatchObject({granularity: "day", bucketStep: 14, bucketCount: 18});
    // 超过一年的跨度同样允许，退到 30 天桶保证数据点数有界（882 天 → 30 桶）。
    const yearPlus = resolveDashboardRange({
      start: "2024-01-01T00:00",
      end: "2026-06-01T00:00",
      timezone: "UTC",
    });
    expect(yearPlus).toMatchObject({granularity: "day", bucketStep: 30, bucketCount: 30});
  });

  test("非法输入被拒绝", () => {
    expect(() => resolveDashboardRange({start: "2026-08-27T00:00", end: "not-a-date", timezone: "UTC"})).toThrow("无效的结束时间");
    expect(() => resolveDashboardRange({start: "2026-08-28T00:00", end: "2026-08-27T00:00", timezone: "UTC"})).toThrow("结束时间必须晚于开始时间");
    expect(() => resolveDashboardRange({start: "2026-08-27T00:00", timezone: "UTC"})).toThrow("start 与 end 必须同时提供");
    expect(() => resolveDashboardRange({start: "2026-13-01T00:00", end: "2026-13-02T00:00", timezone: "UTC"})).toThrow("无效的开始时间");
    expect(() => resolveDashboardRange({start: "2026-08-27T00:00", end: "2026-08-28T00:00", timezone: "Not/AZone"})).toThrow("无效的 IANA 时区");
  });
});
