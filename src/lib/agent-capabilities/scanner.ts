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

import {existsSync, readdirSync, readFileSync, realpathSync, statSync} from "node:fs";
import {basename, dirname, join, sep} from "node:path";
import {homedir} from "node:os";
import {AGENT_REGISTRY, agentLabel} from "@/lib/agent-registry";

type AgentId = (typeof AGENT_REGISTRY)[number]["id"];

export type LedgerItemKind = "skill" | "mcp_server" | "plugin" | "profile" | "tool" | "rule" | "system_prompt";

export interface CapabilityLedgerItem {
  kind: LedgerItemKind;
  name: string;
  detail?: string;
  sourcePath?: string;
  /** 工具详情卡:描述文本(wire 快照提取;≤500 截断)。 */
  description?: string;
}

export type LedgerAvailability =
  | {state: "available"; dataDir: string}
  | {state: "missing"; dataDir: string};

/**
 * 跨 Agent Skill 索引(2026-11-11 核心竞争力):按 skill 名聚合各 Agent 的
 * 存在性 + 内容 hash,支持一致性判断、同步与 diff。
 */
export interface CrossAgentSkillEntry {
  name: string;
  /** 各 Agent 上的存在性与内容标识(同 Agent 同名多副本已收敛为单行)。 */
  agents: Array<{
    agentId: string;
    path: string;
    /** SKILL.md 内容 md5(仅 frontmatter+正文,不含文件元数据)。 */
    contentHash: string;
    /** 与其它 Agent 的内容是否一致(以首个非 unknown 的有效 hash 为基准)。 */
    consistent: boolean;
    detail?: string;
    description?: string;
    /** 该 Agent 侧同名物理副本数(插件多版本、系统+全局+项目并存时 >1)。 */
    variants?: number;
  }>;
  /** 内容是否跨 Agent 一致(所有存在的 hash 相同)。 */
  allConsistent: boolean;
  /** 是否存在任一可校验内容(全部 unknown 时 false,UI 显示「内容未知」而非「一致」)。 */
  contentKnown: boolean;
}

/** 扫描结果附加跨 Agent Skill 索引。 */
export interface CrossAgentSkillIndex {
  skills: CrossAgentSkillEntry[];
  /** 不一致的 skill 名列表。 */
  inconsistentNames: string[];
}

/**
 * Agent 的 skill 同步目标目录(表驱动,无 agent 名条件分派)。
 * 2026-11-12 双验收审计收窄:zcode 经插件市场管理 Skill(不读 ~/.zcode/skills)、
 * dsh 无文件化 Skill 目录——两者同步落点是扫描盲区(假成功),诚实移出支持列表。
 */
const SKILL_SYNC_TARGETS: Record<string, string> = {
  codex: "skills",
  claude: "skills",
  opencode: "skills",
};

/** 支持目录同步的 Agent 列表(UI 渲染同步按钮的唯一依据)。 */
export const SKILL_SYNC_AGENT_IDS: readonly string[] = Object.keys(SKILL_SYNC_TARGETS);

const SKILL_SYNC_BASE_DIRS: Record<string, string[]> = {
  codex: [".codex"],
  claude: [".claude"],
  zcode: [".zcode"],
  dsh: [".dsh"],
  opencode: [".config", "opencode"],
};

export function skillSyncTargetDir(home: string, agentId: string): string | undefined {
  const subDir = SKILL_SYNC_TARGETS[agentId];
  const base = SKILL_SYNC_BASE_DIRS[agentId];
  if (!subDir || !base) return undefined;
  return join(home, ...base, subDir);
}

/** 插件缓存路径的版本段:.../plugins/cache/<market>/<plugin>/<version>/skills/... */
const PLUGIN_VERSION_RE = /[\\/]plugins[\\/]cache[\\/][^\\/]+[\\/][^\\/]+[\\/]([^\\/]+)[\\/]skills[\\/]/;

function pluginVersionOf(path: string): string | undefined {
  return PLUGIN_VERSION_RE.exec(path)?.[1];
}

/** 点分版本比较,>0 表示 a 更新;数字段数值比较,非数字段退化为字符串比较。 */
function compareDottedVersion(a: string, b: string): number {
  const pa = a.split(".");
  const pb = b.split(".");
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const sa = pa[i] ?? "";
    const sb = pb[i] ?? "";
    const na = Number(sa);
    const nb = Number(sb);
    const cmp = sa !== "" && sb !== "" && Number.isFinite(na) && Number.isFinite(nb)
      ? na - nb
      : sa.localeCompare(sb);
    if (cmp !== 0) return cmp;
  }
  return 0;
}

