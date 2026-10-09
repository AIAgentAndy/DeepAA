/**
 * 代理侧 Exchange Store：只负责当前进程的有界内存和 v2 raw/blob 追加。
 * 分析、索引和数据库均由 Next 进程中的异步 Worker 负责，不能进入代理依赖图。
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { resolveDeepaaDataDir } from "./lib/data-paths.js";
import {
  appendRawCapturedExchangeV2,
  buildRawCapturedExchangeV2,
  createV2CaptureSessionId,
} from "./lib/harness/raw-capture.js";
import type {
  CaptureRouting,
  RawCapturedExchange,
  StreamConnectionStatus,
} from "./lib/harness/types.js";
import type { SessionMeta } from "./types.js";

export const MAX_RECENT_RAW_EXCHANGES_PER_SESSION = 20;

interface ExchangeStoreOptions {
  dataDir?: string;
}

export interface CapturedExchangeInput {
  capturedAt: string;
  completedAt: string;
  routing: CaptureRouting;
  request: {
    headers: Record<string, string>;
    rawBody: string;
  };
  response: {
    status: number;
    statusText: string;
    headers: Record<string, string>;
    rawBody: string;
    isStreaming: boolean;
  };
  connectionStatus?: StreamConnectionStatus;
}

export interface SessionRoutingInput {
  targetId: string;
  targetName: string;
  timestamp: string;
  model: string;
}

interface AutoSessionMeta {
  key: string;
  baseKey: string;
  targetName: string;
  model: string;
  date: string;
  generation: number;
  manual: boolean;
}

interface RuntimeSessionSummary {
  startTime: string;
  lastActivityTime: string;
  turnCount: number;
  model: string;
  date: string;
  targetNames: string[];
  fileSize?: number;
}

export class ExchangeStore {
  private currentSessionId: string;
  private readonly dataDir: string;
  private readonly captureDir: string;
  private readonly blobDir: string;
  private readonly rawCaptures = new Map<string, RawCapturedExchange[]>();
  private readonly rawSequenceBySessionId = new Map<string, number>();
  private readonly autoSessionIds = new Map<string, string>();
  private readonly autoSessionGenerations = new Map<string, number>();
  private readonly sessionMeta = new Map<string, AutoSessionMeta>();
  private readonly sessionSummaries = new Map<string, RuntimeSessionSummary>();
  private readonly listeners: Array<(
    exchange: RawCapturedExchange,
    sessionId: string,
  ) => void> = [];

  constructor(options: ExchangeStoreOptions = {}) {
    this.dataDir = options.dataDir || resolveDeepaaDataDir();
    this.captureDir = join(this.dataDir, "captures", "v2");
    this.blobDir = join(this.dataDir, "blobs");
    this.currentSessionId = this.createSessionId();
  }

  async init(): Promise<void> {
    await Promise.all([
      mkdir(this.captureDir, { recursive: true }),
      mkdir(this.blobDir, { recursive: true }),
    ]);
  }

  getCurrentSessionId(): string {
    return this.currentSessionId;
  }

  async rotateCurrentSession(
    sessionId = this.currentSessionId,
  ): Promise<{ previousSessionId: string; currentSessionId: string }> {
    return this.rotateSession(sessionId);
  }

  rotateSession(
    sessionId: string,
  ): { previousSessionId: string; currentSessionId: string } {
    const meta = this.sessionMeta.get(sessionId);
    const nextSessionId = this.createSessionId();
    if (meta) {
      const generation = Math.max(
        meta.generation,
        this.autoSessionGenerations.get(meta.baseKey) || 1,
      ) + 1;
      const nextKey = this.sessionKeyWithGeneration(meta.baseKey, generation);
      this.autoSessionGenerations.set(meta.baseKey, generation);
      this.autoSessionIds.set(nextKey, nextSessionId);
      this.sessionMeta.set(nextSessionId, {
        ...meta,
        key: nextKey,
        generation,
        manual: true,
      });
    }
    this.currentSessionId = nextSessionId;
    return { previousSessionId: sessionId, currentSessionId: nextSessionId };
  }

  async addCapturedExchange(
    input: CapturedExchangeInput,
    sessionId?: string,
  ): Promise<RawCapturedExchange> {
    const resolvedSessionId = sessionId ?? this.getSessionIdForExchange({
      targetId: input.routing.targetId,
      targetName: input.routing.targetName,
      timestamp: input.capturedAt,
      model: modelFromRawBody(input.request.rawBody),
    });
    const exchange = await buildRawCapturedExchangeV2({
      dataDir: this.dataDir,
      captureSessionId: resolvedSessionId,
      sequence: this.nextRawSequence(resolvedSessionId),
      capturedAt: input.capturedAt,
      completedAt: input.completedAt,
      routing: input.routing,
      request: input.request,
      response: input.response,
      connectionStatus: input.connectionStatus,
    });

    let persistedFileSize: number | undefined;
    try {
      const persisted = await appendRawCapturedExchangeV2(this.dataDir, exchange);
      persistedFileSize = persisted.byteOffset + persisted.lineLengthBytes;
    } catch (error) {
      // raw 落盘失败不能改变已经完成的上游代理响应。
      console.error("[Store] Failed to persist v2 raw exchange:", error);
    }

    this.updateSessionSummary(
      resolvedSessionId,
      input,
      exchange.sequence,
      persistedFileSize,
    );
    const recent = this.rawCaptures.get(resolvedSessionId) || [];
    recent.push(exchange);
    if (recent.length > MAX_RECENT_RAW_EXCHANGES_PER_SESSION) {
      recent.splice(0, recent.length - MAX_RECENT_RAW_EXCHANGES_PER_SESSION);
    }
    this.rawCaptures.set(resolvedSessionId, recent);
    for (const listener of this.listeners) {
      try {
        listener(exchange, resolvedSessionId);
      } catch {
        // 观察者错误不能影响代理转发和 raw 证据落盘。
      }
    }
    return exchange;
  }

  getSessionIdForExchange(input: SessionRoutingInput): string {
    const candidate = this.getAutoSessionMeta(input);
    const existing = this.autoSessionIds.get(candidate.key);
    if (existing) {
      this.currentSessionId = existing;
      return existing;
    }
    const sessionId = this.createSessionId();
    this.autoSessionIds.set(candidate.key, sessionId);
    this.autoSessionGenerations.set(candidate.baseKey, candidate.generation);
    this.sessionMeta.set(sessionId, candidate);
    this.currentSessionId = sessionId;
    return sessionId;
  }

  onNewExchange(
    listener: (exchange: RawCapturedExchange, sessionId: string) => void,
  ): void {
    this.listeners.push(listener);
  }

  getRawExchanges(captureSessionId: string): RawCapturedExchange[] {
    return this.rawCaptures.get(captureSessionId) || [];
  }

  getDataDir(): string {
    return this.dataDir;
  }

  /** 仅返回当前进程内存摘要，不读取或枚举历史 raw 文件。 */
  async discoverSessions(): Promise<SessionMeta[]> {
    const sessions: SessionMeta[] = [];
    for (const [sessionId, summary] of this.sessionSummaries) {
      const meta = this.sessionMeta.get(sessionId);
      const generation = meta?.generation ?? 1;
      const date = meta?.date || summary.date;
      sessions.push({
        id: sessionId,
        provider: "proxy-capture",
        label: `${sessionId === this.currentSessionId ? "实时" : "当前进程"} · ${meta?.targetName || summary.targetNames[0] || "unknown"} · ${meta?.model || summary.model} · ${date}${generation > 1 ? ` #${generation}` : ""}`,
        sessionKey: meta?.key,
        sessionDate: date,
        model: meta?.model || summary.model,
        targetNames: summary.targetNames,
        generation,
        startTime: summary.startTime,
        lastActivityTime: summary.lastActivityTime,
        turnCount: summary.turnCount,
        fileSize: summary.fileSize,
        filePath: this.captureFilePath(sessionId),
      });
    }
    return sessions.sort((left, right) =>
      right.lastActivityTime.localeCompare(left.lastActivityTime)
    );
  }

  private createSessionId(): string {
    let sessionId = createV2CaptureSessionId();
    while (
      this.rawCaptures.has(sessionId)
      || this.sessionMeta.has(sessionId)
    ) {
      sessionId = createV2CaptureSessionId();
    }
    return sessionId;
  }

  private nextRawSequence(captureSessionId: string): number {
    const next = (this.rawSequenceBySessionId.get(captureSessionId) || 0) + 1;
    this.rawSequenceBySessionId.set(captureSessionId, next);
    return next;
  }

  private updateSessionSummary(
    sessionId: string,
    input: CapturedExchangeInput,
    sequence: number,
    persistedFileSize: number | undefined,
  ): void {
    const targetName = input.routing.targetName || input.routing.targetId;
    const existing = this.sessionSummaries.get(sessionId);
    if (!existing) {
      this.sessionSummaries.set(sessionId, {
        startTime: input.capturedAt,
        lastActivityTime: input.completedAt,
        turnCount: sequence,
        model: modelFromRawBody(input.request.rawBody),
        date: localDateFromTimestamp(input.capturedAt),
        targetNames: [targetName],
        fileSize: persistedFileSize,
      });
      return;
    }
    existing.lastActivityTime = input.completedAt;
    existing.turnCount = sequence;
    existing.fileSize = persistedFileSize ?? existing.fileSize;
    if (!existing.targetNames.includes(targetName)) {
      existing.targetNames.push(targetName);
    }
  }

  private getAutoSessionMeta(input: SessionRoutingInput): AutoSessionMeta {
    const targetId = normalizeKeyPart(input.targetId || "default");
    const targetName = input.targetName || input.targetId || "default";
    const model = input.model.trim() || "unknown";
    const date = localDateFromTimestamp(input.timestamp);
    const baseKey = `${targetId}::${normalizeKeyPart(model)}::${date}`;
    const generation = this.autoSessionGenerations.get(baseKey) || 1;
    return {
      key: this.sessionKeyWithGeneration(baseKey, generation),
      baseKey,
      targetName,
      model,
      date,
      generation,
      manual: generation > 1,
    };
  }

  private sessionKeyWithGeneration(baseKey: string, generation: number): string {
    return `${baseKey}::${generation}`;
  }

  private captureFilePath(sessionId: string): string {
    return join(this.captureDir, `${sessionId}.jsonl`);
  }
}

function normalizeKeyPart(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9.-]+/g, ".");
}

function localDateFromTimestamp(timestamp: string): string {
  const date = new Date(timestamp);
  return (Number.isNaN(date.getTime()) ? new Date() : date)
    .toLocaleDateString("sv-SE");
}

function modelFromRawBody(rawBody: string): string {
  if (!rawBody.trim()) return "unknown";
  try {
    const parsed = JSON.parse(rawBody) as { model?: unknown };
    return typeof parsed.model === "string" && parsed.model.trim()
      ? parsed.model.trim()
      : "unknown";
  } catch {
    return "unknown";
  }
}
