import {describe, expect, test} from "vitest";
import {
  agentBindingForPath,
  AGENT_REGISTRY,
  agentSupportsWireApi,
  bindingForWireApi,
  bindingSupportsSubscription,
  isKnownGatewayAgent,
  modelsResponseFormatForWireApi,
  targetHasBindingForAgent,
} from "../src/lib/agent-registry.js";

describe("Agent 注册表多 binding", () => {
  test("注册表包含五个 Agent，且每个 Agent 都有默认 binding 与 models binding", () => {
    const ids = AGENT_REGISTRY.map(item => item.id);
    expect(ids).toEqual(["codex", "claude", "opencode", "dsh", "zcode"]);
    for (const entry of AGENT_REGISTRY) {
      expect(entry.bindings.length).toBeGreaterThan(0);
      expect(entry.defaultBinding).toBeDefined();
      expect(entry.defaultModelsBinding).toBeDefined();
    }
  });

  test("opencode 与 dsh 均注册三种 wire API（2026-10-06 dsh 三协议支持，defaultBinding 保持 chat）", () => {
    const opencode = AGENT_REGISTRY.find(item => item.id === "opencode")!;
    expect(opencode.bindings.map(item => item.wireApi)).toEqual([
      "responses",
      "chat_completions",
      "messages",
    ]);
    const dsh = AGENT_REGISTRY.find(item => item.id === "dsh")!;
    expect(dsh.bindings.map(item => item.wireApi)).toEqual(["chat_completions", "responses", "messages"]);
    expect(dsh.defaultBinding.wireApi).toBe("chat_completions");
  });

  test("agentBindingForPath 按协议路径解析 binding", () => {
    expect(agentBindingForPath("opencode", "/v1/responses")?.wireApi).toBe("responses");
    expect(agentBindingForPath("opencode", "/v1/chat/completions")?.wireApi).toBe("chat_completions");
    expect(agentBindingForPath("opencode", "/v1/messages")?.wireApi).toBe("messages");
    expect(agentBindingForPath("claude", "/v1/responses")).toBeUndefined();
    expect(agentBindingForPath("dsh", "/v1/messages")?.wireApi).toBe("messages");
    expect(agentBindingForPath("claude", "/v1/chat/completions")).toBeUndefined();
  });

  test("agentSupportsWireApi 与 bindingForWireApi 保持注册表一致", () => {
    expect(agentSupportsWireApi("codex", "responses")).toBe(true);
    expect(agentSupportsWireApi("codex", "chat_completions")).toBe(false);
    expect(agentSupportsWireApi("codex", "messages")).toBe(false);
    expect(agentSupportsWireApi("claude", "messages")).toBe(true);
    expect(agentSupportsWireApi("opencode", "chat_completions")).toBe(true);
    expect(agentSupportsWireApi("dsh", "chat_completions")).toBe(true);
    expect(agentSupportsWireApi("dsh", "responses")).toBe(true);
    expect(agentSupportsWireApi("dsh", "messages")).toBe(true);
    expect(bindingForWireApi("opencode", "messages")?.protocol).toBe("anthropic");
    expect(bindingForWireApi("claude", "messages")?.protocol).toBe("anthropic");
    // Codex 官方 CLI 只支持 Responses，不注册 chat_completions binding。
    expect(bindingForWireApi("codex", "chat_completions")).toBeUndefined();
  });

  test("modelsResponseFormatForWireApi：messages 输出 Anthropic 格式，其余 OpenAI 格式", () => {
    expect(modelsResponseFormatForWireApi("messages")).toBe("anthropic");
    expect(modelsResponseFormatForWireApi("responses")).toBe("openai");
    expect(modelsResponseFormatForWireApi("chat_completions")).toBe("openai");
  });

  test("targetHasBindingForAgent 按目标协议 URL 判断 binding 可用性", () => {
    const openaiOnly = {openaiUrl: "https://example.com/v1"};
    const anthropicOnly = {anthropicUrl: "https://example.com/v1"};
    const both = {openaiUrl: "https://example.com/v1", anthropicUrl: "https://example.com/v1"};
    expect(targetHasBindingForAgent(openaiOnly, "opencode")).toBe(true);
    expect(targetHasBindingForAgent(openaiOnly, "dsh")).toBe(true);
    expect(targetHasBindingForAgent(anthropicOnly, "opencode")).toBe(true);
    expect(targetHasBindingForAgent(anthropicOnly, "dsh")).toBe(true);
    expect(targetHasBindingForAgent(both, "claude")).toBe(true);
  });

  test("订阅透传按 binding 判断，OpenCode/dsh 首期全部关闭", () => {
    expect(bindingSupportsSubscription("codex", "responses")).toBe(true);
    // Codex 无 chat_completions binding，订阅能力按 responses 判定。
    expect(bindingSupportsSubscription("codex", "chat_completions")).toBe(false);
    expect(bindingSupportsSubscription("claude", "messages")).toBe(true);
    expect(bindingSupportsSubscription("opencode", "responses")).toBe(false);
    expect(bindingSupportsSubscription("opencode", "messages")).toBe(false);
    expect(bindingSupportsSubscription("dsh", "chat_completions")).toBe(false);
  });

  test("isKnownGatewayAgent 覆盖新增 Agent", () => {
    expect(isKnownGatewayAgent("opencode")).toBe(true);
    expect(isKnownGatewayAgent("dsh")).toBe(true);
    expect(isKnownGatewayAgent("zcode")).toBe(true);
  });

  test("zcode 注册三 binding：messages 默认且开放订阅透传，openai 系不透传", () => {
    const zcode = AGENT_REGISTRY.find(item => item.id === "zcode")!;
    expect(zcode.label).toBe("ZCode");
    expect(zcode.defaultBinding.wireApi).toBe("messages");
    expect(zcode.bindings.map(item => item.wireApi)).toEqual(["messages", "chat_completions", "responses"]);
    expect(bindingSupportsSubscription("zcode", "messages")).toBe(true);
    expect(bindingSupportsSubscription("zcode", "chat_completions")).toBe(false);
    expect(bindingSupportsSubscription("zcode", "responses")).toBe(false);
  });
});
