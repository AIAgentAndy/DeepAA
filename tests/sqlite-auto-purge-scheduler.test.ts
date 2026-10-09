import assert from "node:assert/strict";
import { existsSync, statSync } from "node:fs";
import { mkdir, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type {DeepaaDatabase} from "@/lib/db/sqlite-driver";
import {
  isDerivationIdle,
  readAutoPurgeState,
  requestIdlePurgeSoon,
  resolveAutoPurgeTrigger,
  runAutoPurgeOnce,
  startAutoPurgeScheduler,
} from "../src/lib/ingestion/purge-scheduler.js";
import { sourceFileId } from "../src/lib/ingestion/raw-source-reader.js";
import { writeRetentionConfig } from "../src/lib/retention.js";
import { createSqliteFixture, type SqliteFixture } from "./helpers/sqlite-fixture.js";

/**
 * 存储自动清理调度器（2026-09-21 用户确认）：
 * - 每日一次（本地 02:00 后首个空闲时刻）+ 保留窗口调整后当日空闲即清；
 * - 清理复用 raw-purge 闭环（整文件粒度、墓碑、增量回收）；
 * - 运行结果落盘 config/auto-purge-state.json 供 /api/storage 与弹窗展示。
 */

async function withFixture(
  run: (fixture: SqliteFixture) => Promise<void> | void,
): Promise<void> {
  const fixture = await createSqliteFixture();
  try {
    await run(fixture);
  } finally {
    await fixture.cleanup();
  }
}

async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error("等待调度器状态超时");
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

/** 构造一个完全超窗、可被整文件清理的 source（文件 + 登记行 + exchange 墓碑前态）。 */
async function seedPurgeableSource(
  fixture: SqliteFixture,
  fileName: string,
  capturedAt: string,
): Promise<{relativePath: string; filePath: string}> {
  const captureDir = join(fixture.dataDir, "captures", "v2");
  await mkdir(captureDir, {recursive: true});
  const filePath = join(captureDir, fileName);
  await writeFile(filePath, "{\"schemaVersion\":2}\n", "utf8");
  // mtime 必须早于 24h 活跃安全期，否则 purge 按 recently_modified 跳过。
  const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
  await utimes(filePath, old, old);
  const info = statSync(filePath);
  const relativePath = `captures/v2/${fileName}`;
  const now = new Date().toISOString();
  fixture.db.prepare(
    `INSERT INTO ingestion_sources(relative_path, file_id, file_size, updated_at)
     VALUES(?, ?, ?, ?)`,
  ).run(relativePath, sourceFileId(info.dev, info.ino), info.size, now);
  const sourceId = fixture.db.prepare(
    `SELECT id FROM ingestion_sources WHERE relative_path = ?`,
  ).pluck().get(relativePath) as number;
  fixture.db.prepare(
    `INSERT INTO raw_exchange_refs(
       exchange_id, capture_session_id, source_id, byte_offset, line_length_bytes,
       captured_at, completed_at, target_id, target_name, agent_name,
       agent_fingerprint_id, status, is_streaming,
       request_body_bytes, response_body_bytes, raw_state
     ) VALUES(?, ?, ?, 0, 19, ?, ?, 't', 'T', 'codex', 'fp', 200, 0, 10, 10, 'active')`,
  ).run(`ex-${fileName}`, "cs", sourceId, capturedAt, capturedAt);
  return {relativePath, filePath};
}

test("触发判定：每日 00:00 后执行一次；请求标记优先且不受时刻与当日已执行限制", () => {
  const today = "2026-09-21";
  const at = (hour: number, minute = 30) => new Date(2026, 8, 21, hour, minute);
  assert.equal(resolveAutoPurgeTrigger({lastDailyRunDate: undefined, requested: false, now: at(0, 1)}), "daily");
  assert.equal(resolveAutoPurgeTrigger({lastDailyRunDate: undefined, requested: false, now: at(5)}), "daily");
  assert.equal(resolveAutoPurgeTrigger({lastDailyRunDate: today, requested: false, now: at(5)}), null);
  // 当日已例行过，窗口调整请求仍会再次触发一次空闲执行。
  assert.equal(resolveAutoPurgeTrigger({lastDailyRunDate: today, requested: true, now: at(0, 1)}), "retention-change");
  assert.equal(resolveAutoPurgeTrigger({lastDailyRunDate: undefined, requested: true, now: at(5)}), "retention-change");
});

test("空闲判定：pending/running 阻塞清理，retry_wait 与空队列不阻塞", async () => {
  await withFixture(async fixture => {
    const db: DeepaaDatabase = fixture.db;
    assert.equal(isDerivationIdle(db), true);
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO ingestion_sources(relative_path, file_id, file_size, updated_at)
       VALUES('captures/v2/idle.jsonl', 'idle-file', 0, ?)`,
    ).run(now);
    const sourceId = db.prepare(
      `SELECT id FROM ingestion_sources WHERE relative_path = 'captures/v2/idle.jsonl'`,
    ).pluck().get() as number;
    db.prepare(
      `INSERT INTO ingestion_records(
         exchange_id, source_id, source_generation, source_file_id, byte_offset,
         line_length_bytes, line_sha256, schema_version, captured_at, completed_at,
         request_body_bytes, response_body_bytes, request_body_sha256, response_body_sha256,
         request_body_storage, response_body_storage, request_body_state, response_body_state,
         registered_at
       ) VALUES('ex-idle', ?, 1, 'idle-file', 0, 19, ?, 2, ?, ?, 10, 10, ?, ?,
         'inline', 'inline', 'available', 'available', ?)`,
    ).run(
      sourceId,
      "a".repeat(64),
      now,
      now,
      "a".repeat(64),
      "a".repeat(64),
      now,
    );
    const recordId = db.prepare(
      `SELECT id FROM ingestion_records WHERE exchange_id = 'ex-idle'`,
    ).pluck().get() as number;
    db.prepare(
      `INSERT INTO derivation_jobs(
         ingestion_record_id, projection_version, job_status, attempt_count,
         available_at, request_verification, response_verification, created_at, updated_at
       ) VALUES(?, 6, 'pending', 0, ?, 'pending', 'pending', ?, ?)`,
    ).run(recordId, now, now, now);
    assert.equal(isDerivationIdle(db), false);
    db.prepare(`UPDATE derivation_jobs SET job_status = 'running'`).run();
    assert.equal(isDerivationIdle(db), false);
    db.prepare(`UPDATE derivation_jobs SET job_status = 'retry_wait'`).run();
    assert.equal(isDerivationIdle(db), true);
  });
});

test("自动清理执行：整文件删除、墓碑落库、结果与当日标记写入状态文件", async () => {
  await withFixture(async fixture => {
    await writeRetentionConfig(fixture.dataDir, 7);
    const capturedAt = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
    const {relativePath, filePath} = await seedPurgeableSource(fixture, "auto-purge-old.jsonl", capturedAt);

    const record = await runAutoPurgeOnce(fixture.db, fixture.dataDir, "daily");

    assert.equal(record.purgedFileCount, 1);
    assert.equal(record.purgedBytes > 0, true);
    assert.equal(existsSync(filePath), false);
    assert.equal(
      fixture.db.prepare(`SELECT raw_state FROM raw_exchange_refs`).pluck().get(),
      "purged",
    );
    assert.equal(
      fixture.db.prepare(
        `SELECT status FROM ingestion_sources WHERE relative_path = ?`,
      ).pluck().get(relativePath),
      "purged",
    );
    const state = readAutoPurgeState(fixture.dataDir);
    assert.equal(state?.version, 1);
    assert.equal(state?.lastRun?.trigger, "daily");
    assert.equal(state?.lastRun?.purgedFileCount, 1);
    assert.equal(state?.lastDailyRunDate, new Date().toLocaleDateString("sv-SE"));
  });
});

test("调度器闭环：请求标记（窗口调整）触发空闲清理并消费标记", async () => {
  await withFixture(async fixture => {
    // 先让启动 tick 在空库上完成一次（通过请求标记强制触发，避免依赖本地时刻）。
    requestIdlePurgeSoon(fixture.dataDir);
    const scheduler = startAutoPurgeScheduler({dataDir: fixture.dataDir});
    try {
      await waitFor(() => readAutoPurgeState(fixture.dataDir) !== undefined);
      assert.equal(readAutoPurgeState(fixture.dataDir)?.lastRun?.purgedFileCount, 0);

      // 窗口调小 + 超窗文件就绪后再次请求：显式 tick 在空闲时完成清理。
      await writeRetentionConfig(fixture.dataDir, 7);
      const capturedAt = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
      const {filePath} = await seedPurgeableSource(fixture, "auto-tick.jsonl", capturedAt);
      requestIdlePurgeSoon(fixture.dataDir);
      await scheduler.runTick();

      assert.equal(existsSync(filePath), false);
      const state = readAutoPurgeState(fixture.dataDir);
      assert.equal(state?.lastRun?.trigger, "retention-change");
      assert.equal(state?.lastRun?.purgedFileCount, 1);

      // 标记已消费且当日已执行：再次 tick 不再产生清理动作。
      await scheduler.runTick();
      assert.equal(readAutoPurgeState(fixture.dataDir)?.lastRun?.purgedFileCount, 1);
    } finally {
      scheduler.stop();
    }
  });
});
