import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type {DeepaaDatabase} from "@/lib/db/sqlite-driver";
import type { RawCapturedExchangeV2 } from "../src/lib/harness/types.js";
import { claimNextDerivationJob } from "../src/lib/ingestion/job-repository.js";
import { registerRawRecordAndAdvance } from "../src/lib/ingestion/registrar.js";
import { reconcileProjectionWindow } from "../src/lib/ingestion/retention-sweep.js";
import {
  discoverV2Sources,
  readSourceBatch,
} from "../src/lib/ingestion/raw-source-reader.js";
import {
  clampRawRetentionDays,
  computeRetentionCutoff,
  isBeyondRetentionWindow,
  readRetentionConfig,
  writeRetentionConfig,
} from "../src/lib/retention.js";
import {
  createSqliteFixture,
  type SqliteFixture,
} from "./helpers/sqlite-fixture.js";
import { classifyRawReadGate } from "../src/lib/ingestion/raw-read-gate.js";
import {
  openWorkbenchRawInspectorBodyResponse,
  WorkbenchRawInspectorError,
} from "../src/lib/workbench-raw-inspector.js";
import { writeRetentionConfig } from "../src/lib/retention.js";

/**
 * 上线前架构升级改造 P0-3/P0-4（docs/上线前架构升级改造.md）：
 * - 派生顺序：文件级最新优先、文件内正序；
 * - 30 天投影窗口：登记过滤 + 单向出窗撤销扫描（调大窗口不补投影，2026-09-21 确认）。
 */

const fixtures: SqliteFixture[] = [];

async function withFixture(
  run: (fixture: SqliteFixture) => void | Promise<void>,
): Promise<void> {
  const fixture = await createSqliteFixture();
  fixtures.push(fixture);
  await run(fixture);
}

test("retention 配置 clamp、缺省回退与窗口计算", async () => {
  await withFixture(async fixture => {
    assert.deepEqual(readRetentionConfig(fixture.dataDir), {
      version: 1,
      rawRetentionDays: 180,
    });
    assert.equal(clampRawRetentionDays(1), 3);
    assert.equal(clampRawRetentionDays(2), 3);
    assert.equal(clampRawRetentionDays(9999), 180);
    assert.equal(clampRawRetentionDays("31"), 31);
    assert.equal(clampRawRetentionDays("not-a-number"), 15);
    const written = writeRetentionConfig(fixture.dataDir, 45);
    assert.equal(written.rawRetentionDays, 45);
    assert.equal(readRetentionConfig(fixture.dataDir).rawRetentionDays, 45);
    const cutoff = computeRetentionCutoff(30, Date.UTC(2026, 8, 14));
    assert.equal(cutoff, "2026-08-15T00:00:00.000Z");
    assert.equal(isBeyondRetentionWindow("2026-08-14T23:59:59.000Z", cutoff), true);
    assert.equal(isBeyondRetentionWindow("2026-08-15T00:00:00.000Z", cutoff), false);
    // 非法时间戳按「未超窗」处理（宁可多投影，不可误丢弃）。
    assert.equal(isBeyondRetentionWindow("not-a-date", cutoff), false);
  });
});

interface RegisteredSource {
  sourceId: number;
  relativePath: string;
  fileId: string;
  generation: number;
}

async function registerRecords(
  db: DeepaaDatabase,
  dataDir: string,
  fileName: string,
  records: RawCapturedExchangeV2[],
  options: {retentionCutoff?: string} = {},
): Promise<RegisteredSource> {
  const captureDir = join(dataDir, "captures", "v2");
  await mkdir(captureDir, {recursive: true});
  const filePath = join(captureDir, fileName);
  await writeFile(
    filePath,
    `${records.map(record => JSON.stringify(record)).join("\n")}\n`,
    "utf8",
  );
  await discoverV2Sources(db, dataDir);
  const batch = await readSourceBatch(db, filePath, {
    maxRecords: records.length,
    maxBytes: 16 * 1024 * 1024,
    maxLineBytes: 8 * 1024 * 1024,
  });
  db.prepare(
    `INSERT INTO worker_lease(id, owner_id, expires_at)
     VALUES(1, 'retention-owner', '2999-01-01T00:00:00.000Z')
     ON CONFLICT(id) DO UPDATE SET
       owner_id = excluded.owner_id, expires_at = excluded.expires_at`,
  ).run();
  let byteOffset = batch.startOffset;
  for (const entry of batch.entries) {
    if (entry.kind !== "record") throw new Error("fixture 行必须是合法 record");
    const lineEnd = entry.byteOffset + entry.lineLengthBytes;
    registerRawRecordAndAdvance(db, {
      sourceId: batch.sourceId,
      sourceRelativePath: batch.relativePath,
      sourceFileId: batch.fileId,
      sourceGeneration: batch.sourceGeneration,
      record: entry,
      cursor: {
        sourceId: batch.sourceId,
        relativePath: batch.relativePath,
        fileId: batch.fileId,
        generation: batch.sourceGeneration,
        expectedFileSize: batch.sourceFileSize,
        nextFileSize: batch.fileSize,
        expectedByteOffset: byteOffset,
        expectedScanOffset: byteOffset,
        nextByteOffset: lineEnd,
        nextScanOffset: lineEnd,
        processedCount: 1,
      },
      leaseOwnerId: "retention-owner",
      projectionVersion: 5,
      retentionCutoff: options.retentionCutoff,
    });
    byteOffset = lineEnd;
  }
  return {
    sourceId: batch.sourceId,
    relativePath: batch.relativePath,
    fileId: batch.fileId,
    generation: batch.sourceGeneration,
  };
}

