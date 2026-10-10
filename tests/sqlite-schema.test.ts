import assert from "node:assert/strict";
import {DeepaaDatabase} from "@/lib/db/sqlite-driver";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterEach, describe, test } from "node:test";
import { join, resolve } from "path";
import { resolveDeepaaDataDir } from "../src/lib/data-paths.js";
import {
  getDeepaaDatabase,
  deepaaDatabasePath,
  openDeepaaDatabase,
} from "../src/lib/db/connection.js";
import {
  migrateDeepaaDatabase,
  SCHEMA_VERSION,
} from "../src/lib/db/schema.js";
import type { SqliteFixture } from "./helpers/sqlite-fixture.js";
import {
  createSqliteFixture,
  createUnmigratedSqliteFixture,
} from "./helpers/sqlite-fixture.js";

const fixtures: SqliteFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});

describe("SQLite schema", () => {
  test("连接边界统一走 sqlite-driver（node:sqlite，2026-10-08 切换）", async () => {
    const source = await readFile(
      new URL("../src/lib/db/connection.ts", import.meta.url),
      "utf8",
    );

    assert.match(source, /import \{DeepaaDatabase\} from "\.\/sqlite-driver"/);
    assert.doesNotMatch(
      source,
      /better-sqlite3|typeof Bun|BunDatabaseCompatibility|as unknown as DeepaaDatabase/,
    );
    const driverSource = await readFile(
      new URL("../src/lib/db/sqlite-driver.ts", import.meta.url),
      "utf8",
    );
    assert.match(driverSource, /from "node:sqlite"/);
  });

  test("创建全部派生表并启用关键 PRAGMA", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);

    const names = fixture.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all()
      .map((row) => (row as { name: string }).name);

    assert.deepEqual(names, [
      "agent_local_identity_links",
      "agent_local_import_seen",
      "agent_local_import_state",
      "agent_prompt_skeletons",
      "agent_sessions",
      "agent_steps",
      "agent_threads",
      "agent_turns",
      "analytics_dirty_buckets",
      "analytics_hourly_facts",
      "analytics_rollup_runs",
      "analytics_worker_lease",
      "analytics_worker_state",
      "auxiliary_requests",
      "balance_snapshots",
      "billing_value_windows",
      "catalog_sync_effects",
      "catalog_update_notifications",
      "console_accounts",
      "context_snapshots",
      "credential_rate_snapshots",
      "derivation_diagnostics",
      "derivation_jobs",
      "exchange_content_category_stats",
      "exchange_content_filter_status",
      "exchange_content_previews",
      "exchange_media_descriptors",
      "exchange_request_fingerprints",
      "harness_backfill_state",
      "harness_snapshots",
      "ingestion_records",
      "ingestion_sources",
      "learning_insights",
      "official_catalog_membership",
      "plan_estimate_settlements",
      "plan_quota_snapshots",
      "plan_sync_configs",
      "pricing_catalog_blobs",
      "pricing_config_revisions",
      "pricing_policy_blobs",
      "pricing_source_baselines",
      "raw_exchange_refs",
      "reconciliation_windows",
      "relay_local_usage_events",
      "relay_pending_ingestions",
      "relay_reconciliation_hours",
      "relay_reconciliation_matches",
      "relay_site_backoff",
      "schema_meta",
      "scope_aggregates",
      "step_diffs",
      "sync_runs",
      "thread_closure",
      "tool_calls",
      "usage_ledger",
      "worker_lease",
    ]);
    assert.equal(
      fixture.db.pragma("journal_mode", { simple: true }),
      "wal",
    );
    assert.equal(fixture.db.pragma("foreign_keys", { simple: true }), 1);
    assert.equal(fixture.db.pragma("busy_timeout", { simple: true }), 5000);
    assert.equal(fixture.db.pragma("cache_size", { simple: true }), -16384);
    assert.equal(fixture.db.pragma("synchronous", { simple: true }), 1);
    assert.equal(
      fixture.db.pragma("wal_autocheckpoint", { simple: true }),
      1000,
    );
    assert.equal(fixture.db.pragma("user_version", {simple: true}), SCHEMA_VERSION);
    const quotaColumns = fixture.db.pragma("table_info(plan_quota_snapshots)") as Array<{name: string}>;
    assert.equal(quotaColumns.some(column => column.name === "remaining"), true);
    assert.equal(hasIndex(fixture.db, "idx_plan_sync_configs_next_sync"), true);
    assert.equal(hasIndex(fixture.db, "idx_plan_quota_target_time"), true);
    assert.equal(hasIndex(fixture.db, "idx_relay_reconciliation_due"), true);
    assert.equal(hasIndex(fixture.db, "idx_relay_local_usage_hour"), true);
    assert.equal(hasIndex(fixture.db, "idx_relay_pending_ingestions_hour"), true);
  });

  test("v44 到 v45 仅新增空的中转站对账表，不重写旧五分钟窗口与账本", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    fixture.db.prepare(
      `INSERT INTO reconciliation_windows(
        target_id,window_start,window_end,site_spend,local_spend,diff_amount,
        currency,status,created_at
      ) VALUES('legacy','2026-09-24T01:00:00Z','2026-09-24T01:05:00Z',
        1,0,1,'USD','needs_review','2026-09-24T01:05:00Z')`,
    ).run();
    // 仅在独立临时 fixture 模拟旧 v44：drop 本测试刚创建的空 v45 表。
    fixture.db.exec(
      `DROP TABLE relay_reconciliation_matches;
       DROP TABLE relay_reconciliation_hours;
       DROP TABLE relay_local_usage_events;
       DROP TABLE relay_pending_ingestions;
       ALTER TABLE schema_meta DROP COLUMN last_source_scan_completed_at;`,
    );
    fixture.db.pragma("user_version = 44");
    migrateDeepaaDatabase(fixture.db);
    assert.equal(fixture.db.pragma("user_version", {simple: true}), SCHEMA_VERSION);
    assert.equal(fixture.db.prepare(
      "SELECT COUNT(*) FROM reconciliation_windows WHERE target_id='legacy'",
    ).pluck().get(), 1);
    assert.equal(fixture.db.prepare(
      "SELECT COUNT(*) FROM relay_local_usage_events",
    ).pluck().get(), 0);
    assert.equal(fixture.db.prepare(
      "SELECT COUNT(*) FROM relay_reconciliation_hours",
    ).pluck().get(), 0);
    assert.equal(fixture.db.prepare(
      "SELECT COUNT(*) FROM relay_pending_ingestions",
    ).pluck().get(), 0);
    assert.ok((fixture.db.pragma("table_info(schema_meta)") as Array<{name: string}>)
      .some(column => column.name === "last_source_scan_completed_at"));
  });

  test("v45 到 v46 增量迁移：退避表、轻量复查列与 weak 置信度且保留既有匹配行", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    fixture.db.prepare(
      `INSERT INTO relay_reconciliation_hours(
        target_id,hour_start_utc,provider_type,console_account_id,created_at,updated_at
      ) VALUES('target-1','2026-09-24T05:00:00.000Z','sub2api','account-1',
        '2026-09-24T05:00:00.000Z','2026-09-24T05:00:00.000Z')`,
    ).run();
    fixture.db.prepare(
      `INSERT INTO relay_reconciliation_matches(
        target_id,hour_start_utc,provider_type,site_log_id,exchange_id,confidence,
        site_amount_nano,local_amount_nano,adjustment_nano,created_at
      ) VALUES('target-1','2026-09-24T05:00:00.000Z','sub2api','log-1','ex-1','exact',
        100,100,0,'2026-09-24T07:00:00.000Z')`,
    ).run();
    // 模拟旧 v45：退避表、轻量复查列不存在，matches CHECK 不含 weak。
    fixture.db.exec(
      `DROP TABLE relay_site_backoff;
       ALTER TABLE relay_reconciliation_hours DROP COLUMN site_light_check;
       DROP TABLE relay_reconciliation_matches;
       CREATE TABLE relay_reconciliation_matches(
         target_id TEXT NOT NULL,
         hour_start_utc TEXT NOT NULL,
         provider_type TEXT NOT NULL,
         site_log_id TEXT NOT NULL,
         exchange_id TEXT NOT NULL,
         confidence TEXT NOT NULL CHECK(confidence IN ('exact', 'high')),
         site_amount_nano INTEGER NOT NULL,
         local_amount_nano INTEGER NOT NULL,
         adjustment_nano INTEGER NOT NULL,
         adjustment_exchange_id TEXT,
         revision INTEGER NOT NULL DEFAULT 1,
         created_at TEXT NOT NULL,
         PRIMARY KEY(target_id, provider_type, site_log_id),
         UNIQUE(exchange_id),
         FOREIGN KEY(target_id, hour_start_utc)
           REFERENCES relay_reconciliation_hours(target_id, hour_start_utc)
       );
       INSERT INTO relay_reconciliation_matches(
         target_id,hour_start_utc,provider_type,site_log_id,exchange_id,confidence,
         site_amount_nano,local_amount_nano,adjustment_nano,created_at
       ) VALUES('target-1','2026-09-24T05:00:00.000Z','sub2api','log-1','ex-1','exact',
         100,100,0,'2026-09-24T07:00:00.000Z');`,
    );
    fixture.db.pragma("user_version = 45");
    migrateDeepaaDatabase(fixture.db);
    assert.equal(fixture.db.pragma("user_version", {simple: true}), SCHEMA_VERSION);
    assert.ok(hasTable(fixture.db, "relay_site_backoff"));
    assert.ok((fixture.db.pragma("table_info(relay_reconciliation_hours)") as Array<{name: string}>)
      .some(column => column.name === "site_light_check"));
    assert.deepEqual(fixture.db.prepare(
      "SELECT exchange_id,confidence,site_amount_nano FROM relay_reconciliation_matches",
    ).all(), [{exchange_id: "ex-1", confidence: "exact", site_amount_nano: 100}]);
    assert.equal(hasIndex(fixture.db, "idx_relay_reconciliation_matches_hour"), true);
    // weak 置信度在新 CHECK 下可写入且被唯一键约束保护。
    fixture.db.prepare(
      `INSERT INTO relay_reconciliation_matches(
        target_id,hour_start_utc,provider_type,site_log_id,exchange_id,confidence,
        site_amount_nano,local_amount_nano,adjustment_nano,created_at
      ) VALUES('target-1','2026-09-24T05:00:00.000Z','sub2api','log-2','ex-2','weak',
        50,40,10,'2026-09-24T07:00:00.000Z')`,
    ).run();
    assert.throws(() => fixture.db.prepare(
      `INSERT INTO relay_reconciliation_matches(
        target_id,hour_start_utc,provider_type,site_log_id,exchange_id,confidence,
        site_amount_nano,local_amount_nano,adjustment_nano,created_at
      ) VALUES('target-1','2026-09-24T05:00:00.000Z','sub2api','log-3','ex-3','guessed',
        1,1,0,'2026-09-24T07:00:00.000Z')`,
    ).run());
  });

  test("v46 到 v47 增量迁移：matches 增折扣证据列与挂靠索引，既有匹配行逐一保留", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    fixture.db.prepare(
      `INSERT INTO relay_reconciliation_hours(
        target_id,hour_start_utc,provider_type,console_account_id,created_at,updated_at
      ) VALUES('target-1','2026-09-24T05:00:00.000Z','sub2api','account-1',
        '2026-09-24T05:00:00.000Z','2026-09-24T05:00:00.000Z')`,
    ).run();
    fixture.db.prepare(
      `INSERT INTO relay_reconciliation_matches(
        target_id,hour_start_utc,provider_type,site_log_id,exchange_id,confidence,
        site_amount_nano,local_amount_nano,adjustment_nano,adjustment_exchange_id,created_at
      ) VALUES('target-1','2026-09-24T05:00:00.000Z','sub2api','log-1','ex-1','exact',
        100,120,-20,'recon:matched:legacy','2026-09-24T07:00:00.000Z')`,
    ).run();
    // 模拟旧 v46：折扣证据列与挂靠索引尚不存在。
    fixture.db.exec(
      `DROP INDEX idx_relay_reconciliation_matches_adjustment;
       ALTER TABLE relay_reconciliation_matches DROP COLUMN site_discount_nano;`,
    );
    fixture.db.pragma("user_version = 46");
    migrateDeepaaDatabase(fixture.db);
    assert.equal(fixture.db.pragma("user_version", {simple: true}), SCHEMA_VERSION);
    assert.ok((fixture.db.pragma("table_info(relay_reconciliation_matches)") as Array<{name: string}>)
      .some(column => column.name === "site_discount_nano"));
    assert.equal(hasIndex(fixture.db, "idx_relay_reconciliation_matches_adjustment"), true);
    // 既有匹配行金额与挂靠逐一保留；折扣列对历史行为 NULL（不回填，轻量复查键未变不重拉）。
    assert.deepEqual(fixture.db.prepare(
      `SELECT exchange_id,adjustment_nano,adjustment_exchange_id,site_discount_nano
       FROM relay_reconciliation_matches`,
    ).all(), [{
      exchange_id: "ex-1", adjustment_nano: -20,
      adjustment_exchange_id: "recon:matched:legacy", site_discount_nano: null,
    }]);
    // 新列可写入声明值（NOT NULL 约束不存在，历史与无声明站点共存）。
    fixture.db.prepare(
      `UPDATE relay_reconciliation_matches SET site_discount_nano=20 WHERE site_log_id='log-1'`,
    ).run();
    assert.equal(fixture.db.prepare(
      "SELECT site_discount_nano FROM relay_reconciliation_matches WHERE site_log_id='log-1'",
    ).pluck().get(), 20);
  });

  test("v47 到 v48 增量迁移：小时表增残差自动补幂等列，既有小时行默认零", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    fixture.db.prepare(
      `INSERT INTO relay_reconciliation_hours(
        target_id,hour_start_utc,provider_type,console_account_id,status,
        applied_amount_nano,manual_revision,created_at,updated_at
      ) VALUES('target-1','2026-09-24T05:00:00.000Z','sub2api','account-1','applied',
        900,'1','2026-09-24T05:00:00.000Z','2026-09-24T07:00:00.000Z')`,
    ).run();
    // 模拟旧 v47：残差幂等列尚不存在。
    fixture.db.exec(
      `ALTER TABLE relay_reconciliation_hours DROP COLUMN residual_revision;
       ALTER TABLE relay_reconciliation_hours DROP COLUMN residual_applied_nano;`,
    );
    fixture.db.pragma("user_version = 47");
    migrateDeepaaDatabase(fixture.db);
    assert.equal(fixture.db.pragma("user_version", {simple: true}), SCHEMA_VERSION);
    const columns = fixture.db.pragma(
      "table_info(relay_reconciliation_hours)",
    ) as Array<{name: string}>;
    assert.ok(columns.some(column => column.name === "residual_revision"));
    assert.ok(columns.some(column => column.name === "residual_applied_nano"));
    // 既有小时行默认 0/0，不回填也不改写人工补差状态。
    assert.deepEqual(fixture.db.prepare(
      `SELECT status,applied_amount_nano,manual_revision,residual_revision,residual_applied_nano
       FROM relay_reconciliation_hours`,
    ).all(), [{
      status: "applied", applied_amount_nano: 900, manual_revision: 1,
      residual_revision: 0, residual_applied_nano: 0,
    }]);
  });

  test("v49 到 v50 增量迁移：matches 增用量载体列与站点 token 证据列，既有匹配行默认零", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    fixture.db.prepare(
      `INSERT INTO relay_reconciliation_hours(
        target_id,hour_start_utc,provider_type,console_account_id,status,
        created_at,updated_at
      ) VALUES('target-1','2026-09-24T05:00:00.000Z','sub2api','account-1','applied',
        '2026-09-24T05:00:00.000Z','2026-09-24T07:00:00.000Z')`,
    ).run();
    fixture.db.prepare(
      `INSERT INTO relay_reconciliation_matches(
        target_id,hour_start_utc,provider_type,site_log_id,exchange_id,confidence,
        site_amount_nano,local_amount_nano,adjustment_nano,adjustment_exchange_id,
        revision,created_at
      ) VALUES('target-1','2026-09-24T05:00:00.000Z','sub2api','log-1','ex-1','exact',
        100,80,20,'recon:matched:legacy',1,'2026-09-24T07:00:00.000Z')`,
    ).run();
    // 模拟旧 v49：载体列与 token 证据列尚不存在。
    fixture.db.exec(
      `ALTER TABLE relay_reconciliation_matches DROP COLUMN usage_carrier;
       ALTER TABLE relay_reconciliation_matches DROP COLUMN site_input_tokens;
       ALTER TABLE relay_reconciliation_matches DROP COLUMN site_cache_read_tokens;
       ALTER TABLE relay_reconciliation_matches DROP COLUMN site_cache_write_tokens;
       ALTER TABLE relay_reconciliation_matches DROP COLUMN site_output_tokens;
       ALTER TABLE relay_reconciliation_matches DROP COLUMN site_duration_ms;`,
    );
    fixture.db.pragma("user_version = 49");
    migrateDeepaaDatabase(fixture.db);
    assert.equal(fixture.db.pragma("user_version", {simple: true}), SCHEMA_VERSION);
    const columns = fixture.db.pragma(
      "table_info(relay_reconciliation_matches)",
    ) as Array<{name: string}>;
    for (const column of ["usage_carrier", "site_input_tokens", "site_cache_read_tokens",
      "site_cache_write_tokens", "site_output_tokens", "site_duration_ms"]) {
      assert.ok(columns.some(item => item.name === column), `缺少列 ${column}`);
    }
    // 存量匹配行不回填（2026-09-29 用户确认）：载体默认 0、token 证据保持 NULL。
    assert.deepEqual(fixture.db.prepare(
      `SELECT usage_carrier,site_input_tokens,site_duration_ms,adjustment_nano
       FROM relay_reconciliation_matches WHERE site_log_id='log-1'`,
    ).all(), [{usage_carrier: 0, site_input_tokens: null,
      site_duration_ms: null, adjustment_nano: 20}]);
  });

  test("套餐同步配置按目标唯一且快照可按 credential/window 有界读取", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    fixture.db.prepare(`
      INSERT INTO plan_sync_configs(
        id, target_id, provider_type, credential_id, status, created_at, updated_at
      ) VALUES('plan-1', 'target-1', 'kimi-coding', 'cred-1', 'idle', ?, ?)
    `).run(new Date().toISOString(), new Date().toISOString());
    assert.throws(() => fixture.db.prepare(`
      INSERT INTO plan_sync_configs(
        id, target_id, provider_type, credential_id, status, created_at, updated_at
      ) VALUES('plan-2', 'target-1', 'kimi-coding', 'cred-2', 'idle', ?, ?)
    `).run(new Date().toISOString(), new Date().toISOString()));
    fixture.db.prepare(`
      INSERT INTO plan_quota_snapshots(
        target_id, plan_sync_id, credential_id, provider_type, window_label,
        used, total, unit, raw_json, captured_at
      ) VALUES('target-1', 'plan-1', 'cred-1', 'kimi-coding', '5h', 1, 10, 'requests', '{}', ?)
    `).run(new Date().toISOString());
    assert.equal(
      fixture.db.prepare("SELECT COUNT(*) AS count FROM plan_quota_snapshots WHERE target_id = 'target-1'").get().count,
      1,
    );
  });

  test("新建库使用统一会话语义筛选 schema", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);

    const statusColumns = fixture.db.pragma(
      "table_info(exchange_content_filter_status)",
    ) as Array<{ name: string }>;
    assert.deepEqual(
      [
        "request_context_mode",
        "request_comparison_kind",
        "request_context_epoch",
        "effective_context_boundary_id",
        "produced_context_boundary_id",
      ].filter(name => statusColumns.some(column => column.name === name)),
      [
        "request_context_mode",
        "request_comparison_kind",
        "request_context_epoch",
        "effective_context_boundary_id",
        "produced_context_boundary_id",
      ],
    );

    const fingerprintColumns = fixture.db.pragma(
      "table_info(exchange_request_fingerprints)",
    ) as Array<{ name: string; pk: number; notnull: number }>;
    assert.deepEqual(
      fingerprintColumns
        .filter(column => column.pk > 0)
        .sort((left, right) => left.pk - right.pk)
        .map(column => column.name),
      [
        "exchange_id",
        "body_side",
        "category",
        "fingerprint",
        "provider_lineage_key",
      ],
    );
    assert.equal(
      fingerprintColumns.find(
        column => column.name === "provider_lineage_key",
      )?.notnull,
      1,
    );

    const statsColumns = fixture.db.pragma(
      "table_info(exchange_content_category_stats)",
    ) as Array<{ name: string; pk: number }>;
    assert.deepEqual(
      statsColumns
        .filter(column => column.pk > 0)
        .sort((left, right) => left.pk - right.pk)
        .map(column => column.name),
      ["exchange_id", "body_side", "category"],
    );

    const tableSql = fixture.db.prepare(
      `SELECT name, sql FROM sqlite_master
       WHERE type = 'table'
         AND name IN(
           'exchange_request_fingerprints',
           'exchange_content_category_stats'
         )
       ORDER BY name`,
    ).all() as Array<{ name: string; sql: string }>;
    for (const row of tableSql) {
      for (const category of [
        "refusal",
        "control",
        "unknown_input",
        "unknown_output",
      ]) {
        assert.match(row.sql, new RegExp(`'${category}'`, "u"));
      }
    }

    assert.equal(hasIndex(fixture.db, "idx_content_filter_context"), true);
    assert.equal(hasIndex(fixture.db, "idx_content_category_side_match"), true);
  });

  test("Worker 当前投影版本固定为 7（三协议语义修复批）", async () => {
    const workerSource = await readFile(
      new URL("../src/lib/ingestion/worker.ts", import.meta.url),
      "utf8",
    );
    const versionSource = await readFile(
      new URL("../src/lib/ingestion/projection-version.ts", import.meta.url),
      "utf8",
    );
    assert.match(workerSource, /CURRENT_PROJECTION_VERSION.*projection-version/u);
    assert.match(versionSource, /CURRENT_PROJECTION_VERSION\s*=\s*7/u);
  });

  test("创建查询所需索引并记录版本", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);

    const names = fixture.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all()
      .map((row) => (row as { name: string }).name);
    const meta = fixture.db
      .prepare("SELECT schema_version FROM schema_meta WHERE id = 1")
      .get() as { schema_version: number };

    const expectedIndexes = [
      "idx_raw_capture_time",
      "idx_sessions_external",
      "idx_sessions_conversation",
      "idx_sessions_global_latest",
      "idx_sessions_latest",
      "idx_sessions_target_agent_latest",
      "idx_steps_latest",
      "idx_steps_session_time",
      "idx_steps_thread_time",
      "idx_steps_turn_time",
      "idx_aux_session_time",
      "idx_aux_thread_time",
      "idx_aux_turn_time",
      "idx_diagnostics_dedupe",
      "idx_content_category_match",
      "idx_content_filter_status_state",
      "idx_thread_closure_descendant",
      "idx_threads_agent",
      "idx_threads_children",
      "idx_threads_external",
      "idx_threads_root",
      "idx_tools_session_name",
      "idx_tools_thread_name",
      "idx_tools_turn_use",
      "idx_tools_turn_step_name_status",
      "idx_tools_turn_name",
      "idx_turns_native",
      "idx_turns_open",
      "idx_turns_segment",
      "idx_turns_latest",
      "idx_usage_global_time",
      "idx_usage_session_time",
      "idx_usage_thread_time",
      "idx_usage_turn_time",
      "idx_usage_billing_channel",
      "idx_usage_vendor_family",
    ];
    for (const indexName of expectedIndexes) {
      assert.ok(names.includes(indexName), `缺少索引 ${indexName}`);
    }
    assert.equal(
      fixture.db.pragma("user_version", { simple: true }),
      SCHEMA_VERSION,
    );
    assert.equal(meta.schema_version, SCHEMA_VERSION);
  });

  test("目标级辅助请求不强制伪造 Session 和 Thread", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);

    const auxiliaryColumns = fixture.db.pragma("table_info(auxiliary_requests)") as Array<{
      name: string;
      notnull: 0 | 1;
    }>;
    const ledgerColumns = fixture.db.pragma("table_info(usage_ledger)") as Array<{
      name: string;
      notnull: 0 | 1;
    }>;
    const auxiliaryByName = new Map(auxiliaryColumns.map(column => [column.name, column]));
    const ledgerByName = new Map(ledgerColumns.map(column => [column.name, column]));

    assert.equal(auxiliaryByName.get("agent_session_id")?.notnull, 0);
    assert.equal(auxiliaryByName.get("agent_thread_id")?.notnull, 0);
    assert.equal(auxiliaryByName.get("target_id")?.notnull, 1);
    assert.equal(auxiliaryByName.get("agent_fingerprint_id")?.notnull, 1);
    assert.equal(auxiliaryByName.get("agent_name")?.notnull, 1);
    assert.equal(ledgerByName.get("agent_session_id")?.notnull, 0);
    assert.equal(ledgerByName.get("agent_thread_id")?.notnull, 0);
    assert.equal(ledgerByName.get("reasoning_tokens")?.notnull, 1);
    assert.equal(ledgerByName.get("total_tokens")?.notnull, 1);
    assert.equal(ledgerByName.get("currency")?.notnull, 1);
    assert.equal(ledgerByName.get("billing_channel")?.notnull, 0);
    assert.equal(ledgerByName.get("vendor_family")?.notnull, 0);
    assert.equal(hasIndex(fixture.db, "idx_usage_billing_channel"), true);
    assert.equal(hasIndex(fixture.db, "idx_usage_vendor_family"), true);
    assert.equal(hasIndex(fixture.db, "idx_aux_target_time"), true);
  });

  test("v16 存量库升级 v17 自动补计费通道列与索引", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    fixture.db.exec("DROP INDEX IF EXISTS idx_usage_billing_channel");
    fixture.db.exec("DROP INDEX IF EXISTS idx_usage_vendor_family");
    fixture.db.exec("ALTER TABLE usage_ledger DROP COLUMN billing_channel");
    fixture.db.exec("ALTER TABLE usage_ledger DROP COLUMN vendor_family");
    fixture.db.pragma("user_version = 16");
    fixture.db.close();

    const migrated = openDeepaaDatabase({ dataDir: fixture.dataDir });
    try {
      const columns = migrated.pragma("table_info(usage_ledger)") as Array<{ name: string }>;
      assert.equal(columns.map(column => column.name).includes("billing_channel"), true);
      assert.equal(columns.map(column => column.name).includes("vendor_family"), true);
      assert.equal(hasIndex(migrated, "idx_usage_billing_channel"), true);
      assert.equal(hasIndex(migrated, "idx_usage_vendor_family"), true);
      assert.equal(migrated.pragma("user_version", { simple: true }), SCHEMA_VERSION);
    } finally {
      migrated.close();
    }
  });

  test("v17 存量库升级 v18 自动补套餐积分列", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    fixture.db.exec("ALTER TABLE usage_ledger DROP COLUMN plan_credit_cost");
    fixture.db.exec("ALTER TABLE usage_ledger DROP COLUMN plan_credit_unit");
    fixture.db.exec("ALTER TABLE usage_ledger DROP COLUMN plan_credit_formula_version");
    fixture.db.pragma("user_version = 17");
    fixture.db.close();

    const migrated = openDeepaaDatabase({ dataDir: fixture.dataDir });
    try {
      const columns = migrated.pragma("table_info(usage_ledger)") as Array<{ name: string }>;
      const names = columns.map(column => column.name);
      assert.equal(names.includes("plan_credit_cost"), true);
      assert.equal(names.includes("plan_credit_unit"), true);
      assert.equal(names.includes("plan_credit_formula_version"), true);
      assert.equal(migrated.pragma("user_version", { simple: true }), SCHEMA_VERSION);
      assert.equal(SCHEMA_VERSION, 53);
      assert.equal(hasTable(migrated, "pricing_source_baselines"), true);
    } finally {
      migrated.close();
    }
  });

  test("v18 存量库升级 v19 自动补 Agent 证据列且不建索引", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    fixture.db.exec("ALTER TABLE raw_exchange_refs DROP COLUMN wire_api");
    fixture.db.exec("ALTER TABLE agent_steps DROP COLUMN native_step_id");
    fixture.db.exec("ALTER TABLE agent_steps DROP COLUMN identity_source");
    fixture.db.exec("ALTER TABLE agent_steps DROP COLUMN identity_confidence");
    fixture.db.pragma("user_version = 18");
    fixture.db.close();

    const migrated = openDeepaaDatabase({ dataDir: fixture.dataDir });
    try {
      const refColumns = migrated.pragma("table_info(raw_exchange_refs)") as Array<{
        name: string;
        notnull: 0 | 1;
      }>;
      const stepColumns = migrated.pragma("table_info(agent_steps)") as Array<{
        name: string;
        notnull: 0 | 1;
      }>;
      const refByName = new Map(refColumns.map(column => [column.name, column]));
      const stepByName = new Map(stepColumns.map(column => [column.name, column]));
      assert.equal(refByName.get("wire_api")?.notnull, 0);
      assert.equal(stepByName.get("native_step_id")?.notnull, 0);
      assert.equal(stepByName.get("identity_source")?.notnull, 0);
      assert.equal(stepByName.get("identity_confidence")?.notnull, 0);
      assert.equal(hasIndex(migrated, "idx_raw_wire_api"), false);
      assert.equal(hasIndex(migrated, "idx_steps_native_step_id"), false);
      assert.equal(migrated.pragma("user_version", { simple: true }), SCHEMA_VERSION);
      assert.equal(SCHEMA_VERSION, 53);
    } finally {
      migrated.close();
    }
  });

  test("v21 存量库升级 v22 自动补同步周期列并回填 30 分钟", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    const now = new Date().toISOString();
    fixture.db.prepare(`
      INSERT INTO console_accounts(
        id, target_id, provider_type, console_base_url, username, password_ref,
        login_mode, status, created_at, updated_at, sync_interval_minutes
      ) VALUES('console_t1', 'target-1', 'newapi', 'https://console.example.com', 'u', 'target-1',
        'http', 'idle', ?, ?, 5)
    `).run(now, now);
    fixture.db.prepare(`
      INSERT INTO plan_sync_configs(
        id, target_id, provider_type, status, created_at, updated_at, sync_interval_minutes
      ) VALUES('plan_t1', 'target-1', 'kimi-coding', 'idle', ?, ?, 1)
    `).run(now, now);
    fixture.db.exec("ALTER TABLE console_accounts DROP COLUMN sync_interval_minutes");
    fixture.db.exec("ALTER TABLE plan_sync_configs DROP COLUMN sync_interval_minutes");
    fixture.db.pragma("user_version = 21");
    fixture.db.close();

    const migrated = openDeepaaDatabase({ dataDir: fixture.dataDir });
    try {
      const accountColumns = migrated.pragma("table_info(console_accounts)") as Array<{ name: string }>;
      const planColumns = migrated.pragma("table_info(plan_sync_configs)") as Array<{ name: string }>;
      assert.equal(accountColumns.map(column => column.name).includes("sync_interval_minutes"), true);
      assert.equal(planColumns.map(column => column.name).includes("sync_interval_minutes"), true);
      // 存量行按列默认值回填 30 分钟，保持既有同步节奏。
      assert.equal(migrated.prepare(
        "SELECT sync_interval_minutes FROM console_accounts WHERE target_id = 'target-1'",
      ).pluck().get(), 30);
      assert.equal(migrated.prepare(
        "SELECT sync_interval_minutes FROM plan_sync_configs WHERE target_id = 'target-1'",
      ).pluck().get(), 30);
      assert.equal(migrated.pragma("user_version", { simple: true }), SCHEMA_VERSION);
      assert.equal(SCHEMA_VERSION, 53);
    } finally {
      migrated.close();
    }
  });

  test("v9 目标级辅助桶迁移时保留账本并删除伪 Session 层级", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    downgradeToLegacyV9WithAuxiliaryBucket(fixture.db);
    fixture.db.close();

    const migrated = openDeepaaDatabase({ dataDir: fixture.dataDir });
    try {
      assert.equal(migrated.pragma("user_version", { simple: true }), SCHEMA_VERSION);
      assert.deepEqual(
        migrated.prepare(
          `SELECT agent_session_id, agent_thread_id, agent_turn_id,
            target_id, agent_fingerprint_id, agent_name, kind
          FROM auxiliary_requests WHERE exchange_id = 'aux-exchange'`,
        ).get(),
        {
          agent_session_id: null,
          agent_thread_id: null,
          agent_turn_id: null,
          target_id: "target-1",
          agent_fingerprint_id: "fingerprint-aux",
          agent_name: "codex",
          kind: "metadata",
        },
      );
      assert.deepEqual(
        migrated.prepare(
          `SELECT agent_session_id, agent_thread_id, agent_turn_id, agent_step_id
          FROM usage_ledger WHERE exchange_id = 'aux-exchange'`,
        ).get(),
        {
          agent_session_id: null,
          agent_thread_id: null,
          agent_turn_id: null,
          agent_step_id: null,
        },
      );
      assert.equal(
        migrated.prepare("SELECT COUNT(*) FROM agent_sessions WHERE id = 'session-aux'").pluck().get(),
        0,
      );
      assert.equal(
        migrated.prepare("SELECT COUNT(*) FROM agent_threads WHERE id = 'thread-aux'").pluck().get(),
        0,
      );
      assert.equal(
        migrated.prepare("SELECT COUNT(*) FROM scope_aggregates WHERE scope_id IN ('session-aux', 'thread-aux')").pluck().get(),
        0,
      );
      assert.equal(migrated.pragma("foreign_key_check").length, 0);
    } finally {
      migrated.close();
    }
  });

  test("导出范围引用查询使用层级时间索引且不临时排序", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    const stepDetails = queryPlanDetails(
      fixture.db,
      `SELECT exchange_id, timestamp FROM agent_steps
       WHERE agent_session_id = ?
       ORDER BY timestamp DESC, exchange_id DESC
       LIMIT 6`,
      "session-1",
    );
    const auxiliaryDetails = queryPlanDetails(
      fixture.db,
      `SELECT exchange_id, timestamp FROM auxiliary_requests
       WHERE agent_thread_id = ?
       ORDER BY timestamp DESC, exchange_id DESC
       LIMIT 6`,
      "thread-1",
    );

    assert.ok(stepDetails.some((detail) =>
      detail.includes("USING COVERING INDEX idx_steps_session_time")
    ));
    assert.ok(auxiliaryDetails.some((detail) =>
      detail.includes("USING COVERING INDEX idx_aux_thread_time")
    ));
    assert.ok([...stepDetails, ...auxiliaryDetails].every((detail) =>
      !detail.includes("USE TEMP B-TREE")
    ));
  });

  test("findOpenTurn 精确使用 open Turn 索引且不临时排序", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    const details = queryPlanDetails(
      fixture.db,
      `SELECT id, native_turn_id, segment_index, step_count
       FROM agent_turns
       WHERE agent_thread_id = ? AND status = 'open'
       ORDER BY segment_index DESC, id DESC
       LIMIT 1`,
      "thread-1",
    );

    assert.ok(details.some(detail =>
      detail.includes("USING INDEX idx_turns_open")
      && detail.includes("agent_thread_id=?")
      && detail.includes("status=?")), details.join("\n"));
    assert.ok(details.every(detail => !detail.includes("SCAN agent_turns")));
    assert.ok(details.every(detail => !detail.includes("USE TEMP B-TREE")));
  });

  test("auxiliary native Turn 精确使用 native Turn 索引且不临时排序", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    const details = queryPlanDetails(
      fixture.db,
      `SELECT id FROM agent_turns
       WHERE agent_thread_id = ? AND native_turn_id = ?
       ORDER BY segment_index DESC, id DESC LIMIT 1`,
      "thread-1",
      "native-turn-1",
    );

    assert.ok(details.some(detail =>
      detail.includes("USING COVERING INDEX idx_turns_native")
      && detail.includes("agent_thread_id=?")
      && detail.includes("native_turn_id=?")), details.join("\n"));
    assert.ok(details.every(detail => !detail.includes("SCAN agent_turns")));
    assert.ok(details.every(detail => !detail.includes("USE TEMP B-TREE")));
  });

  test("next segment 聚合使用线程 segment 索引而不扫描全部 Turn", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    const details = queryPlanDetails(
      fixture.db,
      `SELECT COALESCE(MAX(segment_index), 0) + 1
       FROM agent_turns WHERE agent_thread_id = ?`,
      "thread-1",
    );

    assert.ok(details.some(detail =>
      detail.includes("USING COVERING INDEX idx_turns_segment")
      && detail.includes("agent_thread_id=?")), details.join("\n"));
    assert.ok(details.every(detail => !detail.includes("SCAN agent_turns")));
    assert.ok(details.every(detail => !detail.includes("USE TEMP B-TREE")));
  });

  test("tool result UPDATE 使用 Turn/tool use 前缀索引", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    const details = queryPlanDetails(
      fixture.db,
      `UPDATE tool_calls SET status = 'completed'
       WHERE agent_thread_id = ? AND agent_turn_id = ? AND tool_use_id = ?`,
      "thread-1",
      "turn-1",
      "tool-use-1",
    );

    assert.ok(details.some(detail =>
      detail.includes("USING INDEX idx_tools_turn_use")
      && detail.includes("agent_turn_id=?")
      && detail.includes("tool_use_id=?")
      && detail.includes("agent_thread_id=?")), details.join("\n"));
    assert.ok(details.every(detail => !detail.includes("SCAN tool_calls")));
    assert.ok(details.every(detail => !detail.includes("USE TEMP B-TREE")));
  });

  test("工作台 Session 最新页使用 target/agent/time 索引且不临时排序", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    const details = queryPlanDetails(
      fixture.db,
      `SELECT id, target_id, target_name, agent_fingerprint_id, agent_name,
         external_session_id, start_time, end_time, model_set_json,
         request_count, thread_count
       FROM agent_sessions
       WHERE target_id = ? AND agent_name = ?
       ORDER BY end_time DESC, id DESC
       LIMIT ?`,
      "target-1",
      "codex",
      51,
    );

    assert.ok(details.some(detail =>
      detail.includes("USING INDEX idx_sessions_target_agent_latest")
      && detail.includes("target_id=?")
      && detail.includes("agent_name=?")), details.join("\n"));
    assert.ok(details.every(detail => !detail.includes("SCAN agent_sessions")));
    assert.ok(details.every(detail => !detail.includes("USE TEMP B-TREE")));
  });

  test("Step 工具聚合使用 Turn/Step/name/status 覆盖索引", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    const details = queryPlanDetails(
      fixture.db,
      `SELECT agent_step_id, tool_name, status, COUNT(*) AS call_count
       FROM tool_calls
       WHERE agent_turn_id = ? AND agent_step_id IN (?, ?)
       GROUP BY agent_step_id, tool_name, status`,
      "turn-1",
      "step-1",
      "step-2",
    );

    assert.ok(details.some(detail =>
      detail.includes("USING COVERING INDEX idx_tools_turn_step_name_status")
      && detail.includes("agent_turn_id=?")
      && detail.includes("agent_step_id=?")), details.join("\n"));
    assert.ok(details.every(detail => !detail.includes("SCAN tool_calls")));
  });

  test("ingestion source generation 默认从零开始且不能回退", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    const generation = fixture.db
      .prepare(
        `INSERT INTO ingestion_sources(relative_path, file_id, updated_at)
        VALUES('captures/v2/generation.jsonl', 'file-generation', ?)
        RETURNING generation`,
      )
      .pluck()
      .get("2026-07-17T00:00:00.000Z");

    assert.equal(generation, 0);
    assert.throws(
      () => fixture.db.prepare(
        "UPDATE ingestion_sources SET generation = -1 WHERE relative_path = 'captures/v2/generation.jsonl'",
      ).run(),
      /CHECK constraint failed/,
    );
  });

  test("大正文登记、任务、预览与媒体表强制执行状态和容量约束", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    const now = "2026-07-22T00:00:00.000Z";
    fixture.db.prepare(
      `INSERT INTO ingestion_sources(
        id, relative_path, file_id, file_size, updated_at
      ) VALUES(1, 'captures/v2/large.jsonl', 'file-large', 4096, ?)`,
    ).run(now);
    const recordId = fixture.db.prepare(
      `INSERT INTO ingestion_records(
        exchange_id, source_id, source_generation, source_file_id,
        byte_offset, line_length_bytes, line_sha256, schema_version,
        captured_at, completed_at, request_body_bytes, response_body_bytes,
        request_body_sha256, response_body_sha256,
        request_body_storage, response_body_storage,
        request_body_state, response_body_state, registered_at
      ) VALUES(
        'exchange-large', 1, 0, 'file-large', 0, 1024, ?, 2, ?, ?,
        13348414, 197299, ?, ?, 'external-blob', 'compressed-inline',
        'available', 'available', ?
      ) RETURNING id`,
    ).pluck().get("a".repeat(64), now, now, "b".repeat(64), "c".repeat(64), now) as number;

    fixture.db.prepare(
      `INSERT INTO derivation_jobs(
        ingestion_record_id, projection_version, job_status,
        request_verification, response_verification, available_at,
        created_at, updated_at
      ) VALUES(?, 1, 'pending', 'pending', 'pending', ?, ?, ?)`,
    ).run(recordId, now, now, now);

    assert.throws(() => fixture.db.prepare(
      `UPDATE derivation_jobs
       SET job_status = 'succeeded', projection_completeness = NULL,
         completed_at = ?
       WHERE ingestion_record_id = ? AND projection_version = 1`,
    ).run(now, recordId), /CHECK constraint failed/);
    assert.throws(() => fixture.db.prepare(
      `UPDATE derivation_jobs
       SET job_status = 'permanent_error', projection_completeness = 'complete',
         completed_at = ?
       WHERE ingestion_record_id = ? AND projection_version = 1`,
    ).run(now, recordId), /CHECK constraint failed/);
    assert.throws(() => fixture.db.prepare(
      `INSERT INTO ingestion_records(
        exchange_id, source_id, source_generation, source_file_id,
        byte_offset, line_length_bytes, line_sha256, schema_version,
        captured_at, completed_at, request_body_bytes, response_body_bytes,
        request_body_sha256, response_body_sha256,
        request_body_storage, response_body_storage,
        request_body_state, response_body_state, registered_at
      ) SELECT
        'exchange-duplicate-offset', source_id, source_generation, source_file_id,
        byte_offset, line_length_bytes, line_sha256, schema_version,
        captured_at, completed_at, request_body_bytes, response_body_bytes,
        request_body_sha256, response_body_sha256,
        request_body_storage, response_body_storage,
        request_body_state, response_body_state, registered_at
      FROM ingestion_records WHERE id = ?`,
    ).run(recordId), /UNIQUE constraint failed/);

    const previewColumns = fixture.db.pragma(
      "table_info(exchange_content_previews)",
    ) as Array<{ name: string }>;
    assert.ok(previewColumns.some(column => column.name === "preview_json"));
    assert.ok(hasIndex(fixture.db, "idx_derivation_jobs_claim"));
    assert.ok(hasIndex(fixture.db, "idx_ingestion_records_source_order"));
    assert.ok(hasIndex(fixture.db, "idx_ingestion_records_registered"));
    assert.ok(hasIndex(fixture.db, "idx_derivation_jobs_status_created"));
    assert.ok(hasIndex(fixture.db, "idx_derivation_jobs_status_completed"));
    assert.ok(hasIndex(fixture.db, "idx_derivation_jobs_recent_error"));
  });

  test("写连接把真实旧 v1 schema 原子迁移到当前版本并保留既有 source", async () => {
    const fixture = await createUnmigratedSqliteFixture();
    fixtures.push(fixture);
    seedLegacyV1Schema(fixture.db, { includeSchemaMeta: true });
    fixture.db.close();

    const readonly = openDeepaaDatabase({
      dataDir: fixture.dataDir,
      readonly: true,
    });
    try {
      assert.equal(readonly.pragma("user_version", { simple: true }), 1);
      assert.equal(hasColumn(readonly, "ingestion_sources", "generation"), false);
    } finally {
      readonly.close();
    }

    const migrated = openDeepaaDatabase({ dataDir: fixture.dataDir });
    try {
      assert.equal(SCHEMA_VERSION, 53);
      assert.equal(migrated.pragma("user_version", { simple: true }), SCHEMA_VERSION);
      assert.equal(hasColumn(migrated, "ingestion_sources", "generation"), true);
      assert.equal(hasColumn(migrated, "ingestion_sources", "scan_offset"), true);
      assert.deepEqual(
        migrated.prepare(
          `SELECT relative_path, file_id, generation, byte_offset, scan_offset,
            file_size, processed_count, status, error
          FROM ingestion_sources WHERE id = 1`,
        ).get(),
        {
          relative_path: "captures/v2/legacy.jsonl",
          file_id: "legacy-file",
          generation: 0,
          byte_offset: 128,
          scan_offset: 128,
          file_size: 256,
          processed_count: 2,
          status: "reset",
          error: "legacy-error",
        },
      );
      assert.equal(
        migrated.prepare(
          `INSERT INTO ingestion_sources(relative_path, file_id, updated_at)
          VALUES('captures/v2/new.jsonl', 'new-file', ?)
          RETURNING generation`,
        ).pluck().get("2026-07-17T00:00:00.000Z"),
        0,
      );
      assert.equal(
        migrated.prepare("SELECT schema_version FROM schema_meta WHERE id = 1").pluck().get(),
        SCHEMA_VERSION,
      );
      assert.equal(hasIndex(migrated, "idx_threads_root"), true);
      assert.equal(hasIndex(migrated, "idx_diagnostics_dedupe"), true);
      assert.equal(hasIndex(migrated, "idx_sessions_conversation"), true);
      assert.equal(hasTable(migrated, "pricing_config_revisions"), true);
      assert.equal(hasIndex(migrated, "idx_pricing_revisions_effective"), true);
    } finally {
      migrated.close();
    }
  });

  test("v1 到 v7 迁移后段失败时回滚新增列、索引和版本", async () => {
    const fixture = await createUnmigratedSqliteFixture();
    fixtures.push(fixture);
    seedLegacyV1Schema(fixture.db, { includeSchemaMeta: false });

    assert.throws(
      () => migrateDeepaaDatabase(fixture.db),
      /no such table: schema_meta/,
    );
    assert.equal(fixture.db.pragma("user_version", { simple: true }), 1);
    assert.equal(hasColumn(fixture.db, "ingestion_sources", "generation"), false);
    assert.equal(hasColumn(fixture.db, "ingestion_sources", "scan_offset"), false);
    assert.equal(hasIndex(fixture.db, "idx_threads_root"), false);
    assert.equal(hasIndex(fixture.db, "idx_diagnostics_dedupe"), false);
    assert.equal(hasIndex(fixture.db, "idx_sessions_conversation"), false);
  });

  test("写连接把真实旧 v2 schema 迁移到当前版本并让只读连接保持原版本", async () => {
    const fixture = await createUnmigratedSqliteFixture();
    fixtures.push(fixture);
    seedLegacyV2Schema(fixture.db, { includeSchemaMeta: true });
    fixture.db.close();

    const readonly = openDeepaaDatabase({
      dataDir: fixture.dataDir,
      readonly: true,
    });
    try {
      assert.equal(readonly.pragma("user_version", { simple: true }), 2);
      assert.equal(hasColumn(readonly, "ingestion_sources", "scan_offset"), false);
    } finally {
      readonly.close();
    }

    const migrated = openDeepaaDatabase({ dataDir: fixture.dataDir });
    try {
      assert.equal(SCHEMA_VERSION, 53);
      assert.equal(migrated.pragma("user_version", { simple: true }), SCHEMA_VERSION);
      assert.equal(hasColumn(migrated, "ingestion_sources", "scan_offset"), true);
      assert.deepEqual(
        migrated.prepare(
          `SELECT byte_offset, scan_offset, generation
          FROM ingestion_sources WHERE id = 1`,
        ).get(),
        { byte_offset: 128, scan_offset: 128, generation: 0 },
      );
      assert.throws(
        () => migrated.prepare(
          "UPDATE ingestion_sources SET scan_offset = byte_offset - 1 WHERE id = 1",
        ).run(),
        /scan_offset.*byte_offset|constraint/i,
      );
      assert.equal(
        migrated.prepare("SELECT schema_version FROM schema_meta WHERE id = 1").pluck().get(),
        SCHEMA_VERSION,
      );
      assert.equal(hasIndex(migrated, "idx_threads_root"), true);
      assert.equal(hasIndex(migrated, "idx_diagnostics_dedupe"), true);
      assert.equal(hasIndex(migrated, "idx_sessions_conversation"), true);
    } finally {
      migrated.close();
    }
  });

  test("v2 到 v7 迁移后段失败时回滚 scan_offset、触发器、索引和版本", async () => {
    const fixture = await createUnmigratedSqliteFixture();
    fixtures.push(fixture);
    seedLegacyV2Schema(fixture.db, { includeSchemaMeta: false });

    assert.throws(
      () => migrateDeepaaDatabase(fixture.db),
      /no such table: schema_meta/,
    );
    assert.equal(fixture.db.pragma("user_version", { simple: true }), 2);
    assert.equal(hasColumn(fixture.db, "ingestion_sources", "scan_offset"), false);
    assert.deepEqual(
      fixture.db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name")
        .pluck()
        .all(),
      [],
    );
    assert.equal(hasIndex(fixture.db, "idx_threads_root"), false);
    assert.equal(hasIndex(fixture.db, "idx_diagnostics_dedupe"), false);
    assert.equal(hasIndex(fixture.db, "idx_sessions_conversation"), false);
  });

  test("写连接把真实旧 v3 schema 原子迁移到当前版本且只读连接不迁移", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    downgradeToLegacyV3(fixture.db, { includeSchemaMeta: true });
    fixture.db.close();

    const readonly = openDeepaaDatabase({
      dataDir: fixture.dataDir,
      readonly: true,
    });
    try {
      assert.equal(readonly.pragma("user_version", { simple: true }), 3);
      assert.equal(hasIndex(readonly, "idx_threads_root"), false);
      assert.equal(hasIndex(readonly, "idx_diagnostics_dedupe"), false);
    } finally {
      readonly.close();
    }

    const migrated = openDeepaaDatabase({ dataDir: fixture.dataDir });
    try {
      assert.equal(SCHEMA_VERSION, 53);
      assert.equal(migrated.pragma("user_version", { simple: true }), SCHEMA_VERSION);
      assert.equal(
        migrated.prepare("SELECT schema_version FROM schema_meta WHERE id = 1").pluck().get(),
        SCHEMA_VERSION,
      );
      assert.equal(hasIndex(migrated, "idx_threads_root"), true);
      assert.equal(hasIndex(migrated, "idx_diagnostics_dedupe"), true);
      assert.equal(hasIndex(migrated, "idx_sessions_conversation"), true);
    } finally {
      migrated.close();
    }
  });

  test("v3 到 v7 迁移后段失败时回滚全部后续索引和版本", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    downgradeToLegacyV3(fixture.db, { includeSchemaMeta: false });

    assert.throws(
      () => migrateDeepaaDatabase(fixture.db),
      /no such table: schema_meta/,
    );
    assert.equal(fixture.db.pragma("user_version", { simple: true }), 3);
    assert.equal(hasIndex(fixture.db, "idx_threads_root"), false);
    assert.equal(hasIndex(fixture.db, "idx_diagnostics_dedupe"), false);
    assert.equal(hasIndex(fixture.db, "idx_sessions_conversation"), false);
  });

  test("写连接把真实旧 v4 schema 原子迁移到当前版本，readonly 保持 v4", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    downgradeToLegacyV4(fixture.db, { includeSchemaMeta: true });
    fixture.db.close();

    const readonly = openDeepaaDatabase({
      dataDir: fixture.dataDir,
      readonly: true,
    });
    try {
      assert.equal(readonly.pragma("user_version", { simple: true }), 4);
      assert.equal(hasIndex(readonly, "idx_sessions_conversation"), false);
    } finally {
      readonly.close();
    }

    const migrated = openDeepaaDatabase({ dataDir: fixture.dataDir });
    try {
      assert.equal(SCHEMA_VERSION, 53);
      assert.equal(migrated.pragma("user_version", { simple: true }), SCHEMA_VERSION);
      assert.equal(hasIndex(migrated, "idx_sessions_conversation"), true);
      assert.equal(
        migrated.prepare("SELECT schema_version FROM schema_meta WHERE id = 1").pluck().get(),
        SCHEMA_VERSION,
      );
    } finally {
      migrated.close();
    }
  });

  test("v4 到 v7 后段失败时回滚 conversation 索引和版本", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    downgradeToLegacyV4(fixture.db, { includeSchemaMeta: false });

    assert.throws(
      () => migrateDeepaaDatabase(fixture.db),
      /no such table: schema_meta/,
    );
    assert.equal(fixture.db.pragma("user_version", { simple: true }), 4);
    assert.equal(hasIndex(fixture.db, "idx_sessions_conversation"), false);
  });

  test("写连接把真实旧 v5 schema 原子迁移到当前版本且只读连接保持 v5", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    downgradeToLegacyV5(fixture.db, { includeSchemaMeta: true });
    fixture.db.close();

    const readonly = openDeepaaDatabase({
      dataDir: fixture.dataDir,
      readonly: true,
    });
    try {
      assert.equal(readonly.pragma("user_version", { simple: true }), 5);
      assert.equal(hasIndex(readonly, "idx_turns_open"), false);
      assert.equal(hasIndex(readonly, "idx_turns_native"), false);
      assert.equal(hasIndex(readonly, "idx_turns_segment"), false);
      assert.equal(hasIndex(readonly, "idx_tools_turn_use"), false);
    } finally {
      readonly.close();
    }

    const migrated = openDeepaaDatabase({ dataDir: fixture.dataDir });
    try {
      assert.equal(SCHEMA_VERSION, 53);
      assert.equal(migrated.pragma("user_version", { simple: true }), SCHEMA_VERSION);
      assert.equal(
        migrated.prepare("SELECT schema_version FROM schema_meta WHERE id = 1").pluck().get(),
        SCHEMA_VERSION,
      );
      for (const indexName of task6LookupIndexNames()) {
        assert.equal(hasIndex(migrated, indexName), true, `缺少迁移索引 ${indexName}`);
      }
      assert.equal(hasIndex(migrated, "idx_turns_latest"), true);
    } finally {
      migrated.close();
    }
  });

  test("v5 到 v7 后段失败时回滚全部 Task 6/7 索引和版本", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    downgradeToLegacyV5(fixture.db, { includeSchemaMeta: false });

    assert.throws(
      () => migrateDeepaaDatabase(fixture.db),
      /no such table: schema_meta/,
    );
    assert.equal(fixture.db.pragma("user_version", { simple: true }), 5);
    for (const indexName of task6LookupIndexNames()) {
      assert.equal(hasIndex(fixture.db, indexName), false, `索引未回滚 ${indexName}`);
    }
    assert.equal(hasIndex(fixture.db, "idx_turns_latest"), true);
  });

  test("写连接把真实旧 v6 schema 原子迁移到当前版本且只读连接保持 v6", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    downgradeToLegacyV6(fixture.db, { includeSchemaMeta: true });
    fixture.db.close();

    const readonly = openDeepaaDatabase({
      dataDir: fixture.dataDir,
      readonly: true,
    });
    try {
      assert.equal(readonly.pragma("user_version", { simple: true }), 6);
      assert.equal(hasIndex(readonly, "idx_sessions_target_agent_latest"), false);
      assert.equal(hasIndex(readonly, "idx_tools_turn_step_name_status"), false);
      assert.equal(hasIndex(readonly, "idx_sessions_latest"), true);
    } finally {
      readonly.close();
    }

    const migrated = openDeepaaDatabase({ dataDir: fixture.dataDir });
    try {
      assert.equal(SCHEMA_VERSION, 53);
      assert.equal(migrated.pragma("user_version", { simple: true }), SCHEMA_VERSION);
      assert.equal(
        migrated.prepare("SELECT schema_version FROM schema_meta WHERE id = 1").pluck().get(),
        SCHEMA_VERSION,
      );
      assert.equal(hasIndex(migrated, "idx_sessions_target_agent_latest"), true);
      assert.equal(hasIndex(migrated, "idx_tools_turn_step_name_status"), true);
      assert.equal(hasIndex(migrated, "idx_sessions_latest"), true);
    } finally {
      migrated.close();
    }
  });

  test("v6 到 v7 后段失败时原子回滚两个索引和版本", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    downgradeToLegacyV6(fixture.db, { includeSchemaMeta: false });

    assert.throws(
      () => migrateDeepaaDatabase(fixture.db),
      /no such table: schema_meta/,
    );
    assert.equal(fixture.db.pragma("user_version", { simple: true }), 6);
    assert.equal(hasIndex(fixture.db, "idx_sessions_target_agent_latest"), false);
    assert.equal(hasIndex(fixture.db, "idx_tools_turn_step_name_status"), false);
    assert.equal(hasIndex(fixture.db, "idx_sessions_latest"), true);
  });

  test("完整 v11 升级到当前版本时只创建空的内容筛选投影", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    seedHierarchy(fixture.db);
    fixture.db.exec(`
      DROP TABLE exchange_content_category_stats;
      DROP TABLE exchange_request_fingerprints;
      DROP TABLE exchange_content_filter_status;
      UPDATE schema_meta SET schema_version = 11 WHERE id = 1;
      PRAGMA user_version = 11;
    `);
    fixture.db.close();

    const migrated = openDeepaaDatabase({ dataDir: fixture.dataDir });
    try {
      assert.equal(migrated.pragma("user_version", { simple: true }), SCHEMA_VERSION);
      assert.equal(hasTable(migrated, "exchange_content_filter_status"), true);
      assert.equal(hasTable(migrated, "exchange_request_fingerprints"), true);
      assert.equal(hasTable(migrated, "exchange_content_category_stats"), true);
      assert.equal(
        hasColumn(migrated, "exchange_content_filter_status", "request_filter_state"),
        true,
      );
      assert.equal(
        hasColumn(migrated, "exchange_content_filter_status", "response_filter_state"),
        true,
      );
      assert.equal(hasIndex(migrated, "idx_content_filter_status_state"), true);
      assert.equal(hasIndex(migrated, "idx_content_category_match"), true);
      assert.equal(
        migrated.prepare("SELECT COUNT(*) FROM exchange_content_filter_status").pluck().get(),
        0,
      );
      assert.equal(
        migrated.prepare("SELECT COUNT(*) FROM exchange_request_fingerprints").pluck().get(),
        0,
      );
      assert.equal(
        migrated.prepare("SELECT COUNT(*) FROM exchange_content_category_stats").pluck().get(),
        0,
      );
    } finally {
      migrated.close();
    }
  });

  test("旧 v12 筛选表升级到 v13 时重建为空的统一语义结构", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    seedHierarchy(fixture.db);
    insertRawExchange(fixture.db, "exchange-v12-filter", 256);
    fixture.db.exec(`
      DROP TABLE exchange_content_category_stats;
      DROP TABLE exchange_request_fingerprints;
      DROP TABLE exchange_content_filter_status;
      CREATE TABLE exchange_content_filter_status (
        exchange_id TEXT PRIMARY KEY REFERENCES raw_exchange_refs(exchange_id) ON DELETE CASCADE,
        projection_version INTEGER NOT NULL,
        filter_state TEXT NOT NULL,
        request_filter_state TEXT NOT NULL,
        response_filter_state TEXT NOT NULL,
        request_dedupe_state TEXT NOT NULL,
        baseline_exchange_id TEXT,
        request_fingerprint_count INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE exchange_request_fingerprints (
        exchange_id TEXT NOT NULL REFERENCES raw_exchange_refs(exchange_id) ON DELETE CASCADE,
        category TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        occurrence_count INTEGER NOT NULL,
        PRIMARY KEY (exchange_id, category, fingerprint)
      );
      CREATE TABLE exchange_content_category_stats (
        exchange_id TEXT NOT NULL REFERENCES raw_exchange_refs(exchange_id) ON DELETE CASCADE,
        category TEXT NOT NULL,
        total_count INTEGER NOT NULL,
        unique_count INTEGER NOT NULL,
        inherited_count INTEGER NOT NULL,
        unconfirmed_count INTEGER NOT NULL,
        PRIMARY KEY (exchange_id, category)
      );
      INSERT INTO exchange_content_filter_status VALUES(
        'exchange-v12-filter', 3, 'complete', 'complete', 'complete',
        'not_required', NULL, 1,
        '2026-07-28T00:00:00.000Z', '2026-07-28T00:00:00.000Z'
      );
      INSERT INTO exchange_request_fingerprints VALUES(
        'exchange-v12-filter', 'user_real',
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 1
      );
      INSERT INTO exchange_content_category_stats VALUES(
        'exchange-v12-filter', 'user_real', 1, 1, 0, 0
      );
      UPDATE schema_meta SET schema_version = 12 WHERE id = 1;
      PRAGMA user_version = 12;
    `);
    fixture.db.close();

    const migrated = openDeepaaDatabase({ dataDir: fixture.dataDir });
    try {
      assert.equal(SCHEMA_VERSION, 53);
      assert.equal(migrated.pragma("user_version", { simple: true }), SCHEMA_VERSION);
      assert.equal(
        hasColumn(migrated, "exchange_content_filter_status", "request_comparison_kind"),
        true,
      );
      assert.equal(
        hasColumn(migrated, "exchange_request_fingerprints", "body_side"),
        true,
      );
      assert.equal(
        hasColumn(migrated, "exchange_request_fingerprints", "provider_lineage_key"),
        true,
      );
      assert.equal(
        hasColumn(migrated, "exchange_content_category_stats", "body_side"),
        true,
      );
      for (const table of [
        "exchange_content_filter_status",
        "exchange_request_fingerprints",
        "exchange_content_category_stats",
      ]) {
        assert.equal(
          migrated.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get(),
          0,
        );
      }
    } finally {
      migrated.close();
    }
  });

  test("conversation Session 精确查询使用 v5 索引且不创建临时排序", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    const details = fixture.db.prepare(
      `EXPLAIN QUERY PLAN
       SELECT id, agent_fingerprint_id FROM agent_sessions
       WHERE target_id = ? AND agent_name = ? AND external_conversation_id = ?
       LIMIT 2`,
    ).all("target", "codex", "conversation")
      .map(row => (row as { detail: string }).detail);

    assert.ok(details.some(detail => detail.includes("idx_sessions_conversation")));
    assert.ok(details.every(detail => !detail.includes("SCAN agent_sessions")));
    assert.ok(details.every(detail => !detail.includes("USE TEMP B-TREE")));
  });

  test("强制执行层级外键和 Step 唯一位置", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);

    assert.throws(
      () =>
        fixture.db
          .prepare(
            `INSERT INTO agent_threads(
              id, agent_session_id, source, display_name, confidence, is_root,
              start_time, end_time
            ) VALUES('thread-orphan', 'missing', 'test', 'orphan', 'high', 1, ?, ?)`,
          )
          .run("2026-07-16T00:00:00.000Z", "2026-07-16T00:00:00.000Z"),
      /FOREIGN KEY constraint failed/,
    );

    seedHierarchy(fixture.db);
    insertRawExchange(fixture.db, "exchange-2", 256);
    assert.throws(
      () =>
        fixture.db
          .prepare(
            `INSERT INTO agent_steps(
              id, exchange_id, agent_session_id, agent_thread_id, agent_turn_id,
              step_index, timestamp, phase, request_action, response_action
            ) VALUES('step-2', 'exchange-2', 'session-1', 'thread-1', 'turn-1',
              0, ?, 'main', 'request', 'response')`,
          )
          .run("2026-07-16T00:00:01.000Z"),
      /UNIQUE constraint failed/,
    );
  });

  test("写连接和只读连接都在修改 journal mode 前拒绝未来版本", async () => {
    const fixture = await createUnmigratedSqliteFixture();
    fixtures.push(fixture);
    fixture.db.exec("CREATE TABLE future_marker(id INTEGER PRIMARY KEY)");
    assert.equal(
      fixture.db.pragma("journal_mode", { simple: true }),
      "delete",
    );
    fixture.db.pragma(`user_version = ${SCHEMA_VERSION + 1}`);
    fixture.db.close();

    const futureVersionError = new RegExp(
      `数据库版本 ${SCHEMA_VERSION + 1} 高于程序版本 ${SCHEMA_VERSION}`,
    );
    assert.throws(
      () => openDeepaaDatabase({ dataDir: fixture.dataDir }),
      futureVersionError,
    );
    assert.throws(
      () =>
        openDeepaaDatabase({ dataDir: fixture.dataDir, readonly: true }),
      futureVersionError,
    );

    const raw = new DeepaaDatabase(deepaaDatabasePath(fixture.dataDir), {
      readonly: true,
      fileMustExist: true,
    });
    try {
      assert.equal(
        raw.pragma("user_version", { simple: true }),
        SCHEMA_VERSION + 1,
      );
      assert.equal(
        raw
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'future_marker'",
          )
          .pluck()
          .get(),
        "future_marker",
      );
      assert.equal(raw.pragma("journal_mode", { simple: true }), "delete");
    } finally {
      raw.close();
    }
  });

  test("真正 v0 schema 的 DDL 迁移失败时回滚全部新表、索引和版本", async () => {
    const fixture = await createUnmigratedSqliteFixture();
    fixtures.push(fixture);
    fixture.db.exec("CREATE TABLE agent_sessions(id TEXT PRIMARY KEY)");

    assert.throws(
      () => migrateDeepaaDatabase(fixture.db),
      /no such column: target_id/,
    );
    assert.equal(fixture.db.pragma("user_version", { simple: true }), 0);
    assert.deepEqual(
      fixture.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
        )
        .pluck()
        .all(),
      ["agent_sessions"],
    );
    assert.deepEqual(
      fixture.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .pluck()
        .all(),
      [],
    );
  });

  test("只读打开缺失数据库时不创建数据目录", async () => {
    const parentDir = await mkdtemp(
      join(tmpdir(), "deepaa-readonly-missing-"),
    );
    const missingDataDir = join(parentDir, "missing-data");
    try {
      assert.throws(
        () =>
          openDeepaaDatabase({
            dataDir: missingDataDir,
            readonly: true,
          }),
        /does not exist|unable to open database/i,
      );
      assert.equal(existsSync(missingDataDir), false);
    } finally {
      await rm(parentDir, { recursive: true, force: true });
    }
  });

  test("环境变量覆盖默认数据目录", () => {
    const previous = process.env.DEEPAA_DATA_DIR;
    try {
      delete process.env.DEEPAA_DATA_DIR;
      // 源码模式默认使用用户数据目录；只有显式 sourceCheckout 才回退项目根 data。
      assert.equal(
        resolveDeepaaDataDir("/tmp/inspector-project", {sourceCheckout: true}),
        resolve("/tmp/inspector-project/data"),
      );

      // 显式覆盖值必须按宿主平台绝对路径提供：POSIX 字面量在 Windows 的
      // win32.isAbsolute 下非绝对会直接抛错。
      const isolatedDir = resolve(tmpdir(), "inspector-isolated-data");
      process.env.DEEPAA_DATA_DIR = isolatedDir;
      assert.equal(
        resolveDeepaaDataDir("/tmp/ignored-project"),
        isolatedDir,
      );
    } finally {
      if (previous === undefined) {
        delete process.env.DEEPAA_DATA_DIR;
      } else {
        process.env.DEEPAA_DATA_DIR = previous;
      }
    }
  });

  test("动态数据根目录标记为运行时路径以避免 Turbopack 全项目追踪", async () => {
    const source = await readFile(
      new URL("../src/lib/data-paths-runtime.mjs", import.meta.url),
      "utf8",
    );

    assert.match(source, /\/\*\s*turbopackIgnore: true\s*\*\//u);
  });

  test("生产连接按规范化数据库路径复用且关闭后重建", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    fixture.db.close();

    const first = getDeepaaDatabase(fixture.dataDir);
    const reused = getDeepaaDatabase(resolve(fixture.dataDir, "."));
    assert.strictEqual(reused, first);
    first.close();

    const reopened = getDeepaaDatabase(fixture.dataDir);
    assert.notStrictEqual(reopened, first);
    assert.equal(reopened.open, true);
    reopened.close();
  });

  test("v39 存量库升级 v41 自动补连续自动失败计数列（默认 0，不回填）", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    fixture.db.exec("ALTER TABLE console_accounts DROP COLUMN consecutive_auto_failures");
    fixture.db.exec("ALTER TABLE plan_sync_configs DROP COLUMN consecutive_auto_failures");
    fixture.db.pragma("user_version = 39");
    fixture.db.close();

    const migrated = openDeepaaDatabase({dataDir: fixture.dataDir});
    try {
      for (const table of ["console_accounts", "plan_sync_configs"]) {
        const columns = migrated.pragma(`table_info(${table})`) as Array<{name: string}>;
        assert.equal(columns.map(column => column.name).includes("consecutive_auto_failures"), true);
      }
      // 存量行由列默认值回填 0：没有历史失败记录就不亮「同步失败」标识。
      const consoleRows = migrated
        .prepare(`SELECT consecutive_auto_failures FROM ${"console_accounts"} LIMIT 1`)
        .all() as Array<{consecutive_auto_failures: number}>;
      for (const row of consoleRows) {
        assert.equal(row.consecutive_auto_failures, 0);
      }
      assert.equal(migrated.pragma("user_version", {simple: true}), SCHEMA_VERSION);
    } finally {
      migrated.close();
    }
  });

  test("v40 存量库升级 v41 自动补连续失败类别列（nullable，旧数据走默认门槛）", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    fixture.db.exec("ALTER TABLE console_accounts DROP COLUMN consecutive_failure_kind");
    fixture.db.exec("ALTER TABLE plan_sync_configs DROP COLUMN consecutive_failure_kind");
    fixture.db.pragma("user_version = 40");
    fixture.db.close();

    const migrated = openDeepaaDatabase({dataDir: fixture.dataDir});
    try {
      for (const table of ["console_accounts", "plan_sync_configs"]) {
        const columns = migrated.pragma(`table_info(${table})`) as Array<{name: string}>;
        assert.equal(columns.map(column => column.name).includes("consecutive_failure_kind"), true);
      }
      // 存量计数行类别为 NULL：读取端按默认门槛（连续两次）处理，不误触 auth 一次即亮。
      const rows = migrated
        .prepare("SELECT consecutive_failure_kind FROM plan_sync_configs LIMIT 1")
        .all() as Array<{consecutive_failure_kind: string | null}>;
      for (const row of rows) {
        assert.equal(row.consecutive_failure_kind, null);
      }
      assert.equal(migrated.pragma("user_version", {simple: true}), SCHEMA_VERSION);
    } finally {
      migrated.close();
    }
  });

  test("v52 存量库升级 v53 自动补账号余额查询密钥列（nullable，存量回退 Agent 默认表）", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    fixture.db.exec("ALTER TABLE console_accounts DROP COLUMN credential_id");
    fixture.db.pragma("user_version = 52");
    fixture.db.close();

    const migrated = openDeepaaDatabase({dataDir: fixture.dataDir});
    try {
      const columns = migrated.pragma("table_info(console_accounts)") as Array<{name: string}>;
      assert.equal(columns.map(column => column.name).includes("credential_id"), true);
      assert.equal(migrated.pragma("user_version", {simple: true}), SCHEMA_VERSION);
    } finally {
      migrated.close();
    }
  });
});

