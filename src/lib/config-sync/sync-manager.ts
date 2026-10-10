import {GatewayTokenResolver} from "@/proxy/token-resolver";
import {KNOWN_AGENT_IDS, type AgentId, type ProxyConfig} from "@/types";
import {readPricingConfig, normalizePricingConfig, type ModelPriceEntry} from "@/lib/pricing";
import {resolveDeepaaDataDir} from "@/lib/data-paths";
import {
  readCatalogOverrides,
  readCatalogTemplate,
  defaultTemplatePath,
  defaultOverridesPath,
} from "@/lib/config-sync/catalog-template";
import {cliConfigAdapters} from "@/lib/config-sync/core/agent-plan-registry";
import {
  backupFile,
  ensurePreDeepaaBackup,
  readOptionalBounded,
  safeRegularFile,
  writeConfigFileAtomic,
} from "@/lib/config-sync/core/file-io";
import {assertNoRealSecrets} from "@/lib/config-sync/core/placeholder-auth";
import {hasSubscriptionPresetRoute} from "@/lib/config-sync/core/subscription-route";
import {createCliSyncContext} from "@/lib/config-sync/core/sync-context";
import {readClaudeOAuthCredentials} from "@/lib/sync-engine/subscription-oauth";
import type {
  AgentCliPreview,
  CliSyncPaths,
  CliSyncWarning,
} from "@/lib/config-sync/core/types";
import {agentLabel as registryAgentLabel} from "@/lib/agent-registry";

export interface ConfigSyncOptions {
  paths: CliSyncPaths;
  credentialHelperPath: string;
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /**
   * 定向同步（2026-09-21 能力下发）：只重写指定 Agent 的受管配置；
   * 缺省 = 全量（既有调用语义不变）。目录能力变化的静默同步按受影响 Agent 定向传入。
   */
  agents?: readonly AgentId[];
  /** 价格中心数据目录（可选）：读取条目索引供共享解析层；缺省按 resolveDeepaaDataDir 解析。 */
  dataDir?: string;
  /**
   * 本机官方 CLI 登录态探测（2026-10-08 路由级订阅透传；2026-10-09 收缩为
   * claude-only——codex 因 ChatGPT 原生 wire 阻断已回退恒占位）：缺省实现只读
   * Claude 凭据（与套餐同步同一份读取逻辑），仅在存在 anthropic-subscription
   * 预设路由时才探测；测试注入用。
   */
  cliLoginProbe?: (config: ProxyConfig) => Promise<{claude: boolean}>;
}

export interface ConfigSyncReport {
  ok: boolean;
  writtenFiles: Array<{path: string; bytes: number}>;
  warnings: CliSyncWarning[];
  errors: string[];
  previews: Partial<Record<AgentId, AgentCliPreview>>;
}

/**
 * 把代理配置同步为全部已注册 Agent 的 CLI 网关配置。
 *
 * 公共引擎只负责编排：按适配器注册表遍历、串行执行、单 Agent 失败不阻断
 * 其它 Agent；每个文件写入前备份、原子替换、1 MiB 有界读取、拒绝符号链接，
 * 并且校验待写内容只含本地网关占位 token。CLI 同步失败只记录错误，
 * 绝不回滚或阻断代理配置保存。
 */