function fixtureRecord(
  exchangeId: string,
  sequence: number,
  capturedAt: string,
): RawCapturedExchangeV2 {
  const requestBody = JSON.stringify({
    model: "retention-fixture-model",
    messages: [{role: "user", content: `request-${sequence}`}],
  });
  const responseBody = JSON.stringify({
    id: `message-${sequence}`,
    type: "message",
    role: "assistant",
    model: "retention-fixture-model",
    content: [{type: "text", text: `response-${sequence}`}],
    usage: {input_tokens: 10, output_tokens: 5},
  });
  return {
    schemaVersion: 2,
    exchangeId,
    captureSessionId: `capture-${exchangeId}`,
    sequence,
    capturedAt,
    completedAt: capturedAt,
    durationMs: 25,
    routing: {
      targetId: "target-retention",
      targetName: "Retention Target",
      targetFormatHint: "anthropic",
      localUrl: "http://127.0.0.1:4000/v1/messages",
      upstreamUrl: "https://example.test/v1/messages",
      localPath: "/v1/messages",
      upstreamPath: "/v1/messages",
      method: "POST",
    },
    request: {
      headers: {"content-type": "application/json"},
      rawBody: requestBody,
      bodySizeBytes: Buffer.byteLength(requestBody),
      bodySha256: createHash("sha256").update(requestBody).digest("hex"),
    },
    response: {
      status: 200,
      statusText: "OK",
      headers: {"content-type": "application/json"},
      rawBody: responseBody,
      bodySizeBytes: Buffer.byteLength(responseBody),
      bodySha256: createHash("sha256").update(responseBody).digest("hex"),
      isStreaming: false,
    },
    bodyStorage: {policy: "inline"},
    captureDiagnostics: [],
    security: {
      containsSensitiveHeaders: true,
      headerRedactionAppliedInApi: true,
      rawBodiesStoredLocally: true,
    },
  } satisfies RawCapturedExchangeV2;
}

test("派生领取顺序：文件级最新优先、文件内 byte 正序", async () => {
  await withFixture(async fixture => {
    const oldTime = "2026-01-10T00:00:00.000Z";
    const newTime = "2026-09-13T00:00:00.000Z";
    await registerRecords(fixture.db, fixture.dataDir, "old-file.jsonl", [
      fixtureRecord("ex-old-1", 1, oldTime),
      fixtureRecord("ex-old-2", 2, oldTime),
    ]);
    await registerRecords(fixture.db, fixture.dataDir, "new-file.jsonl", [
      fixtureRecord("ex-new-1", 1, newTime),
      fixtureRecord("ex-new-2", 2, newTime),
    ]);

    const claimed: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      const claim = claimNextDerivationJob(fixture.db, {
        ownerId: "retention-owner",
        afterIngestionRecordId: undefined,
      });
      if (!claim) break;
      claimed.push(claim.exchangeId);
      markSucceeded(fixture.db, claim.ingestionRecordId, claim.projectionVersion);
    }
    // 新文件先派生（文件内 byte 正序），旧文件随后。
    assert.deepEqual(claimed, ["ex-new-1", "ex-new-2", "ex-old-1", "ex-old-2"]);
    // source 新近度落库。
    const recency = fixture.db.prepare(
      `SELECT relative_path, last_captured_at FROM ingestion_sources
       ORDER BY relative_path`,
    ).all() as Array<{relative_path: string; last_captured_at: string}>;
    assert.deepEqual(recency, [
      {relative_path: "captures/v2/new-file.jsonl", last_captured_at: newTime},
      {relative_path: "captures/v2/old-file.jsonl", last_captured_at: oldTime},
    ]);
  });
});

function markSucceeded(
  db: DeepaaDatabase,
  ingestionRecordId: number,
  projectionVersion: number,
): void {
  db.prepare(
    `UPDATE derivation_jobs
     SET job_status = 'succeeded', projection_completeness = 'complete',
       request_verification = 'verified', response_verification = 'verified',
       locked_by = NULL, locked_at = NULL, completed_at = ?, updated_at = ?
     WHERE ingestion_record_id = ? AND projection_version = ?`,
  ).run(
    new Date().toISOString(),
    new Date().toISOString(),
    ingestionRecordId,
    projectionVersion,
  );
}

