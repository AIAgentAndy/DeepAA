import {describe, expect, test} from "vitest";
import {
  matchSiteUsage,
  type LocalUsageRecord,
} from "../src/lib/sync-engine/reconciliation/matching.js";
import type {SiteUsageRecord} from "../src/lib/sync-engine/reconciliation/site-usage.js";

const site: SiteUsageRecord = {
  siteLogId: "remote-1",
  apiKeyId: "7",
  model: "gpt-6-sol",
  endpoint: "/v1/responses",
  completedAt: "2026-09-24T04:00:10.000Z",
  durationMs: 10_000,
  inputTokens: 2,
  cacheReadTokens: 3,
  cacheWriteTokens: 4,
  outputTokens: 5,
  amountNano: 30_000_000,
};

const local: LocalUsageRecord = {
  exchangeId: "ex-1",
  targetId: "target-1",
  model: "gpt-6-sol",
  endpoint: "/v1/responses",
  capturedAt: "2026-09-24T04:00:00.200Z",
  completedAt: "2026-09-24T04:00:11.000Z",
  inputTokens: 2,
  cacheReadTokens: 3,
  cacheWriteTokens: 4,
  outputTokens: 5,
  actualCostNano: 20_000_000,
  resultClass: "success",
  usageSource: "provider_usage",
};

