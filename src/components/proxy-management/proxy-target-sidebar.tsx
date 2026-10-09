import {CirclePlus, Search} from "lucide-react";
import {formatLocalDateTime} from "@/lib/local-time";
import {formatPlanQuotaAmount, formatPlanQuotaHeadline, formatPlanQuotaUsedAmount, usageFallbackLabel} from "@/lib/plan-quota-display";
import type {SyncOverviewTargetSummary} from "@/lib/sync-engine/overview-types";
import {badgeInputFromOverview, resolveTargetBadge} from "@/lib/sync-engine/target-health-badge";
import {TargetHealthBadge} from "@/components/proxy-management/target-health-badge";
import {PROVIDER_PRESETS, derivePresetCurrency} from "@/lib/provider-presets";
import {asDisplayCurrency, resolveDisplayFxRate} from "@/lib/settlement-fx";
import {formatMoneyWithCnyEquivalent} from "@/lib/money-display";
import {useFxSnapshot} from "@/lib/fx-snapshot-client";
import type {ProxyTarget} from "@/types";
import styles from "./proxy-management.module.css";

interface ProxyTargetSidebarProps {
  targets: ProxyTarget[];
  credentials: Array<{targetId: string}>;
  selectedTargetId?: string;
  /** 新建未保存草稿的 createdAt 身份；用于高亮与切回草稿编辑。 */
  draftCreatedAt?: string;
  search: string;
  /**
   * 全量同步概览（有界只读接口）：余额 / 主套餐窗口用量 / 倍率黄标。
   * 缺省或某目标暂无记录时按空态渲染，绝不阻塞列表本身。
   */
  overviewByTarget?: Record<string, SyncOverviewTargetSummary>;
  onSearchChange: (value: string) => void;
  onSelect: (targetId: string, createdAt?: string) => void;
  onAdd: () => void;
}

/** 账号类型徽标：量 = 按量、套 = 套餐、订 = 订阅。 */
const CHANNEL_BADGE: Record<string, {short: string; full: string; modifier: string}> = {
  pay_as_you_go: {short: "量", full: "按量通道", modifier: "payg"},
  plan: {short: "套", full: "套餐通道", modifier: "plan"},
  subscription: {short: "订", full: "订阅通道", modifier: "subscription"},
};

const CHANNEL_MODIFIER_CLASS: Record<string, string> = {
  payg: styles.channelTagPayg,
  plan: styles.channelTagPlan,
  subscription: styles.channelTagSubscription,
};