/**
 * 项目清单池(2026-11-12 用户拉齐方案):各 Agent 配置文件是项目清单的权威来源——
 * codex config.toml [projects."path"] 段、claude ~/.claude.json projects 键、
 * zcode 会话库 session.directory、dsh 会话目录名(路径编码,存在性回溯解码);
 * UGit 两层扫描保留兜底。池内项目对每个 Agent 探测自身 skills 目录与共享
 * .agents/skills(自身目录优先、同名去重)。
 */
export interface ProjectPoolEntry {
  /** 展示名(basename;跨路径重名时带父段消歧,如 web/OPlusWeb)。 */
  name: string;
  /** realpath 绝对路径(同步白名单同样信任此集合)。 */
  path: string;
}

const MAX_PROJECT_POOL = 60;
/**
 * 候选收集上限(过滤前):配置源(zcode DISTINCT≤200+codex+claude+dsh)与 UGit 兜底
 * 合计留足余量(逻辑审计 MEDIUM:300 时 236 个无技能候选即可把 UGit 挤出候选集);
 * 过滤(含 skills 目录)后 cap 到池上限。仅收集路径+stat,600 约几毫秒。
 * 注:.opencode/skills 不在准入候选——opencode 无项目级 own 扫描,入池即"白名单
 * 可见却无人可见"的不一致(逻辑审计 LOW)。
 */
const MAX_PROJECT_CANDIDATES = 600;
/** 项目内任一 Agent 的 skills 目录(共享 + 各 Agent 自身)。 */
const PROJECT_SKILL_DIR_CANDIDATES = [".agents/skills", ".codex/skills", ".claude/skills"];
const PROJECT_POOL_TTL_MS = 60_000;
const projectPoolCache = new Map<string, {pool: ProjectPoolEntry[]; expiresAt: number}>();

/** 项目内该 Agent 自身的 skills 目录(共享 .agents/skills 对所有 Agent 另行探测)。 */
const AGENT_PROJECT_SKILL_DIRS: Record<string, string[]> = {
  codex: [".codex/skills"],
  claude: [".claude/skills"],
  zcode: [],
  dsh: [],
  opencode: [],
};

/**
 * dsh 会话目录名解码:--Users-andy-...-deepaa-- → 存在性校验的绝对路径(段名可含 '-',回溯合并)。
 * 防御(2026-11-12 逻辑审计 HIGH):① token 硬上界 16(会话名 255 字节,不设界时
 * 已删项目的长名会全组合枚举,实测 26 token ≈117s 阻塞事件循环);② 每步合并后
 * 即校验前缀目录存在——合法完整路径的每个前缀必是真实目录,剪枝使实际搜索
 * 沿真实目录树下降,不再指数膨胀。
 */
const DSH_DECODE_MAX_TOKENS = 16;
function decodeDshSessionDir(name: string, home: string): string | undefined {
  if (!name.startsWith("--")) return undefined;
  const tokens = name.replace(/^-+/, "").replace(/-+$/, "").split("-").filter(t => t.length > 0);
  if (tokens.length < 2 || tokens.length > DSH_DECODE_MAX_TOKENS) return undefined;
  const tryBuild = (start: number, acc: string[]): string | undefined => {
    if (start >= tokens.length) {
      const p = join(sep, ...acc);
      if (!p.startsWith(home + sep)) return undefined;
      return dirExists(p) ? p : undefined;
    }
    // 长段优先:真实目录名含 '-' 时(如 template-factory)需要合并相邻 token。
    for (let end = tokens.length; end > start; end--) {
      const merged = tokens.slice(start, end).join("-");
      const prefix = join(sep, ...acc, merged);
      if (!dirExists(prefix)) continue; // 前缀剪枝:合法路径的每级前缀必须是真实目录
      const found = tryBuild(end, [...acc, merged]);
      if (found) return found;
    }
    return undefined;
  };
  return tryBuild(0, []);
}

/** 有界读文本(≤maxBytes,超限/缺失返回 undefined)。 */
function readBoundedText(path: string, maxBytes: number): string | undefined {
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > maxBytes) return undefined;
    return readFileSync(path, "utf8");
  } catch { return undefined; }
}

