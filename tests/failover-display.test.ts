import {describe, expect, test} from "vitest";
import {buildFailoverTrajectory, formatFailoverBadgeText, formatFailoverChipText, formatFallbackEntryLabel, parseStepFailover} from "../src/lib/failover-display";

const servedFailover = {
  trigger: "consecutive_failures" as const,
  fromTargetId: "primary.example",
  fromTargetName: "中转站A",
  fromModel: "gpt-5.6-sol",
  toTargetId: "backup.example",
  toTargetName: "中转站B",
  toModel: "glm-5.3",
  attempts: [
    {targetId: "primary.example", model: "gpt-5.6-sol", outcome: "error" as const, detail: "HTTP 502"},
    {targetId: "backup.example", model: "glm-5.3", outcome: "served" as const},
  ],
  retryCount: 2,
};

describe("parseStepFailover", () => {
  test("合法结构完整解析", () => {
    expect(parseStepFailover(servedFailover)).toEqual(servedFailover);
  });

  test("旧数据缺省 / 异常结构返回 undefined，不抛错", () => {
    expect(parseStepFailover(undefined)).toBeUndefined();
    expect(parseStepFailover(null)).toBeUndefined();
    expect(parseStepFailover("text")).toBeUndefined();
    expect(parseStepFailover({})).toBeUndefined();
    expect(parseStepFailover({...servedFailover, trigger: "unknown"})).toBeUndefined();
    expect(parseStepFailover({...servedFailover, attempts: []})).toBeUndefined();
    expect(parseStepFailover({...servedFailover, attempts: [{outcome: "boom"}]})).toBeUndefined();
  });

  test("超长 detail 被剔除，attempts 超 8 项截断", () => {
    const parsed = parseStepFailover({
      ...servedFailover,
      attempts: [
        {targetId: "t", model: "m", outcome: "error", detail: "x".repeat(200)},
        ...Array.from({length: 10}, () => ({targetId: "t", model: "m", outcome: "served"})),
      ],
      retryCount: 11,
    });
    expect(parsed?.attempts).toHaveLength(8);
    expect(parsed?.attempts[0]?.detail).toBeUndefined();
  });
});

describe("formatFailoverChipText / formatFailoverBadgeText", () => {
  test("转移成功：紧凑徽标展示 from → to", () => {
    expect(formatFailoverChipText(servedFailover)).toBe("故障转移 · gpt-5.6-sol · 中转站A → glm-5.3 · 中转站B");
    expect(formatFailoverBadgeText(servedFailover))
      .toBe("gpt-5.6-sol · 中转站A → glm-5.3 · 中转站B · 连续失败故障转移 · HTTP 502 · 第 2 次尝试服务");
  });

  test("压缩切回成功（主模型自服务）：展示切回语义", () => {
    const recovered = {
      ...servedFailover,
      trigger: "compaction" as const,
      toTargetId: "primary.example",
      toModel: "gpt-5.6-sol",
      attempts: [{targetId: "primary.example", model: "gpt-5.6-sol", outcome: "served" as const}],
      retryCount: 1,
    };
    expect(formatFailoverChipText(recovered)).toBe("故障转移 · gpt-5.6-sol · 中转站A 已切回主模型");
    expect(formatFailoverBadgeText(recovered)).toBe("gpt-5.6-sol · 中转站A（上下文压缩切回 · 已切回主模型）");
  });

  test("全部候选失败：明确展示失败次数与原因", () => {
    const exhausted = {
      ...servedFailover,
      attempts: [
        {targetId: "primary.example", model: "gpt-5.6-sol", outcome: "error" as const, detail: "HTTP 429"},
        {targetId: "backup.example", model: "glm-5.3", outcome: "error" as const, detail: "HEADER_TIMEOUT"},
      ],
      retryCount: 2,
    };
    expect(formatFailoverBadgeText(exhausted))
      .toBe("gpt-5.6-sol · 中转站A → glm-5.3 · 中转站B · 连续失败故障转移 · HTTP 429、响应头超时 · 2 次尝试均失败");
  });
});

