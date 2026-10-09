import { homedir, tmpdir } from "os";
import { join } from "path";
import { opendir, realpath, rm, stat } from "fs/promises";
import {
  agentScopeIncludes,
  normalizeAgentScope,
  type AgentId,
  type AgentLaunchPreferences,
  type ProxyConfig,
  type ProxyTarget,
  type WireApi,
} from "@/types";
import { findProxyTarget, ProxyConfigStore } from "@/proxy-config";
import type { ProxyConfigUpdate } from "@/proxy-config";
import { buildGatewayModelId } from "@/proxy/gateway-prefix";
import { resolveDeepaaDataDir } from "@/lib/data-paths";
import {isRoutingRevisionApplied} from "@/lib/proxy-routing-status";
import {
  findPricingCatalogModel,
  normalizePricingConfig,
  readPricingConfig,
  type ModelPriceEntry,
  type PricingConfig,
} from "@/lib/pricing";
import type {DevelopmentCli} from "./types";
import {agentLaunchStrategy} from "./strategies";
import type {StrategyExecutable} from "./strategies/types";
import {
  isPortListening as defaultPortProbe,
  launchCodexClientApp,
  launchDshDesktopApp,
  launchZcodeDesktopApp,
  sameLaunchPreferences,
} from "./strategies/shared";
import {
  CredentialMetadataRepository,
  createCredentialMetadata,
  credentialSecretIds,
  normalizeRateMultiplier,
} from "./credential-metadata";
import { SystemCredentialStore } from "./credential-store";
import {
  normalizeDevelopmentManualOverrides,
  prepareDevelopmentLaunch,
  type DevelopmentManualOverrides,
} from "./launch-plan";
import {
  createDevelopmentPlatformAdapter,
  type DevelopmentPlatformAdapter,
} from "./platform";
import { launchCommandInTerminal } from "./terminal-launcher";
import { backupFile, syncCliConfigs, type ConfigSyncReport } from "@/lib/config-sync/sync-manager";
import { resolveDefaultReasoningLevel } from "@/lib/config-sync/model-capabilities";
import { resolveGatewayBaseUrl, normalizeLoopbackAliasBaseUrl } from "@/lib/local-endpoints";
import {
  defaultOverridesPath,
  defaultTemplatePath,
  readCatalogOverrides,
  readCatalogTemplate,
  type CatalogOverrides,
  type CatalogTemplate,
} from "@/lib/config-sync/catalog-template";
import {resolveModelRuntimeCaps} from "@/lib/config-sync/model-capabilities";
import { GATEWAY_PLACEHOLDER_TOKEN } from "@/lib/config-sync/core/placeholder-auth";
import {requireUsableCredential} from "@/lib/oauth/codex-status";
import {agentLabel as registryAgentLabel} from "@/lib/agent-registry";
import type {
  DevelopmentCredentialMetadata,
  DevelopmentModelSelectionContext,
  LaunchConfigurationResolution,
  PlatformCapabilities,
} from "./types";
import {resolveTargetAgentCapability} from "@/lib/provider-preset-capabilities";
import {ensureProxyTargetAgentDefaults} from "@/lib/proxy-management-domain";
import {modelWireApisForTarget} from "@/lib/config-sync/adapters/common";
import {resolveAutoCompactTokenLimit} from "./model-capabilities";

const MAX_SECRET_LENGTH = 16 * 1024;
const MAX_CLEANUP_ENTRIES = 500;

interface ProxyConfigProvider {
  reload(): Promise<void>;
  getConfig(): ProxyConfig;
  updateConfig?(update: ProxyConfigUpdate): Promise<ProxyConfig>;
}

interface CredentialStoreLike {
  put(credentialId: string, label: string, secret: string): Promise<void>;
  get(credentialId: string): Promise<string>;
  delete(credentialId: string): Promise<void>;
  isAvailable(): Promise<boolean>;
}

interface DevelopmentLaunchServiceOptions {
  platform?: DevelopmentPlatformAdapter;
  configProvider?: ProxyConfigProvider;
  credentials?: CredentialMetadataRepository;
  credentialStore?: CredentialStoreLike;
  homeDir?: string;
  tempRoot?: string;
  nodeExecutable?: string;
  credentialHelperPath?: string;
  developmentLaunchHelperPath?: string;
  pricingConfigReader?: () => Promise<PricingConfig>;
  routingApplicationChecker?: (config: ProxyConfig) => Promise<boolean>;
  /** 启动成功后同步 CLI 网关配置；缺省使用真实 home 路径。测试可注入 spy。 */
  cliConfigSyncer?: (config: ProxyConfig, options?: {agents?: readonly AgentId[]}) => Promise<ConfigSyncReport | void>;
  /** 打开 Codex 桌面客户端（可选携带工作区路径，codex app [PATH]）；测试可注入 spy。 */
  codexClientLauncher?: (executablePath: string, workspacePath?: string) => void;
  /** 拉起 ZCode 桌面 App（可选携带工作区目录深链）；测试可注入 spy，避免真实 spawn。 */
  zcodeAppLauncher?: (appPath: string, workspacePath?: string) => void;
  /** dsh 桌面客户端（DeepSeek Harness）拉起/聚焦；测试可注入。 */
  dshDesktopAppLauncher?: (appPath: string) => void;
  /** dsh Web 端口探测（缺省 net 探测 127.0.0.1:3080）；测试注入固定 false 避免命中真实端口。 */
  dshPortProbe?: (port: number) => Promise<boolean>;
}

export interface DevelopmentPreflightResult {
  target: Pick<ProxyTarget, "id" | "name" | "enabled"> & {gatewayBaseUrl: string};
  cli: DevelopmentCli;
  projectDir?: string;
  configuration: LaunchConfigurationResolution;
  credentials: DevelopmentCredentialMetadata[];
  executable: { available: boolean; path?: string };
  terminals: Awaited<ReturnType<DevelopmentPlatformAdapter["listTerminals"]>>;
  preferredTerminal?: string;
  warnings: Array<{ code: string; message: string; sourcePath?: string }>;
  modelSelection: DevelopmentModelSelectionContext;
  /** 该供应商上次成功启动时使用的项目目录（仅 CLI 模式记录），供弹窗预填。 */
  lastProjectDir?: string;
  /**
   * 按模型 ID 的目录默认值（高级设置预填）：推理档位、默认档位、上下文窗口与自动压缩阈值。
   * 来源于 catalog 模板合并结果（官方模型有精确值；模板外模型缺省，UI 显示为空）。
   */
  modelDefaults: Record<string, DevelopmentModelCatalogDefaults>;
  /**
   * 该 Agent 已落库的启动偏好（agentConnections[agent].launchPreferences）；
   * 弹窗预填存量值优先（用户上次设置可见、完整状态提交不再静默回退），无则为 null。
   */
  launchPreferences: AgentLaunchPreferences | null;
}

