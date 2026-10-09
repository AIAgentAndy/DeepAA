import { createHash, type Hash } from "node:crypto";

const PARAMS_FINGERPRINT_CONTAINER_LIMIT = 64;
const PARAMS_FINGERPRINT_GLOBAL_ITEM_LIMIT = 256;
const PARAMS_FINGERPRINT_DEPTH_LIMIT = 4;

export interface ParamsFingerprint {
  stableHash: string;
  complete: boolean;
  candidateItemCount: number;
  processedItemCount: number;
  candidateTextBytes: number;
  processedTextBytes: number;
}

interface FingerprintState {
  hash: Hash;
  complete: boolean;
  candidateItemCount: number;
  processedItemCount: number;
  candidateTextBytes: number;
  processedTextBytes: number;
  ancestors: Set<object>;
}

/**
 * 以有界、类型化 token 流计算 params 专属摘要，避免构造包含敏感原值的完整 JSON 副本。
 */
export function createParamsFingerprint(params: Record<string, unknown>): ParamsFingerprint {
  const state: FingerprintState = {
    hash: createHash("sha256"),
    complete: true,
    candidateItemCount: 0,
    processedItemCount: 0,
    candidateTextBytes: 0,
    processedTextBytes: 0,
    ancestors: new Set(),
  };
  writeFramedText(state.hash, "version", "params-fingerprint-v1");
  writeValue(state, params, 0);
  return {
    stableHash: state.hash.digest("hex").slice(0, 16),
    complete: state.complete,
    candidateItemCount: state.candidateItemCount,
    processedItemCount: state.processedItemCount,
    candidateTextBytes: state.candidateTextBytes,
    processedTextBytes: state.processedTextBytes,
  };
}

/** 兼容旧 fixture 与已脱敏 artifact；无法证明完整时必须保留 incomplete 语义。 */
export function resolveParamsFingerprint(
  params: Record<string, unknown>,
  existing?: ParamsFingerprint,
): ParamsFingerprint {
  if (isParamsFingerprint(existing)) return existing;
  const redactedHash = params.redacted === true && typeof params.stableHash === "string"
    ? params.stableHash
    : undefined;
  if (redactedHash) {
    const rawKeys = Array.isArray(params.keys) ? params.keys : [];
    const inspectedKeyCount = Math.min(
      rawKeys.length,
      PARAMS_FINGERPRINT_CONTAINER_LIMIT + 1,
    );
    let candidateTextBytes = 0;
    for (let index = 0; index < inspectedKeyCount; index += 1) {
      const key = rawKeys[index];
      if (typeof key === "string") candidateTextBytes += Buffer.byteLength(key);
    }
    return {
      stableHash: redactedHash,
      complete: false,
      candidateItemCount: rawKeys.length,
      processedItemCount: 0,
      candidateTextBytes,
      processedTextBytes: 0,
    };
  }
  return createParamsFingerprint(params);
}

function writeValue(state: FingerprintState, value: unknown, depth: number): void {
  if (depth > PARAMS_FINGERPRINT_DEPTH_LIMIT) {
    state.complete = false;
    state.hash.update("depth-limit;");
    if (typeof value === "string") {
      state.candidateTextBytes += Buffer.byteLength(value);
    }
    return;
  }
  if (value === null) {
    state.hash.update("null;");
    return;
  }
  if (typeof value === "string") {
    const textBytes = Buffer.byteLength(value);
    state.candidateTextBytes += textBytes;
    state.processedTextBytes += textBytes;
    writeFramedText(state.hash, "string", value, textBytes);
    return;
  }
  if (typeof value === "boolean") {
    state.hash.update(value ? "boolean:1;" : "boolean:0;");
    return;
  }
  if (typeof value === "number") {
    writeFramedText(state.hash, "number", canonicalNumber(value));
    return;
  }
  if (typeof value === "bigint") {
    writeFramedText(state.hash, "bigint", value.toString());
    return;
  }
  if (value === undefined) {
    state.hash.update("undefined;");
    return;
  }
  if (typeof value === "symbol") {
    writeFramedText(state.hash, "symbol", value.description ?? "");
    return;
  }
  if (typeof value === "function") {
    writeFramedText(state.hash, "function", value.name);
    return;
  }
  if (state.ancestors.has(value)) {
    state.complete = false;
    state.hash.update("cycle;");
    return;
  }

  state.ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      writeArray(state, value, depth);
    } else {
      writeObject(state, value as Record<string, unknown>, depth);
    }
  } finally {
    state.ancestors.delete(value);
  }
}

