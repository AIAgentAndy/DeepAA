import { StringDecoder } from "node:string_decoder";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { parser, type Token } from "stream-json/parser.js";
import type { RawBodyStorage } from "../db/models";
import type {
  StreamLifecycleSummary,
  StreamProviderStatus,
} from "../harness/types";
import { RawBodyStreamError } from "../harness/raw-body-stream";
import {
  createSseBodyAssemblerForProtocol,
  SSE_BODY_ASSEMBLY_TRUNCATED_CODE,
} from "../harness/sse-body-assembler";
import {
  boundedUtf8,
  CONTENT_PREVIEW_ITEM_MAX_BYTES,
  ContentPreviewBuilder,
  type ContentPreviewItemSink,
} from "./content-preview";
import { DataUrlProjector } from "./data-url-projector";
import type {
  ExchangeMediaDescriptorDraft,
  ExchangeContentPreviewItem,
  LimitedDimension,
  PreviewSemanticType,
  ProjectedBodyResult,
  ProjectionBodySide,
} from "./projection-types";
import type {
  AgentKind,
  ConversationSemanticOverride,
  RequestContextMode,
} from "../conversation-semantics";
import { isAnthropicToolBlockType, resolveSseLane } from "../conversation-semantics";
import { classifyAgentProfile } from "../conversation-semantics/agent-profiles";

const SMALL_BODY_MAX_BYTES = 8 * 1024 * 1024;
const MAX_JSON_DEPTH = 128;
const MAX_ARRAY_ITEMS = 256;
const MAX_OBJECT_KEYS = 256;
const MAX_PROJECTED_NODES = 4_096;
const MAX_PROJECTED_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_PROJECTED_STRING_BYTES = 8 * 1024;
const MAX_KEY_BYTES = 512;
const MAX_NUMBER_CHARS = 64;
const MAX_SSE_EVENT_BYTES = 1024 * 1024;
const MAX_SSE_EVENTS = 256;
const SEMANTIC_METADATA_KEYS = new Set([
  "role",
  "type",
  "id",
  "call_id",
  "name",
  "index",
]);

export interface ProjectProtocolStreamOptions {
  stream: Readable;
  format: "json" | "sse";
  exchangeId: string;
  bodySide: ProjectionBodySide;
  rawBodySha256: string;
  sourceStorage: Exclude<RawBodyStorage, "none">;
  projectionVersion: number;
  protocol?: string;
  agentKind?: AgentKind;
  endpointKind?: string;
}

export interface ProjectMaterializedProtocolValueOptions extends Omit<
  ProjectProtocolStreamOptions,
  "stream" | "format"
> {
  value: unknown;
}

export function chooseExchangeProjectionPath(
  requestBodyBytes: number,
  responseBodyBytes: number,
): "small" | "large" {
  assertBodySize(requestBodyBytes);
  assertBodySize(responseBodyBytes);
  return requestBodyBytes <= SMALL_BODY_MAX_BYTES
    && responseBodyBytes <= SMALL_BODY_MAX_BYTES
    ? "small"
    : "large";
}

/**
 * JSON 字符串关闭 packStrings 后逐片处理；SSE 每次只保留一个有界事件，
 * 不累计完整响应。所有 Data URL 在进入有界对象和预览前统一替换为描述符。
 */
export async function projectProtocolStream(
  options: ProjectProtocolStreamOptions,
): Promise<ProjectedBodyResult> {
  let context!: ProjectionContext;
  const preview = new ContentPreviewBuilder({
    exchangeId: options.exchangeId,
    projectionVersion: options.projectionVersion,
    protocol: options.protocol,
    agentKind: options.agentKind,
    endpointKind: options.endpointKind,
    onClassifiedItem: item => rememberAgentSemanticOverride(context, item),
  });
  context = {
    options,
    preview,
    mediaDescriptors: [],
    diagnostics: new Set<string>(),
    limitedDimensions: new Set<LimitedDimension>(),
    chatToolMetadata: new Map(),
    agentMessageOverrides: new Map(),
  };

  let body: unknown = {};
  let eventTypes: string[] = [];
  let streamEvents: Array<{ event: string; data: unknown }> | undefined;
  let streamLifecycle: StreamLifecycleSummary | undefined;
  if (options.format === "json") {
    body = await projectJsonValue(options.stream, context, "$", true);
    reconcileAnthropicJsonMessage(context, body);
    // 非流式 anthropic 工具块的入参是对象，字符串白名单不会为其产项；
    // 与 small path（projectMaterializedProtocolValue）保持一致，按块补齐一条 JSON 入参项。
    reconcileAnthropicJsonToolUse(context, body);
  } else {
    const sse = await projectSse(options.stream, context);
    body = sse.body;
    eventTypes = sse.eventTypes;
    streamEvents = sse.events;
    streamLifecycle = sse.lifecycle;
  }
  preview.setRequestContextMode(
    requestContextModeFromBody(options, body),
  );
  for (const code of context.diagnostics) preview.addDiagnostic(code);
  for (const dimension of context.limitedDimensions) {
    preview.addLimitedDimension(dimension);
  }
  const finalizedPreview = preview.finalize();
  return {
    body,
    streamEvents,
    streamLifecycle,
    preview: finalizedPreview,
    mediaDescriptors: context.mediaDescriptors,
    eventTypes,
    diagnosticCodes: [...context.diagnostics],
    limitedDimensions: uniqueDimensions(
      context.limitedDimensions,
      finalizedPreview.limitedDimensions,
    ),
    candidateCountExact: finalizedPreview.itemCandidateCountExact,
  };
}

/**
 * small path 已受 8 MiB 水合上限保护，必须保留现有完整 normalize 语义。
 * 此处原位遍历 JSON.parse 结果，只过滤 Data URL；不使用 JSON.stringify，也不提前裁数组。
 */
export function projectMaterializedProtocolValue(
  options: ProjectMaterializedProtocolValueOptions,
): ProjectedBodyResult {
  let context!: ProjectionContext;
  const preview = new ContentPreviewBuilder({
    exchangeId: options.exchangeId,
    projectionVersion: options.projectionVersion,
    protocol: options.protocol,
    agentKind: options.agentKind,
    endpointKind: options.endpointKind,
    onClassifiedItem: item => rememberAgentSemanticOverride(context, item),
  });
  context = {
    options: {
      ...options,
      stream: Readable.from([]),
      format: "json",
    },
    preview,
    mediaDescriptors: [],
    diagnostics: new Set<string>(),
    limitedDimensions: new Set<LimitedDimension>(),
    chatToolMetadata: new Map(),
    agentMessageOverrides: new Map(),
  };
  const body = sanitizeMaterializedValue(options.value ?? {}, "$", 0, context, []);
  reconcileAnthropicJsonMessage(context, body);
  reconcileAnthropicJsonToolUse(context, body);
  preview.setRequestContextMode(
    requestContextModeFromBody(options, body),
  );
  for (const code of context.diagnostics) preview.addDiagnostic(code);
  for (const dimension of context.limitedDimensions) {
    preview.addLimitedDimension(dimension);
  }
  const finalizedPreview = preview.finalize();
  return {
    body,
    preview: finalizedPreview,
    mediaDescriptors: context.mediaDescriptors,
    eventTypes: [],
    diagnosticCodes: [...context.diagnostics],
    limitedDimensions: uniqueDimensions(
      context.limitedDimensions,
      finalizedPreview.limitedDimensions,
    ),
    candidateCountExact: true,
  };
}

/**
 * Responses 的会话引用是协议级持久状态，优先于 Agent/历史形状推断。
 * 只检查已投影的根字段，不保存或遍历完整正文。
 */
function requestContextModeFromBody(
  options: Pick<ProjectProtocolStreamOptions, "bodySide" | "protocol" | "endpointKind">,
  body: unknown,
): RequestContextMode | undefined {
  if (options.bodySide !== "request" || options.endpointKind !== "model-call") {
    return undefined;
  }
  if (options.protocol !== "openai-responses") return undefined;
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const record = body as Record<string, unknown>;
  return typeof record.previous_response_id === "string"
    || typeof record.conversation === "string"
    ? "stateful_delta"
    : undefined;
}

