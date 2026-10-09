/**
 * Harness 证据层：内容寻址快照存储（v27，docs/Harness能力建设一期.md §4.2-4.3）。
 *
 * 快照身份 = 名称级指纹（工具 name/kind/mcpServer + skill name + rule kind/path 的排序列表），
 * 同一清单只存一行；定义内容（描述/schema 文本）变化不换快照，走 step_diffs 的 hash 级 diff。
 * 各 JSON 有界 64 KiB，超限截断并置 complete=0。写入发生在派生 job 既有事务内，
 * 失败随 job 重试，不影响 raw 登记与 source 游标。
 */

import type {DeepaaDatabase} from "@/lib/db/sqlite-driver";
import { createHash } from "node:crypto";
import type { NormalizedExchange, NormalizedToolSchema } from "../harness/normalizer";
import type { ParsedRule } from "../harness/evidence";
import type { ParsedSkill } from "../harness/skills-parser";

export const HARNESS_SNAPSHOT_JSON_MAX_BYTES = 64 * 1024;

export interface SnapshotTool {
  name: string;
  kind: "tool" | "mcp";
  mcpServer?: string;
  schemaChars: number;
  schemaTokensEst: number;
}

export interface SnapshotSkill {
  name: string;
  sourceLevel: ParsedSkill["sourceLevel"];
  sourceRoot?: string;
  pluginName?: string;
  estTokens: number;
}

export interface SnapshotRule {
  kind: ParsedRule["kind"];
  path?: string;
  estTokens: number;
}

export interface HarnessSnapshotIdentity {
  snapshotHash: string;
  agentName: string;
  toolCount: number;
  mcpToolCount: number;
  mcpServerCount: number;
  skillCount: number;
  ruleCount: number;
  tools: SnapshotTool[];
  skills: SnapshotSkill[];
  rules: SnapshotRule[];
  complete: boolean;
  projectKey?: string;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function jsonBounded(items: unknown[]): { json: string; truncated: boolean } {
  let json = JSON.stringify(items);
  if (Buffer.byteLength(json) <= HARNESS_SNAPSHOT_JSON_MAX_BYTES) {
    return { json, truncated: false };
  }
  let high = items.length;
  let low = 0;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(JSON.stringify(items.slice(0, middle))) <= HARNESS_SNAPSHOT_JSON_MAX_BYTES) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  json = JSON.stringify(items.slice(0, low));
  return { json, truncated: true };
}

export function toolsFromNormalized(toolSchemas: NormalizedToolSchema[]): SnapshotTool[] {
  return toolSchemas.map(schema => ({
    name: schema.name,
    kind: schema.kind,
    mcpServer: schema.mcpServer,
    schemaChars: schema.schemaChars,
    schemaTokensEst: schema.schemaTokensEst,
  }));
}

export function buildHarnessSnapshotIdentity(
  agentName: string,
  normalized: NormalizedExchange,
): HarnessSnapshotIdentity {
  const evidence = normalized.harnessEvidence;
  const tools = toolsFromNormalized(normalized.request.toolSchemas);
  const skills: SnapshotSkill[] = evidence.skills.map(skill => ({
    name: skill.name,
    sourceLevel: skill.sourceLevel,
    sourceRoot: skill.sourceRoot,
    pluginName: skill.pluginName,
    estTokens: estimateTokensOfText(skill.chars),
  }));
  const rules: SnapshotRule[] = evidence.rules.map(rule => ({
    kind: rule.kind,
    path: rule.path,
    estTokens: estimateTokensOfText(rule.chars),
  }));
  return {
    ...finalizeHarnessSnapshotIdentity(agentName, tools, skills, rules),
    projectKey: evidence.projectKey,
  };
}

/**
 * 名称级身份指纹 + 计数装配。借补路径（导入行缺组件时从同 Agent 最近的富快照
 * 补齐）复用同一公式，保证与网关行产出的等价清单收敛到同一快照哈希（引用计数
 * 复用，不翻倍建行）。
 */
function finalizeHarnessSnapshotIdentity(
  agentName: string,
  tools: SnapshotTool[],
  skills: SnapshotSkill[],
  rules: SnapshotRule[],
): HarnessSnapshotIdentity {
  // 名称级身份指纹：与定义内容、token 估算无关，避免描述微调造成快照翻倍。
  const identityFingerprint = JSON.stringify({
    agent: agentName,
    tools: tools.map(tool => [tool.name, tool.kind, tool.mcpServer ?? ""]).sort(),
    skills: skills.map(skill => [skill.name, skill.sourceLevel, skill.sourceRoot ?? ""]).sort(),
    rules: rules.map(rule => [rule.kind, rule.path ?? ""]).sort(),
  });
  const mcpTools = tools.filter(tool => tool.kind === "mcp");
  return {
    snapshotHash: sha256Hex(identityFingerprint),
    agentName,
    toolCount: tools.length,
    mcpToolCount: mcpTools.length,
    mcpServerCount: new Set(mcpTools.map(tool => tool.mcpServer).filter(Boolean)).size,
    skillCount: skills.length,
    ruleCount: rules.length,
    tools,
    skills,
    rules,
    complete: true,
  };
}

