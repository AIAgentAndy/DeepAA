import type {NewApiSession} from "../adapters/newapi";

// sub2api 用户接口只有天粒度过滤，必须整日拉回再本地切小时；
// 站点单页上限 1000（response.go ParsePagination），500/页×40 页 = 2 万条/日。
const SUB2API_PAGE_SIZE = 500;
const SUB2API_MAX_PAGES = 40;
// new-api 明细接口单页上限 100；小时级时间戳过滤，1000 条/小时足够个人账号。
const NEWAPI_DETAIL_PAGE_SIZE = 100;
const NEWAPI_DETAIL_MAX_PAGES = 10;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;
const HOUR_FETCH_BUDGET_MS = 60_000;

/** 只保存对账所需的脱敏字段；不得把站点响应正文或凭据持久化。 */
export interface SiteUsageRecord {
  siteLogId: string;
  requestId?: string;
  apiKeyId?: string;
  model?: string;
  endpoint?: string;
  completedAt: string;
  durationMs?: number;
  inputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  outputTokens?: number;
  amountNano: number;
  /**
   * 站点明细明示的折扣节省额（nano，仅当站点声明折扣已应用且金额为非负有限数）。
   * 目前仅 sub2api fork（auto-code.net）返回 night_discount_saved_amount；
   * 上游 sub2api 与 new-api 无该字段，恒 undefined。归因展示只认此声明，
   * 禁止以比率巧合推断折扣。
   */
  siteDiscountNano?: number;
}

export interface SiteUsageSnapshot {
  amountNano: number | null;
  records: SiteUsageRecord[];
  complete: boolean;
  detailsComplete: boolean;
  limited: boolean;
  candidateCount: number;
  processedCount: number;
  source: "sub2api_usage" | "sub2api_trend" | "newapi_stat";
  reason?: string;
  /** 触发失败的站点 HTTP 状态（401/403/429 等）；网络/超时类无此字段。 */
  httpStatus?: number;
  /**
   * 完整观测可得到的轻量复查键（new-api stat quota / sub2api 日总数）。
   * 已定稿小时复查时键未变即跳过明细重拉；两站日志只增不改，键相同即数据相同。
   */
  lightCheckKey?: string;
}

function incomplete(
  source: SiteUsageSnapshot["source"],
  records: SiteUsageRecord[],
  candidateCount: number,
  processedCount: number,
  reason: string,
  limited = false,
  httpStatus?: number,
): SiteUsageSnapshot {
  return {amountNano: null, records, complete: false, detailsComplete: false,
    limited, candidateCount, processedCount, source, reason,
    ...(httpStatus !== undefined ? {httpStatus} : {})};
}

/** 站点取数失败必须区分底层原因（HTTP 状态/超时/超预算），禁止一句通用文案。 */
export function siteFailureDetail(error: unknown): string {
  if (!(error instanceof Error)) return "未知网络错误";
  if (error.message.startsWith("SITE_USAGE_HTTP_")) {
    const status = Number(error.message.slice("SITE_USAGE_HTTP_".length));
    const label = status === 401 || status === 403 ? "站点鉴权失败"
      : status === 404 ? "站点接口不存在"
      : status === 429 ? "站点限流"
      : `站点返回 ${status}`;
    return `SITE_USAGE_HTTP_${status}（${label}）`;
  }
  if (error.message === "SITE_USAGE_RESPONSE_LIMITED") return "SITE_USAGE_RESPONSE_LIMITED（单页响应超出字节预算）";
  if (error.name === "TimeoutError" || error.name === "AbortError") return "请求超时";
  return error.message.slice(0, 80) || "未知网络错误";
}

