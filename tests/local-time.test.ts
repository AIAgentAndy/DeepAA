import { describe, expect, test } from "vitest";
import {
  datetimeLocalValueToIso,
  formatLocalDateTime,
  formatLocalMinute,
  formatRelativeLocalTime,
  isoToDatetimeLocalValue,
} from "../src/lib/local-time.js";

describe("本地时间展示与 datetime-local 转换", () => {
  test("按当前系统时区展示 ISO 时间而不是 UTC 字段", () => {
    const originalTz = process.env.TZ;
    process.env.TZ = "Asia/Shanghai";
    try {
      expect(formatLocalMinute("2026-07-11T00:30:00.000Z")).toBe("07-11 08:30");
      expect(formatLocalDateTime("2026-07-11T00:30:00.000Z")).toBe("2026/07/11 08:30:00");
    } finally {
      if (originalTz === undefined) delete process.env.TZ;
      else process.env.TZ = originalTz;
    }
  });

  test("datetime-local 输入值与 ISO 查询参数按本地时区互转", () => {
    const originalTz = process.env.TZ;
    process.env.TZ = "Asia/Shanghai";
    try {
      expect(isoToDatetimeLocalValue("2026-07-11T00:30:00.000Z")).toBe("2026-07-11T08:30:00");
      expect(datetimeLocalValueToIso("2026-07-11T08:30:00")).toBe("2026-07-11T00:30:00.000Z");
    } finally {
      if (originalTz === undefined) delete process.env.TZ;
      else process.env.TZ = originalTz;
    }
  });

  test("指定 UTC 偏移时按该时区互转，不依赖浏览器/系统时区", () => {
    const originalTz = process.env.TZ;
    process.env.TZ = "UTC";
    try {
      // UTC+8（上海）：绝对时间 00:30Z 显示为 08:30，输入 08:30 转回 00:30Z
      expect(isoToDatetimeLocalValue("2026-07-11T00:30:00.000Z", 480)).toBe("2026-07-11T08:30:00");
      expect(datetimeLocalValueToIso("2026-07-11T08:30:00", 480)).toBe("2026-07-11T00:30:00.000Z");
      // UTC+0：不做偏移
      expect(isoToDatetimeLocalValue("2026-07-11T00:30:00.000Z", 0)).toBe("2026-07-11T00:30:00");
      expect(datetimeLocalValueToIso("2026-07-11T00:30:00", 0)).toBe("2026-07-11T00:30:00.000Z");
      // UTC-5（纽约）：绝对时间 00:30Z 显示为前一天 19:30
      expect(isoToDatetimeLocalValue("2026-07-11T00:30:00.000Z", -300)).toBe("2026-07-10T19:30:00");
      expect(datetimeLocalValueToIso("2026-07-10T19:30:00", -300)).toBe("2026-07-11T00:30:00.000Z");
    } finally {
      if (originalTz === undefined) delete process.env.TZ;
      else process.env.TZ = originalTz;
    }
  });

  test("相对时间在一小时内显示分钟，超过一小时恢复具体时间", () => {
    const now = Date.parse("2026-07-18T12:00:00.000Z");

    expect(formatRelativeLocalTime("2026-07-18T11:59:30.000Z", now)).toBe("刚刚");
    expect(formatRelativeLocalTime("2026-07-18T11:55:00.000Z", now)).toBe("5 分钟前");
    expect(formatRelativeLocalTime("2026-07-18T10:59:00.000Z", now)).toBe("07-18 18:59");
  });
});
