import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Dir, type Dirent } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import type { RawCapturedExchangeV2 } from "../src/lib/harness/types.js";
import { createExchangeProcessor } from "../src/lib/ingestion/exchange-processor.js";
import {
  ensurePricingConfigRevision,
  loadPricingConfigAt,
} from "../src/lib/ingestion/pricing-revisions.js";
import { createIngestionWorker } from "../src/lib/ingestion/worker.js";
import {
  claimNextDerivationJob,
  markDerivationJobRetry,
  markDerivationJobSucceeded,
  releaseWorkerClaims,
  resetStaleDerivationJobs,
  touchDerivationJobLock,
} from "../src/lib/ingestion/job-repository.js";
import {
  assertWorkerLease,
  isWorkerLeaseLostError,
  WORKER_LEASE_LOST_CODE,
} from "../src/lib/ingestion/worker-lease.js";
import { registerRawRecordAndAdvance } from "../src/lib/ingestion/registrar.js";
import {upsertAgentLocalIdentityLinks} from "../src/lib/agent-local-source/identity-links.js";
import {
  markAgentScanConverged,
  markAgentScanStarted,
  resetAgentScanReadinessForTests,
} from "../src/lib/agent-local-source/scan-readiness.js";
import {
  discoverV2Sources,
  readSourceBatch,
} from "../src/lib/ingestion/raw-source-reader.js";
import { loadExchangeProjectionDetail } from "../src/lib/db/exchange-projection-queries.js";
import { readDerivationOverview } from "../src/lib/db/workbench-queries.js";
import {
  createSqliteFixture,
  type SqliteFixture,
} from "./helpers/sqlite-fixture.js";

const fixtures: SqliteFixture[] = [];
const workers: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(workers.splice(0).map(worker => worker.close()));
  await Promise.all(fixtures.splice(0).map(fixture => fixture.cleanup()));
  resetAgentScanReadinessForTests();
});

