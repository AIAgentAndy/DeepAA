import { createHash } from "node:crypto";
import { isKnownSemanticAgentKind } from "../agent-registry";
import { createParamsFingerprint, type ParamsFingerprint } from "./params-fingerprint";
import { classifyProtocol, asRecord } from "./protocol";
import type { ProtocolKind } from "./protocol";
import { fingerprintAgent } from "./fingerprint";
import { refineStreamDiagnostic } from "./stream-diagnostics";
import type { RefinedStreamDiagnostic } from "./stream-diagnostics";
import { responseBodyForDisplay } from "./stream-response";
import { classifyToolName, extractHarnessEvidence, type HarnessEvidence } from "./evidence";
import { detectCompactionEvidence, type CompactionEvidence } from "./compaction-evidence";
import { estimateTokens } from "./text-estimate";
import type { CaptureFailover, Confidence, EvidencePointer, RawCapturedExchange } from "./types";
import {
  classifySemanticLane,
  conversationContentKindsFor,
  conversationFingerprintKey,
  type AgentKind,
  type ConversationConfidence,
  type ConversationDedupePolicy,
  type ConversationDisplayPolicy,
  type ConversationProvenance,
  type ConversationSemanticCategory,
  type ConversationTurnSignal,
  type ProtocolKind as SemanticProtocolKind,
} from "../conversation-semantics";

export interface NormalizedExchange {
  exchangeId: string;
  protocol: ProtocolKind;
  endpointKind: string;
  request: NormalizedRequest;
  response: NormalizedResponse;
  stream?: NormalizedStream;
  harnessPayload: NormalizedHarnessPayload;
  /** Harness 证据层：skills 注入名单 / rules 注入条目 / 项目工作目录（一期）。 */
  harnessEvidence: HarnessEvidence;
  /**
   * 压缩证据（P1 校准）：dsh purpose 头 / 压缩续接摘要标记。
   * 缺省表示本请求无可观测压缩证据。
   */
  compaction?: CompactionEvidence;
  /**
   * 模型故障转移元数据：代理在发生「跳过主模型/恢复探测」时随捕获记录；
   * 缺省表示本请求按主模型正常服务。
   */
  failover?: CaptureFailover;
  unsupportedFeatures: UnsupportedFeature[];
  evidence: EvidencePointer[];
}

export interface NormalizedStream {
  diagnostic: RefinedStreamDiagnostic;
  reconstructedResponse?: NormalizedResponse;
  eventTypes: string[];
  evidence: EvidencePointer[];
}

export interface NormalizedRequest {
  model?: string;
  systemBlocks: NormalizedContentBlock[];
  messages: NormalizedMessage[];
  inputItems: NormalizedInputItem[];
  toolSchemas: NormalizedToolSchema[];
  params: Record<string, unknown>;
  sessionHints: SessionHint[];
}

export interface NormalizedResponse {
  model?: string;
  outputMessages: NormalizedMessage[];
  toolUses: NormalizedToolUse[];
  toolResults: NormalizedToolResult[];
  finalTextBlocks: NormalizedContentBlock[];
  reasoningBlocks: NormalizedContentBlock[];
  stopReason?: string;
  status?: "completed" | "incomplete" | "failed" | "unknown";
  error?: { message: string; evidence: EvidencePointer[] };
  usage?: NormalizedUsage;
}

export interface NormalizedHarnessPayload {
  intent: {
    type: "reasoning_and_action" | "pure_completion" | "tool_result_followup" | "retry_like" | "auxiliary" | "unknown";
    confidence: Confidence;
    evidence: EvidencePointer[];
  };
  systemPrompts: HarnessTextItem[];
  developerPrompts: HarnessTextItem[];
  conversationItems: HarnessConversationItem[];
  toolSchemas: NormalizedToolSchema[];
  requestedToolUses: NormalizedToolUse[];
  providedToolResults: NormalizedToolResult[];
  reasoningItems: NormalizedContentBlock[];
  params: Record<string, unknown>;
  paramsFingerprint?: ParamsFingerprint;
  stableHash: string;
  evidence: EvidencePointer[];
}

export interface NormalizedContentBlock {
  type: string;
  text?: string;
  providerType?: string;
  toolUseId?: string;
  toolName?: string;
  evidence: EvidencePointer[];
}

export interface NormalizedMessage {
  role: string;
  content: NormalizedContentBlock[];
  providerItemId?: string;
  providerRole?: string;
  toolCallId?: string;
  toolCalls?: NormalizedToolUse[];
  stableHash: string;
  evidence: EvidencePointer[];
}

export interface NormalizedInputItem {
  type: string;
  role?: string;
  providerItemId?: string;
  callId?: string;
  content: NormalizedContentBlock[];
  stableHash: string;
  evidence: EvidencePointer[];
}

