import { describe, expect, test } from "vitest";
import type { CaptureSummary } from "../src/lib/app-state";
import type { AgentSession } from "../src/lib/harness";
import {
  mergeWorkbenchTreeCaptures,
  mergeWorkbenchTreeSessions,
  parseWorkbenchTreeRefresh,
} from "../src/lib/workbench-tree-refresh";

describe("SQLite 工作台树增量刷新", () => {
  test("真实新树摘要更新轻量字段并保留已加载详情与页外 Session", () => {
    const currentCaptures: CaptureSummary[] = [
      {
        id: "tree:target-new:fingerprint-new",
        fileName: "旧树摘要",
        filePath: "",
        exchangeCount: 3,
        startTime: "2026-07-17T00:01:00.000Z",
        endTime: "2026-07-17T00:02:00.000Z",
        modelSet: ["old-model"],
        targetSet: ["target-old"],
        agentTurnCount: 4,
        fileSize: 0,
      },
      {
        id: "tree:off-page:fingerprint-off-page",
        fileName: "页外摘要",
        filePath: "",
        exchangeCount: 1,
        modelSet: [],
        targetSet: ["off-page"],
        agentTurnCount: 1,
        fileSize: 0,
      },
    ];
    const currentSessions: AgentSession[] = [
      {
        id: "session-existing",
        agentFingerprintId: "fingerprint-old",
        source: "agent-session-header",
        externalSessionId: "external-old",
        externalThreadId: "thread-loaded",
        exchangeIds: ["exchange-loaded"],
        auxiliaryExchangeIds: ["aux-loaded"],
        startTime: "2026-07-17T00:01:00.000Z",
        endTime: "2026-07-17T00:02:00.000Z",
        modelSet: ["old-model"],
        targetSet: ["target-old"],
        confidence: "exact",
        evidence: [{
          kind: "agent-session-header",
          explanation: "已加载证据",
          evidence: [],
        }],
      },
      {
        id: "session-off-page",
        agentFingerprintId: "fingerprint-off-page",
        source: "manual",
        exchangeIds: ["exchange-off-page"],
        auxiliaryExchangeIds: [],
        startTime: "2026-07-16T00:00:00.000Z",
        endTime: "2026-07-16T00:01:00.000Z",
        modelSet: [],
        targetSet: ["off-page"],
        confidence: "low",
        evidence: [],
      },
    ];
    const payload: unknown = {
      agents: [{
        targetId: "target-new",
        targetName: "新目标",
        agentFingerprintId: "fingerprint-new",
        agentName: "codex",
        sessions: [
          {
            id: "session-existing",
            externalSessionId: "external-new",
            startTime: "2026-07-17T00:00:00.000Z",
            endTime: "2026-07-17T00:05:00.000Z",
            modelSet: ["gpt-new"],
            modelSetLimited: false,
            requestCount: 7,
            threadCount: 2,
          },
          {
            id: "session-new",
            startTime: "2026-07-17T00:03:00.000Z",
            endTime: "2026-07-17T00:06:00.000Z",
            modelSet: ["gpt-new", "gpt-next"],
            modelSetLimited: false,
            requestCount: 3,
            threadCount: 1,
          },
        ],
      }],
      latestPath: {
        target: "target-new",
        agent: "codex",
        session: "session-new",
        thread: "thread-new",
        ancestorThreadIds: [],
      },
      candidateCount: 3,
      processedCount: 2,
      limited: true,
      hasMore: true,
      nextCursor: "cursor",
      dataVersion: 9,
      derivedStatus: "running",
    };

    const refresh = parseWorkbenchTreeRefresh(payload);
    expect(refresh).toBeDefined();
    expect(refresh?.derivedStatus).toBe("building");
    const captures = mergeWorkbenchTreeCaptures(
      currentCaptures,
      refresh!.captures,
      {
        protectedIds: new Set(["tree:off-page:fingerprint-off-page"]),
        maxItems: 3,
      },
    );
    const sessions = mergeWorkbenchTreeSessions(
      currentSessions,
      refresh!.agentSessions,
      {
        protectedIds: new Set(["session-off-page"]),
        maxItems: 3,
      },
    );
    const existing = sessions.find(item => item.id === "session-existing");
    const created = sessions.find(item => item.id === "session-new");

    expect(captures.find(item => item.id === "tree:target-new:fingerprint-new")).toMatchObject({
      fileName: "轻量会话树",
      exchangeCount: 10,
      startTime: "2026-07-17T00:00:00.000Z",
      endTime: "2026-07-17T00:06:00.000Z",
      modelSet: ["gpt-new", "gpt-next"],
      targetSet: ["target-new"],
      agentTurnCount: 4,
    });
    expect(captures.some(item => item.id === "tree:off-page:fingerprint-off-page")).toBe(true);
    expect(existing).toMatchObject({
      agentFingerprintId: "fingerprint-new",
      source: "agent-session-header",
      externalSessionId: "external-new",
      externalThreadId: "thread-loaded",
      exchangeIds: ["exchange-loaded"],
      auxiliaryExchangeIds: ["aux-loaded"],
      startTime: "2026-07-17T00:00:00.000Z",
      endTime: "2026-07-17T00:05:00.000Z",
      modelSet: ["gpt-new"],
      targetSet: ["target-new"],
      confidence: "exact",
    });
    expect(existing?.evidence).toHaveLength(1);
    expect(created).toMatchObject({
      agentFingerprintId: "fingerprint-new",
      source: "manual",
      exchangeIds: [],
      auxiliaryExchangeIds: [],
      modelSet: ["gpt-new", "gpt-next"],
      targetSet: ["target-new"],
      confidence: "low",
      evidence: [],
    });
    expect(sessions.some(item => item.id === "session-off-page")).toBe(true);
  });

  test("拒绝结构无效的树摘要并稳定映射 Worker 状态", () => {
    expect(parseWorkbenchTreeRefresh({ agents: [], derivedStatus: "running" })).toBeUndefined();
    expect(parseWorkbenchTreeRefresh({
      agents: [],
      candidateCount: 0,
      processedCount: 0,
      limited: false,
      hasMore: false,
      dataVersion: 1,
      derivedStatus: "paused_disk",
    })?.derivedStatus).toBe("failed");
  });

  test("滚动刷新淘汰普通页外摘要并按硬上限保留受保护项", () => {
    const sessions = Array.from({ length: 200 }, (_, index) => ({
      id: `old-session-${index}`,
      agentFingerprintId: "old-fingerprint",
      source: "manual" as const,
      exchangeIds: [`old-exchange-${index}`],
      auxiliaryExchangeIds: [],
      startTime: "2026-07-16T00:00:00.000Z",
      endTime: "2026-07-16T00:01:00.000Z",
      modelSet: [],
      targetSet: ["old-target"],
      confidence: "low" as const,
      evidence: [],
    }));
    const refresh = sessions.slice(100, 110).map(item => ({
      ...item,
      agentFingerprintId: "new-fingerprint",
      endTime: "2026-07-17T00:01:00.000Z",
    }));

    const merged = mergeWorkbenchTreeSessions(sessions, refresh, {
      protectedIds: new Set(["old-session-2", "old-session-3"]),
      maxItems: 12,
    });

    expect(merged).toHaveLength(12);
    expect(merged.slice(0, 10).map(item => item.id)).toEqual(
      refresh.map(item => item.id),
    );
    expect(merged.some(item => item.id === "old-session-2")).toBe(true);
    expect(merged.some(item => item.id === "old-session-3")).toBe(true);
    expect(merged.some(item => item.id === "old-session-4")).toBe(false);
  });
});
