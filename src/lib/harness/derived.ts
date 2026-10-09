import { deriveAgentArtifacts } from "./agent";
import { diffContextSnapshots } from "./context-snapshot";
import type { AgentTurn, AgentSession, AgentStep, AuxiliaryExchange } from "./agent";
import type { ObservedContextSnapshot, StepDiff } from "./context-snapshot";
import type { Confidence, EvidencePointer, RawCapturedExchange } from "./types";

export interface HarnessLearningObservation {
  kind:
    | "tool_loop"
    | "context_diff"
    | "context_trimming"
    | "remote_state"
    | "tool_schema"
    | "stream_diagnostic"
    | "error"
    | "final_answer";
  title: string;
  detail: string;
  confidence: Confidence;
  evidence: EvidencePointer[];
}

export interface HarnessLearningInsight {
  turnId: string;
  agentSessionId: string;
  summary: string;
  harnessPattern:
    | "tool_loop_then_final"
    | "tool_only"
    | "direct_completion"
    | "incomplete_or_error"
    | "auxiliary_only"
    | "unknown";
  confidence: Confidence;
  observations: HarnessLearningObservation[];
  copyableTemplate: string;
  evidence: EvidencePointer[];
}

export interface HarnessDerivedDataset {
  agentSessions: AgentSession[];
  agentTurns: AgentTurn[];
  steps: AgentStep[];
  contextSnapshots: ObservedContextSnapshot[];
  stepDiffs: StepDiff[];
  auxiliaryExchanges: AuxiliaryExchange[];
  learningInsights: HarnessLearningInsight[];
}

export function deriveHarnessDataset(exchanges: RawCapturedExchange[]): HarnessDerivedDataset {
  const artifacts = deriveAgentArtifacts(exchanges);
  const snapshotsByStepId = new Map(artifacts.contextSnapshots.map(snapshot => [snapshot.stepId, snapshot]));
  const stepDiffs: StepDiff[] = [];

  for (const turn of artifacts.agentTurns) {
    const steps = artifacts.steps
      .filter(step => step.turnId === turn.id)
      .sort((a, b) => a.index - b.index);
    let previous: ObservedContextSnapshot | undefined;
    for (const step of steps) {
      const current = snapshotsByStepId.get(step.id);
      if (!current) continue;
      stepDiffs.push(diffContextSnapshots(previous, current));
      previous = current;
    }
  }

  const dataset = {
    ...artifacts,
    stepDiffs,
  };
  enrichStepIntentLabels(dataset.steps, stepDiffs, exchanges);
  return {
    ...dataset,
    learningInsights: deriveHarnessLearningInsights(dataset),
  };
}

/**
 * 基于跨步骤信息增强 AgentStep 的意图标签：
 * - 上下文压缩：相邻快照 Diff 中存在被移除的消息/工具结果/推理项时标记 contextCompressed，
 *   且当本步没有新增工具结果回填时把请求意图直接标为“上下文压缩”；
 * - 重试：同一 session 内与上一条 model call 请求体完全一致（工具循环中每次请求都会追加内容，
 *   相同请求体即重发）。按 session 而非 turn 分组判重试，因为重试可能跨 turn 边界
 *   （例如首轮请求失败后客户端重发同一请求体，会被切分到不同 turn）。
 * 该函数直接原地修改传入的 step 对象。
 */
/** 判断两次请求是否为同一请求体的重发：优先比较已解析请求体内容，回退到 rawBody 哈希 */
function sameRequestBody(current: RawCapturedExchange, prior: RawCapturedExchange): boolean {
  if (current.request.parsedBody !== undefined && prior.request.parsedBody !== undefined) {
    return JSON.stringify(current.request.parsedBody) === JSON.stringify(prior.request.parsedBody);
  }
  return current.request.bodySha256 === prior.request.bodySha256;
}

export function enrichStepIntentLabels(
  steps: AgentStep[],
  diffs: StepDiff[],
  exchanges: RawCapturedExchange[]
): void {
  const exchangeById = new Map(exchanges.map(exchange => [exchange.exchangeId, exchange]));
  const diffByToStepId = new Map(diffs.map(diff => [diff.toStepId, diff]));
  // 按 session 分组判重试：重试是"同一 session 内相同请求体重发"，与 turn 切分边界无关。
  // index 是 per-turn 的，跨 turn 排序用 timestamp 为主键、index 为次键。
  const stepsBySessionId = new Map<string, AgentStep[]>();
  for (const step of steps) {
    const list = stepsBySessionId.get(step.agentSessionId);
    if (list) list.push(step);
    else stepsBySessionId.set(step.agentSessionId, [step]);
  }
  for (const sessionSteps of stepsBySessionId.values()) {
    sessionSteps.sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.index - b.index);
    let previous: AgentStep | undefined;
    for (const step of sessionSteps) {
      const diff = diffByToStepId.get(step.id);
      if (diff && diff.contextTrimming.length > 0) {
        step.contextCompressed = true;
        const onlyRemoved = diff.addedToolResults.length === 0
          && diff.addedMessages.length === 0
          && step.requestAction !== "tool_result";
        if (onlyRemoved) step.requestIntentLabel = "上下文压缩";
      }
      if (previous) {
        const current = exchangeById.get(step.exchangeId);
        const prior = exchangeById.get(previous.exchangeId);
        if (current && prior && sameRequestBody(current, prior)) {
          step.requestIntentLabel = "重试";
        }
      }
      previous = step;
    }
  }
}

