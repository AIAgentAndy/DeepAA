import { Readable } from "node:stream";
import type { RawBodyVerification } from "../db/models";
import { isKnownSemanticAgentKind } from "../agent-registry";
import { classifyProtocol } from "../harness/protocol";
import { fingerprintAgent } from "../harness/fingerprint";
import { openRawBodyStream } from "../harness/raw-body-stream";
import { hydrateRawCapturedExchange } from "../harness/raw-capture";
import { responseBodyForDisplay } from "../harness/stream-response";
import type {
  CapturedSseEvent,
  RawCapturedExchange,
  RawCapturedExchangeV2,
} from "../harness/types";
import { mergeContentPreviews } from "./content-preview";
import type {
  ExchangeContentPreviewDraft,
  ExchangeMediaDescriptorDraft,
  LimitedDimension,
  ProjectedBodyResult,
} from "./projection-types";
import {
  chooseExchangeProjectionPath,
  projectMaterializedProtocolValue,
  projectProtocolStream,
} from "./protocol-stream-projector";
import type { AgentKind } from "../conversation-semantics";

const DEFAULT_HYDRATE_MAX_BYTES = 8 * 1024 * 1024;

type HydrateExchange = (
  dataDir: string,
  exchange: RawCapturedExchange,
  options: { maxBytes?: number },
) => Promise<RawCapturedExchange>;

export interface CreateExchangeProjectorOptions {
  dataDir: string;
  hydrateMaxBytes?: number;
  hydrateExchange?: HydrateExchange;
  projectionVersion?: number;
}

export interface ExchangeProjection {
  path: "small" | "large";
  exchange: RawCapturedExchange;
  preview: ExchangeContentPreviewDraft;
  mediaDescriptors: ExchangeMediaDescriptorDraft[];
  limitedDimensions: LimitedDimension[];
  diagnosticCodes: string[];
  requestVerification: RawBodyVerification;
  responseVerification: RawBodyVerification;
  completeness: "complete" | "limited";
}

export interface ExchangeProjector {
  project(
    exchange: RawCapturedExchangeV2,
    projectionVersion?: number,
  ): Promise<ExchangeProjection>;
}

/**
 * small path 复用现有 hydrator，再经过公共过滤器；large path 顺序读取两侧安全流。
 * 两条路径都只把过滤后的有界对象交给业务事务。
 */
export function createExchangeProjector(
  options: CreateExchangeProjectorOptions,
): ExchangeProjector {
  const hydrateMaxBytes = options.hydrateMaxBytes ?? DEFAULT_HYDRATE_MAX_BYTES;
  const hydrate = options.hydrateExchange ?? hydrateRawCapturedExchange;
  const projectionVersion = options.projectionVersion ?? 1;

  return {
    async project(exchange, requestedProjectionVersion): Promise<ExchangeProjection> {
      const activeProjectionVersion = requestedProjectionVersion ?? projectionVersion;
      const path = chooseExchangeProjectionPath(
        exchange.request.bodySizeBytes,
        exchange.response.bodySizeBytes,
      );
      const missingDeclared = sideMissingDeclared(exchange, "request")
        || sideMissingDeclared(exchange, "response");
      return path === "small" && !missingDeclared
        ? projectSmall(options.dataDir, exchange, {
          hydrate,
          hydrateMaxBytes,
          projectionVersion: activeProjectionVersion,
        })
        : projectLarge(options.dataDir, exchange, activeProjectionVersion, path);
    },
  };
}

async function projectSmall(
  dataDir: string,
  exchange: RawCapturedExchangeV2,
  options: {
    hydrate: HydrateExchange;
    hydrateMaxBytes: number;
    projectionVersion: number;
  },
): Promise<ExchangeProjection> {
  const hydrated = await options.hydrate(dataDir, exchange, {
    maxBytes: options.hydrateMaxBytes,
  });
  const classification = classifyProtocol(hydrated);
  const agentKind = semanticAgentKind(fingerprintAgent(hydrated).agentName);
  const request = projectMaterializedValue(
    hydrated.request.parsedBody,
    exchange,
    "request",
    options.projectionVersion,
    classification,
    agentKind,
  );
  const response = exchange.response.isStreaming
    ? await projectStoredBody(
        dataDir,
        exchange,
        "response",
        options.projectionVersion,
        classification,
        agentKind,
      )
    : {
        result: projectMaterializedValue(
          responseBodyForDisplay(hydrated),
          exchange,
          "response",
          options.projectionVersion,
          classification,
          agentKind,
        ),
        verification: exchange.response.bodySizeBytes === 0
          ? "empty" as const
          : "verified" as const,
      };
  return assembleExchangeProjection(
    exchange,
    "small",
    request,
    response.result,
    exchange.request.bodySizeBytes === 0 ? "empty" : "verified",
    response.verification,
    options.projectionVersion,
    classification,
    agentKind,
    safeStreamFromProjection(response.result, exchange),
  );
}

