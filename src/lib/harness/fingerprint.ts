import { classifyProtocol } from "./protocol";
import { semanticKindByGatewayId } from "../agent-registry";
import type { Confidence, EvidencePointer, RawCapturedExchange } from "./types";

export interface AgentFingerprint {
  id: string;
  agentName:
    | "claude-code"
    | "codex"
    | "opencode"
    | "dsh"
    | "zcode"
    | "anthropic-sdk"
    | "openai-sdk"
    | "curl"
    | "unknown";
  agentVersion?: string;
  protocol: string;
  sdk?: string;
  confidence: Confidence;
  evidence: Array<{
    kind: "header" | "user-agent" | "path" | "body-shape" | "tool-schema" | "target-format" | "routing-agent";
    value: string;
    confidence: Confidence;
    evidence: EvidencePointer[];
  }>;
}

export function fingerprintAgent(exchange: RawCapturedExchange): AgentFingerprint {
  const protocol = classifyProtocol(exchange).protocol;
  const headers = exchange.request.headers;
  const userAgent = headers["user-agent"] || "";
  const evidence: AgentFingerprint["evidence"] = [];
  const addEvidence = (kind: AgentFingerprint["evidence"][number]["kind"], value: string, confidence: Confidence = "high") => {
    evidence.push({
      kind,
      value,
      confidence,
      evidence: [{ exchangeId: exchange.exchangeId, side: "request", path: kind === "path" ? "routing.upstreamPath" : `headers.${kind}` }],
    });
  };

  // 网关路径是最可信证据：/{agent}/v1 由注册表白名单解析，先于任何头部猜测。
  if (exchange.routing.agent) {
    const routed = routingAgentName(exchange.routing.agent);
    if (routed) {
      addEvidence("routing-agent", exchange.routing.agent);
      return makeFingerprint(exchange, routed, protocol, evidence, "exact");
    }
  }
  // ZCode 指纹必须先于 opencode 兜底判断：两者都可能携带通用 x-session-id，
  // ZCode 另有专属 UA（ZCode/<ver>）与 x-zcode-* 头，优先级更高。
  if (
    /^zcode\//iu.test(userAgent)
    || headers["x-zcode-agent"]
    || headers["x-zcode-app-version"]
    || headers["x-zcode-trace-id"]
  ) {
    addEvidence("header", headers["x-zcode-agent"] || userAgent, "exact");
    return makeFingerprint(exchange, "zcode", protocol, evidence, "exact");
  }
  if (
    headers["x-opencode-session"]
    || headers["x-session-affinity"]
    || headers["x-session-id"]
    || /\bopencode\//iu.test(userAgent)
  ) {
    addEvidence(
      "header",
      headers["x-opencode-session"] || headers["x-session-affinity"] || headers["x-session-id"] || userAgent,
      headers["x-opencode-session"] || headers["x-session-affinity"] || headers["x-session-id"] ? "exact" : "high",
    );
    return makeFingerprint(exchange, "opencode", protocol, evidence, "exact");
  }
  if (
    headers["x-deepseek-harness-session-id"]
    || headers["x-deepseek-harness-user-id"]
    || /deepseek-harness\//iu.test(userAgent)
  ) {
    addEvidence(
      "header",
      headers["x-deepseek-harness-session-id"] || headers["x-deepseek-harness-user-id"] || userAgent,
      headers["x-deepseek-harness-session-id"] || headers["x-deepseek-harness-user-id"] ? "exact" : "high",
    );
    return makeFingerprint(exchange, "dsh", protocol, evidence, "exact");
  }
  if (headers["x-claude-code-session-id"] || userAgent.includes("claude-cli")) {
    addEvidence("header", "x-claude-code-session-id", headers["x-claude-code-session-id"] ? "exact" : "high");
    return makeFingerprint(exchange, "claude-code", protocol, evidence, "exact");
  }
  if (
    headers.session_id
    || headers["session-id"]
    || headers["x-codex-turn-metadata"]
    || /\bcodex(?:[-_/]|$)/iu.test(userAgent)
  ) {
    addEvidence(
      "header",
      headers.session_id
        ? "session_id"
        : headers["session-id"] ? "session-id" : userAgent,
      headers.session_id || headers["session-id"] ? "exact" : "high",
    );
    return makeFingerprint(exchange, "codex", protocol, evidence, "exact");
  }
  if (/Anthropic\/|anthropic/i.test(userAgent)) {
    addEvidence("user-agent", userAgent);
    return makeFingerprint(exchange, "anthropic-sdk", protocol, evidence, "high");
  }
  if (/OpenAI\/|openai/i.test(userAgent)) {
    addEvidence("user-agent", userAgent);
    return makeFingerprint(exchange, "openai-sdk", protocol, evidence, "high");
  }
  if (/curl/i.test(userAgent)) {
    addEvidence("user-agent", userAgent);
    return makeFingerprint(exchange, "curl", protocol, evidence, "high");
  }
  addEvidence("target-format", exchange.routing.targetFormatHint, "low");
  return makeFingerprint(exchange, "unknown", protocol, evidence, "low");
}

function routingAgentName(value: string): AgentFingerprint["agentName"] | undefined {
  // 注册表驱动：网关 AgentId → 语义 AgentKind 的唯一映射点在 agent-registry。
  const kind = semanticKindByGatewayId(value.trim());
  return kind !== undefined && kind !== "generic" ? kind : undefined;
}

function makeFingerprint(
  _exchange: RawCapturedExchange,
  agentName: AgentFingerprint["agentName"],
  protocol: string,
  evidence: AgentFingerprint["evidence"],
  confidence: Confidence
): AgentFingerprint {
  return {
    // 指纹 ID 只表达客户端身份（2026-09-17 Agent 维度会话）：protocol/targetId 是
    // 路由属性（OpenCode 同一会话可跨 wire API、Codex 失败切换必然跨 target），
    // 掺入身份会让同一业务会话在会话追踪里被拆散。
    id: `fp-${agentName}`,
    agentName,
    protocol,
    confidence,
    evidence,
  };
}
