import {mkdir, open, stat, unlink} from "node:fs/promises";
import {dirname, join} from "node:path";
import {setTimeout as delay} from "node:timers/promises";
import type {
  AgentConnectionSettings,
  AgentId,
  AgentModelAliases,
  BillingChannel,
  ProxyConfig,
  ProxyTarget,
  ProxyTargetDevelopmentSettings,
  ProxyTargetModelPricingOverride,
  ProxyTargetModelVendor,
  ProxyTargetPricingPolicy,
  WireApi,
} from "./types";
import {agentScopeIncludes, isKnownAgentId, KNOWN_AGENT_IDS, type AgentLaunchPreferences} from "@/types";
import {
  buildLocalProxyBaseUrl,
  normalizeHttpBaseUrl,
  normalizeProxyRouteId,
  resolveDerivedRouteId,
  routeIdFromUpstreamUrl,
  type RouteIdOccupant,
} from "./lib/proxy-url";
import {resolveDeepaaDataDir} from "./lib/data-paths";
import {atomicWriteFile, readFileBounded} from "./proxy/atomic-file";
import {buildGatewayModelId, parseGatewayModelId} from "./proxy/gateway-prefix";
import {resolveTargetAgentCapability, availableWireApisForAgent} from "@/lib/provider-preset-capabilities";
import {ensureProxyTargetAgentDefaults, resolveTargetModelWireApis, validateTargetModelFallbacks} from "@/lib/proxy-management-domain";
import {agentBindings} from "@/lib/agent-registry";
import {normalizeLoopbackAliasBaseUrl} from "@/lib/local-endpoints";
import {
  inferTargetChannelMetadata,
  normalizeBillingChannel,
  normalizeVendorFamily,
} from "./lib/target-channel-metadata";

export {buildLocalProxyBaseUrl, routeIdFromUpstreamUrl};

const MAX_PROXY_CONFIG_BYTES = 1024 * 1024;
const CONFIG_LOCK_TIMEOUT_MS = 2_000;
const STALE_CONFIG_LOCK_MS = 30_000;
const KNOWN_WIRE_APIS = new Set<WireApi>(["responses", "chat_completions", "messages"]);

interface ProxyConfigStoreOptions {
  configPath?: string;
  localProxyBaseUrl?: string;
  /** 密钥元数据文件路径；只用于 Agent 原子命令的适用校验。 */
  developmentCredentialsPath?: string;
}

/** 单供应商保存的请求载荷：按已持久化 id 合并供应商，缺省 id 表示新增供应商。 */
export interface ProxyTargetPatchUpdate {
  id?: string;
  target: Partial<ProxyTarget>;
}

export interface TargetPricingOverrideUpdate {
  action: "upsert" | "remove";
  targetId: string;
  targetModelId: string;
  pricing?: ProxyTargetModelPricingOverride["pricing"];
  priceSchedules?: ProxyTargetModelPricingOverride["priceSchedules"];
  /** 覆盖价币种（2026-09-28）：保存时继承价格中心条目币种，避免 CNY 条目被回退成 USD。 */
  currency?: "CNY" | "USD";
}

/** 单供应商删除的请求载荷：允许删除最后一个供应商并回到空态。 */
export interface ProxyTargetDeleteUpdate {
  id: string;
}

export interface AgentConnectionPatchUpdate {
  agent: AgentId;
  action: "connect" | "disconnect" | "unbind";
  /** action=unbind 时要移除的供应商；默认供应商不能直接解除绑定。 */
  targetId?: string;
  /**
   * 本次显式接入的供应商范围。接入范围与默认供应商是两个概念：只传该字段时，
   * 仅让 Agent 可以看到并同步该供应商，不会隐式改变默认请求链。
   */
  boundTargetIds?: string[];
  defaultTargetId?: string;
  defaultModelId?: string;
  defaultCredentialId?: string;
  cliSyncEnabled?: boolean;
  modelAliases?: AgentModelAliases;
  /** 开发启动高级设置偏好；显式传入时整体替换（含清空），缺省保留既有值。 */
  launchPreferences?: AgentLaunchPreferences | null;
}

/**
 * 代理配置原子更新。API 写请求应提供 expectedRevision；内部同进程服务可以省略，
 * Store 仍会在文件锁内重新读取最新配置，避免基于内存快照覆盖其它进程的修改。
 */
export interface ProxyConfigUpdate {
  expectedRevision?: number;
  targets?: ProxyTarget[];
  agentConnections?: ProxyConfig["agentConnections"];
  localProxyBaseUrl?: string;
  targetPatch?: ProxyTargetPatchUpdate;
  targetPricingOverride?: TargetPricingOverrideUpdate;
  targetDelete?: ProxyTargetDeleteUpdate;
  agentConnectionPatch?: AgentConnectionPatchUpdate;
  /**
   * 官方目录 wireApis 自动跟随（终极方案 2026-09-10）：目标侧模型协议能力不是用户决策，
   * 由目录同步任务在价格中心 wireApis 变化后物化到引用目标——代理进程不读价格中心，
   * 必须经由本更新写入 proxy-config。键为 targetId，值为「模型 ID → 协议能力」补丁；
   * 只覆盖列出的模型，不影响白名单/归属/价格等用户决策字段。
   */
  wireApiFollowUp?: Record<string, Record<string, readonly WireApi[]>>;
}

export class ProxyConfigStore {
  private readonly configPath: string;
  private readonly developmentCredentialsPath: string;
  private config: ProxyConfig;
  private localProxyBaseUrl: string;
  private initialized = false;

  constructor(options: ProxyConfigStoreOptions = {}) {
    this.configPath = options.configPath || join(resolveDeepaaDataDir(), "proxy-config.json");
    this.developmentCredentialsPath = options.developmentCredentialsPath
      || join(resolveDeepaaDataDir(), "config", "development-credentials.json");
    this.localProxyBaseUrl = options.localProxyBaseUrl || `http://127.0.0.1:${process.env.PROXY_PORT || "3211"}`;
    this.config = createEmptyConfig(this.localProxyBaseUrl);
  }

  async init(): Promise<void> {
    try {
      this.config = await this.readPersistedConfig();
    } catch (error) {
      if (!isFileNotFound(error)) throw error;
      await this.withConfigLock(async () => {
        try {
          this.config = await this.readPersistedConfig();
        } catch (nestedError) {
          if (!isFileNotFound(nestedError)) throw nestedError;
          await this.persist(this.config);
        }
      });
    }
    this.initialized = true;
  }