export interface NormalizedToolSchema {
  name: string;
  /** MCP 工具按 `mcp__` 前缀判定；无名 typed 内置工具赋伪名 `@{type}`。 */
  kind: "tool" | "mcp";
  mcpServer?: string;
  descriptionHash?: string;
  inputSchemaHash?: string;
  providerType?: string;
  /** 原始定义 JSON 字符量（构成估算用；随 stableHash 不变）。 */
  schemaChars: number;
  /** 定义 JSON 的估算 token（text-estimate 规则）。 */
  schemaTokensEst: number;
  stableHash: string;
  evidence: EvidencePointer[];
}

export interface NormalizedToolUse {
  id: string;
  name: string;
  input?: unknown;
  providerType?: string;
  evidence: EvidencePointer[];
}

export interface NormalizedToolResult {
  toolUseId: string;
  content?: unknown;
  isError?: boolean;
  providerType?: string;
  evidence: EvidencePointer[];
}

export interface NormalizedUsage {
  inputTokens?: number;
  totalInputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  cacheCreation5mTokens?: number;
  cacheCreation1hTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
  /** token 来源：exact（服务商 usage）、estimated（tokenizer 估算）、unavailable（不可用） */
  source?: "exact" | "estimated" | "unavailable";
}

export interface SessionHint {
  kind: "agent-session-header" | "thread-header" | "conversation-field" | "previous-response-id" | "tool-link";
  value: string;
  confidence: Confidence;
  evidence: EvidencePointer[];
}

export interface HarnessTextItem {
  textHash: string;
  textPreview?: string;
  providerRole?: string;
  evidence: EvidencePointer[];
}

export interface HarnessConversationItem {
  kind: string;
  semanticCategory: ConversationSemanticCategory;
  provenance: ConversationProvenance;
  confidence: ConversationConfidence;
  displayPolicy: ConversationDisplayPolicy;
  dedupePolicy: ConversationDedupePolicy;
  /** 无原生 Turn 身份时的边界信号；旧快照缺省按 neutral 回退。 */
  turnSignal?: ConversationTurnSignal;
  logicalId: string;
  providerItemType: string;
  providerLineageKey?: string;
  role?: string;
  toolUseId?: string;
  toolName?: string;
  summary?: string;
  stableHash: string;
  evidence: EvidencePointer[];
}

export interface UnsupportedFeature {
  path: string;
  reason: string;
  evidence: EvidencePointer[];
}

export function normalizeExchange(exchange: RawCapturedExchange): NormalizedExchange {
  const classification = classifyProtocol(exchange);
  const requestBody = asRecord(exchange.request.parsedBody);
  const responseBody = asRecord(responseBodyForDisplay(exchange));
  const evidence = [{ exchangeId: exchange.exchangeId, side: "request" as const, path: "$" }];
  const request = normalizeRequest(exchange, classification.protocol, requestBody);
  const response = normalizeResponse(exchange, classification.protocol, responseBody);
  const harnessPayload = buildHarnessPayload(
    exchange,
    classification.protocol,
    request,
    response,
  );
  const stream = exchange.stream
    ? {
      diagnostic: refineStreamDiagnostic(exchange),
      eventTypes: exchange.stream.events.map(event => event.event),
      evidence: [{ exchangeId: exchange.exchangeId, side: "stream" as const, path: "$.events" }],
    }
    : undefined;
  const harnessEvidence = extractHarnessEvidence(
    fingerprintAgent(exchange).agentName,
    headerRecord(exchange),
    requestInputTexts(request),
  );

  return {
    exchangeId: exchange.exchangeId,
    protocol: classification.protocol,
    endpointKind: classification.endpointKind,
    request,
    response,
    stream,
    harnessPayload,
    harnessEvidence,
    compaction: detectCompactionEvidence(headerRecord(exchange), requestInputTexts(request)),
    failover: exchange.routing.failover,
    unsupportedFeatures: collectUnsupportedFeatures(exchange, requestBody, responseBody),
    evidence,
  };
}

function headerRecord(exchange: RawCapturedExchange): Record<string, string | undefined> {
  const headers: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(exchange.request.headers)) {
    headers[key.toLowerCase()] = Array.isArray(value) ? value[0] : value;
  }
  return headers;
}

function requestInputTexts(request: NormalizedRequest): string[] {
  const texts: string[] = [];
  for (const block of request.systemBlocks) {
    if (typeof block.text === "string") texts.push(block.text);
  }
  for (const message of request.messages) {
    for (const block of message.content) {
      if (typeof block.text === "string" && block.text) texts.push(block.text);
    }
  }
  for (const item of request.inputItems) {
    for (const block of item.content) {
      if (typeof block.text === "string" && block.text) texts.push(block.text);
    }
  }
  return texts;
}