interface ProjectionContext {
  options: ProjectProtocolStreamOptions;
  preview: ContentPreviewBuilder;
  mediaDescriptors: ExchangeMediaDescriptorDraft[];
  diagnostics: Set<string>;
  limitedDimensions: Set<LimitedDimension>;
  suppressPreview?: boolean;
  ssePreviewMetadata?: SsePreviewMetadata;
  chatToolMetadata: Map<string, {id?: string; name?: string; type?: string}>;
  agentMessageOverrides: Map<string, ConversationSemanticOverride>;
  anthropicJsonTextKeys?: Set<string>;
}

interface SsePreviewMetadata {
  eventType?: string;
  semanticType?: PreviewSemanticType;
  role?: string;
  type?: string;
  name?: string;
  id?: string;
  callId?: string;
  index?: string;
  parentIdentity?: string;
  semanticLane?: string;
  providerItemId?: string;
  coalesceKey?: string;
  messageStopReason?: string;
  syntheticProviderControl?: boolean;
  semanticOverride?: ConversationSemanticOverride;
}

function beginProjectedTextItem(
  context: ProjectionContext,
  path: string,
  metadata: ReturnType<typeof previewMetadata>,
): ContentPreviewItemSink {
  const agentOverride = agentSemanticOverride(context, path, metadata);
  if (agentOverride) metadata.semanticOverride = agentOverride;
  const chatLane = chatSseLaneMetadata(context, path, metadata);
  if (chatLane) {
    const sink = context.preview.beginCoalescedTextItem(chatLane.key, chatLane.metadata);
    // Chat 的 tool-call id/name 可能晚于 arguments 到达；更新同一 coalesced
    // lane 的元数据，但不创建新的正文项。
    context.preview.updateCoalescedTextItem(chatLane.key, chatLane.metadata);
    return sink;
  }
  const sseKey = context.ssePreviewMetadata?.coalesceKey;
  if (sseKey) {
    return context.preview.beginCoalescedTextItem(sseKey, metadata);
  }
  const jsonKey = anthropicJsonTextLaneKey(context, path, metadata.itemType);
  if (jsonKey) {
    context.anthropicJsonTextKeys ??= new Set<string>();
    context.anthropicJsonTextKeys.add(jsonKey);
    return context.preview.beginCoalescedTextItem(jsonKey, metadata);
  }
  return context.preview.beginTextItem(metadata);
}

function agentSemanticOverride(
  context: ProjectionContext,
  path: string,
  metadata: ReturnType<typeof previewMetadata>,
): ConversationSemanticOverride | undefined {
  if (context.options.bodySide !== "request") return undefined;
  const messageMatch = path.match(/^\$\.(?:messages|input)\[(\d+)\]/u);
  const messageKey = messageMatch?.[1];
  const text = metadata.itemType.toLowerCase() === "image_url"
    ? metadata.itemType
    : undefined;
  const profile = classifyAgentProfile({
    agentKind: context.options.agentKind ?? "unknown",
    bodySide: "request",
    providerRole: metadata.role,
    providerItemType: metadata.itemType,
    ancestorTypes: metadata.ancestorTypes,
    evidencePath: path,
    textPrefix: text,
  });
  if (profile?.scope === "message" && messageKey !== undefined) {
    const override = {
      semanticCategory: profile.category,
      provenance: profile.provenance,
      confidence: profile.confidence,
    };
    context.agentMessageOverrides.set(messageKey, override);
    return override;
  }
  return messageKey !== undefined
    ? context.agentMessageOverrides.get(messageKey)
    : undefined;
}

function rememberAgentSemanticOverride(
  context: ProjectionContext,
  item: ExchangeContentPreviewItem,
): void {
  if (context.options.bodySide !== "request") return;
  const messageKey = item.jsonPath.match(/^\$\.(?:messages|input)\[(\d+)\]/u)?.[1];
  if (messageKey === undefined) return;
  const profile = classifyAgentProfile({
    agentKind: context.options.agentKind ?? "unknown",
    bodySide: "request",
    providerRole: item.role,
    providerItemType: item.itemType,
    ancestorTypes: item.ancestorTypes,
    evidencePath: item.jsonPath,
    textPrefix: item.textPreview,
  });
  // part 规则（dsh 图片句柄）只覆盖当前 part，不能写入 message 级
  // override；否则同一消息后续真实文本会被错误继承为 user_injected。
  if (profile?.scope === "part") return;
  if (
    item.semanticCategory === "tool_result"
    || item.semanticCategory === "user_injected"
  ) {
    context.agentMessageOverrides.set(messageKey, {
      semanticCategory: item.semanticCategory,
      provenance: item.provenance,
      confidence: item.confidence,
    });
  }
}

/** Chat Completions 的 lane 必须在具体 JSON 字段路径处解析，避免同一 chunk 的
 * content、reasoning_content、refusal 与并行 tool_calls 共用事件级 coalesceKey。 */
function chatSseLaneMetadata(
  context: ProjectionContext,
  path: string,
  metadata: ReturnType<typeof previewMetadata>,
): {key: string; metadata: ReturnType<typeof previewMetadata>} | undefined {
  if (
    context.options.format !== "sse"
    || context.options.protocol !== "openai-chat-completions"
  ) {
    return undefined;
  }
  const eventType = context.ssePreviewMetadata?.eventType;
  if (eventType === undefined) return undefined;
  const choiceIndex = path.match(/\.choices\[(\d+)\]/u)?.[1];
  const toolCallIndex = path.match(/\.tool_calls\[(\d+)\]/u)?.[1];
  const remembered = choiceIndex !== undefined && toolCallIndex !== undefined
    ? context.chatToolMetadata.get(`${choiceIndex}:${toolCallIndex}`)
    : undefined;
  const lane = resolveSseLane({
    protocol: "openai-chat-completions",
    eventType,
    evidencePath: path,
    ...(choiceIndex !== undefined ? {choiceIndex} : {}),
    ...(toolCallIndex !== undefined ? {toolCallIndex} : {}),
    ...(remembered?.id !== undefined ? {toolCallId: remembered.id} : {}),
    ...(remembered?.name !== undefined ? {toolName: remembered.name} : {}),
  });
  if (!lane) return undefined;
  const itemType = lane.family === "tool_use"
    ? remembered?.type ?? "tool_calls"
    : lane.family;
  const laneMetadata: ReturnType<typeof previewMetadata> = {
    ...metadata,
    category: lane.family === "tool_use" ? "tool" : metadata.category,
    role: metadata.role ?? "assistant",
    itemType,
    parentIdentity: lane.parentIdentity,
    semanticLane: lane.semanticLane,
    ...(lane.family === "tool_use"
      ? {
          providerItemId: lane.toolCallId ?? remembered?.id,
          toolUseId: lane.toolCallId ?? remembered?.id,
        }
      : {}),
    ...(lane.toolName !== undefined
      ? {toolName: lane.toolName}
      : remembered?.name !== undefined
        ? {toolName: remembered.name}
        : {}),
  };
  return {key: lane.key, metadata: laneMetadata};
}

function anthropicJsonTextLaneKey(
  context: ProjectionContext,
  path: string,
  itemType: string,
): string | undefined {
  if (
    context.options.format !== "json"
    || context.options.protocol !== "anthropic-messages"
    || context.options.bodySide !== "response"
    || itemType.toLowerCase() !== "text"
  ) {
    return undefined;
  }
  const contentIndex = /^\$\.content\[(\d+)\]\.text$/u.exec(path)?.[1];
  return contentIndex === undefined
    ? undefined
    : `anthropic-json:content:${contentIndex}:text`;
}

/**
 * 非流式 anthropic 响应的 tool_use 预览项（2026-09-16）：字符串 sanitizer 只为文本
 * 节点产项，tool_use 块（name/id 字符串 + input 对象）在非流式路径下不产生预览项，
 * 导致「本次响应未产生可展示的模型输出」——官方交互语义要求工具调用可见（SSE 路径
 * 经 input_json_delta lane 本就产生）。此处按 content 块顺序补齐 tool_use 项，
 * 网关非流式响应与本地导入合成行一并受益。
 */