  async reload(): Promise<void> {
    try {
      this.config = await this.readPersistedConfig();
    } catch (error) {
      if (!this.initialized && isFileNotFound(error)) {
        await this.init();
        return;
      }
      console.warn(
        `[ProxyConfigStore] proxy config reload failed; keeping last-known-good ${this.configPath}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  getConfig(): ProxyConfig {
    return structuredClone(this.config);
  }

  getConfigPath(): string {
    return this.configPath;
  }

  async updateConfig(update: ProxyConfigUpdate): Promise<ProxyConfig> {
    await this.withConfigLock(async () => {
      let persisted = this.config;
      try {
        persisted = await this.readPersistedConfig();
      } catch (error) {
        if (!isFileNotFound(error)) throw error;
      }
      if (update.expectedRevision !== undefined && update.expectedRevision !== persisted.revision) {
        throw new Error("CONFIG_REVISION_CONFLICT");
      }

      const merged = await mergeConfigUpdate(
        persisted,
        update,
        this.developmentCredentialsPath,
      );
      const candidate = validateProxyConfig(merged, persisted.localProxyBaseUrl || this.localProxyBaseUrl);
      // 保存端严格校验备份链（UI 校验只是体验优化，服务端才是安全边界）：
      // 悬空/自引用条目已在归一化与 prune 阶段清理；此处拒绝「共同可服务
      // (Agent, wireApi) 为空」「指向 passthrough 目标」「超上限」的链路。
      const fallbackErrors = candidate.targets
        .flatMap(target => validateTargetModelFallbacks(target, candidate.targets));
      if (fallbackErrors.length > 0) throw new Error(fallbackErrors[0]!);
      candidate.revision = persisted.revision + 1;
      candidate.updatedAt = new Date().toISOString();
      await this.persist(candidate);
      this.config = candidate;
    });
    return this.getConfig();
  }

  private async readPersistedConfig(): Promise<ProxyConfig> {
    const raw = await readFileBounded(this.configPath, MAX_PROXY_CONFIG_BYTES);
    const parsed = JSON.parse(raw.toString("utf8")) as unknown;
    const candidateBase = typeof parsed === "object" && parsed !== null && "localProxyBaseUrl" in parsed
      ? (parsed as {localProxyBaseUrl?: unknown}).localProxyBaseUrl
      : undefined;
    const effectiveBase = typeof candidateBase === "string" && candidateBase.trim()
      ? normalizeLoopbackAliasBaseUrl(normalizeHttpBaseUrl(candidateBase, "Proxy localProxyBaseUrl"))
      : this.localProxyBaseUrl;
    this.localProxyBaseUrl = effectiveBase;
    return validateProxyConfig(parsed, effectiveBase);
  }

  private async persist(config: ProxyConfig): Promise<void> {
    await atomicWriteFile(this.configPath, `${JSON.stringify(config, null, 2)}\n`);
  }

  private async withConfigLock<T>(operation: () => Promise<T>): Promise<T> {
    const lockPath = `${this.configPath}.lock`;
    await mkdir(dirname(lockPath), {recursive: true});
    const deadline = Date.now() + CONFIG_LOCK_TIMEOUT_MS;
    let lockHandle;
    while (!lockHandle) {
      try {
        lockHandle = await open(lockPath, "wx", 0o600);
      } catch (error) {
        if (!isAlreadyExists(error)) throw error;
        await removeStaleLock(lockPath);
        if (Date.now() >= deadline) throw new Error("Proxy config update lock timed out");
        await delay(20);
      }
    }
    try {
      return await operation();
    } finally {
      await lockHandle.close().catch(() => undefined);
      await unlink(lockPath).catch(() => undefined);
    }
  }
}

function createEmptyConfig(localProxyBaseUrl: string): ProxyConfig {
  return {
    version: 3,
    revision: 1,
    agentConnections: {},
    targets: [],
    localProxyBaseUrl: normalizeHttpBaseUrl(localProxyBaseUrl, "Proxy localProxyBaseUrl"),
    updatedAt: new Date().toISOString(),
  };
}

async function mergeConfigUpdate(
  current: ProxyConfig,
  update: ProxyConfigUpdate,
  credentialsPath: string,
): Promise<ProxyConfig> {
  let targets = update.targets ? [...update.targets] : [...current.targets];
  let agentConnections = update.agentConnections
    ? structuredClone(update.agentConnections)
    : structuredClone(current.agentConnections);

  if (update.targetDelete) {
    const target = targets.find(item => item.id === update.targetDelete?.id);
    if (!target) {
      throw new Error(`Proxy target not found: ${update.targetDelete.id}`);
    }
    if (target.enabled) throw new Error("TARGET_MUST_BE_DISABLED");
    if (Object.values(agentConnections).some(connection => connection?.defaultTargetId === target.id)) {
      throw new Error("TARGET_DEFAULT_REFERENCE_EXISTS");
    }
    targets = targets.filter(target => target.id !== update.targetDelete?.id);
    agentConnections = clearDeletedTargetReferences(agentConnections, update.targetDelete.id);
  }

  if (update.targetPatch) {
    const patch = update.targetPatch;
    if (patch.id) {
      const index = targets.findIndex(target => target.id === patch.id);
      if (index < 0) throw new Error(`Proxy target not found: ${patch.id}`);
      if (patch.target.id !== undefined && patch.target.id !== patch.id) {
        throw new Error("TARGET_ID_IMMUTABLE");
      }
      const mergedTarget = mergeTargetPatch(targets[index]!, patch.target);
      assertDevelopmentDefaultModelsCompatible(mergedTarget);
      targets[index] = ensureProxyTargetAgentDefaults(
        mergedTarget,
        await listCredentialMetadata(credentialsPath, mergedTarget.id),
      );
    } else {
      const candidate = patch.target as ProxyTarget;
      // 路由 ID 唯一性：网关按 ID 前缀路由，同 ID 供应商无法消歧，服务端直接拒绝。
      if (targets.some(target => target.id === candidate.id)) throw new Error("DUPLICATE_TARGET_ID");
      assertDevelopmentDefaultModelsCompatible(candidate);
      targets.push(ensureProxyTargetAgentDefaults(
        candidate,
        await listCredentialMetadata(credentialsPath, candidate.id),
      ));
    }
  }

  if (update.targetPricingOverride) {
    const operation = update.targetPricingOverride;
    const index = targets.findIndex(target => target.id === operation.targetId);
    if (index < 0) throw new Error("TARGET_NOT_FOUND");
    const target = targets[index]!;
    if (!target.supportedModels.includes(operation.targetModelId)) {
      throw new Error("MODEL_NOT_SUPPORTED");
    }
    const currentOverrides = target.pricing?.modelOverrides || [];
    const kept = currentOverrides.filter(item => item.targetModelId !== operation.targetModelId);
    const nextOverrides = operation.action === "remove"
      ? kept
      : [
          ...kept,
          {
            id: `override-${target.id}-${operation.targetModelId}`,
            targetModelId: operation.targetModelId,
            pricing: operation.pricing!,
            ...(operation.priceSchedules ? {priceSchedules: operation.priceSchedules} : {}),
            ...(operation.currency ? {currency: operation.currency} : {}),
            confidence: "user_override" as const,
          },
        ];
    targets[index] = ensureProxyTargetAgentDefaults({
      ...target,
      pricing: {
        ...target.pricing,
        ...(nextOverrides.length > 0 ? {modelOverrides: nextOverrides} : {modelOverrides: undefined}),
      },
    }, await listCredentialMetadata(credentialsPath, target.id));
  }

  if (update.agentConnectionPatch) {
    const result = await applyAgentConnectionPatch(
      agentConnections,
      targets,
      update.agentConnectionPatch,
      credentialsPath,
    );
    agentConnections = result.agentConnections;
    targets = result.targets;
  }

  return {
    version: 3,
    revision: current.revision,
    agentConnections,
    targets: applyWireApiFollowUp(targets, update.wireApiFollowUp),
    localProxyBaseUrl: update.localProxyBaseUrl || current.localProxyBaseUrl,
    updatedAt: current.updatedAt,
  };
}

/**
 * wireApis 自动跟随物化：对列出的目标按「模型 → 协议能力」覆盖 supportedModelWireApis。
 * 只覆盖补丁中出现的模型；目标或模型不在白名单时跳过（不新增、不删除）；
 * 与当前值一致时不产生变更（调用方据此避免无意义的 revision 递增）。
 */
function applyWireApiFollowUp(
  targets: ProxyTarget[],
  followUp: ProxyConfigUpdate["wireApiFollowUp"],
): ProxyTarget[] {
  if (!followUp) return targets;
  return targets.map(target => {
    const modelPatch = followUp[target.id];
    if (!modelPatch) return target;
    const nextWireApis = {...(target.supportedModelWireApis ?? {})};
    let changed = false;
    for (const modelId of target.supportedModels) {
      const wireApis = modelPatch[modelId];
      if (!wireApis) continue;
      const currentWireApis = nextWireApis[modelId];
      if (currentWireApis && wireApis.length === currentWireApis.length && wireApis.every(api => currentWireApis.includes(api))) {
        continue;
      }
      nextWireApis[modelId] = [...wireApis];
      changed = true;
    }
    return changed ? {...target, supportedModelWireApis: nextWireApis} : target;
  });
}

function mergeTargetPatch(current: ProxyTarget, patch: Partial<ProxyTarget>): ProxyTarget {
  const development = patch.development === undefined
    ? current.development
    : mergeDevelopmentSettings(current.development, patch.development);
  return {
    ...current,
    ...patch,
    ...(development ? {development} : {development: undefined}),
    pricing: patch.pricing === undefined ? current.pricing : {...current.pricing, ...patch.pricing},
    updatedAt: new Date().toISOString(),
  };
}

function mergeDevelopmentSettings(
  current: ProxyTargetDevelopmentSettings | undefined,
  patch: ProxyTargetDevelopmentSettings,
): ProxyTargetDevelopmentSettings | undefined {
  const merged: ProxyTargetDevelopmentSettings = {
    ...current,
    ...patch,
    // 默认模型/默认密钥映射在调用方总是以「完整最新状态」提交（移除/提升时键已删除或改写），
    // 因此采用整体替换而非展开合并——展开合并无法表达键删除，会让悬空引用（指向已删除
    // 模型/密钥）残留。未显式提供时保持原值不变。
    defaultModels: patch.defaultModels === undefined
      ? current?.defaultModels
      : patch.defaultModels,
    defaultCredentials: patch.defaultCredentials === undefined
      ? current?.defaultCredentials
      : patch.defaultCredentials,
  };
  return compactDevelopmentSettings(merged);
}

async function applyAgentConnectionPatch(
  currentConnections: ProxyConfig["agentConnections"],
  currentTargets: ProxyTarget[],
  patch: AgentConnectionPatchUpdate,
  credentialsPath: string,
): Promise<{agentConnections: ProxyConfig["agentConnections"]; targets: ProxyTarget[]}> {
  const agentConnections = structuredClone(currentConnections);
  const targets = structuredClone(currentTargets);
  if (patch.action === "disconnect") {
    delete agentConnections[patch.agent];
    return {agentConnections, targets};
  }
  if (patch.action === "unbind") {
    if (!patch.targetId || !targets.some(target => target.id === patch.targetId)) throw new Error("TARGET_NOT_FOUND");
    const previous = agentConnections[patch.agent];
    if (!previous) return {agentConnections, targets};
    if (previous.defaultTargetId === patch.targetId) throw new Error("TARGET_DEFAULT_REFERENCE_EXISTS");
    const boundTargetIds = (previous.boundTargetIds || []).filter(id => id !== patch.targetId);
    const aliases = normalizeModelAliases(previous.modelAliases, targets, boundTargetIds, patch.agent);
    agentConnections[patch.agent] = {
      ...previous,
      enabled: previous.enabled !== false,
      boundTargetIds: boundTargetIds.length > 0 ? boundTargetIds : undefined,
      ...(aliases ? {modelAliases: aliases} : {modelAliases: undefined}),
    };
    return {agentConnections, targets};
  }

  const previous = agentConnections[patch.agent];
  // 首次接入当前 Agent 且调用方只提交绑定供应商时，把第一个启用供应商设为默认；
  // 已有默认供应商或显式传入空字符串时绝不覆盖/回退。
  const implicitDefaultTargetId = !previous?.defaultTargetId && patch.defaultTargetId === undefined
    ? patch.boundTargetIds?.find(id => targets.some(item => item.id === id && item.enabled))
    : undefined;
  const defaultTargetId = patch.defaultTargetId ?? previous?.defaultTargetId ?? implicitDefaultTargetId;
  const target = defaultTargetId ? targets.find(item => item.id === defaultTargetId) : undefined;
  if (defaultTargetId && !target) throw new Error("DEFAULT_TARGET_NOT_FOUND");
  if (target) {
    if (!target.enabled) throw new Error("TARGET_DISABLED");
    const capability = resolveTargetAgentCapability(target, patch.agent);
    if (!capability.supported) throw new Error(capability.reason === "PRESET_WIRE_API_UNSUPPORTED"
      ? "PRESET_WIRE_API_UNSUPPORTED"
      : "PROTOCOL_URL_REQUIRED");
  }

  if (patch.defaultCredentialId !== undefined) {
    if (!target) throw new Error("DEFAULT_TARGET_REQUIRED");
    const credential = await findCredentialMetadata(credentialsPath, patch.defaultCredentialId);
    if (!credential || credential.targetId !== target.id) throw new Error("DEFAULT_CREDENTIAL_NOT_FOUND");
    if (!agentScopeIncludes(credential.agentScope, patch.agent)) {
      throw new Error("DEFAULT_CREDENTIAL_AGENT_SCOPE_MISMATCH");
    }
    setTargetAgentDefault(target, "defaultCredentials", patch.agent, patch.defaultCredentialId);
  }

  const boundTargetIds = normalizeBoundTargetIds(
    [
      ...(previous?.boundTargetIds || []),
      ...(patch.boundTargetIds || []),
      ...(defaultTargetId ? [defaultTargetId] : []),
    ],
    targets,
  );
  // 绑定门禁（2026-10-06 补全）：boundTargetIds 逐条能力校验——此前只查默认供应商，
  // 不支持协议的目标可经 boundTargetIds 混入绑定（如无 anthropicUrl 的目标绑 zcode）。
  for (const boundId of boundTargetIds) {
    const boundTarget = targets.find(item => item.id === boundId);
    if (!boundTarget) continue;
    const boundCapability = resolveTargetAgentCapability(boundTarget, patch.agent);
    if (!boundCapability.supported) throw new Error(boundCapability.reason === "PRESET_WIRE_API_UNSUPPORTED"
      ? "PRESET_WIRE_API_UNSUPPORTED"
      : "PROTOCOL_URL_REQUIRED");
  }

  if (patch.defaultModelId !== undefined) {
    if (!target) throw new Error("DEFAULT_TARGET_REQUIRED");
    if (!target.supportedModels.includes(patch.defaultModelId)) throw new Error("DEFAULT_MODEL_NOT_SUPPORTED");
    if (!agentScopeIncludes(target.supportedModelScopes?.[patch.defaultModelId], patch.agent)) {
      throw new Error("DEFAULT_MODEL_AGENT_SCOPE_MISMATCH");
    }
    const bindingWireApis = agentBindings(patch.agent)
      .filter(binding => binding.protocol === "openai"
        ? Boolean(target.openaiUrl?.trim())
        : Boolean(target.anthropicUrl?.trim()))
      .map(binding => binding.wireApi);
    const modelWireApis = resolveTargetModelWireApis(target, patch.defaultModelId);
    if (modelWireApis.length === 0
      || !modelWireApis.some(wireApi => bindingWireApis.includes(wireApi))) {
      throw new Error("DEFAULT_MODEL_WIRE_API_MISMATCH");
    }
    setTargetAgentDefault(target, "defaultModels", patch.agent, patch.defaultModelId);
  }
  agentConnections[patch.agent] = {
    enabled: true,
    ...(boundTargetIds.length > 0 ? {boundTargetIds} : {}),
    ...(defaultTargetId ? {defaultTargetId} : {}),
    cliSyncEnabled: patch.cliSyncEnabled ?? previous?.cliSyncEnabled ?? false,
    ...(normalizeModelAliases(patch.modelAliases ?? previous?.modelAliases, targets, boundTargetIds, patch.agent) ? {
      modelAliases: normalizeModelAliases(patch.modelAliases ?? previous?.modelAliases, targets, boundTargetIds, patch.agent),
    } : {}),
    // 显式字段必须回写保留，否则 connect 补丁（如开发启动默认链写入）会静默丢掉它们。
    ...(previous?.preferredWireApi ? {preferredWireApi: previous.preferredWireApi} : {}),
    ...(patch.launchPreferences !== undefined
      ? patch.launchPreferences
        ? {launchPreferences: normalizeLaunchPreferences(patch.launchPreferences) ?? undefined}
        : {}
      : previous?.launchPreferences
        ? {launchPreferences: previous.launchPreferences}
        : {}),
  };
  return {agentConnections, targets};
}

function setTargetAgentDefault(
  target: ProxyTarget,
  key: "defaultModels" | "defaultCredentials",
  agent: AgentId,
  value: string,
): void {
  const development = target.development || {};
  development[key] = {...development[key], [agent]: value};
  target.development = development;
}

/**
 * defaultModels 写入门禁（2026-10-06）：targetPatch 携带的 development.defaultModels
 * 此前不经任何校验直达落盘（只有读侧 normalize 静默剪除），现写入即拒——与
 * agentConnectionPatch.defaultModelId 同一套校验口径，堵住 setTargetDefaultModel、
 * 向导等 targetPatch 路径的绕行。
 */
function assertDevelopmentDefaultModelsCompatible(target: ProxyTarget): void {
  const defaults = target.development?.defaultModels;
  if (!defaults) return;
  for (const agent of KNOWN_AGENT_IDS) {
    const modelId = defaults[agent];
    if (modelId === undefined) continue;
    if (!target.supportedModels.includes(modelId)) throw new Error("DEFAULT_MODEL_NOT_SUPPORTED");
    if (!agentScopeIncludes(target.supportedModelScopes?.[modelId], agent)) {
      throw new Error("DEFAULT_MODEL_AGENT_SCOPE_MISMATCH");
    }
    const bindingWireApis = agentBindings(agent)
      .filter(binding => binding.protocol === "openai"
        ? Boolean(target.openaiUrl?.trim())
        : Boolean(target.anthropicUrl?.trim()))
      .map(binding => binding.wireApi);
    const modelWireApis = resolveTargetModelWireApis(target, modelId);
    if (modelWireApis.length === 0
      || !modelWireApis.some(wireApi => bindingWireApis.includes(wireApi))) {
      throw new Error("DEFAULT_MODEL_WIRE_API_MISMATCH");
    }
  }
}

/**
 * 读侧存量清理（2026-10-06）：模型显式声明 wire API 时，scope 中与该 Agent
 * binding 无交集的 Agent 属可证明死键（弹窗下拉/适配器写入/网关路由三处都会
 * 过滤），读取归一化时剔除；未声明 wire API 的模型不做推断清理——推断值不作为
 * 删除依据，避免误删「从价格中心添加、尚未落声明」的模型适用面。
 */
function pruneScopeAgentsByDeclaredWireApis(
  scopes: Record<string, AgentId[]> | undefined,
  wireApis: Record<string, readonly WireApi[]> | undefined,
  openaiUrl: string | undefined,
  anthropicUrl: string | undefined,
): Record<string, AgentId[]> | undefined {
  if (!scopes || !wireApis) return scopes;
  let changed = false;
  const next: Record<string, AgentId[]> = {};
  for (const [modelId, agents] of Object.entries(scopes)) {
    const declared = wireApis[modelId];
    if (!declared || declared.length === 0 || agents.length === 0) {
      next[modelId] = agents;
      continue;
    }
    const kept = agents.filter(agent => {
      const bindingWireApis = agentBindings(agent)
        .filter(binding => binding.protocol === "openai"
          ? Boolean(openaiUrl?.trim())
          : Boolean(anthropicUrl?.trim()))
        .map(binding => binding.wireApi);
      return bindingWireApis.length > 0 && declared.some(wireApi => bindingWireApis.includes(wireApi));
    });
    if (kept.length !== agents.length) changed = true;
    if (kept.length > 0) next[modelId] = kept;
  }
  if (!changed) return scopes;
  return Object.keys(next).length > 0 ? next : undefined;
}

function clearDeletedTargetReferences(
  connections: ProxyConfig["agentConnections"],
  deletedTargetId: string,
): ProxyConfig["agentConnections"] {
  const next = structuredClone(connections);
  for (const agent of KNOWN_AGENT_IDS) {
    const connection = next[agent];
    if (!connection) continue;
    if (connection.defaultTargetId === deletedTargetId) delete connection.defaultTargetId;
    const boundTargetIds = (connection.boundTargetIds || []).filter(id => id !== deletedTargetId);
    if (boundTargetIds.length > 0) connection.boundTargetIds = boundTargetIds;
    else delete connection.boundTargetIds;
  }
  return next;
}

interface CredentialMetadataRecord {
  id: string;
  targetId: string;
  agentScope?: string[];
}

async function listCredentialMetadata(
  path: string,
  targetId: string,
): Promise<CredentialMetadataRecord[]> {
  let parsed: unknown;
  try {
    parsed = JSON.parse((await readFileBounded(path, MAX_PROXY_CONFIG_BYTES)).toString("utf8"));
  } catch (error) {
    if (isFileNotFound(error)) return [];
    throw error;
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as {credentials?: unknown}).credentials)) return [];
  return (parsed as {credentials: unknown[]}).credentials.flatMap(value => {
    if (!value || typeof value !== "object") return [];
    const raw = value as Record<string, unknown>;
    if (typeof raw.id !== "string" || raw.targetId !== targetId) return [];
    return [{
      id: raw.id,
      targetId,
      agentScope: Array.isArray(raw.agentScope)
        ? raw.agentScope.filter((item): item is string => typeof item === "string")
        : undefined,
    }];
  });
}

async function findCredentialMetadata(
  path: string,
  credentialId: string,
): Promise<CredentialMetadataRecord | undefined> {
  let parsed: unknown;
  try {
    parsed = JSON.parse((await readFileBounded(path, MAX_PROXY_CONFIG_BYTES)).toString("utf8"));
  } catch (error) {
    if (isFileNotFound(error)) return undefined;
    throw error;
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as {credentials?: unknown}).credentials)) {
    return undefined;
  }
  for (const value of (parsed as {credentials: unknown[]}).credentials) {
    if (!value || typeof value !== "object") continue;
    const raw = value as Record<string, unknown>;
    if (raw.id !== credentialId || typeof raw.targetId !== "string") continue;
    return {
      id: credentialId,
      targetId: raw.targetId,
      agentScope: Array.isArray(raw.agentScope)
        ? raw.agentScope.filter((item): item is string => typeof item === "string")
        : undefined,
    };
  }
  return undefined;
}

export function findProxyTarget(config: ProxyConfig, targetId: string): ProxyTarget | undefined {
  return validateProxyConfig(config, config.localProxyBaseUrl).targets.find(target => target.id === targetId);
}

export function buildUpstreamRequestUrl(baseUrl: string, path: string, search = ""): string {
  const normalizedBase = normalizeUpstreamUrl(baseUrl);
  const base = new URL(normalizedBase);
  const normalizedPath = normalizeRequestPath(base.pathname, path);
  return `${normalizedBase}${normalizedPath}${search}`;
}

function normalizeRequestPath(basePath: string, requestPath: string): string {
  const normalizedPath = requestPath.startsWith("/") ? requestPath : `/${requestPath}`;
  const baseSegments = basePath.split("/").filter(Boolean);
  const requestSegments = normalizedPath.split("/").filter(Boolean);
  if (baseSegments.length > 0 && requestSegments[0] === baseSegments.at(-1)) {
    const deduped = requestSegments.slice(1);
    return deduped.length > 0 ? `/${deduped.join("/")}` : "";
  }
  return normalizedPath;
}

function validateProxyConfig(
  raw: unknown,
  fallbackLocalProxyBaseUrl = `http://127.0.0.1:${process.env.PROXY_PORT || "3211"}`,
): ProxyConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Proxy config must be an object");
  }
  const value = raw as Record<string, unknown>;
  if (value.version !== 3) throw new Error("PROXY_CONFIG_VERSION_UNSUPPORTED");
  if (!Array.isArray(value.targets)) throw new Error("Proxy config targets must be an array");

  const localProxyBaseUrl = normalizeLoopbackAliasBaseUrl(normalizeHttpBaseUrl(
    typeof value.localProxyBaseUrl === "string" ? value.localProxyBaseUrl : fallbackLocalProxyBaseUrl,
    "Proxy localProxyBaseUrl",
  ));
  // 路由 ID 兜底派生需要全局判重：显式声明的 ID（含后声明者）阻止自动派生撞名；
  // 同 URL 对判定只与前序已归一化供应商比较（原始项 URL 可能是垃圾数据）。
  const declaredIds = new Set<string>();
  for (const item of value.targets) {
    if (item && typeof item === "object" && !Array.isArray(item)
      && typeof (item as Record<string, unknown>).id === "string"
      && ((item as Record<string, unknown>).id as string).trim()) {
      declaredIds.add(((item as Record<string, unknown>).id as string).trim().toLowerCase());
    }
  }
  const declaredOccupants = [...declaredIds].map(id => ({id}));
  const targets: ProxyTarget[] = [];
  for (const item of value.targets) {
    const normalizedTarget = normalizeProxyTarget(item, [...declaredOccupants, ...targets]);
    targets.push(normalizedTarget);
  }
  const validTargets = pruneSupportedModelFallbacks(targets);
  validateTargetUniqueness(validTargets);
  const agentConnections = normalizeAgentConnections(value.agentConnections, validTargets);
  return {
    version: 3,
    revision: normalizeRevision(value.revision),
    agentConnections,
    targets: validTargets,
    localProxyBaseUrl,
    updatedAt: typeof value.updatedAt === "string" && value.updatedAt
      ? value.updatedAt
      : new Date().toISOString(),
  };
}

function normalizeProxyTarget(raw: unknown, priorTargets: readonly RouteIdOccupant[] = []): ProxyTarget {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Proxy target must be an object");
  }
  const value = raw as Record<string, unknown>;
  const openaiUrl = normalizeOptionalUpstreamUrl(value.openaiUrl, "Proxy openaiUrl");
  const anthropicUrl = normalizeOptionalUpstreamUrl(value.anthropicUrl, "Proxy anthropicUrl");
  if (!openaiUrl && !anthropicUrl) throw new Error("Proxy target requires at least one protocol URL");
  // 空 ID 兜底：按统一候选链解析全局唯一候选。同 URL 对或候选用尽时退回全格式：
  // 同 URL 对的全格式 ID 必然与既有供应商重复，交由唯一性校验以 DUPLICATE_TARGET_ID 拒绝。
  let derivedId = typeof value.id === "string" ? value.id.trim() : "";
  if (!derivedId) {
    const resolution = resolveDerivedRouteId(openaiUrl || undefined, anthropicUrl || undefined, priorTargets);
    derivedId = resolution.status === "resolved"
      ? resolution.id!
      : routeIdFromUpstreamUrl(openaiUrl || anthropicUrl!);
  }
  const id = normalizeTargetId(derivedId);
  const now = new Date().toISOString();
  const supportedModels = normalizeSupportedModels(value.supportedModels);
  const declaredScopes = normalizeSupportedModelScopes(value.supportedModelScopes, supportedModels);
  const supportedModelWireApis = normalizeSupportedModelWireApis(value.supportedModelWireApis, supportedModels);
  const supportedModelScopes = pruneScopeAgentsByDeclaredWireApis(declaredScopes, supportedModelWireApis, openaiUrl, anthropicUrl);
  const presetId = typeof value.presetId === "string" && /^[a-z0-9][a-z0-9.-]{0,127}$/u.test(value.presetId.trim())
    ? value.presetId.trim()
    : undefined;
  const pricing = normalizeTargetPricing(value.pricing);
  const explicitBillingChannel = normalizeBillingChannel(value.billingChannel);
  const explicitVendorFamily = normalizeVendorFamily(value.vendorFamily);
  const inferred = inferTargetChannelMetadata({
    presetId,
    pricing,
    openaiUrl,
    anthropicUrl,
  });
  return {
    id,
    name: typeof value.name === "string" && value.name.trim() ? value.name.trim().slice(0, 256) : id,
    ...(presetId ? {presetId} : {}),
    billingChannel: explicitBillingChannel ?? inferred.billingChannel,
    ...(normalizeCredentialMode(value.credentialMode) ? {credentialMode: normalizeCredentialMode(value.credentialMode)} : {}),
    ...((explicitVendorFamily ?? inferred.vendorFamily) ? {
      vendorFamily: explicitVendorFamily ?? inferred.vendorFamily,
    } : {}),
    ...(openaiUrl ? {openaiUrl} : {}),
    ...(anthropicUrl ? {anthropicUrl} : {}),
    enabled: value.enabled !== false,
    createdAt: typeof value.createdAt === "string" ? value.createdAt : now,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : now,
    supportedModels,
    ...(supportedModelScopes ? {supportedModelScopes} : {}),
    ...(supportedModelWireApis ? {supportedModelWireApis} : {}),
    ...(normalizeSupportedModelFallbacks(value.supportedModelFallbacks, supportedModels, id) ? {
      supportedModelFallbacks: normalizeSupportedModelFallbacks(value.supportedModelFallbacks, supportedModels, id),
    } : {}),
    ...(normalizeCliSyncExclusions(value.cliSyncExclusions) ? {
      cliSyncExclusions: normalizeCliSyncExclusions(value.cliSyncExclusions),
    } : {}),
    pricing,
    ...(normalizeTargetDevelopment(value.development, supportedModels, supportedModelScopes, supportedModelWireApis, openaiUrl, anthropicUrl) ? {
      development: normalizeTargetDevelopment(value.development, supportedModels, supportedModelScopes, supportedModelWireApis, openaiUrl, anthropicUrl),
    } : {}),
  };
}

