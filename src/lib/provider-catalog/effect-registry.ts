/**
 * Effect Dimension 注册表（设计 4.6/10.3）：effect.kind → 内部维度/操作/作用链/固定阶段的
 * 唯一静态映射。JSONL 不暴露 dimension，所有冲突/叠加规则从这里派生。
 *
 * 第一期只启用 4 种 kind（2026-09-10 分期决策）：priceOverride / factorOverride /
 * creditMultiplier / freeWindow；其余 5 种属于契约前向定义，编译期按「未知动作」整条隔离，
 * 诊断明确说明属第二期能力（v2-2 文档）。
 */
import type {CampaignChannel, CampaignEffect} from "./types";

export type EffectDimension =
  | "rateOverride"
  | "rateMultiplier"
  | "modelFactorOverride"
  | "creditMultiplier"
  | "quotaMultiplier"
  | "quotaAdd"
  | "toolCredit"
  | "freeTerminal"
  | "finalCap";

export type EffectOperator = "unique-override" | "multiply" | "add" | "terminal-zero" | "per-event" | "cap";

export type EffectLane = Extract<CampaignChannel, "payg" | "plan">;

export interface EffectSpec {
  dimension: EffectDimension;
  operator: EffectOperator;
  lane: EffectLane;
  /** 固定合成阶段序号（同链内从小到大执行）。 */
  stage: number;
  /** true=第一期运行时已实现；false=契约前向定义，出现即隔离。 */
  phase1Enabled: boolean;
}

export const EFFECT_REGISTRY: Readonly<Record<CampaignEffect["kind"], EffectSpec>> = {
  priceOverride: {dimension: "rateOverride", operator: "unique-override", lane: "payg", stage: 30, phase1Enabled: true},
  priceMultiplier: {dimension: "rateMultiplier", operator: "multiply", lane: "payg", stage: 40, phase1Enabled: false},
  factorOverride: {dimension: "modelFactorOverride", operator: "unique-override", lane: "plan", stage: 20, phase1Enabled: true},
  creditMultiplier: {dimension: "creditMultiplier", operator: "multiply", lane: "plan", stage: 40, phase1Enabled: true},
  quotaMultiplier: {dimension: "quotaMultiplier", operator: "multiply", lane: "plan", stage: 60, phase1Enabled: false},
  quotaAdd: {dimension: "quotaAdd", operator: "add", lane: "plan", stage: 61, phase1Enabled: false},
  fixedToolCredit: {dimension: "toolCredit", operator: "per-event", lane: "plan", stage: 70, phase1Enabled: false},
  freeWindow: {dimension: "freeTerminal", operator: "terminal-zero", lane: "plan", stage: 80, phase1Enabled: true},
  cap: {dimension: "finalCap", operator: "cap", lane: "plan", stage: 90, phase1Enabled: false},
};

/** 第一期启用的 effect.kind 集合（compile/静态校验消费）。 */
export const PHASE1_ENABLED_EFFECT_KINDS: ReadonlySet<CampaignEffect["kind"]> = new Set(
  (Object.keys(EFFECT_REGISTRY) as CampaignEffect["kind"][]).filter(kind => EFFECT_REGISTRY[kind].phase1Enabled),
);

/** effect.kind 与活动通道的一致性：kind 的作用链必须与 campaign.channel 匹配。 */
export function effectLaneMatchesChannel(kind: CampaignEffect["kind"], channel: CampaignChannel): boolean {
  // subscription 通道第一期一律不支持任何活动（SUBSCRIPTION_CAMPAIGN_UNSUPPORTED）。
  if (channel === "subscription") return false;
  return EFFECT_REGISTRY[kind].lane === channel;
}

/** 同维度 override 类效果的选胜规则：同优先级不同值=冲突；高优先级唯一胜出。 */
export function resolvesOverrideConflict(
  candidate: {priority: number; signature: string},
  incumbent: {priority: number; signature: string} | undefined,
): "win" | "lose" | "conflict" {
  if (!incumbent) return "win";
  if (candidate.priority > incumbent.priority) return "win";
  if (candidate.priority < incumbent.priority) return "lose";
  return candidate.signature === incumbent.signature ? "lose" : "conflict";
}
