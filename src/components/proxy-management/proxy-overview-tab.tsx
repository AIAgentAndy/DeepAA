import {AlertTriangle, CheckCircle2, CircleAlert, Gauge, RefreshCw, Save, Settings2, Trash2, WalletCards} from "lucide-react";
import {useEffect, useRef, useState} from "react";
import {AGENT_CATALOG, targetSupportsAgent} from "@/components/proxy-management/agent-catalog";
import {formatCredentialFingerprint} from "@/components/proxy-management/credential-format";
import {SecretRevealChip} from "./secret-reveal";
import type {CredentialItem, ProxySyncStatus} from "./proxy-management-types";
import {onboardingStepsForTarget} from "@/components/proxy-management/proxy-onboarding-wizard";
import {PROVIDER_PRESETS, derivePresetCurrency, resolveProviderAccountCapability} from "@/lib/provider-presets";
import {billingChannelLabel} from "@/lib/preset-family";
import {planProviderLabelFromPlugins} from "@/lib/provider-plugins/meta";
import {resolveOfficialPresetForTarget} from "@/lib/provider-preset-capabilities";
import {resolvePlanTierFee, type PlanBillingCycle} from "@/lib/provider-catalog/plan-tiers";
import {subscriptionLoginMissingNotice, subscriptionNetworkNotice, subscriptionReloginNotice} from "@/lib/subscription-display";
import {resolvePlanProviderForTarget} from "@/lib/sync-engine/plan-provider";
import {isRateUnconfirmed, rateWarningBadgeLabel, rateWarningTitle, resolveRateWarning} from "@/lib/sync-engine/rate-warning";
import {
  asDisplayCurrency,
  formatSettlementFxDisplay,
  parseSettlementFxInput,
  resolveDisplayFxRate,
  settlementFxInputHint,
} from "@/lib/settlement-fx";
import {formatCnyMoney, formatMoneyWithCnyEquivalent, formatOriginalMoney} from "@/lib/money-display";
import {planQuotaPercent, planQuotaRemainingPercent} from "@/lib/plan-quota-display";
import {useFxSnapshot} from "@/lib/fx-snapshot-client";
import {
  DEFAULT_SYNC_INTERVAL_MINUTES,
  SYNC_INTERVAL_MINUTES_CHOICES,
  type PlanProviderType,
  type SyncProviderType,
} from "@/lib/sync-engine/types";
import type {ProxyConfig, ProxyTarget} from "@/types";
import styles from "./proxy-management.module.css";

/** 付款周期下拉选项（2026-10-10 用户确认）：value 与目录档位 billingCycles 键一致。 */
const PLAN_BILLING_CYCLE_OPTIONS: ReadonlyArray<{value: PlanBillingCycle; label: string}> = [
  {value: "monthly", label: "按月"},
  {value: "quarterly", label: "按季"},
  {value: "yearly", label: "按年"},
];

interface ProxyOverviewTabProps {
  config: ProxyConfig;
  target: ProxyTarget;
  credentials: CredentialItem[];
  syncStatus?: ProxySyncStatus;
  /** 该供应商的同步配置是否已完成首次加载。未加载前账号/套餐卡片必须视为
   *  「未知」而非「未配置」，否则每次进入页面都会先闪现配置表单与引导文案
   *  （2026-09-16 用户确认修复）。 */
  syncStatusReady: boolean;
  busy: boolean;
  /** 打开分步引导向导（从第一个未完成步骤开始，不允许跨流程）。 */
  onStartOnboarding: () => void;
  /** 立即同步控制台数据。 */
  onRunSync: () => Promise<void>;
  /** 保存/修改控制台账号（保存后服务端立即执行首次同步，失败随错误提醒）。 */
  onSaveAccount: (input: {providerType: SyncProviderType; consoleBaseUrl: string; username: string; password: string; syncIntervalMinutes?: number}) => Promise<void>;
  /** 保存套餐同步；API Key 只能显式选择当前供应商已有密钥。 */
  onSavePlanConfig: (input: {
    providerType: PlanProviderType;
    credentialId?: string;
    accessKeyId?: string;
    secretAccessKey?: string;
    planMonthlyFee?: number;
    planTier?: string;
    /** 付款周期（2026-10-10）：与档位一起随月费落盘 pricing，随目录折算价联动。 */
    planBillingCycle?: PlanBillingCycle;
    syncIntervalMinutes?: number;
  }) => Promise<void>;
  /** 立即同步套餐时间窗。 */
  onRunPlanSync: () => Promise<void>;
  /** 删除当前代理供应商（二次确认由页面处理）。 */
  onDeleteTarget: () => void;
  /** 新建完成后的引导高亮：脉冲高亮「账号信息」或「套餐用量」卡片；lead 存在时额外在卡片底部
   *  展示专属提示文案（目前仅订阅通道），标准引导文案已内嵌到对应表单底部。 */
  highlight?: {kind: "account" | "plan"; lead?: string; emphasis?: string} | null;
  /** 接入配置（编辑/查看态）保存：直接 patch 当前供应商。 */
  onSaveTargetPatch: (patch: Partial<ProxyTarget>) => Promise<void>;
  /** 接入配置表单字段实时变化：只更新本地草稿态，不写盘、不调同步。 */
  onChangeSelectedTarget: (patch: Partial<ProxyTarget>) => void;
}

/** 表单内嵌引导文案：未完成对应保存操作前常驻展示在表单框内部左下，与右侧保存按钮同行；
 *  emphasis 为加深绿重点体现片段；warning 为整块红色强调（2026-09-05 用户确认）。 */
const ACCOUNT_FORM_GUIDE = {
  lead: "设置供应商的登录账号信息，以便系统能够按照设定周期，定时",
  emphasis: "自动获取最新余额及价格倍率相关信息，准确计算相关消耗数据",
  warning: "不设置也不影响网关转发，但会影响金额消耗准确性统计，强烈建议设置！",
} as const;
const PLAN_FORM_GUIDE = {
  lead: "设置供应商的套餐/Plan信息，以便系统能够按照设定周期，定时",
  emphasis: "自动获取最新套餐用量相关信息，准确计算相关消耗数据",
  warning: "不设置也不影响网关转发，但会影响金额消耗准确性统计，强烈建议设置！",
} as const;

/** 表单底部行：左侧引导文案（仅未完成保存操作时展示）+ 右侧「暂不设置」弱化链接与保存按钮。 */
function FormFooterRow({guide, saveLabel, disabled, onDismiss}: {guide?: {lead: string; emphasis: string; warning?: string}; saveLabel: string; disabled?: boolean; onDismiss?: () => void}) {
  return (
    <div className={styles.formFooterRow}>
      {guide ? (
        <p className={styles.formFooterHint}>
          <span className={styles.formFooterWarning}>{guide.lead}<strong>{guide.emphasis}</strong>。</span>
          {guide.warning ? <span className={styles.formFooterWarning}> - {guide.warning}</span> : null}
        </p>
      ) : null}
      {onDismiss ? <button type="button" className={styles.dismissLink} onClick={onDismiss}>暂不设置</button> : null}
      <button type="submit" className={styles.primaryButton} disabled={disabled}>{saveLabel}</button>
    </div>
  );
}

interface ChecklistItem {
  key: string;
  label: string;
  ok: boolean;
  reason: string;
  /** 前序步骤未完成时该项置灰，不允许跨流程。 */
  blocked: boolean;
}

/** 按最新向导流程生成的检查清单：官方预设与自定义供应商分别镜像各自步骤顺序。 */
function buildChecklist(config: ProxyConfig, target: ProxyTarget, targetCredentials: CredentialItem[]): ChecklistItem[] {
  // 「接入 Agent」= 任一有效接入的 Agent（默认代理供应商已选择且存在）把当前供应商接入：
  // 协议、模型适用、密钥适用齐全即视为已接入（不要求当前供应商被设为默认）。
  const agentConnected = AGENT_CATALOG.some(entry => {
    const connection = config.agentConnections[entry.id];
    if (!connection?.defaultTargetId || !config.targets.some(item => item.id === connection.defaultTargetId)) return false;
    return targetSupportsAgent(target, entry.id, targetCredentials, {requireEnabled: false});
  });
  // 官方预设创建时模型已由目录写入，无「模型发现与确认」步骤；自定义供应商才有。
  const officialPreset = Boolean(resolveOfficialPresetForTarget(target));
  const items: Array<Omit<ChecklistItem, "blocked">> = [];
  if (!officialPreset) {
    items.push({
      key: "models",
      label: "模型发现与确认",
      ok: target.supportedModels.length > 0,
      reason: "当前还没有支持的模型",
    });
  }
  items.push({
    key: "credentials",
    label: "设置 API 密钥",
    ok: target.billingChannel === "subscription" || targetCredentials.length > 0,
    reason: target.billingChannel === "subscription" ? "订阅通道无需系统密钥（推理凭据由本机 CLI 登录透传）" : "当前供应商还没有系统密钥",
  });
  items.push({
    key: "enable",
    label: "启用供应商",
    ok: target.enabled,
    reason: "供应商当前处于停用状态",
  });
  // 接入 Agent 是向导最后一步（完成时自动启用），放在清单末尾。
  items.push({
    key: "agent",
    label: "接入 Agent（选择可用 Agent）",
    ok: agentConnected && target.enabled,
    reason: agentConnected ? "供应商未启用" : "尚未选择任何 Agent 使用此供应商",
  });
  return items.map((item, index) => ({
    ...item,
    blocked: index > 0 && !items.slice(0, index).every(prev => prev.ok),
  }));
}