test("30 天投影窗口：超窗登记 archived 不建 job，扫描单向出窗撤销", async () => {
  await withFixture(async fixture => {
    const cutoff = computeRetentionCutoff(30, Date.UTC(2026, 8, 14));
    const inWindow = "2026-09-10T00:00:00.000Z";
    const outOfWindow = "2026-01-10T00:00:00.000Z";
    await registerRecords(
      fixture.db,
      fixture.dataDir,
      "window.jsonl",
      [
        fixtureRecord("ex-win-old", 1, outOfWindow),
        fixtureRecord("ex-win-new", 2, inWindow),
      ],
      {retentionCutoff: cutoff},
    );

    const states = fixture.db.prepare(
      `SELECT exchange_id, projection_state FROM ingestion_records
       ORDER BY exchange_id`,
    ).all() as Array<{exchange_id: string; projection_state: string}>;
    assert.deepEqual(states, [
      {exchange_id: "ex-win-new", projection_state: "active"},
      {exchange_id: "ex-win-old", projection_state: "archived"},
    ]);
    // 超窗记录没有派生任务；NOT EXISTS 头部阻塞不受「不存在的前序 job」影响。
    const jobCount = fixture.db.prepare(
      `SELECT COUNT(*) AS count FROM derivation_jobs j
       JOIN ingestion_records r ON r.id = j.ingestion_record_id
       WHERE r.exchange_id = 'ex-win-old'`,
    ).get() as {count: number};
    assert.equal(jobCount.count, 0);
    assert.equal(
      (fixture.db.prepare(
        `SELECT COUNT(*) AS count FROM derivation_jobs`,
      ).get() as {count: number}).count,
      1,
    );
    fixture.db.prepare(
      `INSERT INTO relay_pending_ingestions(exchange_id,target_id,completed_at)
       VALUES('ex-win-new','target-retention',?)`,
    ).run(inWindow);

    // 窗口调大：不再重新激活 archived 记录（2026-09-21 用户确认：调整窗口不补投影，
    // 保留窗口只对之后新产生（含晚发现）的数据生效），也不补建派生 job。
    const wideCutoff = "2020-01-01T00:00:00.000Z";
    const wideResult = reconcileProjectionWindow(fixture.db, {
      cutoff: wideCutoff,
      projectionVersion: 5,
    });
    assert.equal(wideResult.archived, 0);
    assert.equal(
      (fixture.db.prepare(
        `SELECT projection_state FROM ingestion_records
         WHERE exchange_id = 'ex-win-old'`,
      ).pluck().get() as string),
      "archived",
    );
    assert.equal(
      (fixture.db.prepare(
        `SELECT COUNT(*) AS count FROM derivation_jobs j
         JOIN ingestion_records r ON r.id = j.ingestion_record_id
         WHERE r.exchange_id = 'ex-win-old'`,
      ).get() as {count: number}).count,
      0,
    );

    // 窗口收回：把 cutoff 收到 2026-09-12，使 ex-win-new（09-10 捕获）也出窗；
    // 其 pending job 被撤销、记录回 archived（单向出窗撤销路径）。
    const narrowCutoff = "2026-09-12T00:00:00.000Z";
    const archived = reconcileProjectionWindow(fixture.db, {
      cutoff: narrowCutoff,
      projectionVersion: 5,
    });
    assert.equal(archived.archived, 1);
    assert.equal(
      (fixture.db.prepare(
        "SELECT COUNT(*) AS count FROM relay_pending_ingestions WHERE exchange_id='ex-win-new'",
      ).get() as {count: number}).count,
      0,
    );
    assert.equal(
      (fixture.db.prepare(
        `SELECT COUNT(*) AS count FROM derivation_jobs`,
      ).get() as {count: number}).count,
      0,
    );
    const finalStates = fixture.db.prepare(
      `SELECT projection_state FROM ingestion_records ORDER BY exchange_id`,
    ).all() as Array<{projection_state: string}>;
    assert.deepEqual(finalStates, [
      {projection_state: "archived"},
      {projection_state: "archived"},
    ]);
  });
});

test("出窗撤销不触碰 succeeded 任务（已进 SQLite 的投影永不撤销）", async () => {
  await withFixture(async fixture => {
    await registerRecords(fixture.db, fixture.dataDir, "done.jsonl", [
      fixtureRecord("ex-done", 1, "2026-09-12T00:00:00.000Z"),
    ]);
    const claim = claimNextDerivationJob(fixture.db, {ownerId: "retention-owner"});
    assert.ok(claim);
    markSucceeded(fixture.db, claim.ingestionRecordId, claim.projectionVersion);

    const narrowCutoff = computeRetentionCutoff(7, Date.UTC(2026, 8, 14));
    const result = reconcileProjectionWindow(fixture.db, {
      cutoff: narrowCutoff,
      projectionVersion: 5,
    });
    assert.equal(result.archived, 0);
    assert.equal(
      (fixture.db.prepare(
        `SELECT job_status FROM derivation_jobs`,
      ).pluck().get() as string),
      "succeeded",
    );
  });
});

test("raw 读取门禁：active/expired/purged 三态与 Inspector 410 结构化状态", async () => {
  await withFixture(async fixture => {
    writeRetentionConfig(fixture.dataDir, 7);
    const now = new Date().toISOString();
    fixture.db.prepare(
      `INSERT INTO ingestion_sources(relative_path, file_id, file_size, updated_at)
       VALUES('captures/v2/gate.jsonl', 'gate-file', 0, ?)`,
    ).run(now);
    const sourceId = fixture.db.prepare(
      `SELECT id FROM ingestion_sources WHERE relative_path = 'captures/v2/gate.jsonl'`,
    ).pluck().get() as number;
    const insert = fixture.db.prepare(
      `INSERT INTO raw_exchange_refs(
        exchange_id, capture_session_id, source_id, byte_offset, line_length_bytes,
        captured_at, completed_at, target_id, target_name, agent_name,
        agent_fingerprint_id, status, is_streaming,
        request_body_bytes, response_body_bytes, raw_state
      ) VALUES(?, ?, ?, 0, 1, ?, ?, 't', 'T', 'codex', 'fp', 200, 0, 10, 10, ?)`,
    );
    insert.run("ex-gate-active", "cs", sourceId, now, now, "active");
    insert.run(
      "ex-gate-expired", "cs", sourceId,
      new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
      new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
      "active",
    );
    insert.run("ex-gate-purged", "cs", sourceId, now, now, "purged");

    assert.equal(classifyRawReadGate(fixture.db, fixture.dataDir, "ex-gate-active")?.state, "active");
    assert.equal(classifyRawReadGate(fixture.db, fixture.dataDir, "ex-gate-expired")?.state, "expired");
    assert.equal(classifyRawReadGate(fixture.db, fixture.dataDir, "ex-gate-purged")?.state, "purged");
    assert.equal(classifyRawReadGate(fixture.db, fixture.dataDir, "ex-gate-missing"), undefined);

    // Inspector 单侧正文入口：门禁先行，返回 410 + 稳定错误码，不读任何 raw 字节。
    for (const [exchangeId, code] of [
      ["ex-gate-purged", "raw_purged"],
      ["ex-gate-expired", "raw_expired"],
    ] as const) {
      const response = await openWorkbenchRawInspectorBodyResponse({
        db: fixture.db,
        dataDir: fixture.dataDir,
        exchangeId,
        side: "request",
      });
      assert.equal(response.status, 410);
      const payload = (await response.json()) as {
        error: {code: string; message: string};
      };
      assert.equal(payload.error.code, code);
      assert.match(payload.error.message, /保留策略清理|保留窗口/);
    }

    // active 且窗内：不受门禁影响（走后续 not-found 路径也证明门禁放行）。
    const passthrough = await openWorkbenchRawInspectorBodyResponse({
      db: fixture.db,
      dataDir: fixture.dataDir,
      exchangeId: "ex-gate-active",
      side: "request",
    });
    assert.notEqual(passthrough.status, 410);

    // 异常抛出形态同样带稳定错误码（元数据入口内部使用）。
    await assert.rejects(
      () => import("../src/lib/workbench-raw-inspector.js").then(module =>
        module.loadWorkbenchRawInspectorMetadata(
          fixture.db,
          fixture.dataDir,
          "ex-gate-purged",
          "request",
        ),
      ),
      (error: unknown) =>
        error instanceof WorkbenchRawInspectorError
        && error.code === "raw_purged"
        && error.status === 410,
    );
  });
});

