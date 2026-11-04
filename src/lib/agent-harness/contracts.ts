/**
 * P1-2（2026-11-03，2026-11-04 审计修订）：Step 能力契约（docs/Agent底层Harness
 * 剖析与推进方案-2026-10-30.md §15.1 最小版）。「响应」面板与「请求」摘要共用同一
 * 契约（同一次拉取、同一组数字）；能力清单页签仍消费既有 loadStepHarness 全量
 * 契约（逐步迁移中，两边的 declared/observedOnly 口径同源）。口径来自 I1 起的可信
 * 查询（declared / observed_only 分离、借补参考、调用受限未知）。
 *
 * 当前为最小版：延迟加载（deferred）/动态发现明细待真实 wire 样本接入后扩展，
 * 不以未验证字段占位。
 */

import type { HarnessReferenceView } from "../harness/harness-step";

export type SkillsParseStatus = "parsed" | "not_supported";

/** Step 级能力摘要：传递 × 使用 × 诚实性标注的单对象视图。 */
export interface StepCapabilitySummary {
  stepId: string;
  exchangeId: string;
  scope: "step";
  agentName?: string;
  /** P1-1/F10：会话首见客户端运行版本。 */
  agentVersion?: string;

  /** 传递口径（快照声明清单；reference 存在时为参考口径）。 */
  declaredToolCount: number;
  mcpServerCount: number;
  /** Skills 目录条目数（三态见 skillsParseStatus）。 */
  skillCount: number;
  skillsParseStatus: SkillsParseStatus;

  /** 活动口径（本步真实调用；次数按 occurrence、种类按工具名去重）。 */
  invokedToolKinds: number;
  /** 本步调用次数。callsLimited.step=true 时此数为下界（超出分组的调用未计入）。 */
  invokedToolCalls: number;
  /** 本 Turn 累计调用次数（§14.2.7 最小版「截至本步的回合汇总」；截断时为下界）。 */
  turnInvokedCalls: number;
  /**
   * 声明且未调用。callsLimited.step=true 时被截断工具可能已调用却被计入未调用，
   * 此数为上界（审计修订：旧注释「下界」方向写反），须配合 callsLimited 展示。
   */
  notInvokedDeclaredCount: number;
  /** 已调用但无传递定义（不进传递分母）。 */
  observedOnlyCount: number;

  /** 诚实性标注（缺失即确定口径）。 */
  reference?: HarnessReferenceView;
  callsLimited?: { step: boolean; turn: boolean };
  /** 快照 JSON 完整（截断=false）。 */
  inputComplete?: boolean;

  /** Tier A 回填/升级前数据：清单与构成为旧口径（诚实披露，不伪装成 0 能力）。 */
  legacyData?: boolean;
  /** 无快照（升级前 Step / 未捕获清单）：0 声明不代表没传，调用证据仍见 observed_only。 */
  noSnapshot?: boolean;
  /** 服务端附加的数据版本（route 层 dataVersion 透传，客户端缓存键使用）。 */
  dataVersion?: string;

  candidateCount: number;
  processedCount: number;
  limited: boolean;
}

export type StepCapabilityItemKind =
  | "declared_tool"
  | "observed_tool"
  | "skill"
  | "mcp_server";

export interface StepCapabilityItem {
  kind: StepCapabilityItemKind;
  name: string;
  mcpServer?: string;
  invoked: boolean;
  callsThisStep: number;
  callsThisTurn: number;
  /** F12：调用分组截断时未处理工具的调用数未知。 */
  callsUnknown?: boolean;
  defTokensEst: number;
  /** skill 专属：来源级别与插件推断。 */
  sourceLevel?: string;
  pluginName?: string;
  estTokens?: number;
}

/** items 分类页：keyset（name 游标），candidateCount 为该分类全集数。 */
export interface StepCapabilityItemsPage {
  stepId: string;
  kind: string;
  items: StepCapabilityItem[];
  candidateCount: number;
  processedCount: number;
  limited: boolean;
  hasMore: boolean;
  nextCursor?: string;
}

/** items 查询参数（route 校验用）。 */
export interface StepCapabilityItemsQuery {
  kind: "tools" | "observed" | "skills" | "mcp";
  limit: number;
  cursor?: string;
}

export const STEP_CAPABILITY_ITEMS_DEFAULT_LIMIT = 50;
export const STEP_CAPABILITY_ITEMS_MAX_LIMIT = 200;
