import {afterEach, describe, expect, test} from "vitest";
import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {openDeepaaDatabase} from "../src/lib/db/connection.js";
import {ReconciliationStore, RESIDUAL_AUTO_APPLY_MAX_NANO} from "../src/lib/sync-engine/reconciliation/store.js";
import {
  residualAutoApplyDecision,
  reviewDueReconciliationHours,
} from "../src/lib/sync-engine/reconciliation/service.js";
import type {SiteUsageSnapshot, SiteUsageRecord} from "../src/lib/sync-engine/reconciliation/site-usage.js";
import type {DeepaaDatabase} from "@/lib/db/sqlite-driver";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(path => rm(path, {recursive: true, force: true})));
});

const hour = "2026-09-24T04:00:00.000Z";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "relay-residual-"));
  roots.push(root);
  const db = openDeepaaDatabase({dataDir: root});
  db.prepare(
    `INSERT INTO worker_lease(id,owner_id,expires_at)
     VALUES(1,'residual-test','2099-01-01T00:00:00.000Z')`,
  ).run();
  db.prepare(
    "UPDATE schema_meta SET last_source_scan_completed_at='2099-01-01T00:00:00.000Z'",
  ).run();
  return {db, store: new ReconciliationStore(db)};
}

interface LocalRowSpec {
  id: string;
  completedAt: string;
  requestId?: string;
  endpoint?: string;
  model?: string;
  resultClass?: string;
  usageSource?: string;
  usd?: number;
}

/** 直接落 raw refs + 账本 + 完成时刻索引；错误行金额恒 0（与真实派生口径一致）。 */
function seedLocalRows(db: DeepaaDatabase, rows: LocalRowSpec[]): void {
  db.prepare(
    `INSERT INTO ingestion_sources(relative_path,file_id,generation,byte_offset,scan_offset,
      file_size,processed_count,status,updated_at)
     VALUES('recon-local://test','recon-test',0,0,0,0,0,'ready','2026-09-24T04:00:00.000Z')
     ON CONFLICT(relative_path) DO NOTHING`,
  ).run();
  const sourceId = (db.prepare(
    "SELECT id FROM ingestion_sources WHERE relative_path='recon-local://test'",
  ).get() as {id: number}).id;
  const ref = db.prepare(
    `INSERT INTO raw_exchange_refs(
      exchange_id,capture_session_id,source_id,byte_offset,line_length_bytes,
      captured_at,completed_at,target_id,target_name,agent_name,
      agent_fingerprint_id,model,wire_api,status,is_streaming,
      request_body_bytes,response_body_bytes
    ) VALUES(?,'recon-test',?,0,1,?,?,'target-1','t','codex','fp',?,
      'responses',200,1,0,0)`,
  );
  const ledger = db.prepare(
    `INSERT INTO usage_ledger(
      exchange_id,target_id,agent_fingerprint_id,agent_name,model,vendor,
      rate_multiplier,input_tokens,cache_read_tokens,cache_write_tokens,output_tokens,
      currency,vendor_cost,actual_cost,duration_ms,usage_source,
      usage_confidence,pricing_snapshot_json,request_kind,result_class,created_at
    ) VALUES(?,'target-1','fp','codex',?, 'demo',1,2,3,4,5,'USD',?,?,1000,?,
      'exact','{}','model',?,?)`,
  );
  const projection = db.prepare(
    `INSERT INTO relay_local_usage_events(exchange_id,target_id,completed_at,provider_request_id,endpoint)
     VALUES(?,'target-1',?,?,?)`,
  );
  db.transaction(() => {
    for (const row of rows) {
      ref.run(row.id, sourceId, row.completedAt, row.completedAt, row.model ?? "m");
      ledger.run(row.id, row.model ?? "m", row.usd ?? 0, row.usd ?? 0,
        row.usageSource ?? "provider_usage", row.resultClass ?? "success", row.completedAt);
      projection.run(row.id, row.completedAt, row.requestId ?? null,
        row.endpoint ?? "/v1/responses");
    }
  })();
}

