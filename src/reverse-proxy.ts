import {
  createServer,
  type ClientRequest,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type Server,
  type ServerResponse,
} from "node:http";
import type {Socket} from "node:net";
import type {Duplex, Readable} from "node:stream";
import {PassThrough, Transform} from "node:stream";
import {dirname, join} from "node:path";
import {pipeline} from "node:stream/promises";
import {setTimeout as delay} from "node:timers/promises";
import {fileURLToPath} from "node:url";
import type {RawBodyCollector} from "./proxy/raw-body-collector.js";
import type {
  ProxyCapturedExchangeInput,
  ProxyExchangeStore,
} from "./proxy/exchange-store.js";
import type {
  CaptureFailover,
  CaptureFailoverAttempt,
  CaptureRouting,
} from "./proxy/raw-v2-contract.js";
import {
  RoutingConfigController,
  isModelAllowedForAgent,
  isModelWireApiAllowedForAgent,
  resolveCredentialForAgent,
  type RoutingSnapshot,
  type RoutingTarget,
} from "./proxy/routing-config.js";
import type {WireApi} from "@/types";
import {
  buildGatewayModelId,
  findModelTokenBytes,
  hasCompactionSummaryMarkerBytes,
  hasDshCompactionHeader,
  parseGatewayModelId,
  rewriteModelValueBytes,
  extractServiceTierValue,
  type ModelTokenMatch,
} from "./proxy/gateway-prefix.js";
import {
  COMPACTION_SCAN_WINDOW_BYTES,
  CodexWindowTracker,
  FAILOVER_ATTEMPT_HEADER_TIMEOUT_MS,
  FAILOVER_CHAIN_BUDGET_MS,
  ModelFailoverRegistry,
  codexWindowNumber,
  isFailoverStatusCode,
  isServedStatusCode,
  resolveFailoverPlan,
  type FailoverPlan,
  type FailoverStateKey,
} from "./proxy/model-failover.js";
import {ReplayBodyStore, teeIntoReplayStore} from "./proxy/replay-body.js";
import {
  agentById,
  agentSupportsWireApi,
  bindingForWireApi,
  modelsResponseFormatForWireApi,
} from "@/lib/agent-registry";
import {
  decideGatewayRoute,
  GatewayRouteError,
  isGatewayModelsPath,
  isGatewayPostPath,
  parseGatewayAgentPath,
  type GatewayRouteDecision,
} from "./proxy/gateway-router.js";
import {GatewayTokenResolver} from "./proxy/token-resolver.js";
import {isPlaceholderAuthorization} from "./proxy/official-upstream.js";
import {
  buildUpstreamUrl,
  createUpstreamRequest,
  ensureOpenCodeGoSessionHeader,
  isOpenCodeGoUpstream,
  normalizedHeaders,
  requestHeadersForUpstream,
  responseDecoder,
  responseHeadersForClient,
  UpstreamAgentPool,
} from "./proxy/upstream-transport.js";

const DEFAULT_PROXY_PORT = 3211;
const DEFAULT_PROXY_HOST = "127.0.0.1";
const MAX_HEADER_BYTES = 64 * 1024;
const HEADER_TIMEOUT_MS = 60_000;
const REQUEST_TIMEOUT_MS = 5 * 60_000;
const KEEP_ALIVE_TIMEOUT_MS = 5_000;
const SHUTDOWN_DRAIN_MS = 10_000;
/** 上游响应头绝对超时（毫秒）：从请求发出开始计时，不受 socket 活动影响。 */
const UPSTREAM_HEADER_TIMEOUT_MS = 60_000;
/** 响应体空闲超时（毫秒）：收到响应头后无数据即断开；SSE 有数据会自动重置。 */
const RESPONSE_IDLE_TIMEOUT_MS = 5 * 60_000;
/** 非流式响应总时长上限（毫秒）：从响应头开始计时，超时即断开。 */
const RESPONSE_TOTAL_TIMEOUT_MS = 10 * 60_000;
/**
 * 网关路由只需要读取请求体开头的 model 字段；超出预算即拒绝，避免全量缓冲。
 * 256 KiB（2026-10-08 从 64 KiB 提升）：codex-tui 序列化 model 在前、100 KiB body
 * 即可命中，但 Codex 桌面 App 的序列化可能把超大插件 tools 前缀置于 model 之前，
 * 64 KiB 窗口内定位不到即误报 MODEL_FIELD_NOT_FOUND（2026-10-08 实测事故）。
 */
const GATEWAY_MODEL_PEEK_BYTES = 256 * 1024;
const GATEWAY_TOKEN_CACHE_TTL_MS = 5 * 60_000;
const GATEWAY_MODELS_LIMIT = 200;

interface CaptureStore {
  createBodyCollector(): Promise<RawBodyCollector>;
  record(input: ProxyCapturedExchangeInput): Promise<unknown>;
  trackCapture?(task: Promise<unknown>): void;
  drain?(): Promise<void>;
}

interface StartProxyOptions {
  hostname?: string;
  port?: number;
  configPath: string;
  statusPath?: string;
  routing?: RoutingConfigController;
  /** credential-helper 路径；缺省按代理产物位置推导，测试可注入假 helper。 */
  credentialHelperPath?: string;
  gatewayModelPeekBytes?: number;
  gatewayTokenCacheTtlMs?: number;
  /** 以下超时参数仅测试覆盖用；生产使用常量默认值。 */
  upstreamHeaderTimeoutMs?: number;
  responseIdleTimeoutMs?: number;
  responseTotalTimeoutMs?: number;
  /** 故障转移链单次尝试响应头超时（测试覆盖用；生产默认 30s，健康路径仍 60s）。 */
  failoverAttemptHeaderTimeoutMs?: number;
  /** 故障转移链总时间预算（测试覆盖用；生产默认 120s）。 */
  failoverChainBudgetMs?: number;
}

export interface NodeProxyServer {
  readonly hostname: string;
  readonly port: number;
  readonly routing: RoutingConfigController;
  /** 模型故障转移状态机（进程内存态；配置快照变更时整体清空）。 */
  readonly failover: ModelFailoverRegistry;
  readonly server: Server;
  close(options?: {force?: boolean}): Promise<void>;
  stop(force?: boolean): void;
}

