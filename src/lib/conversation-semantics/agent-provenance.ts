import {
  AGENT_PROFILE_PREFIX_MAX_CHARACTERS,
  classifyAgentProfile,
  profileTextPrefixes,
} from "./agent-profiles";
import type {
  AgentKind,
  ConversationConfidence,
  ConversationProvenance,
  ConversationSemanticCategory,
} from "./types";

export interface AgentEnvelopeClassification {
  semanticCategory: Extract<
    ConversationSemanticCategory,
    "user_injected" | "control"
  >;
  provenance: Extract<
    ConversationProvenance,
    "agent_injected" | "agent_control"
  >;
  confidence: ConversationConfidence;
}

/** 信封分类只消费 Agent Semantic Profile，不再维护第二套 Agent 前缀真相。 */
export function classifyAgentEnvelope(
  agentKind: AgentKind,
  textPrefix: string | undefined,
): AgentEnvelopeClassification | undefined {
  const value = textPrefix?.trimStart();
  if (!value) return undefined;
  const decision = classifyAgentProfile({
    agentKind,
    bodySide: "request",
    providerRole: "user",
    providerItemType: "text",
    evidencePath: "$",
    textPrefix: value,
  });
  if (
    !decision
    || (decision.category !== "user_injected" && decision.category !== "control")
  ) return undefined;
  return {
    semanticCategory: decision.category,
    provenance: decision.provenance === "agent_control"
      ? "agent_control"
      : "agent_injected",
    confidence: decision.confidence,
  };
}

export type AgentEnvelopePrefixDecision =
  | AgentEnvelopeClassification
  | "pending"
  | "protocol_user";

/** 流式调用只缓存 Profile 中声明的稳定前缀；结构化图片规则在有界最大前缀
 * 达到后交给 classifySemanticLane 做一次完整判定。 */
export function classifyAgentEnvelopePrefix(
  agentKind: AgentKind,
  textPrefix: string,
): AgentEnvelopePrefixDecision {
  const value = textPrefix.trimStart();
  if (!value) return "pending";
  const classification = classifyAgentEnvelope(agentKind, value);
  if (classification) return classification;
  const prefixes = profileTextPrefixes(agentKind);
  return prefixes.some(prefix => prefix.startsWith(value))
    ? "pending"
    : "protocol_user";
}

export const AGENT_ENVELOPE_PREFIX_MAX_CHARACTERS = AGENT_PROFILE_PREFIX_MAX_CHARACTERS;
