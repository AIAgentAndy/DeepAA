"use client";

import {useEffect, useMemo, useState} from "react";
import type {AgentId, TemporalPriceSchedule} from "@/types";
import type {ProviderCatalogReview as ProviderCatalogReviewData} from "@/lib/provider-catalog/service";
import {peakWindowText, scheduleFieldPriceText, scheduleHolidayText} from "@/lib/token-pricing-display";
import {useGlobalTimeZone} from "@/lib/timezone-preference";
import {agentLabel as registryAgentLabel} from "@/lib/agent-registry";
import styles from "./proxy-management.module.css";

interface ProviderCatalogReviewProps {
  review: ProviderCatalogReviewData;
  busy: boolean;
  /** 新建供应商确认预设模型时使用：只展示可选模型卡片，默认勾选目录首位推荐模型。 */
  createMode?: boolean;
  onCancel: () => void;
  /**
   * 存量目标刷新（2026-10-07 用户确认改造为「只加不减」表格交互）提交入口：
   * 入参是「本次勾选新增的模型 ID」——页面负责与目标白名单全集拼接后提交服务端，
   * 组件不感知白名单真相（避免 diff 截断导致漏拼误删）。新建模式不触发本回调。
   */
  onConfirm: (addedModelIds: string[], replacementDefaultModels: Partial<Record<AgentId, string>>) => Promise<void>;
  onSelectionChange?: (selectedModelIds: string[]) => void;
}

/**
 * 预设目录模型面板：
 * - 新建供应商（createMode）：卡片网格，默认仅勾选目录首位推荐模型，保存供应商时一次提交；
 * - 存量目标「刷新预设模型」：与「探测上游模型」同构的表格交互（2026-10-07 用户确认）——
 *   价格与模型能力由目录小时同步自动更新（价格中心唯一数据源，无「更新确认」一说），面板只做
 *   「把新模型加入白名单」一件事：已加入模型强制勾选不可取消（移除统一走模型列表行删除按钮）、
 *   新增模型默认不勾选由用户自行勾选、目录已移除模型仅提示保留。
 */
export function ProviderCatalogReview({review, busy, createMode = false, onCancel, onConfirm, onSelectionChange}: ProviderCatalogReviewProps) {
  if (createMode) {
    return <CreateModeReview review={review} busy={busy} onCancel={onCancel} onSelectionChange={onSelectionChange}/>;
  }
  return <AdditiveModeReview review={review} busy={busy} onCancel={onCancel} onConfirm={onConfirm}/>;
}

/** 新建预设：候选卡片网格 + 默认勾选目录首位推荐模型（2026-10-07 用户确认，取代默认全选）。 */
function CreateModeReview({review, busy, onCancel, onSelectionChange}: {
  review: ProviderCatalogReviewData;
  busy: boolean;
  onCancel: () => void;
  onSelectionChange?: (selectedModelIds: string[]) => void;
}) {
  // 可选集 = 有价格映射的候选（diff 条目的 selected 标志语义即 priced，见 diff.ts 的 item()）；
  // 新建草稿白名单为空，预设全部自动候选都落在 diff.added，目录首位即首位候选。
  const selectableIds = useMemo(() => [
    ...review.diff.added.filter(item => item.selected).map(item => item.id),
    ...review.diff.existing.filter(item => item.selected).map(item => item.id),
  ], [review]);
  // 默认仅勾选目录首位推荐模型（2026-10-07 用户确认，取代默认全选）：目录首位维护约定
  // = 官方主推模型，用户可在此加选。用户勾选只更新 selectedIds；只有切换预设或刷新目录
  // （review 更新 → defaultSelectedIds 引用变化）才重置回默认，不会覆盖用户主动勾选。
  const defaultSelectedIds = useMemo(() => selectableIds.slice(0, 1), [selectableIds]);
  const [selectedIds, setSelectedIds] = useState<string[]>(defaultSelectedIds);

  useEffect(() => {
    setSelectedIds(defaultSelectedIds);
  }, [defaultSelectedIds]);

  useEffect(() => {
    onSelectionChange?.(selectedIds);
  }, [onSelectionChange, selectedIds]);

  function toggleModel(modelId: string, checked: boolean) {
    setSelectedIds(current => checked ? [...new Set([...current, modelId])] : current.filter(item => item !== modelId));
  }

  return <section className={styles.catalogReview} aria-label="预设模型选择">
    <header className={styles.cardHeader}><div><h3>预设模型</h3><p>目录发布于 {review.publishedAt}。默认仅勾选目录首位推荐模型，可在此加选其余模型；点击新建供应商时一次写入价格中心和 Agent 可见模型。</p></div></header>
    <div className={styles.catalogModelGrid}>{review.models.map(model => <CatalogModelCard key={model.id} id={model.id} checked={selectedIds.includes(model.id)} disabled={!model.pricing} vendor={model.vendor} currency={model.currency ?? review.currency} pricing={model.pricing} priceSchedules={model.priceSchedules} planCreditRules={model.planCreditRules} contextWindowK={model.contextWindowK} maxOutputK={model.maxOutputK} supportedAgents={model.supportedAgents} supportedWireApis={model.supportedWireApis} inputModalities={model.inputModalities} sourceUrl={model.sourceUrl} notes={model.notes} onToggle={toggleModel} />)}</div>
    <footer className={styles.catalogReviewFooter}><span>候选 {review.candidateCount} 个，已处理 {review.processedCount} 个{review.limited ? "（结果受限）" : ""}</span><span>当前选择 {selectedIds.length} 个；保存供应商时自动提交</span></footer>
  </section>;
}