function normalizeRequest(
  exchange: RawCapturedExchange,
  protocol: ProtocolKind,
  body: Record<string, unknown>
): NormalizedRequest {
  const sessionHints = extractSessionHints(exchange, body);
  const systemBlocks = normalizeSystemBlocks(exchange, body.system);
  const messages = Array.isArray(body.messages)
    ? body.messages.filter(isRecord).map((message, index) => normalizeMessage(exchange, message, `$.messages[${index}]`))
    : [];
  const inputItems = Array.isArray(body.input)
    ? body.input.filter(isRecord).map((item, index) => normalizeInputItem(exchange, item, `$.input[${index}]`))
    : typeof body.input === "string"
      ? [{
        type: "message",
        role: "user",
        content: [{ type: "text", text: body.input, evidence: [pointer(exchange, "request", "$.input")] }],
        stableHash: stableHash(body.input),
        evidence: [pointer(exchange, "request", "$.input")],
      }]
      : [];
  const toolSchemas = normalizeToolSchemas(exchange, body.tools, protocol);
  return {
    model: typeof body.model === "string" ? body.model : undefined,
    systemBlocks,
    messages,
    inputItems,
    toolSchemas,
    params: Object.fromEntries(Object.entries(body).filter(([key]) =>
      !["messages", "input", "tools", "system"].includes(key)
    )),
    sessionHints,
  };
}

function normalizeResponse(
  exchange: RawCapturedExchange,
  protocol: ProtocolKind,
  body: Record<string, unknown>
): NormalizedResponse {
  if (protocol === "openai-responses") {
    const output = Array.isArray(body.output) ? body.output.filter(isRecord) : [];
    const toolUses = output
      .filter(item => item.type === "function_call" || item.type === "custom_tool_call")
      .map((item, index) => normalizeResponsesToolUse(exchange, item, `$.output[${index}]`));
    const finalTextBlocks = output.flatMap((item, index) => normalizeOutputTextBlocks(exchange, item, `$.output[${index}]`));
    const reasoningBlocks = output
      .filter(item => item.type === "reasoning")
      .map((item, index) => ({
        type: "reasoning",
        text: reasoningSummaryText(item.summary),
        providerType: "reasoning",
        evidence: [pointer(exchange, "response", `$.output[${index}]`)],
      }));
    return {
      model: typeof body.model === "string" ? body.model : undefined,
      outputMessages: [],
      toolUses,
      toolResults: [],
      finalTextBlocks,
      reasoningBlocks,
      status: typeof body.status === "string" ? statusValue(body.status) : undefined,
      stopReason: responsesStopReason(body, toolUses.length > 0),
      usage: normalizeUsage(body.usage),
    };
  }

  if (protocol === "openai-chat-completions") {
    const choices = Array.isArray(body.choices) ? body.choices.filter(isRecord) : [];
    const message = asRecord(choices[0]?.message);
    const content = typeof message.content === "string" ? message.content : "";
    const reasoning = typeof message.reasoning_content === "string"
      ? message.reasoning_content
      : typeof message.reasoning === "string" ? message.reasoning : "";
    return {
      model: typeof body.model === "string" ? body.model : undefined,
      outputMessages: message.role ? [normalizeMessage(exchange, message, "$.choices[0].message")] : [],
      toolUses: normalizeChatToolCalls(exchange, message.tool_calls, "$.choices[0].message.tool_calls"),
      toolResults: [],
      finalTextBlocks: content ? [{ type: "text", text: content, evidence: [pointer(exchange, "response", "$.choices[0].message.content")] }] : [],
      reasoningBlocks: reasoning
        ? [{ type: "reasoning", text: reasoning, providerType: "reasoning_content", evidence: [pointer(exchange, "response", "$.choices[0].message.reasoning_content")] }]
        : [],
      stopReason: typeof choices[0]?.finish_reason === "string" ? choices[0].finish_reason : undefined,
      usage: normalizeUsage(body.usage),
    };
  }

  const content = Array.isArray(body.content) ? body.content.filter(isRecord) : [];
  return {
    model: typeof body.model === "string" ? body.model : undefined,
    outputMessages: [],
    toolUses: content
      .filter(block => block.type === "tool_use")
      .map((block, index) => normalizeAnthropicToolUse(exchange, block, `$.content[${index}]`)),
    toolResults: [],
    finalTextBlocks: content
      .filter(block => block.type === "text")
      .map((block, index) => ({ type: "text", text: String(block.text || ""), evidence: [pointer(exchange, "response", `$.content[${index}]`)] })),
    reasoningBlocks: content
      .filter(block => block.type === "thinking")
      .map((block, index) => ({ type: "thinking", text: String(block.thinking || ""), evidence: [pointer(exchange, "response", `$.content[${index}]`)] })),
    stopReason: typeof body.stop_reason === "string" ? body.stop_reason : undefined,
    usage: normalizeUsage(body.usage),
  };
}

