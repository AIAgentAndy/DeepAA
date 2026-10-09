/**
 * 协议流式 lane 分类器（2026-09-17 用户确认的统一口径，唯一真相）。
 *
 * 背景：Worker 投影器（`src/lib/ingestion/protocol-stream-projector.ts`）与交互内容
 * 导出重投影（`src/lib/export-conversation.ts`）曾各自维护一份「SSE 事件 → 逻辑 lane」
 * 的判定，导致同一类事件在两条链上被归到不同类别：
 * - `response.custom_tool_call_input.delta`（Codex 自由格式工具入参）两条链都未识别，
 *   导出链因缺少 lane 身份把中段 delta 归成 `unknown_output`，工具调用被拆成多片；
 * - 非流式 anthropic `tool_use` 块在两条链上的处理也不一致。
 *
 * 本模块只做纯函数判定：输入「协议 + 事件类型 + provider 身份字段」，输出稳定的
 * 聚合键、阶段、归一化家族与语义 lane。两条链必须共同消费，禁止再各写一份正则。
 */

export type SseLanePhase = "start" | "delta" | "final";

export type SseLaneProtocol =
  | "openai-responses"
  | "openai-chat-completions"
  | "anthropic-messages"
  | "unknown";

export interface SseLaneInput {
  protocol: SseLaneProtocol;
  /** SSE 事件类型（优先取 payload.type，取不到时用 event: 名）。 */
  eventType?: string;
  /** JSON/SSE 证据路径；Chat Completions 依赖字段路径区分同一 chunk 内的多个 lane。 */
  evidencePath?: string;
  /** Chat Completions 的 choice 序号。缺省时从 evidencePath 推导。 */
  choiceIndex?: string;
  /** Chat Completions 的并行工具调用序号。缺省时从 evidencePath 推导。 */
  toolCallIndex?: string;
  /** Chat Completions 工具调用元数据。 */
  toolCallId?: string;
  toolName?: string;
  /** openai-responses：增量事件携带的 item_id / message id。 */
  itemId?: string;
  /** openai-responses：output 序号（无 item_id 时的退化身份）。 */
  outputIndex?: string;
  /** openai-responses：content 序号。 */
  contentIndex?: string;
  /** anthropic：content block 序号。 */
  index?: string;
  /** content_block / part 的 provider 类型（anthropic block type、part.type）。 */
  blockType?: string;
}

export interface SseLaneDescriptor {
  /** 稳定聚合键：同一逻辑 lane 的所有 delta 共用同一个 key。 */
  key: string;
  phase: SseLanePhase;
  /**
   * 归一化 lane 家族：`output_text` / `refusal` / `reasoning_summary_text` /
   * `function_call_arguments` / `custom_tool_call_input` / `text` / `thinking` /
   * `tool_use` 等。
   */
  family: string;
  /** 稳定父身份（`item:xxx` / `output:3` / `content-block:2`）。 */
  parentIdentity: string;
  /** 语义 lane（`content:0:output_text` 等），两条链共用同一命名。 */
  semanticLane: string;
  /** Chat Completions 工具调用序号，供迟到元数据回填使用。 */
  toolCallIndex?: string;
  toolCallId?: string;
  toolName?: string;
}

type ModelSseLaneProtocol = Exclude<SseLaneProtocol, "unknown">;
type SseLaneAdapter = (input: SseLaneInput) => SseLaneDescriptor | undefined;

/**
 * openai-responses 的增量家族。`custom_tool_call_input` 是 Codex 自由格式工具
 * （`custom_tool_call` / 内置 exec）的入参增量事件，历史上两条链都漏掉了它。
 */
const OPENAI_RESPONSES_DELTA_FAMILIES = [
  "output_text",
  "refusal",
  "reasoning_summary_text",
  "function_call_arguments",
  "custom_tool_call_input",
] as const;

const OPENAI_RESPONSES_LANE_PATTERN = new RegExp(
  `^response\\.(${OPENAI_RESPONSES_DELTA_FAMILIES.join("|")})\\.(delta|done)$`,
  "u",
);

/** 工具入参家族：这些 lane 产出的条目语义类别为 tool_use。 */
const OPENAI_RESPONSES_TOOL_FAMILIES = new Set<string>([
  "function_call_arguments",
  "custom_tool_call_input",
]);

export function normalizeSseContentFamily(value: string): string {
  return value.trim().toLowerCase().replaceAll("-", "_");
}

