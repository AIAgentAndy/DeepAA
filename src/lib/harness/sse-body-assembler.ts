/**
 * 流式 SSE 响应体的增量装配器（纯函数、无 I/O）。
 *
 * 为什么存在：projectSse 曾把 anthropic 的 message_start 首帧（content: []）或
 * chat 的首 chunk 直接当作投影 body，写入 parsedBody 后 normalizeResponse 拿不到
 * content/tool_calls/stop_reason（派生层 tool_calls 全空、response_action=unknown，
 * 2026-09-11 五 Agent 实测定位）。装配器在事件循环内逐事件累积完整响应 body；
 * 循环天然遍历全部事件，不受 retainSseSample 采样上限影响。
 *
 * 语义与 src/anthropic.ts 的 sseEventsToMessageBody、src/openai.ts 的
 * openAIChunksToChatCompletionBody 保持一致，由 tests/sse-body-assembler.test.ts
 * 的一致性用例锁定，防止两套实现漂移。
 *
 * 预算保护：追加型文本（text/thinking/partial_json/tool arguments）计入字节预算，
 * 超限后停止追加、保留结构字段（块类型、工具名、stop_reason、finish_reason），
 * truncated 暴露给调用方附加诊断码；绝不因单条超大响应放大投影内存。
 */

export interface SseBodyAssembler {
  push(eventType: string, record: Record<string, unknown>): void;
  /** 无任何可识别事件时返回 undefined，调用方回落既有兜底逻辑。 */
  finalize(): Record<string, unknown> | undefined;
  wasTruncated(): boolean;
}

export const DEFAULT_SSE_BODY_ASSEMBLY_BUDGET_BYTES = 4 * 1024 * 1024;

/** SSE 装配 body 截断的诊断码（diagnostics 集合自由文本）。 */
export const SSE_BODY_ASSEMBLY_TRUNCATED_CODE = "sse_body_assembly_truncated";

export function createSseBodyAssemblerForProtocol(
  protocol: string | undefined,
  options: { maxBodyBytes?: number } = {},
): SseBodyAssembler | undefined {
  if (protocol === "anthropic-messages") return createAnthropicSseBodyAssembler(options);
  if (protocol === "openai-chat-completions") return createChatSseBodyAssembler(options);
  return undefined;
}

export function createAnthropicSseBodyAssembler(
  options: { maxBodyBytes?: number } = {},
): SseBodyAssembler {
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_SSE_BODY_ASSEMBLY_BUDGET_BYTES;
  let budgetUsed = 0;
  let truncated = false;
  let sawMessageStart = false;
  const message: Record<string, unknown> = {type: "message", role: "assistant", content: []};
  const blocks = new Map<number, Record<string, unknown>>();
  let stopReason: string | undefined;

  function appendBudgeted(text: string): boolean {
    if (truncated) return false;
    if (budgetUsed + text.length > maxBodyBytes) {
      truncated = true;
      return false;
    }
    budgetUsed += text.length;
    return true;
  }

  function applyDelta(block: Record<string, unknown>, delta: Record<string, unknown>): void {
    if (delta.type === "text_delta") {
      const text = String(delta.text || "");
      if (appendBudgeted(text)) {
        block.type = block.type || "text";
        block.text = String(block.text || "") + text;
      }
      return;
    }
    if (delta.type === "thinking_delta") {
      const text = String(delta.thinking || "");
      if (appendBudgeted(text)) {
        block.type = block.type || "thinking";
        block.thinking = String(block.thinking || "") + text;
      }
      return;
    }
    if (delta.type === "input_json_delta") {
      const text = String(delta.partial_json || "");
      if (appendBudgeted(text)) {
        block.type = block.type || "tool_use";
        block._inputJson = String(block._inputJson || "") + text;
      }
    }
  }

  return {
    push(eventType, record) {
      if (eventType === "message_start") {
        const startMessage = asRecord(record.message);
        if (startMessage) {
          Object.assign(message, startMessage);
          sawMessageStart = true;
        }
        return;
      }
      if (eventType === "message_delta") {
        const delta = asRecord(record.delta);
        if (delta && typeof delta.stop_reason === "string") stopReason = delta.stop_reason;
        return;
      }
      if (eventType === "content_block_start") {
        const index = numberValue(record.index);
        const block = asRecord(record.content_block);
        if (index !== null && block) blocks.set(index, {...block});
        return;
      }
      if (eventType === "content_block_delta") {
        const index = numberValue(record.index);
        const delta = asRecord(record.delta);
        if (index === null || !delta) return;
        const block = blocks.get(index) || {};
        applyDelta(block, delta);
        blocks.set(index, block);
      }
    },
    finalize() {
      if (!sawMessageStart && blocks.size === 0) return undefined;
      if (blocks.size > 0) {
        message.content = Array.from(blocks.entries())
          .sort(([a], [b]) => a - b)
          .map(([, block]) => finalizeAnthropicBlock(block));
      }
      if (stopReason !== undefined) message.stop_reason = stopReason;
      return message;
    },
    wasTruncated: () => truncated,
  };
}

