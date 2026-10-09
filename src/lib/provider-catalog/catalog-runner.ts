/**
 * 官方目录同步执行器（v2 七章：自动生效 + 通知已阅制，薄 IO 层）：
 *
 * - `runOfficialCatalogSync`：拉最新目录（在线优先→本地兜底）→ 版本闸门（含 v2 切换重置）→
 *   临界区内重读价格中心并按 catalog-sync 分类 → 全量合法变化经 mergeProviderCatalogPricing
 *   自动落盘（user_override 两组保护）→ 追加价格版本（effective_at 回填本批最早官方生效时刻；
 *   历史账本绝不重算）→ 记录目录更新通知（未阅）→ 更新 catalogSync 标记。
 * - `startOfficialCatalogSyncScheduler`：启动执行一次 + 每 1 小时定时重复。
 *
 * 目标使用快照从 proxy-config.json 有界读取（≤1MiB），纯分类逻辑在 catalog-sync.ts。
 */

import {readFile, stat} from "node:fs/promises";
import {homedir} from "node:os";
import {join} from "node:path";
import {loadProviderCatalog} from "./cache";
import {
  classifyCatalogSync,
  shouldSkipCatalogSync,
  type CatalogSyncMarker,
  type TargetModelUsage,
} from "./catalog-sync";
import {mergeProviderCatalogPricing, providerCatalogToPricingEntries} from "./pricing";
import {applyWireApiFollowUp, collectWireApiChanges} from "./wire-api-follow";
import {
  collectCapabilityModelChanges,
  resolveAgentsForModelChanges,
} from "@/lib/config-sync/capability-follow";
import {syncCliConfigs} from "@/lib/config-sync/sync-manager";
import {GATEWAY_PLACEHOLDER_TOKEN} from "@/lib/config-sync/core/placeholder-auth";
import {resolveGatewayBaseUrl} from "@/lib/local-endpoints";
import {importLegacyCatalogNotifications, recordCatalogNotification} from "./notification-store";
import {getDeepaaDatabase} from "@/lib/db/connection";
import {
  claimDueCatalogSyncEffects,
  enqueueCatalogSyncEffects,
  markCatalogSyncEffectRetry,
  markCatalogSyncEffectSucceeded,
} from "./sync-effects";
import {
  listCurrentOfficialMembershipIdentities,
  syncOfficialCatalogMembership,
  syncOfficialCatalogMembershipRows,
} from "./membership-store";
import {
  upsertPricingSourceBaseline,
} from "@/lib/pricing/source-baseline-store";
import {
  readPricingConfig,
  pricingEntryRuntimeModelId,
  withPricingConfigMutation,
  writePricingConfig,
  type PricingConfigV2,
} from "@/lib/pricing";
import {KNOWN_AGENT_IDS, type AgentId, type ProxyConfig} from "@/types";

const LOG_PREFIX = "[deepaa:catalog-sync]";
const MAX_PROXY_CONFIG_BYTES = 1024 * 1024;

export interface CatalogSyncRunResult {
  /** 版本闸门命中：本次目录不比已同步版本新，未执行任何写入。 */
  skippedByVersion: boolean;
  insertedCount: number;
  autoUpdatedCount: number;
  /** 容差内静默迁移（不生成通知）条数。 */
  toleranceSilentCount: number;
  /** 本版通知的可见变化条数（未阅 Diff 数据；无变化为 0）。 */
  notificationCount: number;
  /** 本批最早官方生效时刻（revision 回填用）。 */
  effectiveFrom?: string;
  publishedAt?: string;
}

