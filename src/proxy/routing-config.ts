import {randomUUID} from "node:crypto";
import {watch, type FSWatcher} from "node:fs";
import {stat} from "node:fs/promises";
import {basename, dirname, join} from "node:path";
import {atomicWriteFile, readFileBounded} from "./atomic-file.js";
import {parseGatewayModelId} from "./gateway-prefix.js";
import type {WireApi} from "@/types";
import {inferCustomTargetModelWireApis} from "@/lib/wire-api-infer";
import {MAX_MODEL_FALLBACKS} from "./model-failover.js";

const DEFAULT_MAX_CONFIG_BYTES = 1024 * 1024;
const DEFAULT_DEBOUNCE_MS = 75;
const DEFAULT_POLL_INTERVAL_MS = 1_000;

export interface RoutingTarget {
  readonly id: string;
  readonly name: string;
  /** OpenAI 协议上游 URL。 */
  readonly openaiUrl?: string;
  /** Anthropic 协议上游 URL。 */
  readonly anthropicUrl?: string;
  /** 计费通道：subscription 表示订阅透传供应商，网关放行客户端 OAuth。 */
  readonly billingChannel: RoutingBillingChannel;
  /**
   * 网关凭据模式：passthrough 表示透传客户端 Authorization（登录态目标），
   * 缺省 = inject 按系统凭据库注入；与 billingChannel=subscription 共用同一条
   * passthrough 门禁通道（binding 必须声明 supportsSubscription）。
   */
  readonly gatewayCredentialMode?: "passthrough";
  readonly enabled: true;
  /** 网关允许使用的 Agent 可见模型；空数组表示该供应商暂未同步网关配置。 */
  readonly supportedModels: readonly string[];
  /** 模型 → 适用 Agent 列表；未记录的模型默认全部 Agent 可用。 */
  readonly modelAgentScopes: ReadonlyMap<string, readonly string[]>;
  /** 模型 → 允许的 wire API；未记录表示该模型不允许任何协议路径。 */
  readonly modelWireApis: ReadonlyMap<string, readonly WireApi[]>;
  /**
   * 模型 → 有序备份模型链（完整网关模型串 `<真实模型ID>_<目标路由ID>`，可跨目标，
   * 数组顺序即优先级）。存在非空链即对该模型启用故障转移，无独立开关。
   * 条目有效性（目标存在、白名单、scope、wire API）由转发层按最新快照实时校验。
   */
  readonly modelFallbacks: ReadonlyMap<string, readonly string[]>;
  /** Agent → 默认凭据 ID；V3 不再存在供应商级默认密钥回退。 */
  readonly credentialsByAgent: ReadonlyMap<string, string>;
}

export type RoutingBillingChannel = "pay_as_you_go" | "plan" | "subscription";

const KNOWN_WIRE_APIS = new Set<WireApi>(["responses", "chat_completions", "messages"]);

/** 判断模型是否允许指定 Agent 使用（未记录或空 scope = 不允许任何 Agent）。 */
export function isModelAllowedForAgent(
  target: RoutingTarget,
  modelId: string,
  agent: string,
): boolean {
  const scope = target.modelAgentScopes.get(modelId);
  return scope !== undefined && scope.includes(agent);
}

/** 判断模型是否允许指定 wire API（未记录 = 不允许）。 */
export function isModelWireApiAllowedForAgent(
  target: RoutingTarget,
  modelId: string,
  wireApi: WireApi,
): boolean {
  const apis = target.modelWireApis.get(modelId);
  return apis !== undefined && apis.includes(wireApi);
}

/** 解析指定 Agent 的默认凭据。 */
export function resolveCredentialForAgent(
  target: RoutingTarget,
  agent: string,
): string | undefined {
  return target.credentialsByAgent.get(agent);
}

export interface RoutingSnapshot {
  readonly revision: number;
  readonly targetsById: ReadonlyMap<string, RoutingTarget>;
}

export interface RoutingAppliedStatus {
  appliedRevision: number;
  proxyInstanceId: string;
  appliedAt: string;
}

interface RoutingConfigControllerOptions {
  configPath: string;
  statusPath?: string;
  localProxyBaseUrl?: string;
  debounceMs?: number;
  pollIntervalMs?: number;
  maxConfigBytes?: number;
  watchEnabled?: boolean;
  onLoadAttempt?: () => void | Promise<void>;
  onSnapshot?: (next: RoutingSnapshot, previous?: RoutingSnapshot) => void;
  onError?: (error: unknown) => void;
}

