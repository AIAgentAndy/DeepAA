/**
 * P1-5（2026-11-03）：本机能力台账扫描（最小版·只读有界）。
 *
 * 扫描边界（docs/Agent底层Harness剖析与推进方案-2026-10-30.md §16 初始预算）：
 * - 只读；绝不执行配置里的命令/插件脚本/Skill 脚本，不为收集目录启动任何进程；
 * - stat 先行：skills/plugins 只 readdir + stat 单一已知文件名，不读正文；
 * - 单文件读取上限：config/settings ≤1 MiB、插件 manifest ≤256 KiB；
 * - 目录项预算：每 Agent ≤500 项（超出标 limited，留给下一轮）；
 * - 结果带 60 秒内存缓存（模块级），页面加载不重复扫描；
 * - 每渠道返回 candidateCount / processedCount / bytesRead / limited 可观测字段。
 *
 * 台账身份为名字级（与 P1-4 反查一致）；路径含本机绝对路径，仅本机页面展示，
 * 不进入任何导出/分享产物。
 */

import {readdirSync, readFileSync, statSync} from "node:fs";
import {join} from "node:path";
import {homedir} from "node:os";
import {AGENT_REGISTRY, agentLabel} from "@/lib/agent-registry";

type AgentId = (typeof AGENT_REGISTRY)[number]["id"];

export type LedgerItemKind = "skill" | "mcp_server" | "plugin" | "profile";

export interface CapabilityLedgerItem {
  kind: LedgerItemKind;
  name: string;
  detail?: string;
  sourcePath?: string;
}

export type LedgerAvailability =
  | {state: "available"; dataDir: string}
  | {state: "missing"; dataDir: string};

export interface AgentCapabilityLedger {
  agentId: AgentId;
  label: string;
  availability: LedgerAvailability;
  skills: CapabilityLedgerItem[];
  mcpServers: CapabilityLedgerItem[];
  plugins: CapabilityLedgerItem[];
  /** 第三组（plugins 槽位）的展示名（dsh=Profiles），数据驱动避免 UI 层 agent 分派。 */
  pluginsLabel?: string;
  /** skills 空清单时的解释文案（opencode=内联注入形态无文件台账）。 */
  skillsEmptyNote?: string;
  scan: {
    candidateCount: number;
    processedCount: number;
    bytesRead: number;
    limited: boolean;
    scannedAt: string;
  };
}

const MAX_DIR_ENTRIES_PER_AGENT = 500;
const MAX_CONFIG_BYTES = 1024 * 1024;
const MAX_MANIFEST_BYTES = 256 * 1024;
const SCAN_CACHE_TTL_MS = 60_000;

const scanCache = new Map<string, {ledgers: AgentCapabilityLedger[]; expiresAt: number}>();

/** 入口：五 Agent 台账（60s 缓存）；homeDir 供测试注入。 */
export function scanLocalCapabilities(options?: {homeDir?: string; noCache?: boolean}): AgentCapabilityLedger[] {
  const home = options?.homeDir ?? homedir();
  const cacheKey = `home:${home}`;
  if (!options?.noCache) {
    const cached = scanCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.ledgers;
    }
  }
  const ledgers = [scanCodex(home), ...scanOthers(home)];
  scanCache.set(cacheKey, {ledgers, expiresAt: Date.now() + SCAN_CACHE_TTL_MS});
  return ledgers;
}

function freshScan(now: string): AgentCapabilityLedger["scan"] {
  return {candidateCount: 0, processedCount: 0, bytesRead: 0, limited: false, scannedAt: now};
}