export async function startProxy(
  store: CaptureStore | ProxyExchangeStore,
  options: StartProxyOptions,
): Promise<NodeProxyServer> {
  const hostname = options.hostname ?? process.env.PROXY_HOST ?? process.env.HOST ?? DEFAULT_PROXY_HOST;
  const port = options.port ?? parsePort(process.env.PROXY_PORT, DEFAULT_PROXY_PORT);
  const agents = new UpstreamAgentPool();
  const upstreamHeaderTimeoutMs = options.upstreamHeaderTimeoutMs ?? UPSTREAM_HEADER_TIMEOUT_MS;
  const responseIdleTimeoutMs = options.responseIdleTimeoutMs ?? RESPONSE_IDLE_TIMEOUT_MS;
  const responseTotalTimeoutMs = options.responseTotalTimeoutMs ?? RESPONSE_TOTAL_TIMEOUT_MS;
  const gatewayModelPeekBytes = options.gatewayModelPeekBytes ?? GATEWAY_MODEL_PEEK_BYTES;
  const failoverRegistry = new ModelFailoverRegistry();
  const failoverOptions = {
    attemptHeaderTimeoutMs: options.failoverAttemptHeaderTimeoutMs ?? FAILOVER_ATTEMPT_HEADER_TIMEOUT_MS,
    chainBudgetMs: options.failoverChainBudgetMs ?? FAILOVER_CHAIN_BUDGET_MS,
    /** codex x-codex-turn-metadata.window_number 追踪（压缩/新窗口边界的首选信号）。 */
    codexWindows: new CodexWindowTracker(),
  };
  const replayTempDir = join(dirname(options.configPath), "blobs", ".tmp");
  const tokenResolver = new GatewayTokenResolver({
    credentialHelperPath: options.credentialHelperPath ?? resolveCredentialHelperPath(),
    cacheTtlMs: options.gatewayTokenCacheTtlMs ?? GATEWAY_TOKEN_CACHE_TTL_MS,
  });
  // 配置快照变更时按目标差异精细清理故障转移状态：只清空发生变化/被删除的目标，
  // 无关配置变更（如其它目标的调整）不再重置健康观测。
  const routing = options.routing ?? new RoutingConfigController({
    configPath: options.configPath,
    statusPath: options.statusPath ?? join(dirname(options.configPath), "proxy-routing-status.json"),
    localProxyBaseUrl: `http://${hostname}:${port || DEFAULT_PROXY_PORT}`,
    onSnapshot: (next, previous) => {
      agents.retainOrigins(snapshotOrigins(next));
      if (!previous) {
        failoverRegistry.clearAll();
        return;
      }
      const signature = (target: RoutingTarget) => JSON.stringify([
        target.openaiUrl, target.anthropicUrl, target.billingChannel, target.gatewayCredentialMode,
        target.supportedModels, [...target.modelAgentScopes.entries()], [...target.modelWireApis.entries()],
        [...target.modelFallbacks.entries()], [...target.credentialsByAgent.entries()],
      ]);
      const previousSignatures = new Map([...previous.targetsById.values()].map(target => [target.id, signature(target)]));
      for (const target of next.targetsById.values()) {
        const before = previousSignatures.get(target.id);
        if (before === undefined || before !== signature(target)) failoverRegistry.clearTarget(target.id);
        previousSignatures.delete(target.id);
      }
      for (const removedTargetId of previousSignatures.keys()) failoverRegistry.clearTarget(removedTargetId);
    },
  });
  await routing.init();
  routing.start();
  agents.retainOrigins(snapshotOrigins(routing.current()));

  const sockets = new Set<Socket>();
  const server = createServer({
    maxHeaderSize: MAX_HEADER_BYTES,
    headersTimeout: HEADER_TIMEOUT_MS,
    requestTimeout: REQUEST_TIMEOUT_MS,
    keepAliveTimeout: KEEP_ALIVE_TIMEOUT_MS,
  });
  // 请求路径异常兜底（稳定性红线）：任何未预料的异常（含故障转移代码）一律降级为
  // 对客户端的 502/连接关闭 + 日志，绝不允许未处理的 Promise 拒绝带崩代理进程。
  const handleRequestSafely = (
    request: IncomingMessage,
    response: ServerResponse,
    expectContinue: boolean,
  ) => {
    handleRequest(request, response, expectContinue, store, routing, agents, {
      upstreamHeaderTimeoutMs,
      responseIdleTimeoutMs,
      responseTotalTimeoutMs,
    }, tokenResolver, gatewayModelPeekBytes, failoverRegistry, replayTempDir, failoverOptions,
    ).catch(error => {
      reportCaptureError(error);
      if (!response.headersSent && !response.destroyed) {
        writeLocalError(response, 500, "PROXY_ERROR");
        return;
      }
      if (!response.destroyed) response.destroy();
    });
  };
  server.on("request", (request, response) => {
    handleRequestSafely(request, response, false);
  });
  server.on("checkContinue", (request, response) => {
    handleRequestSafely(request, response, true);
  });
  server.on("checkExpectation", (_request, response) => {
    writeLocalError(response, 417, "EXPECTATION_FAILED");
  });
  server.on("connection", socket => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.on("connect", (_request, socket) => rejectRawSocket(socket, 405));
  server.on("upgrade", (_request, socket) => rejectRawSocket(socket, 426));
  server.on("clientError", (_error, socket) => rejectRawSocket(socket, 400));

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, hostname, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Proxy did not bind a TCP address");
  let closePromise: Promise<void> | undefined;
  const close = (closeOptions: {force?: boolean} = {}): Promise<void> => {
    closePromise ??= closeProxy(
      server,
      routing,
      agents,
      sockets,
      store,
      closeOptions.force === true,
    );
    return closePromise;
  };
  return {
    hostname,
    port: address.port,
    routing,
    failover: failoverRegistry,
    server,
    close,
    stop(force = false) { void close({force}); },
  };
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  expectContinue: boolean,
  store: CaptureStore,
  routingController: RoutingConfigController,
  agents: UpstreamAgentPool,
  timeouts: {
    upstreamHeaderTimeoutMs: number;
    responseIdleTimeoutMs: number;
    responseTotalTimeoutMs: number;
  },
  tokenResolver: GatewayTokenResolver,
  gatewayModelPeekBytes: number,
  failoverRegistry: ModelFailoverRegistry,
  replayTempDir: string,
  failoverOptions: {attemptHeaderTimeoutMs: number; chainBudgetMs: number; codexWindows: CodexWindowTracker},
): Promise<void> {
  if (!request.url || !request.headers.host || /^https?:\/\//iu.test(request.url)) {
    writeLocalError(response, 400, "INVALID_REQUEST_TARGET");
    return;
  }
  let localUrl: URL;
  try {
    localUrl = new URL(request.url, `http://${request.headers.host}`);
  } catch {
    writeLocalError(response, 400, "INVALID_REQUEST_TARGET");
    return;
  }
  const snapshot = routingController.current();
  const method = request.method || "GET";

  if (method === "GET" && isGatewayModelsPath(localUrl.pathname)) {
    writeGatewayModels(request, response, snapshot);
    return;
  }
  if (method !== "POST" || !isGatewayPostPath(localUrl.pathname)) {
    writeLocalError(response, 404, "TARGET_NOT_FOUND");
    return;
  }

  // 故障转移启用与否依赖 model 前缀解析结果，因此把判定回调下探到 peek：
  // 命中备份链时保留原始 model 字节（改写延迟到每次候选尝试），并收集压缩标记扫描窗口。
  const peek = await peekGatewayModel(request, response, expectContinue, gatewayModelPeekBytes, COMPACTION_SCAN_WINDOW_BYTES,
    (targetId, modelId) => {
      const chain = snapshot.targetsById.get(targetId)?.modelFallbacks.get(modelId);
      return chain !== undefined && chain.length > 0;
    });
  if (!peek.ok) {
    writeLocalError(response, peek.code === "REQUEST_BODY_TOO_LARGE" ? 413 : 400, peek.code);
    return;
  }

  let decision: GatewayRouteDecision;
  try {
    decision = decideGatewayRoute(snapshot, localUrl.pathname, peek.requestedModel);
  } catch (error) {
    const gatewayError = error instanceof GatewayRouteError
      ? error
      : new GatewayRouteError("INVALID_ROUTE");
    writeLocalError(
      response,
      gatewayError.code === "TARGET_NOT_FOUND" ? 404 : 400,
      gatewayError.code,
    );
    return;
  }

  // 组装故障转移计划：仅当主模型配置了备份链；降级态下先做压缩证据判定。
  const now = Date.now();
  let failoverPlan: FailoverPlan | undefined;
  {
    const chain = decision.target.modelFallbacks.get(decision.modelId);
    if (chain !== undefined && chain.length > 0) {
      const stateKey: FailoverStateKey = {
        targetId: decision.target.id,
        modelId: decision.modelId,
        wireApi: decision.wireApi,
      };
      // 压缩证据（2026-09-15 修订）：首选 codex 窗口编号递增（x-codex-turn-metadata
      // .window_number，零请求体扫描、事件精确）；dsh purpose 头次之；文本标记扫描
      // （2 MiB 窗口）仅作为无该头请求的兜底。
      let compactionEvidence = hasDshCompactionHeader(request.headers);
      const windowNumber = codexWindowNumber(request.headers);
      if (windowNumber !== undefined) {
        const sessionIdHeader = request.headers["session-id"];
        const sessionId = Array.isArray(sessionIdHeader) ? sessionIdHeader[0] : sessionIdHeader;
        if (sessionId && failoverOptions.codexWindows.consume(sessionId, windowNumber)) {
          compactionEvidence = true;
        }
      }
      if (!compactionEvidence && failoverRegistry.isDegraded(stateKey)) {
        // peek 在定位 model 后暂停了请求；扫描窗口依赖后续字节流入，
        // 这里先恢复流动（bodyOut 以扫描窗口为高水位自限，不会失去背压控制）。
        peek.resumeRequest();
        compactionEvidence = await peek.scan.done.then(() => hasCompactionSummaryMarkerBytes(peek.scan.buffer()));
      }
      failoverPlan = resolveFailoverPlan({
        snapshot,
        registry: failoverRegistry,
        decision,
        pathname: localUrl.pathname,
        compactionEvidence,
        now,
      });
    }
  }

  if (!failoverPlan) {
    // 订阅透传防御（2026-10-08 用户确认）：占位/缺失凭据打到订阅透传目标时，
    // 不转发上游（必然 401 或网络不可达），本地给出明确指引——文案按 Agent 分化：
    // codex 因 ChatGPT 原生 wire 阻断（2026-10-09 实证）只能引导官方模式；
    // claude 的 messages wire 不随认证模式变化，登录后重新同步即切换透传形态。
    if (decision.credentialMode === "passthrough"
      && isPlaceholderAuthorization(request.headers.authorization)) {
      const guidance = decision.agent === "claude"
        ? "订阅预设模型需要官方 CLI 登录态：请在终端进入 claude 后输入 /login，并在 DeepAA 保存任一供应商以切换为 OAuth 透传。"
        : "订阅预设模型不支持经网关使用（ChatGPT 登录协议差异）：请在 DeepAA 的 Agent 接入页将 Codex 切换为「官方模式」后使用。";
      writeLocalError(response, 401, "SUBSCRIPTION_LOGIN_REQUIRED", guidance);
      return;
    }
    let token: string | undefined;
    if (decision.credentialMode === "inject") {
      try {
        token = await tokenResolver.resolve(decision.credentialId!);
      } catch {
        writeLocalError(response, 502, "CREDENTIAL_RESOLVE_FAILED");
        return;
      }
    }

    const upstreamUrl = buildUpstreamUrl(
      decision.upstreamUrl,
      decision.upstreamPath,
      localUrl.search,
    );
    const headers = requestHeadersForUpstream(request, upstreamUrl);
    if (isOpenCodeGoUpstream(upstreamUrl)
      && ensureOpenCodeGoSessionHeader(headers, upstreamUrl, decision.agent) === undefined) {
      writeLocalError(response, 400, "OPENCODE_SESSION_REQUIRED");
      return;
    }
    delete headers["content-length"];
    delete headers.expect;
    applyCredentialHeaders(headers, decision, token!);

    // 模型改写兜底（2026-10-06 修复）：peek 因存在模型兜底链保留了原始复合模型
    // 字节，但故障转移计划可能落空（候选对当前 Agent/协议路径全部不可路由）而
    // 退回本直连路径——此时必须按主决策模型改写，否则复合名原样到达上游触发
    // model_not_found（dsh responses + codex 侧配置的兜底链实测事故）。
    const bodySource = peek.keptOriginalModel
      ? (peek.bodySource as NodeJS.ReadableStream).pipe(createModelRewriteStream(peek.modelToken, decision.modelId))
      : peek.bodySource;

    await forwardToUpstream(store, agents, timeouts, {
      request,
      response,
      upstreamUrl,
      method,
      headers,
      bodySource,
      resumeRequest: peek.resumeRequest,
      ...(peek.serviceTier ? {serviceTier: peek.serviceTier} : {}),
      routing: {
        targetId: decision.target.id,
        targetName: decision.target.name,
        // targetFormatHint 只表示协议族，按实际路径派生：messages → anthropic，其余 → openai。
        targetFormatHint: decision.wireApi === "messages" ? "anthropic" : "openai",
        localUrl: localUrl.pathname,
        upstreamUrl: upstreamUrl.toString(),
        localPath: localUrl.pathname,
        upstreamPath: decision.upstreamPath,
        method,
        requestedModel: decision.requestedModel,
        routeMode: "model",
        clientCredentialId: decision.credentialId,
        agent: decision.agent,
        wireApi: decision.wireApi,
      },
      model: decision.modelId,
    });
    return;
  }

  await forwardWithFailover(store, agents, timeouts, failoverOptions, tokenResolver, failoverRegistry, {
    plan: failoverPlan,
    request,
    response,
    bodySource: peek.bodySource,
    resumeRequest: peek.resumeRequest,
    modelToken: peek.modelToken,
    requestedGatewayModel: decision.requestedModel,
    localUrl,
    method,
    ...(peek.serviceTier ? {serviceTier: peek.serviceTier} : {}),
    replayTempDir,
  });
}

interface ForwardPlan {
  request: IncomingMessage;
  response: ServerResponse;
  upstreamUrl: URL;
  method: string;
  headers: OutgoingHttpHeaders;
  bodySource: NodeJS.ReadableStream;
  resumeRequest: () => void;
  routing: CaptureRouting;
  model: string;
  /** 请求体携带的 service_tier（priority/flex/fast）；随 v2 捕获落盘用于乘数计价。 */
  serviceTier?: "priority" | "flex" | "fast";
}

async function forwardToUpstream(
  store: CaptureStore,
  agents: UpstreamAgentPool,
  timeouts: {
    upstreamHeaderTimeoutMs: number;
    responseIdleTimeoutMs: number;
    responseTotalTimeoutMs: number;
  },
  plan: ForwardPlan,
): Promise<void> {
  const {request, response} = plan;
  const requestHeaders = normalizedHeaders(request.rawHeaders);
  const capturedAt = new Date().toISOString();
  const forwardStartMs = Date.now();
  let firstTokenMs: number | undefined;
  const [requestCollector, responseCollector] = await Promise.all([
    store.createBodyCollector(),
    store.createBodyCollector(),
  ]);
  let requestCaptureFinished = false;
  let requestBodyResult: ReturnType<RawBodyCollector["finish"]> | undefined;
  const finishRequestCapture = () => {
    if (!requestCaptureFinished) {
      requestCaptureFinished = true;
      requestBodyResult = requestCollector.finish();
    }
    return requestBodyResult!;
  };
  let requestBodyStarted = false;
  const beginRequestBody = (upstream: ClientRequest) => {
    if (requestBodyStarted) return;
    requestBodyStarted = true;
    plan.bodySource.on("data", chunk => {
      if (!requestCaptureFinished) requestCollector.capture(Buffer.from(chunk));
    });
    plan.bodySource.pipe(upstream);
    plan.resumeRequest();
  };
  plan.bodySource.once("end", finishRequestCapture);
  plan.bodySource.once("error", finishRequestCapture);
  request.once("aborted", finishRequestCapture);
  request.once("error", finishRequestCapture);

    const origins = new Set([plan.upstreamUrl.origin]);
    agents.retainOrigins(origins);
    const lease = await agents.acquire(plan.upstreamUrl);
  const routing = {...plan.routing};
  let connectionStatus: ProxyCapturedExchangeInput["connectionStatus"] = "open_completed";
  let upstreamResponse: IncomingMessage | undefined;
  let responseStatus = 502;
  let responseStatusText = "Bad Gateway";
  let responseHeaders: Record<string, string> = {};
  let isStreaming = false;
  let responseBodyResult: ReturnType<RawBodyCollector["finish"]> | undefined;
  let responseStarted = false;
  let upstreamRequest: ClientRequest;

  const persist = () => {
    const requestBody = finishRequestCapture();
    responseBodyResult ??= responseCollector.finish();
    const captureTask = Promise.all([requestBody, responseBodyResult]).then(([capturedRequest, capturedResponse]) =>
      store.record({
        capturedAt,
        completedAt: new Date().toISOString(),
        model: plan.model,
        firstTokenMs,
        routing,
        request: {headers: requestHeaders, body: capturedRequest, ...(plan.serviceTier ? {serviceTier: plan.serviceTier} : {})},
        response: {
          status: responseStatus,
          statusText: responseStatusText,
          headers: responseHeaders,
          body: capturedResponse,
          isStreaming,
        },
        connectionStatus,
      }),
    ).catch(error => reportCaptureError(error));
    store.trackCapture?.(captureTask);
  };

  try {
    await new Promise<void>(resolve => {
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        lease.release();
        resolve();
      };
      upstreamRequest = createUpstreamRequest(plan.upstreamUrl, {
        method: plan.method,
        headers: plan.headers,
        agent: lease.agent,
        headerTimeoutMs: timeouts.upstreamHeaderTimeoutMs,
      }, incoming => {
        upstreamResponse = incoming;
        responseStarted = true;
        responseStatus = incoming.statusCode || 502;
        responseStatusText = incoming.statusMessage || "";
        responseHeaders = normalizedHeaders(incoming.rawHeaders);
        isStreaming = String(incoming.headers["content-type"] || "").toLowerCase().includes("text/event-stream");
        // 响应体空闲超时：无数据活动超过阈值即断开；SSE 流持续有数据会自动重置。
        incoming.setTimeout(timeouts.responseIdleTimeoutMs, () => {
          if (connectionStatus === "open_completed") connectionStatus = "proxy_stream_error";
          incoming.destroy(new Error("UPSTREAM_RESPONSE_IDLE_TIMEOUT"));
        });
        if (!isStreaming) {
          // 非流式响应总时长上限：从响应头开始计时，防止上游半开连接无限挂起。
          const totalTimer = setTimeout(() => {
            if (connectionStatus === "open_completed") connectionStatus = "proxy_stream_error";
            incoming.destroy(new Error("UPSTREAM_RESPONSE_TOTAL_TIMEOUT"));
          }, timeouts.responseTotalTimeoutMs);
          totalTimer.unref();
          incoming.once("close", () => clearTimeout(totalTimer));
        }
        const decoder = responseDecoder(incoming.headers);
        const output = decoder ? incoming.pipe(decoder) : incoming;
        const clientHeaders = responseHeadersForClient(incoming, Boolean(decoder));
        response.writeHead(responseStatus, responseStatusText, clientHeaders);
        output.on("data", chunk => {
          // 首字时间：转发开始到首个上游响应 chunk 到达（对齐 new-api frt / sub2api FirstTokenMs 口径）。
          if (firstTokenMs === undefined) firstTokenMs = Date.now() - forwardStartMs;
          responseCollector.capture(Buffer.from(chunk));
        });
        incoming.once("aborted", () => {
          if (connectionStatus !== "client_aborted") connectionStatus = "upstream_aborted";
        });
        response.once("close", () => {
          if (response.writableFinished) return;
          connectionStatus = "client_aborted";
          incoming.destroy();
        });
        void pipeline(output, response).catch(error => {
          if (connectionStatus === "open_completed") {
            connectionStatus = response.destroyed ? "client_aborted" : "proxy_stream_error";
          }
          if (!response.destroyed) response.destroy(error as Error);
        }).finally(() => {
          responseBodyResult = responseCollector.finish();
          persist();
          settle();
        });
      });
      upstreamRequest.once("error", error => {
        if (responseStarted) {
          if (!response.destroyed) response.destroy(error);
          settle();
          return;
        }
        responseStatus = 502;
        responseStatusText = "Bad Gateway";
        responseHeaders = {"content-type": "application/json"};
        connectionStatus = request.aborted ? "client_aborted" : "connection_error";
        const body = Buffer.from(JSON.stringify({error: "Bad Gateway"}));
        responseCollector.capture(body);
        responseBodyResult = responseCollector.finish();
        if (!response.destroyed) {
          response.writeHead(502, "Bad Gateway", {
            "content-type": "application/json",
            "content-length": String(body.length),
          });
          response.end(body);
        }
        persist();
        settle();
      });
      request.once("aborted", () => {
        connectionStatus = "client_aborted";
        upstreamRequest.destroy(new Error("CLIENT_ABORTED"));
      });
      beginRequestBody(upstreamRequest);
    });
  } catch (error) {
    lease.release();
    if (!response.headersSent && !response.destroyed) writeLocalError(response, 500, "PROXY_ERROR");
    reportCaptureError(error);
  }
}

