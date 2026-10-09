import {beforeEach, describe, expect, test, vi} from "vitest";

const {service} = vi.hoisted(() => ({
  service: {
    listReconciliationHours: vi.fn(() => ({
      items: [{
        targetId: "target-1", hourStartUtc: "2026-09-24T04:00:00.000Z",
        status: "needs_review", siteAmountNano: 30_000_000,
        localAmountNano: 20_000_000, appliedAmountNano: 0, residualNano: 10_000_000,
        siteCandidateCount: 2, siteProcessedCount: 2, siteLimited: false,
      }],
      candidateCount: 1, processedCount: 1, limited: false,
      summary: {
        needsReviewCount: 1, needsReviewResidualNano: 10_000_000,
        autoApplied24hNano: 0, autoApplied24hCount: 0,
        backoffs: [{targetId: "dmapi.xyz", retryAfter: "2026-09-24T07:00:00.000Z",
          lastError: "SITE_USAGE_HTTP_429（站点限流）"}],
      },
    })),
    confirmReconciliationHour: vi.fn(async () => 10_000_000),
    ignoreReconciliationHour: vi.fn(),
  },
}));

vi.mock("@/lib/sync-engine/service", () => ({getSyncService: async () => service}));
import {GET, POST} from "../src/app/api/proxy-sync/reconciliation/route.js";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("小时对账 API", () => {
  test("GET 返回待复核小时与摘要（含退避目标），旧窗口与 scope 彻底移除", async () => {
    const response = await GET(new Request(
      "http://127.0.0.1:3210/api/proxy-sync/reconciliation?targetId=target-1&limit=20&cursor=abc",
    ));
    const body = await response.json() as Record<string, unknown>;
    expect(response.status).toBe(200);
    expect(service.listReconciliationHours).toHaveBeenCalledWith({
      targetId: "target-1", limit: 20, cursor: "abc",
    });
    expect(body).toMatchObject({
      items: [expect.objectContaining({hourStartUtc: "2026-09-24T04:00:00.000Z"})],
      candidateCount: 1, processedCount: 1, limited: false,
      summary: {
        needsReviewCount: 1, needsReviewResidualNano: 10_000_000,
        backoffs: [{targetId: "dmapi.xyz"}],
      },
    });
    // 旧窗口机制已从页面彻底移除；scope/空小时计数也不再存在。
    expect(body).not.toHaveProperty("legacyCount");
    expect(body).not.toHaveProperty("windows");
    expect(body).not.toHaveProperty("emptyHiddenCount");
    expect(body).not.toHaveProperty("targets");
  });

  test("POST 忽略必须有同源 nonce 和原因，不写补差行", async () => {
    const list = await GET(new Request("http://127.0.0.1:3210/api/proxy-sync/reconciliation"));
    const {nonce} = await list.json() as {nonce: string};
    const response = await POST(new Request("http://127.0.0.1:3210/api/proxy-sync/reconciliation", {
      method: "POST",
      headers: {
        origin: "http://127.0.0.1:3210",
        host: "127.0.0.1:3210",
        "content-type": "application/json",
        "sec-fetch-site": "same-origin",
      },
      body: JSON.stringify({
        action: "ignore", targetId: "target-1",
        hourStartUtc: "2026-09-24T04:00:00.000Z",
        reason: "该账号还有别的目标在用", nonce,
      }),
    }));
    expect(response.status).toBe(200);
    expect(service.ignoreReconciliationHour).toHaveBeenCalledWith(
      "target-1", "2026-09-24T04:00:00.000Z", "该账号还有别的目标在用",
    );
    expect(service.confirmReconciliationHour).not.toHaveBeenCalled();
  });

  test("人工确认必须携带用户看到的剩余金额，缺少金额不能写入", async () => {
    const list = await GET(new Request("http://127.0.0.1:3210/api/proxy-sync/reconciliation"));
    const {nonce} = await list.json() as {nonce: string};
    const response = await POST(new Request("http://127.0.0.1:3210/api/proxy-sync/reconciliation", {
      method: "POST",
      headers: {
        origin: "http://127.0.0.1:3210", host: "127.0.0.1:3210",
        "content-type": "application/json", "sec-fetch-site": "same-origin",
      },
      body: JSON.stringify({
        action: "apply", targetId: "target-1",
        hourStartUtc: "2026-09-24T04:00:00.000Z", nonce,
      }),
    }));
    expect(response.status).not.toBe(200);
    expect(service.confirmReconciliationHour).not.toHaveBeenCalled();
  });
});
