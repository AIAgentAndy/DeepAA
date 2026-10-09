"use client";

import {Check, CircleAlert, SquareTerminal, X} from "lucide-react";
import {useEffect, useRef, useState} from "react";
import {AGENT_CATALOG, agentCompatibleModelsForTarget, agentLabel, isAgentConnected, resolveTargetAgentCapability} from "@/components/proxy-management/agent-catalog";
import {AGENT_LOGO_EXT} from "@/components/proxy-management/agent-entry-badges";
import {resolveAgentConnection} from "@/lib/agent-connections";
import {agentScopeIncludes, type AgentId, type ProxyConfig} from "@/types";
import type {CredentialItem} from "./proxy-management-types";
import styles from "./proxy-management.module.css";

interface AgentDefaultEntryDialogProps {
  agent: AgentId;
  config: ProxyConfig;
  credentials: CredentialItem[];
  onClose: () => void;
  /** 选择默认供应商后立即生效（保留该 Agent 其它已绑定供应商）。 */
  onSetDefaultTarget: (agent: AgentId, targetId: string) => Promise<void>;
  /** 设置指定供应商下该 Agent 的默认模型（立即生效）。 */
  onSetDefaultModel: (agent: AgentId, targetId: string, modelId: string) => Promise<void>;
  /** 设置指定供应商下该 Agent 的默认密钥（立即生效）。 */
  onSetDefaultCredential: (agent: AgentId, targetId: string, credentialId: string) => Promise<void>;
  /** 打开「在 XXX 中开发」弹窗（默认链 ready 时可用）。 */
  onLaunch: (agent: AgentId, targetId: string) => void;
}

/**
 * Agent 默认入口弹窗：顶部「在 XXX 中开发」，下方默认供应商/模型/密钥三个下拉，
 * 选择即触发对应修改动作（即时生效、无需保存按钮）；数据随 config/credentials 实时刷新。
 */
