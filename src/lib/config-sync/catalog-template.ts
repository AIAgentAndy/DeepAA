/**
 * Agent 目录模板（2026-09-21 重构）：纯手写的「Agent 产品配置与兜底默认」，
 * 零模型条目、不从 llm_catalog 生成（守护测试锁死职责边界）。
 *
 * 三层结构：
 * - defaults：全局兜底（上下文窗口 / 输入模态 / 推理档位表）——模型事实的最终安全网；
 * - families：模型家族级兜底（按 src/lib/model-family.ts 判定家族）；
 * - agents.{agent}：Agent 维度产品配置（内部使用该 Agent 配置文件的原生字段形状，
 *   目前 codex 有内容；dsh/opencode/zcode 为扩展位）。模型能力真相在价格中心
 *   （config-sync/model-capabilities.ts 共享解析层），本模板不承载模型事实。
 *
 * 数据流：价格中心条目 → 解析层（families → defaults 兜底）→ 适配器映射 → CLI 配置。
 * 用户覆盖（catalog-overrides.json，按模型 ID 的字段级覆盖）为最高优先级兼容位。
 */

import {readFile} from "node:fs/promises";
import {join} from "node:path";
import {resolveDeepaaDataDir} from "@/lib/data-paths";
import type {InputModality} from "@/types";
import {modelFamilyOf, familyParentOf, type ModelFamily} from "@/lib/model-family";

/** 项目级模板文件路径（版本控制，随项目发布；手写维护）。 */
export function defaultTemplatePath(projectRoot?: string): string {
  const root = projectRoot || process.cwd();
  return join(root, "config", "agents", "catalog-template.json");
}

/** 用户级覆盖文件路径（运行时，不版本控制；历史 codex-catalog-overrides.json 兼容读取）。 */
export function defaultOverridesPath(): string {
  return join(resolveDeepaaDataDir(), "config", "catalog-overrides.json");
}

/** 中立兜底字段：全局 defaults 与 families 层共用的形状（字段均可缺省）。 */
export interface TemplateCapabilityDefaults {
  contextWindow?: number;
  inputModalities?: InputModality[];
}

/** 推理档位表条目（与 Codex supported_reasoning_levels 同构，全部 Agent 共用）。 */
export interface TemplateReasoningLevel {
  effort: string;
  description: string;
}

/** Agent 维度产品配置：defaults 为该 Agent 全模型默认，families 为家族级覆盖（浅合并）。 */
export interface TemplateAgentConfig {
  defaults?: Record<string, unknown>;
  families?: Record<string, Record<string, unknown>>;
}

/** 模板文件结构（零模型条目；结构校验见 readCatalogTemplate）。 */
export interface CatalogTemplate {
  defaults: TemplateCapabilityDefaults & {
    supportedReasoningLevels: TemplateReasoningLevel[];
    defaultReasoningLevel?: string;
  };
  families: Partial<Record<ModelFamily, TemplateCapabilityDefaults>>;
  agents: Record<string, TemplateAgentConfig>;
}

/** 用户覆盖：按模型 ID 索引，只存被修改的字段（历史编辑器产物 / 手工编辑兼容位）。 */
export type CatalogOverrides = Record<string, Record<string, unknown>>;

