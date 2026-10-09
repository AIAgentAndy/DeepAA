import { describe, expect, test } from "vitest";
import {
  activeTreePathForSelection,
  agentNameFromSessionEvidence,
  defaultCollapsedTreeKeys,
  formatCostValue,
  formatStepToolSummary,
  hasCompleteWorkbenchAggregate,
  hierarchyRefreshPlan,
  overviewEvidencePlan,
  projectionOverviewSideSummary,
  reconcileCollapsedTreeKeys,
  resolveWorkbenchSelection,
  selectOverviewTokenUsageSource,
  selectedStepAfterTurnStepsPage,
  tokenUsageSummaryFromStep,
  toolCallSummary,
  workbenchAggregateRefreshKey,
  type TreeCollapseGroup,
} from "../src/lib/workbench-display.js";

describe("会话追踪 UI 展示辅助逻辑", () => {
  const treeGroups: TreeCollapseGroup[] = [
    {
      key: "target-latest::codex",
      sessions: [
        { session: { id: "session-latest" }, turns: [{ turn: { id: "turn-44" } }] },
        { session: { id: "session-old-in-latest-group" }, turns: [{ turn: { id: "turn-12" } }] },
      ],
    },
    {
      key: "target-old::claude-code",
      sessions: [
        { session: { id: "session-old-target" }, turns: [{ turn: { id: "turn-1" } }] },
      ],
    },
  ];

  test("默认只展开最新目标 Agent 和包含最新 Turn 的 Session", () => {
    expect([...defaultCollapsedTreeKeys(treeGroups)].sort()).toEqual([
      "session-old-in-latest-group",
      "session-old-target",
      "target-old::claude-code",
    ]);
  });

  test("完整 Session 首条历史请求未加载时仍从最近 evidence 保留 Agent", () => {
    expect(agentNameFromSessionEvidence(
      ["ex-old", "ex-latest"],
      [],
      [{ exchangeId: "ex-latest", agentName: "codex" }],
    )).toBe("codex");
  });

  test("数据刷新时保留用户手动展开或折叠过的树节点", () => {
    const reconciled = reconcileCollapsedTreeKeys({
      groups: treeGroups,
      currentCollapsed: new Set(["session-latest"]),
      touchedKeys: new Set(["session-latest", "target-old::claude-code"]),
    });

    expect([...reconciled].sort()).toEqual([
      "session-latest",
      "session-old-in-latest-group",
      "session-old-target",
    ]);
  });

  test("数据刷新重排后当前查看 Turn 所在路径必须保持展开", () => {
    const refreshedGroups: TreeCollapseGroup[] = [
      {
        key: "catapi.chat::codex",
        sessions: [
          { session: { id: "session-cat-latest" }, turns: [{ turn: { id: "turn-cat-9" } }] },
        ],
      },
      {
        key: "api.kaiaigo.com-v1::codex",
        sessions: [
          { session: { id: "session-api-current" }, turns: [{ turn: { id: "turn-api-current" } }] },
          { session: { id: "session-api-old" }, turns: [{ turn: { id: "turn-api-old" } }] },
        ],
      },
    ];
    const activePath = activeTreePathForSelection(refreshedGroups, { selectedTurnId: "turn-api-current" });
    const reconciled = reconcileCollapsedTreeKeys({
      groups: refreshedGroups,
      currentCollapsed: defaultCollapsedTreeKeys(refreshedGroups),
      touchedKeys: new Set(),
      forcedExpandedKeys: activePath?.expandedKeys ?? new Set(),
    });

    expect(activePath).toMatchObject({
      groupKey: "api.kaiaigo.com-v1::codex",
      sessionId: "session-api-current",
      turnId: "turn-api-current",
    });
    expect(reconciled.has("api.kaiaigo.com-v1::codex")).toBe(false);
    expect(reconciled.has("session-api-current")).toBe(false);
    expect(reconciled.has("catapi.chat::codex")).toBe(true);
    expect(reconciled.has("session-cat-latest")).toBe(true);
    expect(reconciled.has("session-api-old")).toBe(true);
  });

  test("用户手动折叠活动目标和 Session 时不再被强制展开", () => {
    const activeKeys = new Set(["target-latest::codex", "session-latest"]);
    const reconciled = reconcileCollapsedTreeKeys({
      groups: treeGroups,
      currentCollapsed: activeKeys,
      touchedKeys: activeKeys,
      forcedExpandedKeys: activeKeys,
    });

    expect(reconciled.has("target-latest::codex")).toBe(true);
    expect(reconciled.has("session-latest")).toBe(true);
  });

  test("步骤工具文案按真实调用、结果回填、Schema 和远端续接排列", () => {
    expect(formatStepToolSummary({
      toolUseNames: ["exec", "exec", "Read"],
      toolUseIds: ["call-1", "call-2", "call-3"],
      toolResultIds: ["result-1", "result-2"],
      toolSchemaCount: 38,
    })).toBe("调用 exec ×2、Read ×1 · 回填 2 个工具结果 · 本请求携带 38 个工具定义");
    expect(formatStepToolSummary({
      toolUseNames: [],
      toolUseIds: [],
      toolResultIds: [],
      toolSchemaCount: 0,
      requestIntentLabel: "远端状态续接",
    })).toBe("无工具动作 · 沿用远端工具上下文");
    expect(formatStepToolSummary({
      toolUseNames: [],
      toolUseIds: [],
      toolResultIds: ["result-1"],
      toolSchemaCount: 0,
    })).toBe("回填 1 个工具结果");
  });

  test("同一聚合范围的数据版本变化会生成新的刷新 key", () => {
    expect(workbenchAggregateRefreshKey({ level: "turn", turnId: "aturn-1", scopeVersion: "3:0:2026-07-16T10:00:00Z" }))
      .not.toBe(workbenchAggregateRefreshKey({ level: "turn", turnId: "aturn-1", scopeVersion: "4:1:2026-07-16T10:01:00Z" }));
  });

  test("总览页 Token 用量可直接从轻量 Step 元数据展示", () => {
    const usage = tokenUsageSummaryFromStep({
      tokenUsage: {
        inputTokens: 120,
        cacheReadTokens: 30,
        totalInputTokens: 150,
        outputTokens: 40,
        totalTokens: 190,
        source: "exact",
      },
    });

    expect(usage.source).toBe("provider_usage");
    expect(usage.sourceLabel).toBe("服务商 usage");
    expect(usage.totalInputTokens).toBe(150);
    expect(usage.outputTokens).toBe(40);
    expect(usage.totalTokens).toBe(190);
  });

  test("自动切到新步骤时旧 rawExchange 不应覆盖新 Step 的 Token 用量", () => {
    expect(selectOverviewTokenUsageSource({
      activeExchangeId: "ex-44",
      rawExchangeId: "ex-17",
      hasStepUsage: true,
    })).toBe("step");
    expect(selectOverviewTokenUsageSource({
      activeExchangeId: "ex-44",
      rawExchangeId: "ex-44",
      hasStepUsage: true,
    })).toBe("raw");
    expect(selectOverviewTokenUsageSource({
      activeExchangeId: "ex-44",
      rawExchangeId: "ex-17",
      hasStepUsage: false,
    })).toBe("unavailable");
  });

  test("总览只计划读取当前 Step 和同 Turn 的前一个 Step", () => {
    const steps = [
      { id: "step-1", exchangeId: "exchange-1", turnId: "turn-1", index: 1 },
      { id: "step-2", exchangeId: "exchange-2", turnId: "turn-1", index: 2 },
      { id: "step-other", exchangeId: "exchange-other", turnId: "turn-2", index: 1 },
    ];

    expect(overviewEvidencePlan({
      active: true,
      step: steps[1],
      turnSteps: steps,
    })).toEqual({
      current: { stepId: "step-2", exchangeId: "exchange-2" },
      previous: { stepId: "step-1", exchangeId: "exchange-1" },
    });
  });

  test("总览首个 Step 没有前一步，已加载证据不重复计划", () => {
    const first = { id: "step-1", exchangeId: "exchange-1", turnId: "turn-1", index: 1 };
    const second = { id: "step-2", exchangeId: "exchange-2", turnId: "turn-1", index: 2 };

    expect(overviewEvidencePlan({
      active: true,
      step: first,
      turnSteps: [first, second],
      loadedCurrentExchangeId: "exchange-1",
    })).toEqual({});
    expect(overviewEvidencePlan({
      active: true,
      step: second,
      turnSteps: [first, second],
      loadedCurrentExchangeId: "exchange-2",
      loadedPreviousExchangeId: "exchange-1",
    })).toEqual({});
    expect(overviewEvidencePlan({
      active: false,
      step: second,
      turnSteps: [first, second],
    })).toEqual({});
  });

  test("总览优先使用 SQLite 返回的同 Thread 跨 Turn 上一模型请求", () => {
    const firstInTurn = { id: "step-2", exchangeId: "exchange-2", turnId: "turn-2", index: 1 };

    expect(overviewEvidencePlan({
      active: true,
      step: firstInTurn,
      turnSteps: [firstInTurn],
      previousModelExchangeId: "exchange-before-turn",
    })).toEqual({
      current: { stepId: "step-2", exchangeId: "exchange-2" },
      previous: { exchangeId: "exchange-before-turn" },
    });
  });

  test("总览请求摘要先做多重集差集再选择最高优先级类别", () => {
    const previous = projectionPreview([
      previewItem("request", "user", "历史上下文", "hash-history"),
      previewItem("request", "user", "重复项", "hash-repeat"),
    ]);
    const current = projectionPreview([
      previewItem("request", "user", "历史上下文", "hash-history"),
      previewItem("request", "user", "重复项", "hash-repeat"),
      previewItem("request", "user", "重复项", "hash-repeat"),
      previewItem("request", "developer", "本次开发约束", "hash-developer"),
    ]);

    expect(projectionOverviewSideSummary(current, previous, "request")).toBe(
      "[真实输入]\n重复项",
    );
  });

  test("总览请求摘要优先最后一条真实输入", () => {
    const current = projectionPreview([
      previewItem("request", "system", "系统约束", "hash-system"),
      previewItem("request", "developer", "开发约束", "hash-developer"),
      {
        ...previewItem("request", undefined, "工具执行结果", "hash-tool", "custom_tool_call_output"),
        jsonPath: "$.input[2].output",
      },
      previewItem("request", "user", "# AGENTS.md instructions\nAgent 注入", "hash-injected"),
      previewItem("request", "user", "较早的真实输入", "hash-user-earlier"),
      previewItem("request", "user", "最后的真实输入", "hash-user-last"),
    ]);

    expect(projectionOverviewSideSummary(current, undefined, "request")).toBe(
      "[真实输入]\n最后的真实输入",
    );
  });

  test("总览真实用户文本优先于同类别纯图片占位", () => {
    const current = projectionPreview([
      previewItem("request", "user", "真实用户输入", "hash-user"),
      {
        ...previewItem("request", "user", "[media]", "hash-image", "input_image"),
        jsonPath: "$.input[0].content[1].image_url",
        mediaDescriptorOrdinals: [0],
      },
    ]);

    expect(projectionOverviewSideSummary(current, undefined, "request")).toBe(
      "[真实输入]\n真实用户输入",
    );
  });

  test("总览请求摘要按 Agent 注入、工具结果、developer、system 依次回退", () => {
    const system = previewItem("request", "system", "系统约束", "hash-system");
    const developer = previewItem("request", "developer", "开发约束", "hash-developer");
    const toolResult = {
      ...previewItem("request", undefined, "工具执行结果", "hash-tool", "custom_tool_call_output"),
      jsonPath: "$.input[2].output",
    };
    const injected = previewItem(
      "request",
      "user",
      "# AGENTS.md instructions\nAgent 注入",
      "hash-injected",
    );

    expect(projectionOverviewSideSummary(
      projectionPreview([system, developer, toolResult, injected]),
      undefined,
      "request",
    )).toBe("[Agent 注入]\n# AGENTS.md instructions\nAgent 注入");
    expect(projectionOverviewSideSummary(
      projectionPreview([system, developer, toolResult]),
      undefined,
      "request",
    )).toBe("[工具结果]\n工具执行结果");
    expect(projectionOverviewSideSummary(
      projectionPreview([system, developer]),
      undefined,
      "request",
    )).toBe("[开发者]\n开发约束");
    expect(projectionOverviewSideSummary(
      projectionPreview([system]),
      undefined,
      "request",
    )).toBe("[系统]\n系统约束");
  });

  test("总览在普通 Preview 文本被收敛时使用同来源语义候选", () => {
    const source = previewItem(
      "request",
      "user",
      "# AGENTS.md instructions\n当前 Agent 注入",
      "hash-injected-candidate",
    );
    const current = projectionPreview([
      {
        ...source,
        textPreview: undefined,
        previewTextBytes: 0,
        truncated: true,
      },
    ], [{
      ...source,
      conversationCategory: "user_injected",
    }]);

    expect(projectionOverviewSideSummary(current, undefined, "request")).toBe(
      "[Agent 注入]\n# AGENTS.md instructions\n当前 Agent 注入",
    );
  });

  test("总览响应合并 Assistant delta 后优先于工具调用展示", () => {
    const current = projectionPreview([
      previewItem("response", undefined, "我", "hash-1", "delta"),
      previewItem("response", undefined, "会继续", "hash-2", "delta"),
      { ...previewItem("response", undefined, "{\"path\":\"a\"}", "hash-3", "arguments"), toolName: "Read" },
    ]);

    expect(projectionOverviewSideSummary(current, undefined, "response")).toBe(
      "[Assistant]\n我会继续",
    );
  });

  test("总览响应合并同 toolUseId 的 custom_tool_call 碎片为连续文本（不逐字换行）", () => {
    const current = projectionPreview([
      { ...previewItem("response", undefined, "const", "hash-ctc-1", "custom_tool_call"), toolUseId: "call_abc123" },
      { ...previewItem("response", undefined, " r", "hash-ctc-2", "custom_tool_call"), toolUseId: "call_abc123" },
      { ...previewItem("response", undefined, " =", "hash-ctc-3", "custom_tool_call"), toolUseId: "call_abc123" },
      { ...previewItem("response", undefined, " await", "hash-ctc-4", "custom_tool_call"), toolUseId: "call_abc123" },
      { ...previewItem("response", undefined, " tools", "hash-ctc-5", "custom_tool_call"), toolUseId: "call_abc123" },
      { ...previewItem("response", undefined, ".exec", "hash-ctc-6", "custom_tool_call"), toolUseId: "call_abc123" },
    ]);

    expect(projectionOverviewSideSummary(current, undefined, "response")).toBe(
      "[工具调用]\nconst r = await tools.exec",
    );
  });

  test("总览响应摘要优先最后一条 Assistant 回复", () => {
    const current = projectionPreview([
      previewItem("response", undefined, "内部思考", "hash-reasoning", "reasoning.delta"),
      previewItem("response", undefined, "较早的模型回复", "hash-assistant-earlier", "delta"),
      {
        ...previewItem("response", undefined, "{\"path\":\"a\"}", "hash-tool", "arguments"),
        toolName: "Read",
      },
      previewItem("response", undefined, "最后的模型回复", "hash-assistant-last", "delta"),
    ]);

    expect(projectionOverviewSideSummary(current, undefined, "response")).toBe(
      "[Assistant]\n最后的模型回复",
    );
  });

  test("总览响应摘要按工具调用、思考依次回退", () => {
    const reasoning = previewItem(
      "response",
      undefined,
      "内部思考",
      "hash-reasoning",
      "reasoning.delta",
    );
    const toolUse = {
      ...previewItem("response", undefined, "{\"path\":\"a\"}", "hash-tool", "arguments"),
      toolName: "Read",
    };

    expect(projectionOverviewSideSummary(
      projectionPreview([reasoning, toolUse]),
      undefined,
      "response",
    )).toBe("[工具调用: Read]\n{\"path\":\"a\"}");
    expect(projectionOverviewSideSummary(
      projectionPreview([reasoning]),
      undefined,
      "response",
    )).toBe("[思考]\n内部思考");
  });

  test("总览多个 Anthropic 工具调用选择最后一项", () => {
    const current = projectionPreview([
      {
        ...previewItem("response", undefined, "{\"path\":\"a\"}", "hash-a", "input_json_delta"),
        toolUseId: "content-block:0",
      },
      {
        ...previewItem("response", undefined, "{\"path\":\"b\"}", "hash-b", "input_json_delta"),
        toolUseId: "content-block:1",
      },
    ]);

    expect(projectionOverviewSideSummary(current, undefined, "response")).toBe(
      "[工具调用]\n{\"path\":\"b\"}",
    );
  });

  test("总览把 Codex 自定义工具输出显示为工具结果并隐藏历史工具动作", () => {
    const current = projectionPreview([
      {
        ...previewItem("request", undefined, "{\"cmd\":\"pwd\"}", "hash-call", "custom_tool_call"),
        jsonPath: "$.input[0].input",
        toolName: "exec_command",
        toolUseId: "call-1",
      },
      {
        ...previewItem(
          "request",
          undefined,
          "Script completed\nWall time 0.1 seconds\nOutput:",
          "hash-output",
          "custom_tool_call_output",
        ),
        jsonPath: "$.input[1].output",
        toolUseId: "call-1",
      },
    ]);

    expect(projectionOverviewSideSummary(current, undefined, "request")).toBe(
      "[工具结果]\nScript completed\nWall time 0.1 seconds\nOutput:",
    );
  });

  test("总览通过父级语义把工具输出数组的 input_text 显示为工具结果", () => {
    const current = projectionPreview([
      {
        ...previewItem("request", undefined, "Script completed", "hash-array-output", "input_text"),
        semanticType: "call_output" as const,
        category: "tool",
        semanticCategory: "tool_result" as const,
        provenance: "tool_runtime" as const,
        jsonPath: "$.input[0].output[0].text",
        toolUseId: "call-array",
      },
    ]);

    expect(projectionOverviewSideSummary(current, undefined, "request")).toBe(
      "[工具结果]\nScript completed",
    );
  });

  test("总览缺少统一语义字段时不再根据 role 和 itemType 猜分类", () => {
    const current = {
      previewState: "complete" as const,
      preview: {
        items: [{
          side: "request" as const,
          role: "user",
          itemType: "input_text",
          jsonPath: "$.input[0].content[0].text",
          textPreview: "不能被猜成真实输入",
          textSha256: "hash-legacy",
        }],
      },
    };

    expect(projectionOverviewSideSummary(current, undefined, "request")).toBeUndefined();
  });

  test("总览显示统一层保留的未知输出类别", () => {
    const unknown = {
      ...previewItem("response", undefined, "供应商新增输出类型", "hash-unknown"),
      conversationCategory: "unknown_output" as const,
    };

    expect(projectionOverviewSideSummary(
      projectionPreview([unknown]),
      undefined,
      "response",
    )).toBe("[未识别输出]\n供应商新增输出类型");
  });

  test("实时刷新合并当前路径与最新路径并按层级去重", () => {
    expect(hierarchyRefreshPlan([
      {
        session: "session-current",
        thread: "thread-current",
        ancestorThreadIds: ["thread-root"],
      },
      {
        session: "session-current",
        thread: "thread-latest",
        ancestorThreadIds: ["thread-root"],
      },
    ])).toEqual({
      sessionIds: ["session-current"],
      childPages: [
        { sessionId: "session-current", parentThreadId: "thread-root" },
        { sessionId: "session-current", parentThreadId: "thread-current" },
        { sessionId: "session-current", parentThreadId: "thread-latest" },
      ],
      turnThreadIds: ["thread-current", "thread-latest"],
    });
  });

  test("供应商成本和实际成本按 6 位小数四舍五入并带币种符号（2026-09-28）", () => {
    expect(formatCostValue(0.00000149, "USD", 6)).toBe("$0.000001");
    expect(formatCostValue(0.0000015, "USD", 6)).toBe("$0.000002");
    expect(formatCostValue(12.3456789, "CNY", 6)).toBe("￥12.345679");
    // 未知币种（如未计价行 'unknown'）不猜测，保持纯数值；缺省参数沿用 USD 默认。
    expect(formatCostValue(0.5, "unknown", 6)).toBe("0.500000");
    expect(formatCostValue(0.5, undefined, 6)).toBe("$0.500000");
  });

  test("Turn 刷新第一页步骤时，若当前选中的是旧最新步骤则切到新最新步骤", () => {
    expect(selectedStepAfterTurnStepsPage({
      replace: true,
      currentStepId: "step-17",
      previousLatestStepId: "step-17",
      nextSteps: [{ id: "step-44", exchangeId: "ex-44" }, { id: "step-17", exchangeId: "ex-17" }],
    })).toEqual({ stepId: "step-44", exchangeId: "ex-44" });
  });

  test("Turn 刷新第一页步骤时，保留用户手动选中的旧步骤", () => {
    expect(selectedStepAfterTurnStepsPage({
      replace: true,
      currentStepId: "step-10",
      previousLatestStepId: "step-17",
      currentExchangeId: "ex-10",
      nextSteps: [{ id: "step-44", exchangeId: "ex-44" }, { id: "step-10", exchangeId: "ex-10" }],
    })).toEqual({ stepId: "step-10", exchangeId: "ex-10" });
  });

  test("URL 中的 Step 优先恢复所属 Turn 和 Session", () => {
    const sessions = [{ id: "asess-1" }, { id: "asess-2" }];
    const turns = [
      { id: "aturn-1", agentSessionId: "asess-1", exchangeIds: ["ex-1", "ex-2"] },
      { id: "aturn-2", agentSessionId: "asess-2", exchangeIds: ["ex-3"] },
    ];

    expect(resolveWorkbenchSelection({
      session: "asess-2",
      turn: "aturn-2",
      step: "ex-2",
    }, sessions, turns)).toEqual({
      sessionId: "asess-1",
      turnId: "aturn-1",
      exchangeId: "ex-2",
    });
  });

  test("旧聚合缺少完整请求指标时必须提示待重建", () => {
    expect(hasCompleteWorkbenchAggregate({ totalCost: 1 })).toBe(false);
    expect(hasCompleteWorkbenchAggregate({
      requestCount: 0,
      stepRequestCount: 0,
      auxiliaryRequestCount: 0,
      durationTotalMs: 0,
      durationSampleCount: 0,
      toolCallCount: 0,
      toolCallsByName: {},
    })).toBe(true);
  });

  test("工具调用摘要按次数降序并限制为前四种", () => {
    expect(toolCallSummary({ Read: 3, Bash: 8, Write: 2, Glob: 5, Grep: 1 })).toBe(
      "Bash ×8 · Glob ×5 · Read ×3 · Write ×2 · 另 1 种",
    );
    expect(toolCallSummary({})).toBe("无工具调用");
  });
});