export function isOpenAiResponsesToolFamily(family: string): boolean {
  return OPENAI_RESPONSES_TOOL_FAMILIES.has(normalizeSseContentFamily(family));
}

/**
 * 非流式 anthropic content block 类型归一化。
 * 返回 undefined 表示该 block 不产生可展示内容（签名 / 引用等）。
 */
export function normalizeAnthropicBlockType(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = normalizeSseContentFamily(value);
  if (normalized === "text_delta") return "text";
  if (normalized === "thinking_delta") return "thinking";
  if (normalized === "input_json_delta") return "tool_use";
  if (normalized === "signature_delta" || normalized === "citations_delta") {
    return undefined;
  }
  return normalized;
}

/** anthropic 工具类 block：这些 block 的入参需要作为工具调用展示。 */
export function isAnthropicToolBlockType(blockType: string | undefined): boolean {
  const normalized = blockType === undefined
    ? undefined
    : normalizeSseContentFamily(blockType);
  return normalized === "tool_use"
    || normalized === "server_tool_use"
    || normalized === "mcp_tool_use"
    || normalized === "computer_20250124"
    || normalized === "bash_code_execution";
}

/**
 * openai-responses 增量 lane 判定。
 *
 * 覆盖：`response.{output_text|refusal|reasoning_summary_text|function_call_arguments|
 * custom_tool_call_input}.{delta|done}`，以及 `response.content_part.added/done` 与
 * `response.reasoning_summary_part.done` 的 part 类型归一。
 */
export function resolveOpenAiResponsesSseLane(
  input: SseLaneInput,
): SseLaneDescriptor | undefined {
  const eventType = input.eventType;
  if (!eventType) return undefined;
  const direct = OPENAI_RESPONSES_LANE_PATTERN.exec(eventType);
  let family = direct?.[1];
  let phase: SseLanePhase | undefined = direct?.[2] === "delta"
    ? "delta"
    : direct?.[2] === "done" ? "final" : undefined;
  if (eventType === "response.content_part.added" || eventType === "response.content_part.done") {
    if (!input.blockType) return undefined;
    family = normalizeSseContentFamily(input.blockType);
    phase = eventType.endsWith(".added") ? "start" : "final";
  } else if (eventType === "response.reasoning_summary_part.done") {
    family = "reasoning_summary_text";
    phase = "final";
  }
  if (!family || !phase) return undefined;
  const parentIdentity = openAiParentIdentity(input);
  if (!parentIdentity) return undefined;
  const contentIndex = input.contentIndex ?? "0";
  return {
    key: `openai:${parentIdentity}:content:${contentIndex}:${family}`,
    phase,
    family,
    parentIdentity,
    semanticLane: `content:${contentIndex}:${family}`,
  };
}

function openAiParentIdentity(input: SseLaneInput): string | undefined {
  if (input.itemId) return `item:${input.itemId}`;
  return input.outputIndex === undefined ? undefined : `output:${input.outputIndex}`;
}

/**
 * anthropic 流式 lane 判定（`content_block_start` / `content_block_delta`）。
 * block 类型未识别时返回 undefined，交由调用方按需降级。
 */
export function resolveAnthropicSseLane(
  input: SseLaneInput,
): (SseLaneDescriptor & {blockType: string}) | undefined {
  if (input.protocol !== "anthropic-messages") return undefined;
  const eventType = input.eventType;
  if (eventType !== "content_block_start" && eventType !== "content_block_delta") {
    return undefined;
  }
  const index = input.index;
  if (index === undefined) return undefined;
  const blockType = normalizeAnthropicBlockType(input.blockType);
  if (!blockType) return undefined;
  return {
    key: `anthropic:content-block:${index}`,
    phase: eventType === "content_block_delta" ? "delta" : "start",
    family: blockType,
    blockType,
    parentIdentity: `content-block:${index}`,
    semanticLane: `content:${index}:${blockType}`,
  };
}

/**
 * Chat Completions 事件内字段级 lane 判定。
 *
 * 一个 chunk 可以同时带 content、reasoning_content 和多个并行 tool_calls；
 * 因此 lane 身份必须由 choices[i] 下的具体字段路径决定，不能使用事件级 key。
 */