/**
 * 存量目标「刷新预设模型」：只加不减的表格交互（2026-10-07 用户确认，对齐「探测上游模型」）。
 * - 新增模型（目录有、白名单无）：默认不勾选，用户勾选后经底部「添加所选模型」提交；
 * - 已加入模型：强制勾选置灰（移除统一走下方模型列表行删除按钮）；
 * - 目录已移除模型：仅提示「白名单保留」，同样置灰；
 * - 价格/能力变化由目录小时同步自动落价格中心（wire-api-follow 自动跟随），无需任何确认。
 */
function AdditiveModeReview({review, busy, onCancel, onConfirm}: {
  review: ProviderCatalogReviewData;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (addedModelIds: string[], replacementDefaultModels: Partial<Record<AgentId, string>>) => Promise<void>;
}) {
  const added = review.diff.added;
  const [pendingIds, setPendingIds] = useState<string[]>([]);
  useEffect(() => {
    setPendingIds([]);
  }, [review]);
  const selectableIds = added.filter(item => item.priced).map(item => item.id);
  const allSelected = selectableIds.length > 0 && selectableIds.every(id => pendingIds.includes(id));
  const symbol = review.currency === "USD" ? "$" : review.currency === "CNY" ? "￥" : "";

  function toggleModel(modelId: string, checked: boolean) {
    setPendingIds(current => checked ? [...new Set([...current, modelId])] : current.filter(item => item !== modelId));
  }
  function toggleAll(checked: boolean) {
    setPendingIds(checked ? selectableIds : []);
  }

  return <section className={styles.catalogReview} aria-label="价格中心可添加模型">
    <header className={styles.cardHeader}><div><h3>可添加的预设模型</h3></div><button type="button" className={styles.iconButton} onClick={onCancel} aria-label="收起模型列表">×</button></header>
    {added.length === 0 && review.diff.existing.length === 0 && review.diff.removed.length === 0 ? <p className={styles.emptyCompact}>暂无模型数据。</p> : <div className={styles.tableWrap}><table className={styles.dataTable}><thead><tr><th><input type="checkbox" aria-label={allSelected ? "全不选" : "全选"} checked={allSelected} onChange={event => toggleAll(event.currentTarget.checked)} disabled={selectableIds.length === 0} /></th><th>模型 ID</th><th>状态</th><th>非缓存输入 /M</th><th>缓存输入 /M</th><th>输出 /M</th><th>上下文窗口</th><th>最大输出 Token</th></tr></thead><tbody>
      {added.map(item => <tr key={`added-${item.id}`}>
        <td><input type="checkbox" aria-label={`选择模型 ${item.id}`} checked={pendingIds.includes(item.id)} disabled={!item.priced || busy} onChange={event => toggleModel(item.id, event.currentTarget.checked)} /></td>
        <td><strong>{item.id}</strong></td>
        <td>{item.priced ? (item.supportedAgents && item.supportedAgents.length > 0 ? "可加入" : "当前无可用 Agent") : (item.warning || "缺少价格映射，暂不可加入")}</td>
        <td>{symbol}{formatPrice(item.pricing?.input)}</td>
        <td>{symbol}{formatPrice(item.pricing?.cachedInput)}</td>
        <td>{symbol}{formatPrice(item.pricing?.output)}</td>
        <td>{formatK(item.contextWindowK)}</td>
        <td>{formatK(item.maxOutputK)}</td>
      </tr>)}
      {review.diff.existing.map(item => <tr key={`existing-${item.id}`} title="已加入白名单；如需移除请使用下方模型列表的行删除按钮">
        <td><input type="checkbox" aria-label={`${item.id} 已加入（默认保留，不可取消）`} checked disabled /></td>
        <td><strong>{item.id}</strong></td>
        <td>{item.warning ? item.warning : "已加入，移除请用行删除按钮"}</td>
        <td>{symbol}{formatPrice(item.pricing?.input)}</td>
        <td>{symbol}{formatPrice(item.pricing?.cachedInput)}</td>
        <td>{symbol}{formatPrice(item.pricing?.output)}</td>
        <td>{formatK(item.contextWindowK)}</td>
        <td>{formatK(item.maxOutputK)}</td>
      </tr>)}
      {review.diff.removed.map(item => <tr key={`removed-${item.id}`} title="目录已移除该模型；白名单与价格中心条目默认保留。如需移除请使用下方模型列表的行删除按钮">
        <td><input type="checkbox" aria-label={`${item.id} 已加入（目录已移除，白名单保留）`} checked disabled /></td>
        <td><strong>{item.id}</strong></td>
        <td>目录已移除，白名单保留 <small className={styles.modelHint}>（移除请用行删除按钮）</small></td>
        <td>—</td><td>—</td><td>—</td><td>—</td><td>—</td>
      </tr>)}
    </tbody></table></div>}
    <footer className={styles.catalogReviewFooter}><span>候选 {review.candidateCount} 个，已处理 {review.processedCount} 个{review.limited ? "（结果受限）" : ""}</span><span className={styles.inlineActions}><button type="button" className={styles.secondaryButton} onClick={onCancel} disabled={busy}>收起</button><button type="button" className={styles.primaryButton} onClick={() => void onConfirm(pendingIds, {})} disabled={busy || pendingIds.length === 0}>添加所选模型（{pendingIds.length}）</button></span></footer>
  </section>;
}

