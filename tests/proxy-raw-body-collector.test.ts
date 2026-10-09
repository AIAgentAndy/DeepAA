import {createHash} from "node:crypto";
import {mkdtemp, readFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {gunzipSync} from "node:zlib";
import {describe, expect, test} from "vitest";
import {
  CaptureBudget,
  RawBodyCollector,
} from "../src/proxy/raw-body-collector.js";

describe("RawBodyCollector", () => {
  test("默认全局待写正文预算遵守设计约定的 64 MiB 上限", () => {
    const budget = new CaptureBudget();
    const expectedBytes = 64 * 1024 * 1024;

    expect(budget.reserve(expectedBytes)).toBe(true);
    expect(budget.reserve(1)).toBe(false);
    budget.release(expectedBytes);
    expect(budget.pendingBytes).toBe(0);
  });

  test("单个 collector 的待写正文超过 4 MiB 时只降级该正文", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "collector-single-budget-"));
    const budget = new CaptureBudget();
    const collector = await RawBodyCollector.create({dataDir, budget});

    collector.capture(Buffer.alloc(4 * 1024 * 1024 + 1, 0x61));
    const result = await collector.finish();

    expect(result.missing).toBe(true);
    expect(result.bodySizeBytes).toBe(4 * 1024 * 1024 + 1);
    expect(budget.pendingBytes).toBe(0);
  });

  test("preserves logical UTF-8 across chunks and hashes replacement-decoded text", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "collector-utf8-"));
    const collector = await RawBodyCollector.create({dataDir});
    const euro = Buffer.from("A€B", "utf8");
    collector.capture(euro.subarray(0, 2));
    collector.capture(euro.subarray(2));
    collector.capture(Buffer.from([0xc3, 0x28]));

    const result = await collector.finish();
    const expected = "A€B�(";
    expect(result.rawBody).toBe(expected);
    expect(result.bodySizeBytes).toBe(Buffer.byteLength(expected));
    expect(result.bodySha256).toBe(createHash("sha256").update(expected).digest("hex"));
    expect(result.rawBodyRef).toMatchObject({storage: "inline", encoding: "identity"});
  });

  test("matches Fetch text decoding by stripping one leading UTF-8 BOM", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "collector-bom-"));
    const collector = await RawBodyCollector.create({dataDir});
    collector.capture(Buffer.from([0xef]));
    collector.capture(Buffer.from([0xbb, 0xbf, 0x41]));

    const result = await collector.finish();

    expect(result.rawBody).toBe("A");
    expect(result.bodySizeBytes).toBe(1);
    expect(result.bodySha256).toBe(createHash("sha256").update("A").digest("hex"));
  });

  test("uses compressed-inline and external blob without retaining the full text", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "collector-storage-"));
    const medium = await RawBodyCollector.create({
      dataDir,
      policy: {inlineThresholdBytes: 16, compressedInlineThresholdBytes: 128},
    });
    medium.capture(Buffer.from("m".repeat(64)));
    const mediumResult = await medium.finish();
    expect(mediumResult.rawBody).toBeUndefined();
    expect(mediumResult.rawBodyRef?.storage).toBe("compressed-inline");
    expect(gunzipSync(Buffer.from(mediumResult.rawBodyRef!.inlineBase64!, "base64")).toString()).toBe("m".repeat(64));

    const large = await RawBodyCollector.create({
      dataDir,
      policy: {inlineThresholdBytes: 16, compressedInlineThresholdBytes: 128},
    });
    large.capture(Buffer.from("L".repeat(256)));
    const largeResult = await large.finish();
    expect(largeResult.rawBodyRef?.storage).toBe("external-blob");
    const blob = await readFile(join(dataDir, largeResult.rawBodyRef!.externalPath!));
    expect(gunzipSync(blob).toString()).toBe("L".repeat(256));
  });

  test("degrades capture immediately when the asynchronous write queue exceeds budget", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "collector-budget-"));
    const budget = new CaptureBudget({maxPendingBytes: 8, maxConcurrentFinalizers: 1});
    const collector = await RawBodyCollector.create({
      dataDir,
      budget,
      policy: {inlineThresholdBytes: 4, compressedInlineThresholdBytes: 16},
    });

    collector.capture(Buffer.from("0123456789abcdef"));
    const result = await collector.finish();

    expect(result.missing).toBe(true);
    expect(result.rawBody).toBeUndefined();
    expect(result.rawBodyRef).toBeUndefined();
    expect(result.bodySizeBytes).toBe(16);
    expect(budget.pendingBytes).toBe(0);
  });

  test("bounds queued finalizers without blocking the network path", async () => {
    const budget = new CaptureBudget({
      maxPendingBytes: 1024,
      maxConcurrentFinalizers: 1,
      maxQueuedFinalizers: 1,
    });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const first = budget.runFinalizer(async () => await gate);
    const second = budget.runFinalizer(async () => "second");

    expect(budget.queuedFinalizers).toBe(1);
    await expect(budget.runFinalizer(async () => "overflow")).rejects.toThrow("FINALIZER_QUEUE_FULL");
    release();
    await expect(first).resolves.toBeUndefined();
    await expect(second).resolves.toBe("second");
    expect(budget.queuedFinalizers).toBe(0);
    expect(budget.activeFinalizers).toBe(0);
  });
});
