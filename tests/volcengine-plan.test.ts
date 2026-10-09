import {describe, expect, test} from "vitest";
import {
  buildVolcengineCanonicalQuery,
  createVolcengineSignature,
} from "../src/lib/sync-engine/adapters/plan/volcengine-signature.js";
import {
  parseVolcengineAfpQuota,
  parseVolcengineCodingPlanQuota,
  VolcenginePlanAdapter,
} from "../src/lib/sync-engine/adapters/plan/volcengine-plan.js";
import {calculateAfp} from "../src/lib/sync-engine/adapters/plan/afp-rules.js";
import {SyncAuthRequiredError} from "../src/lib/sync-engine/types.js";

function makeVolcengineInput() {
  return {
    targetId: "volcengine-plan",
    baseUrl: "https://ark.cn-beijing.volces.com/api/plan/v3",
    accessKeyRef: "ak-ref",
    secretKeyRef: "sk-ref",
    resolveCredential: async () => "",
    resolveSecretReference: async (reference: string) => ({
      "ak-ref": "AKLTtest",
      "sk-ref": "secretkey",
    })[reference] ?? "",
  };
}

describe("火山引擎 OpenAPI HMAC 签名", () => {
  test("固定向量生成 canonical request、scope 与 signature", () => {
    const query = buildVolcengineCanonicalQuery("GetAFPUsage", "cn-beijing");
    expect(query).toBe("Action=GetAFPUsage&Region=cn-beijing&Version=2024-01-01");

    const signed = createVolcengineSignature({
      accessKeyId: "AKLTtest",
      secretAccessKey: "secretkey",
      region: "cn-beijing",
      canonicalQuery: query,
      now: new Date("2024-06-21T00:00:00.000Z"),
    });
    expect(signed.canonicalRequest).toBe(
      "POST\n/\nAction=GetAFPUsage&Region=cn-beijing&Version=2024-01-01\n"
      + "host:ark.cn-beijing.volcengineapi.com\n"
      + "x-date:20240621T000000Z\n"
      + "x-content-sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855\n"
      + "content-type:application/json; charset=utf-8\n\n"
      + "host;x-date;x-content-sha256;content-type\n"
      + "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(signed.credentialScope).toBe("20240621/cn-beijing/ark/request");
    expect(signed.signature).toBe("a5b46dd59b06e917a352e9679ea8f88c39efe8a258f3cc8b9f49e39e3d1de401");
    expect(signed.authorization).toContain("HMAC-SHA256 Credential=AKLTtest/20240621/cn-beijing/ark/request");
  });
});

describe("火山方舟 Agent/Coding Plan 解析", () => {
  test("Agent Plan 解析 5 小时、周、月绝对额度并跳过 daily", () => {
    expect(parseVolcengineAfpQuota({
      PlanType: "Large",
      AFPFiveHour: {Quota: 50, Used: 12.5, ResetTime: 1_778_806_800_000},
      AFPDaily: {Quota: 100, Used: 22.5},
      AFPWeekly: {Quota: 500, Used: 150, ResetTime: 1_779_062_400_000},
      AFPMonthly: {Quota: 2_000, Used: 850.5, ResetTime: 1_780_531_200_000},
    })).toEqual([
      expect.objectContaining({planName: "火山方舟 Agent Plan Large", windowLabel: "5h", used: 12.5, total: 50, unit: "AFP"}),
      expect.objectContaining({windowLabel: "weekly", used: 150, total: 500, unit: "AFP"}),
      expect.objectContaining({windowLabel: "monthly", used: 850.5, total: 2_000, unit: "AFP"}),
    ]);
  });

  test("Coding Plan 解析真实 Level/Percent 时间窗并跳过未知窗口", () => {
    expect(parseVolcengineCodingPlanQuota({
      QuotaUsage: [
        {Level: "session", Percent: 0, ResetTimestamp: -1},
        {Level: "weekly", Percent: 1.672568, ResetTimestamp: 1_782_057_600},
        {Level: "monthly", Percent: 0.836284, ResetTimestamp: 1_784_303_999},
        {Level: "daily", Percent: 9},
      ],
    })).toEqual([
      expect.objectContaining({planName: "火山方舟 Coding Plan", windowLabel: "5h", used: 0, total: 100, unit: "percent", resetAt: undefined}),
      expect.objectContaining({windowLabel: "weekly", used: 1.672568, total: 100, unit: "percent", resetAt: expect.stringMatching(/^2026-/u)}),
      expect.objectContaining({windowLabel: "monthly", used: 0.836284, total: 100, unit: "percent"}),
    ]);
  });
});

describe("火山方舟套餐适配器", () => {
  test("共享 AFP 规则按缓存命中输入系数计算，Agent/Coding 可复用", () => {
    expect(calculateAfp({
      inputTokens: 10_000,
      cacheReadTokens: 2_000,
      outputTokens: 4_000,
    }, {
      input: 2,
      cachedInput: 0.5,
      output: 3,
    })).toBeCloseTo(3.3, 9);
  });

  test("Agent Plan 无活动额度时回退 Coding Plan，AK/SK 仅作为签名输入", async () => {
    const actions: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      actions.push(url.searchParams.get("Action") ?? "");
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get("authorization")).toMatch(/^HMAC-SHA256 Credential=AKLTtest\//u);
      return new Response(JSON.stringify(url.searchParams.get("Action") === "GetAFPUsage"
        ? {Result: {AFPFiveHour: {Quota: 0, Used: 0}}}
        : {Result: {QuotaUsage: [{Level: "weekly", Percent: 10, ResetTimestamp: 1_782_057_600}]}}), {
        status: 200,
        headers: {"content-type": "application/json"},
      });
    }) as typeof fetch;
    const adapter = new VolcenginePlanAdapter(
      fetchImpl,
      () => new Date("2024-06-21T00:00:00.000Z"),
    );
    const result = await adapter.sync(makeVolcengineInput());
    expect(actions).toEqual(["GetAFPUsage", "GetPersonalPlan"]);
    expect(result.planQuota).toEqual([
      expect.objectContaining({windowLabel: "weekly", used: 10}),
    ]);
  });

  test("签名/权限错误快速终止且不再请求第二个 plan", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response(JSON.stringify({
        ResponseMetadata: {Error: {Code: "SignatureDoesNotMatch", Message: "invalid"}},
      }), {status: 400, headers: {"content-type": "application/json"}});
    }) as typeof fetch;
    const adapter = new VolcenginePlanAdapter(fetchImpl);
    await expect(adapter.sync(makeVolcengineInput())).rejects.toBeInstanceOf(SyncAuthRequiredError);
    expect(calls).toBe(1);
  });
});