function dirExists(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** 有界目录枚举：≤limit 项，超出标 limited；失败返回空（不抛）。 */
function listBounded(path: string, limit = MAX_DIR_ENTRIES_PER_AGENT): {names: string[]; limited: boolean} {
  try {
    const entries = readdirSync(path, {withFileTypes: true});
    const names = entries.slice(0, limit).filter(entry => entry.isDirectory()).map(entry => entry.name);
    return {names, limited: entries.length > limit};
  } catch {
    return {names: [], limited: false};
  }
}

function readBounded(path: string, maxBytes: number): string | undefined {
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > maxBytes) return undefined;
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/** skills 目录扫描：每个子目录 stat <name>/SKILL.md，存在即条目（不读正文）。 */
function scanSkillsDir(skillsDir: string, scan: AgentCapabilityLedger["scan"]): CapabilityLedgerItem[] {
  const {names, limited} = listBounded(skillsDir);
  scan.candidateCount += names.length;
  scan.limited = scan.limited || limited;
  const items: CapabilityLedgerItem[] = [];
  for (const name of names) {
    const skillFile = join(skillsDir, name, "SKILL.md");
    try {
      const stat = statSync(skillFile);
      if (!stat.isFile()) continue;
      scan.processedCount += 1;
      items.push({kind: "skill", name, sourcePath: skillFile});
    } catch {
      // 无 SKILL.md 的目录不是技能，不计入。
    }
  }
  return items;
}

function scanCodex(home: string): AgentCapabilityLedger {
  const scan = freshScan(new Date().toISOString());
  const dataDir = join(home, ".codex");
  const skills: CapabilityLedgerItem[] = scanSkillsDir(join(dataDir, "skills"), scan);
  // MCP servers：config.toml 的 [mcp_servers.<name>] 段头（有界读 ≤1 MiB，正则提取）。
  const mcpServers: CapabilityLedgerItem[] = [];
  const config = readBounded(join(dataDir, "config.toml"), MAX_CONFIG_BYTES);
  if (config) {
    scan.bytesRead += Buffer.byteLength(config);
    // server 名不含点：嵌套子配置段（如 [mcp_servers.node_repl.env]）不误报为 server。
    const pattern = /^\[mcp_servers\.([A-Za-z0-9_-]+)\]/gmu;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(config)) !== null) {
      mcpServers.push({kind: "mcp_server", name: match[1]!, sourcePath: join(dataDir, "config.toml")});
    }
  }
  const availability: LedgerAvailability = dirExists(dataDir)
    ? {state: "available", dataDir}
    : {state: "missing", dataDir};
  return {
    agentId: "codex",
    label: labelOf("codex"),
    availability,
    skills,
    mcpServers,
    plugins: [],
    scan,
  };
}

function scanOthers(home: string): AgentCapabilityLedger[] {
  return [scanClaudeCode(home), scanZcode(home), scanOpencode(home), scanDsh(home)];
}

function scanClaudeCode(home: string): AgentCapabilityLedger {
  const scan = freshScan(new Date().toISOString());
  const dataDir = join(home, ".claude");
  const skills = scanSkillsDir(join(dataDir, "skills"), scan);
  // MCP：settings.json 的 mcpServers 键（≤1 MiB）。
  const mcpServers: CapabilityLedgerItem[] = [];
  const settingsRaw = readBounded(join(dataDir, "settings.json"), MAX_CONFIG_BYTES);
  if (settingsRaw) {
    scan.bytesRead += Buffer.byteLength(settingsRaw);
    try {
      const settings = JSON.parse(settingsRaw) as {mcpServers?: Record<string, unknown>};
      for (const name of Object.keys(settings.mcpServers ?? {})) {
        mcpServers.push({kind: "mcp_server", name, sourcePath: join(dataDir, "settings.json")});
      }
    } catch {
      // 配置解析失败：保留空清单，availability 仍 available（目录存在）。
    }
  }
  // 插件：installed_plugins.json（v2 格式 plugins 键，≤256 KiB manifest 预算）。
  const plugins: CapabilityLedgerItem[] = [];
  const pluginsRaw = readBounded(join(dataDir, "plugins", "installed_plugins.json"), MAX_MANIFEST_BYTES);
  if (pluginsRaw) {
    scan.bytesRead += Buffer.byteLength(pluginsRaw);
    try {
      const manifest = JSON.parse(pluginsRaw) as {plugins?: Record<string, unknown>};
      for (const key of Object.keys(manifest.plugins ?? {})) {
        const name = key.split("@")[0]!;
        plugins.push({kind: "plugin", name: key, detail: name, sourcePath: join(dataDir, "plugins", "installed_plugins.json")});
        scan.processedCount += 1;
        scan.candidateCount += 1;
      }
    } catch {
      // 清单损坏保持空。
    }
  }
  return {
    agentId: "claude",
    label: labelOf("claude"),
    availability: dirExists(dataDir) ? {state: "available", dataDir} : {state: "missing", dataDir},
    skills,
    mcpServers,
    plugins,
    scan,
  };
}

