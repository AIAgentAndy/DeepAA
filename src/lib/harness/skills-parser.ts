/**
 * Harness 证据层：Skills 注入名单解析（Harness 能力建设一期，2026-09-11 用户确认）。
 *
 * 两类已验证格式（均用本机真实抓包校准，绝不猜测）：
 * 1. codex：`<skills_instructions>` 段落（roots 表 + Available skills 名单，
 *    docs/Harness能力建设一期.md §2.2）。
 * 2. claude-code / zcode：`<system-reminder>` 包裹的 Skill 工具清单段
 *    （2026-09-11 真实库取证：claude 173 处、zcode 含插件路径样本）：
 *    "The following skills are available for use with the Skill tool:"
 *    后跟 `- name: description (also loadable as alias) (file: /abs/path/SKILL.md)` 条目。
 *
 * 其它 Agent（opencode/dsh）暂无本地抓包样本，解析器返回空集——待真实样本接入后
 * 按注册表补充实现。
 *
 * 边界（一期决策 D5）：skills 是注入文本而非 wire 工具调用，只能统计「注入」，
 * 不能统计「使用」；UI 必须带「注入」徽标。
 */

export type SkillSourceLevel = "system" | "user" | "plugin" | "project" | "unknown";

export interface ParsedSkill {
  name: string;
  sourceLevel: SkillSourceLevel;
  /** roots 表的短键（如 r0/r6）或展开前的相对路径。 */
  sourceRoot?: string;
  /** 由 `plugin_name:` 前缀或 plugins/cache roots 推断的插件名（一级标注「推断」）。 */
  pluginName?: string;
  /** 该条目注入文本的字符量（供构成估算与二期成本分析）。 */
  chars: number;
}

export interface SkillSectionResult {
  skills: ParsedSkill[];
  /** skills 注入段总字符量（含标签），供上下文构成分类。 */
  sectionChars: number;
}

const SKILLS_SECTION_OPEN = "<skills_instructions>";
const SKILLS_SECTION_CLOSE = "</skills_instructions>";

/** claude-code / zcode 共用的 Skill 工具清单段标题（真实抓包验证）。 */
export const SKILL_TOOL_SECTION_HEADER = "The following skills are available for use with the Skill tool:";
const SYSTEM_REMINDER_CLOSE = "</system-reminder>";
const SYSTEM_REMINDER_OPEN = "<system-reminder>";

/**
 * Skill 工具清单段的字符 span（含紧邻前导 `<system-reminder>` 开标签、标题与
 * 可选 `</system-reminder>` 收尾），供构成估算与名单解析共用同一口径。
 */
export function skillToolSectionSpan(text: string): {start: number; end: number} | undefined {
  if (!text) return undefined;
  const start = text.indexOf(SKILL_TOOL_SECTION_HEADER);
  if (start < 0) return undefined;
  let spanStart = start;
  const window = text.slice(Math.max(0, start - SYSTEM_REMINDER_OPEN.length - 4), start);
  const openIndex = window.lastIndexOf(SYSTEM_REMINDER_OPEN);
  if (openIndex >= 0 && window.slice(openIndex + SYSTEM_REMINDER_OPEN.length).trim() === "") {
    spanStart = Math.max(0, start - SYSTEM_REMINDER_OPEN.length - 4) + openIndex;
  }
  const close = text.indexOf(SYSTEM_REMINDER_CLOSE, spanStart);
  const fallbackEnd = start + SKILL_TOOL_SECTION_HEADER.length;
  return {start: spanStart, end: close >= 0 ? close + SYSTEM_REMINDER_CLOSE.length : fallbackEnd};
}

/** 提取文本中所有 `<tag>...</tag>` 结构化段落（有界扫描，不使用回溯型正则）。 */
export function extractTaggedSections(text: string, open: string, close: string): string[] {
  if (!text) return [];
  const sections: string[] = [];
  let from = 0;
  while (from <= text.length - open.length) {
    const start = text.indexOf(open, from);
    if (start < 0) break;
    const contentStart = start + open.length;
    const end = text.indexOf(close, contentStart);
    if (end < 0) break;
    sections.push(text.slice(contentStart, end));
    from = end + close.length;
  }
  return sections;
}

interface SkillRoot {
  key: string;
  path: string;
}

function parseSkillRoots(section: string): SkillRoot[] {
  const roots: SkillRoot[] = [];
  const rootPattern = /^- `([A-Za-z0-9_]+)` = (.+)$/gmu;
  let match: RegExpExecArray | null;
  while ((match = rootPattern.exec(section)) !== null) {
    const path = match[2].trim();
    if (path) roots.push({ key: match[1], path });
  }
  return roots;
}

