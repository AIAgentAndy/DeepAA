import {describe, expect, test} from "vitest";
import {modelFamilyOf} from "../src/lib/model-family.js";
import {isVpnTunnelModel} from "../src/proxy/upstream-model-gate.js";

/**
 * 镜像语料：model-family.ts 可识别的模型。共有家族（gpt 含 o 系列/gpt-5.6/
 * claude/grok）的门控判定必须与 modelFamilyOf 完全一致——代理 bundle 不能导入
 * web 侧模块（边界红线），一致性靠本守卫锁定（注册表镜像惯例）。
 */
const MIRROR_CORPUS = [
  "gpt-5.6-sol", "gpt-6-luna", "gpt-4o", "o1", "o3", "o4-mini",
  "claude-opus-5", "claude-sonnet-4.5",
  "grok-4.7", "grok-4",
  "deepseek-v4.1-flash", "deepseek-chat", "glm-5.3", "kimi-k3", "minimax-m3",
  "qwen3-coder", "hunyuan-turbo", "doubao-seed-2.1-pro",
  "openai/gpt-5.6-sol", "x-ai/grok-4", "anthropic/claude-opus-4.5",
  "deepseek/deepseek-chat", "z-ai/glm-5.3",
];

describe("VPN 隧道模型门控（2026-10-10 用户确认）", () => {
  test("镜像守卫：共有家族（gpt/o 系列/claude/grok）与 model-family.ts 判定一致", () => {
    for (const id of MIRROR_CORPUS) {
      const family = modelFamilyOf(id);
      const expected = family === "gpt" || family === "gpt-5.6" || family === "claude" || family === "grok";
      expect(isVpnTunnelModel(id), id).toBe(expected);
    }
  });

  test("gemini 与 chatgpt 为门控扩展项（model-family 无此家族，直连会被模型级封锁）", () => {
    expect(isVpnTunnelModel("gemini-2.5-pro")).toBe(true);
    expect(isVpnTunnelModel("google/gemini-3-pro")).toBe(true);
    expect(isVpnTunnelModel("chatgpt-4o-latest")).toBe(true);
    expect(isVpnTunnelModel("openai/chatgpt-4o-latest")).toBe(true);
    expect(modelFamilyOf("gemini-2.5-pro")).toBeUndefined();
    expect(modelFamilyOf("chatgpt-4o-latest")).toBeUndefined();
  });

  test("无模型/空串/纯空白 → 直连（web 侧用量 GET 等无模型请求）", () => {
    expect(isVpnTunnelModel(undefined)).toBe(false);
    expect(isVpnTunnelModel("")).toBe(false);
    expect(isVpnTunnelModel("   ")).toBe(false);
  });

  test("国产与非家族模型绝不误入隧道；大小写不敏感", () => {
    expect(isVpnTunnelModel("GPT-6-Luna")).toBe(true);
    expect(isVpnTunnelModel("Grok-4.7")).toBe(true);
    expect(isVpnTunnelModel("Claude-Opus-5")).toBe(true);
    expect(isVpnTunnelModel("DeepSeek-V4.1-Flash")).toBe(false);
    expect(isVpnTunnelModel("kimi-k3")).toBe(false);
    expect(isVpnTunnelModel("opencode/deepseek-v4.1-flash")).toBe(false);
    expect(isVpnTunnelModel("GLM-5.3")).toBe(false);
  });
});