function scanZcode(home: string): AgentCapabilityLedger {
  const scan = freshScan(new Date().toISOString());
  const dataDir = join(home, ".zcode");
  // 插件市场：cli/plugins/cache/<market>/<plugin>；每插件枚举其 skills/ 子目录计技能。
  const plugins: CapabilityLedgerItem[] = [];
  const skills: CapabilityLedgerItem[] = [];
  const cacheDir = join(dataDir, "cli", "plugins", "cache");
  if (dirExists(cacheDir)) {
    const markets = listBounded(cacheDir);
    scan.candidateCount += markets.names.length;
    scan.limited = scan.limited || markets.limited;
    for (const market of markets.names) {
      const pluginDirs = listBounded(join(cacheDir, market));
      scan.candidateCount += pluginDirs.names.length;
      scan.limited = scan.limited || pluginDirs.limited;
      for (const plugin of pluginDirs.names) {
        const pluginPath = join(cacheDir, market, plugin);
        plugins.push({kind: "plugin", name: `${market}/${plugin}`, sourcePath: pluginPath});
        scan.processedCount += 1;
        // 插件技能：plugin 下任意 skills 目录的子目录（广度 ≤1 层已知布局）。
        const pluginSkills = listBounded(join(pluginPath, "skills"));
        for (const skillName of pluginSkills.names) {
          skills.push({kind: "skill", name: `${plugin}:${skillName}`, sourcePath: join(pluginPath, "skills", skillName)});
          scan.processedCount += 1;
        }
      }
    }
  }
  return {
    agentId: "zcode",
    label: labelOf("zcode"),
    availability: dirExists(dataDir) ? {state: "available", dataDir} : {state: "missing", dataDir},
    skills,
    mcpServers: [],
    plugins,
    scan,
  };
}

function scanOpencode(home: string): AgentCapabilityLedger {
  const scan = freshScan(new Date().toISOString());
  const dataDir = join(home, ".config", "opencode");
  const configExists = (() => {
    try {
      return statSync(join(dataDir, "opencode.json")).isFile();
    } catch {
      return false;
    }
  })();
  // skills：配置目录下的 skill/ 目录（存在才扫；OpenCode 技能也可经 `skill` 工具
  // 描述内联注入——该形态无本机文件台账，页面如实显示 0 并注明）。
  const skills = dirExists(join(dataDir, "skill"))
    ? scanSkillsDir(join(dataDir, "skill"), scan)
    : [];
  return {
    agentId: "opencode",
    label: labelOf("opencode"),
    availability: configExists ? {state: "available", dataDir} : {state: "missing", dataDir},
    skills,
    mcpServers: [],
    plugins: [],
    skillsEmptyNote: "无本地 skill 目录（OpenCode 技能可能经 skill 工具描述内联注入，无文件台账）",
    scan,
  };
}

function scanDsh(home: string): AgentCapabilityLedger {
  const scan = freshScan(new Date().toISOString());
  const dataDir = join(home, ".dsh");
  const profiles: CapabilityLedgerItem[] = listBounded(join(dataDir, "profiles")).names
    .filter(name => name !== "node_modules")
    .map(name => ({kind: "profile" as const, name, sourcePath: join(dataDir, "profiles", name)}));
  scan.candidateCount += profiles.length;
  scan.processedCount += profiles.length;
  return {
    agentId: "dsh",
    label: labelOf("dsh"),
    availability: dirExists(dataDir) ? {state: "available", dataDir} : {state: "missing", dataDir},
    skills: [],
    mcpServers: [],
    plugins: profiles,
    pluginsLabel: "Profiles",
    scan,
  };
}

function labelOf(agentId: AgentId): string {
  return agentLabel(agentId);
}