export function resolveOpenAiChatCompletionsSseLane(
  input: SseLaneInput,
): SseLaneDescriptor | undefined {
  const path = input.evidencePath ?? "";
  const choiceIndex = input.choiceIndex ?? path.match(/\.choices\[(\d+)\]/u)?.[1];
  if (choiceIndex === undefined) return undefined;
  const toolCallMatch = path.match(/\.tool_calls\[(\d+)\]/u);
  const toolCallIndex = input.toolCallIndex ?? toolCallMatch?.[1];
  const lastKey = path.match(/\.([A-Za-z_$][\w$]*)$/u)?.[1] ?? "";
  const eventType = input.eventType ?? "";
  const isDelta = eventType === ""
    || eventType === "chat.completion.chunk"
    || eventType === "message";
  if (!isDelta) return undefined;

  let family: string;
  let semanticLane: string;
  let parentIdentity = "choice:" + choiceIndex;
  if (toolCallIndex !== undefined && (
    lastKey === "arguments"
    || path.includes(".function.arguments")
  )) {
    family = "tool_use";
    semanticLane = "choice:" + choiceIndex + ":tool:" + toolCallIndex;
    parentIdentity = semanticLane;
  } else if (lastKey === "content") {
    family = "content";
    semanticLane = "choice:" + choiceIndex + ":content";
  } else if (lastKey === "reasoning_content" || lastKey === "reasoning") {
    family = "reasoning";
    semanticLane = "choice:" + choiceIndex + ":reasoning";
  } else if (lastKey === "refusal") {
    family = "refusal";
    semanticLane = "choice:" + choiceIndex + ":refusal";
  } else {
    return undefined;
  }

  return {
    key: "chat:" + semanticLane,
    phase: "delta",
    family,
    parentIdentity,
    semanticLane,
    ...(toolCallIndex !== undefined ? {toolCallIndex} : {}),
    ...(input.toolCallId !== undefined ? {toolCallId: input.toolCallId} : {}),
    ...(input.toolName !== undefined ? {toolName: input.toolName} : {}),
  };
}

const SSE_LANE_ADAPTERS = {
  "openai-responses": resolveOpenAiResponsesSseLane,
  "openai-chat-completions": resolveOpenAiChatCompletionsSseLane,
  "anthropic-messages": resolveAnthropicSseLane,
} satisfies Record<ModelSseLaneProtocol, SseLaneAdapter>;

export function hasSseLaneAdapter(protocol: SseLaneProtocol): boolean {
  return protocol !== "unknown" && SSE_LANE_ADAPTERS[protocol] !== undefined;
}

/** 协议无关入口：三种模型协议都必须通过同一份注册表分派。 */
export function resolveSseLane(input: SseLaneInput): SseLaneDescriptor | undefined {
  if (input.protocol === "unknown") return undefined;
  return SSE_LANE_ADAPTERS[input.protocol](input);
}

/**
 * anthropic 非流式 `tool_use` / `server_tool_use` 块的规范化身份。
 * 非流式 JSON 路径下，工具入参是对象（没有可用的文本白名单键），必须由调用方
 * 按块补齐条目——本函数给出与流式路径一致的父身份与 lane 命名。
 */
export function anthropicJsonToolBlockLane(input: {
  index: number;
  blockType: string;
  toolUseId?: string;
  messageId?: string;
}): {parentIdentity: string; semanticLane: string} {
  const providerItemId = input.toolUseId ?? input.messageId;
  return {
    parentIdentity: providerItemId ? `item:${providerItemId}` : `content-block:${input.index}`,
    semanticLane: `content:${input.index}:${normalizeSseContentFamily(input.blockType)}`,
  };
}

/**
 * 判断某个 JSON 帧的元数据是否属于「工具调用块」——非流式路径据此把工具入参
 * 下的所有字符串/数字叶子都当作可展示正文（而不是要求键名命中白名单）。
 */
export function isToolBlockMetadata(metadata: {
  type?: string;
  semanticType?: string;
}): boolean {
  if (metadata.semanticType === "call_output") return false;
  const type = metadata.type === undefined ? "" : normalizeSseContentFamily(metadata.type);
  if (!type) return false;
  if (type.includes("tool_call_output") || type.includes("call_output")) return false;
  return type === "tool_use"
    || type === "server_tool_use"
    || type === "mcp_tool_use"
    || type === "function_call"
    || type === "custom_tool_call"
    || type === "computer_call"
    || type === "shell_call"
    || type === "local_shell_call"
    || type === "apply_patch_call"
    || type === "mcp_call"
    || type === "programmatic_function_call"
    || type === "tool_search_call"
    || type === "input_json";
}
