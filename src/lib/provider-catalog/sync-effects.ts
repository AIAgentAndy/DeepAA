import {randomUUID} from "node:crypto";
import type {DeepaaDatabase} from "@/lib/db/sqlite-driver";

export type CatalogSyncEffectType =
  | "notification"
  | "pricing_revision"
  | "wire_api_follow"
  | "cli_config_sync"
  | "membership_projection";

export type CatalogSyncEffectStatus = "pending" | "running" | "retry_wait" | "succeeded" | "permanent_error";

export interface CatalogSyncEffectInput {
  catalogRevision: string;
  catalogHash: string;
  effectType: CatalogSyncEffectType;
  targetId?: string;
  agentId?: string;
  modelId?: string;
  payload?: unknown;
}

export interface CatalogSyncEffectRow extends CatalogSyncEffectInput {
  id: number;
  status: CatalogSyncEffectStatus;
  attemptCount: number;
  lockedBy?: string;
  nextRetryAt: string;
  lastError?: string;
  payload?: unknown;
  createdAt: string;
  updatedAt: string;
}

const MAX_CLAIM_LIMIT = 100;

export function enqueueCatalogSyncEffects(
  db: DeepaaDatabase,
  effects: readonly CatalogSyncEffectInput[],
  now = new Date().toISOString(),
): number {
  if (effects.length === 0) return 0;
  const insert = db.prepare(`
    INSERT INTO catalog_sync_effects(
      catalog_revision, catalog_hash, effect_type, target_id, agent_id, model_id, payload_json,
      status, attempt_count, next_retry_at, created_at, updated_at
    ) VALUES(@catalogRevision, @catalogHash, @effectType, @targetId, @agentId, @modelId, @payloadJson,
      'pending', 0, @nextRetryAt, @createdAt, @updatedAt)
    ON CONFLICT(catalog_revision, catalog_hash, effect_type, target_id, agent_id, model_id)
    DO NOTHING
  `);
  const transaction = db.transaction((items: readonly CatalogSyncEffectInput[]) => {
    let inserted = 0;
    for (const effect of items) {
      const result = insert.run({
        ...effect,
        targetId: effect.targetId ?? "",
        agentId: effect.agentId ?? "",
        modelId: effect.modelId ?? "",
        payloadJson: JSON.stringify(effect.payload ?? {}),
        nextRetryAt: now,
        createdAt: now,
        updatedAt: now,
      });
      inserted += result.changes;
    }
    return inserted;
  });
  return transaction(effects);
}

export function claimDueCatalogSyncEffects(
  db: DeepaaDatabase,
  now: string,
  ownerId: string = randomUUID(),
  limit = 20,
): CatalogSyncEffectRow[] {
  const boundedLimit = Math.min(Math.max(Math.trunc(limit), 1), MAX_CLAIM_LIMIT);
  const transaction = db.transaction(() => {
    const candidates = db.prepare(`
      SELECT id
      FROM catalog_sync_effects
      WHERE status IN ('pending', 'retry_wait')
        AND next_retry_at <= ?
      ORDER BY id
      LIMIT ?
    `).all(now, boundedLimit) as Array<{id: number}>;
    const update = db.prepare(`
      UPDATE catalog_sync_effects
      SET status = 'running', locked_by = ?, attempt_count = attempt_count + 1, updated_at = ?
      WHERE id = ? AND status IN ('pending', 'retry_wait') AND next_retry_at <= ?
    `);
    const claimedIds = candidates
      .filter(candidate => update.run(ownerId, now, candidate.id, now).changes === 1)
      .map(candidate => candidate.id);
    if (claimedIds.length === 0) return [];
    const rows = db.prepare(`
      SELECT id, catalog_revision AS catalogRevision, catalog_hash AS catalogHash,
             effect_type AS effectType, target_id AS targetId, agent_id AS agentId,
             model_id AS modelId, payload_json AS payloadJson, status, attempt_count AS attemptCount,
             locked_by AS lockedBy, next_retry_at AS nextRetryAt,
             last_error AS lastError, created_at AS createdAt, updated_at AS updatedAt
      FROM catalog_sync_effects
      WHERE id IN (${claimedIds.map(() => "?").join(",")})
      ORDER BY id
    `).all(...claimedIds) as Array<CatalogSyncEffectRow & {payloadJson?: string}>;
    return rows.map(row => {
      let payload: unknown = {};
      try {
        payload = JSON.parse(row.payloadJson || "{}");
      } catch {
        payload = {};
      }
      return {
        ...row,
        targetId: row.targetId || undefined,
        agentId: row.agentId || undefined,
        modelId: row.modelId || undefined,
        payload,
      };
    });
  });
  return transaction();
}

export function markCatalogSyncEffectSucceeded(
  db: DeepaaDatabase,
  id: number,
  now = new Date().toISOString(),
): boolean {
  return db.prepare(`
    UPDATE catalog_sync_effects
    SET status = 'succeeded', locked_by = NULL, last_error = NULL, updated_at = ?
    WHERE id = ? AND status = 'running'
  `).run(now, id).changes === 1;
}

export function markCatalogSyncEffectRetry(
  db: DeepaaDatabase,
  id: number,
  errorMessage: string,
  nextRetryAt: string,
  now = new Date().toISOString(),
): boolean {
  return db.prepare(`
    UPDATE catalog_sync_effects
    SET status = 'retry_wait', locked_by = NULL, last_error = ?, next_retry_at = ?, updated_at = ?
    WHERE id = ? AND status = 'running'
  `).run(errorMessage.slice(0, 2000), nextRetryAt, now, id).changes === 1;
}

export function markCatalogSyncEffectPermanentError(
  db: DeepaaDatabase,
  id: number,
  errorMessage: string,
  now = new Date().toISOString(),
): boolean {
  return db.prepare(`
    UPDATE catalog_sync_effects
    SET status = 'permanent_error', locked_by = NULL, last_error = ?, updated_at = ?
    WHERE id = ? AND status = 'running'
  `).run(errorMessage.slice(0, 2000), now, id).changes === 1;
}
