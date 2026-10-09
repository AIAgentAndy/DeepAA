import {describe, expect, test} from "vitest";
import {
  agentScopeIncludes,
  isKnownAgentId,
  KNOWN_AGENT_IDS,
  normalizeAgentScope,
} from "../src/types.js";

describe("Agent scope 默认拒绝语义", () => {
  test("KNOWN_AGENT_IDS 覆盖全部已知 Agent 且类型由常量推导", () => {
    expect(KNOWN_AGENT_IDS).toEqual(["codex", "claude", "opencode", "dsh", "zcode"]);
    expect(isKnownAgentId("codex")).toBe(true);
    expect(isKnownAgentId("claude")).toBe(true);
    expect(isKnownAgentId("opencode")).toBe(true);
    expect(isKnownAgentId("dsh")).toBe(true);
    expect(isKnownAgentId("zcode")).toBe(true);
    expect(isKnownAgentId("glm-agent")).toBe(false);
  });

  test("normalizeAgentScope 缺省归一为空数组而不是全部 Agent", () => {
    expect(normalizeAgentScope(undefined)).toEqual([]);
    expect(normalizeAgentScope(null)).toEqual([]);
    expect(normalizeAgentScope(42)).toEqual([]);
    expect(normalizeAgentScope("codex")).toEqual([]);
  });

  test("normalizeAgentScope 保留显式已知 Agent 并去重", () => {
    expect(normalizeAgentScope(["codex", "claude", "opencode", "dsh"])).toEqual([
      "codex",
      "claude",
      "opencode",
      "dsh",
    ]);
    expect(normalizeAgentScope(["codex", "codex"])).toEqual(["codex"]);
  });

  test("normalizeAgentScope 丢弃未知 Agent，避免透传绕过白名单", () => {
    expect(normalizeAgentScope(["codex", "bogus"])).toEqual(["codex"]);
    expect(normalizeAgentScope(["bogus"])).toEqual([]);
  });

  test("agentScopeIncludes 缺省与空数组都不允许任何 Agent", () => {
    expect(agentScopeIncludes(undefined, "codex")).toBe(false);
    expect(agentScopeIncludes([], "codex")).toBe(false);
    expect(agentScopeIncludes(["claude"], "codex")).toBe(false);
    expect(agentScopeIncludes(["opencode"], "opencode")).toBe(true);
  });
});