describe("SQLite ingestion Worker", () => {
  test("空批完整发现来源并确认游标到尾后写对账扫描水位", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    const worker = trackedWorker(fixture, "worker-reconciliation-watermark");
    const before = new Date().toISOString();
    assert.equal(worker.acquireLease(), true);
    await worker.runOneBatch();
    const row = fixture.db.prepare(
      "SELECT last_source_scan_completed_at AS scanAt FROM schema_meta WHERE id=1",
    ).get() as {scanAt: string | null};
    assert.ok(row.scanAt && row.scanAt >= before);
  });

  test("Worker 新租约接管时撤销旧扫描水位，防止接管与首轮扫描之间误结算", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    fixture.db.prepare(
      "UPDATE schema_meta SET last_source_scan_completed_at='2026-09-24T07:00:00.000Z'",
    ).run();
    const worker = trackedWorker(fixture, "worker-new-reconciliation-lease");
    assert.equal(worker.acquireLease(), true);
    assert.equal(fixture.db.prepare(
      "SELECT last_source_scan_completed_at FROM schema_meta WHERE id=1",
    ).pluck().get(), null);
  });

  test("持续未消费尾部不清空既有水位；租约换主仍按观察者纪元重置（2026-09-29 单调化）", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    const file = await fixture.writeV2Lines([record("ex-watermark-monotonic", 1)]);
    const worker = trackedWorker(fixture, "worker-watermark-monotonic");
    assert.equal(worker.acquireLease(), true);
    await worker.runOneBatch();
    const first = fixture.db.prepare(
      "SELECT last_source_scan_completed_at AS scanAt FROM schema_meta WHERE id=1",
    ).get() as {scanAt: string | null};
    assert.ok(first.scanAt, "完整轮结束应提交水位");
    // 模拟活跃流量：文件追加未终结的半行（扫描不可确认 → source 恒 pending，
    // 该轮不满足提交条件）。单调语义下既有水位必须保留，不得被批次清空——
    // 旧"批次开头清空"正是对账两轮稳定在持续流量下退化为运气采样的根因。
    await writeFile(file, '{"partial":"unterminated', {flag: "a"});
    await worker.runOneBatch();
    const second = fixture.db.prepare(
      "SELECT last_source_scan_completed_at AS scanAt FROM schema_meta WHERE id=1",
    ).get() as {scanAt: string | null};
    assert.ok(second.scanAt, "存在 pending 源的批次不得清空既有水位");
    assert.ok(second.scanAt! >= first.scanAt!, "水位只能单调前进");
    // 观察者纪元重置：租约过期后被新 owner 抢占，水位归零、须重挣信任。
    fixture.db.prepare("UPDATE worker_lease SET expires_at=? WHERE id=1")
      .run(new Date(Date.now() - 1_000).toISOString());
    const next = trackedWorker(fixture, "worker-watermark-next-owner");
    assert.equal(next.acquireLease(), true);
    assert.equal(fixture.db.prepare(
      "SELECT last_source_scan_completed_at FROM schema_meta WHERE id=1",
    ).pluck().get(), null);
  });

  test("派生状态聚合区分登记、任务、完整性、预览和积压时间", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    seedDerivationOverview(fixture);

    const overview = readDerivationOverview(
      fixture.db,
      "2026-07-22T00:10:00.000Z",
    );

    assert.equal(overview.registeredCount, 6);
    assert.deepEqual(overview.jobCounts, {
      pending: 1,
      running: 1,
      retryWait: 1,
      succeeded: 2,
      permanentError: 1,
    });
    assert.deepEqual(overview.completenessCounts, {
      complete: 1,
      limited: 1,
      unavailable: 1,
    });
    assert.deepEqual(overview.previewCounts, {
      complete: 1,
      limited: 1,
      unavailable: 1,
      notMaterialized: 1,
    });
    assert.equal(overview.oldestPendingAt, "2026-07-22T00:00:00.000Z");
    assert.equal(overview.backlogAgeMs, 10 * 60 * 1_000);
    assert.equal(overview.lastRegisteredAt, "2026-07-22T00:05:00.000Z");
    assert.equal(overview.lastDerivedAt, "2026-07-22T00:04:00.000Z");
    assert.deepEqual(overview.recentError, {
      code: "raw_body_integrity_failed",
      message: "正文哈希不一致",
      occurredAt: "2026-07-22T00:05:00.000Z",
    });
  });

  test("Raw 登记、任务创建和 source 游标同事务提交并支持任务 CAS", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    fixture.db.prepare(
      `INSERT INTO console_accounts(
        id,target_id,provider_type,console_base_url,username,password_ref,created_at,updated_at
      ) VALUES('account-recon','target-worker','sub2api','https://relay.example',
        'u','ref','2026-09-24T00:00:00Z','2026-09-24T00:00:00Z')`,
    ).run();
    const exchange = record("ex-registrar-atomic", 1);
    const filePath = await fixture.writeV2Lines([exchange], "registrar.jsonl");
    await discoverV2Sources(fixture.db, fixture.dataDir);
    const batch = await readSourceBatch(fixture.db, filePath, {
      maxRecords: 1,
      maxBytes: 16 * 1024 * 1024,
      maxLineBytes: 8 * 1024 * 1024,
    });
    const sourceRecord = batch.records[0]!;
    const now = "2026-07-22T00:00:00.000Z";
    fixture.db.prepare(
      `INSERT INTO worker_lease(id, owner_id, expires_at)
       VALUES(1, 'registrar-owner', '2999-01-01T00:00:00.000Z')`,
    ).run();
    fixture.db.exec(`
      CREATE TRIGGER fail_registrar_job
      BEFORE INSERT ON derivation_jobs
      BEGIN SELECT RAISE(ABORT, 'injected registrar failure'); END;
    `);

    assert.throws(() => registerRawRecordAndAdvance(fixture.db, {
      sourceId: batch.sourceId,
      sourceRelativePath: batch.relativePath,
      sourceFileId: batch.fileId,
      sourceGeneration: batch.sourceGeneration,
      record: sourceRecord,
      cursor: {
        sourceId: batch.sourceId,
        relativePath: batch.relativePath,
        fileId: batch.fileId,
        generation: batch.sourceGeneration,
        expectedFileSize: batch.sourceFileSize,
        nextFileSize: batch.fileSize,
        expectedByteOffset: batch.startOffset,
        expectedScanOffset: batch.startScanOffset,
        nextByteOffset: batch.endOffset,
        nextScanOffset: batch.endOffset,
        processedCount: 1,
      },
      leaseOwnerId: "registrar-owner",
      projectionVersion: 1,
      now,
    }), /injected registrar failure/);
    assert.equal(
      fixture.db.prepare("SELECT COUNT(*) FROM ingestion_records").pluck().get(),
      0,
    );
    assert.deepEqual(sourceCursor(fixture), { byte_offset: 0, scan_offset: 0 });

    fixture.db.exec("DROP TRIGGER fail_registrar_job");
    const registered = registerRawRecordAndAdvance(fixture.db, {
      sourceId: batch.sourceId,
      sourceRelativePath: batch.relativePath,
      sourceFileId: batch.fileId,
      sourceGeneration: batch.sourceGeneration,
      record: sourceRecord,
      cursor: {
        sourceId: batch.sourceId,
        relativePath: batch.relativePath,
        fileId: batch.fileId,
        generation: batch.sourceGeneration,
        expectedFileSize: batch.sourceFileSize,
        nextFileSize: batch.fileSize,
        expectedByteOffset: batch.startOffset,
        expectedScanOffset: batch.startScanOffset,
        nextByteOffset: batch.endOffset,
        nextScanOffset: batch.endOffset,
        processedCount: 1,
      },
      leaseOwnerId: "registrar-owner",
      projectionVersion: 1,
      now,
    });

    assert.equal(registered.taskCreated, true);
    assert.deepEqual(fixture.db.prepare(
      "SELECT target_id,completed_at FROM relay_pending_ingestions WHERE exchange_id=?",
    ).get(exchange.exchangeId), {
      target_id: "target-worker", completed_at: exchange.completedAt,
    });
    assert.equal(
      fixture.db.prepare("SELECT COUNT(*) FROM ingestion_records").pluck().get(),
      1,
    );
    assert.deepEqual(sourceCursor(fixture), {
      byte_offset: batch.endOffset,
      scan_offset: batch.endOffset,
    });
    assert.equal(
      fixture.db.prepare("SELECT job_status FROM derivation_jobs").pluck().get(),
      "pending",
    );

    const claimed = claimNextDerivationJob(fixture.db, {
      ownerId: "registrar-owner",
      now,
    });
    assert.equal(claimed?.ingestionRecordId, registered.ingestionRecordId);
    assert.equal(claimed?.attemptCount, 1);
    const retry = markDerivationJobRetry(fixture.db, claimed!, {
      errorCode: "raw_body_unavailable",
      errorMessage: "temporary read failure",
      now,
    });
    assert.equal(retry.status, "retry_wait");
    assert.equal(retry.availableAt, "2026-07-22T00:00:01.000Z");

    const retryClaim = claimNextDerivationJob(fixture.db, {
      ownerId: "registrar-owner",
      now: retry.availableAt,
    });
    assert.equal(retryClaim?.attemptCount, 2);
    markDerivationJobSucceeded(fixture.db, retryClaim!, {
      completeness: "limited",
      limitedDimensions: ["request_text"],
      requestVerification: "verified",
      responseVerification: "verified",
      now: "2026-07-22T00:00:02.000Z",
    });
    assert.deepEqual(
      fixture.db.prepare(
        `SELECT job_status, projection_completeness, attempt_count,
          limited_dimensions_json
         FROM derivation_jobs`,
      ).get(),
      {
        job_status: "succeeded",
        projection_completeness: "limited",
        attempt_count: 2,
        limited_dimensions_json: '["request_text"]',
      },
    );
  });

  test("Worker 先登记并推进 source，再从持久任务生成业务投影", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    fixture.db.prepare(
      `INSERT INTO console_accounts(
        id,target_id,provider_type,console_base_url,username,password_ref,created_at,updated_at
      ) VALUES('account-recon','target-worker','sub2api','https://relay.example',
        'u','ref','2026-09-24T00:00:00Z','2026-09-24T00:00:00Z')`,
    ).run();
    await fixture.writeV2Lines([record("ex-worker-registered", 1)]);
    const worker = trackedWorker(fixture, "worker-registered");

    assert.equal(worker.acquireLease(), true);
    const result = await worker.runOneBatch();

    assert.equal(result.processedCount, 1);
    assert.equal(fixture.db.prepare(
      "SELECT COUNT(*) FROM relay_pending_ingestions WHERE exchange_id='ex-worker-registered'",
    ).pluck().get(), 0);
    assert.deepEqual(
      fixture.db.prepare(
        `SELECT r.exchange_id, j.job_status, j.projection_completeness,
          j.projection_version, p.projection_version AS preview_projection_version,
          s.byte_offset = s.scan_offset AS cursor_complete
         FROM ingestion_records r
         JOIN derivation_jobs j ON j.ingestion_record_id = r.id
         JOIN exchange_content_previews p ON p.exchange_id = r.exchange_id
         JOIN ingestion_sources s ON s.id = r.source_id`,
      ).get(),
      {
        exchange_id: "ex-worker-registered",
        job_status: "succeeded",
        projection_completeness: "complete",
        projection_version: 7,
        preview_projection_version: 7,
        cursor_complete: 1,
      },
    );
    assert.equal(
      fixture.db.prepare(
        "SELECT COUNT(*) FROM raw_exchange_refs WHERE exchange_id = ?",
      ).pluck().get("ex-worker-registered"),
      1,
    );
  });

  test("Worker 持久化完整 SSE 生命周期、首页候选和最终 Step 状态", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    const exchange = streamingLifecycleRecord(
      "ex-worker-stream-lifecycle",
      1,
    );
    await fixture.writeV2Lines([exchange], "stream-lifecycle.jsonl");
    const worker = trackedWorker(fixture, "worker-stream-lifecycle");

    assert.equal(worker.acquireLease(), true);
    const result = await worker.runOneBatch();
    assert.equal(result.processedCount, 1);

    const detail = loadExchangeProjectionDetail(
      fixture.db,
      exchange.exchangeId,
    );
    assert.ok(detail);
    assert.equal(detail.projectionVersion, 7);
    assert.deepEqual(detail.preview.streamLifecycle, {
      eventCount: 258,
      lastEventType: "response.completed",
      terminalEventSeen: true,
      terminalEventType: "response.completed",
      providerStatus: "completed",
      doneMarkerSeen: false,
      parseErrorCount: 0,
      sampleLimited: true,
    });
    assert.ok(detail.preview.overviewCandidates.some(candidate =>
      candidate.conversationCategory === "user_real"
      && candidate.textPreview === "请给出最终回答"));
    assert.ok(detail.preview.overviewCandidates.some(candidate =>
      candidate.conversationCategory === "assistant"
      && candidate.textPreview === "真实模型回答"));
    const step = fixture.db.prepare(
      `SELECT phase, request_action, response_action
       FROM agent_steps WHERE exchange_id = ?`,
    ).get(exchange.exchangeId);
    assert.deepEqual(step, {
      phase: "final_answer",
      request_action: "user_prompt",
      response_action: "final",
    });
    const previewJson = fixture.db.prepare(
      "SELECT preview_json FROM exchange_content_previews WHERE exchange_id = ?",
    ).pluck().get(exchange.exchangeId) as string;
    assert.equal(previewJson.includes("You are Codex, a coding agent"), false);
  });

  test("任务终态提交失败时业务事实、预览和媒体必须整体回滚", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    await fixture.writeV2Lines([record("ex-worker-atomic-job", 1)]);
    fixture.db.exec(`
      CREATE TRIGGER fail_job_success_commit
      BEFORE UPDATE OF job_status ON derivation_jobs
      WHEN NEW.job_status = 'succeeded'
      BEGIN SELECT RAISE(ABORT, 'injected job success failure'); END;
    `);
    const worker = trackedWorker(fixture, "worker-atomic-job");

    assert.equal(worker.acquireLease(), true);
    const result = await worker.runOneBatch();

    assert.equal(result.processedCount, 0);
    assert.equal(
      fixture.db.prepare("SELECT COUNT(*) FROM raw_exchange_refs").pluck().get(),
      0,
    );
    assert.equal(
      fixture.db.prepare("SELECT COUNT(*) FROM exchange_content_previews").pluck().get(),
      0,
    );
    assert.equal(
      fixture.db.prepare("SELECT job_status FROM derivation_jobs").pluck().get(),
      "retry_wait",
    );
  });

  test("正文完整性错误直接永久失败且同 source 后续任务继续", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    const broken = record("ex-worker-integrity-broken", 1);
    const requestBody = broken.request.rawBody!;
    broken.request.bodySha256 = "0".repeat(64);
    broken.request.rawBodyRef = {
      storage: "inline",
      encoding: "identity",
      sizeBytes: Buffer.byteLength(requestBody),
      sha256: "0".repeat(64),
    };
    await fixture.writeV2Lines([
      broken,
      record("ex-worker-after-integrity", 2),
    ], "integrity-then-valid.jsonl");
    const worker = trackedWorker(fixture, "worker-integrity");

    assert.equal(worker.acquireLease(), true);
    const result = await worker.runOneBatch();

    assert.equal(result.processedCount, 1);
    assert.deepEqual(
      fixture.db.prepare(
        `SELECT r.exchange_id, j.job_status, j.projection_completeness,
           j.limited_dimensions_json
         FROM ingestion_records r
         JOIN derivation_jobs j ON j.ingestion_record_id = r.id
         ORDER BY r.byte_offset`,
      ).all(),
      [
        {
          exchange_id: "ex-worker-integrity-broken",
          job_status: "permanent_error",
          projection_completeness: "unavailable",
          limited_dimensions_json: "[]",
        },
        {
          exchange_id: "ex-worker-after-integrity",
          job_status: "succeeded",
          projection_completeness: "limited",
          limited_dimensions_json: '["dependency_gap"]',
        },
      ],
    );
    assert.deepEqual(
      fixture.db.prepare("SELECT exchange_id FROM raw_exchange_refs").pluck().all(),
      ["ex-worker-after-integrity"],
    );
  });

  test("运行锁超时的僵尸任务被重置，同 source 后续任务继续派生", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    await fixture.writeV2Lines([
      record("ex-stale-lock-a", 1),
      record("ex-stale-lock-b", 2),
      record("ex-stale-lock-c", 3),
    ], "stale-lock.jsonl");
    // 让 ex-a 首次派生失败（从未成功过），其 retry_wait 会阻塞同 source 后续任务。
    fixture.db.exec(`
      CREATE TRIGGER fail_stale_lock_a
      BEFORE INSERT ON raw_exchange_refs
      WHEN NEW.exchange_id = 'ex-stale-lock-a'
      BEGIN
        SELECT RAISE(ABORT, 'injected stale lock failure');
      END;
    `);
    const worker = createIngestionWorker({
      dataDir: fixture.dataDir,
      ownerId: "worker-stale",
      diskReserveBytes: 0,
      // 测试加速：锁超时阈值与重置延迟都设为 0，避免等待真实时间。
      staleJobLockMs: 0,
      staleJobResetDelayMs: 0,
      jobTransitionLogger: () => undefined,
    });
    workers.push(worker);

    assert.equal(worker.acquireLease(), true);
    let result = await worker.runOneBatch();
    assert.equal(result.processedCount, 0);
    fixture.db.exec("DROP TRIGGER fail_stale_lock_a");

    // 模拟 worker 卡死残留：把 ex-a 的 retry_wait 任务置为 running + 很久以前的
    // locked_at（领取后处理挂起、心跳停止）；其存在会阻塞同 source 后续任务。
    fixture.db.prepare(
      `UPDATE derivation_jobs
       SET job_status = 'running', locked_by = 'ghost-worker',
         locked_at = '2026-07-22T00:10:00.000Z', updated_at = '2026-07-22T00:10:00.000Z',
         projection_completeness = NULL, completed_at = NULL
       WHERE ingestion_record_id = (
         SELECT id FROM ingestion_records WHERE exchange_id = 'ex-stale-lock-a'
       )`,
    ).run();

    result = await worker.runOneBatch();
    assert.equal(result.processedCount, 3);

    assert.deepEqual(
      fixture.db.prepare(
        `SELECT r.exchange_id, j.job_status
         FROM ingestion_records r
         JOIN derivation_jobs j ON j.ingestion_record_id = r.id
         ORDER BY r.byte_offset`,
      ).all(),
      [
        { exchange_id: "ex-stale-lock-a", job_status: "succeeded" },
        { exchange_id: "ex-stale-lock-b", job_status: "succeeded" },
        { exchange_id: "ex-stale-lock-c", job_status: "succeeded" },
      ],
    );
    assert.deepEqual(
      fixture.db.prepare("SELECT exchange_id FROM raw_exchange_refs ORDER BY byte_offset")
        .pluck().all(),
      ["ex-stale-lock-a", "ex-stale-lock-b", "ex-stale-lock-c"],
    );
  });

  test("租约丢失时失败回写仍必须落库，且不得阻塞同 source 后续任务", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    await fixture.writeV2Lines([
      record("ex-lease-lost-a", 1),
      record("ex-lease-lost-b", 2),
    ], "lease-lost.jsonl");
    const worker = trackedWorker(fixture, "worker-lease-lost");
    assert.equal(worker.acquireLease(), true);
    await worker.runOneBatch();

    // 置回 pending 供精确领取（正式流程由登记阶段创建）。
    fixture.db.prepare(
      `UPDATE derivation_jobs
       SET job_status = 'pending', locked_by = NULL, locked_at = NULL,
         attempt_count = 0, available_at = '2026-07-22T00:00:00.000Z',
         projection_completeness = NULL, completed_at = NULL`,
    ).run();

    const claim = claimNextDerivationJob(fixture.db, {
      ownerId: "worker-lease-lost",
      now: "2026-07-22T00:10:00.000Z",
    });
    assert.ok(claim);
    // 模拟"主线程被长任务占满 → 续租停摆"：租约已过期，但任务仍由本 worker 持有。
    fixture.db.prepare("DELETE FROM worker_lease").run();
    assert.equal(isWorkerLeaseLostError(captureLeaseError(fixture, "worker-lease-lost")), true);

    // 失败回写绝不能因为租约丢失而抛错：否则任务永久停在 running（僵尸锁），
    // 并按 claim 的"同 source 前序未完成"约束锁死整个文件后续记录。
    const transition = markDerivationJobRetry(fixture.db, claim, {
      errorCode: WORKER_LEASE_LOST_CODE,
      errorMessage: "Worker worker-lease-lost 未持有有效租约。",
      now: "2026-07-22T00:10:01.000Z",
    });
    assert.equal(transition.status, "retry_wait");
    assert.deepEqual(
      fixture.db.prepare(
        `SELECT j.job_status, j.locked_by, j.locked_at, j.last_error_code
         FROM derivation_jobs j
         JOIN ingestion_records r ON r.id = j.ingestion_record_id
         WHERE r.exchange_id = 'ex-lease-lost-a'`,
      ).get(),
      {
        job_status: "retry_wait",
        locked_by: null,
        locked_at: null,
        last_error_code: WORKER_LEASE_LOST_CODE,
      },
    );

    // 前序已回到可重试状态：重新持租后必须能继续派生同 source 的后续记录。
    assert.equal(worker.acquireLease(), true);
    const next = claimNextDerivationJob(fixture.db, {
      ownerId: "worker-lease-lost",
      now: "2026-07-22T00:10:02.000Z",
    });
    assert.equal(next?.exchangeId, "ex-lease-lost-a");
  });

  test("releaseWorkerClaims 交还本 worker 未完成任务，不碰他人锁，并尊重尝试次数上限", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    await fixture.writeV2Lines([
      record("ex-release-a", 1),
      record("ex-release-b", 2),
      record("ex-release-c", 3),
    ], "release-claims.jsonl");
    const worker = trackedWorker(fixture, "worker-release");
    assert.equal(worker.acquireLease(), true);
    await worker.runOneBatch();
    fixture.db.prepare(
      `UPDATE derivation_jobs
       SET job_status = 'pending', locked_by = NULL, locked_at = NULL,
         attempt_count = 0, available_at = '2026-07-22T00:00:00.000Z',
         projection_completeness = NULL, completed_at = NULL`,
    ).run();

    const byExchange = (exchangeId: string): number =>
      fixture.db.prepare(
        `SELECT j.ingestion_record_id FROM derivation_jobs j
         JOIN ingestion_records r ON r.id = j.ingestion_record_id
         WHERE r.exchange_id = ?`,
      ).pluck().get(exchangeId) as number;
    const setRunning = (recordId: number, owner: string, attempts: number): void => {
      fixture.db.prepare(
        `UPDATE derivation_jobs
         SET job_status = 'running', locked_by = ?, locked_at = '2026-07-22T00:10:00.000Z',
           attempt_count = ?, projection_completeness = NULL, completed_at = NULL
         WHERE ingestion_record_id = ?`,
      ).run(owner, attempts, recordId);
    };

    // a：本 worker 未完成任务（未到上限）→ 交还队列可重试。
    setRunning(byExchange("ex-release-a"), "worker-release", 1);
    // b：本 worker 已耗尽尝试次数 → 直接判永久失败（必须满足表的 CHECK 约束）。
    setRunning(byExchange("ex-release-b"), "worker-release", 6);
    // c：别的 worker 的任务 → 一律不碰。
    setRunning(byExchange("ex-release-c"), "other-worker", 1);

    const released = releaseWorkerClaims(fixture.db, "worker-release", {
      errorCode: WORKER_LEASE_LOST_CODE,
      errorMessage: "批次崩溃兜底",
      now: "2026-07-22T00:10:05.000Z",
    });
    assert.equal(released, 2);

    assert.deepEqual(
      fixture.db.prepare(
        `SELECT r.exchange_id, j.job_status, j.locked_by, j.locked_at,
           j.last_error_code, j.projection_completeness,
           (j.completed_at IS NOT NULL) AS completed
         FROM derivation_jobs j
         JOIN ingestion_records r ON r.id = j.ingestion_record_id
         ORDER BY r.byte_offset`,
      ).all(),
      [
        {
          exchange_id: "ex-release-a",
          job_status: "retry_wait",
          locked_by: null,
          locked_at: null,
          last_error_code: WORKER_LEASE_LOST_CODE,
          projection_completeness: null,
          completed: 0,
        },
        {
          exchange_id: "ex-release-b",
          job_status: "permanent_error",
          locked_by: null,
          locked_at: null,
          last_error_code: WORKER_LEASE_LOST_CODE,
          projection_completeness: "unavailable",
          completed: 1,
        },
        {
          exchange_id: "ex-release-c",
          job_status: "running",
          locked_by: "other-worker",
          locked_at: "2026-07-22T00:10:00.000Z",
          last_error_code: null,
          projection_completeness: null,
          completed: 0,
        },
      ],
    );

    // 交还后同 source 的后续记录必须立刻可领取（不再等 5 分钟僵尸锁超时）。
    const claim = claimNextDerivationJob(fixture.db, {
      ownerId: "worker-release",
      now: "2026-07-22T00:10:06.000Z",
    });
    assert.equal(claim?.exchangeId, "ex-release-a");
  });

  test("resetStaleDerivationJobs 重置僵尸锁并延迟重试，touch 心跳刷新锁定时间", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    await fixture.writeV2Lines([record("ex-stale-unit", 1)], "stale-unit.jsonl");
    const worker = trackedWorker(fixture, "worker-stale-unit");
    assert.equal(worker.acquireLease(), true);
    await worker.runOneBatch();

    // 置回 pending 供单测领取；正式流程中该状态由登记阶段创建。
    fixture.db.prepare(
      `UPDATE derivation_jobs
       SET job_status = 'pending', locked_by = NULL, locked_at = NULL,
         attempt_count = 0, available_at = '2026-07-22T00:00:00.000Z',
         projection_completeness = NULL, completed_at = NULL`,
    ).run();
    const claim = claimNextDerivationJob(fixture.db, {
      ownerId: "worker-stale-unit",
      now: "2026-07-22T00:10:00.000Z",
    });
    assert.ok(claim);

    // 心跳：处理中刷新 locked_at。
    touchDerivationJobLock(fixture.db, claim, "2026-07-22T00:10:30.000Z");
    assert.equal(
      fixture.db.prepare("SELECT locked_at FROM derivation_jobs").pluck().get(),
      "2026-07-22T00:10:30.000Z",
    );

    // 僵尸锁清理：locked_at 早于阈值的 running 任务重置为 retry_wait 并清锁，
    // available_at 按延迟后移，避免立即重试抖动。
    const staleBefore = "2026-07-22T00:20:00.000Z";
    const resetCount = resetStaleDerivationJobs(fixture.db, {
      staleLockBefore: staleBefore,
      now: "2026-07-22T00:20:00.000Z",
      retryDelayMs: 5_000,
    });
    assert.equal(resetCount, 1);
    assert.deepEqual(
      fixture.db.prepare(
        `SELECT job_status, locked_by, locked_at, available_at, last_error_code
         FROM derivation_jobs`,
      ).get(),
      {
        job_status: "retry_wait",
        locked_by: null,
        locked_at: null,
        available_at: "2026-07-22T00:20:05.000Z",
        last_error_code: "stale_job_lock",
      },
    );

    // 未超时的 running 任务不受影响。
    fixture.db.prepare(
      `UPDATE derivation_jobs
       SET job_status = 'running', locked_by = 'active-worker',
         locked_at = '2026-07-22T00:25:00.000Z',
         projection_completeness = NULL, completed_at = NULL`,
    ).run();
    const untouched = resetStaleDerivationJobs(fixture.db, {
      staleLockBefore: "2026-07-22T00:24:00.000Z",
      now: "2026-07-22T00:25:00.000Z",
      retryDelayMs: 5_000,
    });
    assert.equal(untouched, 0);
    assert.equal(
      fixture.db.prepare("SELECT job_status FROM derivation_jobs").pluck().get(),
      "running",
    );
  });

  test("价格目录只更新来源时间时不创建无意义版本", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    const base = {
      version: 2 as const,
      currency: "USD",
      unit: "per_million_tokens",
      sourceCheckedAt: "2026-07-18T08:00:00.000Z",
      catalogSource: {
        type: "litellm" as const,
        fetchedAt: "2026-07-18T08:00:00.000Z",
      },
      models: [{
        id: "metadata-only-model",
        vendor: "openai",
        patterns: ["metadata-only-model"],
        pricing: { input: 1, output: 2 },
        confidence: "third_party" as const,
        sourceCheckedAt: "2026-07-18T08:00:00.000Z",
      }],
    };

    assert.equal(ensurePricingConfigRevision(fixture.db, base).created, true);
    assert.equal(ensurePricingConfigRevision(fixture.db, {
      ...base,
      sourceCheckedAt: "2026-07-18T09:00:00.000Z",
      catalogSource: {
        ...base.catalogSource,
        fetchedAt: "2026-07-18T09:00:00.000Z",
      },
      models: base.models.map(model => ({
        ...model,
        sourceCheckedAt: "2026-07-18T09:00:00.000Z",
      })),
    }).created, false);
    assert.equal(
      fixture.db.prepare("SELECT COUNT(*) FROM pricing_config_revisions")
        .pluck().get(),
      1,
    );
  });

  test("价格配置按请求捕获时间版本化，延迟处理的旧请求不使用新配置", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    await writePricingFixture(fixture.dataDir, false);
    const beforeChange = new Date(Date.now() - 1_000).toISOString();
    const afterChange = new Date(Date.now() + 1_000).toISOString();
    const capturePath = await fixture.writeV2Lines([
      recordAt("ex-worker-pricing-old", 1, beforeChange),
    ]);
    const worker = trackedWorker(fixture, "worker-pricing");

    assert.equal(worker.acquireLease(), true);
    await worker.refreshPricingConfig();

    await writePricingFixture(fixture.dataDir, true);
    await fixture.appendRaw(capturePath, `${JSON.stringify(recordAt("ex-worker-pricing-new", 2, afterChange))}\n`);

    await worker.runOneBatch();
    assert.equal(
      fixture.db.prepare("SELECT vendor FROM usage_ledger WHERE exchange_id = ?")
        .pluck().get("ex-worker-pricing-old"),
      "unknown",
    );

    await worker.runOneBatch();
    assert.equal(
      fixture.db.prepare("SELECT vendor FROM usage_ledger WHERE exchange_id = ?")
        .pluck().get("ex-worker-pricing-new"),
      "openai",
    );
    assert.equal(
      fixture.db.prepare("SELECT rate_multiplier FROM usage_ledger WHERE exchange_id = ?")
        .pluck().get("ex-worker-pricing-old"),
      1,
    );
    // 2026-09-01 目标级倍率概念移除：无密钥倍率时恒为 1
    assert.equal(
      fixture.db.prepare("SELECT rate_multiplier FROM usage_ledger WHERE exchange_id = ?")
        .pluck().get("ex-worker-pricing-new"),
      1,
    );
    assert.equal(dataVersion(fixture), 2);
    assert.equal(
      fixture.db.prepare("SELECT vendor FROM usage_ledger WHERE exchange_id = ?")
        .pluck().get("ex-worker-pricing-old"),
      "unknown",
    );
    assert.equal(
      fixture.db.prepare("SELECT COUNT(*) FROM pricing_config_revisions")
        .pluck().get(),
      2,
    );

    await worker.close();
    const restarted = trackedWorker(fixture, "worker-pricing-restarted");
    await fixture.appendRaw(capturePath, `${JSON.stringify(recordAt("ex-worker-pricing-delayed", 3, beforeChange))}\n`);
    assert.equal(restarted.acquireLease(), true);
    await restarted.runOneBatch();
    assert.deepEqual(
      fixture.db.prepare("SELECT vendor, rate_multiplier FROM usage_ledger WHERE exchange_id = ?")
        .get("ex-worker-pricing-delayed"),
      { vendor: "unknown", rate_multiplier: 1 },
    );
  });

  test("价格版本快照保留目标模型供应商映射，映射变化生成新版本", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    const base = {
      version: 2 as const,
      currency: "USD",
      unit: "per_million_tokens" as const,
      models: [{
        id: "gpt-5.6-sol",
        vendor: "openai",
        patterns: ["gpt-5.6-sol"],
        pricing: {input: 5, output: 30},
        confidence: "third_party" as const,
      }],
    };
    const withMappings = {
      ...base,
      targetModelMappings: {
        "api.test": {
          "gpt-5.6-sol": {vendor: "openai", priceEntryId: "gpt-5.6-sol"},
        },
      },
    };

    assert.equal(ensurePricingConfigRevision(fixture.db, withMappings).created, true);
    const restored = loadPricingConfigAt(fixture.db, new Date().toISOString());
    assert.deepEqual(restored?.config.targetModelMappings, withMappings.targetModelMappings);
    assert.equal(restored?.revisionId, 1);

    // 仅切换供应商映射也必须生成新版本，否则 Worker 计价仍按旧策略。
    const mappingChanged = {
      ...withMappings,
      targetModelMappings: {
        "api.test": {
          "gpt-5.6-sol": {vendor: "azure", priceEntryId: "azure/gpt-5.6-sol"},
        },
      },
    };
    assert.equal(ensurePricingConfigRevision(fixture.db, mappingChanged).created, true);
    const restoredChanged = loadPricingConfigAt(fixture.db, new Date().toISOString());
    assert.deepEqual(
      restoredChanged?.config.targetModelMappings?.["api.test"]?.["gpt-5.6-sol"],
      {vendor: "azure", priceEntryId: "azure/gpt-5.6-sol"},
    );
  });

  test("Worker 按 raw 密钥 ID 读取价格倍率写入账本", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    // 单一价格条目避免同名跨供应商歧义，验证官方价分支按密钥倍率计价。
    await mkdir(join(fixture.dataDir, "config"), {recursive: true});
    await writeFile(join(fixture.dataDir, "config", "model-pricing.json"), JSON.stringify({
      version: 2,
      currency: "USD",
      unit: "per_million_tokens",
      models: [{
        id: "worker-fixture-model",
        vendor: "openai",
        patterns: ["worker-fixture-model"],
        pricing: {input: 1, output: 1},
        confidence: "official",
      }],
    }));
    await writeFile(join(fixture.dataDir, "proxy-config.json"), JSON.stringify({
      version: 2,
      defaultTargetId: "target-worker",
      targets: [{
        id: "target-worker",
        name: "Worker Target",
        upstreamUrl: "https://example.test",
        format: "openai",
        enabled: true,
      }],
    }));
    const exchange = record("ex-worker-rate", 1);
    exchange.routing = {...exchange.routing, clientCredentialId: "cred_rate_01"};
    await fixture.writeV2Lines([exchange]);
    const now = new Date().toISOString();
    await writeFile(
      join(fixture.dataDir, "config", "development-credentials.json"),
      `${JSON.stringify({
        version: 1,
        credentials: [{
          id: "cred_rate_01",
          targetId: "target-worker",
          label: "倍率密钥",
          store: "macos-keychain",
          account: "cred_rate_01",
          fingerprintSuffix: "abcd",
          rateMultiplier: 0.16,
          createdAt: now,
          updatedAt: now,
        }],
      }, null, 2)}\n`,
    );

    const worker = trackedWorker(fixture, "worker-rate");
    assert.equal(worker.acquireLease(), true);
    await worker.runOneBatch();

    const row = fixture.db.prepare(
      "SELECT rate_multiplier, vendor FROM usage_ledger WHERE exchange_id = ?",
    ).get("ex-worker-rate") as {rate_multiplier: number; vendor: string};
    assert.equal(row.rate_multiplier, 0.16);
  });

  test("只有租约持有者处理批次，单条失败进入任务重试且 source 已登记", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    const first = record("ex-worker-ok", 1);
    const second = record("ex-worker-fail", 2);
    await fixture.writeV2Lines([first, second]);
    fixture.db.exec(`
      CREATE TRIGGER fail_second_worker_exchange
      BEFORE INSERT ON raw_exchange_refs
      WHEN NEW.exchange_id = 'ex-worker-fail'
      BEGIN
        SELECT RAISE(ABORT, 'injected worker failure');
      END;
    `);

    const transitions: Array<Record<string, unknown>> = [];
    const owner = createIngestionWorker({
      dataDir: fixture.dataDir,
      ownerId: "worker-a",
      diskReserveBytes: 0,
      jobTransitionLogger: (event: Record<string, unknown>) => {
        transitions.push(event);
      },
    });
    const blocked = createIngestionWorker({
      dataDir: fixture.dataDir,
      ownerId: "worker-b",
      diskReserveBytes: 0,
    });
    workers.push(owner, blocked);

    assert.equal(owner.acquireLease(), true);
    assert.equal(blocked.acquireLease(), false);
    const result = await owner.runOneBatch();
    assert.equal(result.processedCount, 1);

    assert.deepEqual(
      fixture.db.prepare(
        `SELECT exchange_id FROM raw_exchange_refs ORDER BY byte_offset`,
      ).pluck().all(),
      ["ex-worker-ok"],
    );
    assert.deepEqual(
      fixture.db.prepare(
        `SELECT byte_offset, scan_offset, processed_count
         FROM ingestion_sources`,
      ).get(),
      {
        byte_offset: Buffer.byteLength(
          `${JSON.stringify(first)}\n${JSON.stringify(second)}\n`,
        ),
        scan_offset: Buffer.byteLength(
          `${JSON.stringify(first)}\n${JSON.stringify(second)}\n`,
        ),
        processed_count: 2,
      },
    );
    assert.deepEqual(
      fixture.db.prepare(
        `SELECT r.exchange_id, j.job_status, j.attempt_count
         FROM derivation_jobs j
         JOIN ingestion_records r ON r.id = j.ingestion_record_id
         WHERE r.exchange_id = 'ex-worker-fail'`,
      ).get(),
      {
        exchange_id: "ex-worker-fail",
        job_status: "retry_wait",
        attempt_count: 1,
      },
    );
    assert.equal(transitions.length, 1);
    assert.deepEqual(transitions[0], {
      event: "derivation-job-transition",
      ingestionRecordId: fixture.db.prepare(
        "SELECT id FROM ingestion_records WHERE exchange_id = 'ex-worker-fail'",
      ).pluck().get(),
      exchangeId: "ex-worker-fail",
      sourceId: fixture.db.prepare(
        "SELECT source_id FROM ingestion_records WHERE exchange_id = 'ex-worker-fail'",
      ).pluck().get(),
      byteOffset: Buffer.byteLength(`${JSON.stringify(first)}\n`),
      attempt: 1,
      status: "retry_wait",
      errorCode: "SQLITE_CONSTRAINT_TRIGGER",
    });
    const transitionJson = JSON.stringify(transitions);
    assert.equal(transitionJson.includes("injected worker failure"), false);
    assert.equal(transitionJson.includes("captures/v2"), false);
    assert.equal(
      fixture.db.prepare("SELECT data_version FROM schema_meta WHERE id = 1")
        .pluck().get(),
      1,
    );
  });

  test("每批最多提交 25 行并逐行递增 data_version", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    await fixture.writeV2Lines(
      Array.from({ length: 30 }, (_, index) =>
        record(`ex-worker-batch-${index}`, index + 1)),
    );
    const worker = trackedWorker(fixture, "worker-batch");

    assert.equal(worker.acquireLease(), true);
    const first = await worker.runOneBatch();
    assert.equal(first.processedCount, 25);
    assert.equal(rawExchangeCount(fixture), 25);
    assert.equal(dataVersion(fixture), 25);

    const second = await worker.runOneBatch();
    assert.equal(second.processedCount, 5);
    assert.equal(rawExchangeCount(fixture), 30);
    assert.equal(dataVersion(fixture), 30);
  });

  test("新 Turn 开始时关闭旧 Turn 但不推进旧 Turn 的最近请求时间", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    const firstTime = "2026-07-17T08:00:00.000Z";
    const secondTime = "2026-07-17T09:00:00.000Z";
    await fixture.writeV2Lines([
      recordAt("ex-worker-turn-first", 1, firstTime),
      recordAt("ex-worker-turn-second", 2, secondTime),
    ]);
    const worker = trackedWorker(fixture, "worker-turn-end-time");

    assert.equal(worker.acquireLease(), true);
    await worker.runOneBatch();

    assert.deepEqual(
      fixture.db.prepare(
        `SELECT status, start_time, end_time
         FROM agent_turns ORDER BY segment_index ASC`,
      ).all(),
      [
        { status: "closed", start_time: firstTime, end_time: firstTime },
        { status: "open", start_time: secondTime, end_time: secondTime },
      ],
    );
  });

  test("重复 exchange 仍推进对应 raw 行但不会重复派生", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    const duplicate = record("ex-worker-duplicate", 1);
    await fixture.writeV2Lines([duplicate, duplicate]);
    const worker = trackedWorker(fixture, "worker-duplicate");

    assert.equal(worker.acquireLease(), true);
    const result = await worker.runOneBatch();

    assert.equal(result.processedCount, 1);
    assert.equal(rawExchangeCount(fixture), 1);
    assert.equal(dataVersion(fixture), 1);
    assert.deepEqual(
      fixture.db.prepare(
        `SELECT byte_offset, scan_offset, processed_count, file_size
         FROM ingestion_sources`,
      ).get(),
      {
        byte_offset: 2 * (Buffer.byteLength(JSON.stringify(duplicate)) + 1),
        scan_offset: 2 * (Buffer.byteLength(JSON.stringify(duplicate)) + 1),
        processed_count: 2,
        file_size: 2 * (Buffer.byteLength(JSON.stringify(duplicate)) + 1),
      },
    );
  });

  test("无效 raw 行写有界诊断并继续处理后续有效行", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    const file = await fixture.writeV2Lines([]);
    await fixture.appendRaw(
      file,
      `{broken}\n${JSON.stringify(record("ex-worker-after-invalid", 2))}\n`,
    );
    const worker = trackedWorker(fixture, "worker-invalid");

    assert.equal(worker.acquireLease(), true);
    const result = await worker.runOneBatch();

    assert.equal(result.processedCount, 1);
    assert.equal(rawExchangeCount(fixture), 1);
    assert.equal(dataVersion(fixture), 2);
    assert.deepEqual(
      fixture.db.prepare(
        `SELECT code, severity FROM derivation_diagnostics
         WHERE code = 'raw_line_invalid_json'`,
      ).get(),
      { code: "raw_line_invalid_json", severity: "warning" },
    );
  });

  test("超过 8 MiB 的行按 16 MiB I/O 预算跨批跳过且只在完整时记版本", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    const file = await fixture.writeV2Lines([]);
    const oversizedBytes = 17 * 1024 * 1024;
    await fixture.appendRaw(file, `${"x".repeat(oversizedBytes)}\n`);
    const worker = trackedWorker(fixture, "worker-oversized");

    assert.equal(worker.acquireLease(), true);
    const first = await worker.runOneBatch();
    const partial = sourceCursor(fixture);
    assert.equal(first.processedCount, 0);
    assert.equal(partial.byte_offset, 0);
    assert.ok(partial.scan_offset > 0);
    assert.ok(partial.scan_offset <= 16 * 1024 * 1024);
    assert.equal(dataVersion(fixture), 0);

    const second = await worker.runOneBatch();
    const completed = sourceCursor(fixture);
    assert.equal(second.processedCount, 0);
    assert.equal(completed.byte_offset, oversizedBytes + 1);
    assert.equal(completed.scan_offset, oversizedBytes + 1);
    assert.equal(dataVersion(fixture), 1);
    assert.equal(
      fixture.db.prepare(
        `SELECT COUNT(*) FROM derivation_diagnostics
         WHERE code = 'raw_line_oversized'`,
      ).pluck().get(),
      1,
    );
  });

  test("source 轮转先原子记录 reset 再从 generation 新起点处理", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    const file = await fixture.writeV2Lines([record("ex-worker-before-reset", 1)]);
    const worker = trackedWorker(fixture, "worker-reset");
    assert.equal(worker.acquireLease(), true);
    await worker.runOneBatch();

    const replacement = join(fixture.dataDir, "captures", "v2", "replacement.tmp");
    const after = record("ex-worker-after-reset", 2);
    await writeFile(replacement, `${JSON.stringify(after)}\n`);
    await rename(replacement, file);

    const result = await worker.runOneBatch();
    assert.equal(result.processedCount, 1);
    assert.deepEqual(
      fixture.db.prepare(
        `SELECT exchange_id FROM raw_exchange_refs ORDER BY captured_at`,
      ).pluck().all(),
      ["ex-worker-before-reset", "ex-worker-after-reset"],
    );
    assert.deepEqual(
      fixture.db.prepare(
        `SELECT generation, status, processed_count FROM ingestion_sources`,
      ).get(),
      { generation: 1, status: "ready", processed_count: 2 },
    );
    assert.equal(
      fixture.db.prepare(
        `SELECT COUNT(*) FROM derivation_diagnostics WHERE code = 'source_reset'`,
      ).pluck().get(),
      1,
    );
    assert.equal(dataVersion(fixture), 3);
  });

  test("可用空间低于保留阈值时暂停且不发现或处理 source", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    await fixture.writeV2Lines([record("ex-worker-paused-disk", 1)]);
    const worker = createIngestionWorker({
      dataDir: fixture.dataDir,
      ownerId: "worker-paused-disk",
      diskReserveBytes: 101,
      availableDiskBytes: async () => 100,
    });
    workers.push(worker);

    assert.equal(worker.acquireLease(), true);
    const result = await worker.runOneBatch();

    assert.equal(result.pausedDisk, true);
    assert.equal(rawExchangeCount(fixture), 0);
    assert.equal(dataVersion(fixture), 0);
    assert.equal(
      fixture.db.prepare("SELECT COUNT(*) FROM ingestion_sources").pluck().get(),
      0,
    );
    assert.deepEqual(
      fixture.db.prepare(
        "SELECT worker_status, worker_error FROM schema_meta WHERE id = 1",
      ).get(),
      { worker_status: "paused_disk", worker_error: null },
    );
  });

  test("异步检查期间失去租约的旧 Worker 不得覆盖新持有者状态", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    let releaseDiskCheck!: (value: number) => void;
    const diskCheck = new Promise<number>(resolveCheck => {
      releaseDiskCheck = resolveCheck;
    });
    const worker = createIngestionWorker({
      dataDir: fixture.dataDir,
      ownerId: "worker-lost-lease",
      diskReserveBytes: 0,
      availableDiskBytes: () => diskCheck,
    });
    workers.push(worker);
    assert.equal(worker.acquireLease(), true);

    const pending = worker.runOneBatch();
    await new Promise(resolveImmediate => setImmediate(resolveImmediate));
    fixture.db.prepare(
      `UPDATE worker_lease SET owner_id = 'worker-new-owner', expires_at = ?
       WHERE id = 1`,
    ).run(new Date(Date.now() + 60_000).toISOString());
    fixture.db.prepare(
      `UPDATE schema_meta SET worker_status = 'running', worker_error = NULL
       WHERE id = 1`,
    ).run();
    releaseDiskCheck(Number.MAX_SAFE_INTEGER);

    await assert.rejects(pending, /未持有有效租约/);
    assert.deepEqual(
      fixture.db.prepare(
        "SELECT worker_status, worker_error FROM schema_meta WHERE id = 1",
      ).get(),
      { worker_status: "running", worker_error: null },
    );
  });

  test("文件句柄观察到追加增长时以 CAS 提交的新快照校验行范围", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    const exchange = record("ex-worker-file-growth", 1);
    const lineLengthBytes = Buffer.byteLength(JSON.stringify(exchange)) + 1;
    const sourceId = fixture.db.prepare(
      `INSERT INTO ingestion_sources(
        relative_path, file_id, file_size, updated_at
      ) VALUES('captures/v2/growth.jsonl', 'growth-file', 1, ?)
      RETURNING id`,
    ).pluck().get(new Date().toISOString()) as number;
    fixture.db.prepare(
      `INSERT INTO worker_lease(id, owner_id, expires_at) VALUES(1, ?, ?)`,
    ).run(
      "worker-growth",
      new Date(Date.now() + 60_000).toISOString(),
    );
    const processor = createExchangeProcessor({
      db: fixture.db,
      dataDir: fixture.dataDir,
    });

    const result = await processor.processExchangeRecordAndAdvance({
      sourceId,
      sourceRelativePath: "captures/v2/growth.jsonl",
      byteOffset: 0,
      lineLengthBytes,
      exchange,
    }, {
      leaseOwnerId: "worker-growth",
      cursor: {
        sourceId,
        relativePath: "captures/v2/growth.jsonl",
        fileId: "growth-file",
        generation: 0,
        expectedFileSize: 1,
        nextFileSize: lineLengthBytes,
        expectedByteOffset: 0,
        expectedScanOffset: 0,
        nextByteOffset: lineLengthBytes,
        nextScanOffset: lineLengthBytes,
        processedCount: 1,
      },
    });

    assert.equal(result.exchangeId, exchange.exchangeId);
    assert.deepEqual(
      fixture.db.prepare(
        `SELECT byte_offset, scan_offset, file_size, processed_count
         FROM ingestion_sources WHERE id = ?`,
      ).get(sourceId),
      {
        byte_offset: lineLengthBytes,
        scan_offset: lineLengthBytes,
        file_size: lineLengthBytes,
        processed_count: 1,
      },
    );
    assert.equal(dataVersion(fixture), 1);
  });

  test("失败 source 本轮停止后下批轮转到其他 source 而不无限饿死", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    const recordsByPath = new Map([
      [
        "captures/v2/a.jsonl",
        record("ex-worker-fair-a", 1),
      ],
      [
        "captures/v2/z.jsonl",
        record("ex-worker-fair-z", 2),
      ],
    ]);
    await fixture.writeV2Lines([recordsByPath.get("captures/v2/a.jsonl")!], "a.jsonl");
    await fixture.writeV2Lines([recordsByPath.get("captures/v2/z.jsonl")!], "z.jsonl");
    await discoverV2Sources(fixture.db, fixture.dataDir);
    const firstSelected = fixture.db.prepare(
      `SELECT relative_path FROM ingestion_sources
       ORDER BY updated_at DESC, id DESC LIMIT 1`,
    ).pluck().get() as string;
    const failingExchangeId = recordsByPath.get(firstSelected)!.exchangeId;
    fixture.db.exec(`
      CREATE TRIGGER fail_latest_worker_source
      BEFORE INSERT ON raw_exchange_refs
      WHEN NEW.exchange_id = '${failingExchangeId}'
      BEGIN
        SELECT RAISE(ABORT, 'injected fair scheduling failure');
      END;
    `);
    const worker = trackedWorker(fixture, "worker-fair-sources");

    assert.equal(worker.acquireLease(), true);
    const first = await worker.runOneBatch();
    assert.equal(first.processedCount, 0);
    const second = await worker.runOneBatch();

    assert.equal(second.processedCount, 1);
    assert.deepEqual(
      fixture.db.prepare("SELECT exchange_id FROM raw_exchange_refs")
        .pluck().all(),
      [firstSelected === "captures/v2/a.jsonl"
        ? "ex-worker-fair-z"
        : "ex-worker-fair-a"],
    );
  });

  test("discovery 候选校验期间租约转移后旧 Worker 不能 upsert source", async (context) => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    await fixture.writeV2Lines([record("ex-worker-stale-discovery", 1)]);
    fixture.db.prepare(
      `INSERT INTO worker_lease(id, owner_id, expires_at) VALUES(1, ?, ?)`,
    ).run(
      "worker-stale-discovery",
      new Date(Date.now() + 60_000).toISOString(),
    );
    const originalRead = Dir.prototype.read as (
      this: Dir,
    ) => Promise<Dirent | null>;
    let transferred = false;
    context.mock.method(
      Dir.prototype,
      "read",
      async function readAfterLeaseTransfer(this: Dir): Promise<Dirent | null> {
        const entry = await originalRead.call(this);
        if (!transferred && entry) {
          fixture.db.prepare(
            `UPDATE worker_lease SET owner_id = 'worker-new-discovery',
              expires_at = ? WHERE id = 1`,
          ).run(new Date(Date.now() + 60_000).toISOString());
          transferred = true;
        }
        return entry;
      },
    );

    await assert.rejects(
      discoverV2Sources(fixture.db, fixture.dataDir, {
        maxEntries: 1,
        leaseOwnerId: "worker-stale-discovery",
      }),
      /未持有有效租约/,
    );
    assert.equal(transferred, true);
    assert.equal(
      fixture.db.prepare("SELECT COUNT(*) FROM ingestion_sources").pluck().get(),
      0,
    );
  });

  test("close 等待执行中的异步批次后再关闭数据库连接", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    let releaseDiskCheck!: (value: number) => void;
    const diskCheck = new Promise<number>(resolveCheck => {
      releaseDiskCheck = resolveCheck;
    });
    const worker = createIngestionWorker({
      dataDir: fixture.dataDir,
      ownerId: "worker-graceful-close",
      diskReserveBytes: 0,
      availableDiskBytes: () => diskCheck,
    });
    workers.push(worker);
    assert.equal(worker.acquireLease(), true);
    const pendingBatch = worker.runOneBatch();
    await new Promise(resolveImmediate => setImmediate(resolveImmediate));

    const closing = worker.close();
    assert.ok(closing instanceof Promise);
    let closeFinished = false;
    void closing.then(() => {
      closeFinished = true;
    });
    await new Promise(resolveImmediate => setImmediate(resolveImmediate));
    assert.equal(closeFinished, false);

    releaseDiskCheck(Number.MAX_SAFE_INTEGER);
    const result = await pendingBatch;
    await closing;
    assert.equal(result.leaseAcquired, true);
    assert.equal(closeFinished, true);
  });

  test("close 会关闭批次执行期间迟到创建的 discovery continuation", async (context) => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    const captureDir = join(fixture.dataDir, "captures", "v2");
    await mkdir(captureDir, { recursive: true });
    await Promise.all(Array.from({ length: 26 }, (_, index) =>
      writeFile(join(captureDir, `ignored-${index}.txt`), "ignored")));
    const originalRead = Dir.prototype.read as (
      this: Dir,
    ) => Promise<Dirent | null>;
    const originalClose = Dir.prototype.close as (
      this: Dir,
      callback: (error?: NodeJS.ErrnoException | null) => void,
    ) => void;
    let enterFirstRead!: () => void;
    const firstReadEntered = new Promise<void>(resolveEntered => {
      enterFirstRead = resolveEntered;
    });
    let releaseFirstRead!: () => void;
    const firstReadGate = new Promise<void>(resolveRead => {
      releaseFirstRead = resolveRead;
    });
    let firstRead = true;
    let closeCount = 0;
    context.mock.method(
      Dir.prototype,
      "read",
      async function delayedFirstRead(this: Dir): Promise<Dirent | null> {
        if (firstRead) {
          firstRead = false;
          enterFirstRead();
          await firstReadGate;
        }
        return originalRead.call(this);
      },
    );
    context.mock.method(
      Dir.prototype,
      "close",
      async function countedClose(this: Dir): Promise<void> {
        closeCount += 1;
        await new Promise<void>((resolveClose, rejectClose) => {
          originalClose.call(this, error => {
            if (error) rejectClose(error);
            else resolveClose();
          });
        });
      },
    );
    const worker = trackedWorker(fixture, "worker-late-continuation");
    assert.equal(worker.acquireLease(), true);

    const pendingBatch = worker.runOneBatch();
    await firstReadEntered;
    const closing = worker.close();
    releaseFirstRead();
    await pendingBatch;
    await closing;

    assert.equal(closeCount, 1);
  });
});

