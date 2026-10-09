import { describe, expect, test } from "vitest";
import {
  mergeWorkbenchTurnStepsPage,
  parseWorkbenchContextSnapshotState,
  parseWorkbenchStepDetailResponse,
  parseWorkbenchStepDiffState,
  parseWorkbenchStepSelection,
  parseWorkbenchTurnStepsPage,
  turnStepsPageRequestUrl,
} from "../src/lib/workbench-step-pages";

function stepItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "step-x",
    exchangeId: "exchange-x",
    agentSessionId: "session-1",
    agentThreadId: "thread-1",
    agentTurnId: "turn-1",
    stepIndex: 1,
    timestamp: "2026-07-17T08:00:00.000Z",
    phase: "tool_loop",
    toolSchemaCount: 0,
    toolUseNames: [],
    toolUseNamesLimited: false,
    toolUseCount: 0,
    toolResultCount: 0,
    ...overrides,
  };
}

describe("SQLite 工作台 Step 客户端契约", () => {
  test("不完整 Context/Diff artifact 在组件渲染前降级为空态", () => {
    const state = {
      derivedStatus: "idle",
      candidateCount: 1,
      processedCount: 1,
      limited: false,
    };

    expect(parseWorkbenchContextSnapshotState({
      ...state,
      snapshot: { stepId: "step-2" },
    })).toBeUndefined();
    expect(parseWorkbenchStepDiffState({
      ...state,
      diff: { toStepId: "step-2" },
    })).toBeUndefined();
  });

  test("SQLite harnessPayload 投影为检查器摘要并保留受限状态", () => {
    const evidence = [{ exchangeId: "exchange-2", side: "request", path: "$.input" }];
    const parsed = parseWorkbenchContextSnapshotState({
      derivedStatus: "idle",
      candidateCount: 1,
      processedCount: 1,
      limited: true,
      truncated: true,
      completeness: {
        complete: false,
        candidateItemCount: 20,
        processedItemCount: 12,
      },
      snapshot: {
        id: "ctx-2",
        stepId: "astep-2",
        exchangeId: "exchange-2",
        protocol: "openai_responses",
        model: "gpt-5.5",
        systemPromptHashes: ["system-hash"],
        developerPromptHashes: ["developer-hash"],
        conversationItemHashes: ["conversation-hash"],
        toolSchemaHashes: ["tool-hash"],
        paramsHash: "params-hash",
        toolSchemaCount: 1,
        totalStableHash: "snapshot-hash",
        remoteStateReferences: [],
        evidence,
        harnessPayload: {
          intent: { type: "reasoning_and_action", confidence: "high", evidence },
          systemPrompts: [{
            textHash: "system-hash",
            textPreview: "系统提示摘要",
            providerRole: "system",
            evidence,
          }],
          developerPrompts: [{
            textHash: "developer-hash",
            textPreview: "开发者提示摘要",
            providerRole: "developer",
            evidence,
          }],
          conversationItems: [{
            kind: "message",
            role: "user",
            stableHash: "conversation-hash",
            evidence,
          }],
          toolSchemas: [{
            name: "Read",
            stableHash: "tool-hash",
            evidence,
          }],
          requestedToolUses: [{ id: "call-1", name: "Read", input: { path: "a" }, evidence }],
          providedToolResults: [{ toolUseId: "call-1", content: "ok", evidence }],
          reasoningItems: [{ type: "reasoning", text: "摘要", evidence }],
          params: { temperature: 0.2 },
          stableHash: "harness-hash",
          evidence,
        },
      },
    });

    expect(parsed?.snapshot.harnessSummary).toMatchObject({
      intent: { type: "reasoning_and_action", confidence: "high" },
      systemPrompts: [{ textHash: "system-hash", textPreview: "系统提示摘要", evidenceCount: 1 }],
      developerPrompts: [{ textHash: "developer-hash", textPreview: "开发者提示摘要", evidenceCount: 1 }],
      userPrompts: [],
      userPromptObservability: "partial",
      conversationItemCount: 1,
      toolSchemaCount: 1,
      requestedToolUses: [{ id: "call-1", name: "Read", input: { path: "a" }, evidenceCount: 1 }],
      providedToolResults: [{ toolUseId: "call-1", content: "ok", evidenceCount: 1 }],
      reasoningItemCount: 1,
      params: { temperature: 0.2 },
      stableHash: "harness-hash",
      evidenceCount: 1,
    });
    expect(parsed?.snapshot.artifactLimited).toBe(true);
    expect(parsed?.snapshot.artifactCompleteness).toEqual({
      complete: false,
      candidateItemCount: 20,
      processedItemCount: 12,
    });
  });

  test("解析真实 BoundedPage payload 并映射为现有时间线 Step", () => {
    const payload: unknown = {
      items: [{
        id: "step-2",
        exchangeId: "exchange-2",
        agentSessionId: "session-1",
        agentThreadId: "thread-1",
        agentTurnId: "turn-1",
        stepIndex: 2,
        timestamp: "2026-07-17T08:00:02.000Z",
        phase: "tool_loop",
        requestIntentLabel: "续接工具结果",
        responseStatusLabel: "待工具调用",
        toolSchemaCount: 3,
        toolUseNames: ["Read"],
        toolUseNamesLimited: false,
        toolUseCount: 2,
        toolResultCount: 1,
        compactionRole: "first-after",
        compactionOrdinal: 1,
      }],
      userPrompt: {
        text: "帮我修复会话追踪页面",
        stepIndex: 1,
        stepId: "astep-1",
        exchangeId: "exchange-1",
        timestamp: "2026-07-17T08:00:00.000Z",
        truncated: true,
        originalBytes: 65536,
        source: "user_prompt",
      },
      intentStats: {
        toolUseSteps: 94,
        retries: 0,
        interruptions: 0,
        finals: 1,
        compressions: 1,
      },
      candidateCount: 3,
      processedCount: 2,
      limited: true,
      hasMore: true,
      nextCursor: "eyJ0aW1lIjoiMiIsImlkIjoic3RlcC0yIn0",
      dataVersion: 9,
      derivedStatus: "running",
    };

    const page = parseWorkbenchTurnStepsPage(payload);

    expect(page).toBeDefined();
    expect(page?.userPrompt).toMatchObject({
      stepId: "astep-1",
      exchangeId: "exchange-1",
      truncated: true,
      originalBytes: 65536,
    });
    expect(page?.steps[0]).toMatchObject({
      id: "step-2",
      turnId: "turn-1",
      agentSessionId: "session-1",
      agentThreadId: "thread-1",
      exchangeId: "exchange-2",
      index: 2,
      phase: "tool_loop",
      requestAction: "unknown",
      responseAction: "tool_use",
      toolSchemaCount: 3,
      toolUseNames: ["Read"],
      requestIntentLabel: "续接工具结果",
      responseStatusLabel: "待工具调用",
    });
    expect(page?.steps[0]?.toolUseIds).toHaveLength(2);
    expect(page?.steps[0]?.toolResultIds).toHaveLength(1);
    expect(page?.steps[0]?.compactionRole).toBe("first-after");
    expect(page?.steps[0]?.compactionOrdinal).toBe(1);
    expect(page?.intentStats).toEqual({
      toolUseSteps: 94,
      retries: 0,
      interruptions: 0,
      finals: 1,
      compressions: 1,
    });
    expect(page).toMatchObject({
      candidateCount: 3,
      processedCount: 2,
      limited: true,
      hasMore: true,
      nextCursor: "eyJ0aW1lIjoiMiIsImlkIjoic3RlcC0yIn0",
      derivedStatus: "building",
    });
  });

  test("userPrompt 缺少首步定点锚点（stepId/exchangeId）时拒绝整个 payload", () => {
    // 完整读取（显式点击）必须能定点到 Turn 首步请求；旧字段形状不允许静默通过。
    const payload: unknown = {
      items: [{
        id: "step-2",
        exchangeId: "exchange-2",
        agentSessionId: "session-1",
        agentThreadId: "thread-1",
        agentTurnId: "turn-1",
        stepIndex: 2,
        timestamp: "2026-07-17T08:00:02.000Z",
        phase: "tool_loop",
        requestIntentLabel: "续接工具结果",
        responseStatusLabel: "待工具调用",
        toolSchemaCount: 3,
        toolUseNames: ["Read"],
        toolUseNamesLimited: false,
        toolUseCount: 2,
        toolResultCount: 1,
      }],
      userPrompt: {
        text: "帮我修复会话追踪页面",
        stepIndex: 1,
        timestamp: "2026-07-17T08:00:00.000Z",
        truncated: true,
      },
      intentStats: {
        toolUseSteps: 0,
        retries: 0,
        interruptions: 0,
        finals: 1,
        compressions: 0,
      },
      candidateCount: 3,
      processedCount: 2,
      limited: true,
      hasMore: true,
      dataVersion: 9,
      derivedStatus: "running",
    };

    expect(parseWorkbenchTurnStepsPage(payload)).toBeUndefined();
  });

  test("intentStats 缺失、缺 compressions 或字段非非负整数时拒绝整个 payload", () => {
    const basePayload = {
      items: [],
      candidateCount: 0,
      processedCount: 0,
      limited: false,
      hasMore: false,
      dataVersion: 9,
      derivedStatus: "idle",
    };
    const validStats = {
      toolUseSteps: 1,
      retries: 0,
      interruptions: 0,
      finals: 0,
      compressions: 0,
    };

    expect(parseWorkbenchTurnStepsPage(basePayload)).toBeUndefined();
    expect(parseWorkbenchTurnStepsPage({
      ...basePayload,
      intentStats: { toolUseSteps: 1, retries: 0, interruptions: 0 },
    })).toBeUndefined();
    expect(parseWorkbenchTurnStepsPage({
      ...basePayload,
      intentStats: { toolUseSteps: -1, retries: 0, interruptions: 0, finals: 0 },
    })).toBeUndefined();
    // compressions 是必填字段：缺失即拒绝（防旧服务响应静默放行）。
    expect(parseWorkbenchTurnStepsPage({
      ...basePayload,
      intentStats: {toolUseSteps: 1, retries: 0, interruptions: 0, finals: 0},
    })).toBeUndefined();
    expect(parseWorkbenchTurnStepsPage({
      ...basePayload,
      intentStats: validStats,
    })).toBeDefined();
    // compactionRole/Ordinal 可选：省略时正常解析。
    expect(parseWorkbenchTurnStepsPage({
      ...basePayload,
      intentStats: validStats,
      items: [stepItem()],
    })).toBeDefined();
    // 非法角色枚举或非正整数序号按坏契约整体拒绝。
    expect(parseWorkbenchTurnStepsPage({
      ...basePayload,
      intentStats: validStats,
      items: [stepItem({compactionRole: "unknown-role"})],
    })).toBeUndefined();
    expect(parseWorkbenchTurnStepsPage({
      ...basePayload,
      intentStats: validStats,
      items: [stepItem({compactionRole: "first-after", compactionOrdinal: 0})],
    })).toBeUndefined();
  });

  test("单 Step 详情把账本价格和 Turn 洞察投影到检查器运行时对象", () => {
    const detail = parseWorkbenchStepDetailResponse({
      step: {
        id: "astep-2",
        exchangeId: "exchange-2",
        agentSessionId: "session-1",
        agentThreadId: "thread-1",
        agentTurnId: "turn-1",
        stepIndex: 2,
        timestamp: "2026-07-17T08:00:02.000Z",
        phase: "tool_loop",
        requestAction: "tool_result",
        responseAction: "tool_use",
        requestIntentLabel: "续接工具结果",
        responseStatusLabel: "待工具调用",
      toolSchemaCount: 3,
      toolUseNames: ["Read"],
      toolUseCount: 1,
      toolResultCount: 1,
      contextCompressed: false,
      compaction: {
        kind: "summary_marker",
        confidence: "high",
        markerKind: "codex_summary",
        preview: "Another language model started to solve this problem",
      },
      compactionEvent: {role: "first-after", ordinal: 1},
        model: "gpt-5.5",
        vendor: "OpenAI",
        rateMultiplier: 0.5,
        inputTokens: 100,
        cacheReadTokens: 200,
        cacheWriteTokens: 5,
        outputTokens: 40,
        vendorCost: 1.2,
        actualCost: 0.6,
        durationMs: 2500,
        usageSource: "provider_usage",
        usageConfidence: "exact",
        pricingSnapshot: {
          unit: "USD_per_million_tokens",
          matchedModel: "gpt-5.5",
          vendor: "OpenAI",
          matchStrategy: "global_exact",
          rateMultiplier: 0.5,
          baseRates: { input: 1, output: 2 },
          effectiveRates: { input: 0.5, output: 1 },
          priced: true,
          currency: "USD",
        },
        learningInsight: {
          turnId: "turn-1",
          agentSessionId: "session-1",
          summary: "工具循环后完成",
          harnessPattern: "tool_loop_then_final",
          confidence: "high",
          observations: [],
          copyableTemplate: "先读后答",
          evidence: [],
        },
      },
    });

    expect(detail?.step).toMatchObject({
      id: "astep-2",
      exchangeId: "exchange-2",
      pricingSnapshot: {
        matchedModel: "gpt-5.5",
        vendor: "OpenAI",
        rateMultiplier: 0.5,
      },
      tokenUsage: {
        inputTokens: 100,
        totalInputTokens: 305,
        cacheReadTokens: 200,
        cacheCreationTokens: 5,
        outputTokens: 40,
        totalTokens: 345,
        source: "exact",
      },
      tokenCost: {
        priced: true,
        currency: "USD",
        totalCost: 0.6,
        officialTotalCost: 1.2,
      },
    });
    expect(detail?.learningInsight?.summary).toBe("工具循环后完成");
    // 压缩事件注解随详情透传：概览条「识别到第 N 次发生压缩」的门控依据。
    expect(detail?.step.compactionEvent).toEqual({role: "first-after", ordinal: 1});
  });

  test("单 Step 详情的估算真实成本人民币口径：物化列优先、缺列按冻结系数折算、旧数据回退原币种（2026-09-23）", () => {
    const baseStep = {
      id: "astep-fx",
      exchangeId: "exchange-fx",
      agentSessionId: "session-1",
      agentThreadId: "thread-1",
      agentTurnId: "turn-1",
      stepIndex: 1,
      timestamp: "2026-09-23T04:00:00.000Z",
      phase: "tool_loop",
      requestAction: "user_prompt",
      responseAction: "final",
      toolSchemaCount: 0,
      toolUseNames: [],
      toolUseCount: 0,
      toolResultCount: 0,
      contextCompressed: false,
      inputTokens: 10,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 4,
      durationMs: 800,
      usageSource: "provider_usage",
      usageConfidence: "exact",
      vendorCost: 0.025539,
      actualCost: 0.102156,
    };
    // 账本物化列存在：直接采用；冻结结算系数一并透传（估算真实成本公式浮窗折算行用）。
    const materialized = parseWorkbenchStepDetailResponse({
      step: {
        ...baseStep,
        actualCostCny: 0.00638475,
        fxRateToCny: 0.0625,
        currency: "USD",
      },
    });
    expect(materialized?.step.tokenCost?.totalCostCny).toBeCloseTo(0.00638475, 12);
    expect(materialized?.step.tokenCost?.fxRateToCny).toBe(0.0625);
    // 缺物化列：按 原币种 × 冻结结算系数 折算。
    const folded = parseWorkbenchStepDetailResponse({
      step: {...baseStep, fxRateToCny: 0.0625, currency: "USD"},
    });
    expect(folded?.step.tokenCost?.totalCostCny).toBeCloseTo(0.102156 * 0.0625, 12);
    // 旧数据无 fx 信息：保持 undefined（UI 回退原币种值，不虚构折算）。
    const legacy = parseWorkbenchStepDetailResponse({step: {...baseStep}});
    expect(legacy?.step.tokenCost?.totalCostCny).toBeUndefined();
    expect(legacy?.step.tokenCost?.totalCost).toBe(0.102156);
  });

  test("套餐估算人民币物化列随详情透传（2026-09-28：Step 面板人民币口径取数链）", () => {
    const planStep = {
      id: "astep-plan",
      exchangeId: "exchange-plan",
      agentSessionId: "session-1",
      agentThreadId: "thread-1",
      agentTurnId: "turn-1",
      stepIndex: 1,
      timestamp: "2026-09-28T04:00:00.000Z",
      phase: "tool_loop",
      requestAction: "user_prompt",
      responseAction: "final",
      toolSchemaCount: 0,
      toolUseNames: [],
      toolUseCount: 0,
      toolResultCount: 0,
      contextCompressed: false,
      inputTokens: 10,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 4,
      durationMs: 800,
      usageSource: "provider_usage",
      usageConfidence: "exact",
      vendorCost: 0.025539,
      actualCost: 0.051078,
      billingChannel: "plan",
      planCreditCost: 41.49,
      planCreditUnit: "积分",
      planEstimatedStatus: "estimated",
      // USD 套餐：planEstimatedCost 是美元原币，与 Token 价格页人民币口径差一个汇率。
      planEstimatedCost: 0.02,
      planEstimatedCurrency: "USD",
    };
    const parsed = parseWorkbenchStepDetailResponse({
      step: {...planStep, planEstimatedCostNano: 134_977_800, planEstimatedFx: 6.7489},
    });
    expect(parsed?.step.planEstimatedCostNano).toBe(134_977_800);
    expect(parsed?.step.planEstimatedFx).toBe(6.7489);
    expect(parsed?.step.planEstimatedCost).toBe(0.02);
    // 极旧行缺物化列：保持 undefined（组件按 原币×冻结汇率 折算，再回退原币并标注币种）。
    const legacy = parseWorkbenchStepDetailResponse({step: {...planStep}});
    expect(legacy?.step.planEstimatedCostNano).toBeUndefined();
    expect(legacy?.step.planEstimatedFx).toBeUndefined();
  });

  test("额度差分依据字段随详情透传（2026-10-09 B4 回归：客户端白名单曾剥掉差分字段致公式永不渲染）", () => {
    const planStepLike = () => ({
      id: "astep-quota",
      exchangeId: "exchange-quota",
      agentSessionId: "session-1",
      agentThreadId: "thread-1",
      agentTurnId: "turn-1",
      stepIndex: 1,
      timestamp: "2026-10-09T07:56:00.000Z",
      phase: "tool_loop",
      requestAction: "user_prompt",
      responseAction: "final",
      toolSchemaCount: 0,
      toolUseNames: [],
      toolUseCount: 0,
      toolResultCount: 0,
      contextCompressed: false,
      inputTokens: 10,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 4,
      durationMs: 800,
      usageSource: "provider_usage",
      usageConfidence: "exact",
      vendorCost: 0.025539,
      actualCost: 0.051078,
      billingChannel: "subscription",
    });
    const detail = {
      consumedBasis: "quota_delta",
      monthlyFee: 18.41,
      currency: "USD",
      fxUsdCny: 6.7351,
      windowLabel: "weekly",
      windowDays: 7,
      usedFrom: 3,
      usedTo: 4,
      total: 100,
      deltaUsed: 1,
      periodFrom: "2026-10-09T07:51:33.732Z",
      periodTo: "2026-10-09T07:56:35.161Z",
      shareOfMarketCost: 0.1473999744178803,
      requestCount: 7,
    };
    const parsed = parseWorkbenchStepDetailResponse({
      step: {
        ...planStepLike(),
        planEstimatedStatus: "estimated",
        planEstimatedCostNano: 42_645_384,
        planEstimateDetail: detail,
      },
    });
    expect(parsed?.step.planEstimateDetail).toEqual(detail);
    // ratio_fallback / reset_residual 依据字段同样透传（共享解析器单源）。
    const ratio = parseWorkbenchStepDetailResponse({
      step: {
        ...planStepLike(),
        planEstimateDetail: {consumedBasis: "ratio_fallback", monthlyFee: 18.41, fallbackRatio: 0.112, evidenceRows: 19},
      },
    });
    expect(ratio?.step.planEstimateDetail).toMatchObject({consumedBasis: "ratio_fallback", fallbackRatio: 0.112, evidenceRows: 19});
  });

  test("加载更多只传播每 Turn cursor，不再发送 offset/order/exchangeId", () => {
    const first = turnStepsPageRequestUrl("turn/1", { limit: 50 });
    const second = turnStepsPageRequestUrl("turn/1", {
      limit: 50,
      cursor: "cursor+/=",
    });

    expect(first).toBe("/api/agent-turns/turn%2F1/steps?limit=50");
    expect(second).toBe(
      "/api/agent-turns/turn%2F1/steps?limit=50&cursor=cursor%2B%2F%3D",
    );
    expect(second).not.toContain("offset=");
    expect(second).not.toContain("order=");
    expect(second).not.toContain("exchangeId=");
  });

  test("客户端累计 Step 最多保留 500 条并停止继续翻页", () => {
    const steps = Array.from({ length: 480 }, (_, index) => ({
      id: `step-${index}`,
      turnId: "turn-1",
      agentSessionId: "session-1",
      exchangeId: `exchange-${index}`,
      index,
      timestamp: "2026-07-17T00:00:00.000Z",
      phase: "incomplete" as const,
      requestAction: "unknown" as const,
      responseAction: "unknown" as const,
      toolSchemaCount: 0,
      toolUseNames: [],
      toolUseIds: [],
      toolResultIds: [],
      contextSnapshotId: `stored-step-${index}`,
    }));
    const current = {
      steps,
      intentStats: { toolUseSteps: 480, retries: 1, interruptions: 2, finals: 3, compressions: 1 },
      candidateCount: 600,
      processedCount: 481,
      limited: true,
      hasMore: true,
      nextCursor: "cursor-1",
      derivedStatus: "ready" as const,
    };
    const incoming = {
      ...current,
      steps: Array.from({ length: 50 }, (_, index) => ({
        ...steps[0]!,
        id: `step-${480 + index}`,
        exchangeId: `exchange-${480 + index}`,
        index: 480 + index,
      })),
      // 服务端每次响应都重算本 Turn 全量统计，合并后必须取最新页的值。
      intentStats: { toolUseSteps: 520, retries: 1, interruptions: 2, finals: 4, compressions: 2 },
      processedCount: 51,
      nextCursor: "cursor-2",
    };

    const merged = mergeWorkbenchTurnStepsPage(current, incoming);
    expect(merged.steps).toHaveLength(500);
    expect(merged.hasMore).toBe(false);
    expect(merged.limited).toBe(true);
    expect(merged.nextCursor).toBeUndefined();
    expect(merged.intentStats).toEqual({
      toolUseSteps: 520,
      retries: 1,
      interruptions: 2,
      finals: 4,
      compressions: 2,
    });
  });

  test("深链 Step 通过 workbench-selection 精确验证内部 Step ID 从属关系", () => {
    const selection = parseWorkbenchStepSelection({
      latestPath: {
        target: "target-1",
        agent: "codex",
        session: "session-latest",
        thread: "thread-latest",
        ancestorThreadIds: [],
      },
      resolvedPath: {
        target: "target-1",
        agent: "codex",
        session: "session-1",
        thread: "thread-1",
        turn: "turn-1",
        step: "astep-2",
        ancestorThreadIds: [],
      },
      dataVersion: 9,
      derivedStatus: "running",
    }, "turn-1", "astep-2");

    expect(selection).toEqual({
      sessionId: "session-1",
      turnId: "turn-1",
      stepId: "astep-2",
      derivedStatus: "building",
    });
    expect(parseWorkbenchStepSelection({
      resolvedPath: {
        target: "target-1",
        agent: "codex",
        session: "session-1",
        thread: "thread-1",
        turn: "another-turn",
        step: "astep-2",
        ancestorThreadIds: [],
      },
      dataVersion: 9,
      derivedStatus: "idle",
    }, "turn-1", "astep-2")).toBeUndefined();
  });
});
