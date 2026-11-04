import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseAgentStepHarness } from "../src/lib/workbench-harness-client.js";

/**
 * I1 客户端宽松校验回归（2026-11-03）：observedOnlyTools / reference / callsLimited
 * 新字段透传；缺失字段不落成 false/空导致 UI 误读（缺失 ≠ 没有）。
 */
describe("workbench-harness-client parseAgentStepHarness（I1 字段）", () => {
  const baseHarness = {
    stepId: "step-1",
    exchangeId: "ex-1",
    stepIndex: 1,
    inventory: { tools: [], skills: [], rules: [] },
    legacyData: false,
    candidateCount: 1,
    processedCount: 1,
    limited: false,
  };

  test("observed_only 工具与 exposure 字段透传", () => {
    const parsed = parseAgentStepHarness({
      ...baseHarness,
      inventory: {
        tools: [{ name: "declared-only", kind: "tool", defTokensEst: 10, callsThisStep: 0, callsThisTurn: 0, invoked: false, exposure: "declared" }],
        skills: [],
        rules: [],
        observedOnlyTools: [{ name: "observed-only", kind: "tool", defTokensEst: 0, callsThisStep: 2, callsThisTurn: 3, invoked: true, exposure: "observed_only" }],
      },
    });
    assert.ok(parsed);
    assert.equal(parsed.inventory.tools.length, 1);
    assert.equal(parsed.inventory.tools[0].exposure, "declared");
    assert.ok(parsed.inventory.observedOnlyTools);
    assert.equal(parsed.inventory.observedOnlyTools.length, 1);
    assert.equal(parsed.inventory.observedOnlyTools[0].exposure, "observed_only");
    assert.equal(parsed.inventory.observedOnlyTools[0].callsThisStep, 2);
  });

  test("reference 与 callsLimited 透传；缺失时为 undefined 而非空对象", () => {
    const withFlags = parseAgentStepHarness({
      ...baseHarness,
      reference: { borrowed: ["tools"], donorSnapshotHash: "ab12cd34ef", donorLastSeenAt: "2026-11-03T00:00:00Z" },
      callsLimited: { step: true, turn: false },
    });
    assert.ok(withFlags);
    assert.ok(withFlags.reference);
    assert.deepEqual(withFlags.reference.borrowed, ["tools"]);
    assert.equal(withFlags.reference.donorSnapshotHash, "ab12cd34ef");
    assert.ok(withFlags.callsLimited);
    assert.equal(withFlags.callsLimited.step, true);
    assert.equal(withFlags.callsLimited.turn, false);

    const withoutFlags = parseAgentStepHarness(baseHarness);
    assert.ok(withoutFlags);
    assert.equal(withoutFlags.reference, undefined);
    assert.equal(withoutFlags.callsLimited, undefined);
  });

  test("存量响应（无 exposure 字段）仍可解析，不因新增字段缺失而拒绝", () => {
    const parsed = parseAgentStepHarness({
      ...baseHarness,
      inventory: {
        tools: [{ name: "legacy-tool", kind: "tool", defTokensEst: 5, callsThisStep: 1, callsThisTurn: 1, invoked: true }],
        skills: [],
        rules: [],
      },
    });
    assert.ok(parsed);
    assert.equal(parsed.inventory.tools.length, 1);
    assert.equal(parsed.inventory.tools[0].name, "legacy-tool");
  });
});