function insertRawExchange(
  db: DeepaaDatabase,
  exchangeId: string,
  byteOffset: number,
): void {
  db.prepare(
    `INSERT INTO raw_exchange_refs(
      exchange_id, capture_session_id, source_id, byte_offset,
      line_length_bytes, captured_at, completed_at, target_id, target_name,
      agent_name, agent_fingerprint_id, status, is_streaming,
      request_body_bytes, response_body_bytes
    ) VALUES(?, 'capture-1', 1, ?, 128, ?, ?, 'target-1', 'Target',
      'codex', 'fingerprint-1', 200, 0, 16, 32)`,
  ).run(
    exchangeId,
    byteOffset,
    "2026-07-16T00:00:00.000Z",
    "2026-07-16T00:00:01.000Z",
  );
}

function downgradeToLegacyV9WithAuxiliaryBucket(db: DeepaaDatabase): void {
  db.exec(`
    DROP TABLE auxiliary_requests;
    DROP TABLE usage_ledger;
    CREATE TABLE auxiliary_requests (
      id TEXT PRIMARY KEY,
      exchange_id TEXT NOT NULL UNIQUE REFERENCES raw_exchange_refs(exchange_id),
      agent_session_id TEXT NOT NULL REFERENCES agent_sessions(id),
      agent_thread_id TEXT NOT NULL REFERENCES agent_threads(id),
      agent_turn_id TEXT REFERENCES agent_turns(id),
      kind TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      duration_ms INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE usage_ledger (
      exchange_id TEXT PRIMARY KEY REFERENCES raw_exchange_refs(exchange_id),
      agent_session_id TEXT NOT NULL REFERENCES agent_sessions(id),
      agent_thread_id TEXT NOT NULL REFERENCES agent_threads(id),
      agent_turn_id TEXT REFERENCES agent_turns(id),
      agent_step_id TEXT REFERENCES agent_steps(id),
      target_id TEXT NOT NULL,
      agent_fingerprint_id TEXT NOT NULL,
      agent_name TEXT NOT NULL,
      model TEXT NOT NULL,
      vendor TEXT NOT NULL,
      rate_multiplier REAL NOT NULL,
      input_tokens INTEGER NOT NULL,
      cache_read_tokens INTEGER NOT NULL,
      cache_write_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      vendor_cost REAL NOT NULL,
      actual_cost REAL NOT NULL,
      duration_ms INTEGER NOT NULL,
      usage_source TEXT NOT NULL,
      usage_confidence TEXT NOT NULL,
      pricing_snapshot_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    INSERT INTO ingestion_sources(id, relative_path, file_id, updated_at)
    VALUES(1, 'captures/v2/aux.jsonl', 'aux-file', '2026-07-19T00:00:00.000Z');
    INSERT INTO raw_exchange_refs(
      exchange_id, capture_session_id, source_id, byte_offset,
      line_length_bytes, captured_at, completed_at, target_id, target_name,
      agent_name, agent_fingerprint_id, status, is_streaming,
      request_body_bytes, response_body_bytes
    ) VALUES(
      'aux-exchange', 'capture-aux', 1, 0, 128,
      '2026-07-19T00:00:00.000Z', '2026-07-19T00:00:01.000Z',
      'target-1', 'Target', 'codex', 'fingerprint-aux', 200, 0, 0, 128
    );
    INSERT INTO agent_sessions(
      id, target_id, target_name, agent_fingerprint_id, agent_name,
      source, confidence, start_time, end_time, request_count, thread_count
    ) VALUES(
      'session-aux', 'target-1', 'Target', 'fingerprint-aux', 'codex',
      'capture-session', 'low', '2026-07-19T00:00:00.000Z',
      '2026-07-19T00:00:00.000Z', 1, 1
    );
    INSERT INTO agent_threads(
      id, agent_session_id, source, display_name, confidence, is_root,
      start_time, end_time, request_count, turn_count
    ) VALUES(
      'thread-aux', 'session-aux', 'default-root', '根 Thread', 'low', 1,
      '2026-07-19T00:00:00.000Z', '2026-07-19T00:00:00.000Z', 1, 0
    );
    INSERT INTO thread_closure(ancestor_thread_id, descendant_thread_id, depth)
    VALUES('thread-aux', 'thread-aux', 0);
    INSERT INTO auxiliary_requests(
      id, exchange_id, agent_session_id, agent_thread_id, kind, timestamp
    ) VALUES(
      'aux-1', 'aux-exchange', 'session-aux', 'thread-aux',
      'metadata', '2026-07-19T00:00:00.000Z'
    );
    INSERT INTO usage_ledger(
      exchange_id, agent_session_id, agent_thread_id, target_id,
      agent_fingerprint_id, agent_name, model, vendor, rate_multiplier,
      input_tokens, cache_read_tokens, cache_write_tokens, output_tokens,
      vendor_cost, actual_cost, duration_ms, usage_source, usage_confidence,
      pricing_snapshot_json, created_at
    ) VALUES(
      'aux-exchange', 'session-aux', 'thread-aux', 'target-1',
      'fingerprint-aux', 'codex', 'unknown', 'unknown', 1,
      0, 0, 0, 0, 0, 0, 10, 'unavailable', 'unavailable', '{}',
      '2026-07-19T00:00:00.000Z'
    );
    INSERT INTO scope_aggregates(
      scope_type, scope_id, auxiliary_request_count, updated_at
    ) VALUES
      ('session', 'session-aux', 1, '2026-07-19T00:00:00.000Z'),
      ('thread', 'thread-aux', 1, '2026-07-19T00:00:00.000Z');
    UPDATE schema_meta SET schema_version = 9 WHERE id = 1;
  `);
  db.pragma("user_version = 9");
}

