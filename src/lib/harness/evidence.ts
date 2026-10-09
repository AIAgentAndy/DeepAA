/**
 * Harness 证据层：工具分类 / Rules 提取 / 项目目录提取 / 输入文本构成切分。
 * 设计依据：docs/Harness能力建设一期.md §2（codex 证据链）+ 2026-09-11 P1 校准
 * （claude/zcode `<env>` Working directory 块与 Skill 工具清单段，均真实抓包验证）。
 *
 * - 工具分类：`mcp__` 前缀判定 MCP（claude-code 形态 `mcp__server__tool`、codex 实测形态 `mcp__server`）。
 * - 项目目录证据链：`x-codex-turn-metadata.workspaces`（主）→ `<environment_context><cwd>`
 *   → `<env>` Working directory 块（claude/zcode）→ AGENTS.md 注入路径（最后兜底）。
 * - Rules：AGENTS.md / CLAUDE.md 注入条目 + `<permissions instructions>` 段。
 * - partitionInputText 把注入文本切分为 skills / rules / env / 剩余四类字符量，
 *   供上下文构成估算复用，保证两处口径一致。
 */

import {
  extractTaggedSections,
  parseSkillsForAgent,
  skillToolSectionSpan,
  type ParsedSkill,
} from "./skills-parser";

export type ParsedRuleKind =
  | "agents_md_project"
  | "agents_md_global"
  | "claude_md_project"
  | "claude_md_global"
  | "permissions";

export interface ParsedRule {
  kind: ParsedRuleKind;
  path?: string;
  chars: number;
}

export interface HarnessEvidence {
  skills: ParsedSkill[];
  /** skills 注入段总字符量（含标签）。 */
  skillsChars: number;
  rules: ParsedRule[];
  /** rules 注入条目总字符量。 */
  rulesChars: number;
  /** 项目工作目录（绝对路径键）；无法提取时缺省。 */
  projectKey?: string;
}

const ENV_CONTEXT_OPEN = "<environment_context>";
const ENV_CONTEXT_CLOSE = "</environment_context>";
const PERMISSIONS_OPEN = "<permissions instructions>";
const PERMISSIONS_CLOSE = "</permissions instructions>";
const ENV_BLOCK_OPEN = "<env>";
const ENV_BLOCK_CLOSE = "</env>";

/** 按工具名分类：MCP 工具（含所属 server）或普通工具。 */
export function classifyToolName(name: string): { kind: "tool" | "mcp"; mcpServer?: string } {
  if (name.startsWith("mcp__")) {
    const parts = name.split("__");
    if (parts.length >= 2 && parts[1]) return { kind: "mcp", mcpServer: parts[1] };
  }
  return { kind: "tool" };
}

function scanEnvCwd(inputTexts: string[]): string | undefined {
  for (const text of inputTexts) {
    if (!text || !text.includes(ENV_CONTEXT_OPEN)) continue;
    for (const section of extractTaggedSections(text, ENV_CONTEXT_OPEN, ENV_CONTEXT_CLOSE)) {
      const cwd = /<cwd>([^<]+)<\/cwd>/u.exec(section)?.[1]?.trim();
      if (cwd) return cwd;
    }
  }
  return undefined;
}

/**
 * claude-code / zcode 的系统提示环境块（真实抓包验证，$.system[N].text）：
 * `<env>\nWorking directory: /abs/path\n...`。
 */
function scanEnvBlockWorkingDirectory(inputTexts: string[]): string | undefined {
  for (const text of inputTexts) {
    if (!text || !text.includes(ENV_BLOCK_OPEN)) continue;
    for (const section of extractTaggedSections(text, ENV_BLOCK_OPEN, ENV_BLOCK_CLOSE)) {
      const cwd = /^Working directory: (.+)$/mu.exec(section)?.[1]?.trim();
      if (cwd && cwd.startsWith("/")) return cwd;
    }
  }
  return undefined;
}

function parseWorkspaceKeys(headerValue: string | undefined): string[] {
  if (!headerValue) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(headerValue);
  } catch {
    return [];
  }
  const workspaces = (parsed as { workspaces?: Record<string, unknown> } | null)?.workspaces;
  if (!workspaces || typeof workspaces !== "object") return [];
  return Object.keys(workspaces).filter(key => key.startsWith("/"));
}

function scanInstructionsPath(inputTexts: string[]): string | undefined {
  for (const text of inputTexts) {
    const match = /^\s*# (?:AGENTS|CLAUDE)\.md instructions for (.+)$/mu.exec(text || "");
    const path = match?.[1]?.trim();
    if (path) return path;
  }
  return undefined;
}

/**
 * 项目目录证据链：workspaces 头优先（cwd 匹配项优先于首项），
 * 退回 `<environment_context><cwd>`，再退回 claude/zcode `<env>` Working directory 块，
 * 最后退回 AGENTS.md 注入路径。
 */
