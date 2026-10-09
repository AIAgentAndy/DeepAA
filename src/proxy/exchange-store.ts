import {mkdir} from "node:fs/promises";
import {join} from "node:path";
import {appendRawCapturedExchangeV2, createV2CaptureSessionId} from "./capture-writer.js";
import {CaptureBudget, RawBodyCollector, type RawBodyPolicy} from "./raw-body-collector.js";
import type {
  CaptureDiagnostic,
  CaptureRouting,
  CollectedRawBody,
  RawCapturedExchangeV2,
  StreamConnectionStatus,
} from "./raw-v2-contract.js";

const DEFAULT_MAX_RUNTIME_SESSIONS = 1_000;
const DEFAULT_MAX_RECENT_DIAGNOSTICS = 100;
const DEFAULT_MAX_PENDING_RECORD_BYTES = 64 * 1024 * 1024;

interface ProxyExchangeStoreOptions {
  dataDir: string;
  maxRuntimeSessions?: number;
  maxRecentDiagnostics?: number;
  captureBudget?: CaptureBudget;
  rawBodyPolicy?: Partial<RawBodyPolicy>;
  maxPendingRecordBytes?: number;
  appendExchange?: typeof appendRawCapturedExchangeV2;
}

export interface ProxyCapturedExchangeInput {
  capturedAt: string;
  completedAt: string;
  model: string;
  /** 首字时间（毫秒）：转发开始到首个上游响应 chunk；无响应体缺省。 */
  firstTokenMs?: number;
  routing: CaptureRouting;
  request: {
    headers: Record<string, string>;
    body: CollectedRawBody;
    /** 请求体携带的 service_tier（计费参数，可选）。 */
    serviceTier?: string;
  };
  response: {
    status: number;
    statusText: string;
    headers: Record<string, string>;
    body: CollectedRawBody;
    isStreaming: boolean;
  };
  connectionStatus?: StreamConnectionStatus;
  sessionId?: string;
}

/** 只落盘计费相关的 service_tier 取值，其它任意值一律丢弃。 */
function normalizeServiceTier(value: string | undefined): "priority" | "flex" | "fast" | undefined {
  return value === "priority" || value === "flex" || value === "fast" ? value : undefined;
}

interface RuntimeSession {
  id: string;
  key: string;
  sequence: number;
  lastActivityAt: string;
}

interface RecentDiagnostic {
  exchangeId: string;
  status: number;
  diagnosticCodes: string[];
  completedAt: string;
}

/** 代理侧只写 Store；完整正文不进入任何长期内存集合。 */
export class ProxyExchangeStore {
  private readonly dataDir: string;
  private readonly maxRuntimeSessions: number;
  private readonly maxRecentDiagnostics: number;
  private readonly captureBudget: CaptureBudget;
  private readonly rawBodyPolicy?: Partial<RawBodyPolicy>;
  private readonly maxPendingRecordBytes: number;
  private readonly appendExchange: typeof appendRawCapturedExchangeV2;
  private readonly sessionsByKey = new Map<string, RuntimeSession>();
  private readonly sessionsById = new Map<string, RuntimeSession>();
  private readonly recentDiagnostics: RecentDiagnostic[] = [];
  private readonly pendingRecords = new Set<Promise<RawCapturedExchangeV2 | undefined>>();
  private readonly pendingCaptureTasks = new Set<Promise<unknown>>();
  private capturePendingRecordBytes = 0;
  private peakCapturePendingRecordBytes = 0;
  private captureDroppedRecords = 0;
  private captureMissingBodies = 0;
  private captureDegraded = false;
  private rawWriteFailures = 0;
  private lastErrorAt = 0;

  constructor(options: ProxyExchangeStoreOptions) {
    this.dataDir = options.dataDir;
    this.maxRuntimeSessions = options.maxRuntimeSessions ?? DEFAULT_MAX_RUNTIME_SESSIONS;
    this.maxRecentDiagnostics = options.maxRecentDiagnostics ?? DEFAULT_MAX_RECENT_DIAGNOSTICS;
    this.captureBudget = options.captureBudget ?? new CaptureBudget();
    this.rawBodyPolicy = options.rawBodyPolicy;
    this.maxPendingRecordBytes = options.maxPendingRecordBytes ?? DEFAULT_MAX_PENDING_RECORD_BYTES;
    this.appendExchange = options.appendExchange ?? appendRawCapturedExchangeV2;
  }

  async init(): Promise<void> {
    try {
      await Promise.all([
        mkdir(join(this.dataDir, "captures", "v2"), {recursive: true}),
        mkdir(join(this.dataDir, "blobs", ".tmp"), {recursive: true}),
      ]);
      this.captureDegraded = false;
    } catch (error) {
      this.captureDegraded = true;
      this.reportWriteError(error);
    }
  }

  async createBodyCollector(): Promise<RawBodyCollector> {
    return RawBodyCollector.create({
      dataDir: this.dataDir,
      budget: this.captureBudget,
      policy: this.rawBodyPolicy,
      directoryReady: !this.captureDegraded,
    });
  }