function reconcileAnthropicJsonToolUse(
  context: ProjectionContext,
  body: unknown,
): void {
  if (
    context.options.protocol !== "anthropic-messages"
    || context.options.bodySide !== "response"
  ) {
    return;
  }
  const message = asRecord(body);
  const content = Array.isArray(message.content) ? message.content : [];
  const messageId = optionalBoundedString(message.id, 256);
  content.forEach((block, index) => {
    const record = asRecord(block);
    const blockType = typeof record.type === "string" ? record.type : undefined;
    if (!isAnthropicToolBlockType(blockType)) return;
    const toolUseId = optionalBoundedString(record.id, 256);
    const key = `anthropic-json:content:${index}:tool_use`;
    const writer = context.preview.beginCoalescedTextItem(key, {
      side: "response",
      category: "tool_use",
      role: "assistant",
      itemType: blockType!,
      toolName: optionalBoundedString(record.name, 256),
      toolUseId,
      ancestorTypes: ["message", "content", blockType!],
      jsonPath: `$.content[${index}]`,
      parentIdentity: messageId ? `message:${messageId}` : "message:tool_use",
      ...(toolUseId ? {providerItemId: toolUseId} : {}),
    });
    // 工具入参 JSON 序列化为可见文本（writer 自带字节上限收敛）。
    let inputText = "{}";
    try {
      inputText = JSON.stringify(record.input ?? {});
    } catch {
      inputText = "{}";
    }
    writer.pushText(inputText);
  });
}

function reconcileAnthropicJsonMessage(
  context: ProjectionContext,
  body: unknown,
): void {
  if (
    context.options.protocol !== "anthropic-messages"
    || context.options.bodySide !== "response"
  ) {
    return;
  }
  const message = asRecord(body);
  const stopReason = optionalBoundedString(message.stop_reason, 128);
  if (stopReason?.toLowerCase() !== "refusal") return;
  const textKeys = [...(context.anthropicJsonTextKeys ?? [])];
  for (const key of textKeys) {
    context.preview.updateCoalescedTextItem(key, {
      messageStopReason: "refusal",
    });
  }
  const hasText = textKeys.some(key =>
    context.preview.hasCoalescedTextContent(key));
  const explanation = optionalBoundedString(
    asRecord(message.stop_details).explanation,
    CONTENT_PREVIEW_ITEM_MAX_BYTES,
  );
  if (hasText || !explanation?.trim()) return;
  const messageId = optionalBoundedString(message.id, 256);
  const writer = context.preview.beginCoalescedTextItem(
    "anthropic-json:refusal-explanation",
    {
      side: "response",
      category: "message",
      role: "assistant",
      itemType: "refusal",
      ancestorTypes: ["message", "stop_details"],
      jsonPath: "$.stop_details.explanation",
      parentIdentity: messageId ? `message:${messageId}` : "message:refusal",
      semanticLane: "refusal_explanation",
      providerItemId: messageId,
      messageStopReason: "refusal",
      syntheticProviderControl: true,
    },
  );
  writer.pushText(explanation);
}

function sanitizeMaterializedValue(
  value: unknown,
  path: string,
  depth: number,
  context: ProjectionContext,
  ancestors: Array<Record<string, unknown>>,
): unknown {
  if (typeof value === "string") {
    return sanitizeMaterializedString(value, path, context, ancestors);
  }
  if (!value || typeof value !== "object") return value;
  if (depth >= MAX_JSON_DEPTH) {
    context.diagnostics.add("json_depth_exceeded");
    context.limitedDimensions.add(textDimension(context.options.bodySide));
    return "[projection-depth-limited]";
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      value[index] = sanitizeMaterializedValue(
        value[index],
        `${path}[${index}]`,
        depth + 1,
        context,
        ancestors,
      );
    }
    return value;
  }
  const record = value as Record<string, unknown>;
  const childAncestors = [...ancestors, record];
  for (const key of Object.keys(record)) {
    record[key] = sanitizeMaterializedValue(
      record[key],
      jsonPath(path, key),
      depth + 1,
      context,
      childAncestors,
    );
  }
  return record;
}

function sanitizeMaterializedString(
  value: string,
  path: string,
  context: ProjectionContext,
  ancestors: Array<Record<string, unknown>>,
): string {
  const metadata = isPreviewTextPath(path)
    ? previewMetadata(context.options.bodySide, path, ancestors)
    : undefined;
  const writer = metadata
    ? beginProjectedTextItem(context, path, metadata)
    : undefined;
  if (!value.includes("data:")) {
    writer?.pushText(value);
    writer?.finish();
    return value;
  }
  const safeChunks: string[] = [];
  const mediaBefore = context.mediaDescriptors.length;
  const dataUrls = new DataUrlProjector({
    exchangeId: context.options.exchangeId,
    bodySide: context.options.bodySide,
    jsonPath: path,
    rawBodySha256: context.options.rawBodySha256,
    sourceStorage: context.options.sourceStorage,
    ordinal: mediaBefore,
    maxDescriptors: 256 - mediaBefore,
    onText: text => {
      safeChunks.push(text);
      writer?.pushText(text);
    },
    onDescriptor: descriptor => {
      context.mediaDescriptors.push(descriptor);
      writer?.addMediaOrdinal(descriptor.ordinal);
      writer?.addMediaSha256(descriptor.sha256);
    },
    onDiagnostic: code => context.diagnostics.add(code),
  });
  dataUrls.push(value);
  const result = dataUrls.finish();
  writer?.finish();
  if (result.limited) {
    context.limitedDimensions.add(mediaDimension(context.options.bodySide));
  }
  return safeChunks.join("");
}

async function projectJsonValue(
  source: Readable,
  context: ProjectionContext,
  rootPath: string,
  tolerateProtocolError: boolean,
): Promise<unknown> {
  const tokenizer = parser.asStream({
    packKeys: false,
    streamKeys: true,
    packStrings: false,
    streamStrings: true,
    packNumbers: false,
    streamNumbers: true,
  });
  const assembler = new BoundedTokenAssembler(context, rootPath);
  const pipePromise = pipeline(source, tokenizer);
  try {
    for await (const rawToken of tokenizer) {
      assembler.consume(rawToken as Token);
    }
    await pipePromise;
    return assembler.finish();
  } catch (error) {
    await pipePromise.catch(() => undefined);
    if (error instanceof RawBodyStreamError || !tolerateProtocolError) throw error;
    context.diagnostics.add("protocol_json_invalid");
    context.limitedDimensions.add(textDimension(context.options.bodySide));
    context.preview.markCandidateCountInexact(context.options.bodySide);
    return assembler.partialValue();
  } finally {
    tokenizer.destroy();
  }
}

type ContainerFrame = ObjectFrame | ArrayFrame;

interface ObjectFrame {
  kind: "object";
  path: string;
  value: Record<string, unknown>;
  nextKey?: string;
  keyCount: number;
  materialize: boolean;
}

interface ArrayFrame {
  kind: "array";
  path: string;
  value: unknown[];
  nextIndex: number;
  materialize: boolean;
}

interface ValueSlot {
  path: string;
  attach: (value: unknown) => void;
  materialize: boolean;
}

class BoundedTokenAssembler {
  private readonly frames: ContainerFrame[] = [];
  private rootValue: unknown = {};
  private rootAssigned = false;
  private keyBuffer = "";
  private keyTruncated = false;
  private stringCapture?: StreamingStringCapture;
  private numberBuffer?: { value: string; slot: ValueSlot; truncated: boolean };
  private projectedNodes = 0;
  private projectedTextBytes = 0;

  constructor(
    private readonly context: ProjectionContext,
    private readonly rootPath: string,
  ) {}

  consume(token: Token): void {
    switch (token.name) {
      case "startObject":
        this.startContainer("object");
        break;
      case "endObject":
        this.endContainer("object");
        break;
      case "startArray":
        this.startContainer("array");
        break;
      case "endArray":
        this.endContainer("array");
        break;
      case "startKey":
        this.keyBuffer = "";
        this.keyTruncated = false;
        break;
      case "endKey":
        this.finishKey();
        break;
      case "startString":
        this.startString();
        break;
      case "endString":
        this.finishString();
        break;
      case "startNumber":
        this.numberBuffer = { value: "", slot: this.reserveSlot(), truncated: false };
        break;
      case "endNumber":
        this.finishNumber();
        break;
      case "stringChunk":
        if (this.stringCapture) this.stringCapture.push(token.value);
        else this.pushKeyChunk(token.value);
        break;
      case "numberChunk":
        this.pushNumberChunk(token.value);
        break;
      case "nullValue":
      case "trueValue":
      case "falseValue":
        this.attachPrimitive(token.value);
        break;
      case "keyValue":
        this.assignPackedKey(token.value);
        break;
      case "stringValue":
        this.attachPackedString(token.value);
        break;
      case "numberValue":
        this.attachPackedNumber(token.value);
        break;
      case "whitespace":
        break;
    }
  }

