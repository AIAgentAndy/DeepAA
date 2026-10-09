import type { Confidence, EvidencePointer, RawCapturedExchange } from "./types";

export type ProtocolKind =
  | "openai-responses"
  | "openai-chat-completions"
  | "anthropic-messages"
  | "anthropic-count-tokens"
  | "unknown";

export type EndpointKind =
  | "model-call"
  | "token-count"
  | "metadata"
  | "health-check"
  | "title-generation"
  | "unknown";

export interface ProtocolClassification {
  exchangeId: string;
  protocol: ProtocolKind;
  endpointKind: EndpointKind;
  isModelCall: boolean;
  isAuxiliary: boolean;
  confidence: Confidence;
  evidence: EvidencePointer[];
}

export function classifyProtocol(exchange: RawCapturedExchange): ProtocolClassification {
  const path = exchange.routing.upstreamPath || exchange.routing.localPath;
  const request = asRecord(exchange.request.parsedBody);
  const response = asRecord(exchange.response.parsedBody);
  const streamEvents = exchange.stream?.events.map(event => event.event) || [];
  const wireApi = exchange.routing.wireApi;

  // Agent 客户端自报的调用来源优先判定（本地导入链路）：session_title 是 Agent 自己
  // 发起的辅助请求，不能当成模型 Step——它既不承载会话上下文，又会污染同 Thread 的
  // 请求排重链（实测：标题行夹在主请求之间会把后续步骤判成「未排重」并额外切出 Turn）。
  const auxiliaryKind = auxiliaryEndpointFromClientQuerySource(
    exchange.routing.clientQuerySource,
  );
  if (auxiliaryKind) {
    return classification(
      exchange,
      protocolFromRouting(wireApi, path),
      auxiliaryKind,
      "exact",
      "routing",
      "clientQuerySource",
    );
  }

  // 网关链路没有客户端自报来源：按 per-agent 有界内容签名识别标题生成等辅助
  // 调用（实测：zcode/claude-code/opencode/codex 的标题调用一旦成为 Step/Turn，
  // 既产生幻影层级，又把交互内容的排重基线起点污染成不可比较）。
  if (isAuxiliaryTitleRequest(exchange)) {
    return classification(
      exchange,
      protocolFromRouting(wireApi, path),
      "title-generation",
      "high",
      "request",
      "messages",
    );
  }

  if (path.endsWith("/messages/count_tokens") || path.endsWith("/v1/messages/count_tokens")) {
    return classification(exchange, "anthropic-count-tokens", "token-count", "exact", "routing", "upstreamPath");
  }
  if (path.endsWith("/models") || path.endsWith("/v1/models")) {
    return classification(exchange, "unknown", "metadata", "exact", "routing", "upstreamPath");
  }
  // 网关路由已确定 wireApi 时以此为准，路径/body 推断只用于无 wireApi 的历史 raw。
  if (wireApi === "responses") {
    return classification(exchange, "openai-responses", "model-call", "exact", "routing", "wireApi");
  }
  if (wireApi === "chat_completions") {
    return classification(exchange, "openai-chat-completions", "model-call", "exact", "routing", "wireApi");
  }
  if (wireApi === "messages") {
    return classification(exchange, "anthropic-messages", "model-call", "exact", "routing", "wireApi");
  }
  if (
    path.endsWith("/responses")
    || path.endsWith("/v1/responses")
    || "input" in request
    || response.object === "response"
    || streamEvents.some(event => event.startsWith("response."))
  ) {
    return classification(exchange, "openai-responses", "model-call", "exact", "routing", "upstreamPath");
  }
  if (
    path.endsWith("/chat/completions")
    || path.endsWith("/v1/chat/completions")
    || (Array.isArray(request.messages) && Array.isArray(response.choices))
  ) {
    return classification(exchange, "openai-chat-completions", "model-call", "exact", "routing", "upstreamPath");
  }
  if (
    path.endsWith("/messages")
    || path.endsWith("/v1/messages")
    || typeof exchange.request.headers["anthropic-version"] === "string"
  ) {
    return classification(exchange, "anthropic-messages", "model-call", "high", "routing", "upstreamPath");
  }
  return classification(exchange, "unknown", "unknown", "low", "routing", "upstreamPath");
}

/** Agent 自报 query_source → 辅助端点类型（未识别来源返回 undefined）。 */
function auxiliaryEndpointFromClientQuerySource(
  querySource: string | undefined,
): EndpointKind | undefined {
  if (!querySource) return undefined;
  if (querySource === "session_title") return "title-generation";
  return undefined;
}

function protocolFromRouting(
  wireApi: string | undefined,
  path: string,
): ProtocolKind {
  if (wireApi === "responses") return "openai-responses";
  if (wireApi === "chat_completions") return "openai-chat-completions";
  if (wireApi === "messages") return "anthropic-messages";
  if (path.endsWith("/messages") || path.endsWith("/v1/messages")) {
    return "anthropic-messages";
  }
  return "unknown";
}

function classification(
  exchange: RawCapturedExchange,
  protocol: ProtocolKind,
  endpointKind: EndpointKind,
  confidence: Confidence,
  side: EvidencePointer["side"],
  path: string
): ProtocolClassification {
  return {
    exchangeId: exchange.exchangeId,
    protocol,
    endpointKind,
    isModelCall: endpointKind === "model-call",
    isAuxiliary: endpointKind !== "model-call",
    confidence,
    evidence: [{ exchangeId: exchange.exchangeId, side, path }],
  };
}

/** 标题生成签名的扫描 lane：system = 系统/指令槽，user = 首条用户输入槽。 */
interface AuxiliaryTitleSignature {
  lane: "system" | "user";
  prefix: string;
}