async function projectLarge(
  dataDir: string,
  exchange: RawCapturedExchangeV2,
  projectionVersion: number,
  selectedPath: "small" | "large",
): Promise<ExchangeProjection> {
  const classification = classifyProtocol(exchange);
  const agentKind = semanticAgentKind(fingerprintAgent(exchange).agentName);
  const request = await projectStoredBody(
    dataDir,
    exchange,
    "request",
    projectionVersion,
    classification,
    agentKind,
  );
  const response = await projectStoredBody(
    dataDir,
    exchange,
    "response",
    projectionVersion,
    classification,
    agentKind,
  );
  return assembleExchangeProjection(
    exchange,
    selectedPath,
    request.result,
    response.result,
    request.verification,
    response.verification,
    projectionVersion,
    classification,
    agentKind,
    safeStreamFromProjection(response.result, exchange),
  );
}

function projectMaterializedValue(
  value: unknown,
  exchange: RawCapturedExchangeV2,
  side: "request" | "response",
  projectionVersion: number,
  classification: ReturnType<typeof classifyProtocol>,
  agentKind: AgentKind,
): ProjectedBodyResult {
  return projectMaterializedProtocolValue({
    value,
    exchangeId: exchange.exchangeId,
    bodySide: side,
    rawBodySha256: exchange[side].bodySha256,
    sourceStorage: storageFor(exchange, side, true),
    projectionVersion,
    protocol: classification.protocol,
    agentKind,
    endpointKind: classification.endpointKind,
  });
}

async function projectStoredBody(
  dataDir: string,
  exchange: RawCapturedExchangeV2,
  side: "request" | "response",
  projectionVersion: number,
  classification: ReturnType<typeof classifyProtocol>,
  agentKind: AgentKind,
): Promise<{ result: ProjectedBodyResult; verification: RawBodyVerification }> {
  const body = exchange[side];
  if (body.bodySizeBytes === 0) {
    return {
      result: await emptyBodyProjection(
        exchange,
        side,
        projectionVersion,
        classification,
        agentKind,
      ),
      verification: "empty",
    };
  }
  if (sideMissingDeclared(exchange, side)) {
    const result = await emptyBodyProjection(
      exchange,
      side,
      projectionVersion,
      classification,
      agentKind,
    );
    result.preview.filterItemCandidateCountExact = false;
    result.preview.filterItemCandidateCountExactBySide[side] = false;
    result.preview.limited = true;
    result.preview.truncated = true;
    result.preview.limitedDimensions.push(textDimension(side));
    result.preview.diagnosticCodes.push("raw_body_unavailable");
    result.diagnosticCodes.push("raw_body_unavailable");
    result.limitedDimensions.push(textDimension(side));
    return { result, verification: "missing_declared" };
  }
  const opened = await openRawBodyStream(dataDir, body, {
    purpose: "projection",
    label: side,
  });
  const result = await projectProtocolStream({
    stream: opened.stream,
    format: side === "response" && exchange.response.isStreaming ? "sse" : "json",
    exchangeId: exchange.exchangeId,
    bodySide: side,
    rawBodySha256: body.bodySha256,
    sourceStorage: storageFor(exchange, side, false),
    projectionVersion,
    protocol: classification.protocol,
    agentKind,
    endpointKind: classification.endpointKind,
  });
  const verification = await opened.verification;
  if (verification.status === "failed") {
    throw new Error(`${side} Raw 正文校验失败：${verification.errorCode}`);
  }
  if (verification.status === "not_verified_budget") {
    result.preview.itemCandidateCountExact = false;
    result.preview.filterItemCandidateCountExact = false;
    result.preview.filterItemCandidateCountExactBySide[side] = false;
    result.preview.limited = true;
    result.preview.truncated = true;
    result.preview.limitedDimensions.push(textDimension(side));
    result.preview.diagnosticCodes.push("body_scan_budget_exceeded");
    result.diagnosticCodes.push("body_scan_budget_exceeded");
    result.limitedDimensions.push(textDimension(side));
    return { result, verification: "not_verified_budget" };
  }
  return { result, verification: "verified" };
}

async function emptyBodyProjection(
  exchange: RawCapturedExchangeV2,
  side: "request" | "response",
  projectionVersion: number,
  classification: ReturnType<typeof classifyProtocol>,
  agentKind: AgentKind,
): Promise<ProjectedBodyResult> {
  return projectProtocolStream({
    stream: Readable.from(["{}"]),
    format: "json",
    exchangeId: exchange.exchangeId,
    bodySide: side,
    rawBodySha256: exchange[side].bodySha256,
    sourceStorage: storageFor(exchange, side, true),
    projectionVersion,
    protocol: classification.protocol,
    agentKind,
    endpointKind: classification.endpointKind,
  });
}

