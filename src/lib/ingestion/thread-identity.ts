import type {
  AgentSessionIdentitySource,
  ResolvedAgentPath,
  ThreadIdentityDiagnostic,
} from "../db/models";
import { codexTurnMetadata } from "../harness/agent";
import { fingerprintAgent } from "../harness/fingerprint";
import { stableHash } from "../harness/normalizer";
import type { Confidence, RawCapturedExchange } from "../harness/types";

interface SessionIdentity {
  identity: string;
  source: AgentSessionIdentitySource;
  confidence: Confidence;
  externalSessionId?: string;
  externalConversationId?: string;
  diagnostics?: ThreadIdentityDiagnostic[];
}

type ProviderThreadIdentity = string | typeof PRIVATE_DEFAULT_ROOT_IDENTITY;

const PRIVATE_DEFAULT_ROOT_IDENTITY = { kind: "private-default-root" } as const;

interface ThreadIdentity {
  providerIdentity: ProviderThreadIdentity;
  rootProviderIdentity: ProviderThreadIdentity;
  parentProviderIdentity?: ProviderThreadIdentity;
  source: string;
  isRoot: boolean;
  displayName: string;
  externalThreadId?: string;
  externalAgentId?: string;
  externalParentThreadId?: string;
  externalParentAgentId?: string;
  downgradeConfidence?: boolean;
  diagnostics?: ThreadIdentityDiagnostic[];
}

/**
 * 将单条交换映射到跨供应商统一的 Session/Thread 路径。
 * 这里只使用明确 header、Codex metadata 与顶层 body 字段，不从消息内容或时间关系猜测身份。
 */
export function resolveAgentPath(exchange: RawCapturedExchange): ResolvedAgentPath {
  const fingerprint = fingerprintAgent(exchange);
  const metadata = jsonObject(exchange.request.headers["x-codex-turn-metadata"]);
  const session = resolveSessionIdentity(exchange, fingerprint.agentName, metadata);
  // Agent 维度会话（2026-09-17）：Session 身份 = Agent 客户端身份 + 外部会话身份，
  // 不掺 targetId——业务会话由 Agent 产生，跨 target 的失败切换/对冲仍是同一会话；
  // target 降级为 Step 级过滤条件（与 model 同级），不参与层级建模。
  const sessionId = `asess-${stableHash({
    agentFingerprintId: fingerprint.id,
    externalSessionIdentity: session.identity,
  })}`;
  const diagnostics: ThreadIdentityDiagnostic[] = [...(session.diagnostics ?? [])];
  if (session.source === "capture-session") {
    diagnostics.push({
      code: "session-identity-capture-fallback",
      message: `未捕获明确的供应商 Session 身份，已按回退身份 ${session.identity} 隔离。`,
    });
  }

  const thread = resolveThreadIdentity(
    exchange,
    fingerprint.agentName,
    session.identity,
    metadata
  );
  diagnostics.push(...(thread.diagnostics ?? []));
  const threadId = internalThreadId(sessionId, thread.providerIdentity);
  const rootThreadId = internalThreadId(sessionId, thread.rootProviderIdentity);
  let parentAgentThreadId = thread.parentProviderIdentity
    ? internalThreadId(sessionId, thread.parentProviderIdentity)
    : undefined;
  let confidence = thread.downgradeConfidence
    ? lowerConfidence(session.confidence)
    : session.confidence;
  let isRootThread = thread.isRoot;

  if (parentAgentThreadId === threadId) {
    parentAgentThreadId = undefined;
    isRootThread = fingerprint.agentName === "claude-code" && thread.externalAgentId
      ? false
      : true;
    if (!thread.downgradeConfidence) confidence = lowerConfidence(confidence);
    if (!diagnostics.some(item => item.code === "thread-parent-self-reference")) {
      diagnostics.push({
        code: "thread-parent-self-reference",
        message: "外部父 Thread 身份与当前 Thread 相同，已移除自引用父关系。",
      });
    }
  }

  return {
    targetId: exchange.routing.targetId,
    targetName: exchange.routing.targetName,
    agentFingerprintId: fingerprint.id,
    agentName: fingerprint.agentName,
    agentSessionId: sessionId,
    agentThreadId: threadId,
    rootAgentThreadId: rootThreadId,
    parentAgentThreadId,
    externalSessionId: session.externalSessionId,
    externalConversationId: session.externalConversationId,
    externalThreadId: thread.externalThreadId,
    externalAgentId: thread.externalAgentId,
    externalParentThreadId: thread.externalParentThreadId,
    externalParentAgentId: thread.externalParentAgentId,
    sessionSource: session.source,
    threadSource: thread.source,
    confidence,
    isRootThread,
    displayName: thread.displayName,
    diagnostics,
  };
}

