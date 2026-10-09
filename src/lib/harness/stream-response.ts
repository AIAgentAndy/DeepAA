import { sseEventsToMessageBody } from "../../anthropic";
import { openAIChunksToChatCompletionBody } from "../../openai";
import type { ProxyFormat } from "../../types";
import type { SSEEvent } from "../../sse";
import type { CapturedSseEvent, RawCapturedExchange } from "./types";

export interface TokenUsageSummary {
  inputTokens?: number;
  totalInputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  cacheCreation5mTokens?: number;
  cacheCreation1hTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
  source: "provider_usage" | "reconstructed_stream_usage" | "provider_count_tokens" | "tokenizer_estimated" | "heuristic_estimated" | "estimated" | "unavailable";
  usageConfidence: "exact" | "high" | "medium" | "low" | "unavailable";
  sourceLabel: string;
  note: string;
}

export function responseBodyForDisplay(exchange: RawCapturedExchange): unknown {
  if (exchange.response.parsedBody !== undefined) return exchange.response.parsedBody;
  const reconstructed = reconstructStreamingResponseBody(
    exchange.routing.targetFormatHint,
    exchange.stream?.events,
    modelFromRequestBody(exchange.request.parsedBody)
  );
  if (reconstructed !== undefined) return reconstructed;
  const parsedRaw = parseJsonBody(exchange.response.rawBody);
  if (parsedRaw !== undefined) return parsedRaw;
  if (exchange.response.rawBody) return exchange.response.rawBody;
  return exchange.stream?.events.map(event => event.data) ?? {};
}

export function responseEvidenceBodyForDisplay(exchange: RawCapturedExchange): unknown {
  const parsedRawBody = parseJsonBody(exchange.response.rawBody);
  const reconstructedBody = reconstructStreamingResponseBody(
    exchange.routing.targetFormatHint,
    exchange.stream?.events,
    modelFromRequestBody(exchange.request.parsedBody)
  );
  return {
    rawBody: exchange.response.isStreaming
      ? {
        kind: "sse_stream",
        storage: exchange.stream?.rawBodyStorage || exchange.response.rawBodyRef?.storage || "inline",
        sizeBytes: exchange.response.bodySizeBytes,
        eventCount: exchange.stream?.events.length || 0,
        preview: compactText(exchange.response.rawBody || "", 1200),
        note: "流式响应的 rawBody 是 SSE 原文，不是单个 JSON；完整原文见“完整原始响应文本”，逐事件结构见“SSE Events”。",
      }
      : parsedRawBody ?? exchange.response.rawBody,
    parsedBody: exchange.response.parsedBody,
    reconstructedBody,
    parseError: exchange.response.parseError,
    rawBodyRef: exchange.response.rawBodyRef,
  };
}

export function reconstructStreamingResponseBody(
  format: ProxyFormat,
  events: CapturedSseEvent[] | undefined,
  fallbackModel = ""
): Record<string, unknown> | undefined {
  if (!events || events.length === 0) return undefined;
  const legacyEvents = events.map(capturedSseEventToLegacyEvent);
  return format === "anthropic"
    ? sseEventsToMessageBody(legacyEvents, fallbackModel)
    : openAIChunksToChatCompletionBody(legacyEvents, fallbackModel);
}

export function tokenUsageFromExchange(exchange: RawCapturedExchange | undefined): TokenUsageSummary {
  if (!exchange) return unavailableTokenUsage("未选择请求。");
  const body = responseBodyForDisplay(exchange);
  const usage = extractTokenUsage(body);
  if (usage) {
    return {
      ...usage,
      source: "provider_usage",
      usageConfidence: "exact",
      sourceLabel: "服务商 usage",
      note: "来自服务商响应 usage 字段。请求 Token 包含 input_tokens、cache_read_input_tokens 和 cache_creation_input_tokens；OpenAI/GLM cached_tokens 按 prompt_tokens 子集扣除，DeepSeek/中转站 cache hit/miss 按命中/未命中拆分，Anthropic cache_read/cache_creation 按独立字段累加。",
    };
  }

  // 缺失 usage 时用 tokenizer 估算
  const estimated = estimateTokenUsage(exchange);
  if (estimated) {
    return {
      ...estimated,
      source: "tokenizer_estimated",
      usageConfidence: "medium",
      sourceLabel: "tokenizer 估算",
      note: "服务商响应中没有 usage 字段，使用 GPT tokenizer 估算。估算值仅供参考，可能与实际计费不同。",
    };
  }

  return unavailableTokenUsage("服务商响应中没有 usage 字段，且 tokenizer 估算失败。");
}

