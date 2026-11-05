/**
 * Harness 证据层：Step 级查询（docs/Harness能力建设一期.md §5）。
 * 全部主键/唯一键定位 + 小范围 keyset 聚合，禁止全量扫描；
 * 快照覆盖区间以同 Thread 内相同 harness_snapshot_hash 的 step_index 包络计算。
 */

import type {DeepaaDatabase} from "@/lib/db/sqlite-driver";
import type {
  ApiAgentStepHarness,
  HarnessCallsLimitedView,
  HarnessChangesView,
  HarnessCompactionView,
  HarnessReferenceView,
  HarnessRuleItem,
  HarnessSkillItem,
  HarnessSnapshotView,
  HarnessToolItem,
  HarnessTokensView,
} from "../harness/harness-step";
import { classifyToolName } from "../harness/evidence";
import { skillsParseStatusForAgent } from "../harness/skills-parser";
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

  // 本步每工具调用计数（Used 侧）。F12：limit+1 哨兵——达上限时超出分组不可信，
  // 未进入已处理集合的工具调用数标 unknown，不落成 0。
  const stepCallRows = db.prepare(
    `SELECT tool_name, COUNT(*) AS calls
     FROM tool_calls WHERE agent_step_id = ?
     GROUP BY tool_name LIMIT 202`,
  ).all(stepId) as Array<{ tool_name: string; calls: number }>;
  const stepCallsLimited = stepCallRows.length > 201;
  const callsThisStep = new Map(
    (stepCallsLimited ? stepCallRows.slice(0, 201) : stepCallRows).map(row => [row.tool_name, row.calls]),
  );

  // 本 Turn 每工具累计调用（同样哨兵）。
  const turnCallRows = db.prepare(
    `SELECT tool_name, COUNT(*) AS calls
     FROM tool_calls WHERE agent_turn_id = ?
     GROUP BY tool_name LIMIT 202`,
  ).all(step.agent_turn_id) as Array<{ tool_name: string; calls: number }>;
  const turnCallsLimited = turnCallRows.length > 201;
  const callsThisTurn = new Map(
    (turnCallsLimited ? turnCallRows.slice(0, 201) : turnCallRows).map(row => [row.tool_name, row.calls]),
  );
  const callsLimited: HarnessCallsLimitedView = {step: stepCallsLimited, turn: turnCallsLimited};

  // 当前步的实际 usage（供 Harness tokens 占比）。
  const usageRow = db.prepare(
    `SELECT input_tokens, cache_read_tokens FROM usage_ledger WHERE agent_step_id = ? LIMIT 1`,
  ).get(stepId) as { input_tokens: number; cache_read_tokens: number } | undefined;

  let snapshotView: HarnessSnapshotView | undefined;
  let tools: HarnessToolItem[] = [];
  let observedOnlyTools: HarnessToolItem[] = [];
  let skills: HarnessSkillItem[] = [];
  let rules: HarnessRuleItem[] = [];
  let reference: HarnessReferenceView | undefined;
  let legacyData = true;
  // 声明清单（快照内工具名集合）；无快照时为空集——observed_only 调用证据
  // 独立于快照存在（审计修订 2026-11-04：无快照的 step 此前连调用证据也不显示）。
  let declaredNames = new Set<string>();
  // F6 时间序序列与当前行位置(快照分支填充,changes 复用)。
  let sequenceRows: Array<{id: string; step_index: number; hash: string}> = [];
  let currentIndexRef = -1;

  if (step.harness_snapshot_hash) {
    const snapshot = db.prepare(
      `SELECT snapshot_hash, agent_name, tool_count, complete,
              tools_json, skills_json, rules_json
       FROM harness_snapshots WHERE snapshot_hash = ? LIMIT 1`,
    ).get(step.harness_snapshot_hash) as SnapshotRow | undefined;
    if (snapshot) {
      const storedTools = parseSnapshotTools(snapshot.tools_json);
      declaredNames = new Set(storedTools.map(tool => tool.name));
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
        const knownStep = callsThisStep.has(tool.name);
        const stepCalls = knownStep ? (callsThisStep.get(tool.name) ?? 0) : 0;
        return {
          name: tool.name,
          kind,
          mcpServer,
          defTokensEst: tool.schemaTokensEst ?? 0,
          callsThisStep: stepCalls,
          callsThisTurn: callsThisTurn.get(tool.name) ?? 0,
          invoked: stepCalls > 0,
          exposure: "declared" as const,
          callsUnknown: stepCallsLimited && !knownStep ? true : undefined,
        };
      });
      // F1：该 step 的清单若为导入行借补产物（诊断可观测），标记为参考而非当次确定传递。
      const borrowedDiag = db.prepare(
        `SELECT details_json FROM derivation_diagnostics
         WHERE exchange_id = ? AND code = 'harness_inventory_borrowed'
         ORDER BY created_at DESC LIMIT 1`,
      ).get(step.exchange_id) as {details_json: string} | undefined;
      if (borrowedDiag) {
        let borrowed: string[] = [];
        let donorSnapshotHash: string | undefined;
        let donorLastSeenAt: string | undefined;
        try {
          const details = JSON.parse(borrowedDiag.details_json) as {
            borrowed?: unknown;
            donors?: Array<{component?: string; snapshotHash?: string; lastSeenAt?: string}>;
          };
          if (Array.isArray(details.borrowed)) {
            borrowed = details.borrowed.filter((item): item is string => typeof item === "string");
          }
          const firstDonor = Array.isArray(details.donors) ? details.donors[0] : undefined;
          if (firstDonor && typeof firstDonor.snapshotHash === "string") {
            donorSnapshotHash = firstDonor.snapshotHash;
            donorLastSeenAt = typeof firstDonor.lastSeenAt === "string" ? firstDonor.lastSeenAt : undefined;
          }
        } catch {
          // 存量诊断 details 损坏时保持无 donor 的参考标注，不阻断响应。
        }
        reference = {borrowed, donorSnapshotHash, donorLastSeenAt};
      }

      // P1-1/F10：会话首见运行版本（轻量单列读取，存量 NULL）。
      const sessionAgentVersion = db.prepare(
        `SELECT s.agent_version FROM agent_sessions s
         JOIN agent_threads t ON t.agent_session_id = s.id
         WHERE t.id = ? LIMIT 1`,
      ).pluck().get(step.agent_thread_id) as string | null | undefined;

      // F6（2026-11-04 查询侧修复）：Thread 内快照序列 → 连续片段。
      // 旧实现的三个缺陷（docs 方案 F6 隔离反例 A→A→B→A）：
      // ① seqInThread = distinctBefore+1——第二步清单未变却显示「第 2 个」；
      // ② coverage = 同哈希全局 MIN/MAX——A 的包络 1–4 跨过中间的 B；
      // ③ changes 用全局 MIN 作查找边界——第四步回到 A 时 B→A 的变化不展示。
      // 序列有界（单 Thread ≤5000 行，仅主键列）；片段按数组邻接扩展（不假设 step_index 无洞）。
      // 审计修订 B(P-2, 2026-11-04):真实 thread 的 step_index 每 turn 重置为 1
      // (实测 zcode/codex 多 turn thread),ORDER BY step_index 会把各 turn 交错排列。
      // 序列必须按捕获时间序(同刻稳定序:step 主键),窗口放宽到 10000 行;
      // 当前步不在窗口内(超长 thread,极罕见)时保守显示自身片段,不误报全局序。
      const sequenceRowsLocal = db.prepare(
        `SELECT s.id, s.step_index, s.harness_snapshot_hash AS hash
         FROM agent_steps s JOIN raw_exchange_refs r ON r.exchange_id = s.exchange_id
         WHERE s.agent_thread_id = ? AND s.harness_snapshot_hash IS NOT NULL
         ORDER BY r.captured_at, s.id LIMIT 10000`,
      ).all(step.agent_thread_id) as Array<{id: string; step_index: number; hash: string}>;
      sequenceRows = sequenceRowsLocal;
      // 审计修订 B 关键:step_index 每 turn 重置,必须按 step 主键定位当前行
      // (按 step_index findIndex 会命中其它 turn 的同号行)。超长 thread 越界
      // (>10000 行)时保守退化为自身片段,不误报全局序。
      const currentIndex = sequenceRows.findIndex(row => row.id === stepId);
      currentIndexRef = currentIndex;
      let segmentStart = step.step_index;
      let segmentEnd = step.step_index;
      let hashFirstSeen = step.step_index;
      const seenHashes = new Set<string>();
      let seqInThread = 1;
      if (currentIndex >= 0) {
        let back = currentIndex - 1;
        while (back >= 0 && sequenceRows[back]!.hash === snapshot.snapshot_hash) {
          segmentStart = sequenceRows[back]!.step_index;
          back -= 1;
        }
        let forward = currentIndex + 1;
        while (forward < sequenceRows.length && sequenceRows[forward]!.hash === snapshot.snapshot_hash) {
          segmentEnd = sequenceRows[forward]!.step_index;
          forward += 1;
        }
        // 审计修订 B:遍历到当前行(序列位置)为止——step_index 每 turn 重置,
        // 不可作比较键。
        for (let i = 0; i <= currentIndex && i < sequenceRows.length; i += 1) {
          const row = sequenceRows[i]!;
          if (!seenHashes.has(row.hash)) {
            seenHashes.add(row.hash);
            if (row.hash === snapshot.snapshot_hash) hashFirstSeen = row.step_index;
          }
        }
        seqInThread = seenHashes.size;
      }

      snapshotView = {
        hash: snapshot.snapshot_hash,
        shortHash: shortHash(snapshot.snapshot_hash),
        agentName: snapshot.agent_name,
        agentVersion: sessionAgentVersion ?? undefined,
        complete: snapshot.complete === 1,
        seqInThread,
        coverage: {
          fromStepIndex: segmentStart,
          toStepIndex: segmentEnd,
        },
        firstSeenStepIndex: hashFirstSeen,
      };
    }
  }

  // 审计修订 A(F12):step 分组截断时,observed-only 集合只含已处理分组——
  // 是下界,响应带 observedLimited 如实标注(超出分组的仅调用工具不可见)。
  const observedLimited = stepCallsLimited;
  // F11（审计修订 2026-11-04）：本步实际调用过但清单无定义的工具单独成组——
  // 调用证据独立于快照存在，无快照/借补/截断场景同样如实展示；不进传递分母。
  for (const [toolName, calls] of callsThisStep) {
    if (declaredNames.has(toolName)) continue;
    const classification = classifyToolName(toolName);
    observedOnlyTools.push({
      name: toolName,
      kind: classification.kind,
      mcpServer: classification.mcpServer,
      defTokensEst: 0,
      callsThisStep: calls,
      callsThisTurn: callsThisTurn.get(toolName) ?? 0,
      invoked: true,
      exposure: "observed_only" as const,
    });
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

  // 快照变化：当前连续片段起点之前紧邻一步所属的不同快照（F6 修复：
  // 用片段边界而非全局 MIN——回到旧清单（A→B→A）时 B→A 的变化正确展示）。
  let changes: HarnessChangesView | undefined;
  if (snapshotView && currentIndexRef >= 1) {
    // 审计修订 B:紧邻前一行取自时间序序列(step_index 每 turn 重置不可作键);
    // 同清单片段内的前行(同哈希)不产生变化。
    const previousRow = sequenceRows[currentIndexRef - 1]!;
    const previous = previousRow.hash !== step.harness_snapshot_hash
      ? {hash: previousRow.hash, first_index: previousRow.step_index}
      : undefined;
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
    inventory: observedOnlyTools.length > 0
      ? { tools, skills, rules, observedOnlyTools }
      : { tools, skills, rules },
    harnessTokens,
    changes,
    compaction: loadAgentStepCompaction(db, step),
    reference,
    callsLimited,
    ...(observedLimited ? {observedLimited: true} : {}),
    skillsParseStatus: snapshotView ? skillsParseStatusForAgent(snapshotView.agentName) : undefined,
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
