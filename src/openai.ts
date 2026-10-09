import type { ContentBlock, TokenUsage } from "./types.js";
import type { SSEEvent } from "./sse.js";

export interface ParsedOpenAIResponse {
  content: ContentBlock[];
  model: string;
  usage?: TokenUsage;
  stopReason?: string;
}

export function openAIChunksToChatCompletionBody(
  events: SSEEvent[],
  fallbackModel = ""
): Record<string, unknown> {
  if (events.some(isResponsesAPIEvent)) {
    return openAIEventsToResponsesBody(events, fallbackModel);
  }

  const contentParts: string[] = [];
  const toolCalls = new Map<number, Record<string, unknown>>();
  let id = "";
  let model = fallbackModel;
  let finishReason: string | undefined;
  let usage: Record<string, unknown> | undefined;

  for (const event of events) {
    if (!isRecord(event.data)) continue;
    const data = event.data;
    if (typeof data.id === "string") id = data.id;
    if (typeof data.model === "string") model = data.model;
    if (isRecord(data.usage)) usage = data.usage;

    const choices = Array.isArray(data.choices) ? data.choices : [];
    for (const choice of choices) {
      if (!isRecord(choice)) continue;
      if (typeof choice.finish_reason === "string") finishReason = choice.finish_reason;
      if (!isRecord(choice.delta)) continue;

      const delta = choice.delta;
      if (typeof delta.content === "string") {
        contentParts.push(delta.content);
      }
      collectToolCallDeltas(toolCalls, delta.tool_calls);
    }
  }

  const message: Record<string, unknown> = {
    role: "assistant",
    content: contentParts.join(""),
  };
  const finalToolCalls = finalizeToolCalls(toolCalls);
  if (finalToolCalls.length > 0) message.tool_calls = finalToolCalls;

  const body: Record<string, unknown> = {
    id,
    object: "chat.completion",
    model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: finishReason || null,
      },
    ],
  };
  if (usage) body.usage = usage;
  return body;
}

export function parseOpenAIResponseBody(body: Record<string, unknown>): ParsedOpenAIResponse {
  if (body.object === "response" || Array.isArray(body.output)) {
    return parseResponsesAPIResponseBody(body);
  }

  const model = (body.model as string) || "";
  const choices = Array.isArray(body.choices) ? body.choices : [];
  const firstChoice = choices.find(isRecord) as Record<string, unknown> | undefined;
  const message = isRecord(firstChoice?.message) ? firstChoice.message : {};
  const stopReason = typeof firstChoice?.finish_reason === "string"
    ? firstChoice.finish_reason
    : undefined;

  return {
    content: parseOpenAIMessageContent(message),
    model,
    usage: parseOpenAIUsage(body.usage),
    stopReason,
  };
}

export function extractOpenAIRequestSummary(message: Record<string, unknown> | undefined): string {
  if (!message) return "(no user message)";
  return contentToText(message.content);
}

export function isOpenAIToolResultMessage(message: Record<string, unknown> | undefined): boolean {
  return message?.role === "tool";
}

function parseOpenAIMessageContent(message: Record<string, unknown>): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  const text = contentToText(message.content);
  if (text) blocks.push({ type: "text", text });

  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  for (const call of toolCalls) {
    if (!isRecord(call)) continue;
    const fn = isRecord(call.function) ? call.function : {};
    blocks.push({
      type: "tool_use",
      id: (call.id as string) || "",
      name: (fn.name as string) || "",
      input: parseArguments(fn.arguments),
    });
  }

  return blocks;
}