function buildHarnessPayload(
  exchange: RawCapturedExchange,
  protocol: ProtocolKind,
  request: NormalizedRequest,
  response: NormalizedResponse
): NormalizedHarnessPayload {
  const providedToolResults = [
    ...request.messages.flatMap(message => message.content.filter(block => block.type === "tool_result").map(block => ({
      toolUseId: block.toolUseId || "",
      content: block.text,
      providerType: "tool_result",
      evidence: block.evidence,
    }))),
    ...request.inputItems
      .filter(item => item.type === "function_call_output" || item.type === "custom_tool_call_output")
      .map(item => ({
        toolUseId: item.callId || "",
        content: item.content[0]?.text,
        providerType: item.type,
        evidence: item.evidence,
      })),
    ...request.messages
      .filter(message => message.providerRole === "tool")
      .map(message => ({
        toolUseId: message.toolCallId || "",
        content: message.content[0]?.text,
        providerType: "tool_message",
        evidence: message.evidence,
      })),
  ];
  const semanticContext = {
    protocol: semanticProtocolKind(protocol),
    agentKind: semanticAgentKind(fingerprintAgent(exchange).agentName),
  };
  const conversationItems = [
    ...request.messages.flatMap(message =>
      conversationItemsFromMessage(message, semanticContext)),
    ...request.inputItems.flatMap(item =>
      conversationItemsFromInputItem(item, semanticContext)),
  ];
  const type = providedToolResults.length > 0
    ? "tool_result_followup"
    : response.toolUses.length > 0
      ? "reasoning_and_action"
      : "pure_completion";
  const paramsFingerprint = createParamsFingerprint(request.params);
  return {
    intent: {
      type,
      confidence: "high",
      evidence: [pointer(exchange, "request", "$")],
    },
    systemPrompts: request.systemBlocks.map(block => ({
      textHash: stableHash(block.text || ""),
      textPreview: block.text,
      providerRole: "system",
      evidence: block.evidence,
    })),
    developerPrompts: [],
    conversationItems,
    toolSchemas: request.toolSchemas,
    requestedToolUses: response.toolUses,
    providedToolResults,
    reasoningItems: response.reasoningBlocks,
    params: request.params,
    paramsFingerprint,
    stableHash: stableHash({
      conversationItems,
      tools: request.toolSchemas,
      paramsFingerprint,
    }),
    evidence: [pointer(exchange, "request", "$")],
  };
}

function normalizeSystemBlocks(exchange: RawCapturedExchange, raw: unknown): NormalizedContentBlock[] {
  if (typeof raw === "string") {
    return [{ type: "text", text: raw, evidence: [pointer(exchange, "request", "$.system")] }];
  }
  if (!Array.isArray(raw)) return [];
  return raw.filter(isRecord).map((block, index) => ({
    type: String(block.type || "text"),
    text: typeof block.text === "string" ? block.text : undefined,
    providerType: typeof block.type === "string" ? block.type : undefined,
    evidence: [pointer(exchange, "request", `$.system[${index}]`)],
  }));
}

function normalizeMessage(exchange: RawCapturedExchange, raw: Record<string, unknown>, path: string): NormalizedMessage {
  const role = typeof raw.role === "string" ? raw.role : "unknown";
  const blocks = normalizeContent(exchange, raw.content, path);
  const toolCallId = typeof raw.tool_call_id === "string" ? raw.tool_call_id : undefined;
  const toolCalls = normalizeChatToolCalls(exchange, raw.tool_calls, `${path}.tool_calls`, "request");
  return {
    role,
    content: blocks,
    providerItemId: typeof raw.id === "string" ? raw.id : undefined,
    providerRole: role,
    toolCallId,
    toolCalls,
    stableHash: stableHash({
      role,
      content: blocks.map(hashableContentBlock),
      toolCalls: toolCalls.map(toolCall => ({
        id: toolCall.id,
        name: toolCall.name,
        input: toolCall.input,
        providerType: toolCall.providerType,
      })),
    }),
    evidence: [pointer(exchange, "request", path)],
  };
}

function normalizeInputItem(exchange: RawCapturedExchange, raw: Record<string, unknown>, path: string): NormalizedInputItem {
  const type = typeof raw.type === "string" ? raw.type : "message";
  const content = normalizeInputItemContent(exchange, raw, path, type);
  return {
    type,
    role: typeof raw.role === "string" ? raw.role : undefined,
    providerItemId: typeof raw.id === "string" ? raw.id : undefined,
    callId: typeof raw.call_id === "string" ? raw.call_id : undefined,
    content,
    stableHash: stableHash(raw),
    evidence: [pointer(exchange, "request", path)],
  };
}

function normalizeInputItemContent(
  exchange: RawCapturedExchange,
  raw: Record<string, unknown>,
  path: string,
  type: string
): NormalizedContentBlock[] {
  if (type === "function_call_output" || type === "custom_tool_call_output") {
    return [{
      type: "tool_result",
      // 两类工具输出负载都在 output 字段（codex 自定义 shell 工具用
      // custom_tool_call_output；2026-09-17 实测漏判导致整步标签错位）。
      text: textFromUnknown(raw.output ?? raw.content),
      providerType: type,
      evidence: [pointer(exchange, "request", path)],
    }];
  }
  if (type === "function_call" || type === "custom_tool_call") {
    return [{
      type: "tool_use",
      text: compactJsonText(parseMaybeJson(raw.arguments ?? raw.input)),
      providerType: type,
      toolUseId: typeof raw.call_id === "string" ? raw.call_id : undefined,
      toolName: typeof raw.name === "string" ? raw.name : undefined,
      evidence: [pointer(exchange, "request", path)],
    }];
  }
  return normalizeContent(exchange, raw.content, path);
}

