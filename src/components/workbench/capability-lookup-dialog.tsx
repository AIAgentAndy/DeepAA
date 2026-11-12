"use client";

/**
 * P1-4（2026-11-03）：能力详情对话框（双向反查·最小版）。
 * 从「响应」能力面板 / 能力清单条目打开：显示该能力（Agent + 名字级身份）的
 * 调用反查（keyset 分页）与声明出现；反查行可点击回到对应 Step（selection 深链）。
 * 诚实边界：coverage=name-level（能力台账落地前不冒充精确身份）。
 */

import {useCallback, useEffect, useRef, useState} from "react";
import {SimpleDialog} from "@/components/simple-dialog";
import {formatLocalDateTime} from "@/lib/local-time";
import type {CapabilityLookupResult} from "@/lib/db/capability-lookup-queries";

export interface CapabilityLookupTarget {
  agentName: string;
  kind: "tool" | "skill";
  name: string;
}

export interface CapabilityNavigateTarget {
  stepId: string;
  sessionId: string;
  threadId: string;
  turnId?: string;
  agentName: string;
  targetId: string;
}

export function CapabilityLookupDialog({target, onClose, onNavigate}: {
  target: CapabilityLookupTarget | undefined;
  onClose: () => void;
  onNavigate: (loc: CapabilityNavigateTarget) => void;
}) {
  const [result, setResult] = useState<CapabilityLookupResult>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const seqRef = useRef(0);

  const load = useCallback(async (cursor?: string) => {
    if (!target) return;
    const seq = ++seqRef.current;
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({agent: target.agentName, kind: target.kind, name: target.name});
      if (cursor) params.set("cursor", cursor);
      const response = await fetch(`/api/capabilities/lookup?${params}`, {cache: "no-store"});
      if (seq !== seqRef.current) return;
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json() as CapabilityLookupResult;
      if (seq !== seqRef.current) return;
      setResult(payload);
    } catch (err) {
      if (seq !== seqRef.current) return;
      setError((err as Error).message || "读取失败");
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  }, [target]);

  useEffect(() => {
    if (target) void load();
    else {
      setResult(undefined);
      setError("");
    }
  }, [target, load]);

  if (!target) return null;
  return (
    <SimpleDialog
      title={`${target.name}`}
      description={`能力反查 · ${target.agentName} · ${target.kind === "tool" ? "工具" : "Skill"}（名字级身份）`}
      onClose={onClose}
      footer={
        <>
          <button
            type="button"
            className="comp-link"
            onClick={() => {
              onClose();
              window.open(`/agent-capabilities?agent=${encodeURIComponent(target.agentName)}&view=usage&tool=${encodeURIComponent(target.name)}`, "_self");
            }}
          >
            在 Agent 能力页查看工具详情 →
          </button>
          <button type="button" className="ghost-btn" onClick={onClose}>关闭</button>
        </>
      }
    >
      {loading && !result ? <p className="caps-lookup-muted">正在读取反查数据…</p> : null}
      {error ? (
        <p className="caps-lookup-muted">反查读取失败（{error}）· <button type="button" className="comp-link" onClick={() => void load()}>重试</button></p>
      ) : null}
      {result ? (
        <div className="caps-lookup">
          {/* 全零诚实说明(2026-11-12 用户反馈):不是坏数据,是"装了没用过"。 */}
          {result.totals.declaredStepCount === 0 && result.totals.invokedCallCount === 0 ? (
            <p className="caps-lookup-muted">
              该{target.kind === "skill" ? " Skill 已安装但" : "能力"}在观测范围内没有任何调用或声明记录——
              {target.kind === "skill" ? "即从未被加载使用。" : "即从未被调用。"}统计口径为全量历史(非时间窗口)。
            </p>
          ) : null}
          <div className="caps-lookup-totals">
            <span>声明出现 {result.totals.declaredStepCount} 步</span>
            <span>调用 {result.totals.invokedStepCount} 步 / {result.totals.invokedCallCount} 次</span>
            {result.totals.lastActivityAt ? <span>最近活动 {formatLocalDateTime(result.totals.lastActivityAt)}</span> : null}
          </div>
          <p className="caps-lookup-muted">身份口径：Agent + 名字（同名跨 MCP/插件的歧义在能力台账落地前不判定）。</p>

          <h4>调用记录（最近 {result.calls.processedCount}{result.calls.hasMore ? "，共 " + result.calls.candidateCount : ""}）</h4>
          {result.calls.items.length > 0 ? (
            <div className="caps-lookup-rows">
              {result.calls.items.map(row => (
                <button type="button" key={`${row.stepId}:${row.exchangeId}`}
                  className="caps-lookup-row caps-lookup-row-exec"
                  title={row.execution ? executionTitle(row.execution) : undefined}
                  onClick={() => onNavigate({stepId: row.stepId, sessionId: row.sessionId, threadId: row.threadId, turnId: row.turnId, agentName: row.agentName, targetId: row.targetId})}>
                  <span className="mono">Step {row.stepIndex}</span>
                  <span>{formatLocalDateTime(row.capturedAt)}</span>
                  <span className="caps-lookup-status" data-status={row.status}>
                    {statusLabel(row.status)}
                    {row.execution ? <span className="caps-lookup-exec"> · 执行{executionLabel(row.execution)}</span> : null}
                  </span>
                </button>
              ))}
              {result.calls.hasMore && result.calls.nextCursor ? (
                <button type="button" className="caps-lookup-more" onClick={() => void load(result.calls.nextCursor)}>加载更早 20 条…</button>
              ) : null}
            </div>
          ) : <p className="caps-lookup-muted">{target.kind === "skill" ? "未观察到调用——该 Skill 已安装但从未被加载。" : "未观察到调用。"}</p>}

          <h4>声明出现（最近 {result.declaredIn.processedCount}{result.declaredIn.hasMore ? `，共 ${result.declaredIn.candidateCount}（只显示首页）` : ""}）</h4>
          {result.declaredIn.items.length > 0 ? (
            <div className="caps-lookup-rows">
              {result.declaredIn.items.map(row => (
                <button type="button" key={row.stepId}
                  className="caps-lookup-row"
                  onClick={() => onNavigate({stepId: row.stepId, sessionId: row.sessionId, threadId: row.threadId, turnId: row.turnId, agentName: target.agentName, targetId: ""})}>
                  <span className="mono">Step {row.stepIndex}</span>
                  <span>{formatLocalDateTime(row.capturedAt)}</span>
                  <span>{row.invokedThisStep > 0 ? `本步调用 ${row.invokedThisStep} 次` : "声明未调用"}</span>
                </button>
              ))}
            </div>
          ) : <p className="caps-lookup-muted">未观察到声明（可能仅作为调用出现，或该 Agent 的声明观测不完整）。</p>}
        </div>
      ) : null}

      {result && result.definitions && result.definitions.length > 0 ? (
        <>
          <h4>定义演变（{result.definitions.length} 个快照形态 · 名字级）</h4>
          {(() => {
            const latest = result.definitions?.[result.definitions.length - 1];
            if (!latest?.description) return null;
            return (
              <div className="caps-lookup-tool-detail">
                <b>工具说明</b>
                <p>{latest.description}</p>
                {latest.paramNames ? (
                  <p className="caps-lookup-muted">参数:{latest.paramNames}</p>
                ) : null}
              </div>
            );
          })()}
          <div className="caps-lookup-rows">
            {result.definitions.map(def => (
              <div key={def.snapshotHash} className="caps-lookup-row" role="presentation">
                <span className="mono">{new Date(def.firstSeenAt).toLocaleDateString()}</span>
                <span>→ {new Date(def.lastSeenAt).toLocaleDateString()}</span>
                <span className="caps-lookup-status">定义约 {def.schemaTokensEst.toLocaleString()} tokens</span>
              </div>
            ))}
          </div>
          <p className="caps-lookup-muted">同一名字在不同时期快照中的定义规模;变化时旧值保留为历史,不回改。</p>
        </>
      ) : null}
    </SimpleDialog>
  );
}