export function AgentDefaultEntryDialog({agent, config, credentials, onClose, onSetDefaultTarget, onSetDefaultModel, onSetDefaultCredential, onLaunch}: AgentDefaultEntryDialogProps) {
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const entry = AGENT_CATALOG.find(item => item.id === agent)!;
  const label = entry.label;
  const connection = config.agentConnections[agent];
  const boundTargetIds = connection?.boundTargetIds?.length
    ? connection.boundTargetIds
    : connection?.defaultTargetId ? [connection.defaultTargetId] : [];
  const connected = isAgentConnected(config, agent);
  const resolved = resolveAgentConnection(config, agent, credentials);
  // 可选默认供应商：该 Agent 已绑定、启用且协议支持的。
  const targetOptions = config.targets.filter(target =>
    boundTargetIds.includes(target.id)
    && target.enabled
    && resolveTargetAgentCapability(target, agent).supported);
  const defaultTargetId = connection?.defaultTargetId || "";
  const defaultTarget = config.targets.find(target => target.id === defaultTargetId);
  const modelOptions = defaultTarget ? agentCompatibleModelsForTarget(defaultTarget, agent) : [];
  const targetCredentials = credentials.filter(item => item.targetId === defaultTargetId && agentScopeIncludes(item.agentScope, agent));
  const defaultModel = defaultTarget?.development?.defaultModels?.[agent] || "";
  const defaultCredential = defaultTarget?.development?.defaultCredentials?.[agent] || "";
  const [feedback, setFeedback] = useState<Record<string, "ok" | "error">>({});
  const [error, setError] = useState("");

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") closeRef.current();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.querySelector<HTMLButtonElement>(".agent-entry-close")?.focus();
    return () => { previouslyFocused?.focus(); };
  }, []);

  /** 选择即触发：成功短暂显示 ✓，失败显示错误并回滚反馈。 */
  async function apply(key: string, action: () => Promise<void>) {
    setError("");
    try {
      await action();
      setFeedback(current => ({...current, [key]: "ok"}));
      window.setTimeout(() => setFeedback(current => {
        const next = {...current};
        delete next[key];
        return next;
      }), 1800);
    } catch (cause) {
      setFeedback(current => ({...current, [key]: "error"}));
      setError(cause instanceof Error ? cause.message : "保存失败");
    }
  }

  function feedbackIcon(key: string) {
    if (feedback[key] === "ok") return <span className={styles.entryFieldSaved}><Check size={14} /> 已保存</span>;
    if (feedback[key] === "error") return <span className={styles.entryFieldFailed}><CircleAlert size={14} /> 失败</span>;
    return null;
  }

  /** 预取开发启动数据：hover 按钮时提前触发服务端 capabilities/preflight 计算并填热短缓存，
   * 用户点击「在 XX 中开发」后弹窗打开即命中缓存秒渲染。预取与弹窗首次调用使用相同参数
   * （含 lastProjectDir，Codex 客户端模式除外），保证缓存键一致；失败静默不阻塞后续操作。 */
  function prefetchLaunchData(targetId: string): void {
    if (!targetId) return;
    const target = config.targets.find(item => item.id === targetId);
    const lastDir = agent !== "codex" ? target?.development?.lastProjectDir : undefined;
    void (async () => {
      try {
        const cap = await fetch("/api/development-launch/capabilities", {cache: "no-store"})
          .then(response => response.json()) as {nonce?: string};
        if (!cap.nonce) return;
        await fetch("/api/development-launch/preflight", {
          method: "POST",
          headers: {"content-type": "application/json"},
          body: JSON.stringify({cli: agent, targetId, projectDir: lastDir || undefined, nonce: cap.nonce}),
        }).catch(() => undefined);
      } catch {
        // 预取失败静默：弹窗打开时仍会正常请求。
      }
    })();
  }

  /** Agent 品牌色头部类名（CSS module 需要静态类）。 */
  function entryHeaderClass(id: AgentId): string {
    if (id === "codex") return styles.entryHeaderCodex;
    if (id === "claude") return styles.entryHeaderClaude;
    if (id === "opencode") return styles.entryHeaderOpencode;
    if (id === "zcode") return styles.entryHeaderZcode;
    return styles.entryHeaderDsh;
  }

  return (
    <div className={styles.dialogBackdrop} role="presentation" onMouseDown={event => {if (event.currentTarget === event.target) onClose();}}>
      <section ref={dialogRef} className={`${styles.dialog} ${styles.entryDialog}`} role="dialog" aria-modal="true" aria-labelledby="agent-entry-title">
        <header className={`${styles.dialogHeader} ${styles.entryDialogHeader} ${entryHeaderClass(agent)}`}>
          <div className={styles.entryDialogIdentity}>
            <span className={`${styles.entryLogo} ${entryHeaderClass(agent)}`}><img src={`/agent-logos/${agent}.${AGENT_LOGO_EXT[agent] || "png"}`} alt="" /></span>
            <div><h2 id="agent-entry-title">{label}</h2><span className={`${styles.badge} ${connected && resolved.proxyReady ? styles.badgeReady : styles.badgePending}`}>{connected && resolved.proxyReady ? "可用" : "待配置"}</span></div>
          </div>
          <button type="button" className={`${styles.iconButton} agent-entry-close`} onClick={onClose} aria-label="关闭"><X size={18} /></button>
        </header>
        <div className={styles.entryDialogBody}>
          <button type="button" className={styles.entryLaunchButton} disabled={!connected || !resolved.proxyReady || !defaultTargetId} onClick={() => { if (defaultTargetId) onLaunch(agent, defaultTargetId); }} onMouseEnter={() => prefetchLaunchData(defaultTargetId)} title={resolved.proxyReady ? `在 ${label} 中开发（默认供应商：${defaultTarget?.name || "未选择"}）` : "默认链未就绪：请先完成默认供应商、模型与密钥配置"}><SquareTerminal size={16} /> 在 {label} 中开发</button>
          {!connected ? <p className={styles.entryHint}>尚未接入 {label}：接入后这里将展示默认供应商、模型与密钥的即时设置。</p> : null}
          {error ? <p className={styles.errorText} role="alert">{error}</p> : null}
          <label className={styles.entryField}><span>默认供应商</span><select value={defaultTargetId} disabled={!connected} onChange={event => { const targetId = event.currentTarget.value; if (targetId) void apply("target", () => onSetDefaultTarget(agent, targetId)); }}><option value="">暂不选择</option>{targetOptions.map(target => <option key={target.id} value={target.id}>{target.name}</option>)}</select>{feedbackIcon("target")}<small>选择后立即生效；该 Agent 的其它已绑定供应商保留。</small></label>
          <label className={styles.entryField}><span>当前默认供应商下的默认模型</span><select value={defaultModel} disabled={!connected || !defaultTargetId} onChange={event => { const modelId = event.currentTarget.value; if (defaultTargetId && modelId) void apply("model", () => onSetDefaultModel(agent, defaultTargetId, modelId)); }}><option value="">选择模型</option>{modelOptions.map(model => <option key={model} value={model}>{model}</option>)}</select>{feedbackIcon("model")}<small>跟随当前默认供应商；切换默认供应商后需重新设置。</small></label>
          <label className={styles.entryField}><span>当前默认供应商下的默认密钥</span><select value={defaultCredential} disabled={!connected || !defaultTargetId} onChange={event => { const credentialId = event.currentTarget.value; if (defaultTargetId && credentialId) void apply("credential", () => onSetDefaultCredential(agent, defaultTargetId, credentialId)); }}><option value="">选择密钥</option>{targetCredentials.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select>{feedbackIcon("credential")}<small>密钥适用当前默认供应商；选择后立即生效。</small></label>
        </div>
      </section>
    </div>
  );
}