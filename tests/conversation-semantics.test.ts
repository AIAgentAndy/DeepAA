import { describe, expect, test } from "vitest";
import {
  ALL_CONVERSATION_SEMANTIC_CATEGORIES,
  buildSemanticLogicalId,
  classifySemanticLane,
  conversationFingerprintKey,
} from "../src/lib/conversation-semantics";
import { classifyAgentProfile, profileForAgent } from "../src/lib/conversation-semantics/agent-profiles";
import { classifyAgentEnvelopePrefix } from "../src/lib/conversation-semantics/agent-provenance";

describe("统一会话语义分类", () => {
  test("五个 Agent 都有可查询的语义 Profile，未知 Agent 使用 generic 回退", () => {
    for (const agentKind of ["codex", "claude-code", "dsh", "zcode", "opencode"] as const) {
      expect(profileForAgent(agentKind).kind).toBe(agentKind);
    }
    expect(profileForAgent("unknown").kind).toBe("generic");
  });

  test("dsh Profile 按作用域识别 runtime context、图片句柄和工具结果 marker", () => {
    expect(classifyAgentProfile({
      agentKind: "dsh",
      bodySide: "request",
      providerRole: "user",
      providerItemType: "text",
      evidencePath: "$.messages[2].content[0].text",
      textPrefix: "Current runtime context: workspace=/repo",
    })).toMatchObject({
      category: "user_injected",
      provenance: "agent_injected",
      scope: "message",
    });
    expect(classifyAgentProfile({
      agentKind: "dsh",
      bodySide: "request",
      providerRole: "user",
      providerItemType: "text",
      evidencePath: "$.messages[2].content[1].text",
      textPrefix: "Image #1 (image/png; 1024x768)",
    })).toMatchObject({
      category: "user_injected",
      provenance: "agent_injected",
      scope: "part",
    });
    expect(classifyAgentProfile({
      agentKind: "dsh",
      bodySide: "request",
      providerRole: "user",
      providerItemType: "text",
      evidencePath: "$.messages[2].content[0].text",
      textPrefix: "Attached image(s) from tool result:",
    })).toMatchObject({
      category: "tool_result",
      provenance: "provider_tool",
      scope: "message-remainder",
    });
    expect(classifyAgentProfile({
      agentKind: "dsh",
      bodySide: "request",
      providerRole: "user",
      providerItemType: "text",
      evidencePath: "$.messages[2].content[0].text",
      textPrefix: "Image \"diagram.png\" is attached",
    })).toBeUndefined();
    expect(classifyAgentEnvelopePrefix("dsh", "Image #")).toBe("pending");
  });

  test("按 Anthropic 顶层 system 路径识别协议系统输入", () => {
    expect(classifySemanticLane({
      protocol: "anthropic-messages",
      agentKind: "claude-code",
      bodySide: "request",
      providerItemType: "text",
      evidencePath: "$.system[0].text",
      parentIdentity: "system:0",
      semanticLane: "text:0",
    })).toMatchObject({
      semanticCategory: "system",
      provenance: "protocol_system",
      displayPolicy: "conversation",
      dedupePolicy: "occurrence",
    });
  });

  test("保留 Anthropic 普通 user text 为真实协议输入", () => {
    expect(classifySemanticLane({
      protocol: "anthropic-messages",
      agentKind: "claude-code",
      bodySide: "request",
      providerRole: "user",
      providerItemType: "text",
      evidencePath: "$.messages[0].content[1].text",
      parentIdentity: "message:0",
      semanticLane: "content:1:text",
    })).toMatchObject({
      semanticCategory: "user_real",
      provenance: "physical_user",
      confidence: "structural",
    });
  });

  test("把 Codex checkpoint 信封识别为控制输入", () => {
    expect(classifySemanticLane({
      protocol: "openai-responses",
      agentKind: "codex",
      bodySide: "request",
      providerRole: "user",
      providerItemType: "input_text",
      evidencePath: "$.input[292].content[0].text",
      parentIdentity: "input:292",
      semanticLane: "content:0:input_text",
      textPrefix: "You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary",
    })).toMatchObject({
      semanticCategory: "control",
      provenance: "agent_control",
      confidence: "exact",
      displayPolicy: "conversation",
      dedupePolicy: "occurrence",
    });
  });

  test("把稳定 Agent 约束信封识别为注入输入", () => {
    expect(classifySemanticLane({
      protocol: "openai-responses",
      agentKind: "codex",
      bodySide: "request",
      providerRole: "user",
      providerItemType: "input_text",
      evidencePath: "$.input[6].content[0].text",
      parentIdentity: "input:6",
      semanticLane: "content:0:input_text",
      textPrefix: "# AGENTS.md instructions for /repo\n\n<INSTRUCTIONS>",
    })).toMatchObject({
      semanticCategory: "user_injected",
      provenance: "agent_injected",
      confidence: "exact",
    });
  });

  test("zcode 的 system-reminder 注入信封不再标为真实输入", () => {
    expect(classifySemanticLane({
      protocol: "anthropic-messages",
      agentKind: "zcode",
      bodySide: "request",
      providerRole: "user",
      providerItemType: "text",
      evidencePath: "$.messages[3].content[0].text",
      parentIdentity: "messages:3",
      semanticLane: "content:0:text",
      textPrefix: "<system-reminder> The TodoWrite tool hasn't been used recently",
    })).toMatchObject({
      semanticCategory: "user_injected",
      provenance: "agent_injected",
      confidence: "exact",
    });
    // 普通用户文本仍为真实输入。
    expect(classifySemanticLane({
      protocol: "anthropic-messages",
      agentKind: "zcode",
      bodySide: "request",
      providerRole: "user",
      providerItemType: "text",
      evidencePath: "$.messages[3].content[0].text",
      parentIdentity: "messages:3",
      semanticLane: "content:0:text",
      textPrefix: "当前项目有几个问题需要修复",
    })).toMatchObject({
      semanticCategory: "user_real",
      provenance: "protocol_user",
    });
  });

  test("把 Responses Request reasoning 识别为历史重放", () => {
    expect(classifySemanticLane({
      protocol: "openai-responses",
      agentKind: "codex",
      bodySide: "request",
      providerItemType: "summary_text",
      ancestorTypes: ["reasoning", "summary"],
      evidencePath: "$.input[12].summary[0].text",
      parentIdentity: "item:reason-1",
      semanticLane: "summary:0",
      providerItemId: "reason-1",
    })).toMatchObject({
      semanticCategory: "reasoning",
      provenance: "model_output",
      displayPolicy: "history_replay",
      dedupePolicy: "history_replay",
    });
  });

  test("把 Responses call output 识别为本轮工具结果", () => {
    expect(classifySemanticLane({
      protocol: "openai-responses",
      agentKind: "codex",
      bodySide: "request",
      providerItemType: "function_call_output",
      evidencePath: "$.input[7].output",
      parentIdentity: "item:call-output-1",
      semanticLane: "output",
      toolUseId: "call-1",
    })).toMatchObject({
      semanticCategory: "tool_result",
      provenance: "tool_runtime",
      displayPolicy: "conversation",
      dedupePolicy: "occurrence",
    });
  });

  test("把 Responses 原生 compaction 输出识别为 provider control", () => {
    expect(classifySemanticLane({
      protocol: "openai-responses",
      agentKind: "generic",
      bodySide: "response",
      providerItemType: "compaction",
      evidencePath: "$.output[3].encrypted_content",
      parentIdentity: "item:cmp-1",
      semanticLane: "compaction",
      providerItemId: "cmp-1",
    })).toMatchObject({
      semanticCategory: "control",
      provenance: "provider_control",
      displayPolicy: "conversation",
      dedupePolicy: "none",
    });
  });

  test("把 Chat refusal 输出识别为拒绝而不是 assistant", () => {
    expect(classifySemanticLane({
      protocol: "openai-chat-completions",
      agentKind: "generic",
      bodySide: "response",
      providerItemType: "refusal",
      evidencePath: "$.choices[0].message.refusal",
      parentIdentity: "choice:0",
      semanticLane: "refusal",
    })).toMatchObject({
      semanticCategory: "refusal",
      provenance: "model_output",
    });
  });

  test("未知结构只进入方向对应的 unknown 类别", () => {
    expect(classifySemanticLane({
      protocol: "unknown",
      agentKind: "unknown",
      bodySide: "request",
      providerItemType: "future_input",
      evidencePath: "$.future.value",
      parentIdentity: "future:0",
      semanticLane: "value",
    }).semanticCategory).toBe("unknown_input");

    expect(classifySemanticLane({
      protocol: "unknown",
      agentKind: "unknown",
      bodySide: "response",
      providerItemType: "future_output",
      evidencePath: "$.future.value",
      parentIdentity: "future:0",
      semanticLane: "value",
    }).semanticCategory).toBe("unknown_output");
  });

  test("同一父容器的不同 semantic lane 生成不同 logicalId", () => {
    const content = buildSemanticLogicalId("response", "choice:0", "content");
    const refusal = buildSemanticLogicalId("response", "choice:0", "refusal");
    const firstTool = buildSemanticLogicalId("response", "choice:0", "tool:call-1");
    const secondTool = buildSemanticLogicalId("response", "choice:0", "tool:call-2");

    expect(new Set([content, refusal, firstTool, secondTool])).toHaveLength(4);
  });

  test("指纹包含来源与 provider 类型但不依赖数组路径", () => {
    const base = {
      category: "user_real" as const,
      side: "input" as const,
      provenance: "physical_user" as const,
      providerItemType: "input_text",
      textSha256: "a".repeat(64),
    };
    expect(conversationFingerprintKey(base)).toBe(conversationFingerprintKey({
      ...base,
      evidencePath: "$.input[999].content[0].text",
    }));
    expect(conversationFingerprintKey(base)).not.toBe(conversationFingerprintKey({
      ...base,
      providerItemType: "text",
    }));
    expect(conversationFingerprintKey(base)).not.toBe(conversationFingerprintKey({
      ...base,
      provenance: "protocol_user",
    }));
  });

  test("媒体 SHA 进入指纹：不同图片不碰撞，同图跨类别仍不合并", () => {
    const base = {
      side: "input" as const,
      provenance: "physical_user" as const,
      providerItemType: "input_text",
      textSha256: "same-text",
      mediaSha256: ["a".repeat(64)],
    };
    expect(conversationFingerprintKey({
      category: "user_real",
      ...base,
    })).not.toBe(conversationFingerprintKey({
      category: "user_real",
      ...base,
      mediaSha256: ["b".repeat(64)],
    }));
    expect(conversationFingerprintKey({
      category: "user_real",
      ...base,
    })).not.toBe(conversationFingerprintKey({
      category: "user_injected",
      ...base,
    }));
  });

  test("权威类别常量固定包含十二类", () => {
    expect(ALL_CONVERSATION_SEMANTIC_CATEGORIES).toEqual([
      "system",
      "developer",
      "user_real",
      "user_injected",
      "tool_result",
      "assistant",
      "tool_use",
      "reasoning",
      "refusal",
      "control",
      "unknown_input",
      "unknown_output",
    ]);
  });
});
