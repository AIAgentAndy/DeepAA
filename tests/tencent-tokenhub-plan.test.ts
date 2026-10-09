import {describe, expect, test} from "vitest";
import {
  createTencentCloudSignature,
  TENCENT_TOKENHUB_API_VERSION,
  TENCENT_TOKENHUB_HOST,
} from "../src/lib/sync-engine/adapters/plan/tencent-signature.js";
import {
  extractTokenPlanIds,
  parseTokenPlanQuota,
  TencentTokenHubPlanAdapter,
} from "../src/lib/sync-engine/adapters/plan/tencent-tokenhub-plan.js";
import {SyncAuthRequiredError, SyncUnsupportedError} from "../src/lib/sync-engine/types.js";

const EMPTY_PAYLOAD_HASH = "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a";

function makeInput() {
  return {
    targetId: "tencent-tokenhub-plan",
    baseUrl: "https://api.lkeap.cloud.tencent.com/plan/v3",
    accessKeyRef: "sid-ref",
    secretKeyRef: "skey-ref",
    resolveCredential: async () => "",
    resolveSecretReference: async (reference: string) => ({
      "sid-ref": "AKIDtest",
      "skey-ref": "Gu5t9qGl8xs0grMxRnW2",
    })[reference] ?? "",
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {"content-type": "application/json"},
  });
}

describe("腾讯云 TC3-HMAC-SHA256 签名", () => {
  test("固定向量生成 canonical request、scope 与 signature", () => {
    const signed = createTencentCloudSignature({
      secretId: "AKIDtest",
      secretKey: "Gu5t9qGl8xs0grMxRnW2",
      action: "DescribeTokenPlanList",
      payload: "{}",
      now: new Date("2026-09-29T00:00:00.000Z"),
    });
    expect(signed.canonicalRequest).toBe(
      "POST\n/\n\n"
      + "content-type:application/json; charset=utf-8\n"
      + `host:${TENCENT_TOKENHUB_HOST}\n`
      + "x-tc-action:describetokenplanlist\n\n"
      + "content-type;host;x-tc-action\n"
      + EMPTY_PAYLOAD_HASH,
    );
    expect(signed.credentialScope).toBe("2026-09-29/tokenhub/tc3_request");
    expect(signed.xTcTimestamp).toBe("1790640000");
    expect(signed.stringToSign).toBe(
      "TC3-HMAC-SHA256\n1790640000\n2026-09-29/tokenhub/tc3_request\n"
      + "ab01972083a51d51381da3fc441c2a54e8ca52e9a75760f666e6c3e279d016dc",
    );
    expect(signed.authorization).toBe(
      "TC3-HMAC-SHA256 Credential=AKIDtest/2026-09-29/tokenhub/tc3_request, "
      + "SignedHeaders=content-type;host;x-tc-action, "
      + "Signature=da09b1f740b940662a2290d6d1d811de484a1043544302e397acb6c1ae09e54f",
    );
  });

  test("action 头统一小写、API 版本为 2026-03-22（DescribeTokenPlan 族）", () => {
    const signed = createTencentCloudSignature({
      secretId: "AKIDtest",
      secretKey: "key",
      action: "DescribeTokenPlan",
      payload: JSON.stringify({TokenPlanId: "tp-1"}),
      now: new Date("2026-09-29T00:00:00.000Z"),
    });
    expect(signed.xTcAction).toBe("describetokenplan");
    expect(TENCENT_TOKENHUB_API_VERSION).toBe("2026-03-22");
  });
});

describe("TokenHub 套餐响应解析", () => {
  test("DescribeTokenPlanList 多形态提取套餐 ID 并防御截断到上限", () => {
    expect(extractTokenPlanIds({Response: {TokenPlanSet: [
      {TokenPlanId: "tp-common"}, {TokenPlanId: "tp-hy"},
    ]}})).toEqual(["tp-common", "tp-hy"]);
    expect(extractTokenPlanIds({Response: {PlanList: [{PlanId: "tp-1"}]}})).toEqual(["tp-1"]);
    expect(extractTokenPlanIds({Response: {PlanIds: ["tp-a", "tp-a", "tp-b"]}})).toEqual(["tp-a", "tp-b"]);
    expect(extractTokenPlanIds({Response: {}})).toEqual([]);
    const overflow = {Response: {PlanIds: ["a", "b", "c", "d", "e"]}};
    expect(extractTokenPlanIds(overflow)).toHaveLength(4);
  });

  test("显式 Used 优先；缺失时按 total-remain 反推；输出月度积分快照", () => {
    const snapshot = parseTokenPlanQuota({Response: {
      PlanName: "通用 Token Plan Pro",
      TotalCredits: 5980,
      UsedCredits: 1234.5,
      ExpireTime: "2026-10-15T00:00:00+08:00",
    }});
    expect(snapshot).toMatchObject({
      planName: "腾讯 TokenHub Token Plan 通用 Token Plan Pro",
      planFamily: "common",
      windowLabel: "monthly",
      used: 1234.5,
      total: 5980,
      unit: "credits",
      resetAt: "2026-10-14T16:00:00.000Z",
    });
  });

  test("QuotaPackage 嵌套余量（remain 形态）与 total<=0 拒绝", () => {
    const snapshot = parseTokenPlanQuota({Response: {
      QuotaPackage: {TotalCredits: 1560, RemainCredits: 400},
      EndTime: 1790640000,
    }});
    expect(snapshot).toMatchObject({used: 1160, total: 1560, unit: "credits"});
    expect(parseTokenPlanQuota({Response: {TotalCredits: 0, UsedCredits: 1}})).toBeUndefined();
    expect(parseTokenPlanQuota({Response: {TotalCredits: 100}})).toBeUndefined();
  });
});

