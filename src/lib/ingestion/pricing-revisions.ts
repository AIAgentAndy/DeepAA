import { createHash } from "node:crypto";
import type {DeepaaDatabase} from "@/lib/db/sqlite-driver";
import { normalizePricingConfig, type PricingConfigV2 } from "../pricing";

const BASELINE_EFFECTIVE_AT = "1970-01-01T00:00:00.000Z";

interface PricingRevisionRow {
  id: number;
  effective_at: string;
  catalog_hash: string;
  policy_hash: string;
  catalog_json: string;
  policy_json: string;
}

export interface PricingRevisionResult {
  id: number;
  effectiveAt: string;
  created: boolean;
}

/** 按捕获时间恢复的完整价格配置及其版本信息，供账本审计列落库。 */
export interface LoadedPricingConfigAt {
  config: PricingConfigV2;
  revisionId: number;
  effectiveAt: string;
  catalogHash: string;
}

/**
 * 按配置内容拆分并保存价格版本。模型目录和代理策略分别按内容哈希去重，
 * 这样修改一个供应商倍率时不会复制整份大型 LiteLLM 目录。
 */
export function ensurePricingConfigRevision(
  db: DeepaaDatabase,
  config: PricingConfigV2,
  effectiveAt = new Date().toISOString(),
): PricingRevisionResult {
  const normalized = normalizePricingConfig(config);
  const catalog = {
    version: normalized.version,
    currency: normalized.currency,
    unit: normalized.unit,
    sourceCheckedAt: normalized.sourceCheckedAt,
    catalogSource: normalized.catalogSource,
    models: normalized.models,
    unconvertedCatalogPricing: normalized.unconvertedCatalogPricing,
    // fx 快照参与版本（2026-09-15）：目录汇率影响账本 *_cny/*_nano 折算与套餐估算，
    // 纯汇率变化必须产生新版本——此后请求按新汇率入账，历史版本照旧回放。
    fx: normalized.fx,
  };
  const policy = {
    targetOverrides: normalized.targetOverrides,
    targetVendorPreferences: normalized.targetVendorPreferences,
    // 支持模型 → 价格中心条目的供应商映射：Worker 按快照恢复计价时依赖它做同名模型消歧。
    targetModelMappings: normalized.targetModelMappings,
    // 目标级结算系数随 policy 版本化（2026-09-23 方案 B）：它是费用语义字段，与目录 fx
    // 同一红线——不进 blob/哈希的话修改系数永不产生新版本，Worker 恒按旧系数折算。
    targetSettlementFx: normalized.targetSettlementFx,
  };
  // 语义哈希：一次遍历同时产出 catalog/policy 两个语义对象（2026-09-10 性能优化：
  // 原实现各走一遍全量语义投影 + canonicalJson，3375 条模型时是主要耗时之一）。
  const semantics = pricingSemantics(normalized);
  const catalogHash = sha256(canonicalJson(semantics.catalog));
  const policyHash = sha256(canonicalJson(semantics.policy));
  const latest = db.prepare(
    `SELECT id, effective_at, catalog_hash, policy_hash
     FROM pricing_config_revisions
     ORDER BY effective_at DESC, id DESC LIMIT 1`,
  ).get() as Pick<PricingRevisionRow, "id" | "effective_at" | "catalog_hash" | "policy_hash"> | undefined;

  if (latest && latest.catalog_hash === catalogHash && latest.policy_hash === policyHash) {
    return {
      id: latest.id,
      effectiveAt: latest.effective_at,
      created: false,
    };
  }

  const hasRevision = db.prepare(
    "SELECT 1 FROM pricing_config_revisions LIMIT 1",
  ).get() !== undefined;
  const revisionEffectiveAt = hasRevision
    ? normalizeEffectiveAt(effectiveAt)
    : BASELINE_EFFECTIVE_AT;
  const now = new Date().toISOString();

  // blob 只在缺失时才序列化与写入（2026-09-10 性能优化：全量配置可达数 MiB，
  // 每次保存都构造/传输同内容字符串是纯浪费；内容由 hash 唯一确定）。
  const insert = db.transaction(() => {
    if (db.prepare("SELECT 1 FROM pricing_catalog_blobs WHERE hash = ?").get(catalogHash) === undefined) {
      db.prepare(
        `INSERT INTO pricing_catalog_blobs(hash, config_json, created_at)
         VALUES(?, ?, ?)
         ON CONFLICT(hash) DO NOTHING`,
      ).run(catalogHash, canonicalJson(catalog), now);
    }
    if (db.prepare("SELECT 1 FROM pricing_policy_blobs WHERE hash = ?").get(policyHash) === undefined) {
      db.prepare(
        `INSERT INTO pricing_policy_blobs(hash, config_json, created_at)
         VALUES(?, ?, ?)
         ON CONFLICT(hash) DO NOTHING`,
      ).run(policyHash, canonicalJson(policy), now);
    }
    return db.prepare(
      `INSERT INTO pricing_config_revisions(
        effective_at, catalog_hash, policy_hash, created_at
      ) VALUES(?, ?, ?, ?)
      ON CONFLICT(effective_at, catalog_hash, policy_hash) DO UPDATE SET id = id
      RETURNING id, effective_at`,
    ).get(revisionEffectiveAt, catalogHash, policyHash, now) as {
      id: number;
      effective_at: string;
    };
  });
  const row = insert();
  return {
    id: row.id,
    effectiveAt: row.effective_at,
    created: true,
  };
}

