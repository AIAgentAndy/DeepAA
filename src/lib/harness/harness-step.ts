/**
 * Harness 证据层：Step 级 API 线类型（服务器与客户端共用，纯类型模块无运行时依赖）。
 * 响应形态见 docs/Harness能力建设一期.md §5。
 */

export type ToolKind = "tool" | "mcp";
export type SkillSourceLevel = "system" | "user" | "plugin" | "project" | "unknown";
export type RuleKind =
  | "agents_md_project"
  | "agents_md_global"
  | "claude_md_project"
  | "claude_md_global"
  | "permissions";

export interface HarnessToolItem {
  name: string;
  kind: ToolKind;
  mcpServer?: string;
  /** 定义规模估算（升级前数据为 0）。 */
  defTokensEst: number;
  callsThisStep: number;
  callsThisTurn: number;
  invoked: boolean;
}

export interface HarnessSkillItem {
  name: string;
  sourceLevel: SkillSourceLevel;
  sourceRoot?: string;
  pluginName?: string;
  estTokens: number;
}

export interface HarnessRuleItem {
  kind: RuleKind;
  path?: string;
  estTokens: number;
}

export interface HarnessSnapshotView {
  hash: string;
  shortHash: string;
  agentName: string;
  complete: boolean;
  seqInThread: number;
  coverage: { fromStepIndex: number; toStepIndex: number };
  firstSeenStepIndex: number;
}

export interface HarnessTokensView {
  byComponent: {
    toolsNonMcp: number;
    mcp: number;
    skills: number;
    rules: number;
  };
  total: number;
  /** 占全部 Input（含校准）的比例；缺失时为 undefined。 */
  shareOfInput?: number;
  calibrated: boolean;
  inputTokens?: number;
}

export interface HarnessChangesView {
  fromSnapshotHash?: string;
  fromStepIndex?: number;
  toolsAdded: string[];
  toolsRemoved: string[];
  skillsAdded: string[];
  skillsRemoved: string[];
  rulesAdded: string[];
  rulesRemoved: string[];
}

export interface HarnessCompactionView {
  kind: "detected" | "possible";
  before: number;
  after: number;
  reductionPct: number;
  messageRemoved: number;
  toolResultRemoved: number;
  /** P1：压缩证据条数（dsh purpose 头 / 续接摘要注入）。 */
  compactionEvidence: number;
  contextCompressed: boolean;
}

export interface ApiAgentStepHarness {
  stepId: string;
  exchangeId: string;
  stepIndex: number;
  project?: string;
  snapshot?: HarnessSnapshotView;
  inventory: {
    tools: HarnessToolItem[];
    skills: HarnessSkillItem[];
    rules: HarnessRuleItem[];
  };
  harnessTokens?: HarnessTokensView;
  changes?: HarnessChangesView;
  compaction?: HarnessCompactionView;
  /** true = Tier A 回填数据（有工具清单与调用，无 skills/rules/构成估算/项目）。 */
  legacyData: boolean;
  candidateCount: number;
  processedCount: number;
  limited: boolean;
}
