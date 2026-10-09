/**
 * Agent 本地数据源导入（双链路观测，2026-09-15）：Agent 官方客户端直连官方端点时
 * （享官方签名/活动权益），DeepAA 只读导入其在本机落盘的会话与用量数据，合成为
 * 标准 v2 raw 记录，进入与网关链路完全相同的 Worker 派生管线。
 *
 * 本模块只封装「该 Agent 在本机落了什么、怎么读、怎么对齐 DeepAA」的 Agent 差异；
 * 公共编排（调度、绑定推导、合成、落盘）在 scheduler/synthetic-capture/binding。
 * 红线：对 Agent 本地数据全程只读，绝不 checkpoint、绝不写入。
 */

import type { AgentId } from "@/types";

/** 排重标记命中的用量记录形状（与具体 Agent 本地表结构解耦）。 */
export interface LocalUsageRecord {
  /** 本地主键（如 zcode model_usage.id），全局唯一且稳定，用于 exchangeId 幂等。 */
  id: string;
  /** 本地 schema 内的尝试序号；当前 zcode 恒 0，保留以兼容未来重试。 */
  attemptIndex: number;
  /** 本地 provider/来源标识；命中 adapter.gatewayProviderMarkers 的记录必须被调用方过滤。 */
  providerId: string;
  /** 本地模型显示名（如 GLM-5.3-Flash）；归一交给 adapter.normalizeModelId。 */
  modelId: string;
  /** Agent 客户端自报请求分类（如 main_turn/subagent）；仅随 routing.clientQuerySource 落盘。 */
  querySource?: string;
  status: "running" | "completed" | "error" | "cancelled";
  /** epoch 毫秒。 */
  startedAt: number;
  completedAt?: number;
  durationMs?: number;
  firstTokenMs?: number;
  finishReason?: string;
  errorCode?: string;
  errorMessage?: string;
  /** 客户端自报权威 token 用量（五维）。 */
  usage: {
    inputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
  };
  /** 关联会话层级（本地 ID 体系）。 */
  sessionId: string;
  turnId?: string;
  traceId?: string;
  /**
   * 该请求所属 turn 的真实用户输入文本（来自 Agent 本地 message/part 表，
   * 经 parent_user_message_id 关联）；timeline 重建不可用时的降级回填。
   */
  userText?: string;
  /**
   * 该请求响应消息的本地 ID（zcode assistant_message_id，实测 100% 关联）——
   * session timeline 中定位本次响应、并回放其之前的完整上下文。
   */
  assistantMessageId?: string;
  /** session 目录/工作区（project 归集用）。 */
  projectDirectory?: string;
  /** 顶层祖先会话 UUID（dsh 等有本地父子层级的 Agent；自身为顶层时缺省）。 */
  rootSessionId?: string;
  /** 本地步骤序号（与 turnId 联合唯一定位；合成头/正文定位用）。 */
  stepNumber?: number;
  /** 正文定位引用（如 rollout requestId + 会话文件路径线索）；读取可能失败/缺失。 */
  detailRef?: LocalExchangeRef;
}

export interface LocalExchangeRef {
  /** rollout/model-io 层的请求 ID（如可得，精确匹配）。 */
  requestId?: string;
  /**
   * 本地步骤序号（dsh session v3 的 step；与 turnId 联合精确唯一定位一条记录）。
   * responseId 缺失（部分 provider 不写 replayState）时必须提供，防止 fallback
   * 只按 turn 命中首步导致整会话重建错位（2026-09-17 实测）。
   */
  stepNumber?: number;
  /** 正文所在会话外部 ID（定位 model-io-<sessionId>.jsonl）。 */
  sessionId: string;
  /** 关联 Turn 的本地 ID（rollout.turnId 与 model_usage.turn_id 同值，主匹配键）。 */
  turnId?: string;
  /** 请求开始时刻（epoch 毫秒；同 Turn 多记录时按邻近度消歧）。 */
  startedAt?: number;
  /**
   * 客户端自报的请求来源（model_usage.query_source：main_turn / session_title /
   * subagent / compact…）。同一 Turn 内 session_title 与 main_turn 可能只相差几毫秒，
   * 仅靠时间邻近会串记录——querySource 是 rollout 记录里可直接对上的判别键。
   */
  querySource?: string;
  /** 本地记录的模型 ID（rollout.model.modelId），用于二次判别。 */
  modelId?: string;
}