function normalizeContent(exchange: RawCapturedExchange, raw: unknown, path: string): NormalizedContentBlock[] {
  if (typeof raw === "string") return [{ type: "text", text: raw, evidence: [pointer(exchange, "request", `${path}.content`)] }];
  if (!Array.isArray(raw)) return [];
  return raw.filter(isRecord).map((block, index) => {
    if (block.type === "tool_result") {
      return {
        type: "tool_result",
        text: textFromUnknown(block.content),
        providerType: "tool_result",
        toolUseId: typeof block.tool_use_id === "string" ? block.tool_use_id : undefined,
        evidence: [pointer(exchange, "request", `${path}.content[${index}]`)],
      };
    }
    if (block.type === "tool_use") {
      return {
        type: "tool_use",
        text: textFromUnknown(block.input),
        providerType: "tool_use",
        toolUseId: typeof block.id === "string" ? block.id : undefined,
        toolName: typeof block.name === "string" ? block.name : undefined,
        evidence: [pointer(exchange, "request", `${path}.content[${index}]`)],
      };
    }
    return {
      type: String(block.type || "unknown"),
      text: textFromUnknown(block.text ?? block.content),
      providerType: typeof block.type === "string" ? block.type : undefined,
      evidence: [pointer(exchange, "request", `${path}.content[${index}]`)],
    };
  });
}

function normalizeToolSchemas(exchange: RawCapturedExchange, raw: unknown, protocol: ProtocolKind): NormalizedToolSchema[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isRecord).map((tool, index) => {
    const functionDef = protocol === "openai-chat-completions" && isRecord(tool.function) ? tool.function : tool;
    const schema = functionDef.parameters ?? functionDef.input_schema;
    const rawName = String(functionDef.name || "");
    // 无名 typed 内置工具（codex tool_search/web_search 等）赋伪名保留身份，避免丢失。
    const name = rawName || (typeof tool.type === "string" && tool.type ? `@${tool.type}` : "@unnamed");
    const classification = classifyToolName(name);
    const schemaText = JSON.stringify(tool);
    return {
      name,
      kind: classification.kind,
      mcpServer: classification.mcpServer,
      descriptionHash: functionDef.description ? stableHash(functionDef.description) : undefined,
      inputSchemaHash: schema ? stableHash(schema) : undefined,
      providerType: typeof tool.type === "string" ? tool.type : undefined,
      schemaChars: schemaText.length,
      schemaTokensEst: estimateTokens(schemaText),
      stableHash: stableHash(tool),
      evidence: [pointer(exchange, "request", `$.tools[${index}]`)],
    };
  });
}

function normalizeResponsesToolUse(exchange: RawCapturedExchange, item: Record<string, unknown>, path: string): NormalizedToolUse {
  // codex 自定义工具（shell/exec 等）走 custom_tool_call：入参在 input（自由文本代码），
  // function_call 的入参在 arguments（JSON 字符串）。providerType 保留原始类型。
  const isCustom = item.type === "custom_tool_call";
  return {
    id: String(item.call_id || item.id || ""),
    name: String(item.name || ""),
    input: parseMaybeJson(isCustom ? item.input : item.arguments),
    providerType: isCustom ? "custom_tool_call" : "function_call",
    evidence: [pointer(exchange, "response", path)],
  };
}

/**
 * Responses 协议没有独立 stop_reason 字段，从终止 status 推导，值语义与
 * chat/anthropic 通道对齐（tool_use/end_turn/max_tokens）：completed+工具调用
 * → tool_use；completed → end_turn；incomplete 按 incomplete_details.reason 映射。
 */
function responsesStopReason(body: Record<string, unknown>, hasToolUse: boolean): string | undefined {
  const status = typeof body.status === "string" ? body.status : undefined;
  if (status === "completed") return hasToolUse ? "tool_use" : "end_turn";
  if (status === "incomplete") {
    const reason = asRecord(body.incomplete_details)?.reason;
    if (typeof reason === "string" && reason) {
      return reason === "max_output_tokens" ? "max_tokens" : reason;
    }
    return "incomplete";
  }
  return status;
}

function normalizeAnthropicToolUse(exchange: RawCapturedExchange, block: Record<string, unknown>, path: string): NormalizedToolUse {
  return {
    id: String(block.id || ""),
    name: String(block.name || ""),
    input: block.input,
    providerType: "tool_use",
    evidence: [pointer(exchange, "response", path)],
  };
}

