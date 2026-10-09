/**
 * 供应商同步概览的共享契约（纯类型模块）。
 *
 * 为什么单独成文件：写入端（`sync-engine/service.ts`，Node runtime、依赖 SQLite）
 * 与读取端（供应商管理页面 / 侧栏，客户端组件）必须共用同一份结构。
 * 客户端绝不能 `import type` 整个 service 模块（会牵引 node:sqlite 等
 * Node-only 依赖），因此把契约放在这个零依赖的类型模块里。
 */

/** 供应商同步概览的读取上限：目标数与单目标时间窗数都必须有界。 */
export const MAX_OVERVIEW_TARGETS = 200;
export const OVERVIEW_PLAN_WINDOW_LIMIT = 8;

/**
 * 连续自动失败的类别（2026-09-20 用户确认）：「连续两次才亮」只是默认场景，
 * 凭证/鉴权类失败基本会持续失败且需要尽快人工介入 → 一次即亮；
 * 未来新类别（如链接不通需三次再亮）在此扩展联合类型并在
 * target-health-badge 的门槛策略表登记。
 * 读取端对未知类别一律回退默认门槛，保证前向兼容。
 */
export type TargetSyncFailureKind = "auth" | "default";

/** 单个供应商的同步概览（供应商列表 / 侧栏只消费这一份精简投影）。 */
export interface SyncOverviewTargetSummary {
  targetId: string;
  /** 是否配置了控制台账号；未配置时余额不可能自动获取。 */
  hasConsoleAccount: boolean;
  /** 控制台账号同步状态（ok / failed / auth_required / running / idle…）。 */
  accountStatus: string | null;
  accountLastSyncAt: string | null;
  /** 账号链连续自动同步失败次数（成功即清零）；供「同步失败」红标判定。 */
  accountConsecutiveFailures: number;
  accountLastError: string | null;
  /** 账号链最近一次失败的类别（auth = 凭证/鉴权一次即亮；null = 无进行中的失败链）。 */
  accountFailureKind: string | null;
  balance: {currency: string; amount: number; capturedAt: string} | null;
  /** 主时间窗用量（按 5 小时 → 滚动 → 周 → 月 的优先级挑选）。 */
  plan: {
    windowLabel: string;
    /** 该目标共有多少个时间窗快照（>1 时提示还有其它窗口）。 */
    windowCount: number;
    used: number | null;
    total: number | null;
    remaining: number | null;
    unit: string | null;
    resetAt: string | null;
    capturedAt: string;
  } | null;
  /** 是否配置了套餐同步（套餐/订阅通道的「未设置」提示依据）。 */
  hasPlanConfig: boolean;
  planLastSyncAt: string | null;
  /** 套餐链连续自动同步失败次数（成功即清零）；供「同步失败」红标判定。 */
  planConsecutiveFailures: number;
  planLastError: string | null;
  /** 套餐链最近一次失败的类别（auth = 凭证/鉴权一次即亮；null = 无进行中的失败链）。 */
  planFailureKind: string | null;
  /** 远端倍率待确认（黄标提醒）的密钥数量；0 表示无提醒。 */
  rateUnconfirmedCount: number;
  rateUnconfirmedLabels: string[];
}

export interface SyncOverviewPayload {
  targets: SyncOverviewTargetSummary[];
  /** 实际处理的目标数（含 limited 截断后的真实值）。 */
  processedCount: number;
  /** 请求目标数超过 MAX_OVERVIEW_TARGETS 时为 true。 */
  limited: boolean;
}
