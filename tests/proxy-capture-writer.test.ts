import {mkdtemp, mkdir, readFile, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {describe, expect, test} from "vitest";
import * as captureWriterModule from "../src/proxy/capture-writer.js";
import {
  appendRawCapturedExchangeV2,
  createV2CaptureSessionId,
} from "../src/proxy/capture-writer.js";
import type {RawCapturedExchangeV2} from "../src/proxy/raw-v2-contract.js";

describe("proxy capture writer", () => {
  test("repairs only the partial JSONL tail and appends a stable v2 field order", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "proxy-writer-tail-"));
    const exchange = makeExchange();
    const captureDir = join(dataDir, "captures", "v2");
    const filePath = join(captureDir, `${exchange.captureSessionId}.jsonl`);
    await mkdir(captureDir, {recursive: true});
    await writeFile(filePath, '{"existing":true}\n{"partial"', "utf8");

    const result = await appendRawCapturedExchangeV2(dataDir, exchange);
    const lines = (await readFile(filePath, "utf8")).trimEnd().split("\n");
    const persisted = JSON.parse(lines[1]!) as Record<string, unknown>;

    expect(result.byteOffset).toBe(Buffer.byteLength('{"existing":true}\n'));
    expect(lines).toHaveLength(2);
    expect(Object.keys(persisted)).toEqual([
      "schemaVersion", "exchangeId", "captureSessionId", "sequence", "capturedAt",
      "completedAt", "durationMs", "routing", "request", "response", "bodyStorage",
      "captureDiagnostics", "security",
    ]);
  });

  test("持久化 routing.clientCredentialId 供派生读取密钥价格倍率", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "proxy-writer-credential-"));
    const exchange = makeExchange();
    const captureDir = join(dataDir, "captures", "v2");
    const filePath = join(captureDir, `${exchange.captureSessionId}.jsonl`);
    await mkdir(captureDir, {recursive: true});

    await appendRawCapturedExchangeV2(dataDir, exchange);

    const persisted = JSON.parse(
      (await readFile(filePath, "utf8")).trimEnd(),
    ) as {routing?: {clientCredentialId?: string}};
    expect(persisted.routing?.clientCredentialId).toBe("cred_test_1");
  });

  test("持久化 firstTokenMs（首字时间）且缺失时不输出空键", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "proxy-writer-ttft-"));
    const captureDir = join(dataDir, "captures", "v2");
    const withTtft = makeExchange({firstTokenMs: 420});
    const withoutTtft = makeExchange();
    // 追加到同一 capture 文件：共享 sessionId，仅递增 sequence。
    withoutTtft.captureSessionId = withTtft.captureSessionId;
    withoutTtft.sequence = 2;
    withoutTtft.exchangeId = `${withoutTtft.captureSessionId}:ex-2`;
    await mkdir(captureDir, {recursive: true});

    await appendRawCapturedExchangeV2(dataDir, withTtft);
    await appendRawCapturedExchangeV2(dataDir, withoutTtft);

    const lines = (await readFile(join(captureDir, `${withTtft.captureSessionId}.jsonl`), "utf8")).trimEnd().split("\n");
    const first = JSON.parse(lines[0]!) as Record<string, unknown>;
    const second = JSON.parse(lines[1]!) as Record<string, unknown>;
    expect(first.firstTokenMs).toBe(420);
    expect("firstTokenMs" in second).toBe(false);
  });

  test("持久化 routing 的 agent/wireApi/requestedModel/routeMode 供派生层精确溯源", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "proxy-writer-routing-"));
    const exchange = makeExchange();
    const captureDir = join(dataDir, "captures", "v2");
    const filePath = join(captureDir, `${exchange.captureSessionId}.jsonl`);
    await mkdir(captureDir, {recursive: true});

    await appendRawCapturedExchangeV2(dataDir, exchange);

    const persisted = JSON.parse(
      (await readFile(filePath, "utf8")).trimEnd(),
    ) as {routing?: Record<string, unknown>};
    expect(persisted.routing).toMatchObject({
      agent: "opencode",
      wireApi: "responses",
      requestedModel: "gpt-test_target",
      routeMode: "model",
      clientCredentialId: "cred_test_1",
    });
  });

  test("serializes concurrent appends to one capture file", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "proxy-writer-concurrent-"));
    const first = makeExchange();
    const second = {...first, exchangeId: `${first.captureSessionId}:ex-2`, sequence: 2};

    await Promise.all([
      appendRawCapturedExchangeV2(dataDir, first),
      appendRawCapturedExchangeV2(dataDir, second),
    ]);
    const filePath = join(dataDir, "captures", "v2", `${first.captureSessionId}.jsonl`);
    const lines = (await readFile(filePath, "utf8")).trimEnd().split("\n");
    expect(lines.map(line => JSON.parse(line).sequence)).toEqual([1, 2]);
  });

  test("batches a burst of concurrent appends without changing JSONL offsets", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "proxy-writer-batch-"));
    const base = makeExchange();
    const exchanges = Array.from({length: 256}, (_, index) => ({
      ...base,
      exchangeId: `${base.captureSessionId}:ex-${index + 1}`,
      sequence: index + 1,
    }));
    const runtimeState = (
      captureWriterModule as typeof captureWriterModule & {
        captureWriterRuntimeState?: () => {
          openedFileBatches: number;
          writeOperations: number;
        };
      }
    ).captureWriterRuntimeState;
    const stateBefore = runtimeState?.();

    const locations = await Promise.all(
      exchanges.map(exchange => appendRawCapturedExchangeV2(dataDir, exchange)),
    );

    const stateAfter = runtimeState?.();
    expect(stateAfter).toBeDefined();
    expect(stateAfter!.openedFileBatches - (stateBefore?.openedFileBatches ?? 0)).toBeLessThanOrEqual(4);
    expect(stateAfter!.writeOperations - (stateBefore?.writeOperations ?? 0)).toBeLessThanOrEqual(4);
    expect(new Set(locations.map(location => location.byteOffset))).toHaveLength(exchanges.length);
    const file = await readFile(locations[0]!.filePath, "utf8");
    expect(file.trimEnd().split("\n").map(line => JSON.parse(line).sequence)).toEqual(
      exchanges.map(exchange => exchange.sequence),
    );
  });

  test("bounds verified offset metadata across long-running capture sessions", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "proxy-writer-offset-cache-"));
    const runtimeState = captureWriterModule.captureWriterRuntimeState as () => {
      verifiedOffsetEntries: number;
      maxVerifiedOffsetEntries: number;
    };
    const maximum = runtimeState().maxVerifiedOffsetEntries;
    expect(maximum).toBeGreaterThanOrEqual(1_000);
    for (let index = 0; index < maximum + 8; index += 1) {
      const exchange = makeExchange();
      const captureSessionId = createV2CaptureSessionId(1_752_643_200_001 + index);
      await appendRawCapturedExchangeV2(dataDir, {
        ...exchange,
        captureSessionId,
        exchangeId: `${captureSessionId}:ex-1`,
      });
    }

    expect(runtimeState().verifiedOffsetEntries).toBeLessThanOrEqual(maximum);
  }, 30_000);
});