function normalizeChatToolCalls(
  exchange: RawCapturedExchange,
  raw: unknown,
  path: string,
  side: EvidencePointer["side"] = "response"
): NormalizedToolUse[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isRecord).map((call, index) => {
    const fn = asRecord(call.function);
    return {
      id: String(call.id || ""),
      name: String(fn.name || ""),
      input: parseMaybeJson(fn.arguments),
      providerType: "tool_calls",
      evidence: [pointer(exchange, side, `${path}[${index}]`)],
    };
  });
}

function normalizeOutputTextBlocks(exchange: RawCapturedExchange, item: Record<string, unknown>, path: string): NormalizedContentBlock[] {
  if (item.type !== "message" || !Array.isArray(item.content)) return [];
  return item.content.filter(isRecord).map((part, index) => ({
    type: "text",
    text: textFromUnknown(part.text),
    providerType: typeof part.type === "string" ? part.type : undefined,
    evidence: [pointer(exchange, "response", `${path}.content[${index}]`)],
  }));
}

function extractSessionHints(exchange: RawCapturedExchange, body: Record<string, unknown>): SessionHint[] {
  const hints: SessionHint[] = [];
  const pushHint = (
    kind: SessionHint["kind"],
    value: unknown,
    confidence: Confidence,
    evidence: EvidencePointer[]
  ) => {
    if (typeof value !== "string" || !value.trim()) return;
    const normalizedValue = value.trim();
    if (hints.some(item => item.kind === kind && item.value === normalizedValue)) return;
    hints.push({ kind, value: normalizedValue, confidence, evidence });
  };

  for (const header of ["x-claude-code-session-id", "session_id", "session-id", "x-codex-session-id"]) {
    pushHint("agent-session-header", exchange.request.headers[header], "exact", [pointer(exchange, "request", `headers.${header}`)]);
  }
  for (const header of ["thread_id", "thread-id", "x-codex-thread-id"]) {
    pushHint("thread-header", exchange.request.headers[header], "exact", [pointer(exchange, "request", `headers.${header}`)]);
  }
  const turnMetadata = parseMaybeJson(exchange.request.headers["x-codex-turn-metadata"]);
  const turnRecord = asRecord(turnMetadata);
  pushHint("agent-session-header", turnRecord.session_id, "exact", [pointer(exchange, "request", "headers.x-codex-turn-metadata.session_id")]);
  pushHint("thread-header", turnRecord.thread_id, "exact", [pointer(exchange, "request", "headers.x-codex-turn-metadata.thread_id")]);
  const windowSessionId = sessionIdFromCodexWindowId(exchange.request.headers["x-codex-window-id"] || stringValue(turnRecord.window_id));
  pushHint("agent-session-header", windowSessionId, "high", [pointer(exchange, "request", "headers.x-codex-window-id")]);
  if (typeof body.previous_response_id === "string") {
    pushHint("previous-response-id", body.previous_response_id, "high", [pointer(exchange, "request", "$.previous_response_id")]);
  }
  if (typeof body.conversation === "string") {
    pushHint("conversation-field", body.conversation, "high", [pointer(exchange, "request", "$.conversation")]);
  }
  pushHint("conversation-field", body.prompt_cache_key, "high", [pointer(exchange, "request", "$.prompt_cache_key")]);
  return hints;
}

function sessionIdFromCodexWindowId(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const [sessionId] = value.split(":");
  return sessionId?.trim() || undefined;
}

interface NormalizerSemanticContext {
  protocol: SemanticProtocolKind;
  agentKind: AgentKind;
}

function conversationItemsFromMessage(
  message: NormalizedMessage,
  context: NormalizerSemanticContext,
): HarnessConversationItem[] {
  const items: HarnessConversationItem[] = [];
  for (const toolCall of message.toolCalls || []) {
    items.push(harnessConversationItem({
      context,
      kind: "tool_use",
      role: message.role,
      providerRole: message.providerRole,
      providerItemType: toolCall.providerType ?? "tool_use",
      providerItemId: message.providerItemId,
      toolUseId: toolCall.id,
      toolName: toolCall.name,
      summary: compactJsonText(toolCall.input),
      evidence: toolCall.evidence,
    }));
  }
  for (const block of message.content) {
    if (block.type === "tool_use") {
      items.push(harnessConversationItem({
        context,
        kind: "tool_use",
        role: message.role,
        providerRole: message.providerRole,
        providerItemType: block.providerType ?? block.type,
        providerItemId: message.providerItemId,
        toolUseId: block.toolUseId,
        toolName: block.toolName,
        summary: block.text,
        evidence: block.evidence,
      }));
    }
  }
  for (const block of message.content) {
    if (block.type === "tool_result") {
      items.push(harnessConversationItem({
        context,
        kind: "tool_result",
        role: message.role,
        providerRole: message.providerRole,
        providerItemType: block.providerType ?? block.type,
        providerItemId: message.providerItemId,
        toolUseId: block.toolUseId,
        summary: block.text,
        evidence: block.evidence,
      }));
    }
  }
  if (message.providerRole === "tool") {
    items.push(harnessConversationItem({
      context,
      kind: "tool_result",
      role: message.role,
      providerRole: message.providerRole,
      providerItemType: "tool_message",
      providerItemId: message.providerItemId,
      toolUseId: message.toolCallId,
      summary: message.content.map(block => block.text).filter(Boolean).join("\n") || undefined,
      evidence: message.evidence,
    }));
    return items;
  }

  if (message.content.some(block => block.type === "tool_result")) return items;

  for (const block of message.content.filter(isConversationTextBlock)) {
    items.push(harnessConversationItem({
      context,
      kind: `${message.role}_text`,
      role: message.role,
      providerRole: message.providerRole,
      providerItemType: block.providerType ?? block.type,
      providerItemId: message.providerItemId,
      toolUseId: message.toolCallId,
      summary: block.text,
      evidence: block.evidence,
    }));
  }
  return items;
}

