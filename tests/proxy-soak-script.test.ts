import {createHash} from "node:crypto";
import {mkdir, mkdtemp, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {gzipSync} from "node:zlib";
import {describe, expect, test} from "vitest";
import * as soakModule from "../scripts/proxy-soak.mjs";
import {
  buildSoakRuntimeConfig,
  createSoakRequest,
  parseSoakArguments,
} from "../scripts/proxy-soak.mjs";

describe("代理 soak 参数", () => {
  test("默认运行 24 小时并使用有界并发和报告周期", () => {
    expect(parseSoakArguments([])).toEqual({
      durationMs: 24 * 60 * 60 * 1_000,
      requestLimit: Number.POSITIVE_INFINITY,
      concurrency: 32,
      reportIntervalMs: 60_000,
      sseEvery: 100,
      sseDelayMs: 1_000,
      largeEvery: 0,
      largeBodyBytes: 1024 * 1024,
      keepData: false,
    });
  });

  test("支持短时发布门禁参数", () => {
    expect(parseSoakArguments([
      "--duration-ms", "30000",
      "--requests", "10000",
      "--concurrency", "64",
      "--report-ms", "5000",
      "--sse-every", "50",
      "--sse-delay-ms", "1500",
      "--large-every", "10",
      "--large-body-bytes", "2097152",
      "--keep-data",
    ])).toEqual({
      durationMs: 30_000,
      requestLimit: 10_000,
      concurrency: 64,
      reportIntervalMs: 5_000,
      sseEvery: 50,
      sseDelayMs: 1_500,
      largeEvery: 10,
      largeBodyBytes: 2 * 1024 * 1024,
      keepData: true,
    });
  });

  test("拒绝无界或非法并发参数", () => {
    expect(() => parseSoakArguments(["--concurrency", "0"])).toThrow("concurrency");
    expect(() => parseSoakArguments(["--requests", "NaN"])).toThrow("requests");
    expect(() => parseSoakArguments(["--unknown", "1"])).toThrow("unknown");
  });

  test("使用 V3 配置、Codex Agent 路径与带目标前缀的模型", () => {
    expect(buildSoakRuntimeConfig("http://127.0.0.1:4567/v1")).toMatchObject({
      version: 3,
      agentConnections: {},
      targets: [{
        id: "soak-target",
        openaiUrl: "http://127.0.0.1:4567/v1",
        supportedModels: ["soak-model"],
        development: {defaultCredentials: {codex: "soak-cred"}},
      }],
    });
    const regular = createSoakRequest(1, {
      sseEvery: 100,
      largeEvery: 0,
      largeBodyBytes: 1024,
    });
    const streaming = createSoakRequest(100, {
      sseEvery: 100,
      largeEvery: 0,
      largeBodyBytes: 1024,
    });
    const large = createSoakRequest(10, {
      sseEvery: 100,
      largeEvery: 10,
      largeBodyBytes: 1024,
    });

    expect(regular).toMatchObject({path: "/codex/v1/responses", body: {model: "soak-model_soak-target"}});
    expect(streaming).toMatchObject({path: "/codex/v1/responses", streaming: true});
    expect(large).toMatchObject({path: "/codex/v1/responses", large: true});
  });

  test("逐条验证 inline 和 external blob 的正文大小与 SHA", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "proxy-soak-integrity-"));
    const captureDir = join(dataDir, "captures", "v2");
    const blobDir = join(dataDir, "blobs", "aa");
    await Promise.all([
      mkdir(captureDir, {recursive: true}),
      mkdir(blobDir, {recursive: true}),
    ]);
    const requestBody = "inline-body";
    const responseBody = "external-body";
    const responseGzip = gzipSync(responseBody);
    const responsePath = join("blobs", "aa", "response.body.gz");
    await writeFile(join(dataDir, responsePath), responseGzip);
    await writeFile(join(captureDir, "fixture.jsonl"), `${JSON.stringify({
      schemaVersion: 2,
      request: bodyRecord(requestBody, {storage: "inline", encoding: "identity"}),
      response: bodyRecord(responseBody, {
        storage: "external-blob",
        encoding: "gzip",
        externalPath: responsePath,
        compressedSizeBytes: responseGzip.length,
      }, false),
    })}\n`, "utf8");
    const inspectRaw = (
      soakModule as typeof soakModule & {
        inspectRaw?: (root: string) => Promise<{invalidBodies: number; missingBodies: number}>;
      }
    ).inspectRaw;
    expect(inspectRaw).toBeTypeOf("function");

    await expect(inspectRaw!(dataDir)).resolves.toMatchObject({
      exchangeCount: 1,
      invalidBodies: 0,
      missingBodies: 0,
    });
    await writeFile(join(dataDir, responsePath), gzipSync("corrupted"));
    await expect(inspectRaw!(dataDir)).resolves.toMatchObject({invalidBodies: 1});
  });
});

function bodyRecord(
  body: string,
  reference: Record<string, unknown>,
  inline = true,
) {
  const bytes = Buffer.from(body);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return {
    ...(inline ? {rawBody: body} : {}),
    rawBodyRef: {...reference, sha256, sizeBytes: bytes.length},
    bodySizeBytes: bytes.length,
    bodySha256: sha256,
  };
}