  finish(): unknown {
    if (this.frames.length !== 0 || this.stringCapture || this.numberBuffer) {
      throw new Error("JSON token 流未在完整值边界结束。");
    }
    return this.rootValue;
  }

  partialValue(): unknown {
    return this.rootValue;
  }

  private startContainer(kind: "object" | "array"): void {
    const slot = this.reserveSlot();
    const depthAllowed = this.frames.length < MAX_JSON_DEPTH;
    const nodeAllowed = this.projectedNodes < MAX_PROJECTED_NODES;
    const materialize = slot.materialize && depthAllowed && nodeAllowed;
    if (!depthAllowed) this.limit("json_depth_exceeded");
    if (!nodeAllowed) this.limit("projected_node_limit_exceeded");
    if (kind === "object") {
      const value: Record<string, unknown> = {};
      if (materialize) {
        this.projectedNodes += 1;
        slot.attach(value);
      }
      this.frames.push({
        kind: "object",
        path: slot.path,
        value,
        keyCount: 0,
        materialize,
      });
    } else {
      const value: unknown[] = [];
      if (materialize) {
        this.projectedNodes += 1;
        slot.attach(value);
      }
      this.frames.push({
        kind: "array",
        path: slot.path,
        value,
        nextIndex: 0,
        materialize,
      });
    }
  }

  private endContainer(expected: "object" | "array"): void {
    const frame = this.frames.pop();
    if (!frame || frame.kind !== expected) {
      throw new Error(`JSON ${expected} token 层级不匹配。`);
    }
  }

  private startString(): void {
    const slot = this.reserveSlot();
    const metadata = !this.context.suppressPreview && isPreviewTextPath(slot.path)
      ? previewMetadata(
          this.context.options.bodySide,
          slot.path,
          this.frames
            .filter((frame): frame is ObjectFrame => frame.kind === "object")
            .map(frame => frame.value),
          this.context.ssePreviewMetadata,
        )
      : undefined;
    const writer = metadata
      ? beginProjectedTextItem(this.context, slot.path, metadata)
      : undefined;
    this.stringCapture = new StreamingStringCapture({
      slot,
      writer,
      context: this.context,
      maxMaterializedBytes: Math.max(
        0,
        Math.min(
          MAX_PROJECTED_STRING_BYTES,
          MAX_PROJECTED_TEXT_BYTES - this.projectedTextBytes,
        ),
      ),
      onMaterializedBytes: bytes => {
        this.projectedTextBytes += bytes;
      },
    });
  }

  private finishString(): void {
    if (!this.stringCapture) throw new Error("JSON string 结束 token 缺少开始 token。");
    const result = this.stringCapture.finish();
    this.stringCapture = undefined;
    if (result.materializedLimited) this.limit("projected_text_limit_exceeded");
  }

  private attachPrimitive(value: unknown): void {
    const slot = this.reserveSlot();
    if (slot.materialize) slot.attach(value);
  }

  private attachPackedString(value: string): void {
    this.startString();
    this.stringCapture!.push(value);
    this.finishString();
  }

  private attachPackedNumber(value: string): void {
    const slot = this.reserveSlot();
    if (slot.materialize) slot.attach(numberFromJson(value));
  }

  private pushKeyChunk(value: string): void {
    const remaining = MAX_KEY_BYTES - Buffer.byteLength(this.keyBuffer);
    if (remaining <= 0) {
      this.keyTruncated = true;
      return;
    }
    const prefix = boundedUtf8(value, remaining);
    this.keyBuffer += prefix;
    if (prefix !== value) this.keyTruncated = true;
  }

  private finishKey(): void {
    const frame = this.frames.at(-1);
    if (!frame || frame.kind !== "object") throw new Error("JSON key 不在 object 内。");
    frame.nextKey = this.keyTruncated
      ? `${this.keyBuffer}#truncated-${frame.keyCount}`
      : this.keyBuffer;
    if (this.keyTruncated) this.limit("json_key_limit_exceeded");
  }

  private assignPackedKey(value: string): void {
    this.keyBuffer = boundedUtf8(value, MAX_KEY_BYTES);
    this.keyTruncated = this.keyBuffer !== value;
    this.finishKey();
  }

  private pushNumberChunk(value: string): void {
    if (!this.numberBuffer) throw new Error("JSON number chunk 缺少开始 token。");
    const remaining = MAX_NUMBER_CHARS - this.numberBuffer.value.length;
    if (remaining <= 0) {
      this.numberBuffer.truncated = true;
      return;
    }
    this.numberBuffer.value += value.slice(0, remaining);
    if (value.length > remaining) this.numberBuffer.truncated = true;
  }

  private finishNumber(): void {
    const number = this.numberBuffer;
    this.numberBuffer = undefined;
    if (!number) throw new Error("JSON number 结束 token 缺少开始 token。");
    if (number.truncated) {
      this.limit("json_number_limit_exceeded");
      return;
    }
    if (number.slot.materialize) number.slot.attach(numberFromJson(number.value));
  }

  private reserveSlot(): ValueSlot {
    const parent = this.frames.at(-1);
    if (!parent) {
      const materialize = !this.rootAssigned;
      this.rootAssigned = true;
      return {
        path: this.rootPath,
        materialize,
        attach: value => {
          if (materialize) this.rootValue = value;
        },
      };
    }
    if (parent.kind === "array") {
      const index = parent.nextIndex;
      parent.nextIndex += 1;
      const materialize = parent.materialize && index < MAX_ARRAY_ITEMS;
      if (!materialize && parent.materialize) this.limit("json_array_limit_exceeded");
      return {
        path: `${parent.path}[${index}]`,
        materialize,
        attach: value => {
          if (materialize) parent.value.push(value);
        },
      };
    }
    const key = parent.nextKey ?? `#missing-key-${parent.keyCount}`;
    parent.nextKey = undefined;
    const index = parent.keyCount;
    parent.keyCount += 1;
    const semanticMetadata = SEMANTIC_METADATA_KEYS.has(key);
    const materialize = semanticMetadata
      || (parent.materialize && index < MAX_OBJECT_KEYS);
    if (!materialize && parent.materialize) this.limit("json_object_limit_exceeded");
    return {
      path: jsonPath(parent.path, key),
      materialize,
      attach: value => {
        if (materialize) parent.value[key] = value;
      },
    };
  }

  private limit(code: string): void {
    this.context.diagnostics.add(code);
    this.context.limitedDimensions.add(textDimension(this.context.options.bodySide));
  }
}

class StreamingStringCapture {
  private readonly materializedChunks: Buffer[] = [];
  private materializedBytes = 0;
  private materializedLimited = false;
  private readonly dataUrls: DataUrlProjector;

  constructor(private readonly options: {
    slot: ValueSlot;
    writer?: ContentPreviewItemSink;
    context: ProjectionContext;
    maxMaterializedBytes: number;
    onMaterializedBytes: (bytes: number) => void;
  }) {
    const mediaBefore = options.context.mediaDescriptors.length;
    this.dataUrls = new DataUrlProjector({
      exchangeId: options.context.options.exchangeId,
      bodySide: options.context.options.bodySide,
      jsonPath: options.slot.path,
      rawBodySha256: options.context.options.rawBodySha256,
      sourceStorage: options.context.options.sourceStorage,
      ordinal: mediaBefore,
      maxDescriptors: 256 - mediaBefore,
      onText: value => this.pushSafeText(value),
      onDescriptor: descriptor => {
        options.context.mediaDescriptors.push(descriptor);
        options.writer?.addMediaOrdinal(descriptor.ordinal);
        options.writer?.addMediaSha256(descriptor.sha256);
      },
      onDiagnostic: code => options.context.diagnostics.add(code),
    });
  }

  push(value: string): void {
    this.dataUrls.push(value);
  }

  finish(): { materializedLimited: boolean } {
    const media = this.dataUrls.finish();
    if (media.limited) {
      this.options.context.limitedDimensions.add(
        mediaDimension(this.options.context.options.bodySide),
      );
    }
    this.options.writer?.finish();
    if (this.options.slot.materialize) {
      this.options.slot.attach(
        Buffer.concat(this.materializedChunks, this.materializedBytes).toString("utf8"),
      );
      this.options.onMaterializedBytes(this.materializedBytes);
    }
    return { materializedLimited: this.materializedLimited };
  }

