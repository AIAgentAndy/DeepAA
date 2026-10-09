"use client";

import { useMemo, type ReactNode } from "react";
import { useGlobalTimeZone } from "@/lib/timezone-preference";
import {
  datetimeLocalToIso,
  isoToDatetimeLocal,
  matchWorkbenchRangePreset,
  normalizeWorkbenchRange,
  WORKBENCH_RANGE_PRESETS,
  workbenchRangeForPreset,
  type WorkbenchRange,
  type WorkbenchRangePreset,
} from "@/lib/workbench-time-range";

/**
 * 会话追踪页时间范围区块（与仪表盘筛选条同一视觉语言）：
 * 开始/结束时间支持到分秒级（原生 datetime-local，step=1）+ 预设档位。
 * 跨度不设上限（2026-09-21 用户确认）：统一受存储管理的保留窗口约束，
 * 查询区右侧展示范围不完整提示（note 插槽）。
 * 墙钟串与 UTC 的互转、预设档位的日界一律按右上角全局时区（2026-09-17 全站时区统一）。
 */
export function SessionsTimeRange({
  value,
  onChange,
  onReset,
  note,
}: {
  value: WorkbenchRange;
  onChange: (next: WorkbenchRange) => void;
  /** 全量重置（时间恢复默认「今天」+ 清空选择与全部 URL 参数）；未提供时仅恢复今天。 */
  onReset?: () => void;
  /** 条尾附加说明（如保留窗口范围提示），展示在范围提示之后。 */
  note?: ReactNode;
}) {
  const globalTz = useGlobalTimeZone();
  const offsetMinutes = globalTz.offsetMinutes;
  const startLocal = isoToDatetimeLocal(value.start, offsetMinutes) ?? value.start;
  const endLocal = isoToDatetimeLocal(value.end, offsetMinutes) ?? value.end;
  const activePreset = useMemo(
    () => matchWorkbenchRangePreset(value, new Date(), offsetMinutes),
    [value, offsetMinutes],
  );

  function apply(next: WorkbenchRange): void {
    const normalized = normalizeWorkbenchRange(next.start, next.end);
    if (normalized) onChange({ start: normalized.start, end: normalized.end });
  }

  function changeBoundary(boundary: "start" | "end", localValue: string): void {
    const iso = datetimeLocalToIso(localValue, offsetMinutes);
    if (!iso) return;
    apply(boundary === "start" ? { ...value, start: iso } : { ...value, end: iso });
  }

  function applyPreset(key: WorkbenchRangePreset["key"]): void {
    apply(workbenchRangeForPreset(key, new Date(), offsetMinutes));
  }

  return (
    <section className="sessions-range-bar" aria-label="会话时间范围">
      <span className="sessions-range-title">时间范围</span>
      <label className="sessions-range-field">
        <span className="sessions-range-label">开始</span>
        <input
          type="datetime-local"
          step={1}
          className="sessions-range-input"
          aria-label="开始时间（含边界）"
          value={startLocal}
          onChange={event => changeBoundary("start", event.currentTarget.value)}
        />
      </label>
      <label className="sessions-range-field">
        <span className="sessions-range-label">结束</span>
        <input
          type="datetime-local"
          step={1}
          className="sessions-range-input"
          aria-label="结束时间（排他边界）"
          value={endLocal}
          onChange={event => changeBoundary("end", event.currentTarget.value)}
        />
      </label>
      <span className="sessions-range-divider" aria-hidden="true" />
      <div className="sessions-range-presets" role="group" aria-label="时间范围预设">
        {WORKBENCH_RANGE_PRESETS.map(preset => (
          <button
            key={preset.key}
            type="button"
            className={`sessions-range-chip${activePreset === preset.key ? " active" : ""}`}
            onClick={() => applyPreset(preset.key)}
          >
            {preset.label}
          </button>
        ))}
      </div>
      <button
        type="button"
        className="sessions-range-reset"
        onClick={() => (onReset ? onReset() : onChange(workbenchRangeForPreset("today", new Date(), offsetMinutes)))}
        title="重置全部：时间恢复默认今天，清空选择与全部 URL 参数"
      >
        重置
      </button>
      <span className="sessions-range-spacer" />
      {note ? <span className="sessions-range-note">{note}</span> : null}
    </section>
  );
}
