/**
 * 回看窗口天数（2026-10-13 用户定案：30 天 → 7 天）。窗口约束的是「记录
 * completed_at 导入下界 + 文件活跃判据（mtime ≥ floor，7 天无写入即放归历史）」。
 * 旧表述「持续使用中的尾追导入（新行恒在窗口内）不受影响」在 2026-11-03 被证伪：
 * Codex 长会话持续 resume 会把新行 append 到任意老的日期目录（sessions/YYYY/MM/DD
 * 按会话创建日归档），目录名日期裁剪曾把 mtime 活跃的文件永久排除，官方直连导入
 * 静默断流 4 天。现由 codex 适配器的活跃注册表兜底（全量目录扫描 + 低频重扫 +
 * 活跃清单外缓存逐出）——老目录的活跃文件照常被发现，非活跃数据绝不驻留内存。
 * seen 保留余量由本常量派生，自动跟随。
 */
export const LOCAL_IMPORT_LOOKBACK_DAYS = 7;
export const LOCAL_IMPORT_LOOKBACK_DAYS_MS = LOCAL_IMPORT_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;

/**
 * seen 表保留余量（2026-10-05 D2 有界清理，用户确认）：清理只删 imported_at 早于
 * 「回看窗口 + 5 天余量」的行——被删行对应的候选 completed_at ≤ imported_at，必然
 * 已早于窗口下界，同一 floor 下不可能重新成为候选，幂等不受影响。
 */
export const SEEN_RETENTION_MARGIN_MS = 5 * 24 * 60 * 60 * 1000;