function projectionPreview(
  items: ReturnType<typeof previewItem>[],
  overviewCandidates: Array<
    ReturnType<typeof previewItem> & {
      conversationCategory: ReturnType<typeof previewItem>["semanticCategory"];
    }
  > = [],
) {
  return {
    previewState: "complete" as const,
    preview: { items, overviewCandidates },
  };
}

function previewItem(
  side: "request" | "response",
  role: string | undefined,
  textPreview: string,
  textSha256: string,
  itemType = "text",
) {
  const semanticCategory = previewSemanticCategory(
    side,
    role,
    itemType,
    textPreview,
  );
  const historyReplay = side === "request"
    && (semanticCategory === "assistant"
      || semanticCategory === "tool_use"
      || semanticCategory === "reasoning"
      || semanticCategory === "refusal");
  return {
    side,
    category: "message",
    role,
    itemType,
    semanticCategory,
    provenance: previewProvenance(semanticCategory),
    displayPolicy: historyReplay ? "history_replay" as const : "conversation" as const,
    contentKinds: itemType.includes("json") || itemType.includes("arguments")
      ? ["json"] as const
      : ["text"] as const,
    jsonPath: side === "request" ? "$.input[0].content[0].text" : "$.events[0].delta",
    textPreview,
    textSha256,
    originalTextBytes: textPreview.length,
    previewTextBytes: textPreview.length,
    truncated: false,
    mediaDescriptorOrdinals: [],
  };
}

function previewSemanticCategory(
  side: "request" | "response",
  role: string | undefined,
  itemType: string,
  text: string,
) {
  if (side === "response") {
    if (itemType.includes("reasoning")) return "reasoning" as const;
    if (itemType.includes("arguments") || itemType.includes("input_json")
      || itemType.includes("custom_tool_call")) {
      return "tool_use" as const;
    }
    return "assistant" as const;
  }
  if (role === "system") return "system" as const;
  if (role === "developer") return "developer" as const;
  if (itemType === "custom_tool_call_output") return "tool_result" as const;
  if (itemType === "custom_tool_call") return "tool_use" as const;
  if (text.startsWith("# AGENTS.md instructions")) return "user_injected" as const;
  return "user_real" as const;
}

function previewProvenance(
  category: ReturnType<typeof previewSemanticCategory>,
) {
  if (category === "system" || category === "developer") return "protocol_system" as const;
  if (category === "user_injected") return "agent_injected" as const;
  if (category === "user_real") return "protocol_user" as const;
  if (category === "tool_result") return "tool_runtime" as const;
  return "model_output" as const;
}
