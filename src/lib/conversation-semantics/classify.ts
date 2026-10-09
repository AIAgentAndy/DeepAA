import { createHash } from "node:crypto";
import { classifyAgentEnvelope } from "./agent-provenance";
import { classifyAgentProfile } from "./agent-profiles";
import type {
  ConversationConfidence,
  ConversationBodySide,
  ConversationDedupePolicy,
  ConversationDisplayPolicy,
  ConversationFingerprintInput,
  ConversationProvenance,
  ConversationSemanticCategory,
  ConversationSemanticItem,
  ConversationTurnSignal,
  SemanticLaneInput,
} from "./types";

interface SemanticDecision {
  category: ConversationSemanticCategory;
  provenance: ConversationProvenance;
  confidence: ConversationConfidence;
  historyReplay?: boolean;
}

export function classifySemanticLane(
  input: SemanticLaneInput,
): ConversationSemanticItem {
  const agentKind = input.agentKind ?? "unknown";
  const decision = input.bodySide === "response"
    ? classifyResponse(input)
    : classifyRequest(input);
  const historyReplay = decision.historyReplay === true;
  const displayPolicy: ConversationDisplayPolicy = historyReplay
    ? "history_replay"
    : "conversation";
  const dedupePolicy: ConversationDedupePolicy = historyReplay
    ? "history_replay"
    : input.bodySide === "response" ? "none" : "occurrence";
  return {
    protocol: input.protocol,
    agentKind,
    bodySide: input.bodySide,
    semanticCategory: decision.category,
    providerRole: input.providerRole,
    providerItemType: input.providerItemType,
    ancestorTypes: [...(input.ancestorTypes ?? [])],
    provenance: decision.provenance,
    confidence: decision.confidence,
    displayPolicy,
    dedupePolicy,
    turnSignal: turnSignalFor(input.bodySide, decision.category),
    logicalId: buildSemanticLogicalId(
      input.bodySide,
      input.parentIdentity,
      input.semanticLane,
    ),
    providerItemId: input.providerItemId,
    providerLineageKey: input.providerItemId
      ? buildProviderLineageKey(input.providerItemId, input.semanticLane)
      : undefined,
    itemPhase: input.itemPhase,
    toolName: input.toolName,
    toolUseId: input.toolUseId,
    contentKinds: [...(input.contentKinds ?? ["text"])],
    evidencePath: input.evidencePath,
  };
}

export function buildSemanticLogicalId(
  bodySide: "request" | "response",
  parentIdentity: string,
  semanticLane: string,
): string {
  return `semantic:${encodeIdentityPart(bodySide)}:${encodeIdentityPart(parentIdentity)}:${encodeIdentityPart(semanticLane)}`;
}

export function buildProviderLineageKey(
  providerItemId: string,
  semanticLane: string,
): string {
  return `provider:${encodeIdentityPart(providerItemId)}:${encodeIdentityPart(semanticLane)}`;
}

/** 指纹排除 evidencePath/数组索引，避免完整历史重排破坏 occurrence 继承。 */
export function conversationFingerprintKey(
  input: ConversationFingerprintInput,
): string {
  return createHash("sha256").update(JSON.stringify({
    category: input.category,
    side: input.side,
    provenance: input.provenance,
    // 归一化 wire 形态：字符串 content 与单 text part 是同一逻辑内容（2026-09-17
    // 实测 opencode/claude-code 客户端会在两种形态间重排同一文本）。
    providerItemType: normalizeFingerprintItemType(input.providerItemType),
    textSha256: input.textSha256,
    mediaSha256: [...(input.mediaSha256 ?? [])],
    contentKinds: [...(input.contentKinds ?? [])],
    itemPhase: input.itemPhase,
    toolName: input.toolName,
    toolUseId: input.toolUseId,
  })).digest("hex");
}

function normalizeFingerprintItemType(value: string): string {
  const type = normalizeType(value);
  return type === "content" ? "text" : type;
}

/** Preview、Raw 与 Normalizer 共用同一内容类型归一化，避免指纹分叉。 */
export function conversationContentKindsFor(
  providerItemType: string,
  hasMedia: boolean,
): ConversationSemanticItem["contentKinds"] {
  const type = normalizeType(providerItemType);
  if (type.includes("image")) return ["image"];
  if (type.includes("audio")) return ["audio"];
  if (type.includes("document")) return ["document"];
  if (type.includes("file")) return ["file"];
  if (
    type.includes("json")
    || type.includes("arguments")
    || type.includes("input_json")
  ) {
    return hasMedia ? ["json", "image"] : ["json"];
  }
  return hasMedia ? ["text", "image"] : ["text"];
}

