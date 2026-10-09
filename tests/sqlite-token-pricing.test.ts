import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { readFileSync } from "node:fs";
import { loadTokenPricingState } from "../src/lib/token-pricing.js";
import {
  createSqliteFixture,
  type SqliteFixture,
} from "./helpers/sqlite-fixture.js";

const fixtures: SqliteFixture[] = [];

test("Token 价格生产模块不再导入旧索引、旧派生或 JSONL 账本", () => {
  const source = readFileSync("src/lib/token-pricing.ts", "utf-8");
  assert.doesNotMatch(source, /captureIndexPath|readBusinessIndex|usageLedgerPath|readJsonlReverse/);
});

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});

test("明细行附加小时对账标注：原始行已对账、补差行链接原始请求", async () => {
  const fixture = await createSqliteFixture();
  fixtures.push(fixture);
  fixture.db.pragma("foreign_keys = OFF");
  const insertLedger = fixture.db.prepare(
    `INSERT INTO usage_ledger(
      exchange_id, target_id, agent_fingerprint_id, agent_name, model,
      vendor, rate_multiplier, input_tokens, cache_read_tokens,
      cache_write_tokens, output_tokens, vendor_cost, actual_cost,
      duration_ms, usage_source, usage_confidence, pricing_snapshot_json,
      request_kind, result_class, created_at
    ) VALUES(?, 'target-token', 'fp', 'codex', 'gpt-token',
      'openai', 1, 10, 0, 0, 5, 0.02, 0.02, 800,
      'provider_usage', 'exact', '{}', ?, ?, '2026-07-17T00:10:00.000Z')`,
  );
  insertLedger.run("ex-recon-origin", "model", "success");
  insertLedger.run("recon:matched:abc123", "reconciliation", "reconciled");
  fixture.db.prepare(
    `INSERT INTO agent_steps(
      id, exchange_id, agent_session_id, agent_thread_id, agent_turn_id,
      step_index, timestamp, phase, request_action, response_action,
      input_tokens, cache_read_tokens, output_tokens
    ) VALUES('step-origin', 'ex-recon-origin', 'sess-recon', 'thread-recon', 'turn-recon',
      0, '2026-07-17T00:10:00.000Z', 'respond', 'continue', 'complete', 10, 0, 5)`,
  ).run();
  fixture.db.prepare(
    `INSERT INTO relay_reconciliation_hours(
      target_id, hour_start_utc, provider_type, console_account_id,
      status, created_at, updated_at
    ) VALUES('target-token', '2026-07-17T00:00:00.000Z', 'sub2api', 'acct-1',
      'applied', '2026-07-17T01:00:00.000Z', '2026-07-17T01:05:00.000Z')`,
  ).run();
  fixture.db.prepare(
    `INSERT INTO relay_reconciliation_matches(
      target_id, hour_start_utc, provider_type, site_log_id, exchange_id,
      confidence, site_amount_nano, local_amount_nano, adjustment_nano,
      adjustment_exchange_id, revision, created_at
    ) VALUES('target-token', '2026-07-17T00:00:00.000Z', 'sub2api', 'log-1',
      'ex-recon-origin', 'weak', 30_000_000, 20_000_000, 10_000_000,
      'recon:matched:abc123', 1, '2026-07-17T01:05:00.000Z')`,
  ).run();

  const state = await loadTokenPricingState(new URLSearchParams({
    target: "target-token",
    start: "2026-07-17T00:00:00.000Z",
    end: "2026-07-17T01:00:00.000Z",
  }), { db: fixture.db, dataDir: fixture.dataDir });
  const origin = state.items.find(item => item.exchangeId === "ex-recon-origin");
  const adjustment = state.items.find(item => item.exchangeId === "recon:matched:abc123");
  assert.deepEqual(origin?.recon, {
    kind: "matched", confidence: "weak",
    siteAmountNano: 30_000_000, localAmountNano: 20_000_000,
    adjustmentNano: 10_000_000, hourStartUtc: "2026-07-17T00:00:00.000Z",
  });
  assert.deepEqual(adjustment?.recon, {
    kind: "adjustment", confidence: "weak",
    siteAmountNano: 30_000_000, localAmountNano: 20_000_000,
    adjustmentNano: 10_000_000, hourStartUtc: "2026-07-17T00:00:00.000Z",
    linkedExchangeId: "ex-recon-origin", linkedStepId: "step-origin",
    linkedSelection: {target: "target-token", agent: "codex", step: "step-origin"},
  });
  // 无匹配证据的行不带标注。
  insertLedger.run("ex-plain-row", "model", "success");
  const reloaded = await loadTokenPricingState(new URLSearchParams({
    target: "target-token",
    start: "2026-07-17T00:00:00.000Z",
    end: "2026-07-17T01:00:00.000Z",
  }), { db: fixture.db, dataDir: fixture.dataDir });
  assert.equal(reloaded.items.find(item => item.exchangeId === "ex-plain-row")?.recon, undefined);
});

test("step 级筛选命中挂靠补差行，折扣归因只认站点声明（2026-09-28）", async () => {
  const fixture = await createSqliteFixture();
  fixtures.push(fixture);
  fixture.db.pragma("foreign_keys = OFF");
  const insertLedger = fixture.db.prepare(
    `INSERT INTO usage_ledger(
      exchange_id, agent_session_id, agent_thread_id, agent_turn_id, agent_step_id,
      target_id, agent_fingerprint_id, agent_name, model,
      vendor, rate_multiplier, input_tokens, cache_read_tokens,
      cache_write_tokens, output_tokens, vendor_cost, actual_cost,
      duration_ms, usage_source, usage_confidence, pricing_snapshot_json,
      request_kind, result_class, created_at
    ) VALUES(?, 'sess-1', 'thread-1', 'turn-1', ?, 'target-token', 'fp', 'codex', 'gpt-token',
      'openai', 1, 10, 0, 0, 5, 0.02, 0.02, 800,
      'provider_usage', 'exact', '{}', ?, ?, '2026-07-17T00:10:00.000Z')`,
  );
  insertLedger.run("ex-origin-a", "step-origin-a", "model", "success");
  insertLedger.run("recon:matched:disc-a", null, "reconciliation", "reconciled");
  insertLedger.run("ex-origin-b", "step-origin-b", "model", "success");
  insertLedger.run("recon:matched:plain-b", null, "reconciliation", "reconciled");
  const insertStep = fixture.db.prepare(
    `INSERT INTO agent_steps(
      id, exchange_id, agent_session_id, agent_thread_id, agent_turn_id,
      step_index, timestamp, phase, request_action, response_action,
      input_tokens, cache_read_tokens, output_tokens
    ) VALUES(?, ?, 'sess-1', 'thread-1', 'turn-1',
      ?, '2026-07-17T00:10:00.000Z', 'respond', 'continue', 'complete', 10, 0, 5)`,
  );
  insertStep.run("step-origin-a", "ex-origin-a", 0);
  insertStep.run("step-origin-b", "ex-origin-b", 1);
  fixture.db.exec(`INSERT INTO thread_closure VALUES ('thread-1', 'thread-1', 0)`);
  // 补差行 created_at 挂站点完成时刻，天然晚于原请求时刻（真实数据约晚数秒到数十秒）。
  fixture.db.exec(
    `UPDATE usage_ledger SET created_at='2026-07-17T00:10:30.000Z'
     WHERE exchange_id IN ('recon:matched:disc-a', 'recon:matched:plain-b')`,
  );
  fixture.db.prepare(
    `INSERT INTO relay_reconciliation_hours(
      target_id, hour_start_utc, provider_type, console_account_id,
      status, created_at, updated_at
    ) VALUES('target-token', '2026-07-17T00:00:00.000Z', 'sub2api', 'acct-1',
      'applied', '2026-07-17T01:00:00.000Z', '2026-07-17T01:05:00.000Z')`,
  ).run();
  // A 组：站点声明折扣 10M 且差额 -10M 被全额解释 → 归因成立（两侧标注）。
  fixture.db.prepare(
    `INSERT INTO relay_reconciliation_matches(
      target_id, hour_start_utc, provider_type, site_log_id, exchange_id,
      confidence, site_amount_nano, local_amount_nano, adjustment_nano,
      adjustment_exchange_id, site_discount_nano, revision, created_at
    ) VALUES('target-token', '2026-07-17T00:00:00.000Z', 'sub2api', 'log-a',
      'ex-origin-a', 'exact', 90_000_000, 100_000_000, -10_000_000,
      'recon:matched:disc-a', 10_000_000, 1, '2026-07-17T01:05:00.000Z')`,
  ).run();
  // B 组：与 A 完全相同的差额比例，但站点未声明折扣（字段 NULL）→ 不得归因。
  fixture.db.prepare(
    `INSERT INTO relay_reconciliation_matches(
      target_id, hour_start_utc, provider_type, site_log_id, exchange_id,
      confidence, site_amount_nano, local_amount_nano, adjustment_nano,
      adjustment_exchange_id, site_discount_nano, revision, created_at
    ) VALUES('target-token', '2026-07-17T00:00:00.000Z', 'sub2api', 'log-b',
      'ex-origin-b', 'exact', 90_000_000, 100_000_000, -10_000_000,
      'recon:matched:plain-b', NULL, 1, '2026-07-17T01:05:00.000Z')`,
  ).run();

  // step 级筛选：原始请求与其挂靠补差行必须同时出现（补差行 agent_step_id 恒 NULL）。
  const stepState = await loadTokenPricingState(new URLSearchParams({
    target: "target-token",
    step: "step-origin-a",
    start: "2026-07-17T00:00:00.000Z",
    end: "2026-07-17T01:00:00.000Z",
  }), { db: fixture.db, dataDir: fixture.dataDir });
  assert.deepEqual(stepState.items.map(item => item.exchangeId).sort(),
    ["ex-origin-a", "recon:matched:disc-a"]);

  // 真实深链形态：不带显式时间范围时默认窗口坍缩为 step 时刻（start=end），
  // 挂靠补差行（created_at 晚于原请求）靠时间窗豁免仍必须出现（2026-09-28 修复）。
  const deepLinkState = await loadTokenPricingState(new URLSearchParams({
    target: "target-token",
    step: "step-origin-a",
    limit: "10",
  }), { db: fixture.db, dataDir: fixture.dataDir });
  assert.deepEqual(deepLinkState.items.map(item => item.exchangeId).sort(),
    ["ex-origin-a", "recon:matched:disc-a"]);

  const fullState = await loadTokenPricingState(new URLSearchParams({
    target: "target-token",
    start: "2026-07-17T00:00:00.000Z",
    end: "2026-07-17T01:00:00.000Z",
  }), { db: fixture.db, dataDir: fixture.dataDir });
  const originA = fullState.items.find(item => item.exchangeId === "ex-origin-a");
  const adjustmentA = fullState.items.find(item => item.exchangeId === "recon:matched:disc-a");
  // 站点声明 + 全额解释 → 折扣归因标注成立，补差行带六元组深链上下文。
  assert.equal(originA?.recon?.discountExplainsDelta, true);
  assert.equal(originA?.recon?.siteDiscountNano, 10_000_000);
  assert.equal(adjustmentA?.recon?.discountExplainsDelta, true);
  assert.deepEqual(adjustmentA?.recon?.linkedSelection, {
    target: "target-token", agent: "codex", session: "sess-1",
    thread: "thread-1", turn: "turn-1", step: "step-origin-a",
  });
  // 比率巧合但无站点声明 → 不得出现折扣归因。
  const originB = fullState.items.find(item => item.exchangeId === "ex-origin-b");
  const adjustmentB = fullState.items.find(item => item.exchangeId === "recon:matched:plain-b");
  assert.equal(originB?.recon?.discountExplainsDelta, undefined);
  assert.equal(originB?.recon?.siteDiscountNano, undefined);
  assert.equal(adjustmentB?.recon?.discountExplainsDelta, undefined);
  assert.equal(adjustmentB?.recon?.siteDiscountNano, undefined);
});