/** 代理控制面：请求路径只读取 current()，绝不执行磁盘 IO。 */
export class RoutingConfigController {
  readonly proxyInstanceId = randomUUID();
  private readonly configPath: string;
  private readonly statusPath: string;
  private readonly localProxyBaseUrl: string;
  private readonly debounceMs: number;
  private readonly pollIntervalMs: number;
  private readonly maxConfigBytes: number;
  private readonly watchEnabled: boolean;
  private readonly onLoadAttempt?: () => void | Promise<void>;
  private readonly onSnapshot?: (next: RoutingSnapshot, previous?: RoutingSnapshot) => void;
  private readonly onError: (error: unknown) => void;
  private snapshot?: RoutingSnapshot;
  private watcher?: FSWatcher;
  private debounceTimer?: NodeJS.Timeout;
  private pollTimer?: NodeJS.Timeout;
  private reloadPromise?: Promise<boolean>;
  private reloadQueued = false;
  private observedSignature?: string;
  private started = false;
  private closed = false;
  private lastErrorAt = 0;

  constructor(options: RoutingConfigControllerOptions) {
    this.configPath = options.configPath;
    this.statusPath = options.statusPath ?? join(dirname(options.configPath), "proxy-routing-status.json");
    this.localProxyBaseUrl = options.localProxyBaseUrl ?? "http://127.0.0.1:3211";
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.maxConfigBytes = options.maxConfigBytes ?? DEFAULT_MAX_CONFIG_BYTES;
    this.watchEnabled = options.watchEnabled !== false;
    this.onLoadAttempt = options.onLoadAttempt;
    this.onSnapshot = options.onSnapshot;
    this.onError = options.onError ?? (error => this.reportError(error));
  }

  async init(): Promise<void> {
    if (this.snapshot) return;
    try {
      await this.loadAndApply(true);
    } catch (error) {
      if (!isFileNotFound(error)) throw error;
      await atomicWriteFile(this.configPath, `${JSON.stringify(createInitialConfig(this.localProxyBaseUrl), null, 2)}\n`);
      await this.loadAndApply(true);
    }
    this.observedSignature = await fileSignature(this.configPath);
  }

  current(): RoutingSnapshot {
    if (!this.snapshot) throw new Error("Routing config is not initialized");
    return this.snapshot;
  }

  start(): void {
    if (this.started || this.closed) return;
    if (!this.snapshot) throw new Error("Routing config must be initialized before start");
    this.started = true;
    if (this.watchEnabled) {
      this.watcher = watch(dirname(this.configPath), (eventType, fileName) => {
        const changedName = fileName?.toString();
        if (changedName && changedName !== basename(this.configPath)) return;
        this.scheduleReload();
      });
      this.watcher.on("error", error => this.onError(error));
      this.watcher.unref();
    }
    this.pollTimer = setInterval(() => void this.pollExactPath(), this.pollIntervalMs);
    this.pollTimer.unref();
  }

  reload(): Promise<boolean> {
    if (this.closed) return Promise.resolve(false);
    this.reloadQueued = true;
    if (this.reloadPromise) return this.reloadPromise;
    this.reloadPromise = this.drainReloads().finally(() => {
      this.reloadPromise = undefined;
    });
    return this.reloadPromise;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.watcher?.close();
    await this.reloadPromise?.catch(() => undefined);
  }

  private scheduleReload(): void {
    if (this.closed) return;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      void this.reload();
    }, this.debounceMs);
    this.debounceTimer.unref();
  }

  private async pollExactPath(): Promise<void> {
    if (this.closed) return;
    try {
      const signature = await fileSignature(this.configPath);
      if (signature === this.observedSignature) return;
      this.observedSignature = signature;
      this.scheduleReload();
    } catch (error) {
      this.onError(error);
    }
  }

  private async drainReloads(): Promise<boolean> {
    let applied = false;
    while (this.reloadQueued && !this.closed) {
      this.reloadQueued = false;
      try {
        applied = await this.loadAndApply(false) || applied;
      } catch (error) {
        this.onError(error);
      }
    }
    return applied;
  }

  private async loadAndApply(initial: boolean): Promise<boolean> {
    await this.onLoadAttempt?.();
    const raw = await readFileBounded(this.configPath, this.maxConfigBytes);
    const next = parseRoutingSnapshot(JSON.parse(raw.toString("utf8")), this.localProxyBaseUrl);
    const previous = this.snapshot;
    if (previous) {
      if (next.revision < previous.revision) {
        throw new Error(`Routing revision regressed from ${previous.revision} to ${next.revision}`);
      }
      if (next.revision === previous.revision) return false;
    } else if (!initial) {
      throw new Error("Routing config has no initial snapshot");
    }
    this.snapshot = next;
    this.onSnapshot?.(next, previous);
    await atomicWriteFile(this.statusPath, `${JSON.stringify({
      appliedRevision: next.revision,
      proxyInstanceId: this.proxyInstanceId,
      appliedAt: new Date().toISOString(),
    } satisfies RoutingAppliedStatus)}\n`);
    this.observedSignature = await fileSignature(this.configPath);
    return true;
  }

  private reportError(error: unknown): void {
    const now = Date.now();
    if (now - this.lastErrorAt < 10_000) return;
    this.lastErrorAt = now;
    console.warn(`[ProxyRouting] ${error instanceof Error ? error.message : String(error)}`);
  }
}