/** 根据 raw 请求的捕获时间恢复当时生效的完整价格配置与版本信息。 */
export function loadPricingConfigAt(
  db: DeepaaDatabase,
  capturedAt: string,
): LoadedPricingConfigAt | undefined {
  const capturedTimestamp = Date.parse(capturedAt);
  const normalizedCapturedAt = Number.isFinite(capturedTimestamp)
    ? new Date(capturedTimestamp).toISOString()
    : capturedAt;
  const row = db.prepare(
    `SELECT revisions.id, revisions.effective_at, revisions.catalog_hash,
            catalog.config_json AS catalog_json,
            policy.config_json AS policy_json
     FROM pricing_config_revisions revisions
     JOIN pricing_catalog_blobs catalog ON catalog.hash = revisions.catalog_hash
     JOIN pricing_policy_blobs policy ON policy.hash = revisions.policy_hash
     WHERE revisions.effective_at <= ?
     ORDER BY revisions.effective_at DESC, revisions.id DESC
     LIMIT 1`,
  ).get(normalizedCapturedAt) as PricingRevisionRow | undefined;
  if (!row) return undefined;
  try {
    const catalog = JSON.parse(row.catalog_json) as Record<string, unknown>;
    const policy = JSON.parse(row.policy_json) as Record<string, unknown>;
    return {
      config: normalizePricingConfig({ ...catalog, ...policy, version: 2 }),
      revisionId: row.id,
      effectiveAt: row.effective_at,
      catalogHash: row.catalog_hash,
    };
  } catch {
    // 版本表由程序写入；损坏时让调用方回退当前配置并继续记录请求。
    return undefined;
  }
}

function normalizeEffectiveAt(value: string): string {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : new Date().toISOString();
}

/**
 * 语义哈希输入（2026-09-10 性能优化）：一次调用产出 catalog/policy 两个语义对象。
 * 两者的全量投影由下方两个专用函数承担（字段语义保持单一来源），此处只做组合，
 * 避免调用侧分散遍历顺序、也便于将来合并为真正的单遍实现。
 */
function pricingSemantics(config: PricingConfigV2): {catalog: unknown; policy: unknown} {
  return {
    catalog: catalogPricingSemantics(config),
    policy: policyPricingSemantics(config),
  };
}

/** 只让会改变匹配或费用的字段参与版本哈希，忽略自动导入刷新时间等元数据。 */
function catalogPricingSemantics(config: PricingConfigV2): unknown {
  return {
    currency: config.currency,
    unit: config.unit,
    models: config.models.map(model => ({
      id: model.id,
      vendor: model.vendor,
      match: model.match,
      patterns: model.patterns,
      aliases: model.aliases,
      mode: model.mode,
      litellmProvider: model.litellmProvider,
      pricingProviderId: model.pricingProviderId,
      region: model.region,
      catalogSource: model.catalogSource,
      contextWindow: model.contextWindow,
      maxOutput: model.maxOutput,
      pricing: model.pricing,
      priceSchedules: model.priceSchedules,
      // 促销（按量链）与服务档位价格集参与版本哈希（2026-09-08 断链修复）：
      // 引擎 computeTokenCost 消费这两个字段计费，缺漏会导致促销目录更新后
      // catalog_hash 不变、版本去重短路，Worker 永远按旧牌价计市价。
      promotions: model.promotions,
      serviceTierPricing: model.serviceTierPricing,
      planCreditRules: model.planCreditRules,
      currency: model.currency,
      confidence: model.confidence,
    })),
    unconvertedCatalogPricing: config.unconvertedCatalogPricing,
    // fx 参与语义哈希（2026-09-15）：与 blob 序列化同集合，否则纯汇率更新会因 hash
    // 短路而永不落新版本，Worker 恒按旧汇率折算。
    fx: config.fx,
  };
}

function policyPricingSemantics(config: PricingConfigV2): unknown {
  return {
    targetVendorPreferences: config.targetVendorPreferences,
    targetOverrides: config.targetOverrides?.map(override => ({
      id: override.id,
      targetId: override.targetId,
      agentFingerprintId: override.agentFingerprintId,
      patterns: override.patterns,
      pricing: override.pricing,
      currency: override.currency,
        confidence: override.confidence,
    })),
    // 映射变化必须触发新版本，否则保存供应商选择后 Worker 仍按旧策略计价。
    targetModelMappings: config.targetModelMappings,
    // 结算系数变化必须触发新版本（与 blob 序列化同集合，2026-09-23 方案 B）：
    // 缺漏会因 hash 短路导致改系数不落版本，迟到行与审计回放都拿不到历史系数。
    targetSettlementFx: config.targetSettlementFx,
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalize(item)]),
  );
}
