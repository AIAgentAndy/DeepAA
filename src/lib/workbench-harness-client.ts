/**
 * Harness 证据层客户端：Step Harness API 的拉取与响应校验。
 * 响应形态见 src/lib/harness/harness-step.ts（ApiAgentStepHarness）。
 */

import type { ApiAgentStepHarness } from "./harness/harness-step";

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return !!value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function harnessItemArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(objectRecord).filter((item): item is Record<string, unknown> => !!item) : [];
}

/** 宽松校验：核心数组缺失时返回 undefined，不允许半截数据进入渲染层。 */
export function parseAgentStepHarness(value: unknown): ApiAgentStepHarness | undefined {
  const record = objectRecord(value);
  if (!record || typeof record.stepId !== "string") return undefined;
  const inventory = objectRecord(record.inventory);
  if (!inventory) return undefined;
  const snapshotRecord = objectRecord(record.snapshot);
  const tokensRecord = objectRecord(record.harnessTokens);
  const changesRecord = objectRecord(record.changes);
  const compactionRecord = objectRecord(record.compaction);
  const tokensComponent = objectRecord(tokensRecord?.byComponent);
  return {
    stepId: record.stepId,
    exchangeId: typeof record.exchangeId === "string" ? record.exchangeId : "",
    stepIndex: typeof record.stepIndex === "number" ? record.stepIndex : 0,
    project: typeof record.project === "string" ? record.project : undefined,
    snapshot: snapshotRecord
      ? (() => {
        const coverage = objectRecord(snapshotRecord.coverage) ?? {};
        return {
          hash: typeof snapshotRecord.hash === "string" ? snapshotRecord.hash : "",
          shortHash: typeof snapshotRecord.shortHash === "string" ? snapshotRecord.shortHash : "",
          agentName: typeof snapshotRecord.agentName === "string" ? snapshotRecord.agentName : "",
          complete: snapshotRecord.complete === true,
          seqInThread: typeof snapshotRecord.seqInThread === "number" ? snapshotRecord.seqInThread : 1,
          coverage: {
            fromStepIndex: typeof coverage.fromStepIndex === "number" ? coverage.fromStepIndex : 0,
            toStepIndex: typeof coverage.toStepIndex === "number" ? coverage.toStepIndex : 0,
          },
          firstSeenStepIndex: typeof snapshotRecord.firstSeenStepIndex === "number"
            ? snapshotRecord.firstSeenStepIndex
            : 0,
        };
      })()
      : undefined,
    inventory: {
      tools: harnessItemArray(inventory.tools) as unknown as ApiAgentStepHarness["inventory"]["tools"],
      skills: harnessItemArray(inventory.skills) as unknown as ApiAgentStepHarness["inventory"]["skills"],
      rules: harnessItemArray(inventory.rules) as unknown as ApiAgentStepHarness["inventory"]["rules"],
    },
    harnessTokens: tokensRecord && tokensComponent
      ? {
        byComponent: {
          toolsNonMcp: Number(tokensComponent.toolsNonMcp ?? 0),
          mcp: Number(tokensComponent.mcp ?? 0),
          skills: Number(tokensComponent.skills ?? 0),
          rules: Number(tokensComponent.rules ?? 0),
        },
        total: Number(tokensRecord.total ?? 0),
        shareOfInput: typeof tokensRecord.shareOfInput === "number" ? tokensRecord.shareOfInput : undefined,
        calibrated: tokensRecord.calibrated === true,
        inputTokens: typeof tokensRecord.inputTokens === "number" ? tokensRecord.inputTokens : undefined,
      }
      : undefined,
    changes: changesRecord
      ? {
        fromSnapshotHash: typeof changesRecord.fromSnapshotHash === "string" ? changesRecord.fromSnapshotHash : undefined,
        fromStepIndex: typeof changesRecord.fromStepIndex === "number" ? changesRecord.fromStepIndex : undefined,
        toolsAdded: stringArray(changesRecord.toolsAdded),
        toolsRemoved: stringArray(changesRecord.toolsRemoved),
        skillsAdded: stringArray(changesRecord.skillsAdded),
        skillsRemoved: stringArray(changesRecord.skillsRemoved),
        rulesAdded: stringArray(changesRecord.rulesAdded),
        rulesRemoved: stringArray(changesRecord.rulesRemoved),
      }
      : undefined,
    compaction: compactionRecord
      ? {
        kind: compactionRecord.kind === "detected" ? "detected" : "possible",
        before: Number(compactionRecord.before ?? 0),
        after: Number(compactionRecord.after ?? 0),
        reductionPct: Number(compactionRecord.reductionPct ?? 0),
        messageRemoved: Number(compactionRecord.messageRemoved ?? 0),
        toolResultRemoved: Number(compactionRecord.toolResultRemoved ?? 0),
        compactionEvidence: Number(compactionRecord.compactionEvidence ?? 0),
        contextCompressed: compactionRecord.contextCompressed === true,
      }
      : undefined,
    legacyData: record.legacyData === true,
    candidateCount: typeof record.candidateCount === "number" ? record.candidateCount : 1,
    processedCount: typeof record.processedCount === "number" ? record.processedCount : 1,
    limited: record.limited === true,
  };
}

export async function fetchOptionalStepHarness(
  stepId: string,
  signal?: AbortSignal,
): Promise<ApiAgentStepHarness | undefined> {
  const response = await fetch(
    `/api/agent-steps/${encodeURIComponent(stepId)}/harness`,
    { cache: "no-store", signal },
  );
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return parseAgentStepHarness(await response.json());
}
