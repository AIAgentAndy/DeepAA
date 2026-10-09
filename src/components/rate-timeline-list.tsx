"use client";

import {useState} from "react";
import {
  groupRateTimeline,
  segmentRangeText,
  segmentRateText,
  segmentTimeText,
  type DisplayRateSegment,
} from "@/lib/rate-timeline-display";

/**
 * 价格时间线列表（终极方案 2026-09-10）：当前生效段置顶（标注区间右端）→
 * 待生效段紧随（含公告文案）→ 历史段折叠。
 * 价格中心、密钥与模型列表、通知项三处共用；无时间线时不渲染。
 */
export function RateTimelineList({
  timeline,
  now,
  compact = false,
}: {
  timeline: DisplayRateSegment[] | undefined;
  /** 注入当前时刻（测试与 SSR 一致性）。 */
  now?: Date;
  /** 紧凑模式（列表内联展示，隐藏历史折叠区）。 */
  compact?: boolean;
}) {
  const [expandedHistory, setExpandedHistory] = useState(false);
  const grouped = groupRateTimeline(timeline, now);
  if (!timeline?.length || !grouped.current) return null;
  const {current, currentFrom, currentUntil, upcoming, expired} = grouped;
  return (
    <div className="rate-timeline">
      <div className="rate-timeline-segment current">
        <div className="rate-timeline-head">
          <span className="rate-timeline-tag current">当前生效</span>
          <span className="rate-timeline-range">{segmentRangeText(currentFrom, currentUntil)}</span>
        </div>
        <div className="rate-timeline-rates">{segmentRateText(current)}</div>
        {current.changeNote ? <p className="rate-timeline-note">{current.changeNote}</p> : null}
      </div>
      {upcoming.map(segment => (
        <div key={segment.effectiveFrom ?? "upcoming"} className="rate-timeline-segment upcoming">
          <div className="rate-timeline-head">
            <span className="rate-timeline-tag upcoming">{segmentTimeText(segment.effectiveFrom)} 生效</span>
          </div>
          <div className="rate-timeline-rates">{segmentRateText(segment)}</div>
          {segment.changeNote ? <p className="rate-timeline-note">{segment.changeNote}</p> : null}
        </div>
      ))}
      {!compact && expired.length > 0 ? (
        <div className="rate-timeline-history">
          <button type="button" className="rate-timeline-history-toggle" onClick={() => setExpandedHistory(value => !value)}>
            {expandedHistory ? "▾" : "▸"} 历史价格 {expired.length} 段（已过期）
          </button>
          {expandedHistory ? expired.map(segment => (
            <div key={segment.effectiveFrom ?? "expired"} className="rate-timeline-segment expired">
              <div className="rate-timeline-head">
                <span className="rate-timeline-tag expired">{segmentTimeText(segment.effectiveFrom)} 起</span>
              </div>
              <div className="rate-timeline-rates">{segmentRateText(segment)}</div>
            </div>
          )) : null}
        </div>
      ) : null}
    </div>
  );
}
