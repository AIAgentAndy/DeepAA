/**
 * 开发启动窗口兜底策略：官方目录/用户覆盖优先，只有缺失能力声明时才使用这里的默认值。
 * GPT-5.6-* 是项目已在 Sub2API/New API 中转链路实测过的特殊模型族，采用更大兜底窗口；
 * 该值只代表本产品的启动默认，不宣称所有上游都支持同样大小。
 */
export const DEFAULT_CONTEXT_WINDOW = 272_000;
/** 2026-09-01 用户修正：gpt-5.6 系默认 350K（此前误配 3.5M）。 */
export const GPT56_CONTEXT_WINDOW = 350_000;
export const AUTO_COMPACT_CONTEXT_PERCENT = 0.95;

const GPT56_MODEL_PATTERN = /^gpt-5\.6-[a-z0-9][a-z0-9._-]*$/iu;

export function resolveFallbackContextWindow(modelId: string): number {
  return GPT56_MODEL_PATTERN.test(modelId.trim()) ? GPT56_CONTEXT_WINDOW : DEFAULT_CONTEXT_WINDOW;
}

export function resolveAutoCompactTokenLimit(contextWindow: number): number {
  return Math.floor(contextWindow * AUTO_COMPACT_CONTEXT_PERCENT);
}
