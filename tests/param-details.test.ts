import {describe, expect, test} from "vitest";
import {diffParamDetails, projectParamDetails} from "../src/lib/harness/param-details.js";

describe("模型参数白名单投影", () => {
  test("投影顶层标量与一层对象键（anthropic + responses + zhipu 扩展形态）", () => {
    const details = projectParamDetails({
      model: "glm-5.3",
      max_tokens: 128000,
      temperature: 1,
      thinking: {type: "enabled", budget_tokens: 32000},
      output_config: {effort: "max"},
      reasoning: {effort: "high", summary: "auto"},
      text: {verbosity: "low"},
      tool_choice: {type: "auto", disable_parallel_tool_use: false},
      prompt_cache_key: "session-abc",
      previous_response_id: "resp_123",
      service_tier: "auto",
      // 以下键必须被排除
      metadata: {user_id: "should-not-appear"},
      messages: [{role: "user", content: "x"}],
      tools: [{name: "Bash"}],
      system: "You are...",
    });
    expect(details).toBeDefined();
    expect(details).not.toHaveProperty("model");
    expect(details).not.toHaveProperty("metadata");
    expect(details).not.toHaveProperty("messages");
    expect(details?.max_tokens).toBe(128000);
    expect(details?.thinking).toEqual({type: "enabled", budget_tokens: 32000});
    expect(details?.output_config).toEqual({effort: "max"});
    expect(details?.reasoning).toEqual({effort: "high", summary: "auto"});
    expect(details?.tool_choice).toEqual({type: "auto", disable_parallel_tool_use: false});
    expect(details?.prompt_cache_key).toBe("session-abc");
  });

  test("tool_choice 字符串形态（chat_completions \"auto\"）也保留", () => {
    expect(projectParamDetails({tool_choice: "auto"})?.tool_choice).toBe("auto");
  });

  test("一层对象只保留已知子键，未知子键被剔除", () => {
    const details = projectParamDetails({thinking: {type: "enabled", budget_tokens: 8000, secret: "x"}});
    expect(details?.thinking).toEqual({type: "enabled", budget_tokens: 8000});
  });

  test("长字符串截断到 64 字符；无白名单键返回 undefined", () => {
    const long = "k".repeat(200);
    expect(projectParamDetails({prompt_cache_key: long})?.prompt_cache_key.length).toBe(64);
    expect(projectParamDetails({temperature: undefined})).toBeUndefined();
    expect(projectParamDetails(undefined)).toBeUndefined();
    expect(projectParamDetails({})).toBeUndefined();
  });

  test("总键数受 24 上限约束", () => {
    const params: Record<string, unknown> = {};
    for (let i = 0; i < 40; i++) params[`k${i}`] = i;
    params.temperature = 1;
    // 40 个未知键全部被白名单排除，temperature 仍应保留。
    expect(projectParamDetails(params)?.temperature).toBe(1);
  });
});

describe("参数值级变化 diff", () => {
  test("新增 / 变更 / 删除键均产出，from/to 规范化展示", () => {
    const changes = diffParamDetails(
      {reasoning: {effort: "low"}, temperature: 1, max_tokens: 4096},
      {reasoning: {effort: "high"}, max_tokens: 8192, thinking: {type: "enabled", budget_tokens: 32000}},
    );
    expect(changes).toEqual([
      {key: "max_tokens", from: "4096", to: "8192"},
      {key: "reasoning", from: '{"effort":"low"}', to: '{"effort":"high"}'},
      {key: "temperature", from: "1", to: "∅"},
      {key: "thinking", from: "∅", to: '{"type":"enabled","budget_tokens":32000}'},
    ]);
  });

  test("无变化 / 双方缺失返回空数组", () => {
    expect(diffParamDetails(undefined, undefined)).toEqual([]);
    expect(diffParamDetails({temperature: 1}, {temperature: 1})).toEqual([]);
  });
});