function openAIEventsToResponsesBody(
  events: SSEEvent[],
  fallbackModel: string
): Record<string, unknown> {
  let response: Record<string, unknown> = {
    object: "response",
    model: fallbackModel,
    output: [],
  };
  const outputItems = new Map<number, Record<string, unknown>>();
  const indexByItemId = new Map<string, number>();

  for (const event of events) {
    if (!isRecord(event.data)) continue;
    const data = event.data;
    const eventType = typeof data.type === "string" ? data.type : event.event;

    if (isRecord(data.response)) {
      response = { ...response, ...data.response };
      if (eventType === "response.completed" && Array.isArray(data.response.output)) {
        reconcileCompletedResponseOutput(
          outputItems,
          indexByItemId,
          data.response.output,
        );
      } else {
        collectResponseOutputItems(outputItems, indexByItemId, data.response.output);
      }
    }

    if (isRecord(data.item)) {
      const index = numberValue(data.output_index) ?? outputItems.size;
      mergeOutputItem(outputItems, indexByItemId, index, data.item);
    }

    if (isRecord(data.part)) {
      const item = ensureOutputItem(outputItems, indexByItemId, data.output_index, data.item_id);
      const contentIndex = numberValue(data.content_index) ?? 0;
      setContentPart(item, contentIndex, data.part);
    }

    if (eventType === "response.output_text.delta" && typeof data.delta === "string") {
      const item = ensureOutputItem(outputItems, indexByItemId, data.output_index, data.item_id);
      const contentIndex = numberValue(data.content_index) ?? 0;
      const part = ensureContentPart(item, contentIndex);
      part.type = "output_text";
      part.text = String(part.text || "") + data.delta;
      continue;
    }

    if (eventType === "response.output_text.done" && typeof data.text === "string") {
      const item = ensureOutputItem(outputItems, indexByItemId, data.output_index, data.item_id);
      const contentIndex = numberValue(data.content_index) ?? 0;
      const part = ensureContentPart(item, contentIndex);
      part.type = "output_text";
      part.text = data.text;
      continue;
    }

    if (eventType === "response.function_call_arguments.delta" && typeof data.delta === "string") {
      const item = ensureOutputItem(outputItems, indexByItemId, data.output_index, data.item_id);
      item.type = item.type || "function_call";
      item.arguments = String(item.arguments || "") + data.delta;
      continue;
    }

    if (eventType === "response.function_call_arguments.done" && typeof data.arguments === "string") {
      const item = ensureOutputItem(outputItems, indexByItemId, data.output_index, data.item_id);
      item.type = item.type || "function_call";
      item.arguments = data.arguments;
    }
  }

  if (outputItems.size > 0) {
    response.output = Array.from(outputItems.entries())
      .sort(([a], [b]) => a - b)
      .map(([, item]) => item);
  } else if (!Array.isArray(response.output)) {
    response.output = [];
  }

  return response;
}

function parseResponsesAPIResponseBody(body: Record<string, unknown>): ParsedOpenAIResponse {
  return {
    content: parseResponsesAPIOutput(body.output),
    model: (body.model as string) || "",
    usage: parseOpenAIUsage(body.usage),
    stopReason: typeof body.status === "string" ? body.status : undefined,
  };
}

function parseResponsesAPIOutput(output: unknown): ContentBlock[] {
  if (!Array.isArray(output)) return [];

  const blocks: ContentBlock[] = [];
  for (const item of output) {
    if (!isRecord(item)) continue;

    if (item.type === "message") {
      const text = contentToText(item.content);
      if (text) blocks.push({ type: "text", text });
      continue;
    }

    if (item.type === "function_call") {
      blocks.push({
        type: "tool_use",
        id: (item.call_id as string) || (item.id as string) || "",
        name: (item.name as string) || "",
        input: parseArguments(item.arguments),
      });
      continue;
    }

    if (item.type === "reasoning") {
      const thinking = responseReasoningToText(item.summary);
      if (thinking) blocks.push({ type: "thinking", thinking });
    }
  }

  return blocks;
}

function collectResponseOutputItems(
  outputItems: Map<number, Record<string, unknown>>,
  indexByItemId: Map<string, number>,
  output: unknown
): void {
  if (!Array.isArray(output)) return;
  output.forEach((item, index) => {
    if (isRecord(item)) mergeOutputItem(outputItems, indexByItemId, index, item);
  });
}