interface FailoverForwardContext {
  plan: FailoverPlan;
  request: IncomingMessage;
  response: ServerResponse;
  bodySource: NodeJS.ReadableStream;
  resumeRequest: () => void;
  /** 客户端原始 model 值在请求体字节流中的区间；逐候选按该区间重写。 */
  modelToken: ModelTokenMatch;
  requestedGatewayModel: string;
  localUrl: URL;
  method: string;
  serviceTier?: "priority" | "flex" | "fast";
  replayTempDir: string;
}

type FailoverAttemptOutcome = {kind: "failover"} | {kind: "final"};

/** 已提交给客户端的最终尝试（成功服务 / 最后候选失败 / 非通道类错误原样透传）。 */
interface CommittedAttempt {
  decision: GatewayRouteDecision;
  upstreamUrl: URL;
  requestCollector: RawBodyCollector;
  responseCollector: RawBodyCollector;
  responseStatus: number;
  responseStatusText: string;
  responseHeaders: Record<string, string>;
  isStreaming: boolean;
  /** served=2xx 成功服务；error=最后候选的通道级失败；client_error=非通道类错误透传。 */
  committedOutcome: "served" | "error" | "client_error";
}

/**
 * 故障转移转发（2026-09-13 二次修订）：
 * - 请求体架构为「旁路 tee」：首次尝试直连完整客户端字节流（绝不因重放缓冲溢出
 *   截断当前请求），ReplayBodyStore 只作为后续候选的尽力而为副本；
 * - 每次尝试具备明确取消路径：切换候选时销毁旧 reader/改写流/上游请求并停写采集器，
 *   旧尝试的数据与错误不再干扰新尝试；
 * - 响应四分类：2xx=served（清零/切回/锁定粘性）；408/429/5xx/连接类=通道失败
 *   （记账、落盘失败记录、换候选）；其余状态码=client_error（提交客户端但不锁定，
 *   粘性自身 4xx → 粘性失效）；本地 preflight 失败与客户端中断不污染上游健康；
 * - 失败尝试逐条落盘（真实状态码+上游错误体，连接类合成 502），归属被尝试目标；
 * - 链级总时间预算：耗尽后不再发起新候选；单次尝试响应头超时取转移场景短超时。
 */