function makeExchange(options?: {firstTokenMs?: number}): RawCapturedExchangeV2 {
  const captureSessionId = createV2CaptureSessionId(1_752_643_200_000);
  const emptySha = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
  return {
    schemaVersion: 2,
    exchangeId: `${captureSessionId}:ex-1`,
    captureSessionId,
    sequence: 1,
    capturedAt: "2026-07-21T00:00:00.000Z",
    completedAt: "2026-07-21T00:00:00.010Z",
    durationMs: 10,
    ...(options?.firstTokenMs !== undefined ? {firstTokenMs: options.firstTokenMs} : {}),
    routing: {
      targetId: "target",
      targetName: "Target",
      targetFormatHint: "openai",
      localUrl: "/v1/responses",
      upstreamUrl: "https://example.test/v1/responses",
      localPath: "/v1/responses",
      upstreamPath: "/v1/responses",
      method: "POST",
      requestedModel: "gpt-test_target",
      routeMode: "model",
      clientCredentialId: "cred_test_1",
      agent: "opencode",
      wireApi: "responses",
    },
    request: {headers: {}, rawBody: "", bodySizeBytes: 0, bodySha256: emptySha},
    response: {
      status: 200,
      statusText: "OK",
      headers: {},
      rawBody: "",
      bodySizeBytes: 0,
      bodySha256: emptySha,
      isStreaming: false,
    },
    bodyStorage: {policy: "inline", compression: "gzip", externalBlobDir: "blobs", thresholdBytes: 262144},
    captureDiagnostics: [],
    security: {containsSensitiveHeaders: false, headerRedactionAppliedInApi: true, rawBodiesStoredLocally: true},
  };
}
