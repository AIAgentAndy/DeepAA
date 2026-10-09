/**
 * 「本 Turn 用户输入」正文选取的共享纯函数。
 *
 * 两个读取端必须共用同一套规则，保证预览与完整读取展示的是同一条正文：
 * - 预览端：SQLite Content Preview 投影的 user_real 条目（单条上限 4 KiB）；
 * - 完整端：交互内容 NDJSON 流（显式点击、声明字节预算的有界 raw 读取）。
 */

import { classifyAgentProfile } from "./conversation-semantics/agent-profiles";
import type { AgentKind, ConversationSemanticCategory } from "./conversation-semantics";

/** 兼容没有携带 semanticCategory 的旧调用：规则仍来自统一 Agent Profile，
 * 不在正文选择器内维护第二套前缀集合。 */
export function looksLikeInjectedEnvelope(
  text: string,
  agentKinds: readonly AgentKind[] = ["codex", "claude-code", "opencode", "dsh", "zcode"],
): boolean {
  const value = text.trimStart();
  if (!value) return false;
  return agentKinds.some(agentKind => {
    const decision = classifyAgentProfile({
      agentKind,
      bodySide: "request",
      providerRole: "user",
      providerItemType: "text",
      evidencePath: "$",
      textPrefix: value,
    });
    return decision?.category === "user_injected"
      || decision?.category === "control"
      || decision?.category === "tool_result";
  });
}

/**
 * 选取「本 Turn 用户输入」：最后一个人类输入条目优先（一个 Turn 必然由一次
 * 真实用户输入开启，它位于首步请求历史回放的末尾）；全部像注入时如实降级取最后一条。
 */
export function pickTurnUserPromptItem<T>(
  items: readonly T[],
  textOf: (item: T) => string | undefined,
): T | undefined {
  const candidates = items.filter(item => (textOf(item) ?? "").trim() !== "");
  const classified = candidates.filter(item => {
    const category = semanticCategoryOf(item);
    return category === "user_real";
  });
  if (classified.length > 0) return classified.at(-1);
  const humanLike = candidates.filter(item => !looksLikeInjectedEnvelope(textOf(item) ?? ""));
  return humanLike.at(-1) ?? candidates.at(-1);
}

function semanticCategoryOf(value: unknown): ConversationSemanticCategory | undefined {
  if (!value || typeof value !== "object") return undefined;
  const category = (value as {semanticCategory?: unknown}).semanticCategory;
  return typeof category === "string"
    && [
      "system", "developer", "user_real", "user_injected",
      "tool_result", "assistant", "tool_use", "reasoning",
      "refusal", "control", "unknown_input", "unknown_output",
    ].includes(category)
    ? category as ConversationSemanticCategory
    : undefined;
}
