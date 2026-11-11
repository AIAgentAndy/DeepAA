"use client";

/**
 * UI 重构（2026-11-10）：「Agent 能力」页参照 Codex 桌面端三区布局。
 * 顶部 = Agent 列表(横向 tab); 左侧 = 分类导航(Skills/MCP/工具/插件/规则/系统提示词);
 * 右侧 = 选中分类的条目网格(按来源分组)。保留机制剖析与使用分析。
 */

import Image from "next/image";
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

const AGENT_ORDER = ["codex", "claude", "zcode", "dsh", "opencode"] as const;
const AGENT_LOGO: Record<string, string> = {
  codex: "/agent-logos/codex.png",
  claude: "/agent-logos/claude.ico",
  zcode: "/agent-logos/zcode.png",
  dsh: "/agent-logos/dsh.ico",
  opencode: "/agent-logos/opencode.svg",
};

type CategoryKey = "skills" | "mcp" | "tools" | "plugins" | "rules" | "prompts" | "mechanisms" | "usage";

const CATEGORIES: Array<{key: CategoryKey; label: string; icon: string}> = [
  {key: "skills", label: "Skills", icon: "◆"},
  {key: "mcp", label: "MCP 服务", icon: "⬡"},
  {key: "tools", label: "工具", icon: "⚙"},
  {key: "plugins", label: "插件", icon: "▣"},
  {key: "rules", label: "内置规则", icon: "☰"},
  {key: "prompts", label: "系统提示词", icon: "✎"},
  {key: "mechanisms", label: "机制剖析", icon: "🔬"},
  {key: "usage", label: "使用分析", icon: "📊"},
];

export function AgentCapabilitiesPage({mechanismProfiles}: {
  mechanismProfiles?: MechanismProfiles;
}) {
  const [data, setData] = useState<LedgerResponse>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [agentId, setAgentId] = useState<string>("codex");
  const [category, setCategory] = useState<CategoryKey>("skills");
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

  const agent = data?.agents.find(a => a.agentId === agentId);

  return (
    <div className="agent-caps-page-v2">
      {/* 顶部 Agent 列表 */}
      <nav className="acaps-agent-bar" role="tablist" aria-label="Agent 选择">
        <span className="acaps-agent-bar-fill" />
        {AGENT_ORDER.map(id => {
          const ledger = data?.agents.find(a => a.agentId === id);
          const count = ledger
            ? ledger.skills.length + ledger.tools.length + ledger.mcpServers.length + ledger.plugins.length
            : 0;
          return (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={agentId === id}
              className={`acaps-agent-chip${agentId === id ? " on" : ""}`}
              data-agent={id}
              onClick={() => setAgentId(id)}
            >
              <Image
                src={AGENT_LOGO[id] ?? "/agent-logos/codex.png"}
                alt=""
                width={24}
                height={24}
                className="acaps-agent-logo"
              />
              <span className="acaps-agent-name">{agentLabel(id)}</span>
              {count > 0 ? <span className="acaps-agent-count">{count}</span> : null}
            </button>
          );
        })}
        <span className="acaps-agent-bar-fill" />
        <button type="button" className="acaps-refresh" onClick={() => void load()} disabled={loading} title="刷新本机能力扫描">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/>
          </svg>
          {loading ? "扫描中" : "扫描"}
        </button>
      </nav>

      {error ? <p className="agent-caps-note">读取失败（{error}）· <button type="button" className="comp-link" onClick={() => void load()}>重试</button></p> : null}
      {data?.limited ? <p className="agent-caps-note">部分 Agent 目录项达扫描上限（500），清单可能不完整。</p> : null}

      {/* 主体三区 */}
      <div className="acaps-body">
        {/* 左侧分类导航 */}
        <aside className="acaps-sidebar">
          <p className="acaps-sidebar-label">能力分类</p>
          {CATEGORIES.map(cat => {
            const count = getCategoryCount(agent, cat.key);
            return (
              <button
                key={cat.key}
                type="button"
                className={`acaps-sidebar-item${category === cat.key ? " on" : ""}`}
                onClick={() => setCategory(cat.key)}
              >
                <span className="acaps-sidebar-icon" aria-hidden="true">{cat.icon}</span>
                {cat.label}
                {count > 0 ? <span className="acaps-sidebar-count">{count}</span> : null}
              </button>
            );
          })}
          {agent?.availability.state === "available" ? (
            <div className="acaps-sidebar-meta">
              <p className="mono">{agent.availability.dataDir}</p>
              <p>目录项 {agent.scan.candidateCount} · 读取 {(agent.scan.bytesRead / 1024).toFixed(1)} KiB</p>
            </div>
          ) : null}
        </aside>

        {/* 右侧内容 */}
        <main className="acaps-main">
          {loading && !data ? <p className="agent-caps-note">正在读取本机台账…</p> : null}
          {category === "mechanisms" ? <MechanismPanel profiles={mechanismProfiles} agentId={agentId} /> : null}
          {category === "usage" ? <UsagePanel agentId={agentId} /> : null}
          {category === "skills" ? <CategoryPanel title="Skills" groups={groupSkills(agent)} emptyText="无 Skills 目录" /> : null}
          {category === "mcp" ? <CategoryPanel title="MCP 服务" groups={groupMcp(agent)} emptyText="未配置 MCP 服务" /> : null}
          {category === "tools" ? <CategoryPanel title="工具（wire 观测）" groups={groupTools(agent)} emptyText="暂无已捕获的工具清单" /> : null}
          {category === "plugins" ? <CategoryPanel title={agent?.pluginsLabel ?? "插件"} groups={groupPlugins(agent)} emptyText="无" /> : null}
          {category === "rules" ? <CategoryPanel title="内置规则" groups={groupRules(agent)} emptyText="未发现规则文件" /> : null}
          {category === "prompts" ? <CategoryPanel title="系统提示词" groups={groupPrompts(agent)} emptyText="未发现系统提示词文件" /> : null}
        </main>
      </div>
    </div>
  );
}