/** 媒体占位只用于代表项优先级，不参与类别推断。 */
export function isMediaOnlyConversationPreview(
  textPreview: string | undefined,
  mediaDescriptorOrdinals: readonly number[] | undefined,
): boolean {
  if (!textPreview?.trim() || !mediaDescriptorOrdinals?.length) return false;
  return textPreview.replace(/\[media\]/gu, "").trim().length === 0;
}

function classifyRequest(input: SemanticLaneInput): SemanticDecision {
  const role = input.providerRole?.toLowerCase();
  const path = input.evidencePath.toLowerCase();
  const types = normalizedTypes(input);

  if (isProtocolSystem(role, path, types)) {
    return exact("system", "protocol_system");
  }
  if (role === "developer" || types.has("developer")) {
    return exact("developer", "protocol_system");
  }
  if (isCompaction(types)) {
    return {
      ...exact("control", "provider_control"),
      historyReplay: true,
    };
  }
  if (isProviderToolResult(types)) {
    return {
      ...exact("tool_result", "provider_tool"),
      historyReplay: true,
    };
  }
  if (isToolResult(role, path, types)) {
    return exact("tool_result", "tool_runtime");
  }
  if (isReasoning(types, path)) {
    return {
      ...exact("reasoning", "model_output"),
      historyReplay: true,
    };
  }
  if (isToolUse(types, path)) {
    return {
      ...exact("tool_use", "model_output"),
      historyReplay: true,
    };
  }
  if (input.semanticOverride) {
    return {
      category: input.semanticOverride.semanticCategory,
      provenance: input.semanticOverride.provenance,
      confidence: input.semanticOverride.confidence,
    };
  }
  if (role === "assistant" || types.has("output_text") || types.has("refusal")) {
    return {
      ...exact(
        types.has("refusal") ? "refusal" : "assistant",
        "model_output",
      ),
      historyReplay: true,
    };
  }

  if (role === "user" || isProtocolUserInput(input.protocol, path, types)) {
    const profile = classifyAgentProfile({
      agentKind: input.agentKind ?? "unknown",
      bodySide: input.bodySide,
      providerRole: input.providerRole,
      providerItemType: input.providerItemType,
      ancestorTypes: input.ancestorTypes,
      evidencePath: input.evidencePath,
      textPrefix: input.textPrefix,
    });
    const envelope = profile && (profile.category === "user_injected" || profile.category === "control")
      ? {
          semanticCategory: profile.category,
          provenance: profile.provenance === "agent_control" ? "agent_control" : "agent_injected",
          confidence: profile.confidence,
        }
      : classifyAgentEnvelope(
          input.agentKind ?? "unknown",
          input.textPrefix,
        );
    if (profile?.category === "tool_result") {
      return {
        category: "tool_result",
        provenance: profile.provenance as ConversationProvenance,
        confidence: profile.confidence,
      };
    }
    if (envelope) {
      return {
        category: envelope.semanticCategory,
        provenance: envelope.provenance as ConversationProvenance,
        confidence: envelope.confidence,
      };
    }
    if (input.agentKind === "codex" || input.agentKind === "claude-code") {
      return {
        category: "user_real",
        provenance: "physical_user",
        confidence: "structural",
      };
    }
    return {
      category: "user_real",
      provenance: "protocol_user",
      confidence: "protocol_role",
    };
  }
  return uncertain("unknown_input");
}

function turnSignalFor(
  side: ConversationBodySide,
  category: ConversationSemanticCategory,
): ConversationTurnSignal {
  if (side === "response") return "neutral";
  if (category === "user_real") return "opens_turn";
  if (category === "tool_result") return "continues_turn";
  return "neutral";
}

function classifyResponse(input: SemanticLaneInput): SemanticDecision {
  const path = input.evidencePath.toLowerCase();
  const types = normalizedTypes(input);
  if (isCompaction(types)) return exact("control", "provider_control");
  if (
    input.messageStopReason?.toLowerCase() === "refusal"
    || types.has("refusal")
    || path.includes(".refusal")
  ) {
    return exact(
      "refusal",
      input.syntheticProviderControl ? "provider_control" : "model_output",
    );
  }
  if (isReasoning(types, path)) return exact("reasoning", "model_output");
  if (isProviderToolResult(types)) return exact("tool_result", "provider_tool");
  if (isToolUse(types, path)) return exact("tool_use", "model_output");
  if (
    hasType(types, "text")
    || hasType(types, "content")
    || hasType(types, "output_text")
    || hasType(types, "audio")
    || input.providerRole?.toLowerCase() === "assistant"
  ) {
    return exact("assistant", "model_output");
  }
  return uncertain("unknown_output");
}

