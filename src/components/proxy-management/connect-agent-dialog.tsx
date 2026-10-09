import {useEffect, useMemo, useRef, useState} from "react";
import {X} from "lucide-react";
import {confirmDialog} from "@/components/confirm-dialog";
import {AGENT_CATALOG, agentCompatibleModelsForTarget, agentLabel, isAgentConnected, targetHasProtocolForAgent} from "@/components/proxy-management/agent-catalog";
import {formatCredentialFingerprint} from "@/components/proxy-management/credential-format";
import type {CredentialItem} from "./proxy-management-types";
import {agentScopeIncludes, type AgentId, type ProxyConfig} from "@/types";
import styles from "./proxy-management.module.css";

interface ConnectAgentDialogProps {
  config: ProxyConfig;
  credentials: CredentialItem[];
  initialAgent?: AgentId;
  /** 从某个代理供应商的上下文打开时传入该供应商 ID：默认模型/密钥跟随当前供应商，并显示「作为默认供应商」勾选框。 */
  currentTargetId?: string;
  onTargetChange: (targetId: string) => void;
  onClose: () => void;
  onSave: (input: {
    agent: AgentId;
    boundTargetIds?: string[];
    defaultTargetId?: string;
    defaultModelId?: string;
    defaultCredentialId?: string;
    cliSyncEnabled: boolean;
  }) => Promise<void>;
}