function conversationItemsFromInputItem(
  item: NormalizedInputItem,
  context: NormalizerSemanticContext,
): HarnessConversationItem[] {
  return item.content.flatMap(block => {
    if (
      typeof block.text !== "string"
      || (!block.text.trim() && block.type !== "tool_use")
    ) {
      return [];
    }
    const kind = block.type === "tool_result"
      ? "tool_result"
      : block.type === "tool_use"
        ? "tool_use"
        : item.role ? `${item.role}_text` : "user_text";
    return [harnessConversationItem({
      context,
      kind,
      role: item.role,
      providerRole: item.role,
      providerItemType: block.providerType ?? item.type ?? block.type,
      ancestorTypes: [item.type],
      providerItemId: item.providerItemId,
      toolUseId: block.toolUseId ?? item.callId,
      toolName: block.toolName,
      summary: block.text,
      evidence: block.evidence.length > 0 ? block.evidence : item.evidence,
    })];
  });
}

function harnessConversationItem(input: {
  context: NormalizerSemanticContext;
  kind: string;
  role?: string;
  providerRole?: string;
  providerItemType: string;
  ancestorTypes?: string[];
  providerItemId?: string;
  toolUseId?: string;
  toolName?: string;
  summary?: string;
  evidence: EvidencePointer[];
}): HarnessConversationItem {
  const evidencePath = input.evidence[0]?.path ?? "$";
  const semantic = classifySemanticLane({
    protocol: input.context.protocol,
    agentKind: input.context.agentKind,
    bodySide: "request",
    providerRole: input.providerRole,
    providerItemType: input.providerItemType,
    ancestorTypes: input.ancestorTypes,
    evidencePath,
    parentIdentity: input.providerItemId
      ? `item:${input.providerItemId}`
      : semanticParentPath(evidencePath),
    semanticLane: semanticLaneFromPath(evidencePath, input.providerItemType),
    providerItemId: input.providerItemId,
    textPrefix: input.summary,
    toolName: input.toolName,
    toolUseId: input.toolUseId,
    contentKinds: conversationContentKindsFor(input.providerItemType, false),
  });
  const textSha256 = stableHash(input.summary ?? "");
  return {
    kind: input.kind,
    semanticCategory: semantic.semanticCategory,
    provenance: semantic.provenance,
    confidence: semantic.confidence,
    displayPolicy: semantic.displayPolicy,
    dedupePolicy: semantic.dedupePolicy,
    turnSignal: semantic.turnSignal,
    logicalId: semantic.logicalId,
    providerItemType: semantic.providerItemType,
    providerLineageKey: semantic.providerLineageKey,
    role: input.role,
    toolUseId: input.toolUseId,
    toolName: input.toolName,
    summary: input.summary,
    stableHash: conversationFingerprintKey({
      category: semantic.semanticCategory,
      side: "input",
      provenance: semantic.provenance,
      providerItemType: semantic.providerItemType,
      textSha256,
      contentKinds: semantic.contentKinds,
      toolName: semantic.toolName,
      toolUseId: semantic.toolUseId,
    }),
    evidence: input.evidence,
  };
}

function semanticProtocolKind(protocol: ProtocolKind): SemanticProtocolKind {
  if (
    protocol === "openai-chat-completions"
    || protocol === "openai-responses"
    || protocol === "anthropic-messages"
  ) {
    return protocol;
  }
  return "unknown";
}

function semanticAgentKind(agentName: string): AgentKind {
  // 注册表驱动：已知语义 AgentKind 原样通过；其余非空名按通用工具，空名未知。
  if (isKnownSemanticAgentKind(agentName)) return agentName as AgentKind;
  return agentName ? "generic" : "unknown";
}

function semanticParentPath(path: string): string {
  return path.replace(/(?:\.[A-Za-z_$][\w$]*|\[\d+\])$/u, "") || "$";
}

