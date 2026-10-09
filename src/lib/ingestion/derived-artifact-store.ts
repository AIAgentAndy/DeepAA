import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

/**
 * 派生物外置存储（docs/上线前架构升级改造.md P1-6，决策 D2）。
 *
 * context_snapshots / step_diffs 的 JSON 摘要 ≤16 KiB 内联 SQLite；超过则写入
 * `<dataDir>/derived-blobs/<hash[0:2]>/<sha256>.json.gz` 内容寻址文件（幂等去重），
 * SQLite 行只存 artifact_hash + artifact_size。存量 inline 行零迁移，读取端永久
 * 兼容双策略；清理 raw 时对相关行置墓碑并清空 artifact_hash，GC 据此回收文件。
 *
 * 文件很小（原文硬上限 256 KiB，gz 后通常几十 KiB），使用同步 fs + zlib：调用点
 * 位于派生提交的同步事务内，与 better-sqlite3 的同步语义一致。
 */

export const DERIVED_ARTIFACT_INLINE_MAX_BYTES = 16 * 1024;
/** 派生物原文读取硬上限：略高于写入端 256 KiB 投影预算，防御异常文件。 */
export const DERIVED_ARTIFACT_READ_MAX_BYTES = 512 * 1024;
export const DERIVED_ARTIFACT_DIR_NAME = "derived-blobs";

export interface DerivedArtifactPlacement {
  storage: "inline" | "external";
  hash: string | null;
  /** 原文（未压缩）UTF-8 字节数，即 size_bytes 列的口径。 */
  sizeBytes: number;
}

export interface DerivedArtifactRow {
  artifact_storage: string | null;
  artifact_hash: string | null;
  inline_json: string;
}

export function derivedArtifactPath(dataDir: string, hash: string): string {
  return join(dataDir, DERIVED_ARTIFACT_DIR_NAME, hash.slice(0, 2), `${hash}.json.gz`);
}

/** 计算放置策略并落盘（external 时）；幂等：同内容哈希只写一次文件。 */
export function placeDerivedArtifact(
  dataDir: string,
  json: string,
  inlineMaxBytes: number = DERIVED_ARTIFACT_INLINE_MAX_BYTES,
): DerivedArtifactPlacement {
  const sizeBytes = Buffer.byteLength(json, "utf8");
  if (sizeBytes <= inlineMaxBytes) {
    return {storage: "inline", hash: null, sizeBytes};
  }
  const hash = createHash("sha256").update(json, "utf8").digest("hex");
  const file = derivedArtifactPath(dataDir, hash);
  if (!existsSync(file)) {
    mkdirSync(dirname(file), {recursive: true});
    writeFileSync(file, gzipSync(Buffer.from(json, "utf8")));
  }
  return {storage: "external", hash, sizeBytes};
}

/** external 行在 SQLite 正文列中的占位 JSON（保持 NOT NULL 与 json 可解析性）。 */
export function externalDerivedArtifactPlaceholder(placement: DerivedArtifactPlacement): string {
  return JSON.stringify({
    artifact: "external",
    hash: placement.hash,
    sizeBytes: placement.sizeBytes,
  });
}

/** 清理 raw 时的墓碑占位 JSON。 */
export function purgedDerivedArtifactPlaceholder(sizeBytes: number): string {
  return JSON.stringify({artifact: "purged", sizeBytes});
}

/**
 * 读取派生物原文：inline 行直接取列；external 行读 gz 文件。文件缺失/损坏/超限
 * 返回 null，调用方降级为「不可用」而不是崩溃。
 */
export function resolveDerivedArtifactJson(
  dataDir: string | undefined,
  row: DerivedArtifactRow,
): string | null {
  if (row.artifact_storage !== "external") {
    return row.inline_json ?? null;
  }
  if (!dataDir || !row.artifact_hash) return null;
  try {
    const gz = readFileSync(derivedArtifactPath(dataDir, row.artifact_hash));
    const text = gunzipSync(gz).toString("utf8");
    if (Buffer.byteLength(text, "utf8") > DERIVED_ARTIFACT_READ_MAX_BYTES) {
      return null;
    }
    return text;
  } catch {
    return null;
  }
}

/** 从派生物原文 JSON 中摘取 failover 元数据（与 SQL json_extract 双路径一致）。 */
export function extractFailoverFromArtifactJson(text: string): string | null {
  try {
    const parsed = JSON.parse(text) as {
      failover?: unknown;
      snapshot?: {failover?: unknown};
    };
    const failover = parsed.failover ?? parsed.snapshot?.failover;
    if (failover === undefined || failover === null) return null;
    const serialized = JSON.stringify(failover);
    return serialized === "{}" ? null : serialized;
  } catch {
    return null;
  }
}