describe("腾讯 TokenHub Token Plan 适配器", () => {
  test("List → Describe 链路产出月度积分快照，TC3 头与签名随请求携带", async () => {
    const calls: Array<{url: string; init: RequestInit}> = [];
    const adapter = new TencentTokenHubPlanAdapter(async (url, init) => {
      calls.push({url: String(url), init});
      const body = JSON.parse(String(init.body)) as {TokenPlanId?: string};
      if (body.TokenPlanId === undefined) {
        return jsonResponse({Response: {TokenPlanSet: [{TokenPlanId: "tp-hy"}], RequestId: "req-1"}});
      }
      return jsonResponse({Response: {
        PlanName: "Hy Token Plan Standard",
        QuotaPackage: {TotalCredits: 1560, UsedCredits: 300},
        CurrentPeriodEnd: "2026-10-20T00:00:00+08:00",
      }});
    });
    const result = await adapter.sync(makeInput());
    expect(result.providerType).toBe("tencent-tokenhub-plan");
    expect(result.planQuota).toHaveLength(1);
    expect(result.planQuota![0]).toMatchObject({
      planName: "腾讯 TokenHub Token Plan Hy Token Plan Standard",
      planFamily: "hy",
      windowLabel: "monthly",
      used: 300,
      total: 1560,
      unit: "credits",
    });
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.url).toBe(`https://${TENCENT_TOKENHUB_HOST}/`);
      expect(String(call.init.headers!["authorization" as keyof HeadersInit]))
        .toMatch(/^TC3-HMAC-SHA256 Credential=AKIDtest\//u);
      expect(call.init.headers!["x-tc-version" as keyof HeadersInit]).toBe("2026-03-22");
      expect(call.init.headers!["content-type" as keyof HeadersInit])
        .toBe("application/json; charset=utf-8");
    }
    expect(calls[0]!.init.headers!["x-tc-action" as keyof HeadersInit]).toBe("describetokenplanlist");
    expect(calls[1]!.init.headers!["x-tc-action" as keyof HeadersInit]).toBe("describetokenplan");
  });

  test("HTTP 401/403 与 TC3 鉴权错误码归一为 SyncAuthRequiredError", async () => {
    const unauthorized = new TencentTokenHubPlanAdapter(async () => jsonResponse({}, 401));
    await expect(unauthorized.sync(makeInput())).rejects.toThrow(SyncAuthRequiredError);

    const authFailure = new TencentTokenHubPlanAdapter(async () => jsonResponse({
      Response: {Error: {Code: "AuthFailure.SignatureFailure", Message: "invalid signature"}},
    }));
    await expect(authFailure.sync(makeInput())).rejects.toThrow(SyncAuthRequiredError);
  });

  test("无套餐、缺云密钥与业务错误码分别给出稳定错误", async () => {
    const empty = new TencentTokenHubPlanAdapter(async () => jsonResponse({Response: {}}));
    await expect(empty.sync(makeInput())).rejects.toThrow("TENCENT_TOKEN_PLAN_NOT_FOUND");

    const missingKey = new TencentTokenHubPlanAdapter(async () => jsonResponse({Response: {}}));
    await expect(missingKey.sync({...makeInput(), secretKeyRef: undefined}))
      .rejects.toThrow(SyncUnsupportedError);

    const businessError = new TencentTokenHubPlanAdapter(async () => jsonResponse({
      Response: {Error: {Code: "InvalidParameter.TokenPlanIdNotFound", Message: "not found"}},
    }));
    await expect(businessError.sync(makeInput())).rejects.toThrow("TENCENT_API_InvalidParameter.TokenPlanIdNotFound");
  });
});
