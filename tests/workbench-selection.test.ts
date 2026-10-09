import { describe, expect, test } from "vitest";
import {
  canonicalWorkbenchParams,
  chooseSelectionPath,
  findSelectedAgentGroup,
  parseWorkbenchTreePage,
  parseWorkbenchSelectionResponse,
  refreshWorkbenchTreePage,
  resolveSelectionRestoreOutcome,
  resolvedWorkbenchView,
  selectionAtView,
  type WorkbenchClientSelection,
} from "../src/components/workbench/use-workbench-selection";
import type { WorkbenchTreePage } from "../src/lib/db/workbench-queries";

const completePath = {
  target: "catapi.chat",
  agent: "codex",
  session: "session-1",
  thread: "thread-child",
  turn: "turn-1",
  step: "astep-1",
  ancestorThreadIds: ["thread-root"],
};

describe("工作台六级选择", () => {
  test("无业务参数使用 latestPath，有业务参数使用 resolvedPath", () => {
    const payload = parseWorkbenchSelectionResponse({
      latestPath: completePath,
      resolvedPath: { ...completePath, thread: "thread-resolved" },
      dataVersion: 3,
      derivedStatus: "idle",
    });

    expect(payload).toBeDefined();
    expect(chooseSelectionPath(payload!, false)?.thread).toBe("thread-child");
    expect(chooseSelectionPath(payload!, true)?.thread).toBe("thread-resolved");
  });

  test("SQLite 尚无派生会话时把缺少路径视为空状态而不是错误", () => {
    const payload = parseWorkbenchSelectionResponse({
      dataVersion: 0,
      derivedStatus: "idle",
    });

    expect(payload).toBeDefined();
    expect(resolveSelectionRestoreOutcome(payload!, false)).toEqual({ kind: "empty" });
    expect(resolveSelectionRestoreOutcome(payload!, true)).toEqual({ kind: "empty" });
  });

  test("存在可恢复路径时返回路径结果", () => {
    const payload = parseWorkbenchSelectionResponse({
      latestPath: completePath,
      dataVersion: 1,
      derivedStatus: "idle",
    });

    expect(resolveSelectionRestoreOutcome(payload!, false)).toEqual({
      kind: "path",
      path: completePath,
    });
  });

  test("按当前层级写入 thread 并清理无效下级参数", () => {
    const selection: WorkbenchClientSelection = completePath;

    expect(canonicalWorkbenchParams(selection, "session").toString()).toBe(
      "target=catapi.chat&agent=codex&session=session-1&view=session",
    );
    expect(canonicalWorkbenchParams(selection, "thread").toString()).toBe(
      "target=catapi.chat&agent=codex&session=session-1&thread=thread-child&view=thread",
    );
    expect(canonicalWorkbenchParams(selection, "turn").toString()).toBe(
      "target=catapi.chat&agent=codex&session=session-1&thread=thread-child&turn=turn-1&step=astep-1&view=turn",
    );
  });

  test("无效响应拒绝解析以便调用方保留原选择", () => {
    expect(parseWorkbenchSelectionResponse({
      latestPath: completePath,
      resolvedPath: { ...completePath, ancestorThreadIds: "thread-root" },
      dataVersion: 3,
      derivedStatus: "idle",
    })).toBeUndefined();
  });

  test("树刷新严格校验 Session 摘要", () => {
    // 分组形状与服务端 loadWorkbenchTree 一致：Agent 维度分组，不含 target 字段
    // （2026-09-17 起 target 已不是 Session 分组维度）。
    const tree = {
      agents: [{
        agentFingerprintId: "fp-codex",
        agentName: "codex",
        sessions: [{
          id: "session-1",
          startTime: "2026-07-17T00:00:00.000Z",
          endTime: "2026-07-17T00:00:01.000Z",
          modelSet: ["gpt-5"],
          modelSetLimited: false,
          requestCount: 1,
          threadCount: 1,
        }],
      }],
      candidateCount: 1,
      processedCount: 1,
      limited: false,
      hasMore: false,
      dataVersion: 1,
      derivedStatus: "idle",
    };
    expect(parseWorkbenchTreePage(tree)?.agents[0]?.sessions[0]?.id)
      .toBe("session-1");
    expect(parseWorkbenchTreePage({
      ...tree,
      agents: [{ ...tree.agents[0], sessions: [{ ...tree.agents[0]!.sessions[0]!, threadCount: -1 }] }],
    })).toBeUndefined();
  });

  test("显式 Session 深链不被服务端补出的根 Thread 改变层级", () => {
    expect(resolvedWorkbenchView(
      new URLSearchParams("session=session-1"),
      completePath,
    )).toBe("session");
    expect(resolvedWorkbenchView(new URLSearchParams(), completePath)).toBe("turn");
  });

  test("选择状态按 view 清除服务端补出的下级路径", () => {
    expect(selectionAtView(completePath, "session")).toEqual({
      target: completePath.target,
      agent: completePath.agent,
      session: completePath.session,
    });
    expect(selectionAtView(completePath, "thread")).toEqual({
      target: completePath.target,
      agent: completePath.agent,
      session: completePath.session,
      thread: completePath.thread,
      ancestorThreadIds: completePath.ancestorThreadIds,
    });
  });

  test("Agent 组按 agentName 命中，selection 缺 target 不得失配", () => {
    // 回归（2026-09-19）：Agent 维度会话后树上点选构建的 selection 不携带 target，
    // 旧守卫要求 selection.target 导致 selectedSession 失配——概览「业务 Session」
    // 显示"-"、会话来源退回「内部派生」，直到手动刷新浏览器才恢复。
    const tree = {
      agents: [{
        agentFingerprintId: "fp-zcode",
        agentName: "zcode",
        sessions: [{
          id: "session-1",
          externalSessionId: "sess_native-1",
          startTime: "2026-09-19T00:00:00.000Z",
          endTime: "2026-09-19T00:01:00.000Z",
          modelSet: ["glm-5.3-flash"],
          modelSetLimited: false,
          requestCount: 3,
          threadCount: 1,
        }],
      }],
      candidateCount: 1,
      processedCount: 1,
      limited: false,
      hasMore: false,
      dataVersion: 1,
      derivedStatus: "idle",
    } as WorkbenchTreePage;
    const clickBuilt: WorkbenchClientSelection = {
      agent: "zcode",
      session: "session-1",
      thread: "thread-1",
      turn: "turn-1",
      step: "astep-1",
      ancestorThreadIds: [],
    };
    const group = findSelectedAgentGroup(tree, clickBuilt);
    expect(group?.agentName).toBe("zcode");
    // selectedSession 的取值路径：group.sessions 按 selection.session 命中。
    expect(group?.sessions.find(session => session.id === clickBuilt.session)?.externalSessionId)
      .toBe("sess_native-1");
    // 深链恢复的 selection（带 target）同样命中，二者行为一致。
    expect(findSelectedAgentGroup(tree, { ...clickBuilt, target: "bigmodel.cn" })?.agentName)
      .toBe("zcode");
    expect(findSelectedAgentGroup(tree, undefined)).toBeUndefined();
    expect(findSelectedAgentGroup(tree, { ...clickBuilt, agent: "codex" })).toBeUndefined();
  });

  test("自动刷新只保留最新页和当前受保护 Session", () => {
    const sessions = Array.from({ length: 120 }, (_, index) => ({
      id: `session-${index}`,
      startTime: "2026-07-17T00:00:00.000Z",
      endTime: "2026-07-17T00:01:00.000Z",
      modelSet: ["gpt-5"],
      modelSetLimited: false,
      requestCount: 1,
      threadCount: 1,
    }));
    const current: WorkbenchTreePage = {
      agents: [{
        targetId: "catapi.chat",
        targetName: "Cat API",
        agentFingerprintId: "fp-codex",
        agentName: "codex",
        sessions,
      }],
      candidateCount: 120,
      processedCount: 120,
      limited: false,
      hasMore: false,
      dataVersion: 1,
      derivedStatus: "idle",
    };
    const incoming: WorkbenchTreePage = {
      ...current,
      agents: [{ ...current.agents[0]!, sessions: sessions.slice(70) }],
      processedCount: 50,
      limited: true,
      hasMore: true,
      dataVersion: 2,
    };

    const refreshed = refreshWorkbenchTreePage(
      current,
      incoming,
      "session-0",
      51,
    );
    const result = refreshed.agents.flatMap(agent => agent.sessions);
    expect(result).toHaveLength(51);
    expect(result.some(session => session.id === "session-0")).toBe(true);
    expect(result.some(session => session.id === "session-1")).toBe(false);
  });

  test("自动刷新采用服务端最新顺序并把页外保护 Session 追加在末尾", () => {
    const session = (id: string, endTime: string) => ({
      id,
      startTime: "2026-07-17T00:00:00.000Z",
      endTime,
      modelSet: ["gpt-5"],
      modelSetLimited: false,
      requestCount: 1,
      threadCount: 1,
    });
    const current: WorkbenchTreePage = {
      agents: [{
        targetId: "catapi.chat",
        targetName: "Cat API",
        agentFingerprintId: "fp-codex",
        agentName: "codex",
        sessions: [
          session("session-protected", "2026-07-17T00:01:00.000Z"),
          session("session-updated", "2026-07-17T00:02:00.000Z"),
        ],
      }],
      candidateCount: 2,
      processedCount: 2,
      limited: false,
      hasMore: false,
      dataVersion: 1,
      derivedStatus: "idle",
    };
    const incoming: WorkbenchTreePage = {
      ...current,
      agents: [{
        ...current.agents[0]!,
        sessions: [
          session("session-newest", "2026-07-17T00:05:00.000Z"),
          session("session-updated", "2026-07-17T00:04:00.000Z"),
          session("session-older", "2026-07-17T00:03:00.000Z"),
        ],
      }],
      candidateCount: 4,
      processedCount: 3,
      limited: true,
      hasMore: true,
      dataVersion: 2,
    };

    const refreshed = refreshWorkbenchTreePage(
      current,
      incoming,
      "session-protected",
      4,
    );
    expect(refreshed.agents[0]?.sessions.map(item => item.id)).toEqual([
      "session-newest",
      "session-updated",
      "session-older",
      "session-protected",
    ]);
  });
});