function relativeSync(value: string | null | undefined): string {
  if (!value) return "尚未同步";
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "尚未同步";
  const minutes = Math.round((Date.now() - timestamp) / 60_000);
  if (minutes < 1) return "刚刚同步";
  if (minutes < 60) return `${minutes} 分钟前同步`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时前同步`;
  return `${Math.round(hours / 24)} 天前同步`;
}

/**
 * 侧栏「余额 / 套餐窗口用量」行。
 *
 * 口径与仪表盘供应商卡完全一致（共用 `plan-quota-display`）：
 * 按量通道看余额（依赖控制台账号），套餐/订阅通道看主时间窗用量（依赖套餐同步）。
 * 「没设置」与「设置了但还没同步」必须分开说（2026-09-18 用户确认）：
 * 前者提示「账号未设置」/「套餐（订阅）未设置」，后者才是「用量待同步」/「余额控制台查看」。
 * 同步概览尚未返回时保持沉默，避免先闪一段错误结论。
 */
function TargetUsageLine({target, overview}: {target: ProxyTarget; overview?: SyncOverviewTargetSummary}) {
  // fx 快照（2026-09-28）：余额人民币等值换算用；hook 必须先于任何早退分支调用。
  const fxSnapshot = useFxSnapshot();
  if (!overview) {
    return <span className={styles.targetUsageMuted} title="正在读取同步概览…">读取中…</span>;
  }
  if (target.billingChannel !== "pay_as_you_go") {
    const headline = formatPlanQuotaHeadline(overview.plan ?? undefined);
    if (headline && overview.plan) {
      const detail = [
        `套餐/订阅窗口余量：${headline}`,
        formatPlanQuotaAmount(overview.plan),
        formatPlanQuotaUsedAmount(overview.plan),
        overview.plan.windowCount > 1 ? `另有 ${overview.plan.windowCount - 1} 个时间窗` : "",
        overview.plan.resetAt ? `重置于 ${formatLocalDateTime(overview.plan.resetAt)}` : "",
        relativeSync(overview.planLastSyncAt ?? overview.accountLastSyncAt),
      ].filter(Boolean);
      return <span className={styles.targetUsage} title={detail.join(" · ")}>{headline}</span>;
    }
    if (!overview.hasPlanConfig) {
      return (
        <span className={styles.targetUsageMuted} title="尚未配置套餐同步；可在概览「套餐用量」保存配置后点「同步套餐」">
          {usageFallbackLabel("plan")}
        </span>
      );
    }
    return (
      <span className={styles.targetUsageMuted} title="已配置套餐同步，但还没有可用快照；可点「同步套餐」立即拉取">
        {usageFallbackLabel("pending")}
      </span>
    );
  }
  if (overview.balance) {
    /* 余额「原值（约￥等值）」（2026-09-28；2026-10-06 与入账级联对齐）：按余额自身币种
       解析——官方预设（任意目录币种）非人民币按目录 fx 快照、自定义中转站按目标
       settlementFx（如 auto-code 1:16——这是业务结算系数，不是市场汇率）。 */
    const preset = target.presetId ? PROVIDER_PRESETS.find(item => item.id === target.presetId) : undefined;
    const rate = resolveDisplayFxRate({
      amountCurrency: asDisplayCurrency(overview.balance.currency),
      presetCurrency: derivePresetCurrency(preset),
      settlementFx: target.pricing?.settlementFx,
      fxUsdCny: fxSnapshot?.rate,
    });
    const balanceText = formatMoneyWithCnyEquivalent(overview.balance.amount, overview.balance.currency, rate);
    const detail = [
      `余额（按量）：${overview.balance.amount} ${overview.balance.currency}`,
      ...(overview.balance.currency !== "CNY"
        ? [`人民币等值按${preset ? "目录汇率快照" : "目标结算系数"}折算（仅展示，不入账）`]
        : []),
      relativeSync(overview.balance.capturedAt),
    ];
    return (
      <span className={styles.targetUsage} title={detail.join(" · ")}>
        余额 {balanceText}
      </span>
    );
  }
  if (!overview.hasConsoleAccount) {
    return (
      <span className={styles.targetUsageMuted} title="尚未配置控制台账号同步；余额需在站点控制台查看，配置账号后可自动同步">
        {usageFallbackLabel("account")}
      </span>
    );
  }
  return (
    <span className={styles.targetUsageMuted} title="该站点暂无公开余额接口或最近同步未成功，请在站点控制台查看余额">
      {usageFallbackLabel("balance-unavailable")}
    </span>
  );
}

/**
 * 供应商列表：只表达供应商资源与启用/就绪状态，不重复展示请求协议。
 *
 * 就绪状态完全由左侧圆点承载（绿=已配置、橙=待配置、灰=已停用），
 * 因此不再重复渲染「已配置/待配置」文案（2026-09-18 用户确认）；
 * 完整状态改为挂在该行的 title / aria-label 上，悬浮与读屏仍可获知。
 * 右侧承载账号类型徽标（量/套/订）与远端倍率黄标，
 * 第三行承载余额（按量）或套餐/订阅窗口用量。
 */
export function ProxyTargetSidebar({
  targets,
  selectedTargetId,
  draftCreatedAt,
  search,
  overviewByTarget,
  onSearchChange,
  onSelect,
  onAdd,
}: ProxyTargetSidebarProps) {
  const visible = targets.filter(target =>
    !search.trim() || `${target.name} ${target.id}`.toLowerCase().includes(search.trim().toLowerCase()),
  );
  return (
    <section className={styles.sidebarSection} aria-labelledby="proxy-target-list-title">
      <div className={styles.sectionHeadingRow}>
        <div>
          <h2 id="proxy-target-list-title">供应商</h2>
          <p>供应商只配置一次，可供多个 Agent 复用。</p>
        </div>
        <button type="button" className={styles.iconButton} onClick={onAdd} aria-label="新建供应商" title="新建供应商">
          <CirclePlus size={18} />
        </button>
      </div>
      <label className={styles.searchField}>
        <Search size={16} aria-hidden="true" />
        <span className={styles.srOnly}>搜索供应商</span>
        <input value={search} onChange={event => onSearchChange(event.currentTarget.value)} placeholder="搜索名称或路由 ID" />
      </label>
      <div className={styles.targetList}>
        {visible.length === 0 ? <p className={styles.emptyCompact}>没有匹配的供应商。</p> : visible.map(target => {
          const ready = target.enabled && target.supportedModels.length > 0 && Boolean(target.openaiUrl || target.anthropicUrl);
          const stateLabel = !target.enabled ? "已停用" : ready ? "已配置" : "待配置";
          // billingChannel 是可选字段：缺省按「按量」渲染（与页面头部 channelBadge 同一兜底）。
          const channel = CHANNEL_BADGE[target.billingChannel ?? "pay_as_you_go"] ?? CHANNEL_BADGE.pay_as_you_go!;
          const overview = overviewByTarget?.[target.id];
          // 唯一健康标识（账号未设置 / 套餐（订阅）未设置 / 同步失败 / 倍率未校验 / 倍率待确认）：
          // 判定与文案统一来自 @/lib/sync-engine/target-health-badge（与仪表盘供应商卡共用一份）。
          const badge = resolveTargetBadge(
            badgeInputFromOverview(target, overview),
            target.name || "未命名供应商",
          );
          const rowTitle = [
            `${target.name || "未命名供应商"} · ${stateLabel}`,
            `路由 ID：${target.id}`,
            channel.full,
            badge ? badge.title : "",
          ].filter(Boolean).join(" · ");
          return (
            <button
              type="button"
              key={target.createdAt || target.id}
              className={`${styles.targetItem} ${target.createdAt === draftCreatedAt || (!draftCreatedAt && selectedTargetId === target.id) ? styles.targetItemActive : ""}`}
              title={rowTitle}
              aria-label={rowTitle}
              onClick={() => onSelect(target.id, target.createdAt)}
            >
              <span className={`${styles.statusDot} ${ready ? styles.statusReady : target.enabled ? styles.statusPending : styles.statusOff}`} aria-hidden="true" />
              <span className={styles.targetCopy}>
                <strong>
                  {/* 名称单独包一层：长名称省略号截断时，右侧徽标（未保存/倍率黄标）不会被裁掉。 */}
                  <span className={styles.targetName}>{target.name || "未命名供应商"}</span>
                  {target.createdAt === draftCreatedAt ? <em className={styles.draftTag}>未保存</em> : null}
                  <TargetHealthBadge badge={badge} />
                </strong>
                <small>{target.id}</small>
                <TargetUsageLine target={target} overview={overview} />
              </span>
              <span
                className={`${styles.channelTag} ${CHANNEL_MODIFIER_CLASS[channel.modifier] ?? ""}`}
                title={channel.full}
                aria-label={channel.full}
              >
                {channel.short}
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