test("四级深链从 SQLite 恢复路径并按 Step 汇总", async () => {
  const fixture = await createSqliteFixture();
  fixtures.push(fixture);
  const seeded = seedTokenPricingFixture(fixture, 150);
  const selectedStep = seeded.stepIds[0]!;

  const state = await loadTokenPricingState(new URLSearchParams({
    step: selectedStep,
  }), { db: fixture.db, dataDir: fixture.dataDir });

  assert.deepEqual(state.resolvedSelection, {
    session: seeded.sessionId,
    thread: seeded.childThreadId,
    turn: seeded.turnId,
    step: selectedStep,
  });
  assert.deepEqual(
    state.facets.threads.map((option) => option.value),
    [seeded.childThreadId, seeded.rootThreadId],
  );
  assert.deepEqual(state.facets.turns.map((option) => option.value), [seeded.turnId]);
  assert.equal(state.facets.steps.length, 100);
  assert.ok(state.facets.steps.some((option) => option.value === selectedStep));
  assert.equal(state.limited.facetLimits.steps, true);
  assert.equal(state.summary.requestCount, 1);
  assert.equal(state.summary.inputTokens, 10);
  assert.equal(state.summary.cacheReadTokens, 20);
  assert.equal(state.summary.cacheHitRate, 20 / 30);
  assert.equal(state.summary.averageDurationSeconds, undefined);
  assert.equal(state.summary.durationSampleCount, 0);

  const legacy = await loadTokenPricingState(new URLSearchParams({
    step: seeded.exchangeIds[0]!,
  }), { db: fixture.db, dataDir: fixture.dataDir });
  assert.equal(legacy.resolvedSelection?.step, selectedStep);
  assert.equal(legacy.summary.requestCount, 1);
});

test("账本 first_token_ms 透传到请求列表首字字段", async () => {
  const fixture = await createSqliteFixture();
  fixtures.push(fixture);
  fixture.db.pragma("foreign_keys = OFF");
  fixture.db.prepare(
    `INSERT INTO usage_ledger(
      exchange_id, target_id, agent_fingerprint_id, agent_name, model,
      vendor, rate_multiplier, input_tokens, cache_read_tokens,
      cache_write_tokens, output_tokens, vendor_cost, actual_cost,
      duration_ms, usage_source, usage_confidence, pricing_snapshot_json,
      result_class, created_at, first_token_ms
    ) VALUES(
      'ex-ttft-yes', 'target-token', 'fp', 'codex', 'gpt-token',
      'openai', 1, 10, 20, 0, 4, 0.5, 0.4,
      800, 'provider_usage', 'exact', '{}',
      'success', '2026-07-17T00:01:00.000Z', 420
    )`,
  ).run();
  fixture.db.prepare(
    `INSERT INTO usage_ledger(
      exchange_id, target_id, agent_fingerprint_id, agent_name, model,
      vendor, rate_multiplier, input_tokens, cache_read_tokens,
      cache_write_tokens, output_tokens, vendor_cost, actual_cost,
      duration_ms, usage_source, usage_confidence, pricing_snapshot_json,
      result_class, created_at
    ) VALUES(
      'ex-ttft-no', 'target-token', 'fp', 'codex', 'gpt-token',
      'openai', 1, 10, 20, 0, 4, 0.5, 0.4,
      800, 'provider_usage', 'exact', '{}',
      'success', '2026-07-17T00:02:00.000Z'
    )`,
  ).run();

  const state = await loadTokenPricingState(new URLSearchParams({
    target: "target-token",
    start: "2026-07-17T00:00:00.000Z",
    end: "2026-07-17T01:00:00.000Z",
  }), { db: fixture.db, dataDir: fixture.dataDir });
  assert.equal(state.items.find(item => item.exchangeId === "ex-ttft-yes")?.firstTokenMs, 420);
  assert.equal(state.items.find(item => item.exchangeId === "ex-ttft-no")?.firstTokenMs, undefined);
});

test("长上下文档位行展示单价按 ×2/×1.5 换档，公式分项与账本金额自洽", async () => {
  const fixture = await createSqliteFixture();
  fixtures.push(fixture);
  // 快照形状与生产派生一致：baseRates 携带档位定义，顶层 longContext 为命中信息。
  const snapshot = JSON.stringify({
    unit: "per_million_tokens",
    matchedModel: "catalog:openai:gpt-5.6-sol",
    longContext: {thresholdTokens: 272000, contextTokens: 305822, inputMultiplier: 2, outputMultiplier: 1.5},
    vendor: "openai",
    priceEntryId: "catalog:openai:gpt-5.6-sol",
    confidence: "official",
    matchStrategy: "target_model_entry",
    baseRates: {
      input: 5,
      output: 30,
      cachedInput: 0.5,
      cacheWrite: 7.5,
      longContext: {inputMultiplier: 2, outputMultiplier: 1.5, thresholdTokens: 272000},
    },
    rateMultiplier: 0.15,
    priced: true,
    currency: "USD",
  });
  fixture.db.pragma("foreign_keys = OFF");
  const insert = fixture.db.prepare(
    `INSERT INTO usage_ledger(
      exchange_id, target_id, agent_fingerprint_id, agent_name, model,
      vendor, rate_multiplier, input_tokens, cache_read_tokens,
      cache_write_tokens, output_tokens, vendor_cost, actual_cost,
      duration_ms, usage_source, usage_confidence, pricing_snapshot_json,
      result_class, created_at
    ) VALUES(?, ?, 'fp', 'codex', 'gpt-5.6-sol', 'openai', 0.15, ?, 0, 0, ?, ?, ?, 800, 'provider_usage', 'exact', ?, 'success', '2026-09-21T16:55:33.000Z')`,
  );
  // 命中行：上下文 305,822 > 272,000，账本 vendor_cost 已按 ×2/×1.5 落库。
  insert.run("ex-lctx-hit", "catapi.chat", 305822, 3064, 3.1961, 0.479415, snapshot);
  // 未命中行：上下文 100,000 ≤ 272,000，同一快照但账本按基础价落库。
  insert.run("ex-lctx-base", "catapi.chat", 100000, 3064, 0.5 + 3064 * 30 / 1_000_000, (0.5 + 3064 * 30 / 1_000_000) * 0.15, snapshot);

  const state = await loadTokenPricingState(new URLSearchParams({
    target: "catapi.chat",
    start: "2026-09-21T00:00:00.000Z",
    end: "2026-09-22T00:00:00.000Z",
  }), { db: fixture.db, dataDir: fixture.dataDir });

  const hit = state.items.find(item => item.exchangeId === "ex-lctx-hit");
  assert.ok(hit);
  assert.deepEqual(hit.longContextTier, {
    thresholdTokens: 272000,
    contextTokens: 305822,
    inputMultiplier: 2,
    outputMultiplier: 1.5,
  });
  assert.equal(hit.inputUnitPrice, 10);
  assert.equal(hit.outputUnitPrice, 45);
  assert.equal(hit.cacheReadUnitPrice, 1);
  assert.equal(hit.cacheWriteUnitPrice, 15);
  assert.ok(Math.abs((hit.inputCost ?? 0) - 3.05822) < 1e-9);
  assert.ok(Math.abs((hit.outputCost ?? 0) - 0.13788) < 1e-9);
  // 分项之和与账本落库金额自洽（修复前公式按基础价算出 1.621，与 3.1961 对不上）。
  assert.ok(Math.abs((hit.inputCost ?? 0) + (hit.outputCost ?? 0) - (hit.vendorCost ?? 0)) < 1e-9);
  assert.ok(hit.vendorCostFormula?.includes("* 10"));
  assert.ok(hit.vendorCostFormula?.includes("* 45"));
  assert.ok(!hit.vendorCostFormula?.includes("* 5"));

  const base = state.items.find(item => item.exchangeId === "ex-lctx-base");
  assert.ok(base);
  assert.equal(base.longContextTier, undefined);
  assert.equal(base.inputUnitPrice, 5);
  assert.equal(base.outputUnitPrice, 30);
  assert.ok(Math.abs((base.inputCost ?? 0) + (base.outputCost ?? 0) - (base.vendorCost ?? 0)) < 1e-9);
});