/** 单模型目录默认值（高级设置预填用）。 */
export interface DevelopmentModelCatalogDefaults {
  reasoningLevels: string[];
  defaultReasoningLevel?: string;
  contextWindow?: number;
  autoCompactTokenLimit?: number;
}

export interface DevelopmentStartInput {
  cli: DevelopmentCli;
  targetId: string;
  /** Codex 客户端模式与 dsh Web 形态不需要项目目录；zcode 为选填工作区目录。 */
  projectDir?: string;
  /** 订阅通道（billingChannel=subscription）不需要系统凭据，客户端 OAuth 由官方 CLI 透传。 */
  credentialId?: string;
  terminal?: string;
  /** 网关模型 ID；官方直连形态启动（策略声明 supportsOfficialFormLaunch 且官方模式）可缺省。 */
  selectedModel?: string;
  resumeSessionId?: string;
  manualOverrides: DevelopmentManualOverrides;
  /**
   * 配置文件类 Agent（zcode/dsh/opencode）的高级设置偏好：启动前落库到
   * agentConnections[agent].launchPreferences，并随启动前同步写入受管配置。
   */
  launchPreferences?: AgentLaunchPreferences;
  /** OpenCode / dsh 启动形态；缺省 TUI（dsh 固定 web，zcode 固定 app，忽略该值）。 */
  launchMode?: "tui" | "headless" | "web" | "app";
  /** headless 一次性任务内容（dsh 已移除该形态）。 */
  task?: string;
}

export class DevelopmentLaunchService {
  // capabilities 是平台级只读探测（CLI 路径/终端/凭据库），短时间内稳定；
  // 内存缓存避免每次打开「在 XX 中开发」弹窗都重复 spawn 多个探测进程。
  private static readonly CAPABILITIES_TTL_MS = 8_000;
  // preflight 是只读探测（读配置/检测 CLI/读价格目录），结果短时间稳定；
  // 内存缓存避免「打开弹窗 → 目录预填 → 切换终端」等场景重复计算同一键的结果。
  private static readonly PREFLIGHT_TTL_MS = 3_000;
  private readonly platform: DevelopmentPlatformAdapter;
  private readonly configProvider: ProxyConfigProvider;
  private readonly credentials: CredentialMetadataRepository;
  private readonly credentialStore: CredentialStoreLike;
  private readonly homeDir: string;
  private readonly tempRoot: string;
  private readonly nodeExecutable: string;
  private readonly credentialHelperPath: string;
  private readonly pricingConfigReader: () => Promise<PricingConfig>;
  private readonly routingApplicationChecker: (config: ProxyConfig) => Promise<boolean>;
  private readonly cliConfigSyncer: (config: ProxyConfig, options?: {agents?: readonly AgentId[]}) => Promise<ConfigSyncReport | void>;
  private readonly codexClientLauncher: (executablePath: string, workspacePath?: string) => void;
  private readonly zcodeAppLauncher: (appPath: string, workspacePath?: string) => void;
  private readonly dshDesktopAppLauncher: (appPath: string) => void;
  private readonly dshPortProbe: (port: number) => Promise<boolean>;
  private directoryPickerBusy = false;
  private launchBusy = false;
  private cleanupStarted = false;
  // 缓存与进行中任务只共享只读结果；nonce 仍由路由为每个请求独立签发。
  private capabilitiesCache: { timestamp: number; value: PlatformCapabilities } | null = null;
  /** 同一进程内并发能力请求共享一次平台探测；失败后由调用方下一次重新尝试。 */
  private capabilitiesInFlight: Promise<PlatformCapabilities> | null = null;
  private preflightCache = new Map<string, { timestamp: number; value: DevelopmentPreflightResult }>();
  /** 预检按现有缓存键合并并发只读计算，避免预热与弹窗同时重复读盘/解析。 */
  private preflightInFlight = new Map<string, Promise<DevelopmentPreflightResult>>();

  constructor(options: DevelopmentLaunchServiceOptions = {}) {
    const dataDir = resolveDeepaaDataDir();
    this.tempRoot = options.tempRoot || join(tmpdir(), "deepaa-launch");
    this.nodeExecutable = options.nodeExecutable || process.execPath;
    this.platform = options.platform || createDevelopmentPlatformAdapter(process.platform, {
      tempRoot: this.tempRoot,
      nodeExecutable: this.nodeExecutable,
      developmentLaunchHelperPath: options.developmentLaunchHelperPath
        || join(process.cwd(), "bin", "development-launch.mjs"),
    });
    this.configProvider = options.configProvider || new ProxyConfigStore();
    this.credentials = options.credentials || new CredentialMetadataRepository(
      join(dataDir, "config", "development-credentials.json"),
    );
    this.credentialStore = options.credentialStore || new SystemCredentialStore();
    this.homeDir = options.homeDir || homedir();
    this.credentialHelperPath = options.credentialHelperPath || join(process.cwd(), "bin", "credential-helper.mjs");
    this.cliConfigSyncer = options.cliConfigSyncer || defaultCliConfigSyncer(this.homeDir, this.credentialHelperPath);
    this.codexClientLauncher = options.codexClientLauncher || launchCodexClientApp;
    this.zcodeAppLauncher = options.zcodeAppLauncher || launchZcodeDesktopApp;
    this.dshDesktopAppLauncher = options.dshDesktopAppLauncher || launchDshDesktopApp;
    this.dshPortProbe = options.dshPortProbe || defaultPortProbe;
    this.pricingConfigReader = options.pricingConfigReader || (() => readPricingConfig(dataDir));
    this.routingApplicationChecker = options.routingApplicationChecker
      || (config => isRoutingRevisionApplied(dataDir, config.revision, config.localProxyBaseUrl));
  }

