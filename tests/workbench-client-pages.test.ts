import { describe, expect, test } from "vitest";
import {
  mergeBoundedPage,
  parseThreadPage,
  parseTurnPage,
  retainRecentPages,
} from "../src/components/workbench/thread-tree";

const pageMeta = {
  candidateCount: 2,
  processedCount: 2,
  limited: false,
  hasMore: false,
  dataVersion: 1,
  derivedStatus: "idle",
} as const;

const root = {
  id: "thread-root",
  agentSessionId: "session-1",
  displayName: "主 Thread",
  isRoot: true,
  isPlaceholder: false,
  startTime: "2026-07-17T00:00:00.000Z",
  endTime: "2026-07-17T00:00:01.000Z",
  requestCount: 1,
  turnCount: 1,
  childCount: 0,
  children: [],
};

describe("工作台客户端有界分页", () => {
  test("严格解析 Thread 与 Turn 分页", () => {
    expect(parseThreadPage({ ...pageMeta, items: [root] })?.items[0]?.id)
      .toBe("thread-root");
    expect(parseTurnPage({
      ...pageMeta,
      items: [{
        id: "turn-1",
        agentSessionId: "session-1",
        agentThreadId: "thread-root",
        startTime: root.startTime,
        endTime: root.endTime,
        stepCount: 1,
        auxiliaryRequestCount: 0,
      }],
    })?.items[0]?.id).toBe("turn-1");
    expect(parseThreadPage({ ...pageMeta, items: [{ ...root, childCount: -1 }] }))
      .toBeUndefined();
  });

  test("cursor 加载更多只追加当前页并按 ID 去重", () => {
    const first = parseThreadPage({
      ...pageMeta,
      items: [root],
      hasMore: true,
      limited: true,
      nextCursor: "cursor-1",
    })!;
    const next = parseThreadPage({
      ...pageMeta,
      items: [{ ...root, displayName: "更新" }, { ...root, id: "thread-2" }],
    })!;

    const merged = mergeBoundedPage(first, next);
    expect(merged.items.map(item => item.id)).toEqual(["thread-root", "thread-2"]);
    expect(merged.items[0]?.displayName).toBe("更新");
  });

  test("运行时页缓存最多保留最近 8 项和当前保护项", () => {
    const cache = new Map(Array.from({ length: 9 }, (_, index) => [
      `turn-${index}`,
      { value: index },
    ]));
    const retained = retainRecentPages(cache, "turn-0", 8);

    expect(retained.size).toBe(8);
    expect(retained.has("turn-0")).toBe(true);
    expect(retained.has("turn-1")).toBe(false);
  });
});
