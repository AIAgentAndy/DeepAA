/**
 * Harness 证据层：Step 级查询（docs/Harness能力建设一期.md §5）。
 * 全部主键/唯一键定位 + 小范围 keyset 聚合，禁止全量扫描；
 * 快照覆盖区间以同 Thread 内相同 harness_snapshot_hash 的 step_index 包络计算。
 */

import type {DeepaaDatabase} from "@/lib/db/sqlite-driver";
import type {
  ApiAgentStepHarness,
  HarnessChangesView,
  HarnessCompactionView,
  HarnessRuleItem,
  HarnessSkillItem,
  HarnessSnapshotView,
  HarnessToolItem,
  HarnessTokensView,
} from "../harness/harness-step";
import { classifyToolName } from "../harness/evidence";
import type { ContextComposition } from "../harness/context-composition";
import {
  parseSnapshotRules,
  parseSnapshotSkills,
  parseSnapshotTools,
} from "../ingestion/harness-snapshot-store";
import { resolveDerivedArtifactJson } from "../ingestion/derived-artifact-store";

interface SnapshotRow {
  snapshot_hash: string;
  agent_name: string;
  tool_count: number;
  complete: number;
  tools_json: string;
  skills_json: string;
  rules_json: string;
}

interface StepCoreRow {
  id: string;
  exchange_id: string;
  agent_thread_id: string;
  agent_turn_id: string;
  step_index: number;
  project_key: string | null;
  harness_snapshot_hash: string | null;
}

function shortHash(hash: string): string {
  return hash.slice(0, 8);
}

/** 与 exchange-processor / 回填一致的名称级身份指纹（不含 agent 名）。 */
function identityOfTools(tools: Array<{ name: string; kind: string; mcpServer?: string }>): string[] {
  return tools.map(tool => `${tool.name}|${tool.kind}|${tool.mcpServer ?? ""}`).sort();
}

function identityOfRules(rules: HarnessRuleItem[]): string[] {
  return rules.map(rule => `${rule.kind}|${rule.path ?? ""}`).sort();
}

function diffAddedRemoved(
  before: string[],
  after: string[],
): { added: string[]; removed: string[] } {
  const beforeKeys = new Set(before);
  const afterKeys = new Set(after);
  return {
    added: after.filter(key => !beforeKeys.has(key)),
    removed: before.filter(key => !afterKeys.has(key)),
  };
}