test("一键清除超窗 raw：文件级清理、账本/Step 保留、墓碑与 blob GC、幂等", async () => {
  await withFixture(async fixture => {
    const {utimes} = await import("node:fs/promises");
    const {createHash} = await import("node:crypto");
    const {existsSync} = await import("node:fs");
    const {
      previewRawPurge,
      executeRawPurge,
    } = await import("../src/lib/ingestion/raw-purge.js");
    const {
      derivedArtifactPath,
      placeDerivedArtifact,
    } = await import("../src/lib/ingestion/derived-artifact-store.js");

    writeRetentionConfig(fixture.dataDir, 7);
    const oldTime = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
    const newTime = new Date().toISOString();
    const oldSource = await registerRecords(fixture.db, fixture.dataDir, "purge-old.jsonl", [
      fixtureRecord("ex-purge-1", 1, oldTime),
      fixtureRecord("ex-purge-2", 2, oldTime),
    ]);
    await registerRecords(fixture.db, fixture.dataDir, "keep-new.jsonl", [
      fixtureRecord("ex-keep-1", 1, newTime),
    ]);

    // raw_exchange_refs + 最小层级脚手架（session/thread/turn/step/ledger）。
    const insertRef = fixture.db.prepare(
      `INSERT INTO raw_exchange_refs(
        exchange_id, capture_session_id, source_id, byte_offset, line_length_bytes,
        captured_at, completed_at, target_id, target_name, agent_name,
        agent_fingerprint_id, status, is_streaming,
        request_body_bytes, response_body_bytes
      ) VALUES(?, ?, ?, 0, 100, ?, ?, 't', 'T', 'codex', 'fp', 200, 0, 10, 10)`,
    );
    insertRef.run("ex-purge-1", "cs-old", oldSource.sourceId, oldTime, oldTime);
    insertRef.run("ex-purge-2", "cs-old", oldSource.sourceId, oldTime, oldTime);
    insertRef.run("ex-keep-1", "cs-new", oldSource.sourceId + 1, newTime, newTime);
    // 保留侧 ref 关联登记（模拟真实派生写入；purge 只断开被清理侧）。
    fixture.db.prepare(
      `UPDATE raw_exchange_refs SET ingestion_record_id = (
         SELECT ir.id FROM ingestion_records ir WHERE ir.exchange_id = raw_exchange_refs.exchange_id
       ) WHERE exchange_id = 'ex-keep-1'`,
    ).run();

    fixture.db.prepare(
      `INSERT INTO agent_sessions(id, target_id, target_name, agent_fingerprint_id,
        agent_name, source, confidence, start_time, end_time)
       VALUES('sess', 't', 'T', 'fp', 'codex', 'test', 'high', ?, ?)`,
    ).run(oldTime, newTime);
    fixture.db.prepare(
      `INSERT INTO agent_threads(id, agent_session_id, source, display_name,
        confidence, is_root, is_placeholder, start_time, end_time)
       VALUES('thread', 'sess', 'test', 't', 'high', 1, 0, ?, ?)`,
    ).run(oldTime, newTime);
    fixture.db.prepare(
      `INSERT INTO agent_turns(id, agent_session_id, agent_thread_id, source,
        confidence, status, segment_index, start_exchange_id, start_time, end_time)
       VALUES('turn', 'sess', 'thread', 'test', 'high', 'closed', 1, 'ex-purge-1', ?, ?)`,
    ).run(oldTime, newTime);
    const insertStep = fixture.db.prepare(
      `INSERT INTO agent_steps(id, exchange_id, agent_session_id, agent_thread_id,
        agent_turn_id, step_index, timestamp, phase, request_action, response_action)
       VALUES(?, ?, 'sess', 'thread', 'turn', ?, ?, 'model', 'chat', 'reply')`,
    );
    insertStep.run("step-1", "ex-purge-1", 1, oldTime);
    insertStep.run("step-2", "ex-purge-2", 2, oldTime);
    insertStep.run("step-keep", "ex-keep-1", 3, newTime);
    const insertLedger = fixture.db.prepare(
      `INSERT INTO usage_ledger(exchange_id, agent_session_id, agent_thread_id,
        agent_turn_id, agent_step_id, target_id, agent_fingerprint_id, agent_name,
        model, vendor, rate_multiplier, input_tokens, cache_read_tokens,
        cache_write_tokens, output_tokens, reasoning_tokens, total_tokens,
        currency, vendor_cost, actual_cost, fx_rate_to_cny, duration_ms,
        pricing_snapshot_json, request_kind, result_class, usage_source,
        usage_confidence, usage_quality, pricing_status, audit_eligible,
        total_tokens_basis, reasoning_semantics, reference_cost_status, cost_basis,
        money_scale, latency_source, duration_sample_eligible, ledger_version,
        token_semantics_version, projection_version, created_at)
       VALUES(?, 'sess', 'thread', 'turn', ?, 't', 'fp', 'codex', 'm', 'v', 1,
        10, 0, 0, 5, 0, 15,
        'CNY', 0.1, 0.1, 1, 25, '{}', 'model', 'ok', 'response', 'high', 'ok', 'ok', 1,
        'sum', 'none', 'none', 'vendor', 6, 'none', 1, 1, 1, 1, ?)`,
    );
    insertLedger.run("ex-purge-1", "step-1", oldTime);
    insertLedger.run("ex-purge-2", "step-2", oldTime);

    // 外置派生物 + 预览/指纹（应随清理删除/墓碑）。
    const artifactJson = JSON.stringify({snapshot: {big: "z".repeat(32 * 1024)}});
    const placement = placeDerivedArtifact(fixture.dataDir, artifactJson);
    assert.equal(placement.storage, "external");
    assert.ok(existsSync(derivedArtifactPath(fixture.dataDir, placement.hash!)));
    fixture.db.prepare(
      `INSERT INTO context_snapshots(agent_step_id, summary_json, size_bytes,
        artifact_storage, artifact_hash, artifact_size)
       VALUES('step-1', ?, ?, 'external', ?, ?)`,
    ).run(
      JSON.stringify({artifact: "external"}),
      placement.sizeBytes,
      placement.hash,
      placement.sizeBytes,
    );
    fixture.db.prepare(
      `INSERT INTO exchange_content_previews(exchange_id, projection_version,
        preview_state, preview_json, size_bytes, candidate_item_count,
        processed_item_count, candidate_text_bytes, processed_text_bytes,
        candidate_count_exact, limited, truncated, created_at, updated_at)
       VALUES('ex-purge-1', 5, 'complete', '{}', 2, 0, 0, 0, 0, 1, 0, 0, ?, ?)`,
    ).run(oldTime, oldTime);
    fixture.db.prepare(
      `INSERT INTO exchange_request_fingerprints(exchange_id, body_side, category,
        fingerprint, provider_lineage_key, occurrence_count)
       VALUES('ex-purge-1', 'request', 'user_real', x'${"ab".repeat(32)}', 'k', 1)`,
    ).run();

    // external blob：老 source 的 request body 声明 external-blob。
    const blobHash = createHash("sha256").update("old-blob").digest("hex");
    fixture.db.prepare(
      `UPDATE ingestion_records SET request_body_storage = 'external-blob',
        request_body_sha256 = ? WHERE source_id = ? AND exchange_id = 'ex-purge-1'`,
    ).run(blobHash, oldSource.sourceId);
    const {mkdir, writeFile} = await import("node:fs/promises");
    const blobPath = join(fixture.dataDir, "blobs", blobHash.slice(0, 2), `${blobHash}.body.gz`);
    await mkdir(join(fixture.dataDir, "blobs", blobHash.slice(0, 2)), {recursive: true});
    await writeFile(blobPath, "fake-gz");
    assert.ok(existsSync(blobPath));

    // 所有 job 置为 succeeded（模拟已完成派生）。
    for (const row of fixture.db.prepare(
      `SELECT j.ingestion_record_id AS id, j.projection_version AS version
       FROM derivation_jobs j`,
    ).all() as Array<{id: number; version: number}>) {
      markSucceeded(fixture.db, row.id, row.version);
    }

    // 老 capture 文件 mtime 回拨到 40 天前（越过 24h 活跃安全期）。
    const oldFilePath = join(fixture.dataDir, "captures", "v2", "purge-old.jsonl");
    const backdated = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    await utimes(oldFilePath, backdated, backdated);

    const preview = await previewRawPurge(fixture.db, fixture.dataDir);
    assert.equal(preview.candidates.length, 1);
    assert.equal(preview.candidates[0]!.relativePath, "captures/v2/purge-old.jsonl");
    assert.equal(preview.candidates[0]!.exchangeCount, 2);
    assert.ok(preview.skipped.some(item =>
      item.relativePath === "captures/v2/keep-new.jsonl" && item.reason === "mixed_window"));
    assert.ok(preview.reclaimableBytes.captureFiles > 0);
    assert.ok(preview.reclaimableBytes.derivedArtifacts > 0);

    const result = await executeRawPurge(fixture.db, fixture.dataDir);
    assert.deepEqual(result.errors, []);
    assert.equal(result.purgedFiles.length, 1);
    assert.equal(!existsSync(oldFilePath), true, "老 capture 文件应被删除");
    assert.equal(existsSync(join(fixture.dataDir, "captures", "v2", "keep-new.jsonl")), true);

    // 墓碑与保留不变量。
    assert.deepEqual(
      fixture.db.prepare(
        `SELECT exchange_id, raw_state, ingestion_record_id FROM raw_exchange_refs
         ORDER BY exchange_id`,
      ).all(),
      [
        {exchange_id: "ex-keep-1", raw_state: "active", ingestion_record_id: numberOrNull("keep")},
        {exchange_id: "ex-purge-1", raw_state: "purged", ingestion_record_id: null},
        {exchange_id: "ex-purge-2", raw_state: "purged", ingestion_record_id: null},
      ].map(item => ({
        exchange_id: item.exchange_id,
        raw_state: item.raw_state,
        ingestion_record_id: item.exchange_id === "ex-keep-1" ? item.ingestion_record_id : null,
      })),
    );
    assert.equal(
      fixture.db.prepare(`SELECT COUNT(*) AS count FROM agent_steps`).pluck().get(),
      3,
      "Step 永不删除",
    );
    assert.equal(
      fixture.db.prepare(`SELECT COUNT(*) AS count FROM usage_ledger`).pluck().get(),
      2,
      "账本永不删除",
    );
    assert.equal(
      fixture.db.prepare(
        `SELECT COUNT(*) AS count FROM exchange_content_previews`,
      ).pluck().get(),
      0,
      "raw 直接派生预览随清理删除",
    );
    assert.equal(
      fixture.db.prepare(
        `SELECT COUNT(*) AS count FROM exchange_request_fingerprints`,
      ).pluck().get(),
      0,
    );
    assert.equal(
      fixture.db.prepare(
        `SELECT artifact_hash FROM context_snapshots WHERE agent_step_id = 'step-1'`,
      ).pluck().get(),
      null,
      "派生物墓碑清空 artifact_hash",
    );
    assert.equal(!existsSync(derivedArtifactPath(fixture.dataDir, placement.hash!)), true, "外置派生物被 GC");
    assert.equal(!existsSync(blobPath), true, "无引用 external blob 被 GC");
    assert.equal(
      fixture.db.prepare(
        `SELECT COUNT(*) AS count FROM ingestion_records ir
         JOIN ingestion_sources s ON s.id = ir.source_id
         WHERE s.relative_path = 'captures/v2/purge-old.jsonl'`,
      ).pluck().get(),
      0,
      "老 source 的登记被删除",
    );
    assert.equal(
      fixture.db.prepare(
        `SELECT status FROM ingestion_sources
         WHERE relative_path = 'captures/v2/purge-old.jsonl'`,
      ).pluck().get(),
      "purged",
    );

    // 幂等：再次执行无可清理文件、无错误。
    const second = await executeRawPurge(fixture.db, fixture.dataDir);
    assert.deepEqual(second.purgedFiles, []);
    assert.deepEqual(second.errors, []);

    function numberOrNull(_tag: string): number | null {
      return fixture.db.prepare(
        `SELECT ir.id FROM ingestion_records ir
         JOIN raw_exchange_refs r ON r.ingestion_record_id = ir.id
         WHERE r.exchange_id = 'ex-keep-1'`,
      ).pluck().get() as number;
    }
  });
});