describe("中转站逐条对账匹配", () => {
  test("完整 Token + 开始或完成时差 30 秒且双向唯一才可自动补价差", () => {
    const result = matchSiteUsage([site], [local], "target-1", true);
    expect(result).toEqual({
      matched: [{site, local, confidence: "high", deltaNano: 10_000_000}],
      unmatchedSite: [],
      unmatchedLocal: [],
      ambiguousCount: 0,
    });
  });

  test("长请求比较对应的时钟，不能拿站点记账时间与本地发起时间直接比较", () => {
    const longSite = {...site, completedAt: "2026-09-24T04:06:45.000Z", durationMs: 404_000};
    const longLocal = {...local, completedAt: "2026-09-24T04:07:20.000Z"};
    const result = matchSiteUsage([longSite], [longLocal], "target-1", true);
    expect(result.matched).toHaveLength(1);
  });

  test("重复 Token 与时间窗口交叉产生歧义时双方均不能自动补", () => {
    const result = matchSiteUsage(
      [site, {...site, siteLogId: "remote-2", amountNano: 40_000_000}],
      [local, {...local, exchangeId: "ex-2"}], "target-1", true,
    );
    expect(result.matched).toEqual([]);
    expect(result.ambiguousCount).toBe(2);
  });

  test("失败或估算用量不能以 Token 伪装成高置信；仅可按弱档时间唯一归属", () => {
    const result = matchSiteUsage([site], [
      {...local, resultClass: "upstream_error", usageSource: "tokenizer_estimated",
        inputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4, outputTokens: 5,
        actualCostNano: 0},
    ], "target-1", true);
    // Token 数值相等不产生 exact/high；唯一候选时按弱档（模型+端点+时间）归属。
    expect(result.matched).toEqual([{
      site, local: {...local, resultClass: "upstream_error",
        usageSource: "tokenizer_estimated", actualCostNano: 0},
      confidence: "weak", deltaNano: 30_000_000,
    }]);
    // 无时间近邻时仍不匹配。
    expect(matchSiteUsage([{...site, completedAt: "2026-09-24T04:05:10.000Z"}], [
      {...local, resultClass: "upstream_error", usageSource: "tokenizer_estimated"},
    ], "target-1", true).matched).toEqual([]);
  });

  test("账号密钥范围不确定时，即使 Token 完全相同也不得自动匹配", () => {
    expect(matchSiteUsage([site], [local], "target-1", false).matched).toEqual([]);
  });

  test("站点声明了入站协议端点时，缺失或不一致的本地端点不能高置信匹配", () => {
    const endpointSite = {...site, endpoint: "/v1/responses"};
    expect(matchSiteUsage([endpointSite], [
      {...local, endpoint: undefined},
    ], "target-1", true).matched).toEqual([]);
    expect(matchSiteUsage([endpointSite], [
      {...local, endpoint: "/v1/chat/completions"},
    ], "target-1", true).matched).toEqual([]);
    expect(matchSiteUsage([endpointSite], [
      {...local, endpoint: "/v1/responses"},
    ], "target-1", true).matched).toHaveLength(1);
  });

  test("无共同 request ID 时端点缺失不能只凭 Token 与时间自动匹配", () => {
    expect(matchSiteUsage([{...site, endpoint: undefined}], [local], "target-1", true).matched)
      .toEqual([]);
    expect(matchSiteUsage([site], [{...local, endpoint: undefined}], "target-1", true).matched)
      .toEqual([]);
  });

  test("共同 request ID 仍须目标与密钥范围一致；有 ID 时可精确归属失败行", () => {
    const idSite = {...site, requestId: "request-abc"};
    const idLocal = {...local, requestId: "request-abc", resultClass: "upstream_error",
      usageSource: "tokenizer_estimated", actualCostNano: 0};
    expect(matchSiteUsage([idSite], [idLocal], "target-1", true).matched).toEqual([{
      site: idSite, local: idLocal, confidence: "exact", deltaNano: 30_000_000,
    }]);
    expect(matchSiteUsage([idSite], [{...idLocal, targetId: "other"}], "target-1", true).matched)
      .toEqual([]);
    expect(matchSiteUsage([idSite], [{...idLocal, model: "different-model"}], "target-1", true).matched)
      .toEqual([]);
  });

  test("sub2api 账单 client: 前缀与本地裸 UUID 归一化后 exact 匹配", () => {
    const prefixSite = {...site, requestId: "client:52aa945f-3f1f-4312-bf3d-9631ae5a0ebb"};
    const bareLocal = {...local, requestId: "52aa945f-3f1f-4312-bf3d-9631ae5a0ebb"};
    expect(matchSiteUsage([prefixSite], [bareLocal], "target-1", true).matched)
      .toEqual([{site: prefixSite, local: bareLocal, confidence: "exact",
        deltaNano: 10_000_000}]);
    // 双方都有 ID 且不同：任何档位（含弱档）都不得配对。
    expect(matchSiteUsage([prefixSite], [
      {...local, requestId: "different-id"},
    ], "target-1", true).matched).toEqual([]);
  });

  test("分级瀑布：先认领可精准匹配的 success，剩余唯一候选才归属错误行", () => {
    const errorSite: SiteUsageRecord = {
      siteLogId: "err-1", apiKeyId: "7", model: "gpt-6-sol", endpoint: "/v1/responses",
      completedAt: "2026-09-24T04:07:06.000Z", amountNano: 5_000_000,
    };
    const errorLocal: LocalUsageRecord = {
      ...local, exchangeId: "ex-err", requestId: undefined,
      completedAt: "2026-09-24T04:07:06.200Z", capturedAt: "2026-09-24T04:06:00.000Z",
      resultClass: "upstream_error", usageSource: "tokenizer_estimated", actualCostNano: 0,
    };
    // success 站点行与 success 本地行 Token 全等可高置信；错误行与站点错误扣费行
    // 在同一分钟内互为唯一剩余候选，按弱档归属（07:06 实测案例）。
    const result = matchSiteUsage([site, errorSite], [local, errorLocal], "target-1", true);
    expect(result.matched).toHaveLength(2);
    expect(result.matched.find(match => match.site.siteLogId === "remote-1")?.confidence)
      .toBe("high");
    expect(result.matched.find(match => match.site.siteLogId === "err-1"))
      .toMatchObject({confidence: "weak", deltaNano: 5_000_000, local: errorLocal});
  });

  test("弱-B 等量保序：重试链等量按时间序配对，行数不等整簇放弃", () => {
    const retrySites: SiteUsageRecord[] = [0, 1, 2].map(index => ({
      siteLogId: `retry-site-${index}`, apiKeyId: "7", model: "gpt-6-sol",
      endpoint: "/v1/responses",
      completedAt: new Date(Date.parse("2026-09-24T04:36:16.000Z") + index * 58_000).toISOString(),
      amountNano: 3_000_000,
    }));
    const retryLocals: LocalUsageRecord[] = [0, 1, 2].map(index => ({
      ...local, exchangeId: `retry-local-${index}`, requestId: undefined,
      completedAt: new Date(Date.parse("2026-09-24T04:36:16.500Z") + index * 58_000).toISOString(),
      capturedAt: "2026-09-24T04:35:00.000Z",
      resultClass: "upstream_error", usageSource: "tokenizer_estimated", actualCostNano: 0,
    }));
    const equal = matchSiteUsage(retrySites, retryLocals, "target-1", true);
    expect(equal.matched).toHaveLength(3);
    expect(equal.matched.every(match => match.confidence === "weak")).toBe(true);
    // 站点 3 条、本地 2 条：数量不等，整簇放弃留给人工。
    const unequal = matchSiteUsage(retrySites, retryLocals.slice(0, 2), "target-1", true);
    expect(unequal.matched).toEqual([]);
    expect(unequal.ambiguousCount).toBeGreaterThan(0);
  });
});
