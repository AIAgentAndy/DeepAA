import {useEffect, useMemo, useRef, useState} from "react";
import {ArrowDown, ArrowUp, ArrowRightLeft, Info, X} from "lucide-react";
import {MAX_TARGET_MODEL_FALLBACKS, collectFallbackCandidateOptions, servableAgentsForModel} from "@/lib/proxy-management-domain";
import {agentLabel} from "./agent-catalog";
import type {AgentId, ProxyConfig, ProxyTarget} from "@/types";
import styles from "./proxy-management.module.css";

interface ProxyFallbackDialogProps {
  target: ProxyTarget;
  config: ProxyConfig;
  modelId: string;
  busy: boolean;
  /** 保存该主模型的有序故障转移链；空数组表示清空。 */
  onSave: (fallbacks: string[]) => Promise<void>;
  onClose: () => void;
}

/**
 * 故障转移模型编辑弹层（有序配置编辑器）：候选区跨供应商分组展示与主模型
 * 存在「共同可服务 Agent」的白名单模型（网关 /v1/models 同口径，代理转发时
 * 只改 model 字段、零转换）；已选区按优先级排序，顺序即网关故障转移的尝试
 * 优先级。候选收集来自公共纯函数。
 */
export function ProxyFallbackDialog({target, config, modelId, busy, onSave, onClose}: ProxyFallbackDialogProps) {
  const initial = target.supportedModelFallbacks?.[modelId] ?? [];
  const [draft, setDraft] = useState<string[]>(initial);
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const dialogRef = useRef<HTMLElement>(null);
  // 主模型没有任何可服务 Agent（绑定/凭据/协议错位）时候选为空，需明确提示原因。
  const primaryServableAgents = useMemo(() => servableAgentsForModel(target, modelId), [target, modelId]);

  // 供应商路由 ID → 显示名（候选卡片、已选列表、搜索共用）。
  const targetNames = useMemo(
    () => new Map(config.targets.map(owner => [owner.id, owner.name || owner.id])),
    [config.targets],
  );
  const candidates = useMemo(
    () => collectFallbackCandidateOptions(target, config.targets, modelId),
    [target, config.targets, modelId],
  );

  // Escape 关闭 + Tab 焦点圈（与供应商管理其它弹层保持同一交互惯例）。
  useEffect(() => {
    const host = dialogRef.current;
    if (!host) return;
    const focusables = host.querySelectorAll<HTMLElement>("input, button, select, textarea");
    focusables[0]?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab" || focusables.length === 0) return;
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    host.addEventListener("keydown", onKeyDown);
    return () => host.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const filteredCandidates = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    const selected = new Set(draft);
    return candidates.filter(candidate => !selected.has(candidate.gatewayModelId))
      .filter(candidate => !keyword
        || candidate.modelId.toLowerCase().includes(keyword)
        || candidate.targetName.toLowerCase().includes(keyword));
  }, [candidates, draft, search]);

  const groupedCandidates = useMemo(() => {
    const groups = new Map<string, typeof filteredCandidates>();
    for (const candidate of filteredCandidates) {
      const list = groups.get(candidate.targetId) ?? [];
      list.push(candidate);
      groups.set(candidate.targetId, list);
    }
    return [...groups.entries()];
  }, [filteredCandidates]);

  const draftCandidates = useMemo(() => draft
    .map(gatewayModelId => candidates.find(candidate => candidate.gatewayModelId === gatewayModelId))
    .map((candidate, index) => candidate ?? {
      gatewayModelId: draft[index]!,
      modelId: draft[index]!,
      targetId: "",
      targetName: "",
      agents: [] as AgentId[],
    }), [candidates, draft]);
  function addCandidate(gatewayModelId: string) {
    setError("");
    setDraft(current => current.length >= MAX_TARGET_MODEL_FALLBACKS
      ? current
      : [...current, gatewayModelId]);
  }

  function removeAt(index: number) {
    setError("");
    setDraft(current => current.filter((_, position) => position !== index));
  }

  function move(index: number, delta: -1 | 1) {
    setError("");
    setDraft(current => {
      const next = [...current];
      const targetIndex = index + delta;
      if (targetIndex < 0 || targetIndex >= next.length) return current;
      [next[index], next[targetIndex]] = [next[targetIndex]!, next[index]!];
      return next;
    });
  }

  async function save() {
    if (saving) return;
    setSaving(true);
    setError("");
    try {
      await onSave(draft);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "保存故障转移模型失败");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className={styles.dialogBackdrop}
      onMouseDown={event => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section className={`${styles.dialog} ${styles.fallbackDialog}`} role="dialog" aria-modal="true" aria-label={`配置 ${modelId} 的故障转移模型`} ref={dialogRef}>
        <header className={styles.fallbackHeader}>
          <span className={styles.fallbackIconBadge} aria-hidden="true"><ArrowRightLeft size={19} /></span>
          <div className={styles.fallbackHeaderText}>
            <h3>故障转移模型 · {modelId}</h3>
            <p>主模型连续 2 次请求不通时，自动按优先级转移到故障转移模型；检测到上下文压缩时自动尝试切回主力模型。</p>
          </div>
          <button type="button" className={styles.iconButtonSmall} onClick={onClose} aria-label="关闭"><X size={16} /></button>
        </header>
        <div className={styles.fallbackBody}>
          <section className={styles.fallbackSection}>
            <label className={`${styles.field} ${styles.fallbackSearchField}`}>
              <span>搜索候选模型（全部供应商，需与主模型存在共同可用的 Agent）</span>
              <input
                value={search}
                onChange={event => setSearch(event.currentTarget.value)}
                placeholder="搜索模型 ID 或供应商名称"
              />
            </label>
            {primaryServableAgents.length === 0 ? (
              <p className={styles.fallbackEmpty}>
                主模型当前没有任何可用的 Agent 适用（绑定、密钥或协议未就绪），无法配置故障转移；请先在「Agent 适用」中确认该模型可被至少一个 Agent 使用。
              </p>
            ) : (
              <div className={styles.fallbackCandidateGroups}>
                {groupedCandidates.length === 0
                  ? <p className={styles.fallbackEmpty}>没有匹配的候选模型；候选需与主模型存在共同可用的 Agent（协议与凭据就绪）。</p>
                  : groupedCandidates.map(([ownerTargetId, list]) => (
                    <div key={ownerTargetId} className={styles.fallbackCandidateGroup}>
                      <small className={styles.fallbackGroupName}>{targetNames.get(ownerTargetId) ?? ownerTargetId}</small>
                      <div className={styles.fallbackCandidateList}>
                        {list.map(candidate => (
                          <button
                            key={candidate.gatewayModelId}
                            type="button"
                            className={styles.fallbackCandidateCard}
                            onClick={() => addCandidate(candidate.gatewayModelId)}
                            disabled={draft.length >= MAX_TARGET_MODEL_FALLBACKS}
                            title={draft.length >= MAX_TARGET_MODEL_FALLBACKS ? `最多 ${MAX_TARGET_MODEL_FALLBACKS} 个故障转移模型` : `添加 ${candidate.gatewayModelId}`}
                          >
                            <span className={styles.fallbackCardMain}>
                              <span className={styles.fallbackCardModel}>{candidate.modelId}</span>
                              <span className={styles.fallbackCardTarget}>{candidate.targetName}</span>
                            </span>
                            {candidate.agents.length > 0
                              ? <span className={styles.fallbackCardAgents}>{candidate.agents.map(agentLabel).join("、")}</span>
                              : null}
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
              </div>
            )}
          </section>
          <section className={styles.fallbackSection}>
            <p className={styles.fallbackSectionTitle}>已选（按优先级尝试，{draft.length}/{MAX_TARGET_MODEL_FALLBACKS}）</p>
            {draftCandidates.length === 0
              ? <p className={styles.fallbackEmpty}>尚未选择故障转移模型；不配置则该模型不启用故障转移。</p>
              : <ol className={styles.fallbackDraftList}>
                {draftCandidates.map((candidate, index) => (
                  <li key={candidate.gatewayModelId} className={styles.fallbackDraftItem}>
                    <span className={styles.fallbackPriority}>{index + 1}</span>
                    <span className={styles.fallbackDraftName}>
                      <strong>{candidate.modelId}</strong>
                      {candidate.targetName ? <small>{candidate.targetName}</small> : null}
                    </span>
                    <span className={styles.fallbackDraftActions}>
                      <button type="button" className={styles.iconButtonSmall} onClick={() => move(index, -1)} disabled={index === 0} aria-label="上移"><ArrowUp size={14} /></button>
                      <button type="button" className={styles.iconButtonSmall} onClick={() => move(index, 1)} disabled={index === draftCandidates.length - 1} aria-label="下移"><ArrowDown size={14} /></button>
                      <button type="button" className={styles.iconButtonSmall} onClick={() => removeAt(index)} aria-label="移除"><X size={14} /></button>
                    </span>
                  </li>
                ))}
              </ol>}
          </section>
          <aside className={styles.fallbackHints}>
            <Info size={15} aria-hidden="true" />
            <div>
              <p>建议所有闭源模型（如：GPT、Claude类）优先设置相同模型ID（如 中转站A gpt-5.6-sol → 中转站B gpt-5.6-sol，可以跨供应商）的故障转移备份模型，以最大可能性的复用上游提示词缓存。</p>
              <p>请求过程中，一旦切换到备份模型，系统会在下一次检测到上下文压缩时才自动尝试切回主力模型（兜底：长期未压缩约 2 小时后也会自动尝试切回），以最大化利用缓存及平衡主力模型可用性。</p>
            </div>
          </aside>
          {error ? <p className={styles.errorText} role="alert">{error}</p> : null}
        </div>
        <footer className={styles.fallbackFooter}>
          <button type="button" className={styles.secondaryButton} onClick={onClose}>取消</button>
          <button type="button" className={styles.primaryButton} onClick={() => void save()} disabled={saving || busy}>
            {saving ? "保存中…" : "保存"}
          </button>
        </footer>
      </section>
    </div>
  );
}