async function forwardWithFailover(
  store: CaptureStore,
  agents: UpstreamAgentPool,
  timeouts: {
    upstreamHeaderTimeoutMs: number;
    responseIdleTimeoutMs: number;
    responseTotalTimeoutMs: number;
  },
  failoverOptions: {attemptHeaderTimeoutMs: number; chainBudgetMs: number; codexWindows: CodexWindowTracker},
  tokenResolver: GatewayTokenResolver,
  registry: ModelFailoverRegistry,
  context: FailoverForwardContext,
): Promise<void> {
  const {request, response, plan} = context;
  const stateKey: FailoverStateKey = {
    targetId: plan.primary.target.id,
    modelId: plan.primary.modelId,
    wireApi: plan.primary.wireApi,
  };
  const forwardStartMs = Date.now();
  const capturedAt = new Date().toISOString();
  const chainDeadline = forwardStartMs + failoverOptions.chainBudgetMs;
  const requestHeaders = normalizedHeaders(request.rawHeaders);
  const replay = await ReplayBodyStore.create({tempDir: context.replayTempDir});
  let replayReleased = false;
  const releaseReplay = () => {
    if (replayReleased) return;
    replayReleased = true;
    void replay.release();
  };

  // 旁路 tee：liveBody 始终承载完整客户端字节（首个尝试的数据源）；
  // replay 只是尽力而为副本，溢出仅使后续候选不可重放，绝不影响当前请求。
  const liveBody = teeIntoReplayStore(context.bodySource, replay);
  request.once("aborted", () => replay.abort());
  context.resumeRequest();
  // 首个尝试的消费者结束后（切换候选/请求完结），liveBody 转入丢弃排水，
  // 保证 tee 持续向 replay 供数直到客户端上传结束，不因失去消费者而背压阻塞。
  let liveBodySettled = false;
  const drainLiveBody = () => {
    if (liveBodySettled) return;
    liveBodySettled = true;
    const stream = liveBody as PassThrough;
    if (!stream.readableEnded) stream.resume();
  };
  context.bodySource.once("end", () => { liveBodySettled = true; });
  context.bodySource.once("error", () => { liveBodySettled = true; });

  const anchorDecision = plan.attempts[0]!.decision;
  let anchorFailures = 0;
  /** 本请求内主模型是否发生上游类两连败（preflight 失败不算）：healthy 态
   * 备份服务只有在它为真时才锁定降级，避免本地凭据故障误降级主模型。 */
  let primaryUpstreamExhausted = false;
  const anchorExhausted = () => {
    // 锚点两连败：健康态→进入降级；探测态→刷新兜底计时；降级粘性锚点→粘性失效。
    if (plan.mode === "healthy") {
      registry.enterDegraded(stateKey, Date.now());
      primaryUpstreamExhausted = true;
    } else if (plan.mode === "probe") {
      registry.probeFailed(stateKey, Date.now());
      primaryUpstreamExhausted = true;
    } else {
      registry.clearSticky(stateKey);
    }
  };
  const attemptsMeta: CaptureFailoverAttempt[] = [];
  let connectionStatus: ProxyCapturedExchangeInput["connectionStatus"] = "open_completed";
  let firstTokenMs: number | undefined;
  let clientAborted = false;
  request.once("aborted", () => { clientAborted = true; });

  let committed: CommittedAttempt | undefined;
  let endReason: "FAILOVER_BUDGET_LIMIT" | "FAILOVER_REPLAY_EXHAUSTED" | undefined;

  /** 落盘一次尝试的捕获（失败尝试与最终提交共用；归属该尝试的目标与模型）。 */
  const recordAttempt = (input: {
    decision: GatewayRouteDecision;
    upstreamUrl: URL;
    requestCollector: RawBodyCollector;
    responseCollector: RawBodyCollector;
    status: number;
    statusText: string;
    responseHeaders: Record<string, string>;
    isStreaming: boolean;
    connStatus: ProxyCapturedExchangeInput["connectionStatus"];
    failover?: CaptureFailover;
    firstToken?: number;
  }) => {
    const requestBody = input.requestCollector.finish();
    const responseBody = input.responseCollector.finish();
    const captureTask = Promise.all([requestBody, responseBody]).then(([capturedRequest, capturedResponse]) =>
      store.record({
        capturedAt,
        completedAt: new Date().toISOString(),
        model: input.decision.modelId,
        ...(input.firstToken !== undefined ? {firstTokenMs: input.firstToken} : {}),
        routing: {
          targetId: input.decision.target.id,
          targetName: input.decision.target.name,
          targetFormatHint: input.decision.wireApi === "messages" ? "anthropic" : "openai",
          localUrl: context.localUrl.pathname,
          upstreamUrl: input.upstreamUrl.toString(),
          localPath: context.localUrl.pathname,
          upstreamPath: input.decision.upstreamPath,
          method: context.method,
          requestedModel: context.requestedGatewayModel,
          routeMode: "model" as const,
          ...(input.decision.credentialId ? {clientCredentialId: input.decision.credentialId} : {}),
          agent: input.decision.agent,
          wireApi: input.decision.wireApi,
          ...(input.failover ? {failover: input.failover} : {}),
        },
        request: {
          headers: requestHeaders,
          body: capturedRequest,
          ...(context.serviceTier ? {serviceTier: context.serviceTier} : {}),
        },
        response: {
          status: input.status,
          statusText: input.statusText,
          headers: input.responseHeaders,
          body: capturedResponse,
          isStreaming: input.isStreaming,
        },
        connectionStatus: input.connStatus,
      }),
    ).catch(error => reportCaptureError(error));
    store.trackCapture?.(captureTask);
  };

  for (let index = 0; index < plan.attempts.length; index += 1) {
    if (response.destroyed || clientAborted) break;
    const attempt = plan.attempts[index]!;
    // 锚点重试退避（含抖动，计划期已定值）。
    if (attempt.retryAfterMs) await delay(attempt.retryAfterMs);
    if (response.destroyed || clientAborted) break;
    if (Date.now() >= chainDeadline) {
      endReason = "FAILOVER_BUDGET_LIMIT";
      break;
    }
    const decision = attempt.decision;
    const isLast = index === plan.attempts.length - 1;
    const isAnchor = decision === anchorDecision;
    const isPrimaryDecision = decision === plan.primary;
    const requestCollector = await store.createBodyCollector();
    const responseCollector = await store.createBodyCollector();
    let collectorOpen = true;
    const pushMeta = (outcome: "error" | "served", detail?: string) => {
      attemptsMeta.push({
        targetId: decision.target.id,
        model: decision.modelId,
        outcome,
        ...(detail ? {detail} : {}),
      });
    };

    let upstreamUrl: URL;
    let headers: OutgoingHttpHeaders;
    try {
      const prepared = await prepareFailoverAttemptHeaders(decision, context, tokenResolver);
      upstreamUrl = prepared.upstreamUrl;
      headers = prepared.headers;
    } catch (error) {
      // 本地 preflight 失败（凭据解析/会话头缺失）：真实尝试，落盘失败记录；
      // 但属本地问题，不污染上游健康（不记账、不降级）。
      const detail = error instanceof Error && error.message === "OPENCODE_SESSION_REQUIRED"
        ? "OPENCODE_SESSION_REQUIRED"
        : "CREDENTIAL_RESOLVE_FAILED";
      pushMeta("error", detail);
      responseCollector.capture(Buffer.from(JSON.stringify({error: detail})));
      recordAttempt({
        decision,
        upstreamUrl: new URL(decision.upstreamUrl),
        requestCollector,
        responseCollector,
        status: 502,
        statusText: "Bad Gateway",
        responseHeaders: {"content-type": "application/json"},
        isStreaming: false,
        connStatus: "connection_error",
        failover: buildFailoverCaptureMeta(plan, attemptsMeta, decision, "error"),
      });
      if (isLast) {
        writeLocalError(response, 502, detail);
        releaseReplay();
        drainLiveBody();
        return;
      }
      continue;
    }

    // 数据源：首个尝试直连 liveBody（完整字节）；后续尝试用重放副本。
    let sourceStream: NodeJS.ReadableStream;
    if (index === 0) {
      sourceStream = liveBody;
    } else {
      const reader = replay.createReader();
      if (!reader) {
        void requestCollector.finish().catch(() => undefined);
        void responseCollector.finish().catch(() => undefined);
        endReason = "FAILOVER_REPLAY_EXHAUSTED";
        break;
      }
      sourceStream = reader;
    }
    const rewrite = createModelRewriteStream(context.modelToken, decision.modelId);
    rewrite.on("data", (chunk: Buffer) => {
      if (collectorOpen) requestCollector.capture(chunk);
    });

    const origins = new Set([upstreamUrl.origin]);
    agents.retainOrigins(origins);
    const lease = await agents.acquire(upstreamUrl);

    // 尝试的显式取消路径（P0）：切换候选时销毁旧管道并停写采集器，
    // 防止旧数据/旧错误（如 EPIPE）干扰新尝试或销毁客户端响应。
    let attemptAborted = false;
    let currentUpstream: ClientRequest | undefined;
    const abortAttempt = () => {
      if (attemptAborted) return;
      attemptAborted = true;
      collectorOpen = false;
      rewrite.destroy();
      if (sourceStream !== liveBody) (sourceStream as Readable).destroy();
      currentUpstream?.destroy();
      if (index === 0) drainLiveBody();
    };

    const outcome = await new Promise<FailoverAttemptOutcome>(resolve => {
      let settled = false;
      let sawResponse = false;
      let responseStarted = false;
      const settle = (value: FailoverAttemptOutcome) => {
        if (settled) return;
        settled = true;
        lease.release();
        resolve(value);
      };
      const failCurrent = (detail: string) => {
        pushMeta("error", detail);
        if (isAnchor) {
          anchorFailures += 1;
          if (anchorFailures >= 2) anchorExhausted();
        }
        if (!isLast && !response.headersSent && !response.destroyed) {
          const body = Buffer.from(JSON.stringify({error: "Bad Gateway"}));
          responseCollector.capture(body);
          recordAttempt({
            decision,
            upstreamUrl,
            requestCollector,
            responseCollector,
            status: 502,
            statusText: "Bad Gateway",
            responseHeaders: {"content-type": "application/json"},
            isStreaming: false,
            connStatus: "connection_error",
            failover: buildFailoverCaptureMeta(plan, attemptsMeta, decision, "error"),
          });
          abortAttempt();
          settle({kind: "failover"});
          return;
        }
        // 最后候选连接类失败：合成 502 提交客户端（同时作为最终记录落盘）。
        connectionStatus = "connection_error";
        const body = Buffer.from(JSON.stringify({error: "Bad Gateway"}));
        responseCollector.capture(body);
        committed = {
          decision,
          upstreamUrl,
          requestCollector,
          responseCollector,
          responseStatus: 502,
          responseStatusText: "Bad Gateway",
          responseHeaders: {"content-type": "application/json"},
          isStreaming: false,
          committedOutcome: "error",
        };
        if (!response.destroyed && !response.headersSent) {
          response.writeHead(502, "Bad Gateway", {
            "content-type": "application/json",
            "content-length": String(body.length),
          });
          response.end(body);
        }
        settle({kind: "final"});
      };
      currentUpstream = createUpstreamRequest(upstreamUrl, {
        method: context.method,
        headers,
        agent: lease.agent,
        // 转移场景短超时：加速主模型挂死场景的换候选；拿到响应头后由流空闲超时保护。
        headerTimeoutMs: failoverOptions.attemptHeaderTimeoutMs,
      }, incoming => {
        sawResponse = true;
        const status = incoming.statusCode || 502;
        const channelFailure = isFailoverStatusCode(status);
        const servedOutcome = isServedStatusCode(status);
        // 备份候选 4xx：视为该候选不可用，本次继续下一候选（区别于主模型 4xx 直接
        // 提交——链的意义就是绕开坏候选，不应被坏备份阻断健康备份）。
        const candidateRejected = !servedOutcome && !channelFailure && !isPrimaryDecision;
        if ((channelFailure || candidateRejected) && !isLast && !response.headersSent && !response.destroyed) {
          // 读有界错误体，落盘失败记录，取消本尝试并换候选。
          void readUpstreamErrorBody(incoming).then(errorBody => {
            pushMeta("error", `HTTP ${status}`);
            if (channelFailure && isAnchor) {
              anchorFailures += 1;
              if (anchorFailures >= 2) anchorExhausted();
            }
            if (candidateRejected) {
              // 候选 4xx：进入候选冷却；若坏的是粘性/锚点备份则同时失效粘性。
              registry.coolCandidate(decision.target.id, decision.modelId, Date.now());
              if (isAnchor) registry.clearSticky(stateKey);
            }
            responseCollector.capture(errorBody);
            recordAttempt({
              decision,
              upstreamUrl,
              requestCollector,
              responseCollector,
              status,
              statusText: incoming.statusMessage || "",
              responseHeaders: normalizedHeaders(incoming.rawHeaders),
              isStreaming: false,
              connStatus: "open_completed",
              failover: buildFailoverCaptureMeta(plan, attemptsMeta, decision, "error"),
            });
            abortAttempt();
            settle({kind: "failover"});
          });
          return;
        }
        // 提交：served（2xx）/ client_error（非通道类透传）/ error（最后候选通道失败）。
        const committedOutcome: CommittedAttempt["committedOutcome"] = servedOutcome
          ? "served"
          : channelFailure ? "error" : "client_error";
        pushMeta(committedOutcome === "served" ? "served" : "error",
          committedOutcome === "served" ? undefined : `HTTP ${status}`);
        if (committedOutcome === "served") {
          if (isPrimaryDecision) registry.recover(stateKey);
          else if (plan.mode !== "healthy" || primaryUpstreamExhausted) {
            // healthy 态仅在上游类两连败后锁定降级；preflight 失败导致的转移
            // 不锁定（本地凭据故障不误判主模型上游健康）。
            registry.lockSticky(stateKey, {targetId: decision.target.id, modelId: decision.modelId}, Date.now());
          }
        } else if (committedOutcome === "client_error") {
          if (isPrimaryDecision) {
            if (plan.mode !== "healthy") registry.probeFailed(stateKey, Date.now());
          } else if (isAnchor) {
            registry.clearSticky(stateKey);
          }
          // 备份候选最终以 4xx 提交（链尾）：同样进入冷却。
          registry.coolCandidate(decision.target.id, decision.modelId, Date.now());
        }
        committed = {
          decision,
          upstreamUrl,
          requestCollector,
          responseCollector,
          responseStatus: status,
          responseStatusText: incoming.statusMessage || "",
          responseHeaders: normalizedHeaders(incoming.rawHeaders),
          isStreaming: String(incoming.headers["content-type"] || "").toLowerCase().includes("text/event-stream"),
          committedOutcome,
        };
        responseStarted = true;
        const decoder = responseDecoder(incoming.headers);
        const output = decoder ? incoming.pipe(decoder) : incoming;
        const clientHeaders = responseHeadersForClient(incoming, Boolean(decoder));
        response.writeHead(status, committed.responseStatusText, clientHeaders);
        output.on("data", (chunk: Buffer) => {
          // 首字时间：转发开始到首个上游响应 chunk 到达（含失败尝试耗时，对齐现有口径）。
          if (firstTokenMs === undefined) firstTokenMs = Date.now() - forwardStartMs;
          responseCollector.capture(Buffer.from(chunk));
        });
        incoming.setTimeout(timeouts.responseIdleTimeoutMs, () => {
          if (connectionStatus === "open_completed") connectionStatus = "proxy_stream_error";
          incoming.destroy(new Error("UPSTREAM_RESPONSE_IDLE_TIMEOUT"));
        });
        if (!committed.isStreaming) {
          const totalTimer = setTimeout(() => {
            if (connectionStatus === "open_completed") connectionStatus = "proxy_stream_error";
            incoming.destroy(new Error("UPSTREAM_RESPONSE_TOTAL_TIMEOUT"));
          }, timeouts.responseTotalTimeoutMs);
          totalTimer.unref();
          incoming.once("close", () => clearTimeout(totalTimer));
        }
        incoming.once("aborted", () => {
          if (connectionStatus !== "client_aborted") connectionStatus = "upstream_aborted";
        });
        response.once("close", () => {
          if (response.writableFinished) return;
          connectionStatus = "client_aborted";
          incoming.destroy();
        });
        void pipeline(output, response).catch(error => {
          if (connectionStatus === "open_completed") {
            connectionStatus = response.destroyed ? "client_aborted" : "proxy_stream_error";
          }
          if (!response.destroyed) response.destroy(error as Error);
        }).finally(() => {
          settle({kind: "final"});
        });
      });
      currentUpstream.once("error", error => {
        // 主动取消（换候选）或客户端中断：旧尝试的错误一概忽略，绝不销毁客户端。
        if (clientAborted || attemptAborted) {
          settle({kind: "final"});
          return;
        }
        if (sawResponse || responseStarted) {
          if (!response.destroyed) response.destroy(error);
          settle({kind: "final"});
          return;
        }
        failCurrent(upstreamErrorDetail(error));
      });
      sourceStream.once("error", error => {
        if (clientAborted || attemptAborted || settled || responseStarted) return;
        const detail = error instanceof Error && error.message === "REPLAY_OVERFLOW"
          ? "REPLAY_OVERFLOW"
          : upstreamErrorDetail(error);
        failCurrent(detail);
      });
      request.once("aborted", () => {
        clientAborted = true;
        currentUpstream?.destroy(new Error("CLIENT_ABORTED"));
      });
      sourceStream.pipe(rewrite);
      rewrite.pipe(currentUpstream);
    });

    if (outcome.kind === "final") {
      drainLiveBody();
      break;
    }
  }

  if (committed) {
    recordAttempt({
      decision: committed.decision,
      upstreamUrl: committed.upstreamUrl,
      requestCollector: committed.requestCollector,
      responseCollector: committed.responseCollector,
      status: committed.responseStatus,
      statusText: committed.responseStatusText,
      responseHeaders: committed.responseHeaders,
      isStreaming: committed.isStreaming,
      connStatus: connectionStatus,
      ...(firstTokenMs !== undefined ? {firstToken: firstTokenMs} : {}),
      failover: buildFailoverCaptureMeta(
        plan,
        attemptsMeta,
        committed.decision,
        committed.committedOutcome === "client_error" ? "error" : committed.committedOutcome,
      ),
    });
    if (committed.committedOutcome !== "served" && !isPrimaryDecisionOf(plan, committed.decision)) {
      // 全链以失败告终：本轮转移使命完成，重置回健康态——下一请求从主模型
      // → 备份1 → 备份2 从头开始（2026-09-14 用户确认语义）。
      registry.recover(stateKey);
    }
  } else if (endReason && !response.headersSent && !response.destroyed && !clientAborted) {
    writeLocalError(response, endReason === "FAILOVER_BUDGET_LIMIT" ? 504 : 502, endReason);
    // 预算耗尽同样是本轮尽力告终：重置，下一请求从主模型重新开始。
    registry.recover(stateKey);
  }
  drainLiveBody();
  releaseReplay();
}