/**
 * `response.completed.output` 是最终权威列表，但部分中转服务会省略 reasoning，
 * 导致它的数组下标与早期 output_index 不一致。这里按稳定身份或类型匹配流式项，
 * 保留增量补全的字段，同时以终止事件的顺序和条数为准。
 */
function reconcileCompletedResponseOutput(
  outputItems: Map<number, Record<string, unknown>>,
  indexByItemId: Map<string, number>,
  output: unknown[],
): void {
  const streamedItems = [...outputItems.entries()]
    .sort(([left], [right]) => left - right);
  const consumedIndexes = new Set<number>();
  const completedItems = output.filter(isRecord).map(rawItem => {
    const match = findMatchingStreamedItem(
      streamedItems,
      consumedIndexes,
      rawItem,
    );
    if (match) consumedIndexes.add(match[0]);
    return mergeCanonicalOutputItem(match?.[1], rawItem);
  });

  outputItems.clear();
  indexByItemId.clear();
  completedItems.forEach((item, index) => {
    outputItems.set(index, item);
    if (typeof item.id === "string") indexByItemId.set(item.id, index);
  });
}

function findMatchingStreamedItem(
  streamedItems: Array<[number, Record<string, unknown>]>,
  consumedIndexes: Set<number>,
  rawItem: Record<string, unknown>,
): [number, Record<string, unknown>] | undefined {
  const identities = outputItemIdentities(rawItem);
  if (identities.length > 0) {
    const exact = streamedItems.find(([index, item]) =>
      !consumedIndexes.has(index)
      && outputItemIdentities(item).some(identity => identities.includes(identity))
    );
    if (exact) return exact;
  }

  return streamedItems.find(([index, item]) =>
    !consumedIndexes.has(index)
    && item.type === rawItem.type
    && rolesAreCompatible(item.role, rawItem.role)
  );
}

function outputItemIdentities(item: Record<string, unknown>): string[] {
  const identities: string[] = [];
  if (typeof item.id === "string" && item.id) identities.push(`id:${item.id}`);
  if (typeof item.call_id === "string" && item.call_id) {
    identities.push(`call:${item.call_id}`);
  }
  return identities;
}

function rolesAreCompatible(left: unknown, right: unknown): boolean {
  return typeof left !== "string"
    || typeof right !== "string"
    || left === right;
}

function mergeCanonicalOutputItem(
  streamedItem: Record<string, unknown> | undefined,
  rawItem: Record<string, unknown>,
): Record<string, unknown> {
  const item = { ...streamedItem, ...cloneOutputItem(rawItem) };
  if (Array.isArray(streamedItem?.content) && !Array.isArray(rawItem.content)) {
    item.content = streamedItem.content;
  }
  return item;
}

function mergeOutputItem(
  outputItems: Map<number, Record<string, unknown>>,
  indexByItemId: Map<string, number>,
  index: number,
  rawItem: Record<string, unknown>
): Record<string, unknown> {
  const existing = outputItems.get(index) || {};
  const item = { ...existing, ...cloneOutputItem(rawItem) };
  if (Array.isArray(existing.content) && !Array.isArray(rawItem.content)) {
    item.content = existing.content;
  }
  outputItems.set(index, item);
  if (typeof item.id === "string") indexByItemId.set(item.id, index);
  return item;
}

function ensureOutputItem(
  outputItems: Map<number, Record<string, unknown>>,
  indexByItemId: Map<string, number>,
  rawIndex: unknown,
  rawItemId: unknown
): Record<string, unknown> {
  const itemId = typeof rawItemId === "string" ? rawItemId : "";
  const index = numberValue(rawIndex) ?? (itemId ? indexByItemId.get(itemId) : undefined) ?? outputItems.size;
  const item = outputItems.get(index) || {
    id: itemId || undefined,
    type: "message",
    role: "assistant",
    content: [],
  };
  outputItems.set(index, item);
  if (itemId) {
    item.id = itemId;
    indexByItemId.set(itemId, index);
  }
  return item;
}

