import http, {
  Agent as HttpAgent,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
} from "node:http";
import https, {Agent as HttpsAgent} from "node:https";
import type {Transform} from "node:stream";
import * as nodeZlib from "node:zlib";
import {resolveOfficialUpstreamProxy} from "./official-upstream";
import {createConnectTunnelHttpsAgent} from "./upstream-proxy";
const {createBrotliDecompress, createGunzip, createInflate} = nodeZlib;

/**
 * 响应解码能力表 = accept-encoding 透传白名单：
 * 只有代理能解码的编码才允许透传给上游——否则上游返回的压缩字节会绕过解码器
 * 流进 raw 捕获（捕获挂在解码之后），污染 JSONL 文本语义。
 * zstd 在运行时 zlib 支持时自动加入（Node 22.15+），旧运行时不透传该编码。
 */
const RESPONSE_DECODERS: Readonly<Record<string, (() => Transform) | undefined>> = (() => {
  const zstd = typeof (nodeZlib as {createZstdDecompress?: unknown}).createZstdDecompress === "function"
    ? (nodeZlib as {createZstdDecompress?: () => Transform}).createZstdDecompress
    : undefined;
  return {
    gzip: createGunzip,
    deflate: createInflate,
    br: createBrotliDecompress,
    ...(zstd ? {zstd: zstd} : {}),
  };
})();

export function supportedAcceptEncodings(): readonly string[] {
  return Object.keys(RESPONSE_DECODERS);
}

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/** 响应头绝对超时：从请求发出开始计时，无论 socket 是否有活动，超时即断开。 */
const DEFAULT_HEADER_TIMEOUT_MS = 60_000;

interface AgentEntry {
  agent: HttpAgent | HttpsAgent;
  active: number;
  retired: boolean;
}

export interface AgentLease {
  agent: HttpAgent | HttpsAgent;
  release(): void;
}

/** keep-alive Agent 的退休不会中断活动流，只在最后一个 lease 释放后销毁。 */
export class UpstreamAgentPool {
  private readonly entries = new Map<string, AgentEntry>();

  /**
   * 按 origin 池化上游连接 Agent（2026-10-08 起异步化）：国际官方上游白名单域
   * 且探测到系统代理时改用 CONNECT 隧道 Agent，其余一切目标与既有直连行为
   * 字节级一致（影响隔离红线，tests/upstream-proxy.test.ts 守卫）。
   */
  async acquire(url: URL): Promise<AgentLease> {
    const origin = url.origin;
    let entry = this.entries.get(origin);
    if (!entry || entry.retired) {
      const options = {
        keepAlive: true,
        keepAliveMsecs: 1_000,
        maxSockets: 128,
        maxFreeSockets: 16,
        timeout: 30_000,
        scheduling: "lifo" as const,
      };
      let agent: HttpAgent | HttpsAgent;
      if (url.protocol === "https:") {
        const proxy = await resolveOfficialUpstreamProxy(url.hostname);
        agent = proxy ? createConnectTunnelHttpsAgent(proxy, options) : new HttpsAgent(options);
      } else {
        agent = new HttpAgent(options);
      }
      entry = {
        agent,
        active: 0,
        retired: false,
      };
      this.entries.set(origin, entry);
    }
    entry.active += 1;
    let released = false;
    return {
      agent: entry.agent,
      release: () => {
        if (released) return;
        released = true;
        entry!.active = Math.max(0, entry!.active - 1);
        if (entry!.retired && entry!.active === 0) {
          entry!.agent.destroy();
          if (this.entries.get(origin) === entry) this.entries.delete(origin);
        }
      },
    };
  }

  retainOrigins(origins: ReadonlySet<string>): void {
    for (const [origin, entry] of this.entries) {
      if (origins.has(origin)) continue;
      entry.retired = true;
      if (entry.active === 0) {
        entry.agent.destroy();
        this.entries.delete(origin);
      }
    }
  }

  close(): void {
    for (const entry of this.entries.values()) entry.agent.destroy();
    this.entries.clear();
  }
}