function getCategoryCount(agent: AgentCapabilityLedger | undefined, key: CategoryKey): number {
  if (!agent) return 0;
  switch (key) {
    case "skills": return agent.skills.length;
    case "mcp": return agent.mcpServers.length;
    case "tools": return agent.tools.length;
    case "plugins": return agent.plugins.length;
    case "rules": return agent.rules.length;
    case "prompts": return agent.systemPrompts.length;
    default: return 0;
  }
}

interface ItemGroup { label: string; items: CapabilityLedgerItem[] }

function groupSkills(agent?: AgentCapabilityLedger): ItemGroup[] {
  if (!agent) return [];
  const system = agent.skills.filter(s => !s.name.includes(":"));
  const byPlugin = new Map<string, CapabilityLedgerItem[]>();
  for (const s of agent.skills) {
    const idx = s.name.indexOf(":");
    if (idx > 0) {
      const plugin = s.name.slice(0, idx);
      const bucket = byPlugin.get(plugin) ?? [];
      bucket.push(s);
      byPlugin.set(plugin, bucket);
    }
  }
  const groups: ItemGroup[] = [];
  if (system.length > 0) groups.push({label: "系统 / 个人", items: system});
  for (const [plugin, items] of byPlugin) {
    groups.push({label: `插件 · ${plugin}`, items});
  }
  return groups;
}

function groupMcp(agent?: AgentCapabilityLedger): ItemGroup[] {
  if (!agent?.mcpServers.length) return [];
  const user = agent.mcpServers.filter(m => !m.detail?.startsWith("项目级"));
  const project = agent.mcpServers.filter(m => m.detail?.startsWith("项目级"));
  const groups: ItemGroup[] = [];
  if (user.length) groups.push({label: "用户级", items: user});
  if (project.length) groups.push({label: "项目级", items: project});
  return groups;
}

function groupTools(agent?: AgentCapabilityLedger): ItemGroup[] {
  if (!agent?.tools.length) return [];
  const builtin = agent.tools.filter(t => t.detail === "内置/普通");
  const mcp = agent.tools.filter(t => t.detail?.startsWith("MCP"));
  const groups: ItemGroup[] = [];
  if (builtin.length) groups.push({label: "内置 / 普通", items: builtin});
  if (mcp.length) groups.push({label: "MCP 工具", items: mcp});
  return groups;
}