function seedLegacyV1Schema(
  db: DeepaaDatabase,
  options: { includeSchemaMeta: boolean },
): void {
  db.exec(`
    ${options.includeSchemaMeta ? `
      CREATE TABLE schema_meta (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        schema_version INTEGER NOT NULL,
        initialized_at TEXT NOT NULL,
        data_version INTEGER NOT NULL DEFAULT 0,
        worker_status TEXT NOT NULL DEFAULT 'idle',
        worker_error TEXT
      );
      INSERT INTO schema_meta(
        id, schema_version, initialized_at, data_version, worker_status
      ) VALUES(1, 1, '2026-07-16T00:00:00.000Z', 3, 'idle');
    ` : ""}
    CREATE TABLE ingestion_sources (
      id INTEGER PRIMARY KEY,
      relative_path TEXT NOT NULL UNIQUE,
      file_id TEXT NOT NULL,
      byte_offset INTEGER NOT NULL DEFAULT 0 CHECK (byte_offset >= 0),
      file_size INTEGER NOT NULL DEFAULT 0 CHECK (file_size >= 0),
      processed_count INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'ready',
      error TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE agent_sessions (
      id TEXT PRIMARY KEY,
      target_id TEXT NOT NULL,
      agent_name TEXT NOT NULL,
      external_conversation_id TEXT,
      end_time TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE agent_threads (
      id TEXT PRIMARY KEY,
      agent_session_id TEXT NOT NULL,
      is_root INTEGER NOT NULL
    );
    CREATE TABLE agent_turns (
      id TEXT PRIMARY KEY,
      agent_thread_id TEXT NOT NULL,
      native_turn_id TEXT,
      status TEXT NOT NULL,
      segment_index INTEGER NOT NULL,
      end_time TEXT NOT NULL
    );
    CREATE TABLE tool_calls (
      id TEXT PRIMARY KEY,
      agent_thread_id TEXT NOT NULL,
      agent_turn_id TEXT NOT NULL,
      agent_step_id TEXT NOT NULL DEFAULT '',
      tool_use_id TEXT,
      tool_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'requested'
    );
    CREATE TABLE derivation_diagnostics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      exchange_id TEXT,
      source_id INTEGER,
      code TEXT NOT NULL,
      details_json TEXT NOT NULL DEFAULT '{}'
    );
    INSERT INTO ingestion_sources(
      id, relative_path, file_id, byte_offset, file_size, processed_count,
      status, error, updated_at
    ) VALUES(
      1, 'captures/v2/legacy.jsonl', 'legacy-file', 128, 256, 2,
      'reset', 'legacy-error', '2026-07-16T00:00:00.000Z'
    );
  `);
  db.pragma("user_version = 1");
}