function resolveSessionIdentity(
  exchange: RawCapturedExchange,
  agentName: string,
  metadata: Readonly<Record<string, unknown>>
): SessionIdentity {
  const headers = exchange.request.headers;
  const body = objectValue(exchange.request.parsedBody);
  // ZCode：主会话与 subagent 使用不同 x-session-id，父子归并只体现在共享的
  // x-zcode-trace-id 上（与 ZCode 本地 session.parent_id 关系一致）。Session 级
  // 身份必须用 trace-id 折叠，否则每个 subagent 会成为独立顶层 Session；
  // 展示用 externalSessionId 只由 main/other 请求回填主会话 uuid（upsert 语义为
  // 非 NULL 即覆盖，subagent 请求保持 undefined 以免覆盖成子代理 uuid）。
  if (agentName === "zcode") {
    const traceId = stringValue(headers["x-zcode-trace-id"]);
    if (traceId) {
      // 仅显式 main/other 请求回填展示 id；session-type 缺失或 subagent 一律不回填，
      // 防止未知类型请求把展示 id 覆盖成子代理 uuid。
      const sessionType = stringValue(headers["x-zcode-session-type"]);
      const displaySessionId = sessionType === "main" || sessionType === "other"
        ? stringValue(headers["x-session-id"])
        : undefined;
      return {
        identity: traceId,
        source: "session-header",
        confidence: "exact",
        externalSessionId: displaySessionId,
      };
    }
    // 无 trace-id 的 zcode 请求退回 x-session-id 独立成 Session（防御性兜底）。
  }
  const headerSessionId = firstString(
    headers["x-claude-code-session-id"],
    headers.session_id,
    headers["session-id"],
    headers["x-codex-session-id"],
    headers["x-opencode-session"],
    headers["x-session-affinity"],
    headers["x-session-id"],
    headers["x-deepseek-harness-session-id"]
  );
  if (headerSessionId) return externalSessionIdentity(headerSessionId, "session-header", "exact");

  const metadataSessionId = stringValue(metadata.session_id);
  if (metadataSessionId) return externalSessionIdentity(metadataSessionId, "session-metadata", "exact");

  const bodySessionId = stringValue(body.session_id);
  if (bodySessionId) return externalSessionIdentity(bodySessionId, "session-body", "exact");

  const conversationId = stringValue(body.conversation);
  if (conversationId) {
    return {
      identity: conversationId,
      source: "conversation-id",
      confidence: "high",
      externalConversationId: conversationId,
    };
  }

  const windowSessionId = sessionIdFromCodexWindowId(firstString(
    headers["x-codex-window-id"],
    metadata.window_id
  ));
  if (windowSessionId) {
    return {
      identity: windowSessionId,
      source: "provider-grouping",
      confidence: "high",
    };
  }

  const promptCacheKey = stringValue(body.prompt_cache_key);
  if (promptCacheKey) {
    return {
      identity: promptCacheKey,
      source: "provider-grouping",
      confidence: "high",
    };
  }

  const captureSessionId = stringValue(exchange.captureSessionId);
  if (captureSessionId) {
    return {
      identity: captureSessionId,
      source: "capture-session",
      confidence: "low",
    };
  }

  return {
    identity: invalidCaptureFallbackIdentity(exchange),
    source: "capture-session",
    confidence: "low",
    diagnostics: [{
      code: "capture-session-id-invalid-fallback",
      message: "captureSessionId 为空白，已使用 exchange 级稳定身份隔离。",
    }],
  };
}

function resolveThreadIdentity(
  exchange: RawCapturedExchange,
  agentName: string,
  sessionIdentity: string,
  metadata: Readonly<Record<string, unknown>>
): ThreadIdentity {
  if (agentName === "codex") {
    return resolveCodexThreadIdentity(exchange, sessionIdentity, metadata);
  }
  if (agentName === "claude-code") return resolveClaudeThreadIdentity(exchange);
  if (agentName === "opencode") return resolveOpenCodeThreadIdentity(exchange);
  // ZCode：main/other 构成根 Thread，subagent 以自身 x-session-id 挂到根下。
  if (agentName === "zcode") return resolveZcodeThreadIdentity(exchange);
  if (agentName === "dsh") return resolveDshThreadIdentity(exchange);
  return defaultRootIdentity();
}