export function createChatSseBodyAssembler(
  options: { maxBodyBytes?: number } = {},
): SseBodyAssembler {
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_SSE_BODY_ASSEMBLY_BUDGET_BYTES;
  let budgetUsed = 0;
  let truncated = false;
  let sawChunk = false;
  let id = "";
  let model = "";
  type ChatToolCall = {id?: string; type?: string; name: string; arguments: string};
  type ChatChoiceState = {
    contentParts: string[];
    reasoningParts: string[];
    refusalParts: string[];
    finishReason?: string;
    toolCalls: Map<number, ChatToolCall>;
  };
  const choices = new Map<number, ChatChoiceState>();

  function appendBudgeted(text: string): boolean {
    if (truncated) return false;
    if (budgetUsed + text.length > maxBodyBytes) {
      truncated = true;
      return false;
    }
    budgetUsed += text.length;
    return true;
  }

  function choiceState(index: number): ChatChoiceState {
    const existing = choices.get(index);
    if (existing) return existing;
    const created: ChatChoiceState = {
      contentParts: [],
      reasoningParts: [],
      refusalParts: [],
      toolCalls: new Map(),
    };
    choices.set(index, created);
    return created;
  }

  return {
    push(_eventType, record) {
      sawChunk = true;
      if (typeof record.id === "string" && record.id) id = record.id;
      if (typeof record.model === "string" && record.model) model = record.model;
      if (!Array.isArray(record.choices)) return;
      for (let choicePosition = 0; choicePosition < record.choices.length; choicePosition += 1) {
        const choice = asRecord(record.choices[choicePosition]);
        if (!choice) continue;
        const index = typeof choice.index === "number" ? choice.index : choicePosition;
        const state = choiceState(index);
        if (typeof choice.finish_reason === "string") state.finishReason = choice.finish_reason;
        const delta = asRecord(choice.delta);
        if (!delta) continue;
        if (typeof delta.content === "string" && delta.content && appendBudgeted(delta.content)) {
          state.contentParts.push(delta.content);
        }
        const reasoning = typeof delta.reasoning_content === "string"
          ? delta.reasoning_content
          : typeof delta.reasoning === "string" ? delta.reasoning : undefined;
        if (reasoning && appendBudgeted(reasoning)) state.reasoningParts.push(reasoning);
        if (typeof delta.refusal === "string" && delta.refusal && appendBudgeted(delta.refusal)) {
          state.refusalParts.push(delta.refusal);
        }
        if (!Array.isArray(delta.tool_calls)) continue;
        for (const rawCall of delta.tool_calls) {
          const call = asRecord(rawCall);
          if (!call) continue;
          const toolIndex = typeof call.index === "number" ? call.index : state.toolCalls.size;
          const current = state.toolCalls.get(toolIndex) || {name: "", arguments: ""};
          if (typeof call.id === "string" && call.id) current.id = call.id;
          if (typeof call.type === "string" && call.type) current.type = call.type;
          const fn = asRecord(call.function);
          if (fn) {
            if (typeof fn.name === "string" && fn.name) current.name = fn.name;
            if (typeof fn.arguments === "string" && fn.arguments && appendBudgeted(fn.arguments)) {
              current.arguments += fn.arguments;
            }
          }
          state.toolCalls.set(toolIndex, current);
        }
      }
    },
    finalize() {
      if (!sawChunk) return undefined;
      const assembledChoices = Array.from(choices.entries())
        .sort(([a], [b]) => a - b)
        .map(([index, state]) => {
          const message: Record<string, unknown> = {
            role: "assistant",
            content: state.contentParts.join(""),
          };
          const reasoning = state.reasoningParts.join("");
          if (reasoning) message.reasoning_content = reasoning;
          const refusal = state.refusalParts.join("");
          if (refusal) message.refusal = refusal;
          if (state.toolCalls.size > 0) {
            message.tool_calls = Array.from(state.toolCalls.entries())
              .sort(([a], [b]) => a - b)
              .map(([, call]) => ({
                ...(call.id ? {id: call.id} : {}),
                ...(call.type ? {type: call.type} : {}),
                function: {name: call.name, arguments: call.arguments},
              }));
          }
          return {
            index,
            message,
            finish_reason: state.finishReason ?? null,
          };
        });
      return {
        id,
        object: "chat.completion",
        model,
        choices: assembledChoices,
      };
    },
    wasTruncated: () => truncated,
  };
}

function finalizeAnthropicBlock(block: Record<string, unknown>): Record<string, unknown> {
  if (block.type === "tool_use" && typeof block._inputJson === "string") {
    const {_inputJson, ...rest} = block;
    try {
      return {...rest, input: JSON.parse(_inputJson)};
    } catch {
      return {...rest, input: {_raw: _inputJson}};
    }
  }
  return block;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}
