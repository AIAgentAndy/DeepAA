import {describe, expect, test} from "vitest";
import {inferCustomTargetModelWireApis, isAnthropicFamilyModel, isOpenAiResponsesFamilyModel} from "../src/lib/wire-api-infer.js";
import {resolveTargetModelWireApis} from "../src/lib/proxy-management-domain.js";
import type {ProxyTarget} from "../src/types.js";

describe("自定义目标 wire API 推断", () => {
  test("gpt-* 与 o 系列模型在 OpenAI URL 下只推断 responses", () => {
    expect(isOpenAiResponsesFamilyModel("gpt-5.6-sol")).toBe(true);
    expect(isOpenAiResponsesFamilyModel("gpt-5.6-luna")).toBe(true);
    expect(isOpenAiResponsesFamilyModel("o3")).toBe(true);
    expect(isOpenAiResponsesFamilyModel("o3-mini")).toBe(true);
    expect(isOpenAiResponsesFamilyModel("deepseek-v4-flash")).toBe(false);
    expect(isOpenAiResponsesFamilyModel("glm-5.3")).toBe(false);

    const target = {openaiUrl: "https://relay.example/v1"};
    expect(inferCustomTargetModelWireApis("gpt-5.6-sol", target)).toEqual(["responses"]);
    expect(inferCustomTargetModelWireApis("o3-mini", target)).toEqual(["responses"]);
  });

  test("非 gpt 家族模型在 OpenAI URL 下推断 chat_completions，anthropicUrl 追加 messages", () => {
    expect(inferCustomTargetModelWireApis("deepseek-v4-flash", {openaiUrl: "https://relay.example/v1"}))
      .toEqual(["chat_completions"]);
    expect(inferCustomTargetModelWireApis("deepseek-v4-flash", {
      openaiUrl: "https://relay.example/v1",
      anthropicUrl: "https://relay.example/anthropic",
    })).toEqual(["chat_completions", "messages"]);
    expect(inferCustomTargetModelWireApis("glm-5.3", {anthropicUrl: "https://relay.example/anthropic"}))
      .toEqual(["messages"]);
    expect(inferCustomTargetModelWireApis("glm-5.3", {})).toEqual([]);
  });

  test("双 URL 目标按家族收敛：GPT/o 系列不获得 messages，claude 系列只经 messages 服务", () => {
    const dual = {
      openaiUrl: "https://relay.example/v1",
      anthropicUrl: "https://relay.example/anthropic",
    };
    // GPT/o 家族：即使填了 anthropicUrl 也不推断 messages（Claude Code 无法经 /v1/messages 调用 GPT）。
    expect(inferCustomTargetModelWireApis("gpt-5.6-sol", dual)).toEqual(["responses"]);
    expect(inferCustomTargetModelWireApis("o3-mini", dual)).toEqual(["responses"]);
    expect(isAnthropicFamilyModel("claude-sonnet-5")).toBe(true);
    expect(isAnthropicFamilyModel("anthropic/claude-sonnet-5")).toBe(true);
    expect(isAnthropicFamilyModel("glm-5.3")).toBe(false);
    expect(isAnthropicFamilyModel("gpt-5.6-sol")).toBe(false);
    // claude 家族：anthropicUrl → messages；只有 openaiUrl 时无法服务（默认拒绝）。
    expect(inferCustomTargetModelWireApis("claude-sonnet-5", dual)).toEqual(["messages"]);
    expect(inferCustomTargetModelWireApis("claude-sonnet-5", {anthropicUrl: "https://relay.example/anthropic"}))
      .toEqual(["messages"]);
    expect(inferCustomTargetModelWireApis("claude-sonnet-5", {openaiUrl: "https://relay.example/v1"}))
      .toEqual([]);
  });

  test("resolveTargetModelWireApis：目标声明优先，空数组=显式拒绝不回退", () => {
    const target = {
      id: "relay",
      openaiUrl: "https://relay.example/v1",
      supportedModelWireApis: {"gpt-5.6-sol": ["responses"], "glm-5.3": []},
    } as ProxyTarget;
    expect(resolveTargetModelWireApis(target, "gpt-5.6-sol")).toEqual(["responses"]);
    expect(resolveTargetModelWireApis(target, "glm-5.3")).toEqual([]);
    // 未声明模型回退到 URL 推断
    expect(resolveTargetModelWireApis(target, "deepseek-v4-flash")).toEqual(["chat_completions"]);
  });

  test("resolveTargetModelWireApis：官方预设目标缺声明时继承预设级能力", () => {
    const zhipu = {
      id: "zhipu-cn",
      openaiUrl: "https://open.bigmodel.cn/api/paas/v4",
      anthropicUrl: "https://open.bigmodel.cn/api/anthropic",
      presetId: "zhipu-cn",
    } as ProxyTarget;
    // 智谱预设只声明 chat_completions + anthropicUrl → messages，不推断 responses。
    expect(resolveTargetModelWireApis(zhipu, "glm-5.3")).toEqual(["chat_completions", "messages"]);

    const volces = {
      id: "volces",
      openaiUrl: "https://ark.cn-beijing.volces.com/api/plan/v3",
      anthropicUrl: "https://ark.cn-beijing.volces.com/api/plan",
      presetId: "volcengine-plan",
    } as ProxyTarget;
    expect(resolveTargetModelWireApis(volces, "minimax-m3")).toEqual([
      "chat_completions",
      "responses",
      "messages",
    ]);
  });
});