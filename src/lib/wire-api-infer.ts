import type {WireApi} from "@/types";

/**
 * 自定义供应商（无官方预设注册表）的模型 wire API 推断。
 *
 * 目录供应商创建时会落库 supportedModelWireApis；自定义供应商没有预设级能力声明，
 * 只能按「模型家族 × 供应商协议 URL」推断，家族优先于 URL：
 * - Claude 家族（claude-* / anthropic/*）只经 Anthropic Messages 端点服务：
 *   填了 anthropicUrl → messages；没填则无法服务（openaiUrl 不为其推断 chat/responses）
 * - OpenAI Responses 家族（gpt-* 与 o 系列）只走 Responses 端点（Codex 2026-02 起仅
 *   支持 Responses，Claude Code 也无法经 /v1/messages 调用 GPT 模型）：
 *   填了 openaiUrl → responses；没填则无法服务（anthropicUrl 不为其推断 messages）
 * - 其余家族（glm、kimi、deepseek、grok、qwen 等双协议家族）：
 *   openaiUrl → chat_completions，anthropicUrl → messages（双 URL 时两者都有）
 * - 推断结果为空 → []（默认拒绝）
 *
 * UI 候选过滤与网关对无声明模型的路由兜底共用本函数，保证「不列出 = 不可路由」。
 */
export function inferCustomTargetModelWireApis(
  modelId: string,
  target: {openaiUrl?: string; anthropicUrl?: string},
): WireApi[] {
  const wireApis = new Set<WireApi>();
  if (isAnthropicFamilyModel(modelId)) {
    if (target.anthropicUrl?.trim()) wireApis.add("messages");
    return [...wireApis];
  }
  const responsesFamily = isOpenAiResponsesFamilyModel(modelId);
  if (target.openaiUrl?.trim()) {
    wireApis.add(responsesFamily ? "responses" : "chat_completions");
  }
  // 只有当模型家族与端点语义匹配时才叠加 messages：双 URL 目标不再让
  // GPT/o 系列凭空获得 messages 能力（Claude Code 因此误可选、可路由）。
  if (!responsesFamily && target.anthropicUrl?.trim()) wireApis.add("messages");
  return [...wireApis];
}

/** OpenAI Responses 家族模型：gpt-* 与 o 系列（与模型发现的供应商家族推断同规则）。 */
export function isOpenAiResponsesFamilyModel(modelId: string): boolean {
  const model = modelId.trim().toLowerCase();
  return /^(gpt-|o[1-9](?:[-.]|$)|o[1-9][a-z0-9]*(?:[-.]|$))/.test(model);
}

/** Anthropic 家族模型：claude-* 与 openrouter 风格的 anthropic/* 前缀。 */
export function isAnthropicFamilyModel(modelId: string): boolean {
  const model = modelId.trim().toLowerCase();
  return /^(claude-|anthropic\/)/.test(model);
}