function seedLegacyV2Schema(
  db: DeepaaDatabase,
  options: { includeSchemaMeta: boolean },
): void {
  seedLegacyV1Schema(db, options);
  db.exec(`
    ALTER TABLE ingestion_sources
      ADD COLUMN generation INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0);
  `);
  if (options.includeSchemaMeta) {
    db.prepare("UPDATE schema_meta SET schema_version = 2 WHERE id = 1").run();
  }
  db.pragma("user_version = 2");
}

function hasColumn(
  db: DeepaaDatabase,
  table: string,
  column: string,
): boolean {
  return (db.pragma(`table_info(${table})`) as Array<{ name: string }>)
    .some((item) => item.name === column);
}

function hasTable(db: DeepaaDatabase, tableName: string): boolean {
  return db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(tableName) !== undefined;
}

function hasIndex(db: DeepaaDatabase, indexName: string): boolean {
  return db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?",
  ).get(indexName) !== undefined;
}

function queryPlanDetails(
  db: DeepaaDatabase,
  sql: string,
  ...parameters: unknown[]
): string[] {
  return db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...parameters)
    .map(row => (row as { detail: string }).detail);
}

function task6LookupIndexNames(): string[] {
  return [
    "idx_turns_open",
    "idx_turns_native",
    "idx_turns_segment",
    "idx_tools_turn_use",
  ];
}