export async function syncCliConfigs(
  config: ProxyConfig,
  options: ConfigSyncOptions,
): Promise<ConfigSyncReport> {
  const report: ConfigSyncReport = {ok: true, writtenFiles: [], warnings: [], errors: [], previews: {}};
  try {
    const templatePath = options.paths.codexCatalogTemplatePath || defaultTemplatePath();
    const overridesPath = options.paths.codexCatalogOverridesPath || defaultOverridesPath();
    const template = await readCatalogTemplate(templatePath);
    const overrides = await readCatalogOverrides(overridesPath);
    // 价格中心条目索引（能力下发）：读取失败降级为空索引，同步绝不因价格中心问题失败。
    const pricingEntriesById = await readPricingEntriesByIdForSync(options.dataDir);
    // CLI 登录态探测（2026-10-08）：只在存在对应订阅预设路由时才探测（注入的
    // probe 同样遵守该语义）；codex 侧 2026-10-09 起恒占位 token、不再探测。
    // 探测失败一律按未登录处理，绝不阻断同步。
    const needsClaudeLogin = hasSubscriptionPresetRoute(config, "anthropic-subscription");
    const cliLogin = needsClaudeLogin
      ? await (options.cliLoginProbe ?? probeCliLoginStates)(config)
      : {claude: false};
    const context = createCliSyncContext({
      config,
      paths: options.paths,
      template,
      overrides,
      ...(pricingEntriesById ? {pricingEntriesById} : {}),
      cliLogin,
      homeDir: options.homeDir,
      env: options.env,
      platform: options.platform,
    });

    for (const adapter of cliConfigAdapters()) {
      // 定向同步：只处理指定 Agent；缺省全量（既有调用零影响）。
      if (options.agents && !options.agents.includes(adapter.agent)) continue;
      try {
        const resolved = adapter.resolvePaths(context);
        const plan = adapter.build(context, resolved);
        adapter.validate(plan);
        report.warnings.push(...plan.warnings);
        report.previews[adapter.agent] = adapter.describe(plan);
        // 链路瞬时不合格：跳过一切写入（含清理层），保留磁盘现状。
        if (plan.preserve) continue;
        for (const artifact of plan.artifacts) {
          const spec = adapter.files.find(file => file.id === artifact.specId);
          if (!spec) throw new Error(`UNKNOWN_FILE_SPEC: ${artifact.specId}`);
          // 路径白名单：拒绝符号链接与非常规文件；文件不存在时按新建处理。
          await safeRegularFile(artifact.path);
          const existingRaw = await readOptionalBounded(artifact.path, spec.maxBytes);
          const merged = adapter.mergeFile({file: spec, existingRaw, artifact});
          // 空合并产物 = 无需写入（目标文件不存在时的清理层 no-op），
          // 避免为不存在的 Agent 配置凭空创建 0 字节文件。
          if (merged === "") continue;
          // 敏感凭据文件跳过密钥扫描与备份：文件本身就是用户的密钥存储，只 patch 占位键。
          // skipSecretScan 用于「文件本身合法包含用户自有密钥」的场景：保留备份、只跳过扫描。
          if (!spec.sensitive) {
            await backupFile(artifact.path);
            if (!spec.skipSecretScan) {
              assertNoRealSecrets(merged, `${registryAgentLabel(adapter.agent)} ${artifact.path}`);
            }
          }
          await writeConfigFileAtomic(artifact.path, merged);
          report.writtenFiles.push({path: artifact.path, bytes: Buffer.byteLength(merged)});
        }
      } catch (error) {
        report.errors.push(`${registryAgentLabel(adapter.agent)} CLI 同步失败：${errorMessage(error)}`);
        report.ok = false;
      }
    }

    // 凭据存在性预检：不改变上游状态码与保存结果，只补充 warning。
    // 定向同步（options.agents 非空：开发启动链、目录能力跟随）不执行预检——
    // 预检需按「目标 × Agent」逐个 spawn 凭据 helper（本机实测 ~0.3s/次，
    // 12 目标 × 5 Agent 的默认凭据引用串行可达 9s），而定向消费方均不消费
    // CREDENTIAL_MISSING（启动链只透出 LAUNCH_PREFERENCE_EFFORT_UNSUPPORTED，
    // 能力跟随只看 report.ok）；全量同步（供应商管理「立即同步」）保持既有行为。
    if (!options.agents) {
      const checks: Array<{targetId: string; targetName: string; agent: AgentId; credentialId: string}> = [];
      for (const target of config.targets) {
        if (!target.enabled) continue;
        for (const agent of KNOWN_AGENT_IDS) {
          const credentialId = target.development?.defaultCredentials?.[agent];
          if (!credentialId || !config.agentConnections[agent]) continue;
          checks.push({targetId: target.id, targetName: target.name, agent, credentialId});
        }
      }
      const missing = await findMissingCredentials(
        checks.map(check => check.credentialId),
        options.credentialHelperPath,
      );
      for (const check of checks) {
        if (!missing.has(check.credentialId)) continue;
        report.warnings.push({
          targetId: check.targetId,
          code: "CREDENTIAL_MISSING",
          message: `${check.targetName} 的 ${registryAgentLabel(check.agent)} 默认系统凭据不存在`,
        });
      }
    }
  } catch (error) {
    report.errors.push(errorMessage(error));
    report.ok = false;
  }
  return report;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ———————————————— 凭据存在性预检（全量同步专用） ————————————————

/**
 * 存在性探测缓存（web 进程内模块级共享）：每次探测 = spawn credential-helper
 * 子进程（node 启动 + 系统凭据库查询，本机实测 ~0.3s/次），全量同步按
 * 「目标 × Agent」逐个探测时缓存把重复探测降为零。凭据写操作后经
 * invalidateCredentialExistenceCache 主动失效（见 development-launch service）。
 * exists 的退出码无法区分「确认不存在」与「探测异常」，失败结果用短 TTL，
 * 瞬时故障（如 Keychain 锁定）30s 内自愈；成功结果（大多数）享受长 TTL。
 */
const CREDENTIAL_EXISTS_SUCCESS_TTL_MS = 5 * 60_000;
const CREDENTIAL_EXISTS_FAILURE_TTL_MS = 30_000;
/** 并发 spawn 上限：保留并行收益的同时避免一次性派出几十个子进程。 */
const CREDENTIAL_PROBE_CONCURRENCY = 8;
const credentialExistsCache = new Map<string, {ok: boolean; expiresAt: number}>();

/** 凭据写操作（新增/覆盖/删除）后主动失效；不传 id 时清空全部缓存。 */
export function invalidateCredentialExistenceCache(credentialId?: string): void {
  if (credentialId === undefined) credentialExistsCache.clear();
  else credentialExistsCache.delete(credentialId);
}

async function probeCredentialExists(
  resolver: GatewayTokenResolver,
  credentialId: string,
): Promise<boolean> {
  const cached = credentialExistsCache.get(credentialId);
  if (cached && cached.expiresAt > Date.now()) return cached.ok;
  const ok = await resolver.exists(credentialId);
  credentialExistsCache.set(credentialId, {
    ok,
    expiresAt: Date.now() + (ok ? CREDENTIAL_EXISTS_SUCCESS_TTL_MS : CREDENTIAL_EXISTS_FAILURE_TTL_MS),
  });
  return ok;
}

/** 批量存在性探测（去重 + 有界并发），返回不存在的 credentialId 集合。 */
async function findMissingCredentials(
  credentialIds: readonly string[],
  credentialHelperPath: string,
): Promise<Set<string>> {
  const unique = [...new Set(credentialIds)];
  if (unique.length === 0) return new Set();
  const resolver = new GatewayTokenResolver({credentialHelperPath});
  const missing = new Set<string>();
  for (let offset = 0; offset < unique.length; offset += CREDENTIAL_PROBE_CONCURRENCY) {
    const batch = unique.slice(offset, offset + CREDENTIAL_PROBE_CONCURRENCY);
    const results = await Promise.all(batch.map(id => probeCredentialExists(resolver, id)));
    batch.forEach((id, index) => {
      if (!results[index]) missing.add(id);
    });
  }
  return missing;
}

/**
 * 默认 Claude 登录态探测：读 Claude 凭据（与套餐同步同一份只读逻辑）；
 * 读取函数内部自捕获，外层再兜一层——任何异常都按未登录降级。
 * 调用时机（是否存在订阅路由）由编排层判定。
 */
async function probeCliLoginStates(config: ProxyConfig): Promise<{claude: boolean}> {
  try {
    const claude = hasSubscriptionPresetRoute(config, "anthropic-subscription")
      ? await readClaudeOAuthCredentials().then(token => Boolean(token))
      : false;
    return {claude};
  } catch {
    return {claude: false};
  }
}

/**
 * 读取价格中心条目索引（按条目 id）供共享解析层；任何失败返回 undefined（降级为
 * 模板/兜底链），同步绝不因价格中心问题失败。导出供 config-sync 预览路由复用，
 * 保证「预览值 = 实际同步值」。
 */
export async function readPricingEntriesByIdForSync(
  dataDir?: string,
): Promise<Map<string, ModelPriceEntry> | undefined> {
  try {
    const dir = dataDir || resolveDeepaaDataDir();
    const config = await readPricingConfig(dir);
    return new Map(normalizePricingConfig(config).models.map(entry => [entry.id, entry]));
  } catch {
    return undefined;
  }
}

// 兼容导出：文件 IO 能力仍由 development-launch 使用。
export {backupFile, ensurePreDeepaaBackup};
export type {CliSyncPaths, CliSyncWarning};