export function extractProjectKey(
  headers: Record<string, string | undefined>,
  inputTexts: string[],
): string | undefined {
  const workspaceKeys = parseWorkspaceKeys(headers["x-codex-turn-metadata"]);
  if (workspaceKeys.length > 0) {
    const cwd = scanEnvCwd(inputTexts);
    return cwd && workspaceKeys.includes(cwd) ? cwd : workspaceKeys[0];
  }
  return scanEnvCwd(inputTexts)
    ?? scanEnvBlockWorkingDirectory(inputTexts)
    ?? scanInstructionsPath(inputTexts);
}

interface MdRuleMatch {
  family: "agents" | "claude";
  path: string;
}

function matchMdRuleHeader(text: string): MdRuleMatch | undefined {
  const match = /^\s*# (AGENTS|CLAUDE)\.md instructions for (.+)$/mu.exec(text || "");
  if (!match) return undefined;
  const path = match[2].trim();
  if (!path) return undefined;
  return { family: match[1] === "AGENTS" ? "agents" : "claude", path };
}

function mdRuleKind(match: MdRuleMatch, projectKey?: string): ParsedRuleKind {
  const isProject = projectKey
    && (match.path === projectKey || match.path.startsWith(`${projectKey}/`));
  if (match.family === "agents") return isProject ? "agents_md_project" : "agents_md_global";
  return isProject ? "claude_md_project" : "claude_md_global";
}

export interface TextPartition {
  skillsChars: number;
  rulesChars: number;
  envChars: number;
  /** 扣除 skills/rules/env 后剩余文本字符量。 */
  conversationChars: number;
}

/**
 * 把单条输入文本切分为 harness 注入分类。skills 段 / permissions 段 / env 段按
 * 实际 span 计量；以 AGENTS/CLAUDE.md instructions 头开头的整块计为 rules。
 */
export function partitionInputText(text: string, projectKey?: string): TextPartition {
  const partition: TextPartition = {
    skillsChars: 0,
    rulesChars: 0,
    envChars: 0,
    conversationChars: 0,
  };
  if (!text) return partition;

  const consumed = new Array<boolean>(text.length).fill(false);
  const markSpan = (start: number, end: number) => {
    for (let index = start; index < end; index++) consumed[index] = true;
  };
  const countSpans = (open: string, close: string): number => {
    let total = 0;
    let from = 0;
    while (from <= text.length - open.length) {
      const start = text.indexOf(open, from);
      if (start < 0) break;
      const end = text.indexOf(close, start + open.length);
      if (end < 0) break;
      total += end + close.length - start;
      markSpan(start, end + close.length);
      from = end + close.length;
    }
    return total;
  };

  partition.skillsChars = countSpans("<skills_instructions>", "</skills_instructions>");
  partition.rulesChars = countSpans(PERMISSIONS_OPEN, PERMISSIONS_CLOSE);
  partition.envChars = countSpans(ENV_CONTEXT_OPEN, ENV_CONTEXT_CLOSE);
  partition.envChars += countSpans(ENV_BLOCK_OPEN, ENV_BLOCK_CLOSE);
  const skillToolSpan = skillToolSectionSpan(text);
  if (skillToolSpan) {
    markSpan(skillToolSpan.start, skillToolSpan.end);
    partition.skillsChars += skillToolSpan.end - skillToolSpan.start;
  }

  const mdMatch = matchMdRuleHeader(text);
  if (mdMatch) {
    partition.rulesChars += text.length;
    return partition;
  }

  let conversation = 0;
  for (let index = 0; index < consumed.length; index++) {
    if (!consumed[index]) conversation++;
  }
  partition.conversationChars = conversation;
  return partition;
}

/** 从请求输入文本集合提取完整 Harness 证据（skills / rules / project）。 */
export function extractHarnessEvidence(
  agentName: string,
  headers: Record<string, string | undefined>,
  inputTexts: string[],
): HarnessEvidence {
  const projectKey = extractProjectKey(headers, inputTexts);
  const skillsResult = parseSkillsForAgent(agentName, inputTexts, projectKey);
  const rules: ParsedRule[] = [];
  for (const text of inputTexts) {
    if (!text) continue;
    const mdMatch = matchMdRuleHeader(text);
    if (mdMatch) {
      rules.push({
        kind: mdRuleKind(mdMatch, projectKey),
        path: mdMatch.path,
        chars: text.length,
      });
    }
    const permissionsChars = extractTaggedSections(text, PERMISSIONS_OPEN, PERMISSIONS_CLOSE)
      .reduce((sum, section) => sum + section.length + PERMISSIONS_OPEN.length + PERMISSIONS_CLOSE.length, 0);
    if (permissionsChars > 0) {
      rules.push({ kind: "permissions", chars: permissionsChars });
    }
  }
  return {
    skills: skillsResult.skills,
    skillsChars: skillsResult.sectionChars,
    rules,
    rulesChars: rules.reduce((sum, rule) => sum + rule.chars, 0),
    projectKey,
  };
}