test("明细行携带人民币口径金额与冻结结算系数（2026-09-23 统一口径）", async () => {
  const fixture = await createSqliteFixture();
  fixtures.push(fixture);
  fixture.db.pragma("foreign_keys = OFF");
  const insert = fixture.db.prepare(
    `INSERT INTO usage_ledger(
      exchange_id, target_id, agent_fingerprint_id, agent_name, model,
      vendor, rate_multiplier, input_tokens, cache_read_tokens,
      cache_write_tokens, output_tokens, vendor_cost, actual_cost,
      vendor_cost_cny, actual_cost_cny, fx_rate_to_cny, currency,
      duration_ms, usage_source, usage_confidence, pricing_snapshot_json,
      result_class, created_at
    ) VALUES(?, 'target-relay', 'fp', 'codex', 'glm-5.3', 'auto-code.net', 4,
      1_000_000, 0, 0, 0, 0.025539, 0.102156, ?, ?, ?, 'USD',
      800, 'provider_usage', 'exact', '{}', 'success', '2026-09-23T00:01:00.000Z')`,
  );
  // 物化列齐全的中转站行（结算系数 16）：明细直接读人民币物化值。
  insert.run("ex-cny-materialized", 0.408624, 1.634496, 16);
  // 缺 cny 物化列的历史形状：按原币种 × 冻结系数折算。
  insert.run("ex-cny-fallback", null, null, 16);

  const state = await loadTokenPricingState(new URLSearchParams({
    target: "target-relay",
    start: "2026-09-23T00:00:00.000Z",
    end: "2026-09-23T01:00:00.000Z",
  }), { db: fixture.db, dataDir: fixture.dataDir });

  const materialized = state.items.find(item => item.exchangeId === "ex-cny-materialized");
  assert.ok(materialized);
  assert.equal(materialized.vendorCost, 0.025539);
  assert.equal(materialized.actualCost, 0.102156);
  assert.equal(materialized.fxRateToCny, 16);
  assert.ok(Math.abs((materialized.vendorCostCny ?? 0) - 0.408624) < 1e-9);
  assert.ok(Math.abs((materialized.actualCostCny ?? 0) - 1.634496) < 1e-9);
  assert.equal(materialized.currency, "USD");

  const fallback = state.items.find(item => item.exchangeId === "ex-cny-fallback");
  assert.ok(fallback);
  assert.ok(Math.abs((fallback.vendorCostCny ?? 0) - 0.025539 * 16) < 1e-9);
  assert.ok(Math.abs((fallback.actualCostCny ?? 0) - 0.102156 * 16) < 1e-9);
});

test("Step 深链的代理目标 facet 展示时间窗外仍有数据的目标", async () => {
  const fixture = await createSqliteFixture();
  fixtures.push(fixture);
  const seeded = seedTokenPricingFixture(fixture, 2);
  fixture.db.prepare(
    `UPDATE usage_ledger SET target_id = 'target-alt' WHERE exchange_id = ?`,
  ).run(seeded.exchangeIds[1]);

  const state = await loadTokenPricingState(new URLSearchParams({
    step: seeded.stepIds[0]!,
  }), { db: fixture.db, dataDir: fixture.dataDir });

  assert.deepEqual(
    state.facets.targets.map((option) => option.value).sort(),
    ["target-alt", "target-token"],
  );
});

test("按代理目标和模型聚合 Token、消费、缓存命中率与每百万 Token 单价", async () => {
  const fixture = await createSqliteFixture();
  fixtures.push(fixture);
  const seeded = seedTokenPricingFixture(fixture, 4);
  fixture.db.prepare(
    `UPDATE usage_ledger
     SET target_id = 'target-alt', model = 'gpt-alt',
       input_tokens = 100, cache_read_tokens = 50,
       cache_write_tokens = 10, output_tokens = 20,
       vendor_cost = 4, actual_cost = 2.5, duration_ms = 1000
     WHERE exchange_id IN (?, ?)`
  ).run(seeded.exchangeIds[0], seeded.exchangeIds[1]);
  fixture.db.prepare(
    `UPDATE usage_ledger
     SET target_id = 'target-zero', model = 'gpt-zero',
       input_tokens = 0, cache_read_tokens = 0,
       cache_write_tokens = 0, output_tokens = 0,
       vendor_cost = 0, actual_cost = 0, duration_ms = 0
     WHERE exchange_id = ?`
  ).run(seeded.exchangeIds[2]);

  const state = await loadTokenPricingState(new URLSearchParams({
    start: "2026-07-17T00:00:00.000Z",
    end: "2026-07-17T01:00:00.000Z",
  }), { db: fixture.db, dataDir: fixture.dataDir });

  const alternate = state.breakdown.find(item => item.targetId === "target-alt");
  assert.ok(alternate);
  assert.equal(alternate.model, "gpt-alt");
  assert.equal(alternate.requestCount, 2);
  assert.equal(alternate.inputTokens, 200);
  assert.equal(alternate.cacheReadTokens, 100);
  assert.equal(alternate.cacheCreationTokens, 20);
  assert.equal(alternate.outputTokens, 40);
  assert.equal(alternate.cacheHitRate, 1 / 3);
  assert.equal(alternate.vendorCost, 8);
  assert.equal(alternate.actualCost, 5);
  assert.equal(alternate.averageDurationSeconds, 1);
  assert.equal(alternate.totalTokens, 360);
  assert.equal(alternate.actualCostPerMillionTokens, (5 / 360) * 1_000_000);

  const zero = state.breakdown.find(item => item.targetId === "target-zero");
  assert.ok(zero);
  assert.equal(zero.totalTokens, 0);
  assert.equal(zero.actualCostPerMillionTokens, undefined);

  const filtered = await loadTokenPricingState(new URLSearchParams({
    target: "target-alt",
    model: "gpt-alt",
    start: "2026-07-17T00:00:00.000Z",
    end: "2026-07-17T01:00:00.000Z",
  }), { db: fixture.db, dataDir: fixture.dataDir });
  assert.deepEqual(filtered.breakdown.map(item => `${item.targetId}/${item.model}`), ["target-alt/gpt-alt"]);
});