describe("dsh 身份等待调度层顺延（2026-09-22：等待离开错误管道）", () => {
  test("① 新近 dsh 网关行标注未到：顺延而非错误重试（零错误码、零迁移日志、attempt 不变）", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    await fixture.writeV2Lines(
      [dshGatewayRecord("ex-dsh-defer-1", "resp-defer-0001", new Date(Date.now() - 3_000).toISOString())],
      "dsh-defer-1.jsonl",
    );
    const transitions: unknown[] = [];
    const worker = createIngestionWorker({
      dataDir: fixture.dataDir,
      ownerId: "worker-dsh-defer",
      diskReserveBytes: 0,
      jobTransitionLogger: (event) => transitions.push(event),
    });
    workers.push(worker);
    assert.equal(worker.acquireLease(), true);
    const result = await worker.runOneBatch();

    // 顺延不是处理：不计数，不派生任何业务投影。
    assert.equal(result.processedCount, 0);
    assert.equal(rawExchangeCount(fixture), 0);
    // 错误管道完全静默：无迁移日志（旧实现此处会打 dsh_identity_pending warn）。
    assert.equal(transitions.length, 0, `迁移日志必须为零：${JSON.stringify(transitions)}`);
    const job = fixture.db.prepare(
      `SELECT job_status, attempt_count, last_error_code, available_at, updated_at
       FROM derivation_jobs`,
    ).get() as {
      job_status: string;
      attempt_count: number;
      last_error_code: string | null;
      available_at: string;
      updated_at: string;
    };
    assert.equal(job.job_status, "pending");
    // 领取时 +1 已被顺延减回：顺延不消耗错误重试预算。
    assert.equal(job.attempt_count, 0);
    assert.equal(job.last_error_code, null);
    const delay = Date.parse(job.available_at) - Date.parse(job.updated_at);
    assert.ok(delay > 0 && delay <= 5_000, `available_at 顺延时长异常：${delay}ms`);
    const diagnostics = fixture.db.prepare(
      "SELECT COUNT(*) AS n FROM derivation_diagnostics",
    ).get() as {n: number};
    assert.equal(diagnostics.n, 0);
  });

  test("② 标注到达后到点重领：派生成功并回填原生 session/turn/step 身份", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    await fixture.writeV2Lines(
      [dshGatewayRecord("ex-dsh-defer-2", "resp-defer-0002", new Date(Date.now() - 3_000).toISOString())],
      "dsh-defer-2.jsonl",
    );
    const worker = trackedWorker(fixture, "worker-dsh-defer-2");
    assert.equal(worker.acquireLease(), true);
    const first = await worker.runOneBatch();
    assert.equal(first.processedCount, 0, "标注未到必须顺延而非派生");

    // 模拟 2s 扫描节拍写入身份标注，并把顺延 available_at 推到过去模拟到点。
    upsertAgentLocalIdentityLinks(fixture.db, [{
      responseId: "resp-defer-0002",
      agentId: "dsh",
      externalSessionId: "sess-defer-0002",
      turnNumber: 3,
      stepNumber: 7,
      recordedAt: new Date().toISOString(),
    }]);
    fixture.db.prepare(
      "UPDATE derivation_jobs SET available_at = '2000-01-01T00:00:00.000Z'",
    ).run();

    const second = await worker.runOneBatch();
    assert.equal(second.processedCount, 1);
    const job = fixture.db.prepare(
      `SELECT job_status, attempt_count, last_error_code FROM derivation_jobs`,
    ).get() as {job_status: string; attempt_count: number; last_error_code: string | null};
    assert.equal(job.job_status, "succeeded");
    assert.equal(job.attempt_count, 1, "顺延回合不计数，重领后第 1 次尝试即成功");
    assert.equal(job.last_error_code, null);
    const step = fixture.db.prepare(
      `SELECT st.identity_source, st.identity_confidence,
         st.native_step_id, t.native_turn_id
       FROM agent_steps st JOIN agent_turns t ON t.id = st.agent_turn_id`,
    ).get() as {
      identity_source: string;
      identity_confidence: string;
      native_turn_id: string | null;
      native_step_id: string | null;
    };
    assert.equal(step.identity_source, "native-header");
    assert.equal(step.identity_confidence, "exact");
    assert.equal(step.native_turn_id, "sess-defer-0002:turn:3");
    assert.equal(step.native_step_id, "sess-defer-0002:step:7");
  });

  test("③ 超出 90s 窗口仍无标注：按现状派生并写 dsh_identity_missing 诊断", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    await fixture.writeV2Lines(
      [dshGatewayRecord("ex-dsh-old-3", "resp-old-0003", new Date(Date.now() - 10 * 60_000).toISOString())],
      "dsh-old-3.jsonl",
    );
    const worker = trackedWorker(fixture, "worker-dsh-old-3");
    assert.equal(worker.acquireLease(), true);
    const result = await worker.runOneBatch();

    assert.equal(result.processedCount, 1, "超窗行必须立即按现状派生，不得无限顺延");
    const diagnostic = fixture.db.prepare(
      "SELECT code, severity FROM derivation_diagnostics WHERE code = 'dsh_identity_missing'",
    ).get() as {code: string; severity: string} | undefined;
    assert.ok(diagnostic, "超窗降级必须写 dsh_identity_missing 诊断");
    assert.equal(diagnostic.severity, "warning");
    const step = fixture.db.prepare(
      "SELECT identity_source FROM agent_steps",
    ).get() as {identity_source: string};
    assert.notEqual(step.identity_source, "native-header");
  });

  test("④ 顺延不消耗错误重试预算：后续真实错误按正常 attempt 消耗", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    await fixture.writeV2Lines(
      [dshGatewayRecord("ex-dsh-budget-4", "resp-budget-0004", new Date(Date.now() - 3_000).toISOString())],
      "dsh-budget-4.jsonl",
    );
    const worker = trackedWorker(fixture, "worker-dsh-budget-4");
    assert.equal(worker.acquireLease(), true);
    const first = await worker.runOneBatch();
    assert.equal(first.processedCount, 0);
    const deferred = fixture.db.prepare(
      "SELECT attempt_count FROM derivation_jobs",
    ).get() as {attempt_count: number};
    assert.equal(deferred.attempt_count, 0);

    fixture.db.prepare(
      "UPDATE derivation_jobs SET available_at = '2000-01-01T00:00:00.000Z'",
    ).run();
    const claim = claimNextDerivationJob(fixture.db, {ownerId: "worker-dsh-budget-4"});
    assert.ok(claim);
    assert.equal(claim.attemptCount, 1, "顺延后的下一次领取必须从 attempt 1 起算");
    markDerivationJobRetry(fixture.db, claim, {
      errorCode: "synthetic_failure",
      errorMessage: "注入的真实失败",
    });
    const job = fixture.db.prepare(
      `SELECT job_status, attempt_count, last_error_code FROM derivation_jobs`,
    ).get() as {job_status: string; attempt_count: number; last_error_code: string};
    assert.equal(job.job_status, "retry_wait");
    assert.equal(job.attempt_count, 1);
    assert.equal(job.last_error_code, "synthetic_failure");
  });

  test("⑤ 顺延过的任务在 running 中遇批次崩溃：走 retry_wait 而非 permanent_error", async () => {
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    await fixture.writeV2Lines(
      [dshGatewayRecord("ex-dsh-crash-5", "resp-crash-0005", new Date(Date.now() - 3_000).toISOString())],
      "dsh-crash-5.jsonl",
    );
    const worker = trackedWorker(fixture, "worker-dsh-crash-5");
    assert.equal(worker.acquireLease(), true);
    const first = await worker.runOneBatch();
    assert.equal(first.processedCount, 0);

    fixture.db.prepare(
      "UPDATE derivation_jobs SET available_at = '2000-01-01T00:00:00.000Z'",
    ).run();
    const claim = claimNextDerivationJob(fixture.db, {ownerId: "worker-dsh-crash-5"});
    assert.ok(claim);
    assert.equal(claim.attemptCount, 1);
    // 批次崩溃兜底：attempt 未被顺延污染（< MAX_ATTEMPTS）→ 必须交还 retry_wait。
    const released = releaseWorkerClaims(fixture.db, "worker-dsh-crash-5", {
      errorCode: "batch_crash",
      errorMessage: "模拟批次崩溃",
    });
    assert.equal(released, 1);
    const job = fixture.db.prepare(
      `SELECT job_status, attempt_count, last_error_code FROM derivation_jobs`,
    ).get() as {job_status: string; attempt_count: number; last_error_code: string};
    assert.equal(job.job_status, "retry_wait", "顺延不得把 attempt 推过上限导致误判永久失败");
    assert.equal(job.attempt_count, 1);
    assert.equal(job.last_error_code, "batch_crash");
  });

  test("⑥ 本地导入扫描节拍锁定 2 秒（2026-09-22 用户定案）", async () => {
    const {LOCAL_IMPORT_INTERVAL_MS} = await import(
      "../src/lib/agent-local-source/local-import-scheduler.js"
    );
    assert.equal(LOCAL_IMPORT_INTERVAL_MS, 2_000);
  });

  test("⑦ 扫描就绪门控：旧行 + 扫描已启动未收敛 → 顺延 5s（零错误码、attempt 不变）", async () => {
    resetAgentScanReadinessForTests();
    // 模拟重启追赶竞态：行龄 10 分钟（远超 90s），本进程扫描已启动但未收敛。
    markAgentScanStarted("dsh");
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    await fixture.writeV2Lines(
      [dshGatewayRecord("ex-dsh-scanwait-7", "resp-scanwait-0007", new Date(Date.now() - 10 * 60_000).toISOString())],
      "dsh-scanwait-7.jsonl",
    );
    const transitions: unknown[] = [];
    const worker = createIngestionWorker({
      dataDir: fixture.dataDir,
      ownerId: "worker-dsh-scanwait-7",
      diskReserveBytes: 0,
      jobTransitionLogger: (event) => transitions.push(event),
    });
    workers.push(worker);
    assert.equal(worker.acquireLease(), true);
    const result = await worker.runOneBatch();

    // 旧行不降级：等待扫描收敛（旧实现此处会立即派生并写 dsh_identity_missing）。
    assert.equal(result.processedCount, 0);
    assert.equal(rawExchangeCount(fixture), 0);
    assert.equal(transitions.length, 0);
    const job = fixture.db.prepare(
      `SELECT job_status, attempt_count, last_error_code, available_at, updated_at
       FROM derivation_jobs`,
    ).get() as {
      job_status: string;
      attempt_count: number;
      last_error_code: string | null;
      available_at: string;
      updated_at: string;
    };
    assert.equal(job.job_status, "pending");
    assert.equal(job.attempt_count, 0);
    assert.equal(job.last_error_code, null);
    // 扫描就绪等待用低频粒度（5s），区别于实时竞态的 2s。
    assert.equal(Date.parse(job.available_at) - Date.parse(job.updated_at), 5_000);
    const diagnostics = fixture.db.prepare(
      "SELECT COUNT(*) AS n FROM derivation_diagnostics",
    ).get() as {n: number};
    assert.equal(diagnostics.n, 0, "未收敛期间不得写降级诊断");
  });

  test("⑧ 扫描收敛 + 标注到达：旧行重领后原生派生", async () => {
    resetAgentScanReadinessForTests();
    markAgentScanStarted("dsh");
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    await fixture.writeV2Lines(
      [dshGatewayRecord("ex-dsh-scanwait-8", "resp-scanwait-0008", new Date(Date.now() - 10 * 60_000).toISOString())],
      "dsh-scanwait-8.jsonl",
    );
    const worker = trackedWorker(fixture, "worker-dsh-scanwait-8");
    assert.equal(worker.acquireLease(), true);
    const first = await worker.runOneBatch();
    assert.equal(first.processedCount, 0, "未收敛旧行必须顺延");

    // 模拟扫描收敛并把标注落表，顺延到点后重领。
    markAgentScanConverged("dsh");
    upsertAgentLocalIdentityLinks(fixture.db, [{
      responseId: "resp-scanwait-0008",
      agentId: "dsh",
      externalSessionId: "sess-scanwait-0008",
      turnNumber: 1,
      stepNumber: 2,
      recordedAt: new Date().toISOString(),
    }]);
    fixture.db.prepare(
      "UPDATE derivation_jobs SET available_at = '2000-01-01T00:00:00.000Z'",
    ).run();

    const second = await worker.runOneBatch();
    assert.equal(second.processedCount, 1);
    const step = fixture.db.prepare(
      `SELECT st.identity_source, st.identity_confidence, st.native_step_id
       FROM agent_steps st`,
    ).get() as {identity_source: string; identity_confidence: string; native_step_id: string | null};
    assert.equal(step.identity_source, "native-header");
    assert.equal(step.identity_confidence, "exact");
    assert.equal(step.native_step_id, "sess-scanwait-0008:step:2");
  });

  test("⑨ 熔断：已启动超过 5 分钟未收敛 → 旧行按现状降级派生 + 诊断", async () => {
    resetAgentScanReadinessForTests();
    markAgentScanStarted("dsh", Date.now() - 6 * 60_000);
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    await fixture.writeV2Lines(
      [dshGatewayRecord("ex-dsh-circuit-9", "resp-circuit-0009", new Date(Date.now() - 10 * 60_000).toISOString())],
      "dsh-circuit-9.jsonl",
    );
    const worker = trackedWorker(fixture, "worker-dsh-circuit-9");
    assert.equal(worker.acquireLease(), true);
    const result = await worker.runOneBatch();

    assert.equal(result.processedCount, 1, "熔断后旧行必须立即按现状派生（有界性）");
    const diagnostic = fixture.db.prepare(
      "SELECT code FROM derivation_diagnostics WHERE code = 'dsh_identity_missing'",
    ).get() as {code: string} | undefined;
    assert.ok(diagnostic, "熔断降级必须写 dsh_identity_missing 诊断");
  });

  test("⑩ 已收敛后 miss 即真缺失：旧行立即降级（三态之收敛态）", async () => {
    resetAgentScanReadinessForTests();
    markAgentScanStarted("dsh");
    markAgentScanConverged("dsh");
    const fixture = await createSqliteFixture();
    fixtures.push(fixture);
    await fixture.writeV2Lines(
      [dshGatewayRecord("ex-dsh-converged-10", "resp-converged-0010", new Date(Date.now() - 10 * 60_000).toISOString())],
      "dsh-converged-10.jsonl",
    );
    const worker = trackedWorker(fixture, "worker-dsh-converged-10");
    assert.equal(worker.acquireLease(), true);
    const result = await worker.runOneBatch();

    assert.equal(result.processedCount, 1, "收敛后旧行不再等待");
    const diagnostic = fixture.db.prepare(
      "SELECT COUNT(*) AS n FROM derivation_diagnostics WHERE code = 'dsh_identity_missing'",
    ).get() as {n: number};
    assert.equal(diagnostic.n, 1);
  });
});