  record(input: ProxyCapturedExchangeInput): Promise<RawCapturedExchangeV2 | undefined> {
    let exchange: RawCapturedExchangeV2;
    try {
      exchange = this.buildExchange(input);
    } catch (error) {
      return Promise.reject(error);
    }
    const recordBytes = Buffer.byteLength(JSON.stringify(exchange), "utf8") + 1;
    if (recordBytes > this.maxPendingRecordBytes
      || this.capturePendingRecordBytes + recordBytes > this.maxPendingRecordBytes) {
      this.captureDroppedRecords += 1;
      this.captureDegraded = true;
      return Promise.resolve(undefined);
    }
    this.capturePendingRecordBytes += recordBytes;
    this.peakCapturePendingRecordBytes = Math.max(
      this.peakCapturePendingRecordBytes,
      this.capturePendingRecordBytes,
    );
    const pending = this.persistExchange(exchange);
    this.pendingRecords.add(pending);
    const release = () => {
      this.pendingRecords.delete(pending);
      this.capturePendingRecordBytes = Math.max(0, this.capturePendingRecordBytes - recordBytes);
    };
    void pending.then(
      release,
      release,
    );
    return pending;
  }

  /** 从正文 finalize 开始追踪整条抓包任务，确保关闭摘要不会早于 blob/JSONL 完成。 */
  trackCapture(task: Promise<unknown>): void {
    this.pendingCaptureTasks.add(task);
    const release = () => this.pendingCaptureTasks.delete(task);
    void task.then(release, release);
  }

  async drain(): Promise<void> {
    while (this.pendingCaptureTasks.size > 0 || this.pendingRecords.size > 0) {
      await Promise.allSettled([...this.pendingCaptureTasks, ...this.pendingRecords]);
    }
  }

  private buildExchange(input: ProxyCapturedExchangeInput): RawCapturedExchangeV2 {
    const session = this.resolveSession(input);
    session.sequence += 1;
    session.lastActivityAt = input.completedAt;
    this.captureMissingBodies += Number(input.request.body.missing) + Number(input.response.body.missing);
    const diagnostics = buildDiagnostics(input);
    const exchangeId = `${session.id}:ex-${session.sequence}`;
    const exchange: RawCapturedExchangeV2 = {
      schemaVersion: 2,
      exchangeId,
      captureSessionId: session.id,
      sequence: session.sequence,
      capturedAt: input.capturedAt,
      completedAt: input.completedAt,
      durationMs: Math.max(0, Date.parse(input.completedAt) - Date.parse(input.capturedAt)),
      ...(typeof input.firstTokenMs === "number" && Number.isFinite(input.firstTokenMs)
        ? {firstTokenMs: Math.max(0, Math.round(input.firstTokenMs))}
        : {}),
      routing: {...input.routing},
      request: {
        headers: lowerCaseHeaders(input.request.headers),
        rawBody: input.request.body.rawBody,
        rawBodyRef: input.request.body.rawBodyRef,
        bodySizeBytes: input.request.body.bodySizeBytes,
        bodySha256: input.request.body.bodySha256,
        ...(normalizeServiceTier(input.request.serviceTier)
          ? {serviceTier: normalizeServiceTier(input.request.serviceTier)}
          : {}),
      },
      response: {
        status: input.response.status,
        statusText: input.response.statusText,
        headers: lowerCaseHeaders(input.response.headers),
        rawBody: input.response.body.rawBody,
        rawBodyRef: input.response.body.rawBodyRef,
        bodySizeBytes: input.response.body.bodySizeBytes,
        bodySha256: input.response.body.bodySha256,
        isStreaming: input.response.isStreaming,
      },
      bodyStorage: storageMetadata(input.request.body, input.response.body),
      captureDiagnostics: diagnostics,
      security: {
        containsSensitiveHeaders: containsSensitiveHeaders(input.request.headers)
          || containsSensitiveHeaders(input.response.headers),
        headerRedactionAppliedInApi: true,
        rawBodiesStoredLocally: true,
      },
    };
    this.pushRecentDiagnostic({
      exchangeId,
      status: input.response.status,
      diagnosticCodes: diagnostics.map(item => item.code),
      completedAt: input.completedAt,
    });
    return exchange;
  }

  private async persistExchange(exchange: RawCapturedExchangeV2): Promise<RawCapturedExchangeV2 | undefined> {
    try {
      await this.appendExchange(this.dataDir, exchange);
      this.captureDegraded = false;
      return exchange;
    } catch (error) {
      this.captureDegraded = true;
      this.rawWriteFailures += 1;
      this.reportWriteError(error);
      return undefined;
    }
  }

