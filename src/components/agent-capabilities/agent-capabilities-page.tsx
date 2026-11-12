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

type DetailItem = CapabilityLedgerItem & {paramNames?: string};

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
  /** URL tool 参数:选中 Agent 后自动打开该工具的详情。 */
  const [detailTarget, setDetailTarget] = useState<DetailItem | undefined>();
  const seqRef = useRef(0);
  const urlConsumedRef = useRef(false);

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

  // URL 参数消费(一次性):/agent-capabilities?agent=zcode&view=usage&tool=Bash
  useEffect(() => {
    if (urlConsumedRef.current) return;
    urlConsumedRef.current = true;
    try {
      const params = new URLSearchParams(window.location.search);
      const agentParam = params.get("agent");
      if (agentParam && (AGENT_ORDER as readonly string[]).includes(agentParam)) {
        setAgentId(agentParam);
      }
      const viewParam = params.get("view");
      if (viewParam === "usage") setCategory("usage");
      else if (viewParam === "mechanisms") setCategory("mechanisms");
      const toolParam = params.get("tool");
      if (toolParam) setDetailTarget({kind: "tool", name: toolParam});
    } catch { /* SSR / 静默 */ }
  }, []);

  const agent = data?.agents.find(a => a.agentId === agentId);

  // URL ?tool=Bash → 数据加载后从 agent 数据找到完整条目(带 description)。
  useEffect(() => {
    if (!detailTarget || !agent || detailTarget.description) return;
    const found =
      agent.tools.find(t => t.name === detailTarget.name)
      ?? agent.skills.find(s => s.name === detailTarget.name)
      ?? agent.mcpServers.find(m => m.name === detailTarget.name);
    if (found) setDetailTarget(found);
  }, [agent, detailTarget]);

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
          {category === "skills" ? <CategoryPanel title="Skills" groups={groupSkills(agent)} emptyText="无 Skills 目录" onSelectItem={setDetailTarget} /> : null}
          {category === "mcp" ? <CategoryPanel title="MCP 服务" groups={groupMcp(agent)} emptyText="未配置 MCP 服务" onSelectItem={setDetailTarget} /> : null}
          {category === "tools" ? <CategoryPanel title="工具（wire 观测）" groups={groupTools(agent)} emptyText="暂无已捕获的工具清单" onSelectItem={setDetailTarget} /> : null}
          {category === "plugins" ? <CategoryPanel title={agent?.pluginsLabel ?? "插件"} groups={groupPlugins(agent)} emptyText="无" onSelectItem={setDetailTarget} /> : null}
          {category === "rules" ? <CategoryPanel title="内置规则" groups={groupRules(agent)} emptyText="未发现规则文件" onSelectItem={setDetailTarget} /> : null}
          {category === "prompts" ? <CategoryPanel title="系统提示词" groups={groupPrompts(agent)} emptyText="未发现系统提示词文件" onSelectItem={setDetailTarget} /> : null}
        </main>
      </div>

      {/* 工具/Skill 详情抽屉(点击卡片或 URL ?tool= 触发) */}
      <DetailDrawer
        item={detailTarget}
        agentId={agentId}
        onClose={() => setDetailTarget(undefined)}
      />
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
  // 修复(2026-11-11 双路审核):按 detail 来源字段分组(用户全局/项目/插件/系统)。
  const user = agent.skills.filter(s => s.detail === "用户全局");
  const project = agent.skills.filter(s => (s.detail ?? "").startsWith("项目 · "));
  const rest = agent.skills.filter(s => s.detail !== "用户全局" && !(s.detail ?? "").startsWith("项目 · "));
  const system = rest.filter(s => !s.name.includes(":"));
  const byPlugin = new Map<string, CapabilityLedgerItem[]>();
  for (const s of rest) {
    const idx = s.name.indexOf(":");
    if (idx > 0) {
      const plugin = s.name.slice(0, idx);
      const bucket = byPlugin.get(plugin) ?? [];
      bucket.push(s);
      byPlugin.set(plugin, bucket);
    }
  }
  const groups: ItemGroup[] = [];
  if (user.length > 0) groups.push({label: "用户全局", items: user});
  if (system.length > 0) groups.push({label: "系统 / 个人", items: system});
  for (const [plugin, items] of byPlugin) {
    groups.push({label: `插件 · ${plugin}`, items});
  }
  if (project.length > 0) groups.push({label: "项目", items: project});
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
function CategoryPanel({title, groups, emptyText, onSelectItem}: {
  title: string;
  groups: ItemGroup[];
  emptyText: string;
  onSelectItem: (item: CapabilityLedgerItem) => void;
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
              <button type="button" key={`${item.kind}:${item.name}:${item.sourcePath ?? ""}`} className="acaps-card acaps-card-clickable" title={item.sourcePath} onClick={() => onSelectItem(item)}>
                <div className="acaps-card-icon" data-kind={item.kind}>
                  {item.kind === "skill" ? "◆" : item.kind === "mcp_server" ? "⬡" : item.kind === "plugin" ? "▣" : item.kind === "rule" ? "☰" : item.kind === "system_prompt" ? "✎" : "⚙"}
                </div>
                <div className="acaps-card-body">
                  <b className="acaps-card-name">
                    {item.name}
                    {skillVersionBadge(item.sourcePath) ? <span className="acaps-ver-badge">{skillVersionBadge(item.sourcePath)}</span> : null}
                  </b>
                  {item.description ? <p className="acaps-card-desc">{item.description.slice(0, 80)}</p> : null}
                  {item.detail && !item.description ? <p className="acaps-card-desc">{item.detail}</p> : null}
                </div>
              </button>
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


/**
 * 详情抽屉(2026-11-11 重构):点击工具/Skill 卡片展开——
 * Skill 显示 SKILL.md 全文 + 跨 Agent 状态 + 一键同步;
 * 工具显示描述 + 参数 + 调用链接。
 */
/** 插件缓存多版本 skill 的版本徽标(消解同名副本的"重复条目"观感,验收审计 A M-2)。 */
const PLUGIN_VERSION_BADGE_RE = /\/plugins\/cache\/[^/]+\/[^/]+\/([^/]+)\/skills\//;
function skillVersionBadge(path?: string): string | undefined {
  return path ? PLUGIN_VERSION_BADGE_RE.exec(path)?.[1] : undefined;
}

function DetailDrawer({item, agentId, onClose}: {
  item: DetailItem | undefined;
  agentId: string;
  onClose: () => void;
}) {
  const [lookupTarget, setLookupTarget] = useState<{agentName: string; kind: "tool" | "skill"; name: string}>();
  const [skillDetail, setSkillDetail] = useState<SkillDetailData>();
  const [diffData, setDiffData] = useState<DiffData>();
  const [syncStatus, setSyncStatus] = useState("");
  const [pendingOverwrite, setPendingOverwrite] = useState<{targetAgent: string; source: {agentId: string; path: string}}>();
  const [syncNonce, setSyncNonce] = useState<string>();
  const [diffError, setDiffError] = useState("");
  const isSkill = item?.kind === "skill";

  useEffect(() => {
    if (!isSkill || !item) return;
    setSkillDetail(undefined);
    fetch(`/api/agent-capabilities/skill-detail?name=${encodeURIComponent(item.name)}`, {cache: "no-store"})
      .then(r => r.ok ? r.json() : undefined)
      .then(d => {
        setSkillDetail(d);
        if (typeof d?.nonce === "string") setSyncNonce(d.nonce);
      })
      .catch(() => {});
  }, [isSkill, item?.name]);

  const doSync = async (targetAgent: string, overrideSource?: {agentId: string; path: string}, force = false) => {
    if (!skillDetail || !item) return;
    setSyncStatus(`同步中 → ${targetAgent}…`);
    try {
      // Fix MEDIUM-1: 合并场景用显式源(diffData.agentA),非合并场景用当前页签 Agent。
      const source = overrideSource
        ? {agentId: overrideSource.agentId, path: overrideSource.path}
        : skillDetail.agents.find(a => a.agentId === agentId) ?? skillDetail.agents[0];
      if (!source?.path) { setSyncStatus("❌ 找不到源 skill 目录"); return; }
      // 首次不带 confirm:目标已存在且内容不同 → 服务端 409,弹二次确认后 force 重发。
      const res = await fetch("/api/agent-capabilities/skill-sync", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({skillName: item.name, sourceAgent: source.agentId, targetAgent, sourcePath: source.path, confirm: force, nonce: syncNonce}),
      });
      const data = await res.json();
      // nonce 逐次轮换:任何通过闸门的响应都携带新值。
      if (typeof data.nonce === "string") setSyncNonce(data.nonce);
      if (res.status === 403 && data.error === "LAUNCH_NONCE_INVALID") {
        setSyncStatus("操作凭证已失效,已自动刷新,请重试");
        void refreshSkillDetail();
        return;
      }
      if (res.status === 409 && data.error === "CONFIRM_REQUIRED") {
        setSyncStatus("");
        setPendingOverwrite({targetAgent, source: {agentId: source.agentId, path: source.path}});
        return;
      }
      if (data.ok) {
        setSyncStatus(`✅ 已从 ${source.agentId} 同步到 ${targetAgent}`);
        setDiffData(undefined); // 旧 hunks 与合并按钮不再指向当前内容
        setPendingOverwrite(undefined);
        void refreshSkillDetail();
      }
      else setSyncStatus(`❌ ${data.message ?? data.error}`);
    } catch (e) { setSyncStatus(`❌ ${(e as Error).message}`); }
  };

  const refreshSkillDetail = async () => {
    if (!item) return;
    fetch(`/api/agent-capabilities/skill-detail?name=${encodeURIComponent(item.name)}`, {cache: "no-store"})
      .then(r => r.ok ? r.json() : undefined)
      .then(d => {
        if (d) setSkillDetail(d);
        if (typeof d?.nonce === "string") setSyncNonce(d.nonce);
      })
      .catch(() => {});
  };

  const openDiff = async (agentA: string, agentB: string) => {
    if (!item) return;
    setDiffData(undefined);
    setDiffError("");
    fetch(`/api/agent-capabilities/skill-diff?name=${encodeURIComponent(item.name)}&agentA=${agentA}&agentB=${agentB}`)
      .then(r => r.ok ? r.json() : undefined)
      .then(d => {
        if (d) setDiffData(d);
        else setDiffError("Diff 加载失败,请重试");
      })
      .catch(() => setDiffError("Diff 加载失败,请重试"));
  };

  if (!item) return null;
  const kindLabel = item.kind === "skill" ? "Skill"
    : item.kind === "mcp_server" ? "MCP 服务"
    : item.kind === "plugin" ? "插件"
    : item.kind === "rule" ? "规则"
    : item.kind === "system_prompt" ? "系统提示词" : "工具";
  const allAgents = ["codex", "claude", "zcode", "dsh", "opencode"] as const;
  const presence = new Map(skillDetail?.agents.map(a => [a.agentId, a]) ?? []);

  return (
    <>
      <div className="acaps-detail-backdrop" onClick={onClose} role="presentation" />
      <aside className="acaps-detail" role="dialog" aria-label={`${kindLabel}详情`}>
        <header className="acaps-detail-head">
          <div className="acaps-card-icon" data-kind={item.kind}>
            {item.kind === "skill" ? "◆" : item.kind === "mcp_server" ? "⬡" : item.kind === "plugin" ? "▣" : item.kind === "rule" ? "☰" : item.kind === "system_prompt" ? "✎" : "⚙"}
          </div>
          <div className="acaps-detail-title">
            <b>{item.name}</b>
            <span>{kindLabel}{item.detail ? ` · ${item.detail}` : ""}</span>
          </div>
          <button type="button" className="acaps-detail-close" onClick={onClose} aria-label="关闭">✕</button>
        </header>
        <div className="acaps-detail-body">
          {/* 描述 */}
          {item.description ? (
            <section>
              <h5>描述</h5>
              <p>{item.description}</p>
            </section>
          ) : <p className="agent-caps-note">暂无描述。</p>}

          {/* 跨 Agent 状态(核心竞争力) */}
          {isSkill && skillDetail ? (
            <section>
              <h5>
                跨 Agent 状态 · {skillDetail.agents.length} Agent{" "}
                {skillDetail.allConsistent
                  ? (skillDetail.contentKnown === false ? "· 内容未知" : "· 内容一致 ✅")
                  : "· 内容不一致 ⚠️"}
              </h5>
              <div className="acaps-cross-grid">
                {allAgents.map(agent => {
                  const found = presence.get(agent);
                  // 同步按钮只对支持目录同步的 Agent 渲染(zcode/dsh 等盲区目标诚实拒绝)。
                  const syncable = skillDetail.syncTargets?.includes(agent) ?? false;
                  return (
                    <div key={agent} className="acaps-cross-row">
                      <span className="acaps-cross-agent">
                        {agentLabel(agent)}
                        {found?.variants && found.variants > 1 ? <small className="acaps-variant-note"> ×{found.variants}</small> : null}
                      </span>
                      {found ? (
                        found.contentHash === "unknown" ? (
                          <span className="acaps-cross-status missing">— 未知</span>
                        ) : (
                          <span className={`acaps-cross-status ${found.consistent ? "ok" : "diff"}`}>
                            {found.consistent ? "✅ 一致" : "⚠️ 不同"}
                          </span>
                        )
                      ) : syncable ? (
                        <>
                          <span className="acaps-cross-status missing">— 无</span>
                          <button type="button" className="acaps-sync-btn" onClick={() => void doSync(agent)}>同步 →</button>
                        </>
                      ) : (
                        <span className="acaps-cross-status missing" title="该 Agent 不支持目录同步">— 无</span>
                      )}
                    </div>
                  );
                })}
              </div>
              {diffError ? <p className="acaps-sync-status">{diffError}</p> : null}
              {syncStatus ? <p className="acaps-sync-status">{syncStatus}</p> : null}
              {/* 覆盖二次确认:目标已存在且内容不同时弹出 */}
              {pendingOverwrite ? (
                <div className="acaps-overwrite-confirm">
                  <p>目标 Agent <b>{agentLabel(pendingOverwrite.targetAgent)}</b> 已存在同名 Skill 且内容不同,确认用 <b>{agentLabel(pendingOverwrite.source.agentId)}</b> 的内容覆盖?</p>
                  <div className="acaps-diff-actions">
                    <button type="button" className="danger" onClick={() => {
                      const p = pendingOverwrite;
                      setPendingOverwrite(undefined);
                      void doSync(p.targetAgent, p.source, true);
                    }}>确认覆盖</button>
                    <button type="button" onClick={() => setPendingOverwrite(undefined)}>取消</button>
                  </div>
                </div>
              ) : null}
              {!skillDetail.allConsistent ? (
                <div className="acaps-diff-actions">
                  {(() => {
                    /* 配对 = 基准 Agent(首个有效 hash)× 首个 hash 不同的**其它** Agent。
                       验收审计 A HIGH-1:按对象身份比较会让同 Agent 多副本自比
                       (「ZCode ↔ ZCode」空 diff);索引侧已按 (name, agentId) 收敛,
                       此处再按 agentId 防御性去重,无跨 Agent 分歧时不渲染入口。 */
                    const withHash = skillDetail.agents.filter(a => a.contentHash !== "unknown");
                    const baseline = withHash[0];
                    const divergent = withHash.find(a => baseline && a.agentId !== baseline.agentId && a.contentHash !== baseline.contentHash);
                    return baseline && divergent
                      ? <button type="button" onClick={() => void openDiff(baseline.agentId, divergent.agentId)}>查看 Diff ({agentLabel(baseline.agentId)} ↔ {agentLabel(divergent.agentId)})</button>
                      : null;
                  })()}
                </div>
              ) : null}
            </section>
          ) : null}

          {/* Diff 视图 */}
          {diffData ? (
            <section>
              <h5>Diff · {agentLabel(diffData.agentA)} ↔ {agentLabel(diffData.agentB)}</h5>
              <div className="acaps-diff-view">
                {diffData.hunks.filter(h => h.type !== "ctx").length === 0 ? (
                  <p className="agent-caps-note">内容完全一致。</p>
                ) : diffData.hunks.slice(0, 100).map((h, i) => (
                  <div key={i} className={`acaps-diff-line ${h.type}`}>
                    <span className="mono">{h.type === "add" ? `+${h.bLine ?? ""}` : h.type === "del" ? `-${h.aLine ?? ""}` : " "}</span>
                    <span className="mono">{h.text.length > 80 ? `${h.text.slice(0, 80)}…` : h.text}</span>
                  </div>
                ))}
              </div>
              {/* 截断必须明示(项目红线):行数与单行长度均受限。 */}
              {diffData.hunks.length > 100 ? (
                <p className="acaps-diff-truncated">预览受限:仅显示前 100 行差异,共 {diffData.hunks.length} 行;超长行已截断到 80 字符。</p>
              ) : (
                <p className="acaps-diff-truncated">超长行已截断到 80 字符。</p>
              )}
              {/* 一键合并 */}
              <div className="acaps-diff-actions">
                <button type="button" onClick={() => {
                  const src = skillDetail?.agents.find(a => a.agentId === diffData!.agentA);
                  if (src) void doSync(diffData!.agentB, {agentId: src.agentId, path: src.path});
                }} title={`用 ${diffData.agentA} 的内容覆盖 ${diffData.agentB}`}>
                  以 {diffData.agentA} → {diffData.agentB} 合并
                </button>
                <button type="button" onClick={() => void openDiff(diffData!.agentB, diffData.agentA)}>反向合并</button>
              </div>
            </section>
          ) : null}

          {/* 正文缺失/超限的诚实提示(验收审计 B LOW-4) */}
          {isSkill && skillDetail && !skillDetail.content ? (
            <p className="agent-caps-note">SKILL.md 不可读或超过 100 KiB 上限,未展示全文。</p>
          ) : null}

          {/* SKILL.md 全文 */}
          {isSkill && skillDetail?.content ? (
            <section>
              <h5>SKILL.md 全文</h5>
              <div className="acaps-skill-md">
                <pre>{skillDetail.content}</pre>
              </div>
            </section>
          ) : null}

          {/* 参数(工具) */}
          {item.paramNames ? (
            <section>
              <h5>参数</h5>
              <p className="mono">{item.paramNames}</p>
            </section>
          ) : null}

          {/* 来源路径 */}
          {item.sourcePath ? (
            <section>
              <h5>来源</h5>
              <p className="mono acaps-detail-path">{item.sourcePath}</p>
            </section>
          ) : null}

          {/* 反查链接 */}
          {item.kind === "tool" || item.kind === "skill" ? (
            <button
              type="button"
              className="acaps-detail-lookup"
              onClick={() => setLookupTarget({agentName: agentId, kind: item.kind === "skill" ? "skill" : "tool", name: item.name})}
            >
              查看调用记录与使用分析 →
            </button>
          ) : null}
        </div>
      </aside>
      <CapabilityLookupDialog
        target={lookupTarget}
        onClose={() => setLookupTarget(undefined)}
        onNavigate={() => {}}
      />
    </>
  );
}

interface SkillDetailData {
  name: string;
  agents: Array<{agentId: string; path: string; contentHash: string; consistent: boolean; description?: string; variants?: number}>;
  allConsistent: boolean;
  contentKnown?: boolean;
  content?: string;
  /** 支持目录同步的 Agent 列表(服务端下发,决定同步按钮渲染)。 */
  syncTargets?: string[];
  /** 同步写操作的单次 nonce(服务端下发,逐次轮换)。 */
  nonce?: string;
}

interface DiffData {
  name: string;
  agentA: string;
  agentB: string;
  hunks: Array<{type: "ctx" | "add" | "del"; aLine?: number; bLine?: number; text: string}>;
}