/** 有界读取供应商目标的使用快照：modelVendors 映射 + vendor/supportedModels 兜底（通知「使用中」标注）。 */
export async function readTargetModelUsage(dataDir: string): Promise<TargetModelUsage> {
  const used = new Set<string>(); // "vendor/modelId"（小写归一）
  try {
    const path = join(dataDir, "proxy-config.json");
    const info = await stat(path).catch(() => undefined);
    if (!info || !info.isFile() || info.size > MAX_PROXY_CONFIG_BYTES) {
      return {isModelInUse: (vendor, modelId) => used.has(key(vendor, modelId))};
    }
    const parsed = JSON.parse(await readFile(path, "utf8")) as {targets?: unknown};
    if (parsed && Array.isArray(parsed.targets)) {
      for (const raw of parsed.targets) {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
        const target = raw as Record<string, unknown>;
        const pricing = target.pricing as Record<string, unknown> | undefined;
        const modelVendors = pricing && typeof pricing.modelVendors === "object" && !Array.isArray(pricing.modelVendors)
          ? pricing.modelVendors as Record<string, {vendor?: unknown}>
          : undefined;
        if (modelVendors) {
          for (const [modelId, mapping] of Object.entries(modelVendors)) {
            if (typeof mapping?.vendor === "string" && mapping.vendor.trim()) {
              used.add(key(mapping.vendor, modelId));
            }
          }
        }
        // 兜底口径：目标级 pricing.vendor + supportedModels（无逐模型映射时）。
        const targetVendor = typeof pricing?.vendor === "string" ? pricing.vendor.trim() : "";
        if (targetVendor && Array.isArray(target.supportedModels)) {
          for (const modelId of target.supportedModels) {
            if (typeof modelId === "string") used.add(key(targetVendor, modelId));
          }
        }
      }
    }
  } catch {
    /* 读取失败时视为无使用中模型：通知缺少「使用中」标注，不阻断同步。 */
  }
  return {isModelInUse: (vendor, modelId) => used.has(key(vendor, modelId))};
}

function key(vendor: string, modelId: string): string {
  return `${vendor.trim().toLowerCase()}/${modelId.trim().toLowerCase()}`;
}

/** 有界读取 proxy-config（wireApis 跟随的目标发现；失败返回空配置不阻断同步）。 */
async function readProxyConfigForFollowUp(dataDir: string): Promise<ProxyConfig> {
  const empty = {version: 3, revision: 0, updatedAt: "", localProxyBaseUrl: "", targets: [], agentConnections: {}} as unknown as ProxyConfig;
  try {
    const path = join(dataDir, "proxy-config.json");
    const info = await stat(path);
    if (!info.isFile() || info.size > MAX_PROXY_CONFIG_BYTES) return empty;
    const parsed = JSON.parse(await readFile(path, "utf8")) as ProxyConfig;
    if (!parsed || !Array.isArray(parsed.targets)) return empty;
    return parsed;
  } catch {
    return empty;
  }
}

export interface CatalogSyncRunOptions {
  /** true 时强制刷新目录缓存（定时任务用）；缺省走 TTL 缓存（启动复用已有缓存）。 */
  forceRefresh?: boolean;
  /** 价格版本追加（测试可注入）。 */
  recordRevision?: (dataDir: string, config: PricingConfigV2, effectiveAt: string) => void | Promise<void>;
  /** 通知 createdAt 时间源（测试可注入）。 */
  now?: () => Date;
}

function retryAt(now: Date, attemptCount: number): string {
  const delayMs = Math.min(15 * 60 * 1000, 30_000 * (2 ** Math.max(0, attemptCount - 1)));
  return new Date(now.getTime() + delayMs).toISOString();
}

async function enqueueEffect(
  dataDir: string,
  effect: Parameters<typeof enqueueCatalogSyncEffects>[1][number],
  now: Date,
): Promise<void> {
  enqueueCatalogSyncEffects(getDeepaaDatabase(dataDir), [effect], now.toISOString());
}

function serializeWireChanges(changes: Map<string, readonly string[]>): Record<string, readonly string[]> {
  return Object.fromEntries(changes.entries());
}

function deserializeWireChanges(payload: unknown): Map<string, readonly import("@/types").WireApi[]> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return new Map();
  const result = new Map<string, readonly import("@/types").WireApi[]>();
  for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
    if (!Array.isArray(value)) continue;
    const wireApis = value.filter((item): item is import("@/types").WireApi =>
      item === "chat_completions" || item === "responses" || item === "messages");
    result.set(key, wireApis);
  }
  return result;
}