/** 读取并校验项目级模板文件（结构错误直接抛出，宁可失败也不带病兜底）。 */
export async function readCatalogTemplate(templatePath: string): Promise<CatalogTemplate> {
  const raw = await readFile(templatePath, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Catalog template invalid: not an object at ${templatePath}`);
  }
  const template = parsed as Partial<CatalogTemplate>;
  if (!template.defaults || typeof template.defaults !== "object"
    || !Array.isArray(template.defaults.supportedReasoningLevels)
    || template.defaults.supportedReasoningLevels.length === 0
    || template.defaults.supportedReasoningLevels.some(level =>
      !level || typeof level !== "object" || typeof level.effort !== "string" || !level.effort.trim())) {
    throw new Error(`Catalog template invalid: defaults.supportedReasoningLevels 缺失或为空 at ${templatePath}`);
  }
  if (template.defaults.contextWindow !== undefined
    && !(Number.isSafeInteger(template.defaults.contextWindow) && template.defaults.contextWindow > 0)) {
    throw new Error(`Catalog template invalid: defaults.contextWindow 必须为正整数 at ${templatePath}`);
  }
  if (!template.families || typeof template.families !== "object" || Array.isArray(template.families)) {
    throw new Error(`Catalog template invalid: missing families at ${templatePath}`);
  }
  for (const [family, value] of Object.entries(template.families)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`Catalog template invalid: families.${family} 必须为对象 at ${templatePath}`);
    }
    if (value.contextWindow !== undefined
      && !(Number.isSafeInteger(value.contextWindow) && value.contextWindow > 0)) {
      throw new Error(`Catalog template invalid: families.${family}.contextWindow 必须为正整数 at ${templatePath}`);
    }
  }
  if (!template.agents || typeof template.agents !== "object" || Array.isArray(template.agents)) {
    throw new Error(`Catalog template invalid: missing agents at ${templatePath}`);
  }
  for (const [agent, config] of Object.entries(template.agents)) {
    if (!config || typeof config !== "object" || Array.isArray(config)) {
      throw new Error(`Catalog template invalid: agents.${agent} 必须为对象 at ${templatePath}`);
    }
  }
  return template as CatalogTemplate;
}

/** 读取用户覆盖文件；不存在或损坏时返回空对象（兼容位，绝不阻断同步）。 */
export async function readCatalogOverrides(overridesPath: string): Promise<CatalogOverrides> {
  try {
    const raw = await readFile(overridesPath, "utf8");
    const parsed = JSON.parse(raw) as CatalogOverrides;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed;
  } catch {
    return {};
  }
}

/**
 * Agent 产品位组装：agents.{agent}.defaults 深合并 agents.{agent}.families[family]
 * （家族值逐字段覆盖顶层默认；对象值递归合并，数组与标量整体替换）。
 * 模型家族由 modelFamilyOf 判定；未知家族只返回 defaults。
 */
export function resolveAgentProductConfig(
  agent: string,
  modelId: string,
  template: CatalogTemplate,
): Record<string, unknown> {
  const config = template.agents[agent];
  if (!config) return {};
  const base = config.defaults ?? {};
  // Agent 产品位家族覆盖只取具体家族（不沿父链回退：行为位是显式产品决策，
  // 上级家族默认可能语义不符，如 gpt-5.6 的 code_mode_only 不应波及 gpt-5.5）。
  const family = modelFamilyOf(modelId);
  const familyOverrides = family ? config.families?.[family] : undefined;
  if (!familyOverrides) return {...base};
  return deepMergeProduct(base, familyOverrides);
}

/**
 * 解析模板能力兜底链（具体家族 → 上级家族 → 全局）；逐字段独立回退，
 * 调用方按需取用。家族链见 familyParentOf（如 gpt-5.6 缺省模态时回退 gpt 家族）。
 */
export function resolveTemplateCapabilityFallback(
  modelId: string,
  template: CatalogTemplate,
): TemplateCapabilityDefaults {
  const familyChain: ModelFamily[] = [];
  for (let family = modelFamilyOf(modelId); family && !familyChain.includes(family); family = familyParentOf(family)) {
    familyChain.push(family);
  }
  const pick = <K extends keyof TemplateCapabilityDefaults>(key: K): TemplateCapabilityDefaults[K] => {
    for (const family of familyChain) {
      const value = template.families[family]?.[key];
      if (value !== undefined) return value;
    }
    return template.defaults[key];
  };
  return {
    ...(pick("contextWindow") !== undefined ? {contextWindow: pick("contextWindow")} : {}),
    ...(pick("inputModalities") !== undefined ? {inputModalities: pick("inputModalities")} : {}),
  };
}

function deepMergeProduct(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {...base};
  for (const [key, value] of Object.entries(override)) {
    const baseValue = result[key];
    if (baseValue && typeof baseValue === "object" && !Array.isArray(baseValue)
      && value && typeof value === "object" && !Array.isArray(value)) {
      result[key] = deepMergeProduct(baseValue as Record<string, unknown>, value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }
  return result;
}