function resolveSourceLevel(input: {
  rootPath?: string;
  pluginPrefix?: string;
  projectKey?: string;
}): { sourceLevel: SkillSourceLevel; pluginName?: string } {
  if (input.pluginPrefix) return { sourceLevel: "plugin", pluginName: input.pluginPrefix };
  const rootPath = input.rootPath;
  if (rootPath) {
    const pluginCacheIndex = rootPath.indexOf("/plugins/cache/");
    if (pluginCacheIndex >= 0) {
      const rest = rootPath.slice(pluginCacheIndex + "/plugins/cache/".length);
      const pluginName = rest.split("/")[0] || undefined;
      return { sourceLevel: "plugin", pluginName };
    }
    if (input.projectKey && rootPath.startsWith(input.projectKey)) {
      return { sourceLevel: "project" };
    }
    if (rootPath.includes("/.system")) return { sourceLevel: "system" };
    return { sourceLevel: "user" };
  }
  return { sourceLevel: "unknown" };
}

function parseSkillEntries(section: string, projectKey?: string): ParsedSkill[] {
  const roots = parseSkillRoots(section);
  const rootsByKey = new Map(roots.map(root => [root.key, root.path]));
  const skills: ParsedSkill[] = [];
  const seen = new Set<string>();
  const entryPattern = /^- (.+)$/gmu;
  let match: RegExpExecArray | null;
  while ((match = entryPattern.exec(section)) !== null) {
    const line = match[1];
    if (/^`[A-Za-z0-9_]+` = /.test(line)) continue; // roots 行
    // 条目格式：`name: description`；插件条目 name 形如 `plugin_name:skill`。
    const headSeparator = line.indexOf(": ");
    if (headSeparator <= 0) continue;
    const head = line.slice(0, headSeparator);
    let name = head;
    let pluginPrefix: string | undefined;
    const prefixSeparator = head.indexOf(":");
    if (prefixSeparator > 0 && prefixSeparator < head.length - 1) {
      pluginPrefix = head.slice(0, prefixSeparator);
      name = head.slice(prefixSeparator + 1);
    }
    name = name.trim();
    if (!name) continue;
    let rootKey: string | undefined;
    let rootPath: string | undefined;
    const fileRef = /\(file: ([^)]+)\)\s*$/u.exec(line);
    if (fileRef) {
      const ref = fileRef[1].trim();
      const slashIndex = ref.indexOf("/");
      if (ref.startsWith("r") && slashIndex > 0) {
        rootKey = ref.slice(0, slashIndex);
      } else if (ref.startsWith("/")) {
        // claude/zcode 形态：绝对路径，取 SKILL.md 所在目录作来源根。
        const withoutFile = ref.slice(0, ref.length - "/SKILL.md".length);
        rootPath = withoutFile.endsWith("/") ? withoutFile.slice(0, -1) : withoutFile;
      }
    }
    if (rootKey && !rootPath) {
      rootPath = rootsByKey.get(rootKey);
    }
    const level = resolveSourceLevel({ rootPath, pluginPrefix, projectKey });
    const dedupeKey = `${name}|${rootPath ?? ""}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    skills.push({
      name,
      sourceLevel: level.sourceLevel,
      sourceRoot: rootPath ?? rootKey,
      pluginName: level.pluginName,
      chars: match[0].length,
    });
  }
  return skills;
}

/** 按 Agent 解析注入 skills 名单；未支持 Agent 返回空集（显式空态，不猜测格式）。 */
export function parseSkillsForAgent(
  agentName: string,
  inputTexts: string[],
  projectKey?: string,
): SkillSectionResult {
  if (agentName === "codex") return parseCodexSkills(inputTexts, projectKey);
  if (agentName === "claude-code" || agentName === "zcode") {
    return parseSkillToolSection(inputTexts, projectKey);
  }
  return { skills: [], sectionChars: 0 };
}

function parseCodexSkills(inputTexts: string[], projectKey?: string): SkillSectionResult {
  const skills: ParsedSkill[] = [];
  let sectionChars = 0;
  for (const text of inputTexts) {
    if (!text || !text.includes(SKILLS_SECTION_OPEN)) continue;
    for (const section of extractTaggedSections(text, SKILLS_SECTION_OPEN, SKILLS_SECTION_CLOSE)) {
      const fullLength = section.length + SKILLS_SECTION_OPEN.length + SKILLS_SECTION_CLOSE.length;
      sectionChars += fullLength;
      for (const skill of parseSkillEntries(section, projectKey)) {
        skills.push(skill);
      }
    }
  }
  return { skills, sectionChars };
}

/**
 * claude-code / zcode 的 Skill 工具清单段（`<system-reminder>` 包裹，真实抓包验证）。
 * 条目行与 codex 同构，复用 parseSkillEntries；绝对路径 file 引用按目录推断来源分级。
 */
function parseSkillToolSection(inputTexts: string[], projectKey?: string): SkillSectionResult {
  const skills: ParsedSkill[] = [];
  let sectionChars = 0;
  const seen = new Set<string>();
  for (const text of inputTexts) {
    if (!text || !text.includes(SKILL_TOOL_SECTION_HEADER)) continue;
    const span = skillToolSectionSpan(text);
    if (!span) continue;
    sectionChars += span.end - span.start;
    const section = text.slice(span.start, span.end);
    for (const skill of parseSkillEntries(section, projectKey)) {
      const dedupeKey = `${skill.name}|${skill.sourceRoot ?? ""}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      skills.push(skill);
    }
  }
  return { skills, sectionChars };
}