async function drainCatalogSyncEffects(
  dataDir: string,
  options: CatalogSyncRunOptions,
  now: Date,
): Promise<void> {
  const db = getDeepaaDatabase(dataDir);
  const effects = claimDueCatalogSyncEffects(db, now.toISOString(), "catalog-sync", 20);
  for (const effect of effects) {
    try {
      switch (effect.effectType) {
        case "notification": {
          const notification = effect.payload;
          if (!notification || typeof notification !== "object") throw new Error("catalog_notification_payload_invalid");
          recordCatalogNotification(db, notification as Parameters<typeof recordCatalogNotification>[1]);
          break;
        }
        case "wire_api_follow": {
          const config = await readProxyConfigForFollowUp(dataDir);
          await applyWireApiFollowUp(config, deserializeWireChanges(effect.payload));
          break;
        }
        case "cli_config_sync": {
          const payload = effect.payload as {agents?: unknown} | undefined;
          const agents = Array.isArray(payload?.agents)
            ? payload.agents.filter((item): item is AgentId =>
                typeof item === "string" && KNOWN_AGENT_IDS.includes(item as AgentId))
            : [];
          const config = await readProxyConfigForFollowUp(dataDir);
          const report = await syncCliConfigs(config, {
            paths: {
              codexConfigPath: join(homedir(), ".codex", "config.toml"),
              codexCatalogPath: join(homedir(), ".codex", "deepaa", "catalogs", "all.json"),
              claudeUserSettingsPath: join(homedir(), ".claude", "settings.json"),
              claudeProjectSettingsPaths: {},
              gatewayBaseUrl: resolveGatewayBaseUrl(config.localProxyBaseUrl),
              gatewayBearerToken: GATEWAY_PLACEHOLDER_TOKEN,
            },
            credentialHelperPath: join(process.cwd(), "bin", "credential-helper.mjs"),
            agents,
            dataDir,
          });
          if (!report.ok) throw new Error(report.errors.join("；") || "cli_config_sync_failed");
          break;
        }
        case "pricing_revision": {
          const payload = effect.payload as {effectiveAt?: unknown} | undefined;
          const effectiveAt = typeof payload?.effectiveAt === "string" ? payload.effectiveAt : now.toISOString();
          await options.recordRevision?.(dataDir, await readPricingConfig(dataDir), effectiveAt);
          break;
        }
        case "membership_projection":
          if (!effect.payload || typeof effect.payload !== "object" || Array.isArray(effect.payload)) {
            throw new Error("catalog_membership_payload_invalid");
          }
          await syncOfficialCatalogMembershipRows(
            db,
            effect.catalogRevision,
            (effect.payload as {rows?: unknown}).rows as Array<{catalogKey: string; pricingProviderId: string; modelId: string}> || [],
            now.toISOString(),
          );
          break;
      }
      markCatalogSyncEffectSucceeded(db, effect.id, now.toISOString());
    } catch (error) {
      markCatalogSyncEffectRetry(db, effect.id, errorMessage(error), retryAt(now, effect.attemptCount), now.toISOString());
      console.error(`${LOG_PREFIX} effect retry scheduled type=${effect.effectType} id=${effect.id}`, error);
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 执行一次官方目录同步（自动生效的写入端）。网络与文件 IO 集中于此，
 * 分类逻辑纯函数化；写路径走 withPricingConfigMutation 临界区（多进程安全）。
 */
export async function runOfficialCatalogSync(
  dataDir: string,
  options: CatalogSyncRunOptions = {},
): Promise<CatalogSyncRunResult> {
  const now = options.now || (() => new Date());
  await drainCatalogSyncEffects(dataDir, options, now());
  const envelope = await loadProviderCatalog(dataDir, {forceRefresh: options.forceRefresh === true});
  const catalog = envelope.catalog;
  const publishedAt = catalog.publishedAt;
  const preRead = await readPricingConfig(dataDir);
  if (shouldSkipCatalogSync(preRead.catalogSync, catalog)) {
    // 版本闸门命中时只重试尚未完成的后置效果，不重复改写价格中心。
    const usage = await readTargetModelUsage(dataDir);
    const plan = classifyCatalogSync(
      preRead,
      catalog,
      usage,
      listCurrentOfficialMembershipIdentities(getDeepaaDatabase(dataDir)),
    );
    return {
      skippedByVersion: true,
      insertedCount: 0,
      autoUpdatedCount: 0,
      toleranceSilentCount: 0,
      notificationCount: plan.changedModelCount,
      publishedAt,
    };
  }

  const usage = await readTargetModelUsage(dataDir);
  let result: CatalogSyncRunResult;
  await withPricingConfigMutation(dataDir, async () => {
    // 网络期间价格中心可能已被修改：临界区内重读并重分类，保证合并基线最新。
    const current = await readPricingConfig(dataDir);
    const plan = classifyCatalogSync(
      current,
      catalog,
      usage,
      listCurrentOfficialMembershipIdentities(getDeepaaDatabase(dataDir)),
    );
    let next: PricingConfigV2 = current;
    const baselineDb = getDeepaaDatabase(dataDir);
    const sourceEntries = providerCatalogToPricingEntries(catalog, {sourceHash: envelope.sourceHash});
    const currentByIdentity = new Map(current.models.map(entry => [
      `${entry.vendor.trim().toLowerCase()}\u0000${pricingEntryRuntimeModelId(entry).trim().toLowerCase()}`,
      entry,
    ]));
    // 底稿只在来源即将被更高优先级覆盖时创建/更新：
    // LiteLLM → 官方保存旧 LiteLLM；全局人工覆盖期间更新最新官方来源。
    for (const officialEntry of sourceEntries) {
      const identity = `${officialEntry.vendor.trim().toLowerCase()}\u0000${pricingEntryRuntimeModelId(officialEntry).trim().toLowerCase()}`;
      const existing = currentByIdentity.get(identity);
      if (existing?.confidence === "third_party") {
        upsertPricingSourceBaseline(baselineDb, {
          vendor: existing.vendor,
          runtimeModelId: pricingEntryRuntimeModelId(existing),
          sourceKind: "litellm",
          sourceRevision: existing.catalogRevision,
          sourceHash: existing.catalogSourceHash,
          capturedAt: now().toISOString(),
          entry: existing,
        });
      } else if (existing?.confidence === "user_override") {
        upsertPricingSourceBaseline(baselineDb, {
          vendor: officialEntry.vendor,
          runtimeModelId: pricingEntryRuntimeModelId(officialEntry),
          sourceKind: "official",
          sourceRevision: officialEntry.catalogRevision,
          sourceHash: officialEntry.catalogSourceHash,
          capturedAt: now().toISOString(),
          entry: officialEntry,
        });
      }
    }
    if (plan.insertCount > 0 || plan.autoUpdateCount > 0 || plan.membershipChangeCount > 0) {
      next = mergeProviderCatalogPricing(
        current,
        plan.membershipChangeCount > 0 ? catalog : plan.silentCatalog,
        {updateMembership: plan.membershipChangeCount > 0},
      );
    }
    const marker: CatalogSyncMarker = {
      ...next.catalogSync,
      lastSyncedPublishedAt: publishedAt,
      lastSyncedCatalogRevision: catalog.catalogRevision,
      lastSyncedSourceHash: envelope.sourceHash,
      syncedAt: now().toISOString(),
    };
    // 通知历史写入 SQLite（2026-09-10 用户决策）：与价格中心 JSON 解耦，
    // 支持列表化查询（版本号/已阅筛选 + 分页），并在首次写入时续承旧 JSON 记录。
    if (plan.notification) {
      try {
        const db = getDeepaaDatabase(dataDir);
        importLegacyCatalogNotifications(db, next.catalogSync?.notifications);
        recordCatalogNotification(db, plan.notification);
      } catch (error) {
        // 通知落库失败不影响价格自动生效；效果任务负责在版本闸门命中后重试。
        void enqueueEffect(dataDir, {
          catalogRevision: catalog.catalogRevision,
          catalogHash: envelope.sourceHash,
          effectType: "notification",
          payload: plan.notification,
        }, now()).catch(() => undefined);
        console.error(`${LOG_PREFIX} notification record failed`, error);
      }
    }
    next = {...next, catalogSync: marker};
    await writePricingConfig(dataDir, next);
    try {
      syncOfficialCatalogMembership(baselineDb, catalog, now().toISOString());
    } catch (error) {
      void enqueueEffect(dataDir, {
        catalogRevision: catalog.catalogRevision,
        catalogHash: envelope.sourceHash,
        effectType: "membership_projection",
        payload: {
          rows: Object.entries(catalog.providers).flatMap(([catalogKey, provider]) =>
            provider.models.map(model => ({
              catalogKey,
              pricingProviderId: provider.pricingProviderId,
              modelId: model.id,
            }))),
        },
      }, now()).catch(() => undefined);
      console.error(`${LOG_PREFIX} membership projection failed`, error);
    }
    // wireApis 自动跟随（终极方案）：价格中心条目协议能力变化物化到引用目标
    // （代理进程不读价格中心；无实际变化不递增 proxy-config revision）。
    let wireApiFollowed = {updatedTargetCount: 0, patchedModelCount: 0};
    const wireApiChanges = collectWireApiChanges(current, next);
    if (plan.insertCount > 0 || plan.autoUpdateCount > 0 || plan.membershipChangeCount > 0) {
      try {
        wireApiFollowed = await applyWireApiFollowUp(
          await readProxyConfigForFollowUp(dataDir),
          wireApiChanges,
        );
        if (wireApiFollowed.updatedTargetCount > 0) {
          console.info(`${LOG_PREFIX} wireApis followed targets=${wireApiFollowed.updatedTargetCount} models=${wireApiFollowed.patchedModelCount}`);
        }
      } catch (error) {
        // 物化失败不回滚价格同步；效果任务负责后续重试。
        void enqueueEffect(dataDir, {
          catalogRevision: catalog.catalogRevision,
          catalogHash: envelope.sourceHash,
          effectType: "wire_api_follow",
          payload: serializeWireChanges(wireApiChanges),
        }, now()).catch(() => undefined);
        console.error(`${LOG_PREFIX} wireApis follow-up failed`, error);
      }
    }
    // 能力变化定向静默 CLI 同步（2026-09-21 能力下发）：既有模型能力字段
    // （模态/窗口/输出上限/wireApis）变化时，只重写「绑定目标包含该模型且 CLI 同步
    // 开启」的 Agent 受管配置；纯价格变化与新模型不触发。失败只日志，不回滚价格同步
    // （下次同步重新对比补齐）。wireApiFollow 可能已改 proxy-config，重读最新快照。
    if (plan.insertCount > 0 || plan.autoUpdateCount > 0 || plan.membershipChangeCount > 0) {
      try {
        const capabilityModels = collectCapabilityModelChanges(current, next);
        for (const key of wireApiChanges.keys()) capabilityModels.add(key);
        if (capabilityModels.size > 0) {
          const config = await readProxyConfigForFollowUp(dataDir);
          const agents = resolveAgentsForModelChanges(config, capabilityModels);
          if (agents.length > 0) {
            const home = homedir();
            const syncReport = await syncCliConfigs(config, {
              paths: {
                codexConfigPath: join(home, ".codex", "config.toml"),
                codexCatalogPath: join(home, ".codex", "deepaa", "catalogs", "all.json"),
                claudeUserSettingsPath: join(home, ".claude", "settings.json"),
                claudeProjectSettingsPaths: {},
                gatewayBaseUrl: resolveGatewayBaseUrl(config.localProxyBaseUrl),
                gatewayBearerToken: GATEWAY_PLACEHOLDER_TOKEN,
              },
              credentialHelperPath: join(process.cwd(), "bin", "credential-helper.mjs"),
              agents,
              dataDir,
            });
            if (!syncReport.ok) {
              throw new Error(syncReport.errors.join("；") || "cli_config_sync_failed");
            }
            console.info(`${LOG_PREFIX} capability follow-up agents=${agents.join(",")} models=${capabilityModels.size}`);
          }
        }
      } catch (error) {
        const config = await readProxyConfigForFollowUp(dataDir);
        const capabilityModels = collectCapabilityModelChanges(current, next);
        for (const key of wireApiChanges.keys()) capabilityModels.add(key);
        const agents = resolveAgentsForModelChanges(config, capabilityModels);
        void enqueueEffect(dataDir, {
          catalogRevision: catalog.catalogRevision,
          catalogHash: envelope.sourceHash,
          effectType: "cli_config_sync",
          payload: {agents},
        }, now()).catch(() => undefined);
        console.error(`${LOG_PREFIX} capability CLI follow-up failed`, error);
      }
    }
    // revision effective_at 回填（设计七章）：本批存在官方生效时刻且早于当前时间时，
    // 按官方时刻生效——迟到同步后未派生请求按官方边界得到正确新价；已入账请求绝不回算。
    const effectiveAt = plan.notification?.effectiveFrom !== undefined
      && Date.parse(plan.notification.effectiveFrom) < now().getTime()
      ? plan.notification.effectiveFrom
      : now().toISOString();
    try {
      await options.recordRevision?.(dataDir, next, effectiveAt);
    } catch (error) {
      void enqueueEffect(dataDir, {
        catalogRevision: catalog.catalogRevision,
        catalogHash: envelope.sourceHash,
        effectType: "pricing_revision",
        payload: {effectiveAt},
      }, now()).catch(() => undefined);
      // 价格文件已保存；效果任务负责补建版本，不回滚同步。
      console.error(`${LOG_PREFIX} pricing revision record failed`, error);
    }
    result = {
      skippedByVersion: false,
      insertedCount: plan.insertCount,
      autoUpdatedCount: plan.autoUpdateCount,
      toleranceSilentCount: plan.toleranceSilentCount,
      notificationCount: plan.changedModelCount,
      ...(plan.notification?.effectiveFrom ? {effectiveFrom: plan.notification.effectiveFrom} : {}),
      publishedAt,
    };
  });
  return result!;
}

let schedulerStarted = false;

/**
 * 启动一次 + 每 1 小时重复的官方目录同步调度。
 * 定时任务 forceRefresh 刷新目录缓存；失败只打日志，不阻塞 UI/代理/Worker。
 */
export function startOfficialCatalogSyncScheduler(
  dataDir: string,
  intervalMs = 60 * 60 * 1000,
  recordRevision?: (dataDir: string, config: PricingConfigV2, effectiveAt: string) => void | Promise<void>,
): void {
  if (schedulerStarted) return;
  schedulerStarted = true;
  const run = async (forceRefresh: boolean) => {
    try {
      const result = await runOfficialCatalogSync(dataDir, {forceRefresh, recordRevision});
      console.info(
        `${LOG_PREFIX} done version=${result.publishedAt ?? "-"}`
        + ` skipped=${result.skippedByVersion} inserted=${result.insertedCount}`
        + ` autoUpdated=${result.autoUpdatedCount} toleranceSilent=${result.toleranceSilentCount}`
        + ` notify=${result.notificationCount}`,
      );
    } catch (error) {
      console.warn(`${LOG_PREFIX} failed`, error);
    }
  };
  void run(false);
  const timer = setInterval(() => void run(true), intervalMs);
  if (typeof timer.unref === "function") timer.unref();
}

/** 供 API 路由内联使用：读取使用快照 + 分类（只读，不写价格中心）。 */
export async function computeCatalogSyncState(
  dataDir: string,
  pricing: PricingConfigV2,
  catalog: Parameters<typeof classifyCatalogSync>[1],
): Promise<ReturnType<typeof classifyCatalogSync>> {
  const usage = await readTargetModelUsage(dataDir);
  return classifyCatalogSync(
    pricing,
    catalog,
    usage,
    listCurrentOfficialMembershipIdentities(getDeepaaDatabase(dataDir)),
  );
}