  async capabilities(): Promise<PlatformCapabilities> {
    this.startCleanupOnce();
    const cached = this.capabilitiesCache;
    if (cached && Date.now() - cached.timestamp < DevelopmentLaunchService.CAPABILITIES_TTL_MS) {
      return cached.value;
    }
    if (this.capabilitiesInFlight) return await this.capabilitiesInFlight;
    const request = this.platform.detectCapabilities().then(value => {
      this.capabilitiesCache = { timestamp: Date.now(), value };
      return value;
    });
    this.capabilitiesInFlight = request;
    try {
      return await request;
    } finally {
      if (this.capabilitiesInFlight === request) this.capabilitiesInFlight = null;
    }
  }

  async selectDirectory() {
    if (this.directoryPickerBusy) throw new Error("DIRECTORY_PICKER_BUSY");
    this.directoryPickerBusy = true;
    try {
      return await this.platform.selectDirectory();
    } finally {
      this.directoryPickerBusy = false;
    }
  }

  async preflight(input: {
    cli: DevelopmentCli;
    targetId: string;
    projectDir?: string;
    profile?: string;
  }): Promise<DevelopmentPreflightResult> {
    const cacheKey = `${input.cli}|${input.targetId}|${input.projectDir || ""}|${input.profile || ""}`;
    const cached = this.preflightCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < DevelopmentLaunchService.PREFLIGHT_TTL_MS) {
      return cached.value;
    }
    const inFlight = this.preflightInFlight.get(cacheKey);
    if (inFlight) return await inFlight;
    const request = this.preflightUncached(input, cacheKey);
    this.preflightInFlight.set(cacheKey, request);
    try {
      return await request;
    } finally {
      if (this.preflightInFlight.get(cacheKey) === request) {
        this.preflightInFlight.delete(cacheKey);
      }
    }
  }

  /** 保留原有预检顺序与校验；仅成功结果入短缓存，失败由外层释放进行中任务。 */
  private async preflightUncached(
    input: {
      cli: DevelopmentCli;
      targetId: string;
      projectDir?: string;
      profile?: string;
    },
    cacheKey: string,
  ): Promise<DevelopmentPreflightResult> {
    const target = await this.resolveTarget(input.targetId, input.cli);
    const projectDir = input.projectDir
      ? await validateProjectDirectory(input.projectDir)
      : undefined;
    const cli = input.cli;
    assertTargetProtocol(target, cli);
    const strategy = agentLaunchStrategy(cli);
    const [configuration, credentials, executablePath, terminals, pricingConfig] = await Promise.all([
      strategy.resolveConfiguration({homeDir: this.homeDir, projectDir, profile: input.profile}),
      this.credentials.list(target.id),
      this.platform.resolveExecutable(cli),
      this.platform.listTerminals(),
      this.pricingConfigReader(),
    ]);
    const modelDefaults = await resolveModelCatalogDefaults(target, pricingConfig);
    const vendor = target.pricing?.vendor?.trim() || undefined;
    const configuredModel = configuration.model.value
      ? {
        value: configuration.model.value,
        source: configuration.model.source,
        available: Boolean(
          vendor && findPricingCatalogModel(pricingConfig, vendor, configuration.model.value),
        ),
      }
      : undefined;
    const preferredTerminal = chooseTerminal(
      target.development?.preferredTerminal,
      terminals,
    );
    const warnings: Array<{ code: string; message: string; sourcePath?: string }> = configuration.warnings.map(warning => ({
      code: warning.code,
      message: warning.message,
      sourcePath: warning.sourcePath,
    }));
    if (configuration.projectTrust === "untrusted" || configuration.projectTrust === "unknown") {
      warnings.push({ code: "PROJECT_UNTRUSTED", message: "Codex 项目配置尚未被信任，将使用全局配置或手动设置" });
    }
    const result: DevelopmentPreflightResult = {
      target: {
        id: target.id,
        name: target.name,
        enabled: target.enabled,
        gatewayBaseUrl: resolveGatewayBaseUrl(this.configProvider.getConfig().localProxyBaseUrl),
      },
      cli,
      projectDir,
      configuration,
      credentials,
      executable: { available: Boolean(executablePath), path: executablePath || undefined },
      terminals,
      preferredTerminal,
      warnings,
      modelSelection: { vendor, configuredModel },
      lastProjectDir: target.development?.lastProjectDir,
      modelDefaults,
      launchPreferences: this.configProvider.getConfig().agentConnections[cli]?.launchPreferences ?? null,
    };
    this.preflightCache.set(cacheKey, { timestamp: Date.now(), value: result });
    // 防膨胀：键数超限时整体清空，下次按需重建；条目本身是 3s 短 TTL 的只读快照。
    if (this.preflightCache.size > 32) this.preflightCache.clear();
    return result;
  }

  async listCredentials(targetId: string): Promise<DevelopmentCredentialMetadata[]> {
    await this.resolveCredentialTarget(targetId);
    return await this.credentials.list(targetId);
  }

  async createCredential(input: {
    targetId: string;
    label: string;
    secret: string;
    rateMultiplier?: number;
    agentScope?: string[];
  }): Promise<DevelopmentCredentialMetadata> {
    const target = await this.resolveCredentialTarget(input.targetId);
    validateSecret(input.secret);
    if (!await this.credentialStore.isAvailable()) throw new Error("CREDENTIAL_STORE_UNAVAILABLE");
    const metadata = createCredentialMetadata({
      targetId: target.id,
      label: input.label,
      platform: this.platform.platform,
      secret: input.secret,
      rateMultiplier: input.rateMultiplier,
      agentScope: input.agentScope,
    });
    await this.credentialStore.put(metadata.id, `${target.name} · ${metadata.label}`, input.secret);
    let canDeleteSecretOnFailure = true;
    try {
      await this.credentials.upsert(metadata);
      try {
        await this.reconcileTargetDefaults(target.id);
      } catch (error) {
        // 默认链写入失败时必须回滚刚落库的元数据；若元数据回滚本身失败，
        // 保留系统凭据，避免留下“元数据存在但真实密钥已删除”的不可用悬空引用。
        try {
          await this.credentials.remove(metadata.id);
        } catch {
          canDeleteSecretOnFailure = false;
        }
        throw error;
      }
      return metadata;
    } catch (error) {
      if (canDeleteSecretOnFailure) {
        await this.credentialStore.delete(metadata.id).catch(() => undefined);
      }
      throw error;
    }
  }

  /** 首个密钥创建后立即补齐当前供应商各协议 Agent 的默认密钥/默认模型。 */
  private async reconcileTargetDefaults(targetId: string): Promise<void> {
    if (!this.configProvider.updateConfig) return;
    await this.configProvider.reload();
    const config = this.configProvider.getConfig();
    const target = findProxyTarget(config, targetId);
    if (!target) return;
    const credentials = await this.credentials.list(targetId);
    const completed = ensureProxyTargetAgentDefaults(target, credentials);
    if (JSON.stringify(completed.development || null) === JSON.stringify(target.development || null)) return;
    await this.configProvider.updateConfig({
      expectedRevision: config.revision,
      targetPatch: {id: targetId, target: {development: completed.development}},
    });
  }

  /**
   * 删除代理供应商时的级联清理：清空该供应商全部系统凭据（Keychain + 元数据）。
   * 与普通单条删除不同，这里不做「至少保留一个密钥」限制——供应商是删除场景。
   */
  async purgeTargetCredentials(targetId: string): Promise<{
    removed: number;
    failed?: Array<{credentialId: string; code: string}>;
  }> {
    // 供应商配置会先通过原子门禁删除；级联清理必须允许按已删除 targetId 清理孤立元数据。
    if (!targetId.trim()) throw new Error("TARGET_REQUIRED");
    const items = await this.credentials.list(targetId);
    let removed = 0;
    const failed: Array<{credentialId: string; code: string}> = [];
    for (const item of items) {
      try {
        for (const secretId of credentialSecretIds(item)) {
          await this.credentialStore.delete(secretId);
        }
      } catch (error) {
        // 系统凭据删除失败时保留元数据，便于后续重试或人工定位，不能假报已清理。
        failed.push({credentialId: item.id, code: stableCleanupErrorCode(error, "CREDENTIAL_DELETE_FAILED")});
        continue;
      }
      try {
        await this.credentials.remove(item.id);
      } catch (error) {
        failed.push({credentialId: item.id, code: stableCleanupErrorCode(error, "CREDENTIAL_METADATA_DELETE_FAILED")});
        continue;
      }
      removed += 1;
    }
    return failed.length > 0 ? {removed, failed} : {removed};
  }

  /** 更新密钥名称/价格倍率；secret 提供时覆盖系统凭据库中的密钥内容。 */
  async updateCredential(input: {
    targetId: string;
    credentialId: string;
    label?: string;
    rateMultiplier?: number;
    /** undefined 表示不修改；null/空数组表示显式清空为不允许任何 Agent。 */
    agentScope?: string[] | null;
    secret?: string;
  }): Promise<DevelopmentCredentialMetadata> {
    await this.resolveCredentialTarget(input.targetId);
    const current = await this.credentials.find(input.credentialId);
    if (!current || current.targetId !== input.targetId) throw new Error("CREDENTIAL_NOT_FOUND");
    const label = input.label === undefined || input.label.trim() === ""
      ? current.label
      : input.label.trim();
    if (!label || label.length > 80 || /[\u0000-\u001f\u007f]/.test(label)) {
      throw new Error("CREDENTIAL_LABEL_REQUIRED");
    }
    const rateMultiplier = normalizeRateMultiplier(input.rateMultiplier) ?? current.rateMultiplier;
    // 凭据适用与创建/读取一致：显式记录勾选的 Agent，无「全部」值域。
    const agentScope = input.agentScope === undefined
      ? current.agentScope
      : normalizeAgentScope(input.agentScope);
    if (input.secret) {
      validateSecret(input.secret);
      if (!await this.credentialStore.isAvailable()) throw new Error("CREDENTIAL_STORE_UNAVAILABLE");
      await this.credentialStore.put(
        current.id,
        `${this.configProvider.getConfig().targets?.find(t => t.id === input.targetId)?.name ?? input.targetId} · ${label}`,
        input.secret,
      );
    }
    const updated: DevelopmentCredentialMetadata = {
      ...current,
      label,
      rateMultiplier,
      // 显式写入 undefined 会覆盖展开对象中的旧值；持久化 JSON 时该字段自然省略。
      agentScope,
      updatedAt: new Date().toISOString(),
    };
    await this.credentials.upsert(updated);
    // 适用变更后维护默认密钥引用：失去 Agent 适用的默认密钥被提升/清理，避免悬空。
    await this.reconcileCredentialDefaults(input.targetId, updated.id);
    return updated;
  }

  async deleteCredential(input: { targetId: string; credentialId: string }): Promise<void> {
    await this.resolveCredentialTarget(input.targetId);
    const metadata = await this.credentials.find(input.credentialId);
    if (!metadata || metadata.targetId !== input.targetId) throw new Error("CREDENTIAL_NOT_FOUND");
    // 供应商至少需要保留一个密钥，否则 config-sync 会把供应商从 Codex/Claude 配置中剔除。
    const remaining = await this.credentials.list(input.targetId);
    if (remaining.length <= 1) throw new Error("CREDENTIAL_LAST_REQUIRED");
    for (const secretId of credentialSecretIds(metadata)) await this.credentialStore.delete(secretId);
    await this.credentials.remove(metadata.id);
    // 双保险：删除后清理/提升供应商与 Agent 级默认密钥引用，避免悬空指向已删除密钥。
    await this.reconcileCredentialDefaults(input.targetId, metadata.id);
  }

  /**
   * 密钥删除或适用变更后，维护默认密钥引用：
   * Agent 级 defaultCredentials[agent] 指向已移除/失去适用的密钥时，
   * 提升为剩余适用密钥中最近设置的一个（列表按 updatedAt 倒序）；无适用则删除该引用。
   */
  private async reconcileCredentialDefaults(targetId: string, removedId: string): Promise<void> {
    if (!this.configProvider.updateConfig) return;
    const current = this.configProvider.getConfig();
    const target = current.targets?.find(item => item.id === targetId);
    if (!target) return;
    const remaining = await this.credentials.list(targetId);
    const development = target.development || {};
    const nextDefaultCredentials: Record<string, string> = { ...(development.defaultCredentials || {}) };
    let changed = false;
    for (const [agent, credentialId] of Object.entries(nextDefaultCredentials)) {
      if (credentialId !== removedId) continue;
      const candidate = remaining.find(item => agentScopeIncludes(item.agentScope, agent));
      if (candidate) {
        nextDefaultCredentials[agent] = candidate.id;
      } else {
        delete nextDefaultCredentials[agent];
      }
      changed = true;
    }
    if (!changed) return;
    // 总是显式提交完整 defaultCredentials（含剩余键；无剩余时为空对象），
    // 配合 mergeDevelopmentSettings 的整体替换语义，确保提升/清理都真正落库。
    const nextDevelopment: ProxyTarget["development"] = {
      ...development,
      defaultCredentials: nextDefaultCredentials,
    };
    await this.configProvider.updateConfig({
      targetPatch: { id: targetId, target: { development: nextDevelopment } },
    }).catch(() => undefined);
  }

  async start(input: DevelopmentStartInput): Promise<{
    launchId: string;
    defaultNotice: string;
    dshAlreadyRunning?: boolean;
    zcodeAlreadyRunning?: boolean;
    /** 偏好确有变化且进程常驻（dsh/zcode）：配置已写入，需重启后生效。 */
    appliedButRequiresRestart?: boolean;
    /**
     * 偏好确有变化且形态为 Codex 桌面客户端：目录条目已写入，但无法探测客户端
     * 是否已在运行，给出条件式提示（在运行则需完全退出重开）。
     */
    preferenceApplyHint?: string;
    /** 启动前 preSync 产生的 CLI 同步警告（preserve/回退类），供弹窗如实展示。 */
    appliedSyncWarnings?: Array<{code: string; message: string; targetId?: string}>;
  }> {
    this.startCleanupOnce();
    const manualOverrides = normalizeDevelopmentManualOverrides(input.manualOverrides);
    if (this.launchBusy) throw new Error("LAUNCH_IN_PROGRESS");
    this.launchBusy = true;
    try {
      const target = await this.resolveTarget(input.targetId, input.cli);
      if (!await this.routingApplicationChecker(this.configProvider.getConfig())) {
        throw new Error("PROXY_CONFIG_NOT_APPLIED");
      }
      const cli = input.cli;
      const strategy = agentLaunchStrategy(cli);
      // 官方直连形态启动（2026-10-09，仅声明 supportsOfficialFormLaunch 的 Agent——
      // 当前 codex）：CLI 形态为官方模式（cliSyncEnabled=false，受管层已清空）时，
      // 不注入网关参数、不校验模型/价格映射/密钥（模型在官方客户端内选择），
      // 启动后持久化也跳过默认模型。configProvider 已在 resolveTarget 内 reload。
      const officialFormLaunch = strategy.supportsOfficialFormLaunch === true
        && this.configProvider.getConfig().agentConnections[cli]?.cliSyncEnabled === false;
      let resolvedModel: string | undefined;
      if (!officialFormLaunch) {
        resolvedModel = requiredSelectionValue(
          input.selectedModel,
          "MODEL_SELECTION_REQUIRED",
          256,
        );
        const modelAllowed = (target.supportedModels || []).includes(resolvedModel)
          && agentScopeIncludes(target.supportedModelScopes?.[resolvedModel], cli);
        if (!modelAllowed) {
          throw new Error("MODEL_NOT_SUPPORTED_BY_TARGET");
        }
        const priceMapping = target.pricing?.modelVendors?.[resolvedModel];
        if (!priceMapping?.vendor || !priceMapping.priceEntryId) {
          throw new Error("MODEL_PRICE_MAPPING_REQUIRED");
        }
      }
      const opencodeWireApi = strategy.resolveLaunchWireApi?.(
        this.configProvider.getConfig(),
        target,
        resolvedModel ?? "",
      );
      assertTargetProtocol(target, cli);
      // 订阅通道、显式 passthrough（登录透传）与官方直连形态启动都不需要系统凭据。
      const isPassthrough = target.credentialMode === "passthrough";
      const isSubscription = target.billingChannel === "subscription" || isPassthrough;
      const credentialFree = isSubscription || officialFormLaunch;
      let credential: DevelopmentCredentialMetadata | undefined;
      if (!credentialFree) {
        const credentialId = input.credentialId;
        if (!credentialId) throw new Error("CREDENTIAL_REQUIRED");
        credential = await this.credentials.find(credentialId);
        if (!credential || credential.targetId !== target.id) throw new Error("CREDENTIAL_REQUIRED");
        requireUsableCredential(credential);
        if (!agentScopeIncludes(credential.agentScope, cli)) {
          throw new Error("CREDENTIAL_NOT_ALLOWED_FOR_AGENT");
        }
        if (credential.store !== expectedCredentialStore(this.platform.platform)) {
          throw new Error("CREDENTIAL_STORE_UNAVAILABLE");
        }
        if (!await this.credentialStore.isAvailable()) {
          throw new Error("CREDENTIAL_STORE_UNAVAILABLE");
        }
      }
      // 可执行解析与常驻实例探测全部由策略声明（dsh 通道探测 3080 端口、
      // zcode 取平台安装位置并检测单例；缺省走 PATH 解析）。
      const executableResolution: StrategyExecutable = strategy.resolveExecutable
        ? await strategy.resolveExecutable({
          platform: this.platform,
          capabilities: () => this.capabilities(),
          portProbe: this.dshPortProbe,
        })
        : await this.resolveExecutableViaPath(cli);
      const executablePath = executableResolution.executablePath;
      const alreadyRunning = executableResolution.alreadyRunning ?? false;
      const isClientTerminal = strategy.clientTerminalId !== undefined
        && input.terminal === strategy.clientTerminalId;
      // CLI 模式必填并校验存在性；客户端模式（codex app [PATH]）与 App/Web 形态选填。
      const dirOptional = strategy.requiresProjectDir === "optional" || isClientTerminal;
      const projectDir = dirOptional
        ? (input.projectDir ? await validateProjectDirectory(input.projectDir) : undefined)
        : await validateProjectDirectory(input.projectDir);
      let terminal: string | undefined;
      if (isClientTerminal) {
        terminal = strategy.clientTerminalId;
      } else if (strategy.terminalPolicy === "none") {
        terminal = strategy.fixedTerminalId;
      } else {
        const terminals = await this.platform.listTerminals();
        terminal = input.terminal
          ? terminals.find(item => item.id === input.terminal && item.available)?.id
          : chooseTerminal(target.development?.preferredTerminal, terminals);
        if (!terminal) throw new Error("TERMINAL_NOT_FOUND");
      }
      const localBaseUrl = validateGatewayBaseUrl(this.configProvider.getConfig().localProxyBaseUrl);
      // 配置文件类 Agent（策略声明 consumesLaunchPreferences）：弹窗总是提交完整
      // 偏好状态（空对象 = 清除），启动前落库，随后的 config-sync 写入受管配置。
      const prefsProvided = strategy.consumesLaunchPreferences
        && input.launchPreferences !== undefined;
      let preferencesChanged = false;
      if (prefsProvided && this.configProvider.updateConfig) {
        const previousPreferences
          = this.configProvider.getConfig().agentConnections[cli]?.launchPreferences ?? null;
        const launchPreferences = strategy.normalizePreferences(input.launchPreferences);
        // 偏好确有变化才视为「改了受管配置」：常驻进程（dsh/zcode）的重启提示
        // 只在该信号 + 进程在运行时给出，默认不改配置的启动保持静默。
        preferencesChanged = !sameLaunchPreferences(previousPreferences, launchPreferences ?? null);
        await this.configProvider.updateConfig({
          agentConnectionPatch: {agent: cli, action: "connect", launchPreferences: launchPreferences ?? null},
        }).catch(error => {
          console.error("[deepaa] development launch preference persist failed", error);
        });
      }
      const effectiveLaunchMode = strategy.fixedLaunchMode ?? input.launchMode;
      const prepared = await prepareDevelopmentLaunch({
        tempRoot: this.tempRoot,
        input: {
          cli,
          platform: this.platform.platform,
          targetId: target.id,
          targetName: target.name,
          localBaseUrl,
          // 客户端模式的命令不会被使用，但命令构造仍要求非空目录，回退用户目录。
          projectDir: projectDir || this.homeDir,
          executablePath,
          terminal: terminal || "codex-client",
          credentialId: credential?.id,
          credentialHelperPath: this.credentialHelperPath,
          nodeExecutable: this.nodeExecutable,
          resolvedModel,
          resumeSessionId: input.resumeSessionId,
          manualOverrides,
          subscriptionPassthrough: isSubscription,
          officialFormLaunch,
          launchMode: effectiveLaunchMode,
          dshChannel: executableResolution.channel,
          task: strategy.consumesHeadlessTask && input.launchMode === "headless"
            ? input.task
            : undefined,
          opencodeWireApi,
        },
      });
      try {
        const executeResult = await strategy.execute({
          homeDir: this.homeDir,
          target,
          resolvedModel,
          manualOverrides,
          executablePath,
          projectDir,
          requestedTerminal: input.terminal,
          isClientTerminal,
          launchMode: effectiveLaunchMode,
          alreadyRunning,
          officialFormLaunch,
          command: prepared.command,
          configOps: {
            reload: () => this.configProvider.reload(),
            getConfig: () => this.configProvider.getConfig(),
            syncer: (config, options) => this.cliConfigSyncer(config, options),
          },
          launchers: {
            codexClient: this.codexClientLauncher,
            zcodeApp: this.zcodeAppLauncher,
            dshDesktopApp: this.dshDesktopAppLauncher,
          },
          platform: this.platform,
        });
        // 警告白名单（2026-10-06 用户确认）：只透传「本次启动目标」的用户向回退提示；
        // 其余（preserve/凭据缺失等管理页语境）不上弹窗。
        const launchWarnings = (executeResult?.syncWarnings ?? [])
          .filter(warning => warning.code === "LAUNCH_PREFERENCE_EFFORT_UNSUPPORTED"
            && (!warning.targetId || warning.targetId === target.id));
        // 终端偏好只在标准终端路径且非专用终端模式时持久化（codex-client/zcode-app 不落库）。
        const persistTerminal = strategy.terminalPolicy === "standard"
          && terminal !== strategy.clientTerminalId
            ? terminal
            : undefined;
        const defaultNotice = await this.persistDevelopmentPreferences(
          target.id,
          credential?.id,
          persistTerminal,
          resolvedModel,
          cli,
          projectDir,
        );
        return {
          launchId: prepared.command.launchId,
          defaultNotice,
          ...(launchWarnings.length > 0 ? {
            appliedSyncWarnings: launchWarnings.map(warning => ({
              code: warning.code,
              message: warning.message,
              ...(warning.targetId ? {targetId: warning.targetId} : {}),
            })),
          } : {}),
          ...(strategy.alreadyRunningResponseKey === "dshAlreadyRunning" && alreadyRunning
            && effectiveLaunchMode !== "app"
            ? {dshAlreadyRunning: true}
            : {}),
          ...(strategy.alreadyRunningResponseKey === "zcodeAlreadyRunning" && alreadyRunning
            ? {zcodeAlreadyRunning: true}
            : {}),
          // zcode 常驻 App：个人供应商规则层（provider_config.json）约 1 秒热加载，
          // 供应商/模型列表免重启刷新（2026-10-06 asar 实证轮询机制）；默认模型选择
          // 若未跟随需完全退出重开，故保持常驻提示由用户确认（dsh 免重启、dsh 桌面
          // 客户端形态同样不提示）。
          ...(alreadyRunning && strategy.alreadyRunningResponseKey === "zcodeAlreadyRunning"
            ? {appliedButRequiresRestart: true}
            : {}),
          // dsh web 常驻：偏好确有变化时提示「下一请求即生效」（免重启，不阻止关窗）。
          ...(preferencesChanged && alreadyRunning
            && strategy.alreadyRunningResponseKey === "dshAlreadyRunning" && effectiveLaunchMode !== "app"
            ? {preferenceApplyHint: "本次高级设置已写入受管配置，下一请求即生效"}
            : {}),
          // Codex 客户端模式无法探测桌面客户端是否已在运行：偏好确有变化时给出
          // 条件式提示（在运行则需完全退出重开才能读到新目录条目）。
          ...(preferencesChanged && isClientTerminal && !alreadyRunning
            ? {preferenceApplyHint: "本次高级设置已写入模型目录；若 Codex 桌面客户端已在运行，请完全退出后重新打开生效"}
            : {}),
        };
      } catch (error) {
        if (prepared.runtimeDirectory) {
          await rm(prepared.runtimeDirectory, { recursive: true, force: true });
        }
        throw error;
      }
    } finally {
      this.launchBusy = false;
    }
  }

  private async resolveTarget(targetId: string, agent: AgentId): Promise<ProxyTarget> {
    await this.configProvider.reload();
    const config = this.configProvider.getConfig();
    const connection = config.agentConnections[agent];
    if (!connection) throw new Error("AGENT_NOT_CONNECTED");
    const target = findProxyTarget(config, targetId);
    if (!target) throw new Error("TARGET_NOT_FOUND");
    if (!target.enabled) throw new Error("TARGET_DISABLED");
    const boundTargetIds = connection.boundTargetIds?.length
      ? connection.boundTargetIds
      : connection.defaultTargetId ? [connection.defaultTargetId] : [];
    if (!boundTargetIds.includes(target.id)) throw new Error("AGENT_TARGET_NOT_BOUND");
    validateGatewayBaseUrl(config.localProxyBaseUrl);
    return target;
  }

  /** 凭据操作只要求供应商存在，不要求启用：允许用户先配置密钥再启用供应商。 */
  private async resolveCredentialTarget(targetId: string): Promise<ProxyTarget> {
    await this.configProvider.reload();
    const target = findProxyTarget(this.configProvider.getConfig(), targetId);
    if (!target) throw new Error("TARGET_NOT_FOUND");
    return target;
  }

  /** 策略未声明专属可执行解析时的兜底：平台 PATH 解析（终端 CLI 形态）。 */
  private async resolveExecutableViaPath(cli: DevelopmentCli): Promise<StrategyExecutable> {
    const executablePath = await this.platform.resolveExecutable(cli);
    if (!executablePath) throw new Error("CLI_NOT_FOUND");
    return {executablePath};
  }

  private startCleanupOnce(): void {
    if (this.cleanupStarted) return;
    this.cleanupStarted = true;
    void cleanupExpiredLaunchArtifacts(this.tempRoot).catch(() => undefined);
  }

  /**
   * 启动成功后持久化本次选择：写入供应商默认模型、把该供应商提升为对应 Agent 默认代理，
   * 并同步本地 CLI 配置；任何一步失败只记录，不反向破坏本次启动结果。
   * 返回弹窗提示文案（默认代理 + 默认模型）。官方直连形态启动（defaultModel
   * 为 undefined）只记录默认供应商与目录/终端偏好，不写默认模型——官方模式下
   * 无网关模型概念，写网关默认模型会让后续网关模式目录解析缺省失配。
   */
  private async persistDevelopmentPreferences(
    targetId: string,
    credentialId: string | undefined,
    terminal: string | undefined,
    defaultModel: string | undefined,
    cli: DevelopmentCli,
    lastProjectDir?: string,
  ): Promise<string> {
    if (!this.configProvider.updateConfig) return "";
    await this.configProvider.reload().catch(() => undefined);
    const target = this.configProvider.getConfig().targets.find(item => item.id === targetId);
    if (!target) return "";
    // 订阅通道、登录透传与官方直连形态启动都没有系统默认密钥引用可写。
    const subscription =
      target.billingChannel === "subscription" || target.credentialMode === "passthrough";
    const existingConnection = this.configProvider.getConfig().agentConnections[cli];
    const boundTargetIds = [...new Set([
      ...(existingConnection?.boundTargetIds ?? []),
      ...(existingConnection?.defaultTargetId ? [existingConnection.defaultTargetId] : []),
      targetId,
    ])];
    await this.configProvider.updateConfig({
      targetPatch: {
        id: targetId,
        target: {
          development: {
            ...target.development,
            ...(terminal ? {preferredTerminal: terminal} : {}),
            ...(lastProjectDir ? {lastProjectDir} : {}),
          },
        },
      },
      agentConnectionPatch: {
        agent: cli,
        action: "connect",
        boundTargetIds,
        defaultTargetId: targetId,
        ...(defaultModel ? {defaultModelId: defaultModel} : {}),
        ...(subscription ? {} : {defaultCredentialId: credentialId}),
        cliSyncEnabled: this.configProvider.getConfig().agentConnections[cli]?.cliSyncEnabled ?? false,
      },
    }).catch(() => undefined);
    // 定向同步（2026-10-06 闭环）：启动链路只刷本次启动的 Agent——其它 Agent 的
    // 受管文件不被无关启动触碰（其更新由各自启动、供应商管理保存、目录能力跟随
    // 等既有触发点负责）。官方模式下该同步产出幂等清理层，不触碰用户官方配置。
    await this.cliConfigSyncer(this.configProvider.getConfig(), {agents: [cli]}).catch(error => {
      console.error("[deepaa] development launch default sync failed", error);
    });
    return defaultModel
      ? `已设为 ${registryAgentLabel(cli)} 默认供应商，默认模型：${defaultModel}`
      : `已设为 ${registryAgentLabel(cli)} 默认供应商（官方直连，模型在官方客户端内选择）`;
  }
}

