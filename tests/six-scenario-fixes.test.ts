import { describe, expect, test } from "vitest";
import { readFile as fs } from "node:fs/promises";
import { classifyProtocol } from "../src/lib/harness/protocol.js";
import { conversationFingerprintKey } from "../src/lib/conversation-semantics/classify.js";
import { ContentPreviewBuilder } from "../src/lib/ingestion/content-preview.js";
import {
  resolveRequestContextProjection,
  type StoredRequestProjectionState,
} from "../src/lib/ingestion/request-context";
import { resolveAgentPath } from "../src/lib/ingestion/thread-identity.js";
import type { ExchangeContentFilterItem } from "../src/lib/ingestion/projection-types";
import type { RawCapturedExchange } from "../src/lib/harness/types.js";

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

function makeExchange(options: {
  exchangeId?: string;
  routingAgent?: string;
  wireApi?: RawCapturedExchange["routing"]["wireApi"];
  path?: string;
  targetId?: string;
  headers?: Record<string, string>;
  body?: Record<string, unknown>;
} = {}): RawCapturedExchange {
  const body = options.body ?? { model: "gpt-5", input: [] };
  const path = options.path ?? "/v1/chat/completions";
  return {
    schemaVersion: 1,
    exchangeId: options.exchangeId ?? "capture-default:ex-1",
    captureSessionId: "capture-default",
    sequence: 1,
    capturedAt: "2026-09-17T02:00:00.000Z",
    completedAt: "2026-09-17T02:00:01.000Z",
    durationMs: 1_000,
    routing: {
      targetId: options.targetId ?? "target-default",
      targetName: "Test",
      targetFormatHint: "openai",
      localUrl: `http://localhost:3211${path}`,
      upstreamUrl: `https://example.test${path}`,
      localPath: path,
      upstreamPath: path,
      method: "POST",
      ...(options.routingAgent ? {agent: options.routingAgent} : {}),
      ...(options.wireApi ? {wireApi: options.wireApi} : {}),
    },
    request: {
      headers: Object.fromEntries(
        Object.entries(options.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]),
      ),
      rawBody: JSON.stringify(body),
      parsedBody: body,
      bodySizeBytes: JSON.stringify(body).length,
      bodySha256: "0".repeat(64),
    },
    response: {
      status: 200,
      statusText: "OK",
      headers: {},
      rawBody: "{}",
      parsedBody: {},
      bodySizeBytes: 2,
      bodySha256: "1".repeat(64),
      isStreaming: false,
    },
    bodyStorage: { policy: "inline" },
    captureDiagnostics: [],
    security: {
      containsSensitiveHeaders: false,
      headerRedactionAppliedInApi: true,
      rawBodiesStoredLocally: true,
    },
  };
}

function filterItem(
  fingerprint: string,
  category: ExchangeContentFilterItem["category"] = "user_real",
  providerLineageKey?: string,
): ExchangeContentFilterItem {
  return {
    side: "request",
    category,
    fingerprint: fingerprint.padEnd(64, "0").slice(0, 64),
    providerLineageKey,
  };
}

function storedState(options: {
  exchangeId: string;
  contextEpoch: number;
  effectiveBoundaryId?: string;
  producedBoundaryId?: string;
  nativeTurnId?: string;
  items: ExchangeContentFilterItem[];
}): StoredRequestProjectionState {
  return {
    exchangeId: options.exchangeId,
    contextMode: "full_replay",
    contextEpoch: options.contextEpoch,
    effectiveBoundaryId: options.effectiveBoundaryId,
    producedBoundaryId: options.producedBoundaryId,
    requestFilterState: "complete",
    nativeTurnId: options.nativeTurnId,
    nativeTurnStable: options.nativeTurnId !== undefined,
    filterItems: options.items,
  };
}

function currentItem(options: {
  exchangeId: string;
  items: ExchangeContentFilterItem[];
}) {
  return {
    exchangeId: options.exchangeId,
    contextMode: "full_replay" as const,
    requestFilterState: "complete" as const,
    nativeTurnId: undefined,
    nativeTurnStable: false,
    filterItems: options.items,
    boundaryCandidates: [],
  };
}

// ---------------------------------------------------------------------------
// #1 辅助标题调用内容签名注册表
// ---------------------------------------------------------------------------

