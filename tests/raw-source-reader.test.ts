import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Dir, type Dirent } from "node:fs";
import { link, mkdir, readFile, rename, stat, symlink, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import {
  commitSourceCursor,
  discoverV2Sources,
  readRegisteredSourceRecord,
  readSourceBatch,
} from "../src/lib/ingestion/raw-source-reader.js";
import type { RawCapturedExchangeV2 } from "../src/lib/harness/types.js";
import type { SqliteFixture } from "./helpers/sqlite-fixture.js";
import { createSqliteFixture } from "./helpers/sqlite-fixture.js";

const fixtures: SqliteFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});

describe("v2 raw source reader", () => {
  test("允许受信任的配置 dataDir 根符号链接", async () => {
    const fixture = await createSqliteFixture({ dataDirSymlink: true });
    fixtures.push(fixture);
    const file = await fixture.writeV2Lines([record("ex-data-root-symlink")]);

    assert.equal(
      (await discoverV2Sources(fixture.db, fixture.dataDir)).discoveredCount,
      1,
    );
    const batch = await readSourceBatch(fixture.db, file, {
      maxRecords: 10,
      maxBytes: 64_000,
      maxLineBytes: 8_000_000,
    });

    assert.deepEqual(batch.records.map((item) => item.exchange.exchangeId), [
      "ex-data-root-symlink",
    ]);
  });

  test("发现拒绝外部 dataDir 根且不污染已有 source 状态", async () => {
    const fixture = await trackedFixture();
    const external = await createSqliteFixture();
    fixtures.push(external);
    await fixture.writeV2Lines([record("ex-owned")]);
    await external.writeV2Lines([record("ex-external")]);
    await discoverV2Sources(fixture.db, fixture.dataDir);
    const before = sourceRow(fixture);

    await assert.rejects(
      discoverV2Sources(fixture.db, external.dataDir),
      /数据库 dataDir|目录边界|根目录/,
    );

    assert.deepEqual(sourceRow(fixture), before);
  });

  test("发现候选读取后目录被替换时在任何 upsert 前拒绝", async (context) => {
    const fixture = await trackedFixture();
    const external = await createSqliteFixture();
    fixtures.push(external);
    const fileNames = ["race-1.jsonl", "race-2.jsonl", "race-3.jsonl"];
    for (const [index, fileName] of fileNames.entries()) {
      await fixture.writeV2Lines([record(`ex-owned-race-${index}`)], fileName);
      const externalRecord = record(`ex-external-race-${index}`);
      externalRecord.request.rawBody = "x".repeat(4_096 + index);
      externalRecord.request.bodySizeBytes = Buffer.byteLength(
        externalRecord.request.rawBody,
      );
      await external.writeV2Lines([externalRecord], fileName);
    }
    await discoverV2Sources(fixture.db, fixture.dataDir);
    const page = await discoverV2Sources(fixture.db, fixture.dataDir, {
      maxEntries: 1,
    });
    assert.ok(page.continuation);
    const before = allSourceRows(fixture);
    const internalV2Dir = join(fixture.dataDir, "captures", "v2");
    const parkedV2Dir = join(fixture.dataDir, "parked-v2");
    const externalV2Dir = join(external.dataDir, "captures", "v2");
    const originalRead = Dir.prototype.read as (
      this: Dir,
    ) => Promise<Dirent | null>;
    let swapped = false;
    context.mock.method(
      Dir.prototype,
      "read",
      async function readAfterDirectorySwap(this: Dir): Promise<Dirent | null> {
        const entry = await originalRead.call(this);
        if (!swapped && entry !== null) {
          await rename(internalV2Dir, parkedV2Dir);
          await symlink(externalV2Dir, internalV2Dir, "dir");
          swapped = true;
        }
        return entry;
      },
    );

    try {
      await assert.rejects(
        page.continuation.next({ maxEntries: 1 }),
        /目录边界|路径组件|打开期间|替换|符号链接/,
      );
    } finally {
      await page.continuation.close();
    }

    assert.equal(swapped, true, "测试必须在 Dir.read 返回候选后完成目录替换");
    assert.deepEqual(allSourceRows(fixture), before);
  });

  test("发现目录项分页有界且 continuation 不饿死后续文件并在耗尽后关闭", async () => {
    const fixture = await trackedFixture();
    const fileCount = 13;
    for (let index = 0; index < fileCount; index += 1) {
      await fixture.writeV2Lines(
        [record(`ex-discovery-${index}`)],
        `capture-${String(index).padStart(2, "0")}.jsonl`,
      );
    }
    await writeFile(
      join(fixture.dataDir, "captures", "v2", "ignored.txt"),
      "ignored",
    );

    let batch = await discoverV2Sources(fixture.db, fixture.dataDir, {
      maxEntries: 5,
    });
    let discoveredCount = batch.discoveredCount;
    let lastContinuation = batch.continuation;
    assert.ok(batch.processedCount <= 5);
    assert.equal(batch.limited, true);
    assert.ok(lastContinuation);

    while (batch.continuation) {
      lastContinuation = batch.continuation;
      batch = await batch.continuation.next({ maxEntries: 5 });
      assert.ok(batch.processedCount <= 5);
      discoveredCount += batch.discoveredCount;
    }

    assert.equal(discoveredCount, fileCount);
    assert.equal(
      fixture.db.prepare("SELECT COUNT(*) FROM ingestion_sources").pluck().get(),
      fileCount,
    );
    assert.ok(lastContinuation);
    await assert.rejects(
      lastContinuation.next({ maxEntries: 5 }),
      /已关闭|closed/i,
    );

    const abandoned = await discoverV2Sources(fixture.db, fixture.dataDir, {
      maxEntries: 1,
    });
    assert.ok(abandoned.continuation);
    await abandoned.continuation.close();
    await assert.rejects(
      abandoned.continuation.next({ maxEntries: 1 }),
      /已关闭|closed/i,
    );

    const invalidPage = await discoverV2Sources(fixture.db, fixture.dataDir, {
      maxEntries: 1,
    });
    assert.ok(invalidPage.continuation);
    await assert.rejects(
      invalidPage.continuation.next({ maxEntries: 0 }),
      /maxEntries.*有限范围/,
    );
    await assert.rejects(
      invalidPage.continuation.next({ maxEntries: 1 }),
      /已关闭|closed/i,
    );
  });

  test("只发现 captures/v2 的直接 jsonl 普通文件", async () => {
    const fixture = await trackedFixture();
    const direct = await fixture.writeV2Lines([record("ex-direct")], "direct.jsonl");
    const capturesDir = join(fixture.dataDir, "captures");
    const v2Dir = join(capturesDir, "v2");
    await mkdir(join(v2Dir, "nested"), { recursive: true });
    await mkdir(join(fixture.dataDir, "derived"), { recursive: true });
    await mkdir(join(fixture.dataDir, "indexes"), { recursive: true });
    await writeFile(join(capturesDir, "legacy.jsonl"), "{}\n");
    await writeFile(join(v2Dir, "ignored.txt"), "{}\n");
    await writeFile(join(v2Dir, "nested", "nested.jsonl"), "{}\n");
    await writeFile(join(fixture.dataDir, "derived", "derived.jsonl"), "{}\n");
    await writeFile(join(fixture.dataDir, "indexes", "index.jsonl"), "{}\n");
    await symlink(direct, join(v2Dir, "linked.jsonl"));

    assert.equal(
      (await discoverV2Sources(fixture.db, fixture.dataDir)).discoveredCount,
      1,
    );
    assert.deepEqual(
      fixture.db
        .prepare("SELECT relative_path FROM ingestion_sources ORDER BY relative_path")
        .pluck()
        .all(),
      ["captures/v2/direct.jsonl"],
    );
  });

  test("不跟随 captures/v2 目录符号链接", async () => {
    const fixture = await trackedFixture();
    const capturesDir = join(fixture.dataDir, "captures");
    const outsideDir = join(fixture.dataDir, "outside-v2");
    await mkdir(capturesDir, { recursive: true });
    await mkdir(outsideDir, { recursive: true });
    await writeFile(join(outsideDir, "outside.jsonl"), `${JSON.stringify(record("ex-outside"))}\n`);
    await symlink(outsideDir, join(capturesDir, "v2"), "dir");

    await assert.rejects(
      discoverV2Sources(fixture.db, fixture.dataDir),
      /v2 路径组件不是实际目录|符号链接/,
    );
    assert.deepEqual(
      fixture.db.prepare("SELECT relative_path FROM ingestion_sources").pluck().all(),
      [],
    );
  });

  test("拒绝数据库 dataDir 外部的同名 hardlink alias", async () => {
    const fixture = await trackedFixture();
    const file = await fixture.writeV2Lines([record("ex-hardlink")]);
    await discoverV2Sources(fixture.db, fixture.dataDir);
    const externalDir = join(fixture.dataDir, "outside", "captures", "v2");
    const externalAlias = join(externalDir, "capture-v2-test.jsonl");
    await mkdir(externalDir, { recursive: true });
    await link(file, externalAlias);

    await assert.rejects(
      readSourceBatch(fixture.db, externalAlias, {
        maxRecords: 10,
        maxBytes: 64_000,
        maxLineBytes: 8_000_000,
      }),
      /必须匹配数据库 dataDir/,
    );
  });

  test("拒绝发现后替换到末级符号链接的 source", async () => {
    const fixture = await trackedFixture();
    const file = await fixture.writeV2Lines([record("ex-symlink")]);
    await discoverV2Sources(fixture.db, fixture.dataDir);
    const backingFile = join(fixture.dataDir, "capture-v2-backing.jsonl");
    await rename(file, backingFile);
    await symlink(backingFile, file);

    await assert.rejects(
      readSourceBatch(fixture.db, file, {
        maxRecords: 10,
        maxBytes: 64_000,
        maxLineBytes: 8_000_000,
      }),
      /不是普通文件|符号链接/,
    );
  });

  test("拒绝 discover 后被替换为外部 symlink 的 captures/v2 目录", async () => {
    const fixture = await trackedFixture();
    const file = await fixture.writeV2Lines([record("ex-v2-directory-symlink")]);
    await discoverV2Sources(fixture.db, fixture.dataDir);
    const capturesDir = join(fixture.dataDir, "captures");
    const v2Dir = join(capturesDir, "v2");
    const externalDir = join(fixture.dataDir, "external-v2");
    await rename(v2Dir, externalDir);
    await symlink(externalDir, v2Dir, "dir");

    await assert.rejects(
      readSourceBatch(fixture.db, file, {
        maxRecords: 10,
        maxBytes: 64_000,
        maxLineBytes: 8_000_000,
      }),
      /路径组件|符号链接|目录边界/,
    );
  });

  test("只返回游标后的完整行并保留未完成尾行", async () => {
    const fixture = await trackedFixture();
    const firstRecord = record("ex-1");
    const secondRecord = record("ex-2");
    const partialRecord = record("ex-partial");
    const file = await fixture.writeV2Lines([firstRecord, secondRecord]);
    await discoverV2Sources(fixture.db, fixture.dataDir);

    const first = await readSourceBatch(fixture.db, file, {
      maxRecords: 1,
      maxBytes: 64_000,
      maxLineBytes: 8_000_000,
    });
    assert.deepEqual(first.records.map((item) => item.exchange.exchangeId), ["ex-1"]);
    assert.equal(first.startOffset, 0);
    assert.equal(first.endOffset, encodedLineLength(firstRecord));
    assert.equal(sourceRow(fixture).byte_offset, 0, "读取不能提前推进数据库游标");
    assert.equal(first.limited, true);
    commitSourceCursor(fixture.db, first);

    await fixture.appendRaw(file, JSON.stringify(partialRecord));
    const second = await readSourceBatch(fixture.db, file, {
      maxRecords: 10,
      maxBytes: 64_000,
      maxLineBytes: 8_000_000,
    });
    assert.deepEqual(second.records.map((item) => item.exchange.exchangeId), ["ex-2"]);
    assert.equal(second.hasPartialTail, true);
    assert.equal(
      second.endOffset,
      encodedLineLength(firstRecord) + encodedLineLength(secondRecord),
    );
    commitSourceCursor(fixture.db, second);

    await fixture.appendRaw(file, "\n");
    const completed = await readSourceBatch(fixture.db, file, {
      maxRecords: 10,
      maxBytes: 64_000,
      maxLineBytes: 8_000_000,
    });
    assert.deepEqual(completed.records.map((item) => item.exchange.exchangeId), ["ex-partial"]);
    assert.equal(completed.hasPartialTail, false);
  });

  test("超限完整行进入跳过状态且缓冲保持有界", async () => {
    const fixture = await trackedFixture();
    const before = record("ex-before");
    const after = record("ex-after");
    const oversized = JSON.stringify({ schemaVersion: 2, padding: "x".repeat(180_000) });
    const file = await fixture.writeV2Lines([before]);
    await fixture.appendRaw(file, `${oversized}\n${JSON.stringify(after)}\n`);
    await discoverV2Sources(fixture.db, fixture.dataDir);

    const batch = await readSourceBatch(fixture.db, file, {
      maxRecords: 10,
      maxBytes: 512_000,
      maxLineBytes: 4_096,
    });
    const source = sourceRow(fixture);

    assert.deepEqual(batch.records.map((item) => item.exchange.exchangeId), [
      "ex-before",
      "ex-after",
    ]);
    assert.deepEqual(batch.oversizedLines, [
      {
        sourceId: source.id,
        relativePath: "captures/v2/capture-v2-test.jsonl",
        byteOffset: encodedLineLength(before),
        lineLengthBytes: Buffer.byteLength(oversized) + 1,
      },
    ]);
    assert.equal(batch.processedCount, 3);
    assert.ok(batch.maxBufferedLineBytes <= 4_096 + 64 * 1_024);
    assert.ok(batch.bytesRead <= batch.endOffset - batch.startOffset + 64 * 1_024);
  });

  test("未换行的超限尾行不消费且补全后可以越过", async () => {
    const fixture = await trackedFixture();
    const oversized = JSON.stringify({ schemaVersion: 2, padding: "x".repeat(180_000) });
    const after = record("ex-after-partial");
    const file = await fixture.writeV2Lines([]);
    await fixture.appendRaw(file, oversized);
    await discoverV2Sources(fixture.db, fixture.dataDir);

    const partial = await readSourceBatch(fixture.db, file, {
      maxRecords: 10,
      maxBytes: 64_000,
      maxLineBytes: 4_096,
    });
    assert.equal(partial.endOffset, 0);
    assert.equal(partial.hasPartialTail, false, "受预算限制时尚未读取到快照末尾");
    assert.equal(partial.limited, true);
    assert.ok(partial.endScanOffset > partial.endOffset);
    assert.deepEqual(partial.oversizedLines, []);
    assert.ok(partial.maxBufferedLineBytes <= 4_096 + 64 * 1_024);

    await fixture.appendRaw(file, `\n${JSON.stringify(after)}\n`);
    const completed = await readSourceBatch(fixture.db, file, {
      maxRecords: 10,
      maxBytes: 512_000,
      maxLineBytes: 4_096,
    });
    assert.equal(completed.oversizedLines[0]?.lineLengthBytes, Buffer.byteLength(oversized) + 1);
    assert.deepEqual(completed.records.map((item) => item.exchange.exchangeId), [
      "ex-after-partial",
    ]);
  });

  test("oversized 跳过进度按 I/O 预算持久推进并使用 scan_offset CAS", async () => {
    const fixture = await trackedFixture();
    const file = await fixture.writeV2Lines([]);
    await fixture.appendRaw(file, "x".repeat(1024 * 1024));
    await discoverV2Sources(fixture.db, fixture.dataDir);
    const options = {
      maxRecords: 10,
      maxBytes: 4_096,
      maxLineBytes: 4_096,
    };

    const first = await readSourceBatch(fixture.db, file, options);
    assert.equal(first.endOffset, 0);
    assert.equal(first.processedCount, 0);
    assert.deepEqual(first.oversizedLines, []);
    assert.equal(first.limited, true);
    assert.ok(first.bytesRead <= options.maxBytes + 64 * 1_024);
    assert.equal(first.startScanOffset, 0);
    assert.ok(first.endScanOffset > first.startScanOffset);

    const stale = await readSourceBatch(fixture.db, file, options);
    commitSourceCursor(fixture.db, first);
    assert.throws(
      () => commitSourceCursor(fixture.db, stale),
      /游标提交冲突/,
      "同一 scan_offset 起点的旧批次不能重复提交跳过进度",
    );
    assert.equal(sourceScanOffset(fixture), first.endScanOffset);

    const after = record("ex-after-oversized-tail");
    await fixture.appendRaw(file, `\n${JSON.stringify(after)}\n`);
    let oversizedCount = 0;
    const exchangeIds: string[] = [];
    for (let attempt = 0; attempt < 300; attempt += 1) {
      const beforeScanOffset = sourceScanOffset(fixture);
      const batch = await readSourceBatch(fixture.db, file, options);
      assert.equal(batch.startScanOffset, beforeScanOffset);
      assert.ok(batch.bytesRead <= options.maxBytes);
      oversizedCount += batch.oversizedLines.length;
      exchangeIds.push(...batch.records.map((item) => item.exchange.exchangeId));
      commitSourceCursor(fixture.db, batch);
      if (exchangeIds.includes(after.exchangeId)) {
        break;
      }
    }

    assert.equal(oversizedCount, 1);
    assert.deepEqual(exchangeIds, [after.exchangeId]);
    const completed = sourceRow(fixture);
    assert.equal(completed.scan_offset, completed.byte_offset);
  });

  test("文件 identity 变化只标记 reset 而不提前写 Worker 诊断", async () => {
    const fixture = await trackedFixture();
    const file = await fixture.writeV2Lines([record("ex-old"), record("ex-old-2")]);
    await discoverV2Sources(fixture.db, fixture.dataDir);
    const oldFileId = sourceRow(fixture).file_id;
    const batch = await readSourceBatch(fixture.db, file, {
      maxRecords: 1,
      maxBytes: 64_000,
      maxLineBytes: 8_000_000,
    });
    commitSourceCursor(fixture.db, batch);

    const replacement = join(fixture.dataDir, "captures", "v2", "replacement.tmp");
    await writeFile(replacement, `${JSON.stringify(record("ex-new"))}\n`);
    await rename(replacement, file);
    await discoverV2Sources(fixture.db, fixture.dataDir);

    const reset = sourceRow(fixture);
    assert.notEqual(reset.file_id, oldFileId);
    assert.equal(reset.byte_offset, 0);
    assert.equal(reset.scan_offset, 0);
    assert.equal(reset.status, "reset");
    assert.equal(reset.generation, 1);
    await assert.rejects(
      readSourceBatch(fixture.db, file, {
        maxRecords: 10,
        maxBytes: 64_000,
        maxLineBytes: 8_000_000,
      }),
      /reset 状态必须由 Worker 先消费/,
    );
    fixture.db
      .prepare("UPDATE ingestion_sources SET status = 'ready' WHERE id = ?")
      .run(reset.id);
    const resumed = await readSourceBatch(fixture.db, file, {
      maxRecords: 10,
      maxBytes: 64_000,
      maxLineBytes: 8_000_000,
    });
    assert.equal(resumed.sourceGeneration, 1);
    assert.deepEqual(resumed.records.map((item) => item.exchange.exchangeId), ["ex-new"]);
    assert.equal(
      fixture.db.prepare("SELECT COUNT(*) FROM derivation_diagnostics").pluck().get(),
      0,
    );
  });

  test("同一文件缩短到已提交 offset 之前时重置 source", async () => {
    const fixture = await trackedFixture();
    const firstRecord = record("ex-first");
    const file = await fixture.writeV2Lines([firstRecord, record("ex-second")]);
    await discoverV2Sources(fixture.db, fixture.dataDir);
    const initialFileId = sourceRow(fixture).file_id;
    const batch = await readSourceBatch(fixture.db, file, {
      maxRecords: 10,
      maxBytes: 64_000,
      maxLineBytes: 8_000_000,
    });
    commitSourceCursor(fixture.db, batch);
    await truncate(file, encodedLineLength(firstRecord));

    await discoverV2Sources(fixture.db, fixture.dataDir);
    const reset = sourceRow(fixture);
    assert.equal(reset.file_id, initialFileId);
    assert.equal(reset.byte_offset, 0);
    assert.equal(reset.scan_offset, 0);
    assert.equal(reset.status, "reset");
    assert.equal(reset.generation, 1);
    assert.throws(
      () => commitSourceCursor(fixture.db, batch),
      /游标提交冲突/,
      "截短重置后不能接受截短前读取的旧批次",
    );
  });

  test("普通追加与重复发现不增加 source generation", async () => {
    const fixture = await trackedFixture();
    const file = await fixture.writeV2Lines([record("ex-generation-1")]);

    await discoverV2Sources(fixture.db, fixture.dataDir);
    assert.equal(sourceRow(fixture).generation, 0);
    await discoverV2Sources(fixture.db, fixture.dataDir);
    assert.equal(sourceRow(fixture).generation, 0);
    await fixture.appendRaw(file, `${JSON.stringify(record("ex-generation-2"))}\n`);
    await discoverV2Sources(fixture.db, fixture.dataDir);

    assert.equal(sourceRow(fixture).generation, 0);
    assert.equal(sourceRow(fixture).status, "ready");
  });

  test("ABA 恢复相同 fileId 和大小后旧 generation batch 仍冲突", async () => {
    const fixture = await trackedFixture();
    const file = await fixture.writeV2Lines([record("ex-aba-original")]);
    await discoverV2Sources(fixture.db, fixture.dataDir);
    const staleBatch = await readSourceBatch(fixture.db, file, {
      maxRecords: 10,
      maxBytes: 64_000,
      maxLineBytes: 8_000_000,
    });
    assert.equal(staleBatch.sourceGeneration, 0);

    const originalFile = join(fixture.dataDir, "capture-v2-original.jsonl");
    const replacementFile = join(fixture.dataDir, "capture-v2-replacement.jsonl");
    await rename(file, originalFile);
    await writeFile(file, `${JSON.stringify(record("ex-aba-replacement"))}\n`);
    await discoverV2Sources(fixture.db, fixture.dataDir);
    assert.equal(sourceRow(fixture).generation, 1);

    await rename(file, replacementFile);
    await rename(originalFile, file);
    await discoverV2Sources(fixture.db, fixture.dataDir);
    const restored = sourceRow(fixture);
    assert.equal(restored.generation, 2);
    assert.equal(restored.file_id, staleBatch.fileId);
    assert.equal(restored.file_size, staleBatch.sourceFileSize);
    assert.equal(restored.byte_offset, staleBatch.startOffset);

    // 模拟 Task 7 已记录 source_reset 并恢复 ready，CAS 仍必须依赖 generation 拒绝 ABA。
    fixture.db
      .prepare("UPDATE ingestion_sources SET status = 'ready' WHERE id = ?")
      .run(restored.id);
    assert.throws(
      () => commitSourceCursor(fixture.db, staleBatch),
      /游标提交冲突/,
    );
  });

  test("CRLF、坏 UTF-8、空行、非法 JSON 和非 raw v2 都有界跳过", async () => {
    const fixture = await trackedFixture();
    const first = record("ex-crlf");
    const last = record("ex-last");
    const v1 = { ...record("ex-v1"), schemaVersion: 1 };
    const hydrated = {
      ...record("ex-hydrated"),
      request: { ...record("unused").request, parsedBody: { secret: true } },
    };
    const file = await fixture.writeV2Lines([]);
    await fixture.appendRaw(
      file,
      Buffer.concat([
        Buffer.from(`${JSON.stringify(first)}\r\n`),
        Buffer.from("\n{broken}\n"),
        Buffer.from(`${JSON.stringify(v1)}\n${JSON.stringify(hydrated)}\n`),
        Buffer.from([0xff, 0xfe, 0x0a]),
        Buffer.from(`${JSON.stringify(last)}\n`),
      ]),
    );
    await discoverV2Sources(fixture.db, fixture.dataDir);

    const batch = await readSourceBatch(fixture.db, file, {
      maxRecords: 10,
      maxBytes: 512_000,
      maxLineBytes: 8_000_000,
    });

    assert.deepEqual(batch.records.map((item) => item.exchange.exchangeId), [
      "ex-crlf",
      "ex-last",
    ]);
    assert.equal(batch.records[0]?.lineLengthBytes, Buffer.byteLength(JSON.stringify(first)) + 2);
    assert.deepEqual(batch.invalidLines.map((item) => item.reason), [
      "empty_line",
      "invalid_json",
      "unsupported_schema",
      "not_raw_only",
      "invalid_utf8",
    ]);
    assert.equal(batch.processedCount, 7);
    assert.equal(batch.hasPartialTail, false);
  });

  test("深度校验 v2 嵌套元数据并允许未知附加字段", async () => {
    const fixture = await trackedFixture();
    const base = record("ex-deep-guard");
    const invalidRecords: unknown[] = [
      { ...base, bodyStorage: {} },
      { ...base, security: {} },
      { ...base, captureDiagnostics: [null] },
      { ...base, bodyStorage: { ...base.bodyStorage, policy: "future-policy" } },
      { ...base, bodyStorage: { ...base.bodyStorage, thresholdBytes: 1.5 } },
      {
        ...base,
        captureDiagnostics: [{ code: "unknown", severity: "warning", message: "bad" }],
      },
      {
        ...base,
        request: { ...base.request, rawBodyRef: {} },
      },
      {
        ...base,
        request: {
          ...base.request,
          rawBodyRef: {
            storage: "inline",
            encoding: "brotli",
            sha256: "c".repeat(64),
            sizeBytes: 2,
          },
        },
      },
      {
        ...base,
        response: {
          ...base.response,
          rawBodyRef: {
            storage: "external-blob",
            encoding: "gzip",
            sha256: "d".repeat(64),
            sizeBytes: -1,
          },
        },
      },
      { ...base, routing: { ...base.routing, agent: "" } },
      { ...base, routing: { ...base.routing, agent: "x".repeat(33) } },
      { ...base, routing: { ...base.routing, wireApi: "future-api" } },
      { ...base, routing: { ...base.routing, requestedModel: "" } },
      { ...base, routing: { ...base.routing, requestedModel: "x".repeat(257) } },
      { ...base, routing: { ...base.routing, routeMode: "unknown" } },
      { ...base, routing: { ...base.routing, clientCredentialId: "" } },
      { ...base, routing: { ...base.routing, clientCredentialId: "x".repeat(129) } },
    ];
    const routingFull = {
      ...record("ex-routing-full"),
      routing: {
        ...record("unused-routing").routing,
        agent: "dsh",
        wireApi: "chat_completions",
        requestedModel: "deepseek-v4_target",
        routeMode: "model",
        clientCredentialId: "cred_dsh_1",
      },
    };
    const forwardCompatible = {
      ...record("ex-forward-compatible"),
      futureTopLevelField: { version: 3 },
      bodyStorage: {
        ...record("unused-forward").bodyStorage,
        futureStorageField: true,
      },
    };
    const file = await fixture.writeV2Lines([
      ...invalidRecords,
      routingFull,
      forwardCompatible,
    ]);
    await discoverV2Sources(fixture.db, fixture.dataDir);

    const batch = await readSourceBatch(fixture.db, file, {
      maxRecords: 20,
      maxBytes: 512_000,
      maxLineBytes: 64_000,
    });

    assert.deepEqual(
      batch.invalidLines.map((item) => item.reason),
      invalidRecords.map(() => "invalid_v2_record"),
    );
    assert.deepEqual(batch.records.map((item) => item.exchange.exchangeId), [
      "ex-routing-full",
      "ex-forward-compatible",
    ]);
    assert.equal(batch.records[0]?.exchange.routing.wireApi, "chat_completions");
    assert.equal(batch.records[0]?.exchange.routing.agent, "dsh");
  });

  test("拒绝非法或无界读取预算", async () => {
    const fixture = await trackedFixture();
    const file = await fixture.writeV2Lines([record("ex-budget")]);
    await discoverV2Sources(fixture.db, fixture.dataDir);
    const valid = { maxRecords: 1, maxBytes: 64_000, maxLineBytes: 8_000_000 };

    for (const [name, value] of [
      ["maxRecords", 0],
      ["maxRecords", -1],
      ["maxRecords", 1.5],
      ["maxRecords", Number.POSITIVE_INFINITY],
      ["maxRecords", 100_000_000],
      ["maxBytes", 0],
      ["maxBytes", Number.POSITIVE_INFINITY],
      ["maxBytes", Number.MAX_SAFE_INTEGER],
      ["maxLineBytes", 0],
      ["maxLineBytes", Number.POSITIVE_INFINITY],
      ["maxLineBytes", Number.MAX_SAFE_INTEGER],
    ] as const) {
      await assert.rejects(
        readSourceBatch(fixture.db, file, { ...valid, [name]: value }),
        new RegExp(`${name}.*有限范围`),
      );
    }
  });

  test("maxRecords 同样限制坏行处理量", async () => {
    const fixture = await trackedFixture();
    const file = await fixture.writeV2Lines([]);
    await fixture.appendRaw(file, `\n{broken}\n\n${JSON.stringify(record("ex-later"))}\n`);
    await discoverV2Sources(fixture.db, fixture.dataDir);

    const batch = await readSourceBatch(fixture.db, file, {
      maxRecords: 3,
      maxBytes: 64_000,
      maxLineBytes: 8_000_000,
    });

    assert.equal(batch.processedCount, 3);
    assert.equal(batch.invalidLines.length, 3);
    assert.deepEqual(batch.records, []);
    assert.equal(batch.limited, true);
  });

  test("已开始的完整行可以越过 maxBytes 并在行边界停止", async () => {
    const fixture = await trackedFixture();
    const large = record("ex-over-budget");
    large.request.rawBody = "x".repeat(12_000);
    large.request.bodySizeBytes = 12_000;
    const later = record("ex-after-budget");
    const file = await fixture.writeV2Lines([large, later]);
    await discoverV2Sources(fixture.db, fixture.dataDir);

    const batch = await readSourceBatch(fixture.db, file, {
      maxRecords: 10,
      maxBytes: 4_096,
      maxLineBytes: 64_000,
    });

    assert.deepEqual(batch.records.map((item) => item.exchange.exchangeId), [
      "ex-over-budget",
    ]);
    assert.equal(batch.endOffset, encodedLineLength(large));
    assert.equal(batch.limited, true);
    assert.ok(batch.bytesRead <= batch.endOffset - batch.startOffset + 64 * 1_024);
    assert.ok(batch.bytesRead <= 64_000 + 64 * 1_024);
  });

  test("commit 使用起始 offset 做 CAS，旧 batch 不能倒退或重复游标", async () => {
    const fixture = await trackedFixture();
    const file = await fixture.writeV2Lines([record("ex-cas")]);
    await discoverV2Sources(fixture.db, fixture.dataDir);
    const options = { maxRecords: 10, maxBytes: 64_000, maxLineBytes: 8_000_000 };
    const first = await readSourceBatch(fixture.db, file, options);
    const stale = await readSourceBatch(fixture.db, file, options);

    commitSourceCursor(fixture.db, first);
    assert.throws(() => commitSourceCursor(fixture.db, stale), /游标提交冲突/);
    assert.equal(sourceRow(fixture).byte_offset, first.endOffset);
    assert.equal(sourceRow(fixture).processed_count, 1);
  });

  test("实现不使用全文件 readFile 或 split", async () => {
    const source = await readFile(
      new URL("../src/lib/ingestion/raw-source-reader.ts", import.meta.url),
      "utf8",
    );
    assert.doesNotMatch(source, /\breadFile\b/);
    assert.doesNotMatch(source, /\.split\s*\(/);
  });

  test("登记行在 source 身份漂移后按行哈希兜底读取，内容不一致仍拒绝", async () => {
    const fixture = await trackedFixture();
    const exchangeId = "ex-registered-drift";
    const file = await fixture.writeV2Lines([record(exchangeId)]);
    assert.equal(
      (await discoverV2Sources(fixture.db, fixture.dataDir)).discoveredCount,
      1,
    );
    const source = sourceRow(fixture);
    const lineBytes = Buffer.concat([
      Buffer.from(JSON.stringify(record(exchangeId))),
      Buffer.from("\n"),
    ]);
    const registeredLocator = {
      exchangeId,
      sourceId: source.id,
      sourceGeneration: source.generation,
      sourceFileId: source.file_id,
      sourceRelativePath: source.relative_path,
      byteOffset: 0,
      lineLengthBytes: lineBytes.length,
      lineSha256: createHash("sha256").update(lineBytes).digest("hex"),
    };
    assert.equal(
      (await readRegisteredSourceRecord(fixture.db, fixture.dataDir, registeredLocator))
        .exchange.exchangeId,
      exchangeId,
    );

    // 模拟跨重启设备号变化后的重新发现：文件内容不变但磁盘身份刷新，
    // source 行按发现逻辑推进 generation 并写入新 file_id；登记记录仍持旧身份。
    await rename(file, `${file}.previous`);
    await writeFile(file, lineBytes);
    const replaced = await stat(file);
    fixture.db.prepare(
      "UPDATE ingestion_sources SET file_id = ?, generation = generation + 1 WHERE id = ?",
    ).run(`${replaced.dev}:${replaced.ino}`, source.id);

    assert.equal(
      (await readRegisteredSourceRecord(fixture.db, fixture.dataDir, registeredLocator))
        .exchange.exchangeId,
      exchangeId,
    );

    await assert.rejects(
      readRegisteredSourceRecord(fixture.db, fixture.dataDir, {
        ...registeredLocator,
        lineSha256: "f".repeat(64),
      }),
      /SHA-256 不匹配/,
    );
    await assert.rejects(
      readRegisteredSourceRecord(fixture.db, fixture.dataDir, {
        ...registeredLocator,
        lineSha256: "",
      }),
      /身份或 generation 已变化/,
    );
  });
});

async function trackedFixture(): Promise<SqliteFixture> {
  const fixture = await createSqliteFixture();
  fixtures.push(fixture);
  return fixture;
}

function encodedLineLength(exchange: RawCapturedExchangeV2): number {
  return Buffer.byteLength(JSON.stringify(exchange)) + 1;
}

function sourceRow(fixture: SqliteFixture): {
  id: number;
  relative_path: string;
  file_id: string;
  byte_offset: number;
  scan_offset: number;
  file_size: number;
  generation: number;
  processed_count: number;
  status: string;
} {
  const row = fixture.db
    .prepare(
      `SELECT id, relative_path, file_id, byte_offset, scan_offset, file_size,
        generation, processed_count, status
      FROM ingestion_sources
      WHERE relative_path = ?`,
    )
    .get("captures/v2/capture-v2-test.jsonl");
  assert.ok(row);
  return row as ReturnType<typeof sourceRow>;
}

function allSourceRows(fixture: SqliteFixture): unknown[] {
  return fixture.db
    .prepare(
      `SELECT id, relative_path, file_id, generation, byte_offset, scan_offset,
        file_size, processed_count, status, error, updated_at
      FROM ingestion_sources
      ORDER BY relative_path`,
    )
    .all();
}

function sourceScanOffset(fixture: SqliteFixture): number {
  return sourceRow(fixture).scan_offset;
}

function record(exchangeId: string): RawCapturedExchangeV2 {
  return {
    schemaVersion: 2,
    exchangeId,
    captureSessionId: "capture-v2-1784160000000-12345678-abc",
    sequence: 1,
    capturedAt: "2026-07-16T00:00:00.000Z",
    completedAt: "2026-07-16T00:00:01.000Z",
    durationMs: 1_000,
    routing: {
      targetId: "target-1",
      targetName: "Target 1",
      targetFormatHint: "anthropic",
      localUrl: "http://127.0.0.1:4000/v1/messages",
      upstreamUrl: "https://example.com/v1/messages",
      localPath: "/v1/messages",
      upstreamPath: "/v1/messages",
      method: "POST",
    },
    request: {
      headers: { "content-type": "application/json" },
      rawBody: "{}",
      bodySizeBytes: 2,
      bodySha256: "a".repeat(64),
    },
    response: {
      status: 200,
      statusText: "OK",
      headers: { "content-type": "application/json" },
      rawBody: "{}",
      bodySizeBytes: 2,
      bodySha256: "b".repeat(64),
      isStreaming: false,
    },
    bodyStorage: {
      policy: "inline",
      compression: "gzip",
      externalBlobDir: "blobs",
      thresholdBytes: 262_144,
    },
    captureDiagnostics: [],
    security: {
      containsSensitiveHeaders: false,
      headerRedactionAppliedInApi: true,
      rawBodiesStoredLocally: true,
    },
  };
}