/**
 * ZCode 的 Thread 身份：同一 trace-id（即同一主会话）内，main/other 请求构成该
 * Session 的确定性根 Thread；subagent 请求以自身 x-session-id 为外部 Thread 身份，
 * 挂到该根 Thread 下——父子关系来自共享 trace-id，与 ZCode 本地 session.parent_id
 * 一致（实测当前只有一层 subagent，无递归）。无 trace-id 的兜底请求保持旧行为：
 * 整个请求独立成 Session 且 Thread 为根。
 */
function resolveZcodeThreadIdentity(exchange: RawCapturedExchange): ThreadIdentity {
  const headers = exchange.request.headers;
  if (!stringValue(headers["x-zcode-trace-id"])) return defaultRootIdentity();
  const sessionType = stringValue(headers["x-zcode-session-type"]);
  const requestSessionId = stringValue(headers["x-session-id"]);
  if (sessionType === "subagent" && requestSessionId) {
    return {
      providerIdentity: requestSessionId,
      rootProviderIdentity: PRIVATE_DEFAULT_ROOT_IDENTITY,
      parentProviderIdentity: PRIVATE_DEFAULT_ROOT_IDENTITY,
      source: "zcode-subagent",
      isRoot: false,
      displayName: `ZCode 子代理 (${zcodeSubagentDisplayId(requestSessionId)})`,
      externalThreadId: requestSessionId,
    };
  }
  return defaultRootIdentity();
}

/**
 * zcode 子代理外部 id 形态有两种：本地导入为 sess_subagent_agent_<uuid>，网关行为
 * 裸 uuid。展示名取 uuid 段前 8 位——直接 slice(0,8) 会把导入行全部显示成 "sess_sub"，
 * 多个子代理线程在树里无法区分（2026-09-17 实测）。
 */
function zcodeSubagentDisplayId(externalId: string): string {
  const bare = externalId.startsWith("sess_subagent_agent_")
    ? externalId.slice("sess_subagent_agent_".length)
    : externalId;
  return bare.slice(0, 8);
}

/**
 * dsh 的 Thread 身份（本地导入行合成头语义，网关行走身份标注覆写）：
 * - x-session-id 携带顶层祖先（root）UUID → Session 折叠；
 * - 自身非 root 时以自身 UUID 为子 Thread 挂 root 的确定性根下（与 zcode 子代理同构）；
 * - x-dsh-turn-id 为原生 Turn 键（session:turn:N），由 Turn 边界逻辑精确分轮。
 */
function resolveDshThreadIdentity(exchange: RawCapturedExchange): ThreadIdentity {
  const headers = exchange.request.headers;
  const sessionId = stringValue(headers["x-session-id"]);
  const threadId = stringValue(headers["x-dsh-thread-id"]);
  if (!sessionId || !threadId || threadId === sessionId) return defaultRootIdentity();
  return {
    providerIdentity: threadId,
    rootProviderIdentity: PRIVATE_DEFAULT_ROOT_IDENTITY,
    parentProviderIdentity: PRIVATE_DEFAULT_ROOT_IDENTITY,
    source: "dsh-subagent",
    isRoot: false,
    displayName: `Dsh 子代理 (${threadId.slice(0, 8)})`,
    externalThreadId: threadId,
  };
}

/**
 * OpenCode 的 HTTP 身份：x-opencode-session 是 Session 级身份，thread 恒为
 * 该 Session 下的确定性根 Thread；x-opencode-request 是 native Turn（user message ID），
 * 由 Turn 分段逻辑使用，不参与 Thread 身份。
 * 受管 opencode-* provider 不会发送 x-parent-session-id，因此只在捕获到该头时
 * 记录外部 Session 级父关系，不声称能精确还原 fork/subagent Thread 父关系。
 */
function resolveOpenCodeThreadIdentity(exchange: RawCapturedExchange): ThreadIdentity {
  const headers = exchange.request.headers;
  const parentSessionId = stringValue(headers["x-parent-session-id"]);
  if (!parentSessionId) return defaultRootIdentity();
  return {
    providerIdentity: PRIVATE_DEFAULT_ROOT_IDENTITY,
    rootProviderIdentity: PRIVATE_DEFAULT_ROOT_IDENTITY,
    source: "default-root",
    isRoot: true,
    displayName: "根 Thread",
    externalParentAgentId: parentSessionId,
    diagnostics: [{
      code: "opencode-parent-session-header",
      message: "捕获到 x-parent-session-id：仅非受管 provider 会发送该头，已记录外部 Session 级父关系，不推断 Thread 父子结构。",
    }],
  };
}