test("目标级辅助账本默认不进入汇总，includeAuxiliary=yes 时进入但不伪造 Session 层级", async () => {
  const fixture = await createSqliteFixture();
  fixtures.push(fixture);
  const seeded = seedTokenPricingFixture(fixture, 2);
  const sourceId = fixture.db.prepare("SELECT id FROM ingestion_sources LIMIT 1").pluck().get() as number;
  fixture.db.prepare(
    `INSERT INTO raw_exchange_refs(
      exchange_id, capture_session_id, source_id, byte_offset,
      line_length_bytes, captured_at, completed_at, target_id, target_name,
      agent_name, agent_fingerprint_id, status, is_streaming,
      request_body_bytes, response_body_bytes
    ) VALUES(
      'exchange-target-metadata', 'capture-token', ?, 999999, 128,
      '2026-07-17T00:30:00.000Z', '2026-07-17T00:30:00.100Z',
      'target-token', 'Token Target', 'codex', 'fingerprint-metadata',
      200, 0, 0, 128
    )`,
  ).run(sourceId);
  fixture.db.prepare(
    `INSERT INTO usage_ledger(
      exchange_id, agent_session_id, agent_thread_id, agent_turn_id,
      agent_step_id, target_id, agent_fingerprint_id, agent_name, model,
      vendor, rate_multiplier, input_tokens, cache_read_tokens,
      cache_write_tokens, output_tokens, vendor_cost, actual_cost,
      duration_ms, usage_source, usage_confidence, pricing_snapshot_json,
      result_class, created_at
    ) VALUES(
      'exchange-target-metadata', NULL, NULL, NULL, NULL,
      'target-token', 'fingerprint-metadata', 'codex', 'unknown',
      'unknown', 1, 0, 0, 0, 0, 0, 0, 100,
      'unavailable', 'unavailable', '{}', 'success', '2026-07-17T00:30:00.000Z'
    )`,
  ).run();

  const global = await loadTokenPricingState(new URLSearchParams({
    target: "target-token",
    start: "2026-07-17T00:00:00.000Z",
    end: "2026-07-17T01:00:00.000Z",
  }), { db: fixture.db, dataDir: fixture.dataDir });
  // 默认“是否包含辅助请求=否”：unknown 辅助行被过滤
  assert.equal(global.summary.requestCount, 2);
  assert.equal(global.items.find(item => item.exchangeId === "exchange-target-metadata"), undefined);
  assert.deepEqual(global.breakdown.map(item => item.model), ["gpt-token"]);

  const withAuxiliary = await loadTokenPricingState(new URLSearchParams({
    target: "target-token",
    includeAuxiliary: "yes",
    start: "2026-07-17T00:00:00.000Z",
    end: "2026-07-17T01:00:00.000Z",
  }), { db: fixture.db, dataDir: fixture.dataDir });
  const auxiliary = withAuxiliary.items.find(item => item.exchangeId === "exchange-target-metadata");
  assert.equal(withAuxiliary.summary.requestCount, 3);
  assert.ok(auxiliary);
  assert.equal(auxiliary.sessionId, "");
  assert.equal(auxiliary.threadId, "");
  assert.equal(auxiliary.turnId, "");

  const session = await loadTokenPricingState(new URLSearchParams({
    session: seeded.sessionId,
  }), { db: fixture.db, dataDir: fixture.dataDir });
  assert.equal(session.summary.requestCount, 2);
});

test("tokenizer_estimated 费用不纳入实际总消费，请求与 Token 保留，失败状态透出", async () => {
  const fixture = await createSqliteFixture();
  fixtures.push(fixture);
  const seeded = seedTokenPricingFixture(fixture, 4);
  // 三条正常请求：各 1000ms；一条估算失败请求：13.7s 长挂 + 估算费用
  fixture.db.prepare(
    `UPDATE usage_ledger
     SET duration_ms = 1000, actual_cost = 1, vendor_cost = 1,
       usage_source = 'provider_usage', usage_confidence = 'exact'
     WHERE exchange_id IN (?, ?, ?)`
  ).run(seeded.exchangeIds[0], seeded.exchangeIds[1], seeded.exchangeIds[2]);
  fixture.db.prepare(
    `UPDATE usage_ledger
     SET duration_ms = 13713028, input_tokens = 151454, output_tokens = 6,
       actual_cost = 0.151466, vendor_cost = 0,
       usage_source = 'tokenizer_estimated', usage_confidence = 'medium'
     WHERE exchange_id = ?`
  ).run(seeded.exchangeIds[3]);
  fixture.db.prepare(
    `UPDATE raw_exchange_refs
     SET status = 502, diagnostic_codes_json = '["upstream_error","connection_error"]'
     WHERE exchange_id = ?`
  ).run(seeded.exchangeIds[3]);

  const state = await loadTokenPricingState(new URLSearchParams({
    start: "2026-07-17T00:00:00.000Z",
    end: "2026-07-17T01:00:00.000Z",
  }), { db: fixture.db, dataDir: fixture.dataDir });

  // 实际总消费剔除估算费用（1+1+1），请求数与 Token 保留
  assert.equal(state.summary.requestCount, 4);
  assert.equal(state.summary.actualCost, 3);
  assert.equal(state.summary.inputTokens, 151454 + 30);
  // 平均 3429s 被长挂请求拉高，中位数 1s 稳健
  assert.equal(state.summary.averageDurationSeconds, 3429.007);
  assert.equal(state.summary.medianDurationSeconds, 1);

  const estimated = state.items.find(item => item.exchangeId === seeded.exchangeIds[3]);
  assert.ok(estimated);
  assert.equal(estimated.usageSource, "tokenizer_estimated");
  assert.equal(estimated.responseStatus, 502);
  assert.deepEqual(estimated.diagnosticCodes, ["upstream_error", "connection_error"]);

  const flashBreakdown = state.breakdown.find(item => item.model === "gpt-token");
  assert.ok(flashBreakdown);
  assert.equal(flashBreakdown.actualCost, 3);
  assert.equal(flashBreakdown.medianDurationSeconds, 1);
});

test("请求结果多值筛选：默认成功+已取消，token 单选与 all 全选", async () => {
  const fixture = await createSqliteFixture();
  fixtures.push(fixture);
  const seeded = seedTokenPricingFixture(fixture, 5);
  // 三条成功 + 一条上游错误（5xx）+ 一条用户取消：覆盖成功/失败/边缘三类。
  fixture.db.prepare(
    `UPDATE usage_ledger
     SET duration_ms = 1000, actual_cost = 1, vendor_cost = 1,
       usage_source = 'provider_usage', usage_confidence = 'exact',
       result_class = 'success'
     WHERE exchange_id IN (?, ?, ?)`
  ).run(seeded.exchangeIds[0], seeded.exchangeIds[1], seeded.exchangeIds[2]);
  fixture.db.prepare(
    `UPDATE usage_ledger
     SET duration_ms = 500, input_tokens = 224347, output_tokens = 6,
       actual_cost = 0.9, vendor_cost = 0.9,
       usage_source = 'tokenizer_estimated', usage_confidence = 'medium',
       result_class = 'upstream_error'
     WHERE exchange_id = ?`
  ).run(seeded.exchangeIds[3]);
  fixture.db.prepare(
    `UPDATE usage_ledger
     SET result_class = 'cancelled', input_tokens = 100, output_tokens = 5
     WHERE exchange_id = ?`
  ).run(seeded.exchangeIds[4]);
  fixture.db.prepare(
    `UPDATE raw_exchange_refs SET status = 502 WHERE exchange_id = ?`
  ).run(seeded.exchangeIds[3]);

  const baseParams = new URLSearchParams({
    start: "2026-07-17T00:00:00.000Z",
    end: "2026-07-17T01:00:00.000Z",
  });
  const defaultView = await loadTokenPricingState(baseParams, { db: fixture.db, dataDir: fixture.dataDir });
  // 默认口径 = 成功 + 已取消（站点已计费）：失败行不可见，取消行可见。
  assert.equal(defaultView.summary.requestCount, 4);
  assert.equal(defaultView.items.some(item => item.exchangeId === seeded.exchangeIds[3]), false);
  assert.equal(defaultView.items.some(item => item.exchangeId === seeded.exchangeIds[4]), true);
  // success token 单选：仅成功。
  const successOnly = await loadTokenPricingState(new URLSearchParams([...baseParams, ["result", "success"]]), { db: fixture.db, dataDir: fixture.dataDir });
  assert.equal(successOnly.summary.requestCount, 3);
  assert.equal(successOnly.items.some(item => item.exchangeId === seeded.exchangeIds[4]), false);

  const failures = await loadTokenPricingState(new URLSearchParams({...Object.fromEntries(baseParams), result: "failure"}), { db: fixture.db, dataDir: fixture.dataDir });
  // 「失败」= 错误类（客户端/上游/代理），不含取消与不完整；仅命中 502 行。
  assert.equal(failures.summary.requestCount, 1);
  assert.equal(failures.summary.inputTokens, 224347);
  assert.ok(failures.items.some(item => item.exchangeId === seeded.exchangeIds[3]));

  const all = await loadTokenPricingState(new URLSearchParams({...Object.fromEntries(baseParams), result: "all"}), { db: fixture.db, dataDir: fixture.dataDir });
  // 「全部」含取消等边缘行。
  assert.equal(all.summary.requestCount, 5);
  assert.equal(all.summary.inputTokens, 224347 + 30 + 100);
  assert.ok(all.items.some(item => item.exchangeId === seeded.exchangeIds[4]));

  // 旧 includeFailed 参数已删除：非法值收敛为默认口径「成功+已取消」。
  const legacy = await loadTokenPricingState(new URLSearchParams({...Object.fromEntries(baseParams), includeFailed: "yes"}), { db: fixture.db, dataDir: fixture.dataDir });
  assert.equal(legacy.summary.requestCount, 4);
});