function downgradeToLegacyV3(
  db: DeepaaDatabase,
  options: { includeSchemaMeta: boolean },
): void {
  db.exec(`
    DROP INDEX IF EXISTS idx_threads_root;
    DROP INDEX IF EXISTS idx_diagnostics_dedupe;
    DROP INDEX IF EXISTS idx_sessions_conversation;
    DROP INDEX IF EXISTS idx_turns_open;
    DROP INDEX IF EXISTS idx_turns_native;
    DROP INDEX IF EXISTS idx_turns_segment;
    DROP INDEX IF EXISTS idx_tools_turn_use;
    DROP INDEX IF EXISTS idx_sessions_target_agent_latest;
    DROP INDEX IF EXISTS idx_tools_turn_step_name_status;
  `);
  if (options.includeSchemaMeta) {
    db.prepare("UPDATE schema_meta SET schema_version = 3 WHERE id = 1").run();
  } else {
    db.exec("DROP TABLE schema_meta");
  }
  db.pragma("user_version = 3");
}

function downgradeToLegacyV4(
  db: DeepaaDatabase,
  options: { includeSchemaMeta: boolean },
): void {
  db.exec(`
    DROP INDEX IF EXISTS idx_sessions_conversation;
    DROP INDEX IF EXISTS idx_turns_open;
    DROP INDEX IF EXISTS idx_turns_native;
    DROP INDEX IF EXISTS idx_turns_segment;
    DROP INDEX IF EXISTS idx_tools_turn_use;
    DROP INDEX IF EXISTS idx_sessions_target_agent_latest;
    DROP INDEX IF EXISTS idx_tools_turn_step_name_status;
  `);
  if (options.includeSchemaMeta) {
    db.prepare("UPDATE schema_meta SET schema_version = 4 WHERE id = 1").run();
  } else {
    db.exec("DROP TABLE schema_meta");
  }
  db.pragma("user_version = 4");
}