/** dsh 网关捕获形态夹具：chat_completions 非流式，response.id = 本地 responseId。 */
function dshGatewayRecord(
  exchangeId: string,
  responseId: string,
  completedAt: string,
): RawCapturedExchangeV2 {
  const requestBody = JSON.stringify({
    model: "deepseek-chat",
    messages: [{role: "user", content: "dsh 身份顺延夹具请求"}],
  });
  const responseBody = JSON.stringify({
    id: responseId,
    object: "chat.completion",
    model: "deepseek-chat",
    choices: [{
      index: 0,
      message: {role: "assistant", content: "经网关的回答。"},
      finish_reason: "stop",
    }],
    usage: {prompt_tokens: 20, completion_tokens: 5, total_tokens: 25},
  });
  return {
    schemaVersion: 2,
    exchangeId,
    captureSessionId: "capture-dsh-defer-fixture",
    sequence: 1,
    capturedAt: completedAt,
    completedAt,
    durationMs: 500,
    routing: {
      targetId: "target-dsh-defer",
      targetName: "DeepSeek（顺延夹具）",
      targetFormatHint: "openai",
      localUrl: "/dsh/v1/chat/completions",
      upstreamUrl: "https://api.deepseek.com/v1/chat/completions",
      localPath: "/dsh/v1/chat/completions",
      upstreamPath: "/v1/chat/completions",
      method: "POST",
      routeMode: "model",
      agent: "dsh",
      wireApi: "chat_completions",
    },
    request: {
      headers: {"user-agent": "deepseek-harness/0.1.5-rc.2"},
      rawBody: requestBody,
      bodySizeBytes: Buffer.byteLength(requestBody),
      bodySha256: createHash("sha256").update(requestBody).digest("hex"),
    },
    response: {
      status: 200,
      statusText: "OK",
      headers: {},
      rawBody: responseBody,
      bodySizeBytes: Buffer.byteLength(responseBody),
      bodySha256: createHash("sha256").update(responseBody).digest("hex"),
      isStreaming: false,
    },
    bodyStorage: {policy: "inline"},
    captureDiagnostics: [],
    security: {
      containsSensitiveHeaders: false,
      headerRedactionAppliedInApi: true,
      rawBodiesStoredLocally: true,
    },
  };
}

