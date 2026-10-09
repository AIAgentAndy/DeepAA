"use client";

import { useEffect, useState } from "react";
import {hasLocalImportAdapter, localImportStatusCopyForAgent} from "@/lib/agent-local-source/presets";
import type { AgentId } from "@/types";
import styles from "./proxy-management/proxy-management.module.css";

interface AgentLocalImportStatusEntry {
  agentId: string;
  label: string;
  adapterPresent: boolean;
  /** 直连导入开关（false = 仅身份标注模式：本地日志照常扫描，不入账）。 */
  directImportEnabled?: boolean;
  binding: {state: "bound" | "disabled"; reason?: string; targetId?: string; viaDefaultTarget?: boolean};
  source?: {state: string; reason?: string; dataDir: string; localSchemaVersion?: string};
  importState?: {
    lastStartedAt?: number;
    lastRecordId?: string;
    cursorResetCount: number;
    skippedModelNotProvisioned: number;
    consecutiveFailures: number;
    lastError?: string;
    importedCount: number;
    lastSuccessAt?: string;
    lastRunCount?: number;
    lastRunDurationMs?: number;
  };
}

/**
 * Agent 卡片内嵌的「官方直连观测」状态区（双链路观测，2026-09-15）：纯状态展示，
 * 无开关无按钮——能力随「官方预设目标启用 + Agent scope」自动启停，导入由调度器
 * 全自动执行。挂载条件只看该 Agent 是否声明本地导入适配（2026-10-06 与默认目标
 * 解耦）：默认目标指向第三方时归因目标按候选扫描推导，状态区不得整块消失。
 */
export function AgentLocalSourceStatus(props: {agentId: AgentId}) {
  const [status, setStatus] = useState<AgentLocalImportStatusEntry | undefined>();
  const [failed, setFailed] = useState(false);
  const visible = hasLocalImportAdapter(props.agentId);

  useEffect(() => {
    if (!hasLocalImportAdapter(props.agentId)) return;
    let disposed = false;
    const load = async () => {
      try {
        const response = await fetch("/api/agent-local-import/status", {cache: "no-store"});
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json() as {agents?: AgentLocalImportStatusEntry[]};
        if (!disposed) {
          setStatus(data.agents?.find(item => item.agentId === props.agentId));
          setFailed(false);
        }
      } catch {
        if (!disposed) setFailed(true);
      }
    };
    void load();
    const timer = setInterval(() => void load(), 30_000);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [props.agentId]);

  if (!visible) return null;
  const binding = status?.binding;
  const source = status?.source;
  const state = status?.importState;
  const copy = localImportStatusCopyForAgent(props.agentId);
  return (
    <div className={styles.agentDefaultsPanelV5} data-testid="agent-local-source-status">
      <header className={styles.agentSectionHeaderV5}>
        <div>
          <span className={styles.agentSectionEyebrowV5}>OFFICIAL CLIENT OBSERVATION</span>
          <h4>官方直连观测（自动导入）</h4>
        </div>
        <span className={styles.agentSectionStateV5}>
          {failed ? "状态读取失败" : !status ? "读取中…" : binding?.state === "bound" ? "已启用" : "未启用"}
        </span>
      </header>
      {/* 说明文案按 Agent 分化（2026-10-09 用户确认）：zcode=官方积分折扣、
          codex=OpenAI 登录协议限制、dsh=仅身份标注，禁止共用单一 ZCode 口径。 */}
      <p className={styles.muted}>
        {status?.directImportEnabled === false
          ? copy.identityOnly
          : copy.direct}
      </p>
      {binding?.state === "bound" && binding.targetId ? (
        <p className={styles.muted}>
          归因目标：{binding.targetId}
          {binding.viaDefaultTarget === false ? "（非默认目标，按创建时间选中的官方预设目标）" : ""}
        </p>
      ) : null}
      {binding?.state === "disabled" ? <p className={styles.muted}>未启用原因：{binding.reason}</p> : null}
      {source && source.state !== "available" ? <p className={styles.muted}>本地数据源：{source.state === "missing" ? "未找到" : "不可读"}（{source.reason}）</p> : null}
      {state ? (
        <p className={styles.muted}>
          {status?.directImportEnabled === false ? "本模式不入账" : `已导入 ${state.importedCount} 条请求`}
          {state.lastSuccessAt ? `，最近成功 ${formatTime(state.lastSuccessAt)}` : ""}
          {state.lastRunCount !== undefined ? `，最近一轮 ${state.lastRunCount} 条` : ""}
          {/* 扫描耗时必须可见：本地扫描是同步阻塞（2026-09-18 曾因每轮全量解压把主线程占满 20 s+）。 */}
          {state.lastRunDurationMs !== undefined ? `（扫描耗时 ${formatDuration(state.lastRunDurationMs)}）` : ""}
          {state.consecutiveFailures > 0 ? `；连续失败 ${state.consecutiveFailures} 次${state.lastError ? `：${state.lastError}` : ""}` : ""}
          {state.skippedModelNotProvisioned > 0 ? `；未入账本 ${state.skippedModelNotProvisioned} 条（模型未在供应商配置）` : ""}
          {state.cursorResetCount > 0 ? `；游标重置 ${state.cursorResetCount} 次` : ""}。
        </p>
      ) : null}
    </div>
  );
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

/** 扫描耗时展示：1 s 以上显示秒（本地扫描是全同步阻塞，秒级就要显眼）。 */
function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  return ms >= 1_000 ? `${(ms / 1_000).toFixed(1)} s` : `${Math.round(ms)} ms`;
}
