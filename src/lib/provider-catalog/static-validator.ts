/**
 * Profile/Campaign 静态校验（设计 5.2 静态拒绝与隔离规则）：
 * 输入已通过 normalize 结构校验的供应商对象，输出「允许参与编译的活动/档位/Profile」
 * 与维护诊断。「隔离」= 从编译输入中剔除并记录告警，绝不静默当成无条件生效。
 */
import {PROVIDER_PRESETS} from "@/lib/provider-presets";
import type {ProviderPlanTier, ProviderPlanProfile, CatalogCampaign, ProviderCatalogCalendar, ProviderCatalogProvider} from "./types";
import {catalogDiagnostic, type CatalogDiagnostic} from "./diagnostics";
import {EFFECT_REGISTRY, effectLaneMatchesChannel} from "./effect-registry";
import {validateProfileCalculator} from "./calculator-registry";
import {campaignHasBoundary, sortCampaignsByPriority} from "./rule-dsl";

export interface ProviderValidationResult {
  /** 允许参与编译的活动（priority 降序；隔离项已剔除）。 */
  campaigns: CatalogCampaign[];
  /** 允许参与编译的套餐档位（billingCycles 非法档位已剔除）。 */
  planTiers: ProviderPlanTier[] | undefined;
  /** 允许参与编译的 planProfiles（calculator 非法的 Profile 已剔除）。 */
  planProfiles: Record<string, ProviderPlanProfile> | undefined;
  diagnostics: CatalogDiagnostic[];
}

