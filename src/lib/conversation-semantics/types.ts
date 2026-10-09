export const ALL_CONVERSATION_SEMANTIC_CATEGORIES = [
  "system",
  "developer",
  "user_real",
  "user_injected",
  "tool_result",
  "assistant",
  "tool_use",
  "reasoning",
  "refusal",
  "control",
  "unknown_input",
  "unknown_output",
] as const;

export type ConversationSemanticCategory =
  typeof ALL_CONVERSATION_SEMANTIC_CATEGORIES[number];

export type ProtocolKind =
  | "openai-chat-completions"
  | "openai-responses"
  | "anthropic-messages"
  | "unknown";

export type AgentKind = "codex" | "claude-code" | "opencode" | "dsh" | "zcode" | "generic" | "unknown";

export type ConversationBodySide = "request" | "response";

export type ConversationProvenance =
  | "physical_user"
  | "protocol_user"
  | "agent_injected"
  | "agent_control"
  | "model_output"
  | "protocol_system"
  | "tool_runtime"
  | "provider_tool"
  | "provider_control"
  | "unknown";

export type ConversationConfidence =
  | "exact"
  | "structural"
  | "protocol_role"
  | "uncertain";

export type ConversationDisplayPolicy =
  | "conversation"
  | "history_replay"
  | "diagnostic_only";

export type ConversationDedupePolicy =
  | "occurrence"
  | "history_replay"
  | "none";

export type ConversationTurnSignal =
  | "opens_turn"
  | "continues_turn"
  | "neutral";

export interface ConversationSemanticOverride {
  semanticCategory: ConversationSemanticCategory;
  provenance: ConversationProvenance;
  confidence: ConversationConfidence;
}

export type ConversationContentKind =
  | "text"
  | "image"
  | "audio"
  | "file"
  | "document"
  | "json";

export interface ConversationSemanticItem {
  protocol: ProtocolKind;
  agentKind: AgentKind;
  bodySide: ConversationBodySide;
  semanticCategory: ConversationSemanticCategory;
  providerRole?: string;
  providerItemType: string;
  ancestorTypes: string[];
  provenance: ConversationProvenance;
  confidence: ConversationConfidence;
  displayPolicy: ConversationDisplayPolicy;
  dedupePolicy: ConversationDedupePolicy;
  turnSignal: ConversationTurnSignal;
  logicalId: string;
  providerItemId?: string;
  providerLineageKey?: string;
  itemPhase?: "commentary" | "final_answer" | "intermediate";
  toolName?: string;
  toolUseId?: string;
  contentKinds: ConversationContentKind[];
  evidencePath: string;
}

export interface SemanticLaneInput {
  protocol: ProtocolKind;
  agentKind?: AgentKind;
  bodySide: ConversationBodySide;
  providerRole?: string;
  providerItemType: string;
  ancestorTypes?: string[];
  evidencePath: string;
  parentIdentity: string;
  semanticLane: string;
  providerItemId?: string;
  textPrefix?: string;
  itemPhase?: ConversationSemanticItem["itemPhase"];
  toolName?: string;
  toolUseId?: string;
  contentKinds?: ConversationContentKind[];
  messageStopReason?: string;
  syntheticProviderControl?: boolean;
  semanticOverride?: ConversationSemanticOverride;
}

export type RequestContextMode = "full_replay" | "stateful_delta" | "unknown";

export type RequestComparisonKind =
  | "none"
  | "same_epoch"
  | "boundary_carryover";

export interface ConversationRequestContext {
  contextMode: RequestContextMode;
  contextEpoch?: number;
  effectiveBoundaryId?: string;
  producedBoundaryId?: string;
  comparisonKind: RequestComparisonKind;
  baselineExchangeId?: string;
  resolution: "resolved" | "unconfirmed";
}

export interface ConversationFingerprintInput {
  category: ConversationSemanticCategory;
  side: "input" | "output";
  provenance: ConversationProvenance;
  providerItemType: string;
  textSha256: string;
  mediaSha256?: readonly string[];
  contentKinds?: readonly ConversationContentKind[];
  itemPhase?: ConversationSemanticItem["itemPhase"];
  toolName?: string;
  toolUseId?: string;
  evidencePath?: string;
}
