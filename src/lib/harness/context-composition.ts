/**
 * Harness 证据层：上下文构成估算与校准（一期决策 D2）。
 *
 * 原始抓包只有哈希/计数，无 token 级构成真值；本模块按字符估算（见 text-estimate.ts），
 * 并在响应 usage 可用时按实际 input(+cache_read) 总量等比校准。
 * 红线：估算结果仅用于构成参考展示，绝不写入 usage_ledger、绝不参与计价。
 */

import type { NormalizedExchange } from "./normalizer";
import type { HarnessEvidence } from "./evidence";
import { partitionInputText } from "./evidence";
import { estimateTokens } from "./text-estimate";

export interface CompositionChars {
  system: number;
  developer: number;
  toolsNonMcp: number;
  mcp: number;
  skills: number;
  rules: number;
  conversation: number;
  toolResults: number;
  other: number;
}

export interface ContextComposition {
  chars: CompositionChars;
  estTokens: CompositionChars;
  /** usage 可用时按实际 input(+cache_read) 等比校准后的分量。 */
  calibratedTokens?: CompositionChars;
  calibration?: {
    actualInputTokens: number;
    scale: number;
    usageSource: string;
  };
}

interface CharBucket {
  chars: number;
  estTokens: number;
}

type BucketMap = Record<keyof CompositionChars, CharBucket>;

function emptyBuckets(): BucketMap {
  return {
    system: { chars: 0, estTokens: 0 },
    developer: { chars: 0, estTokens: 0 },
    toolsNonMcp: { chars: 0, estTokens: 0 },
    mcp: { chars: 0, estTokens: 0 },
    skills: { chars: 0, estTokens: 0 },
    rules: { chars: 0, estTokens: 0 },
    conversation: { chars: 0, estTokens: 0 },
    toolResults: { chars: 0, estTokens: 0 },
    other: { chars: 0, estTokens: 0 },
  };
}

function addText(bucket: CharBucket, text: string | undefined): void {
  if (!text) return;
  bucket.chars += text.length;
  bucket.estTokens += estimateTokens(text);
}

/**
 * 注入文本块（可能包含 skills 段 / permissions 段 / env 段 / AGENTS.md 头）：
 * 按 partitionInputText 的 span 字符占比分摊整段文本的 token 估算，
 * 保证各分类估算之和等于整段文本的直接估算值。
 */
function partitionTextInto(
  buckets: BucketMap,
  text: string,
  projectKey: string | undefined,
  remainder: "conversation" | "developer" | "other",
): void {
  const partition = partitionInputText(text, projectKey);
  const totalChars = partition.skillsChars + partition.rulesChars + partition.envChars + partition.conversationChars;
  const totalTokens = estimateTokens(text);
  const allocate = (spanChars: number) => totalChars > 0
    ? Math.round(totalTokens * (spanChars / totalChars))
    : 0;
  buckets.skills.chars += partition.skillsChars;
  buckets.skills.estTokens += allocate(partition.skillsChars);
  buckets.rules.chars += partition.rulesChars;
  buckets.rules.estTokens += allocate(partition.rulesChars);
  buckets.other.chars += partition.envChars;
  buckets.other.estTokens += allocate(partition.envChars);
  const remainderBucket = buckets[remainder];
  remainderBucket.chars += partition.conversationChars;
  remainderBucket.estTokens += allocate(partition.conversationChars);
}

