"use client";

import {useCallback, useEffect, useMemo, useRef, useState} from "react";
import {pad} from "./format";

export interface HourPickerProps {
  /** 值形如 "YYYY-MM-DDTHH:00"（datetime-local 小时对齐格式）。 */
  value: string;
  onChange: (next: string) => void;
  ariaLabel: string;
}

const WEEKDAY_HEADERS = ["一", "二", "三", "四", "五", "六", "日"] as const;

/** 仪表盘专用小时级时间选择器：无分钟列，点选小时后自动收起。 */
export function HourPicker({value, onChange, ariaLabel}: HourPickerProps) {
  const [open, setOpen] = useState(false);
  const [viewYear, setViewYear] = useState(() => Number(value.slice(0, 4)) || 1970);
  const [viewMonth, setViewMonth] = useState(() => Number(value.slice(5, 7)) || 1);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const openPanel = useCallback(() => {
    setViewYear(Number(value.slice(0, 4)) || new Date().getFullYear());
    setViewMonth(Number(value.slice(5, 7)) || new Date().getMonth() + 1);
    setOpen(true);
  }, [value]);

  const datePart = value.slice(0, 10);
  const hourPart = Number(value.slice(11, 13)) || 0;

  const selectDate = useCallback((day: number) => {
    const next = `${viewYear}-${pad(viewMonth)}-${pad(day)}`;
    onChange(`${next}T${pad(hourPart)}:00`);
  }, [hourPart, onChange, viewMonth, viewYear]);

  const selectHour = useCallback((hour: number) => {
    onChange(`${datePart}T${pad(hour)}:00`);
    setOpen(false);
  }, [datePart, onChange]);

  const calendar = useMemo(() => buildCalendar(viewYear, viewMonth), [viewMonth, viewYear]);
  const monthLabel = `${viewYear} 年 ${viewMonth} 月`;
  const todayKey = (() => {
    const now = new Date();
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  })();

  const shiftMonth = (delta: number) => {
    const next = new Date(viewYear, viewMonth - 1 + delta, 1);
    setViewYear(next.getFullYear());
    setViewMonth(next.getMonth() + 1);
  };

  return (
    <div className="hour-picker" ref={rootRef}>
      <button
        type="button"
        className="hour-picker-input"
        aria-label={ariaLabel}
        aria-expanded={open}
        onClick={() => (open ? setOpen(false) : openPanel())}
      >
        {datePart} {pad(hourPart)}:00
      </button>
      {open ? (
        <div className="hour-picker-panel" role="dialog" aria-label={`${ariaLabel}选择面板`}>
          <div className="hour-picker-head">
            <button type="button" aria-label="上一月" onClick={() => shiftMonth(-1)}>‹</button>
            <strong>{monthLabel}</strong>
            <button type="button" aria-label="下一月" onClick={() => shiftMonth(1)}>›</button>
          </div>
          <div className="hour-picker-weekdays">
            {WEEKDAY_HEADERS.map(day => <span key={day}>{day}</span>)}
          </div>
          <div className="hour-picker-days">
            {calendar.map((cell, index) => cell === null ? (
              <span key={`blank-${index}`} />
            ) : (
              <button
                key={cell.key}
                type="button"
                className={cell.key === datePart ? "hour-picker-day active" : "hour-picker-day"}
                onClick={() => selectDate(cell.day)}
              >
                {cell.day}
              </button>
            ))}
          </div>
          <div className="hour-picker-hours">
            {Array.from({length: 24}, (_, hour) => (
              <button
                key={hour}
                type="button"
                className={hour === hourPart ? "hour-picker-hour active" : "hour-picker-hour"}
                onClick={() => selectHour(hour)}
              >
                {pad(hour)}
              </button>
            ))}
          </div>
          <div className="hour-picker-foot">
            <button
              type="button"
              onClick={() => {
                onChange(`${todayKey}T00:00`);
                setViewYear(Number(todayKey.slice(0, 4)));
                setViewMonth(Number(todayKey.slice(5, 7)));
              }}
            >
              今天 00 时
            </button>
            <button type="button" onClick={() => setOpen(false)}>关闭</button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** 生成周一起始的 6×7 日历网格，空位为 null。 */
function buildCalendar(year: number, month: number): Array<{key: string; day: number} | null> {
  const firstDay = new Date(year, month - 1, 1);
  const daysInMonth = new Date(year, month, 0).getDate();
  const lead = (firstDay.getDay() + 6) % 7;
  const cells: Array<{key: string; day: number} | null> = [];
  for (let i = 0; i < lead; i += 1) cells.push(null);
  for (let day = 1; day <= daysInMonth; day += 1) {
    cells.push({key: `${year}-${pad(month)}-${pad(day)}`, day});
  }
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
}