test("父 Thread 默认聚合 closure 后代并用 keyset 游标分页", async () => {
  const fixture = await createSqliteFixture();
  fixtures.push(fixture);
  const seeded = seedTokenPricingFixture(fixture, 150);
  const planDetails = fixture.db.prepare(
    `EXPLAIN QUERY PLAN
     SELECT u.* FROM usage_ledger u
     WHERE u.created_at >= ? AND u.created_at <= ?
       AND u.agent_session_id = ?
       AND u.agent_thread_id IN (
         SELECT descendant_thread_id FROM thread_closure
         WHERE ancestor_thread_id = ?
       )
     ORDER BY u.created_at DESC, u.exchange_id DESC
     LIMIT 101`,
  ).all(
    "2026-07-17T00:00:00.000Z",
    "2026-07-17T01:00:00.000Z",
    seeded.sessionId,
    seeded.rootThreadId,
  ).map((row) => (row as { detail: string }).detail);
  assert.ok(planDetails.some((detail) =>
    detail.includes("idx_usage_session_time")
  ));
  assert.ok(planDetails.every((detail) => !detail.includes("USE TEMP B-TREE")));
  const first = await loadTokenPricingState(new URLSearchParams({
    session: seeded.sessionId,
    thread: seeded.rootThreadId,
    limit: "999",
  }), { db: fixture.db, dataDir: fixture.dataDir });

  assert.equal(first.limit, 100);
  assert.equal(first.items.length, 100);
  assert.equal(first.total, 150);
  assert.equal(first.summary.requestCount, 150);
  assert.equal(first.summary.inputTokens, 1_500);
  assert.equal(first.summary.cacheReadTokens, 3_000);
  assert.equal(first.summary.outputTokens, 750);
  assert.equal(first.summary.vendorCost, 15);
  assert.equal(first.summary.actualCost, 7.5);
  assert.equal(first.hasMore, true);
  assert.ok(first.nextCursor);

  const second = await loadTokenPricingState(new URLSearchParams({
    session: seeded.sessionId,
    thread: seeded.rootThreadId,
    limit: "100",
    cursor: first.nextCursor!,
  }), { db: fixture.db, dataDir: fixture.dataDir });
  assert.equal(second.items.length, 50);
  assert.equal(second.hasMore, false);
  assert.equal(
    new Set([...first.items, ...second.items].map((item) => item.exchangeId)).size,
    150,
  );
});

test("报表透出高峰闲时维度与套餐积分字段", async () => {
  const fixture = await createSqliteFixture();
  fixtures.push(fixture);
  const seeded = seedTokenPricingFixture(fixture, 3);
  fixture.db.prepare(
    `UPDATE usage_ledger
     SET pricing_snapshot_json = json_set(
           pricing_snapshot_json,
           '$.scheduleLabel', '闲时',
           '$.timezone', 'Asia/Shanghai'
         ),
       plan_credit_cost = 12.5,
       plan_credit_unit = '积分',
       plan_credit_formula_version = 'zhipu-2026-08'
     WHERE exchange_id = ?`,
  ).run(seeded.exchangeIds[0]);

  const state = await loadTokenPricingState(new URLSearchParams({
    start: "2026-07-17T00:00:00.000Z",
    end: "2026-07-17T01:00:00.000Z",
  }), { db: fixture.db, dataDir: fixture.dataDir });

  const item = state.items.find(row => row.exchangeId === seeded.exchangeIds[0]);
  assert.equal(item?.scheduleLabel, "闲时");
  assert.equal(item?.timezone, "Asia/Shanghai");
  assert.equal(item?.planCreditUnit, "积分");
  assert.ok(Math.abs((item?.planCreditCost ?? 0) - 12.5) < 1e-9);

  const breakdown = state.breakdown.find(row => row.scheduleLabel === "闲时");
  assert.ok(breakdown);
  assert.equal(breakdown.requestCount, 1);
  assert.equal(breakdown.planCreditUnit, "积分");
  assert.ok(Math.abs((breakdown.planCreditCost ?? 0) - 12.5) < 1e-9);

  const plain = state.breakdown.find(row => row.scheduleLabel === undefined);
  assert.ok(plain);
  assert.equal(plain.planCreditUnit, undefined);
  assert.equal(state.summary.planCreditCost, 12.5);
  assert.equal(state.summary.planCreditUnit, "积分");

  const filtered = await loadTokenPricingState(new URLSearchParams({
    start: "2026-07-17T00:00:00.000Z",
    end: "2026-07-17T01:00:00.000Z",
    schedule: "闲时",
  }), { db: fixture.db, dataDir: fixture.dataDir });
  assert.equal(filtered.total, 1);
  assert.equal(filtered.items[0]?.scheduleLabel, "闲时");
});

function seedTokenPricingFixture(
  fixture: SqliteFixture,
  count: number,
): {
  sessionId: string;
  rootThreadId: string;
  childThreadId: string;
  turnId: string;
  exchangeIds: string[];
  stepIds: string[];
} {
  const sessionId = "asess-token";
  const rootThreadId = "athread-token-root";
  const childThreadId = "athread-token-child";
  const turnId = "aturn-token-child";
  const exchangeIds = Array.from(
    { length: count },
    (_, index) => `exchange-token-${String(index + 1).padStart(3, "0")}`,
  );
  const stepIds = Array.from(
    { length: count },
    (_, index) => `astep-token-${index + 1}`,
  );
  const sourceId = fixture.db.prepare(
    `INSERT INTO ingestion_sources(
      relative_path, file_id, byte_offset, scan_offset, file_size,
      processed_count, status, updated_at
    ) VALUES('captures/v2/token-fixture.jsonl', 'token-fixture', 0, 0,
      1000000, 0, 'ready', '2026-07-17T00:00:00.000Z')
    RETURNING id`,
  ).pluck().get() as number;
  fixture.db.prepare(
    `INSERT INTO agent_sessions(
      id, target_id, target_name, agent_fingerprint_id, agent_name,
      external_session_id, source, confidence, start_time, end_time,
      request_count, thread_count
    ) VALUES(?, 'target-token', 'Token Target', 'fingerprint-token',
      'codex', 'session-token', 'fixture', 'exact', ?, ?, ?, 2)`,
  ).run(
    sessionId,
    "2026-07-17T00:00:00.000Z",
    "2026-07-17T01:00:00.000Z",
    count,
  );
  const insertThread = fixture.db.prepare(
    `INSERT INTO agent_threads(
      id, agent_session_id, parent_agent_thread_id, source, display_name,
      confidence, is_root, start_time, end_time, request_count, turn_count
    ) VALUES(?, ?, ?, 'fixture', ?, 'exact', ?, ?, ?, ?, ?)`,
  );
  insertThread.run(
    rootThreadId,
    sessionId,
    null,
    "Root Thread",
    1,
    "2026-07-17T00:00:00.000Z",
    "2026-07-17T01:00:00.000Z",
    0,
    0,
  );
  insertThread.run(
    childThreadId,
    sessionId,
    rootThreadId,
    "Child Thread",
    0,
    "2026-07-17T00:00:00.000Z",
    "2026-07-17T01:00:00.000Z",
    count,
    1,
  );
  fixture.db.exec(`
    INSERT INTO thread_closure VALUES
      ('${rootThreadId}', '${rootThreadId}', 0),
      ('${rootThreadId}', '${childThreadId}', 1),
      ('${childThreadId}', '${childThreadId}', 0);
  `);
  fixture.db.prepare(
    `INSERT INTO agent_turns(
      id, agent_session_id, agent_thread_id, source, confidence, status,
      segment_index, start_exchange_id, start_time, end_time, step_count
    ) VALUES(?, ?, ?, 'fixture', 'exact', 'closed', 1, ?, ?, ?, ?)`,
  ).run(
    turnId,
    sessionId,
    childThreadId,
    exchangeIds[0],
    "2026-07-17T00:00:00.000Z",
    "2026-07-17T01:00:00.000Z",
    count,
  );

  const insertRef = fixture.db.prepare(
    `INSERT INTO raw_exchange_refs(
      exchange_id, capture_session_id, source_id, byte_offset,
      line_length_bytes, captured_at, completed_at, target_id,
      target_name, agent_name, agent_fingerprint_id, model, status,
      is_streaming, request_body_bytes, response_body_bytes
    ) VALUES(?, 'capture-token', ?, ?, 256, ?, ?, 'target-token',
      'Token Target', 'codex', 'fingerprint-token', 'gpt-token',
      200, 0, 64, 64)`,
  );
  const insertStep = fixture.db.prepare(
    `INSERT INTO agent_steps(
      id, exchange_id, agent_session_id, agent_thread_id, agent_turn_id,
      step_index, timestamp, phase, request_action, response_action,
      input_tokens, cache_read_tokens, output_tokens
    ) VALUES(?, ?, ?, ?, ?, ?, ?, 'respond', 'continue', 'complete',
      10, 20, 5)`,
  );
  const insertLedger = fixture.db.prepare(
    `INSERT INTO usage_ledger(
      exchange_id, agent_session_id, agent_thread_id, agent_turn_id,
      agent_step_id, target_id, agent_fingerprint_id, agent_name, model,
      vendor, rate_multiplier, input_tokens, cache_read_tokens,
      cache_write_tokens, output_tokens, vendor_cost, actual_cost,
      duration_ms, usage_source, usage_confidence, pricing_snapshot_json,
      result_class, created_at
    ) VALUES(?, ?, ?, ?, ?, 'target-token', 'fingerprint-token',
      'codex', 'gpt-token', 'OpenAI', 0.5, 10, 20, 0, 5, 0.1, 0.05,
      0, 'provider', 'exact', ?, 'success', ?)`,
  );
  const insertAll = fixture.db.transaction(() => {
    for (let index = 0; index < exchangeIds.length; index += 1) {
      const exchangeId = exchangeIds[index]!;
      const stepId = stepIds[index]!;
      const timestamp = new Date(
        Date.parse("2026-07-17T00:00:00.000Z") + index * 1_000,
      ).toISOString();
      insertRef.run(exchangeId, sourceId, index * 256, timestamp, timestamp);
      insertStep.run(
        stepId,
        exchangeId,
        sessionId,
        childThreadId,
        turnId,
        index + 1,
        timestamp,
      );
      insertLedger.run(
        exchangeId,
        sessionId,
        childThreadId,
        turnId,
        stepId,
        JSON.stringify({
          vendor: "OpenAI",
          rateMultiplier: 0.5,
          baseRates: { input: 1, cachedInput: 0.5, output: 2 },
        }),
        timestamp,
      );
    }
  });
  insertAll();
  return { sessionId, rootThreadId, childThreadId, turnId, exchangeIds, stepIds };
}