describe("formatFallbackEntryLabel", () => {
  const targetNames = new Map([
    ["catapi.chat", "CatAPI"],
    ["dmapi.xyz", "DmAPI"],
  ]);

  test("展示「模型 ID · 供应商显示名」", () => {
    expect(formatFallbackEntryLabel("gpt-5.6-sol_catapi.chat", targetNames)).toBe("gpt-5.6-sol · CatAPI");
  });

  test("供应商名缺失回退路由 ID", () => {
    expect(formatFallbackEntryLabel("gpt-5.6-sol_ghost.example", targetNames)).toBe("gpt-5.6-sol · ghost.example");
  });

  test("非法网关模型串原样返回", () => {
    expect(formatFallbackEntryLabel("not-a-gateway-model", targetNames)).toBe("not-a-gateway-model");
  });
});

describe("同模型 ID 跨供应商转移（2026-09-14 回归：身份判定含目标）", () => {
  const sameModelFailover = {
    trigger: "consecutive_failures" as const,
    fromTargetId: "ai98pro.xyz",
    fromTargetName: "ai98pro",
    fromModel: "gpt-5.6-sol",
    toTargetId: "catapi.chat",
    toTargetName: "catapi",
    toModel: "gpt-5.6-sol",
    attempts: [
      {targetId: "ai98pro.xyz", model: "gpt-5.6-sol", outcome: "error" as const, detail: "HEADER_TIMEOUT"},
      {targetId: "ai98pro.xyz", model: "gpt-5.6-sol", outcome: "error" as const, detail: "HEADER_TIMEOUT"},
      {targetId: "catapi.chat", model: "gpt-5.6-sol", outcome: "served" as const},
    ],
    retryCount: 3,
  };

  test("同 ID 跨目标服务：不显示「已切回主模型」，展示 from → to（含供应商）", () => {
    expect(formatFailoverChipText(sameModelFailover))
      .toBe("故障转移 · gpt-5.6-sol · ai98pro → gpt-5.6-sol · catapi");
    expect(formatFailoverBadgeText(sameModelFailover))
      .toBe("gpt-5.6-sol · ai98pro → gpt-5.6-sol · catapi · 连续失败故障转移 · 响应头超时 · 第 3 次尝试服务");
  });

  test("旧数据缺供应商名：回退路由 ID 展示", () => {
    const legacy = {...sameModelFailover, fromTargetName: undefined, toTargetName: undefined};
    expect(formatFailoverChipText(legacy))
      .toBe("故障转移 · gpt-5.6-sol · ai98pro.xyz → gpt-5.6-sol · catapi.chat");
  });

  test("parseStepFailover 解析供应商名；缺省字段兼容旧数据", () => {
    const parsed = parseStepFailover(sameModelFailover);
    expect(parsed?.fromTargetName).toBe("ai98pro");
    expect(parsed?.toTargetName).toBe("catapi");
    const legacy = parseStepFailover({...sameModelFailover, fromTargetName: undefined});
    expect(legacy?.fromTargetName).toBeUndefined();
    expect(legacy?.toTargetName).toBe("catapi");
  });
});

describe("buildFailoverTrajectory（Turn 总览轨迹）", () => {
  const f = (toTargetName: string, toModel = "gpt-5.6-sol") => ({
    trigger: "consecutive_failures" as const,
    fromTargetId: "ai98pro.xyz",
    fromTargetName: "ai98pro",
    fromModel: "gpt-5.6-sol",
    toTargetId: toTargetName,
    toTargetName,
    toModel,
    attempts: [{targetId: toTargetName, model: toModel, outcome: "served" as const}],
    retryCount: 1,
  });

  test("按时间顺序去重连续重复端点", () => {
    const trajectory = buildFailoverTrajectory([f("catapi"), f("catapi"), f("dmapi"), f("dmapi"), f("lajiang")]);
    expect(trajectory).toEqual([
      "gpt-5.6-sol · ai98pro",
      "gpt-5.6-sol · catapi",
      "gpt-5.6-sol · dmapi",
      "gpt-5.6-sol · lajiang",
    ]);
  });

  test("空输入返回 undefined；单端点重复仍是有效的主→备份轨迹", () => {
    expect(buildFailoverTrajectory([])).toBeUndefined();
    expect(buildFailoverTrajectory([f("catapi"), f("catapi")])).toEqual([
      "gpt-5.6-sol · ai98pro",
      "gpt-5.6-sol · catapi",
    ]);
  });
});
