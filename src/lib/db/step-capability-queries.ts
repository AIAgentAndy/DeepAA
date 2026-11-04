/**
 * P1-2（2026-11-03）：Step 能力查询——summary 与分类 items 页的服务端组装。
 * 数据全部来自 loadAgentStepHarness 的可信投影（I1 起 declared/observed 分离），
 * 不新增第二套事实来源；items 内存分页仅在快照清单（≤64 KiB JSON、几百条级）
 * 上进行，candidateCount 如实返回全集数，分页不改变总数。
 */

import type {DeepaaDatabase} from "@/lib/db/sqlite-driver";
import type {ApiAgentStepHarness} from "../harness/harness-step";
import { loadAgentStepHarness } from "./harness-queries";
import {
  STEP_CAPABILITY_ITEMS_MAX_LIMIT,
  type StepCapabilityItem,
  type StepCapabilityItemsPage,
  type StepCapabilityItemsQuery,
  type StepCapabilitySummary,
} from "../agent-harness/contracts";

export function loadStepCapabilitySummary(
  db: DeepaaDatabase,
  stepId: string,
  dataDir?: string,
): StepCapabilitySummary | undefined {
  const harness = loadAgentStepHarness(db, stepId, dataDir);
  if (!harness) return undefined;
  return summarizeHarness(harness);
}

export function summarizeHarness(harness: ApiAgentStepHarness): StepCapabilitySummary {
  const declared = harness.inventory.tools;
  const observedOnly = harness.inventory.observedOnlyTools ?? [];
  const mcpServers = new Set(
    declared.filter(tool => tool.kind === "mcp" && tool.mcpServer).map(tool => tool.mcpServer),
  );
  const invokedDeclared = declared.filter(tool => tool.invoked);
  const summary: StepCapabilitySummary = {
    stepId: harness.stepId,
    exchangeId: harness.exchangeId,
    scope: "step",
    agentName: harness.snapshot?.agentName,
    agentVersion: harness.snapshot?.agentVersion,
    declaredToolCount: declared.length,
    mcpServerCount: mcpServers.size,
    skillCount: harness.inventory.skills.length,
    skillsParseStatus: harness.skillsParseStatus ?? "parsed",
    invokedToolKinds: invokedDeclared.length + observedOnly.length,
    invokedToolCalls:
      declared.reduce((sum, tool) => sum + tool.callsThisStep, 0)
      + observedOnly.reduce((sum, tool) => sum + tool.callsThisStep, 0),
    // §14.2.7 最小版：截至本步的回合累计调用（callsLimited.turn 时为下界）。
    turnInvokedCalls:
      declared.reduce((sum, tool) => sum + tool.callsThisTurn, 0)
      + observedOnly.reduce((sum, tool) => sum + tool.callsThisTurn, 0),
    notInvokedDeclaredCount: declared.length - invokedDeclared.length,
    observedOnlyCount: observedOnly.length,
    ...(harness.legacyData ? {legacyData: true} : {}),
    ...(harness.snapshot ? {} : {noSnapshot: true}),
    ...(harness.reference ? {reference: harness.reference} : {}),
    ...(harness.callsLimited ? {callsLimited: harness.callsLimited} : {}),
    ...(harness.snapshot ? {inputComplete: harness.snapshot.complete} : {}),
    candidateCount: 1,
    processedCount: 1,
    limited: harness.limited,
  };
  return summary;
}

export function loadStepCapabilityItems(
  db: DeepaaDatabase,
  stepId: string,
  query: StepCapabilityItemsQuery,
  dataDir?: string,
): StepCapabilityItemsPage | undefined {
  const harness = loadAgentStepHarness(db, stepId, dataDir);
  if (!harness) return undefined;
  return paginateItems(harness, query);
}

export function paginateItems(
  harness: ApiAgentStepHarness,
  query: StepCapabilityItemsQuery,
): StepCapabilityItemsPage {
  const limit = Math.max(1, Math.min(query.limit, STEP_CAPABILITY_ITEMS_MAX_LIMIT));
  const all = collectItems(harness, query.kind);
  // name keyset：稳定排序 + 游标（cursor = 上一页最后一条 name）。
  const sorted = [...all].sort((a, b) => a.name.localeCompare(b.name));
  const startIndex = query.cursor ? lowerBoundByName(sorted, query.cursor) : 0;
  const page = sorted.slice(startIndex, startIndex + limit);
  const hasMore = startIndex + limit < sorted.length;
  return {
    stepId: harness.stepId,
    kind: query.kind,
    items: page,
    candidateCount: sorted.length,
    processedCount: page.length,
    limited: false,
    hasMore,
    ...(hasMore && page.length > 0 ? {nextCursor: page[page.length - 1]!.name} : {}),
  };
}

function lowerBoundByName(sorted: StepCapabilityItem[], cursor: string): number {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (middle === sorted.length || sorted[middle]!.name > cursor) high = middle - 1;
    else low = middle;
  }
  // low = 最后一个 name <= cursor 的位置；下一页从其后开始。
  return low < sorted.length && sorted[low]!.name <= cursor ? low + 1 : low;
}

function collectItems(
  harness: ApiAgentStepHarness,
  kind: StepCapabilityItemsQuery["kind"],
): StepCapabilityItem[] {
  if (kind === "tools") {
    return harness.inventory.tools.map(tool => ({
      kind: "declared_tool" as const,
      name: tool.name,
      mcpServer: tool.mcpServer,
      invoked: tool.invoked,
      callsThisStep: tool.callsThisStep,
      callsThisTurn: tool.callsThisTurn,
      ...(tool.callsUnknown ? {callsUnknown: true} : {}),
      defTokensEst: tool.defTokensEst,
    }));
  }
  if (kind === "observed") {
    return (harness.inventory.observedOnlyTools ?? []).map(tool => ({
      kind: "observed_tool" as const,
      name: tool.name,
      mcpServer: tool.mcpServer,
      invoked: tool.invoked,
      callsThisStep: tool.callsThisStep,
      callsThisTurn: tool.callsThisTurn,
      defTokensEst: tool.defTokensEst,
    }));
  }
  if (kind === "skills") {
    return harness.inventory.skills.map(skill => ({
      kind: "skill" as const,
      name: skill.name,
      invoked: false,
      callsThisStep: 0,
      callsThisTurn: 0,
      defTokensEst: skill.estTokens,
      sourceLevel: skill.sourceLevel,
      ...(skill.pluginName ? {pluginName: skill.pluginName} : {}),
      estTokens: skill.estTokens,
    }));
  }
  // mcp：server 级聚合条目（叶子见 tools 分类）。
  const byServer = new Map<string, {tools: typeof harness.inventory.tools}>();
  for (const tool of harness.inventory.tools) {
    if (tool.kind !== "mcp") continue;
    const server = tool.mcpServer || "mcp";
    const bucket = byServer.get(server);
    if (bucket) bucket.tools.push(tool);
    else byServer.set(server, {tools: [tool]});
  }
  return [...byServer.entries()].map(([server, group]) => ({
    kind: "mcp_server" as const,
    name: server,
    invoked: group.tools.some(tool => tool.invoked),
    callsThisStep: group.tools.reduce((sum, tool) => sum + tool.callsThisStep, 0),
    callsThisTurn: group.tools.reduce((sum, tool) => sum + tool.callsThisTurn, 0),
    defTokensEst: group.tools.reduce((sum, tool) => sum + tool.defTokensEst, 0),
  }));
}
