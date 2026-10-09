/**
 * 目录 v2 稳定诊断码（设计 9.1 首批稳定码 + 隔离规则 5.2）：
 * 供维护告警、同步日志、快照 ruleDiagnostics 与测试共用。
 * 「隔离」语义：保留原目录与其它合法内容，单独记录维护告警；
 * 禁止把未知规则静默当成无条件生效。
 */

/** 诊断严重级别：error=对应内容已隔离、不计费不生效；warning=数据事实不一致但不阻断计价。 */
export type CatalogDiagnosticSeverity = "error" | "warning";

export interface CatalogDiagnostic {
  /** 稳定诊断码（本文件 REGISTRY 中的键）。 */
  code: CatalogDiagnosticCode;
  severity: CatalogDiagnosticSeverity;
  /** 作用对象粒度：整份目录 / 供应商 / 档位 / 活动 / 工具规则 / 窗口 / 预设。 */
  dimension: "catalog" | "provider" | "plan-tier" | "campaign" | "tool-factor" | "window" | "preset";
  /** 关联对象标识（catalogKey / campaignId / presetKey 等）。 */
  target?: string;
  /** 关联活动 ID 列表（冲突类诊断）。 */
  campaignIds?: string[];
  message: string;
}

export type CatalogDiagnosticCode =
  | "CATALOG_SCHEMA_UNSUPPORTED"
  | "CATALOG_META_INVALID"
  | "CALENDAR_NOT_FOUND"
  | "CAMPAIGN_UNKNOWN_EFFECT"
  | "CAMPAIGN_CONFLICT"
  | "CAMPAIGN_TIMEZONE_REQUIRED"
  | "CAMPAIGN_SCOPE_REQUIRED"
  | "CAMPAIGN_TIME_INVALID"
  | "CAMPAIGN_STRUCTURE_INVALID"
  | "PROFILE_NOT_FOUND"
  | "PROFILE_CALCULATOR_INVALID"
  | "PLAN_CHANNEL_WITHOUT_PROFILE"
  | "PLAN_INPUT_BOUNDARY_VIOLATION"
  | "TOOL_CREDIT_UNSUPPORTED"
  | "PRESET_REGISTRY_MISMATCH"
  | "PLAN_TIER_BILLING_CYCLES_INVALID"
  | "SUBSCRIPTION_CAMPAIGN_UNSUPPORTED"
  | "MARKET_SHARE_LIMITS_MISSING";

/** 诊断码 → 默认严重级别与说明（单一事实来源，测试与 UI 消费）。 */
export const CATALOG_DIAGNOSTIC_REGISTRY: Readonly<Record<CatalogDiagnosticCode, {severity: CatalogDiagnosticSeverity; description: string}>> = {
  CATALOG_SCHEMA_UNSUPPORTED: {severity: "error", description: "schemaVersion 不支持：隔离整份目录，回退上一份有效目录或随包兜底"},
  CATALOG_META_INVALID: {severity: "error", description: "v2 必填元信息缺失或格式非法：隔离整份目录"},
  CALENDAR_NOT_FOUND: {severity: "error", description: "calendarRef 引用的公共日历不存在或日期格式非法：隔离所属窗口/活动"},
  CAMPAIGN_UNKNOWN_EFFECT: {severity: "error", description: "未知 effect.kind / 条件 / 计算器：整条活动隔离（含第二期 kind 提前出现）"},
  CAMPAIGN_CONFLICT: {severity: "error", description: "同优先级同范围 override/freeWindow 冲突：隔离冲突活动"},
  CAMPAIGN_TIMEZONE_REQUIRED: {severity: "error", description: "活动窗口无可继承时区：隔离该活动"},
  CAMPAIGN_SCOPE_REQUIRED: {severity: "error", description: "免费/封顶/大额加成活动缺少有效边界（模型/Agent/日期/窗口至少其一）：隔离"},
  CAMPAIGN_TIME_INVALID: {severity: "error", description: "period/窗口时间非法：隔离该活动"},
  CAMPAIGN_STRUCTURE_INVALID: {severity: "error", description: "活动结构非法（缺 id、分数分母非法、效果与通道不匹配等）：隔离"},
  PROFILE_NOT_FOUND: {severity: "error", description: "套餐活动/模型引用的 Profile 不存在：隔离相关条目"},
  PROFILE_CALCULATOR_INVALID: {severity: "error", description: "Profile 缺少可用 calculator/时区/额度语义：隔离依赖活动，不回退 PAYG 价"},
  PLAN_CHANNEL_WITHOUT_PROFILE: {severity: "warning", description: "套餐通道无逐请求积分公式：标记 crediting=unavailable（合法状态）"},
  PLAN_INPUT_BOUNDARY_VIOLATION: {severity: "error", description: "Plan 计算输入越界（读取 PAYG 生效价等通道污染）：计费端必须拒绝"},
  TOOL_CREDIT_UNSUPPORTED: {severity: "error", description: "fixedToolCredit 无运行时工具事件能力：隔离（第二期能力）"},
  PRESET_REGISTRY_MISMATCH: {severity: "warning", description: "目录 presets[] 与源码注册表不一致：展示回退注册表，不影响计价"},
  PLAN_TIER_BILLING_CYCLES_INVALID: {severity: "error", description: "billingCycles 缺 monthly/与 monthlyFee 不一致/非正数：隔离该档位"},
  SUBSCRIPTION_CAMPAIGN_UNSUPPORTED: {severity: "error", description: "第一期订阅通道一律隔离订阅 Campaign（仅保留观察窗口语义）"},
  MARKET_SHARE_LIMITS_MISSING: {severity: "error", description: "模型引用 market_share Profile 但缺档位月度额度：条目不投影规则，估算按 market_blocked 降级"},
};

/** 便捷构造：严重级别取注册表默认值。 */
export function catalogDiagnostic(
  code: CatalogDiagnosticCode,
  dimension: CatalogDiagnostic["dimension"],
  message: string,
  extra: Omit<CatalogDiagnostic, "code" | "severity" | "dimension" | "message"> = {},
): CatalogDiagnostic {
  return {code, severity: CATALOG_DIAGNOSTIC_REGISTRY[code].severity, dimension, message, ...extra};
}