export function validateProviderBilling(
  catalogKey: string,
  provider: ProviderCatalogProvider,
  calendars: Record<string, ProviderCatalogCalendar>,
): ProviderValidationResult {
  const diagnostics: CatalogDiagnostic[] = [];
  const rawProfiles = provider.planProfiles ?? {};

  // ── Profile 校验（规则 10）：calculator 合法 + 时区可用；非法 Profile 剔除，依赖方后续隔离。
  const planProfiles: Record<string, ProviderPlanProfile> = {};
  for (const [profileId, profile] of Object.entries(rawProfiles)) {
    const errors = validateProfileCalculator(profile);
    if (profile.timezone !== undefined) {
      try {
        new Intl.DateTimeFormat("en-US", {timeZone: profile.timezone});
      } catch {
        errors.push(`timezone 不是可用的 IANA 时区: ${profile.timezone}`);
      }
    }
    if (errors.length > 0) {
      diagnostics.push(catalogDiagnostic("PROFILE_CALCULATOR_INVALID", "provider",
        `Profile ${profileId} 计算器/时区非法：${errors.join("；")}`, {target: `${catalogKey}/${profileId}`}));
      continue;
    }
    planProfiles[profileId] = profile;
  }

  // ── 活动校验（规则 2/3/4/8/9/10/12/14 + 第一期订阅隔离 + 第二期 kind 隔离）。
  const surviving: CatalogCampaign[] = [];
  for (const campaign of provider.campaigns ?? []) {
    const reject = (code: Parameters<typeof catalogDiagnostic>[0], message: string) => {
      diagnostics.push(catalogDiagnostic(code, "campaign", message, {target: `${catalogKey}/${campaign.id}`}));
    };
    if (campaign.channel === "subscription") {
      reject("SUBSCRIPTION_CAMPAIGN_UNSUPPORTED", "第一期订阅通道只保留观察窗口语义，订阅 Campaign 一律隔离");
      continue;
    }
    const spec = EFFECT_REGISTRY[campaign.effect.kind];
    if (!spec) {
      reject("CAMPAIGN_UNKNOWN_EFFECT", `未知 effect.kind: ${String((campaign.effect as {kind?: unknown}).kind)}`);
      continue;
    }
    if (!spec.phase1Enabled) {
      reject("CAMPAIGN_UNKNOWN_EFFECT", `effect.kind=${campaign.effect.kind} 属第二期能力（v2-2 设计，待按需确认），第一期按未知动作隔离`);
      continue;
    }
    if (!effectLaneMatchesChannel(campaign.effect.kind, campaign.channel)) {
      reject("CAMPAIGN_STRUCTURE_INVALID", `effect.kind=${campaign.effect.kind} 属 ${spec.lane} 链，与 campaign.channel=${campaign.channel} 不匹配`);
      continue;
    }
    // 第一期没有分组定义源（modelGroups/agentGroups/regions/serviceTiers）：无法求值的条件必须隔离，
    // 不得静默当成无条件生效（设计 4.5「未声明维度=不限制，绝不=忽略未知条件」）。
    const scope = campaign.scope;
    if ((scope?.modelGroups?.length ?? 0) > 0 || (scope?.agentGroups?.length ?? 0) > 0
      || (scope?.regions?.length ?? 0) > 0 || (scope?.serviceTiers?.length ?? 0) > 0) {
      reject("CAMPAIGN_STRUCTURE_INVALID", "活动作用域使用了第一期无定义源的条件（modelGroups/agentGroups/regions/serviceTiers），隔离待第二期开放");
      continue;
    }
    // 规则 4/9：免费/封顶/大额加成必须有边界。
    if ((campaign.effect.kind === "freeWindow" || isZeroCreditMultiplier(campaign.effect)) && !campaignHasBoundary(campaign)) {
      reject("CAMPAIGN_SCOPE_REQUIRED", "freeWindow / ×0 活动缺少模型、Agent、截止日期或每日窗口中的至少一个有效边界");
      continue;
    }
    // plan 活动必须引用存在的合法 Profile（规则 8/10）。
    if (campaign.channel === "plan") {
      const profileId = campaign.profileRef;
      if (!profileId || !planProfiles[profileId]) {
        reject("PROFILE_NOT_FOUND", `套餐活动引用的 Profile 不存在或已隔离: ${String(profileId)}`);
        continue;
      }
    }
    // 每日窗口需要可继承时区（规则：绝不隐式当作 Asia/Shanghai）。
    if (campaign.recurringWindows?.length) {
      const inheritable = campaign.recurringWindows.every(window =>
        window.timezone !== undefined
        || (campaign.channel === "plan" && planProfiles[campaign.profileRef ?? ""]?.timezone !== undefined)
        || provider.defaultTimezone !== undefined);
      if (!inheritable) {
        reject("CAMPAIGN_TIMEZONE_REQUIRED", "活动每日窗口无可继承时区（窗口/Profile/defaultTimezone 均未声明）");
        continue;
      }
      if (campaign.recurringWindows.some(window => window.excludeHolidays || window.includeHolidays)
        && !(provider.calendarRef && calendars[provider.calendarRef])) {
        diagnostics.push(catalogDiagnostic("CALENDAR_NOT_FOUND", "campaign",
          `活动窗口声明节假日标志但供应商缺少可用 calendarRef: ${String(provider.calendarRef)}`, {target: `${catalogKey}/${campaign.id}`}));
        continue;
      }
    }
    surviving.push(campaign);
  }

  // ── 冲突检测（规则 5/6）：同维度、同优先级、同范围签名、不同效果值的 override/freeTerminal 隔离。
  const conflicts = detectOverrideConflicts(surviving);
  const conflictedIds = new Set(conflicts.flatMap(pair => pair));
  for (const pair of conflicts) {
    diagnostics.push(catalogDiagnostic("CAMPAIGN_CONFLICT", "campaign",
      `同优先级同范围的活动效果冲突：${pair.join(" vs ")}`, {campaignIds: pair}));
  }
  const campaigns = sortCampaignsByPriority(surviving.filter(campaign => !conflictedIds.has(campaign.id)));

  // ── 档位校验（规则 15，billingCycles 可选）。
  const planTiers = (provider.planTiers ?? []).filter(tier => {
    const cycles = tier.billingCycles;
    if (cycles === undefined) return true;
    const values = [cycles.monthly, cycles.quarterly, cycles.yearly].filter((value): value is number => value !== undefined);
    const invalid = typeof cycles.monthly !== "number"
      || !Number.isFinite(cycles.monthly) || cycles.monthly <= 0
      || cycles.monthly !== tier.monthlyFee
      || values.some(value => !Number.isFinite(value) || value <= 0);
    if (invalid) {
      diagnostics.push(catalogDiagnostic("PLAN_TIER_BILLING_CYCLES_INVALID", "plan-tier",
        `档位 ${tier.name} 的 billingCycles 非法（须含 monthly 且等于 monthlyFee、各值为正数）`, {target: `${catalogKey}/${tier.id ?? tier.name}`}));
      return false;
    }
    return true;
  });

  // ── 套餐通道无 Profile 的合法降级提示（规则 11 前半：crediting=unavailable）。
  const hasPlanChannel = provider.supportedBillingChannels?.includes("plan") ?? false;
  const planModelsExist = provider.models.some(model => model.planProfileRef !== undefined || model.planFactors !== undefined);
  if (hasPlanChannel && Object.keys(planProfiles).length === 0 && !planModelsExist) {
    diagnostics.push(catalogDiagnostic("PLAN_CHANNEL_WITHOUT_PROFILE", "provider",
      "套餐通道无逐请求积分公式（crediting=unavailable，合法状态）：账本不折算积分，真实成本走参考口径", {target: catalogKey}));
  }

  // ── presets[] 注册表联表校验（规则 13）：不一致只告警，展示回退注册表。
  for (const preset of provider.presets ?? []) {
    const registry = PROVIDER_PRESETS.find(item => item.id === preset.presetKey);
    if (!registry) {
      diagnostics.push(catalogDiagnostic("PRESET_REGISTRY_MISMATCH", "preset",
        `目录声明的预设 ${preset.presetKey} 在源码注册表不存在`, {target: `${catalogKey}/${preset.presetKey}`}));
      continue;
    }
    const mismatched: string[] = [];
    if (registry.billingChannel !== preset.billingChannel) mismatched.push(`通道 ${preset.billingChannel} ≠ 注册表 ${registry.billingChannel}`);
    if (preset.openaiUrl && registry.openaiUrl && normalizeUrl(preset.openaiUrl) !== normalizeUrl(registry.openaiUrl)) mismatched.push("openaiUrl 不一致");
    if (preset.anthropicUrl && registry.anthropicUrl && normalizeUrl(preset.anthropicUrl) !== normalizeUrl(registry.anthropicUrl)) mismatched.push("anthropicUrl 不一致");
    if (preset.billingChannel === "plan" && !preset.planSyncAdapter && registry.planSync?.kind === "adapter") mismatched.push("缺少 planSyncAdapter");
    if (mismatched.length > 0) {
      diagnostics.push(catalogDiagnostic("PRESET_REGISTRY_MISMATCH", "preset",
        `预设 ${preset.presetKey} 与注册表不一致：${mismatched.join("；")}`, {target: `${catalogKey}/${preset.presetKey}`}));
    }
  }

  return {
    campaigns,
    planTiers: planTiers.length > 0 ? planTiers : undefined,
    planProfiles: Object.keys(planProfiles).length > 0 ? planProfiles : undefined,
    diagnostics,
  };
}

