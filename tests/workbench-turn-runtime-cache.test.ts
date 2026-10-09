import { describe, expect, test } from "vitest";
import type {
  WorkbenchContextSnapshot,
  WorkbenchStepDiff,
} from "../src/lib/app-state";
import type {
  AgentStep,
  AuxiliaryExchange,
  HarnessLearningInsight,
} from "../src/lib/harness";
import {
  retainTurnRuntimeCaches,
  WORKBENCH_TURN_RUNTIME_CACHE_CAPACITY,
  type WorkbenchTurnRuntimeCache,
  type WorkbenchTurnRuntimeCacheMutation,
} from "../src/lib/workbench-turn-runtime-cache";

describe("Workbench Turn 运行时缓存", () => {
  test("依次访问九个 Turn 后只保留最近八个 Turn", () => {
    let cache = emptyCache();

    for (let index = 1; index <= WORKBENCH_TURN_RUNTIME_CACHE_CAPACITY + 1; index += 1) {
      const turnId = `turn-${index}`;
      cache = addTurn(cache, turnId);
    }

    expect(cache.lruTurnIds).toEqual([
      "turn-9", "turn-8", "turn-7", "turn-6",
      "turn-5", "turn-4", "turn-3", "turn-2",
    ]);
    expect(turnIdsInCache(cache)).toEqual(new Set(cache.lruTurnIds));
  });

  test("当前 Turn 与选中 Step 所属 Turn 即使最旧也不会淘汰", () => {
    let cache = emptyCache();
    for (let index = 1; index <= WORKBENCH_TURN_RUNTIME_CACHE_CAPACITY; index += 1) {
      cache = addTurn(cache, `turn-${index}`);
    }

    cache = addTurn(cache, "turn-9", ["turn-1", "turn-2"]);

    expect(cache.lruTurnIds).toContain("turn-1");
    expect(cache.lruTurnIds).toContain("turn-2");
    expect(cache.lruTurnIds).toContain("turn-9");
    expect(cache.lruTurnIds).toHaveLength(WORKBENCH_TURN_RUNTIME_CACHE_CAPACITY);
  });

  test("重新访问旧 Turn 后把它提升为 MRU", () => {
    let cache = emptyCache();
    for (let index = 1; index <= WORKBENCH_TURN_RUNTIME_CACHE_CAPACITY; index += 1) {
      cache = addTurn(cache, `turn-${index}`);
    }

    cache = retainTurnRuntimeCaches(cache, {}, ["turn-2"], []);

    expect(cache.lruTurnIds[0]).toBe("turn-2");
    expect(cache.lruTurnIds).toHaveLength(WORKBENCH_TURN_RUNTIME_CACHE_CAPACITY);
  });

  test("淘汰 Turn 时原子清理页面、Step、快照、Diff、辅助请求和洞察", () => {
    let cache = emptyCache();
    for (let index = 1; index <= WORKBENCH_TURN_RUNTIME_CACHE_CAPACITY + 1; index += 1) {
      cache = addTurn(cache, `turn-${index}`);
    }

    expect(cache.pages["turn-1"]).toBeUndefined();
    expect(cache.steps.some(item => item.turnId === "turn-1")).toBe(false);
    expect(cache.snapshots.some(item => item.stepId === "step-turn-1")).toBe(false);
    expect(cache.diffs.some(item => item.toStepId === "step-turn-1")).toBe(false);
    expect(cache.auxiliaryExchanges.some(item => item.agentTurnId === "turn-1")).toBe(false);
    expect(cache.learningInsights.some(item => item.turnId === "turn-1")).toBe(false);
  });

  test("同一 Turn 加载更多只更新 MRU 而不增加 LRU 槽", () => {
    let cache = addTurn(emptyCache(), "turn-1");
    const nextStep = step("turn-1", 2);

    cache = retainTurnRuntimeCaches(cache, {
      pages: {
        ...cache.pages,
        "turn-1": { candidateCount: 2, loaded: 2, hasMore: false },
      },
      steps: [...cache.steps, nextStep],
    }, ["turn-1"], []);

    expect(cache.lruTurnIds).toEqual(["turn-1"]);
    expect(cache.steps.map(item => item.id)).toEqual(["step-turn-1", "step-turn-1-2"]);
  });

  test("请求失败没有成功 mutation 时保持原状态引用和 LRU", () => {
    const cache = addTurn(emptyCache(), "turn-1");

    const next = retainTurnRuntimeCaches(cache, undefined, ["turn-2"], []);

    expect(next).toBe(cache);
    expect(next.lruTurnIds).toEqual(["turn-1"]);
  });
});

function emptyCache(): WorkbenchTurnRuntimeCache {
  return {
    lruTurnIds: [],
    pages: {},
    steps: [],
    snapshots: [],
    diffs: [],
    auxiliaryExchanges: [],
    learningInsights: [],
  };
}

function addTurn(
  current: WorkbenchTurnRuntimeCache,
  turnId: string,
  protectedTurnIds: string[] = [],
): WorkbenchTurnRuntimeCache {
  const nextStep = step(turnId);
  const mutation: WorkbenchTurnRuntimeCacheMutation = {
    pages: {
      ...current.pages,
      [turnId]: { candidateCount: 1, loaded: 1, hasMore: false },
    },
    steps: [...current.steps, nextStep],
    snapshots: [...current.snapshots, snapshot(nextStep.id)],
    diffs: [...current.diffs, diff(nextStep.id)],
    auxiliaryExchanges: [...current.auxiliaryExchanges, auxiliary(turnId)],
    learningInsights: [...current.learningInsights, insight(turnId)],
  };
  return retainTurnRuntimeCaches(current, mutation, [turnId], protectedTurnIds);
}

function turnIdsInCache(cache: WorkbenchTurnRuntimeCache): Set<string> {
  const stepTurnById = new Map(cache.steps.map(item => [item.id, item.turnId]));
  return new Set([
    ...Object.keys(cache.pages),
    ...cache.steps.map(item => item.turnId),
    ...cache.snapshots.map(item => stepTurnById.get(item.stepId) || ""),
    ...cache.diffs.map(item => stepTurnById.get(item.toStepId) || ""),
    ...cache.auxiliaryExchanges.map(item => item.agentTurnId || ""),
    ...cache.learningInsights.map(item => item.turnId),
  ].filter(Boolean));
}

function step(turnId: string, index = 1): AgentStep {
  return {
    id: `step-${turnId}${index === 1 ? "" : `-${index}`}`,
    turnId,
    agentSessionId: "session-1",
    exchangeId: `exchange-${turnId}-${index}`,
    index,
    timestamp: "2026-07-17T00:00:00.000Z",
    phase: "final_answer",
    requestAction: "user_prompt",
    responseAction: "final",
    toolSchemaCount: 0,
    toolUseNames: [],
    toolUseIds: [],
    toolResultIds: [],
    contextSnapshotId: `snapshot-${turnId}-${index}`,
  };
}

function snapshot(stepId: string): WorkbenchContextSnapshot {
  return { id: `snapshot-${stepId}`, stepId } as WorkbenchContextSnapshot;
}

function diff(stepId: string): WorkbenchStepDiff {
  return { id: `diff-${stepId}`, toStepId: stepId } as WorkbenchStepDiff;
}

function auxiliary(turnId: string): AuxiliaryExchange {
  return { id: `aux-${turnId}`, agentTurnId: turnId } as AuxiliaryExchange;
}

function insight(turnId: string): HarnessLearningInsight {
  return { turnId, agentSessionId: "session-1" } as HarnessLearningInsight;
}
