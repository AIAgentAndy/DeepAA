"use client";

import type {ModelDiscoverResponse} from "./proxy-management-types";
import styles from "./proxy-management.module.css";

interface ModelDiscoveryTableProps {
  result: ModelDiscoverResponse;
  selectedModelIds: readonly string[];
  onToggle: (modelId: string, checked: boolean) => void;
  /** 全选/全不选：仅作用于可选择行（matched + removed）。 */
  onToggleAll: (checked: boolean) => void;
}

/**
 * 模型发现结果只展示业务字段；内部 priceEntryId 不向用户暴露。
 * 已匹配与存量模型可选，非固定模型家族或缺少价格映射的模型只读展示。
 */
export function ModelDiscoveryTable({
  result,
  selectedModelIds,
  onToggle,
  onToggleAll,
}: ModelDiscoveryTableProps) {
  const added = new Set((result.added || []).map(item => item.modelId));
  const existing = new Set(result.existing || []);
  const matched = result.matched || [];
  const removed = result.removed || [];
  const unpriced = result.unpriced || [];
  // existing（当前密钥返回且已在白名单）强制选中置灰，不参与全选/全不选。
  const selectableIds = matched.filter(item => !existing.has(item.modelId)).map(item => item.modelId);
  const allSelected = selectableIds.length > 0
    && selectableIds.every(modelId => selectedModelIds.includes(modelId));

  if (matched.length + removed.length + unpriced.length === 0) return null;
  return <div className={styles.tableWrap}>
    <table className={styles.dataTable}>
      <thead><tr><th><input type="checkbox" aria-label={allSelected ? "全不选" : "全选"} checked={allSelected} onChange={event => onToggleAll(event.currentTarget.checked)} /></th><th>模型 ID</th><th>状态</th><th>非缓存输入 /M</th><th>缓存输入 /M</th><th>输出 /M</th><th>上下文窗口</th><th>最大输出 Token</th></tr></thead>
      <tbody>
        {matched.map(item => {
          const isExisting = existing.has(item.modelId);
          return <tr key={item.modelId}>
          <td><input type="checkbox" aria-label={isExisting ? `${item.modelId} 已存在（默认保留，不可取消）` : `选择模型 ${item.modelId}`} checked={isExisting || selectedModelIds.includes(item.modelId)} disabled={isExisting} onChange={event => onToggle(item.modelId, event.currentTarget.checked)} /></td>
          <td><strong>{item.modelId}</strong></td>
          <td>{added.has(item.modelId) ? "新增" : isExisting ? "已存在模型，移除请用行删除按钮" : "可加入"}</td>
          <td>{formatPrice(item.pricing?.input)}</td>
          <td>{formatPrice(item.pricing?.cachedInput)}</td>
          <td>{formatPrice(item.pricing?.output)}</td>
          <td>{formatTokens(item.contextWindow)}</td>
          <td>{formatTokens(item.maxOutput)}</td>
        </tr>;
        })}
        {removed.map(modelId => <tr key={`removed-${modelId}`}>
          <td><input type="checkbox" aria-label={`${modelId} 保留（本密钥未返回，确认时自动保留）`} checked disabled title="本密钥未返回该模型；确认时服务端会自动保留它，不参与本次勾选。如需移除请使用模型行的删除按钮" /></td>
          <td><strong>{modelId}</strong></td>
          <td>本密钥未返回，将保留 <small className={styles.modelHint}>（其他密钥添加 · 确认时自动保留 · 移除请用行删除按钮）</small></td>
          <td>—</td><td>—</td><td>—</td><td>—</td><td>—</td>
        </tr>)}
        {unpriced.map(item => <tr key={`unpriced-${item.modelId}`}>
          <td><input type="checkbox" aria-label={`模型 ${item.modelId} 不可选择`} disabled /></td>
          <td><strong>{item.modelId}</strong></td>
          <td>{unpricedReason(item.reason)}</td>
          <td>—</td><td>—</td><td>—</td><td>—</td><td>—</td>
        </tr>)}
      </tbody>
    </table>
  </div>;
}

function formatPrice(value: number | undefined): string {
  return value === undefined ? "—" : value.toLocaleString(undefined, {maximumFractionDigits: 6});
}

function formatTokens(value: number | undefined): string {
  return value === undefined ? "—" : value.toLocaleString();
}

function unpricedReason(reason: string): string {
  const labels: Record<string, string> = {
    unsupported_model_family: "暂不接受该模型家族",
    no_price_entry: "价格中心无匹配",
    ambiguous_price_entry: "价格映射不唯一",
    non_chat_mode: "非对话模型",
    price_missing: "价格不完整",
  };
  return labels[reason] || "不可加入";
}