export function deriveHarnessLearningInsights(
  dataset: Omit<HarnessDerivedDataset, "learningInsights"> | HarnessDerivedDataset
): HarnessLearningInsight[] {
  return dataset.agentTurns.map(turn => learningInsightForTurn(dataset, turn));
}

function learningInsightForTurn(
  dataset: Omit<HarnessDerivedDataset, "learningInsights"> | HarnessDerivedDataset,
  turn: AgentTurn
): HarnessLearningInsight {
  const steps = dataset.steps
    .filter(step => step.turnId === turn.id)
    .sort((a, b) => a.index - b.index);
  const diffs = dataset.stepDiffs.filter(diff => steps.some(step => step.id === diff.toStepId));
  const observations = [
    ...toolLoopObservations(steps),
    ...contextDiffObservations(diffs),
    ...streamAndErrorObservations(steps),
    ...finalAnswerObservations(steps),
  ];
  const harnessPattern = inferPattern(steps);
  const evidence = uniqueEvidence(observations.flatMap(item => item.evidence));
  return {
    turnId: turn.id,
    agentSessionId: turn.agentSessionId,
    summary: summarizePattern(harnessPattern, steps, observations),
    harnessPattern,
    confidence: confidenceForPattern(harnessPattern, observations),
    observations,
    copyableTemplate: buildCopyableTemplate(harnessPattern, steps),
    evidence,
  };
}

function toolLoopObservations(steps: AgentStep[]): HarnessLearningObservation[] {
  const firstToolRequest = steps.find(step => step.responseAction === "tool_use");
  const firstToolResult = steps.find(step => step.requestAction === "tool_result");
  if (!firstToolRequest && !firstToolResult) return [];
  const names = [...new Set(steps.flatMap(step => step.toolUseNames).filter(Boolean))];
  const evidence = steps
    .filter(step => step.responseAction === "tool_use" || step.requestAction === "tool_result")
    .map(step => ({ exchangeId: step.exchangeId, side: "response" as const, path: "$" }));
  return [{
    kind: "tool_loop",
    title: "工具循环",
    detail: `检测到 ${steps.filter(step => step.responseAction === "tool_use").length} 次模型请求工具和 ${steps.filter(step => step.requestAction === "tool_result").length} 次工具结果回填。${names.length ? `工具：${names.join(", ")}。` : ""}`,
    confidence: firstToolRequest && firstToolResult ? "high" : "medium",
    evidence,
  }];
}

function contextDiffObservations(diffs: StepDiff[]): HarnessLearningObservation[] {
  const observations: HarnessLearningObservation[] = [];
  const changedDiffs = diffs.filter(diff =>
    diff.addedMessages.length > 0
      || diff.removedMessages.length > 0
      || diff.addedToolResults.length > 0
      || diff.removedToolResults.length > 0
      || diff.changedParams.length > 0
      || diff.changedTools.added.length > 0
      || diff.changedTools.removed.length > 0
  );
  if (changedDiffs.length > 0) {
    observations.push({
      kind: "context_diff",
      title: "上下文差异",
      detail: `检测到 ${changedDiffs.length} 个 step 存在上下文、工具结果、参数或工具 schema 变化。`,
      confidence: "high",
      evidence: uniqueEvidence(changedDiffs.flatMap(diff => diff.evidence)),
    });
  }

  const trimming = diffs.flatMap(diff => diff.contextTrimming);
  const remoteState = trimming.filter(item => item.kind === "remote_state_reference");
  if (remoteState.length > 0) {
    observations.push({
      kind: "remote_state",
      title: "远端上下文续接",
      detail: `检测到 ${remoteState.length} 个 previous_response_id、conversation 或 thread 远端状态引用，说明完整上下文不完全在本地请求体中。`,
      confidence: "exact",
      evidence: uniqueEvidence(remoteState.flatMap(item => item.evidence)),
    });
  }
  const localTrimming = trimming.filter(item => item.kind !== "remote_state_reference");
  if (localTrimming.length > 0) {
    observations.push({
      kind: "context_trimming",
      title: "上下文裁剪",
      detail: `检测到 ${localTrimming.length} 个消息、reasoning 或 tool result 被移出后续上下文的候选。`,
      confidence: localTrimming.some(item => item.confidence === "high" || item.confidence === "exact") ? "high" : "medium",
      evidence: uniqueEvidence(localTrimming.flatMap(item => item.evidence)),
    });
  }
  return observations;
}