export function ConnectAgentDialog({config, credentials, initialAgent, currentTargetId, onTargetChange, onClose, onSave}: ConnectAgentDialogProps) {
  const dialogRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  // 无指定 Agent 时默认选第一个「未有效接入」的 Agent：默认代理供应商为空或失效的连接
  // 回退为未接入，从这里进入的是新建接入流程，而不是对残留连接的编辑。
  const firstNotConnected = AGENT_CATALOG.map(entry => entry.id)
    .find(item => !isAgentConnected(config, item));
  const [agent, setAgent] = useState<AgentId>(initialAgent || firstNotConnected || "codex");
  // 从「接入其他 Agent」进入且全部已接入时，不再回退到 Codex 编辑模式。
  const allConnectedWithoutInitial = !initialAgent && !firstNotConnected;
  // 仅「有效接入」（默认代理供应商已选择且存在）视为已接入；残留连接按新接入处理。
  const existing = isAgentConnected(config, agent) ? config.agentConnections[agent] : undefined;
  const existingDefaultTargetId = existing?.defaultTargetId;
  const [targetId, setTargetId] = useState(existing?.defaultTargetId || "");
  // 只反映已保存事实；首次接入不自动勾选默认代理供应商。
  const [asDefault, setAsDefault] = useState(() => Boolean(currentTargetId && existingDefaultTargetId === currentTargetId));
  const [modelId, setModelId] = useState("");
  const [credentialId, setCredentialId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const currentTarget = currentTargetId ? config.targets.find(item => item.id === currentTargetId) : undefined;
  const label = agentLabel(agent);
  // 可选择的模型与密钥一定来自当前上下文供应商（或弹窗中选择的供应商），不会串到其它供应商。
  const target = currentTarget || config.targets.find(item => item.id === targetId);
  // 只提供与该 Agent 协议能力兼容的模型（如 Codex 只支持 Responses，Chat 模型不出现）；
  // 无 wire API 声明的自定义供应商保持全部适用模型可选。
  const models = target ? agentCompatibleModelsForTarget(target, agent) : [];
  const scopeModels = target?.supportedModels.filter(model => agentScopeIncludes(target.supportedModelScopes?.[model], agent)) || [];
  const wireApiFilteredCount = Math.max(0, scopeModels.length - models.length);
  const targetCredentials = credentials.filter(item => item.targetId === target?.id && agentScopeIncludes(item.agentScope, agent));
  const targetOptions = useMemo(() => config.targets.filter(item =>
    item.enabled && targetHasProtocolForAgent(item, agent)), [config.targets, agent]);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButtonRef.current?.focus();
    function handleDialogKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(
        "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])",
      ) || []).filter(element => element.getAttribute("aria-hidden") !== "true");
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", handleDialogKeyDown);
    return () => {
      document.removeEventListener("keydown", handleDialogKeyDown);
      previouslyFocused?.focus();
    };
  }, []);

  useEffect(() => {
    const next = config.agentConnections[agent];
    setTargetId(next?.defaultTargetId || "");
    if (currentTargetId) {
      setAsDefault(next?.defaultTargetId === currentTargetId);
    }
    const nextTarget = currentTarget || config.targets.find(item => item.id === next?.defaultTargetId);
    setModelId(nextTarget?.development?.defaultModels?.[agent] || "");
    setCredentialId(nextTarget?.development?.defaultCredentials?.[agent] || "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent, config, currentTargetId]);

  useEffect(() => {
    setModelId(target?.development?.defaultModels?.[agent] || "");
    setCredentialId(target?.development?.defaultCredentials?.[agent] || "");
  }, [targetId, agent, currentTargetId, target]);

  function handleAsDefaultChange(checked: boolean) {
    void (async () => {
      // 该 Agent 已有其它默认代理供应商时，改为当前供应商需要确认。
      if (checked && currentTargetId && existingDefaultTargetId && existingDefaultTargetId !== currentTargetId) {
        const oldTarget = config.targets.find(item => item.id === existingDefaultTargetId);
        const confirmed = await confirmDialog({title: "切换默认供应商", message: `当前 ${label} 的默认供应商是「${oldTarget?.name || existingDefaultTargetId}」，确认改为当前供应商「${currentTarget?.name || currentTargetId}」吗？`});
        if (!confirmed) return;
      }
      setAsDefault(checked);
    })();
  }

  async function submit() {
    setBusy(true);
    setError("");
    try {
      await onSave({
        agent,
        ...(target?.id ? {boundTargetIds: [target.id]} : {}),
        // 有供应商上下文：勾选才设置当前供应商为默认；取消勾选只建立绑定，保留原默认供应商。
        // 无供应商上下文：下拉框选择的是显式默认供应商；未选择时保留旧值。
        defaultTargetId: currentTargetId
          ? (asDefault ? currentTargetId : undefined)
          : (targetId || undefined),
        ...(modelId ? {defaultModelId: modelId} : {}),
        ...(credentialId ? {defaultCredentialId: credentialId} : {}),
        // 配置数据同步不再由用户显式选择：供应商启用且链路完整时保存即同步。
        cliSyncEnabled: true,
      });
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "接入失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.dialogBackdrop} role="presentation" onMouseDown={event => {if (event.currentTarget === event.target) onClose();}}>
      <section ref={dialogRef} className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby="connect-agent-title">
        <header className={styles.dialogHeader}><div><h2 id="connect-agent-title">{allConnectedWithoutInitial ? "接入 Agent" : existing ? "编辑 Agent 默认入口" : "接入 Agent"}</h2><p>{allConnectedWithoutInitial ? "当前没有需要接入的 Agent。" : currentTarget ? `默认模型与密钥跟随当前供应商「${currentTarget.name || currentTarget.id}」；切换供应商后默认模型与密钥随之变化。` : "可以只接入并稍后配置默认供应商。"}</p></div><button ref={closeButtonRef} type="button" className={styles.iconButton} onClick={onClose} aria-label="关闭"><X size={18} /></button></header>
        {allConnectedWithoutInitial ? <div className={styles.formStack}><p className={styles.muted}>所有 Agent 都已接入，无需重复接入；如需调整默认入口，请在左侧「各 Agent 默认入口」中编辑。</p></div> : <div className={styles.formStack}>
          <label className={styles.field}><span>Agent</span><select value={agent} onChange={event => setAgent(event.currentTarget.value as AgentId)} disabled={Boolean(initialAgent)}>{AGENT_CATALOG.map(entry => entry.id).filter(item => item === agent || !isAgentConnected(config, item)).map(item => <option key={item} value={item}>{agentLabel(item)}</option>)}</select><small>已接入的 Agent 不再出现在选项中；如需调整请在左侧默认入口中编辑。</small></label>
          {currentTargetId ? (
            <label className={styles.switchRow}><input type="checkbox" checked={asDefault} onChange={event => handleAsDefaultChange(event.currentTarget.checked)} /><span><strong>作为默认供应商</strong><small>{existingDefaultTargetId && existingDefaultTargetId !== currentTargetId ? `该 Agent 的默认供应商是「${config.targets.find(item => item.id === existingDefaultTargetId)?.name || existingDefaultTargetId}」；接入不会改变默认，如需改为当前供应商请勾选（需确认）。` : existingDefaultTargetId === currentTargetId ? "当前供应商已是该 Agent 的默认供应商。" : "该 Agent 尚未设置默认供应商；不勾选时仅建立接入绑定并保持待配置。"}</small></span></label>
          ) : (
            <label className={styles.field}><span>默认供应商</span><select value={targetId} onChange={event => {const nextTargetId = event.currentTarget.value; setTargetId(nextTargetId); if (nextTargetId) onTargetChange(nextTargetId);}}><option value="">暂不选择供应商</option>{targetOptions.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select><small>未选择时保存为待配置，不会隐式回退第一个供应商。</small></label>
          )}
          <label className={styles.field}><span>当前供应商下的默认模型</span><select value={modelId} onChange={event => setModelId(event.currentTarget.value)} disabled={!targetId && !currentTargetId}><option value="">暂不选择</option>{models.map(model => <option key={model} value={model}>{model}</option>)}</select><small>{wireApiFilteredCount > 0 ? `有 ${wireApiFilteredCount} 个适用模型因协议能力不兼容 ${label} 未列出（如 Chat 模型不能用于只支持 Responses 的 Codex）。` : "默认模型跟随当前供应商；切换默认供应商后需重新设置。"}</small></label>
          <label className={styles.field}><span>当前供应商下的默认密钥</span><select value={credentialId} onChange={event => setCredentialId(event.currentTarget.value)} disabled={!targetId && !currentTargetId}><option value="">暂不选择</option>{targetCredentials.map(item => <option key={item.id} value={item.id}>{item.label} · {formatCredentialFingerprint(item.fingerprintSuffix)}</option>)}</select></label>
          {error ? <p className={styles.errorText} role="alert">{error}</p> : null}
        </div>}
        <footer className={styles.dialogFooter}>{allConnectedWithoutInitial ? <button type="button" className={styles.primaryButton} onClick={onClose}>知道了</button> : <><button type="button" className={styles.secondaryButton} onClick={onClose}>取消</button><button type="button" className={styles.primaryButton} onClick={() => void submit()} disabled={busy}>{busy ? "保存中…" : existing ? "保存设置" : "确认接入"}</button></>}</footer>
      </section>
    </div>
  );
}
