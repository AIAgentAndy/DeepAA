import {afterEach, describe, expect, test} from "vitest";
import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {openDeepaaDatabase} from "../src/lib/db/connection.js";
import {ReconciliationStore} from "../src/lib/sync-engine/reconciliation/store.js";
import {reviewDueReconciliationHours} from "../src/lib/sync-engine/reconciliation/service.js";
import type {DeepaaDatabase} from "@/lib/db/sqlite-driver";
import type {UsageMatch} from "../src/lib/sync-engine/reconciliation/matching.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(path => rm(path, {recursive: true, force: true})));
});

async function fixture(workerReady = true) {
  const root = await mkdtemp(join(tmpdir(), "relay-reconciliation-"));
  roots.push(root);
  const db = openDeepaaDatabase({dataDir: root});
  if (workerReady) {
    db.prepare(
      `INSERT INTO worker_lease(id,owner_id,expires_at)
       VALUES(1,'reconciliation-test','2099-01-01T00:00:00.000Z')`,
    ).run();
    db.prepare(
      "UPDATE schema_meta SET last_source_scan_completed_at='2099-01-01T00:00:00.000Z'",
    ).run();
  }
  return {db, store: new ReconciliationStore(db)};
}

const hour = "2026-09-24T04:00:00.000Z";

function applyCurrentManual(store: ReconciliationStore, targetId: string, hourStartUtc: string): number {
  const current = store.getHour(targetId, hourStartUtc);
  return store.applyManual(
    targetId, hourStartUtc, current?.residualNano ?? 0, current?.lastCheckedAt ?? "",
  );
}

function seedLocal(
  db: DeepaaDatabase, count: number, usageSource = "provider_usage",
  at = "2026-09-24T04:10:00.000Z",
): void {
  db.prepare(
    `INSERT INTO ingestion_sources(relative_path,file_id,generation,byte_offset,scan_offset,
      file_size,processed_count,status,updated_at)
     VALUES('recon-local://test','recon-test',0,0,0,0,0,'ready',?)`,
  ).run(at);
  const sourceId = (db.prepare(
    "SELECT id FROM ingestion_sources WHERE relative_path='recon-local://test'",
  ).get() as {id: number}).id;
  const ref = db.prepare(
    `INSERT INTO raw_exchange_refs(
      exchange_id,capture_session_id,source_id,byte_offset,line_length_bytes,
      captured_at,completed_at,target_id,target_name,agent_name,
      agent_fingerprint_id,model,wire_api,status,is_streaming,
      request_body_bytes,response_body_bytes
    ) VALUES(?,'recon-test',?,0,1,?,?,'target-1','t','codex','fp','m',
      'responses',200,1,0,0)`,
  );
  const ledger = db.prepare(
    `INSERT INTO usage_ledger(
      exchange_id,target_id,agent_fingerprint_id,agent_name,model,vendor,
      rate_multiplier,input_tokens,cache_read_tokens,cache_write_tokens,output_tokens,
      currency,vendor_cost,actual_cost,actual_cost_cny,duration_ms,usage_source,
      usage_confidence,pricing_snapshot_json,request_kind,result_class,created_at
    ) VALUES(?,'target-1','fp','codex','m','demo',1,2,3,4,5,'USD',0.02,0.02,
      0.02,1000,?,'exact','{}','model','success',?)`,
  );
  const projection = db.prepare(
    `INSERT INTO relay_local_usage_events(exchange_id,target_id,completed_at,provider_request_id)
     VALUES(?,'target-1',?,'req-1')`,
  );
  db.transaction(() => {
    for (let i = 0; i < count; i++) {
      const id = `local-${i}`;
      ref.run(id, sourceId, at, at);
      ledger.run(id, usageSource, at);
      projection.run(id, at);
    }
  })();
}