class ReadonlyMapView<K, V> implements ReadonlyMap<K, V> {
  readonly #source: Map<K, V>;

  constructor(entries: Iterable<readonly [K, V]>) {
    this.#source = new Map(entries);
    Object.freeze(this);
  }

  get size(): number { return this.#source.size; }
  get(key: K): V | undefined { return this.#source.get(key); }
  has(key: K): boolean { return this.#source.has(key); }
  entries(): MapIterator<[K, V]> { return this.#source.entries(); }
  keys(): MapIterator<K> { return this.#source.keys(); }
  values(): MapIterator<V> { return this.#source.values(); }
  forEach(callbackfn: (value: V, key: K, map: ReadonlyMap<K, V>) => void, thisArg?: unknown): void {
    this.#source.forEach((value, key) => callbackfn.call(thisArg, value, key, this));
  }
  [Symbol.iterator](): MapIterator<[K, V]> { return this.#source[Symbol.iterator](); }
}

function parseRoutingSnapshot(raw: unknown, localProxyBaseUrl: string): RoutingSnapshot {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Routing config must be an object");
  }
  const value = raw as Record<string, unknown>;
  if (value.version !== 3) throw new Error("PROXY_CONFIG_VERSION_UNSUPPORTED");
  const revision = normalizeRevision(value.revision);
  if (!Array.isArray(value.targets)) throw new Error("Routing config targets must be an array");
  const targets = value.targets.map(item => parseTarget(item, localProxyBaseUrl));
  const enabledTargets = targets.filter((target): target is RoutingTarget => target !== undefined);
  const byId = new Map<string, RoutingTarget>();
  for (const target of enabledTargets) {
    if (byId.has(target.id)) throw new Error(`Duplicate routing target id: ${target.id}`);
    byId.set(target.id, target);
  }
  return Object.freeze({
    revision,
    targetsById: new ReadonlyMapView(byId),
  });
}

function parseTarget(raw: unknown, localProxyBaseUrl: string): RoutingTarget | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Routing target must be an object");
  const value = raw as Record<string, unknown>;
  if (value.enabled === false) return undefined;
  if (typeof value.id !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(value.id)) {
    throw new Error("Routing target id is invalid");
  }
  const openaiUrl = normalizeRoutingUrl(value.openaiUrl, "Routing openaiUrl");
  const anthropicUrl = normalizeRoutingUrl(value.anthropicUrl, "Routing anthropicUrl");
  if (!openaiUrl && !anthropicUrl) {
    throw new Error("Routing target requires at least one protocol URL");
  }
  if (typeof value.id === "string" && value.id.includes("_")) {
    throw new Error("Routing target id must not contain underscore");
  }
  const supportedModels = Array.isArray(value.supportedModels)
    ? value.supportedModels
      .filter((model): model is string => typeof model === "string" && model.trim().length > 0)
      .map(model => model.trim())
    : [];
  if (supportedModels.length > 500) {
    throw new Error("Routing target supportedModels exceeds limit");
  }
  const modelAgentScopes = new Map<string, readonly string[]>();
  if (isRecord(value.supportedModelScopes)) {
    for (const [modelId, scope] of Object.entries(value.supportedModelScopes)) {
      if (!Array.isArray(scope)) continue;
      const agents = scope
        .filter((item): item is string => typeof item === "string" && item.trim().length > 0 && item.length <= 32)
        .map(item => item.trim());
      if (agents.length > 0) modelAgentScopes.set(modelId, Object.freeze(agents));
    }
  }
  const modelWireApis = new Map<string, readonly WireApi[]>();
  const declaredModelIds = new Set<string>();
  if (isRecord(value.supportedModelWireApis)) {
    for (const [modelId, wireApis] of Object.entries(value.supportedModelWireApis)) {
      if (!Array.isArray(wireApis)) continue;
      const known = wireApis
        .filter((item): item is WireApi => typeof item === "string" && KNOWN_WIRE_APIS.has(item as WireApi))
        .filter((item, index, array) => array.indexOf(item) === index);
      // 显式声明的空数组也视为「已声明但拒绝」，不能回退到 URL 推断。
      declaredModelIds.add(modelId);
      if (known.length > 0) modelWireApis.set(modelId, Object.freeze(known));
    }
  }
  // 自定义供应商（无目录声明）按 URL + 模型家族推断：gpt-*/o 系列 → responses，
  // 其余 OpenAI 模型 → chat_completions，anthropicUrl → messages；声明过的模型不再推断。
  for (const modelId of supportedModels) {
    if (declaredModelIds.has(modelId)) continue;
    const inferred = inferCustomTargetModelWireApis(modelId, {openaiUrl, anthropicUrl});
    if (inferred.length > 0) modelWireApis.set(modelId, Object.freeze(inferred));
  }
  // 模型故障转移备份链：完整网关模型串（可跨目标），顺序即优先级。
  // 这里只做形状与上限规整；条目指向的目标/模型是否有效由转发层实时校验，
  // 悬空条目静默过滤，绝不因此拒绝整个配置。自引用（主模型自身的网关串）剔除。
  const modelFallbacks = new Map<string, readonly string[]>();
  if (isRecord(value.supportedModelFallbacks)) {
    for (const [modelId, list] of Object.entries(value.supportedModelFallbacks)) {
      if (!Array.isArray(list)) continue;
      const entries = list
        .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
        .map(item => item.trim())
        .filter((item, index, array) => array.indexOf(item) === index)
        .filter(item => {
          const parsed = parseGatewayModelId(item);
          return !(parsed && parsed.targetId === value.id && parsed.modelId === modelId);
        })
        .slice(0, MAX_MODEL_FALLBACKS);
      if (entries.length > 0) modelFallbacks.set(modelId, Object.freeze(entries));
    }
  }
  const development = isRecord(value.development) ? value.development : undefined;
  const billingChannel = parseBillingChannel(value.billingChannel);
  // 显式声明以外的任何值都拒绝加载，防止拼写错误静默降级为 inject。
  // 磁盘键为 credentialMode（与 Web 侧 V3 目标 schema 同名，同一文件）。
  const gatewayCredentialMode = value.credentialMode === undefined
    ? undefined
    : parseGatewayCredentialMode(value.credentialMode);
  const credentialsByAgent = new Map<string, string>();
  if (development && isRecord(development.defaultCredentials)) {
    for (const [agent, id] of Object.entries(development.defaultCredentials)) {
      if (typeof id === "string" && id.trim()) credentialsByAgent.set(agent, id.trim());
    }
  }
  void localProxyBaseUrl;
  return Object.freeze({
    id: value.id,
    name: typeof value.name === "string" && value.name.trim() ? value.name.trim() : value.id,
    billingChannel,
    ...(openaiUrl ? {openaiUrl} : {}),
    ...(anthropicUrl ? {anthropicUrl} : {}),
    ...(gatewayCredentialMode ? {gatewayCredentialMode} : {}),
    enabled: true,
    supportedModels: Object.freeze(supportedModels),
    modelAgentScopes: new ReadonlyMapView(modelAgentScopes),
    modelWireApis: new ReadonlyMapView(modelWireApis),
    modelFallbacks: new ReadonlyMapView(modelFallbacks),
    credentialsByAgent: new ReadonlyMapView(credentialsByAgent),
  });
}

function parseBillingChannel(value: unknown): RoutingBillingChannel {
  return value === "subscription" || value === "plan" ? value : "pay_as_you_go";
}

/** 网关凭据模式：仅接受显式 "passthrough"；其余值抛错避免静默降级。 */
function parseGatewayCredentialMode(value: unknown): "passthrough" {
  if (value === "passthrough") return value;
  throw new Error('Routing target gatewayCredentialMode must be "passthrough" when present');
}

function normalizeRoutingUrl(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !value.trim()) return undefined;
  const url = new URL(value.trim());
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${label} must use http or https`);
  }
  return url.toString().replace(/\/+$/u, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function createInitialConfig(localProxyBaseUrl: string): Record<string, unknown> {
  return {
    version: 3,
    revision: 1,
    agentConnections: {},
    targets: [],
    localProxyBaseUrl,
    updatedAt: new Date().toISOString(),
  };
}

function normalizeRevision(value: unknown): number {
  if (value === undefined) return 1;
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error("Routing revision must be a positive safe integer");
  }
  return value as number;
}

async function fileSignature(filePath: string): Promise<string> {
  const info = await stat(filePath, {bigint: true});
  return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}`;
}

function isFileNotFound(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as {code?: unknown}).code === "ENOENT";
}