function assembleExchangeProjection(
  source: RawCapturedExchangeV2,
  path: "small" | "large",
  request: ProjectedBodyResult,
  response: ProjectedBodyResult,
  requestVerification: RawBodyVerification,
  responseVerification: RawBodyVerification,
  projectionVersion: number,
  classification: ReturnType<typeof classifyProtocol>,
  agentKind: AgentKind,
  stream: RawCapturedExchange["stream"],
): ExchangeProjection {
  const preview = mergeContentPreviews({
    exchangeId: source.exchangeId,
    projectionVersion,
    protocol: classification.protocol,
    agentKind,
    endpointKind: classification.endpointKind,
    drafts: [request.preview, response.preview],
    streamLifecycle: response.streamLifecycle,
  });
  const limitedDimensions = [...new Set([
    ...request.limitedDimensions,
    ...response.limitedDimensions,
    ...preview.limitedDimensions,
  ])];
  if (requestVerification === "not_verified_budget"
    || requestVerification === "missing_declared") {
    limitedDimensions.push("request_text");
  }
  if (responseVerification === "not_verified_budget"
    || responseVerification === "missing_declared") {
    limitedDimensions.push("response_text");
  }
  // large 路径表示正文超过可materialize预算（>8 MiB）：投影只覆盖有界片段，
  // 必须保留「未完整投影」信号（完整正文按需流式读取）。
  if (path === "large") {
    limitedDimensions.push("request_text", "response_text");
  }
  const uniqueLimited = [...new Set(limitedDimensions)];
  const diagnosticCodes = [...new Set([
    ...request.diagnosticCodes,
    ...response.diagnosticCodes,
    ...preview.diagnosticCodes,
  ])];
  const exchange: RawCapturedExchange = {
    ...source,
    request: {
      ...source.request,
      rawBody: undefined,
      parsedBody: request.body,
    },
    response: {
      ...source.response,
      rawBody: undefined,
      parsedBody: response.body,
    },
    stream,
  };
  return {
    path,
    exchange,
    preview,
    mediaDescriptors: [
      ...request.mediaDescriptors,
      ...response.mediaDescriptors,
    ],
    limitedDimensions: uniqueLimited,
    diagnosticCodes,
    requestVerification,
    responseVerification,
    completeness: preview.limited || uniqueLimited.length > 0
      ? "limited"
      : "complete",
  };
}

function semanticAgentKind(agentName: string): AgentKind {
  // 注册表驱动：已知语义 AgentKind 原样通过；SDK/curl 属通用工具；其余未知。
  if (isKnownSemanticAgentKind(agentName)) return agentName as AgentKind;
  if (
    agentName === "openai-sdk"
    || agentName === "anthropic-sdk"
    || agentName === "curl"
  ) {
    return "generic";
  }
  return "unknown";
}

function safeStreamFromProjection(
  response: ProjectedBodyResult,
  exchange: RawCapturedExchangeV2,
): RawCapturedExchange["stream"] {
  if (!exchange.response.isStreaming) return undefined;
  const events: CapturedSseEvent[] = (response.streamEvents ?? []).map(
    (event, index) => ({
      index,
      event: event.event,
      data: event.data,
      rawData: "",
    }),
  );
  return {
    events,
    parseErrors: [],
    doneMarkerSeen: response.eventTypes.includes("[DONE]"),
    rawBodyStorage: storageFor(exchange, "response", true),
    lifecycleSummary: response.streamLifecycle,
  };
}

function storageFor(
  exchange: RawCapturedExchangeV2,
  side: "request" | "response",
  allowFallback: true,
): "inline" | "compressed-inline" | "external-blob";
function storageFor(
  exchange: RawCapturedExchangeV2,
  side: "request" | "response",
  allowFallback: false,
): "inline" | "compressed-inline" | "external-blob";
function storageFor(
  exchange: RawCapturedExchangeV2,
  side: "request" | "response",
  allowFallback: boolean,
): "inline" | "compressed-inline" | "external-blob" {
  const body = exchange[side];
  if (body.rawBodyRef) return body.rawBodyRef.storage;
  if (typeof body.rawBody === "string") return "inline";
  if (allowFallback) return "inline";
  throw new Error(`${side} 正文没有可用 storage。`);
}

function sideMissingDeclared(
  exchange: RawCapturedExchangeV2,
  side: "request" | "response",
): boolean {
  const body = exchange[side];
  return body.bodySizeBytes > 0
    && typeof body.rawBody !== "string"
    && !body.rawBodyRef
    && exchange.captureDiagnostics.some(
      diagnostic => diagnostic.code === "missing_raw_body",
    );
}

function textDimension(side: "request" | "response"): LimitedDimension {
  return side === "request" ? "request_text" : "response_text";
}