function writeArray(state: FingerprintState, values: readonly unknown[], depth: number): void {
  writeFramedText(state.hash, "array-length", String(values.length));
  state.candidateItemCount += values.length;
  const containerItemCount = Math.min(values.length, PARAMS_FINGERPRINT_CONTAINER_LIMIT);
  if (values.length > containerItemCount) {
    state.complete = false;
    state.hash.update("array-container-limit;");
  }
  state.hash.update("array-start;");
  for (let index = 0; index < containerItemCount; index += 1) {
    if (!claimItemBudget(state)) break;
    writeFramedText(state.hash, "index", String(index));
    writeValue(state, index in values ? values[index] : null, depth + 1);
  }
  state.hash.update("array-end;");
}

function writeObject(
  state: FingerprintState,
  value: Record<string, unknown>,
  depth: number,
): void {
  const selectedKeys: string[] = [];
  let candidateCount = 0;
  let enumeratedKeyCount = 0;
  let containerLimited = false;
  // 前 64 个 own key 进入排序，第 65 个只作为超限探针，不为精确计数继续扫描。
  for (const key in value) {
    enumeratedKeyCount += 1;
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      candidateCount += 1;
      state.candidateTextBytes += Buffer.byteLength(key);
      if (candidateCount > PARAMS_FINGERPRINT_CONTAINER_LIMIT) {
        containerLimited = true;
        break;
      }
      selectedKeys.push(key);
    }
    if (enumeratedKeyCount >= PARAMS_FINGERPRINT_CONTAINER_LIMIT + 1) {
      containerLimited = true;
      break;
    }
  }
  selectedKeys.sort();
  state.candidateItemCount += candidateCount;
  if (containerLimited) {
    state.complete = false;
    state.hash.update("object-container-limit;");
  }
  writeFramedText(state.hash, "object-size", String(candidateCount));
  state.hash.update("object-start;");
  for (const key of selectedKeys) {
    if (!claimItemBudget(state)) break;
    const keyBytes = Buffer.byteLength(key);
    state.processedTextBytes += keyBytes;
    writeFramedText(state.hash, "key", key, keyBytes);
    writeValue(state, value[key], depth + 1);
  }
  state.hash.update("object-end;");
}

function claimItemBudget(state: FingerprintState): boolean {
  if (state.processedItemCount >= PARAMS_FINGERPRINT_GLOBAL_ITEM_LIMIT) {
    state.complete = false;
    state.hash.update("item-limit;");
    return false;
  }
  state.processedItemCount += 1;
  return true;
}

function writeFramedText(
  hash: Hash,
  type: string,
  value: string,
  byteLength = Buffer.byteLength(value),
): void {
  hash.update(type);
  hash.update(":");
  hash.update(String(byteLength));
  hash.update(":");
  hash.update(value);
  hash.update(";");
}

function canonicalNumber(value: number): string {
  if (Number.isNaN(value)) return "NaN";
  if (value === Number.POSITIVE_INFINITY) return "Infinity";
  if (value === Number.NEGATIVE_INFINITY) return "-Infinity";
  if (Object.is(value, -0)) return "-0";
  return String(value);
}

function isParamsFingerprint(value: unknown): value is ParamsFingerprint {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ParamsFingerprint>;
  return typeof candidate.stableHash === "string"
    && typeof candidate.complete === "boolean"
    && isNonNegativeSafeInteger(candidate.candidateItemCount)
    && isNonNegativeSafeInteger(candidate.processedItemCount)
    && isNonNegativeSafeInteger(candidate.candidateTextBytes)
    && isNonNegativeSafeInteger(candidate.processedTextBytes);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