test("历史账本 vendor=unknown 时按最新目标供应商偏好只读兜底展示，不改写账本", async () => {
  const fixture = await createSqliteFixture();
  fixtures.push(fixture);
  const seeded = seedTokenPricingFixture(fixture, 2);
  fixture.db.exec(`
    INSERT INTO pricing_catalog_blobs(hash, config_json, created_at)
    VALUES('cat-vendor-fallback', '{"version":2,"models":[]}', '2026-07-16T00:00:00.000Z');
    INSERT INTO pricing_policy_blobs(hash, config_json, created_at)
    VALUES('pol-vendor-fallback',
      '{"targetVendorPreferences":{"target-token":"deepseek"}}',
      '2026-07-16T00:00:00.000Z');
    INSERT INTO pricing_config_revisions(effective_at, catalog_hash, policy_hash, created_at)
    VALUES('2026-07-16T00:00:00.000Z', 'cat-vendor-fallback', 'pol-vendor-fallback',
      '2026-07-16T00:00:00.000Z');
  `);
  fixture.db.prepare(
    `UPDATE usage_ledger SET vendor = 'unknown' WHERE exchange_id = ?`,
  ).run(seeded.exchangeIds[0]);

  const state = await loadTokenPricingState(new URLSearchParams({
    start: "2026-07-17T00:00:00.000Z",
    end: "2026-07-17T01:00:00.000Z",
  }), { db: fixture.db, dataDir: fixture.dataDir });

  const item = state.items.find(row => row.exchangeId === seeded.exchangeIds[0]);
  assert.ok(item);
  assert.equal(item.vendor, "deepseek");
  assert.ok(state.facets.vendors.some(option => option.value === "unknown"));
});

test("历史账本 vendor_cost=0 但快照保留费率与用量时，明细供应商成本按公式兜底展示", async () => {
  const fixture = await createSqliteFixture();
  fixtures.push(fixture);
  const seeded = seedTokenPricingFixture(fixture, 1);
  fixture.db.prepare(
    `UPDATE usage_ledger SET vendor_cost = 0 WHERE exchange_id = ?`,
  ).run(seeded.exchangeIds[0]);

  const state = await loadTokenPricingState(new URLSearchParams({
    start: "2026-07-17T00:00:00.000Z",
    end: "2026-07-17T01:00:00.000Z",
  }), { db: fixture.db, dataDir: fixture.dataDir });

  const item = state.items.find(row => row.exchangeId === seeded.exchangeIds[0]);
  assert.ok(item);
  // 快照 baseRates: input 1、cachedInput 0.5、output 2（每百万 token）；
  // tokens: 输入 10、缓存读取 20、输出 5 → 0.00001 + 0.00001 + 0.00001
  assert.ok(Math.abs((item.vendorCost ?? 0) - 0.00003) < 1e-12);
  assert.ok(item.vendorCostFormula?.includes("10 / 1000000"));
  // 汇总的“倍率前”与“倍率前总消费”与明细同一兜底口径
  assert.ok(Math.abs(state.summary.vendorCost - 0.00003) < 1e-12);
  assert.equal(state.breakdown.length, 1);
  assert.ok(Math.abs(state.breakdown[0]!.vendorCost - 0.00003) < 1e-12);
});

test("结果筛选多选：默认=成功+已取消+补差，补差计金额不计请求数", async () => {
  const fixture = await createSqliteFixture();
  fixtures.push(fixture);
  fixture.db.pragma("foreign_keys = OFF");
  const insert = fixture.db.prepare(
    `INSERT INTO usage_ledger(
      exchange_id, target_id, agent_fingerprint_id, agent_name, model,
      vendor, rate_multiplier, input_tokens, cache_read_tokens,
      cache_write_tokens, output_tokens, vendor_cost, actual_cost,
      duration_ms, usage_source, usage_confidence, pricing_snapshot_json,
      request_kind, result_class, created_at
    ) VALUES(?, 'target-result', 'fp', 'codex', 'gpt-result',
      'openai', 1, 100, 0, 0, 10, 0.01, 0.008,
      500, 'provider_usage', 'exact', '{}',
      ?, ?, ?)`,
  );
  const rows: Array<[string, string, string, string]> = [
    ["ex-success-1", "model", "success", "2026-08-20T02:00:00.000Z"],
    ["ex-success-2", "model", "success", "2026-08-20T02:01:00.000Z"],
    ["ex-cancel-1", "model", "cancelled", "2026-08-20T02:02:00.000Z"],
    ["ex-error-1", "model", "upstream_error", "2026-08-20T02:03:00.000Z"],
    ["ex-incomplete-1", "model", "incomplete", "2026-08-20T02:04:00.000Z"],
  ];
  for (const [id, kind, resultClass, createdAt] of rows) insert.run(id, kind, resultClass, createdAt);
  // 补差行：request_kind=reconciliation / result_class=reconciled，只带金额
  fixture.db.prepare(
    `INSERT INTO usage_ledger(
      exchange_id, target_id, agent_fingerprint_id, agent_name, model,
      vendor, rate_multiplier, input_tokens, cache_read_tokens,
      cache_write_tokens, output_tokens, vendor_cost, actual_cost,
      duration_ms, usage_source, usage_confidence, pricing_snapshot_json,
      request_kind, result_class, created_at
    ) VALUES('ex-recon-1', 'target-result', 'fp', 'codex', '(对账补差)',
      'openai', 1, 0, 0, 0, 0, 0.1234, 0.1234,
      0, 'reconciliation', 'exact', '{}',
      'reconciliation', 'reconciled', '2026-08-20T02:05:00.000Z')`,
  ).run();

  const load = (params: Record<string, string>) => loadTokenPricingState(new URLSearchParams({
    target: "target-result",
    start: "2026-08-20T00:00:00.000Z",
    end: "2026-08-21T00:00:00.000Z",
    ...params,
  }), { db: fixture.db, dataDir: fixture.dataDir });

  // 默认口径：成功+已取消+补差；请求计数 3（补差不计），金额含补差
  const defa = await load({});
  const defaIds = defa.items.map(item => item.exchangeId).sort();
  assert.deepEqual(defaIds, ["ex-cancel-1", "ex-recon-1", "ex-success-1", "ex-success-2"]);
  assert.equal(defa.summary.requestCount, 3);
  assert.ok(Math.abs(defa.summary.actualCost - (0.008 * 3 + 0.1234)) < 1e-9);

  // 全量（兼容旧 result=all）：含失败/不完整，计数 5
  const all = await load({result: "all"});
  assert.equal(all.summary.requestCount, 5);
  assert.equal(all.items.length, 6);

  // 失败值域只含错误类；不完整由 incomplete token 单独选择
  const failure = await load({result: "failure"});
  assert.deepEqual(failure.items.map(item => item.exchangeId), ["ex-error-1"]);
  const incompleteOnly = await load({result: "incomplete"});
  assert.deepEqual(incompleteOnly.items.map(item => item.exchangeId), ["ex-incomplete-1"]);

  // 多 token 组合：success,incomplete
  const combo = await load({result: "success,incomplete"});
  assert.deepEqual(combo.items.map(item => item.exchangeId).sort(),
    ["ex-incomplete-1", "ex-success-1", "ex-success-2"]);

  // 仅补差
  const reconOnly = await load({result: "reconciled"});
  assert.deepEqual(reconOnly.items.map(item => item.exchangeId), ["ex-recon-1"]);
  assert.equal(reconOnly.summary.requestCount, 0);
});

