/**
 * 模型能力共享解析层（2026-09-21 能力下发重构）：全部消费面的唯一窗口/模态解析实现。
 *
 * 消费面：dsh/codex/opencode/zcode 适配器 + 开发启动弹窗（resolveModelCatalogDefaults）。
 * 任何消费面禁止自带解析链（AGENTS.md 规范红线）；新增能力字段在此扩链。
 *
 * 优先级（高 → 低）：
 * ① 用户编目覆盖 overrides[modelId]（蛇形兼容键 input_modalities / context_window / max_context_window）
 * ② 价格中心条目（target.pricing.modelVendors[modelId].priceEntryId 精确命中；
 *    人工/官方目录/litellm 来源均认——沿用开发启动弹窗 2026-09-03 确认的语义）
 * ③ 模板兜底链（families → defaults）。模板重构后该层只含产品级保守值
 *    （全局 272000/text、家族如 gpt-5.6 350000），等价于历史 resolveFallbackContextWindow
 *    的产品兜底语义——与目标是否官方预设无关，不设闸门（官方模型大窗口只存在于
 *    价格中心条目，第②级已按用户映射精确命中）。
 * ④ 代码常量兜底（272000 / ["text"]，模板结构异常时的最终安全网）
 */

import type {ProxyTarget} from "@/types";
import type {InputModality} from "@/types";
import type {ModelPriceEntry} from "@/lib/pricing";
import {isAnthropicFamilyModel, isOpenAiResponsesFamilyModel} from "@/lib/wire-api-infer";
import type {CatalogOverrides, CatalogTemplate} from "./catalog-template";
import {resolveTemplateCapabilityFallback} from "./catalog-template";

/** 代码常量兜底：模板结构缺字段时的最终安全网（与历史 resolveFallbackContextWindow 语义一致）。 */
export const FALLBACK_CONTEXT_WINDOW = 272_000;
export const FALLBACK_INPUT_MODALITIES: readonly InputModality[] = ["text"];

/** 单模型的运行时能力解析结果。 */
export interface ModelRuntimeCaps {
  /** 上下文窗口（token）；任何来源都无值时为 FALLBACK_CONTEXT_WINDOW。 */
  contextWindow: number;
  /** 输入模态（至少含 text；顺序与来源声明一致）。 */
  inputModalities: readonly InputModality[];
  /** 最大输出 token（可选；本期消费端不强制使用，供未来接入）。 */
  maxOutput?: number;
}

export interface ModelRuntimeCapsInput {
  target: ProxyTarget;
  modelId: string;
  /** 价格中心条目索引（按条目 id）；缺省 = 跳过②级（同步绝不因价格中心读取失败而失败）。 */
  pricingEntriesById?: ReadonlyMap<string, ModelPriceEntry>;
  template: CatalogTemplate;
  overrides: CatalogOverrides;
}

/** 模型能力共享解析入口：四级优先链唯一实现（详见文件头）。 */
export function resolveModelRuntimeCaps(input: ModelRuntimeCapsInput): ModelRuntimeCaps {
  const {target, modelId, template, overrides} = input;
  const modelOverride = overrides[modelId];

  // ① 用户编目覆盖（蛇形兼容键）。
  const overrideWindow = positiveSafeInteger(modelOverride?.context_window)
    ?? positiveSafeInteger(modelOverride?.max_context_window);
  const overrideModalities = asInputModalities(modelOverride?.input_modalities);

  // ② 价格中心条目（priceEntryId 精确命中）。
  const mapping = target.pricing?.modelVendors?.[modelId];
  const priceEntry = mapping?.priceEntryId
    ? input.pricingEntriesById?.get(mapping.priceEntryId.trim())
    : undefined;
  const priceWindow = positiveSafeInteger(priceEntry?.contextWindow);
  const priceModalities = asInputModalities(priceEntry?.inputModalities);
  const priceMaxOutput = positiveSafeInteger(priceEntry?.maxOutput);

  // ③ 模板兜底链（家族 → 全局）：产品级保守值，与目标是否官方预设无关（见文件头）。
  const templateFallback = resolveTemplateCapabilityFallback(modelId, template);

  const contextWindow = overrideWindow
    ?? priceWindow
    ?? templateFallback.contextWindow
    ?? FALLBACK_CONTEXT_WINDOW;
  const modalitiesSource = overrideModalities ?? priceModalities ?? templateFallback.inputModalities;
  const inputModalities = modalitiesSource && modalitiesSource.length > 0
    ? modalitiesSource
    : FALLBACK_INPUT_MODALITIES;
  const maxOutput = positiveSafeInteger(modelOverride?.max_output)
    ?? priceMaxOutput
    ?? templateFallbackMaxOutput(modelId, template);
  return {
    contextWindow,
    inputModalities,
    ...(maxOutput !== undefined ? {maxOutput} : {}),
  };
}

/** 模板家族/全局层当前不承载 maxOutput；保留挂点供未来声明（返回 undefined）。 */
function templateFallbackMaxOutput(_modelId: string, _template: CatalogTemplate): number | undefined {
  return undefined;
}

function positiveSafeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** 输入模态白名单解析：过滤非法值并去重；空/全非法 = undefined（视为该级未声明）。 */
function asInputModalities(value: unknown): readonly InputModality[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const modalities = [...new Set(value.filter((item): item is InputModality =>
    item === "text" || item === "image" || item === "audio"))];
  return modalities.length > 0 ? modalities : undefined;
}

/**
 * 默认推理档推断（共享，沿用历史 mergeCatalogEntry 语义）：anthropic / responses
 * 家族偏好 xhigh、其余 max；推断值必须落在模板档位表内，表内没有时回退表内最后一档
 * （最高档），避免 strict 消费方拒绝。
 */
export function resolveDefaultReasoningLevel(modelId: string, template: CatalogTemplate): string {
  const efforts = template.defaults.supportedReasoningLevels.map(level => level.effort);
  const preferred = isAnthropicFamilyModel(modelId) || isOpenAiResponsesFamilyModel(modelId)
    ? "xhigh"
    : "max";
  if (efforts.includes(preferred)) return preferred;
  return efforts[efforts.length - 1] ?? template.defaults.defaultReasoningLevel ?? "high";
}