function seedDerivationOverview(fixture: SqliteFixture): void {
  const sourceId = fixture.db.prepare(
    `INSERT INTO ingestion_sources(
      relative_path, file_id, byte_offset, scan_offset, file_size,
      processed_count, status, updated_at
    ) VALUES('captures/v2/status.jsonl', 'status-file', 0, 0, 4096,
      6, 'ready', '2026-07-22T00:05:00.000Z')
    RETURNING id`,
  ).pluck().get() as number;
  const insertRecord = fixture.db.prepare(
    `INSERT INTO ingestion_records(
      exchange_id, source_id, source_generation, source_file_id,
      byte_offset, line_length_bytes, line_sha256, schema_version,
      captured_at, completed_at, request_body_bytes, response_body_bytes,
      request_body_sha256, response_body_sha256,
      request_body_storage, response_body_storage,
      request_body_state, response_body_state, registered_at
    ) VALUES(?, ?, 0, 'status-file', ?, 64, ?, 2, ?, ?, 10, 10,
      ?, ?, 'inline', 'inline', 'available', 'available', ?)
    RETURNING id`,
  );
  const insertJob = fixture.db.prepare(
    `INSERT INTO derivation_jobs(
      ingestion_record_id, projection_version, job_status,
      projection_completeness, attempt_count, available_at,
      locked_by, locked_at, last_error_code, last_error_message,
      request_verification, response_verification,
      created_at, updated_at, completed_at
    ) VALUES(?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const statuses = [
    { status: "pending", completeness: null, attempts: 0, verification: "pending", minute: 0 },
    { status: "running", completeness: null, attempts: 1, verification: "pending", minute: 1 },
    {
      status: "retry_wait",
      completeness: null,
      attempts: 1,
      verification: "pending",
      minute: 2,
      errorCode: "raw_body_unavailable",
      errorMessage: "正文暂时不可用",
    },
    { status: "succeeded", completeness: "complete", attempts: 1, verification: "verified", minute: 3 },
    { status: "succeeded", completeness: "limited", attempts: 1, verification: "not_verified_budget", minute: 4 },
    {
      status: "permanent_error",
      completeness: "unavailable",
      attempts: 2,
      verification: "failed",
      minute: 5,
      errorCode: "raw_body_integrity_failed",
      errorMessage: "正文哈希不一致",
    },
  ] as const;
  const records: Array<{ id: number; exchangeId: string; timestamp: string }> = [];
  fixture.db.transaction(() => {
    for (const [index, status] of statuses.entries()) {
      const exchangeId = `status-exchange-${index}`;
      const timestamp = `2026-07-22T00:0${status.minute}:00.000Z`;
      const hash = String(index).repeat(64);
      const id = insertRecord.pluck().get(
        exchangeId,
        sourceId,
        index * 64,
        hash,
        timestamp,
        timestamp,
        hash,
        hash,
        timestamp,
      ) as number;
      const terminal = status.status === "succeeded"
        || status.status === "permanent_error";
      insertJob.run(
        id,
        status.status,
        status.completeness,
        status.attempts,
        timestamp,
        status.status === "running" ? "status-worker" : null,
        status.status === "running" ? timestamp : null,
        "errorCode" in status ? status.errorCode : null,
        "errorMessage" in status ? status.errorMessage : null,
        status.verification,
        status.verification,
        timestamp,
        timestamp,
        terminal ? timestamp : null,
      );
      records.push({ id, exchangeId, timestamp });
    }

    const insertRef = fixture.db.prepare(
      `INSERT INTO raw_exchange_refs(
        exchange_id, capture_session_id, source_id, byte_offset,
        line_length_bytes, captured_at, completed_at, target_id,
        target_name, agent_name, agent_fingerprint_id, model, status,
        is_streaming, request_body_bytes, response_body_bytes,
        ingestion_record_id
      ) VALUES(?, 'status-capture', ?, ?, 64, ?, ?, 'status-target',
        'Status Target', 'codex', 'status-fingerprint', 'status-model',
        200, 0, 10, 10, ?)`,
    );
    for (const record of records.slice(2)) {
      insertRef.run(
        record.exchangeId,
        sourceId,
        record.id * 64,
        record.timestamp,
        record.timestamp,
        record.id,
      );
    }
    const insertPreview = fixture.db.prepare(
      `INSERT INTO exchange_content_previews(
        exchange_id, projection_version, preview_state, preview_json,
        size_bytes, candidate_item_count, processed_item_count,
        candidate_text_bytes, processed_text_bytes, candidate_count_exact,
        limited, truncated, limited_dimensions_json, created_at, updated_at
      ) VALUES(?, 1, ?, ?, ?, 0, 0, 0, 0, 1, ?, ?, '[]', ?, ?)`,
    );
    for (const [offset, previewState] of [
      "complete",
      "limited",
      "unavailable",
    ].entries()) {
      const record = records[offset + 2]!;
      const previewJson = JSON.stringify({ items: [], state: previewState });
      const limited = previewState === "complete" ? 0 : 1;
      insertPreview.run(
        record.exchangeId,
        previewState,
        previewJson,
        Buffer.byteLength(previewJson),
        limited,
        limited,
        record.timestamp,
        record.timestamp,
      );
    }
  })();
}

function trackedWorker(
  fixture: SqliteFixture,
  ownerId: string,
): ReturnType<typeof createIngestionWorker> {
  const worker = createIngestionWorker({
    dataDir: fixture.dataDir,
    ownerId,
    diskReserveBytes: 0,
    jobTransitionLogger: () => undefined,
  });
  workers.push(worker);
  return worker;
}

/** 捕获 assertWorkerLease 抛出的错误对象（断言错误类型/错误码用）。 */
function captureLeaseError(fixture: SqliteFixture, ownerId: string): unknown {
  try {
    assertWorkerLease(fixture.db, ownerId, "2026-07-22T00:10:00.000Z");
    return undefined;
  } catch (error) {
    return error;
  }
}

function rawExchangeCount(fixture: SqliteFixture): number {  return fixture.db.prepare("SELECT COUNT(*) FROM raw_exchange_refs")
    .pluck().get() as number;
}

function dataVersion(fixture: SqliteFixture): number {
  return fixture.db.prepare("SELECT data_version FROM schema_meta WHERE id = 1")
    .pluck().get() as number;
}

function sourceCursor(fixture: SqliteFixture): {
  byte_offset: number;
  scan_offset: number;
} {
  return fixture.db.prepare(
    "SELECT byte_offset, scan_offset FROM ingestion_sources",
  ).get() as ReturnType<typeof sourceCursor>;
}

function record(exchangeId: string, sequence: number): RawCapturedExchangeV2 {
  const capturedAt = new Date(Date.UTC(2026, 6, 17, 8, 0, sequence)).toISOString();
  return recordAt(exchangeId, sequence, capturedAt);
}

function recordAt(
  exchangeId: string,
  sequence: number,
  capturedAt: string,
): RawCapturedExchangeV2 {
  const requestBody = JSON.stringify({
    model: "worker-fixture-model",
    messages: [{ role: "user", content: `request-${sequence}` }],
  });
  const responseBody = JSON.stringify({
    id: `message-${sequence}`,
    type: "message",
    role: "assistant",
    model: "worker-fixture-model",
    content: [{ type: "text", text: `response-${sequence}` }],
    usage: { input_tokens: 10, output_tokens: 5 },
  });
  return {
    schemaVersion: 2,
    exchangeId,
    captureSessionId: "capture-worker-fixture",
    sequence,
    capturedAt,
    completedAt: capturedAt,
    durationMs: 25,
    routing: {
      targetId: "target-worker",
      targetName: "Worker Target",
      targetFormatHint: "anthropic",
      localUrl: "http://127.0.0.1:4000/v1/messages",
      upstreamUrl: "https://example.test/v1/messages",
      localPath: "/v1/messages",
      upstreamPath: "/v1/messages",
      method: "POST",
    },
    request: {
      headers: {
        "content-type": "application/json",
        "x-api-key": "test-key",
        "anthropic-session-id": "session-worker",
      },
      rawBody: requestBody,
      bodySizeBytes: Buffer.byteLength(requestBody),
      bodySha256: createHash("sha256").update(requestBody).digest("hex"),
    },
    response: {
      status: 200,
      statusText: "OK",
      headers: { "content-type": "application/json" },
      rawBody: responseBody,
      bodySizeBytes: Buffer.byteLength(responseBody),
      bodySha256: createHash("sha256").update(responseBody).digest("hex"),
      isStreaming: false,
    },
    bodyStorage: { policy: "inline" },
    captureDiagnostics: [],
    security: {
      containsSensitiveHeaders: true,
      headerRedactionAppliedInApi: true,
      rawBodiesStoredLocally: true,
    },
  };
}

function streamingLifecycleRecord(
  exchangeId: string,
  sequence: number,
): RawCapturedExchangeV2 {
  const value = record(exchangeId, sequence);
  const requestBody = JSON.stringify({
    model: "gpt-5",
    input: [{
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "请给出最终回答" }],
    }],
  });
  const events = [
    ...Array.from({ length: 256 }, (_, index) => ({
      type: "response.output_text.delta",
      item_id: "message-1",
      delta: index === 0 ? "真实模型回答" : "",
    })),
    {
      type: "response.output_item.done",
      item: {
        id: "message-1",
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "真实模型回答" }],
      },
    },
    {
      type: "response.completed",
      response: {
        id: "response-worker-stream",
        status: "completed",
        instructions: "You are Codex, a coding agent based on GPT-5.",
        output: [{
          id: "message-1",
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "真实模型回答" }],
        }],
        usage: { input_tokens: 12, output_tokens: 7 },
      },
    },
  ];
  const responseBody = events
    .map(event => `data: ${JSON.stringify(event)}\n\n`)
    .join("");
  return {
    ...value,
    routing: {
      ...value.routing,
      targetFormatHint: "openai",
      localUrl: "http://127.0.0.1:3211/v1/responses",
      upstreamUrl: "https://example.test/v1/responses",
      localPath: "/v1/responses",
      upstreamPath: "/v1/responses",
    },
    request: {
      headers: {
        "content-type": "application/json",
        "user-agent": "codex-tui/fixture",
      },
      rawBody: requestBody,
      bodySizeBytes: Buffer.byteLength(requestBody),
      bodySha256: createHash("sha256").update(requestBody).digest("hex"),
    },
    response: {
      ...value.response,
      headers: { "content-type": "text/event-stream" },
      rawBody: responseBody,
      bodySizeBytes: Buffer.byteLength(responseBody),
      bodySha256: createHash("sha256").update(responseBody).digest("hex"),
      isStreaming: true,
    },
  };
}

async function writePricingFixture(dataDir: string, preferredVendor: boolean): Promise<void> {
  await mkdir(join(dataDir, "config"), { recursive: true });
  await writeFile(join(dataDir, "config", "model-pricing.json"), JSON.stringify({
    version: 2,
    currency: "USD",
    unit: "per_million_tokens",
    models: [
      {
        id: "worker-fixture-model",
        vendor: "azure",
        patterns: ["worker-fixture-model"],
        pricing: { input: 1, output: 1 },
        confidence: "official",
      },
      {
        id: "worker-fixture-model",
        vendor: "openai",
        patterns: ["worker-fixture-model"],
        pricing: { input: 2, output: 3 },
        confidence: "official",
      },
    ],
  }));
  await writeFile(join(dataDir, "proxy-config.json"), JSON.stringify({
    version: 2,
    defaultTargetId: "target-worker",
    targets: [{
      id: "target-worker",
      name: "Worker Target",
      upstreamUrl: "https://example.test",
      format: "openai",
      enabled: true,
      ...(preferredVendor ? { pricing: { vendor: "openai" } } : {}),
    }],
  }));
}
