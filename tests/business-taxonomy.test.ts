import { describe, expect, test } from "vitest";
import { existsSync, readFileSync } from "fs";

describe("业务层级命名规则", () => {
  test("对外 API 使用 Session/Thread/Turn/Step，不再暴露旧 Run 路由", () => {
    expect(existsSync("src/app/api/agent-sessions/[agentSessionId]/threads/route.ts")).toBe(true);
    expect(existsSync("src/app/api/agent-threads/[threadId]/turns/route.ts")).toBe(true);
    expect(existsSync("src/app/api/agent-turns/route.ts")).toBe(true);
    expect(existsSync("src/app/api/agent-turns/[turnId]/route.ts")).toBe(true);
    expect(existsSync("src/app/api/agent-turns/[turnId]/steps/route.ts")).toBe(true);
    expect(existsSync("src/app/api/agent-turns/[turnId]/workbench-detail/route.ts")).toBe(true);
    expect(existsSync("src/app/api/agent-turns/[turnId]/auxiliary-exchanges/route.ts")).toBe(true);
    expect(existsSync("src/app/api/agent-runs")).toBe(false);

    const workbench = readFileSync("src/components/harness-workbench.tsx", "utf-8");
    expect(workbench).toContain("/api/agent-threads/");
    expect(workbench).toContain("turnStepsPageRequestUrl");
    expect(workbench).not.toContain("/api/agent-runs/");
    expect(workbench).toContain("Turn");
    for (const oldRunIdentifier of [
      "AgentRun",
      "agentRuns",
      "selectedRunId",
      "run-row",
      "run-summary",
      "tree-run",
      "runItem",
      "runKey",
      "loadRun",
    ]) {
      expect(workbench).not.toContain(oldRunIdentifier);
    }
  });

  test("派生物化 schema 使用 turnId/turns/turnCount", () => {
    // 旧内存派生管线（src/lib/derivation）已删除（2026-09-14 用户确认）；
    // 命名守护对象改为现行 SQLite 派生管线与业务查询层。
    const agent = readFileSync("src/lib/harness/agent.ts", "utf-8");
    const processor = readFileSync("src/lib/ingestion/exchange-processor.ts", "utf-8");
    const workbench = readFileSync("src/lib/db/workbench-queries.ts", "utf-8");

    for (const source of [agent, processor, workbench]) {
      expect(source).toMatch(/[Tt]urnId/);
      expect(source).not.toContain("runId");
      expect(source).not.toContain("agentRunId");
      expect(source).not.toContain(".runs");
      expect(source).not.toContain("runs:");
      expect(source).not.toContain('kind: "run"');
      expect(source).not.toContain('kind === "run"');
    }

    expect(processor).toContain("agent_turns");
    expect(processor).toContain("turn_count");
    expect(workbench).toContain("agent_turns");
  });

  test("Token 价格页面使用 Turn 维度筛选与展示", () => {
    const component = readFileSync("src/components/token-pricing-content.tsx", "utf-8");
    const loader = readFileSync("src/lib/token-pricing.ts", "utf-8");
    const pricing = readFileSync("src/lib/pricing.ts", "utf-8");

    expect(component).toContain("Turn");
    expect(component).not.toContain("Run");
    expect(loader).toContain("turnId");
    expect(loader).not.toContain("filters.run");
    expect(pricing).toContain("byTurn");
    expect(pricing).not.toContain("runAgg");
  });

  test("提示词中心已废弃，不再暴露独立组件、API 和导出工具", () => {
    expect(existsSync("src/components/prompt-library.tsx")).toBe(false);
    expect(existsSync("src/app/api/prompts")).toBe(false);
    expect(existsSync("src/lib/prompt-export.ts")).toBe(false);

    const appState = readFileSync("src/lib/app-state.ts", "utf-8");
    expect(appState).not.toContain("loadPromptLibrary");
    expect(appState).not.toContain("PromptLibrary");
  });
});
