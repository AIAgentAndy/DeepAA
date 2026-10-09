import {describe, expect, test} from "vitest";
import {createRollupRepository} from "../src/lib/analytics/rollup-repository.js";
import {createSqliteFixture} from "./helpers/sqlite-fixture.js";

describe("小时分析事实重建", () => {
  test("同一小时重复重建不会翻倍，并从账本按维度聚合", async () => {
    const fixture = await createSqliteFixture();
    try {
      fixture.db.pragma("foreign_keys = OFF");
      fixture.db.prepare(`INSERT INTO usage_ledger(
        exchange_id, target_id, agent_fingerprint_id, agent_name, model, vendor,
        rate_multiplier, input_tokens, cache_read_tokens, cache_write_tokens,
        output_tokens, reasoning_tokens, total_tokens, currency, vendor_cost,
        actual_cost, duration_ms, usage_source, usage_confidence,
        pricing_snapshot_json, created_at, request_kind, result_class,
        usage_quality, pricing_status, audit_eligible, derived_total_tokens,
        total_tokens_basis, cost_basis, vendor_cost_nano, actual_cost_nano
      ) VALUES (?, 't', 'fp', 'codex', 'm', 'v', 1, 10, 2, 0, 5, 1, 17,
        'USD', 1.5, 1.5, 100, 'provider_usage', 'exact', '{}',
        '2026-08-25T10:12:00.000Z', 'model', 'success', 'exact', 'priced', 1,
        17, 'derived', 'payg_rate', 1500000000, 1500000000)`)
        .run("ex-1");
      const repository = createRollupRepository(fixture.db);
      await repository.rebuildBucket("2026-08-25T10:00:00.000Z");
      await repository.rebuildBucket("2026-08-25T10:00:00.000Z");
      const row = fixture.db.prepare("SELECT request_count, total_tokens, vendor_cost_nano FROM analytics_hourly_facts").get() as {request_count: number; total_tokens: number; vendor_cost_nano: number};
      expect(row).toEqual({request_count: 1, total_tokens: 17, vendor_cost_nano: 1_500_000_000});
    } finally {
      await fixture.cleanup();
    }
  });

  test("小时事实是账本的确定性投影：账本修正后重算精确一致（可重审）", async () => {
    const fixture = await createSqliteFixture();
    try {
      fixture.db.pragma("foreign_keys = OFF");
      const insert = fixture.db.prepare(`INSERT INTO usage_ledger(
        exchange_id, target_id, agent_fingerprint_id, agent_name, model, vendor,
        rate_multiplier, input_tokens, cache_read_tokens, cache_write_tokens,
        output_tokens, reasoning_tokens, total_tokens, currency, vendor_cost,
        actual_cost, duration_ms, usage_source, usage_confidence,
        pricing_snapshot_json, created_at, request_kind, result_class,
        usage_quality, pricing_status, audit_eligible, derived_total_tokens,
        total_tokens_basis, cost_basis, vendor_cost_nano, actual_cost_nano
      ) VALUES (?, ?, ?, ?, ?, 'v', 1, ?, 0, 0, ?, 0, ?, 'USD', ?, ?, ?,
        'provider_usage', 'exact', '{}', ?, 'model', ?,
        'exact', 'priced', 0, ?, 'derived', 'payg_rate', ?, ?)`);
      insert.run("ex-a", "t1", "fp", "codex", "m-a", 100, 10, 110, 1.0, 2.0, 500, "2026-08-25T10:05:00.000Z", "success", 110, 1_000_000_000, 2_000_000_000);
      insert.run("ex-b", "t1", "fp", "codex", "m-b", 200, 20, 220, 3.0, 6.0, 800, "2026-08-25T10:40:00.000Z", "success", 220, 3_000_000_000, 6_000_000_000);
      const repository = createRollupRepository(fixture.db);
      const factsSnapshot = () => fixture.db.prepare(
        "SELECT bucket_start_utc, model, request_count, total_tokens, vendor_cost_nano, actual_cost_nano FROM analytics_hourly_facts ORDER BY model",
      ).all();
      await repository.rebuildBucket("2026-08-25T10:00:00.000Z");
      expect(factsSnapshot()).toHaveLength(2);

      // 模拟审计修正：ex-a 账本行被更正移除、ex-b 金额修正后，同桶全量重算。
      // 2026-09-16 起 facts 金额与 Token 价格页共用同一表达式（ledger-cost-exprs.ts），
      // 输入是账本 CNY 列（vendor_cost_cny/actual_cost_cny），不再读取 nano 列。
      fixture.db.prepare("DELETE FROM usage_ledger WHERE exchange_id = 'ex-a'").run();
      fixture.db.prepare("UPDATE usage_ledger SET vendor_cost_cny = 3.5, actual_cost_cny = 7.0 WHERE exchange_id = 'ex-b'").run();
      await repository.rebuildBucket("2026-08-25T10:00:00.000Z");
      const after = factsSnapshot();
      expect(after).toEqual([{
        bucket_start_utc: "2026-08-25T10:00:00.000Z",
        model: "m-b",
        request_count: 1,
        total_tokens: 220,
        vendor_cost_nano: 3_500_000_000,
        actual_cost_nano: 7_000_000_000,
      }]);

      // 重复重建：结果保持稳定（幂等，可重复审核）。
      await repository.rebuildBucket("2026-08-25T10:00:00.000Z");
      await repository.rebuildBucket("2026-08-25T10:00:00.000Z");
      expect(factsSnapshot()).toEqual(after);
    } finally {
      await fixture.cleanup();
    }
  });

  test("请求/Token 取代语义：用量载体补差行计入，被取代原行排他（2026-09-29）", async () => {
    const fixture = await createSqliteFixture();
    try {
      fixture.db.pragma("foreign_keys = OFF");
      const insert = fixture.db.prepare(`INSERT INTO usage_ledger(
        exchange_id, target_id, agent_fingerprint_id, agent_name, model, vendor,
        rate_multiplier, input_tokens, cache_read_tokens, cache_write_tokens,
        output_tokens, reasoning_tokens, total_tokens, currency, vendor_cost,
        actual_cost, duration_ms, usage_source, usage_confidence,
        pricing_snapshot_json, created_at, request_kind, result_class,
        usage_quality, pricing_status, audit_eligible, derived_total_tokens,
        total_tokens_basis, cost_basis, vendor_cost_nano, actual_cost_nano
      ) VALUES (?, 't', 'fp', 'codex', 'm', 'v', 1, ?, 0, 0, ?, 0, ?,
        'USD', ?, ?, 100, ?, 'exact', '{}',
        '2026-08-25T10:12:00.000Z', ?, ?, 'exact', 'priced', 0,
        ?, 'derived', 'payg_rate', ?, ?)`);
      // 成功行（真实用量）+ 失败估算原行（本地金额 0）+ 站点真值载体补差行。
      insert.run("ex-ok", 50, 5, 55, 0.01, 0.01, "provider_usage", "model", "success", 55, 10_000_000, 10_000_000);
      insert.run("ex-failed", 1000, 6, 1006, 0, 0, "tokenizer_estimated", "model", "upstream_error", 1006, 0, 0);
      insert.run("recon:matched:carrier", 900, 90, 990, 0.03, 0.03, "reconciliation", "reconciliation", "reconciled", 990, 30_000_000, 30_000_000);
      fixture.db.prepare(
        `INSERT INTO relay_reconciliation_hours(
          target_id, hour_start_utc, provider_type, console_account_id,
          status, created_at, updated_at
        ) VALUES('t', '2026-08-25T10:00:00.000Z', 'sub2api', 'acct-1',
          'applied', '2026-08-25T11:00:00.000Z', '2026-08-25T11:05:00.000Z')`,
      ).run();
      fixture.db.prepare(
        `INSERT INTO relay_reconciliation_matches(
          target_id, hour_start_utc, provider_type, site_log_id, exchange_id,
          confidence, site_amount_nano, local_amount_nano, adjustment_nano,
          adjustment_exchange_id, revision, created_at, usage_carrier
        ) VALUES('t', '2026-08-25T10:00:00.000Z', 'sub2api', 'log-c',
          'ex-failed', 'weak', 30_000_000, 0, 30_000_000,
          'recon:matched:carrier', 1, '2026-08-25T11:05:00.000Z', 1)`,
      ).run();
      const repository = createRollupRepository(fixture.db);
      await repository.rebuildBucket("2026-08-25T10:00:00.000Z");
      const row = fixture.db.prepare(
        `SELECT SUM(request_count) AS request_count, SUM(model_request_count) AS model_request_count,
           SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
           SUM(total_tokens) AS total_tokens, SUM(actual_cost_nano) AS actual_cost_nano
         FROM analytics_hourly_facts`,
      ).get() as Record<string, number>;
      // 请求 2 次（成功行 + 载体行），失败原行让位；Token 用站点真值（950/95/1045），
      // 不再叠加原行估算（否则 input 1950）；金额含补差 40M nano。
      expect(row.request_count).toBe(2);
      expect(row.model_request_count).toBe(2);
      expect(row.input_tokens).toBe(950);
      expect(row.output_tokens).toBe(95);
      expect(row.total_tokens).toBe(1045);
      expect(row.actual_cost_nano).toBe(40_000_000);
    } finally {
      await fixture.cleanup();
    }
  });
});
