import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  DERIVED_ARTIFACT_INLINE_MAX_BYTES,
  derivedArtifactPath,
  extractFailoverFromArtifactJson,
  externalDerivedArtifactPlaceholder,
  placeDerivedArtifact,
  purgedDerivedArtifactPlaceholder,
  resolveDerivedArtifactJson,
} from "../src/lib/ingestion/derived-artifact-store";

/** P1-6 派生物外置：inline/external 双策略、幂等落盘、缺失降级、failover 提取。 */

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "deepaa-artifact-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, {recursive: true, force: true})));
});

describe("derived artifact store", () => {
  test("小 JSON 内联、大 JSON 外置内容寻址 gz 且幂等", async () => {
    const dataDir = await tempRoot();
    const small = placeDerivedArtifact(dataDir, JSON.stringify({k: "v"}));
    expect(small.storage).toBe("inline");
    expect(small.hash).toBeNull();

    const bigText = JSON.stringify({k: "x".repeat(64 * 1024)});
    const big = placeDerivedArtifact(dataDir, bigText);
    expect(big.storage).toBe("external");
    expect(big.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(big.sizeBytes).toBe(Buffer.byteLength(bigText, "utf8"));
    expect(big.sizeBytes).toBeGreaterThan(DERIVED_ARTIFACT_INLINE_MAX_BYTES);

    // 幂等：同内容再次放置返回同一 hash，不重复写文件。
    const again = placeDerivedArtifact(dataDir, bigText);
    expect(again.hash).toBe(big.hash);

    // 读取 roundtrip。
    const resolved = resolveDerivedArtifactJson(dataDir, {
      artifact_storage: "external",
      artifact_hash: big.hash,
      inline_json: externalDerivedArtifactPlaceholder(big),
    });
    expect(resolved).toBe(bigText);

    // inline 行直接取列。
    expect(resolveDerivedArtifactJson(dataDir, {
      artifact_storage: "inline",
      artifact_hash: null,
      inline_json: "{\"a\":1}",
    })).toBe("{\"a\":1}");
  });

  test("external 文件缺失/无 dataDir/损坏时降级为 null，绝不抛出", async () => {
    const dataDir = await tempRoot();
    expect(resolveDerivedArtifactJson(undefined, {
      artifact_storage: "external",
      artifact_hash: "a".repeat(64),
      inline_json: "{}",
    })).toBeNull();
    expect(resolveDerivedArtifactJson(dataDir, {
      artifact_storage: "external",
      artifact_hash: "b".repeat(64),
      inline_json: "{}",
    })).toBeNull();
    // 损坏 gz。
    const hash = placeDerivedArtifact(dataDir, JSON.stringify({k: "y".repeat(32 * 1024)})).hash!;
    await writeFile(derivedArtifactPath(dataDir, hash), "not-gzip");
    expect(resolveDerivedArtifactJson(dataDir, {
      artifact_storage: "external",
      artifact_hash: hash,
      inline_json: "{}",
    })).toBeNull();
  });

  test("failover 提取与墓碑占位", () => {
    const failover = {fromModel: "a", toModel: "b", trigger: "http_5xx", attempts: 2};
    expect(extractFailoverFromArtifactJson(
      JSON.stringify({failover}),
    )).toBe(JSON.stringify(failover));
    expect(extractFailoverFromArtifactJson(
      JSON.stringify({snapshot: {failover}}),
    )).toBe(JSON.stringify(failover));
    expect(extractFailoverFromArtifactJson(JSON.stringify({}))).toBeNull();
    expect(extractFailoverFromArtifactJson("not-json")).toBeNull();
    expect(extractFailoverFromArtifactJson(JSON.stringify({failover: {}}))).toBeNull();

    const tombstone = purgedDerivedArtifactPlaceholder(4096);
    expect(JSON.parse(tombstone)).toEqual({artifact: "purged", sizeBytes: 4096});
  });
});
