import type {DeepaaDatabase} from "@/lib/db/sqlite-driver";
import {
  computeRetentionCutoff,
  isBeyondRetentionWindow,
  readRetentionConfig,
} from "../retention";

/**
 * Raw 读取统一门禁（docs/上线前架构升级改造.md P0-5，决策 D1/D8）。
 *
 * 所有「显式单侧 Raw 读取」入口（完整 Raw 流、结构化 Inspector、媒体查看、交互
 * 内容页）在打开任何 raw 字节前必须先过本门禁：
 * - purged：raw 已按保留策略清理（raw_exchange_refs 墓碑），返回显式状态；
 * - expired：raw 仍在盘上但 captured_at 超出保留窗口，同样显式拒绝——窗口外不再
 *   支持查看完整交互内容（用户 2026-09-14 确认）。
 * 两者都是结构化状态（HTTP 410 + 稳定错误码），不是 5xx/崩溃；调用方据此渲染
 * 「原始数据已按保留策略清理 / 超出保留窗口」的占位说明。
 */

export type RawReadGateState = "active" | "purged" | "expired";

export interface RawReadGateResult {
  state: RawReadGateState;
  capturedAt: string;
  retentionDays: number;
}

interface RawReadGateRow {
  raw_state: string;
  captured_at: string;
}

export function classifyRawReadGate(
  db: DeepaaDatabase,
  dataDir: string,
  exchangeId: string,
): RawReadGateResult | undefined {
  const row = db.prepare(
    `SELECT raw_state, captured_at FROM raw_exchange_refs WHERE exchange_id = ?`,
  ).get(exchangeId) as RawReadGateRow | undefined;
  if (!row) return undefined;
  const retentionDays = readRetentionConfig(dataDir).rawRetentionDays;
  if (row.raw_state === "purged") {
    return {state: "purged", capturedAt: row.captured_at, retentionDays};
  }
  const cutoff = computeRetentionCutoff(retentionDays);
  if (isBeyondRetentionWindow(row.captured_at, cutoff)) {
    return {state: "expired", capturedAt: row.captured_at, retentionDays};
  }
  return {state: "active", capturedAt: row.captured_at, retentionDays};
}

export function rawReadGateMessage(gate: RawReadGateResult): string {
  if (gate.state === "purged") {
    return `原始数据已按保留策略清理（捕获于 ${gate.capturedAt}），该 Exchange 的完整正文不再可用。`;
  }
  if (gate.state === "expired") {
    return `原始数据超出 ${gate.retentionDays} 天保留窗口（捕获于 ${gate.capturedAt}），不再支持查看完整正文。`;
  }
  return "";
}