  private pushSafeText(value: string): void {
    this.options.writer?.pushText(value);
    if (!this.options.slot.materialize || !value) return;
    const remaining = this.options.maxMaterializedBytes - this.materializedBytes;
    if (remaining <= 0) {
      this.materializedLimited = true;
      return;
    }
    const bytes = Buffer.from(value, "utf8");
    const prefix = utf8BufferPrefix(bytes, remaining);
    if (prefix.length > 0) {
      this.materializedChunks.push(prefix);
      this.materializedBytes += prefix.length;
    }
    if (prefix.length < bytes.length) this.materializedLimited = true;
  }
}

async function projectSse(
  source: Readable,
  context: ProjectionContext,
): Promise<{
  body: unknown;
  eventTypes: string[];
  events: Array<{ event: string; data: unknown }>;
  lifecycle: StreamLifecycleSummary;
}> {
  const eventTypes: string[] = [];
  const events: Array<{ event: string; data: unknown }> = [];
  const itemMetadata = new Map<string, SsePreviewMetadata>();
  const reconcileState: SsePreviewReconcileState = {
    seenDeltaKeys: new Set<string>(),
    openAiItemsWithLaneContent: new Set<string>(),
    anthropicLaneTypes: new Map<string, string>(),
  };
  const lifecycle: StreamLifecycleSummary = {
    eventCount: 0,
    terminalEventSeen: false,
    doneMarkerSeen: false,
    parseErrorCount: 0,
    sampleLimited: false,
  };
  let body: unknown = {};
  // 流式 body 增量装配：anthropic/chat 的 SSE 不携带完整响应快照（responses 协议的
  // response.completed 除外），必须在事件循环内逐事件累积完整 body，否则派生层
  // normalizeResponse 只能看到 message_start 首帧（content: []）或首 chunk，
  // tool_use/thinking/stop_reason 全部丢失。装配器看到全部事件，不受采样上限影响。
  const bodyAssembler = createSseBodyAssemblerForProtocol(context.options.protocol);
  // 流式 usage 聚合：chat_completions 的 usage 只在末 chunk；Anthropic 的
  // input/cache 在 message_start、output 在 message_delta，且部分上游在
  // message_start 发占位 0。聚合结果挂到投影 body，保证 tokenUsageFromExchange
  // 能拿到供应商真实 usage，而不是退化为 tokenizer 估算或记 0。
  let chatCompletionsUsage: Record<string, unknown> | undefined;
  let anthropicUsage: Record<string, unknown> | undefined;
  for await (const event of iterateSseEvents(source, context)) {
    if (event.done) {
      observeStreamLifecycle(
        lifecycle,
        "[DONE]",
        undefined,
        context.options.protocol,
      );
      retainSseSample(eventTypes, events, "[DONE]", undefined, context, lifecycle);
      continue;
    }
    if (event.skipped) {
      lifecycle.eventCount += 1;
      lifecycle.parseErrorCount += 1;
      continue;
    }
    const sourceRecord = readSseDataRecord(event.dataChunks);
    if (!sourceRecord) lifecycle.parseErrorCount += 1;
    const payloadEventType = typeof sourceRecord?.type === "string"
      ? sourceRecord.type
      : undefined;
    const controlEventType = payloadEventType || event.eventName;
    rememberSseItemMetadata(sourceRecord, itemMetadata);
    rememberChatSseToolMetadata(sourceRecord, context);
    const previewDecision = resolveSsePreviewDecision(
      context,
      reconcileState,
      controlEventType,
      sourceRecord,
      itemMetadata,
      `$.events[${event.candidateIndex}].data`,
    );
    context.suppressPreview = previewDecision.suppress
      || isSsePreviewPlaceholderEvent(controlEventType, sourceRecord);
    context.ssePreviewMetadata = previewDecision.metadata
      ? {...previewDecision.metadata, eventType: controlEventType}
      : {eventType: controlEventType};
    let data: unknown;
    try {
      data = await projectJsonValue(
        Readable.from(event.dataChunks),
        context,
        `$.events[${event.candidateIndex}].data`,
        true,
      );
    } finally {
      context.suppressPreview = false;
      context.ssePreviewMetadata = undefined;
    }
    const record = asRecord(data);
    const eventType = event.eventName
      || payloadEventType
      || (typeof record.type === "string" ? record.type : "unknown");
    observeStreamLifecycle(
      lifecycle,
      eventType,
      sourceRecord ?? record,
      context.options.protocol,
    );
    retainSseSample(eventTypes, events, eventType, data, context, lifecycle);
    if (bodyAssembler && record) bodyAssembler.push(eventType, record);
    if (context.options.protocol === "openai-chat-completions") {
      const usage = asRecord(record.usage);
      if (usage && Object.keys(usage).length > 0) chatCompletionsUsage = usage;
    } else if (context.options.protocol === "anthropic-messages") {
      if (eventType === "message_start") {
        anthropicUsage = mergeUsage(anthropicUsage, asRecord(asRecord(record.message).usage));
      } else if (eventType === "message_delta") {
        anthropicUsage = mergeUsage(anthropicUsage, asRecord(record.usage));
      }
    }
    const response = asRecord(record.response);
    if (Object.keys(response).length > 0) body = response;
    else if (eventType === "message_start" && Object.keys(asRecord(record.message)).length > 0) {
      body = record.message;
    } else if (Object.keys(asRecord(body)).length === 0) {
      body = data;
    }
  }
  // 增量装配的完整 body 优先于循环内的首帧快照；装配器无可识别事件时保持
  // 既有兜底（responses 的 response 快照、畸形流的首个 data）。
  const assembledBody = bodyAssembler?.finalize();
  if (assembledBody) {
    body = assembledBody;
    if (bodyAssembler?.wasTruncated()) {
      context.diagnostics.add(SSE_BODY_ASSEMBLY_TRUNCATED_CODE);
    }
  }
  const projectedBody = asRecord(body);
  if (projectedBody && Object.keys(projectedBody).length > 0) {
    if (chatCompletionsUsage) projectedBody.usage = chatCompletionsUsage;
    if (anthropicUsage) projectedBody.usage = anthropicUsage;
  }
  finalizeSsePreviewReconcile(context, reconcileState);
  return { body, eventTypes, events, lifecycle };
}

/**
 * 逐字段合并流式 usage：新值非 0 时覆盖（兼容 message_start 占位 0 与
 * message_delta 重复上报全量）；新值缺省或为 0 时保留旧值。
 */
function mergeUsage(
  acc: Record<string, unknown> | undefined,
  next: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!next || Object.keys(next).length === 0) return acc;
  if (!acc) return {...next};
  const merged: Record<string, unknown> = {...acc};
  for (const [key, value] of Object.entries(next)) {
    if (typeof value === "number" && value > 0) merged[key] = value;
  }
  return merged;
}

function retainSseSample(
  eventTypes: string[],
  events: Array<{ event: string; data: unknown }>,
  eventType: string,
  data: unknown,
  context: ProjectionContext,
  lifecycle: StreamLifecycleSummary,
): void {
  if (eventTypes.length < MAX_SSE_EVENTS) {
    eventTypes.push(eventType);
    if (data !== undefined) events.push({ event: eventType, data });
    return;
  }
  lifecycle.sampleLimited = true;
  context.diagnostics.add("sse_event_limit_exceeded");
  context.limitedDimensions.add("stream_events");
}

function observeStreamLifecycle(
  summary: StreamLifecycleSummary,
  eventType: string,
  record: Record<string, unknown> | undefined,
  protocol: string | undefined,
): void {
  summary.eventCount += 1;
  summary.lastEventType = boundedUtf8(eventType || "unknown", 128);
  if (eventType === "[DONE]") summary.doneMarkerSeen = true;

  const providerStatus = streamProviderStatus(eventType, record);
  if (providerStatus) summary.providerStatus = providerStatus;
  if (!isTerminalStreamEvent(protocol, eventType)) return;
  summary.terminalEventSeen = true;
  summary.terminalEventType = summary.lastEventType;
}