/** 判定决策是否为主模型本身（目标 + 模型双要素；同 ID 跨目标转移不算主模型）。 */
function isPrimaryDecisionOf(plan: FailoverPlan, decision: GatewayRouteDecision): boolean {
  return decision.target.id === plan.primary.target.id && decision.modelId === plan.primary.modelId;
}

const UPSTREAM_ERROR_BODY_LIMIT_BYTES = 64 * 1024;
const UPSTREAM_ERROR_BODY_TIMEOUT_MS = 1_000;

/** 有界读取上游错误响应体（失败尝试落盘用；超限/超时截断，不阻塞换候选）。 */
function readUpstreamErrorBody(incoming: IncomingMessage): Promise<Buffer> {
  return new Promise(resolve => {
    const chunks: Buffer[] = [];
    let total = 0;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      incoming.removeAllListeners("data");
      incoming.destroy();
      resolve(Buffer.concat(chunks));
    };
    incoming.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      total += chunk.length;
      if (total >= UPSTREAM_ERROR_BODY_LIMIT_BYTES) finish();
    });
    incoming.once("end", finish);
    incoming.once("error", finish);
    setTimeout(finish, UPSTREAM_ERROR_BODY_TIMEOUT_MS).unref();
  });
}

/**
 * 按凭据模式与协议语义落上游鉴权头（主路径与故障转移候选共用；此前两处为内联复制）：
 * - passthrough：保留客户端 Authorization（订阅透传）；Claude 订阅缺失时兜底 anthropic-beta。
 * - inject：删除客户端 Authorization 后写 `Bearer <token>`；messages（anthropic 系）wire
 *   同步覆写 x-api-key 为同一凭据——镜像原生客户端对 anthropic 端点的双头形态
 *   （登录态凭据依赖服务端按凭据身份识别流量），并避免客户端占位 x-api-key 泄漏到上游；
 *   openai 系 wire 不动 x-api-key（上游可能按 x-api-key 独立取钥）。
 */
