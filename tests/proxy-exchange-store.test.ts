import {createHash} from "node:crypto";
import {mkdtemp, readFile, readdir, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {setTimeout as delay} from "node:timers/promises";
import {describe, expect, test} from "vitest";
import {ProxyExchangeStore} from "../src/proxy/exchange-store.js";
import type {CollectedRawBody} from "../src/proxy/raw-v2-contract.js";

describe("ProxyExchangeStore", () => {
  test("writes compatible v2 raw without retaining complete body history", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "proxy-store-"));
    const store = new ProxyExchangeStore({dataDir, maxRuntimeSessions: 4, maxRecentDiagnostics: 2});
    await store.init();
    const first = await store.record(makeInput("one"));
    await store.record(makeInput("two"));
    await store.record(makeInput("three", "other-model"));

    expect(first?.schemaVersion).toBe(2);
    expect(store.runtimeState()).toMatchObject({recentDiagnosticsCount: 2});
    expect(JSON.stringify(store.runtimeState())).not.toContain('"rawBody"');
    const files = await readdir(join(dataDir, "captures", "v2"));
    expect(files.length).toBeGreaterThan(0);
    const lines = (await Promise.all(files.map(file => readFile(join(dataDir, "captures", "v2", file), "utf8"))))
      .flatMap(content => content.trimEnd().split("\n"));
    expect(lines.map(line => JSON.parse(line).schemaVersion)).toEqual([2, 2, 2]);
  });

  test("keeps forwarding capture-degraded when dataDir cannot be created", async () => {
    const root = await mkdtemp(join(tmpdir(), "proxy-store-degraded-"));
    const dataDir = join(root, "not-a-directory");
    await writeFile(dataDir, "occupied", "utf8");
    const store = new ProxyExchangeStore({dataDir});

    await expect(store.init()).resolves.toBeUndefined();
    await expect(store.record(makeInput("degraded"))).resolves.toBeUndefined();
    expect(store.runtimeState().captureDegraded).toBe(true);
  });

  test("累计报告因预算或存储失败而缺失的 raw 正文数量", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "proxy-store-missing-body-"));
    const store = new ProxyExchangeStore({dataDir});
    await store.init();
    const input = makeInput("missing-body");
    input.response.body = {
      bodySizeBytes: 17,
      bodySha256: createHash("sha256").update("missing-response").digest("hex"),
      missing: true,
    };

    await store.record(input);

    expect(store.runtimeState().captureMissingBodies).toBe(1);
  });

  test("owns a dependency closure that excludes harness, SQLite and UI modules", async () => {
    const source = await readFile(new URL("../src/proxy/exchange-store.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/lib\/harness|better-sqlite3|node:sqlite|capture-index|derivation|src\/types/u);
  });

  test("bounds pending JSONL metadata without applying network backpressure", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "proxy-store-record-budget-"));
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const store = new ProxyExchangeStore({
      dataDir,
      maxPendingRecordBytes: 4 * 1024,
      appendExchange: async () => {
        await gate;
        return {filePath: "fixture", byteOffset: 0, lineLengthBytes: 1};
      },
    });
    await store.init();

    const records = Array.from({length: 20}, (_, index) => store.record(makeInput(`queued-${index}-${"x".repeat(512)}`)));
    const stateWhileBlocked = store.runtimeState();

    expect(stateWhileBlocked.capturePendingRecordBytes).toBeLessThanOrEqual(4 * 1024);
    expect(stateWhileBlocked.peakCapturePendingRecordBytes).toBeGreaterThan(0);
    expect(stateWhileBlocked.captureDroppedRecords).toBeGreaterThan(0);
    release();
    await Promise.all(records);
    await store.drain();
    expect(store.runtimeState().capturePendingRecordBytes).toBe(0);
  });

  test("drain waits for body finalization tasks that have not called record yet", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "proxy-store-finalizer-drain-"));
    const store = new ProxyExchangeStore({dataDir});
    await store.init();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const trackCaptureMethod = (
      store as ProxyExchangeStore & {trackCapture?: (task: Promise<unknown>) => void}
    ).trackCapture;
    const trackCapture = trackCaptureMethod?.bind(store);
    expect(trackCapture).toBeTypeOf("function");
    trackCapture?.(gate.then(() => store.record(makeInput("after-finalize"))));

    let drained = false;
    const draining = store.drain().then(() => { drained = true; });
    await delay(20);
    expect(drained).toBe(false);

    release();
    await draining;
    expect(store.runtimeState()).toMatchObject({
      capturePendingTasks: 0,
      capturePendingRecordBytes: 0,
      activeFinalizers: 0,
    });
  });
});

function makeInput(marker: string, model = "gpt-test") {
  const requestText = JSON.stringify({model, input: marker});
  const responseText = JSON.stringify({output: marker});
  return {
    capturedAt: "2026-07-21T00:00:00.000Z",
    completedAt: "2026-07-21T00:00:00.010Z",
    model,
    routing: {
      targetId: "target",
      targetName: "Target",
      targetFormatHint: "openai" as const,
      localUrl: "/v1/responses",
      upstreamUrl: "https://example.test/v1/responses",
      localPath: "/v1/responses",
      upstreamPath: "/v1/responses",
      method: "POST",
    },
    request: {
      headers: {"content-type": "application/json"},
      body: inlineBody(requestText),
    },
    response: {
      status: 200,
      statusText: "OK",
      headers: {"content-type": "application/json"},
      body: inlineBody(responseText),
      isStreaming: false,
    },
  };
}

function inlineBody(rawBody: string): CollectedRawBody {
  const body = Buffer.from(rawBody);
  const bodySha256 = createHash("sha256").update(body).digest("hex");
  return {
    rawBody,
    rawBodyRef: {storage: "inline", encoding: "identity", sha256: bodySha256, sizeBytes: body.length},
    bodySizeBytes: body.length,
    bodySha256,
    missing: false,
  };
}
