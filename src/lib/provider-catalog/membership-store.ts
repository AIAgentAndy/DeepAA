import type {DeepaaDatabase} from "@/lib/db/sqlite-driver";
import type {ProviderCatalog} from "./types";

/**
 * 把当前目录推荐集合写入独立索引。
 * 该索引只描述“当前官方是否推荐”，不承载价格、目标白名单或历史账本事实。
 */
export function syncOfficialCatalogMembership(
  db: DeepaaDatabase,
  catalog: ProviderCatalog,
  now: string,
): number {
  const revision = catalog.catalogRevision;
  const rows = Object.entries(catalog.providers).flatMap(([catalogKey, provider]) =>
    provider.models.map(model => ({
      catalogKey,
      pricingProviderId: provider.pricingProviderId,
      modelId: model.id,
    })),
  );
  return syncOfficialCatalogMembershipRows(db, revision, rows, now);
}

export function syncOfficialCatalogMembershipRows(
  db: DeepaaDatabase,
  revision: string,
  rows: ReadonlyArray<{catalogKey: string; pricingProviderId: string; modelId: string}>,
  now: string,
): number {
  const transaction = db.transaction(() => {
    const seen = new Set<string>();
    const providerKeys = new Set<string>();
    const upsert = db.prepare(`
      INSERT INTO official_catalog_membership(
        catalog_key, pricing_provider_id, model_id, current_official,
        first_seen_revision, last_seen_revision, first_seen_at, last_seen_at
      ) VALUES(?, ?, ?, 1, ?, ?, ?, ?)
      ON CONFLICT(catalog_key, model_id) DO UPDATE SET
        pricing_provider_id = excluded.pricing_provider_id,
        current_official = 1,
        last_seen_revision = excluded.last_seen_revision,
        last_seen_at = excluded.last_seen_at
    `);
    for (const row of rows) {
      providerKeys.add(row.catalogKey);
      seen.add(`${row.catalogKey}\u0000${row.modelId}`);
      upsert.run(
        row.catalogKey,
        row.pricingProviderId,
        row.modelId,
        revision,
        revision,
        now,
        now,
      );
    }
    const stale = db.prepare(`
      UPDATE official_catalog_membership
      SET current_official = 0, last_seen_revision = ?, last_seen_at = ?
      WHERE catalog_key = ? AND current_official = 1
        AND model_id NOT IN (
          SELECT value FROM json_each(?)
        )
    `);
    for (const catalogKey of providerKeys) {
      const modelIds = rows.filter(row => row.catalogKey === catalogKey).map(row => row.modelId);
      stale.run(revision, now, catalogKey, JSON.stringify(modelIds));
    }
    // 目录已经移除的供应商也必须把旧推荐集合收窄，但不删除索引行。
    const providerKeysJson = JSON.stringify([...providerKeys]);
    db.prepare(`
      UPDATE official_catalog_membership
      SET current_official = 0, last_seen_revision = ?, last_seen_at = ?
      WHERE current_official = 1
        AND catalog_key NOT IN (SELECT value FROM json_each(?))
    `).run(revision, now, providerKeysJson);
    return seen.size;
  });
  return transaction();
}

export interface OfficialCatalogMembershipRow {
  catalogKey: string;
  pricingProviderId: string;
  modelId: string;
  currentOfficial: boolean;
  firstSeenRevision: string;
  lastSeenRevision: string;
}

export function listOfficialCatalogMembership(
  db: DeepaaDatabase,
  catalogKey: string,
): OfficialCatalogMembershipRow[] {
  return db.prepare(`
    SELECT catalog_key AS catalogKey, pricing_provider_id AS pricingProviderId,
           model_id AS modelId, current_official AS currentOfficial,
           first_seen_revision AS firstSeenRevision, last_seen_revision AS lastSeenRevision
    FROM official_catalog_membership
    WHERE catalog_key = ?
    ORDER BY current_official DESC, model_id
  `).all(catalogKey).map(row => ({
    ...(row as Omit<OfficialCatalogMembershipRow, "currentOfficial">),
    currentOfficial: Boolean((row as {currentOfficial: number}).currentOfficial),
  }));
}

export function listCurrentOfficialModelIds(
  db: DeepaaDatabase,
  catalogKey: string,
): Set<string> {
  const rows = db.prepare(`
    SELECT model_id AS modelId
    FROM official_catalog_membership
    WHERE catalog_key = ? AND current_official = 1
  `).all(catalogKey) as Array<{modelId: string}>;
  return new Set(rows.map(row => row.modelId));
}

export function listCurrentOfficialMembershipIdentities(
  db: DeepaaDatabase,
): Set<string> {
  const rows = db.prepare(`
    SELECT catalog_key AS catalogKey,
           pricing_provider_id AS pricingProviderId,
           model_id AS modelId
    FROM official_catalog_membership
    WHERE current_official = 1
  `).all() as Array<{catalogKey: string; pricingProviderId: string; modelId: string}>;
  return new Set(rows.map(row =>
    `${row.catalogKey}\u0000${row.pricingProviderId.trim().toLowerCase()}\u0000${row.modelId.trim().toLowerCase()}`));
}