function siteRow(
  siteLogId: string, completedAt: string, amountNano: number,
  extra: Partial<SiteUsageRecord> = {},
): SiteUsageRecord {
  return {
    siteLogId, apiKeyId: "7", model: "m", endpoint: "/v1/responses",
    completedAt, amountNano,
    inputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4, outputTokens: 5,
    ...extra,
  };
}

function siteSnapshot(records: SiteUsageRecord[]): SiteUsageSnapshot {
  return {
    amountNano: records.reduce((sum, row) => sum + row.amountNano, 0),
    records, complete: true, detailsComplete: true, limited: false,
    candidateCount: records.length, processedCount: records.length,
    source: "sub2api_usage",
  };
}

async function review(
  store: ReconciliationStore, nowIso: string, site: SiteUsageSnapshot,
  settlementFx?: number,
): Promise<void> {
  await reviewDueReconciliationHours({
    store, nowIso,
    fetchSite: async () => site,
    remoteKeyIds: async () => ["7"],
    ...(settlementFx !== undefined ? {settlementFx: () => settlementFx} : {}),
  });
}

/** auto-code 2026-09-28T05:00Z 实测形态：1 条 exact 成功请求 + 错误风暴。 */
function stormFixture() {
  return {
    local: [
      {id: "local-ok", completedAt: "2026-09-24T04:10:00.000Z", requestId: "req-1", usd: 0.02},
      {id: "local-err-1", completedAt: "2026-09-24T04:30:00.000Z",
        resultClass: "upstream_error", usageSource: "tokenizer_estimated", usd: 0},
      {id: "local-err-2", completedAt: "2026-09-24T04:30:30.000Z",
        resultClass: "upstream_error", usageSource: "tokenizer_estimated", usd: 0},
      {id: "local-err-3", completedAt: "2026-09-24T04:31:00.000Z",
        resultClass: "upstream_error", usageSource: "tokenizer_estimated", usd: 0},
    ] satisfies LocalRowSpec[],
    site: siteSnapshot([
      siteRow("site-ok", "2026-09-24T04:10:00.000Z", 20_000_000, {requestId: "req-1"}),
      // 与本地错误行相邻 ≤60s 但双向不唯一，weak-A/weak-B 均无法归属 → 留给残差档。
      siteRow("site-err-1", "2026-09-24T04:30:15.000Z", 500_000_000),
      siteRow("site-err-2", "2026-09-24T04:30:45.000Z", 400_000_000),
    ]),
  };
}

function reconRows(db: DeepaaDatabase): Array<{
  exchange_id: string; model: string; actual_cost: number;
  actual_cost_nano: number; fx_rate_to_cny: number;
}> {
  return db.prepare(
    `SELECT exchange_id,model,actual_cost,actual_cost_nano,fx_rate_to_cny
     FROM usage_ledger WHERE request_kind='reconciliation' ORDER BY exchange_id`,
  ).all() as Array<{
    exchange_id: string; model: string; actual_cost: number;
    actual_cost_nano: number; fx_rate_to_cny: number;
  }>;
}