function streamAndErrorObservations(steps: AgentStep[]): HarnessLearningObservation[] {
  return steps
    .filter(step => step.responseAction === "error" || step.responseAction === "incomplete")
    .map(step => ({
      kind: step.responseAction === "error" ? "error" : "stream_diagnostic",
      title: step.responseAction === "error" ? "错误响应" : "流式中断",
      detail: `步骤 ${step.index} 的响应状态为 ${step.responseAction}${step.streamStatus ? `，stream=${step.streamStatus}` : ""}。`,
      confidence: "high",
      evidence: [{ exchangeId: step.exchangeId, side: "response" as const, path: "$" }],
    }));
}

function finalAnswerObservations(steps: AgentStep[]): HarnessLearningObservation[] {
  const finalStep = steps.find(step => step.responseAction === "final");
  if (!finalStep) return [];
  return [{
    kind: "final_answer",
    title: "最终回答",
    detail: `步骤 ${finalStep.index} 产出最终文本或非工具调用响应。`,
    confidence: "high",
    evidence: [{ exchangeId: finalStep.exchangeId, side: "response", path: "$" }],
  }];
}

function inferPattern(steps: AgentStep[]): HarnessLearningInsight["harnessPattern"] {
  if (steps.length === 0) return "auxiliary_only";
  if (steps.some(step => step.responseAction === "error" || step.responseAction === "incomplete")) return "incomplete_or_error";
  const hasToolUse = steps.some(step => step.responseAction === "tool_use");
  const hasToolResult = steps.some(step => step.requestAction === "tool_result");
  const hasFinal = steps.some(step => step.responseAction === "final");
  if (hasToolUse && hasToolResult && hasFinal) return "tool_loop_then_final";
  if (hasToolUse || hasToolResult) return "tool_only";
  if (hasFinal) return "direct_completion";
  return "unknown";
}

function summarizePattern(
  pattern: HarnessLearningInsight["harnessPattern"],
  steps: AgentStep[],
  observations: HarnessLearningObservation[]
): string {
  const toolLoop = observations.find(item => item.kind === "tool_loop");
  if (pattern === "tool_loop_then_final") {
    return `该 Agent Turn 呈现“模型请求工具 -> 工具结果回填 -> 最终回答”的工具循环模式，共 ${steps.length} 个模型调用。${toolLoop?.detail || ""}`;
  }
  if (pattern === "tool_only") return `该 Agent Turn 主要体现工具调用或工具结果回填，共 ${steps.length} 个模型调用。`;
  if (pattern === "direct_completion") return `该 Agent Turn 未观察到工具循环，整体接近直接补全/回答模式，共 ${steps.length} 个模型调用。`;
  if (pattern === "incomplete_or_error") return `该 Agent Turn 存在错误或流式中断，应先查看诊断再学习 harness 行为。`;
  if (pattern === "auxiliary_only") return "该 Agent Turn 只有辅助请求，未形成模型调用步骤。";
  return "该 Agent Turn 暂未识别出稳定 harness 模式。";
}

function confidenceForPattern(
  pattern: HarnessLearningInsight["harnessPattern"],
  observations: HarnessLearningObservation[]
): Confidence {
  if (pattern === "unknown") return "low";
  if (pattern === "auxiliary_only") return "medium";
  return observations.some(item => item.confidence === "exact" || item.confidence === "high") ? "high" : "medium";
}

function buildCopyableTemplate(pattern: HarnessLearningInsight["harnessPattern"], steps: AgentStep[]): string {
  const toolNames = [...new Set(steps.flatMap(step => step.toolUseNames).filter(Boolean))];
  if (pattern === "tool_loop_then_final" || pattern === "tool_only") {
    return [
      "build_context(system, conversation, tools)",
      "while model_response.requests_tool:",
      `  execute_tool(${toolNames.length ? toolNames.join(" | ") : "tool_name"}, model_response.tool_input)`,
      "  append_tool_result(tool_use_id, tool_output)",
      "  model_response = call_model(updated_context)",
      "return final_answer",
    ].join("\n");
  }
  if (pattern === "direct_completion") {
    return [
      "build_context(system, conversation)",
      "model_response = call_model(context)",
      "return final_answer",
    ].join("\n");
  }
  return [
    "inspect_raw_evidence(exchange)",
    "classify_protocol(exchange)",
    "derive_next_step_when_more_evidence_is_available()",
  ].join("\n");
}

function uniqueEvidence(evidence: EvidencePointer[]): EvidencePointer[] {
  const seen = new Set<string>();
  const result: EvidencePointer[] = [];
  for (const item of evidence) {
    const key = `${item.exchangeId}:${item.side}:${item.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}