function resolveCodexThreadIdentity(
  exchange: RawCapturedExchange,
  sessionIdentity: string,
  metadataRecord: Readonly<Record<string, unknown>>
): ThreadIdentity {
  const headers = exchange.request.headers;
  const body = objectValue(exchange.request.parsedBody);
  const metadata = codexTurnMetadata(exchange, metadataRecord);
  const explicitThreadId = firstString(
    headers.thread_id,
    headers["thread-id"],
    headers["x-codex-thread-id"]
  );
  const metadataThreadId = stringValue(metadataRecord.thread_id);
  const bodyThreadId = stringValue(body.thread_id);
  const externalThreadId = metadata.threadId;
  const externalParentThreadId = metadata.parentThreadId;
  const identitySource = explicitThreadId
    ? "thread-header"
    : metadataThreadId
      ? "thread-metadata"
      : bodyThreadId
        ? "thread-body"
        : "default-root";
  const rootProviderIdentity: ProviderThreadIdentity = sessionIdentity;
  const providerIdentity: ProviderThreadIdentity = externalThreadId
    ?? rootProviderIdentity;
  const isTrueRoot = !externalThreadId
    || externalThreadId === sessionIdentity;
  const parentIsSelf = !!externalParentThreadId && (
    externalParentThreadId === externalThreadId
    || (!externalThreadId && externalParentThreadId === sessionIdentity)
  );
  const isMarkedSubagent = metadata.threadSource === "subagent" || !!metadata.subagentKind;
  const isChild = !isTrueRoot && (
    !!externalParentThreadId
    || isMarkedSubagent
    || externalThreadId !== sessionIdentity
  );
  let parentProviderIdentity: ProviderThreadIdentity | undefined;
  const diagnostics: ThreadIdentityDiagnostic[] = [];
  let downgradeConfidence = false;

  if (isTrueRoot && externalParentThreadId) {
    downgradeConfidence = true;
    diagnostics.push(parentIsSelf
      ? selfReferenceDiagnostic()
      : {
          code: "codex-root-parent-ignored",
          message: "Codex 根 Thread 携带了外部父身份，已忽略该异常父关系。",
        });
  } else if (isChild) {
    if (externalParentThreadId && !parentIsSelf) {
      parentProviderIdentity = externalParentThreadId;
    } else {
      parentProviderIdentity = rootProviderIdentity;
      downgradeConfidence = true;
      if (parentIsSelf) diagnostics.push(selfReferenceDiagnostic());
      diagnostics.push({
        code: "codex-parent-root-inferred",
        message: "Codex 子 Thread 缺少有效父身份，已挂到当前 Session 的确定性根 Thread。",
      });
    }
  }

  const isRoot = !isChild;
  return {
    providerIdentity,
    rootProviderIdentity,
    parentProviderIdentity,
    source: metadata.threadSource ?? identitySource,
    isRoot,
    displayName: codexDisplayName(externalThreadId, metadata.subagentKind, isRoot),
    externalThreadId,
    externalParentThreadId,
    downgradeConfidence,
    diagnostics,
  };
}

function resolveClaudeThreadIdentity(exchange: RawCapturedExchange): ThreadIdentity {
  const headers = exchange.request.headers;
  const body = objectValue(exchange.request.parsedBody);
  const headerAgentId = stringValue(headers.agent_id);
  const bodyAgentId = stringValue(body.agent_id);
  const externalAgentId = headerAgentId ?? bodyAgentId;
  if (!externalAgentId) return defaultRootIdentity();

  const externalParentAgentId = firstString(headers.parent_agent_id, body.parent_agent_id);
  return {
    providerIdentity: externalAgentId,
    rootProviderIdentity: PRIVATE_DEFAULT_ROOT_IDENTITY,
    parentProviderIdentity: externalParentAgentId
      ? externalParentAgentId
      : undefined,
    source: headerAgentId ? "agent-header" : "agent-body",
    isRoot: false,
    displayName: `Claude 子代理 (${externalAgentId})`,
    externalAgentId,
    externalParentAgentId,
  };
}

function defaultRootIdentity(): ThreadIdentity {
  return {
    providerIdentity: PRIVATE_DEFAULT_ROOT_IDENTITY,
    rootProviderIdentity: PRIVATE_DEFAULT_ROOT_IDENTITY,
    source: "default-root",
    isRoot: true,
    displayName: "根 Thread",
  };
}

function externalSessionIdentity(
  value: string,
  source: AgentSessionIdentitySource,
  confidence: Confidence
): SessionIdentity {
  return {
    identity: value,
    source,
    confidence,
    externalSessionId: value,
  };
}

function internalThreadId(
  agentSessionId: string,
  providerThreadIdentity: ProviderThreadIdentity
): string {
  return `athread-${stableHash({ agentSessionId, providerThreadIdentity })}`;
}

