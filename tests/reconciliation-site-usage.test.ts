import {describe, expect, test, vi} from "vitest";
import {
  fetchNewApiHour,
  fetchNewApiStatLight,
  fetchSub2ApiDayTotalLight,
  fetchSub2ApiHour,
} from "../src/lib/sync-engine/reconciliation/site-usage.js";

const hourStart = "2026-09-24T04:00:00.000Z";
const hourEnd = "2026-09-24T05:00:00.000Z";

function response(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: {"content-type": "application/json"},
  });
}

describe("中转站小时消费取数", () => {
  test("sub2api 四十页仍满页时返回不完整，绝不把前 2 万条当成站点总额", async () => {
    const urls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      urls.push(url.toString());
      if (url.pathname.endsWith("/dashboard/trend")) {
        return new Response("not available", {status: 404});
      }
      const page = Number(url.searchParams.get("page"));
      const size = Number(url.searchParams.get("page_size"));
      return response({
        data: {
          total: 20_001,
          items: Array.from({length: size}, (_, i) => ({
            id: page * size + i,
            request_id: `req-${page}-${i}`,
            created_at: "2026-09-24T04:30:00.000Z",
            model: "m",
            input_tokens: 1,
            output_tokens: 1,
            cache_read_tokens: 0,
            cache_creation_tokens: 0,
            actual_cost: 0.01,
          })),
        },
      });
    }) as typeof fetch;

    const result = await fetchSub2ApiHour("https://example.test", "token", hourStart, fetchImpl);
    // 40 页明细 + 1 次趋势兜底。
    expect(urls).toHaveLength(41);
    expect(new URL(urls[0]!).searchParams.get("page_size")).toBe("500");
    expect(new URL(urls[0]!).searchParams.get("start_date")).toBe("2026-09-24");
    expect(new URL(urls[0]!).searchParams.get("timezone")).toBe("UTC");
    expect(result).toMatchObject({
      amountNano: null,
      complete: false,
      limited: true,
      candidateCount: 20_001,
      processedCount: 20_000,
    });
    expect(result.records).toHaveLength(20_000);
  });

  test("sub2api 明细超预算时，小时趋势只作受限人工候选，绝不获得逐条自动资格", async () => {
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/dashboard/trend")) {
        return response({data: {trend: [{
          date: "2026-09-24 04:00", actual_cost: 0.03, requests: 20_001,
        }]}});
      }
      const page = Number(url.searchParams.get("page"));
      const size = Number(url.searchParams.get("page_size"));
      return response({data: {
        total: 20_001,
        items: Array.from({length: size}, (_, i) => ({
          id: page * size + i,
          created_at: "2026-09-24T04:30:00.000Z",
          actual_cost: 0.00001,
        })),
      }});
    }) as typeof fetch;
    const result = await fetchSub2ApiHour("https://example.test", "token", hourStart, fetchImpl);
    expect(result).toMatchObject({
      source: "sub2api_trend", amountNano: 30_000_000, complete: true,
      detailsComplete: false, limited: true,
      candidateCount: 20_001, processedCount: 20_000, records: [],
    });
  });

  test("sub2api 只合计半开小时内的有效明细且携带可匹配字段", async () => {
    const fetchImpl = (async () => response({data: {total: 3, items: [
      {id: 1, request_id: "site-1", api_key_id: 7, model: "m",
        created_at: "2026-09-24T04:30:00Z", duration_ms: 1000,
        input_tokens: 2, output_tokens: 3, cache_read_tokens: 4,
        cache_creation_tokens: 5, actual_cost: 0.015},
      {id: 2, request_id: "site-2", api_key_id: 7, model: "m",
        created_at: "2026-09-24T05:00:00Z", actual_cost: 0.2},
      {id: 3, request_id: "site-3", api_key_id: 7, model: "m",
        created_at: "2026-09-24T03:59:59Z", actual_cost: 0.3},
    ]}})) as typeof fetch;

    const result = await fetchSub2ApiHour("https://example.test", "token", hourStart, fetchImpl);
    expect(result).toMatchObject({
      amountNano: 15_000_000,
      complete: true,
      limited: false,
      candidateCount: 3,
      processedCount: 3,
    });
    expect(result.records).toEqual([expect.objectContaining({
      siteLogId: "1", requestId: "site-1", apiKeyId: "7", model: "m",
      inputTokens: 2, cacheReadTokens: 4, cacheWriteTokens: 5, outputTokens: 3,
    })]);
  });

  test("站点响应超过 4 MiB 时流式取消，尚未解析 JSON 或计入部分金额", async () => {
    let cancelled = false;
    let produced = 0;
    const fetchImpl = (async () => new Response(new ReadableStream({
      pull(controller) {
        produced++;
        controller.enqueue(new Uint8Array(256 * 1024));
      },
      cancel() {
        cancelled = true;
      },
    }), {status: 200})) as typeof fetch;
    const result = await fetchSub2ApiHour("https://example.test", "token", hourStart, fetchImpl);
    expect(result).toMatchObject({
      complete: false, amountNano: null, candidateCount: 0, processedCount: 0,
    });
    expect(result.reason).toContain("SITE_USAGE_RESPONSE_LIMITED");
    expect(cancelled).toBe(true);
    expect(produced).toBeLessThanOrEqual(20);
  });

  test("站点明细 ID 异常膨胀时拒绝入对账索引而非持久化大字段", async () => {
    const fetchImpl = (async () => response({data: {total: 1, items: [{
      id: "x".repeat(300),
      created_at: "2026-09-24T04:30:00.000Z",
      actual_cost: 0.01,
    }]}})) as typeof fetch;
    const result = await fetchSub2ApiHour("https://example.test", "token", hourStart, fetchImpl);
    expect(result).toMatchObject({
      amountNano: null, complete: false, candidateCount: 1,
      processedCount: 1, records: [],
    });
  });

  test("单条金额安全但小时纳元求和溢出时不返回不精确余额", async () => {
    const fetchImpl = (async () => response({data: {total: 2, items: [
      {id: 1, created_at: "2026-09-24T04:10:00Z", actual_cost: 5_000_000},
      {id: 2, created_at: "2026-09-24T04:20:00Z", actual_cost: 5_000_000},
    ]}})) as typeof fetch;
    expect(await fetchSub2ApiHour("https://example.test", "token", hourStart, fetchImpl))
      .toMatchObject({amountNano: null, complete: false});
  });

  test("站点响应多页迟缓时整个小时受 60 秒总预算保护", async () => {
    let elapsed = 0;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => elapsed);
    let pages = 0;
    try {
      const fetchImpl = (async () => {
        pages++;
        elapsed += 16_000;
        return response({data: {
          total: 2_001,
          items: Array.from({length: 500}, (_, i) => ({
            id: pages * 500 + i,
            created_at: "2026-09-24T04:30:00.000Z", actual_cost: 0.01,
          })),
        }});
      }) as typeof fetch;
      const result = await fetchSub2ApiHour("https://example.test", "token", hourStart, fetchImpl);
      expect(pages).toBe(4);
      expect(result).toMatchObject({
        complete: false, limited: true, amountNano: null, processedCount: 2_000,
      });
    } finally {
      clock.mockRestore();
    }
  });

  test("站点失败 reason 区分底层错误码：限流、鉴权、超时分别透出", async () => {
    const limited = await fetchSub2ApiHour("https://example.test", "token", hourStart,
      (async () => new Response("rate limited", {status: 429})) as typeof fetch);
    expect(limited.reason).toContain("SITE_USAGE_HTTP_429");
    expect(limited.reason).toContain("站点限流");
    expect(limited.httpStatus).toBe(429);

    const unauthorized = await fetchNewApiHour("https://example.test",
      {accessToken: "session"}, hourStart,
      (async () => new Response("denied", {status: 401})) as typeof fetch);
    expect(unauthorized.reason).toContain("SITE_USAGE_HTTP_401");
    expect(unauthorized.httpStatus).toBe(401);
  });

  test("轻量复查键：sub2api 读日总数、new-api 读 stat 汇总", async () => {
    const dayTotal = await fetchSub2ApiDayTotalLight("https://example.test", "token",
      hourStart, (async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        expect(url.pathname).toBe("/api/v1/usage");
        expect(url.searchParams.get("page")).toBe("1");
        return response({data: {total: 137, items: []}});
      }) as typeof fetch);
    expect(dayTotal).toBe("sub2api_day:t:137");

    const statKey = await fetchNewApiStatLight("https://example.test",
      {accessToken: "session"}, hourStart, (async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        expect(url.pathname).toBe("/api/log/self/stat");
        return response({success: true, data: {quota: 7500}});
      }) as typeof fetch);
    expect(statKey).toBe("newapi_stat:q:7500");

    const failed = await fetchSub2ApiDayTotalLight("https://example.test", "token",
      hourStart, (async () => new Response("no", {status: 500})) as typeof fetch);
    expect(failed).toBeUndefined();
  });

  test("new-api 按整秒半开边界调用消费聚合；明细缺失不冒充可逐条匹配", async () => {
    const urls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return response({success: true, data: {quota: 7500}});
    }) as typeof fetch;

    const result = await fetchNewApiHour(
      "https://example.test", {accessToken: "session"}, hourStart, fetchImpl,
    );
    const params = new URL(urls[0]!).searchParams;
    expect(new URL(urls[0]!).pathname).toBe("/api/log/self/stat");
    expect(params.get("start_timestamp")).toBe(String(Date.parse(hourStart) / 1000));
    expect(params.get("end_timestamp")).toBe(String(Date.parse(hourEnd) / 1000 - 1));
    expect(result).toMatchObject({
      amountNano: 15_000_000,
      complete: true,
      records: [],
      processedCount: 0,
      detailsComplete: false,
    });
  });

  test("new-api 的统计额与完整明细分离；仅显式齐全的 Token 字段可逐条匹配", async () => {
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/stat")) return response({success: true, data: {quota: 7500}});
      return response({success: true, data: {total: 1, items: [{
        id: 18, request_id: "new-request", token_id: 7,
        model_name: "m", created_at: Date.parse("2026-09-24T04:20:00Z") / 1000,
        quota: 7500, prompt_tokens: 12, completion_tokens: 3,
        other: JSON.stringify({
          input_tokens_total: 12, cache_tokens: 4, cache_write_tokens: 2,
          request_path: "/v1/responses",
        }),
      }]}});
    }) as typeof fetch;
    const result = await fetchNewApiHour(
      "https://example.test", {accessToken: "session"}, hourStart, fetchImpl,
    );
    expect(result).toMatchObject({
      complete: true, detailsComplete: true, amountNano: 15_000_000,
      candidateCount: 1, processedCount: 1,
      records: [expect.objectContaining({
        siteLogId: "request:new-request", requestId: "new-request", apiKeyId: "7", model: "m",
        inputTokens: 6, cacheReadTokens: 4, cacheWriteTokens: 2, outputTokens: 3,
        endpoint: "/v1/responses",
      })],
    });
  });

  test("new-api 明确省略的零值 cache_write_tokens 按零归一，仍可用于高置信匹配", async () => {
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/stat")) return response({success: true, data: {quota: 7500}});
      return response({success: true, data: {total: 1, items: [{
        id: 18, request_id: "new-request-zero-cache", token_id: 7,
        model_name: "m", created_at: Date.parse("2026-09-24T04:20:00Z") / 1000,
        quota: 7500,
        other: JSON.stringify({
          input_tokens_total: 12, cache_tokens: 4,
          request_path: "/v1/responses",
        }),
      }]}});
    }) as typeof fetch;
    const result = await fetchNewApiHour(
      "https://example.test", {accessToken: "session"}, hourStart, fetchImpl,
    );
    expect(result).toMatchObject({
      complete: true, detailsComplete: true,
      records: [expect.objectContaining({
        cacheReadTokens: 4, cacheWriteTokens: 0, inputTokens: 8,
      })],
    });
  });

  test("new-api 用户日志缺稳定 request_id 时不以分页显示 id 自动归属", async () => {
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/stat")) return response({success: true, data: {quota: 7500}});
      return response({success: true, data: {total: 1, items: [{
        id: 1, token_id: 7, model_name: "m",
        created_at: Date.parse("2026-09-24T04:20:00Z") / 1000,
        quota: 7500, completion_tokens: 3,
      }]}});
    }) as typeof fetch;
    const result = await fetchNewApiHour(
      "https://example.test", {accessToken: "session"}, hourStart, fetchImpl,
    );
    expect(result).toMatchObject({
      complete: true, detailsComplete: false, amountNano: 15_000_000,
      records: [],
    });
  });

  test("new-api 明细到预算上限只影响逐条资格，服务器统计额仍可供人工核对", async () => {
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/stat")) return response({success: true, data: {quota: 7500}});
      const page = Number(url.searchParams.get("p"));
      return response({success: true, data: {
        total: 1001,
        items: Array.from({length: 100}, (_, i) => ({
          id: page * 100 + i,
          request_id: `req-${page}-${i}`,
          created_at: Date.parse("2026-09-24T04:20:00Z") / 1000,
          quota: 1,
        })),
      }});
    }) as typeof fetch;
    const result = await fetchNewApiHour(
      "https://example.test", {accessToken: "session"}, hourStart, fetchImpl,
    );
    expect(result).toMatchObject({
      complete: true, detailsComplete: false, limited: true,
      amountNano: 15_000_000, candidateCount: 1001, processedCount: 1000,
    });
  });

  test("sub2api 明细声明夜间折扣时采集节省额；未声明/未应用/负值一律不采（2026-09-28）", async () => {
    const items = [
      { // 声明折扣：saved 金额进入证据字段。
        id: 1, request_id: "r1", created_at: "2026-09-24T04:10:00.000Z", model: "m",
        input_tokens: 1, output_tokens: 1, cache_read_tokens: 0,
        cache_creation_tokens: 0, actual_cost: 0.14752463,
        night_discount_applied: true, night_discount_ratio: 0.9,
        night_discount_saved_amount: 0.01639162, rate_multiplier: 2.5,
      },
      { // 上游 sub2api 无折扣字段：不得出现该字段。
        id: 2, request_id: "r2", created_at: "2026-09-24T04:11:00.000Z", model: "m",
        input_tokens: 1, output_tokens: 1, cache_read_tokens: 0,
        cache_creation_tokens: 0, actual_cost: 0.1,
      },
      { // applied=false：即使带 saved 数值也不采。
        id: 3, request_id: "r3", created_at: "2026-09-24T04:12:00.000Z", model: "m",
        input_tokens: 1, output_tokens: 1, cache_read_tokens: 0,
        cache_creation_tokens: 0, actual_cost: 0.1,
        night_discount_applied: false, night_discount_saved_amount: 0.05,
      },
      { // saved 为负数：不采，但记录本身仍有效。
        id: 4, request_id: "r4", created_at: "2026-09-24T04:13:00.000Z", model: "m",
        input_tokens: 1, output_tokens: 1, cache_read_tokens: 0,
        cache_creation_tokens: 0, actual_cost: 0.1,
        night_discount_applied: true, night_discount_saved_amount: -0.01,
      },
    ];
    const fetchImpl = (async () => response({data: {total: items.length, items}})) as typeof fetch;
    const snapshot = await fetchSub2ApiHour("https://s.test", "tok", hourStart, fetchImpl);
    expect(snapshot.complete).toBe(true);
    const byId = new Map(snapshot.records.map(record => [record.siteLogId, record]));
    expect(byId.get("1")?.siteDiscountNano).toBe(16_391_620);
    expect(byId.get("2")?.siteDiscountNano).toBeUndefined();
    expect(byId.get("3")?.siteDiscountNano).toBeUndefined();
    expect(byId.get("4")?.siteDiscountNano).toBeUndefined();
    expect(byId.get("4")?.amountNano).toBe(100_000_000);
  });

  test("sub2api 折扣节省额超出安全整数精度时整行拒绝（与金额超精度同防）", async () => {
    const items = [{
      id: 1, request_id: "r1", created_at: "2026-09-24T04:10:00.000Z", model: "m",
      input_tokens: 1, output_tokens: 1, cache_read_tokens: 0,
      cache_creation_tokens: 0, actual_cost: 0.1,
      night_discount_applied: true,
      night_discount_saved_amount: Number.MAX_SAFE_INTEGER * 2,
    }];
    const fetchImpl = (async () => response({data: {total: items.length, items}})) as typeof fetch;
    const snapshot = await fetchSub2ApiHour("https://s.test", "tok", hourStart, fetchImpl);
    expect(snapshot.complete).toBe(false);
    expect(snapshot.processedCount).toBe(1);
  });
});