function statusLabel(status: string): string {
  if (status === "completed") return "有结果";
  if (status === "error") return "有结果·出错";
  if (status === "awaiting_result") return "等待结果";
  if (status === "skill-activation") return "Skill 激活";
  return status;
}

/** 执行侧行内摘要（原生证据;来源 zcode tool_usage）。 */
function executionLabel(exec: NonNullable<import("@/lib/db/capability-lookup-queries").CapabilityLookupCallRow["execution"]>): string {
  const parts: string[] = [];
  if (exec.status) parts.push(exec.status === "completed" ? "完成" : exec.status === "error" ? "出错" : exec.status);
  if (exec.durationMs !== null && exec.durationMs !== undefined) parts.push(`${(exec.durationMs / 1000).toFixed(1)}s`);
  if (typeof exec.exitCode === "number") parts.push(`exit ${exec.exitCode}`);
  if (exec.retryCount && exec.retryCount > 0) parts.push(`重试 ${exec.retryCount}`);
  if (exec.cancelledByUser) parts.push("用户取消");
  return parts.length > 0 ? parts.join(" · ") : "有记录";
}

function executionTitle(exec: NonNullable<import("@/lib/db/capability-lookup-queries").CapabilityLookupCallRow["execution"]>): string {
  const lines = [
    `执行状态: ${exec.status ?? "未知"}`,
    `审批: ${exec.approvalStatus ?? "—"}`,
    `耗时: ${exec.durationMs !== null ? `${exec.durationMs}ms` : "—"}`,
    `首输出: ${exec.timeToFirstOutputMs !== null ? `${exec.timeToFirstOutputMs}ms` : "—"}`,
    `退出码: ${exec.exitCode ?? "—"}`,
    `错误: ${exec.errorType ?? "—"}`,
    "来源: zcode 原生 tool_usage（执行侧证据,wire 不可见）",
  ];
  return lines.join("\n");
}