describe("辅助标题调用识别（网关链路签名注册表）", () => {
  test("zcode 标题调用判定为 title-generation 辅助端点", () => {
    const exchange = makeExchange({
      routingAgent: "zcode",
      wireApi: "messages",
      path: "/v1/messages",
      body: {
        model: "glm-5.3-flash",
        system: [{type: "text", text: "Generate a concise title for this coding session.\n\nDo not answer."}],
        messages: [{role: "user", content: [{type: "text", text: "这是啥项目？"}]}],
      },
    });
    expect(classifyProtocol(exchange).endpointKind).toBe("title-generation");
    expect(classifyProtocol(exchange).isAuxiliary).toBe(true);
  });

  test("claude-code 会话命名调用判定为 title-generation（key=网关段名 claude）", () => {
    const exchange = makeExchange({
      routingAgent: "claude",
      wireApi: "messages",
      path: "/v1/messages",
      body: {
        model: "claude-x",
        system: [
          {type: "text", text: "x-anthropic-billing-header: cc_version=2.1.270;"},
          {type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude."},
          {type: "text", text: "You are naming a coding session so the user can pick it out of a long list of sessions."},
        ],
        messages: [{role: "user", content: [{type: "text", text: "这是啥项目？"}]}],
      },
    });
    expect(classifyProtocol(exchange).endpointKind).toBe("title-generation");
  });

  test("opencode 标题生成调用判定为 title-generation", () => {
    const exchange = makeExchange({
      routingAgent: "opencode",
      wireApi: "chat_completions",
      body: {
        model: "grok-4.5",
        messages: [
          {role: "system", content: "You are a title generator. You output ONLY a thread title."},
          {role: "user", content: "Generate a title for this conversation:"},
          {role: "user", content: "这是啥项目？"},
        ],
      },
    });
    expect(classifyProtocol(exchange).endpointKind).toBe("title-generation");
  });

  test("codex 任务标题调用（user 槽签名）判定为 title-generation", () => {
    const exchange = makeExchange({
      routingAgent: "codex",
      wireApi: "responses",
      path: "/v1/responses",
      body: {
        model: "gpt-5.6",
        instructions: "You are Codex, an agent based on GPT-5.",
        input: [
          {role: "user", type: "message", content: [{type: "input_text", text: "# AGENTS.md instructions"}]},
          {role: "user", type: "message", content: [{type: "input_text", text: "Generate a concise, single-line task title of at most 36 characters"}]},
        ],
      },
    });
    expect(classifyProtocol(exchange).endpointKind).toBe("title-generation");
  });

  test("dsh 标题签名（迁移注册表后）仍然生效", () => {
    const exchange = makeExchange({
      routingAgent: "dsh",
      wireApi: "chat_completions",
      body: {
        model: "deepseek-flash",
        messages: [
          {role: "system", content: "Create a concise title for an AI coding-assistant session from the supplied human messages."},
          {role: "user", content: "Generate the session title from this JSON array of human messages: []"},
        ],
      },
    });
    expect(classifyProtocol(exchange).endpointKind).toBe("title-generation");
  });

  test("主模型请求不误判为标题调用", () => {
    const exchange = makeExchange({
      routingAgent: "zcode",
      wireApi: "messages",
      path: "/v1/messages",
      body: {
        model: "glm-5.3-flash",
        system: [{type: "text", text: "You are ZCode, an interactive coding agent"}],
        messages: [
          {role: "user", content: [{type: "text", text: "这是啥项目？ --- 只读分析，别修改。"}]},
          {role: "user", content: [{type: "tool_result", tool_use_id: "t1", content: "file"}]},
        ],
      },
    });
    const classification = classifyProtocol(exchange);
    expect(classification.endpointKind).toBe("model-call");
    expect(classification.isModelCall).toBe(true);
  });
});

test("标题签名注册表 key 覆盖全部已声明 Agent 的网关段名", async () => {
  const { AGENT_REGISTRY } = await import("../src/lib/agent-registry.js");
  const registry = await import("../src/lib/harness/protocol.js");
  // 从源码提取签名表 key（运行时未导出；防止再出现 claude/claude-code 语义名错配）。
  const source = await fs(
    new URL("../src/lib/harness/protocol.ts", import.meta.url),
    "utf8",
  );
  const declared = [...source.matchAll(/^\s{2}("?[a-z-]+"?):\s+\[/gmu)].map(match =>
    match[1]!.replace(/^"|"$/gu, ""));
  expect(declared.sort()).toEqual(["claude", "codex", "dsh", "opencode", "zcode"]);
  void registry;
  void AGENT_REGISTRY;
});

// ---------------------------------------------------------------------------
// #2a 指纹 wire 形态归一（content ↔ text）
// ---------------------------------------------------------------------------

describe("指纹 wire 形态归一", () => {
  test("字符串 content 与单 text part 的同一文本得到同一指纹", () => {
    const asStringForm = conversationFingerprintKey({
      category: "user_real",
      side: "input",
      provenance: "protocol_user",
      providerItemType: "content",
      textSha256: "aaa",
      contentKinds: ["text"],
    });
    const asPartForm = conversationFingerprintKey({
      category: "user_real",
      side: "input",
      provenance: "protocol_user",
      providerItemType: "text",
      textSha256: "aaa",
      contentKinds: ["text"],
    });
    expect(asStringForm).toBe(asPartForm);
  });

  test("不同文本仍然不同指纹", () => {
    const a = conversationFingerprintKey({
      category: "user_real",
      side: "input",
      provenance: "protocol_user",
      providerItemType: "content",
      textSha256: "aaa",
      contentKinds: ["text"],
    });
    const b = conversationFingerprintKey({
      category: "user_real",
      side: "input",
      provenance: "protocol_user",
      providerItemType: "content",
      textSha256: "bbb",
      contentKinds: ["text"],
    });
    expect(a).not.toBe(b);
  });
});

// ---------------------------------------------------------------------------
// #2b 指纹文本空白折叠
// ---------------------------------------------------------------------------

describe("指纹文本空白折叠", () => {
  test("同一文本的 1/2 空格序列化差异折叠为同一 textSha256", () => {
    const builderOne = new ContentPreviewBuilder({
      exchangeId: "whitespace-one",
      projectionVersion: 6,
    });
    const itemOne = builderOne.beginTextItem({
      side: "request",
      category: "message",
      role: "user",
      itemType: "text",
      jsonPath: "$.messages[0].content[0].text",
    });
    itemOne.pushText("这是啥项目？ --- 只读分析，别修改。");
    itemOne.finish();

    const builderTwo = new ContentPreviewBuilder({
      exchangeId: "whitespace-two",
      projectionVersion: 6,
    });
    const itemTwo = builderTwo.beginTextItem({
      side: "request",
      category: "message",
      role: "user",
      itemType: "text",
      jsonPath: "$.messages[0].content[0].text",
    });
    itemTwo.pushText("这是啥项目？  --- 只读分析，别修改。");
    itemTwo.finish();

    const one = builderOne.finalize().items[0];
    const two = builderTwo.finalize().items[0];
    expect(one.textPreview).toBe("这是啥项目？ --- 只读分析，别修改。");
    expect(two.textPreview).toBe("这是啥项目？  --- 只读分析，别修改。");
    expect(one.textSha256).toBe(two.textSha256);
  });

  test("换行与制表符同样折叠；不同文本哈希不同", () => {
    const builder = new ContentPreviewBuilder({
      exchangeId: "whitespace-mixed",
      projectionVersion: 6,
    });
    const item = builder.beginTextItem({
      side: "request",
      category: "message",
      role: "user",
      itemType: "text",
      jsonPath: "$.messages[0].content[0].text",
    });
    item.pushText("行一\n\n行二\t行三");
    item.finish();
    const first = builder.finalize().items[0];

    const builderB = new ContentPreviewBuilder({
      exchangeId: "whitespace-mixed-b",
      projectionVersion: 6,
    });
    const itemB = builderB.beginTextItem({
      side: "request",
      category: "message",
      role: "user",
      itemType: "text",
      jsonPath: "$.messages[0].content[0].text",
    });
    itemB.pushText("行一 行二 行三");
    itemB.finish();
    const second = builderB.finalize().items[0];
    expect(first.textSha256).toBe(second.textSha256);

    const builderC = new ContentPreviewBuilder({
      exchangeId: "whitespace-mixed-c",
      projectionVersion: 6,
    });
    const itemC = builderC.beginTextItem({
      side: "request",
      category: "message",
      role: "user",
      itemType: "text",
      jsonPath: "$.messages[0].content[0].text",
    });
    itemC.pushText("完全不同");
    itemC.finish();
    expect(builderC.finalize().items[0].textSha256).not.toBe(first.textSha256);
  });
});

// ---------------------------------------------------------------------------
// #2c/#2d/#2e 排重基线鲁棒性（control 排除 / 有界消失容忍 / epoch 持续化）
// ---------------------------------------------------------------------------

describe("排重基线鲁棒性", () => {
  test("基线中 control 项消失不影响比较（token 计数器替换）", () => {
    const previous = storedState({
      exchangeId: "ex-c1",
      contextEpoch: 3,
      items: [
        filterItem("sys-a", "system"),
        filterItem("user-q"),
        filterItem("counter-14969356", "control"),
      ],
    });
    const result = resolveRequestContextProjection({
      current: currentItem({
        exchangeId: "ex-c2",
        items: [
          filterItem("sys-a", "system"),
          filterItem("user-q"),
          filterItem("counter-14968924", "control"),
        ],
      }),
      previous,
    });
    expect(result.requestDedupeState).toBe("compared");
    expect(result.decisions.map(item => item.freshness)).toEqual([
      "inherited",
      "inherited",
      "current_new",
    ]);
  });

  test("有界消失容忍：基线个别 plumbing 消息被整体替换仍可比较", () => {
    const previous = storedState({
      exchangeId: "ex-t1",
      contextEpoch: 2,
      items: [
        filterItem("sys-a", "system"),
        filterItem("sys-b", "system"),
        filterItem("sys-c", "system"),
        filterItem("sys-d", "system"),
        filterItem("user-q"),
        filterItem("tool-r1", "tool_result"),
      ],
    });
    const result = resolveRequestContextProjection({
      current: currentItem({
        exchangeId: "ex-t2",
        // sys-d 消失（被重写为 sys-d2），其余保持
        items: [
          filterItem("sys-a", "system"),
          filterItem("sys-b", "system"),
          filterItem("sys-c", "system"),
          filterItem("sys-d2", "system"),
          filterItem("user-q"),
          filterItem("tool-r1", "tool_result"),
          filterItem("tool-r2", "tool_result"),
        ],
      }),
      previous,
    });
    expect(result.requestDedupeState).toBe("compared");
    const fresh = result.decisions.filter(item => item.freshness === "current_new");
    expect(fresh.map(item => item.item.fingerprint[0])).toEqual(["s", "t"]);
  });

  test("大比例消失（真实 compaction 无边界标记）仍诚实 unconfirmed，但 epoch 持续化", () => {
    const previous = storedState({
      exchangeId: "ex-k1",
      contextEpoch: 4,
      items: [
        filterItem("a", "system"),
        filterItem("b", "system"),
        filterItem("c", "system"),
        filterItem("d", "system"),
        filterItem("user-q"),
      ],
    });
    const result = resolveRequestContextProjection({
      current: currentItem({
        exchangeId: "ex-k2",
        items: [filterItem("compacted-summary", "system")],
      }),
      previous,
    });
    expect(result.requestDedupeState).toBe("unconfirmed");
    expect(result.context.resolution).toBe("unconfirmed");
    expect(result.context.contextEpoch).toBe(4);
  });

  test("unconfirmed 之后下一步可恢复比较（级联阻断）", () => {
    // 步骤 1：比较失败 → unconfirmed 但 epoch 已物化
    const failingBaseline = storedState({
      exchangeId: "ex-f1",
      contextEpoch: 6,
      items: [
        filterItem("a", "system"),
        filterItem("b", "system"),
        filterItem("c", "system"),
        filterItem("d", "system"),
        filterItem("e", "system"),
        filterItem("f", "system"),
        filterItem("user-q"),
      ],
    });
    const stepTwo = resolveRequestContextProjection({
      current: currentItem({
        exchangeId: "ex-f2",
        items: [filterItem("fresh-world", "system")],
      }),
      previous: failingBaseline,
    });
    expect(stepTwo.requestDedupeState).toBe("unconfirmed");
    expect(stepTwo.context.contextEpoch).toBe(6);

    // 步骤 2：以上一步（unconfirmed 但 filter complete + epoch 已知）为基线恢复比较
    const recoveredBaseline: StoredRequestProjectionState = {
      exchangeId: "ex-f2",
      contextMode: "full_replay",
      contextEpoch: 6,
      requestFilterState: "complete",
      nativeTurnId: undefined,
      nativeTurnStable: false,
      filterItems: [filterItem("fresh-world", "system")],
    };
    const stepThree = resolveRequestContextProjection({
      current: currentItem({
        exchangeId: "ex-f3",
        items: [filterItem("fresh-world", "system"), filterItem("tool-1", "tool_result")],
      }),
      previous: recoveredBaseline,
    });
    expect(stepThree.requestDedupeState).toBe("compared");
    expect(stepThree.decisions.map(item => item.freshness)).toEqual(["inherited", "current_new"]);
  });
});

// ---------------------------------------------------------------------------
// #5 Codex custom_tool_call_output 归一化
// ---------------------------------------------------------------------------

describe("Codex custom_tool_call_output 归一化", () => {
  test("custom 工具输出识别为 providedToolResults 且动作判定为 tool_result", async () => {
    const {normalizeExchange} = await import("../src/lib/harness/normalizer.js");
    const {requestActionFor} = await import("../src/lib/harness/agent.js");
    const exchange = makeExchange({
      routingAgent: "codex",
      wireApi: "responses",
      path: "/v1/responses",
      body: {
        model: "gpt-5.6",
        instructions: "You are Codex",
        input: [
          {type: "message", role: "user", content: [{type: "input_text", text: "列出文件"}]},
          {type: "custom_tool_call", call_id: "call_1", name: "shell", input: "{\"command\":\"ls\"}"},
          {type: "custom_tool_call_output", call_id: "call_1", output: "README.md\npackage.json"},
        ],
        tools: [],
      },
    });
    const normalized = normalizeExchange(exchange);
    expect(normalized.harnessPayload.providedToolResults).toHaveLength(1);
    expect(normalized.harnessPayload.providedToolResults[0]?.content).toContain("package.json");
    expect(requestActionFor(normalized)).toBe("tool_result");
  });

  test("function_call_output 行为不变（回归）", async () => {
    const {normalizeExchange} = await import("../src/lib/harness/normalizer.js");
    const {requestActionFor} = await import("../src/lib/harness/agent.js");
    const exchange = makeExchange({
      routingAgent: "codex",
      wireApi: "responses",
      path: "/v1/responses",
      body: {
        model: "gpt-5.6",
        input: [
          {type: "function_call_output", call_id: "call_2", output: "done"},
        ],
      },
    });
    const normalized = normalizeExchange(exchange);
    expect(normalized.harnessPayload.providedToolResults).toHaveLength(1);
    expect(normalized.harnessPayload.providedToolResults[0]?.providerType).toBe("function_call_output");
    expect(requestActionFor(normalized)).toBe("tool_result");
  });
});

// ---------------------------------------------------------------------------
// #6 OpenCode 信封前缀
// ---------------------------------------------------------------------------

describe("OpenCode 技能提醒信封", () => {
  test("[Category+Skill Reminder] 归类为 user_injected", async () => {
    const {classifyAgentEnvelope} = await import("../src/lib/conversation-semantics/agent-provenance.js");
    const decision = classifyAgentEnvelope("opencode", "[Category+Skill Reminder] **Built-in**: playwright, frontend");
    expect(decision).toEqual({
      semanticCategory: "user_injected",
      provenance: "agent_injected",
      confidence: "exact",
    });
  });

  test("真实用户输入不受影响", async () => {
    const {classifyAgentEnvelope} = await import("../src/lib/conversation-semantics/agent-provenance.js");
    expect(classifyAgentEnvelope("opencode", "这是啥项目？ 只读分析。")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// #3 Agent 维度会话身份
// ---------------------------------------------------------------------------

describe("Agent 维度会话身份", () => {
  test("同一外部 Session 跨 target 不再拆分（Codex 失败切换场景）", () => {
    const onLajiang = resolveAgentPath(makeExchange({
      routingAgent: "codex",
      wireApi: "responses",
      path: "/v1/responses",
      targetId: "lajiang.xyz",
      headers: {"session_id": "01a0ad17-a12d"},
      body: {model: "gpt-5.6", input: []},
    }));
    const onAi98 = resolveAgentPath(makeExchange({
      routingAgent: "codex",
      wireApi: "responses",
      path: "/v1/responses",
      targetId: "ai98pro.xyz",
      headers: {"session_id": "01a0ad17-a12d"},
      body: {model: "gpt-5.6", input: []},
    }));
    expect(onAi98.agentSessionId).toBe(onLajiang.agentSessionId);
    expect(onAi98.agentFingerprintId).toBe(onLajiang.agentFingerprintId);
    expect(onAi98.agentFingerprintId).toBe("fp-codex");
  });

  test("同一 Agent 会话跨 wire API 不再拆分（OpenCode 双协议场景）", () => {
    const viaResponses = resolveAgentPath(makeExchange({
      routingAgent: "opencode",
      wireApi: "responses",
      path: "/v1/responses",
      headers: {"x-opencode-session": "ses_x"},
      body: {model: "gpt-x", input: []},
    }));
    const viaChat = resolveAgentPath(makeExchange({
      routingAgent: "opencode",
      wireApi: "chat_completions",
      path: "/v1/chat/completions",
      headers: {"x-opencode-session": "ses_x"},
      body: {model: "glm-y", messages: []},
    }));
    expect(viaChat.agentSessionId).toBe(viaResponses.agentSessionId);
  });

  test("不同外部 Session 仍彼此隔离", () => {
    const first = resolveAgentPath(makeExchange({
      routingAgent: "codex",
      headers: {"session_id": "sess-aaa"},
    }));
    const second = resolveAgentPath(makeExchange({
      routingAgent: "codex",
      headers: {"session_id": "sess-bbb"},
    }));
    expect(second.agentSessionId).not.toBe(first.agentSessionId);
  });
});