function downgradeToLegacyV5(
  db: DeepaaDatabase,
  options: { includeSchemaMeta: boolean },
): void {
  for (const indexName of task6LookupIndexNames()) {
    db.exec(`DROP INDEX IF EXISTS ${indexName}`);
  }
  db.exec(`
    DROP INDEX IF EXISTS idx_sessions_target_agent_latest;
    DROP INDEX IF EXISTS idx_tools_turn_step_name_status;
  `);
  if (options.includeSchemaMeta) {
    db.prepare("UPDATE schema_meta SET schema_version = 5 WHERE id = 1").run();
  } else {
    db.exec("DROP TABLE schema_meta");
  }
  db.pragma("user_version = 5");
}

function downgradeToLegacyV6(
  db: DeepaaDatabase,
  options: { includeSchemaMeta: boolean },
): void {
  db.exec(`
    DROP INDEX IF EXISTS idx_sessions_target_agent_latest;
    DROP INDEX IF EXISTS idx_tools_turn_step_name_status;
  `);
  if (options.includeSchemaMeta) {
    db.prepare("UPDATE schema_meta SET schema_version = 6 WHERE id = 1").run();
  } else {
    db.exec("DROP TABLE schema_meta");
  }
  db.pragma("user_version = 6");
}

function seedHierarchy(db: DeepaaDatabase): void {
  db.exec(`
    INSERT INTO ingestion_sources(
      id, relative_path, file_id, updated_at
    ) VALUES(1, 'captures/v2/test.jsonl', 'file-1', '2026-07-16T00:00:00.000Z');
    INSERT INTO agent_sessions(
      id, target_id, target_name, agent_fingerprint_id, agent_name,
      source, confidence, start_time, end_time
    ) VALUES(
      'session-1', 'target-1', 'Target', 'fingerprint-1', 'codex',
      'provider', 'high', '2026-07-16T00:00:00.000Z', '2026-07-16T00:00:01.000Z'
    );
    INSERT INTO agent_threads(
      id, agent_session_id, source, display_name, confidence, is_root,
      start_time, end_time
    ) VALUES(
      'thread-1', 'session-1', 'provider', 'Root', 'high', 1,
      '2026-07-16T00:00:00.000Z', '2026-07-16T00:00:01.000Z'
    );
    INSERT INTO thread_closure(
      ancestor_thread_id, descendant_thread_id, depth
    ) VALUES('thread-1', 'thread-1', 0);
    INSERT INTO agent_turns(
      id, agent_session_id, agent_thread_id, source, confidence, status,
      segment_index, start_exchange_id, start_time, end_time
    ) VALUES(
      'turn-1', 'session-1', 'thread-1', 'provider', 'high', 'open', 0,
      'exchange-1', '2026-07-16T00:00:00.000Z', '2026-07-16T00:00:01.000Z'
    );
  `);
  insertRawExchange(db, "exchange-1", 0);
  db.prepare(
    `INSERT INTO agent_steps(
      id, exchange_id, agent_session_id, agent_thread_id, agent_turn_id,
      step_index, timestamp, phase, request_action, response_action
    ) VALUES(
      'step-1', 'exchange-1', 'session-1', 'thread-1', 'turn-1', 0,
      '2026-07-16T00:00:00.000Z', 'main', 'request', 'response'
    )`,
  ).run();
}