interface CatalogModelCardProps {
  id: string;
  checked: boolean;
  disabled: boolean;
  vendor?: string;
  /** 价格币种（2026-09-28）：价格前缀 $ / ￥（cn 预设=CNY、global=USD）。 */
  currency?: "CNY" | "USD";
  pricing?: {input?: number; output?: number; cachedInput?: number};
  priceSchedules?: TemporalPriceSchedule[];
  planCreditRules?: ProviderCatalogReviewData["models"][number]["planCreditRules"];
  contextWindowK?: number;
  maxOutputK?: number;
  supportedAgents?: AgentId[];
  supportedWireApis?: string[];
  inputModalities?: string[];
  sourceUrl?: string;
  notes?: string;
  onToggle: (id: string, checked: boolean) => void;
}

function CatalogModelCard({id, checked, disabled, vendor, currency, pricing, priceSchedules, planCreditRules, contextWindowK, maxOutputK, supportedAgents, supportedWireApis, inputModalities, sourceUrl, notes, onToggle}: CatalogModelCardProps) {
  // 时段窗口按全站查看者时区展示（2026-09-30；缺省东八区）。
  const viewerTimeZone = useGlobalTimeZone().iana;
  const peakText = peakWindowText(priceSchedules, viewerTimeZone);
  const holidayText = scheduleHolidayText(priceSchedules);
  // 币种前缀（2026-09-28）：cn 预设 ￥、global 预设 $；目录行缺声明时不猜测，展示纯数值。
  const symbol = currency === "USD" ? "$" : currency === "CNY" ? "￥" : "";
  return <label className={styles.catalogModelCard}><div className={styles.catalogModelHeading}><input type="checkbox" disabled={disabled} checked={checked} onChange={event => onToggle(id, event.currentTarget.checked)} /><code>{id}</code><span>{supportedAgents ? supportedAgents.length > 0 ? `可用 Agent：${supportedAgents.map(agentLabel).join("、")}` : "当前无可用 Agent" : "目录已移除，可用 Agent 待确认"}</span></div><div className={styles.catalogModelBody}><dl className={styles.catalogModelMeta}><div><dt>价格中心供应商</dt><dd>{vendor || "—"}</dd></div><div><dt>协议能力</dt><dd>{supportedWireApis?.join("、") || "按供应商能力"}</dd></div><div><dt>输入模态</dt><dd>{inputModalities?.join("、") || "文本"}</dd></div><div><dt>非缓存输入</dt><dd>{symbol}{scheduleFieldPriceText(pricing, priceSchedules, "input") || formatPrice(pricing?.input)}</dd></div><div><dt>缓存输入</dt><dd>{symbol}{scheduleFieldPriceText(pricing, priceSchedules, "cachedInput") || formatPrice(pricing?.cachedInput)}</dd></div><div><dt>输出</dt><dd>{symbol}{scheduleFieldPriceText(pricing, priceSchedules, "output") || formatPrice(pricing?.output)}</dd></div><div><dt>上下文窗口</dt><dd>{formatTokens(contextWindowK)}</dd></div><div><dt>最大输出 Token</dt><dd>{formatTokens(maxOutputK)}</dd></div>{peakText ? <div><dt>时段费率</dt><dd>{peakText}</dd></div> : null}{holidayText ? <div><dt>节假日</dt><dd>{holidayText}</dd></div> : null}{planCreditRules ? <div><dt>套餐积分</dt><dd>{planCreditRules.formula}{planCreditRules.notes ? `（${planCreditRules.notes}）` : ""}</dd></div> : null}</dl>{sourceUrl || notes ? <small>{[sourceUrl ? `来源：${sourceUrl}` : "", notes || ""].filter(Boolean).join("；")}</small> : null}</div></label>;
}

function formatPrice(value: number | undefined): string {
  return value === undefined ? "—" : `${value}`;
}

function formatK(valueK: number | undefined): string {
  return valueK === undefined ? "—" : `${valueK.toLocaleString()}K`;
}

function formatTokens(valueK: number | undefined): string {
  return valueK === undefined ? "—" : `${valueK.toLocaleString()}K（${(valueK * 1024).toLocaleString()}）`;
}

function agentLabel(agent: AgentId): string {
  return registryAgentLabel(agent);
}