/** 单条 Exchange 正文（wire 形态，读取失败/缺失时字段缺省）。 */
export interface LocalExchangeDetail {
  /** 客户端发出的 wire 请求体 JSON 文本（model 为官方原始名，保真不改写）。 */
  requestRawBody?: string;
  requestHeaders?: Record<string, string>;
  /** ai-sdk 聚合后的结构化响应（非 SSE 原文）。 */
  response?: LocalResponseShape;
  responseHeaders?: Record<string, string>;
  responseId?: string;
  /**
   * 请求体的系统提示 + 工具定义的稳定摘要（sha256）。
   * 骨架可跨记录复用/借用时用它判等，避免把不同骨架误当成同一份。
   */
  promptHash?: string;
  /** 请求体声明的工具名清单（非 full-retention 模式也会保留）。 */
  toolNames?: string[];
  /**
   * 请求骨架（system/tools）来源：rollout 自带 / 会话缓存借用。
   * 借用必须在 capture diagnostic 与页面上如实标注，不得冒充原始 wire。
   */
  skeletonSource?: "rollout" | "borrowed";
  /**
   * 该 Agent 的本地记录**结构上不可能**包含系统提示/工具定义（如 codex rollout
   * 不落盘 instructions/tools）。合成时不产生 request_skeleton_missing 诊断——
   * 这是已知常态而非异常（2026-10-09 用户确认）。
   */
  skeletonUnavailable?: boolean;
}

/** 结构化响应的最小契约（zcode rollout 实测形态；其它 Agent adapter 自行映射）。 */
export interface LocalResponseShape {
  finishReason?: string;
  text?: string;
  /** 推理链文本（zcode parts reasoning / full-retention rollout reasoningText）。 */
  reasoningText?: string;
  toolCalls?: Array<{id?: string; name?: string; input?: unknown}>;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
}

export interface LocalUsageBatch {
  records: LocalUsageRecord[];
  /** 本地库 schema 版本标识（漂移检测）；不可得时缺省。 */
  schemaVersion?: string;
}

export type LocalSourceAvailability =
  | {state: "available"}
  | {state: "missing"; reason: string}
  | {state: "unreadable"; reason: string};

export interface LocalSourceStatus {
  availability: LocalSourceAvailability;
  /** 数据目录路径（探测到的实际路径；缺失时为预期路径）。 */
  dataDir: string;
  localSchemaVersion?: string;
}

export interface LocalImportCursor {
  /**
   * 终态时刻水位（epoch 毫秒，keyset 第一键）。zcode 侧 = completed_at：请求进行中
   * 的行无终态时刻，天然不会被游标越过，不存在丢失窗口。
   */
  lastStartedAt?: number;
  /** 本地主键水位（keyset 第二键，同毫秒稳定序）。 */
  lastId?: string;
}

export interface AgentLocalSourceAdapter {
  readonly agentId: AgentId;
  /** 展示名（状态卡用）。 */
  readonly label: string;

  /**
   * 直连导入开关（2026-09-18 用户定稿，插件级显式常量）：
   * - true：直连流量合成 capture 入账（账本/Step/交互内容全量），身份标注照常——
   *   仅限直连权益绕不开的 Agent（如 zcode）显式声明；
   * - 未声明或 false（缺省，"仅身份标注"模式）：本地日志照常扫描、身份标注照常
   *   落库（网关行依赖 responseId→session/turn/step 回填原生身份），但直连步不再
   *   合成 capture、不再入账——直连与代理计费同价时，代理 wire 捕获数据更完整，
   *   默认不支持直连。
   */
  readonly directImportEnabled?: boolean;

  /** 数据目录探测（macOS/Windows）+ 本地 schema 版本；绝不创建目录。 */
  discover(): Promise<LocalSourceStatus>;

  /**
   * 排重标记：该 Agent 经 DeepAA 网关时，在其本地数据中的 provider/来源标识常量集合
   * （含历史网关名）。命中集合的记录一律跳过——这些请求的权威记录在网关 raw。
   * 标记集必须与 config-sync 写入该 Agent 配置的 provider 键名单一来源对齐（守卫测试）。
   */
  readonly gatewayProviderMarkers: readonly string[];

  /**
   * 待导入候选（2026-09-16 确认：精确 pending 计算，幂等最强）。
   * 返回窗口内（completed_at >= floor）白名单 provider + 指定模型面的全部待导入行，
   * **已按目标顺序排列**：session 按最新活动倒序（用户最先看到最新会话），
   * 同 session 内按完成时间正序（步骤号/标签/差分的派生序依赖）。
   * 已导入的行由调用方反联账本排除——anti-join 即游标，天然幂等、无遗漏。
   */
  readPendingCandidates(
    floorEpochMs: number,
    allowedModels: ReadonlySet<string>,
  ): PendingImportCandidate[];

  /**
   * 有界待导入批次（2026-10-05 D2 资源治理，用户确认）：把「seen 反联 + 目标顺序
   * + LIMIT」整体下推到 SQL 引擎执行，JS 侧只见 ≤limit 行——取代调度器旧路径的
   * 「全量候选物化 + seen 全表 JS Set 过滤」（实测稳态每轮物化数万行、随历史线性
   * 放大）。语义与 readPendingCandidates + 调用方过滤切片完全一致：同一候选集合、
   * 同一顺序（会话最新活动倒序 + 会话内完成时间正序）、同一幂等反联。
   * 未实现该方法的适配器继续走调度器旧路径（渐进迁移，行为不变）。
   */
  readPendingBatch?(options: PendingBatchQuery): PendingBatchResult;