test("总消费按计费通道拆分，套餐行按月费×积分比率×窗口天数折算真实成本", async () => {
  const fixture = await createSqliteFixture();
  fixtures.push(fixture);
  // usage_ledger.exchange_id 外键引用 raw_exchange_refs，source_id 外键引用 ingestion_sources。
  const sourceId = fixture.db.prepare(
    `INSERT INTO ingestion_sources(
      relative_path, file_id, byte_offset, scan_offset, file_size,
      processed_count, status, updated_at
    ) VALUES('captures/v2/token-plan-fixture.jsonl', 'token-plan-fixture', 0, 0,
      1000000, 0, 'ready', '2026-07-17T00:00:00.000Z')
    RETURNING id`,
  ).pluck().get() as number;
  const insertRef = fixture.db.prepare(
    `INSERT INTO raw_exchange_refs(
      exchange_id, capture_session_id, source_id, byte_offset,
      line_length_bytes, captured_at, completed_at, target_id,
      target_name, agent_name, agent_fingerprint_id, model, status,
      is_streaming, request_body_bytes, response_body_bytes
    ) VALUES(?, 'capture-token', ?, ?, 256, ?, ?, 'target-token',
      'Token Target', 'codex', 'fp', ?, 200, 0, 64, 64)`,
  );
  const insertLedger = fixture.db.prepare(
    `INSERT INTO usage_ledger(
      exchange_id, target_id, agent_fingerprint_id, agent_name, model,
      vendor, rate_multiplier, input_tokens, cache_read_tokens,
      cache_write_tokens, output_tokens, vendor_cost, actual_cost,
      duration_ms, usage_source, usage_confidence, pricing_snapshot_json,
      result_class, billing_channel, plan_credit_cost, created_at,
      plan_estimated_cost, plan_estimated_currency, plan_estimated_fx,
      plan_estimated_cost_nano, plan_estimated_status
    ) VALUES(?, 'target-token', 'fp', 'codex', ?, 'OpenAI', 1,
      100, 0, 0, 50, ?, ?, 1000, 'provider', 'exact', '{}', 'success',
      ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  // 按量：供应商成本 0.30 / 实际 0.30；套餐：市价 5 / 实际 5 / 消耗积分 500 /
  // 入账冻结估算 = 100 × (500/5000) × (7/30) ≈ 2.3333（2026-09-15 冻结口径）。
  const expectedWeeklyReal = 100 * (500 / 5000) * (7 / 30);
  const rows = [
    ["ex-payg", "gpt-payg", 0.3, 0.3, "pay_as_you_go", null, "2026-07-17T00:00:00.000Z", null],
    ["ex-plan", "gpt-plan", 5, 5, "plan", 500, "2026-07-17T00:01:00.000Z", Math.round(expectedWeeklyReal * 1e9)],
  ] as const;
  for (const [exchangeId, model, vendorCost, actualCost, channel, credits, createdAt, frozenNano] of rows) {
    insertRef.run(exchangeId, sourceId, 1024, createdAt, createdAt, model);
    insertLedger.run(
      exchangeId, model, vendorCost, actualCost, channel, credits, createdAt,
      frozenNano, frozenNano === null ? null : "CNY", frozenNano === null ? null : 1,
      frozenNano, frozenNano === null ? null : "estimated",
    );
  }
  // 周窗口积分总额 5000；月费 100 → 周真实成本 = 100 × (500/5000) × (7/30) ≈ 2.3333。
  fixture.db.prepare(
    `INSERT INTO plan_quota_snapshots(target_id, provider_type, plan_name, window_label, used, total, unit, captured_at)
     VALUES('target-token', 'zhipu', '智谱 Coding Plan', 'weekly', 500, 5000, 'credit', '2026-07-17T01:00:00.000Z')`,
  ).run();
  const { writeFileSync, mkdirSync } = await import("node:fs");
  mkdirSync(fixture.dataDir, { recursive: true });
  writeFileSync(`${fixture.dataDir}/proxy-config.json`, JSON.stringify({
    targets: [{ id: "target-token", name: "Token Target", pricing: { planMonthlyFee: 100 } }],
  }));

  // 夹具时间在 2026-07-17；不传显式范围时默认只查最近 24 小时。
  const state = await loadTokenPricingState(new URLSearchParams({
    start: "2026-07-16T00:00:00.000Z",
    end: "2026-07-18T00:00:00.000Z",
  }), { db: fixture.db, dataDir: fixture.dataDir });

  assert.equal(state.summary.paygVendorCost, 0.3);
  assert.equal(state.summary.paygActualCost, 0.3);
  assert.equal(state.summary.planMarketCost, 5);
  assert.equal(state.summary.planCredits, 500);
  assert.equal(state.summary.planCreditCost, 500);
  assert.ok(Math.abs((state.summary.planRealCost ?? 0) - expectedWeeklyReal) < 1e-6);
  assert.equal(state.summary.planRealCostUnavailable, false);

  const planRow = state.breakdown.find(row => row.model === "gpt-plan");
  assert.equal(planRow?.planRequestCount, 1);
  assert.ok(Math.abs((planRow?.planRealCost ?? 0) - expectedWeeklyReal) < 1e-6);
  // nano 取整经 ×1e6 放大后允许绝对误差 0.01。
  assert.ok(Math.abs((planRow?.realCostPerMillionTokens ?? 0) - expectedWeeklyReal / 150 * 1_000_000) < 0.01);
  const paygRow = state.breakdown.find(row => row.model === "gpt-payg");
  assert.equal(paygRow?.planRequestCount, 0);
  assert.equal(paygRow?.planRealCost, undefined);
});

test("套餐零积分（错峰免费活动）真实成本按 0 折算，绝不回退市价（2026-09-08 修复）", async () => {
  const fixture = await createSqliteFixture();
  fixtures.push(fixture);
  const sourceId = fixture.db.prepare(
    `INSERT INTO ingestion_sources(
      relative_path, file_id, byte_offset, scan_offset, file_size,
      processed_count, status, updated_at
    ) VALUES('captures/v2/token-plan-free-fixture.jsonl', 'token-plan-free-fixture', 0, 0,
      1000000, 0, 'ready', '2026-07-17T00:00:00.000Z')
    RETURNING id`,
  ).pluck().get() as number;
  const insertRef = fixture.db.prepare(
    `INSERT INTO raw_exchange_refs(
      exchange_id, capture_session_id, source_id, byte_offset,
      line_length_bytes, captured_at, completed_at, target_id,
      target_name, agent_name, agent_fingerprint_id, model, status,
      is_streaming, request_body_bytes, response_body_bytes
    ) VALUES(?, 'capture-token', ?, ?, 256, ?, ?, 'target-token',
      'Token Target', 'codex', 'fp', ?, 200, 0, 64, 64)`,
  );
  const insertLedger = fixture.db.prepare(
    `INSERT INTO usage_ledger(
      exchange_id, target_id, agent_fingerprint_id, agent_name, model,
      vendor, rate_multiplier, input_tokens, cache_read_tokens,
      cache_write_tokens, output_tokens, vendor_cost, actual_cost,
      duration_ms, usage_source, usage_confidence, pricing_snapshot_json,
      result_class, billing_channel, plan_credit_cost, plan_credit_unit,
      plan_estimated_cost, plan_estimated_currency, plan_estimated_fx,
      plan_estimated_cost_nano, plan_estimated_status,
      plan_estimate_detail_json, created_at
    ) VALUES(?, 'target-token', 'fp', 'codex', ?, 'zhipu-cn', 1,
      100, 0, 0, 50, ?, ?, 1000, 'provider', 'exact', '{}', 'success',
      'plan', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  // 免费窗口请求：市价 5 但积分消耗 0（unit=积分），入账冻结估算 0；
  // 美元额度制请求：无积分数据，市价 3 作消耗，入账冻结估算 = 100×(3/5000)×(7/30)。
  const dollarExpected = 100 * (3 / 5000) * (7 / 30);
  const rows = [
    ["ex-plan-free", "glm-5.3-flash", 5, 0, 0, "积分", "2026-07-17T00:00:00.000Z",
      0, 0, "credits", 0],
    ["ex-plan-dollar", "opencode-go-model", 3, 3, null, null, "2026-07-17T00:01:00.000Z",
      3, Math.round(dollarExpected * 1e9), "market_cny", 5000],
  ] as const;
  for (const [exchangeId, model, vendorCost, actualCost, credits, unit, createdAt,
    frozenConsumed, frozenNano, frozenBasis, frozenQuota] of rows) {
    insertRef.run(exchangeId, sourceId, 1024, createdAt, createdAt, model);
    insertLedger.run(
      exchangeId, model, vendorCost, actualCost, credits, unit,
      frozenNano / 1e9, "CNY", 1, frozenNano, "estimated",
      JSON.stringify({monthlyFee: 100, consumed: frozenConsumed, consumedBasis: frozenBasis,
        quotaTotal: frozenQuota, windowDays: 7, fxUsdCny: undefined}),
      createdAt,
    );
  }
  fixture.db.prepare(
    `INSERT INTO plan_quota_snapshots(target_id, provider_type, plan_name, window_label, used, total, unit, captured_at)
     VALUES('target-token', 'zhipu', '智谱 Coding Plan', 'weekly', 0, 5000, 'credit', '2026-07-17T01:00:00.000Z')`,
  ).run();
  const { writeFileSync, mkdirSync } = await import("node:fs");
  mkdirSync(fixture.dataDir, { recursive: true });
  writeFileSync(`${fixture.dataDir}/proxy-config.json`, JSON.stringify({
    targets: [{ id: "target-token", name: "Token Target", pricing: { planMonthlyFee: 100 } }],
  }));

  const state = await loadTokenPricingState(new URLSearchParams({
    start: "2026-07-16T00:00:00.000Z",
    end: "2026-07-18T00:00:00.000Z",
  }), { db: fixture.db, dataDir: fixture.dataDir });

  // 免费请求真实成本 = 0（不按市价 5 折算）；美元额度制按市价 3 折算。
  // planCreditCost 映射层只在 >0 时透出（0 积分不展示数值），积分制身份由 unit 表达。
  const freeRow = state.breakdown.find(row => row.model === "glm-5.3-flash");
  assert.equal(freeRow?.planRequestCount, 1);
  assert.equal(freeRow?.planCreditCost, undefined);
  assert.equal(freeRow?.planCreditUnit, "积分");
  assert.equal(freeRow?.planRealCost, 0);
  assert.ok(Math.abs((state.summary.planRealCost ?? 0) - dollarExpected) < 1e-6);
  const freeItem = state.items.find(row => row.exchangeId === "ex-plan-free");
  assert.equal(freeItem?.planRealCost, 0);
  // 2026-10-09 B2/B3：服务端只下发结构化依据（planEstimateDetail），
  // ？公式文本由客户端用共享 note 函数按查看者时区现算；这里锁定依据字段完整透出。
  assert.equal(freeItem?.planEstimateDetail?.consumedBasis, "credits");
  assert.equal(freeItem?.planEstimateDetail?.consumed, 0);
  const dollarItem = state.items.find(row => row.exchangeId === "ex-plan-dollar");
  assert.equal(dollarItem?.planEstimateDetail?.consumedBasis, "market_cny");
  assert.ok(dollarItem?.planEstimateDetail?.consumed !== undefined);
});

test("估算待补筛选（2026-10-09 #5 徽标跳转）：pending=1 只看待补行，按量行天然排除", async () => {
  const fixture = await createSqliteFixture();
  fixtures.push(fixture);
  const sourceId = fixture.db.prepare(
    `INSERT INTO ingestion_sources(
      relative_path, file_id, byte_offset, scan_offset, file_size,
      processed_count, status, updated_at
    ) VALUES('captures/v2/pending-filter-fixture.jsonl', 'pending-filter-fixture', 0, 0,
      1000000, 0, 'ready', '2026-07-17T00:00:00.000Z')
    RETURNING id`,
  ).pluck().get() as number;
  const insertRef = fixture.db.prepare(
    `INSERT INTO raw_exchange_refs(
      exchange_id, capture_session_id, source_id, byte_offset,
      line_length_bytes, captured_at, completed_at, target_id,
      target_name, agent_name, agent_fingerprint_id, model, status,
      is_streaming, request_body_bytes, response_body_bytes
    ) VALUES(?, 'capture-token', ?, ?, 256, ?, ?, 'target-token',
      'Token Target', 'codex', 'fp', ?, 200, 0, 64, 64)`,
  );
  const insertLedger = fixture.db.prepare(
    `INSERT INTO usage_ledger(
      exchange_id, target_id, agent_fingerprint_id, agent_name, model,
      vendor, rate_multiplier, input_tokens, cache_read_tokens,
      cache_write_tokens, output_tokens, vendor_cost, actual_cost,
      duration_ms, usage_source, usage_confidence, pricing_snapshot_json,
      result_class, billing_channel, reference_cost_nano,
      plan_estimated_cost_nano, plan_estimated_status, created_at
    ) VALUES(?, 'target-token', 'fp', 'codex', ?, 'zhipu-cn', 1,
      100, 0, 0, 50, 1, 1, 1000, 'provider', 'exact', '{}', 'success',
      ?, ?, ?, ?, ?)`,
  );
  const seeds = [
    ["ex-pending", "glm-5.3", "subscription", 1_000_000_000, null, "unavailable", "2026-07-17T00:00:00.000Z"],
    ["ex-settled", "glm-5.3", "subscription", 1_000_000_000, 280_000_000, "estimated", "2026-07-17T00:01:00.000Z"],
    ["ex-payg", "glm-5.3", "pay_as_you_go", 1_000_000_000, null, null, "2026-07-17T00:02:00.000Z"],
  ] as const;
  for (const [exchangeId, model, channel, reference, estimatedNano, status, createdAt] of seeds) {
    insertRef.run(exchangeId, sourceId, 1024, createdAt, createdAt, model);
    insertLedger.run(exchangeId, model, channel, reference, estimatedNano, status, createdAt);
  }

  const query = (extra: Record<string, string>) => loadTokenPricingState(new URLSearchParams({
    start: "2026-07-16T00:00:00.000Z",
    end: "2026-07-18T00:00:00.000Z",
    ...extra,
  }), { db: fixture.db, dataDir: fixture.dataDir });

  const unfiltered = await query({});
  assert.equal(unfiltered.items.length, 3);

  const pendingOnly = await query({pending: "1"});
  // 只剩待补行；按量行 plan_estimated_status 为 NULL 天然排除，已结算行排除。
  assert.equal(pendingOnly.items.length, 1);
  assert.equal(pendingOnly.items[0]?.exchangeId, "ex-pending");
  assert.equal(pendingOnly.summary.planEstimatedPendingCount, 1);
});

test("聚合取代语义：用量载体补差行计入请求与 Token，被取代原行的估算量排他（2026-09-29）", async () => {
  const fixture = await createSqliteFixture();
  fixtures.push(fixture);
  fixture.db.pragma("foreign_keys = OFF");
  const insertLedger = fixture.db.prepare(
    `INSERT INTO usage_ledger(
      exchange_id, target_id, agent_fingerprint_id, agent_name, model,
      vendor, rate_multiplier, input_tokens, cache_read_tokens,
      cache_write_tokens, output_tokens, vendor_cost, actual_cost,
      duration_ms, usage_source, usage_confidence, pricing_snapshot_json,
      request_kind, result_class, created_at
    ) VALUES(?, 'target-carrier', 'fp', 'codex', 'gpt-token',
      'openai', 1, ?, 0, 0, ?, ?, ?, 800,
      ?, 'exact', '{}', ?, ?, '2026-07-17T00:10:00.000Z')`,
  );
  // 普通成功行 + 失败估算原行（本地金额 0）+ 站点真值载体补差行。
  insertLedger.run("ex-ok", 50, 5, 0.01, 0.01, "provider_usage", "model", "success");
  insertLedger.run("ex-carrier-origin", 1000, 6, 0, 0,
    "tokenizer_estimated", "model", "upstream_error");
  insertLedger.run("recon:matched:carrier", 900, 90, 0.03, 0.03,
    "reconciliation", "reconciliation", "reconciled");
  fixture.db.prepare(
    `INSERT INTO relay_reconciliation_hours(
      target_id, hour_start_utc, provider_type, console_account_id,
      status, created_at, updated_at
    ) VALUES('target-carrier', '2026-07-17T00:00:00.000Z', 'sub2api', 'acct-1',
      'applied', '2026-07-17T01:00:00.000Z', '2026-07-17T01:05:00.000Z')`,
  ).run();
  fixture.db.prepare(
    `INSERT INTO relay_reconciliation_matches(
      target_id, hour_start_utc, provider_type, site_log_id, exchange_id,
      confidence, site_amount_nano, local_amount_nano, adjustment_nano,
      adjustment_exchange_id, revision, created_at, usage_carrier
    ) VALUES('target-carrier', '2026-07-17T00:00:00.000Z', 'sub2api', 'log-carrier',
      'ex-carrier-origin', 'weak', 30_000_000, 0, 30_000_000,
      'recon:matched:carrier', 1, '2026-07-17T01:05:00.000Z', 1)`,
  ).run();

  // result=all：三条行都进结果集，聚合仍不得双算（请求 2 次、input 950）。
  const state = await loadTokenPricingState(new URLSearchParams({
    target: "target-carrier",
    start: "2026-07-17T00:00:00.000Z",
    end: "2026-07-17T01:00:00.000Z",
    result: "all",
  }), { db: fixture.db, dataDir: fixture.dataDir });
  assert.equal(state.summary.requestCount, 2);
  assert.equal(state.summary.inputTokens, 950);
  assert.equal(state.summary.outputTokens, 95);
  // 默认口径（成功+已取消+补差）下原行本就被滤掉，口径不受影响。
  const defaultState = await loadTokenPricingState(new URLSearchParams({
    target: "target-carrier",
    start: "2026-07-17T00:00:00.000Z",
    end: "2026-07-17T01:00:00.000Z",
  }), { db: fixture.db, dataDir: fixture.dataDir });
  assert.equal(defaultState.summary.requestCount, 2);
  assert.equal(defaultState.summary.inputTokens, 950);
  // 金额：载体补差 $0.03 + 成功行 $0.01 一并计入。
  assert.ok(Math.abs(defaultState.summary.actualCost - 0.04) < 1e-9);
});