/**
 * 缺失 usage 时，用 GPT tokenizer 估算请求和响应的 token 数。
 * 估算策略：将请求体和响应体序列化为文本，用 BPE 分词器计数。
 */
function estimateTokenUsage(exchange: RawCapturedExchange): Omit<TokenUsageSummary, "source" | "sourceLabel" | "note" | "usageConfidence"> | undefined {
  try {
    const requestText = serializeForTokenCounting(exchange.request.parsedBody);
    const responseText = serializeForTokenCounting(responseBodyForDisplay(exchange));
    // 空请求和空响应（如 "{}"、""）不进行估算
    if (!hasEstimableContent(requestText) && !hasEstimableContent(responseText)) return undefined;
    const inputTokens = countTokens(requestText);
    const outputTokens = countTokens(responseText);
    if (inputTokens === 0 && outputTokens === 0) return undefined;
    return {
      inputTokens,
      totalInputTokens: inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
    };
  } catch {
    return undefined;
  }
}

/** 判断文本是否包含足够的内容用于 token 估算（排除空字符串、空对象、空数组等） */
function hasEstimableContent(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (trimmed === "{}" || trimmed === "[]" || trimmed === "null") return false;
  return trimmed.length > 3;
}

/** 将请求/响应体序列化为适合 token 计数的文本 */
function serializeForTokenCounting(body: unknown): string {
  if (body === undefined || body === null) return "";
  if (typeof body === "string") return body;
  try {
    return JSON.stringify(body);
  } catch {
    return String(body);
  }
}

/**
 * gpt-tokenizer 的 BPE 对超长文本（尤其重复字符）耗时呈超线性病态：
 * 实测 200KB 重复字符约需 83 秒，会同步阻塞 SQLite worker 事件循环并拖垮
 * 整个 web 服务；超过预算的文本直接按字符数粗略估算（约 4 字符/token），
 * 保证派生流程不被卡死。
 */
const MAX_TOKENIZER_INPUT_CHARS = 16_000;

/** 用 GPT tokenizer 计算 token 数，超长或不可用时退回字符数估算 */
function countTokens(text: string): number {
  if (!text) return 0;
  if (text.length > MAX_TOKENIZER_INPUT_CHARS) {
    return Math.ceil(text.length / 4);
  }
  try {
    const { encode } = require("gpt-tokenizer");
    return encode(text).length;
  } catch {
    // tokenizer 不可用时退回粗略估算：~4 字符/token
    return Math.ceil(text.length / 4);
  }
}