test("本地导入大正文先外置后落盘：行内只留 rawBodyRef、blob 落盘（顺序红线）", async () => {
  await withFixture(async fixture => {
    const {existsSync, readFileSync} = await import("node:fs");
    const {readdir} = await import("node:fs/promises");
    const {
      materializeLargeBodies,
      ImportCaptureFileWriter,
      SYNTHETIC_INLINE_THRESHOLD_BYTES,
    } = await import("../src/lib/agent-local-source/synthetic-capture.js");

    const bigBody = "z".repeat(SYNTHETIC_INLINE_THRESHOLD_BYTES + 1024);
    const exchange = fixtureRecord("import-order-big", 1, new Date().toISOString());
    exchange.request.rawBody = JSON.stringify({messages: [{role: "user", content: bigBody}]});
    exchange.request.bodySizeBytes = Buffer.byteLength(exchange.request.rawBody);
    exchange.request.bodySha256 = createHash("sha256").update(exchange.request.rawBody).digest("hex");

    // 与调度器相同的顺序：先外置、再落盘（2026-09-21 双重存储修复）。
    await materializeLargeBodies(fixture.dataDir, [exchange]);
    const writer = new ImportCaptureFileWriter(fixture.dataDir, "zcode");
    await writer.appendBatch([exchange]);

    const importFiles = (await readdir(join(fixture.dataDir, "captures", "v2")))
      .filter(name => name.startsWith("import-zcode-"));
    assert.equal(importFiles.length, 1);
    const line = JSON.parse(
      readFileSync(join(fixture.dataDir, "captures", "v2", importFiles[0]), "utf8"),
    ) as {
      request: {rawBody?: string; rawBodyRef?: {storage: string; externalPath: string}};
      bodyStorage: {policy: string};
    };
    assert.equal(line.request.rawBody, undefined, "落盘行不得再保留明文大正文");
    assert.equal(line.request.rawBodyRef?.storage, "external-blob");
    assert.equal(line.bodyStorage.policy, "external-blob");
    assert.equal(
      existsSync(join(fixture.dataDir, line.request.rawBodyRef!.externalPath)),
      true,
      "外置 blob 必须落盘",
    );

    // 外置后的行必须能原样通过真实登记管线（v2 深度校验 + external-blob 契约），
    // 登记为 external-blob 且哈希与 blob 一致——与代理大正文路径完全等价。
    await registerRecords(fixture.db, fixture.dataDir, "import-order-reg.jsonl", [exchange]);
    const registered = fixture.db.prepare(
      `SELECT request_body_storage, request_body_sha256 FROM ingestion_records
       WHERE exchange_id = 'import-order-big'`,
    ).get() as {request_body_storage: string; request_body_sha256: string};
    assert.equal(registered.request_body_storage, "external-blob");
    assert.equal(registered.request_body_sha256, line.request.rawBodyRef!.sha256);
  });
});