  /** 按候选顺序水合完整用量记录（顺序 = 导入处理顺序）。 */
  hydrateUsageRecords(ids: readonly string[]): LocalUsageBatch;

  /**
   * 计费白名单（2026-09-16 用户确认升级为白名单制）：只有该集合内的本地
   * provider/来源标识才允许导入入账——与绑定目标的官方预设一一对应（如 zcode
   * 的 builtin:bigmodel-coding-plan 对应 zhipu-coding-plan Pro 套餐；体验套餐
   * builtin:bigmodel-start-plan 与 zai 家族天然排除）。gatewayProviderMarkers
   * 黑名单保留作防御性双保险。
   */
  readonly allowedProviderIds: readonly string[];

  /** 直连请求的真实官方上游 base URL（合成行 upstreamUrl 用）。 */
  readonly officialUpstreamBaseUrl: string;

  /** 本地协议路径（如 /v1/messages；合成行 localPath/upstreamPath 用）。 */
  readonly protocolPath: string;

  /** 模型名归一：官方显示名 → DeepAA 目录名（GLM-5.3-Flash → glm-5.3-flash）。 */
  normalizeModelId(modelId: string): string;

  /**
   * 创建批内 rollout 尾窗缓存（2026-10-05 D3 去重）：骨架清扫与逐条正文读取
   * 共享同一次尾部窗口读取与逐行解析。生命周期 = 一个批次，由调度器创建并在
   * 批内透传给 readRecentRecords / readExchangeDetail；未实现的适配器每次独立读取（行为不变）。
   */
  createRolloutCache?(): unknown;

  /** 同轮趁热读取单条正文；文件被清理/不可得时返回 undefined（usage 照常入账）。 */
  readExchangeDetail(
    ref: LocalExchangeRef,
    rolloutCache?: unknown,
  ): Promise<LocalExchangeDetail | undefined>;

  /**
   * 可选：列出本地尾部窗口内的最近记录（骨架清扫用）。
   * 实现必须是「尾部有界读取」，不得整文件扫描；缺省表示该 Agent 无此能力。
   */
  readRecentRecords?(sessionId: string, rolloutCache?: unknown): Promise<LocalExchangeDetail[]>;

  /**
   * 读取会话语义时间线（重建完整上下文的唯一数据源，全程只读）。
   * 超过 64MB 防御上限时返回 undefined（该 session 的行降级为「仅用量」入账，
   * 绝不丢行）；实现须自带短周期缓存语义由调用方协调（scheduler 持 LRU）。
   */
  readSessionTimeline(sessionId: string): Promise<SessionTimeline | undefined>;

  // ---- 以下为可选扩展（缺省走 zcode 的 anthropic messages 合成形态）----

  /**
   * 合成行 wire 协议（缺省 "messages"）。openai chat 系适配器（如 dsh）声明
   * "chat_completions"、Codex 官方直连声明 "responses"（2026-10-09）后，合成行
   * 路由与协议分类自动对齐网关对应 wire 形态。
   */
  readonly syntheticWireApi?: "messages" | "chat_completions" | "responses";

  /** 合成行目标格式提示（缺省 "anthropic"）。 */
  readonly syntheticTargetFormatHint?: "anthropic" | "openai";

  /**
   * openai chat 系适配器必须提供：把结构化聚合结果组装为非流式 chat/completions
   * 响应体 JSON 文本。usage 恒以客户端自报权威值为准；正文缺失时组装仅含 usage
   * 的最小 body（账本永不缺数）。缺省（未声明）时走 anthropic message 组装。
   */
  assembleChatResponseRawBody?(
    record: LocalUsageRecord,
    detail: LocalExchangeDetail | undefined,
    modelId: string,
  ): string;

  /**
   * 合成请求头（缺省 zcode anthropic 形态头）。dsh 等无 zcode 专有头的适配器
   * 用它声明自己的占位认证与 UA 形态——认证头只允许占位值（与网关 raw 语义一致）。
   */
  buildSyntheticRequestHeaders?(
    record: LocalUsageRecord,
    detail: LocalExchangeDetail | undefined,
  ): Record<string, string>;

  /**
   * 排空本轮扫描积累的身份标注（dsh 等经网关但本地有原生身份的 Agent）。
   * 调度器每轮在候选扫描后调用一次并持久化；网关流量本身不导入入账，
   * 标注只用于把原生 session/turn/step 身份回填到网关捕获行。
   */
  drainIdentityLinks?(): readonly AgentLocalIdentityLink[];