export function extractTokenUsage(value: unknown): Omit<TokenUsageSummary, "source" | "sourceLabel" | "note"> | undefined {
  const body = asRecord(value);
  if (!body) return undefined;
  const message = asRecord(body.message);
  const usageRecord = asRecord(body.usage) || asRecord(message?.usage);
  if (!usageRecord) return undefined;
  const rawInputTokens = numberValue(usageRecord.input_tokens ?? usageRecord.prompt_tokens);
  const outputTokens = numberValue(usageRecord.output_tokens ?? usageRecord.completion_tokens);
  const inputDetails = asRecord(usageRecord.input_tokens_details) || asRecord(usageRecord.prompt_tokens_details);
  const outputDetails = asRecord(usageRecord.output_tokens_details) || asRecord(usageRecord.completion_tokens_details);
  const nestedCachedTokens = numberValue(inputDetails?.cached_tokens);
  const promptCacheHitTokens = numberValue(usageRecord.prompt_cache_hit_tokens ?? usageRecord.cache_hit_tokens);
  const promptCacheMissTokens = numberValue(usageRecord.prompt_cache_miss_tokens ?? usageRecord.cache_miss_tokens);
  const topLevelCacheReadTokens = numberValue(usageRecord.cache_read_input_tokens) ?? promptCacheHitTokens;
  const cacheReadTokens = topLevelCacheReadTokens ?? nestedCachedTokens;
  const cacheCreation = asRecord(usageRecord.cache_creation);
  const cacheCreation5mTokens = numberValue(
    usageRecord.cache_creation_5m_input_tokens
      ?? usageRecord.cache_creation_5m_tokens
      ?? cacheCreation?.ephemeral_5m_input_tokens,
  );
  const cacheCreation1hTokens = numberValue(
    usageRecord.cache_creation_1h_input_tokens
      ?? usageRecord.cache_creation_1h_tokens
      ?? cacheCreation?.ephemeral_1h_input_tokens,
  );
  const cacheCreationTotal = numberValue(usageRecord.cache_creation_input_tokens);
  const cacheCreationTokens = cacheCreationTotal
    ?? (cacheCreation5mTokens !== undefined || cacheCreation1hTokens !== undefined
      ? (cacheCreation5mTokens ?? 0) + (cacheCreation1hTokens ?? 0)
      : undefined);
  const reasoningTokens = numberValue(outputDetails?.reasoning_tokens ?? usageRecord.reasoning_tokens);
  const nestedCachedIsInputSubset = nestedCachedTokens !== undefined && topLevelCacheReadTokens === undefined;
  const inputTokens = promptCacheMissTokens !== undefined
    ? promptCacheMissTokens
    : nestedCachedIsInputSubset && rawInputTokens !== undefined
      ? Math.max(rawInputTokens - nestedCachedTokens, 0)
      : rawInputTokens;
  const totalInputTokens = promptCacheMissTokens !== undefined || promptCacheHitTokens !== undefined
    ? sumDefined(promptCacheMissTokens, promptCacheHitTokens)
    : nestedCachedIsInputSubset
    ? rawInputTokens
    : sumDefined(inputTokens, cacheReadTokens, cacheCreationTokens);
  const totalTokens = numberValue(usageRecord.total_tokens) ?? (
    totalInputTokens !== undefined || outputTokens !== undefined ? (totalInputTokens || 0) + (outputTokens || 0) : undefined
  );
  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined) return undefined;
  return {
    inputTokens,
    totalInputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    cacheCreation5mTokens,
    cacheCreation1hTokens,
    reasoningTokens,
    totalTokens,
    usageConfidence: "exact",
  };
}

function sumDefined(...values: Array<number | undefined>): number | undefined {
  const definedValues = values.filter((value): value is number => value !== undefined);
  if (definedValues.length === 0) return undefined;
  return definedValues.reduce((sum, value) => sum + value, 0);
}

function capturedSseEventToLegacyEvent(event: CapturedSseEvent): SSEEvent {
  const legacy: SSEEvent = {
    event: event.event,
    data: event.data,
  };
  if (event.parseError) legacy.raw = event.rawData;
  return legacy;
}

function modelFromRequestBody(value: unknown): string {
  const body = asRecord(value);
  return typeof body?.model === "string" ? body.model : "";
}

function parseJsonBody(rawBody: string | undefined): unknown {
  if (!rawBody?.trim()) return undefined;
  try {
    return JSON.parse(rawBody);
  } catch {
    return undefined;
  }
}

function unavailableTokenUsage(note: string): TokenUsageSummary {
  return {
    source: "unavailable",
    usageConfidence: "unavailable",
    sourceLabel: "无法精确计算",
    note,
  };
}

function compactText(value: string, limit: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > limit ? `${normalized.slice(0, limit)}... (${normalized.length} chars)` : normalized;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