function setContentPart(item: Record<string, unknown>, index: number, rawPart: Record<string, unknown>): void {
  const content = Array.isArray(item.content) ? [...item.content] : [];
  content[index] = cloneContentPart(rawPart);
  item.content = content;
  item.type = item.type || "message";
  item.role = item.role || "assistant";
}

function ensureContentPart(item: Record<string, unknown>, index: number): Record<string, unknown> {
  const content = Array.isArray(item.content) ? [...item.content] : [];
  const existing = isRecord(content[index]) ? { ...content[index] } : {};
  content[index] = existing;
  item.content = content;
  item.type = item.type || "message";
  item.role = item.role || "assistant";
  return existing;
}

function cloneOutputItem(item: Record<string, unknown>): Record<string, unknown> {
  return {
    ...item,
    content: Array.isArray(item.content) ? item.content.map(cloneContentPart) : item.content,
  };
}

function cloneContentPart(part: unknown): unknown {
  return isRecord(part) ? { ...part } : part;
}

function responseReasoningToText(summary: unknown): string {
  if (!Array.isArray(summary)) return "";
  return summary
    .map(part => isRecord(part) && typeof part.text === "string" ? part.text : "")
    .filter(Boolean)
    .join("\n");
}

function collectToolCallDeltas(
  toolCalls: Map<number, Record<string, unknown>>,
  rawToolCalls: unknown
): void {
  if (!Array.isArray(rawToolCalls)) return;
  for (const rawCall of rawToolCalls) {
    if (!isRecord(rawCall)) continue;
    const index = typeof rawCall.index === "number" ? rawCall.index : toolCalls.size;
    const current = toolCalls.get(index) || { function: {} };
    if (typeof rawCall.id === "string") current.id = rawCall.id;
    if (typeof rawCall.type === "string") current.type = rawCall.type;

    const currentFn = isRecord(current.function) ? current.function : {};
    if (isRecord(rawCall.function)) {
      if (typeof rawCall.function.name === "string") currentFn.name = rawCall.function.name;
      if (typeof rawCall.function.arguments === "string") {
        currentFn.arguments = String(currentFn.arguments || "") + rawCall.function.arguments;
      }
    }
    current.function = currentFn;
    toolCalls.set(index, current);
  }
}

function finalizeToolCalls(toolCalls: Map<number, Record<string, unknown>>): Record<string, unknown>[] {
  return Array.from(toolCalls.entries())
    .sort(([a], [b]) => a - b)
    .map(([, call]) => call);
}

function parseOpenAIUsage(raw: unknown): TokenUsage | undefined {
  if (!isRecord(raw)) return undefined;
  const inputTokens = numberValue(raw.prompt_tokens) ?? numberValue(raw.input_tokens) ?? 0;
  const outputTokens = numberValue(raw.completion_tokens) ?? numberValue(raw.output_tokens) ?? 0;
  const totalTokens = numberValue(raw.total_tokens) ?? inputTokens + outputTokens;
  return { inputTokens, outputTokens, totalTokens };
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  const parts: string[] = [];
  for (const item of content) {
    if (!isRecord(item)) continue;
    if (item.type === "text" && typeof item.text === "string") {
      parts.push(item.text);
    } else if (item.type === "output_text" && typeof item.text === "string") {
      parts.push(item.text);
    } else if (item.type === "input_text" && typeof item.text === "string") {
      parts.push(item.text);
    } else if (item.type === "tool_result" && typeof item.content === "string") {
      parts.push(item.content);
    }
  }
  return parts.join("\n");
}

function parseArguments(value: unknown): Record<string, unknown> {
  if (isRecord(value)) return value;
  if (typeof value !== "string" || value.trim() === "") return {};
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : { value: parsed };
  } catch {
    return { _raw: value };
  }
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function isResponsesAPIEvent(event: SSEEvent): boolean {
  if (event.event.startsWith("response.")) return true;
  if (!isRecord(event.data)) return false;
  if (typeof event.data.type === "string" && event.data.type.startsWith("response.")) return true;
  return isRecord(event.data.response) && event.data.response.object === "response";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