function streamProviderStatus(
  eventType: string,
  record: Record<string, unknown> | undefined,
): StreamProviderStatus | undefined {
  const responseStatus = asRecord(record?.response).status;
  const directStatus = record?.status;
  for (const value of [responseStatus, directStatus]) {
    if (
      value === "completed"
      || value === "failed"
      || value === "incomplete"
      || value === "cancelled"
    ) return value;
  }
  if (eventType === "response.completed") return "completed";
  if (eventType === "response.failed" || eventType === "error") return "failed";
  if (eventType === "response.incomplete") return "incomplete";
  if (eventType === "response.cancelled") return "cancelled";
  return undefined;
}

function isTerminalStreamEvent(
  protocol: string | undefined,
  eventType: string,
): boolean {
  if (protocol === "openai-responses") {
    return /^response\.(?:completed|failed|incomplete|cancelled)$/u.test(eventType);
  }
  if (protocol === "anthropic-messages") return eventType === "message_stop";
  if (protocol === "openai-chat-completions") return eventType === "[DONE]";
  return eventType === "[DONE]"
    || eventType === "message_stop"
    || /^response\.(?:completed|failed|incomplete|cancelled)$/u.test(eventType);
}

/**
 * 单个 SSE 事件已有 1 MiB 硬上限；先用标准 JSON 解析器读取事件元数据，
 * 使 data-only 事件也能识别生命周期快照并关联后续 delta。
 */
function readSseDataRecord(
  dataChunks: string[],
): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(dataChunks.join("\n")) as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function rememberSseItemMetadata(
  record: Record<string, unknown> | undefined,
  items: Map<string, SsePreviewMetadata>,
): void {
  if (!record || items.size >= MAX_SSE_EVENTS) return;
  const message = asRecord(record.message);
  const messageId = optionalBoundedString(message.id, 256);
  if (messageId) {
    items.set("message", {
      role: optionalBoundedString(message.role, 128),
      type: optionalBoundedString(message.type, 128),
      id: messageId,
      providerItemId: messageId,
    });
  }
  const item = asRecord(record.item);
  const itemId = optionalBoundedString(item.id, 256);
  if (itemId) {
    items.set(`id:${itemId}`, {
      role: optionalBoundedString(item.role, 128),
      type: optionalBoundedString(item.type, 128),
      name: optionalBoundedString(item.name, 128),
      id: itemId,
      providerItemId: itemId,
      callId: optionalBoundedString(item.call_id, 256),
    });
  }
  const contentBlock = asRecord(record.content_block);
  const index = safeSseIndex(record.index);
  if (index !== undefined && Object.keys(contentBlock).length > 0) {
    items.set(`index:${index}`, {
      role: optionalBoundedString(contentBlock.role, 128),
      type: optionalBoundedString(contentBlock.type, 128),
      name: optionalBoundedString(contentBlock.name, 128),
      id: optionalBoundedString(contentBlock.id, 256),
      providerItemId: optionalBoundedString(contentBlock.id, 256),
      callId: optionalBoundedString(contentBlock.call_id, 256),
      index,
    });
  }
}

/** Chat Completions 的 id/name/type 可能与 arguments 分属不同 chunk；只保留有界的
 * choice/tool 索引元数据，供字段路径 lane 回填，不把元数据自身变成正文项。 */
function rememberChatSseToolMetadata(
  record: Record<string, unknown> | undefined,
  context: ProjectionContext,
): void {
  if (
    context.options.protocol !== "openai-chat-completions"
    || !record
    || context.chatToolMetadata.size >= MAX_SSE_EVENTS
  ) {
    return;
  }
  const choices = Array.isArray(record.choices) ? record.choices : [];
  for (let choicePosition = 0; choicePosition < choices.length; choicePosition += 1) {
    const choice = asRecord(choices[choicePosition]);
    const choiceIndex = safeSseIndex(choice.index) ?? String(choicePosition);
    const delta = asRecord(choice.delta);
    const toolCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
    for (let callPosition = 0; callPosition < toolCalls.length; callPosition += 1) {
      const call = asRecord(toolCalls[callPosition]);
      const toolCallIndex = safeSseIndex(call.index) ?? String(callPosition);
      const fn = asRecord(call.function);
      const key = `${choiceIndex}:${toolCallIndex}`;
      const current = context.chatToolMetadata.get(key) ?? {};
      const next = {
        ...current,
        ...(optionalBoundedString(call.id, 256) !== undefined
          ? {id: optionalBoundedString(call.id, 256)}
          : {}),
        ...(optionalBoundedString(call.type, 128) !== undefined
          ? {type: optionalBoundedString(call.type, 128)}
          : {}),
        ...(optionalBoundedString(fn.name, 256) !== undefined
          ? {name: optionalBoundedString(fn.name, 256)}
          : {}),
      };
      context.chatToolMetadata.set(key, next);
    }
  }
}

function resolveSsePreviewMetadata(
  record: Record<string, unknown> | undefined,
  items: ReadonlyMap<string, SsePreviewMetadata>,
): SsePreviewMetadata | undefined {
  if (!record) return undefined;
  const inlineItem = asRecord(record.item);
  const inlineItemId = optionalBoundedString(inlineItem.id, 256);
  if (inlineItemId) {
    return {
      role: optionalBoundedString(inlineItem.role, 128),
      type: optionalBoundedString(inlineItem.type, 128),
      name: optionalBoundedString(inlineItem.name, 128),
      id: inlineItemId,
      providerItemId: inlineItemId,
      callId: optionalBoundedString(inlineItem.call_id, 256),
    };
  }
  const itemId = optionalBoundedString(record.item_id, 256);
  if (itemId) {
    const metadata = items.get(`id:${itemId}`);
    if (metadata) return metadata;
    return {
      type: optionalBoundedString(record.type, 128),
      name: optionalBoundedString(record.name, 128),
      id: itemId,
      providerItemId: itemId,
      callId: optionalBoundedString(record.call_id, 256),
    };
  }
  const index = safeSseIndex(record.index);
  return index === undefined ? undefined : items.get(`index:${index}`);
}

interface SsePreviewReconcileState {
  seenDeltaKeys: Set<string>;
  openAiItemsWithLaneContent: Set<string>;
  anthropicLaneTypes: Map<string, string>;
  messageId?: string;
  messageStopReason?: string;
  refusalExplanation?: string;
  refusalExplanationPath?: string;
}

function resolveSsePreviewDecision(
  context: ProjectionContext,
  state: SsePreviewReconcileState,
  eventType: string | undefined,
  record: Record<string, unknown> | undefined,
  items: ReadonlyMap<string, SsePreviewMetadata>,
  eventPath: string,
): { suppress: boolean; metadata?: SsePreviewMetadata } {
  const base = resolveSsePreviewMetadata(record, items);
  if (!eventType || !record) {
    return { suppress: isSseControlSnapshotEvent(eventType), metadata: base };
  }

  const message = asRecord(record.message);
  const messageId = optionalBoundedString(message.id, 256);
  if (messageId) state.messageId = messageId;
  if (eventType === "message_delta" || eventType === "message_stop") {
    rememberAnthropicMessageFinal(state, record, eventPath);
    return { suppress: true };
  }

  const openAi = openAiSseLaneMetadata(eventType, record, base);
  if (openAi) {
    if (openAi.phase === "delta") state.seenDeltaKeys.add(openAi.key);
    const itemIdentity = openAiItemIdentity(record, base);
    if (itemIdentity) state.openAiItemsWithLaneContent.add(itemIdentity);
    return {
      suppress: openAi.phase === "final" && state.seenDeltaKeys.has(openAi.key),
      metadata: {
        ...openAi.metadata,
        coalesceKey: openAi.key,
      },
    };
  }
  if (eventType === "response.output_item.done") {
    const itemIdentity = openAiItemIdentity(record, base);
    return {
      suppress: itemIdentity !== undefined
        && state.openAiItemsWithLaneContent.has(itemIdentity),
      metadata: base,
    };
  }

  const anthropic = anthropicSseLaneMetadata(eventType, record, base);
  if (anthropic) {
    state.anthropicLaneTypes.set(anthropic.key, anthropic.blockType);
    if (anthropic.phase === "delta") state.seenDeltaKeys.add(anthropic.key);
    return {
      suppress: false,
      metadata: {
        ...anthropic.metadata,
        coalesceKey: anthropic.key,
      },
    };
  }

  return {
    suppress: isSseControlSnapshotEvent(eventType) || eventType.endsWith(".done"),
    metadata: base,
  };
}

