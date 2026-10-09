import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 统一保留策略配置（docs/上线前架构升级改造.md §2，2026-09-14 用户确认）。
 *
 * `rawRetentionDays` 是唯一时间窗来源，同时驱动：投影窗口（超窗登记 archived 不建
 * 派生 job）、raw 读取窗口（超窗 exchange 的单侧 Raw 读取返回显式 expired 状态）、
 * 一键清除判定（只处理整文件全部 exchange 超窗的 capture 文件）、派生物外置 gz 的
 * 保留（随 raw 清理一并 GC）。配置持久化在数据目录 config/retention.json，无敏感
 * 数据；读取失败一律安全回退默认值，绝不阻断摄取主链路。
 */

export const RETENTION_CONFIG_FILENAME = "retention.json";
export const MIN_RAW_RETENTION_DAYS = 3;
export const MAX_RAW_RETENTION_DAYS = 180;
export const DEFAULT_RAW_RETENTION_DAYS = 15;

export interface RetentionConfig {
  version: 1;
  rawRetentionDays: number;
}

export function retentionConfigPath(dataDir: string): string {
  return join(dataDir, "config", RETENTION_CONFIG_FILENAME);
}

export function clampRawRetentionDays(days: unknown): number {
  const parsed = typeof days === "number" ? days : Number(days);
  if (!Number.isFinite(parsed)) return DEFAULT_RAW_RETENTION_DAYS;
  const rounded = Math.floor(parsed);
  if (rounded < MIN_RAW_RETENTION_DAYS) return MIN_RAW_RETENTION_DAYS;
  if (rounded > MAX_RAW_RETENTION_DAYS) return MAX_RAW_RETENTION_DAYS;
  return rounded;
}

/** 读取保留配置；文件缺失、损坏或越界一律回退默认值（安全侧）。 */
export function readRetentionConfig(dataDir: string): RetentionConfig {
  try {
    const file = retentionConfigPath(dataDir);
    if (!existsSync(file)) return defaultRetentionConfig();
    const parsed = JSON.parse(readFileSync(file, "utf8")) as {
      rawRetentionDays?: unknown;
    };
    return { version: 1, rawRetentionDays: clampRawRetentionDays(parsed.rawRetentionDays) };
  } catch {
    return defaultRetentionConfig();
  }
}

export function writeRetentionConfig(
  dataDir: string,
  rawRetentionDays: number,
): RetentionConfig {
  const config: RetentionConfig = {
    version: 1,
    rawRetentionDays: clampRawRetentionDays(rawRetentionDays),
  };
  const file = retentionConfigPath(dataDir);
  mkdirSync(join(dataDir, "config"), { recursive: true });
  writeFileSync(file, JSON.stringify(config, null, 2) + "\n", "utf8");
  return config;
}

/** 计算保留窗口截止时刻（ISO 8601）：captured_at 早于该值的记录视为超窗。 */
export function computeRetentionCutoff(
  rawRetentionDays: number,
  now: number = Date.now(),
): string {
  const days = clampRawRetentionDays(rawRetentionDays);
  return new Date(now - days * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * 判断 captured_at 是否超出保留窗口。captured_at 与 cutoff 均为同一 toISOString
 * 产物的 UTC RFC 3339 字符串，字典序比较等价于时间序；非法/缺失时间戳按「未超窗」
 * 处理（宁可多投影，不可误丢弃）。
 */
export function isBeyondRetentionWindow(capturedAt: string, cutoff: string): boolean {
  if (!capturedAt || !cutoff) return false;
  const captured = Date.parse(capturedAt);
  const cutoffMs = Date.parse(cutoff);
  if (!Number.isFinite(captured) || !Number.isFinite(cutoffMs)) return false;
  return captured < cutoffMs;
}

function defaultRetentionConfig(): RetentionConfig {
  return { version: 1, rawRetentionDays: DEFAULT_RAW_RETENTION_DAYS };
}
