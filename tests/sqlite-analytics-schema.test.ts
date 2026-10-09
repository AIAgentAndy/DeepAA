import {describe, expect, test} from "vitest";
import {createSqliteFixture} from "./helpers/sqlite-fixture.js";
import {migrateDeepaaDatabase, SCHEMA_VERSION} from "../src/lib/db/schema.js";

describe("Analytics schema", () => {
  test("迁移后创建小时事实、独立 Worker 状态和账期价值窗口", async () => {
    const fixture = await createSqliteFixture();
    try {
      expect(fixture.db.pragma("user_version", {simple: true})).toBe(SCHEMA_VERSION);
      for (const table of [
        "analytics_hourly_facts",
        "analytics_dirty_buckets",
        "analytics_rollup_runs",
        "analytics_worker_lease",
        "analytics_worker_state",
        "billing_value_windows",
      ]) {
        expect(fixture.db.prepare(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
        ).get(table), table).toBeTruthy();
      }

      const columns = fixture.db.pragma("table_info(usage_ledger)") as Array<{name: string}>;
      const names = new Set(columns.map(column => column.name));
      for (const name of [
        "request_kind",
        "result_class",
        "usage_quality",
        "pricing_status",
        "audit_eligible",
        "derived_total_tokens",
        "provider_total_tokens",
        "total_tokens_basis",
        "reference_price_entry_id",
        "reference_cost_nano",
        "reference_currency",
      ]) {
        expect(names.has(name), name).toBe(true);
      }
    } finally {
      await fixture.cleanup();
    }
  });

  test("迁移可以重复执行且不改变已有账本行", async () => {
    const fixture = await createSqliteFixture();
    try {
      migrateDeepaaDatabase(fixture.db);
      migrateDeepaaDatabase(fixture.db);
      expect(fixture.db.pragma("user_version", {simple: true})).toBe(SCHEMA_VERSION);
      expect(fixture.db.prepare(
        "SELECT COUNT(*) AS count FROM usage_ledger",
      ).get()).toEqual({count: 0});
    } finally {
      await fixture.cleanup();
    }
  });
});
