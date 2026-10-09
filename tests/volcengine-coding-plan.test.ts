import {describe, expect, test} from "vitest";
import {VolcengineCodingPlanAdapter} from "../src/lib/sync-engine/adapters/plan/volcengine-coding-plan.js";

function input() {
  return {
    targetId: "volces.com",
    baseUrl: "https://ark.cn-beijing.volces.com/api/coding/v3",
    accessKeyRef: "ak-ref",
    secretKeyRef: "sk-ref",
    resolveCredential: async () => "",
    resolveSecretReference: async (reference: string) => reference === "ak-ref" ? "ak" : "sk",
  };
}

describe("火山方舟 Coding Plan 独立适配器", () => {
  test("调用 GetCodingPlanUsage，不复用 Agent Plan 的 GetAFPUsage", async () => {
    const adapter = new VolcengineCodingPlanAdapter(
      (async (url: string | URL, init?: RequestInit) => {
        const requestUrl = String(url);
        expect(requestUrl).toContain("Action=GetCodingPlanUsage");
        expect(requestUrl).not.toContain("Action=GetAFPUsage");
        expect(new Headers(init?.headers).get("authorization")).toContain("Credential=ak/");
        return new Response(JSON.stringify({
          Result: {
            QuotaUsage: [
              {Type: "5h", Percent: 20, ResetTime: 1_791_000_000_000},
              {Type: "weekly", Percent: 30, ResetTime: 1_791_000_000_000},
              {Type: "monthly", Percent: 40, ResetTime: 1_791_000_000_000},
            ],
          },
        }), {status: 200, headers: {"content-type": "application/json"}});
      }) as typeof fetch,
    );

    const result = await adapter.sync(input());
    expect(result.providerType).toBe("volcengine-coding-plan");
    expect(result.planQuota?.map(item => item.windowLabel)).toEqual(["5h", "weekly", "monthly"]);
    expect(result.planQuota?.every(item => item.unit === "percent")).toBe(true);
  });
});