function applyCredentialHeaders(
  headers: OutgoingHttpHeaders,
  decision: GatewayRouteDecision,
  token: string,
): void {
  if (decision.credentialMode === "passthrough") {
    // 订阅通道透传客户端 OAuth；Claude 订阅需要 anthropic-beta 头，缺失时兜底补充。
    if (decision.agent === "claude" && !headers["anthropic-beta"]) {
      headers["anthropic-beta"] = "oauth-2025-04-20";
    }
    return;
  }
  delete headers.authorization;
  headers.authorization = `Bearer ${token}`;
  if (decision.wireApi === "messages") {
    headers["x-api-key"] = token;
  }
}

/** 按候选目标重建协议 URL 与请求头（鉴权注入/透传跟随候选目标的凭据模式）。 */
async function prepareFailoverAttemptHeaders(
  decision: GatewayRouteDecision,
  context: FailoverForwardContext,
  tokenResolver: GatewayTokenResolver,
): Promise<{upstreamUrl: URL; headers: OutgoingHttpHeaders}> {
  const upstreamUrl = buildUpstreamUrl(
    decision.upstreamUrl,
    decision.upstreamPath,
    context.localUrl.search,
  );
  const headers = requestHeadersForUpstream(context.request, upstreamUrl);
  if (isOpenCodeGoUpstream(upstreamUrl)
    && ensureOpenCodeGoSessionHeader(headers, upstreamUrl, decision.agent) === undefined) {
    throw new Error("OPENCODE_SESSION_REQUIRED");
  }
  // 订阅透传防御与主路径同口径（2026-10-08）：占位/缺失凭据不转发候选上游。
  if (decision.credentialMode === "passthrough"
    && isPlaceholderAuthorization(headers.authorization as string | string[] | undefined)) {
    throw new Error("SUBSCRIPTION_LOGIN_REQUIRED");
  }
  delete headers["content-length"];
  delete headers.expect;
  const token = decision.credentialMode === "passthrough"
    ? ""
    : await tokenResolver.resolve(decision.credentialId!);
  applyCredentialHeaders(headers, decision, token);
  return {upstreamUrl, headers};
}