export function collectProjectPool(home: string, options?: {noCache?: boolean}): ProjectPoolEntry[] {
  if (!options?.noCache) {
    const cached = projectPoolCache.get(home);
    if (cached && cached.expiresAt > Date.now()) return cached.pool;
  }
  const byReal = new Map<string, string>();
  // mkdtemp 等场景 home 自身是符号链接(macOS /var → /private/var):两个形态都接受。
  let homeReal = home;
  try { homeReal = realpathSync(home); } catch { /* 保持原样 */ }
  const underHome = (p: string): boolean => p.startsWith(home + sep) || p.startsWith(homeReal + sep);
  const add = (candidate: string): void => {
    if (byReal.size >= MAX_PROJECT_CANDIDATES || typeof candidate !== "string" || !candidate.startsWith("/")) return;
    let real: string;
    try { real = realpathSync(candidate); } catch { return; }
    if (!underHome(real)) return;
    try { if (!statSync(real).isDirectory()) return; } catch { return; }
    if (!byReal.has(real)) byReal.set(real, basename(real));
  };

  // ① codex:config.toml 的 [projects."<path>"] 段键。
  const codexToml = readBoundedText(join(home, ".codex", "config.toml"), MAX_CONFIG_BYTES);
  if (codexToml) {
    for (const m of codexToml.matchAll(/^\[projects\."([^"]+)"\]/gm)) add(m[1]!);
  }
  // ② claude:~/.claude.json 顶层 projects 键(≤1 MiB 有界)。
  const claudeJson = readBoundedText(join(home, ".claude.json"), MAX_CONFIG_BYTES);
  if (claudeJson) {
    try {
      const parsed = JSON.parse(claudeJson) as {projects?: Record<string, unknown>};
      for (const p of Object.keys(parsed.projects ?? {})) add(p);
    } catch { /* 损坏降级 */ }
  }
  // ③ zcode:会话库 session.directory 去重(readonly 连接)。
  try {
    const {DeepaaDatabase: Db} = require("@/lib/db/sqlite-driver") as typeof import("@/lib/db/sqlite-driver");
    const db = new Db(join(home, ".zcode", "cli", "db", "db.sqlite"), {readonly: true, timeout: 3_000});
    try {
      const rows = db.prepare(
        "SELECT DISTINCT directory FROM session WHERE directory IS NOT NULL LIMIT 200",
      ).all() as Array<{directory: string}>;
      for (const row of rows) add(row.directory);
    } finally { db.close(); }
  } catch { /* 库缺失/锁定属正常 */ }
  // ④ dsh:会话目录名解码。
  try {
    for (const dir of listBounded(join(home, ".dsh", "sessions")).names.slice(0, 40)) {
      const decoded = decodeDshSessionDir(dir, home);
      if (decoded) add(decoded);
    }
  } catch { /* 目录缺失属正常 */ }
  // ⑤ UGit 两层扫描兜底(用户确认保留)。
  try {
    const workspaceRoot = join(home, "Documents", "UGit");
    const walk = (dir: string, depth: number): void => {
      if (byReal.size >= MAX_PROJECT_CANDIDATES || depth > 2) return;
      let entries;
      try { entries = readdirSync(dir, {withFileTypes: true}); } catch { return; }
      for (const entry of entries) {
        if (byReal.size >= MAX_PROJECT_CANDIDATES) break;
        if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
        const projPath = join(dir, entry.name);
        add(projPath);
        if (depth < 2) walk(projPath, depth + 1);
      }
    };
    walk(workspaceRoot, 0);
  } catch { /* 工作区不存在属正常。 */ }

  /* 过滤:只保留含任一 skills 目录的项目(会话/清单里的临时目录、深层子目录
   * 不占池位——否则配置源几十个无技能路径把池塞满,UGit 兜底的真实项目被截断,
   * deepseek-harness 等 24 个技能实测丢失)。 */
  const skilled = [...byReal.keys()].filter(real =>
    PROJECT_SKILL_DIR_CANDIDATES.some(rel => dirExists(join(real, rel))));
  const chosen = skilled.slice(0, MAX_PROJECT_POOL);
  // 重名消歧(在截断后的幸存集内计数):同名项目带父段(如 web/OPlusWeb)。
  const nameCount = new Map<string, number>();
  for (const real of chosen) nameCount.set(byReal.get(real)!, (nameCount.get(byReal.get(real)!) ?? 0) + 1);
  const pool: ProjectPoolEntry[] = chosen.map(real => {
    const base = byReal.get(real)!;
    return {
      name: (nameCount.get(base) ?? 0) > 1 ? `${basename(dirname(real))}/${base}` : base,
      path: real,
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
  projectPoolCache.set(home, {pool, expiresAt: Date.now() + PROJECT_POOL_TTL_MS});
  return pool;
}

type SkillAgentRow = CrossAgentSkillEntry["agents"][number];

/**
 * 同一 Agent 同名副本择一(HIGH-2 修复):插件多版本取最新版;
 * 带版本层的新布局优先于旧无版本布局;其余稳定保留首见。
 * 注意:「系统+全局」同名并存不会走到这里——全局/项目合并层已按名去重
 * (Agent 自身目录优先,见 scanLocalCapabilities 合并逻辑),到达索引层的
 * 同 Agent 多副本基本只有插件缓存多版本与双市场 legacy 布局两种形态。
 */
function pickSkillVariantRow(prev: SkillAgentRow, next: Omit<SkillAgentRow, "variants">): Omit<SkillAgentRow, "variants"> {
  const pv = pluginVersionOf(prev.path);
  const nv = pluginVersionOf(next.path);
  if (pv === undefined && nv === undefined) return prev;
  if (pv === undefined) return next;
  if (nv === undefined) return prev;
  return compareDottedVersion(nv, pv) > 0 ? next : prev;
}

export interface AgentCapabilityLedger {
  agentId: AgentId;
  label: string;
  availability: LedgerAvailability;
  skills: CapabilityLedgerItem[];
  mcpServers: CapabilityLedgerItem[];
  plugins: CapabilityLedgerItem[];
  /** 核心价值①(2026-11-06):工具清单——wire 快照观测(有描述/定义规模)。 */
  tools: CapabilityLedgerItem[];
  /** UI 重构(2026-11-10):规则(AGENTS.md/CLAUDE.md/permissions)与系统提示词。 */
  rules: CapabilityLedgerItem[];
  systemPrompts: CapabilityLedgerItem[];
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

const scanCache = new Map<string, {ledgers: AgentCapabilityLedger[]; expiresAt: number; crossAgentIndex: CrossAgentSkillIndex}>();

/** 同步写盘后使扫描缓存与项目清单池立即失效,详情/索引/白名单反映最新内容。 */
export function invalidateCapabilityScanCache(): void {
  scanCache.clear();
  projectPoolCache.clear();
}

/** 入口：五 Agent 台账（60s 缓存）；homeDir 供测试注入。 */
export function scanLocalCapabilities(options?: {
  homeDir?: string;
  noCache?: boolean;
  dataDir?: string;
}): AgentCapabilityLedger[] {
  const home = options?.homeDir ?? homedir();
  const cacheKey = `home:${home}`;
  if (!options?.noCache) {
    const cached = scanCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return Object.assign(cached.ledgers, {crossAgentIndex: cached.crossAgentIndex}) as AgentCapabilityLedger[] & {crossAgentIndex: CrossAgentSkillIndex};
    }
  }
  const ledgers = [scanCodex(home), ...scanOthers(home)];
  // 核心价值①(2026-11-06):从 wire 快照提取工具清单——五 Agent 已捕获的
  // harness_snapshots.tools_json 含 name+schemaTokensEst(名字级),按 Agent 聚合
  // 去重后作为台账工具通道(「本地安装/网关观测」两个维度的一侧)。
  try {
    const dataDir = options?.dataDir ?? process.env.DEEPAA_DATA_DIR ?? join(home, ".deepaa");
    const dbPath = join(dataDir, "deepaa.sqlite");
    if (existsSync(dbPath)) {
      const {DeepaaDatabase: Db} = require("@/lib/db/sqlite-driver") as typeof import("@/lib/db/sqlite-driver");
      const db = new Db(dbPath, {readonly: true, timeout: 3_000});
      try {
        db.pragma("busy_timeout = 3000");
        const rows = db.prepare(
          `SELECT agent_name, tools_json FROM harness_snapshots
           WHERE agent_name IS NOT NULL AND tool_count > 0
           ORDER BY last_seen_at DESC LIMIT 500`,
        ).all() as Array<{agent_name: string; tools_json: string}>;
        const toolsByAgent = new Map<string, Map<string, {item: CapabilityLedgerItem; lastSeen: number}>>();
        for (const row of rows) {
          let tools: Array<{name?: string; kind?: string; mcpServer?: string; schemaTokensEst?: number; description?: string; paramNames?: string}>;
          try {
            tools = JSON.parse(row.tools_json);
          } catch { continue; }
          const agentTools = toolsByAgent.get(row.agent_name) ?? new Map();
          for (const tool of tools) {
            if (!tool?.name) continue;
            const existing = agentTools.get(tool.name);
            if (existing) {
              existing.lastSeen += 1;
              continue;
            }
            agentTools.set(tool.name, {
              item: {
                kind: "tool",
                name: tool.name,
                ...(tool.mcpServer ? {detail: `MCP · ${tool.mcpServer}`} : tool.kind === "mcp" ? {detail: "MCP"} : {detail: "内置/普通"}),
                ...((tool as {description?: string}).description
                  ? {description: (tool as {description: string}).description} : {}),
              },
              lastSeen: 1,
            });
          }
          toolsByAgent.set(row.agent_name, agentTools);
        }
        for (const ledger of ledgers) {
          const agentTools = toolsByAgent.get(ledger.agentId);
          if (!agentTools) continue;
          const items = [...agentTools.values()]
            .sort((a, b) => b.lastSeen - a.lastSeen || a.item.name.localeCompare(b.item.name))
            .slice(0, 500)
            .map(v => v.item);
          ledger.tools = items;
        }
      } finally {
        db.close();
      }
    }
  } catch {
    // 快照工具提取失败不影响台账(本地配置扫描已有)。
  }
  // P0-4.3(2026-11-11):全局 ~/.agents/skills/(跨 Agent 共享)+ 项目级 .agents/skills/。
  const globalScan: AgentCapabilityLedger["scan"] = {candidateCount: 0, processedCount: 0, bytesRead: 0, limited: false, scannedAt: new Date().toISOString()};
  const globalAgentSkills = scanSkillsWithDesc(join(home, ".agents", "skills"), globalScan);
  /* 2026-11-12 用户拉齐方案:项目技能来自清单池(collectProjectPool),
   * 每项目探测各 Agent 自身 skills 目录 + 共享 .agents/skills(共享只扫一次)。
   * 旧 UGit 两层扫描并入清单池兜底,不再独立成路。 */
  const projectPool = collectProjectPool(home);
  const projectSkillsList: Array<{project: string; items: CapabilityLedgerItem[]; ownByAgent: Map<string, CapabilityLedgerItem[]>}> = [];
  for (const proj of projectPool) {
    const ownByAgent = new Map<string, CapabilityLedgerItem[]>();
    let shared: CapabilityLedgerItem[] = [];
    const sharedDir = join(proj.path, ".agents", "skills");
    if (dirExists(sharedDir)) {
      const pScan: AgentCapabilityLedger["scan"] = {candidateCount: 0, processedCount: 0, bytesRead: 0, limited: false, scannedAt: new Date().toISOString()};
      shared = scanSkillsWithDesc(sharedDir, pScan);
    }
    for (const ledger of ledgers) {
      for (const rel of AGENT_PROJECT_SKILL_DIRS[ledger.agentId] ?? []) {
        const ownDir = join(proj.path, rel);
        if (!dirExists(ownDir)) continue;
        const pScan: AgentCapabilityLedger["scan"] = {candidateCount: 0, processedCount: 0, bytesRead: 0, limited: false, scannedAt: new Date().toISOString()};
        const items = scanSkillsWithDesc(ownDir, pScan);
        if (items.length > 0) ownByAgent.set(ledger.agentId, [...(ownByAgent.get(ledger.agentId) ?? []), ...items]);
      }
    }
    if (shared.length > 0 || ownByAgent.size > 0) {
      projectSkillsList.push({project: proj.name, items: shared, ownByAgent});
    }
  }

  // UI 重构(2026-11-10):集中填充规则与系统提示词(表驱动,无 agent 名条件分派)。
  const RULE_SOURCES: Record<string, Array<{label: string; path: string}>> = {
    codex: [
      {label: "全局 AGENTS.md", path: join(home, "AGENTS.md")},
      {label: "config.toml", path: join(home, ".codex", "config.toml")},
    ],
    claude: [
      {label: "全局 AGENTS.md", path: join(home, "AGENTS.md")},
      {label: "全局 CLAUDE.md", path: join(home, ".claude", "CLAUDE.md")},
      {label: "settings.json(env)", path: join(home, ".claude", "settings.json")},
    ],
    zcode: [
      {label: "全局 AGENTS.md", path: join(home, "AGENTS.md")},
      {label: "provider_config.json", path: join(home, ".zcode", "v2", "provider_config.json")},
    ],
    dsh: [{label: "全局 AGENTS.md", path: join(home, "AGENTS.md")}],
    opencode: [{label: "全局 AGENTS.md", path: join(home, "AGENTS.md")}],
  };
  const PROMPT_SOURCES: Record<string, Array<{name: string; path: string}>> = {
    codex: [{name: "会话基础指令", path: join(home, ".codex", "instructions.md")}],
    claude: [{name: "全局 CLAUDE.md(注入)", path: join(home, ".claude", "CLAUDE.md")}],
  };
  for (const ledger of ledgers) {
    // P0-4.3:合并全局+项目级 skills(去重后追加,detail 标来源)。
    const existingNames = new Set(ledger.skills.map(s => s.name));
    const extraSkills: CapabilityLedgerItem[] = [];
    for (const g of globalAgentSkills) {
      if (!existingNames.has(g.name)) {
        extraSkills.push({...g, detail: "用户全局"});
        existingNames.add(g.name);
      }
    }
    for (const proj of projectSkillsList) {
      // 该 Agent 自身项目目录优先(如 <项目>/.codex/skills),共享 .agents/skills 其次。
      for (const item of proj.ownByAgent.get(ledger.agentId) ?? []) {
        if (!existingNames.has(item.name)) {
          extraSkills.push({...item, detail: `项目 · ${proj.project}`});
          existingNames.add(item.name);
        }
      }
      for (const item of proj.items) {
        if (!existingNames.has(item.name)) {
          extraSkills.push({...item, detail: `项目 · ${proj.project}`});
          existingNames.add(item.name);
        }
      }
    }
    ledger.skills = [...ledger.skills, ...extraSkills];

    if (ledger.rules.length === 0) {
      ledger.rules = scanRuleFiles(home, RULE_SOURCES[ledger.agentId] ?? []);
      ledger.systemPrompts = scanSystemPrompts(home, ledger.agentId, PROMPT_SOURCES[ledger.agentId] ?? []);
    }
  }
  // 跨 Agent Skill 索引:按名字聚合 + md5 一致性检测。
  const {createHash} = require("node:crypto") as typeof import("node:crypto");
  const skillByName = new Map<string, CrossAgentSkillEntry>();
  for (const ledger of ledgers) {
    for (const skill of ledger.skills) {
      let entry = skillByName.get(skill.name);
      if (!entry) {
        entry = {name: skill.name, agents: [], allConsistent: true, contentKnown: false};
        skillByName.set(skill.name, entry);
      }
      // 计算 SKILL.md 内容 hash(有界读取 ≤100KiB)。
      let contentHash = "unknown";
      if (skill.sourcePath) {
        try {
          // sourcePath 是 skill 目录,hash 对象是其中的 SKILL.md(≤100KiB)。
          const skillMd = join(skill.sourcePath, "SKILL.md");
          const stat = statSync(skillMd);
          if (stat.isFile() && stat.size <= 100 * 1024) {
            contentHash = createHash("md5").update(readFileSync(skillMd)).digest("hex");
          }
        } catch { /* 不可读保持 unknown */ }
      }
      // HIGH-2 修复:同一 Agent 同名多副本收敛为单行(择一规则见 pickSkillVariantRow),
      // 一致性推迟到终态统一计算——避免 zcode 插件多版本自比污染跨 Agent 判定。
      const row = {
        agentId: ledger.agentId,
        path: skill.sourcePath ?? "",
        contentHash,
        consistent: true,
        ...(skill.detail ? {detail: skill.detail} : {}),
        ...(skill.description ? {description: skill.description} : {}),
      };
      const idx = entry.agents.findIndex(a => a.agentId === ledger.agentId);
      if (idx === -1) entry.agents.push({...row, variants: 1});
      else {
        const prev = entry.agents[idx]!;
        entry.agents[idx] = {...pickSkillVariantRow(prev, row), variants: (prev.variants ?? 1) + 1};
      }
    }
  }
  // 一致性终态计算:基准 = agents 顺序上首个非 unknown hash;unknown 不参与判断。
  for (const entry of skillByName.values()) {
    const baseline = entry.agents.find(a => a.contentHash !== "unknown");
    entry.contentKnown = baseline !== undefined;
    for (const a of entry.agents) {
      a.consistent = a.contentHash === "unknown" || !baseline || a.contentHash === baseline.contentHash;
    }
    entry.allConsistent = entry.agents.every(a => a.consistent);
  }
  const crossAgentIndex: CrossAgentSkillIndex = {
    skills: [...skillByName.values()].sort((a, b) => a.name.localeCompare(b.name)),
    inconsistentNames: [...skillByName.values()].filter(e => !e.allConsistent).map(e => e.name),
  };

  scanCache.set(cacheKey, {ledgers, expiresAt: Date.now() + SCAN_CACHE_TTL_MS, crossAgentIndex});
  return Object.assign(ledgers, {crossAgentIndex}) as AgentCapabilityLedger[] & {crossAgentIndex: CrossAgentSkillIndex};
}

import {openSync, readSync, closeSync} from "node:fs";

/**
 * P0-4.4(2026-11-11):有界读取 SKILL.md frontmatter 的 description。
 * 只读前 2KiB,逐行匹配 YAML name:/description:(支持单行和多行 > 折叠)。
 */
const SKILL_META_MAX_BYTES = 2 * 1024;

function readSkillDescription(skillDir: string): {description?: string} {
  const skillFile = join(skillDir, "SKILL.md");
  try {
    const stat = statSync(skillFile);
    if (!stat.isFile()) return {};
    const fd = openSync(skillFile, "r");
    try {
      const length = Math.min(stat.size, SKILL_META_MAX_BYTES);
      const buffer = Buffer.alloc(length);
      const read = readSync(fd, buffer, 0, length, 0);
      const text = buffer.subarray(0, read).toString("utf8");
      const fmStart = text.indexOf("---");
      if (fmStart < 0) return {};
      const fmEnd = text.indexOf("---", fmStart + 3);
      const fm = fmEnd > fmStart ? text.slice(fmStart + 3, fmEnd) : "";
      const descMatch = /^description:\s*(.+)$/m.exec(fm);
      if (descMatch) {
        let desc = descMatch[1].trim();
        // 修复(2026-11-11 双路审核):多行折叠(>/|/>-/|-)时,split("\n") 首元素
        // 是空行(不以缩进开头),旧逻辑立即 break → 多行格式 100% 提取失败。
        // 修复:跳过空行;折叠指示符放宽为 /^[>|][+-]?$/。
        if (/^[>|][+-]?$/.test(desc)) {
          const lines: string[] = [];
          const after = fm.slice(fm.indexOf("description:") + descMatch[0].length);
          for (const line of after.split("\n")) {
            if (line === "") {
              if (lines.length === 0) continue; // 跳过折叠指示符后的前导空行
              break; // 已有内容后的空行 = 多行块结束
            }
            if (line.startsWith("  ") || line.startsWith("\t")) lines.push(line.trim());
            else break;
          }
          desc = lines.join(" ");
        }
        desc = desc.replace(/^["']|["']$/g, "").trim();
        return desc ? {description: desc.slice(0, 500)} : {};
      }
      return {};
    } finally {
      try { closeSync(fd); } catch { /* ignore */ }
    }
  } catch {
    return {};
  }
}

/** P0-4.3:扩展 scanSkillsDir 为带 description 版本。 */
function scanSkillsWithDesc(skillsDir: string, scan: AgentCapabilityLedger["scan"]): CapabilityLedgerItem[] {
  const {names, limited} = listBounded(skillsDir);
  scan.candidateCount += names.length;
  scan.limited = scan.limited || limited;
  const items: CapabilityLedgerItem[] = [];
  for (const name of names) {
    const dir = join(skillsDir, name);
    try {
      const skillFile = join(dir, "SKILL.md");
      const stat = statSync(skillFile);
      if (!stat.isFile()) continue;
      scan.processedCount += 1;
      const {description} = readSkillDescription(dir);
      items.push({kind: "skill", name, sourcePath: dir, ...(description ? {description} : {})}); // Fix HIGH-1: 目录路径(同步 API 契约)
    } catch {
      // 无 SKILL.md 的目录不是技能。
    }
  }
  return items;
}

/**
 * UI 重构(2026-11-10):扫描 Agent 的规则文件(AGENTS.md/CLAUDE.md/.cursorrules 等)。
 * 有界读取前 1KiB 判断存在性,不读全文。
 */
function scanRuleFiles(home: string, paths: Array<{label: string; path: string}>): CapabilityLedgerItem[] {
  const items: CapabilityLedgerItem[] = [];
  for (const {label, path} of paths) {
    try {
      const stat = statSync(path);
      if (!stat.isFile() || stat.size > MAX_CONFIG_BYTES) continue;
      items.push({kind: "rule", name: label, detail: `${(stat.size / 1024).toFixed(1)} KiB`, sourcePath: path});
    } catch {
      // 文件不存在属正常。
    }
  }
  return items;
}

function scanSystemPrompts(home: string, _agent: string, candidates: Array<{name: string; path: string}>): CapabilityLedgerItem[] {
  const items: CapabilityLedgerItem[] = [];
  for (const {name, path} of candidates) {
    try {
      const stat = statSync(path);
      if (!stat.isFile()) continue;
      items.push({kind: "system_prompt", name, detail: `${(stat.size / 1024).toFixed(1)} KiB`, sourcePath: path});
    } catch {
      // 不存在属正常。
    }
  }
  return items;
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

function scanCodex(home: string): AgentCapabilityLedger {
  const scan = freshScan(new Date().toISOString());
  const dataDir = join(home, ".codex");
  const skills: CapabilityLedgerItem[] = scanSkillsWithDesc(join(dataDir, "skills"), scan);
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
    tools: [],
    rules: [],
    systemPrompts: [],
    scan,
  };
}

function scanOthers(home: string): AgentCapabilityLedger[] {
  return [scanClaudeCode(home), scanZcode(home), scanOpencode(home), scanDsh(home)];
}

function scanClaudeCode(home: string): AgentCapabilityLedger {
  const scan = freshScan(new Date().toISOString());
  const dataDir = join(home, ".claude");
  const skills = scanSkillsWithDesc(join(dataDir, "skills"), scan);
  // MCP：settings.json + ~/.claude.json 双源（审计 P1-4——用户级 MCP 在后者顶层,
  // 本机实测 myFileSystem/chrome-devtools;项目级在 projects 键下）。
  const mcpServers: CapabilityLedgerItem[] = [];
  const mcpNames = new Set<string>();
  const settingsRaw = readBounded(join(dataDir, "settings.json"), MAX_CONFIG_BYTES);
  if (settingsRaw) {
    scan.bytesRead += Buffer.byteLength(settingsRaw);
    try {
      const settings = JSON.parse(settingsRaw) as {mcpServers?: Record<string, unknown>};
      for (const name of Object.keys(settings.mcpServers ?? {})) {
        if (mcpNames.has(name)) continue;
        mcpNames.add(name);
        mcpServers.push({kind: "mcp_server", name, sourcePath: join(dataDir, "settings.json")});
      }
    } catch {
      // 配置解析失败：保留空清单，availability 仍 available（目录存在）。
    }
  }
  const claudeJsonRaw = readBounded(join(home, ".claude.json"), MAX_CONFIG_BYTES);
  if (claudeJsonRaw) {
    scan.bytesRead += Buffer.byteLength(claudeJsonRaw);
    try {
      const claudeJson = JSON.parse(claudeJsonRaw) as {
        mcpServers?: Record<string, unknown>;
        projects?: Record<string, {mcpServers?: Record<string, unknown>}>;
      };
      for (const name of Object.keys(claudeJson.mcpServers ?? {})) {
        if (mcpNames.has(name)) continue;
        mcpNames.add(name);
        mcpServers.push({kind: "mcp_server", name, sourcePath: join(home, ".claude.json")});
      }
      for (const [projectPath, project] of Object.entries(claudeJson.projects ?? {})) {
        for (const name of Object.keys(project.mcpServers ?? {})) {
          if (mcpNames.has(name)) continue;
          mcpNames.add(name);
          mcpServers.push({kind: "mcp_server", name, detail: `项目 · ${projectPath.split("/").pop()}`, sourcePath: join(home, ".claude.json")});
        }
      }
    } catch {
      // 同上,损坏不阻断。
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
    tools: [],
    rules: [],
    systemPrompts: [],
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
        // 插件技能：审计 P0-2 修复——实际布局 cache/<market>/<plugin>/<version>/skills
        // (本机实测 17 插件全带版本层);兼容无版本层旧布局。
        const versionDirs = listBounded(pluginPath);
        for (const ver of versionDirs.names) {
          const verSkillsDir = join(pluginPath, ver, "skills");
          if (!dirExists(verSkillsDir)) continue;
          for (const skillName of listBounded(verSkillsDir).names) {
            const {description: sd} = readSkillDescription(join(verSkillsDir, skillName)); skills.push({kind: "skill", name: `${plugin}:${skillName}`, sourcePath: join(verSkillsDir, skillName), ...(sd ? {description: sd} : {})});
            scan.processedCount += 1;
          }
        }
        const legacySkillsDir = join(pluginPath, "skills");
        if (dirExists(legacySkillsDir)) {
          for (const skillName of listBounded(legacySkillsDir).names) {
            const {description: sd} = readSkillDescription(join(legacySkillsDir, skillName)); skills.push({kind: "skill", name: `${plugin}:${skillName}`, sourcePath: join(legacySkillsDir, skillName), ...(sd ? {description: sd} : {})});
            scan.processedCount += 1;
          }
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
    tools: [],
    rules: [],
    systemPrompts: [],
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
  // 审计 P0-3 修复:实际目录名是 skills(复数,本机实测 10 个技能);兼容 skill。
  const opencodeSkillsDir = dirExists(join(dataDir, "skills"))
    ? join(dataDir, "skills")
    : dirExists(join(dataDir, "skill")) ? join(dataDir, "skill") : undefined;
  const skills = opencodeSkillsDir ? scanSkillsWithDesc(opencodeSkillsDir, scan) : [];
  return {
    agentId: "opencode",
    label: labelOf("opencode"),
    availability: configExists ? {state: "available", dataDir} : {state: "missing", dataDir},
    skills,
    mcpServers: [],
    plugins: [],
    tools: [],
    rules: [],
    systemPrompts: [],
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
    tools: [],
    rules: [],
    systemPrompts: [],
    pluginsLabel: "Profiles",
    scan,
  };
}

function labelOf(agentId: AgentId): string {
  return agentLabel(agentId);
}