test("导入调度器外置先于落盘（源码顺序守卫）", async () => {
  const {readFileSync} = await import("node:fs");
  const source = readFileSync(
    join("src", "lib", "agent-local-source", "local-import-scheduler.ts"),
    "utf8",
  );
  const materializeAt = source.indexOf("await materializeLargeBodies(dataDir, filteredExchanges);");
  const appendAt = source.indexOf("await writer.appendBatch(filteredExchanges);");
  assert.ok(materializeAt >= 0, "必须调用 materializeLargeBodies");
  assert.ok(appendAt >= 0, "必须调用 writer.appendBatch");
  assert.ok(
    materializeAt < appendAt,
    "必须先外置大正文、再写 capture 文件（2026-09-21 双重存储修复的顺序红线）",
  );
});

test("孤儿外部件清扫：无引用且超活跃安全期的 blob/派生物被回收，引用与新增的保留", async () => {
  await withFixture(async fixture => {
    const {utimes} = await import("node:fs/promises");
    const {existsSync} = await import("node:fs");
    const {previewRawPurge, executeRawPurge} = await import("../src/lib/ingestion/raw-purge.js");
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    const now = new Date().toISOString();

    const refHash = createHash("sha256").update("referenced").digest("hex");
    const orphanHash = createHash("sha256").update("orphan").digest("hex");
    const freshHash = createHash("sha256").update("fresh-orphan").digest("hex");
    const writeBlob = async (hash: string, mtime?: Date) => {
      const dir = join(fixture.dataDir, "blobs", hash.slice(0, 2));
      await mkdir(dir, {recursive: true});
      const path = join(dir, `${hash}.body.gz`);
      await writeFile(path, "fake-gz");
      if (mtime) await utimes(path, mtime, mtime);
    };
    await writeBlob(refHash, old);
    await writeBlob(orphanHash, old);
    await writeBlob(freshHash);

    const artifactRefHash = createHash("sha256").update("artifact-referenced").digest("hex");
    const artifactOrphanHash = createHash("sha256").update("artifact-orphan").digest("hex");
    const writeArtifact = async (hash: string, mtime?: Date) => {
      const dir = join(fixture.dataDir, "derived-blobs", hash.slice(0, 2));
      await mkdir(dir, {recursive: true});
      const path = join(dir, `${hash}.json.gz`);
      await writeFile(path, "fake-gz");
      if (mtime) await utimes(path, mtime, mtime);
    };
    await writeArtifact(artifactRefHash, old);
    await writeArtifact(artifactOrphanHash, old);

    // 引用链：登记行持有 blob 哈希；上下文快照持有派生物哈希。
    fixture.db.prepare(
      `INSERT INTO ingestion_sources(relative_path, file_id, file_size, updated_at)
       VALUES('captures/v2/orphan-ref.jsonl', 'orphan-ref-file', 0, ?)`,
    ).run(now);
    const sourceId = fixture.db.prepare(
      `SELECT id FROM ingestion_sources WHERE relative_path = 'captures/v2/orphan-ref.jsonl'`,
    ).pluck().get() as number;
    fixture.db.prepare(
      `INSERT INTO raw_exchange_refs(
         exchange_id, capture_session_id, source_id, byte_offset, line_length_bytes,
         captured_at, completed_at, target_id, target_name, agent_name,
         agent_fingerprint_id, status, is_streaming,
         request_body_bytes, response_body_bytes
       ) VALUES('ex-orphan-ref', 'cs-orphan', ?, 0, 19, ?, ?, 't', 'T', 'codex', 'fp', 200, 0, 10, 0)`,
    ).run(sourceId, now, now);
    fixture.db.prepare(
      `INSERT INTO ingestion_records(
         exchange_id, source_id, source_generation, source_file_id, byte_offset,
         line_length_bytes, line_sha256, schema_version, captured_at, completed_at,
         request_body_bytes, response_body_bytes, request_body_sha256, response_body_sha256,
         request_body_storage, response_body_storage, request_body_state, response_body_state,
         registered_at
       ) VALUES('ex-orphan-ref', ?, 1, 'orphan-ref-file', 0, 19, ?, 2, ?, ?, 10, 0, ?, ?,
         'external-blob', 'none', 'available', 'empty', ?)`,
    ).run(
      sourceId,
      "a".repeat(64),
      now,
      now,
      refHash,
      "e".repeat(64),
      now,
    );
    fixture.db.prepare(
      `INSERT INTO agent_sessions(id, target_id, target_name, agent_fingerprint_id,
         agent_name, source, confidence, start_time, end_time)
       VALUES('sess-orphan', 't', 'T', 'fp', 'codex', 'test', 'high', ?, ?)`,
    ).run(now, now);
    fixture.db.prepare(
      `INSERT INTO agent_threads(id, agent_session_id, source, display_name,
         confidence, is_root, is_placeholder, start_time, end_time)
       VALUES('thread-orphan', 'sess-orphan', 'test', 't', 'high', 1, 0, ?, ?)`,
    ).run(now, now);
    fixture.db.prepare(
      `INSERT INTO agent_turns(id, agent_session_id, agent_thread_id, source,
         confidence, status, segment_index, start_exchange_id, start_time, end_time)
       VALUES('turn-orphan', 'sess-orphan', 'thread-orphan', 'test', 'high', 'closed', 1,
         'ex-orphan-ref', ?, ?)`,
    ).run(now, now);
    fixture.db.prepare(
      `INSERT INTO agent_steps(id, exchange_id, agent_session_id, agent_thread_id,
         agent_turn_id, step_index, timestamp, phase, request_action, response_action)
       VALUES('step-orphan', 'ex-orphan-ref', 'sess-orphan', 'thread-orphan', 'turn-orphan',
         1, ?, 'model', 'chat', 'reply')`,
    ).run(now);
    fixture.db.prepare(
      `INSERT INTO context_snapshots(agent_step_id, summary_json, size_bytes,
         artifact_storage, artifact_hash, artifact_size)
       VALUES('step-orphan', '{}', 2, 'external', ?, 2)`,
    ).run(artifactRefHash);

    const preview = await previewRawPurge(fixture.db, fixture.dataDir);
    assert.equal(preview.orphanReclaim.blobFileCount, 1);
    assert.equal(preview.orphanReclaim.artifactFileCount, 1);
    assert.ok(preview.orphanReclaim.bytes > 0);

    const result = await executeRawPurge(fixture.db, fixture.dataDir);
    assert.deepEqual(result.errors, []);
    assert.equal(result.deletedOrphanBlobFiles, 1);
    assert.equal(result.deletedOrphanArtifactFiles, 1);
    assert.equal(
      existsSync(join(fixture.dataDir, "blobs", refHash.slice(0, 2), `${refHash}.body.gz`)),
      true,
      "引用中的 blob 必须保留",
    );
    assert.equal(
      existsSync(join(fixture.dataDir, "blobs", freshHash.slice(0, 2), `${freshHash}.body.gz`)),
      true,
      "活跃安全期内的孤儿保留（可能正被写入方引用）",
    );
    assert.equal(
      existsSync(join(fixture.dataDir, "blobs", orphanHash.slice(0, 2), `${orphanHash}.body.gz`)),
      false,
      "超期孤儿 blob 应被回收",
    );
    assert.equal(
      existsSync(join(fixture.dataDir, "derived-blobs", artifactOrphanHash.slice(0, 2), `${artifactOrphanHash}.json.gz`)),
      false,
      "超期孤儿派生物应被回收",
    );
    assert.equal(
      existsSync(join(fixture.dataDir, "derived-blobs", artifactRefHash.slice(0, 2), `${artifactRefHash}.json.gz`)),
      true,
      "引用中的派生物必须保留",
    );
  });
});