function groupPlugins(agent?: AgentCapabilityLedger): ItemGroup[] {
  if (!agent?.plugins.length) return [];
  const groups = new Map<string, CapabilityLedgerItem[]>();
  for (const p of agent.plugins) {
    const market = p.name.includes("/") ? p.name.split("/")[0] : "其它";
    const bucket = groups.get(market) ?? [];
    bucket.push(p);
    groups.set(market, bucket);
  }
  return [...groups.entries()].map(([market, items]) => ({label: `市场 · ${market}`, items}));
}

function groupRules(agent?: AgentCapabilityLedger): ItemGroup[] {
  return agent?.rules.length ? [{label: "规则文件", items: agent.rules}] : [];
}

function groupPrompts(agent?: AgentCapabilityLedger): ItemGroup[] {
  return agent?.systemPrompts.length ? [{label: "系统提示词", items: agent.systemPrompts}] : [];
}

/** 右侧通用分类面板:按来源分组,两列卡片网格。 */
function CategoryPanel({title, groups, emptyText}: {
  title: string;
  groups: ItemGroup[];
  emptyText: string;
}) {
  return (
    <div className="acaps-category">
      <h3 className="acaps-category-title">{title} <span>{groups.reduce((sum, g) => sum + g.items.length, 0)} 项</span></h3>
      {groups.length === 0 ? (
        <p className="agent-caps-note">{emptyText}</p>
      ) : groups.map(group => (
        <section key={group.label} className="acaps-group-section">
          <h4 className="acaps-group-label">{group.label} <small>{group.items.length}</small></h4>
          <div className="acaps-card-grid">
            {group.items.map(item => (
              <div key={`${item.kind}:${item.name}`} className="acaps-card" title={item.sourcePath}>
                <div className="acaps-card-icon" data-kind={item.kind}>
                  {item.kind === "skill" ? "◆" : item.kind === "mcp_server" ? "⬡" : item.kind === "plugin" ? "▣" : item.kind === "rule" ? "☰" : item.kind === "system_prompt" ? "✎" : "⚙"}
                </div>
                <div className="acaps-card-body">
                  <b className="acaps-card-name">{item.name}</b>
                  {item.description ? <p className="acaps-card-desc">{item.description.slice(0, 100)}</p> : null}
                  {item.detail && !item.description ? <p className="acaps-card-desc">{item.detail}</p> : null}
                </div>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

/** 机制剖析面板(嵌入左侧选中时)。 */
function MechanismPanel({profiles, agentId}: {profiles?: MechanismProfiles; agentId: string}) {
  if (!profiles) {
    return <p className="agent-caps-note">机制剖面暂不可用（config/agents/harness/mechanism-profiles.json 缺失或损坏）。</p>;
  }
  const activeId = profiles.agents[agentId] ? agentId : Object.keys(profiles.agents)[0] ?? "codex";
  const profile = profiles.agents[activeId];
  const byTopic = new Map<string, typeof profile.mechanisms>();
  for (const entry of profile?.mechanisms ?? []) {
    const bucket = byTopic.get(entry.topic);
    if (bucket) bucket.push(entry);
    else byTopic.set(entry.topic, [entry]);
  }
  return (
    <div className="acaps-category">
      <h3 className="acaps-category-title">机制剖析 <span>{profile?.mechanisms.length ?? 0} 条 · 基线 {profiles.updatedAt}</span></h3>
      {profile ? (
        <>
          <p className="acaps-summary">{profile.summary}</p>
          <div className="acaps-topics">
            {profiles.topics.map(topic => {
              const entries = byTopic.get(topic.key) ?? [];
              if (entries.length === 0) return null;
              return (
                <section key={topic.key} className="acaps-topic-card">
                  <h4>{topic.label}</h4>
                  {entries.map(entry => (
                    <div key={entry.title} className="acaps-entry">
                      <b>{entry.title}</b>
                      <p>{entry.detail}</p>
                      <span className="acaps-source">来源：{entry.source}</span>
                    </div>
                  ))}
                </section>
              );
            })}
          </div>
        </>
      ) : <p className="agent-caps-note">该 Agent 暂无剖面。</p>}
    </div>
  );
}

/** 使用分析面板。 */
function UsagePanel({agentId}: {agentId: string}) {
  const [lookupTarget, setLookupTarget] = useState<{agentName: string; kind: "tool" | "skill"; name: string}>();
  const [days, setDays] = useState<7 | 30>(7);
  const [dimension, setDimension] = useState<"tools" | "skills">("tools");
  const [data, setData] = useState<UsageData>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const seqRef = useRef(0);

  const load = useCallback(async () => {
    const seq = ++seqRef.current;
    setLoading(true);
    setError("");
    try {
      const response = await fetch(`/api/capabilities/usage?agent=${encodeURIComponent(agentId)}&days=${days}&dimension=${dimension}`, {cache: "no-store"});
      if (seq !== seqRef.current) return;
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json() as UsageData;
      if (seq !== seqRef.current) return;
      setData(payload);
    } catch (err) {
      if (seq !== seqRef.current) return;
      setError((err as Error).message || "读取失败");
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  }, [agentId, days, dimension]);

  useEffect(() => { void load(); }, [load]);

  return (
    <div className="acaps-category">
      <h3 className="acaps-category-title">
        使用分析
        <span className="acaps-usage-filters">
          <button type="button" className={dimension === "tools" ? "on" : ""} onClick={() => setDimension("tools")}>工具</button>
          <button type="button" className={dimension === "skills" ? "on" : ""} onClick={() => setDimension("skills")}>Skills</button>
          <button type="button" className={days === 7 ? "on" : ""} onClick={() => setDays(7)}>近 7 天</button>
          <button type="button" className={days === 30 ? "on" : ""} onClick={() => setDays(30)}>近 30 天</button>
        </span>
      </h3>
      {error ? <p className="agent-caps-note">读取失败（{error}）</p> : null}
      {loading && !data ? <p className="agent-caps-note">聚合中…</p> : null}
      {data ? (
        data.items.length > 0 ? (
          <div className="acaps-usage-table">
            <div className="acaps-usage-row head">
              <span>{dimension === "skills" ? "Skill" : "工具"}</span>
              <span className="num">声明步</span>
              <span className="num">{dimension === "skills" ? "激活步/次" : "调用步/次"}</span>
              <span className="num">覆盖率</span>
              <span className="num">执行侧</span>
              <span>候选</span>
            </div>
            {data.items.map(item => (
              <button type="button" key={item.name}
                className={`acaps-usage-row${item.lowUseCandidate ? " cand" : ""}`}
                onClick={() => setLookupTarget({agentName: agentId, kind: dimension === "skills" ? "skill" : "tool", name: item.name})}>
                <span className="mono">{item.name}</span>
                <span className="num">{item.declaredSteps}</span>
                <span className="num">{dimension === "skills" ? `${item.activatedSteps ?? 0} / ${item.invokedCalls}` : `${item.invokedSteps} / ${item.invokedCalls}`}</span>
                <span className="num">{item.coverage !== undefined ? `${Math.round(item.coverage * 100)}%` : "—"}</span>
                <span className="num">
                  {item.executedCount !== undefined
                    ? `${item.executedCount} 次${item.avgDurationMs !== undefined ? ` · 均 ${(item.avgDurationMs / 1000).toFixed(1)}s` : ""}`
                    : "—"}
                </span>
                <span>{item.lowUseCandidate ? (dimension === "skills" ? "未激活" : "低调用") : ""}</span>
              </button>
            ))}
          </div>
        ) : <p className="agent-caps-note">窗口内无记录。</p>
      ) : null}
      <CapabilityLookupDialog target={lookupTarget} onClose={() => setLookupTarget(undefined)} onNavigate={() => {}} />
    </div>
  );
}

interface UsageData {
  items: Array<{
    name: string; declaredSteps: number; invokedSteps: number; invokedCalls: number;
    coverage?: number; avgDurationMs?: number; executedCount?: number;
    lowUseCandidate: boolean; kind?: string; activatedSteps?: number;
  }>;
  borrowedStepCount: number; candidateCount: number; processedCount: number; limited: boolean;
  thresholds: {minDeclaredSteps: number; maxCoverage: number};
  windowDays: number;
}
