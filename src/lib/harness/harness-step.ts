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

/**
 * 工具传递证据来源（F11 分离）：declared = 请求 wire 声明的定义（快照清单），
 * observed_only = 仅本步调用证据、快照无对应定义——不参与「传递了多少」分母。
 */
export type ToolExposure = "declared" | "observed_only";

export interface HarnessToolItem {
  name: string;
  kind: ToolKind;
  mcpServer?: string;
  /** 定义规模估算（升级前数据为 0）。 */
  defTokensEst: number;
  callsThisStep: number;
  callsThisTurn: number;
  invoked: boolean;
  exposure: ToolExposure;
  /** F12：调用分组达处理上限时，未进入已处理集合的工具调用数不可信（未知，非 0）。 */
  callsUnknown?: boolean;
}

/**
 * F1 借补参考标注：本地导入行（官方直连日志不含 tools/skills/rules 声明）的清单
 * 借自同 Agent 近期快照。清单内容保留展示，但属「参考」，不是当次确定传递。
 */
export interface HarnessReferenceView {
  /** 被借补的组件：tools / skills / rules。 */
  borrowed: string[];
  /** donor 快照哈希（新数据带；存量旧诊断未记录时缺省）。 */
  donorSnapshotHash?: string;
  donorLastSeenAt?: string;
}

/** F12：step/turn 调用分组是否达到处理上限（超出部分的计数不可信）。 */
export interface HarnessCallsLimitedView {
  step: boolean;
  turn: boolean;
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
  /** P1-1/F10：会话首见的客户端运行版本（存量/未解析为 undefined）。 */
  agentVersion?: string;
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
    /** 请求声明清单（declared）。 */
    tools: HarnessToolItem[];
    skills: HarnessSkillItem[];
    rules: HarnessRuleItem[];
    /** F11：本步调用过但快照无定义的工具（exposure=observed_only，不算传递分母）。 */
    observedOnlyTools?: HarnessToolItem[];
  };
  harnessTokens?: HarnessTokensView;
  changes?: HarnessChangesView;
  compaction?: HarnessCompactionView;
  /** F1：清单为借补参考（本地导入行），非当次确定传递。 */
  reference?: HarnessReferenceView;
  /** F12：调用分组截断状态。 */
  callsLimited?: HarnessCallsLimitedView;
  /** I6/F5：该 Agent 的 Skills 解析能力（not_supported = 0 条显示「解析未支持」而非「无注入」）。 */
  skillsParseStatus?: "parsed" | "not_supported";
  /** true = Tier A 回填数据（有工具清单与调用，无 skills/rules/构成估算/项目）。 */
  legacyData: boolean;
  candidateCount: number;
  processedCount: number;
  limited: boolean;
}