export function loadAgentStepHarness(
  db: DeepaaDatabase,
  stepId: string,
  dataDir?: string,
): ApiAgentStepHarness | undefined {
  const step = db.prepare(
    `SELECT id, exchange_id, agent_thread_id, agent_turn_id, step_index,
            project_key, harness_snapshot_hash
     FROM agent_steps WHERE id = ? LIMIT 1`,
  ).get(stepId) as StepCoreRow | undefined;
  if (!step) return undefined;

  // 本步每工具调用计数（Used 侧）。
  const stepCallRows = db.prepare(
    `SELECT tool_name, COUNT(*) AS calls
     FROM tool_calls WHERE agent_step_id = ?
     GROUP BY tool_name LIMIT 201`,
  ).all(stepId) as Array<{ tool_name: string; calls: number }>;
  const callsThisStep = new Map(stepCallRows.map(row => [row.tool_name, row.calls]));

  // 本 Turn 每工具累计调用。
  const turnCallRows = db.prepare(
    `SELECT tool_name, COUNT(*) AS calls
     FROM tool_calls WHERE agent_turn_id = ?
     GROUP BY tool_name LIMIT 201`,
  ).all(step.agent_turn_id) as Array<{ tool_name: string; calls: number }>;
  const callsThisTurn = new Map(turnCallRows.map(row => [row.tool_name, row.calls]));

  // 当前步的实际 usage（供 Harness tokens 占比）。
  const usageRow = db.prepare(
    `SELECT input_tokens, cache_read_tokens FROM usage_ledger WHERE agent_step_id = ? LIMIT 1`,
  ).get(stepId) as { input_tokens: number; cache_read_tokens: number } | undefined;

  let snapshotView: HarnessSnapshotView | undefined;
  let tools: HarnessToolItem[] = [];
  let skills: HarnessSkillItem[] = [];
  let rules: HarnessRuleItem[] = [];
  let legacyData = true;

  if (step.harness_snapshot_hash) {
    const snapshot = db.prepare(
      `SELECT snapshot_hash, agent_name, tool_count, complete,
              tools_json, skills_json, rules_json
       FROM harness_snapshots WHERE snapshot_hash = ? LIMIT 1`,
    ).get(step.harness_snapshot_hash) as SnapshotRow | undefined;
    if (snapshot) {
      const storedTools = parseSnapshotTools(snapshot.tools_json);
      skills = parseSnapshotSkills(snapshot.skills_json).map(skill => ({
        name: skill.name,
        sourceLevel: skill.sourceLevel,
        sourceRoot: skill.sourceRoot,
        pluginName: skill.pluginName,
        estTokens: skill.estTokens,
      }));
      rules = parseSnapshotRules(snapshot.rules_json).map(rule => ({
        kind: rule.kind,
        path: rule.path,
        estTokens: rule.estTokens,
      }));
      tools = storedTools.map(tool => {
        const classification = classifyToolName(tool.name);
        const kind = tool.kind === "mcp" || classification.kind === "mcp" ? "mcp" : "tool";
        const mcpServer = tool.mcpServer ?? classification.mcpServer;
        const stepCalls = callsThisStep.get(tool.name) ?? 0;
        return {
          name: tool.name,
          kind,
          mcpServer,
          defTokensEst: tool.schemaTokensEst ?? 0,
          callsThisStep: stepCalls,
          callsThisTurn: callsThisTurn.get(tool.name) ?? 0,
          invoked: stepCalls > 0,
        };
      });
      // 本步实际调用过但清单缺失的工具（如截断或异常），补在末尾保证事实完整。
      for (const [toolName, calls] of callsThisStep) {
        if (!tools.some(tool => tool.name === toolName)) {
          const classification = classifyToolName(toolName);
          tools.push({
            name: toolName,
            kind: classification.kind,
            mcpServer: classification.mcpServer,
            defTokensEst: 0,
            callsThisStep: calls,
            callsThisTurn: callsThisTurn.get(toolName) ?? 0,
            invoked: true,
          });
        }
      }

      // 快照覆盖区间与本 Thread 内序号。
      const coverage = db.prepare(
        `SELECT MIN(step_index) AS from_index, MAX(step_index) AS to_index
         FROM agent_steps
         WHERE agent_thread_id = ? AND harness_snapshot_hash = ?`,
      ).get(step.agent_thread_id, step.harness_snapshot_hash) as {
        from_index: number | null;
        to_index: number | null;
      };
      const distinctBefore = db.prepare(
        `SELECT COUNT(DISTINCT harness_snapshot_hash) AS seq
         FROM agent_steps
         WHERE agent_thread_id = ? AND harness_snapshot_hash IS NOT NULL
           AND step_index < ?`,
      ).get(step.agent_thread_id, step.step_index) as { seq: number };

      snapshotView = {
        hash: snapshot.snapshot_hash,
        shortHash: shortHash(snapshot.snapshot_hash),
        agentName: snapshot.agent_name,
        complete: snapshot.complete === 1,
        seqInThread: distinctBefore.seq + 1,
        coverage: {
          fromStepIndex: coverage.from_index ?? step.step_index,
          toStepIndex: coverage.to_index ?? step.step_index,
        },
        firstSeenStepIndex: coverage.from_index ?? step.step_index,
      };
    }
  }

  // 构成估算：来自本步 context snapshot 的 contextComposition（升级前数据缺失）。
  let harnessTokens: HarnessTokensView | undefined;
  const summaryRow = db.prepare(
    `SELECT summary_json, artifact_storage, artifact_hash
     FROM context_snapshots WHERE agent_step_id = ? LIMIT 1`,
  ).get(stepId) as
    | {summary_json: string; artifact_storage: string | null; artifact_hash: string | null}
    | undefined;
  const summaryJson = summaryRow
    ? resolveDerivedArtifactJson(dataDir, {
      artifact_storage: summaryRow.artifact_storage,
      artifact_hash: summaryRow.artifact_hash,
      inline_json: summaryRow.summary_json,
    }) ?? undefined
    : undefined;
  if (summaryJson) {
    let composition: ContextComposition | undefined;
    try {
      const parsed = JSON.parse(summaryJson) as {
        snapshot?: { contextComposition?: ContextComposition };
        contextComposition?: ContextComposition;
      };
      composition = parsed.snapshot?.contextComposition ?? parsed.contextComposition;
    } catch {
      composition = undefined;
    }
    if (composition) {
      legacyData = false;
      const source = composition.calibratedTokens ?? composition.estTokens;
      const byComponent = {
        toolsNonMcp: source.toolsNonMcp ?? 0,
        mcp: source.mcp ?? 0,
        skills: source.skills ?? 0,
        rules: source.rules ?? 0,
      };
      const total = byComponent.toolsNonMcp + byComponent.mcp + byComponent.skills + byComponent.rules;
      const actualInput = composition.calibration?.actualInputTokens;
      harnessTokens = {
        byComponent,
        total,
        shareOfInput: actualInput && actualInput > 0 ? total / actualInput : undefined,
        calibrated: composition.calibratedTokens !== undefined,
        inputTokens: actualInput,
      };
    }
  }

  // 快照变化：同 Thread 内、覆盖区间起点之前的最近一个不同快照。
  let changes: HarnessChangesView | undefined;
  if (snapshotView) {
    const previous = db.prepare(
      `SELECT s.harness_snapshot_hash AS hash, MIN(s.step_index) AS first_index
       FROM agent_steps s
       WHERE s.agent_thread_id = ?
         AND s.harness_snapshot_hash IS NOT NULL
         AND s.harness_snapshot_hash != ?
         AND s.step_index < ?
       GROUP BY s.harness_snapshot_hash
       ORDER BY first_index DESC
       LIMIT 1`,
    ).get(step.agent_thread_id, step.harness_snapshot_hash, snapshotView.coverage.fromStepIndex) as {
      hash: string;
      first_index: number;
    } | undefined;
    if (previous) {
      const previousSnapshot = db.prepare(
        `SELECT tools_json, rules_json, skills_json FROM harness_snapshots WHERE snapshot_hash = ? LIMIT 1`,
      ).get(previous.hash) as { tools_json: string; rules_json: string; skills_json: string } | undefined;
      const currentIdentity = identityOfTools(tools);
      const previousIdentity = previousSnapshot
        ? identityOfTools(parseSnapshotTools(previousSnapshot.tools_json))
        : [];
      const toolDiff = diffAddedRemoved(previousIdentity, currentIdentity);
      const currentRules = identityOfRules(rules);
      const previousRules = previousSnapshot
        ? identityOfRules(parseSnapshotRules(previousSnapshot.rules_json).map(rule => ({
          kind: rule.kind,
          path: rule.path,
          estTokens: 0,
        })))
        : [];
      const rulesDiff = diffAddedRemoved(previousRules, currentRules);
      // 身份串仅用于集合比对；展示侧只保留名称段。
      const nameOf = (identity: string) => identity.split("|")[0];
      const currentSkills = new Set(skills.map(skill => skill.name));
      const previousSkills = new Set(
        previousSnapshot
          ? parseSnapshotSkills(previousSnapshot.skills_json).map(skill => skill.name)
          : [],
      );
      changes = {
        fromSnapshotHash: previous.hash,
        fromStepIndex: previous.first_index,
        toolsAdded: toolDiff.added.map(nameOf),
        toolsRemoved: toolDiff.removed.map(nameOf),
        skillsAdded: [...currentSkills].filter(name => !previousSkills.has(name)),
        skillsRemoved: [...previousSkills].filter(name => !currentSkills.has(name)),
        rulesAdded: rulesDiff.added.map(nameOf),
        rulesRemoved: rulesDiff.removed.map(nameOf),
      };
    }
  }

  return {
    stepId: step.id,
    exchangeId: step.exchange_id,
    stepIndex: step.step_index,
    project: step.project_key ? step.project_key.split("/").filter(Boolean).pop() : undefined,
    snapshot: snapshotView,
    inventory: { tools, skills, rules },
    harnessTokens,
    changes,
    compaction: loadAgentStepCompaction(db, step),
    legacyData: legacyData && !skills.length && !rules.length,
    candidateCount: 1,
    processedCount: 1,
    limited: snapshotView ? !snapshotView.complete : false,
  };
}