/**
 * 导入行 Harness 借补（2026-09-18 用户批准的根治项）：dsh/zcode 等官方直连的本地
 * 日志不落工具定义/skills 清单（dsh 的 request/header.config 无 tools，wire 层才带），
 * 导入行的空组件从同 Agent 最近一个含该组件的快照（网关行产出）借补。借补只在
 * 组件为空时发生，且以快照表中真实存在的富快照为前提——若该 Agent 网络侧从无
 * 记录则保持为空，不虚构。
 */
export function borrowHarnessInventoryFromPeers(
  db: DeepaaDatabase,
  identity: HarnessSnapshotIdentity,
): {identity: HarnessSnapshotIdentity; borrowed: string[]} {
  if (identity.toolCount > 0 && identity.skillCount > 0 && identity.ruleCount > 0) {
    return {identity, borrowed: []};
  }
  const borrowed: string[] = [];
  let tools = identity.tools;
  let skills = identity.skills;
  let rules = identity.rules;
  if (identity.toolCount === 0) {
    const donor = db.prepare(
      "SELECT tools_json FROM harness_snapshots WHERE agent_name = ? AND tool_count > 0 ORDER BY last_seen_at DESC LIMIT 1",
    ).get(identity.agentName) as {tools_json: string} | undefined;
    if (donor) {
      tools = parseSnapshotTools(donor.tools_json);
      borrowed.push("tools");
    }
  }
  if (identity.skillCount === 0) {
    const donor = db.prepare(
      "SELECT skills_json FROM harness_snapshots WHERE agent_name = ? AND skill_count > 0 ORDER BY last_seen_at DESC LIMIT 1",
    ).get(identity.agentName) as {skills_json: string} | undefined;
    if (donor) {
      skills = parseSnapshotSkills(donor.skills_json);
      borrowed.push("skills");
    }
  }
  if (identity.ruleCount === 0) {
    const donor = db.prepare(
      "SELECT rules_json FROM harness_snapshots WHERE agent_name = ? AND rule_count > 0 ORDER BY last_seen_at DESC LIMIT 1",
    ).get(identity.agentName) as {rules_json: string} | undefined;
    if (donor) {
      rules = parseSnapshotRules(donor.rules_json);
      borrowed.push("rules");
    }
  }
  if (borrowed.length === 0) return {identity, borrowed: []};
  return {
    identity: {...finalizeHarnessSnapshotIdentity(identity.agentName, tools, skills, rules), projectKey: identity.projectKey},
    borrowed,
  };
}

function estimateTokensOfText(chars: number): number {
  // skills/rules 只有字符量；按整体注入文本的保守折算（≈1/3 token/字符，介于 CJK 与 ASCII 之间）。
  return Math.round(chars / 3);
}

/**
 * 在派生事务内 upsert 快照并回写 step 引用列。
 * 命中已有快照时仅追加引用计数并刷新 last_seen_at（保留 first_seen_at）。
 */
export function upsertHarnessSnapshotForStep(
  db: DeepaaDatabase,
  identity: HarnessSnapshotIdentity,
  input: { stepId: string; timestamp: string },
): void {
  const tools = jsonBounded(identity.tools);
  const skills = jsonBounded(identity.skills);
  const rules = jsonBounded(identity.rules);
  const complete = identity.complete && !tools.truncated && !skills.truncated && !rules.truncated ? 1 : 0;

  db.prepare(
    `INSERT INTO harness_snapshots(
      snapshot_hash, agent_name, tool_count, mcp_tool_count, mcp_server_count,
      skill_count, rule_count, tools_json, skills_json, rules_json,
      complete, first_seen_at, last_seen_at, step_ref_count
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 1)
    ON CONFLICT(snapshot_hash) DO UPDATE SET
      last_seen_at = MAX(harness_snapshots.last_seen_at, excluded.last_seen_at),
      step_ref_count = step_ref_count + 1`,
  ).run(
    identity.snapshotHash,
    identity.agentName,
    identity.toolCount,
    identity.mcpToolCount,
    identity.mcpServerCount,
    identity.skillCount,
    identity.ruleCount,
    tools.json,
    skills.json,
    rules.json,
    input.timestamp,
    input.timestamp,
  );
  // complete 在冲突路径不更新：以首见写入为准，避免同清单截断状态抖动。
  if (!complete) {
    db.prepare(
      `UPDATE harness_snapshots SET complete = 0 WHERE snapshot_hash = ?`,
    ).run(identity.snapshotHash);
  }
  db.prepare(
    `UPDATE agent_steps SET harness_snapshot_hash = ?, project_key = ? WHERE id = ?`,
  ).run(identity.snapshotHash, identity.projectKey ?? null, input.stepId);
}

/** 供回填与 API 复用：从已存 JSON 列解析工具清单（损坏时返回空集）。 */
export function parseSnapshotTools(json: string): SnapshotTool[] {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed as SnapshotTool[] : [];
  } catch {
    return [];
  }
}

export function parseSnapshotSkills(json: string): SnapshotSkill[] {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed as SnapshotSkill[] : [];
  } catch {
    return [];
  }
}

export function parseSnapshotRules(json: string): SnapshotRule[] {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed as SnapshotRule[] : [];
  } catch {
    return [];
  }
}
