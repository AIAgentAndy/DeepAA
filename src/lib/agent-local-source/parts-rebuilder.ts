/**
 * 会话时间线 → wire 语义重建器（双链路观测 2026-09-16 第六版核心，纯函数）。
 *
 * 数据面实测（2026-09-16）：
 * - model_usage.assistant_message_id 100% 关联 assistant message；
 * - assistant message 的 parts 即该次响应的完整语义结构
 *   （step-start → reasoning → text → tool×N → step-finish），与 anthropic wire
 *   语义一一对应；tool part 的 state 同时携带 input 与 output（调用与结果成对）；
 * - message.semantics.providerVisibility='hidden' 的消息不进模型上下文；
 * - compaction part 的 tail_start_id 指向压缩后保留上下文的起始消息。
 *
 * 重建规则：
 * - 响应 = 目标 assistant message 的 parts 直映射（reasoning→thinking、text→text、
 *   tool→tool_use、step-finish.reason→stop_reason）；
 * - 请求上下文 = 目标消息之前全部 provider-visible 消息按序回放：user 文本 → user
 *   消息；assistant 的 reasoning/text/tool → thinking/text/tool_use 块；其 completed
 *   工具的 output 紧随其后组成 user tool_result 消息（wire 成对约定）；遇 compaction
 *   以 tailMessageId 位置截断；hidden 跳过。
 * - 经网关的消息在 timeline 中同样 visible——按用户确认保留（那是模型真实看到的
 *   上下文），且不产生任何账本行（计费白名单在 adapter 层已保证）。
 */

import type {SessionTimeline, TimelineMessage} from "./types";

export interface RebuiltExchange {
  /** 完整上下文请求体（wire 形态，model 由调用方覆写）。 */
  requestMessages: Array<Record<string, unknown>>;
  /** 响应语义块（按 parts 顺序）。 */
  responseContent: Array<Record<string, unknown>>;
  stopReason?: string;
  /** 重建质量标记：上下文被 compaction 截断过。 */
  compacted: boolean;
  /**
   * 目标 assistant 消息已终态（`time.completed` + `step-finish`）。
   * false 表示本地还在写这条消息——此时合成会得到空正文，必须延迟导入。
   */
  responseFinalized: boolean;
  /**
   * 目标之前的 assistant 消息是否全部终态。false 表示回放出来的上下文缺内容
   * （典型现象：请求体里 assistant 的正文/工具调用整段消失）。
   */
  contextFinalized: boolean;
}

/** 上下文终态检查窗口（消息条数）：覆盖紧邻目标的上一条 assistant 及其工具结果。 */
const CONTEXT_FINALITY_WINDOW = 8;

export interface TimelineIndex {
  order: TimelineMessage[];
  /** messageId → timeline 下标。 */
  indexById: Map<string, number>;
  /** 每个消息位置之前生效的 compaction 截断点（消息下标）。 */
  cutBefore: number[];
}

export function indexTimeline(timeline: SessionTimeline): TimelineIndex {
  const order = timeline.messages;
  const indexById = new Map<string, number>();
  order.forEach((message, index) => indexById.set(message.messageId, index));
  // cutBefore[i] = 消息 i 之前（作为上下文上界时）应从哪个下标开始回放：
  // 扫描中遇到 compaction part（tailMessageId 可定位）即更新截断点。
  const cutBefore: number[] = [];
  let currentCut = 0;
  for (let index = 0; index < order.length; index += 1) {
    // 截断点对该消息自身的请求不生效（压缩发生在其响应过程中），从下一条消息起生效；
    // 精确贴合 zcode mid-turn compaction 的边界归属由校准测试 V-4 对拍确认。
    cutBefore[index] = currentCut;
    for (const part of order[index]!.parts) {
      if (part.kind === "compaction" && part.tailMessageId) {
        const tailIndex = indexById.get(part.tailMessageId);
        if (tailIndex !== undefined) {
          currentCut = Math.max(currentCut, tailIndex);
        }
      }
    }
  }
  return {order, indexById, cutBefore};
}

/**
 * 重建目标 assistant 消息对应的请求上下文与响应语义块。
 * 返回 undefined = timeline 中找不到目标消息（异常形态，调用方走降级路径）。
 */
