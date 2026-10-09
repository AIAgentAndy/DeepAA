"use client";

import {AGENT_CATALOG, agentLabel, boundCompatibleTargetsForAgent} from "@/components/proxy-management/agent-catalog";
import {AGENT_LOGO_EXT} from "@/lib/agent-registry";
import type {AgentId, ProxyConfig} from "@/types";
import styles from "./proxy-management.module.css";

/** 兼容旧导入路径：logo 扩展名映射的唯一来源已收敛到 agent-registry。 */
export {AGENT_LOGO_EXT};

interface AgentEntryBadgesProps {
  config: ProxyConfig;
  onSelect: (agent: AgentId) => void;
}

/** 页面顶部「已接入 Agent」logo 行：只展示至少有一个可用供应商候选的 Agent。 */
export function AgentEntryBadges({config, onSelect}: AgentEntryBadgesProps) {
  const connected = AGENT_CATALOG.filter(entry => boundCompatibleTargetsForAgent(config, entry.id).length > 0);
  if (connected.length === 0) return null;
  return (
    <div className={styles.pageHeaderEntries} aria-label="已接入的 Agent">
      {connected.map(entry => (
        <button key={entry.id} type="button" className={styles.entryBadge} onClick={() => onSelect(entry.id)} title={`编辑 ${agentLabel(entry.id)} 默认入口`}>
          <span className={`${styles.entryBadgeLogo} ${entryBadgeColor(entry.id)}`}>
            <img src={`/agent-logos/${entry.id}.${AGENT_LOGO_EXT[entry.id] || "png"}`} alt="" />
          </span>
          <span className={styles.entryBadgeName}>{agentLabel(entry.id)}</span>
        </button>
      ))}
    </div>
  );
}

function entryBadgeColor(id: AgentId): string {
  if (id === "codex") return styles.entryBadgeCodex;
  if (id === "claude") return styles.entryBadgeClaude;
  if (id === "opencode") return styles.entryBadgeOpencode;
  if (id === "zcode") return styles.entryBadgeZcode;
  return styles.entryBadgeDsh;
}