export function createUpstreamRequest(
  url: URL,
  options: {
    method: string;
    headers: OutgoingHttpHeaders;
    agent: HttpAgent | HttpsAgent;
    /** 响应头绝对超时（毫秒），默认 60s；测试可缩短。 */
    headerTimeoutMs?: number;
  },
  onResponse: (response: IncomingMessage) => void,
) {
  const headerTimeoutMs = options.headerTimeoutMs ?? DEFAULT_HEADER_TIMEOUT_MS;
  const headerDeadline = setTimeout(() => {
    request.destroy(new Error("UPSTREAM_RESPONSE_HEADER_TIMEOUT"));
  }, headerTimeoutMs);
  headerDeadline.unref();
  const request = (url.protocol === "https:" ? https.request : http.request)(url, {
    method: options.method,
    headers: options.headers,
    agent: options.agent,
    joinDuplicateHeaders: true,
  }, response => {
    clearTimeout(headerDeadline);
    onResponse(response);
  });
  request.setTimeout(30_000, () => {
    request.destroy(new Error("UPSTREAM_RESPONSE_HEADER_TIMEOUT"));
  });
  request.once("socket", socket => {
    if (!socket.connecting) return;
    const connectTimer = setTimeout(() => {
      socket.destroy(new Error("UPSTREAM_CONNECT_TIMEOUT"));
    }, 10_000);
    connectTimer.unref();
    const clear = () => clearTimeout(connectTimer);
    socket.once("connect", clear);
    socket.once("secureConnect", clear);
    socket.once("error", clear);
  });
  return request;
}

export function requestHeadersForUpstream(request: IncomingMessage, upstreamUrl: URL): OutgoingHttpHeaders {
  const connectionTokens = connectionHeaderTokens(request.rawHeaders);
  const headers: OutgoingHttpHeaders = {};
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    const originalName = request.rawHeaders[index]!;
    const name = originalName.toLowerCase();
    const value = request.rawHeaders[index + 1] ?? "";
    if (name === "host" || HOP_BY_HOP_HEADERS.has(name) || connectionTokens.has(name)) continue;
    appendHeader(headers, name, value);
  }
  headers.host = upstreamUrl.host;
  applyUpstreamAcceptEncoding(headers);
  return headers;
}

/**
 * 按代理解码能力过滤透传客户端 accept-encoding（2026-09-15 取代强制 identity）：
 * - 客户端原值按 token 过滤，只保留 RESPONSE_DECODERS 支持的编码，其余（如 zstd）剔除；
 * - 客户端未发送该头、或过滤后无剩余编码时删除该头——绝不注入 identity 等代理自身
 *   信号（codex 原生即不发送 accept-encoding，凭空添加等于向上游暴露中间层的存在）。
 * 捕获语义不受影响：raw 捕获挂在 responseDecoder 之后，上游合法压缩响应仍落盘明文。
 */
function applyUpstreamAcceptEncoding(headers: OutgoingHttpHeaders): void {
  const raw = headers["accept-encoding"];
  delete headers["accept-encoding"];
  if (raw === undefined || raw === null) return;
  const value = Array.isArray(raw) ? raw.join(",") : String(raw);
  const kept = value.split(",")
    .map(token => token.trim())
    .filter(Boolean)
    .filter(token => RESPONSE_DECODERS[token.split(";")[0]!.trim().toLowerCase()] !== undefined);
  if (kept.length > 0) headers["accept-encoding"] = kept.join(", ");
}

/** OpenCode Go 的供应商专用上游入口。 */
export function isOpenCodeGoUpstream(upstreamUrl: URL): boolean {
  const pathname = upstreamUrl.pathname.replace(/\/+$/u, "");
  return upstreamUrl.hostname === "opencode.ai"
    && (pathname === "/zen/go" || pathname.startsWith("/zen/go/"));
}

/**
 * 按 Agent 业务 Session 头解析 OpenCode Go 所需的身份。
 *
 * 这里绝不创建随机值，也不使用 DeepAA 派生的内部 AgentSession.id：后者要在
 * 请求捕获后才能由业务索引确定，无法作为发送前的身份。已有原生
 * x-opencode-session 优先，其次才映射各 Agent 明确携带的外部 Session 头。
 */
export function ensureOpenCodeGoSessionHeader(
  headers: OutgoingHttpHeaders,
  upstreamUrl: URL,
  agent?: string,
): string | undefined {
  if (!isOpenCodeGoUpstream(upstreamUrl)) return undefined;
  const candidates = [
    "x-opencode-session",
    ...(agent === "dsh" ? ["x-deepseek-harness-session-id", "x-dsh-session-id"] : []),
    ...(agent === "codex" ? ["x-codex-session-id"] : []),
    ...(agent === "claude" ? ["x-claude-code-session-id"] : []),
    "session_id",
    "session-id",
    "x-session-id",
    "x-session-affinity",
  ];
  for (const name of candidates) {
    const value = firstHeaderValue(headers[name]);
    if (!value) continue;
    if (name !== "x-opencode-session") headers["x-opencode-session"] = value;
    return value;
  }
  return undefined;
}