/**
 * 按候选模型重写请求体的 model 字段：缓冲首段至 model 字面量区间结束，
 * 按字节区间替换后放行其余字节（与 peek 的单次改写同一字节语义）。
 */
function createModelRewriteStream(match: ModelTokenMatch, modelId: string): Transform {
  let buffered = Buffer.alloc(0);
  let rewritten = false;
  return new Transform({
    transform(chunk: Buffer<ArrayBuffer>, _encoding, callback) {
      if (rewritten) {
        callback(null, chunk);
        return;
      }
      buffered = buffered.length === 0 ? chunk : Buffer.concat([buffered, chunk]);
      if (buffered.length < match.end) {
        callback();
        return;
      }
      rewritten = true;
      callback(null, rewriteModelValueBytes(buffered, match, modelId));
    },
    flush(callback) {
      if (!rewritten && buffered.length > 0) {
        callback(null, buffered);
        return;
      }
      callback();
    },
  });
}

/** 连接类上游错误归类为稳定短文案，用于 failover 尝试明细与 UI 展示。 */
function upstreamErrorDetail(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message === "UPSTREAM_CONNECT_TIMEOUT") return "CONNECT_TIMEOUT";
  if (message === "UPSTREAM_RESPONSE_HEADER_TIMEOUT") return "HEADER_TIMEOUT";
  if (message === "CLIENT_ABORTED") return "CLIENT_ABORTED";
  return "CONNECTION_ERROR";
}

/**
 * 组装随捕获落盘的 failover 元数据。
 * 正常由主模型一次性服务且无切回探测意图（无 trigger）时返回 undefined。
 */
function buildFailoverCaptureMeta(
  plan: FailoverPlan,
  attemptsMeta: CaptureFailoverAttempt[],
  servedDecision: GatewayRouteDecision,
  finalOutcome: "served" | "error",
): CaptureFailover | undefined {
  // 健康态下最终仍由主模型服务/提交（首试 4xx、锚点重试成功或主模型链尾失败）：
  // 全程未离开主模型、未发生转移，不写故障转移字段（避免 from==to 的误导徽标）。
  const servedByPrimary = isPrimaryDecisionOf(plan, servedDecision);
  if (plan.mode === "healthy" && servedByPrimary) {
    return undefined;
  }
  if (attemptsMeta.length === 0) return undefined;
  return {
    trigger: plan.trigger ?? "consecutive_failures",
    fromTargetId: plan.primary.target.id,
    fromTargetName: plan.primary.target.name,
    fromModel: plan.primary.modelId,
    toTargetId: servedDecision.target.id,
    toTargetName: servedDecision.target.name,
    toModel: servedDecision.modelId,
    attempts: attemptsMeta,
    retryCount: attemptsMeta.length,
  };
}

function snapshotOrigins(snapshot: RoutingSnapshot): Set<string> {
  const origins = new Set<string>();
  for (const target of snapshot.targetsById.values()) {
    const urls = [target.openaiUrl, target.anthropicUrl]
      .filter((url): url is string => Boolean(url));
    for (const url of urls) origins.add(new URL(url).origin);
  }
  return origins;
}

/**
 * 合成 /v1/models：
 * 1. 先确定 wire API：显式 ?wireApi=... 必须命中该 Agent 已注册 binding，否则 400；
 * 2. 未传时使用注册表 defaultModelsBinding（发现接口默认值）；
 * 3. 输出格式由 modelsResponseFormatForWireApi 决定，不由 Agent 名称决定；
 * 4. 模型列表同时按 Agent scope 与模型 wire API 能力过滤；订阅供应商按 binding 放行。
 */
function writeGatewayModels(
  request: IncomingMessage,
  response: ServerResponse,
  snapshot: RoutingSnapshot,
): void {
  const localUrl = new URL(request.url || "/", `http://${request.headers.host}`);
  const parsed = parseGatewayAgentPath(localUrl.pathname);
  if (!parsed) {
    writeLocalError(response, 404, "TARGET_NOT_FOUND");
    return;
  }
  const {agent} = parsed;
  const requestedWireApi = localUrl.searchParams.get("wireApi");
  if (requestedWireApi && !isKnownWireApi(requestedWireApi)) {
    writeLocalError(response, 400, "MODEL_WIRE_API_UNSUPPORTED");
    return;
  }
  if (requestedWireApi && !agentSupportsWireApi(agent, requestedWireApi as WireApi)) {
    writeLocalError(response, 400, "MODEL_WIRE_API_UNSUPPORTED");
    return;
  }
  const wireApi = requestedWireApi
    ? requestedWireApi as WireApi
    : (agentById(agent)?.defaultModelsBinding ?? "responses");
  const anthropic = modelsResponseFormatForWireApi(wireApi) === "anthropic";
  const binding = bindingForWireApi(agent, wireApi);
  if (!binding) {
    writeLocalError(response, 400, "MODEL_WIRE_API_UNSUPPORTED");
    return;
  }
  const models: Array<{id: string; displayName: string; ownedBy: string}> = [];
  for (const target of snapshot.targetsById.values()) {
    if (target.supportedModels.length === 0) continue;
    const isSubscription = target.billingChannel === "subscription";
    if (!isSubscription && !resolveCredentialForAgent(target, agent)) continue;
    const hasUrl = binding.protocol === "openai"
      ? Boolean(target.openaiUrl)
      : Boolean(target.anthropicUrl);
    if (!hasUrl) continue;
    if (isSubscription && binding.supportsSubscription !== true) continue;
    for (const modelId of target.supportedModels) {
      if (models.length >= GATEWAY_MODELS_LIMIT) break;
      if (!isModelAllowedForAgent(target, modelId, agent)) continue;
      if (!isModelWireApiAllowedForAgent(target, modelId, wireApi)) continue;
      models.push({
        id: buildGatewayModelId(target.id, modelId),
        displayName: `${target.name} · ${modelId}`,
        ownedBy: target.id,
      });
    }
  }
  const body = anthropic
    ? JSON.stringify({data: models.map(model => ({
      id: model.id,
      display_name: model.displayName,
      type: "model",
    }))})
    : JSON.stringify({object: "list", data: models.map(model => ({
      id: model.id,
      object: "model",
      created: 0,
      owned_by: model.ownedBy,
    }))});
  const bytes = Buffer.from(body, "utf8");
  response.writeHead(200, {
    "content-type": "application/json",
    "content-length": String(bytes.length),
  });
  response.end(bytes);
}

function isKnownWireApi(value: string): boolean {
  return value === "responses" || value === "chat_completions" || value === "messages";
}

type GatewayPeekResult =
  | {
    ok: true;
    requestedModel: string;
    bodySource: NodeJS.ReadableStream;
    resumeRequest: () => void;
    serviceTier?: "priority" | "flex" | "fast";
    /** model 值 JSON 字面量在原始请求体字节流中的区间（改写前口径），供逐候选重写。 */
    modelToken: ModelTokenMatch;
    /**
     * true = bodySource 保留了客户端原始 model 字节（配置了模型兜底链，等故障
     * 转发层按候选改写）。若后续故障转移计划落空（候选全部不可路由）退回直连
     * 路径，直连必须自行按 modelToken 改写——否则复合模型名会原样到达上游
     * （2026-10-06 dsh responses 实测 404 事故根因）。
     */
    keptOriginalModel: boolean;
    /** ≤maxBytes 的请求体前缀扫描窗口；done 在窗口封顶或请求体结束时兑现。 */
    scan: {buffer(): Buffer; done: Promise<void>};
  }
  | {ok: false; code: "MODEL_FIELD_NOT_FOUND" | "MODEL_PREFIX_REQUIRED" | "REQUEST_BODY_TOO_LARGE"};