function isZeroCreditMultiplier(effect: CatalogCampaign["effect"]): boolean {
  if (effect.kind !== "creditMultiplier") return false;
  const value = effect.value;
  return typeof value === "number" ? value === 0 : value.numerator === 0;
}

/** 同维度 override/terminal 活动的同优先级冲突：范围签名相同且时间区间实际重叠才算。 */
function detectOverrideConflicts(campaigns: CatalogCampaign[]): string[][] {
  const conflicts: string[][] = [];
  const overrideKinds = new Set(["priceOverride", "factorOverride", "freeWindow"]);
  const candidates = campaigns.filter(campaign => overrideKinds.has(campaign.effect.kind));
  for (let i = 0; i < candidates.length; i += 1) {
    for (let j = i + 1; j < candidates.length; j += 1) {
      const left = candidates[i]!;
      const right = candidates[j]!;
      if (EFFECT_REGISTRY[left.effect.kind].dimension !== EFFECT_REGISTRY[right.effect.kind].dimension) continue;
      if ((left.priority ?? 0) !== (right.priority ?? 0)) continue;
      if (scopeSignature(left) !== scopeSignature(right)) continue;
      if (!periodsOverlap(left, right)) continue;
      if (JSON.stringify(canonicalize(left.effect)) !== JSON.stringify(canonicalize(right.effect))) {
        conflicts.push([left.id, right.id]);
      }
    }
  }
  return conflicts;
}

/** period 左闭右开区间是否重叠（缺省 to = 无限期）。 */
function periodsOverlap(left: CatalogCampaign, right: CatalogCampaign): boolean {
  const leftStart = Date.parse(left.period.from);
  const rightStart = Date.parse(right.period.from);
  if (!Number.isFinite(leftStart) || !Number.isFinite(rightStart)) return true;
  const leftEnd = left.period.to !== undefined ? Date.parse(left.period.to) : Number.POSITIVE_INFINITY;
  const rightEnd = right.period.to !== undefined ? Date.parse(right.period.to) : Number.POSITIVE_INFINITY;
  return leftStart < rightEnd && rightStart < leftEnd;
}

function scopeSignature(campaign: CatalogCampaign): string {
  const scope = campaign.scope ?? {};
  return [
    [...(scope.models ?? [])].sort().join(","),
    [...(scope.agents ?? [])].sort().join(","),
    [...(scope.modelGroups ?? [])].sort().join(","),
    [...(scope.agentGroups ?? [])].sort().join(","),
  ].join("|");
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .map(([key, item]) => [key, canonicalize(item)] as [string, unknown])
    .sort((left, right) => left[0].localeCompare(right[0])));
}

function normalizeUrl(url: string): string {
  return url.trim().replace(/\/+$/u, "");
}