function firstHeaderValue(value: string | string[] | number | undefined): string | undefined {
  const values = Array.isArray(value) ? value : [value];
  for (const item of values) {
    const normalized = String(item ?? "").trim();
    if (normalized) return normalized;
  }
  return undefined;
}

export function responseHeadersForClient(
  response: IncomingMessage,
  decoded: boolean,
): string[] {
  const connectionTokens = connectionHeaderTokens(response.rawHeaders);
  const headers: string[] = [];
  for (let index = 0; index < response.rawHeaders.length; index += 2) {
    const originalName = response.rawHeaders[index]!;
    const name = originalName.toLowerCase();
    const value = response.rawHeaders[index + 1] ?? "";
    if (HOP_BY_HOP_HEADERS.has(name) || connectionTokens.has(name)) continue;
    if (decoded && (name === "content-encoding" || name === "content-length")) continue;
    headers.push(originalName, value);
  }
  return headers;
}

export function normalizedHeaders(rawHeaders: readonly string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const name = rawHeaders[index]!.toLowerCase();
    const value = rawHeaders[index + 1] ?? "";
    result[name] = result[name] === undefined ? value : `${result[name]}, ${value}`;
  }
  return result;
}

export function responseDecoder(headers: IncomingHttpHeaders): Transform | undefined {
  const encoding = Array.isArray(headers["content-encoding"])
    ? headers["content-encoding"][0]
    : headers["content-encoding"];
  const factory = RESPONSE_DECODERS[encoding?.trim().toLowerCase() ?? ""];
  return factory ? factory() : undefined;
}

/**
 * 拼接上游请求 URL，语义与 OpenAI / Anthropic SDK 行业规范保持一致：
 * - OpenAI 协议请求（/v1/responses、/v1/chat/completions）：各家官方提供的 base URL
 *   自带版本段（如 /v1、/api/v3、/api/paas/v4），端点本身不带 /v1，
 *   因此去掉请求路径的 /v1 协议版本段后再拼接；裸根 base（如
 *   https://api.straitapi.com）按标准 OpenAI base 补 /v1，兼容 New API 等
 *   只注册 /v1 路由的中转站，带路径的 base 一律不再补，避免 /api/plan/v3/v1 类错误。
 * - Anthropic 协议请求（/v1/messages）：SDK 规范为 base URL + /v1/messages，
 *   请求路径的 /v1 段原样保留。
 * 兼容历史配置：base 自身以 v1 结尾时按末段去重，避免 /v1/v1 重复。
 */
export function buildUpstreamUrl(baseUrl: string, requestPath: string, search: string): URL {
  const base = new URL(baseUrl);
  const baseSegments = base.pathname.split("/").filter(Boolean);
  const requestSegments = requestPath.split("/").filter(Boolean);
  const openaiEndpoint = requestSegments[0] === "v1"
    && (requestSegments[1] === "responses" || requestSegments[1] === "chat");
  // OpenAI 协议端点不带 /v1（responses、chat/completions）；Anthropic 的 messages 保留。
  if (openaiEndpoint) requestSegments.shift();
  // 裸根 base 补齐 /v1：标准 OpenAI SDK base 自带版本段，New API 等中转站只注册 /v1 路由。
  if (openaiEndpoint && baseSegments.length === 0) baseSegments.push("v1");
  // 兼容 base 自身以 v1 结尾的历史配置：末段去重，避免 /v1/v1 重复。
  if (baseSegments.length > 0 && requestSegments[0] === baseSegments.at(-1)) requestSegments.shift();
  const pathname = `/${[...baseSegments, ...requestSegments].join("/")}`;
  return new URL(`${base.origin}${pathname === "/" ? "" : pathname}${search}`);
}

function appendHeader(headers: OutgoingHttpHeaders, name: string, value: string): void {
  const current = headers[name];
  if (current === undefined) {
    headers[name] = value;
  } else if (Array.isArray(current)) {
    current.push(value);
  } else {
    headers[name] = [String(current), value];
  }
}

function connectionHeaderTokens(rawHeaders: readonly string[]): Set<string> {
  const tokens = new Set<string>();
  for (let index = 0; index < rawHeaders.length; index += 2) {
    if (rawHeaders[index]!.toLowerCase() !== "connection") continue;
    for (const token of (rawHeaders[index + 1] ?? "").split(",")) {
      if (token.trim()) tokens.add(token.trim().toLowerCase());
    }
  }
  return tokens;
}