/** 默认 CLI 网关同步器：写入用户 home 下的 Codex/Claude Code 配置，与 /api/config-sync 同一实现。 */
function defaultCliConfigSyncer(homeDir: string, credentialHelperPath: string): (config: ProxyConfig, options?: {agents?: readonly AgentId[]}) => Promise<ConfigSyncReport> {
  return async (config: ProxyConfig, options?: {agents?: readonly AgentId[]}): Promise<ConfigSyncReport> =>
    syncCliConfigs(config, {
      paths: {
        codexConfigPath: join(homeDir, ".codex", "config.toml"),
        codexCatalogPath: join(homeDir, ".codex", "deepaa", "catalogs", "all.json"),
        claudeUserSettingsPath: join(homeDir, ".claude", "settings.json"),
        claudeProjectSettingsPaths: {},
        gatewayBaseUrl: resolveGatewayBaseUrl(config.localProxyBaseUrl),
        gatewayBearerToken: GATEWAY_PLACEHOLDER_TOKEN,
      },
      credentialHelperPath,
      ...(options?.agents ? {agents: options.agents} : {}),
    });
}

let service: DevelopmentLaunchService | undefined;

export function getDevelopmentLaunchService(): DevelopmentLaunchService {
  service ||= new DevelopmentLaunchService();
  return service;
}