function openAiItemIdentity(
  record: Record<string, unknown>,
  base: SsePreviewMetadata | undefined,
): string | undefined {
  const itemId = optionalBoundedString(record.item_id, 256)
    ?? base?.providerItemId
    ?? base?.id
    ?? optionalBoundedString(asRecord(record.item).id, 256);
  if (itemId) return `item:${itemId}`;
  const outputIndex = safeSseIndex(record.output_index);
  return outputIndex === undefined ? undefined : `output:${outputIndex}`;
}

function openAiSseLaneMetadata(
  eventType: string,
  record: Record<string, unknown>,
  base: SsePreviewMetadata | undefined,
): {
  key: string;
  phase: "start" | "delta" | "final";
  metadata: SsePreviewMetadata;
} | undefined {
  const direct = /^response\.(output_text|refusal|reasoning_summary_text|function_call_arguments|custom_tool_call_input)\.(delta|done)$/u
    .exec(eventType);
  let partType: string | undefined;
  if (eventType === "response.content_part.added" || eventType === "response.content_part.done") {
    partType = optionalBoundedString(asRecord(record.part).type, 128);
    if (!partType) return undefined;
  }
  const itemId = optionalBoundedString(record.item_id, 256)
    ?? base?.providerItemId
    ?? base?.id;
  const lane = resolveSseLane({
    protocol: "openai-responses",
    eventType,
    ...(itemId !== undefined ? {itemId} : {}),
    ...(safeSseIndex(record.output_index) !== undefined
      ? {outputIndex: safeSseIndex(record.output_index)!}
      : {}),
    ...(safeSseIndex(record.content_index) !== undefined
      ? {contentIndex: safeSseIndex(record.content_index)!}
      : {}),
    ...(partType !== undefined ? {blockType: partType} : {}),
  });
  if (!lane) return undefined;
  return {
    key: lane.key,
    phase: lane.phase,
    metadata: {
      ...base,
      role: base?.role ?? "assistant",
      // itemType 保留原始 provider SSE 事件类型；family 只作为稳定聚合 lane。
      type: direct ? eventType : partType,
      id: itemId,
      providerItemId: itemId,
      parentIdentity: lane.parentIdentity,
      semanticLane: lane.semanticLane,
    },
  };
}

function anthropicSseLaneMetadata(
  eventType: string,
  record: Record<string, unknown>,
  base: SsePreviewMetadata | undefined,
): {
  key: string;
  phase: "start" | "delta";
  blockType: string;
  metadata: SsePreviewMetadata;
} | undefined {
  if (eventType !== "content_block_start" && eventType !== "content_block_delta") {
    return undefined;
  }
  const index = safeSseIndex(record.index);
  if (index === undefined) return undefined;
  const deltaType = optionalBoundedString(asRecord(record.delta).type, 128);
  const blockType = base?.type
    ?? optionalBoundedString(asRecord(record.content_block).type, 128)
    ?? deltaType;
  const lane = resolveSseLane({
    protocol: "anthropic-messages",
    eventType,
    index,
    ...(blockType !== undefined ? {blockType} : {}),
  });
  if (!lane) return undefined;
  const providerItemId = base?.providerItemId ?? base?.id;
  return {
    key: lane.key,
    phase: lane.phase === "delta" ? "delta" : "start",
    blockType: lane.family,
    metadata: {
      ...base,
      role: base?.role ?? "assistant",
      // input_json_delta/text_delta 等原始 block delta 类型用于诊断，
      // 规范化后的 blockType 仅用于 semanticLane 和类别识别。
      type: deltaType
        ?? base?.type
        ?? optionalBoundedString(asRecord(record.content_block).type, 128)
        ?? lane.family,
      index,
      parentIdentity: lane.parentIdentity,
      semanticLane: lane.semanticLane,
      providerItemId,
    },
  };
}

function rememberAnthropicMessageFinal(
  state: SsePreviewReconcileState,
  record: Record<string, unknown>,
  eventPath: string,
): void {
  const delta = asRecord(record.delta);
  const stopReason = optionalBoundedString(
    delta.stop_reason ?? record.stop_reason,
    128,
  );
  if (stopReason) state.messageStopReason = stopReason;
  const stopDetails = asRecord(delta.stop_details ?? record.stop_details);
  const explanation = optionalBoundedString(
    stopDetails.explanation,
    CONTENT_PREVIEW_ITEM_MAX_BYTES,
  );
  if (explanation) {
    state.refusalExplanation = explanation;
    state.refusalExplanationPath = Object.keys(asRecord(delta.stop_details)).length > 0
      ? `${eventPath}.delta.stop_details.explanation`
      : `${eventPath}.stop_details.explanation`;
  }
}

function finalizeSsePreviewReconcile(
  context: ProjectionContext,
  state: SsePreviewReconcileState,
): void {
  if (
    context.options.protocol === "anthropic-messages"
    && state.messageStopReason?.toLowerCase() === "refusal"
  ) {
    const textKeys = [...state.anthropicLaneTypes]
      .filter(([, type]) => type === "text")
      .map(([key]) => key);
    for (const key of textKeys) {
      context.preview.updateCoalescedTextItem(key, {
        messageStopReason: "refusal",
      });
    }
    const hasText = textKeys.some(key =>
      context.preview.hasCoalescedTextContent(key));
    if (!hasText && state.refusalExplanation?.trim()) {
      const key = "anthropic:refusal-explanation";
      const writer = context.preview.beginCoalescedTextItem(key, {
        side: "response",
        category: "message",
        role: "assistant",
        itemType: "refusal",
        ancestorTypes: ["message_delta", "stop_details"],
        jsonPath: state.refusalExplanationPath
          ?? "$.message.stop_details.explanation",
        parentIdentity: state.messageId
          ? `message:${state.messageId}`
          : "message:refusal",
        semanticLane: "refusal_explanation",
        providerItemId: state.messageId,
        messageStopReason: "refusal",
        syntheticProviderControl: true,
      });
      writer.pushText(state.refusalExplanation);
    }
  }
  context.preview.finishCoalescedTextItems();
}

function isSsePreviewPlaceholderEvent(
  eventType: string | undefined,
  record: Record<string, unknown> | undefined,
): boolean {
  if (eventType === "response.output_item.added") {
    return !hasSsePreviewText(asRecord(record?.item));
  }
  if (eventType === "response.content_part.added") {
    return !hasSsePreviewText(asRecord(record?.part));
  }
  return false;
}

function hasSsePreviewText(value: unknown, depth = 0): boolean {
  if (depth > 4) return false;
  if (typeof value === "string") return value.length > 0;
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY_ITEMS).some(item =>
      hasSsePreviewText(item, depth + 1));
  }
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return [
    "text",
    "content",
    "input",
    "output",
    "arguments",
    "thinking",
    "summary",
    "delta",
    "partial_json",
  ].some(key => hasSsePreviewText(record[key], depth + 1));
}

function isSseControlSnapshotEvent(eventType: string | undefined): boolean {
  if (!eventType) return false;
  return eventType.endsWith(".done")
    || /^response\.(?:created|queued|in_progress|completed|failed|incomplete|cancelled)$/u.test(eventType)
    || eventType === "message_stop"
    || eventType === "content_block_stop";
}

interface BoundedSseEvent {
  candidateIndex: number;
  eventName: string;
  dataChunks: string[];
  done: boolean;
  skipped: boolean;
}

