/**
 * 全站统一时区偏好（2026-09-10 用户决策）：右上角唯一入口，移除各页自带的时区选择。
 * 存储：localStorage（`deepaa.timezone`，值域为 TIME_ZONE_OPTIONS 的 UTC±N），
 * 缺省东八区（与历史行为一致）；跨页签同步（storage 事件）+ 同页订阅通知。
 *
 * 时区值域与偏移换算复用 `@/lib/timezones`（固定偏移，无夏令时）。
 */
"use client";

import {useEffect, useState} from "react";
import {DEFAULT_TIME_ZONE, TIME_ZONE_OPTIONS, isSupportedTimeZone, timeZoneOffsetMinutes, type TimeZoneOption} from "@/lib/timezones";

const STORAGE_KEY = "deepaa.timezone";
const listeners = new Set<(value: string) => void>();
let cached: string | undefined;

/** 读取全局时区（非法/缺失回退东八区）。 */
export function readGlobalTimeZone(): string {
  if (cached !== undefined) return cached;
  if (typeof window === "undefined") return DEFAULT_TIME_ZONE;
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    cached = stored && isSupportedTimeZone(stored) ? stored : DEFAULT_TIME_ZONE;
  } catch {
    cached = DEFAULT_TIME_ZONE;
  }
  return cached;
}

/** 写入全局时区并通知订阅者（各页据此重算展示与查询）。 */
export function writeGlobalTimeZone(value: string): void {
  const next = isSupportedTimeZone(value) ? value : DEFAULT_TIME_ZONE;
  cached = next;
  try {
    window.localStorage.setItem(STORAGE_KEY, next);
  } catch {
    /* 隐私模式等写入失败：内存态仍然生效。 */
  }
  for (const listener of listeners) listener(next);
}

export function subscribeGlobalTimeZone(listener: (value: string) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 全局时区选项（含偏移与 IANA，供查询参数换算）。 */
export function globalTimeZoneOption(value: string): TimeZoneOption {
  return TIME_ZONE_OPTIONS.find(option => option.value === value) ?? TIME_ZONE_OPTIONS.find(option => option.value === DEFAULT_TIME_ZONE)!;
}

/**
 * 订阅全局时区：返回当前值（UTC±N）、偏移分钟与等价 IANA。
 * SSR 首帧用东八区占位，挂载后立即同步真实偏好（避免 hydration 不一致）。
 */
export function useGlobalTimeZone(): {value: string; label: string; offsetMinutes: number; iana: string} {
  const [value, setValue] = useState<string>(DEFAULT_TIME_ZONE);
  useEffect(() => {
    setValue(readGlobalTimeZone());
    const unsubscribe = subscribeGlobalTimeZone(setValue);
    function handleStorage(event: StorageEvent): void {
      if (event.key === STORAGE_KEY) setValue(readGlobalTimeZone());
    }
    window.addEventListener("storage", handleStorage);
    return () => {
      unsubscribe();
      window.removeEventListener("storage", handleStorage);
    };
  }, []);
  const option = globalTimeZoneOption(value);
  return {
    value: option.value,
    label: option.label,
    offsetMinutes: timeZoneOffsetMinutes(option.value),
    iana: option.iana,
  };
}