/** 从规范化交换中采集八类构成分量（字符量 + 估算 token）。 */
export function collectCompositionChars(
  normalized: NormalizedExchange,
  evidence: HarnessEvidence,
): { chars: CompositionChars; estTokens: CompositionChars } {
  const buckets = emptyBuckets();
  const projectKey = evidence.projectKey;

  for (const block of normalized.request.systemBlocks) {
    addText(buckets.system, block.text);
  }
  // codex 的 system 提示词在 `instructions` 字段（不进入 systemBlocks），按系统分量计。
  if (typeof normalized.request.params.instructions === "string") {
    addText(buckets.system, normalized.request.params.instructions);
  }
  for (const message of normalized.request.messages) {
    const remainder = message.providerRole === "developer" ? "developer" : "conversation";
    for (const block of message.content) {
      if (block.type === "tool_result") {
        addText(buckets.toolResults, block.text);
        continue;
      }
      if (typeof block.text !== "string" || !block.text) continue;
      partitionTextInto(buckets, block.text, projectKey, remainder);
    }
  }
  for (const item of normalized.request.inputItems) {
    if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
      for (const block of item.content) addText(buckets.toolResults, block.text);
      continue;
    }
    if (item.type === "reasoning" || item.type === "custom_tool_call") {
      for (const block of item.content) addText(buckets.other, block.text);
      continue;
    }
    for (const block of item.content) {
      if (block.type === "tool_result") {
        addText(buckets.toolResults, block.text);
        continue;
      }
      if (typeof block.text !== "string" || !block.text) continue;
      partitionTextInto(buckets, block.text, projectKey, "conversation");
    }
  }
  // 工具定义：normalizer 已按原始 JSON 记录 schemaChars 与 schemaTokensEst。
  for (const schema of normalized.request.toolSchemas) {
    const bucket = schema.kind === "mcp" ? buckets.mcp : buckets.toolsNonMcp;
    bucket.chars += schema.schemaChars;
    bucket.estTokens += schema.schemaTokensEst;
  }
  // skills/rules/env 已在 partitionTextInto 中按 span 计入，不重复累加 evidence 字符量。

  const chars = {} as CompositionChars;
  const estTokens = {} as CompositionChars;
  for (const key of Object.keys(buckets) as Array<keyof CompositionChars>) {
    chars[key] = buckets[key].chars;
    estTokens[key] = buckets[key].estTokens;
  }
  return { chars, estTokens };
}

/** 组装含校准结果的完整构成对象；usage 缺失时只返回估算（前端降置信展示）。 */
export function contextCompositionFor(
  normalized: NormalizedExchange,
  evidence: HarnessEvidence,
): ContextComposition {
  const { chars, estTokens } = collectCompositionChars(normalized, evidence);
  const composition: ContextComposition = { chars, estTokens };
  const usage = normalized.response.usage;
  const actualInputTokens = usage?.inputTokens !== undefined
    ? usage.inputTokens + (usage.cacheReadTokens ?? 0)
    : undefined;
  const estimatedTotal = Object.values(estTokens).reduce((sum, value) => sum + value, 0);
  if (actualInputTokens !== undefined && actualInputTokens > 0 && estimatedTotal > 0) {
    const scale = actualInputTokens / estimatedTotal;
    const calibratedTokens = {} as CompositionChars;
    for (const key of Object.keys(estTokens) as Array<keyof CompositionChars>) {
      calibratedTokens[key] = Math.round(estTokens[key] * scale);
    }
    // 取整漂移吸收：差额计入估算占比最大的分量，保证校准合计严格等于实际值。
    const drift = actualInputTokens
      - (Object.keys(calibratedTokens) as Array<keyof CompositionChars>)
        .reduce((sum, key) => sum + calibratedTokens[key], 0);
    if (drift !== 0) {
      let largestKey: keyof CompositionChars = "conversation";
      for (const key of Object.keys(estTokens) as Array<keyof CompositionChars>) {
        if (estTokens[key] > estTokens[largestKey]) largestKey = key;
      }
      calibratedTokens[largestKey] += drift;
    }
    composition.calibratedTokens = calibratedTokens;
    composition.calibration = {
      actualInputTokens,
      scale: Number(scale.toFixed(6)),
      usageSource: usage?.source ?? "exact",
    };
  }
  return composition;
}

/** Harness 定义类（tools/mcp/skills/rules）的构成小计，供 Harness 页签展示。 */
export function harnessDefinitionTotals(composition: ContextComposition): {
  chars: CompositionChars;
  tokens: CompositionChars;
  totalTokens: number;
  calibrated: boolean;
} {
  const keys: Array<keyof CompositionChars> = ["toolsNonMcp", "mcp", "skills", "rules"];
  const source = composition.calibratedTokens ?? composition.estTokens;
  const tokens = {} as CompositionChars;
  const chars = {} as CompositionChars;
  let totalTokens = 0;
  for (const key of keys) {
    tokens[key] = source[key];
    chars[key] = composition.chars[key];
    totalTokens += source[key];
  }
  for (const key of Object.keys(composition.chars) as Array<keyof CompositionChars>) {
    if (!keys.includes(key)) {
      tokens[key] = 0;
      chars[key] = 0;
    }
  }
  return { chars, tokens, totalTokens, calibrated: composition.calibratedTokens !== undefined };
}