async function validateProjectDirectory(path: string | undefined): Promise<string> {
  if (typeof path !== "string" || !path.trim() || path.length > 4096) throw new Error("INVALID_PROJECT_DIR");
  try {
    const canonical = await realpath(path);
    if (!(await stat(canonical)).isDirectory()) throw new Error("INVALID_PROJECT_DIR");
    return canonical;
  } catch (error) {
    if (error instanceof Error && error.message === "INVALID_PROJECT_DIR") throw error;
    throw new Error("INVALID_PROJECT_DIR");
  }
}

function assertTargetProtocol(target: ProxyTarget, cli: DevelopmentCli): void {
  const capability = resolveTargetAgentCapability(target, cli);
  if (!capability.supported) throw new Error(capability.reason === "PRESET_WIRE_API_UNSUPPORTED"
    ? "PRESET_WIRE_API_UNSUPPORTED"
    : "PROTOCOL_NOT_CONFIGURED");
}

/**
 * 供应商支持模型的目录默认值（有界）：读取 catalog 模板 + 用户覆盖，
 * 按模型合并出推理档位、默认档位、上下文窗口与自动压缩阈值，供弹窗高级设置预填。
 * supportedModels 由供应商配置约束（向导上限 200），此处再做切片防御。
 */
async function resolveModelCatalogDefaults(
  target: ProxyTarget,
  pricingConfig: PricingConfig,
): Promise<Record<string, DevelopmentModelCatalogDefaults>> {
  const defaults: Record<string, DevelopmentModelCatalogDefaults> = {};
  const models = (target.supportedModels || []).slice(0, 200);
  if (models.length === 0) return defaults;
  // 价格中心条目（人工/官方目录/litellm 来源均认）按条目 ID 建索引，与 CLI 配置同步
  // 共用同一共享解析层（2026-09-21 能力下发：弹窗预填与 CLI 配置文件同值，单链解析）。
  const priceEntriesById = new Map<string, ModelPriceEntry>(
    normalizePricingConfig(pricingConfig).models.map(entry => [entry.id, entry]),
  );
  let template: CatalogTemplate = EMPTY_LAUNCH_TEMPLATE;
  let overrides: CatalogOverrides = {};
  try {
    [template, overrides] = await Promise.all([
      readCatalogTemplate(defaultTemplatePath()),
      readCatalogOverrides(defaultOverridesPath()),
    ]);
  } catch {
    // 目录缺失/损坏不是预检失败条件：解析层按常量兜底继续生成默认值。
  }
  for (const modelId of models) {
    const caps = resolveModelRuntimeCaps({
      target,
      modelId,
      pricingEntriesById: priceEntriesById,
      template,
      overrides,
    });
    const variants = [...new Set(template.defaults.supportedReasoningLevels
      .map(level => level.effort)
      .filter(Boolean))];
    const contextWindow = caps.contextWindow;
    const autoCompactTokenLimit = resolveAutoCompactTokenLimit(contextWindow);
    defaults[modelId] = {
      reasoningLevels: variants,
      // 默认档与 CLI 适配器共用同一推断链（resolveDefaultReasoningLevel：
      // anthropic/responses → xhigh、其余 → max，落表校验），保证弹窗预填值
      // 就是「不打开弹窗时」适配器实际写入受管配置的值。
      ...((() => {
        const inferred = resolveDefaultReasoningLevel(modelId, template);
        return inferred ? {defaultReasoningLevel: inferred} : {};
      })()),
      contextWindow,
      autoCompactTokenLimit,
    };
  }
  return defaults;
}