export function rebuildExchangeFromTimeline(
  index: TimelineIndex,
  targetMessageId: string,
): RebuiltExchange | undefined {
  const targetIndex = index.indexById.get(targetMessageId);
  if (targetIndex === undefined) return undefined;
  const target = index.order[targetIndex]!;
  const cut = index.cutBefore[targetIndex] ?? 0;

  const requestMessages: Array<Record<string, unknown>> = [];
  for (let i = cut; i < targetIndex; i += 1) {
    const message = index.order[i]!;
    if (!message.visible) continue;
    if (message.role === "user") {
      appendUserMessage(requestMessages, message);
      continue;
    }
    appendAssistantMessage(requestMessages, message);
  }

  // 上下文终态只看目标附近窗口：仍在写入的消息必然是紧邻目标的最近几条；
  // 更早的未终态消息（中断/历史遗留）不会再生效，否则整个会话将永久无法导入。
  let contextFinalized = true;
  const finalityFloor = Math.max(cut, targetIndex - CONTEXT_FINALITY_WINDOW);
  for (let i = finalityFloor; i < targetIndex; i += 1) {
    const message = index.order[i]!;
    if (message.role !== "assistant") continue;
    // 不可见消息不进上下文回放（如会话标题请求的 assistant 消息），
    // 它们的终态与本次回放无关，不得据此延迟导入。
    if (!message.visible) continue;
    if (!message.finalized) {
      contextFinalized = false;
      break;
    }
  }

  const responseContent: Array<Record<string, unknown>> = [];
  let stopReason: string | undefined;
  for (const part of target.parts) {
    if (part.kind === "reasoning" && part.text?.trim()) {
      responseContent.push({type: "thinking", thinking: part.text});
    } else if (part.kind === "text" && part.text !== undefined) {
      responseContent.push({type: "text", text: part.text});
    } else if (part.kind === "tool" && part.callId) {
      responseContent.push({
        type: "tool_use",
        id: part.callId,
        name: part.toolName ?? "unknown",
        input: part.toolInput ?? {},
      });
    } else if (part.kind === "step_finish" && part.reason) {
      stopReason = part.reason;
    }
  }

  return {
    requestMessages,
    responseContent,
    ...(stopReason !== undefined ? {stopReason} : {}),
    compacted: cut > 0,
    responseFinalized: target.finalized,
    contextFinalized,
  };
}

/**
 * 组装最终请求体：以 rollout 骨架（system/tools/metadata/thinking/output_config/
 * tool_choice）为底，覆写 model 为归一名、messages 为重建的完整上下文；
 * 骨架不可得（rollout 已被清理）时退化为最小 body（system/tools 缺失走显式降级）。
 */
export function buildRebuiltRequestBody(
  skeletonBody: string | undefined,
  rebuilt: RebuiltExchange,
  modelId: string,
): string {
  let body: Record<string, unknown> = {};
  if (skeletonBody !== undefined) {
    try {
      const parsed = JSON.parse(skeletonBody) as Record<string, unknown>;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed;
    } catch {
      /* 骨架解析失败按最小 body 处理 */
    }
  }
  body.model = modelId;
  body.messages = rebuilt.requestMessages;
  return JSON.stringify(body);
}

/** 从重建结果提取响应语义块（供合成行 response 组装消费）。 */
export function extractResponseParts(rebuilt: RebuiltExchange): {
  text?: string;
  reasoningText?: string;
  toolCalls: Array<{id?: string; name?: string; input?: unknown}>;
  finishReason?: string;
} {
  const texts: string[] = [];
  const reasonings: string[] = [];
  const toolCalls: Array<{id?: string; name?: string; input?: unknown}> = [];
  for (const block of rebuilt.responseContent) {
    if (block.type === "text" && typeof block.text === "string") texts.push(block.text);
    else if (block.type === "thinking" && typeof block.thinking === "string") reasonings.push(block.thinking);
    else if (block.type === "tool_use") {
      toolCalls.push({
        ...(typeof block.id === "string" ? {id: block.id} : {}),
        ...(typeof block.name === "string" ? {name: block.name} : {}),
        ...(block.input !== undefined ? {input: block.input} : {}),
      });
    }
  }
  return {
    ...(texts.length > 0 ? {text: texts.join("")} : {}),
    ...(reasonings.length > 0 ? {reasoningText: reasonings.join("")} : {}),
    toolCalls,
    ...(rebuilt.stopReason !== undefined ? {finishReason: rebuilt.stopReason} : {}),
  };
}

function appendUserMessage(out: Array<Record<string, unknown>>, message: TimelineMessage): void {
  const texts = message.parts
    .filter(part => part.kind === "text" && part.text?.trim())
    .map(part => part.text!);
  if (texts.length === 0) return;
  const text = texts.join("\n");
  // 注入消息（2026-09-16）：Agent 运行时提醒按 wire 真实形态包上 system-reminder
  // 信封——预览分类器据此标注 user_injected，与网关 lane 行为一致；真实用户输入
  // 保持纯文本（user_real）。
  const wrapped = message.injected === true
    ? `<system-reminder>\n${text}\n</system-reminder>`
    : text;
  out.push({role: "user", content: [{type: "text", text: wrapped}]});
}

function appendAssistantMessage(out: Array<Record<string, unknown>>, message: TimelineMessage): void {
  const content: Array<Record<string, unknown>> = [];
  const toolResults: Array<Record<string, unknown>> = [];
  for (const part of message.parts) {
    if (part.kind === "reasoning" && part.text?.trim()) {
      content.push({type: "thinking", thinking: part.text});
    } else if (part.kind === "text" && part.text !== undefined) {
      content.push({type: "text", text: part.text});
    } else if (part.kind === "tool" && part.callId) {
      content.push({
        type: "tool_use",
        id: part.callId,
        name: part.toolName ?? "unknown",
        input: part.toolInput ?? {},
      });
      // 工具结果成对转换：completed（或 error 带输出）的 output 作为紧随的
      // user tool_result；pending（无输出）表示循环在此中断，wire 语义如实。
      if (part.toolOutput !== undefined) {
        toolResults.push({
          type: "tool_result",
          tool_use_id: part.callId,
          content: part.toolOutput,
          ...(part.toolStatus === "error" ? {is_error: true} : {}),
        });
      }
    }
  }
  if (content.length > 0) out.push({role: "assistant", content});
  if (toolResults.length > 0) out.push({role: "user", content: toolResults});
}
