"use client";

import {Globe} from "lucide-react";
import {TIME_ZONE_OPTIONS} from "@/lib/timezones";
import {useGlobalTimeZone, writeGlobalTimeZone} from "@/lib/timezone-preference";

/**
 * 全站统一时区选择器（2026-09-10 用户确认）：右上角唯一入口，
 * 样式沿用仪表盘时间筛选的「时区」下拉；各页不再自带时区选择。
 * 选择后写入 localStorage 并广播，仪表盘 / Token 价格 / 会话追踪 / 交互内容
 * 全部按该时区换算展示与查询。
 */
export function TimeZoneSelect() {
  const current = useGlobalTimeZone();
  return (
    <label className="topbar-timezone" title="全站时区：影响各页时间展示与统计口径">
      <Globe size={14} aria-hidden />
      <select
        value={current.value}
        onChange={event => writeGlobalTimeZone(event.currentTarget.value)}
        aria-label="全站时区"
      >
        {TIME_ZONE_OPTIONS.map(option => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
    </label>
  );
}