/**
 * 归一化模型故障转移备份链：只保留 supportedModels 内的主模型键，
 * 条目去重、剔除主模型自身并截断到上限；条目指向的目标/模型有效性
 * 由 pruneSupportedModelFallbacks（全局视图）与网关运行时闸门兜底。
 */
function normalizeSupportedModelFallbacks(
  value: unknown,
  supportedModels: string[],
  targetId: string,
): Record<string, string[]> | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid supportedModelFallbacks");
  const result: Record<string, string[]> = {};
  for (const [modelId, entries] of Object.entries(value)) {
    if (!supportedModels.includes(modelId) || !Array.isArray(entries)) continue;
    const normalized = [...new Set(entries
      .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      .map(item => item.trim()))]
      .filter(item => {
        const parsed = parseGatewayModelId(item);
        return !(parsed && parsed.targetId === targetId && parsed.modelId === modelId);
      })
      .slice(0, MAX_MODEL_FALLBACK_ENTRIES);
    if (normalized.length > 0) result[modelId] = normalized;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/** 单个主模型允许配置的备份模型上限（与代理侧 MAX_MODEL_FALLBACKS 同值）。 */
const MAX_MODEL_FALLBACK_ENTRIES = 5;

/**
 * 全局视图修剪备份链：条目必须指向某个已知目标的白名单模型。
 * 目标删除或模型移出白名单后，引用它的备份条目在此处级联清理（读写两端同口径）。
 */
function pruneSupportedModelFallbacks(targets: ProxyTarget[]): ProxyTarget[] {
  const knownModels = new Set(targets.flatMap(target =>
    target.supportedModels.map(modelId => buildGatewayModelId(target.id, modelId)),
  ));
  return targets.map(target => {
    const fallbacks = target.supportedModelFallbacks;
    if (!fallbacks) return target;
    const pruned: Record<string, string[]> = {};
    let changed = false;
    for (const [modelId, entries] of Object.entries(fallbacks)) {
      const kept = entries.filter(entry => knownModels.has(entry));
      if (kept.length !== entries.length) changed = true;
      if (kept.length > 0) pruned[modelId] = kept;
    }
    if (Object.keys(pruned).length !== Object.keys(fallbacks).length) changed = true;
    if (!changed) return target;
    return Object.keys(pruned).length > 0 ? {...target, supportedModelFallbacks: pruned} : omitSupportedModelFallbacks(target);
  });
}

function omitSupportedModelFallbacks(target: ProxyTarget): ProxyTarget {
  const {supportedModelFallbacks: _removed, ...rest} = target;
  return rest;
}

function validateTargetUniqueness(targets: ProxyTarget[]): void {
  const ids = new Set<string>();
  // url -> 首次使用的 {供应商 ID, 计费通道}：同一 URL 可被不同计费通道共用
  //（如 MiniMax 按量/Token Plan、Anthropic 按量/订阅），同一通道重复才拒绝。
  const urls = new Map<string, {targetId: string; channel: BillingChannel}>();
  for (const target of targets) {
    if (ids.has(target.id)) throw new Error(`Duplicate proxy target id: ${target.id}`);
    ids.add(target.id);
    for (const url of [target.openaiUrl, target.anthropicUrl]) {
      if (!url) continue;
      const existing = urls.get(url);
      const channel = target.billingChannel ?? "pay_as_you_go";
      // 同一供应商内 OpenAI/Anthropic URL 相同合法（协议由请求路径区分）；跨供应商同一通道才拒绝。
      if (existing !== undefined && existing.targetId !== target.id && existing.channel === channel) {
        throw new Error(`Duplicate proxy target baseUrl: ${url}`);
      }
      if (existing === undefined) urls.set(url, {targetId: target.id, channel});
    }
  }
}

function normalizeAgentConnections(
  value: unknown,
  targets: ProxyTarget[],
): ProxyConfig["agentConnections"] {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid agentConnections");
  const result: ProxyConfig["agentConnections"] = {};
  for (const [key, connectionValue] of Object.entries(value)) {
    if (!isKnownAgentId(key) || !connectionValue || typeof connectionValue !== "object" || Array.isArray(connectionValue)) {
      continue;
    }
    const raw = connectionValue as Record<string, unknown>;
    const defaultTargetId = typeof raw.defaultTargetId === "string" && raw.defaultTargetId.trim()
      ? raw.defaultTargetId.trim()
      : undefined;
    let boundTargetIds = normalizeBoundTargetIds(raw.boundTargetIds, targets);
    if (defaultTargetId && targets.some(target => target.id === defaultTargetId) && !boundTargetIds.includes(defaultTargetId)) {
      boundTargetIds.push(defaultTargetId);
    }
    // 读侧存量清理（2026-10-06）：剔除 capability 不支持的绑定（URL/预设层面即可
    // 证明的死键，如无 anthropicUrl 的目标绑 zcode）；默认供应商随之失效时一并
    // 移除，诚实呈现「默认供应商缺失」待配置态。
    const capableBoundIds = boundTargetIds.filter(id =>
      targets.some(target => target.id === id && resolveTargetAgentCapability(target, key).supported));
    const capableDefaultId = defaultTargetId && capableBoundIds.includes(defaultTargetId)
      ? defaultTargetId
      : undefined;
    const connection: AgentConnectionSettings = {
      enabled: raw.enabled !== false,
      ...(capableBoundIds.length > 0 ? {boundTargetIds: capableBoundIds} : {}),
      ...(capableDefaultId ? {defaultTargetId: capableDefaultId} : {}),
      cliSyncEnabled: raw.cliSyncEnabled === true,
    };
    const aliases = normalizeModelAliases(raw.modelAliases, targets, capableBoundIds, key);
    if (aliases) connection.modelAliases = aliases;
    if (typeof raw.preferredWireApi === "string" && KNOWN_WIRE_APIS.has(raw.preferredWireApi as WireApi)) {
      connection.preferredWireApi = raw.preferredWireApi as WireApi;
    }
    const launchPreferences = normalizeLaunchPreferences(raw.launchPreferences);
    if (launchPreferences) connection.launchPreferences = launchPreferences;
    result[key] = connection;
  }
  return result;
}

/** 归一化 Agent 级启动偏好：只保留白名单字段与合法值，避免未知结构透传。 */
function normalizeLaunchPreferences(value: unknown): AgentLaunchPreferences | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const result: AgentLaunchPreferences = {};
  if (typeof raw.reasoningEffort === "string" && /^[a-z0-9_-]{1,32}$/u.test(raw.reasoningEffort)) {
    result.reasoningEffort = raw.reasoningEffort;
  }
  if (typeof raw.permissionMode === "string" && /^[a-z0-9_-]{1,32}$/u.test(raw.permissionMode)) {
    result.permissionMode = raw.permissionMode;
  }
  // 键为网关模型 ID（<模型ID>_<目标路由ID>，含 `/` 与 `_`）；限安全 ASCII 标识符。
  const windows = normalizeTokenLimitRecord(raw.contextWindows);
  if (windows) result.contextWindows = windows;
  const autoCompactLimits = normalizeTokenLimitRecord(raw.autoCompactTokenLimits);
  if (autoCompactLimits) result.autoCompactTokenLimits = autoCompactLimits;
  return Object.keys(result).length > 0 ? result : undefined;
}

