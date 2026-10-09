"use client";

import { RefreshCw } from "lucide-react";
import type { ScopeType } from "@/lib/db/models";
import type {
  ScopeSummary as ScopeSummaryData,
} from "@/lib/db/workbench-queries";
import type { WorkbenchClientSelection } from "./use-workbench-selection";

const SCOPE_LABELS: Record<ScopeType, "Session" | "Thread" | "Turn" | "Step"> = {
  session: "Session",
  thread: "Thread",
  turn: "Turn",
  step: "Step",
};

interface ScopeSummaryProps {
  summary?: ScopeSummaryData;
  scopeType: ScopeType;
  selection: WorkbenchClientSelection;
  loading?: boolean;
  error?: string;
  onRetry?: () => void;
}

export function parseScopeSummaryResponse(
  value: unknown,
  expectedScopeType: ScopeType,
  expectedScopeId: string,
): ScopeSummaryData | undefined {
  const wrapper = objectRecord(value);
  const summary = objectRecord(wrapper?.summary);
  if (
    !wrapper
    || !summary
    || summary.scopeType !== expectedScopeType
    || summary.scopeId !== expectedScopeId
    || !isWorkerStatus(wrapper.derivedStatus)
    || !SUMMARY_INTEGER_KEYS.every(key => nonNegativeInteger(summary[key]))
    || !SUMMARY_NUMBER_KEYS.every(key => nonNegativeNumber(summary[key]))
    || !optionalNonNegativeNumber(summary.cacheHitRate)
    || !optionalNonNegativeNumber(summary.averageDurationMs)
    || !Array.isArray(summary.tools)
    || !summary.tools.every(isScopeTool)
    || typeof summary.toolsLimited !== "boolean"
  ) {
    return undefined;
  }
  return summary as unknown as ScopeSummaryData;
}

const SUMMARY_INTEGER_KEYS = [
  "requestCount",
  "stepRequestCount",
  "auxiliaryRequestCount",
  "inputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "outputTokens",
  "totalTokens",
  "durationTotalMs",
  "durationSampleCount",
  "toolCallCount",
  "toolsCandidateCount",
  "toolsProcessedCount",
  "dataVersion",
] as const;

const SUMMARY_NUMBER_KEYS = ["vendorCost", "actualCost"] as const;

export function exportScopeHref(
  scopeType: ScopeType,
  selection: WorkbenchClientSelection,
): string {
  const params = new URLSearchParams();
  setParam(params, "target", selection.target);
  setParam(params, "agent", selection.agent);
  setParam(params, "session", selection.session);
  if (scopeType === "thread" || scopeType === "turn" || scopeType === "step") {
    setParam(params, "thread", selection.thread);
  }
  if (scopeType === "turn" || scopeType === "step") setParam(params, "turn", selection.turn);
  if (scopeType === "step") {
    setParam(params, "step", selection.step);
    params.set("scope", "step");
  }
  const query = params.toString();
  return query ? `/export?${query}` : "/export";
}

export function ScopeSummary({
  summary,
  scopeType,
  selection,
  loading = false,
  error,
  onRetry,
}: ScopeSummaryProps) {
  // 聚合条只展示当前 scope 路径，详细指标与跳转入口都已下沉到「交互内容」页签
  // （含「交互内容」页签内的「新窗口打开」按钮），会话追踪不再承担跨页跳转。
  void summary;
  const scopeLabel = SCOPE_LABELS[scopeType];
  return (
    <section className="agg-bar sqlite-scope-summary" aria-label={`${scopeLabel} 层级入口`}>
      <div className="agg-bar-row">
        <div className="agg-bar-context">
          <span className="agg-bar-label">统计范围</span>
          <strong>当前 {scopeLabel}</strong>
          <span className="agg-bar-path" title={scopePath(selection, scopeType)}>
            {scopePath(selection, scopeType) || "暂无选择范围"}
          </span>
        </div>
        <div className="agg-bar-actions">
          {loading ? <span className="summary-state" role="status">范围信息更新中…</span> : null}
          {error ? (
            <span className="summary-state error" role="alert">
              {error}
              {onRetry ? (
                <button type="button" onClick={onRetry} aria-label="重试统计查询">
                  <RefreshCw size={14} aria-hidden="true" />
                  重试
                </button>
              ) : null}
            </span>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function scopePath(
  selection: WorkbenchClientSelection,
  scopeType: ScopeType,
): string {
  const parts = [selection.target, selection.agent, selection.session];
  if (scopeType === "thread" || scopeType === "turn" || scopeType === "step") parts.push(selection.thread);
  if (scopeType === "turn" || scopeType === "step") parts.push(selection.turn);
  if (scopeType === "step") parts.push(selection.step);
  return parts.filter(Boolean).join(" / ");
}

function setParam(params: URLSearchParams, key: string, value: string | undefined): void {
  if (value?.trim()) params.set(key, value);
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function nonNegativeInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function nonNegativeNumber(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function optionalNonNegativeNumber(value: unknown): boolean {
  return value === undefined || nonNegativeNumber(value);
}

function isWorkerStatus(value: unknown): boolean {
  return value === "idle" || value === "running" || value === "paused_disk" || value === "failed";
}

function isScopeTool(value: unknown): boolean {
  const record = objectRecord(value);
  return !!record
    && typeof record.name === "string"
    && record.name.trim().length > 0
    && typeof record.status === "string"
    && record.status.trim().length > 0
    && nonNegativeInteger(record.count);
}
