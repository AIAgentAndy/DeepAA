"use client";

/**
 * P1-6（2026-11-03）：「Agent 能力」页面（最小版）。
 * 总览：五 Agent 台账卡（skills / MCP / 插件 / profiles 计数 + 扫描可观测字段）；
 * 台账：按 Agent 展开分组清单。读取失败显式重试；missing 诚实呈现（未安装 ≠ 0 条）。
 */

import {useCallback, useEffect, useRef, useState} from "react";
import {agentLabel} from "@/lib/agent-registry";
import {CapabilityLookupDialog} from "@/components/workbench/capability-lookup-dialog";
import type {AgentCapabilityLedger, CapabilityLedgerItem} from "@/lib/agent-capabilities/scanner";
import type {MechanismProfiles} from "@/lib/agent-capabilities/mechanism-profiles";

interface LedgerResponse {
  agents: AgentCapabilityLedger[];
  candidateCount: number;
  processedCount: number;
  limited: boolean;
}

export function AgentCapabilitiesPage({mechanismProfiles}: {
  mechanismProfiles?: MechanismProfiles;
}) {
  const [data, setData] = useState<LedgerResponse>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string>();
  const [view, setView] = useState<"ledger" | "mechanisms" | "usage">("ledger");
  const seqRef = useRef(0);

  const load = useCallback(async () => {
    const seq = ++seqRef.current;
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/agent-capabilities", {cache: "no-store"});
      if (seq !== seqRef.current) return;
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json() as LedgerResponse;
      if (seq !== seqRef.current) return;
      setData(payload);
    } catch (err) {
      if (seq !== seqRef.current) return;
      setError((err as Error).message || "读取失败");
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  return (
    <div className="agent-caps-page">
      <header className="agent-caps-header">
        <div>
          <h2>Agent 能力</h2>
          <p className="muted">本机五个 Agent 实例的能力台账（只读扫描 · 60s 缓存）。会话运行证据见会话追踪「响应 / 能力清单」页签；工具名可反查调用与传递记录。</p>
        </div>
        <div className="agent-caps-header-actions">
          <div className="agent-caps-viewtoggle" role="tablist">
            <button type="button" role="tab" aria-selected={view === "ledger"} className={view === "ledger" ? "on" : ""} onClick={() => setView("ledger")}>台账</button>
            <button type="button" role="tab" aria-selected={view === "mechanisms"} className={view === "mechanisms" ? "on" : ""} onClick={() => setView("mechanisms")}>机制剖析</button>
            <button type="button" role="tab" aria-selected={view === "usage"} className={view === "usage" ? "on" : ""} onClick={() => setView("usage")}>使用分析</button>
          </div>
          {view === "ledger" ? (
            <button type="button" className="ghost-btn" onClick={() => void load()} disabled={loading}>
              {loading ? "扫描中…" : "重新扫描"}
            </button>
          ) : null}
        </div>
      </header>

      {error ? <p className="agent-caps-note">台账读取失败（{error}）· <button type="button" className="comp-link" onClick={() => void load()}>重试</button></p> : null}
      {data?.limited ? <p className="agent-caps-note">部分 Agent 目录项达扫描上限（500），清单可能不完整。</p> : null}

      {view === "mechanisms" ? <MechanismView profiles={mechanismProfiles} /> : null}
      {view === "usage" ? <UsageView /> : null}

      <div className={`agent-caps-grid${view === "mechanisms" ? " hidden" : ""}`}>
        {(data?.agents ?? []).map(agent => (
          <AgentCapabilityCard
            key={agent.agentId}
            ledger={agent}
            expanded={expanded === agent.agentId}
            onToggle={() => setExpanded(current => current === agent.agentId ? undefined : agent.agentId)}
          />
        ))}
        {loading && !data ? <p className="agent-caps-note">正在读取本机台账…</p> : null}
      </div>
    </div>
  );
}

function AgentCapabilityCard({ledger, expanded, onToggle}: {
  ledger: AgentCapabilityLedger;
  expanded: boolean;
  onToggle: () => void;
}) {
  const missing = ledger.availability.state === "missing";
  return (
    <section className={`agent-caps-card${missing ? " missing" : ""}`}>
      <header>
        <b>{ledger.label}</b>
        <span className="agent-caps-state">
          {missing ? "未安装/未找到" : `${ledger.tools.length} 工具 · ${ledger.skills.length} skills · ${ledger.mcpServers.length} MCP · ${ledger.plugins.length} ${ledger.pluginsLabel ?? "插件"}`}
        </span>
      </header>
      <p className="agent-caps-dir mono">{ledger.availability.dataDir}</p>
      <div className="agent-caps-scan">
        <span>目录项 {ledger.scan.candidateCount} · 处理 {ledger.scan.processedCount} · 读取 {(ledger.scan.bytesRead / 1024).toFixed(1)} KiB</span>
        {ledger.scan.limited ? <span className="warn">达上限·受限</span> : <span>完整</span>}
      </div>
      {!missing ? (
        expanded ? (
          <div className="agent-caps-groups">
            <LedgerGroup title="Skills" items={ledger.skills} emptyText={ledger.skillsEmptyNote ?? "无 Skills 目录"} />
            <LedgerGroup title="MCP Servers" items={ledger.mcpServers} emptyText="未配置 MCP 服务" />
            <LedgerGroup title="工具（wire 观测）" items={ledger.tools} emptyText="暂无已捕获的工具清单（经网关/导入的会话将自动出现）" />
            <LedgerGroup title={ledger.pluginsLabel ?? "插件"} items={ledger.plugins} emptyText="无" />
            <button type="button" className="comp-link" onClick={onToggle}>收起</button>
          </div>
        ) : (
          <button type="button" className="comp-link" onClick={onToggle}>展开台账（{ledger.skills.length + ledger.mcpServers.length + ledger.plugins.length} 项）</button>
        )
      ) : (
        <p className="agent-caps-note">本地目录未找到，0 条不代表该 Agent 没有能力配置。</p>
      )}
    </section>
  );
}

function LedgerGroup({title, items, emptyText}: {
  title: string;
  items: CapabilityLedgerItem[];
  emptyText: string;
}) {
  return (
    <div className="agent-caps-group">
      <h4>{title} <small className="cnt">{items.length}</small></h4>
      {items.length > 0 ? (
        <ul>
          {items.map(item => (
            <li key={`${item.kind}:${item.name}`} title={item.sourcePath}>
              <span className="mono">{item.name}</span>
            </li>
          ))}
        </ul>
      ) : <p className="agent-caps-note">{emptyText}</p>}
    </div>
  );
}

/**
 * P1-7 机制剖析视图：八主题 × Agent 的版本化剖面（config/agents/harness 冻结基线，
 * 人工修订；每条带来源标注）。剖面缺失时诚实降级。
 */
function MechanismView({profiles}: {profiles?: MechanismProfiles}) {
  const [agentId, setAgentId] = useState<string>("codex");
  if (!profiles) {
    return <p className="agent-caps-note">机制剖面暂不可用（config/agents/harness/mechanism-profiles.json 缺失或损坏）。</p>;
  }
  const agentIds = Object.keys(profiles.agents);
  const activeId = profiles.agents[agentId] ? agentId : agentIds[0] ?? "codex";
  const profile = profiles.agents[activeId];
  const byTopic = new Map<string, typeof profile.mechanisms>();
  for (const entry of profile?.mechanisms ?? []) {
    const bucket = byTopic.get(entry.topic);
    if (bucket) bucket.push(entry);
    else byTopic.set(entry.topic, [entry]);
  }
  return (
    <div className="agent-caps-mech">
      <div className="agent-caps-viewtoggle" role="tablist">
        {agentIds.map(id => (
          <button type="button" key={id} role="tab" aria-selected={activeId === id}
            className={activeId === id ? "on" : ""} onClick={() => setAgentId(id)}>
            {agentLabel(id)}
          </button>
        ))}
      </div>
      {profile ? (
        <>
          <p className="agent-caps-summary">{profile.summary}</p>
          <div className="agent-caps-topics">
            {profiles.topics.map(topic => {
              const entries = byTopic.get(topic.key) ?? [];
              if (entries.length === 0) return null;
              return (
                <section key={topic.key} className="agent-caps-topic">
                  <h4>{topic.label}</h4>
                  {entries.map(entry => (
                    <div key={entry.title} className="agent-caps-entry">
                      <b>{entry.title}</b>
                      <p>{entry.detail}</p>
                      <span className="agent-caps-source">来源：{entry.source}</span>
                    </div>
                  ))}
                </section>
              );
            })}
          </div>
          <p className="agent-caps-note">剖面基线 {profiles.updatedAt} · schemaVersion {profiles.schemaVersion} · 人工修订，非运行时源码分析。</p>
        </>
      ) : <p className="agent-caps-note">该 Agent 暂无剖面。</p>}
    </div>
  );
}

/**
 * P2-b 使用分析视图：利用率首版（§11 最小版）——声明/调用覆盖率、执行侧聚合、
 * 低调用候选（观察结论，绝不说「从未使用/没价值」）；借补参考清单计入声明分母
 * 时注明。数据来自 /api/capabilities/usage（只读 SQLite 聚合）。
 */
function UsageView() {
  const [agentId, setAgentId] = useState("zcode");
  const [lookupTarget, setLookupTarget] = useState<{agentName: string; kind: "tool" | "skill"; name: string}>();
  const [days, setDays] = useState<7 | 30>(7);
  const [data, setData] = useState<CapabilityUsageResponse>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const seqRef = useRef(0);

  const load = useCallback(async () => {
    const seq = ++seqRef.current;
    setLoading(true);
    setError("");
    try {
      const response = await fetch(`/api/capabilities/usage?agent=${encodeURIComponent(agentId)}&days=${days}`, {cache: "no-store"});
      if (seq !== seqRef.current) return;
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json() as CapabilityUsageResponse;
      if (seq !== seqRef.current) return;
      setData(payload);
    } catch (err) {
      if (seq !== seqRef.current) return;
      setError((err as Error).message || "读取失败");
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  }, [agentId, days]);

  useEffect(() => { void load(); }, [load]);

  const candidates = (data?.items ?? []).filter(item => item.lowUseCandidate);
  return (
    <div className="agent-caps-usage">
      <div className="agent-caps-viewtoggle" role="tablist">
        {[["codex", "codex"], ["claude-code", "Claude Code"], ["zcode", "ZCode"], ["dsh", "dsh"], ["opencode", "opencode"]].map(([id, label]) => (
          <button type="button" key={id} role="tab" aria-selected={agentId === id}
            className={agentId === id ? "on" : ""} onClick={() => setAgentId(id)}>
            {agentLabel(id)}
          </button>
        ))}
        <button type="button" role="tab" aria-selected={days === 7} className={days === 7 ? "on" : ""} onClick={() => setDays(7)}>近 7 天</button>
        <button type="button" role="tab" aria-selected={days === 30} className={days === 30 ? "on" : ""} onClick={() => setDays(30)}>近 30 天</button>
      </div>

      {error ? <p className="agent-caps-note">使用数据读取失败（{error}）· <button type="button" className="comp-link" onClick={() => void load()}>重试</button></p> : null}
      {loading && !data ? <p className="agent-caps-note">正在聚合使用数据…</p> : null}
      {data ? (
        <>
          <p className="agent-caps-summary">
            窗口近 {data.windowDays} 天 · 工具 {data.items.length} 种 · 低调用候选 {candidates.length} 个
            （标准：声明 ≥{data.thresholds.minDeclaredSteps} 步且步级调用覆盖率 {'<'}{Math.round(data.thresholds.maxCoverage * 100)}%）
            {data.borrowedStepCount > 0 ? ` · ${data.borrowedStepCount} 步清单为借补参考（计入声明分母，覆盖率仅供参考）` : ""}
            {data.limited ? ` · 达 ${data.processedCount} 行上限（共 ${data.candidateCount}）` : ""}。
            覆盖率是观察结论，不构成「没价值」判断；无声明分母的工具（仅调用）覆盖率不适用。
          </p>
          {data.items.length > 0 ? (
            <div className="agent-caps-usage-table">
              <div className="agent-caps-usage-row head">
                <span>工具</span><span className="num">声明步</span><span className="num">调用步/次</span>
                <span className="num">步级覆盖率</span><span className="num">执行侧</span><span>候选</span>
              </div>
              {data.items.map(item => (
                <button type="button" key={item.name} className={`agent-caps-usage-row agent-caps-usage-clickable${item.lowUseCandidate ? " cand" : ""}`}
                  onClick={() => setLookupTarget({agentName: agentId, kind: "tool", name: item.name})}>
                  <span className="mono">{item.name}</span>
                  <span className="num">{item.declaredSteps}</span>
                  <span className="num">{item.invokedSteps} / {item.invokedCalls}</span>
                  <span className="num">{item.coverage !== undefined ? `${Math.round(item.coverage * 100)}%` : "—"}</span>
                  <span className="num">
                    {item.executedCount !== undefined
                      ? `${item.executedCount} 次${item.avgDurationMs !== undefined ? ` · 均 ${(item.avgDurationMs / 1000).toFixed(1)}s` : ""}${item.errorCount ? ` · 错 ${item.errorCount}` : ""}${item.cancelledCount ? ` · 取消 ${item.cancelledCount}` : ""}`
                      : "—"}
                  </span>
                  <span>{item.lowUseCandidate ? "低调用（观察）" : ""}</span>
                </button>
              ))}
            </div>
          ) : <p className="agent-caps-note">窗口内无该 Agent 的声明/调用记录（0 条不代表该工具没价值）。</p>}
        </>
      ) : null}
      <CapabilityLookupDialog
        target={lookupTarget}
        onClose={() => setLookupTarget(undefined)}
        onNavigate={() => {/* 使用分析无 Step 深链场景,占位 */}}
      />
    </div>
  );
}

interface CapabilityUsageResponse {
  agentName: string;
  windowDays: number;
  windowStart: string;
  items: Array<{
    name: string;
    declaredSteps: number;
    invokedSteps: number;
    invokedCalls: number;
    coverage?: number;
    avgDurationMs?: number;
    executedCount?: number;
    errorCount?: number;
    cancelledCount?: number;
    lowUseCandidate: boolean;
  }>;
  borrowedStepCount: number;
  candidateCount: number;
  processedCount: number;
  limited: boolean;
  thresholds: {minDeclaredSteps: number; maxCoverage: number};
}