function normalizeTokenLimitRecord(value: unknown): Record<string, number> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const limits: Record<string, number> = {};
  for (const [modelId, tokens] of Object.entries(value as Record<string, unknown>)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u.test(modelId)) continue;
    // 键必须是网关复合键（<模型ID>_<路由ID>，2026-10-02 统一规范）：裸模型 ID 是
    // 规范前的旧格式死键，任何适配器都按复合键查找、永不命中，读取时即丢弃。
    if (!parseGatewayModelId(modelId)) continue;
    if (typeof tokens !== "number" || !Number.isSafeInteger(tokens) || tokens <= 0) continue;
    limits[modelId] = tokens;
  }
  return Object.keys(limits).length > 0 ? limits : undefined;
}

function normalizeBoundTargetIds(value: unknown, targets: readonly ProxyTarget[]): string[] {
  if (!Array.isArray(value)) return [];
  const targetIds = new Set(targets.map(target => target.id));
  return [...new Set(value
    .filter((item): item is string => typeof item === "string" && targetIds.has(item.trim()))
    .map(item => item.trim()))];
}

function normalizeModelAliases(
  value: unknown,
  targets: ProxyTarget[],
  boundTargetIds: readonly string[],
  agent: AgentId,
): AgentModelAliases | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const result: AgentModelAliases = {};
  for (const key of ["opus", "sonnet", "haiku"] as const) {
    const candidate = raw[key];
    if (typeof candidate !== "string" || !candidate.trim()) continue;
    const normalized = candidate.trim();
    if (!isKnownGatewayModelId(normalized, targets, boundTargetIds, agent)) continue;
    result[key] = normalized;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function isKnownGatewayModelId(
  value: string,
  targets: ProxyTarget[],
  boundTargetIds: readonly string[],
  agent: AgentId,
): boolean {
  const bound = new Set(boundTargetIds);
  return targets.some(target => target.enabled
    && bound.has(target.id)
    && target.supportedModels.some(model =>
      agentScopeIncludes(target.supportedModelScopes?.[model], agent)
      && buildGatewayModelId(target.id, model) === value
      && targetModelWireApiCompatible(target, model, agent)));
}

/** 模型 wire API 与该 Agent 可用 binding 有交集才可被引用，与网关路由判定一致。 */
function targetModelWireApiCompatible(
  target: ProxyTarget,
  modelId: string,
  agent: AgentId,
): boolean {
  const bindingWireApis = availableWireApisForAgent(target, agent);
  if (bindingWireApis.length === 0) return false;
  const modelWireApis = resolveTargetModelWireApis(target, modelId);
  return modelWireApis.length > 0 && modelWireApis.some(wireApi => bindingWireApis.includes(wireApi));
}

function normalizeSupportedModelScopes(
  value: unknown,
  supportedModels: string[],
): Record<string, AgentId[]> | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid supportedModelScopes");
  const result: Record<string, AgentId[]> = {};
  for (const [modelId, scope] of Object.entries(value)) {
    if (!supportedModels.includes(modelId) || !Array.isArray(scope)) continue;
    const agents = [...new Set(scope.filter((item): item is AgentId => typeof item === "string" && isKnownAgentId(item)))];
    if (agents.length > 0) result[modelId] = agents;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * 归一化模型 wire API 能力：只保留 supportedModels 内的键与已知 wire API；
 * 缺省或空数组表示不允许任何协议路径（默认拒绝），由网关侧路由校验兜底。
 */
function normalizeSupportedModelWireApis(
  value: unknown,
  supportedModels: string[],
): Record<string, readonly WireApi[]> | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid supportedModelWireApis");
  const result: Record<string, readonly WireApi[]> = {};
  for (const [modelId, wireApis] of Object.entries(value)) {
    if (!supportedModels.includes(modelId) || !Array.isArray(wireApis)) continue;
    const known = [...new Set(wireApis
      .filter((item): item is WireApi => typeof item === "string" && KNOWN_WIRE_APIS.has(item as WireApi)))];
    result[modelId] = known;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function normalizeAgentDefaultRefs(
  value: unknown,
  maxIdLength: number,
): Partial<Record<AgentId, string>> | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Agent default references");
  const result: Partial<Record<AgentId, string>> = {};
  for (const [agent, id] of Object.entries(value)) {
    if (!isKnownAgentId(agent)) continue;
    if (typeof id !== "string" || !id.trim() || id.trim().length > maxIdLength) continue;
    const normalized = id.trim();
    if (maxIdLength === 128 && !/^[A-Za-z0-9._-]{1,128}$/.test(normalized)) {
      throw new Error("Invalid development credential id");
    }
    result[agent] = normalized;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function normalizeCliSyncExclusions(value: unknown): AgentId[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const agents = [...new Set(value.filter((item): item is AgentId => typeof item === "string" && isKnownAgentId(item)))];
  return agents.length > 0 ? agents : undefined;
}

function normalizeSupportedModels(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const models = [...new Set(value
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map(item => item.trim().slice(0, 256)))];
  if (models.length > 500) throw new Error("Proxy target supportedModels exceeds limit");
  return models;
}

function normalizeTargetDevelopment(
  value: unknown,
  supportedModels: string[],
  supportedModelScopes: Record<string, AgentId[]> | undefined,
  supportedModelWireApis: Record<string, readonly WireApi[]> | undefined,
  openaiUrl: string | undefined,
  anthropicUrl: string | undefined,
): ProxyTargetDevelopmentSettings | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid development settings");
  const raw = value as Record<string, unknown>;
  const defaultCredentials = normalizeAgentDefaultRefs(raw.defaultCredentials, 128);
  const rawDefaultModels = normalizeAgentDefaultRefs(raw.defaultModels, 256);
  const defaultModels: Partial<Record<AgentId, string>> = {};
  for (const agent of KNOWN_AGENT_IDS) {
    const model = rawDefaultModels?.[agent];
    const bindingWireApis = agentBindings(agent)
      .filter(binding => binding.protocol === "openai"
        ? Boolean(openaiUrl?.trim())
        : Boolean(anthropicUrl?.trim()))
      .map(binding => binding.wireApi);
    // 与设置端（applyAgentConnectionPatch）和网关路由同一解析：
    // 声明 -> 预设 -> URL/家族推断。只认显式声明会让"从价格中心添加、
    // 未落声明"的自定义目标模型在每次 normalize 时被静默剔除默认模型。
    const modelWireApis = model !== undefined
      ? resolveTargetModelWireApis({openaiUrl, anthropicUrl, supportedModelWireApis}, model)
      : [];
    const wireApiUsable = model !== undefined
      && modelWireApis.length > 0
      && modelWireApis.some(wireApi => bindingWireApis.includes(wireApi));
    if (model && supportedModels.includes(model)
      && agentScopeIncludes(supportedModelScopes?.[model], agent)
      && wireApiUsable) {
      defaultModels[agent] = model;
    }
  }
  const preferredTerminal = normalizeOptionalDevelopmentId(raw.preferredTerminal, "Invalid preferred terminal");
  const lastProjectDir = typeof raw.lastProjectDir === "string" && raw.lastProjectDir.trim()
    ? raw.lastProjectDir.trim().slice(0, 4096)
    : undefined;
  return compactDevelopmentSettings({
    ...(defaultCredentials ? {defaultCredentials} : {}),
    ...(Object.keys(defaultModels).length > 0 ? {defaultModels} : {}),
    ...(preferredTerminal ? {preferredTerminal} : {}),
    ...(lastProjectDir ? {lastProjectDir} : {}),
  });
}

function compactDevelopmentSettings(
  value: ProxyTargetDevelopmentSettings,
): ProxyTargetDevelopmentSettings | undefined {
  const defaultModels = value.defaultModels && Object.keys(value.defaultModels).length > 0
    ? value.defaultModels
    : undefined;
  const defaultCredentials = value.defaultCredentials && Object.keys(value.defaultCredentials).length > 0
    ? value.defaultCredentials
    : undefined;
  if (!defaultModels && !defaultCredentials && !value.preferredTerminal && !value.lastProjectDir) return undefined;
  return {
    ...(defaultModels ? {defaultModels} : {}),
    ...(defaultCredentials ? {defaultCredentials} : {}),
    ...(value.preferredTerminal ? {preferredTerminal: value.preferredTerminal} : {}),
    ...(value.lastProjectDir ? {lastProjectDir: value.lastProjectDir} : {}),
  };
}

function normalizeOptionalDevelopmentId(value: unknown, message: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(value)) throw new Error(message);
  return value;
}

function normalizeTargetPricing(value: unknown): ProxyTargetPricingPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const raw = value as ProxyTargetPricingPolicy;
  const vendor = typeof raw.vendor === "string" && raw.vendor.trim() ? raw.vendor.trim() : undefined;
  const planMonthlyFee = typeof raw.planMonthlyFee === "number"
    && Number.isFinite(raw.planMonthlyFee)
    && raw.planMonthlyFee >= 0
    ? raw.planMonthlyFee
    : undefined;
  // 档位 id 保留（2026-09-30 OpenCode Go）：上游不返回档位标识，用户显式选择；
  // 与月费同属套餐估算链路字段，归一化不得剥除。
  const planTier = typeof raw.planTier === "string"
    && /^[a-z0-9][a-z0-9-]{0,63}$/u.test(raw.planTier)
    ? raw.planTier
    : undefined;
  // 付款周期保留（2026-10-10 智谱 Coding Plan）：目录 billingCycles 键值域，
  // 与档位一起决定自动回填取哪档折算月价；归一化不得剥除。
  const planBillingCycle = raw.planBillingCycle === "monthly"
    || raw.planBillingCycle === "quarterly"
    || raw.planBillingCycle === "yearly"
    ? raw.planBillingCycle
    : undefined;
  // 结算字段保留（2026-09-15 断链修复）：官方预设带出的结算币种与用户显式配置的
  // 结算系数此前被归一化剥除（目标字段恒为空），派生期覆盖与月费币种判定全部失效。
  const settlementCurrency = raw.settlementCurrency === "CNY" || raw.settlementCurrency === "USD"
    ? raw.settlementCurrency
    : undefined;
  const settlementFx = typeof raw.settlementFx === "number"
    && Number.isFinite(raw.settlementFx)
    && raw.settlementFx > 0
    ? raw.settlementFx
    : undefined;
  const modelVendors = normalizeModelVendors(raw.modelVendors);
  const modelOverrides = Array.isArray(raw.modelOverrides)
    ? raw.modelOverrides.map(normalizeModelOverride)
      .filter((item): item is ProxyTargetModelPricingOverride => item !== undefined)
      // 中转站价格同步链路已移除：读取/保存时剔除历史 relay_synced 条目，让存量自然清零。
      .filter(item => item.confidence !== "relay_synced")
    : undefined;
  return {
    ...(vendor ? {vendor} : {}),
    ...(planMonthlyFee === undefined ? {} : {planMonthlyFee}),
    ...(planTier ? {planTier} : {}),
    ...(planBillingCycle ? {planBillingCycle} : {}),
    ...(typeof raw.currency === "string" ? {currency: raw.currency} : {}),
    ...(settlementCurrency ? {settlementCurrency} : {}),
    ...(settlementFx === undefined ? {} : {settlementFx}),
    ...(modelOverrides ? {modelOverrides} : {}),
    ...(modelVendors ? {modelVendors} : {}),
  };
}

function normalizeModelOverride(value: unknown): ProxyTargetModelPricingOverride | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const item = value as Partial<ProxyTargetModelPricingOverride>;
  if (typeof item.id !== "string" || !item.pricing || !isPricingRates(item.pricing)) return undefined;
  const targetModelId = typeof item.targetModelId === "string" && item.targetModelId.trim()
    ? item.targetModelId.trim()
    : undefined;
  if (!targetModelId) return undefined;
  const priceSchedules = normalizeOverridePriceSchedules(item.priceSchedules);
  return {
    id: item.id,
    targetModelId,
    pricing: item.pricing,
    ...(priceSchedules ? {priceSchedules} : {}),
    confidence: item.confidence || "user_override",
    ...(typeof item.currency === "string" ? {currency: item.currency} : {}),
    ...(typeof item.sourceUrl === "string" ? {sourceUrl: item.sourceUrl} : {}),
    ...(typeof item.sourceCheckedAt === "string" ? {sourceCheckedAt: item.sourceCheckedAt} : {}),
    ...(typeof item.notes === "string" ? {notes: item.notes} : {}),
  };
}

