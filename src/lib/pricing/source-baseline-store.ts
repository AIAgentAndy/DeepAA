import type {DeepaaDatabase} from "@/lib/db/sqlite-driver";
import type {ModelPriceEntry} from "../pricing";

export type PricingSourceKind = "official" | "litellm";

export interface PricingSourceBaseline {
  vendor: string;
  runtimeModelId: string;
  sourceKind: PricingSourceKind;
  sourceRevision?: string;
  sourceHash?: string;
  capturedAt: string;
  entry: ModelPriceEntry;
}

export interface StoredPricingSourceBaseline extends PricingSourceBaseline {
  firstSeenAt: string;
  lastSeenAt: string;
}

/**
 * 来源底稿只保存最近一份官方/LiteLLM模型快照，供取消手工覆盖解析；
 * 价格中心当前生效条目和价格版本仍是计价唯一真相，底稿不参与实时计价。
 */
export function upsertPricingSourceBaseline(
  db: DeepaaDatabase,
  baseline: PricingSourceBaseline,
): void {
  const vendor = normalizeIdentityPart(baseline.vendor);
  const runtimeModelId = normalizeIdentityPart(baseline.runtimeModelId);
  const now = baseline.capturedAt;
  const entryJson = JSON.stringify(baseline.entry);
  db.prepare(`
    INSERT INTO pricing_source_baselines(
      vendor, runtime_model_id, source_kind, source_revision, source_hash,
      captured_at, entry_json, first_seen_at, last_seen_at
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(vendor, runtime_model_id, source_kind) DO UPDATE SET
      source_revision = excluded.source_revision,
      source_hash = excluded.source_hash,
      captured_at = excluded.captured_at,
      entry_json = excluded.entry_json,
      last_seen_at = excluded.last_seen_at
  `).run(
    vendor,
    runtimeModelId,
    baseline.sourceKind,
    baseline.sourceRevision ?? null,
    baseline.sourceHash ?? null,
    baseline.capturedAt,
    entryJson,
    now,
    now,
  );
}

export function listPricingSourceBaselines(
  db: DeepaaDatabase,
  vendor: string,
  runtimeModelId: string,
): StoredPricingSourceBaseline[] {
  const rows = db.prepare(`
    SELECT vendor, runtime_model_id AS runtimeModelId, source_kind AS sourceKind,
           source_revision AS sourceRevision, source_hash AS sourceHash,
           captured_at AS capturedAt, entry_json AS entryJson,
           first_seen_at AS firstSeenAt, last_seen_at AS lastSeenAt
    FROM pricing_source_baselines
    WHERE vendor = ? AND runtime_model_id = ?
    ORDER BY CASE source_kind WHEN 'official' THEN 0 ELSE 1 END,
             captured_at DESC
  `).all(normalizeIdentityPart(vendor), normalizeIdentityPart(runtimeModelId)) as Array<Record<string, unknown>>;

  return rows.flatMap(row => {
    try {
      const entry = JSON.parse(String(row.entryJson)) as ModelPriceEntry;
      const sourceKind = row.sourceKind === "official" || row.sourceKind === "litellm"
        ? row.sourceKind
        : undefined;
      if (!sourceKind) return [];
      return [{
        vendor: String(row.vendor),
        runtimeModelId: String(row.runtimeModelId),
        sourceKind,
        ...(typeof row.sourceRevision === "string" ? {sourceRevision: row.sourceRevision} : {}),
        ...(typeof row.sourceHash === "string" ? {sourceHash: row.sourceHash} : {}),
        capturedAt: String(row.capturedAt),
        entry,
        firstSeenAt: String(row.firstSeenAt),
        lastSeenAt: String(row.lastSeenAt),
      }];
    } catch {
      return [];
    }
  });
}

/**
 * 官方底稿优先于 LiteLLM；同一来源只取最近快照。
 * 是否仍属于当前官方推荐集合由 official_catalog_membership 单独决定。
 */
export function resolveLatestPricingSource(
  db: DeepaaDatabase,
  vendor: string,
  runtimeModelId: string,
): StoredPricingSourceBaseline | undefined {
  return listPricingSourceBaselines(db, vendor, runtimeModelId)[0];
}

function normalizeIdentityPart(value: string): string {
  return value.trim().toLowerCase();
}