export function ProxyOverviewTab({config, target, credentials, syncStatus, syncStatusReady, busy, onStartOnboarding, onRunSync, onSaveAccount, onSavePlanConfig, onRunPlanSync, onDeleteTarget, highlight, onChangeSelectedTarget, onSaveTargetPatch}: ProxyOverviewTabProps) {
  const [editingAccount, setEditingAccount] = useState(false);
  // 「暂不设置」收起态：仅未配置账号期间有效；一旦保存过账号即永久失效，行为与一直展开一致。
  const [accountDismissed, setAccountDismissed] = useState(false);
  // 接入配置进入时拍一份 target 快照；任何字段未变 → 确认修改置灰。
  // target.id 是身份键，切换供应商时重置 baseline；onSaveTargetPatch 成功持久化后也重置。
  const baselineRef = useRef<{id: string; snapshot: ConnectionConfigBaseline}>({id: "", snapshot: {name: "", openaiUrl: "", anthropicUrl: ""}});
  if (baselineRef.current.id !== target.id) {
    baselineRef.current = {id: target.id, snapshot: snapshotConnectionConfig(target)};
  }
  const dirty = hasConnectionConfigChanges(baselineRef.current.snapshot, target);
  const [accountDraft, setAccountDraft] = useState({providerType: (syncStatus?.account?.providerType || defaultProviderType(target)) as SyncProviderType, consoleBaseUrl: syncStatus?.account?.consoleBaseUrl || defaultConsoleUrl(target), username: syncStatus?.account?.username || "", password: "", syncIntervalMinutes: syncStatus?.account?.syncIntervalMinutes ?? DEFAULT_SYNC_INTERVAL_MINUTES});
  const [accountError, setAccountError] = useState("");
  const [editingPlan, setEditingPlan] = useState(false);
  // 「暂不设置」收起态：仅未配置套餐同步期间有效；一旦保存过套餐即永久失效，行为与一直展开一致。
  const [planDismissed, setPlanDismissed] = useState(false);
  const [planError, setPlanError] = useState("");
  // 结算系数编辑态：仅自定义中转站目标展示（官方预设按目录规则派生，无需手动覆盖）。
  const [editingSettlement, setEditingSettlement] = useState(false);
  const [settlementError, setSettlementError] = useState("");
  const [settlementDraft, setSettlementDraft] = useState(() => target.pricing?.settlementFx === undefined ? "" : String(target.pricing.settlementFx));
  // 套餐同步密钥默认选中当前供应商第一条已填密钥，避免用户再次下拉选择。
  const firstTargetCredentialId = credentials.filter(item => item.targetId === target.id)[0]?.id || "";
  const [planDraft, setPlanDraft] = useState(() => ({
    providerType: (syncStatus?.plan.config?.providerType || resolvePlanProviderForTarget(target) || "kimi-coding") as PlanProviderType,
    credentialId: syncStatus?.plan.config?.credentialId || firstTargetCredentialId,
    accessKeyId: "",
    secretAccessKey: "",
    planMonthlyFee: target.pricing?.planMonthlyFee === undefined
      ? ""
      : String(target.pricing.planMonthlyFee),
    // OpenCode Go 档位必选（上游 usage 不返回档位标识，2026-09-30）：默认 go。
    // 其它供应商（2026-10-10 档位+周期下拉）：默认不选，由用户显式确认。
    planTier: target.pricing?.planTier
      || ((syncStatus?.plan.config?.providerType || resolvePlanProviderForTarget(target)) === "opencode-go" ? "go" : ""),
    planBillingCycle: target.pricing?.planBillingCycle || "",
    syncIntervalMinutes: syncStatus?.plan.config?.syncIntervalMinutes ?? DEFAULT_SYNC_INTERVAL_MINUTES,
  }));
  // 月费手动改写标记（2026-10-10）：档位/周期联动只在未手动改写时自动填价。
  const [planFeeTouched, setPlanFeeTouched] = useState(false);
  const hasProtocol = Boolean(target.openaiUrl || target.anthropicUrl);
  const hasModels = target.supportedModels.length > 0;
  const targetCredentials = credentials.filter(item => item.targetId === target.id);
  const checklist = buildChecklist(config, target, targetCredentials);
  const account = syncStatus?.account;
  const planConfig = syncStatus?.plan.config;
  const planProvider = resolvePlanProviderForTarget(target);
  const planQuota = syncStatus?.plan.quota.items || [];
  // 账号（余额/倍率）与套餐（用量）周期各自独立展示；未配置时展示新保存默认值。
  const accountIntervalMinutes = account?.syncIntervalMinutes ?? DEFAULT_SYNC_INTERVAL_MINUTES;
  const planIntervalMinutes = planConfig?.syncIntervalMinutes ?? DEFAULT_SYNC_INTERVAL_MINUTES;
  // 文案展示值：表单展开（未配置或编辑中）时跟随「同步周期」当前选择实时变化，
  // 表单收起且已配置时展示已保存周期，避免挂载时序导致旧值闪烁。
  const accountIntervalDisplay = !account || editingAccount ? accountDraft.syncIntervalMinutes : accountIntervalMinutes;
  const planIntervalDisplay = !planConfig || editingPlan ? planDraft.syncIntervalMinutes : planIntervalMinutes;
  // 引导高亮只在「尚未设置」时持续显示：账号信息未配置 → 高亮账号；套餐同步未配置 → 高亮套餐；
  // 一旦配置完成即自动消失，不会常驻打扰。
  const accountHighlight = highlight?.kind === "account" && !account ? highlight : null;
  const planHighlight = highlight?.kind === "plan" && !planConfig ? highlight : null;
  /** 中转站一经识别底层类型后不可更换；存量 sub2api/newapi 账号同样锁定。 */
  const accountRelayLocked = Boolean(account && isRelayProviderType(account.providerType));
  /** 编辑表单里的中转站选项文案：已识别时直接展示具体底层类型。 */
  const relayDraftLabel = account && isRelayProviderType(account.providerType)
    ? relayProviderLabel(account.providerType, account.resolvedProvider)
    : "中转站（基于Sub2API或NEW API）";
  /** 官方预设只有能通过 API Key 查询余额/身份时才展示账号信息；无余额供应商整卡隐藏。 */
  const targetPreset = resolveOfficialPresetForTarget(target);
  /* 档位选项来自目录（planTiers，如 OpenCode Go go $10 / go-plus $40、智谱 Lite/Pro/Max）；
     有预设即拉取一次（2026-10-10 放宽：档位+周期下拉不再限 opencode-go），无档位的供应商
     响应不含 planTiers、状态保持空即不渲染下拉；目录不可达时 opencode-go 回退手填 id 输入。 */
  const [planTierOptions, setPlanTierOptions] = useState<Array<{id: string; name: string; monthlyFee: number; billingCycles?: {monthly: number; quarterly?: number; yearly?: number}}>>([]);
  const planPresetId = targetPreset?.id;
  useEffect(() => {
    if (planTierOptions.length > 0) return;
    if (!planPresetId) return;
    let cancelled = false;
    void fetch(`/api/provider-catalog?preset=${encodeURIComponent(planPresetId)}`, {cache: "no-store"})
      .then(response => response.ok ? response.json() : undefined)
      .then((body: {planTiers?: Array<{id: string; name: string; monthlyFee: number; billingCycles?: {monthly: number; quarterly?: number; yearly?: number}}>} | undefined) => {
        if (!cancelled && body?.planTiers?.length) setPlanTierOptions(body.planTiers);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [planTierOptions.length, planPresetId]);
  /** 「套餐档位 + 付款周期」下拉（2026-10-10 用户确认）：目录多档位且含付款周期折算价
   *  的供应商展示（智谱/Kimi/MiniMax/Qwen 等）；单选、必选、默认不选，保存必须显式确认。
   *  OpenCode Go 无周期概念，维持原档位 radio；无档位供应商月费保持手填。 */
  const tierCycleSelectsEnabled = planDraft.providerType !== "opencode-go"
    && planTierOptions.length >= 2
    && planTierOptions.some(tier => tier.billingCycles);
  const selectedPlanTierOption = planTierOptions.find(tier => tier.id === planDraft.planTier);
  /** 周期选项按所选档位实际维护的折算价过滤（未选档位时展示全部周期）。 */
  const planCycleOptions = PLAN_BILLING_CYCLE_OPTIONS.filter(option =>
    selectedPlanTierOption?.billingCycles
      ? selectedPlanTierOption.billingCycles[option.value] !== undefined
      : true);
  /** 档位+周期联动目录折算月价：齐选且月费未被手动改写时填入（保留两位小数）。 */
  function tierCycleFee(tierId: string, cycle: string): number | undefined {
    if (!tierId || !cycle || planFeeTouched) return undefined;
    const tier = planTierOptions.find(item => item.id === tierId);
    if (!tier) return undefined;
    const fee = resolvePlanTierFee(tier, cycle as PlanBillingCycle);
    return Number.isFinite(fee) ? Math.round(fee * 100) / 100 : undefined;
  }
  const accountSyncSupported = !targetPreset || targetPreset.accountSync?.balance === "supported";
  /* 币种展示上下文（2026-09-28；2026-10-06 与入账级联对齐）：余额/月费/美元额度按
     「原值（约￥等值）」展示，按各金额自身币种解析——官方预设（任意目录币种）非人民币
     用目录 fx 快照、自定义中转站用目标 settlementFx。 */
  const fxSnapshot = useFxSnapshot();
  const displayFxFor = (currency: string | undefined | null) => resolveDisplayFxRate({
    amountCurrency: asDisplayCurrency(currency),
    presetCurrency: derivePresetCurrency(targetPreset),
    settlementFx: target.pricing?.settlementFx,
    fxUsdCny: fxSnapshot?.rate,
  });
  /** 月费币种：显式 settlementCurrency 优先，缺失按预设目录币种兜底，自定义目标缺省 CNY。 */
  const planFeeCurrency = target.pricing?.settlementCurrency ?? derivePresetCurrency(targetPreset) ?? "CNY";
  /** 套餐适配器只允许供应商匹配项；历史配置保留原值以便展示与删除，不允许改存不匹配项。 */
  const planProviderOptions = (): PlanProviderType[] => [...new Set([
    ...(planConfig ? [planConfig.providerType] : []),
    ...(planProvider ? [planProvider] : []),
  ])];
  useEffect(() => {
    if (!planConfig) return;
    setPlanDraft(current => ({
      ...current,
      providerType: planConfig.providerType,
      // 保留已选密钥（含默认第一条）；volcengine/订阅通道无 credentialId 时不覆盖。
      credentialId: planConfig.credentialId || current.credentialId,
      planMonthlyFee: target.pricing?.planMonthlyFee === undefined
        ? ""
        : String(target.pricing.planMonthlyFee),
      // 档位/周期回填已保存值（opencode-go 档位、其它供应商档位+周期）；未保存时保持草稿当前值。
      planTier: target.pricing?.planTier || current.planTier,
      planBillingCycle: target.pricing?.planBillingCycle || current.planBillingCycle,
      syncIntervalMinutes: planConfig.syncIntervalMinutes,
    }));
  }, [planConfig, target.pricing?.planMonthlyFee, target.pricing?.planTier, target.pricing?.planBillingCycle]);
  // 密钥列表是异步加载的：加载完成/变化后回填默认选中，目标有密钥而套餐密钥
  // 未选或已失效时自动选第一条，免去用户再手动下拉；已保存过的套餐密钥优先。
  const targetCredentialIdKey = targetCredentials.map(item => item.id).join("|");
  useEffect(() => {
    setPlanDraft(current => current.credentialId && targetCredentials.some(item => item.id === current.credentialId)
      ? current
      : {...current, credentialId: targetCredentials[0]?.id || ""});
    // targetCredentials 每次渲染都是新数组，用稳定拼接键作依赖。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetCredentialIdKey]);
  return (
    <div className={styles.tabStack}>
      {/* 账号信息：能查询余额/身份的供应商展示；无余额官方预设隐藏，存量账号仅保留清理入口。 */}
      {(accountSyncSupported || account) ? <section className={`${styles.card} ${accountHighlight ? styles.cardHighlight : ""}`}>
        <header className={styles.cardHeader}><div><h3><WalletCards size={17} /> 账号信息</h3><p>约每 {accountIntervalDisplay} 分钟自动同步一次；控制台数据只影响计费统计，不影响代理可用性。</p></div><div className={styles.inlineActions}>{accountSyncSupported && !account && accountDismissed ? <button type="button" className={styles.secondaryButton} onClick={() => setAccountDismissed(false)}>展开设置</button> : null}{accountSyncSupported && account ? <button type="button" className={styles.secondaryButton} onClick={() => {
            // 点「修改账号」时把已保存的账号信息回填进表单（密码除外），避免初始加载时序导致字段为空。
            setAccountDraft({
              providerType: account.providerType as SyncProviderType,
              consoleBaseUrl: account.consoleBaseUrl || defaultConsoleUrl(target),
              username: account.username || "",
              password: "",
              syncIntervalMinutes: account.syncIntervalMinutes,
            });
            setEditingAccount(value => !value);
          }}><Settings2 size={16} /> 修改账号</button> : null}{accountSyncSupported ? <button type="button" className={styles.primaryButton} disabled={busy || !account} onClick={() => void onRunSync()}><RefreshCw size={16} /> 立即同步</button> : null}</div></header>
        {/* 同步状态未加载完成前展示占位，避免先渲染「未配置」摘要再闪烁为真实值。 */}
        {!syncStatusReady && !account ? <p className={styles.emptyCompact}>正在加载账号同步配置…</p> : <>
        <dl className={styles.accountSummary}>
          {/* 官方预设：账号展示用预设名（带通道），不再显示「中转站」等历史错误标签。 */}
          <div><dt>控制台账号</dt><dd>{account ? `${accountProviderLabel(account.providerType, account.resolvedProvider, targetPreset)} · ${account.username}` : "未配置"}</dd></div>
          <div><dt>最近余额</dt><dd>{syncStatus?.balance ? formatMoneyWithCnyEquivalent(syncStatus.balance.amount, syncStatus.balance.currency, displayFxFor(syncStatus.balance.currency)) : "暂无"}</dd></div>
          <div><dt>最近同步</dt><dd>{account?.lastSyncAt ? formatRelativeTime(account.lastSyncAt) : "尚未同步"}</dd></div>
          <div><dt>下次同步</dt><dd>{account?.nextSyncAt ? `${formatRelativeFuture(account.nextSyncAt)}后` : "—"}</dd></div>
          <div><dt>同步状态</dt><dd><span className={`${styles.badge} ${account?.status === "ok" ? styles.badgeReady : account?.status === "auth_required" ? styles.badgePending : account ? styles.badgePending : styles.badge}`}>{account?.status === "ok" ? "正常" : account?.status === "auth_required" ? "需要重新登录" : account?.status === "failed" ? "同步失败" : account ? "待同步" : "未配置"}</span></dd></div>
        </dl>
        </>}
      {!accountSyncSupported ? <p className={styles.syncWarning} role="status">该供应商暂无公开余额接口，余额请在官方控制台查看；如该供应商匹配套餐适配器，可在下方「套餐用量」模块同步。</p> : null}
      {/* 表单只在「已确认未配置」（加载完成且无账号）或用户主动编辑时出现；加载中不闪表单。 */}
      {accountSyncSupported && (account ? editingAccount : (!accountDismissed && syncStatusReady)) ? <form className={styles.inlineForm} onSubmit={event => {event.preventDefault(); setAccountError(""); void onSaveAccount(accountDraft).then(() => setEditingAccount(false)).catch(error => setAccountError(error instanceof Error ? error.message : "保存失败"));}}>
        <label className={styles.field}><span>站点类型</span><select value={accountDraft.providerType} onChange={event => setAccountDraft({...accountDraft, providerType: event.currentTarget.value as SyncProviderType})} disabled={accountRelayLocked}><option value="relay">{relayDraftLabel}</option>{account && isRelayProviderType(account.providerType) ? <option value={account.providerType} style={{display: "none"}}>{relayProviderLabel(account.providerType, account.resolvedProvider)}</option> : null}<option value="openai">OpenAI（官方）</option><option value="anthropic">Anthropic（官方）</option><option value="deepseek">DeepSeek（官方）</option><option value="zhipu">智谱（官方）</option><option value="kimi-coding">Kimi / Moonshot（官方）</option><option value="minimax">MiniMax（官方）</option><option value="volcengine-plan">火山方舟（Coding Plan）</option><option value="openrouter">OpenRouter</option><option value="siliconflow">SiliconFlow（硅基流动）</option><option value="qwenai">千问 AI</option><option value="tencent-hunyuan">腾讯混元</option><option value="opencode-go">OpenCode Go</option><option value="manual">手动</option></select></label>
        <label className={styles.field}><span>控制台地址</span><input type="url" required value={accountDraft.consoleBaseUrl} onChange={event => setAccountDraft({...accountDraft, consoleBaseUrl: event.currentTarget.value})} /></label>
        <label className={styles.field}><span>用户名或邮箱</span><input value={accountDraft.username} onChange={event => setAccountDraft({...accountDraft, username: event.currentTarget.value})} /></label>
        <label className={`${styles.field} ${styles.fieldSecret}`}><span>密码 / 会话凭据</span><input type="password" value={accountDraft.password} onChange={event => setAccountDraft({...accountDraft, password: event.currentTarget.value})} placeholder={account ? "留空保持原值" : "必填"} /><SecretRevealChip kind="console" targetId={target.id} masked={syncStatus?.account?.credentialMasked} label="复制控制台密码/会话凭据" /></label>
        <label className={styles.field}><span>同步周期</span><select value={accountDraft.syncIntervalMinutes} onChange={event => setAccountDraft({...accountDraft, syncIntervalMinutes: Number(event.currentTarget.value)})}>{SYNC_INTERVAL_MINUTES_CHOICES.map(minutes => <option key={minutes} value={minutes}>{minutes}分钟</option>)}</select></label>
        {/* 未完成「保存账号并开启同步」前（无论首次还是再次进入），引导文案常驻表单内部左下，与保存按钮同行；完成后编辑时不重复展示。
            「暂不设置」仅未配置期间出现：点击收起表单，可随时从头部「展开设置」再次进入。 */}
        <FormFooterRow guide={account ? undefined : ACCOUNT_FORM_GUIDE} saveLabel="保存账号并开启同步" onDismiss={account ? undefined : () => setAccountDismissed(true)} />
        {/* 提示统一放整行，避免挂在字段内部把该字段撑高、与同排输入框错位。 */}
        {accountRelayLocked ? <small className={styles.formNote}>{account?.resolvedProvider ? `已识别为${relayProviderLabel("relay", account.resolvedProvider)}，站点类型不可修改。` : "首次同步自动识别 Sub2API / New API，站点类型不可修改。"}</small> : null}
        {accountError ? <p className={styles.errorText} role="alert">{accountError}</p> : null}
      </form> : null}
        {accountSyncSupported && resolveProviderAccountCapability(accountDraft.providerType)?.balance === "unsupported" ? <p className={styles.syncWarning} role="status">当前所选站点类型暂无公开余额接口，余额请在官方控制台查看；如该供应商匹配套餐适配器，可在下方「套餐用量」模块同步。</p> : null}
        {accountHighlight?.lead ? <p className={styles.highlightMessage} role="status">{accountHighlight.lead}{accountHighlight.emphasis ? <strong className={styles.highlightEmphasis}>{accountHighlight.emphasis}</strong> : null}。</p> : null}
        {/* 密钥同步：只对中转站/自定义供应商展示，并入账号信息同一框；
            官方预设密钥只是单条 API Key，没有远程价格倍率概念。 */}
        {!targetPreset ? <section className={styles.credentialSyncSection}>
          <p className={styles.credentialSyncNote}>每{accountIntervalDisplay}分钟自动同步供应商站对应密钥分组的价格倍率信息，密钥名称和内容请移步至「密钥与模型」维护。</p>
          {targetCredentials.length === 0 ? <p className={styles.emptyCompact}>尚未配置系统密钥。先在「密钥与模型」新增密钥，同步后这里展示每条密钥的匹配结果。</p> : <div className={styles.credentialList}>{targetCredentials.map(credential => {
            const comparison = syncStatus?.credentialComparison?.find(item => item.credentialId === credential.id);
            // 远端匹配成功但没返回有效倍率：黄标提醒去站点确认，绝不改动任何关联（2026-09-18 用户决策）。
            const rateUnconfirmed = Boolean(comparison && isRateUnconfirmed(comparison));
            // 同步本身没跑起来（无账号 / 状态非 ok）时，同一处提醒升到黄红（severe）。
            const rateWarning = resolveRateWarning({
              unconfirmedCount: rateUnconfirmed ? 1 : 0,
              unconfirmedLabels: rateUnconfirmed ? [credential.label] : [],
              hasConsoleAccount: Boolean(account),
              accountStatus: syncStatus?.account?.status ?? null,
              usesGroupRates: !targetPreset,
              // 密钥行只播报本条密钥的远端对比结果；配置缺口由上方账号卡片负责提醒。
              includeConfigurationGaps: false,
            });
            const severe = rateUnconfirmed && rateWarning.severity === "severe";
            const badgeClass = !comparison ? styles.badge : rateUnconfirmed ? styles.badgePending : comparison.matched ? styles.badgeReady : styles.badgePending;
            const badgeLabel = !comparison ? "待同步" : rateUnconfirmed ? rateWarningBadgeLabel(rateWarning) : comparison.matched ? "同步成功" : "同步失败";
            const badgeTitle = rateUnconfirmed ? rateWarningTitle(rateWarning, credential.label) : undefined;
            return <article className={styles.credentialRow} key={credential.id}><div><strong>{credential.label}{rateUnconfirmed ? <span className={`${styles.rateWarningBadge} ${severe ? styles.rateWarningBadgeSevere : ""}`} title={badgeTitle}><AlertTriangle size={11} aria-hidden="true" />{rateWarningBadgeLabel(rateWarning)}</span> : null}</strong><span>密钥指纹 {formatCredentialFingerprint(credential.fingerprintSuffix)}</span><small>价格倍率 {credential.rateMultiplier ?? 1}{comparison ? (comparison.matched ? (comparison.ratio !== undefined ? ` · 同步匹配成功，远程倍率 ${comparison.ratio}` : " · ⚠️ 远端未返回有效倍率，请到站点确认实际倍率") + (comparison.remoteName ? ` · 远程名称：${comparison.remoteName}` : "") : ` · 同步匹配失败：${comparison.reason || "对方网站未找到匹配密钥"}`) : " · 尚未同步匹配"}</small></div><span className={`${styles.badge} ${badgeClass}`} title={badgeTitle}>{badgeLabel}</span></article>;
          })}</div>}
        </section> : null}
      </section> : null}

      {/* 结算设置：仅自定义中转站目标展示。中转站普遍按「美元牌价数字 × 倍率 = 人民币」
          1:1 结算（new-api/sub2api 源码调研结论），默认 fx=1 即正确口径；按真实美元汇率
          或特殊折算（如 ×1/16）结算的站点在此显式覆盖。官方预设按目录规则
          （CNY=1 / 全球官方=价格版本汇率）派生。输入支持「几比几」比值（1:16 = 乘 1/16）
          与小数（0.0625），存储仍为单一乘数。 */}
      {!targetPreset ? <section className={styles.card}>
        <header className={styles.cardHeader}>
          <div>
            <h3><CircleAlert size={17} /> 结算设置</h3>
            <p>该站点的价格牌价数字与人民币的换算关系，入账时按此系数折算金额。支持比值（如 1:16 表示牌价 × 1/16 记人民币）或小数。</p>
          </div>
          <div className={styles.inlineActions}>
            <button type="button" className={styles.secondaryButton} onClick={() => {
              setSettlementDraft(target.pricing?.settlementFx === undefined ? "" : String(target.pricing.settlementFx));
              setSettlementError("");
              setEditingSettlement(value => !value);
            }}><Settings2 size={16} /> 修改系数</button>
          </div>
        </header>
        <dl className={styles.accountSummary}>
          <div><dt>结算系数（牌价数字 → 人民币）</dt><dd>{formatSettlementFxDisplay(target.pricing?.settlementFx)}</dd></div>
          <div><dt>计价币种口径</dt><dd>USD 牌价记账（中转站惯例）</dd></div>
        </dl>
        {editingSettlement ? <form className={styles.inlineForm} onSubmit={event => {
          event.preventDefault();
          setSettlementError("");
          const trimmed = settlementDraft.trim();
          if (trimmed !== "" && parseSettlementFxInput(trimmed) === undefined) {
            setSettlementError("结算系数必须是大于 0 的数字或比值（如 1:16、0.0625）");
            return;
          }
          void onSaveTargetPatch({pricing: {...target.pricing, settlementFx: trimmed === "" ? undefined : parseSettlementFxInput(trimmed)}}).then(() => setEditingSettlement(false)).catch(error => setSettlementError(error instanceof Error ? error.message : "保存失败"));
        }}>
          <label className={styles.field}>
            <span>结算系数</span>
            <input
              type="text"
              inputMode="text"
              value={settlementDraft}
              onChange={event => setSettlementDraft(event.currentTarget.value)}
              placeholder="如 1:16 或 0.0625；留空 = 默认 1:1"
            />
            {settlementDraft.trim() !== "" && parseSettlementFxInput(settlementDraft) !== undefined ? (
              <small>{settlementFxInputHint(parseSettlementFxInput(settlementDraft))}</small>
            ) : null}
          </label>
          <FormFooterRow saveLabel="保存结算系数" />
          {settlementError ? <p className={styles.errorText} role="alert">{settlementError}</p> : null}
        </form> : null}
      </section> : null}

      {/* 套餐用量：只对声明 planSync 适配器的供应商展示；与控制台账号同步独立。 */}
      {planProvider || planConfig ? <section className={`${styles.card} ${planHighlight ? styles.cardHighlight : ""}`}>
        <header className={styles.cardHeader}>
          <div className={styles.cardHeaderMain}>
            <h3><Gauge size={17} /> 套餐用量</h3>
            {/* 智谱官方预设套餐常驻直连观测说明（2026-10-10 用户确认）：紧随标题下方，
                不限是否已接入 ZCode；列宽收敛在右侧操作区之前，接近「修改套餐」即自然换行。 */}
            {target.presetId === "zhipu-coding-plan" ? <p className={styles.planDirectObserveNote}>官方直连观测：为了享用官方 ZCode 的专有积分折扣（打折67%），使用 ZCode 工作时，请选择 ZCode 官方自带模型即可。该部分请求不经过本网关，由 DeepAA 直连观测机制自动导入并派生账单及相关链路数据（原因是：ZCode 客户端签名机制限制，经网关流量不享受ZCode专有折扣）。</p> : null}
          </div>
          <div className={styles.inlineActions}>
            {!planConfig && planDismissed ? <button type="button" className={styles.secondaryButton} onClick={() => setPlanDismissed(false)}>展开设置</button> : null}
            {planConfig ? <button type="button" className={styles.secondaryButton} onClick={() => setEditingPlan(value => !value)}><Settings2 size={16} /> 修改套餐</button> : null}
            <button type="button" className={styles.primaryButton} disabled={busy || !planConfig} onClick={() => void onRunPlanSync()}><RefreshCw size={16} /> 同步套餐</button>
          </div>
        </header>

        {planConfig ? <dl className={styles.accountSummary}>
          <div><dt>套餐适配器</dt><dd>{planProviderLabel(planConfig.providerType)}</dd></div>
          {target.pricing?.planTier ? <div><dt>套餐档位</dt><dd>{planTierOptions.find(tier => tier.id === target.pricing?.planTier)?.name ?? target.pricing.planTier}</dd></div> : null}
          {target.pricing?.planBillingCycle ? <div><dt>付款周期</dt><dd>{PLAN_BILLING_CYCLE_OPTIONS.find(option => option.value === target.pricing?.planBillingCycle)?.label ?? target.pricing.planBillingCycle}</dd></div> : null}
          <div><dt>套餐同步密钥</dt><dd>{planConfig.providerType === "openai-subscription" || planConfig.providerType === "anthropic-subscription" ? "自动读取本机 CLI 登录凭据（只读）" : planConfig.credentialId ? targetCredentials.find(item => item.id === planConfig.credentialId)?.label || "密钥已移除" : planConfig.hasAccessKey && planConfig.hasSecretKey ? "火山 AK/SK 已保护保存" : "未配置"}</dd></div>
          <div><dt>套餐月费</dt><dd>{target.pricing?.planMonthlyFee === undefined ? "未录入" : formatMoneyWithCnyEquivalent(target.pricing.planMonthlyFee, planFeeCurrency, displayFxFor(planFeeCurrency))}</dd></div>
          <div><dt>最近同步</dt><dd>{planConfig.lastSyncAt ? formatRelativeTime(planConfig.lastSyncAt) : "尚未同步"}</dd></div>
          <div><dt>同步状态</dt><dd><span className={`${styles.badge} ${planConfig.status === "ok" ? styles.badgeReady : styles.badgePending}`}>{planConfig.status === "ok" ? "正常" : planConfig.status === "auth_required" ? "凭据失效" : planConfig.status === "failed" ? "同步失败" : "待同步"}</span></dd></div>
        </dl> : null}

        {/* 同步状态未加载完成前展示占位：此前把「未加载」当「未配置」，每次进入页面
            都先闪现配置表单与红色引导文案，1~2 秒后才变为已保存摘要（2026-09-16 修复）。 */}
        {!planConfig && !syncStatusReady ? <p className={styles.emptyCompact}>正在加载套餐同步配置…</p> : null}

        {(!planConfig ? !planDismissed && syncStatusReady : editingPlan) ? <form className={styles.planForm} onSubmit={event => {
          event.preventDefault();
          setPlanError("");
          const monthlyFee = planDraft.planMonthlyFee.trim() === ""
            ? undefined
            : Number(planDraft.planMonthlyFee);
          if (monthlyFee !== undefined && (!Number.isFinite(monthlyFee) || monthlyFee < 0)) {
            setPlanError("套餐月费必须是大于等于 0 的数字");
            return;
          }
          if (planDraft.providerType !== "volcengine-plan"
            && planDraft.providerType !== "volcengine-coding-plan"
            && planDraft.providerType !== "openai-subscription"
            && planDraft.providerType !== "anthropic-subscription"
            && !planDraft.credentialId) {
            setPlanError("请选择当前供应商的一条密钥");
            return;
          }
          // OpenCode Go 档位必选（上游 usage 不返回档位标识，估算分母按档位解析）。
          if (planDraft.providerType === "opencode-go" && !planDraft.planTier.trim()) {
            setPlanError("请选择套餐档位（Go / Go Plus）");
            return;
          }
          // 档位 + 付款周期必选且默认不选（2026-10-10 用户确认）：保存必须显式确认，
          // 目录按「档位 × 周期」精准匹配折算月价（如 Pro 按季 430.4/月）。
          if (tierCycleSelectsEnabled) {
            if (!planDraft.planTier) {
              setPlanError("请选择套餐档位");
              return;
            }
            if (!planDraft.planBillingCycle) {
              setPlanError("请选择付款周期");
              return;
            }
          }
          void onSavePlanConfig({
            providerType: planDraft.providerType,
            credentialId: planDraft.providerType === "volcengine-plan" || planDraft.providerType === "volcengine-coding-plan" ? undefined : planDraft.credentialId,
            accessKeyId: planDraft.providerType === "volcengine-plan" || planDraft.providerType === "volcengine-coding-plan" ? planDraft.accessKeyId : undefined,
            secretAccessKey: planDraft.providerType === "volcengine-plan" || planDraft.providerType === "volcengine-coding-plan" ? planDraft.secretAccessKey : undefined,
            planMonthlyFee: monthlyFee,
            planTier: planDraft.providerType === "opencode-go" ? planDraft.planTier.trim() : (tierCycleSelectsEnabled ? planDraft.planTier : undefined),
            planBillingCycle: tierCycleSelectsEnabled && planDraft.planBillingCycle ? planDraft.planBillingCycle as PlanBillingCycle : undefined,
            syncIntervalMinutes: planDraft.syncIntervalMinutes,
          }).then(() => setEditingPlan(false)).catch(error => setPlanError(error instanceof Error ? error.message : "保存失败"));
        }}>
          <label className={styles.field}><span>套餐适配器</span><select value={planDraft.providerType} onChange={event => setPlanDraft({...planDraft, providerType: event.currentTarget.value as PlanProviderType})}>{planProviderOptions().map(providerType => <option key={providerType} value={providerType}>{planProviderLabel(providerType)}</option>)}</select></label>
          {planDraft.providerType === "volcengine-plan" || planDraft.providerType === "volcengine-coding-plan" ? <>
            <label className={`${styles.field} ${styles.fieldSecret}`}><span>AccessKey ID</span><input type="password" autoComplete="off" value={planDraft.accessKeyId} onChange={event => setPlanDraft({...planDraft, accessKeyId: event.currentTarget.value})} placeholder={planConfig?.hasAccessKey ? "留空保持原值" : "必填，只写入系统凭据库"} /><SecretRevealChip kind="plan-ak" targetId={target.id} masked={planConfig?.accessKeyMasked} label="复制 AccessKey ID" /></label>
            <label className={`${styles.field} ${styles.fieldSecret}`}><span>SecretAccessKey</span><input type="password" autoComplete="off" value={planDraft.secretAccessKey} onChange={event => setPlanDraft({...planDraft, secretAccessKey: event.currentTarget.value})} placeholder={planConfig?.hasSecretKey ? "留空保持原值" : "必填，只写入系统凭据库"} /><SecretRevealChip kind="plan-sk" targetId={target.id} masked={planConfig?.secretKeyMasked} label="复制 SecretAccessKey" /></label>
          </> : planDraft.providerType === "openai-subscription" || planDraft.providerType === "anthropic-subscription" ? <p className={styles.syncWarning} role="status">订阅账号自动读取本机 {planDraft.providerType === "openai-subscription" ? "Codex CLI" : "Claude Code CLI"} 登录凭据（只读，不落盘）；未登录时先执行官方 CLI 登录，再点击“保存套餐并开启同步”。</p> : <label className={styles.field}><span>套餐同步密钥</span><select required value={planDraft.credentialId} onChange={event => setPlanDraft({...planDraft, credentialId: event.currentTarget.value})}><option value="">请选择当前供应商的一条密钥</option>{targetCredentials.map(credential => <option key={credential.id} value={credential.id}>{credential.label} · {formatCredentialFingerprint(credential.fingerprintSuffix)}</option>)}</select></label>}
          {planDraft.providerType === "opencode-go" ? (planTierOptions.length > 0
            ? <div className={styles.field}><span>套餐档位（必选，决定各模型的月度额度）</span><div className={styles.tierRadioRow}>{planTierOptions.map(tier => (
              <label key={tier.id} className={styles.tierRadioOption}>
                <input type="radio" name="plan-tier" checked={planDraft.planTier === tier.id} onChange={() => setPlanDraft({
                  ...planDraft,
                  planTier: tier.id,
                  // 选中档位联动月费（目录档位价，可手动修改）。
                  planMonthlyFee: String(tier.monthlyFee),
                })} />
                <span>{tier.name}（${tier.monthlyFee}/月）</span>
              </label>
            ))}</div></div>
            : <label className={styles.field}><span>套餐档位 id（必选）</span><input value={planDraft.planTier} onChange={event => setPlanDraft({...planDraft, planTier: event.currentTarget.value})} placeholder="目录档位读取中…可手填，如 go / go-plus" /></label>) : null}
          {tierCycleSelectsEnabled ? <>
            <label className={styles.field}><span>套餐档位（必选，与付款周期一起决定目录折算月价）</span><select value={planDraft.planTier} onChange={event => {
              const tierId = event.currentTarget.value;
              // 切换档位后，已选周期在新档位无对应折算价时清空强制重选。
              const tier = planTierOptions.find(item => item.id === tierId);
              const cycleKept = !planDraft.planBillingCycle
                || !tier?.billingCycles
                || tier.billingCycles[planDraft.planBillingCycle as PlanBillingCycle] !== undefined;
              const nextCycle = cycleKept ? planDraft.planBillingCycle : "";
              const fee = tierCycleFee(tierId, nextCycle);
              setPlanDraft({...planDraft, planTier: tierId, planBillingCycle: nextCycle, ...(fee !== undefined ? {planMonthlyFee: String(fee)} : {})});
            }}><option value="">请选择套餐档位</option>{planTierOptions.map(tier => <option key={tier.id} value={tier.id}>{tier.name}</option>)}</select></label>
            <label className={styles.field}><span>付款周期（必选）</span><select value={planDraft.planBillingCycle} onChange={event => {
              const cycle = event.currentTarget.value;
              const fee = tierCycleFee(planDraft.planTier, cycle);
              setPlanDraft({...planDraft, planBillingCycle: cycle, ...(fee !== undefined ? {planMonthlyFee: String(fee)} : {})});
            }}><option value="">请选择付款周期</option>{planCycleOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
          </> : null}
          <label className={styles.field}><span>套餐月费（{planFeeCurrency === "USD" ? "美元 USD" : "人民币 CNY"}）</span><input inputMode="decimal" value={planDraft.planMonthlyFee} onChange={event => {setPlanFeeTouched(true); setPlanDraft({...planDraft, planMonthlyFee: event.currentTarget.value});}} placeholder={`可选，例如 ${planFeeCurrency === "USD" ? "10" : "199"}（按预设目录币种）`} /></label>
          <label className={styles.field}><span>同步周期</span><select value={planDraft.syncIntervalMinutes} onChange={event => setPlanDraft({...planDraft, syncIntervalMinutes: Number(event.currentTarget.value)})}>{SYNC_INTERVAL_MINUTES_CHOICES.map(minutes => <option key={minutes} value={minutes}>{minutes}分钟</option>)}</select></label>
          {/* 未完成「保存套餐并开启同步」前（无论首次还是再次进入），引导文案常驻表单内部左下，与保存按钮同行；完成后编辑时不重复展示。
              「暂不设置」仅未配置期间出现：点击收起表单，可随时从头部「展开设置」再次进入。 */}
          <FormFooterRow guide={planConfig ? undefined : PLAN_FORM_GUIDE} saveLabel="保存套餐并开启同步" disabled={busy} onDismiss={planConfig ? undefined : () => setPlanDismissed(true)} />
          {planError ? <p className={styles.errorText} role="alert">{planError}</p> : null}
        </form> : null}

        {/* 订阅 OAuth 失败分化（2026-10-08 用户确认）：NOT_FOUND=本机未登录、REJECTED=真过期，
            不得再把「从未登录」说成「已过期」；网络层失败给出可达性指引。 */}
        {planConfig?.lastSyncError ? <p className={styles.syncWarning} role="status">最近同步失败：{planConfig.lastSyncError}。失败时保留最近成功用量。{planConfig.lastSyncError.includes("SUBSCRIPTION_OAUTH_NOT_FOUND") ? ` ${subscriptionLoginMissingNotice(planConfig.providerType)}` : planConfig.lastSyncError.includes("SUBSCRIPTION_OAUTH_REJECTED") ? ` ${subscriptionReloginNotice(planConfig.providerType)}` : planConfig.lastSyncError.startsWith("PLAN_FETCH_FAILED") ? ` ${subscriptionNetworkNotice(planConfig.providerType)}` : null}</p> : null}
        {planQuota.length === 0 && planConfig ? <p className={styles.emptyCompact}>暂无套餐时间窗数据，可点击“同步套餐”重试。</p> : <div className={styles.quotaGrid}>{planQuota.map(quota => {
          /* 余量主口径（2026-10-07 用户确认，与 zcode 对齐，侧栏/仪表盘同链）：
             主数字与进度条长度展示「剩余」占比；颜色档与级别文案仍按已用占比判定。 */
          const usedPercent = planQuotaPercent(quota);
          const remainingPercent = planQuotaRemainingPercent(quota);
          const stale = isQuotaStale(quota.capturedAt, planIntervalMinutes);
          const level = (usedPercent ?? 0) >= 90 ? "高占用" : (usedPercent ?? 0) >= 70 ? "接近上限" : "余量充足";
          const unlimited = quota.total === null;
          return <article key={`${quota.providerType}-${quota.credentialId || "account"}-${quota.windowLabel}`} className={styles.quotaCell}>
            <div className={styles.quotaCellHead}><strong>{windowLabel(quota.windowLabel)}</strong><span className={styles.quotaLevel}>{level}</span></div>
            <span className={styles.quotaPlanName}>{quota.planName || planProviderLabel(planConfig?.providerType || "kimi-coding")}</span>
            <div className={styles.quotaPercentRow}><strong className={styles.quotaPercent}>{unlimited ? "不限量" : remainingPercent !== null ? `剩 ${remainingPercent.toFixed(1)}%` : "—"}</strong><span className={styles.quotaUsedText}>{formatQuotaDetail(quota, {cnyRate: displayFxFor("USD")})}</span></div>
            <div className={styles.quotaMeter} role="progressbar" aria-label={`${windowLabel(quota.windowLabel)}套餐余量`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(remainingPercent ?? 0)} aria-valuetext={`${level}，剩余 ${remainingPercent !== null ? remainingPercent.toFixed(1) : "—"}%（已用 ${usedPercent !== null ? usedPercent.toFixed(1) : "—"}%）`}><span className={(usedPercent ?? 0) >= 90 ? styles.quotaMeterHigh : (usedPercent ?? 0) >= 70 ? styles.quotaMeterMedium : styles.quotaMeterLow} style={{width: `${remainingPercent ?? 0}%`}} /></div>
            <div className={styles.quotaResetRow}><span title={quota.resetAt ? new Date(quota.resetAt).toLocaleString("zh-CN") : undefined}>重置时间：{quota.resetAt ? formatResetRelative(quota.resetAt) : "供应商未返回"}</span>{stale ? <span className={`${styles.badge} ${styles.badgePending}`}>数据可能过期</span> : null}</div>
          </article>;
        })}</div>}
        {syncStatus?.plan.quota.limited ? <p className={styles.syncWarning}>套餐窗口预览已限制：候选 {syncStatus.plan.quota.candidateCount} 条，本次处理 {syncStatus.plan.quota.processedCount} 条。</p> : null}
        {planHighlight?.lead ? <p className={styles.highlightMessage} role="status">{planHighlight.lead}{planHighlight.emphasis ? <strong className={styles.highlightEmphasis}>{planHighlight.emphasis}</strong> : null}。</p> : null}
      </section> : null}

      {/* 接入配置：编辑/查看态整体从原「基础配置」页签挪入；新建流程不受影响。 */}
      <ConnectionConfigCard target={target} busy={busy} dirty={dirty} onChange={onChangeSelectedTarget} onSave={async () => {
        // 提交时把当前 target 跟 baseline 的 diff 算出来：表单 onChange 只写本地草稿态
        // （updateSelectedTarget），确认时把差异一次性落盘并重置 baseline。
        const base = baselineRef.current.snapshot;
        const patch: Partial<ProxyTarget> = {};
        if (base.name !== target.name) patch.name = target.name;
        if (base.openaiUrl !== (target.openaiUrl || "")) patch.openaiUrl = target.openaiUrl;
        if (base.anthropicUrl !== (target.anthropicUrl || "")) patch.anthropicUrl = target.anthropicUrl;
        if (Object.keys(patch).length === 0) return;
        await onSaveTargetPatch(patch);
        baselineRef.current = {id: target.id, snapshot: snapshotConnectionConfig(target)};
      }} />


      <section className={styles.card}>
        <header className={styles.cardHeader}><div><h3>启用前（接入就绪度）检查清单</h3><p>当前流程：{onboardingStepsForTarget(target).map(item => item.label).join(" → ")}。步骤不可跳跃，前置未完成时后续置灰；点「去配置」进入引导。</p></div></header>
        <ul className={styles.checklist}>
          {checklist.map(item => (
            <li key={item.key} className={`${styles.checklistRow} ${item.blocked ? styles.checklistRowBlocked : ""}`}>
              <span className={`${styles.checklistIcon} ${item.ok ? styles.checklistIconOk : styles.checklistIconPending}`}>{item.ok ? <CheckCircle2 size={15} /> : <CircleAlert size={15} />}</span>
              <div className={styles.checklistCopy}><strong>{item.label}</strong><small>{item.ok ? "已完成" : item.blocked ? "请先完成上一步骤" : item.reason}</small></div>
              {item.ok ? <span className={`${styles.badge} ${styles.badgeReady}`}>已完成</span> : <button type="button" className={styles.secondaryButton} disabled={item.blocked} onClick={onStartOnboarding}>去配置</button>}
            </li>
          ))}
        </ul>
      </section>
      <section className={styles.dangerZone}><div><h3>删除供应商</h3><p>删除后无法恢复，相关 Agent 的默认入口会转为待配置；需要先停用才能删除。</p></div><button type="button" className={styles.dangerButton} onClick={onDeleteTarget} disabled={target.enabled} title={target.enabled ? "请先停用该供应商（右上角开关）" : "删除供应商"}><Trash2 size={16} /> 删除供应商</button></section>
    </div>
  );
}

function formatRelativeTime(value: string): string {
  const diffMs = Date.now() - new Date(value).getTime();
  if (diffMs < 60_000) return "刚刚";
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

/** 新供应商默认站点类型按预设/供应商/上游地址推断：官方预设匹配其同步站点，其余默认中转站（自动识别）。 */
function defaultProviderType(target: ProxyTarget): SyncProviderType {
  const preset = matchPresetForTarget(target);
  if (preset?.syncProvider) return preset.syncProvider;
  const vendor = target.pricing?.vendor || "";
  const urls = `${target.openaiUrl || ""} ${target.anthropicUrl || ""}`;
  if (vendor === "deepseek" || urls.includes("deepseek.com")) return "deepseek";
  return "relay";
}

/** 中转站族（合并选项与存量独立类型）统一按已识别底层类型展示。 */
function isRelayProviderType(providerType: string): boolean {
  return providerType === "relay" || providerType === "sub2api" || providerType === "newapi";
}

/** 中转站展示文案：已识别显示具体底层类型，未识别显示合并说明。 */
function relayProviderLabel(
  providerType: string,
  resolvedProvider?: "sub2api" | "newapi" | null,
): string {
  const resolved = providerType === "relay"
    ? resolvedProvider ?? null
    : providerType === "sub2api"
      ? "sub2api" as const
      : providerType === "newapi"
        ? "newapi" as const
        : null;
  if (resolved === "sub2api") return "中转站（基于Sub2API）";
  if (resolved === "newapi") return "中转站（基于New API）";
  return "中转站（基于Sub2API或NEW API）";
}

/** 账号展示的供应商类型标签：官方预设供应商用预设名+通道，非预设走中转站/官方逻辑。
 *  解决「deepseek 等官方预设在账号信息里仍显示中转站」的历史问题。 */
function accountProviderLabel(
  providerType: string,
  resolvedProvider: "sub2api" | "newapi" | null | undefined,
  preset: ReturnType<typeof resolveOfficialPresetForTarget>,
): string {
  if (preset) {
    const channelTag = preset.billingChannel === "subscription"
      ? "订阅"
      : preset.billingChannel === "plan"
        ? "套餐"
        : "按量";
    return `${preset.name}（${channelTag}）`;
  }
  return relayProviderLabel(providerType, resolvedProvider);
}

/** 账号信息默认控制台地址：预设优先使用官方控制台地址，否则按上游 URL 去掉 /v1 推断。 */
function defaultConsoleUrl(target: ProxyTarget): string {
  const preset = matchPresetForTarget(target);
  if (preset?.consoleUrl) return preset.consoleUrl;
  return (target.openaiUrl || target.anthropicUrl || "").replace(/\/v1\/?$/u, "");
}

/** 按供应商的协议 URL 反查官方预设（与基础配置页的预设反查保持一致）。 */
function matchPresetForTarget(target: ProxyTarget) {
  // 预设创建的供应商优先按 presetId 反查：订阅/套餐与按量预设可能共享同一 URL（如 Anthropic）。
  if (target.presetId) {
    const preset = PROVIDER_PRESETS.find(item => item.id === target.presetId);
    if (preset) return preset;
  }
  return PROVIDER_PRESETS.find(preset =>
    (preset.openaiUrl && preset.openaiUrl === target.openaiUrl)
    || (preset.anthropicUrl && preset.anthropicUrl === target.anthropicUrl),
  );
}

function formatRelativeFuture(value: string): string {
  const diffMs = new Date(value).getTime() - Date.now();
  if (diffMs < 60_000) return "不到 1 分钟";
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时`;
  return `${Math.floor(hours / 24)} 天`;
}

/**
 * 套餐重置时间的相对格式：秒钟不计、不足 1 分钟不计数。
 * 1 小时内显示「X 分钟后」，1 天内显示「X小时Y分钟后」，超过 1 天显示「D天X小时Y分钟后」。
 */
function formatResetRelative(resetAtValue: string): string {
  const diffMs = new Date(resetAtValue).getTime() - Date.now();
  if (!Number.isFinite(diffMs) || diffMs <= 0) return "即将重置";
  const totalMinutes = Math.floor(diffMs / 60_000);
  if (totalMinutes < 1) return "不足 1 分钟后";
  if (totalMinutes < 60) return `${totalMinutes} 分钟后`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  const minuteSuffix = minutes > 0 ? `${minutes}分钟后` : "后";
  if (hours < 24) return `${hours}小时${minuteSuffix}`;
  const days = Math.floor(hours / 24);
  return `${days}天${hours % 24}小时${minuteSuffix}`;
}


function planProviderLabel(providerType: PlanProviderType): string {
  return planProviderLabelFromPlugins(providerType);
}

function windowLabel(value: string): string {
  return ({
    "5h": "5 小时窗口",
    weekly: "每周窗口",
    monthly: "每月窗口",
    "30d": "30 天窗口",
    code_review: "Code Review",
    weekly_opus: "Weekly Opus",
    weekly_sonnet: "Weekly Sonnet",
    extra_usage: "Usage Credits（超额额度）",
  })[value] || value;
}

function formatQuotaValue(value: number | null): string {
  if (value === null) return "—";
  return new Intl.NumberFormat("zh-CN", {maximumFractionDigits: 3}).format(value);
}

/** 用量单位展示：percent 显示为 %，requests 显示为 次，其余保留原值。 */
function quotaUnitLabel(unit: string | null): string {
  if (!unit) return "";
  if (unit === "percent") return "%";
  if (unit === "requests") return " 次";
  if (unit === "credits") return " 积分";
  return ` ${unit}`;
}

function formatQuotaDetail(
  quota: {used: number | null; total: number | null; remaining: number | null; unit: string | null},
  options?: {cnyRate?: number},
): string {
  if (quota.unit === "percent") return "供应商仅返回百分比";
  /* 美元额度（如 Anthropic Extra Usage）：按「原值（约￥等值）」展示（2026-09-28 用户决策）；
     2026-10-07 余量主口径（与 zcode 对齐）：剩余在前、已用在后。 */
  if (quota.unit === "USD") {
    const rate = options?.cnyRate;
    const hasRate = typeof rate === "number" && Number.isFinite(rate) && rate > 0;
    const formatUsd = (value: number | null) => hasRate
      ? formatMoneyWithCnyEquivalent(value, "USD", rate!)
      : formatOriginalMoney(value, "USD");
    if (quota.total === null) {
      return quota.used === null ? "不限量" : `已用 ${formatUsd(quota.used)}`;
    }
    const remaining = quota.remaining ?? (quota.used === null ? null : Math.max(quota.total - quota.used, 0));
    return `剩余 ${formatUsd(remaining)} / 共 ${formatUsd(quota.total)} · 已用 ${formatUsd(quota.used)}`;
  }
  if (quota.total === null) {
    return quota.used === null
      ? "不限量"
      : `已用 ${formatQuotaValue(quota.used)}${quotaUnitLabel(quota.unit)}`;
  }
  const remaining = quota.remaining ?? (quota.used === null ? null : Math.max(quota.total - quota.used, 0));
  const unit = quotaUnitLabel(quota.unit);
  /* 余量主口径（2026-10-07 用户确认，与 zcode 官方客户端对齐）。 */
  return `剩余 ${formatQuotaValue(remaining)}${unit} / 共 ${formatQuotaValue(quota.total)}${unit} · 已用 ${formatQuotaValue(quota.used)}${unit}`;
}

function isQuotaStale(capturedAt: string, intervalMinutes: number): boolean {
  return Date.now() - new Date(capturedAt).getTime() > intervalMinutes * 2 * 60_000;
}

/**
 * 接入配置（编辑/查看态）：官方预设只读展示预设选中框 + 供应商名；
 * 自定义供应商外层只展示供应商名称；两个协议 URL 与不可变路由 ID 在「自定义设置」内。
 */
function ConnectionConfigCard({target, busy, dirty, onChange, onSave}: {
  target: ProxyTarget;
  busy: boolean;
  /** 任何字段无变化时为 false，确认修改按钮置灰。 */
  dirty: boolean;
  onChange: (patch: Partial<ProxyTarget>) => void;
  /** 提交当前 target 跟基线的差异；内部已算好 patch，调用方直接落盘即可。 */
  onSave: () => Promise<void>;
}) {
  const preset = resolveOfficialPresetForTarget(target)
    || (target.presetId ? PROVIDER_PRESETS.find(item => item.id === target.presetId) : undefined);
  const selectedPreset = target.presetId ? PROVIDER_PRESETS.find(item => item.id === target.presetId) : undefined;
  return <section className={styles.card}>
    <header className={styles.cardHeader}><div><h3>接入配置</h3><p>{preset ? "官方预设置顶展示，创建后锁定不可更换；供应商名可修改，固定上游地址与路由 ID 在下方「自定义设置」中。" : "供应商名称与协议地址配置；修改仅影响本页签，点击确认后生效并自动同步到已接入 Agent。"}</p></div></header>
    <div className={styles.formStack}>
      {preset ? (
        <div className={`${styles.field} ${styles.presetPicker}`}>
          <span>官方预设</span>
          <div className={styles.presetPickerControl}>
            <span className={`${styles.presetPickerTrigger} ${styles.presetPickerLocked}`}>
              {selectedPreset ? `${selectedPreset.name}（${billingChannelLabel(selectedPreset.billingChannel)}）` : preset.name}
            </span>
          </div>
          <small>官方预设创建后锁定，不可更换；协议地址固定由预设提供。</small>
        </div>
      ) : null}
      <label className={styles.field}><span>{preset ? "供应商名" : "供应商名称"} <b>*</b></span><input value={target.name} onChange={event => onChange({name: event.currentTarget.value})} placeholder="供应商名称" /></label>
      <details className={styles.advancedSettings}><summary>自定义设置</summary>
        <div className={styles.formStack}>
          {preset ? (
            <div className={styles.readonlyUrlBlock}><strong>固定上游地址（由官方预设提供，只读）</strong><dl className={styles.readonlyUrlList}><div><dt>OpenAI 协议</dt><dd><code>{selectedPreset?.openaiUrl || target.openaiUrl || "该预设未提供"}</code></dd></div><div><dt>Anthropic 协议</dt><dd><code>{selectedPreset?.anthropicUrl || target.anthropicUrl || "该预设未提供"}</code></dd></div></dl></div>
          ) : <>
            <label className={styles.field}><span>OpenAI 协议（支持 chat/completions、responses）上游 URL</span><input type="url" value={target.openaiUrl || ""} onChange={event => onChange({openaiUrl: event.currentTarget.value || undefined})} placeholder="未填写 · 例如 https://api.example.com/v1" /></label>
            <label className={styles.field}><span>Anthropic 协议（支持 v1/messages）上游 URL</span><input type="url" value={target.anthropicUrl || ""} onChange={event => onChange({anthropicUrl: event.currentTarget.value || undefined})} placeholder="未填写 · 例如 https://api.example.com" /></label>
          </>}
          <div className={styles.formGrid}>
            <label className={styles.field}><span>路由 ID <b>*</b></span><input value={target.id} readOnly aria-disabled /><small>路由 ID 只能新建时填写，创建之后不允许修改。</small></label>
          </div>
        </div>
      </details>
      <div className={styles.basicSaveRow}><button type="button" className={styles.primaryButton} onClick={() => void onSave()} disabled={busy || !dirty}><Save size={16} /> {busy ? "保存中…" : "确认修改"}</button></div>
    </div>
  </section>;
}

/** 接入配置可编辑字段的保存基线：仅纳入实际可改的字段，
 *  路由 ID / 预设 ID / 计划档位 / URL 等锁定字段不参与 dirty 判定。 */
interface ConnectionConfigBaseline {
  name: string;
  openaiUrl: string;
  anthropicUrl: string;
}

function snapshotConnectionConfig(target: ProxyTarget): ConnectionConfigBaseline {
  return {
    name: target.name,
    openaiUrl: target.openaiUrl || "",
    anthropicUrl: target.anthropicUrl || "",
  };
}

function hasConnectionConfigChanges(baseline: ConnectionConfigBaseline, target: ProxyTarget): boolean {
  return baseline.name !== target.name
    || baseline.openaiUrl !== (target.openaiUrl || "")
    || baseline.anthropicUrl !== (target.anthropicUrl || "");
}
