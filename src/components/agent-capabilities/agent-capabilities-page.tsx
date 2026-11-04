"use client";

/**
 * P1-6（2026-11-03）：「Agent 能力」页面（最小版）。
 * 总览：五 Agent 台账卡（skills / MCP / 插件 / profiles 计数 + 扫描可观测字段）；
 * 台账：按 Agent 展开分组清单。读取失败显式重试；missing 诚实呈现（未安装 ≠ 0 条）。
 */

import {useCallback, useEffect, useRef, useState} from "react";
import {agentLabel} from "@/lib/agent-registry";
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
  const [view, setView] = useState<"ledger" | "mechanisms">("ledger");
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
          {missing ? "未安装/未找到" : `${ledger.skills.length} skills · ${ledger.mcpServers.length} MCP · ${ledger.plugins.length} ${ledger.pluginsLabel ?? "插件"}`}
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
