/**
 * Harness 证据层：模型参数白名单值投影（P1，2026-09-11）。
 *
 * 背景：projectArtifactParams 只持久化参数键名 + 指纹，reasoning effort /
 * thinking 预算 / max_tokens 等值在 SQLite 不可查，用户无法回答「这两步为什么
 * 费用差 10 倍——是 effort 调高了还是上下文涨了」。
 *
 * 本模块按有界白名单把参数**值**投影为可查询的小对象：
 * - 顶层标量键（max_tokens / temperature / …）与一层对象键（reasoning / thinking /
 *   text / output_config / tool_choice）；
 * - 字符串值截断 64 字符、对象只取一层已知子键、总键数 ≤ 24；
 * - 排除一切身分类与内容载荷字段（metadata / messages / include 聚合等）。
 * 红线：仅展示参考，不参与计价、不参与 paramsHash 身份。
 */

const SCALAR_KEYS = new Set([
  "max_tokens",
  "max_output_tokens",
  "max_completion_tokens",
  "temperature",
  "top_p",
  "parallel_tool_calls",
  "store",
  "stream",
  "service_tier",
  "prompt_cache_key",
  "previous_response_id",
]);

/** 一层对象键 → 允许保留的子键。 */
const OBJECT_KEYS: Record<string, ReadonlySet<string>> = {
  reasoning: new Set(["effort", "summary"]),
  thinking: new Set(["type", "budget_tokens"]),
  text: new Set(["verbosity"]),
  output_config: new Set(["effort"]),
  tool_choice: new Set(["type", "name", "disable_parallel_tool_use"]),
};

const MAX_ENTRIES = 24;
const STRING_VALUE_LIMIT = 64;

export type ParamDetails = Record<string, string | number | boolean | Record<string, string | number | boolean>>;

/** 按白名单投影参数值；无可识别键时返回 undefined（旧数据/无参数请求）。 */
export function projectParamDetails(
  params: Record<string, unknown> | undefined,
): ParamDetails | undefined {
  if (!params) return undefined;
  const result: ParamDetails = {};
  for (const [key, rawValue] of Object.entries(params)) {
    if (Object.keys(result).length >= MAX_ENTRIES) break;
    const scalarKey = SCALAR_KEYS.has(key);
    const objectSubKeys = OBJECT_KEYS[key];
    if (!scalarKey && !objectSubKeys) continue;
    if (scalarKey && !objectSubKeys) {
      const value = scalarValue(rawValue);
      if (value !== undefined) result[key] = value;
      continue;
    }
    if (typeof rawValue === "string" || typeof rawValue === "number" || typeof rawValue === "boolean") {
      // tool_choice 等 hybrid 键既允许字符串（"auto"）也允许对象。
      const value = scalarValue(rawValue);
      if (value !== undefined) result[key] = value;
      continue;
    }
    if (rawValue !== null && typeof rawValue === "object" && !Array.isArray(rawValue)) {
      const nested: Record<string, string | number | boolean> = {};
      const record = rawValue as Record<string, unknown>;
      for (const subKey of objectSubKeys) {
        const value = scalarValue(record[subKey]);
        if (value !== undefined) nested[subKey] = value;
      }
      if (Object.keys(nested).length > 0) result[key] = nested;
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/** 值级参数变化（白名单键，from/to 均为投影后标量或一层对象）。 */
export interface ParamDetailChange {
  key: string;
  from: string;
  to: string;
}

const MAX_CHANGES = 24;

export function diffParamDetails(
  from: ParamDetails | undefined,
  to: ParamDetails | undefined,
): ParamDetailChange[] {
  if (!from && !to) return [];
  const keys = new Set([...Object.keys(from ?? {}), ...Object.keys(to ?? {})]);
  const changes: ParamDetailChange[] = [];
  for (const key of [...keys].sort()) {
    if (changes.length >= MAX_CHANGES) break;
    const before = canonicalValue(from?.[key]);
    const after = canonicalValue(to?.[key]);
    if (before === after) continue;
    changes.push({key, from: before, to: after});
  }
  return changes;
}

function canonicalValue(value: ParamDetails[string] | undefined): string {
  if (value === undefined) return "∅";
  if (typeof value === "object") {
    const text = JSON.stringify(value);
    return text.length > STRING_VALUE_LIMIT ? `${text.slice(0, STRING_VALUE_LIMIT - 1)}…` : text;
  }
  return String(value);
}

function scalarValue(rawValue: unknown): string | number | boolean | undefined {
  if (typeof rawValue === "number") return Number.isFinite(rawValue) ? rawValue : undefined;
  if (typeof rawValue === "boolean") return rawValue;
  if (typeof rawValue === "string") {
    const trimmed = rawValue.trim();
    if (!trimmed) return undefined;
    return trimmed.length > STRING_VALUE_LIMIT
      ? `${trimmed.slice(0, STRING_VALUE_LIMIT - 1)}…`
      : trimmed;
  }
  return undefined;
}