function invalidCaptureFallbackIdentity(exchange: RawCapturedExchange): string {
  const exchangeId = stringValue(exchange.exchangeId);
  if (exchangeId) return exchangeId;
  const capturedAt = stringValue(exchange.capturedAt) ?? "<missing>";
  const completedAt = stringValue(exchange.completedAt) ?? "<missing>";
  const sequence = `${typeof exchange.sequence}:${String(exchange.sequence)}`;
  return `anonymous-exchange:capturedAt:${capturedAt}:completedAt:${completedAt}:sequence:${sequence}`;
}

function selfReferenceDiagnostic(): ThreadIdentityDiagnostic {
  return {
    code: "thread-parent-self-reference",
    message: "外部父 Thread 身份与当前 Thread 相同，已移除自引用父关系。",
  };
}

function codexDisplayName(
  externalThreadId: string | undefined,
  subagentKind: string | undefined,
  isRoot: boolean
): string {
  if (isRoot) return externalThreadId ? `根 Thread (${externalThreadId})` : "根 Thread";
  if (subagentKind) return `子代理 ${subagentKind} (${externalThreadId})`;
  return `子 Thread (${externalThreadId})`;
}

function sessionIdFromCodexWindowId(value: string | undefined): string | undefined {
  const normalized = stringValue(value);
  if (!normalized) return undefined;
  return normalized.split(":", 1)[0]?.trim() || undefined;
}

/**
 * 本地原生身份覆写（2026-09-17 dsh 双链路）：经网关的 dsh 行 wire 上无身份，
 * 但本地 session v3 有原生 session/turn/step（responseId 确定性 join）。
 * 按 zcode「子代理挂主会话」同款语义折叠：子代理会话（有 parentSession）折入
 * 父会话的 DeepAA Session 下作为子 Thread；顶层会话自成 Session。
 */
export interface AgentLocalIdentityOverride {
  externalSessionId: string;
  parentExternalSessionId?: string;
  /** 顶层祖先会话 UUID（递归折叠目标；缺失时退化为 parent 一层）。 */
  rootExternalSessionId?: string;
  turnNumber?: number;
  /** 原生 Step 序号（链接表 step_number），物化 agent_steps.native_step_id。 */
  stepNumber?: number;
}

export function applyAgentLocalIdentityOverride(
  path: ResolvedAgentPath,
  override: AgentLocalIdentityOverride,
): {path: ResolvedAgentPath; nativeTurnId?: string; nativeStepId?: string} {
  // Session 身份 = 顶层祖先（root > parent > 自身）：dsh 子代理深度可达 2+，
  // 只折一层会让孙会话形成「以子会话为 id」的错误 Session（2026-09-17 实测）。
  const sessionIdentity = override.rootExternalSessionId
    ?? override.parentExternalSessionId
    ?? override.externalSessionId;
  const sessionId = `asess-${stableHash({
    agentFingerprintId: path.agentFingerprintId,
    externalSessionIdentity: sessionIdentity,
  })}`;
  const isSubagent = sessionIdentity !== override.externalSessionId;
  const rootThreadId = internalThreadId(sessionId, PRIVATE_DEFAULT_ROOT_IDENTITY);
  const threadId = isSubagent
    ? internalThreadId(sessionId, override.externalSessionId)
    : rootThreadId;
  return {
    path: {
      ...path,
      agentSessionId: sessionId,
      agentThreadId: threadId,
      rootAgentThreadId: rootThreadId,
      parentAgentThreadId: isSubagent ? rootThreadId : undefined,
      externalSessionId: override.externalSessionId,
      sessionSource: "session-header",
      threadSource: isSubagent ? "local-import-subagent" : "default-root",
      confidence: "exact",
      isRootThread: !isSubagent,
      displayName: isSubagent
        ? `Dsh 子代理 (${override.externalSessionId.slice(0, 8)})`
        : path.displayName,
      diagnostics: [
        ...path.diagnostics.filter(item => item.code !== "session-identity-capture-fallback"),
      ],
    },
    nativeTurnId: override.turnNumber !== undefined
      ? `${override.externalSessionId}:turn:${override.turnNumber}`
      : undefined,
    nativeStepId: override.stepNumber !== undefined
      ? `${override.externalSessionId}:step:${override.stepNumber}`
      : undefined,
  };
}

function lowerConfidence(confidence: Confidence): Confidence {
  if (confidence === "exact") return "high";
  if (confidence === "high") return "medium";
  return "low";
}

function jsonObject(value: string | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    return objectValue(JSON.parse(value));
  } catch {
    return {};
  }
}

function objectValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const normalized = stringValue(value);
    if (normalized) return normalized;
  }
  return undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
