import {SyncAuthRequiredError, SyncUnsupportedError} from "../../types";

export const MAX_PLAN_RESPONSE_BYTES = 1024 * 1024;
export const PLAN_REQUEST_TIMEOUT_MS = 15_000;

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/** 只接受有限数字或可无损转为有限数字的非空字符串。 */
export function finiteNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string" || !value.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** 兼容 ISO 字符串、秒级或毫秒级时间戳；无效/非正值不伪造重置时间。 */
export function normalizeResetAt(value: unknown): string | undefined {
  if (typeof value === "string") {
    const numeric = finiteNumber(value);
    if (numeric !== undefined) return normalizeResetAt(numeric);
    const millis = Date.parse(value);
    return Number.isFinite(millis) ? new Date(millis).toISOString() : undefined;
  }
  const numeric = finiteNumber(value);
  if (numeric === undefined || numeric <= 0) return undefined;
  const millis = numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
  const date = new Date(millis);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

/** 流式读取最多 1 MiB，在 JSON.parse 前完成字节限制。 */
export async function readBoundedPlanJson(response: Response): Promise<unknown> {
  const declared = finiteNumber(response.headers.get("content-length"));
  if (declared !== undefined && declared > MAX_PLAN_RESPONSE_BYTES) {
    throw new Error("PLAN_RESPONSE_TOO_LARGE");
  }
  if (!response.body) return {};
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_PLAN_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("PLAN_RESPONSE_TOO_LARGE");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error("PLAN_RESPONSE_INVALID_JSON");
  }
}

export async function fetchPlanJson(
  url: string,
  authorization: string,
  fetchImpl: typeof fetch,
): Promise<unknown> {
  const response = await fetchImpl(url, {
    headers: {
      authorization,
      accept: "application/json",
      "content-type": "application/json",
    },
    signal: AbortSignal.timeout(PLAN_REQUEST_TIMEOUT_MS),
  });
  if (response.status === 401 || response.status === 403) {
    throw new SyncAuthRequiredError(`PLAN_AUTH_${response.status}`);
  }
  if (!response.ok) throw new Error(`PLAN_HTTP_${response.status}`);
  return await readBoundedPlanJson(response);
}

export async function resolveRequiredPlanCredential(
  credentialId: string | undefined,
  resolveCredential: (credentialId: string) => Promise<string>,
): Promise<string> {
  if (!credentialId) throw new SyncUnsupportedError("PLAN_CREDENTIAL_REQUIRED");
  const value = await resolveCredential(credentialId);
  if (!value) throw new SyncUnsupportedError("PLAN_CREDENTIAL_EMPTY");
  return value;
}