  runtimeState(): {
    activeSessionCount: number;
    recentDiagnosticsCount: number;
    captureDegraded: boolean;
    rawWriteFailures: number;
    capturePendingBytes: number;
    activeFinalizers: number;
    queuedFinalizers: number;
    capturePendingTasks: number;
    capturePendingRecordBytes: number;
    peakCapturePendingRecordBytes: number;
    captureDroppedRecords: number;
    captureMissingBodies: number;
  } {
    return {
      activeSessionCount: this.sessionsByKey.size,
      recentDiagnosticsCount: this.recentDiagnostics.length,
      captureDegraded: this.captureDegraded,
      rawWriteFailures: this.rawWriteFailures,
      capturePendingBytes: this.captureBudget.pendingBytes,
      activeFinalizers: this.captureBudget.activeFinalizers,
      queuedFinalizers: this.captureBudget.queuedFinalizers,
      capturePendingTasks: this.pendingCaptureTasks.size,
      capturePendingRecordBytes: this.capturePendingRecordBytes,
      peakCapturePendingRecordBytes: this.peakCapturePendingRecordBytes,
      captureDroppedRecords: this.captureDroppedRecords,
      captureMissingBodies: this.captureMissingBodies,
    };
  }

  private resolveSession(input: ProxyCapturedExchangeInput): RuntimeSession {
    if (input.sessionId) {
      const existing = this.sessionsById.get(input.sessionId);
      if (existing) return existing;
    }
    const key = `${normalizeKey(input.routing.targetId)}::${normalizeKey(input.model || "unknown")}::${localDate(input.capturedAt)}`;
    const existing = this.sessionsByKey.get(key);
    if (existing) return existing;
    const session: RuntimeSession = {
      id: input.sessionId ?? createV2CaptureSessionId(),
      key,
      sequence: 0,
      lastActivityAt: input.capturedAt,
    };
    this.sessionsByKey.set(key, session);
    this.sessionsById.set(session.id, session);
    this.pruneSessions();
    return session;
  }

  private pruneSessions(): void {
    while (this.sessionsByKey.size > this.maxRuntimeSessions) {
      let oldest: RuntimeSession | undefined;
      for (const session of this.sessionsByKey.values()) {
        if (!oldest || session.lastActivityAt < oldest.lastActivityAt) oldest = session;
      }
      if (!oldest) return;
      this.sessionsByKey.delete(oldest.key);
      this.sessionsById.delete(oldest.id);
    }
  }

  private pushRecentDiagnostic(item: RecentDiagnostic): void {
    if (this.maxRecentDiagnostics <= 0) return;
    this.recentDiagnostics.push(item);
    if (this.recentDiagnostics.length > this.maxRecentDiagnostics) {
      this.recentDiagnostics.splice(0, this.recentDiagnostics.length - this.maxRecentDiagnostics);
    }
  }

  private reportWriteError(error: unknown): void {
    const now = Date.now();
    if (now - this.lastErrorAt < 10_000) return;
    this.lastErrorAt = now;
    console.error(`[ProxyCapture] ${error instanceof Error ? error.message : String(error)}`);
  }
}

function buildDiagnostics(input: ProxyCapturedExchangeInput): CaptureDiagnostic[] {
  const diagnostics: CaptureDiagnostic[] = [];
  if (input.request.body.missing || input.response.body.missing) {
    diagnostics.push({
      code: "missing_raw_body",
      severity: "warning",
      message: "Raw body capture exceeded its bounded storage budget or failed.",
    });
  }
  if (input.response.status >= 400 && input.response.status !== 499) {
    diagnostics.push({
      code: "upstream_error",
      severity: "error",
      message: `HTTP ${input.response.status} response captured.`,
    });
  }
  const status = input.connectionStatus;
  if (status && status !== "open_completed" && status !== "unknown") {
    diagnostics.push({
      code: status === "proxy_stream_error" ? "proxy_error" : status,
      severity: status === "client_aborted" ? "warning" : "error",
      message: `Stream connection ended with ${status}.`,
    });
  }
  return diagnostics;
}

function storageMetadata(request: CollectedRawBody, response: CollectedRawBody): RawCapturedExchangeV2["bodyStorage"] {
  const storage = [request.rawBodyRef?.storage, response.rawBodyRef?.storage];
  const policy = storage.includes("external-blob")
    ? "external-blob"
    : storage.includes("compressed-inline") ? "compressed-inline" : "inline";
  return {
    policy,
    compression: "gzip",
    externalBlobDir: "blobs",
    thresholdBytes: 256 * 1024,
  };
}

function lowerCaseHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
}

function containsSensitiveHeaders(headers: Record<string, string>): boolean {
  return Object.keys(headers).some(key => [
    "authorization",
    "api-key",
    "x-api-key",
    "cookie",
    "set-cookie",
    "proxy-authorization",
  ].includes(key.toLowerCase()));
}

function normalizeKey(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9.-]+/gu, ".") || "unknown";
}

function localDate(timestamp: string): string {
  const date = new Date(timestamp);
  return (Number.isNaN(date.getTime()) ? new Date() : date).toLocaleDateString("sv-SE");
}
