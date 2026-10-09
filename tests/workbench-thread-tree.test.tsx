import { describe, expect, test, vi } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import {
  compactHierarchicalId,
  compactHierarchicalIds,
  ThreadTree,
  toggleExpandedId,
} from "../src/components/workbench/thread-tree";
import type { WorkbenchThreadNode } from "../src/lib/db/workbench-queries";

function thread(
  id: string,
  parentAgentThreadId?: string,
  children: WorkbenchThreadNode[] = [],
): WorkbenchThreadNode {
  return {
    id,
    agentSessionId: "session-1",
    parentAgentThreadId,
    externalThreadId: `external-${id}`,
    displayName: id,
    isRoot: !parentAgentThreadId,
    isPlaceholder: false,
    startTime: "2026-07-17T00:00:00.000Z",
    endTime: "2026-07-17T00:00:01.000Z",
    requestCount: 1,
    turnCount: 0,
    childCount: children.length,
    children,
  };
}

function elementChildren(node: ReactNode): ReactElement[] {
  if (Array.isArray(node)) return node.flatMap(elementChildren);
  if (!isValidElement(node)) return [];
  const element = node as ReactElement<{ children?: ReactNode }>;
  if (typeof element.type === "function") {
    return elementChildren(element.type(element.props));
  }
  return [element, ...elementChildren(element.props.children)];
}

describe("ThreadTree", () => {
  test("递归渲染三层 Thread 并限制视觉缩进", () => {
    const grandchild = thread("019f65af-grandchild-f901fa", "thread-child");
    const child = thread("thread-child", "thread-root", [grandchild]);
    const root = thread("thread-root", undefined, [child]);
    const view = ThreadTree({
      roots: [root],
      expandedIds: new Set([root.id, child.id]),
      onToggle: () => undefined,
      onSelectThread: () => undefined,
      onSelectTurn: () => undefined,
      onLoadMore: () => undefined,
    });
    const elements = elementChildren(view);

    expect(elements.filter(item => item.props["data-thread-depth"] !== undefined)
      .map(item => item.props["data-thread-depth"])).toEqual([0, 1, 2]);
    expect(elements.some(item => item.props["data-visual-depth"] === 2)).toBe(true);
    expect(compactHierarchicalId(grandchild.id)).toBe("019f65af…f901fa");
  });

  test("chevron 阻止行选择且任意展开节点都能折叠", () => {
    const root = thread("thread-root");
    const onToggle = vi.fn(() => undefined);
    const onSelectThread = vi.fn(() => undefined);
    const view = ThreadTree({
      roots: [root],
      expandedIds: new Set([root.id]),
      selectedThreadId: root.id,
      onToggle,
      onSelectThread,
      onSelectTurn: () => undefined,
      onLoadMore: () => undefined,
    });
    const elements = elementChildren(view);
    const chevron = elements.find(item => item.type === "button"
      && item.props["data-thread-chevron"] === root.id);
    const stopPropagation = vi.fn(() => undefined);

    expect(chevron).toBeDefined();
    expect(chevron?.props.disabled).toBe(false);
    chevron?.props.onClick({ stopPropagation });
    expect(stopPropagation).toHaveBeenCalledTimes(1);
    expect(onToggle).toHaveBeenCalledWith(root.id);
    expect(onSelectThread).not.toHaveBeenCalled();
    expect(toggleExpandedId(new Set([root.id]), root.id)).toEqual(new Set());
  });

  test("折叠不清除选择，重新展开仍恢复原路径", () => {
    const selectedThreadId = "thread-child";
    const first = toggleExpandedId(new Set(["thread-root", selectedThreadId]), "thread-root");
    const second = toggleExpandedId(first, "thread-root");

    expect(selectedThreadId).toBe("thread-child");
    expect(first).toEqual(new Set([selectedThreadId]));
    expect(second).toEqual(new Set([selectedThreadId, "thread-root"]));
  });

  test("当前页 ID 截断碰撞时自动扩展后缀", () => {
    const first = "019f65af-aaaaaaaa-Axxf901fa";
    const second = "019f65af-bbbbbbbb-Bxxf901fa";
    const labels = compactHierarchicalIds([first, second]);

    expect(labels.get(first)).not.toBe(labels.get(second));
    expect(labels.get(first)).toMatch(/^019f65af…/);
    expect(labels.get(second)).toMatch(/^019f65af…/);
  });

  test("Thread 与 Turn 区分祖先路径和当前统计范围", () => {
    const turn = {
      id: "turn-selected",
      agentSessionId: "session-1",
      agentThreadId: "thread-child",
      startTime: "2026-07-17T00:00:00.000Z",
      endTime: "2026-07-17T00:00:02.000Z",
      stepCount: 1,
      auxiliaryRequestCount: 0,
    };
    const child = {
      ...thread("thread-child", "thread-root"),
      turnCount: 1,
      turnPage: {
        items: [turn],
        candidateCount: 1,
        processedCount: 1,
        limited: false,
        hasMore: false,
        dataVersion: 1,
        derivedStatus: "idle" as const,
      },
    };
    const root = thread("thread-root", undefined, [child]);
    const stepView = ThreadTree({
      roots: [root],
      expandedIds: new Set([root.id, child.id]),
      activeThreadPathIds: new Set([root.id, child.id]),
      selectedThreadId: child.id,
      selectedTurnId: turn.id,
      selectedScopeType: "step",
      onToggle: () => undefined,
      onSelectThread: () => undefined,
      onSelectTurn: () => undefined,
      onLoadMore: () => undefined,
    });
    const stepElements = elementChildren(stepView);
    const threadRows = stepElements.filter(item => (
      typeof item.props.className === "string"
      && item.props.className.includes("tree-thread")
    ));
    const turnRow = stepElements.find(item => (
      typeof item.props.className === "string"
      && item.props.className.includes("tree-turn")
    ));

    expect(threadRows.every(item => item.props.className.includes("path-ancestor"))).toBe(true);
    // step 视图下高亮所属 Turn 行，而不是让整条路径都没有真正选中行。
    expect(turnRow?.props.className).toContain("selected-scope");
    expect(turnRow?.props.className).not.toContain("path-ancestor");
    expect(turnRow?.props["aria-current"]).toBe("true");
    const updateTimes = stepElements
      .filter(item => item.type === "time")
      .map(item => item.props.dateTime);
    expect(updateTimes).toContain(child.endTime);
    expect(updateTimes).toContain(turn.endTime);

    const turnView = ThreadTree({
      roots: [root],
      expandedIds: new Set([root.id, child.id]),
      activeThreadPathIds: new Set([root.id, child.id]),
      selectedThreadId: child.id,
      selectedTurnId: turn.id,
      selectedScopeType: "turn",
      onToggle: () => undefined,
      onSelectThread: () => undefined,
      onSelectTurn: () => undefined,
      onLoadMore: () => undefined,
    });
    const currentTurn = elementChildren(turnView).find(item => (
      typeof item.props.className === "string"
      && item.props.className.includes("tree-turn")
    ));
    expect(currentTurn?.props.className).toContain("selected-scope");
    expect(currentTurn?.props["aria-current"]).toBe("true");
  });
});
