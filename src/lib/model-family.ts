/**
 * 模型家族判定（2026-09-21 能力下发重构）：共享纯函数。
 *
 * 供 Agent 目录模板的 families 兜底层与各家族化逻辑共用；
 * 家族口径与 wire-api-infer 的家族判定对齐（gpt/claude 前缀规则一致），
 * 但本模块只回答「属于哪个家族」，不掺协议语义。
 */

/** 模板 families 层支持的家族键；新增家族时同步在 catalog-template.json 声明兜底值。 */
export type ModelFamily =
  | "gpt-5.6"
  | "gpt"
  | "claude"
  | "glm"
  | "deepseek"
  | "kimi"
  | "minimax"
  | "qwen"
  | "grok"
  | "hunyuan"
  | "doubao";

/** 按模型 ID 判定家族；无法识别时返回 undefined（消费方走全局兜底）。 */
export function modelFamilyOf(modelId: string): ModelFamily | undefined {
  const model = modelId.trim().toLowerCase();
  if (!model) return undefined;
  // 顺序敏感：更具体的前缀优先（gpt-5.6 先于 gpt；openrouter 风格命名空间前缀先剥再判）。
  const bare = model.includes("/") ? model.slice(model.indexOf("/") + 1) : model;
  if (/^gpt-5\.6/.test(bare)) return "gpt-5.6";
  if (/^(gpt-|o[1-9](?:[-.]|$))/.test(bare)) return "gpt";
  if (/^(claude-|anthropic)/.test(bare)) return "claude";
  if (/^glm-/.test(bare)) return "glm";
  if (/^deepseek/.test(bare)) return "deepseek";
  if (/^kimi/.test(bare)) return "kimi";
  if (/^minimax-/.test(bare)) return "minimax";
  if (/^qwen/.test(bare)) return "qwen";
  if (/^grok/.test(bare)) return "grok";
  if (/^hunyuan/.test(bare)) return "hunyuan";
  if (/^doubao/.test(bare)) return "doubao";
  return undefined;
}

/** 家族父链：具体家族缺省字段时沿上级家族回退（如 gpt-5.6 → gpt）。 */
export function familyParentOf(family: ModelFamily): ModelFamily | undefined {
  switch (family) {
    case "gpt-5.6": return "gpt";
    default: return undefined;
  }
}
