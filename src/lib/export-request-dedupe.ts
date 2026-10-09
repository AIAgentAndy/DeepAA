import type {DeepaaDatabase} from "@/lib/db/sqlite-driver";
import { CURRENT_PROJECTION_VERSION } from "./ingestion/projection-version";

const MAX_BASELINE_FINGERPRINT_ROWS = 4_096;

type FingerprintMultiset = Map<string, number>;

export type PersistedRequestFreshness = "unique" | "inherited" | "unconfirmed";

export interface PersistedRequestDedupe {
  state: "not_required" | "not_applicable" | "compared" | "unconfirmed";
  comparisonKind: "none" | "same_epoch" | "boundary_carryover";
  baselineExchangeId?: string;
  fingerprintCounts: FingerprintMultiset;
  lineageCounts: FingerprintMultiset;
  idlessCounts: FingerprintMultiset;
}

/**
 * v4 Worker 已在短事务内完成上下文证明。导出只消费该结论和精确基线指纹，
 * 不再根据当前页面位置二次推断 context epoch 或 compaction 边界。
 */
export function loadPersistedRequestDedupe(
  db: DeepaaDatabase,
  exchangeId: string,
): PersistedRequestDedupe | undefined {
  const row = db.prepare(
    `SELECT projection_version, request_filter_state, request_dedupe_state,
       request_comparison_kind, baseline_exchange_id
     FROM exchange_content_filter_status
     WHERE exchange_id = ?`,
  ).get(exchangeId) as {
    projection_version: number;
    request_filter_state: "complete" | "limited";
    request_dedupe_state:
      | "not_required"
      | "not_applicable"
      | "compared"
      | "unconfirmed";
    request_comparison_kind: "none" | "same_epoch" | "boundary_carryover";
    baseline_exchange_id: string | null;
  } | undefined;
  if (!row || row.projection_version !== CURRENT_PROJECTION_VERSION) return undefined;
  if (row.baseline_exchange_id) {
    const baselineProjectionVersion = db.prepare(
      "SELECT projection_version FROM exchange_content_filter_status WHERE exchange_id = ?",
    ).pluck().get(row.baseline_exchange_id) as number | undefined;
    if (baselineProjectionVersion !== CURRENT_PROJECTION_VERSION) return undefined;
  }
  if (
    row.request_dedupe_state !== "unconfirmed"
    && row.request_filter_state !== "complete"
  ) {
    return undefined;
  }
  if (
    row.request_dedupe_state === "compared"
    && (
      !row.baseline_exchange_id
      || (
        row.request_comparison_kind !== "same_epoch"
        && row.request_comparison_kind !== "boundary_carryover"
      )
    )
  ) {
    return undefined;
  }

  const fingerprintCounts = new Map<string, number>();
  const lineageCounts = new Map<string, number>();
  const idlessCounts = new Map<string, number>();
  if (row.request_dedupe_state === "compared" && row.baseline_exchange_id) {
    const fingerprints = db.prepare(
      `SELECT fingerprint, provider_lineage_key, occurrence_count
       FROM exchange_request_fingerprints
       WHERE exchange_id = ? AND body_side = 'request'
       ORDER BY category, fingerprint, provider_lineage_key
       LIMIT ?`,
    ).all(
      row.baseline_exchange_id,
      MAX_BASELINE_FINGERPRINT_ROWS + 1,
    ) as Array<{
      fingerprint: Buffer;
      provider_lineage_key: string;
      occurrence_count: number;
    }>;
    if (fingerprints.length > MAX_BASELINE_FINGERPRINT_ROWS) return undefined;
    for (const row of fingerprints) {
      const fingerprint = row.fingerprint.toString("hex");
      increment(fingerprintCounts, fingerprint, row.occurrence_count);
      if (row.provider_lineage_key) {
        increment(
          lineageCounts,
          lineageFingerprintKey(row.provider_lineage_key, fingerprint),
          row.occurrence_count,
        );
      } else {
        increment(idlessCounts, fingerprint, row.occurrence_count);
      }
    }
  }
  return {
    state: row.request_dedupe_state,
    comparisonKind: row.request_comparison_kind,
    baselineExchangeId: row.baseline_exchange_id ?? undefined,
    fingerprintCounts,
    lineageCounts,
    idlessCounts,
  };
}

export function consumePersistedRequestFreshness(
  persisted: PersistedRequestDedupe,
  item: { fingerprint: string; providerLineageKey?: string },
): PersistedRequestFreshness {
  if (persisted.state === "unconfirmed") return "unconfirmed";
  if (persisted.state !== "compared") return "unique";
  if (persisted.comparisonKind === "same_epoch") {
    return consume(persisted.fingerprintCounts, item.fingerprint)
      ? "inherited"
      : "unique";
  }
  const inherited = item.providerLineageKey
    ? consume(
        persisted.lineageCounts,
        lineageFingerprintKey(item.providerLineageKey, item.fingerprint),
      )
    : consume(persisted.idlessCounts, item.fingerprint);
  return inherited ? "inherited" : "unique";
}

function lineageFingerprintKey(
  providerLineageKey: string,
  fingerprint: string,
): string {
  return JSON.stringify([providerLineageKey, fingerprint]);
}

function increment(
  counts: FingerprintMultiset,
  key: string,
  count: number,
): void {
  counts.set(key, (counts.get(key) ?? 0) + count);
}

function consume(counts: FingerprintMultiset, key: string): boolean {
  const count = counts.get(key) ?? 0;
  if (count <= 0) return false;
  if (count === 1) counts.delete(key);
  else counts.set(key, count - 1);
  return true;
}