type GatewayPeekErrorCode = Extract<GatewayPeekResult, {ok: false}>["code"];

/**
 * 有界读取请求体开头的 model 字段并生成转发 body 流：
 * 命中后只替换 model 值，剩余字节继续流式透传，不做全量缓冲。
 * model 字段的定位与替换全程按原始字节进行，不做 UTF-8 解码/重编码，
 * 避免 TCP 分块边界切断多字节字符时产生 U+FFFD 损坏请求体其余内容。
 *
 * `isFailoverArmed` 回调在 model 前缀解析出目标与模型的瞬间同步判定：
 * 命中备份链时 body 流保留客户端原始 model 字节（由转发层按候选改写），
 * 否则维持既有行为（在此处一次性改写为真实模型 ID）。
 * 压缩标记扫描窗口独立于 model 定位上限（≤scanWindowBytes，默认 2 MiB），
 * 仅故障转移启用时收集；未配置备份链的模型在 model 定位后立即停扫（公共路径零积累）。
 */
async function peekGatewayModel(
  request: IncomingMessage,
  response: ServerResponse,
  expectContinue: boolean,
  maxBytes: number,
  /** 压缩证据扫描窗口（独立于 model 定位上限：标记可能被大 instructions 推向深处）。 */
  scanWindowBytes: number,
  isFailoverArmed: (targetId: string, modelId: string) => boolean,
): Promise<GatewayPeekResult> {
  if (expectContinue) response.writeContinue();
  const chunks: Buffer[] = [];
  const scanParts: Buffer[] = [];
  let scanBytes = 0;
  let scanSettled = false;
  let scanSettle: (() => void) | undefined;
  const scanDone = new Promise<void>(resolve => { scanSettle = resolve; });
  const settleScan = () => {
    if (scanSettled) return;
    scanSettled = true;
    scanSettle?.();
  };
  const pushScan = (chunk: Buffer) => {
    // 封顶用独立的压缩扫描窗口（可越过 64 KiB model 定位上限：真实案例中 codex
    // 压缩标记位于请求体第 81,852 字节）。
    if (scanSettled || scanBytes >= scanWindowBytes) return;
    const slice = chunk.length > scanWindowBytes - scanBytes
      ? chunk.subarray(0, scanWindowBytes - scanBytes)
      : chunk;
    scanParts.push(Buffer.from(slice));
    scanBytes += slice.length;
    if (scanBytes >= scanWindowBytes) settleScan();
  };
  let failoverArmed = false;
  let total = 0;
  let requestedModel: string | undefined;
  let bodyOut: PassThrough | undefined;
  let settled = false;

  return new Promise(resolvePromise => {
    const fail = (code: GatewayPeekErrorCode) => {
      if (settled) return;
      settled = true;
      // 停止继续消费请求体，由 writeLocalError + connection: close 结束连接。
      request.removeListener("data", onData);
      request.pause();
      settleScan();
      if (code === "MODEL_FIELD_NOT_FOUND") {
        // 诊断元数据（无正文内容，2026-10-08 用户确认）：用于定位客户端序列化
        // 把 model 推出窗口（如桌面 App 超大插件前缀）还是根本未携带 model 字段。
        const scan = Buffer.concat(scanParts);
        console.error(
          `[Proxy] MODEL_FIELD_NOT_FOUND ua=${String(request.headers["user-agent"] ?? "unknown")}`
          + ` ct=${String(request.headers["content-type"] ?? "unknown")}`
          + ` cl=${String(request.headers["content-length"] ?? "unknown")}`
          + ` windowBytes=${String(scanBytes)}`
          + ` modelKeyBytes=${scan.includes(Buffer.from("\"model\"")) ? "yes" : "no"}`,
        );
      }
      resolvePromise({ok: false, code});
    };
    const onData = (chunk: Buffer) => {
      pushScan(chunk);
      if (requestedModel === undefined) {
        // model 定位阶段保留防御性拷贝（原既有行为）；定位完成后不再逐分片拷贝。
        const buffer = Buffer.from(chunk);
        chunks.push(buffer);
        total += buffer.length;
        if (total > maxBytes) {
          fail("REQUEST_BODY_TOO_LARGE");
          return;
        }
        const accumulated = Buffer.concat(chunks);
        const match = findModelTokenBytes(accumulated);
        if (!match) return;
        const parsed = parseGatewayModelId(match.model);
        if (!parsed) {
          fail("MODEL_PREFIX_REQUIRED");
          return;
        }
        requestedModel = match.model;
        failoverArmed = isFailoverArmed(parsed.targetId, parsed.modelId);
        // 未配置备份链的模型：压缩扫描永远不会被消费，立即停扫（公共路径零额外积累）。
        if (!failoverArmed) settleScan();
        bodyOut = new PassThrough({highWaterMark: failoverArmed ? scanWindowBytes : undefined});
        // 故障转移启用：保留原始 model 字节，逐候选尝试时再按候选模型改写。
        bodyOut.write(failoverArmed
          ? accumulated
          : rewriteModelValueBytes(accumulated, match, parsed.modelId));
        settled = true;
        // service_tier 计费参数：与 model 同一批有界前缀字节提取，随捕获记录透传给派生侧计价。
        const serviceTier = extractServiceTierValue(accumulated);
        const modelToken = match;
        // 暂停请求，等待上游管道接好后再续流，避免小 body 提前结束导致转发空内容。
        request.pause();
        resolvePromise({
          ok: true,
          requestedModel,
          bodySource: bodyOut,
          resumeRequest: () => request.resume(),
          ...(serviceTier ? {serviceTier} : {}),
          modelToken,
          keptOriginalModel: failoverArmed,
          scan: {
            buffer: () => Buffer.concat(scanParts),
            done: scanDone,
          },
        });
        return;
      }
      if (!bodyOut || !bodyOut.write(chunk)) {
        if (bodyOut) {
          request.pause();
          bodyOut.once("drain", () => request.resume());
        }
      }
    };
    request.on("data", onData);
    request.on("end", () => {
      settleScan();
      if (settled) {
        bodyOut?.end();
        return;
      }
      fail("MODEL_FIELD_NOT_FOUND");
    });
    request.on("error", () => {
      settleScan();
      if (!settled) fail("MODEL_FIELD_NOT_FOUND");
    });
  });
}

function resolveCredentialHelperPath(): string {
  const envPath = process.env.DEEPAA_CREDENTIAL_HELPER;
  if (envPath) return envPath;
  return fileURLToPath(new URL("../../bin/credential-helper.mjs", import.meta.url));
}

async function closeProxy(
  server: Server,
  routing: RoutingConfigController,
  agents: UpstreamAgentPool,
  sockets: Set<Socket>,
  store: CaptureStore,
  force: boolean,
): Promise<void> {
  await routing.close();
  const closed = new Promise<void>(resolve => server.close(() => resolve()));
  if (force) {
    for (const socket of sockets) socket.destroy();
  } else {
    const timer = setTimeout(() => {
      for (const socket of sockets) socket.destroy();
    }, SHUTDOWN_DRAIN_MS);
    timer.unref();
    void closed.finally(() => clearTimeout(timer));
  }
  await closed;
  await drainCaptureStore(store);
  agents.close();
}

async function drainCaptureStore(store: CaptureStore): Promise<void> {
  if (!store.drain) return;
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      store.drain(),
      new Promise<void>(resolve => {
        timer = setTimeout(resolve, SHUTDOWN_DRAIN_MS);
        timer.unref();
      }),
    ]);
  } catch (error) {
    reportCaptureError(error);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function writeLocalError(response: ServerResponse, status: number, code: string, message?: string): void {
  if (response.headersSent || response.destroyed) return;
  const body = Buffer.from(JSON.stringify(message ? {error: code, message} : {error: code}));
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": String(body.length),
    connection: "close",
  });
  response.end(body);
}

function rejectRawSocket(socket: Duplex, status: number): void {
  if (socket.destroyed) return;
  socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

function reportCaptureError(error: unknown): void {
  console.error(`[Proxy] ${error instanceof Error ? error.message : String(error)}`);
}

function parsePort(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 65_535 ? parsed : fallback;
}
