/** 回看窗口毫秒数（用户定案 D-4：最多回补最近 30 天）。30 天门禁不变。 */
export const LOCAL_IMPORT_LOOKBACK_DAYS = 30;
export const LOCAL_IMPORT_LOOKBACK_DAYS_MS = LOCAL_IMPORT_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;

/**
 * seen 表保留余量（2026-10-05 D2 有界清理，用户确认）：清理只删 imported_at 早于
 * 「回看窗口 + 5 天余量」的行——被删行对应的候选 completed_at ≤ imported_at，必然
 * 已早于窗口下界，同一 floor 下不可能重新成为候选，幂等不受影响。
 */
export const SEEN_RETENTION_MARGIN_MS = 5 * 24 * 60 * 60 * 1000;