describe("小时残差自动补（2026-09-28 用户确认）", () => {
  test("错误风暴残差自动落账：金额=未匹配站点行之和，零请求零 Token", async () => {
    const {db, store} = await fixture();
    try {
      const fx = stormFixture();
      seedLocalRows(db, fx.local);
      store.seedHour("target-1", "account-1", "sub2api", hour);
      await review(store, "2026-09-24T05:10:00.000Z", fx.site);
      expect(store.getHour("target-1", hour)?.status).toBe("pending");
      await review(store, "2026-09-24T05:20:00.000Z", fx.site);
      expect(store.getHour("target-1", hour)).toMatchObject({
        status: "applied", appliedAmountNano: 900_000_000,
        residualNano: 0, residualRevision: 1, residualAppliedNano: 900_000_000,
        matchedCount: 1, unmatchedSiteCount: 2,
      });
      const rows = reconRows(db);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        exchange_id: expect.stringMatching(/^recon:residual:/u),
        model: "(对账补差·小时残差)",
        actual_cost: 0.9, actual_cost_nano: 900_000_000, fx_rate_to_cny: 1,
      });
      // 待复核列表清空：面板回归静默。
      expect(store.listHours({targetId: "target-1"}).candidateCount).toBe(0);
    } finally {
      db.close();
    }
  });

  test("残差行人民币物化用目标当前 settlementFx，与人工补差同口径", async () => {
    const {db, store} = await fixture();
    try {
      const fx = stormFixture();
      seedLocalRows(db, fx.local);
      store.seedHour("target-1", "account-1", "sub2api", hour);
      await review(store, "2026-09-24T05:10:00.000Z", fx.site, 0.0625);
      await review(store, "2026-09-24T05:20:00.000Z", fx.site, 0.0625);
      expect(reconRows(db)[0]).toMatchObject({
        actual_cost_nano: 56_250_000, fx_rate_to_cny: 0.0625,
      });
    } finally {
      db.close();
    }
  });

  test("站点迟到变化重开小时后按新残差追加第二条 revision，不改写旧行", async () => {
    const {db, store} = await fixture();
    try {
      const first = stormFixture();
      seedLocalRows(db, first.local);
      store.seedHour("target-1", "account-1", "sub2api", hour);
      await review(store, "2026-09-24T05:10:00.000Z", first.site);
      await review(store, "2026-09-24T05:20:00.000Z", first.site);
      // 站点新增一条迟到错误扣费 +$0.10；已定稿小时按 1 小时间隔复查重开。
      const reopened = siteSnapshot([...first.site.records,
        siteRow("site-late", "2026-09-24T04:40:00.000Z", 100_000_000),
      ]);
      await review(store, "2026-09-24T06:30:00.000Z", reopened);
      expect(store.getHour("target-1", hour)).toMatchObject({
        status: "pending", stableCount: 1,
      });
      await review(store, "2026-09-24T06:40:00.000Z", reopened);
      expect(store.getHour("target-1", hour)).toMatchObject({
        status: "applied", appliedAmountNano: 1_000_000_000,
        residualNano: 0, residualRevision: 2, residualAppliedNano: 1_000_000_000,
      });
      const rows = reconRows(db);
      expect(rows).toHaveLength(2);
      expect(new Set(rows.map(row => row.exchange_id)).size).toBe(2);
      expect(rows.map(row => row.actual_cost_nano).sort((a, b) => a - b))
        .toEqual([100_000_000, 900_000_000]);
    } finally {
      db.close();
    }
  });

  test("负残差（站点比本地少）不自动补，留人工复核", async () => {
    const {db, store} = await fixture();
    try {
      seedLocalRows(db, [
        {id: "local-a", completedAt: "2026-09-24T04:20:00.000Z", usd: 0.02},
        {id: "local-b", completedAt: "2026-09-24T04:21:00.000Z", usd: 0.02},
      ]);
      const site = siteSnapshot([
        siteRow("site-only", "2026-09-24T04:10:00.000Z", 20_000_000),
      ]);
      store.seedHour("target-1", "account-1", "sub2api", hour);
      await review(store, "2026-09-24T05:10:00.000Z", site);
      await review(store, "2026-09-24T05:20:00.000Z", site);
      expect(store.getHour("target-1", hour)).toMatchObject({
        status: "needs_review", residualNano: -20_000_000,
      });
      expect(reconRows(db)).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  test("本地存在未匹配金额行（残差不等于未匹配站点行之和）时不自动补", async () => {
    const {db, store} = await fixture();
    try {
      seedLocalRows(db, [
        {id: "local-ok", completedAt: "2026-09-24T04:10:00.000Z", requestId: "req-1", usd: 0.02},
        {id: "local-missed", completedAt: "2026-09-24T04:50:00.000Z", usd: 0.03},
      ]);
      const site = siteSnapshot([
        siteRow("site-ok", "2026-09-24T04:10:00.000Z", 20_000_000, {requestId: "req-1"}),
        siteRow("site-err", "2026-09-24T04:30:00.000Z", 50_000_000),
      ]);
      store.seedHour("target-1", "account-1", "sub2api", hour);
      await review(store, "2026-09-24T05:10:00.000Z", site);
      await review(store, "2026-09-24T05:20:00.000Z", site);
      // 残差 +20M = 未匹配站点 50M − 未匹配本地 30M：本地侧存在未解释金额，
      // 恒等式不成立 → 不自动补，留人工归属。
      expect(store.getHour("target-1", hour)).toMatchObject({
        status: "needs_review", residualNano: 20_000_000,
      });
      expect(reconRows(db)).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  test("残差超过 $10 上限不自动补，并在小时 reason 留下可读解释", async () => {
    const {db, store} = await fixture();
    try {
      const fx = stormFixture();
      seedLocalRows(db, fx.local);
      const site = siteSnapshot([
        siteRow("site-ok", "2026-09-24T04:10:00.000Z", 20_000_000, {requestId: "req-1"}),
        siteRow("site-big", "2026-09-24T04:30:15.000Z", 11_000_000_000),
      ]);
      store.seedHour("target-1", "account-1", "sub2api", hour);
      await review(store, "2026-09-24T05:10:00.000Z", site);
      await review(store, "2026-09-24T05:20:00.000Z", site);
      const hourRow = store.getHour("target-1", hour)!;
      expect(hourRow).toMatchObject({
        status: "needs_review", residualNano: 11_000_000_000,
      });
      expect(hourRow.reason).toContain("超过自动补上限");
      expect(reconRows(db)).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  test("人工补过的小时重开后不再自动补残差，仍走人工", async () => {
    const {db, store} = await fixture();
    try {
      const fx = stormFixture();
      seedLocalRows(db, fx.local);
      store.seedHour("target-1", "account-1", "sub2api", hour);
      // 直接构造两轮稳定观测后人工补差（不走复核循环，避免被残差档抢先）。
      const observe = (nowIso: string) => store.observeHour({
        targetId: "target-1", hourStartUtc: hour,
        siteAmountNano: fx.site.amountNano, localAmountNano: 20_000_000,
        candidateCount: fx.site.records.length, processedCount: fx.site.records.length,
        limited: false, detailsComplete: true, localComplete: true,
        localCandidateCount: fx.local.length, localProcessedCount: fx.local.length,
        matchedCount: 0, unmatchedSiteCount: fx.site.records.length,
        source: "sub2api_usage", observedAt: nowIso,
      });
      observe("2026-09-24T05:10:00.000Z");
      observe("2026-09-24T05:16:00.000Z");
      const manual = store.getHour("target-1", hour)!;
      store.applyManual("target-1", hour, manual.residualNano!, manual.lastCheckedAt!);
      expect(store.getHour("target-1", hour)).toMatchObject({
        status: "applied", manualRevision: 1,
      });
      // 站点迟到 +$0.10 重开：manualRevision>0 挡住残差自动补。
      const reopened = siteSnapshot([...fx.site.records,
        siteRow("site-late", "2026-09-24T04:40:00.000Z", 100_000_000),
      ]);
      await review(store, "2026-09-24T06:30:00.000Z", reopened);
      await review(store, "2026-09-24T06:40:00.000Z", reopened);
      expect(store.getHour("target-1", hour)).toMatchObject({
        status: "needs_review", residualNano: 100_000_000, manualRevision: 1,
      });
      expect(reconRows(db).filter(row => row.exchange_id.startsWith("recon:residual:")))
        .toHaveLength(0);
    } finally {
      db.close();
    }
  });

  test("new-api 统计额完整但明细受限（limited）时不自动补", async () => {
    const {db, store} = await fixture();
    try {
      seedLocalRows(db, [
        {id: "local-ok", completedAt: "2026-09-24T04:10:00.000Z", requestId: "req-1", usd: 0.02},
      ]);
      const site: SiteUsageSnapshot = {
        amountNano: 30_000_000, records: [], complete: true, detailsComplete: false,
        limited: true, candidateCount: 1001, processedCount: 1000,
        source: "newapi_stat",
      };
      store.seedHour("target-1", "account-1", "newapi", hour);
      await review(store, "2026-09-24T05:10:00.000Z", site);
      await review(store, "2026-09-24T05:20:00.000Z", site);
      expect(store.getHour("target-1", hour)).toMatchObject({
        status: "needs_review", residualNano: 10_000_000, siteLimited: true,
      });
      expect(reconRows(db)).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  test("store.applyResidual 守卫：期望金额不符拒绝、二次补拒绝、可整轮重入", async () => {
    const {db, store} = await fixture();
    try {
      const fx = stormFixture();
      seedLocalRows(db, fx.local);
      store.seedHour("target-1", "account-1", "sub2api", hour);
      const observe = (nowIso: string) => store.observeHour({
        targetId: "target-1", hourStartUtc: hour,
        siteAmountNano: fx.site.amountNano, localAmountNano: 20_000_000,
        candidateCount: fx.site.records.length, processedCount: fx.site.records.length,
        limited: false, detailsComplete: true, localComplete: true,
        localCandidateCount: fx.local.length, localProcessedCount: fx.local.length,
        matchedCount: 0, unmatchedSiteCount: fx.site.records.length,
        source: "sub2api_usage", observedAt: nowIso,
      });
      observe("2026-09-24T05:10:00.000Z");
      observe("2026-09-24T05:16:00.000Z");
      expect(() => store.applyResidual("target-1", hour, {
        expectedResidualNano: 899_999_999, unmatchedSiteSumNano: 900_000_000,
      })).toThrow("RECONCILIATION_RESIDUAL_NOT_ELIGIBLE");
      expect(() => store.applyResidual("target-1", hour, {
        expectedResidualNano: 900_000_000, unmatchedSiteSumNano: 500_000_000,
      })).toThrow("RECONCILIATION_RESIDUAL_NOT_ELIGIBLE");
      expect(store.applyResidual("target-1", hour, {
        expectedResidualNano: 900_000_000, unmatchedSiteSumNano: 900_000_000,
      })).toBe(900_000_000);
      expect(() => store.applyResidual("target-1", hour, {
        expectedResidualNano: 0, unmatchedSiteSumNano: 900_000_000,
      })).toThrow("RECONCILIATION_RESIDUAL_NOT_ELIGIBLE");
      expect(store.getHour("target-1", hour)).toMatchObject({
        status: "applied", residualRevision: 1,
      });
    } finally {
      db.close();
    }
  });

  test("纯判定函数：scope 未验证或状态非 needs_review 一律不合格", () => {
    const hourRow = {
      targetId: "target-1", hourStartUtc: hour,
      status: "needs_review" as const, stableCount: 2,
      siteDetailsComplete: true, siteLimited: false, localLimited: false,
      manualRevision: 0, residualRevision: 0, residualAppliedNano: 0,
      residualNano: 100,
    };
    const matches = {
      matched: [],
      unmatchedSite: [{amountNano: 100}],
      unmatchedLocal: [],
      ambiguousCount: 0,
    };
    expect(residualAutoApplyDecision(hourRow as never, matches as never, true).eligible)
      .toBe(true);
    expect(residualAutoApplyDecision(hourRow as never, matches as never, false).eligible)
      .toBe(false);
    expect(residualAutoApplyDecision(
      {...hourRow, status: "pending" as const} as never, matches as never, true,
    ).eligible).toBe(false);
    // 上限常量本身参与判定：residualNano 超过即拦截（annotate 分支在集成测试覆盖）。
    expect(RESIDUAL_AUTO_APPLY_MAX_NANO).toBe(10_000_000_000);
  });
});
