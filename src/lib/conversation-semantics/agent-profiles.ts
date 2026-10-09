import type {
  AgentKind,
  ConversationConfidence,
  ConversationProvenance,
  ConversationSemanticCategory,
  ConversationBodySide,
} from "./types";

/** Agent 规则的传播范围：part 只影响当前 part，message 影响整条消息，
 * message-remainder 从 marker 所在 part 起影响后续 sibling。 */
export type AgentSemanticRuleScope = "part" | "message" | "message-remainder";

export interface AgentSemanticProfileInput {
  agentKind: AgentKind;
  bodySide: ConversationBodySide;
  providerRole?: string;
  providerItemType: string;
  ancestorTypes?: readonly string[];
  evidencePath: string;
  textPrefix?: string;
}

export interface AgentSemanticProfileDecision {
  category: ConversationSemanticCategory;
  provenance: ConversationProvenance;
  confidence: ConversationConfidence;
  scope: AgentSemanticRuleScope;
}

interface AgentSemanticRule {
  scope: AgentSemanticRuleScope;
  textPrefixes?: readonly string[];
  match: (input: AgentSemanticProfileInput, value: string) => boolean;
  decision: AgentSemanticProfileDecision;
}

export interface AgentSemanticProfile {
  kind: AgentKind;
  rules: readonly AgentSemanticRule[];
}

const CODEX_INJECTED_PREFIXES = [
  "# AGENTS.md instructions",
  "<environment_context>",
  "<permissions instructions>",
  "<INSTRUCTIONS>",
  "<system-reminder>",
  "# Model Set Context",
  "Perform a web search for the query:",
  "The following skills are available",
] as const;

const CODEX_CONTROL_PREFIXES = [
  "You are performing a CONTEXT CHECKPOINT COMPACTION",
  "Another language model started to solve this problem and produced a summary of its thinking process.",
  "<compact_boundary",
  "compact_boundary",
  "SessionStart(source=compact)",
] as const;

const CLAUDE_CONTROL_PREFIXES = [
  "<compact_boundary",
  "compact_boundary",
  "SessionStart(source=compact)",
  "<total_tokens>",
] as const;

const COMMON_OPEN_CODE_INJECTED_PREFIXES = [
  "[Category+Skill Reminder]",
  "<system-reminder>",
] as const;

const DSH_RUNTIME_PREFIX = "Current runtime context";
const DSH_TOOL_RESULT_IMAGE_PREFIX = "Attached image(s) from tool result:";

/** dsh 的图片句柄必须同时具备编号/括号或显式图片元数据，避免把普通
 * `Image \"...\"` 用户文本误识别为 Agent 注入。 */
export function isDshImageHandle(value: string): boolean {
  const text = value.trim();
  return /^\[Image\s+#\d+(?::[^\]]+)?\](?:\s*\([^)]*\))?$/iu.test(text)
    || /^Image\s+#\d+\s+\([^)]*(?:image\/|\d+\s*[x×]\s*\d+)[^)]*\)$/iu.test(text)
    || /^Image:\s*\[Image\s+#\d+(?::[^\]]+)?\](?:\s*\([^)]*\))?$/iu.test(text);
}

function prefixRule(
  prefixes: readonly string[],
  scope: AgentSemanticRuleScope,
  category: ConversationSemanticCategory,
  provenance: ConversationProvenance,
): AgentSemanticRule {
  return {
    scope,
    textPrefixes: prefixes,
    match: (_input, value) => prefixes.some(prefix => value.startsWith(prefix)),
    decision: {category, provenance, confidence: "exact", scope},
  };
}

const profileRules = {
  codex: [
    ...CODEX_CONTROL_PREFIXES.map(prefix => prefixRule(
      [prefix], "message", "control", "agent_control",
    )),
    ...CODEX_INJECTED_PREFIXES.map(prefix => prefixRule(
      [prefix], "message", "user_injected", "agent_injected",
    )),
  ],
  "claude-code": [
    ...CLAUDE_CONTROL_PREFIXES.map(prefix => prefixRule(
      [prefix], "message", "control", "agent_control",
    )),
    prefixRule(["<system-reminder>"], "message", "user_injected", "agent_injected"),
  ],
  zcode: [
    ...CLAUDE_CONTROL_PREFIXES.map(prefix => prefixRule(
      [prefix], "message", "control", "agent_control",
    )),
    prefixRule(["<system-reminder>"], "message", "user_injected", "agent_injected"),
  ],
  opencode: COMMON_OPEN_CODE_INJECTED_PREFIXES.map(prefix => prefixRule(
    [prefix], "message", "user_injected", "agent_injected",
  )),
  dsh: [
    ...COMMON_OPEN_CODE_INJECTED_PREFIXES.map(prefix => prefixRule(
      [prefix], "message", "user_injected", "agent_injected",
    )),
    prefixRule(
      [DSH_RUNTIME_PREFIX], "message", "user_injected", "agent_injected",
    ),
    prefixRule(
      [DSH_TOOL_RESULT_IMAGE_PREFIX],
      "message-remainder",
      "tool_result",
      "provider_tool",
    ),
    {
      scope: "part" as const,
      textPrefixes: ["Image #", "[Image", "Image: [Image"],
      match: (_input: AgentSemanticProfileInput, value: string) => isDshImageHandle(value),
      decision: {
        category: "user_injected" as const,
        provenance: "agent_injected" as const,
        confidence: "exact" as const,
        scope: "part" as const,
      },
    },
  ],
  generic: [],
  unknown: [],
} satisfies Record<AgentKind, readonly AgentSemanticRule[]>;

const PROFILES: Readonly<Record<AgentKind, AgentSemanticProfile>> = Object.fromEntries(
  (Object.keys(profileRules) as AgentKind[]).map(kind => [kind, {kind, rules: profileRules[kind]}]),
) as unknown as Record<AgentKind, AgentSemanticProfile>;

export function profileForAgent(agentKind: AgentKind | undefined): AgentSemanticProfile {
  if (agentKind === "generic" || !agentKind || agentKind === "unknown") return PROFILES.generic!;
  if (PROFILES[agentKind]) return PROFILES[agentKind]!;
  return PROFILES.generic!;
}

export function classifyAgentProfile(
  input: AgentSemanticProfileInput,
): AgentSemanticProfileDecision | undefined {
  if (input.bodySide !== "request") return undefined;
  const value = input.textPrefix?.trimStart();
  if (!value) return undefined;
  const profile = profileForAgent(input.agentKind);
  for (const rule of profile.rules) {
    if (rule.match(input, value)) return rule.decision;
  }
  return undefined;
}

/** 流式探针所需的有界文本前缀；正则图片规则不参与 pending，交给最大前缀
 * 兜底分类，避免为了猜测完整句柄而无限缓存。 */
export function profileTextPrefixes(agentKind: AgentKind | undefined): readonly string[] {
  const result: string[] = [];
  for (const rule of profileForAgent(agentKind).rules) {
    for (const prefix of rule.textPrefixes ?? []) {
      if (!result.includes(prefix)) result.push(prefix);
    }
  }
  return result;
}

export const AGENT_PROFILE_PREFIX_MAX_CHARACTERS = Math.max(
  256,
  ...Object.keys(profileRules).flatMap(kind =>
    profileTextPrefixes(kind as AgentKind).map(prefix => prefix.length)),
);
