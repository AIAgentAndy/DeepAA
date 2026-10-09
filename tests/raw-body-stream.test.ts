import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  openRawBodyStream,
  type RawBodyStreamResult,
} from "../src/lib/harness/raw-body-stream";
import { storeRawBody } from "../src/lib/harness/raw-body";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(path =>
    rm(path, { recursive: true, force: true })));
});

describe("安全 Raw body stream", () => {
  test.each([
    ["inline", { inlineThresholdBytes: 512 * 1024, compressedInlineThresholdBytes: 1024 * 1024 }],
    ["compressed-inline", { inlineThresholdBytes: 1, compressedInlineThresholdBytes: 1024 * 1024 }],
    ["external-blob", { inlineThresholdBytes: 1, compressedInlineThresholdBytes: 2 }],
  ] as const)("%s 固定 chunk 输出并复核完整正文", async (storage, policy) => {
    const dataDir = await tempDataDir();
    const body = JSON.stringify({
      text: "流式正文".repeat(40_000),
      marker: `storage-${storage}`,
    });
    const stored = await storeRawBody(dataDir, body, policy);
    expect(stored.reference.storage).toBe(storage);

    const opened = await openRawBodyStream(dataDir, {
      rawBody: stored.inline,
      rawBodyRef: stored.reference,
      bodySizeBytes: Buffer.byteLength(body),
      bodySha256: sha256(body),
    }, { purpose: "raw", label: "request" });
    const { body: streamed, maxChunkBytes } = await collect(opened);

    expect(streamed).toBe(body);
    expect(maxChunkBytes).toBeLessThanOrEqual(64 * 1024);
    await expect(opened.verification).resolves.toEqual({
      status: "verified",
      decodedBytes: Buffer.byteLength(body),
      sha256: sha256(body),
    });
  });

  test("Worker 投影预算受限不影响同一正文的完整 Raw 流", async () => {
    const dataDir = await tempDataDir();
    const body = JSON.stringify({ text: "x".repeat(300_000) });
    const stored = await storeRawBody(dataDir, body, {
      inlineThresholdBytes: 1,
      compressedInlineThresholdBytes: 2,
    });
    const source = {
      rawBody: stored.inline,
      rawBodyRef: stored.reference,
      bodySizeBytes: Buffer.byteLength(body),
      bodySha256: sha256(body),
    };

    const projection = await openRawBodyStream(dataDir, source, {
      purpose: "projection",
      label: "request",
      maxDecodedBytes: 128 * 1024,
    });
    const projected = await collect(projection);
    expect(Buffer.byteLength(projected.body)).toBe(128 * 1024);
    await expect(projection.verification).resolves.toMatchObject({
      status: "not_verified_budget",
      decodedBytes: 128 * 1024,
    });

    const raw = await openRawBodyStream(dataDir, source, {
      purpose: "raw",
      label: "request",
    });
    expect((await collect(raw)).body).toBe(body);
    await expect(raw.verification).resolves.toMatchObject({ status: "verified" });
  });

  test("声明 hash 不一致时流以完整性错误结束", async () => {
    const dataDir = await tempDataDir();
    const body = JSON.stringify({ text: "integrity" });
    const stored = await storeRawBody(dataDir, body, {
      inlineThresholdBytes: 1,
      compressedInlineThresholdBytes: 1024,
    });
    const opened = await openRawBodyStream(dataDir, {
      rawBodyRef: { ...stored.reference, sha256: "0".repeat(64) },
      bodySizeBytes: Buffer.byteLength(body),
      bodySha256: "0".repeat(64),
    }, { purpose: "raw", label: "response" });

    await expect(collect(opened)).rejects.toMatchObject({
      code: "raw_body_integrity_failed",
    });
    await expect(opened.verification).resolves.toMatchObject({ status: "failed" });
  });
});

async function tempDataDir(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "deepaa-raw-stream-"));
  tempDirs.push(path);
  return path;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function collect(
  opened: RawBodyStreamResult,
): Promise<{ body: string; maxChunkBytes: number }> {
  const chunks: Buffer[] = [];
  let maxChunkBytes = 0;
  for await (const chunk of opened.stream) {
    const bytes = Buffer.from(chunk as Uint8Array);
    chunks.push(bytes);
    maxChunkBytes = Math.max(maxChunkBytes, bytes.length);
  }
  return { body: Buffer.concat(chunks).toString("utf8"), maxChunkBytes };
}