/** 代理供应商计费覆盖的时段费率浅校验：只保留窗口结构完整且费率可用的条目。 */
function normalizeOverridePriceSchedules(
  value: unknown,
): NonNullable<ProxyTargetModelPricingOverride["priceSchedules"]> | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const schedules = value.filter((item): item is NonNullable<ProxyTargetModelPricingOverride["priceSchedules"]>[number] => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const raw = item as Record<string, unknown>;
    return typeof raw.label === "string"
      && Array.isArray(raw.windows)
      && !!raw.rates
      && typeof (raw.rates as Record<string, unknown>).input === "number"
      && typeof (raw.rates as Record<string, unknown>).output === "number";
  });
  return schedules.length > 0 ? schedules : undefined;
}

function normalizeModelVendors(value: unknown): Record<string, ProxyTargetModelVendor> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const result: Record<string, ProxyTargetModelVendor> = {};
  for (const [modelId, mapping] of Object.entries(value as Record<string, unknown>)) {
    if (!modelId.trim() || modelId.length > 256 || !mapping || typeof mapping !== "object" || Array.isArray(mapping)) continue;
    const raw = mapping as Partial<ProxyTargetModelVendor>;
    const vendor = typeof raw.vendor === "string" && raw.vendor.trim() ? raw.vendor.trim() : undefined;
    const priceEntryId = typeof raw.priceEntryId === "string" && raw.priceEntryId.trim() ? raw.priceEntryId.trim() : undefined;
    if (!vendor && !priceEntryId) continue;
    if (!vendor || !priceEntryId) throw new Error("MODEL_PRICE_MAPPING_INCOMPLETE");
    result[modelId] = {vendor, priceEntryId};
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function isPricingRates(value: unknown): value is ProxyTargetModelPricingOverride["pricing"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  return typeof raw.input === "number" && Number.isFinite(raw.input)
    && typeof raw.output === "number" && Number.isFinite(raw.output)
    && optionalFiniteNumber(raw.cachedInput)
    && optionalFiniteNumber(raw.cacheWrite)
    && optionalFiniteNumber(raw.reasoning)
    && isValidLongContextTier(raw.longContext);
  // 旧 serviceTierMultipliers 乘数制已于 2026-09-08 废弃（fast 档改走价格中心
  // serviceTierPricing 价格集）；存量配置中的残留键随读取忽略，不再校验。
}

/** 长上下文阶梯浅校验：倍率数值为有限正数，可选 rates 绝对价为非负有限数，缺省整段视为未配置。 */
function isValidLongContextTier(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value !== "object" || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  if (!(typeof raw.thresholdTokens === "number" && Number.isFinite(raw.thresholdTokens) && raw.thresholdTokens > 0
    && typeof raw.inputMultiplier === "number" && Number.isFinite(raw.inputMultiplier) && raw.inputMultiplier > 0
    && typeof raw.outputMultiplier === "number" && Number.isFinite(raw.outputMultiplier) && raw.outputMultiplier > 0)) {
    return false;
  }
  if (raw.rates === undefined || raw.rates === null) return true;
  if (typeof raw.rates !== "object" || Array.isArray(raw.rates)) return false;
  const rates = raw.rates as Record<string, unknown>;
  return ["input", "output", "cachedInput", "cacheWrite"].every(key =>
    rates[key] === undefined || (typeof rates[key] === "number" && Number.isFinite(rates[key] as number) && (rates[key] as number) >= 0));
}

function optionalFiniteNumber(value: unknown): boolean {
  return value === undefined || (typeof value === "number" && Number.isFinite(value));
}

function normalizeTargetId(value: unknown): string {
  return normalizeProxyRouteId(value);
}

/** 网关凭据模式：仅接受显式 "passthrough"；其余非法值丢弃（不静默当作 inject 落盘）。 */
function normalizeCredentialMode(value: unknown): "passthrough" | undefined {
  return value === "passthrough" ? "passthrough" : undefined;
}

function normalizeUpstreamUrl(value: unknown): string {
  return normalizeHttpBaseUrl(value, "Proxy URL");
}

function normalizeOptionalUpstreamUrl(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return normalizeHttpBaseUrl(value, label);
}

function isFileNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && (error as {code?: unknown}).code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && (error as {code?: unknown}).code === "EEXIST";
}

function normalizeRevision(value: unknown): number {
  return Number.isSafeInteger(value) && (value as number) >= 1 ? value as number : 1;
}

async function removeStaleLock(lockPath: string): Promise<void> {
  try {
    const info = await stat(lockPath);
    if (Date.now() - info.mtimeMs > STALE_CONFIG_LOCK_MS) await unlink(lockPath);
  } catch (error) {
    if (!isFileNotFound(error)) throw error;
  }
}