/** 上下文压缩事件（证据级）：有 trimming 证据或 context_compressed=1 → detected；仅大幅下降 → possible。 */
export function loadAgentStepCompaction(
  db: DeepaaDatabase,
  step: StepCoreRow,
  dataDir?: string,
): HarnessCompactionView | undefined {
  const currentUsage = db.prepare(
    `SELECT input_tokens, cache_read_tokens FROM usage_ledger WHERE agent_step_id = ? LIMIT 1`,
  ).get(step.id) as { input_tokens: number; cache_read_tokens: number } | undefined;
  if (!currentUsage) return undefined;
  const previous = db.prepare(
    `SELECT u.input_tokens AS input_tokens, u.cache_read_tokens AS cache_read_tokens
     FROM agent_steps s
     JOIN usage_ledger u ON u.agent_step_id = s.id
     WHERE s.agent_thread_id = ? AND s.step_index < ?
     ORDER BY s.step_index DESC LIMIT 1`,
  ).get(step.agent_thread_id, step.step_index) as {
    input_tokens: number;
    cache_read_tokens: number;
  } | undefined;
  if (!previous) return undefined;

  const before = previous.input_tokens + previous.cache_read_tokens;
  const after = currentUsage.input_tokens + currentUsage.cache_read_tokens;
  if (before <= 0 || after <= 0) return undefined;
  const reductionPct = (before - after) / before;
  const trimmedRow = db.prepare(
    `SELECT diff_json, artifact_storage, artifact_hash
     FROM step_diffs WHERE agent_step_id = ? LIMIT 1`,
  ).get(step.id) as
    | {diff_json: string; artifact_storage: string | null; artifact_hash: string | null}
    | undefined;
  const trimmed = trimmedRow
    ? resolveDerivedArtifactJson(dataDir, {
      artifact_storage: trimmedRow.artifact_storage,
      artifact_hash: trimmedRow.artifact_hash,
      inline_json: trimmedRow.diff_json,
    }) ?? undefined
    : undefined;
  let messageRemoved = 0;
  let toolResultRemoved = 0;
  let compactionEvidence = 0;
  let contextCompressed = false;
  if (trimmed) {
    try {
      const diff = JSON.parse(trimmed) as {
        contextTrimming?: Array<{kind?: string}>;
        value?: {contextTrimming?: Array<{kind?: string}>};
      };
      const trimming = diff.contextTrimming ?? diff.value?.contextTrimming ?? [];
      messageRemoved = trimming.filter(item => item.kind === "message_removed").length;
      toolResultRemoved = trimming.filter(item => item.kind === "tool_result_removed").length;
      // P1 校准：压缩证据（dsh purpose 头 / 续接摘要注入）与真实裁剪同级计入 detected；
      // remote_state_reference 是正常续写，不算压缩证据。
      compactionEvidence = trimming.filter(item =>
        item.kind === "compaction_summary_injected" || item.kind === "compaction_purpose_header"
      ).length;
    } catch {
      // 证据解析失败只降级为无证据，不阻断响应。
    }
  }
  contextCompressed = messageRemoved + toolResultRemoved + compactionEvidence > 0;
  const stepCompressedFlag = db.prepare(
    `SELECT context_compressed FROM agent_steps WHERE id = ?`,
  ).pluck().get(step.id);
  if (stepCompressedFlag === 1) contextCompressed = true;

  const hasEvidence = contextCompressed;
  if (!hasEvidence && reductionPct < 0.3) return undefined;
  return {
    kind: hasEvidence ? "detected" : "possible",
    before,
    after,
    reductionPct,
    messageRemoved,
    toolResultRemoved,
    compactionEvidence,
    contextCompressed,
  };
}
