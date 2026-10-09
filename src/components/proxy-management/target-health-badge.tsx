/**
 * 供应商健康徽标（公共组件，2026-09-20 用户确认设计）。
 *
 * 供应商管理侧栏与仪表盘供应商卡共用：每个目标同一时刻最多渲染一个标识，
 * 判定与文案统一来自 `@/lib/sync-engine/target-health-badge`（纯函数、双端共用）。
 * severity 两档视觉：severe = 红（账号未设置 / 套餐（订阅）未设置 / 同步失败 / 倍率未校验），
 * normal = 黄（倍率待确认）；badge 为 null 时不渲染任何内容。
 */

import {AlertTriangle} from "lucide-react";
import type {TargetHealthBadge} from "@/lib/sync-engine/target-health-badge";
import styles from "./target-health-badge.module.css";

export function TargetHealthBadge({badge}: {badge: TargetHealthBadge | null}) {
  if (!badge) return null;
  return (
    <span
      className={`${styles.healthBadge} ${badge.severity === "severe" ? styles.healthBadgeSevere : ""}`}
      title={badge.title}
      aria-label={badge.label}
    >
      <AlertTriangle size={11} aria-hidden="true" />
      {badge.label}
    </span>
  );
}
