import { describe, expect, test } from "vitest";
import {
  defaultWorkbenchRange,
  datetimeLocalToIso,
  isoToDatetimeLocal,
  matchWorkbenchRangePreset,
  normalizeWorkbenchRange,
  resolveWorkbenchRangeParams,
  workbenchRangeForPreset,
} from "../src/lib/workbench-time-range";

describe("会话追踪时间范围", () => {
  test("墙钟串按全局时区偏移与 UTC ISO 互转", () => {
    // UTC+8 下 2026-09-08 00:00:00 墙钟 = 前一日 16:00 UTC。
    const iso = datetimeLocalToIso("2026-09-08T00:00:00", 480);
    expect(iso).toBe("2026-09-07T16:00:00.000Z");
    expect(isoToDatetimeLocal(iso!, 480)).toBe("2026-09-08T00:00:00");
    // 分钟精度（无秒）也接受
    const minuteIso = datetimeLocalToIso("2026-09-08T12:30", 480);
    expect(minuteIso).toBe("2026-09-08T04:30:00.000Z");
    expect(isoToDatetimeLocal("2026-09-08T04:30:00.000Z", 480)).toBe("2026-09-08T12:30:00");
    expect(datetimeLocalToIso("2026-09-08 00:00", 480)).toBeUndefined();
    expect(datetimeLocalToIso("not-a-date", 480)).toBeUndefined();
  });

  test("默认范围为「今天」且按全局时区自然日对齐（2026-09-17 用户确认）", () => {
    const now = new Date(Date.UTC(2026, 8, 8, 7, 30, 0)); // UTC+8 的 15:30
    const range = defaultWorkbenchRange(new Date(now), 480);
    expect(range.start).toBe("2026-09-07T16:00:00.000Z");
    expect(range.end).toBe("2026-09-08T16:00:00.000Z");
  });

  test("预设档位按全局时区自然日对齐，含近 3 天档", () => {
    const now = new Date(Date.UTC(2026, 8, 8, 7, 30, 0)); // UTC+8 的 15:30
    const today = workbenchRangeForPreset("today", now, 480);
    expect(today.start).toBe("2026-09-07T16:00:00.000Z");
    expect(today.end).toBe("2026-09-08T16:00:00.000Z");

    const yesterday = workbenchRangeForPreset("yesterday", now, 480);
    expect(yesterday.start).toBe("2026-09-06T16:00:00.000Z");
    expect(yesterday.end).toBe("2026-09-07T16:00:00.000Z");

    const last24h = workbenchRangeForPreset("24h", now, 480);
    expect(last24h.start).toBe("2026-09-07T07:30:00.000Z");
    expect(last24h.end).toBe("2026-09-08T07:31:00.000Z");

    const last3d = workbenchRangeForPreset("3d", now, 480);
    expect(last3d.start).toBe("2026-09-05T16:00:00.000Z");
    expect(last3d.end).toBe("2026-09-08T16:00:00.000Z");
    expect((Date.parse(last3d.end) - Date.parse(last3d.start)) / 86_400_000).toBe(3);

    const last15d = workbenchRangeForPreset("15d", now, 480);
    expect((Date.parse(last15d.end) - Date.parse(last15d.start)) / 86_400_000).toBe(15);
  });

  test("normalizeWorkbenchRange：跨度不设上限，非法输入回退 undefined", () => {
    // 2026-09-21 用户确认：不再做 1 个月钳制，统一受存储管理的保留窗口约束。
    const wide = normalizeWorkbenchRange(
      "2026-01-01T00:00:00.000Z",
      "2026-03-01T00:00:00.000Z",
    );
    expect(wide).toEqual({
      start: "2026-01-01T00:00:00.000Z",
      end: "2026-03-01T00:00:00.000Z",
    });

    const exact = normalizeWorkbenchRange(
      "2026-01-01T00:00:00.000Z",
      "2026-02-01T00:00:00.000Z",
    );
    expect(exact?.start).toBe("2026-01-01T00:00:00.000Z");

    expect(normalizeWorkbenchRange("bad", "2026-02-01T00:00:00.000Z")).toBeUndefined();
    expect(normalizeWorkbenchRange(
      "2026-02-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
    )).toBeUndefined();
  });

  test("resolveWorkbenchRangeParams：显式参数非法时回退默认档（按传入偏移）", () => {
    const now = new Date(Date.UTC(2026, 8, 8, 7, 30, 0));
    const fallback = resolveWorkbenchRangeParams({}, now, 480);
    expect(fallback).toEqual(defaultWorkbenchRange(now, 480));

    const utcOffsetFallback = resolveWorkbenchRangeParams({}, now, 0);
    expect(utcOffsetFallback.start).toBe("2026-09-08T00:00:00.000Z");
    expect(utcOffsetFallback.end).toBe("2026-09-09T00:00:00.000Z");

    const fromUrl = resolveWorkbenchRangeParams({
      start: "2026-08-01T00:00:00.000Z",
      end: "2026-08-08T00:00:00.000Z",
    }, now, 480);
    expect(fromUrl.start).toBe("2026-08-01T00:00:00.000Z");
    expect(fromUrl.end).toBe("2026-08-08T00:00:00.000Z");

    const wide = resolveWorkbenchRangeParams({
      start: "2026-01-01T00:00:00.000Z",
      end: "2026-03-01T00:00:00.000Z",
    }, now, 480);
    expect(wide.start).toBe("2026-01-01T00:00:00.000Z");
    expect(wide.end).toBe("2026-03-01T00:00:00.000Z");
  });

  test("matchWorkbenchRangePreset 命中当前预设", () => {
    const now = new Date(Date.UTC(2026, 8, 8, 7, 30, 0));
    expect(matchWorkbenchRangePreset(workbenchRangeForPreset("7d", now, 480), now, 480)).toBe("7d");
    expect(matchWorkbenchRangePreset(workbenchRangeForPreset("3d", now, 480), now, 480)).toBe("3d");
    expect(matchWorkbenchRangePreset({ start: "2026-01-01T00:00:00.000Z", end: "2026-01-02T00:00:00.000Z" }, now, 480)).toBeUndefined();
  });
});