function hasType(types: ReadonlySet<string>, expected: string): boolean {
  return [...types].some(type =>
    type === expected
    || type.split(/[.\s]/u).includes(expected)
    || type.includes(`_${expected}`)
    || type.includes(`${expected}_`));
}

function normalizedTypes(input: SemanticLaneInput): Set<string> {
  return new Set([
    input.providerItemType,
    ...(input.ancestorTypes ?? []),
  ].flatMap(value => normalizeType(value).split(/\s+/u)).filter(Boolean));
}

function normalizeType(value: string): string {
  return value.trim().toLowerCase().replaceAll("-", "_");
}

function isProtocolSystem(
  role: string | undefined,
  path: string,
  types: ReadonlySet<string>,
): boolean {
  return role === "system"
    || path === "$.system"
    || path.startsWith("$.system[")
    || path === "$.instructions"
    || path.startsWith("$.instructions.")
    || types.has("system")
    || types.has("mid_conv_system");
}

function isProtocolUserInput(
  protocol: SemanticLaneInput["protocol"],
  path: string,
  types: ReadonlySet<string>,
): boolean {
  if (types.has("input_text") || types.has("input_image") || types.has("input_audio")) {
    return true;
  }
  if (protocol === "openai-responses") return path.startsWith("$.input");
  if (protocol === "anthropic-messages") return path.startsWith("$.messages[");
  return false;
}

function isToolResult(
  role: string | undefined,
  path: string,
  types: ReadonlySet<string>,
): boolean {
  return role === "tool"
    || path.includes("tool_result")
    || path.includes("call_output")
    || [...types].some(type =>
      type === "tool_result"
      || type.endsWith("_call_output")
      || type.endsWith(".call_output")
      || type === "mcp_approval_response");
}

function isProviderToolResult(types: ReadonlySet<string>): boolean {
  return [...types].some(type =>
    type.includes("server_tool_result")
    || type.includes("web_search_result")
    || type.includes("web_fetch_result")
    || type.includes("code_execution_result")
    || type.includes("bash_code_execution_result")
    || type.includes("text_editor_code_execution_result")
    || type.includes("tool_search_result")
    || type === "container_upload");
}

function isToolUse(types: ReadonlySet<string>, path: string): boolean {
  return path.includes("tool_calls")
    || path.includes("function_call")
    || [...types].some(type =>
      type === "tool_use"
      || type === "server_tool_use"
      || type === "function_call"
      || type === "custom_tool_call"
      // Codex 自由格式工具的入参增量事件（response.custom_tool_call_input.delta）：
      // 导出链拿到的是归一 family（custom_tool_call_input），Worker 链拿到的是带点
      // 的事件类型，两种形态都要命中，否则中段 delta 会被归到 unknown_output。
      || hasType(types, "custom_tool_call_input")
      || type === "mcp_tool_use"
      || type === "computer_call"
      || type === "shell_call"
      || type === "local_shell_call"
      || type === "apply_patch_call"
      || type === "mcp_call"
      || type === "programmatic_function_call"
      || type === "tool_search_call"
      || type.includes("function_call_arguments")
      || type === "input_json_delta");
}

function isReasoning(types: ReadonlySet<string>, path: string): boolean {
  return path.includes(".reasoning")
    || path.includes(".thinking")
    || [...types].some(type =>
      type === "reasoning"
      || type === "thinking"
      || type === "redacted_thinking"
      || type === "summary"
      || type === "summary_text"
      || type.includes("reasoning_summary"));
}

function isCompaction(types: ReadonlySet<string>): boolean {
  return types.has("compaction");
}

function exact(
  category: ConversationSemanticCategory,
  provenance: ConversationProvenance,
): SemanticDecision {
  return { category, provenance, confidence: "exact" };
}

function uncertain(category: ConversationSemanticCategory): SemanticDecision {
  return {
    category,
    provenance: "unknown",
    confidence: "uncertain",
  };
}

function encodeIdentityPart(value: string): string {
  return `${Buffer.byteLength(value, "utf8")}:${value}`;
}