  /**
   * 本地扫描就绪状态（2026-09-22 扫描就绪门控，仅身份标注型 Agent 需要）：
   * 返回最近一轮扫描后仍待索引的本地文件数；0 = 收敛（本轮扫描范围内可产的
   * 标注已全部积累，drain 后即全部落表）。调度器据此维护派生侧旧行的等待
   * 边界（见 scan-readiness.ts）；未实现时视为不可判定（不参与收敛置位）。
   */
  reportScanStatus?(): {pendingIndexFiles: number};
}

/** 本地原生身份标注（经网关流量的 responseId 精确回填；只含身份，绝无用量/金额）。 */
export interface AgentLocalIdentityLink {
  /** 响应对象 ID（chat completions response.id；网关捕获响应的 providerItemId 同值）。 */
  responseId: string;
  agentId: AgentId;
  /** 本地原生会话 UUID。 */
  externalSessionId: string;
  /** 父会话 UUID（子代理会话；自身为顶层会话时缺省）。 */
  parentExternalSessionId?: string;
  /** 顶层祖先会话 UUID（递归折叠目标；仅当自身非顶层时存在）。 */
  rootExternalSessionId?: string;
  /** 原生 turn 序号（session v3 的 turn/start）。 */
  turnNumber?: number;
  /** 原生 step 序号（session v3 的 step/start）。 */
  stepNumber?: number;
  /** 委派深度（0=顶层）。 */
  delegationDepth?: number;
  recordedAt: string;
}

/** 待导入候选（轻量行：仅排序/筛选所需字段，水合走 hydrateUsageRecords）。 */
export interface PendingImportCandidate {
  /** 本地 model_usage 主键（exchangeId 幂等键）。 */
  id: string;
  sessionId: string;
  /** 终态时刻（epoch 毫秒）。 */
  completedAt: number;
  /** 本地模型显示名（调用方按 allowedModels 过滤/归一）。 */
  modelId: string;
}

/** readPendingBatch 查询契约（D2 下推；字段语义与 readPendingCandidates 完全一致）。 */
export interface PendingBatchQuery {
  /** DeepAA 数据目录（seen 表所在库；适配器以只读连接挂载自身源库后单条 SQL 反联）。 */
  dataDir: string;
  /** 窗口下界（epoch 毫秒）= max(回看 30 天, 绑定目标创建时刻)。 */
  floorEpochMs: number;
  allowedModels: ReadonlySet<string>;
  /** seen 表 exchange_id 前缀（import-<agentId>-），反联时与候选 id 拼接比对。 */
  seenExchangeIdPrefix: string;
  /** 单批候选上限（= 调度器 LOCAL_IMPORT_BATCH_LIMIT）。 */
  limit: number;
}

export interface PendingBatchResult {
  records: PendingImportCandidate[];
  /** 执行路径（观测/测试）：pushdown = 跨库挂载单条 SQL；chunked = 分块键集反联。 */
  mode: "pushdown" | "chunked";
}

/** 会话语义时间线的通用 part（adapter 把本地形态映射到该契约，重建器只认契约）。 */
export interface TimelinePart {
  kind: "text" | "reasoning" | "tool" | "step_finish" | "compaction" | "other";
  /** text/reasoning 正文。 */
  text?: string;
  /** step_finish 的结束原因（tool-calls/stop/...）。 */
  reason?: string;
  /** tool 调用。 */
  toolName?: string;
  callId?: string;
  toolInput?: unknown;
  /** 工具执行输出（completed 时存在；anthropic wire 的 tool_result 内容）。 */
  toolOutput?: string;
  toolStatus?: string;
  /** compaction：压缩后保留上下文的起始消息 ID（tail_start_id）。 */
  tailMessageId?: string;
}

export interface TimelineMessage {
  /**
   * 终态标记（2026-09-17）：assistant 消息必须「已写 time.completed 且存在
   * step-finish part」才算终态。zcode 先写 parts 再写完成标记，而 model_usage.completed_at
   * 早于两者（实测 -4ms ~ -8.6s），未终态即合成会得到空正文。
   */
  finalized: boolean;
  messageId: string;
  role: "user" | "assistant";
  /** semantics.providerVisibility !== 'hidden'。 */
  visible: boolean;
  /**
   * user 角色专用：Agent 运行时注入（zcode semantics.origin='agent_runtime'，
   * 如 todo_reminder）→ true；真实用户输入（origin='real_user'）→ false/undefined。
   * 重建时注入消息按网关 lane 同款信封形态标注，保证预览分类一致。
   */
  injected?: boolean;
  parts: TimelinePart[];
}

export interface SessionTimeline {
  /** 严格按会话内顺序（sequence + 时间）排列。 */
  messages: TimelineMessage[];
}
