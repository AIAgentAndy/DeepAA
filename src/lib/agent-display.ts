const AGENT_LABELS: Readonly<Record<string, string>> = {
  codex: "Codex",
  "claude-code": "Claude Code",
  "anthropic-sdk": "Anthropic SDK",
  "openai-sdk": "OpenAI SDK",
  curl: "curl",
  unknown: "未识别",
};

/** 将稳定的 Agent 大类标识转换为统一展示名，不解析或拼接 fingerprint。 */
export function agentDisplayName(agentName: string): string {
  return AGENT_LABELS[agentName] || agentName;
}
