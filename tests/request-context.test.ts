import { describe, expect, test } from "vitest";
import type { ExchangeContentFilterItem } from "../src/lib/ingestion/projection-types";
import {
  resolveRequestContextProjection,
  type StoredRequestProjectionState,
} from "../src/lib/ingestion/request-context";

describe("Request context 与跨 compaction 继承", () => {
  test("当前投影版本与基线版本不一致时不确认继承", () => {
    const result = resolveRequestContextProjection({
      current: {
        exchangeId: "ex-v7",
        projectionVersion: 7,
        contextMode: "full_replay",
        requestFilterState: "complete",
        nativeTurnStable: true,
        nativeTurnId: "turn-1",
        filterItems: [filterItem("same")],
        boundaryCandidates: [],
      },
      previous: storedState({
        exchangeId: "ex-v6",
        projectionVersion: 6,
        contextEpoch: 0,
        nativeTurnId: "turn-1",
        items: [filterItem("same")],
      }),
    });
    expect(result.requestDedupeState).toBe("unconfirmed");
    expect(result.context.resolution).toBe("unconfirmed");
    expect(result.decisions[0]?.freshness).toBe("unconfirmed");
  });

  test("旧基线缺少投影版本时也不跨版本确认继承", () => {
    const result = resolveRequestContextProjection({
      current: {
        exchangeId: "ex-v7",
        projectionVersion: 7,
        contextMode: "full_replay",
        requestFilterState: "complete",
        nativeTurnStable: true,
        nativeTurnId: "turn-1",
        filterItems: [filterItem("same")],
        boundaryCandidates: [],
      },
      previous: storedState({
        exchangeId: "ex-legacy",
        contextEpoch: 0,
        nativeTurnId: "turn-1",
        items: [filterItem("same")],
      }),
    });

    expect(result.requestDedupeState).toBe("unconfirmed");
    expect(result.context.resolution).toBe("unconfirmed");
  });
  test("同 native Turn 的无 ID 保留项跨边界按 occurrence 交集继承", () => {
    const previous = storedState({
      exchangeId: "ex-148",
      contextEpoch: 0,
      producedBoundaryId: "boundary-checkpoint-1",
      nativeTurnId: "turn-native-1",
      items: [
        filterItem("user-a"),
        filterItem("user-b"),
        filterItem("user-confirm"),
        filterItem("checkpoint", "control"),
      ],
    });

    const result = resolveRequestContextProjection({
      current: {
        exchangeId: "ex-149",
        contextMode: "full_replay",
        requestFilterState: "complete",
        nativeTurnId: "turn-native-1",
        nativeTurnStable: true,
        filterItems: [
          filterItem("user-a"),
          filterItem("user-b"),
          filterItem("user-confirm"),
        ],
        boundaryCandidates: [],
      },
      previous,
    });

    expect(result.context).toEqual({
      contextMode: "full_replay",
      contextEpoch: 1,
      effectiveBoundaryId: "boundary-checkpoint-1",
      producedBoundaryId: undefined,
      comparisonKind: "boundary_carryover",
      baselineExchangeId: "ex-148",
      resolution: "resolved",
    });
    expect(result.requestDedupeState).toBe("compared");
    expect(result.decisions.map(value => value.freshness)).toEqual([
      "inherited",
      "inherited",
      "inherited",
    ]);
  });

  test("边界迁移只隐藏旧 occurrence 并保留新增 user 输入", () => {
    const result = resolveRequestContextProjection({
      current: {
        exchangeId: "ex-after",
        contextMode: "full_replay",
        requestFilterState: "complete",
        nativeTurnId: "turn-native-1",
        nativeTurnStable: true,
        filterItems: [
          filterItem("user-a"),
          filterItem("user-b"),
          filterItem("new-user"),
        ],
        boundaryCandidates: [],
      },
      previous: storedState({
        exchangeId: "ex-boundary",
        contextEpoch: 2,
        producedBoundaryId: "boundary-2",
        nativeTurnId: "turn-native-1",
        items: [filterItem("user-a"), filterItem("user-b")],
      }),
    });

    expect(result.context.contextEpoch).toBe(3);
    expect(result.decisions.map(value => value.freshness)).toEqual([
      "inherited",
      "inherited",
      "current_new",
    ]);
  });

  test("不同 provider lineage 的同正文跨边界仍是新增 occurrence", () => {
    const result = resolveRequestContextProjection({
      current: {
        exchangeId: "ex-after",
        contextMode: "full_replay",
        requestFilterState: "complete",
        nativeTurnStable: false,
        filterItems: [
          filterItem("same-text", "user_real", "provider:new-message:text"),
        ],
        boundaryCandidates: [],
      },
      previous: storedState({
        exchangeId: "ex-boundary",
        contextEpoch: 0,
        producedBoundaryId: "boundary-provider",
        items: [
          filterItem("same-text", "user_real", "provider:old-message:text"),
        ],
      }),
    });

    expect(result.context.resolution).toBe("resolved");
    expect(result.decisions[0]?.freshness).toBe("current_new");
  });

  test("无 provider lineage 且无稳定 native Turn 时整体 unconfirmed", () => {
    const result = resolveRequestContextProjection({
      current: {
        exchangeId: "ex-after",
        contextMode: "full_replay",
        requestFilterState: "complete",
        nativeTurnStable: false,
        filterItems: [filterItem("same-text")],
        boundaryCandidates: [],
      },
      previous: storedState({
        exchangeId: "ex-boundary",
        contextEpoch: 0,
        producedBoundaryId: "boundary-unknown-turn",
        items: [filterItem("same-text")],
      }),
    });

    expect(result.context).toMatchObject({
      comparisonKind: "none",
      resolution: "unconfirmed",
    });
    // 2026-09-17 epoch 持续化：unconfirmed 也物化可推导 epoch（0 + produced 边界推进 1），
    // 下一步以上一步 items 为基线恢复比较，不再级联。
    expect(result.context.contextEpoch).toBe(1);
    expect(result.context.baselineExchangeId).toBeUndefined();
    expect(result.requestDedupeState).toBe("unconfirmed");
    expect(result.decisions.map(value => value.freshness)).toEqual([
      "unconfirmed",
    ]);
  });

  test("同纪元基线个别项消失仍按 occurrence 消减（2026-09-17 有界容忍）", () => {
    const result = resolveRequestContextProjection({
      current: {
        exchangeId: "ex-current",
        contextMode: "full_replay",
        requestFilterState: "complete",
        nativeTurnId: "turn-native-2",
        nativeTurnStable: true,
        filterItems: [filterItem("user-a")],
        boundaryCandidates: [],
      },
      previous: storedState({
        exchangeId: "ex-previous",
        contextEpoch: 4,
        effectiveBoundaryId: "boundary-old",
        nativeTurnId: "turn-native-2",
        items: [filterItem("user-a"), filterItem("user-b")],
      }),
    });

    // user-b 消失（≤ 容忍上限）：比较继续，缺失项不冒充 inherited。
    expect(result.context).toMatchObject({
      comparisonKind: "same_epoch",
      resolution: "resolved",
      baselineExchangeId: "ex-previous",
    });
    expect(result.requestDedupeState).toBe("compared");
    expect(result.decisions.map(value => value.freshness)).toEqual(["inherited"]);
  });

  test("同纪元基线大比例消失仍整体 unconfirmed", () => {
    const result = resolveRequestContextProjection({
      current: {
        exchangeId: "ex-current",
        contextMode: "full_replay",
        requestFilterState: "complete",
        nativeTurnId: "turn-native-2",
        nativeTurnStable: true,
        filterItems: [filterItem("compacted")],
        boundaryCandidates: [],
      },
      previous: storedState({
        exchangeId: "ex-previous",
        contextEpoch: 4,
        effectiveBoundaryId: "boundary-old",
        nativeTurnId: "turn-native-2",
        items: [
          filterItem("a"), filterItem("b"), filterItem("c"),
          filterItem("d"), filterItem("e"), filterItem("user-a"),
        ],
      }),
    });

    expect(result.context).toMatchObject({
      comparisonKind: "none",
      resolution: "unconfirmed",
    });
    expect(result.decisions.map(value => value.freshness)).toEqual(["unconfirmed"]);
  });

  test("当前 after_exchange 边界只记录 producedBoundaryId 不推进当前 epoch", () => {
    const result = resolveRequestContextProjection({
      current: {
        exchangeId: "ex-checkpoint",
        contextMode: "full_replay",
        requestFilterState: "complete",
        nativeTurnId: "turn-native-3",
        nativeTurnStable: true,
        filterItems: [filterItem("checkpoint", "control")],
        boundaryCandidates: [{
          bodySide: "request",
          logicalId: "checkpoint-lane",
          occurrenceOrdinal: 0,
          effectivePhase: "after_exchange",
          evidencePath: "$.input[12].content[0].text",
        }],
      },
      previous: storedState({
        exchangeId: "ex-before",
        contextEpoch: 7,
        nativeTurnId: "turn-native-3",
        items: [],
      }),
    });

    expect(result.context.contextEpoch).toBe(7);
    expect(result.context.producedBoundaryId).toMatch(/^boundary:/u);
    expect(result.context.effectiveBoundaryId).toBeUndefined();
  });

  test("已生效边界的后续同纪元请求不会重复推进 epoch", () => {
    const result = resolveRequestContextProjection({
      current: {
        exchangeId: "ex-next",
        contextMode: "full_replay",
        requestFilterState: "complete",
        nativeTurnId: "turn-native-4",
        nativeTurnStable: true,
        filterItems: [filterItem("user-a"), filterItem("user-b")],
        boundaryCandidates: [],
      },
      previous: storedState({
        exchangeId: "ex-first-new-epoch",
        contextEpoch: 3,
        effectiveBoundaryId: "boundary-stable",
        nativeTurnId: "turn-native-4",
        items: [filterItem("user-a")],
      }),
    });

    expect(result.context).toMatchObject({
      contextEpoch: 3,
      effectiveBoundaryId: "boundary-stable",
      comparisonKind: "same_epoch",
      resolution: "resolved",
    });
    expect(result.decisions.map(value => value.freshness)).toEqual([
      "inherited",
      "current_new",
    ]);
  });

  test("stateful delta 不依赖上一条 Request 的筛选投影", () => {
    const result = resolveRequestContextProjection({
      current: {
        exchangeId: "ex-stateful",
        contextMode: "stateful_delta",
        requestFilterState: "complete",
        nativeTurnStable: false,
        filterItems: [filterItem("new-user")],
        boundaryCandidates: [],
      },
      previous: {
        exchangeId: "ex-missing-projection",
        contextMode: "unknown",
        requestFilterState: "limited",
        nativeTurnStable: false,
        filterItems: [],
      },
    });

    expect(result.context).toEqual({
      contextMode: "stateful_delta",
      contextEpoch: 0,
      comparisonKind: "none",
      resolution: "resolved",
    });
    expect(result.requestDedupeState).toBe("not_applicable");
    expect(result.decisions.map(value => value.freshness)).toEqual([
      "current_new",
    ]);
  });
});

function storedState(options: {
  exchangeId: string;
  projectionVersion?: number;
  contextEpoch: number;
  effectiveBoundaryId?: string;
  producedBoundaryId?: string;
  nativeTurnId?: string;
  items: ExchangeContentFilterItem[];
}): StoredRequestProjectionState {
  return {
    exchangeId: options.exchangeId,
    projectionVersion: options.projectionVersion,
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