/** dsh（DeepSeek Harness）Web 会话标题生成请求（chat/completions）。 */
const DSH_TITLE_SYSTEM_PREFIX = "Create a concise title for an AI coding-assistant session";
const DSH_TITLE_USER_PREFIX = "Generate the session title from this JSON array of human messages:";

/**
 * 网关链路标题生成调用签名注册表（2026-09-17 六场景实测沉淀）。
 * 各 Agent 客户端都会为会话并行发起一个与主任务无关的标题/命名 LLM 调用；
 * 识别为辅助请求，避免它成为幻影 Step/Turn/Session 并污染排重基线。
 * 只匹配前缀，扫描范围见 requestTitleSignatureCandidates 的有界上限。
 */
// key = 网关路径段名（routing.agent，AGENT_REGISTRY 的 id）：claude 的段名是
// "claude" 而 fingerprint 语义名是 "claude-code"——2026-09-17 实测用语义名导致
// claude-code 标题调用漏判（守卫测试 tests/six-scenario-fixes.test.ts 覆盖全部段名）。
const AUXILIARY_TITLE_SIGNATURES: Readonly<Record<string, ReadonlyArray<AuxiliaryTitleSignature>>> = {
  zcode: [
    {lane: "system", prefix: "Generate a concise title for this coding session"},
  ],
  claude: [
    {lane: "system", prefix: "You are naming a coding session"},
  ],
  opencode: [
    {lane: "system", prefix: "You are a title generator"},
  ],
  codex: [
    {lane: "user", prefix: "Generate a concise, single-line task title"},
  ],
  dsh: [
    {lane: "system", prefix: DSH_TITLE_SYSTEM_PREFIX},
    {lane: "user", prefix: DSH_TITLE_USER_PREFIX},
  ],
};

/** 签名只比较前缀，单条候选文本最多读取的字符数。 */
const TITLE_SIGNATURE_PROBE_CHARS = 256;

/**
 * 有界提取请求侧标题签名候选文本：anthropic 取 system 块与前两条 user 消息，
 * responses 取 instructions 与前几条 user input 文本，chat 取前几条 system/user
 * 消息。只读已在内存的 parsedBody，不做额外 raw I/O。
 */
function requestTitleSignatureCandidates(
  exchange: RawCapturedExchange,
): Array<{lane: "system" | "user"; text: string}> {
  const body = asRecord(exchange.request.parsedBody);
  const candidates: Array<{lane: "system" | "user"; text: string}> = [];
  const push = (lane: "system" | "user", value: unknown): void => {
    if (candidates.length >= 8) return;
    if (typeof value === "string" && value.trim()) {
      candidates.push({lane, text: value.slice(0, TITLE_SIGNATURE_PROBE_CHARS)});
    }
  };
  const pushContent = (lane: "system" | "user", content: unknown): void => {
    if (typeof content === "string") {
      push(lane, content);
      return;
    }
    if (Array.isArray(content)) {
      for (const block of content) {
        if (candidates.length >= 8) return;
        if (block && typeof block === "object" && !Array.isArray(block)) {
          push(lane, (block as Record<string, unknown>).text);
        }
      }
    }
  };

  const wireApi = exchange.routing.wireApi;
  if (wireApi === "messages" || typeof exchange.request.headers["anthropic-version"] === "string") {
    const system = body.system;
    if (typeof system === "string") push("system", system);
    if (Array.isArray(system)) {
      for (const block of system) {
        if (block && typeof block === "object" && !Array.isArray(block)) {
          push("system", (block as Record<string, unknown>).text);
        }
      }
    }
    if (Array.isArray(body.messages)) {
      for (const message of body.messages as unknown[]) {
        if (candidates.length >= 8) return candidates;
        if (!message || typeof message !== "object") continue;
        const record = message as Record<string, unknown>;
        if (record.role !== "user") continue;
        pushContent("user", record.content);
      }
    }
    return candidates;
  }

  if (wireApi === "responses" || typeof body.instructions === "string" || Array.isArray(body.input)) {
    push("system", body.instructions);
    if (Array.isArray(body.input)) {
      for (const item of body.input as unknown[]) {
        if (candidates.length >= 8) return candidates;
        if (!item || typeof item !== "object") continue;
        const record = item as Record<string, unknown>;
        if (record.role !== "user" && record.type !== "message") continue;
        if (record.role !== "user") continue;
        pushContent("user", record.content);
      }
    }
    return candidates;
  }

  if (Array.isArray(body.messages)) {
    for (const message of body.messages as unknown[]) {
      if (candidates.length >= 8) return candidates;
      if (!message || typeof message !== "object") continue;
      const record = message as Record<string, unknown>;
      if (record.role !== "system" && record.role !== "user") continue;
      pushContent(record.role, record.content);
    }
  }
  return candidates;
}

/**
 * dsh Web 每次会话首条用户消息会并行触发一个标题生成 chat/completions 请求，
 * zcode/claude-code/opencode/codex 同理（各自 system/user 槽位前缀见注册表）；
 * 按内容签名识别为辅助请求，避免它成为独立 Step/Turn。
 * 只读取已在内存中的 parsedBody 候选文本，不做额外 raw I/O。
 */
function isAuxiliaryTitleRequest(exchange: RawCapturedExchange): boolean {
  const agent = exchange.routing.agent;
  if (!agent) return false;
  const signatures = AUXILIARY_TITLE_SIGNATURES[agent];
  if (!signatures) return false;
  for (const candidate of requestTitleSignatureCandidates(exchange)) {
    for (const signature of signatures) {
      if (candidate.lane === signature.lane && candidate.text.startsWith(signature.prefix)) {
        return true;
      }
    }
  }
  return false;
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