async function* iterateSseEvents(
  source: Readable,
  context: ProjectionContext,
): AsyncGenerator<BoundedSseEvent> {
  const decoder = new StringDecoder("utf8");
  let lineBuffer = "";
  let eventName = "";
  let dataChunks: string[] = [];
  let dataBytes = 0;
  let skipped = false;
  let candidateIndex = 0;

  const emit = (): BoundedSseEvent | undefined => {
    if (dataChunks.length === 0 && !skipped) {
      eventName = "";
      return undefined;
    }
    const raw = dataChunks.join("\n");
    const event: BoundedSseEvent = {
      candidateIndex,
      eventName,
      dataChunks: raw === "[DONE]" ? [] : [raw],
      done: raw === "[DONE]",
      skipped,
    };
    candidateIndex += 1;
    eventName = "";
    dataChunks = [];
    dataBytes = 0;
    skipped = false;
    return event;
  };

  const processLine = (line: string): BoundedSseEvent | undefined => {
    if (line === "") return emit();
    if (line.startsWith(":")) return undefined;
    const separator = line.indexOf(":");
    const field = separator < 0 ? line : line.slice(0, separator);
    let value = separator < 0 ? "" : line.slice(separator + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") {
      eventName = boundedUtf8(value, 128);
    } else if (field === "data" && !skipped) {
      const bytes = Buffer.byteLength(value);
      if (dataBytes + bytes > MAX_SSE_EVENT_BYTES) {
        skipped = true;
        dataChunks = [];
        context.diagnostics.add("sse_event_bytes_exceeded");
        context.limitedDimensions.add("stream_events");
        context.limitedDimensions.add(textDimension(context.options.bodySide));
      } else {
        dataChunks.push(value);
        dataBytes += bytes;
      }
    }
    return undefined;
  };

  for await (const rawChunk of source) {
    lineBuffer += decoder.write(Buffer.from(rawChunk as Uint8Array));
    let newline: number;
    while ((newline = lineBuffer.indexOf("\n")) >= 0) {
      let line = lineBuffer.slice(0, newline);
      lineBuffer = lineBuffer.slice(newline + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      const event = processLine(line);
      if (event) yield event;
    }
    if (Buffer.byteLength(lineBuffer) > MAX_SSE_EVENT_BYTES) {
      lineBuffer = "";
      skipped = true;
      context.diagnostics.add("sse_line_bytes_exceeded");
      context.limitedDimensions.add("stream_events");
    }
  }
  lineBuffer += decoder.end();
  if (lineBuffer) {
    const event = processLine(lineBuffer.endsWith("\r")
      ? lineBuffer.slice(0, -1)
      : lineBuffer);
    if (event) yield event;
  }
  const trailing = emit();
  if (trailing) yield trailing;
}

function previewMetadata(
  side: ProjectionBodySide,
  path: string,
  ancestors: Array<Record<string, unknown>>,
  sseMetadata?: SsePreviewMetadata,
): {
  side: ProjectionBodySide;
  category: string;
  semanticType?: PreviewSemanticType;
  role?: string;
  itemType: string;
  ancestorTypes: string[];
  jsonPath: string;
  parentIdentity: string;
  semanticLane: string;
  providerItemId?: string;
  toolName?: string;
  toolUseId?: string;
  messageStopReason?: string;
  syntheticProviderControl?: boolean;
  semanticOverride?: ConversationSemanticOverride;
} {
  const key = lastPathKey(path);
  const metadata = {
    ...ancestorPreviewMetadata(ancestors),
    ...(sseMetadata ?? {}),
  };
  const toolItem = path.includes("tool") || path.includes("function")
    || metadata.type?.includes("tool") || metadata.type?.includes("function")
    || metadata.type?.includes("input_json")
    || metadata.semanticType === "call_output";
  return {
    side,
    category: toolItem ? "tool" : "message",
    semanticType: metadata.semanticType,
    role: metadata.role,
    itemType: metadata.type ?? (key || "text"),
    ancestorTypes: metadata.types,
    jsonPath: path,
    parentIdentity: metadata.parentIdentity
      ?? (metadata.id
      ? `item:${metadata.id}`
      : semanticParentIdentity(path)),
    semanticLane: metadata.semanticLane
      ?? semanticLaneIdentity(path, metadata.type ?? (key || "text")),
    providerItemId: metadata.providerItemId ?? metadata.id,
    toolName: metadata.name,
    toolUseId: metadata.callId ?? (toolItem ? metadata.id : undefined)
      ?? (toolItem && metadata.index !== undefined
        ? `content-block:${metadata.index}`
        : undefined),
    messageStopReason: metadata.messageStopReason,
    syntheticProviderControl: metadata.syntheticProviderControl,
  };
}

function optionalBoundedString(
  value: unknown,
  maxBytes: number,
): string | undefined {
  return typeof value === "string" && value.length > 0
    ? boundedUtf8(value, maxBytes)
    : undefined;
}

function safeSseIndex(value: unknown): string | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 0
    ? String(value)
    : undefined;
}

function ancestorPreviewMetadata(ancestors: Array<Record<string, unknown>>): {
  semanticType?: PreviewSemanticType;
  role?: string;
  type?: string;
  types: string[];
  name?: string;
  id?: string;
  callId?: string;
  index?: string;
} {
  const result: {
    semanticType?: PreviewSemanticType;
    role?: string;
    type?: string;
    types: string[];
    name?: string;
    id?: string;
    callId?: string;
    index?: string;
  } = { types: [] };
  for (const record of ancestors) {
    if (
      result.semanticType === undefined
      && typeof record.type === "string"
      && isCallOutputType(record.type)
    ) {
      result.semanticType = "call_output";
    }
    if (typeof record.role === "string") result.role = boundedUtf8(record.role, 128);
    if (typeof record.type === "string") {
      const type = boundedUtf8(record.type, 128);
      result.type = type;
      result.types.push(type);
    }
    if (typeof record.name === "string") result.name = boundedUtf8(record.name, 128);
    if (typeof record.id === "string") result.id = boundedUtf8(record.id, 256);
    if (typeof record.call_id === "string") result.callId = boundedUtf8(record.call_id, 256);
    if (Number.isSafeInteger(record.index) && (record.index as number) >= 0) {
      result.index = String(record.index);
    }
  }
  return result;
}

function semanticParentIdentity(path: string): string {
  const container = /^\$\.(input|output|messages|choices|system)\[(\d+)\]/u.exec(path);
  if (container) return `${container[1]}:${container[2]}`;
  const event = /^\$\.events\[(\d+)\]/u.exec(path);
  return event ? `event:${event[1]}` : `path:${boundedUtf8(path, 256)}`;
}

function semanticLaneIdentity(path: string, itemType: string): string {
  const contentIndex = /\.content\[(\d+)\]/u.exec(path)?.[1];
  const summaryIndex = /\.summary\[(\d+)\]/u.exec(path)?.[1];
  const toolIndex = /\.tool_calls\[(\d+)\]/u.exec(path)?.[1];
  if (contentIndex !== undefined) return `content:${contentIndex}:${itemType}`;
  if (summaryIndex !== undefined) return `summary:${summaryIndex}:${itemType}`;
  if (toolIndex !== undefined) return `tool:${toolIndex}:${itemType}`;
  const key = lastPathKey(path);
  return `${key || "value"}:${itemType}`;
}

function isCallOutputType(type: string): boolean {
  return type.split(/\s+/u).some(value =>
    value.endsWith("_call_output") || value.endsWith(".call_output"));
}

function isPreviewTextPath(path: string): boolean {
  const key = lastPathKey(path).toLowerCase();
  return [
    "text",
    "content",
    "input",
    "output",
    "arguments",
    "thinking",
    "reasoning",
    "reasoning_content",
    "refusal",
    "summary",
    "system",
    "instructions",
    "delta",
    "partial_json",
    "image_url",
    "url",
  ].includes(key);
}

function lastPathKey(path: string): string {
  const bracket = /\["((?:[^"\\]|\\.)*)"\]$/.exec(path);
  if (bracket) return bracket[1]!.replace(/\\"/g, "\"");
  return /\.([A-Za-z_$][\w$]*)$/.exec(path)?.[1] ?? "";
}

function jsonPath(parent: string, key: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(key)
    ? `${parent}.${key}`
    : `${parent}[${JSON.stringify(key)}]`;
}

function numberFromJson(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error("JSON number 不是有限数值。");
  return parsed;
}

function utf8BufferPrefix(bytes: Buffer, maxBytes: number): Buffer {
  if (bytes.length <= maxBytes) return bytes;
  let end = maxBytes;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end);
}

function textDimension(side: ProjectionBodySide): LimitedDimension {
  return side === "request" ? "request_text" : "response_text";
}

function mediaDimension(side: ProjectionBodySide): LimitedDimension {
  return side === "request" ? "request_media" : "response_media";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function assertBodySize(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("正文大小必须是非负安全整数。");
  }
}

function uniqueDimensions(
  first: Iterable<LimitedDimension>,
  second: Iterable<LimitedDimension>,
): LimitedDimension[] {
  return [...new Set([...first, ...second])];
}