test("零登记重复副本可整文件清理；未扫描文件与合成数据源跳过", async () => {
  await withFixture(async fixture => {
    const {utimes} = await import("node:fs/promises");
    const {existsSync, statSync} = await import("node:fs");
    const {
      previewRawPurge,
      executeRawPurge,
    } = await import("../src/lib/ingestion/raw-purge.js");
    const {sourceFileId} = await import("../src/lib/ingestion/raw-source-reader.js");
    writeRetentionConfig(fixture.dataDir, 7);

    const captureDir = join(fixture.dataDir, "captures", "v2");
    await mkdir(captureDir, {recursive: true});
    const now = new Date().toISOString();
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    const insertSource = fixture.db.prepare(
      `INSERT INTO ingestion_sources(relative_path, file_id, file_size,
         byte_offset, scan_offset, status, updated_at)
       VALUES(?, ?, ?, ?, ?, 'ready', ?)`,
    );

    // A. 扫描完毕的零登记重复副本（如本地导入 exchangeId 幂等去重后的文件）：可清。
    const dupPath = join(captureDir, "import-zcode-dup.jsonl");
    await writeFile(dupPath, "{\"schemaVersion\":2}\n", "utf8");
    await utimes(dupPath, old, old);
    const dupInfo = statSync(dupPath);
    insertSource.run(
      "captures/v2/import-zcode-dup.jsonl",
      sourceFileId(dupInfo.dev, dupInfo.ino),
      dupInfo.size,
      dupInfo.size,
      dupInfo.size,
      now,
    );

    // B. 尚未扫描的文件（游标未到文件尾）：跳过 no_records，不得删除。
    const freshPath = join(captureDir, "not-scanned.jsonl");
    await writeFile(freshPath, "{\"schemaVersion\":2}\n", "utf8");
    await utimes(freshPath, old, old);
    const freshInfo = statSync(freshPath);
    insertSource.run(
      "captures/v2/not-scanned.jsonl",
      sourceFileId(freshInfo.dev, freshInfo.ino),
      freshInfo.size,
      0,
      0,
      now,
    );

    // C. 对账补差合成数据源（非捕获文件）：跳过 non_capture_source。
    fixture.db.prepare(
      `INSERT INTO ingestion_sources(relative_path, file_id, file_size, updated_at)
       VALUES('reconciliation://synthetic', 'synthetic', 0, ?)`,
    ).run(now);

    const preview = await previewRawPurge(fixture.db, fixture.dataDir);
    assert.deepEqual(
      preview.candidates.map(candidate => candidate.relativePath),
      ["captures/v2/import-zcode-dup.jsonl"],
    );
    assert.ok(preview.skipped.some(item =>
      item.relativePath === "captures/v2/not-scanned.jsonl" && item.reason === "no_records"));
    assert.ok(preview.skipped.some(item =>
      item.relativePath === "reconciliation://synthetic" && item.reason === "non_capture_source"));

    const result = await executeRawPurge(fixture.db, fixture.dataDir);
    assert.deepEqual(result.errors, []);
    assert.equal(!existsSync(dupPath), true, "零登记重复副本文件应被删除");
    assert.equal(existsSync(freshPath), true, "未扫描文件必须保留");
    assert.equal(
      fixture.db.prepare(
        `SELECT status FROM ingestion_sources
         WHERE relative_path = 'captures/v2/import-zcode-dup.jsonl'`,
      ).pluck().get(),
      "purged",
    );
  });
});
