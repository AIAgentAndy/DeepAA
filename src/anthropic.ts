import type { SSEEvent } from "./sse.js";

export function sseEventsToMessageBody(
  events: SSEEvent[],
  fallbackModel = ""
): Record<string, unknown> {
  const message: Record<string, unknown> = {
    type: "message",
    role: "assistant",
    model: fallbackModel,
    content: [],
  };
  const contentBlocks = new Map<number, Record<string, unknown>>();
  const usage: Record<string, number> = {};

  for (const event of events) {
    if (!event.data || typeof event.data !== "object") continue;
    const data = event.data as Record<string, unknown>;
    const eventType = (typeof data.type === "string" && data.type) || event.event;

    if (eventType === "message_start" && isRecord(data.message)) {
      Object.assign(message, data.message);
      if (!Array.isArray(message.content)) message.content = [];
      mergeUsage(usage, data.message.usage);
      continue;
    }

    if (eventType === "content_block_start") {
      const index = numberValue(data.index);
      if (index === null) continue;
      const block = isRecord(data.content_block) ? { ...data.content_block } : {};
      contentBlocks.set(index, block);
      continue;
    }

    if (eventType === "content_block_delta") {
      const index = numberValue(data.index);
      if (index === null || !isRecord(data.delta)) continue;
      const block = contentBlocks.get(index) || {};
      applyBlockDelta(block, data.delta);
      contentBlocks.set(index, block);
      continue;
    }

    if (eventType === "message_delta") {
      if (isRecord(data.delta) && typeof data.delta.stop_reason === "string") {
        message.stop_reason = data.delta.stop_reason;
      }
      mergeUsage(usage, data.usage);
    }
  }

  const content = Array.from(contentBlocks.entries())
    .sort(([a], [b]) => a - b)
    .map(([, block]) => finalizeBlock(block));
  message.content = content;

  if (Object.keys(usage).length > 0) {
    message.usage = usage;
  }

  return message;
}

function applyBlockDelta(block: Record<string, unknown>, delta: Record<string, unknown>): void {
  if (delta.type === "text_delta") {
    block.type = block.type || "text";
    block.text = String(block.text || "") + String(delta.text || "");
    return;
  }

  if (delta.type === "thinking_delta") {
    block.type = block.type || "thinking";
    block.thinking = String(block.thinking || "") + String(delta.thinking || "");
    return;
  }

  if (delta.type === "input_json_delta") {
    block.type = block.type || "tool_use";
    block._inputJson = String(block._inputJson || "") + String(delta.partial_json || "");
  }
}

function finalizeBlock(block: Record<string, unknown>): Record<string, unknown> {
  if (block.type === "tool_use" && typeof block._inputJson === "string") {
    const { _inputJson, ...rest } = block;
    try {
      return { ...rest, input: JSON.parse(_inputJson) };
    } catch {
      return { ...rest, input: { _raw: _inputJson } };
    }
  }
  return block;
}

function mergeUsage(target: Record<string, number>, raw: unknown): void {
  if (!isRecord(raw)) return;
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "number") target[key] = value;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}
