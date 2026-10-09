import {describe, expect, test} from "vitest";
import {buildLedgerMetrics, deriveTotalTokens} from "../src/lib/analytics/ledger-metrics.js";

describe("请求级分析账本口径", () => {
  test("reasoning 是 output 子集时不重复计入 derived total", () => {
    const result = deriveTotalTokens({
      inputTokens: 100,
      cacheReadTokens: 20,
      cacheCreationTokens: 5,
      outputTokens: 40,
      reasoningTokens: 30,
      totalTokens: 165,
      source: "provider_usage",
      usageConfidence: "exact",
      sourceLabel: "provider",
      note: "",
    });
    expect(result.derivedTotalTokens).toBe(165);
    expect(result.basis).toBe("derived");
  });

  test("估算 Token 或未计价请求不能进入已审计消费", () => {
    const result = buildLedgerMetrics({
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        source: "tokenizer_estimated",
        usageConfidence: "medium",
        sourceLabel: "tokenizer",
        note: "estimated",
      },
      cost: {priced: false, unpricedReason: "model_ambiguous", officialTotalCost: 0, totalCost: 0, currency: "USD", vendor: "x", pricingSnapshot: {}},
      responseStatus: 200,
    });
    expect(result.usageQuality).toBe("estimated");
    expect(result.pricingStatus).toBe("unpriced_ambiguous");
    expect(result.auditEligible).toBe(false);
  });

  test("套餐和订阅保留官方等价价值语义，不伪装成按量账单", () => {
    const result = buildLedgerMetrics({
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
        source: "provider_usage",
        usageConfidence: "exact",
        sourceLabel: "provider",
        note: "",
      },
      cost: {priced: true, officialTotalCost: 1.2, totalCost: 1.2, currency: "USD", vendor: "x", pricingSnapshot: {}},
      billingChannel: "subscription",
      responseStatus: 200,
    });
    expect(result.costBasis).toBe("subscription_observed");
    expect(result.referenceCostStatus).toBe("available");
    expect(result.auditEligible).toBe(false);
  });

  test("客户端中止的 2xx 流式请求归 cancelled 且不计入时长样本", () => {
    const result = buildLedgerMetrics({
      usage: {
        inputTokens: 100,
        outputTokens: 5,
        totalTokens: 105,
        source: "provider_usage",
        usageConfidence: "exact",
        sourceLabel: "provider",
        note: "",
      },
      cost: {priced: true, officialTotalCost: 0.1, totalCost: 0.1, currency: "USD", vendor: "x", pricingSnapshot: {}},
      responseStatus: 200,
      connectionStatus: "client_aborted",
    });
    expect(result.resultClass).toBe("cancelled");
    expect(result.durationSampleEligible).toBe(false);
  });

  test("上游中断的 2xx 流式请求归 incomplete 且不计入时长样本", () => {
    const result = buildLedgerMetrics({
      usage: {
        inputTokens: 100,
        outputTokens: 5,
        totalTokens: 105,
        source: "provider_usage",
        usageConfidence: "exact",
        sourceLabel: "provider",
        note: "",
      },
      cost: {priced: true, officialTotalCost: 0.1, totalCost: 0.1, currency: "USD", vendor: "x", pricingSnapshot: {}},
      responseStatus: 200,
      connectionStatus: "upstream_aborted",
    });
    expect(result.resultClass).toBe("incomplete");
    expect(result.durationSampleEligible).toBe(false);
  });

  test("断流时 tokenizer 估算降级为 unavailable，不冒充估算样本", () => {
    const result = buildLedgerMetrics({
      usage: {
        inputTokens: 10,
        outputTokens: 2,
        totalTokens: 12,
        source: "tokenizer_estimated",
        usageConfidence: "medium",
        sourceLabel: "tokenizer",
        note: "estimated",
      },
      cost: {priced: true, officialTotalCost: 0.1, totalCost: 0.1, currency: "USD", vendor: "x", pricingSnapshot: {}},
      responseStatus: 200,
      connectionStatus: "client_aborted",
    });
    expect(result.usageQuality).toBe("unavailable");
    expect(result.auditEligible).toBe(false);
  });

  test("断流且 provider usage 全 0（如 message_start 占位）降级为 unavailable", () => {
    const result = buildLedgerMetrics({
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        source: "provider_usage",
        usageConfidence: "exact",
        sourceLabel: "provider",
        note: "",
      },
      cost: {priced: true, officialTotalCost: 0, totalCost: 0, currency: "USD", vendor: "x", pricingSnapshot: {}},
      responseStatus: 200,
      connectionStatus: "upstream_aborted",
    });
    expect(result.usageQuality).toBe("unavailable");
  });

  test("正常完成的流式请求保持 success 且计入时长样本", () => {
    const result = buildLedgerMetrics({
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
        source: "provider_usage",
        usageConfidence: "exact",
        sourceLabel: "provider",
        note: "",
      },
      cost: {priced: true, officialTotalCost: 0.2, totalCost: 0.2, currency: "USD", vendor: "x", pricingSnapshot: {}},
      responseStatus: 200,
      connectionStatus: "open_completed",
    });
    expect(result.resultClass).toBe("success");
    expect(result.usageQuality).toBe("exact");
    expect(result.durationSampleEligible).toBe(true);
  });
});

describe("cancelled 判定收紧（终态已见 + provider 用量 → success）", () => {
  const usage = {source: "provider_usage" as const, usageConfidence: "exact" as const};
  const base = {requestKind: "model" as const, usage};

  test("client_aborted + 终态已见 + provider 用量 → success", () => {
    const result = buildLedgerMetrics({
      ...base,
      responseStatus: 200,
      streamComplete: false,
      connectionStatus: "client_aborted",
      terminalSeen: true,
    });
    expect(result.resultClass).toBe("success");
  });

  test("client_aborted 但终态未见 → 保持 cancelled", () => {
    const result = buildLedgerMetrics({
      ...base,
      responseStatus: 200,
      streamComplete: false,
      connectionStatus: "client_aborted",
      terminalSeen: false,
    });
    expect(result.resultClass).toBe("cancelled");
  });

  test("client_aborted + 终态已见但用量非 provider 来源 → 保持 cancelled", () => {
    const result = buildLedgerMetrics({
      requestKind: "model",
      usage: {source: "tokenizer_estimated" as const, usageConfidence: "estimated" as const},
      responseStatus: 200,
      streamComplete: false,
      connectionStatus: "client_aborted",
      terminalSeen: true,
    });
    expect(result.resultClass).toBe("cancelled");
  });

  test("流完整收尾不受影响：success", () => {
    const result = buildLedgerMetrics({
      ...base,
      responseStatus: 200,
      streamComplete: true,
      connectionStatus: "open_completed",
    });
    expect(result.resultClass).toBe("success");
  });
});