describe("中转站小时状态", () => {
  test("本地计价币种不是 USD 时不把 CNY 数值当成站点 USD 自动或手动补差", async () => {
    const {db, store} = await fixture();
    try {
      seedLocal(db, 1);
      db.prepare(
        "UPDATE usage_ledger SET currency='CNY',actual_cost_cny=0.14 WHERE exchange_id='local-0'",
      ).run();
      const local = store.loadLocalHour("target-1", hour);
      expect(local.complete).toBe(false);
      expect(local.amountNano).toBeNull();
    } finally {
      db.close();
    }
  });

  test("冻结汇率不是 1:1 的人民币物化不影响对账：本地金额按原始 USD 比较", async () => {
    const {db, store} = await fixture();
    try {
      seedLocal(db, 1);
      // settlementFx=7 只负责人民币展示换算（actual_cost_cny=0.14）；
      // 对账比较倍率后 USD（actual_cost=0.02），与汇率无关（2026-09-27 用户澄清）。
      db.prepare(
        "UPDATE usage_ledger SET actual_cost_cny=0.14,fx_rate_to_cny=7 WHERE exchange_id='local-0'",
      ).run();
      const local = store.loadLocalHour("target-1", hour);
      expect(local.complete).toBe(true);
      expect(local.amountNano).toBe(20_000_000);
      // 原始币种不是 USD 的非零金额仍不可比。
      db.prepare(
        "UPDATE usage_ledger SET currency='CNY' WHERE exchange_id='local-0'",
      ).run();
      expect(store.loadLocalHour("target-1", hour).complete).toBe(false);
    } finally {
      db.close();
    }
  });

  test("活动驱动发现：只有存在本地完成时刻事件的小时才创建对账行", async () => {
    const {db, store} = await fixture();
    try {
      seedLocal(db, 2);
      // 两条事件同属 hour；只发现该小时，空小时零记录。
      expect(store.missingActivityHours("target-1", "2026-09-24T00:00:00.000Z"))
        .toEqual([hour]);
      for (const bucket of store.missingActivityHours("target-1", "2026-09-24T00:00:00.000Z")) {
        store.seedHour("target-1", "account-1", "sub2api", bucket);
      }
      expect(store.missingActivityHours("target-1", "2026-09-24T00:00:00.000Z"))
        .toEqual([]);
      // 窗口外的旧事件不发现（近 48 小时界限由调用方传入 since）。
      expect(store.missingActivityHours("target-1", "2026-09-24T05:00:00.000Z"))
        .toEqual([]);
    } finally {
      db.close();
    }
  });

  test("新小时只建 pending，关闭后等五分钟即允许复核", async () => {
    const {db, store} = await fixture();
    try {
      store.seedHour("target-1", "account-1", "sub2api", hour);
      store.seedHour("target-1", "account-1", "sub2api", hour);
      expect(store.dueHours("2026-09-24T05:04:59.999Z")).toEqual([]);
      expect(store.dueHours("2026-09-24T05:05:00.000Z")).toEqual([
        expect.objectContaining({targetId: "target-1", status: "pending"}),
      ]);
      expect(db.prepare("SELECT COUNT(*) AS n FROM relay_reconciliation_hours").get()).toEqual({n: 1});
    } finally {
      db.close();
    }
  });

  test("前八个不完整小时反复失败时，新到期小时不能被固定 LIMIT 饿死", async () => {
    const {db, store} = await fixture();
    try {
      const hours = Array.from({length: 10}, (_, index) =>
        new Date(Date.parse(hour) + index * 3_600_000).toISOString());
      for (const start of hours) store.seedHour("target-1", "account-1", "sub2api", start);
      const first = store.dueHours("2026-09-24T16:10:00.000Z");
      expect(first).toHaveLength(8);
      for (const row of first) store.observeHour({
        targetId: row.targetId, hourStartUtc: row.hourStartUtc,
        siteAmountNano: null, localAmountNano: null,
        candidateCount: 0, processedCount: 0, limited: false,
        detailsComplete: false, localComplete: false,
        localCandidateCount: 0, localProcessedCount: 0,
        matchedCount: 0, unmatchedSiteCount: 0,
        source: "sub2api_usage", observedAt: "2026-09-24T16:10:00.000Z",
        reason: "暂不可用",
      });
      const next = store.dueHours("2026-09-24T16:15:00.000Z");
      expect(next.slice(0, 2).map(item => item.hourStartUtc)).toEqual(hours.slice(8));
    } finally {
      db.close();
    }
  });

  test("同一站点金额连续两次且本地完整才定稿；站点变化重置稳定计数", async () => {
    const {db, store} = await fixture();
    try {
      store.seedHour("target-1", "account-1", "sub2api", hour);
      const base = {
        targetId: "target-1", hourStartUtc: hour,
        siteAmountNano: 30_000_000, localAmountNano: 20_000_000,
        candidateCount: 1, processedCount: 1, limited: false,
        detailsComplete: true, localComplete: true, localCandidateCount: 1,
        localProcessedCount: 1, matchedCount: 0, unmatchedSiteCount: 1,
        source: "sub2api_usage",
      };
      store.observeHour({...base, observedAt: "2026-09-24T06:10:00.000Z"});
      expect(store.getHour("target-1", hour)?.status).toBe("pending");
      store.observeHour({...base, siteAmountNano: 31_000_000, observedAt: "2026-09-24T06:16:00.000Z"});
      expect(store.getHour("target-1", hour)?.stableCount).toBe(1);
      store.observeHour({...base, siteAmountNano: 31_000_000, observedAt: "2026-09-24T06:22:00.000Z"});
      expect(store.getHour("target-1", hour)).toMatchObject({
        status: "needs_review", residualNano: 11_000_000, stableCount: 2,
      });
    } finally {
      db.close();
    }
  });

  test("任何非零残差都不能按微小阈值自动标记为已平衡", async () => {
    const {db, store} = await fixture();
    try {
      store.seedHour("target-1", "account-1", "sub2api", hour);
      const base = {
        targetId: "target-1", hourStartUtc: hour,
        siteAmountNano: 50_000, localAmountNano: 0,
        candidateCount: 1, processedCount: 1, limited: false,
        detailsComplete: true, localComplete: true,
        localCandidateCount: 0, localProcessedCount: 0,
        matchedCount: 0, unmatchedSiteCount: 1,
        source: "sub2api_usage",
      };
      store.observeHour({...base, observedAt: "2026-09-24T06:10:00.000Z"});
      store.observeHour({...base, observedAt: "2026-09-24T06:16:00.000Z"});
      expect(store.getHour("target-1", hour)).toMatchObject({
        status: "needs_review", residualNano: 50_000,
      });
    } finally {
      db.close();
    }
  });

  test("站点连续失败按目标指数退避并门控 dueHours，成功立即清零", async () => {
    const {db, store} = await fixture();
    try {
      store.seedHour("target-1", "account-1", "sub2api", hour);
      expect(store.dueHours("2026-09-24T05:05:00.000Z")).toHaveLength(1);
      // 第 1 次失败：5 分钟后才可重试。
      store.recordSiteOutcome("target-1", false,
        "站点明细请求失败（SITE_USAGE_HTTP_429（站点限流））", "2026-09-24T05:05:00.000Z");
      expect(store.dueHours("2026-09-24T05:09:59.999Z")).toEqual([]);
      expect(store.dueHours("2026-09-24T05:10:00.000Z")).toHaveLength(1);
      expect(store.siteBackoff("target-1")).toMatchObject({failCount: 1});
      // 第 2 次 15 分钟、第 3 次 30 分钟、第 4 次起封顶 60 分钟。
      store.recordSiteOutcome("target-1", false, "again", "2026-09-24T05:10:00.000Z");
      expect(store.dueHours("2026-09-24T05:24:59.999Z")).toEqual([]);
      expect(store.dueHours("2026-09-24T05:25:00.000Z")).toHaveLength(1);
      store.recordSiteOutcome("target-1", false, "again", "2026-09-24T05:25:00.000Z");
      store.recordSiteOutcome("target-1", false, "again", "2026-09-24T05:55:00.000Z");
      expect(store.dueHours("2026-09-24T06:54:59.999Z")).toEqual([]);
      expect(store.dueHours("2026-09-24T06:55:00.000Z")).toHaveLength(1);
      store.recordSiteOutcome("target-1", false, "again", "2026-09-24T06:55:00.000Z");
      expect(store.dueHours("2026-09-24T07:54:59.999Z")).toEqual([]);
      expect(store.dueHours("2026-09-24T07:55:00.000Z")).toHaveLength(1);
      // 一次成功立即清零退避。
      store.recordSiteOutcome("target-1", true, "", "2026-09-24T07:55:00.000Z");
      expect(store.siteBackoff("target-1")).toBeUndefined();
      expect(store.dueHours("2026-09-24T05:05:00.000Z")).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  test("轻量复查键随完整观测持久化；命中时只推进检查时刻", async () => {
    const {db, store} = await fixture();
    try {
      store.seedHour("target-1", "account-1", "sub2api", hour);
      const base = {
        targetId: "target-1", hourStartUtc: hour,
        siteAmountNano: 0, localAmountNano: 0,
        candidateCount: 5, processedCount: 5, limited: false,
        detailsComplete: true, localComplete: true,
        localCandidateCount: 0, localProcessedCount: 0,
        matchedCount: 0, unmatchedSiteCount: 0, source: "sub2api_usage",
      };
      store.observeHour({...base, siteLightCheck: "sub2api_day:t:5",
        observedAt: "2026-09-24T06:10:00.000Z"});
      store.observeHour({...base, siteLightCheck: "sub2api_day:t:5",
        observedAt: "2026-09-24T06:16:00.000Z"});
      const settled = store.getHour("target-1", hour)!;
      expect(settled).toMatchObject({status: "balanced", siteLightCheck: "sub2api_day:t:5"});
      store.touchHourChecked("target-1", hour, "2026-09-24T07:20:00.000Z");
      expect(store.getHour("target-1", hour)).toMatchObject({
        status: "balanced", stableCount: 2, siteLightCheck: "sub2api_day:t:5",
        lastCheckedAt: "2026-09-24T07:20:00.000Z",
      });
    } finally {
      db.close();
    }
  });

  test("站点金额与条数相同但明细证据不同，不能算作连续稳定观测", async () => {
    const {db, store} = await fixture();
    try {
      store.seedHour("target-1", "account-1", "sub2api", hour);
      const base = {
        targetId: "target-1", hourStartUtc: hour,
        siteAmountNano: 30_000_000, localAmountNano: 0,
        candidateCount: 1, processedCount: 1, limited: false,
        detailsComplete: true, localComplete: true,
        localCandidateCount: 0, localProcessedCount: 0,
        matchedCount: 0, unmatchedSiteCount: 1, source: "sub2api_usage",
      };
      const first = {...base, siteEvidenceHash: "first-row", observedAt: "2026-09-24T06:10:00.000Z"};
      const second = {...base, siteEvidenceHash: "different-row", observedAt: "2026-09-24T06:16:00.000Z"};
      store.observeHour(first);
      store.observeHour(second);
      expect(store.getHour("target-1", hour)).toMatchObject({
        status: "pending", stableCount: 1,
      });
    } finally {
      db.close();
    }
  });

  test("近期已平衡小时仍定期复核，站点迟到变化重新进入 pending", async () => {
    const {db, store} = await fixture();
    try {
      store.seedHour("target-1", "account-1", "sub2api", hour);
      const base = {
        targetId: "target-1", hourStartUtc: hour,
        siteAmountNano: 0, localAmountNano: 0,
        candidateCount: 0, processedCount: 0, limited: false,
        detailsComplete: true, localComplete: true,
        localCandidateCount: 0, localProcessedCount: 0,
        matchedCount: 0, unmatchedSiteCount: 0, source: "sub2api_usage",
      };
      store.observeHour({...base, observedAt: "2026-09-24T06:10:00.000Z"});
      store.observeHour({...base, observedAt: "2026-09-24T06:16:00.000Z"});
      expect(store.getHour("target-1", hour)?.status).toBe("balanced");
      expect(store.dueHours("2026-09-24T07:20:00.000Z"))
        .toEqual([expect.objectContaining({hourStartUtc: hour, status: "balanced"})]);
      store.observeHour({...base, siteAmountNano: 10_000_000,
        candidateCount: 1, processedCount: 1, observedAt: "2026-09-24T07:20:00.000Z"});
      expect(store.getHour("target-1", hour)).toMatchObject({
        status: "pending", stableCount: 1, residualNano: 10_000_000,
      });
    } finally {
      db.close();
    }
  });

  test("人工已补小时后站点迟到变更以第二条更正入账，不覆盖旧流水", async () => {
    const {db, store} = await fixture();
    try {
      store.seedHour("target-1", "account-1", "sub2api", hour);
      const base = {
        targetId: "target-1", hourStartUtc: hour,
        siteAmountNano: 20_000_000, localAmountNano: 0,
        candidateCount: 1, processedCount: 1, limited: false,
        detailsComplete: true, localComplete: true,
        localCandidateCount: 0, localProcessedCount: 0,
        matchedCount: 0, unmatchedSiteCount: 1, source: "sub2api_usage",
      };
      store.observeHour({...base, observedAt: "2026-09-24T06:10:00.000Z"});
      store.observeHour({...base, observedAt: "2026-09-24T06:16:00.000Z"});
      expect(applyCurrentManual(store, "target-1", hour)).toBe(20_000_000);
      store.observeHour({...base, siteAmountNano: 25_000_000,
        observedAt: "2026-09-24T07:20:00.000Z"});
      store.observeHour({...base, siteAmountNano: 25_000_000,
        observedAt: "2026-09-24T07:26:00.000Z"});
      expect(store.getHour("target-1", hour)?.status).toBe("needs_review");
      expect(applyCurrentManual(store, "target-1", hour)).toBe(5_000_000);
      expect(store.getHour("target-1", hour)).toMatchObject({
        status: "applied", appliedAmountNano: 25_000_000, residualNano: 0,
      });
      expect(db.prepare(
        "SELECT actual_cost_nano FROM usage_ledger WHERE request_kind='reconciliation' ORDER BY actual_cost_nano",
      ).all()).toEqual([
        {actual_cost_nano: 5_000_000}, {actual_cost_nano: 20_000_000},
      ]);
    } finally {
      db.close();
    }
  });

  test("站点数据截断与本地派生未完成都不得定稿", async () => {
    const {db, store} = await fixture();
    try {
      store.seedHour("target-1", "account-1", "newapi", hour);
      store.observeHour({
        targetId: "target-1", hourStartUtc: hour,
        siteAmountNano: null, localAmountNano: 0, candidateCount: 1001,
        processedCount: 1000, limited: true, detailsComplete: false,
        localComplete: false, localCandidateCount: 0, localProcessedCount: 0,
        matchedCount: 0, unmatchedSiteCount: 0, source: "newapi_stat",
        observedAt: "2026-09-24T06:10:00.000Z", reason: "站点分页截断",
      });
      expect(store.getHour("target-1", hour)).toMatchObject({
        status: "incomplete", siteLimited: true, siteCandidateCount: 1001,
        siteProcessedCount: 1000, residualNano: null,
      });
    } finally {
      db.close();
    }
  });

  test("new-api 统计额完整但明细受限时仍可人工核对，禁止逐条自动补", async () => {
    const {db, store} = await fixture();
    try {
      store.seedHour("target-1", "account-1", "newapi", hour);
      const input = {
        targetId: "target-1", hourStartUtc: hour, siteAmountNano: 30_000_000,
        localAmountNano: 0, candidateCount: 1001, processedCount: 1000,
        limited: true, detailsComplete: false, localComplete: true,
        localCandidateCount: 0, localProcessedCount: 0,
        matchedCount: 0, unmatchedSiteCount: 0, source: "newapi_stat",
      };
      store.observeHour({...input, observedAt: "2026-09-24T06:10:00.000Z"});
      store.observeHour({...input, observedAt: "2026-09-24T06:16:00.000Z"});
      expect(store.getHour("target-1", hour)).toMatchObject({
        status: "needs_review", siteLimited: true, residualNano: 30_000_000,
      });
      expect(applyCurrentManual(store, "target-1", hour)).toBe(30_000_000);
    } finally {
      db.close();
    }
  });

  test("sub2api 小时趋势缺少可验证时区范围时禁止直接人工落账", async () => {
    const {db, store} = await fixture();
    try {
      store.seedHour("target-1", "account-1", "sub2api", hour);
      const input = {
        targetId: "target-1", hourStartUtc: hour, siteAmountNano: 30_000_000,
        localAmountNano: 0, candidateCount: 1001, processedCount: 1000,
        limited: true, detailsComplete: false, localComplete: true,
        localCandidateCount: 0, localProcessedCount: 0,
        matchedCount: 0, unmatchedSiteCount: 1001,
        source: "sub2api_trend",
      };
      store.observeHour({...input, observedAt: "2026-09-24T06:10:00.000Z"});
      store.observeHour({...input, observedAt: "2026-09-24T06:16:00.000Z"});
      expect(() => applyCurrentManual(store, "target-1", hour))
        .toThrow("RECONCILIATION_SOURCE_INCOMPLETE");
    } finally {
      db.close();
    }
  });

  test("本地查询仅从完成时刻索引取目标小时，估算行成本为零", async () => {
    const {db, store} = await fixture();
    try {
      seedLocal(db, 1);
      expect(store.loadLocalHour("target-1", hour)).toMatchObject({
        amountNano: 20_000_000, complete: true, limited: false,
        candidateCount: 1, processedCount: 1,
        records: [expect.objectContaining({requestId: "req-1", actualCostNano: 20_000_000})],
      });
      db.prepare("UPDATE usage_ledger SET usage_source='tokenizer_estimated' WHERE exchange_id='local-0'").run();
      expect(store.loadLocalHour("target-1", hour).amountNano).toBe(0);
    } finally {
      db.close();
    }
  });

  test("本地候选超 1000 条时在读取账本正文前有界停止，不返回部分金额", async () => {
    const {db, store} = await fixture();
    try {
      seedLocal(db, 1001);
      const result = store.loadLocalHour("target-1", hour);
      expect(result).toMatchObject({
        amountNano: null, complete: false, limited: true,
        candidateCount: 1001, processedCount: 1001, records: [],
      });
    } finally {
      db.close();
    }
  });

  test("本地单条精确金额可表示而小时合计溢出时拒绝补账", async () => {
    const {db, store} = await fixture();
    try {
      seedLocal(db, 2);
      // 对账读原始 USD（actual_cost）；两条各 $5e6 相加超出 nano 安全整数。
      db.prepare(
        "UPDATE usage_ledger SET actual_cost=5000000 WHERE exchange_id IN ('local-0','local-1')",
      ).run();
      expect(store.loadLocalHour("target-1", hour)).toMatchObject({
        amountNano: null, complete: false, limited: true,
      });
    } finally {
      db.close();
    }
  });

  test("Raw Registrar 已登记未派生任务没有 raw_exchange_refs 时仍阻止小时定稿", async () => {
    const {db, store} = await fixture();
    try {
      seedLocal(db, 1);
      const source = db.prepare(
        "SELECT id FROM ingestion_sources WHERE relative_path='recon-local://test'",
      ).get() as {id: number};
      const at = "2026-09-24T04:25:00.000Z";
      const hash = "a".repeat(64);
      db.prepare(
        `INSERT INTO ingestion_records(
          exchange_id,source_id,source_generation,source_file_id,
          byte_offset,line_length_bytes,line_sha256,schema_version,
          captured_at,completed_at,request_body_bytes,response_body_bytes,
          request_body_sha256,response_body_sha256,
          request_body_storage,response_body_storage,request_body_state,
          response_body_state,registered_at
        ) VALUES('pending-ex',?,0,'recon-test',10,1,?,2,?,?,0,0,?,?,
          'none','none','empty','empty',?)`,
      ).run(source.id, hash, at, at, hash, hash, at);
      const id = (db.prepare(
        "SELECT id FROM ingestion_records WHERE exchange_id='pending-ex'",
      ).get() as {id: number}).id;
      db.prepare(
        `INSERT INTO derivation_jobs(
          ingestion_record_id,projection_version,job_status,available_at,
          request_verification,response_verification,created_at,updated_at
        ) VALUES(?,1,'pending',?,'pending','pending',?,?)`,
      ).run(id, at, at, at);
      db.prepare(
        `INSERT INTO relay_pending_ingestions(exchange_id,target_id,completed_at)
         VALUES('pending-ex','target-1',?)`,
      ).run(at);
      expect(db.prepare(
        "SELECT 1 FROM raw_exchange_refs WHERE exchange_id='pending-ex'",
      ).get()).toBeUndefined();
      expect(store.hasPendingDerivation("target-1", hour)).toBe(true);
    } finally {
      db.close();
    }
  });

  test("数小时前发起但本小时完成的待派生任务也由完成时刻索引阻止补账", async () => {
    const {db, store} = await fixture();
    try {
      seedLocal(db, 1);
      const source = db.prepare(
        "SELECT id FROM ingestion_sources WHERE relative_path='recon-local://test'",
      ).get() as {id: number};
      const hash = "b".repeat(64);
      const completedAt = "2026-09-24T04:40:00.000Z";
      db.prepare(
        `INSERT INTO ingestion_records(
          exchange_id,source_id,source_generation,source_file_id,
          byte_offset,line_length_bytes,line_sha256,schema_version,
          captured_at,completed_at,request_body_bytes,response_body_bytes,
          request_body_sha256,response_body_sha256,
          request_body_storage,response_body_storage,request_body_state,
          response_body_state,registered_at
        ) VALUES('very-long-ex',?,0,'recon-test',20,1,?,2,
          '2026-09-23T18:00:00.000Z',?,0,0,?,?,
          'none','none','empty','empty',?)`,
      ).run(source.id, hash, completedAt, hash, hash, completedAt);
      db.prepare(
        `INSERT INTO relay_pending_ingestions(exchange_id,target_id,completed_at)
         VALUES('very-long-ex','target-1','2026-09-24T04:40:00.000Z')`,
      ).run();
      expect(store.hasPendingDerivation("target-1", hour)).toBe(true);
    } finally {
      db.close();
    }
  });

  test("Worker 尚未完成整轮来源扫描时不认定本地小时已完整", async () => {
    const {db, store} = await fixture(false);
    try {
      expect(store.hasPendingDerivation("target-1", hour)).toBe(true);
      db.prepare(
        `INSERT INTO worker_lease(id,owner_id,expires_at)
         VALUES(1,'reconciliation-test','2099-01-01T00:00:00.000Z')`,
      ).run();
      db.prepare(
        "UPDATE schema_meta SET last_source_scan_completed_at=?",
      ).run(new Date().toISOString());
      expect(store.hasPendingDerivation("target-1", hour)).toBe(false);
    } finally {
      db.close();
    }
  });

  test("水位新鲜度上限：提交时刻距今超过 30 分钟视为 pending（2026-09-29）", async () => {
    const {db, store} = await fixture(false);
    try {
      db.prepare(
        `INSERT INTO worker_lease(id,owner_id,expires_at)
         VALUES(1,'reconciliation-test','2099-01-01T00:00:00.000Z')`,
      ).run();
      // 31 分钟前提交的水位：租约有效、状态健康也不得无限信任（hang 死兜底）。
      db.prepare(
        "UPDATE schema_meta SET last_source_scan_completed_at=?",
      ).run(new Date(Date.now() - 31 * 60_000).toISOString());
      expect(store.hasPendingDerivation("target-1", hour)).toBe(true);
      // 新鲜水位（5 分钟前）正常放行。
      db.prepare(
        "UPDATE schema_meta SET last_source_scan_completed_at=?",
      ).run(new Date(Date.now() - 5 * 60_000).toISOString());
      expect(store.hasPendingDerivation("target-1", hour)).toBe(false);
    } finally {
      db.close();
    }
  });

  test("已稳定的唯一逐条差额事务落账，重复执行幂等且零请求零 Token", async () => {
    const {db, store} = await fixture();
    try {
      seedLocal(db, 1);
      store.seedHour("target-1", "account-1", "sub2api", hour);
      const observation = {
        targetId: "target-1", hourStartUtc: hour,
        siteAmountNano: 30_000_000, localAmountNano: 20_000_000,
        candidateCount: 1, processedCount: 1, limited: false,
        detailsComplete: true, localComplete: true,
        localCandidateCount: 1, localProcessedCount: 1,
        matchedCount: 1, unmatchedSiteCount: 0, source: "sub2api_usage",
      };
      store.observeHour({...observation, observedAt: "2026-09-24T06:10:00.000Z"});
      store.observeHour({...observation, observedAt: "2026-09-24T06:16:00.000Z"});
      const local = store.loadLocalHour("target-1", hour).records[0]!;
      const match: UsageMatch = {
        local, confidence: "high", deltaNano: 10_000_000,
        site: {
          siteLogId: "site-1", apiKeyId: "7", model: "m",
          completedAt: "2026-09-24T04:10:00.000Z",
          inputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4,
          outputTokens: 5, amountNano: 30_000_000,
        },
      };
      expect(store.applyMatches("target-1", hour, [match])).toBe(1);
      expect(store.applyMatches("target-1", hour, [match])).toBe(0);
      expect(store.getHour("target-1", hour)).toMatchObject({
        status: "applied", appliedAmountNano: 10_000_000, residualNano: 0,
      });
      const adjustment = db.prepare(
        `SELECT u.request_kind,u.result_class,u.input_tokens,u.actual_cost_nano,
          u.created_at,f.reason
         FROM usage_ledger u JOIN analytics_dirty_buckets f
           ON f.bucket_start_utc = ?
         WHERE u.exchange_id LIKE 'recon:matched:%' LIMIT 1`,
      ).get(hour) as Record<string, unknown>;
      expect(adjustment).toMatchObject({
        request_kind: "reconciliation", result_class: "reconciled",
        input_tokens: 0, actual_cost_nano: 10_000_000, created_at: "2026-09-24T04:10:00.000Z",
      });
      expect(String(adjustment.reason)).toContain("reconciliation");
    } finally {
      db.close();
    }
  });

  test("已匹配站点记录事后改价时追加逐条更正，原补差仍可审计", async () => {
    const {db, store} = await fixture();
    try {
      seedLocal(db, 1);
      store.seedHour("target-1", "account-1", "sub2api", hour);
      const base = {
        targetId: "target-1", hourStartUtc: hour,
        siteAmountNano: 30_000_000, localAmountNano: 20_000_000,
        candidateCount: 1, processedCount: 1, limited: false,
        detailsComplete: true, localComplete: true, localCandidateCount: 1,
        localProcessedCount: 1, matchedCount: 1, unmatchedSiteCount: 0,
        source: "sub2api_usage",
      };
      store.observeHour({...base, observedAt: "2026-09-24T06:10:00.000Z"});
      store.observeHour({...base, observedAt: "2026-09-24T06:16:00.000Z"});
      const local = store.loadLocalHour("target-1", hour).records[0]!;
      const site = {
        siteLogId: "site-change", model: "m", completedAt: "2026-09-24T04:10:00.000Z",
        inputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4,
        outputTokens: 5, amountNano: 30_000_000,
      };
      store.applyMatches("target-1", hour, [{local, site, confidence: "high", deltaNano: 10_000_000}]);
      store.observeHour({...base, siteAmountNano: 35_000_000,
        observedAt: "2026-09-24T07:20:00.000Z"});
      store.observeHour({...base, siteAmountNano: 35_000_000,
        observedAt: "2026-09-24T07:26:00.000Z"});
      expect(store.applyMatches("target-1", hour, [{
        local, site: {...site, amountNano: 35_000_000},
        confidence: "high", deltaNano: 15_000_000,
      }])).toBe(1);
      expect(store.getHour("target-1", hour)).toMatchObject({
        status: "applied", appliedAmountNano: 15_000_000, residualNano: 0,
      });
      expect(db.prepare(
        "SELECT actual_cost_nano FROM usage_ledger WHERE request_kind='reconciliation' ORDER BY actual_cost_nano",
      ).all()).toEqual([
        {actual_cost_nano: 5_000_000}, {actual_cost_nano: 10_000_000},
      ]);
    } finally {
      db.close();
    }
  });

  test("逐条匹配落库站点折扣声明，改价更正同步刷新声明值（2026-09-28）", async () => {
    const {db, store} = await fixture();
    try {
      seedLocal(db, 1);
      store.seedHour("target-1", "account-1", "sub2api", hour);
      // seedLocal 播 actual_cost=0.02（20M nano）：站点 9 折实扣 18M、声明折扣 2M。
      const base = {
        targetId: "target-1", hourStartUtc: hour,
        siteAmountNano: 18_000_000, localAmountNano: 20_000_000,
        candidateCount: 1, processedCount: 1, limited: false,
        detailsComplete: true, localComplete: true, localCandidateCount: 1,
        localProcessedCount: 1, matchedCount: 1, unmatchedSiteCount: 0,
        source: "sub2api_usage",
      };
      store.observeHour({...base, observedAt: "2026-09-24T06:10:00.000Z"});
      store.observeHour({...base, observedAt: "2026-09-24T06:16:00.000Z"});
      const local = store.loadLocalHour("target-1", hour).records[0]!;
      const site = {
        siteLogId: "site-disc", model: "m", completedAt: "2026-09-24T04:10:00.000Z",
        inputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4,
        outputTokens: 5, amountNano: 18_000_000, siteDiscountNano: 2_000_000,
      };
      store.applyMatches("target-1", hour, [
        {local, site, confidence: "exact", deltaNano: -2_000_000},
      ]);
      expect(db.prepare(
        `SELECT site_discount_nano, adjustment_nano FROM relay_reconciliation_matches
         WHERE site_log_id='site-disc'`,
      ).get()).toEqual({site_discount_nano: 2_000_000, adjustment_nano: -2_000_000});
      // 站点改价（且折扣声明同批变化）时 revision 更正必须同步刷新声明值。
      store.observeHour({...base, siteAmountNano: 16_000_000,
        observedAt: "2026-09-24T07:20:00.000Z"});
      store.observeHour({...base, siteAmountNano: 16_000_000,
        observedAt: "2026-09-24T07:26:00.000Z"});
      expect(store.applyMatches("target-1", hour, [{
        local, site: {...site, amountNano: 16_000_000, siteDiscountNano: 4_000_000},
        confidence: "exact", deltaNano: -4_000_000,
      }])).toBe(1);
      expect(db.prepare(
        `SELECT site_discount_nano, revision FROM relay_reconciliation_matches
         WHERE site_log_id='site-disc'`,
      ).get()).toEqual({site_discount_nano: 4_000_000, revision: 2});
      // 站点无声明（如上游 sub2api / new-api）时列为 NULL，不为 0。
      const noClaim = {
        siteLogId: "site-noclaim", model: "m", completedAt: "2026-09-24T04:11:00.000Z",
        inputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4,
        outputTokens: 5, amountNano: 20_000_000,
      };
      const local2 = {...local, exchangeId: `${local.exchangeId}-2`};
      db.prepare(
        `INSERT INTO raw_exchange_refs(exchange_id, capture_session_id, source_id,
           byte_offset, line_length_bytes, captured_at, completed_at, target_id, target_name,
           agent_name, agent_fingerprint_id, model, wire_api, status, is_streaming,
           request_body_bytes, response_body_bytes)
         VALUES(?, 'recon-test', (SELECT id FROM ingestion_sources WHERE relative_path='recon-local://test'),
           0, 1, ?, ?, 'target-1', 't', 'codex', 'fp', 'm', 'responses', 200, 1, 0, 0)`,
      ).run(local2.exchangeId, local.completedAt, local.completedAt);
      db.prepare(
        `INSERT INTO usage_ledger(exchange_id, target_id, agent_fingerprint_id, agent_name,
           model, vendor, rate_multiplier, input_tokens, cache_read_tokens, cache_write_tokens,
           output_tokens, currency, vendor_cost, actual_cost, duration_ms, usage_source,
           usage_confidence, pricing_snapshot_json, request_kind, result_class, created_at)
         VALUES(?, 'target-1', 'fp', 'codex', 'm', 'openai', 1, 2, 3, 4, 5, 'USD', 0, 0.02, 100,
           'provider_usage', 'exact', '{}', 'model', 'success', ?)`,
      ).run(local2.exchangeId, local.completedAt);
      store.observeHour({
        ...base, siteAmountNano: 16_000_000 + 20_000_000,
        localAmountNano: 20_000_000 + 20_000_000,
        candidateCount: 2, processedCount: 2,
        localCandidateCount: 2, localProcessedCount: 2, matchedCount: 2,
        observedAt: "2026-09-24T08:30:00.000Z",
      });
      store.observeHour({
        ...base, siteAmountNano: 16_000_000 + 20_000_000,
        localAmountNano: 20_000_000 + 20_000_000,
        candidateCount: 2, processedCount: 2,
        localCandidateCount: 2, localProcessedCount: 2, matchedCount: 2,
        observedAt: "2026-09-24T08:36:00.000Z",
      });
      store.applyMatches("target-1", hour, [
        {local, site: {...site, amountNano: 16_000_000, siteDiscountNano: 4_000_000},
          confidence: "exact", deltaNano: -4_000_000},
        {local: local2, site: noClaim, confidence: "exact", deltaNano: 0},
      ]);
      expect(db.prepare(
        "SELECT site_discount_nano FROM relay_reconciliation_matches WHERE site_log_id='site-noclaim'",
      ).get()).toEqual({site_discount_nano: null});
    } finally {
      db.close();
    }
  });

  test("人工只补稳定快照的剩余净额；忽略保留原因且不写金额", async () => {
    const {db, store} = await fixture();
    try {
      seedLocal(db, 1);
      store.seedHour("target-1", "account-1", "sub2api", hour);
      store.seedHour("target-2", "account-2", "newapi", hour);
      for (const targetId of ["target-1", "target-2"]) {
        const base = {
          targetId, hourStartUtc: hour,
          siteAmountNano: 30_000_000, localAmountNano: 20_000_000,
          candidateCount: 1, processedCount: 1, limited: false,
          detailsComplete: false, localComplete: true,
          localCandidateCount: 1, localProcessedCount: 1,
          matchedCount: 0, unmatchedSiteCount: 1, source: "newapi_stat",
        };
        store.observeHour({...base, observedAt: "2026-09-24T06:10:00.000Z"});
        store.observeHour({...base, observedAt: "2026-09-24T06:16:00.000Z"});
      }
      expect(applyCurrentManual(store, "target-1", hour)).toBe(10_000_000);
      expect(store.getHour("target-1", hour)).toMatchObject({
        status: "applied", residualNano: 0, appliedAmountNano: 10_000_000,
      });
      expect(() => applyCurrentManual(store, "target-1", hour)).toThrow("RECONCILIATION_HOUR_NOT_PENDING");
      store.ignoreHour("target-2", hour, "站点账号还被别的本地目标使用");
      expect(store.getHour("target-2", hour)).toMatchObject({
        status: "ignored", ignoredReason: "站点账号还被别的本地目标使用",
      });
      expect((db.prepare(
        "SELECT COUNT(*) AS n FROM usage_ledger WHERE request_kind='reconciliation'",
      ).get() as {n: number}).n).toBe(1);
    } finally {
      db.close();
    }
  });

  test("人工已补的剩余差额不能因迟到的首次逐条匹配被自动补第二次", async () => {
    const {db, store} = await fixture();
    try {
      seedLocal(db, 1);
      store.seedHour("target-1", "account-1", "sub2api", hour);
      const observation = {
        targetId: "target-1", hourStartUtc: hour,
        siteAmountNano: 30_000_000, localAmountNano: 20_000_000,
        candidateCount: 1, processedCount: 1, limited: false,
        detailsComplete: true, localComplete: true,
        localCandidateCount: 1, localProcessedCount: 1,
        matchedCount: 0, unmatchedSiteCount: 1, source: "sub2api_usage",
      };
      store.observeHour({...observation, observedAt: "2026-09-24T06:10:00.000Z"});
      store.observeHour({...observation, observedAt: "2026-09-24T06:16:00.000Z"});
      expect(applyCurrentManual(store, "target-1", hour)).toBe(10_000_000);
      const local = store.loadLocalHour("target-1", hour).records[0]!;
      const match: UsageMatch = {
        local, confidence: "high", deltaNano: 10_000_000,
        site: {siteLogId: "late-match", model: "m",
          completedAt: "2026-09-24T04:10:00.000Z",
          inputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4,
          outputTokens: 5, amountNano: 30_000_000},
      };
      expect(() => store.applyMatches("target-1", hour, [match]))
        .toThrow("RECONCILIATION_MANUAL_MATCH_REQUIRES_REVIEW");
      expect(store.getHour("target-1", hour)).toMatchObject({
        appliedAmountNano: 10_000_000, residualNano: 0,
      });
      expect((db.prepare(
        "SELECT COUNT(*) AS n FROM usage_ledger WHERE request_kind='reconciliation'",
      ).get() as {n: number}).n).toBe(1);
    } finally {
      db.close();
    }
  });

  test("ignored 小时复核时不因迟到匹配自动补差或改写审核状态", async () => {
    const {db, store} = await fixture();
    try {
      seedLocal(db, 1);
      store.seedHour("target-1", "account-1", "sub2api", hour);
      const incompleteObservation = {
        targetId: "target-1", hourStartUtc: hour,
        siteAmountNano: 30_000_000, localAmountNano: 20_000_000,
        candidateCount: 1, processedCount: 1, limited: false,
        detailsComplete: false, localComplete: true,
        localCandidateCount: 1, localProcessedCount: 1,
        matchedCount: 0, unmatchedSiteCount: 1,
        source: "sub2api_usage",
      };
      store.observeHour({...incompleteObservation, observedAt: "2026-09-24T06:10:00.000Z"});
      store.observeHour({...incompleteObservation, observedAt: "2026-09-24T06:16:00.000Z"});
      store.ignoreHour("target-1", hour, "账号范围无法唯一确认");

      const site = {
        amountNano: 30_000_000, complete: true, detailsComplete: true,
        limited: false, candidateCount: 1, processedCount: 1,
        source: "sub2api_usage" as const,
        records: [{
          siteLogId: "site-late", requestId: "req-1", apiKeyId: "7",
          model: "m", endpoint: "/v1/responses",
          completedAt: "2026-09-24T04:10:00.000Z",
          inputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4,
          outputTokens: 5, amountNano: 30_000_000,
        }],
      };
      await reviewDueReconciliationHours({
        store, nowIso: "2026-09-24T07:20:00.000Z",
        fetchSite: async () => site,
        remoteKeyIds: async () => ["7"],
      });
      expect(store.getHour("target-1", hour)).toMatchObject({
        status: "ignored", ignoredReason: "账号范围无法唯一确认",
      });
      expect((db.prepare(
        "SELECT COUNT(*) AS n FROM usage_ledger WHERE request_kind='reconciliation'",
      ).get() as {n: number}).n).toBe(0);
    } finally {
      db.close();
    }
  });

  test("ignored 小时只有站点金额变化时才重新打开复核", async () => {
    const {db, store} = await fixture();
    try {
      store.seedHour("target-1", "account-1", "sub2api", hour);
      const observation = {
        targetId: "target-1", hourStartUtc: hour,
        siteAmountNano: 30_000_000, localAmountNano: 0,
        candidateCount: 1, processedCount: 1, limited: false,
        detailsComplete: true, localComplete: true,
        localCandidateCount: 0, localProcessedCount: 0,
        matchedCount: 0, unmatchedSiteCount: 1,
        source: "sub2api_usage",
      };
      store.observeHour({...observation, observedAt: "2026-09-24T06:10:00.000Z"});
      store.observeHour({...observation, observedAt: "2026-09-24T06:16:00.000Z"});
      store.ignoreHour("target-1", hour, "用户确认暂不处理");

      store.observeHour({...observation, siteEvidenceHash: "changed",
        observedAt: "2026-09-24T07:20:00.000Z"});
      expect(store.getHour("target-1", hour)?.status).toBe("ignored");

      store.observeHour({...observation, siteAmountNano: 31_000_000,
        observedAt: "2026-09-24T07:26:00.000Z"});
      expect(store.getHour("target-1", hour)).toMatchObject({
        status: "pending", stableCount: 1, siteAmountNano: 31_000_000,
      });
    } finally {
      db.close();
    }
  });

  test("已定稿小时站点取数失败时保留原审核状态与金额证据", async () => {
    const {db, store} = await fixture();
    try {
      store.seedHour("target-1", "account-1", "sub2api", hour);
      const observation = {
        targetId: "target-1", hourStartUtc: hour,
        siteAmountNano: 0, localAmountNano: 0,
        candidateCount: 0, processedCount: 0, limited: false,
        detailsComplete: true, localComplete: true,
        localCandidateCount: 0, localProcessedCount: 0,
        matchedCount: 0, unmatchedSiteCount: 0,
        source: "sub2api_usage",
      };
      store.observeHour({...observation, observedAt: "2026-09-24T06:10:00.000Z"});
      store.observeHour({...observation, observedAt: "2026-09-24T06:16:00.000Z"});
      expect(store.getHour("target-1", hour)?.status).toBe("balanced");

      await reviewDueReconciliationHours({
        store, nowIso: "2026-09-24T07:20:00.000Z",
        fetchSite: async () => { throw new Error("站点暂不可用"); },
        remoteKeyIds: async () => [],
      });
      expect(store.getHour("target-1", hour)).toMatchObject({
        status: "balanced", siteAmountNano: 0, localAmountNano: 0,
      });
    } finally {
      db.close();
    }
  });

  test("人工确认事务内发现晚到本地账本时拒绝冻结差额", async () => {
    const {db, store} = await fixture();
    try {
      store.seedHour("target-1", "account-1", "sub2api", hour);
      const base = {
        targetId: "target-1", hourStartUtc: hour,
        siteAmountNano: 20_000_000, localAmountNano: 0,
        candidateCount: 1, processedCount: 1, limited: false,
        detailsComplete: true, localComplete: true,
        localCandidateCount: 0, localProcessedCount: 0,
        matchedCount: 0, unmatchedSiteCount: 1, source: "sub2api_usage",
      };
      store.observeHour({...base, observedAt: "2026-09-24T06:10:00.000Z"});
      store.observeHour({...base, observedAt: "2026-09-24T06:16:00.000Z"});
      seedLocal(db, 1);
      expect(() => applyCurrentManual(store, "target-1", hour)).toThrow("RECONCILIATION_SNAPSHOT_CHANGED");
      expect((db.prepare(
        "SELECT COUNT(*) AS n FROM usage_ledger WHERE request_kind='reconciliation'",
      ).get() as {n: number}).n).toBe(0);
    } finally {
      db.close();
    }
  });

  test("人工确认事务内必须再核对点击时的小时版本，不能补异步变更后的新金额", async () => {
    const {db, store} = await fixture();
    try {
      store.seedHour("target-1", "account-1", "sub2api", hour);
      const base = {
        targetId: "target-1", hourStartUtc: hour,
        siteAmountNano: 30_000_000, localAmountNano: 0,
        candidateCount: 1, processedCount: 1, limited: false,
        detailsComplete: true, localComplete: true,
        localCandidateCount: 0, localProcessedCount: 0,
        matchedCount: 0, unmatchedSiteCount: 1, source: "sub2api_usage",
      };
      store.observeHour({...base, observedAt: "2026-09-24T06:10:00.000Z"});
      store.observeHour({...base, observedAt: "2026-09-24T06:16:00.000Z"});
      const clicked = store.getHour("target-1", hour)!;
      store.observeHour({...base, siteAmountNano: 50_000_000,
        observedAt: "2026-09-24T06:22:00.000Z"});
      store.observeHour({...base, siteAmountNano: 50_000_000,
        observedAt: "2026-09-24T06:28:00.000Z"});
      expect(() => store.applyManual(
        "target-1", hour, clicked.residualNano!, clicked.lastCheckedAt!,
      )).toThrow("RECONCILIATION_SNAPSHOT_CHANGED");
      expect((db.prepare(
        "SELECT COUNT(*) AS n FROM usage_ledger WHERE request_kind='reconciliation'",
      ).get() as {n: number}).n).toBe(0);
    } finally {
      db.close();
    }
  });

  test("小时列表只返回待人工复核的小时，其余状态零出现", async () => {
    const {db, store} = await fixture();
    try {
      for (const start of [
        "2026-09-24T02:00:00.000Z",
        "2026-09-24T03:00:00.000Z",
        "2026-09-24T04:00:00.000Z",
      ]) store.seedHour("target-1", "account-1", "newapi", start);
      const observed = {
        targetId: "target-1", hourStartUtc: "2026-09-24T04:00:00.000Z",
        siteAmountNano: 10_000_000, localAmountNano: 0,
        candidateCount: 1, processedCount: 1, limited: false,
        detailsComplete: true, localComplete: true,
        localCandidateCount: 0, localProcessedCount: 0,
        matchedCount: 0, unmatchedSiteCount: 1,
        source: "newapi_stat", siteEvidenceHash: "stable",
      };
      store.observeHour({...observed, observedAt: "2026-09-24T06:10:00.000Z"});
      store.observeHour({...observed, observedAt: "2026-09-24T06:16:00.000Z"});
      // 02/03 仍为 pending：静默化后不出现在列表。
      const listed = store.listHours({targetId: "target-1", limit: 10});
      expect(listed).toMatchObject({candidateCount: 1, processedCount: 1, limited: false});
      expect(listed.items.map(item => item.hourStartUtc))
        .toEqual(["2026-09-24T04:00:00.000Z"]);
      expect(listed.items[0]?.status).toBe("needs_review");
      expect(listed.emptyHiddenCount).toBeUndefined();
      const oversizedCursor = Buffer.from(JSON.stringify({
        hour: "2026-09-24T04:00:00.000Z", target: "target-1",
      }) + " ".repeat(1000)).toString("base64url");
      expect(() => store.listHours({targetId: "target-1", cursor: oversizedCursor}))
        .toThrow("RECONCILIATION_CURSOR_INVALID");
    } finally {
      db.close();
    }
  });

  test("跨整点的同一请求按站点结算小时重归属，不产生虚构的金额补差", async () => {
    const {db, store} = await fixture();
    try {
      seedLocal(db, 1, "provider_usage", "2026-09-24T05:00:07.000Z");
      const first = store.loadLocalHour("target-1", hour);
      const nextHour = "2026-09-24T05:00:00.000Z";
      expect(first.amountNano).toBe(0);
      expect(store.loadLocalHour("target-1", nextHour).amountNano).toBe(20_000_000);
      const match: UsageMatch = {
        site: {
          siteLogId: "site-boundary", model: "m",
          completedAt: "2026-09-24T04:59:49.000Z",
          inputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4,
          outputTokens: 5, amountNano: 20_000_000,
        },
        local: first.records[0]!, confidence: "high", deltaNano: 0,
      };
      store.seedHour("target-1", "account-1", "sub2api", hour);
      store.seedHour("target-1", "account-1", "sub2api", nextHour);
      const nextObservation = {
        targetId: "target-1", hourStartUtc: nextHour,
        siteAmountNano: 0, localAmountNano: 20_000_000,
        candidateCount: 0, processedCount: 0, limited: false,
        detailsComplete: true, localComplete: true, localCandidateCount: 1,
        localProcessedCount: 1, matchedCount: 0, unmatchedSiteCount: 0,
        source: "sub2api_usage",
      };
      store.observeHour({...nextObservation, observedAt: "2026-09-24T07:10:00.000Z"});
      store.observeHour({...nextObservation, observedAt: "2026-09-24T07:16:00.000Z"});
      const observation = {
        targetId: "target-1", hourStartUtc: hour,
        siteAmountNano: 20_000_000, localAmountNano: 20_000_000,
        candidateCount: 1, processedCount: 1, limited: false,
        detailsComplete: true, localComplete: true, localCandidateCount: 1,
        localProcessedCount: 1, matchedCount: 1, unmatchedSiteCount: 0,
        source: "sub2api_usage",
      };
      store.observeHour({...observation, observedAt: "2026-09-24T06:10:00.000Z"});
      store.observeHour({...observation, observedAt: "2026-09-24T06:16:00.000Z"});
      store.applyMatches("target-1", hour, [match]);
      expect(store.getHour("target-1", hour)?.status).toBe("balanced");
      expect(store.getHour("target-1", nextHour)?.status).toBe("pending");
      expect(store.comparableLocalHour("target-1", hour, first, [match])).toBe(20_000_000);
      expect(store.comparableLocalHour("target-1", nextHour,
        store.loadLocalHour("target-1", nextHour), [])).toBe(0);
      expect((db.prepare(
        "SELECT COUNT(*) AS n FROM usage_ledger WHERE request_kind='reconciliation'",
      ).get() as {n: number}).n).toBe(0);
    } finally {
      db.close();
    }
  });

  test("用量载体：原行无可信用量的 matched 补差回填站点 token 并复制原行价格快照（2026-09-29）", async () => {
    const {db, store} = await fixture();
    try {
      seedLocal(db, 1);
      // 原行 = 502 失败 + 估算 token + 本地金额 0：站点明细是唯一真值来源。
      db.prepare(
        `UPDATE usage_ledger SET
           usage_source='tokenizer_estimated', result_class='upstream_error',
           actual_cost=0, vendor_cost=0, input_tokens=1000,
           pricing_snapshot_json=?,
           rate_multiplier=0.15
         WHERE exchange_id='local-0'`,
      ).run(JSON.stringify({
        unit: "per_million_tokens", currency: "USD",
        baseRates: {input: 10, output: 50, cachedInput: 1, cacheWrite: 12.5},
        rateMultiplier: 0.15,
      }));
      store.seedHour("target-1", "account-1", "sub2api", hour);
      const observation = {
        targetId: "target-1", hourStartUtc: hour,
        siteAmountNano: 30_000_000, localAmountNano: 0,
        candidateCount: 1, processedCount: 1, limited: false,
        detailsComplete: true, localComplete: true,
        localCandidateCount: 1, localProcessedCount: 1,
        matchedCount: 1, unmatchedSiteCount: 0, source: "sub2api_usage",
      };
      store.observeHour({...observation, observedAt: "2026-09-24T06:10:00.000Z"});
      store.observeHour({...observation, observedAt: "2026-09-24T06:16:00.000Z"});
      const local = store.loadLocalHour("target-1", hour).records[0]!;
      expect(local.actualCostNano).toBe(0);
      const match: UsageMatch = {
        local, confidence: "weak", deltaNano: 30_000_000,
        site: {
          siteLogId: "site-carrier", model: "m",
          completedAt: "2026-09-24T04:10:00.000Z",
          inputTokens: 2000, cacheReadTokens: 300, cacheWriteTokens: 400,
          outputTokens: 500, durationMs: 1234, amountNano: 30_000_000,
        },
      };
      expect(store.applyMatches("target-1", hour, [match])).toBe(1);
      // 匹配事实持久化站点 token 证据与载体标记（聚合端排他/计入的唯一依据）。
      expect(db.prepare(
        `SELECT usage_carrier, site_input_tokens, site_cache_read_tokens,
           site_cache_write_tokens, site_output_tokens, site_duration_ms
         FROM relay_reconciliation_matches WHERE site_log_id='site-carrier'`,
      ).get()).toEqual({
        usage_carrier: 1, site_input_tokens: 2000, site_cache_read_tokens: 300,
        site_cache_write_tokens: 400, site_output_tokens: 500, site_duration_ms: 1234,
      });
      // 载体补差行：站点四类 token/时长/派生总量 + 复制原行倍率与 baseRates。
      const carrier = db.prepare(
        `SELECT input_tokens, cache_read_tokens, cache_write_tokens, output_tokens,
           duration_ms, derived_total_tokens, rate_multiplier, actual_cost_nano,
           json_extract(pricing_snapshot_json, '$.usageCarrier') AS carrier_flag,
           json_extract(pricing_snapshot_json, '$.baseRates.input') AS base_input
         FROM usage_ledger WHERE exchange_id LIKE 'recon:matched:%'`,
      ).get() as Record<string, number>;
      expect(carrier).toEqual({
        input_tokens: 2000, cache_read_tokens: 300, cache_write_tokens: 400,
        output_tokens: 500, duration_ms: 1234, derived_total_tokens: 3200,
        rate_multiplier: 0.15, actual_cost_nano: 30_000_000,
        carrier_flag: 1, base_input: 10,
      });
      // 原行不被改写：金额、估算 token 与 result_class 维持原状。
      expect(db.prepare(
        `SELECT actual_cost, input_tokens, result_class FROM usage_ledger WHERE exchange_id='local-0'`,
      ).get()).toEqual({actual_cost: 0, input_tokens: 1000, result_class: "upstream_error"});
    } finally {
      db.close();
    }
  });

  test("纯金额更正：原行有真实用量的 matched 补差保持零 Token 零载体（2026-09-29）", async () => {
    const {db, store} = await fixture();
    try {
      seedLocal(db, 1);
      store.seedHour("target-1", "account-1", "sub2api", hour);
      const base = {
        targetId: "target-1", hourStartUtc: hour,
        siteAmountNano: 30_000_000, localAmountNano: 20_000_000,
        candidateCount: 1, processedCount: 1, limited: false,
        detailsComplete: true, localComplete: true, localCandidateCount: 1,
        localProcessedCount: 1, matchedCount: 1, unmatchedSiteCount: 0,
        source: "sub2api_usage",
      };
      store.observeHour({...base, observedAt: "2026-09-24T06:10:00.000Z"});
      store.observeHour({...base, observedAt: "2026-09-24T06:16:00.000Z"});
      const local = store.loadLocalHour("target-1", hour).records[0]!;
      store.applyMatches("target-1", hour, [{
        local, confidence: "exact", deltaNano: 10_000_000,
        site: {
          siteLogId: "site-correction", model: "m",
          completedAt: "2026-09-24T04:10:00.000Z",
          inputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4,
          outputTokens: 5, amountNano: 30_000_000,
        },
      }]);
      expect(db.prepare(
        `SELECT usage_carrier, site_input_tokens FROM relay_reconciliation_matches
         WHERE site_log_id='site-correction'`,
      ).get()).toEqual({usage_carrier: 0, site_input_tokens: 2});
      expect(db.prepare(
        `SELECT input_tokens, json_extract(pricing_snapshot_json, '$.usageCarrier') AS flag
         FROM usage_ledger WHERE exchange_id LIKE 'recon:matched:%'`,
      ).get()).toEqual({input_tokens: 0, flag: null});
    } finally {
      db.close();
    }
  });
});
