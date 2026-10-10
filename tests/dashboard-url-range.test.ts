import {describe, expect, test} from "vitest";
import {
  dashboardWallRangeToIso,
  instantToWallHour,
  parseDashboardRangeQuery,
  rebaseWallClockHour,
  wallHourToInstant,
} from "@/lib/dashboard-url-range";

/* 仪表盘 URL 时间参数（2026-10-10 与会话追踪页统一 UTC ISO，读路径兼容旧墙钟书签）。 */

describe("parseDashboardRangeQuery 双格式读取", () => {
  test("UTC ISO 链接按东八区换算为墙钟串并标记 explicit", () => {
    const parsed = parseDashboardRangeQuery("start=2026-10-08T16:00:00.000Z&end=2026-10-09T16:00:00.000Z");
    expect(parsed).toEqual({start: "2026-10-09T00:00", end: "2026-10-10T00:00", explicit: true});
  });

  test("带 ±HH:MM 偏移的 ISO 同样接受，且分钟零头先取整到小时", () => {
    // 16:30Z 取整 16:00Z → 东八区 10-09 00:00；09:20-08:00 = 17:20Z 取整 17:00Z → 东八区 10-10 01:00。
    // （查询串里的裸 + 会被 URLSearchParams 解码成空格，偏移写法用例取负偏移。）
    const parsed = parseDashboardRangeQuery("start=2026-10-08T16:30:00Z&end=2026-10-09T09:20:00-08:00");
    expect(parsed).toEqual({start: "2026-10-09T00:00", end: "2026-10-10T01:00", explicit: true});
  });

  test("旧墙钟书签字符串原样保留并标记 explicit", () => {
    const parsed = parseDashboardRangeQuery("start=2026-10-09T00:00&end=2026-10-10T00:00");
    expect(parsed).toEqual({start: "2026-10-09T00:00", end: "2026-10-10T00:00", explicit: true});
  });

  test("end <= start 视为未携带", () => {
    expect(parseDashboardRangeQuery("start=2026-10-09T00:00&end=2026-10-09T00:00").explicit).toBe(false);
    expect(parseDashboardRangeQuery("start=2026-10-09T16:00:00.000Z&end=2026-10-09T16:00:00.000Z").explicit).toBe(false);
  });

  test("混格式 / 缺参 / 非法值视为未携带", () => {
    expect(parseDashboardRangeQuery("start=2026-10-08T16:00:00.000Z&end=2026-10-10T00:00").explicit).toBe(false);
    expect(parseDashboardRangeQuery("start=2026-10-09T00:00").explicit).toBe(false);
    expect(parseDashboardRangeQuery("").explicit).toBe(false);
    expect(parseDashboardRangeQuery("start=not-a-date&end=2026-10-10T00:00").explicit).toBe(false);
    expect(parseDashboardRangeQuery("start=2026-13-01T00:00&end=2026-10-10T00:00").explicit).toBe(false);
  });
});

describe("dashboardWallRangeToIso URL 写入", () => {
  test("墙钟按偏移换算为 UTC ISO（东八区今天 = 前一日 16:00Z）", () => {
    expect(dashboardWallRangeToIso("2026-10-09T00:00", "2026-10-10T00:00", 480))
      .toEqual({start: "2026-10-08T16:00:00.000Z", end: "2026-10-09T16:00:00.000Z"});
  });

  test("墙钟含分钟零头时取整到小时，保证读写往返一致", () => {
    expect(dashboardWallRangeToIso("2026-10-09T00:30", "2026-10-10T00:00", 480))
      .toEqual({start: "2026-10-08T16:00:00.000Z", end: "2026-10-09T16:00:00.000Z"});
  });

  test("写入 ISO 再读回得到同一墙钟窗口（往返不漂移）", () => {
    const iso = dashboardWallRangeToIso("2026-10-09T00:00", "2026-10-10T00:00", 480)!;
    const parsed = parseDashboardRangeQuery(`start=${encodeURIComponent(iso.start)}&end=${encodeURIComponent(iso.end)}`);
    expect(parsed).toEqual({start: "2026-10-09T00:00", end: "2026-10-10T00:00", explicit: true});
  });

  test("非法输入返回 undefined（调用方跳过 URL 改写）", () => {
    expect(dashboardWallRangeToIso("garbage", "2026-10-10T00:00", 480)).toBeUndefined();
    expect(dashboardWallRangeToIso("2026-10-11T00:00", "2026-10-10T00:00", 480)).toBeUndefined();
  });
});

describe("时区切换重排（窗口不平移）", () => {
  test("同一绝对时刻在东八区与东九区的墙钟串互换", () => {
    // 东八区 10-09 00:00 = 10-08T16:00Z = 东九区 10-09 01:00 = 西八区 10-08 08:00。
    expect(rebaseWallClockHour("2026-10-09T00:00", 480, 540)).toBe("2026-10-09T01:00");
    expect(rebaseWallClockHour("2026-10-09T01:00", 540, 480)).toBe("2026-10-09T00:00");
    expect(rebaseWallClockHour("2026-10-09T00:00", 480, -480)).toBe("2026-10-08T08:00");
  });

  test("非法墙钟串原样返回（防御）", () => {
    expect(rebaseWallClockHour("oops", 480, 540)).toBe("oops");
  });
});

describe("墙钟 ↔ 绝对时刻换算原语", () => {
  test("wallHourToInstant 按偏移解释，字段越界返回 NaN", () => {
    expect(wallHourToInstant("2026-10-09T00:00", 480)).toBe(Date.parse("2026-10-08T16:00:00.000Z"));
    expect(Number.isNaN(wallHourToInstant("2026-13-01T00:00", 480))).toBe(true);
    expect(Number.isNaN(wallHourToInstant("2026-10-09T24:00", 480))).toBe(true);
    expect(Number.isNaN(wallHourToInstant("garbage", 480))).toBe(true);
  });

  test("instantToWallHour 分钟截断且支持负偏移", () => {
    expect(instantToWallHour(Date.parse("2026-10-08T16:30:00.000Z"), 480)).toBe("2026-10-09T00:00");
    expect(instantToWallHour(Date.parse("2026-10-09T00:30:00.000Z"), -480)).toBe("2026-10-08T16:00");
  });
});