/** 模板读取失败时的空模板（解析层回退到代码常量兜底）。 */
const EMPTY_LAUNCH_TEMPLATE: CatalogTemplate = {
  defaults: {supportedReasoningLevels: []},
  families: {},
  agents: {},
};

/** dsh 推理强度值域（llm-pi-ai / agent-default-model 的合法枚举）。 */
function validateGatewayBaseUrl(value: string | undefined): string {
  if (!value) throw new Error("INVALID_LOCAL_BASE_URL");
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error();
    // 全站统一 127.0.0.1：启动 env（CLI base_url / ANTHROPIC_BASE_URL）写盘前归一化别名。
    return normalizeLoopbackAliasBaseUrl(parsed.toString()).replace(/\/$/, "");
  } catch {
    throw new Error("INVALID_LOCAL_BASE_URL");
  }
}

function requiredSelectionValue(value: unknown, code: string, maxLength: number): string {
  if (typeof value !== "string") throw new Error(code);
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new Error(code);
  }
  return normalized;
}

function stableCleanupErrorCode(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : "";
  return /^[A-Z][A-Z0-9_]{2,80}$/u.test(message) ? message : fallback;
}

function chooseTerminal(
  preferred: string | undefined,
  terminals: Awaited<ReturnType<DevelopmentPlatformAdapter["listTerminals"]>>,
): string | undefined {
  if (preferred && terminals.some(item => item.id === preferred && item.available)) return preferred;
  return terminals.find(item => item.available)?.id;
}

function expectedCredentialStore(platform: "darwin" | "win32") {
  return platform === "darwin" ? "macos-keychain" : "windows-credential-manager";
}

function validateSecret(secret: string): void {
  if (
    typeof secret !== "string"
    || !secret
    || secret.length > MAX_SECRET_LENGTH
    || /[\u0000\r\n]/.test(secret)
  ) {
    throw new Error("CREDENTIAL_SECRET_REQUIRED");
  }
}

async function cleanupExpiredLaunchArtifacts(tempRoot: string): Promise<void> {
  let directory;
  try {
    directory = await opendir(tempRoot);
  } catch {
    return;
  }
  let processed = 0;
  const cutoff = Date.now() - 24 * 60 * 60_000;
  try {
    for await (const entry of directory) {
      if (++processed > MAX_CLEANUP_ENTRIES) break;
      if (!entry.isDirectory() || !/^launch_[A-Za-z0-9._-]+$/.test(entry.name)) continue;
      const path = join(tempRoot, entry.name);
      const metadata = await stat(path).catch(() => undefined);
      if (metadata && metadata.mtimeMs < cutoff) await rm(path, { recursive: true, force: true });
    }
  } finally {
    await directory.close().catch(() => undefined);
  }
}