function siteHttpStatus(error: unknown): number | undefined {
  return error instanceof Error && error.message.startsWith("SITE_USAGE_HTTP_")
    ? Number(error.message.slice("SITE_USAGE_HTTP_".length)) || undefined
    : undefined;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function token(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function sumAmounts(rows: readonly SiteUsageRecord[]): number | undefined {
  let sum = 0;
  for (const row of rows) {
    sum += row.amountNano;
    if (!Number.isSafeInteger(sum)) return undefined;
  }
  return sum;
}

function text(value: unknown, maxLength = 256): string | undefined {
  return (typeof value === "string" && value.trim() && value.trim().length <= maxLength)
    ? value.trim() : undefined;
}

/** 响应流在 JSON.parse 前限流；远端违反 page_size 时不信任返回体大小。 */
async function boundedJson(
  url: string, headers: HeadersInit, fetchImpl: typeof fetch,
  remainingMs = REQUEST_TIMEOUT_MS,
): Promise<unknown> {
  const response = await fetchImpl(url, {
    headers, signal: AbortSignal.timeout(Math.max(1, Math.min(REQUEST_TIMEOUT_MS, remainingMs))),
  });
  if (!response.ok || !response.body) throw new Error(`SITE_USAGE_HTTP_${response.status}`);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw new Error("SITE_USAGE_RESPONSE_LIMITED");
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const joined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(joined)) as unknown;
}

function hourRange(hourStart: string): {start: number; end: number} {
  const start = Date.parse(hourStart);
  if (!Number.isFinite(start) || start % 3_600_000 !== 0) throw new Error("INVALID_RECONCILIATION_HOUR");
  return {start, end: start + 3_600_000};
}

function siteRecord(value: unknown): SiteUsageRecord | undefined {
  const row = object(value);
  const siteLogId = row && (typeof row.id === "number" || typeof row.id === "string")
    ? String(row.id) : undefined;
  const time = row?.created_at ?? row?.createdAt;
  const completedMs = typeof time === "string" ? Date.parse(time) : NaN;
  const cost = nonNegativeNumber(row?.actual_cost ?? row?.actualCost);
  if (!siteLogId || siteLogId.length > 128 || !Number.isFinite(completedMs)
    || cost === undefined) return undefined;
  const amountNano = Math.round(cost * 1e9);
  if (!Number.isSafeInteger(amountNano)) return undefined;
  const durationMs = token(row?.duration_ms);
  const keyId = row?.api_key_id;
  // 折扣声明是 fork 私有可选字段：只认 applied=true + 非负有限数，其余一律不采。
  const discountApplied = row?.night_discount_applied === true;
  const discountSaved = discountApplied
    ? nonNegativeNumber(row?.night_discount_saved_amount) : undefined;
  const siteDiscountNano = discountSaved !== undefined
    ? Math.round(discountSaved * 1e9) : undefined;
  if (siteDiscountNano !== undefined && !Number.isSafeInteger(siteDiscountNano)) {
    return undefined;
  }
  return {
    siteLogId,
    ...(text(row?.request_id, 128) ? {requestId: text(row?.request_id, 128)} : {}),
    ...(typeof keyId === "number" || typeof keyId === "string"
      ? text(String(keyId), 64) ? {apiKeyId: String(keyId)} : {} : {}),
    ...(text(row?.model) ? {model: text(row?.model)} : {}),
    ...(text(row?.inbound_endpoint) ? {endpoint: text(row?.inbound_endpoint)} : {}),
    completedAt: new Date(completedMs).toISOString(),
    ...(durationMs !== undefined ? {durationMs} : {}),
    ...(token(row?.input_tokens) !== undefined ? {inputTokens: token(row?.input_tokens)} : {}),
    ...(token(row?.cache_read_tokens) !== undefined ? {cacheReadTokens: token(row?.cache_read_tokens)} : {}),
    ...(token(row?.cache_creation_tokens) !== undefined ? {cacheWriteTokens: token(row?.cache_creation_tokens)} : {}),
    ...(token(row?.output_tokens) !== undefined ? {outputTokens: token(row?.output_tokens)} : {}),
    amountNano,
    ...(siteDiscountNano !== undefined ? {siteDiscountNano} : {}),
  };
}

/**
 * sub2api 的用户 usage 接口按日期过滤；读取整个 UTC 自然日的候选，
 * 再在本地以毫秒半开区间筛出目标小时。站点总数缺失、页竞争或预算耗尽均失败关闭。
 */
export async function fetchSub2ApiHour(
  consoleBaseUrl: string,
  accessToken: string,
  hourStart: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SiteUsageSnapshot> {
  const {start, end} = hourRange(hourStart);
  const base = consoleBaseUrl.replace(/\/+$/u, "");
  const date = new Date(start).toISOString().slice(0, 10);
  const records: SiteUsageRecord[] = [];
  const ids = new Set<string>();
  const deadline = Date.now() + HOUR_FETCH_BUDGET_MS;
  let candidateCount = 0;
  let processedCount = 0;
  for (let page = 1; page <= SUB2API_MAX_PAGES; page++) {
    if (Date.now() >= deadline) {
      return incomplete("sub2api_usage", records, candidateCount, processedCount,
        "站点小时明细超过 60 秒取数预算", true);
    }
    const query = new URLSearchParams({
      page: String(page), page_size: String(SUB2API_PAGE_SIZE),
      start_date: date, end_date: date, timezone: "UTC",
    });
    let json: unknown;
    try {
      json = await boundedJson(`${base}/api/v1/usage?${query}`, {
        authorization: `Bearer ${accessToken}`,
      }, fetchImpl, deadline - Date.now());
    } catch (error) {
      return incomplete("sub2api_usage", records, candidateCount, processedCount,
        `站点明细请求失败（${siteFailureDetail(error)}）`, false, siteHttpStatus(error));
    }
    const data = object(object(json)?.data);
    const total = data?.total;
    const items = data?.items;
    if (!Number.isSafeInteger(total) || (total as number) < 0
      || !Array.isArray(items) || items.length > SUB2API_PAGE_SIZE
      || (page > 1 && total !== candidateCount)) {
      return incomplete("sub2api_usage", records, candidateCount, processedCount,
        "站点分页总数或结构不可信");
    }
    candidateCount = total as number;
    for (const raw of items) {
      processedCount++;
      const item = siteRecord(raw);
      if (!item || ids.has(item.siteLogId)) {
        return incomplete("sub2api_usage", records, candidateCount, processedCount,
          "站点记录缺失必要字段或分页重复");
      }
      ids.add(item.siteLogId);
      const time = Date.parse(item.completedAt);
      if (time >= start && time < end) records.push(item);
    }
    if (processedCount === candidateCount) {
      const amountNano = sumAmounts(records);
      if (amountNano === undefined) {
        return incomplete("sub2api_usage", records, candidateCount, processedCount,
          "站点小时金额超出安全整数精度");
      }
      return {
        amountNano,
        records, complete: true, detailsComplete: true, limited: false,
        candidateCount, processedCount, source: "sub2api_usage",
        lightCheckKey: `sub2api_day:t:${candidateCount}`,
      };
    }
    if (items.length < SUB2API_PAGE_SIZE || processedCount > candidateCount) {
      return incomplete("sub2api_usage", records, candidateCount, processedCount,
        "站点分页提前结束或总数发生变化");
    }
  }
  const trend = Date.now() < deadline
    ? await sub2ApiTrendHour(base, accessToken, start, fetchImpl, deadline - Date.now())
    : undefined;
  if (trend !== undefined) {
    return {
      amountNano: trend, records: [], complete: true, detailsComplete: false,
      limited: true, candidateCount, processedCount, source: "sub2api_trend",
      reason: "站点日期明细超过 20000 条；小时趋势未经逐条核验，仅供人工确认",
    };
  }
  return incomplete("sub2api_usage", records, candidateCount, processedCount,
    "站点日期候选超过 20000 条且小时趋势不可用", true);
}

/**
 * 轻量复查：sub2api 只拉第一页读取当日总数。usage_logs 只增不改，
 * 总数与上次完整观测相同即整日数据未变，可跳过整日明细重拉。
 */
export async function fetchSub2ApiDayTotalLight(
  consoleBaseUrl: string,
  accessToken: string,
  hourStart: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string | undefined> {
  const date = new Date(hourRange(hourStart).start).toISOString().slice(0, 10);
  const query = new URLSearchParams({
    page: "1", page_size: String(SUB2API_PAGE_SIZE),
    start_date: date, end_date: date, timezone: "UTC",
  });
  try {
    const data = object(object(await boundedJson(
      `${consoleBaseUrl.replace(/\/+$/u, "")}/api/v1/usage?${query}`,
      {authorization: `Bearer ${accessToken}`}, fetchImpl,
    ))?.data);
    const total = data?.total;
    if (!Number.isSafeInteger(total) || (total as number) < 0) return undefined;
    return `sub2api_day:t:${total}`;
  } catch {
    return undefined;
  }
}

/** 小时趋势仅在明细超预算时作为人工候选；其时区/范围未逐条证明，不可自动归属。 */
async function sub2ApiTrendHour(
  base: string, accessToken: string, start: number, fetchImpl: typeof fetch,
  remainingMs: number,
): Promise<number | undefined> {
  const date = new Date(start).toISOString().slice(0, 10);
  const label = new Date(start).toISOString().slice(0, 13).replace("T", " ") + ":00";
  const params = new URLSearchParams({
    start_date: date, end_date: date, timezone: "UTC", granularity: "hour",
  });
  try {
    const data = object(object(await boundedJson(
      `${base}/api/v1/usage/dashboard/trend?${params}`,
      {authorization: `Bearer ${accessToken}`}, fetchImpl, remainingMs,
    ))?.data);
    const trend = data?.trend;
    if (!Array.isArray(trend) || trend.length > 48) return undefined;
    const matches = trend.map(object).filter(row => row?.date === label);
    if (matches.length !== 1) return undefined;
    const value = nonNegativeNumber(matches[0]?.actual_cost);
    const amountNano = value === undefined ? NaN : Math.round(value * 1e9);
    return Number.isSafeInteger(amountNano) ? amountNano : undefined;
  } catch {
    return undefined;
  }
}

/**
 * new-api 的 self/stat 在数据库侧计算 type=2 消费；秒级闭区间的末秒换算为
 * [hourStart, nextHour) 后传入。聚合不能提供逐条证据，也不能证明令牌名称唯一。
 */
export async function fetchNewApiHour(
  consoleBaseUrl: string,
  session: NewApiSession,
  hourStart: string,
  fetchImpl: typeof fetch = fetch,
  tokenName?: string,
): Promise<SiteUsageSnapshot> {
  const {start, end} = hourRange(hourStart);
  const params = new URLSearchParams({
    type: "2",
    start_timestamp: String(start / 1000),
    end_timestamp: String(end / 1000 - 1),
  });
  if (tokenName) params.set("token_name", tokenName);
  const headers: Record<string, string> = {};
  const deadline = Date.now() + HOUR_FETCH_BUDGET_MS;
  if (session.accessToken) headers.authorization = `Bearer ${session.accessToken}`;
  if (session.cookie) headers.cookie = session.cookie;
  if (session.userId) headers["new-api-user"] = session.userId;
  let json: unknown;
  try {
    json = await boundedJson(
      `${consoleBaseUrl.replace(/\/+$/u, "")}/api/log/self/stat?${params}`,
      headers, fetchImpl, deadline - Date.now(),
    );
  } catch (error) {
    return incomplete("newapi_stat", [], 0, 0,
      `站点小时聚合读取失败（${siteFailureDetail(error)}）`, false, siteHttpStatus(error));
  }
  const payload = object(json);
  const quota = object(payload?.data)?.quota;
  const amountNano = typeof quota === "number" ? quota * 2_000 : NaN;
  if (payload?.success !== true || !Number.isSafeInteger(quota)
    || (quota as number) < 0 || !Number.isSafeInteger(amountNano)) {
    return incomplete("newapi_stat", [], 0, 0, "站点消费 quota 或响应结构无效");
  }
  const records: SiteUsageRecord[] = [];
  const ids = new Set<string>();
  let candidateCount = 0;
  let processedCount = 0;
  let detailsComplete = false;
  let limited = false;
  let reason: string | undefined;
  for (let page = 1; page <= NEWAPI_DETAIL_MAX_PAGES; page++) {
    if (Date.now() >= deadline) {
      limited = true;
      reason = "站点小时明细超过 60 秒取数预算";
      break;
    }
    const detailParams = new URLSearchParams(params);
    detailParams.set("p", String(page));
    detailParams.set("size", String(NEWAPI_DETAIL_PAGE_SIZE));
    try {
      const list = object(await boundedJson(
        `${consoleBaseUrl.replace(/\/+$/u, "")}/api/log/self?${detailParams}`,
        headers, fetchImpl, deadline - Date.now(),
      ));
      const data = object(list?.data);
      const items = data?.items;
      const total = data?.total;
      if (list?.success !== true || !Array.isArray(items)
        || !Number.isSafeInteger(total) || (total as number) < 0
        || items.length > NEWAPI_DETAIL_PAGE_SIZE || (page > 1 && total !== candidateCount)) {
        reason = "站点明细分页结构或总数不可信";
        break;
      }
      candidateCount = total as number;
      for (const raw of items) {
        processedCount++;
        const item = newApiRecord(raw);
        if (!item || ids.has(item.siteLogId)) {
          reason = "站点明细缺少稳定 request_id/时间/quota 或分页重复";
          break;
        }
        ids.add(item.siteLogId);
        const time = Date.parse(item.completedAt);
        if (time >= start && time < end) records.push(item);
      }
      if (reason) break;
      if (processedCount === candidateCount) {
        // 汇总来源独立，列表仅用于逐条归属；二者不一致时绝不自动匹配。
        detailsComplete = sumAmounts(records) === amountNano;
        if (!detailsComplete) reason = "站点明细与小时汇总金额不同";
        break;
      }
      if (items.length < NEWAPI_DETAIL_PAGE_SIZE || processedCount > candidateCount) {
        reason = "站点明细分页提前结束";
        break;
      }
      if (page === NEWAPI_DETAIL_MAX_PAGES) {
        limited = true;
        reason = "站点小时明细超过 1000 条";
      }
    } catch (error) {
      reason = `站点明细请求失败（${siteFailureDetail(error)}）`;
      break;
    }
  }
  return {
    amountNano, records, complete: true, detailsComplete, limited,
    candidateCount, processedCount, source: "newapi_stat",
    lightCheckKey: `newapi_stat:q:${quota}`,
    ...(reason ? {reason} : {}),
  };
}

/** 轻量复查：new-api 只拉 stat 汇总，quota 与上次相同即视为站点数据未变。 */
export async function fetchNewApiStatLight(
  consoleBaseUrl: string,
  session: NewApiSession,
  hourStart: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string | undefined> {
  const {start, end} = hourRange(hourStart);
  const params = new URLSearchParams({
    type: "2",
    start_timestamp: String(start / 1000),
    end_timestamp: String(end / 1000 - 1),
  });
  const headers: Record<string, string> = {};
  if (session.accessToken) headers.authorization = `Bearer ${session.accessToken}`;
  if (session.cookie) headers.cookie = session.cookie;
  if (session.userId) headers["new-api-user"] = session.userId;
  try {
    const payload = object(await boundedJson(
      `${consoleBaseUrl.replace(/\/+$/u, "")}/api/log/self/stat?${params}`,
      headers, fetchImpl,
    ));
    const quota = object(payload?.data)?.quota;
    if (payload?.success !== true || !Number.isSafeInteger(quota)
      || (quota as number) < 0) return undefined;
    return `newapi_stat:q:${quota}`;
  } catch {
    return undefined;
  }
}

function newApiRecord(value: unknown): SiteUsageRecord | undefined {
  const row = object(value);
  // /api/log/self 会把数据库 id 改写成当前页序号；只能用稳定 request_id 幂等。
  const requestId = text(row?.request_id, 120);
  const siteLogId = requestId ? `request:${requestId}` : undefined;
  const rawTime = row?.created_at;
  const seconds = typeof rawTime === "number" ? rawTime
    : typeof rawTime === "string" && /^\d+$/u.test(rawTime) ? Number(rawTime) : NaN;
  const time = seconds < 1e12 ? seconds * 1000 : seconds;
  const quota = row?.quota;
  if (!row || !siteLogId || siteLogId.length > 128
    || !Number.isFinite(time) || !Number.isSafeInteger(quota)
    || (quota as number) < 0) return undefined;
  let other: Record<string, unknown> | undefined;
  if (typeof row.other === "string" && row.other.length <= 8192) {
    try { other = object(JSON.parse(row.other) as unknown); } catch { /* 字段不可用，不推断 Token。 */ }
  }
  const totalInput = token(other?.input_tokens_total);
  // New API 只在缓存计费大于 0 时写入 cache_tokens/cache_write_tokens；
  // 缺失字段在该日志语义中表示明确的零值，而不是未知值。
  const cacheRead = token(other?.cache_tokens) ?? 0;
  const cacheWrite = token(other?.cache_write_tokens) ?? 0;
  const input = totalInput !== undefined && totalInput >= cacheRead + cacheWrite
    ? totalInput - cacheRead - cacheWrite : undefined;
  const id = row.token_id;
  const output = token(row.completion_tokens);
  return {
    siteLogId,
    requestId,
    ...(typeof id === "number" || typeof id === "string"
      ? text(String(id), 64) ? {apiKeyId: String(id)} : {} : {}),
    ...(text(row.model_name) ? {model: text(row.model_name)} : {}),
    ...(text(other?.request_path) && text(other?.request_path)!.startsWith("/")
      ? {endpoint: text(other?.request_path)!.split("?", 1)[0]} : {}),
    completedAt: new Date(time).toISOString(),
    ...(token(row.use_time) !== undefined ? {durationMs: token(row.use_time)! * 1000} : {}),
    ...(input !== undefined ? {inputTokens: input} : {}),
    ...(totalInput !== undefined ? {cacheReadTokens: cacheRead} : {}),
    ...(totalInput !== undefined ? {cacheWriteTokens: cacheWrite} : {}),
    ...(output !== undefined ? {outputTokens: output} : {}),
    amountNano: (quota as number) * 2_000,
  };
}