function semanticLaneFromPath(path: string, fallback: string): string {
  return /\.([A-Za-z_$][\w$]*)$/u.exec(path)?.[1] ?? fallback;
}

function isConversationTextBlock(block: NormalizedContentBlock): boolean {
  return block.type !== "tool_use"
    && block.type !== "tool_result"
    && typeof block.text === "string"
    && block.text.trim().length > 0;
}

function compactJsonText(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function collectUnsupportedFeatures(
  exchange: RawCapturedExchange,
  requestBody: Record<string, unknown>,
  responseBody: Record<string, unknown>
): UnsupportedFeature[] {
  const unsupported: UnsupportedFeature[] = [];
  const requestUnsupported = ["modalities", "audio", "input_audio", "input_image", "metadata"];
  const responseUnsupported = ["audio", "modalities"];
  for (const key of requestUnsupported) {
    if (key in requestBody) {
      unsupported.push({
        path: `$.${key}`,
        reason: `${key} is captured as raw evidence but not semantically rendered in MVP.`,
        evidence: [pointer(exchange, "request", `$.${key}`)],
      });
    }
  }
  for (const key of responseUnsupported) {
    if (key in responseBody) {
      unsupported.push({
        path: `$.${key}`,
        reason: `${key} is captured as raw evidence but not semantically rendered in MVP.`,
        evidence: [pointer(exchange, "response", `$.${key}`)],
      });
    }
  }
  return unsupported;
}

function hashableContentBlock(block: NormalizedContentBlock): Record<string, unknown> {
  return {
    type: block.type,
    text: block.text,
    providerType: block.providerType,
    toolUseId: block.toolUseId,
    toolName: block.toolName,
  };
}

function normalizeUsage(raw: unknown): NormalizedUsage | undefined {
  const usage = asRecord(raw);
  const rawInputTokens = numberValue(usage.input_tokens ?? usage.prompt_tokens);
  const outputTokens = numberValue(usage.output_tokens ?? usage.completion_tokens);
  const inputDetails = optionalRecord(usage.input_tokens_details) || optionalRecord(usage.prompt_tokens_details);
  const outputDetails = optionalRecord(usage.output_tokens_details) || optionalRecord(usage.completion_tokens_details);
  const nestedCachedTokens = numberValue(inputDetails?.cached_tokens);
  const promptCacheHitTokens = numberValue(usage.prompt_cache_hit_tokens ?? usage.cache_hit_tokens);
  const promptCacheMissTokens = numberValue(usage.prompt_cache_miss_tokens ?? usage.cache_miss_tokens);
  const topLevelCacheReadTokens = numberValue(usage.cache_read_input_tokens) ?? promptCacheHitTokens;
  const cacheReadTokens = topLevelCacheReadTokens ?? nestedCachedTokens;
  const cacheCreation = optionalRecord(usage.cache_creation);
  const cacheCreation5mTokens = numberValue(
    usage.cache_creation_5m_input_tokens
      ?? usage.cache_creation_5m_tokens
      ?? cacheCreation?.ephemeral_5m_input_tokens,
  );
  const cacheCreation1hTokens = numberValue(
    usage.cache_creation_1h_input_tokens
      ?? usage.cache_creation_1h_tokens
      ?? cacheCreation?.ephemeral_1h_input_tokens,
  );
  const cacheCreationTotal = numberValue(usage.cache_creation_input_tokens);
  const cacheCreationTokens = cacheCreationTotal
    ?? (cacheCreation5mTokens !== undefined || cacheCreation1hTokens !== undefined
      ? (cacheCreation5mTokens ?? 0) + (cacheCreation1hTokens ?? 0)
      : undefined);
  const reasoningTokens = numberValue(outputDetails?.reasoning_tokens ?? usage.reasoning_tokens);
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
  const totalTokens = numberValue(usage.total_tokens) ?? (
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
    source: "exact",
  };
}

function sumDefined(...values: Array<number | undefined>): number | undefined {
  const definedValues = values.filter((value): value is number => value !== undefined);
  if (definedValues.length === 0) return undefined;
  return definedValues.reduce((sum, value) => sum + value, 0);
}

function optionalRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function pointer(exchange: RawCapturedExchange, side: EvidencePointer["side"], path: string): EvidencePointer {
  return { exchangeId: exchange.exchangeId, side, path };
}

export function stableHash(value: unknown): string {
  const text = JSON.stringify(value);
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function reasoningSummaryText(raw: unknown): string {
  if (!Array.isArray(raw)) return "";
  return raw.map(item => isRecord(item) ? textFromUnknown(item.text) : "").filter(Boolean).join("\n");
}

function statusValue(value: string): NormalizedResponse["status"] {
  if (value === "completed" || value === "incomplete" || value === "failed") return value;
  return "unknown";
}

function textFromUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(textFromUnknown).filter(Boolean).join("\n");
  if (value === undefined || value === null) return "";
  return JSON.stringify(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
