/**
 * 导出对话流提取：普通查询按 target/agent/session/turn/step 读取 SQLite 有界预览，
 * 显式完整下载再按精确 Raw 索引流式还原对话记录。
 *
 * 两条路径都按时间顺序保留请求关联关系，
 * 支持按类别（system/developer/user/tool_result/assistant/tool_use/reasoning）筛选。
 */
import type {DeepaaDatabase} from "@/lib/db/sqlite-driver";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { StringDecoder } from "node:string_decoder";
import { parser, type Token } from "stream-json/parser.js";
import {
  encodeExportCursor,
  estimateExportRange,
  findExportBodyBudgetViolation,
  selectExportExchangeRefs,
  selectPreviousExportModelRef,
  type ExportExchangeRef,
} from "./db/export-queries";
import {
  loadExchangeProjectionDetail,
  type ExchangeProjectionDetail,
} from "./db/exchange-projection-queries";
import { normalizeExchange, stableHash } from "./harness/normalizer";
import { classifyProtocol } from "./harness/protocol";
import { isAgentEnvelopeProbeAgent, isKnownSemanticAgentKind } from "./agent-registry";
import type { RawCapturedExchange, CaptureFailover } from "./harness/types";
import type { NormalizedExchange } from "./harness/normalizer";
import type { RawBodyStorage } from "./db/models";
import {
  AGENT_ENVELOPE_PREFIX_MAX_CHARACTERS,
  ALL_CONVERSATION_SEMANTIC_CATEGORIES,
  buildSemanticLogicalId,
  classifyAgentEnvelopePrefix,
  classifySemanticLane,
  conversationContentKindsFor,
  conversationFingerprintKey,
  isAnthropicToolBlockType,
  isToolBlockMetadata,
  resolveSseLane,
  type AgentKind,
  type ConversationConfidence,
  type ConversationContentKind,
  type ConversationDedupePolicy,
  type ConversationDisplayPolicy,
  type ConversationFingerprintInput,
  type ConversationProvenance,
  type ConversationSemanticCategory,
  type ConversationSemanticItem,
  type ProtocolKind as SemanticProtocolKind,
  type SemanticLaneInput,
  type SseLaneProtocol,
} from "./conversation-semantics";
import { WhitespaceCollapsedHash } from "./conversation-semantics/whitespace-hash";
import {
  categorySelectedForSide,
  selectedCategoriesForSide,
} from "./conversation-categories";
import { DataUrlProjector } from "./ingestion/data-url-projector";
import type { ExchangeContentPreviewItem } from "./ingestion/projection-types";
import { locateRawExchange } from "./harness/raw-locator";
import { classifyRawReadGate, rawReadGateMessage } from "./ingestion/raw-read-gate";
import { openRawBodyStream } from "./harness/raw-body-stream";
import {
  consumePersistedRequestFreshness,
  loadPersistedRequestDedupe,
  type PersistedRequestDedupe,
} from "./export-request-dedupe";

export type ConversationCategory = ConversationSemanticCategory;
export type ConversationSide = "input" | "output";
export type ConversationStepDiff = "unique" | "inherited" | "unconfirmed";
export type AuxiliaryKind = "token_count" | "auth_error" | "health_check" | "metadata" | "title_generation" | "unknown";

export interface ConversationItem {
  category: ConversationCategory;
  side: ConversationSide;
  text: string;
  toolName?: string;
  toolUseId?: string;
  /** 标记该内容块相对上一条同 Thread Request 是新增、继承还是因基线缺失而未确认 */
  stepDiff?: ConversationStepDiff;
  exchangeId: string;
  /** 业务 Turn：一次用户任务轮次；当前内部来源是 AgentTurn.id。 */
  turnId?: string;
  threadId?: string;
  agentSessionId?: string;
  capturedAt: string;
  model?: string;
  /** 模型故障转移元数据：代理记录的「原模型 → 实际模型」；缺省表示按主模型正常服务。 */
  failover?: CaptureFailover;
  targetId: string;
  targetName?: string;
  isAuxiliary: boolean;
  auxiliaryKind?: AuxiliaryKind;
  agentProtocol: string;
  contentSource?: "sqlite_preview" | "raw_stream";
  previewState?: "complete" | "limited" | "unavailable" | "not_materialized" | "integrity_failed";
  textSha256?: string;
  originalTextBytes?: number;
  previewTextBytes?: number;
  truncated?: boolean;
  mediaDescriptorOrdinals?: number[];
}

export interface ExportFilters {
  target?: string | string[];
  agent?: string | string[];
  session?: string;   // 业务 session id（AgentSession.id；兼容旧 externalSessionId）
  thread?: string;    // 业务 thread id（AgentThread.id；查询默认包含 closure 后代）
  turn?: string;      // 业务 turn id（当前内部 AgentTurn.id）
  step?: string;      // 内部 AgentStep.id；服务端兼容旧 exchangeId 链接
  /**
   * 精确单条 Exchange（按需展开锚点，2026-09-17）：与 step 不同，它对辅助请求同样
   * 有效（辅助请求没有 AgentStep），且天然只命中一行，不需要任何业务范围。
   */
  exchangeId?: string;
  start?: string;
  end?: string;
  scope: "all" | "upto" | "step";
  /** 当前页私有方向筛选；未传时同时匹配 Request 与 Response。 */
  side?: "request" | "response";
  /** 选中的类别；空表示全部 */
  categories: ConversationCategory[];
  /** URL 明确携带 categories 参数时为 true；用于区分 categories= 空选和旧语义默认全选。 */
  categoriesExplicit?: boolean;
  /**
   * 读取前最多处理多少条 exchange。
   * 兼容旧查询参数；分页链路优先使用 exchangeLimit。
   */
  maxExchanges?: number;
  /** 兼容旧查询参数；分页链路优先使用 pageMaxBytes。 */
  maxBytes?: number;
  /** 服务端 exchange 游标；表示从该游标之后继续加载更早请求。 */
  cursor?: string;
  /**
   * 交互内容列表模式（2026-09-17）：只回行摘要，不读任何 raw（列表滚动零 raw）。
   * 具体步骤正文由用户展开时再按 step 精确加载。
   */
  summaryOnly?: boolean;
  /**
   * 跳过候选总数 COUNT（全局时间线首屏之后）：无范围 COUNT 是全表扫描，
   * 滚动期间不应重复付出。跳过时 page_start 不返回 candidateCount。
   */
  skipCandidateCount?: boolean;
  /**
   * 推迟线程排重基线解析（全局视图/列表模式）：不为了「本步骤新增」再去读上一条
   * 请求的 raw，行摘要标注「未排重」；展开单条时再按需解析。
   */
  deferBaseline?: boolean;
  /** keyset 方向；older 为默认值，newer 用于返回上一页。 */
  direction?: "older" | "newer";
  /** 仅用于 URL 与 UI 展示，不参与 SQL OFFSET。 */
  page?: number;
  /** 单页最多读取多少条 exchange，读取 raw exchange 前先按索引截断。 */
  exchangeLimit?: number;
  /** 单页读取 raw exchange 前的字节预算，按索引 lineLengthBytes 估算并截断。 */
  pageMaxBytes?: number;
  /** 是否展示被判定为请求重放的继承上下文；默认隐藏，只展示去重后的 transcript。 */
  includeInherited?: boolean;
  /**
   * 调用方是否显式声明了 includeInherited（2026-09-17）。
   * 只有显式 false 才让服务端直接不下发继承正文；参数缺省保持「全部下发」的
   * 历史语义，避免程序化调用方被动丢掉上下文。
   */
  includeInheritedExplicit?: boolean;
}

export type ExportConversationRange = "none" | "session" | "thread" | "turn" | "step";

export interface ExportDedupeSummary {
  mode: "context_replay";
  range: ExportConversationRange;
  requiredRangeMissing: boolean;
  includeInherited: boolean;
  uniqueItemCount: number;
  inheritedItemCount: number;
  hiddenInheritedItemCount: number;
  processedExchangeCount: number;
}

export interface ExportPageInfo {
  /** 未请求统计时缺省（skipCandidateCount）；UI 必须显示「未统计」而不是 0。 */
  candidateCount?: number;
  processedExchangeCount: number;
  loadedExchangeIds: string[];
  firstExchangeId?: string;
  lastExchangeId?: string;
  cursor?: string;
  nextCursor?: string;
  hasMoreOlder: boolean;
  baselineExchangeId?: string;
  exchangeLimit: number;
  pageMaxBytes?: number;
  processedBytes?: number;
  visibleProcessedBytes: number;
  baselineBytes: number;
  dedupeBaselineStatus: "not_required" | "compared" | "budget_blocked";
  blockedExchangeId?: string;
  requiredBytes?: number;
  limitedByBytes?: boolean;
}

export interface ExportResult {
  items: ConversationItem[];
  scope: "all" | "upto" | "step";
  total: number;
  /** SQLite 候选总数；兼容旧结果时可能缺省。 */
  candidateCount?: number;
  /** 当前页真正读取的 SQLite Exchange 投影数（包括隐藏排重基线）。 */
  processedCount?: number;
  filters: ExportFilters;
  page?: ExportPageInfo;
  limited?: {
    candidateCount?: number;
    processedExchangeCount: number;
    maxExchanges: number;
    maxBytes?: number;
    processedBytes?: number;
  };
  stepComparison?: StepComparison;
  dedupe?: ExportDedupeSummary;
  preview?: ExportPreviewSummary;
}

export interface ExportPreviewSummary {
  candidateItemCount: number;
  processedItemCount: number;
  candidateTextBytes: number;
  processedTextBytes: number;
  limitedExchangeCount: number;
  notMaterializedExchangeCount: number;
  unavailableExchangeCount: number;
  integrityFailedExchangeCount: number;
  limited: boolean;
}

const ALL_CATEGORIES: ConversationCategory[] = [
  ...ALL_CONVERSATION_SEMANTIC_CATEGORIES,
];

export interface StepComparison {
  status: "compared" | "no_previous_turn" | "size_limited";
  currentExchangeId: string;
  previousExchangeId?: string;
  uniqueItemCount: number;
  inheritedItemCount: number;
  maxCompareBytes?: number;
  compareBytes?: number;
}

const DEFAULT_FULL_EXPORT_PAGE_EXCHANGES = 5;

export interface ExportConversationDependencies {
  db: DeepaaDatabase;
  rawReader?: (
    ref: ExportExchangeRef,
  ) => Promise<RawCapturedExchange | undefined>;
}

export type ConversationBodyEvent =
  | {
      type: "item_start";
      side: ConversationSide;
      category: ConversationCategory;
      jsonPath: string;
      provenance: ConversationProvenance;
      confidence: ConversationConfidence;
      displayPolicy: ConversationDisplayPolicy;
      dedupePolicy: ConversationDedupePolicy;
      logicalId: string;
      providerItemType: string;
      providerLineageKey?: string;
      contentKinds: ConversationContentKind[];
      streamEventType?: string;
      toolName?: string;
      toolUseId?: string;
      textSha256?: string;
      mediaSha256?: string[];
      stepDiff?: ConversationStepDiff;
    }
  | { type: "text"; value: string }
  | {
      type: "media_descriptor";
      side: "request" | "response";
      ordinal: number;
      jsonPath: string;
      mediaType: string;
      encodedBytes: number;
      decodedBytes: number;
      sha256: string;
      sourceStorage: Exclude<RawBodyStorage, "none">;
    }
  | {
      type: "media_bytes";
      side: "request" | "response";
      ordinal: number;
      mediaType: string;
      value: Uint8Array;
    }
  | {
      type: "item_end";
      textSha256: string;
      originalTextBytes: number;
      contentKinds: ConversationContentKind[];
      mediaSha256?: string[];
      stepDiff: ConversationStepDiff;
    };

export interface IterateConversationBodyEventsOptions {
  stream: Readable;
  format?: "json" | "sse";
  exchangeId: string;
  side: "request" | "response";
  rawBodySha256: string;
  sourceStorage: Exclude<RawBodyStorage, "none">;
  protocol: string;
  agentKind?: AgentKind;
  rootPath?: string;
  previewItems?: ExchangeContentPreviewItem[];
  inheritedFingerprints?: Map<string, number>;
  /** 仅供显式媒体网关使用；普通正文和 Worker 不回传解码字节。 */
  decodedMediaOrdinal?: number;
  /** @deprecated 仅用于旧完整下载调用，迁移后删除。 */
  inheritedHashes?: ReadonlySet<string>;
}

export { conversationFingerprintKey };
export type { ConversationFingerprintInput };

interface ExportJsonFrame {
  kind: "object" | "array";
  path: string;
  nextKey?: string;
  nextIndex: number;
  metadata: Record<string, string>;
}

/** 非流式工具块内被缓冲的标量叶子。 */
interface ToolBlockLeaf {
  /** 相对工具块根路径的 JSON 路径（如 `.input.command`）。 */
  relativePath: string;
  kind: "string" | "number" | "boolean" | "null";
  value: string;
}

interface ToolBlockBuffer {
  root: string;
  leaves: ToolBlockLeaf[];
  bytes: number;
  truncated: boolean;
}

/** 工具入参缓冲上限：超出即停止累积并标记截断，绝不无界缓存。 */
const TOOL_BLOCK_MAX_BYTES = 2 * 1024 * 1024;
const TOOL_BLOCK_MAX_LEAVES = 4_096;

/**
 * 找到最外层「工具调用块」帧。必须取最外层：工具入参内部也可能出现 `type` 字段，
 * 取最内层会把块根定位到入参里的嵌套对象上。
 */
function outermostToolBlockFrame(
  frames: readonly ExportJsonFrame[],
): ExportJsonFrame | undefined {
  for (const frame of frames) {
    if (frame.kind !== "object") continue;
    if (isToolBlockMetadata({
      ...(frame.metadata.type !== undefined ? {type: frame.metadata.type} : {}),
      ...(frame.metadata.semanticType !== undefined
        ? {semanticType: frame.metadata.semanticType}
        : {}),
    })) {
      return frame;
    }
  }
  return undefined;
}

function isToolBlockFrame(frame: ExportJsonFrame | undefined): boolean {
  if (!frame || frame.kind !== "object") return false;
  return isToolBlockMetadata({
    ...(frame.metadata.type !== undefined ? {type: frame.metadata.type} : {}),
    ...(frame.metadata.semanticType !== undefined
      ? {semanticType: frame.metadata.semanticType}
      : {}),
  });
}

type ToolJsonSegment = {key: string} | {index: number};

/** `.input.todos[0].content` → ['input', 'todos', 0, 'content']；无法解析时返回 undefined。 */
function parseToolRelativePath(path: string): ToolJsonSegment[] | undefined {
  const segments: ToolJsonSegment[] = [];
  let rest = path;
  while (rest.length > 0) {
    const separator = rest.startsWith(".") ? "." : rest.startsWith("[") ? "[" : undefined;
    if (separator === undefined) return undefined;
    if (separator === "[") {
      const end = rest.indexOf("]");
      if (end < 0) return undefined;
      const index = Number(rest.slice(1, end));
      if (!Number.isSafeInteger(index) || index < 0) return undefined;
      segments.push({index});
      rest = rest.slice(end + 1);
      continue;
    }
    const match = /^\.([A-Za-z_$][\w$]*)/u.exec(rest);
    if (!match) return undefined;
    segments.push({key: match[1]!});
    rest = rest.slice(match[0].length);
  }
  return segments.length > 0 ? segments : undefined;
}

function toolLeafValue(leaf: ToolBlockLeaf): unknown {
  if (leaf.kind === "number") {
    const parsed = Number(leaf.value);
    return Number.isFinite(parsed) ? parsed : leaf.value;
  }
  if (leaf.kind === "boolean") return leaf.value === "true";
  if (leaf.kind === "null") return null;
  return leaf.value;
}

/** 把叶子按路径还原成嵌套 JSON（键序即协议字段顺序），输出与 Worker 同构。 */
function buildToolBlockInputJson(buffer: ToolBlockBuffer): string {
  const inputLeaves: Array<{segments: ToolJsonSegment[]; leaf: ToolBlockLeaf}> = [];
  for (const leaf of buffer.leaves) {
    const segments = parseToolRelativePath(leaf.relativePath);
    if (!segments || segments.length === 0) continue;
    // 工具入参统一位于块的 `input` 节点内；剥离该前缀后直接输出 input 对象本身，
    // 与 Worker 投影器 `JSON.stringify(record.input ?? {})` 同构。
    const relative = segments[0] && "key" in segments[0] && segments[0].key === "input"
      ? segments.slice(1)
      : segments;
    if (relative.length === 0) {
      if (buffer.leaves.length === 1) return safeJsonStringify(toolLeafValue(leaf));
      continue;
    }
    inputLeaves.push({segments: relative, leaf});
  }
  const root: Record<string, unknown> = {};
  for (const {segments, leaf} of inputLeaves) {
    if ("index" in segments[0]!) continue;
    assignToolJsonPath(root, segments, toolLeafValue(leaf));
  }
  if (buffer.truncated) root.__truncated = true;
  return safeJsonStringify(root);
}

function assignToolJsonPath(
  root: Record<string, unknown>,
  segments: readonly ToolJsonSegment[],
  value: unknown,
): void {
  let current: Record<string, unknown> | unknown[] = root;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]!;
    const last = index === segments.length - 1;
    const next = segments[index + 1];
    const key: string | number = "key" in segment ? segment.key : segment.index;
    if (last) {
      (current as Record<string | number, unknown>)[key] = value;
      return;
    }
    // 复用已存在的容器：多个叶子共享同一层前缀时不能互相覆盖
    // （command/timeout/background 都属于 input 节点）。
    const existing = (current as Record<string | number, unknown>)[key];
    if (existing !== undefined && typeof existing === "object" && existing !== null) {
      current = existing as Record<string, unknown> | unknown[];
      continue;
    }
    const container: Record<string, unknown> | unknown[] =
      next && "index" in next ? [] : {};
    (current as Record<string | number, unknown>)[key] = container;
    current = container;
  }
}

function safeJsonStringify(value: unknown): string {
  try {
    const text = JSON.stringify(value);
    return text === undefined ? "null" : text;
  } catch {
    return "null";
  }
}

/** 单个工具入参字符串叶子的上限（Write 类工具可传入整份文件，绝不无界累积）。 */
const TOOL_BLOCK_LEAF_MAX_CHARACTERS = 512 * 1024;

/**
 * 用记忆到的 item 快照补齐工具身份：SSE 增量事件只带 `item_id`，
 * `call_id`/`name` 只在 `response.output_item.added` 出现一次。
 */
function withRememberedToolIdentity(
  metadata: Record<string, string>,
  store: ReadonlyMap<string, {callId?: string; name?: string; type?: string}>,
): Record<string, string> {
  const itemId = metadata.item_id ?? metadata.id;
  if (itemId === undefined) return metadata;
  const remembered = store.get(itemId);
  if (!remembered) return metadata;
  const merged = {...metadata};
  if (merged.call_id === undefined && remembered.callId !== undefined) {
    merged.call_id = remembered.callId;
  }
  if (merged.name === undefined && remembered.name !== undefined) {
    merged.name = remembered.name;
  }
  return merged;
}

/**
 * 显式完整下载使用的 JSON 字符串事件流。它不组装完整 JSON 或正文字符串；
 * Data URL 经过增量解码/hash 后只输出描述符文本。
 */
/** 单段文本的折叠哈希（与投影/指纹库同一口径）。 */
function collapsedTextSha256(text: string): string {
  const hash = new WhitespaceCollapsedHash();
  hash.update(text);
  return hash.digest();
}

export async function* iterateConversationBodyEvents(
  options: IterateConversationBodyEventsOptions,
): AsyncGenerator<ConversationBodyEvent> {
  const events = iterateScalarConversationBodyEvents(options);
  if (options.format !== "sse") {
    yield* events;
    return;
  }
  yield* coalesceSseConversationEvents(events);
}

async function* iterateScalarConversationBodyEvents(
  options: IterateConversationBodyEventsOptions,
): AsyncGenerator<ConversationBodyEvent> {
  const source = options.format === "sse"
    ? Readable.from(iterateSseJsonArrayChunks(options.stream))
    : options.stream;
  const tokenizer = parser.asStream({
    packKeys: false,
    streamKeys: true,
    packStrings: false,
    streamStrings: true,
    packNumbers: false,
    streamNumbers: true,
  });
  const pipePromise = pipeline(source, tokenizer);
  const frames: ExportJsonFrame[] = [];
  const previewByPath = new Map(
    (options.previewItems ?? [])
      .filter(item => item.side === options.side)
      .map(item => [item.jsonPath, item] as const),
  );
  const previewByLogicalId = new Map(
    (options.previewItems ?? [])
      .filter(item => item.side === options.side)
      .map(item => [item.logicalId, item] as const),
  );
  const rootPath = options.rootPath ?? (options.format === "sse" ? "$.events" : "$");
  let rootReserved = false;
  let keyBuffer = "";
  let activeScalar: { path: string; key: string; value: string } | undefined;
  let activeItem: {
    start: Extract<ConversationBodyEvent, { type: "item_start" }>;
    projector: DataUrlProjector;
    queued: ConversationBodyEvent[];
    descriptorText?: string;
    textHash: WhitespaceCollapsedHash;
    originalTextBytes: number;
    previewTextSha256?: string;
    stepDiff: ConversationStepDiff;
    startEmitted: boolean;
    envelopePrefix?: string;
    semanticInput?: SemanticLaneInput;
    hasMedia: boolean;
    mediaSha256: string[];
  } | undefined;
  let completedSseStart: {
    eventPath: string;
    start: Extract<ConversationBodyEvent, { type: "item_start" }>;
    semanticInput: SemanticLaneInput;
  } | undefined;
  let mediaOrdinal = 0;
  /**
   * 非流式工具块聚合（2026-09-17 用户确认）：anthropic/openai 非流式响应里的
   * `tool_use` / `function_call` 入参是对象，键名（command/description/...）不可能
   * 命中文本路径白名单，历史上这里一条都不产——页面于是显示「本次响应未产生可展示
   * 的模型输出」。这里按块聚合全部标量叶子，块结束时输出一条 JSON 入参条目，
   * 与 Worker 投影器 `reconcileAnthropicJsonToolUse` 的语义同构。
   */
  const toolBlocksEnabled = options.format !== "sse" && options.side === "response";
  const toolBlocks = new Map<string, ToolBlockBuffer>();
  const flushedToolBlocks = new Set<string>();
  let activeNumber: { path: string; key: string; value: string } | undefined;
  /** 正在累积的工具入参字符串叶子（块内数万字符的 Write 入参不能无界累积）。 */
  let activeToolLeaf: {
    root: string;
    path: string;
    value: string;
    truncated: boolean;
  } | undefined;
  /**
   * SSE 工具身份记忆：`response.output_item.added` 才带 `call_id`/`name`，后续
   * `*.delta` 事件只带 `item_id`。没有这份记忆时中段 delta 拿不到工具身份，
   * 排重/聚合会把同一次工具调用拆成多片。
   */
  const sseItemMetadata = new Map<string, {callId?: string; name?: string; type?: string}>();

  const consumeInheritedStepDiff = (
    start: Extract<ConversationBodyEvent, { type: "item_start" }>,
    textSha256: string | undefined,
  ): ConversationStepDiff => {
    if (options.side !== "request" || !textSha256) return "unique";
    const inherited = consumeFingerprint(
      options.inheritedFingerprints,
      conversationFingerprintKey({
        category: start.category,
        side: start.side,
        provenance: start.provenance,
        providerItemType: start.providerItemType,
        textSha256,
        mediaSha256: start.mediaSha256,
        contentKinds: start.contentKinds,
        toolName: start.toolName,
        toolUseId: start.toolUseId,
      }),
    ) || options.inheritedHashes?.has(textSha256) === true;
    return inherited ? "inherited" : "unique";
  };

  const completeInjectionProbe = (item: NonNullable<typeof activeItem>): void => {
    const stepDiff = consumeInheritedStepDiff(item.start, item.previewTextSha256);
    item.start.stepDiff = stepDiff;
    item.stepDiff = stepDiff;
  };

  const applyEnvelopeSemantic = (item: NonNullable<typeof activeItem>): void => {
    if (!item.semanticInput) return;
    const semantic = classifySemanticLane({
      ...item.semanticInput,
      textPrefix: item.envelopePrefix,
    });
    item.start.category = semantic.semanticCategory;
    item.start.provenance = semantic.provenance;
    item.start.confidence = semantic.confidence;
    item.start.displayPolicy = semantic.displayPolicy;
    item.start.dedupePolicy = semantic.dedupePolicy;
    item.start.logicalId = semantic.logicalId;
    item.start.providerLineageKey = semantic.providerLineageKey;
  };

  // SSE 字段顺序不稳定；空 arguments/text 结束后仍可能读到同一事件的 call_id/name。
  const applyLateMetadata = (path: string, key: string, value: string): void => {
    const completed = completedSseStart;
    if (!completed || !path.startsWith(`${completed.eventPath}.`)) return;
    if (key === "type") {
      completed.semanticInput = {
        ...completed.semanticInput,
        providerItemType: value,
        semanticLane: value,
      };
      const semantic = classifySemanticLane(completed.semanticInput);
      completed.start.category = semantic.semanticCategory;
      completed.start.provenance = semantic.provenance;
      completed.start.confidence = semantic.confidence;
      completed.start.displayPolicy = semantic.displayPolicy;
      completed.start.dedupePolicy = semantic.dedupePolicy;
      completed.start.logicalId = semantic.logicalId;
      completed.start.providerItemType = semantic.providerItemType;
      completed.start.providerLineageKey = semantic.providerLineageKey;
      completed.start.contentKinds = [...semantic.contentKinds];
    } else if (key === "name" && !completed.start.toolName) {
      completed.start.toolName = value;
    } else if (key === "call_id") {
      completed.start.toolUseId = value;
    } else if ((key === "item_id" || key === "id") && !completed.start.toolUseId) {
      completed.start.toolUseId = value;
    } else if (
      key === "index"
      && completed.start.category === "tool_use"
      && !completed.start.toolUseId
    ) {
      completed.start.toolUseId = `content-block:${value}`;
    }
  };

  const reservePath = (): { path: string; parent?: ExportJsonFrame; key?: string } => {
    const parent = frames.at(-1);
    if (!parent) {
      if (rootReserved) throw new Error("完整导出 JSON 存在多个根值。");
      rootReserved = true;
      return { path: rootPath };
    }
    if (parent.kind === "array") {
      const index = parent.nextIndex++;
      return { path: `${parent.path}[${index}]`, parent };
    }
    const key = parent.nextKey ?? `#missing-key-${parent.nextIndex}`;
    parent.nextKey = undefined;
    parent.nextIndex += 1;
    return { path: exportJsonPath(parent.path, key), parent, key };
  };

  const bufferToolLeaf = (
    root: string,
    path: string,
    kind: ToolBlockLeaf["kind"],
    value: string,
  ): void => {
    let buffer = toolBlocks.get(root);
    if (!buffer) {
      buffer = {root, leaves: [], bytes: 0, truncated: false};
      toolBlocks.set(root, buffer);
    }
    if (buffer.truncated) return;
    const size = Buffer.byteLength(value);
    if (
      buffer.leaves.length >= TOOL_BLOCK_MAX_LEAVES
      || buffer.bytes + size > TOOL_BLOCK_MAX_BYTES
    ) {
      buffer.truncated = true;
      return;
    }
    buffer.bytes += size;
    buffer.leaves.push({relativePath: path.slice(root.length), kind, value});
  };

  /**
   * 工具块结束：把缓冲的入参还原成一条 JSON 条目（与 Worker 投影器同构）。
   * 即使入参没有任何标量叶子（`input: {}`）也要产出条目，否则工具调用不可见。
   */
  function* flushToolBlock(
    root: string,
    frame: ExportJsonFrame,
  ): Generator<ConversationBodyEvent> {
    if (flushedToolBlocks.has(root)) return;
    flushedToolBlocks.add(root);
    const buffer = toolBlocks.get(root) ?? {
      root,
      leaves: [],
      bytes: 0,
      truncated: false,
    };
    toolBlocks.delete(root);
    const blockType = frame.metadata.type ?? "tool_use";
    const toolName = frame.metadata.name;
    const toolUseId = frame.metadata.call_id ?? frame.metadata.id;
    const index = /\.content\[(\d+)\]$/u.exec(root)?.[1];
    const messageId = frames
      .map(ancestor => ancestor.metadata.id)
      .find((value): value is string => value !== undefined);
    const lane = index !== undefined
      ? `content:${index}:${blockType.trim().toLowerCase().replaceAll("-", "_")}`
      : `${exportLastPathKey(root) || "value"}:${blockType}`;
    const semantic = classifySemanticLane({
      protocol: semanticProtocolKind(options.protocol),
      agentKind: options.agentKind ?? "unknown",
      bodySide: options.side,
      providerRole: "assistant",
      providerItemType: blockType,
      ancestorTypes: frames
        .flatMap(ancestor => ancestor.metadata.type ? [ancestor.metadata.type] : [])
        .concat(blockType),
      evidencePath: root,
      parentIdentity: toolUseId
        ? `item:${toolUseId}`
        : index !== undefined
          ? `content-block:${index}`
          : messageId ? `message:${messageId}` : root,
      semanticLane: lane,
      ...(toolUseId !== undefined ? {providerItemId: toolUseId} : {}),
      ...(toolName !== undefined ? {toolName} : {}),
      ...(toolUseId !== undefined ? {toolUseId} : {}),
      contentKinds: conversationContentKindsFor(blockType, false),
    });
    if (semantic.displayPolicy !== "conversation") return;
    const text = buildToolBlockInputJson(buffer);
    const originalTextBytes = Buffer.byteLength(text);
    yield {
      type: "item_start",
      side: options.side === "request" ? "input" : "output",
      category: semantic.semanticCategory,
      jsonPath: root,
      provenance: semantic.provenance,
      confidence: semantic.confidence,
      displayPolicy: semantic.displayPolicy,
      dedupePolicy: semantic.dedupePolicy,
      logicalId: semantic.logicalId,
      providerItemType: semantic.providerItemType,
      ...(semantic.providerLineageKey !== undefined
        ? {providerLineageKey: semantic.providerLineageKey}
        : {}),
      contentKinds: [...semantic.contentKinds],
      ...(toolName !== undefined ? {toolName} : {}),
      ...(toolUseId !== undefined ? {toolUseId} : {}),
      stepDiff: "unique",
    };
    yield { type: "text", value: text };
    yield {
      type: "item_end",
      textSha256: collapsedTextSha256(text),
      originalTextBytes,
      contentKinds: [...semantic.contentKinds],
      stepDiff: "unique",
    };
  }

  try {
    for await (const rawToken of tokenizer) {
      const token = rawToken as Token;
      if (token.name === "startKey") {
        keyBuffer = "";
      } else if (
        token.name === "stringChunk"
        && !activeItem
        && !activeScalar
        && !activeToolLeaf
      ) {
        keyBuffer += String(token.value ?? "");
      } else if (token.name === "endKey") {
        const parent = frames.at(-1);
        if (!parent || parent.kind !== "object") throw new Error("完整导出 JSON key 层级无效。");
        parent.nextKey = keyBuffer;
        keyBuffer = "";
      } else if (token.name === "startObject" || token.name === "startArray") {
        const slot = reservePath();
        frames.push({
          kind: token.name === "startObject" ? "object" : "array",
          path: slot.path,
          nextIndex: 0,
          metadata: {},
        });
      } else if (token.name === "endObject" || token.name === "endArray") {
        const expected = token.name === "endObject" ? "object" : "array";
        const frame = frames.pop();
        if (!frame || frame.kind !== expected) throw new Error("完整导出 JSON 容器层级无效。");
        // SSE item 快照：`response.output_item.added` 才带 call_id/name，后续 delta
        // 只带 item_id。按「item 对象闭合」记忆，与字段顺序无关。
        if (
          frame.kind === "object"
          && /^\$\.events\[\d+\]\.data\.item$/u.test(frame.path)
        ) {
          const itemId = frame.metadata.id;
          if (itemId) {
            sseItemMetadata.set(itemId, {
              ...(frame.metadata.call_id !== undefined
                ? {callId: frame.metadata.call_id}
                : {}),
              ...(frame.metadata.name !== undefined ? {name: frame.metadata.name} : {}),
              ...(frame.metadata.type !== undefined ? {type: frame.metadata.type} : {}),
            });
          }
        }
        if (
          toolBlocksEnabled
          && frame.kind === "object"
          && isToolBlockFrame(frame)
          && !flushedToolBlocks.has(frame.path)
        ) {
          yield* flushToolBlock(frame.path, frame);
        }
      } else if (token.name === "startString") {
        const slot = reservePath();
        const key = slot.key ?? exportLastPathKey(slot.path);
        if (isExportMetadataKey(key)) {
          activeScalar = { path: slot.path, key, value: "" };
          continue;
        }
        const metadata = mergedFrameMetadata(frames);
        const eventType = sseEventType(frames);
        const enrichedMetadata = withRememberedToolIdentity(metadata, sseItemMetadata);
        if (toolBlocksEnabled) {
          const block = outermostToolBlockFrame(frames);
          if (block) {
            activeToolLeaf = {
              root: block.path,
              path: slot.path,
              value: "",
              truncated: false,
            };
            continue;
          }
        }
        if (!isExportConversationTextPath(
          slot.path,
          key,
          previewByPath.has(slot.path),
          options.side,
          eventType,
        )) {
          activeScalar = { path: slot.path, key: "", value: "" };
          continue;
        }
        const pathPreview = previewByPath.get(slot.path);
        const side = options.side === "request" ? "input" : "output";
        const toolName = pathPreview?.toolName ?? enrichedMetadata.name;
        // JSON 请求路径与 Worker 投影器对齐：只有工具类 item 才允许把 provider id 用作
        // toolUseId，普通消息 id 不得进入指纹，避免运行时指纹与持久化指纹分叉。
        // SSE 路径保持旧语义（响应不参与排重，且 item_id 承担逻辑条目分隔职责）。
        const jsonPath = options.format !== "sse";
        const toolItem = jsonPath && isToolItemMetadata(slot.path, enrichedMetadata);
        const provisionalToolUseId = pathPreview?.toolUseId
          ?? enrichedMetadata.call_id
          ?? (toolItem || !jsonPath
            ? enrichedMetadata.item_id ?? enrichedMetadata.id
            : undefined);
        let classified = classifyStreamSemantic({
          options,
          frames,
          path: slot.path,
          key,
          metadata: enrichedMetadata,
          eventType,
          preview: pathPreview,
          toolName,
          toolUseId: provisionalToolUseId,
        });
        const preview = pathPreview
          ?? previewByLogicalId.get(classified.semantic.logicalId);
        if (preview && preview !== pathPreview) {
          classified = classifyStreamSemantic({
            options,
            frames,
            path: slot.path,
            key,
            metadata: enrichedMetadata,
            eventType,
            preview,
            toolName: preview.toolName ?? toolName,
            toolUseId: preview.toolUseId ?? provisionalToolUseId,
          });
        }
        if (classified.semantic.displayPolicy !== "conversation") {
          activeScalar = { path: slot.path, key: "", value: "" };
          continue;
        }
        const category = classified.semantic.semanticCategory;
        const resolvedToolName = preview?.toolName ?? toolName;
        const toolLike = toolItem || category === "tool_use" || category === "tool_result";
        const toolUseId = preview?.toolUseId
          ?? (jsonPath && !toolLike
            ? undefined
            : enrichedMetadata.call_id
              ?? enrichedMetadata.item_id
              ?? enrichedMetadata.id)
          ?? (category === "tool_use" && enrichedMetadata.index !== undefined
            ? `content-block:${enrichedMetadata.index}`
            : undefined);
        const requiresEnvelopeProbe = options.side === "request"
          && category === "user_real"
          && preview === undefined
          && isAgentEnvelopeProbeAgent(options.agentKind);
        const queued: ConversationBodyEvent[] = [];
        const start: Extract<ConversationBodyEvent, { type: "item_start" }> = {
          type: "item_start",
          side,
          category,
          jsonPath: slot.path,
          provenance: classified.semantic.provenance,
          confidence: classified.semantic.confidence,
          displayPolicy: classified.semantic.displayPolicy,
          dedupePolicy: classified.semantic.dedupePolicy,
          logicalId: classified.semantic.logicalId,
          providerItemType: classified.semantic.providerItemType,
          providerLineageKey: classified.semantic.providerLineageKey,
          contentKinds: [...classified.semantic.contentKinds],
          streamEventType: eventType,
          toolName: resolvedToolName,
          toolUseId,
          textSha256: preview?.textSha256,
          mediaSha256: preview?.mediaSha256 ? [...preview.mediaSha256] : undefined,
          stepDiff: "unique",
        };
        if (!requiresEnvelopeProbe) {
          start.stepDiff = consumeInheritedStepDiff(start, preview?.textSha256);
        }
        if (!requiresEnvelopeProbe) yield start;
        const state: typeof activeItem = {
          start,
          queued,
          projector: undefined as unknown as DataUrlProjector,
          textHash: new WhitespaceCollapsedHash(),
          originalTextBytes: 0,
          previewTextSha256: preview?.textSha256,
          stepDiff: start.stepDiff ?? "unique",
          startEmitted: !requiresEnvelopeProbe,
          envelopePrefix: requiresEnvelopeProbe ? "" : undefined,
          semanticInput: classified.input,
          hasMedia: (preview?.mediaDescriptorOrdinals.length ?? 0) > 0,
          mediaSha256: [...(preview?.mediaSha256 ?? [])],
        };
        state.projector = new DataUrlProjector({
          exchangeId: options.exchangeId,
          bodySide: options.side,
          jsonPath: slot.path,
          rawBodySha256: options.rawBodySha256,
          sourceStorage: options.sourceStorage,
          ordinal: mediaOrdinal,
          maxDescriptors: Math.max(0, 256 - mediaOrdinal),
          onText: value => {
            if (!value) return;
            const rendered = value === "[media]" && state.descriptorText
              ? state.descriptorText
              : value;
            state.descriptorText = undefined;
            queued.push({ type: "text", value: rendered });
          },
          onDescriptor: descriptor => {
            mediaOrdinal = Math.max(mediaOrdinal, descriptor.ordinal + 1);
            state.hasMedia = true;
            if (!state.mediaSha256.includes(descriptor.sha256)) state.mediaSha256.push(descriptor.sha256);
            state.start.contentKinds = conversationContentKindsFor(
              state.start.providerItemType,
              true,
            );
            state.descriptorText = `[media ${descriptor.mediaType}; encodedBytes=${descriptor.encodedBytes}; decodedBytes=${descriptor.decodedBytes}; sha256=${descriptor.sha256}]`;
            queued.push({
              type: "media_descriptor",
              side: descriptor.bodySide,
              ordinal: descriptor.ordinal,
              jsonPath: descriptor.jsonPath,
              mediaType: descriptor.mediaType,
              encodedBytes: descriptor.encodedBytes,
              decodedBytes: descriptor.decodedBytes,
              sha256: descriptor.sha256,
              sourceStorage: descriptor.sourceStorage,
            });
          },
          decodedMediaOrdinal: options.decodedMediaOrdinal,
          onDecodedBytes: options.decodedMediaOrdinal === undefined
            ? undefined
            : (value, media) => {
                queued.push({
                  type: "media_bytes",
                  side: options.side,
                  ordinal: media.ordinal,
                  mediaType: media.mediaType,
                  value: Buffer.from(value),
                });
              },
        });
        activeItem = state;
      } else if (token.name === "stringChunk") {
        const value = String(token.value ?? "");
        if (activeItem) {
          if (!activeItem.startEmitted) {
            const currentPrefix = activeItem.envelopePrefix ?? "";
            activeItem.envelopePrefix = (
              currentPrefix + value
            ).slice(0, AGENT_ENVELOPE_PREFIX_MAX_CHARACTERS);
            const decision = classifyAgentEnvelopePrefix(
              options.agentKind ?? "unknown",
              activeItem.envelopePrefix,
            );
            if (
              decision !== "pending"
              || activeItem.envelopePrefix.length
                >= AGENT_ENVELOPE_PREFIX_MAX_CHARACTERS
            ) {
              applyEnvelopeSemantic(activeItem);
              completeInjectionProbe(activeItem);
              activeItem.startEmitted = true;
              activeItem.envelopePrefix = undefined;
              yield activeItem.start;
            }
          }
          activeItem.textHash.update(value);
          activeItem.originalTextBytes += Buffer.byteLength(value);
          activeItem.projector.push(value);
          while (activeItem.queued.length > 0) yield activeItem.queued.shift()!;
        } else if (activeToolLeaf) {
          if (
            !activeToolLeaf.truncated
            && activeToolLeaf.value.length < TOOL_BLOCK_LEAF_MAX_CHARACTERS
          ) {
            activeToolLeaf.value += value.slice(
              0,
              TOOL_BLOCK_LEAF_MAX_CHARACTERS - activeToolLeaf.value.length,
            );
          } else {
            activeToolLeaf.truncated = true;
          }
        } else if (activeScalar && activeScalar.key && activeScalar.value.length < 512) {
          activeScalar.value += value.slice(0, 512 - activeScalar.value.length);
        }
      } else if (token.name === "endString") {
        if (activeToolLeaf) {
          const leaf = activeToolLeaf;
          activeToolLeaf = undefined;
          bufferToolLeaf(leaf.root, leaf.path, "string", leaf.value);
          if (leaf.truncated) {
            const buffer = toolBlocks.get(leaf.root);
            if (buffer) buffer.truncated = true;
          }
        } else if (activeItem) {
          const completedItem = activeItem;
          if (!completedItem.startEmitted) {
            applyEnvelopeSemantic(completedItem);
            completeInjectionProbe(completedItem);
            completedItem.startEmitted = true;
            completedItem.envelopePrefix = undefined;
            yield completedItem.start;
          }
          completedItem.projector.finish();
          while (completedItem.queued.length > 0) yield completedItem.queued.shift()!;
          activeItem = undefined;
          if (options.format === "sse") {
            const eventPath = /^\$\.events\[\d+\]/u.exec(completedItem.start.jsonPath)?.[0];
            completedSseStart = eventPath
              ? {
                  eventPath,
                  start: completedItem.start,
                  semanticInput: completedItem.semanticInput!,
                }
              : undefined;
          }
          yield {
            type: "item_end",
            textSha256: completedItem.previewTextSha256
              ?? completedItem.textHash.digest(),
            originalTextBytes: completedItem.originalTextBytes,
            contentKinds: conversationContentKindsFor(
              completedItem.start.providerItemType,
              completedItem.hasMedia,
            ),
            mediaSha256: completedItem.mediaSha256.length > 0
              ? [...completedItem.mediaSha256]
              : undefined,
            stepDiff: completedItem.stepDiff,
          };
        } else if (activeScalar) {
          if (activeScalar.key) {
            const parent = frames.at(-1);
            if (parent) parent.metadata[activeScalar.key] = activeScalar.value;
            applyLateMetadata(activeScalar.path, activeScalar.key, activeScalar.value);
          }
          activeScalar = undefined;
        }
      } else if (token.name === "startNumber") {
        const slot = reservePath();
        const key = slot.key ?? exportLastPathKey(slot.path);
        if (isExportMetadataKey(key)) {
          activeScalar = { path: slot.path, key, value: "" };
        } else if (toolBlocksEnabled) {
          const block = outermostToolBlockFrame(frames);
          if (block) activeNumber = { path: slot.path, key: "", value: "" };
        }
      } else if (token.name === "numberChunk") {
        if (activeNumber && activeNumber.value.length < 64) {
          activeNumber.value += String(token.value ?? "").slice(0, 64 - activeNumber.value.length);
        } else if (activeScalar && activeScalar.key && activeScalar.value.length < 512) {
          const value = String(token.value ?? "");
          activeScalar.value += value.slice(0, 512 - activeScalar.value.length);
        }
      } else if (token.name === "endNumber") {
        if (activeNumber) {
          const number = activeNumber;
          activeNumber = undefined;
          const block = outermostToolBlockFrame(frames);
          if (block) bufferToolLeaf(block.path, number.path, "number", number.value);
        } else if (activeScalar?.key) {
          const parent = frames.at(-1);
          if (parent) parent.metadata[activeScalar.key] = activeScalar.value;
          applyLateMetadata(activeScalar.path, activeScalar.key, activeScalar.value);
        }
        activeScalar = undefined;
      } else if (
        token.name === "nullValue"
        || token.name === "trueValue"
        || token.name === "falseValue"
      ) {
        const slot = reservePath();
        if (toolBlocksEnabled) {
          const block = outermostToolBlockFrame(frames);
          if (block) {
            const kind = token.name === "nullValue"
              ? "null"
              : token.name === "trueValue" ? "boolean" : "boolean";
            const value = token.name === "trueValue" ? "true" : "false";
            bufferToolLeaf(block.path, slot.path, kind, value);
          }
        }
      }
    }
    await pipePromise;
    if (frames.length > 0 || activeItem || activeScalar || activeToolLeaf || activeNumber) {
      throw new Error("完整导出 JSON 未在完整边界结束。");
    }
  } finally {
    tokenizer.destroy();
    await pipePromise.catch(() => undefined);
  }
}

async function* coalesceSseConversationEvents(
  events: AsyncIterable<ConversationBodyEvent>,
): AsyncGenerator<ConversationBodyEvent> {
  // 空生命周期项只保存逻辑身份；首次非空 delta 到来时才真正下发 item_start。
  let scalarStart: Extract<ConversationBodyEvent, { type: "item_start" }> | undefined;
  let scalarHasContent = false;
  let suppressScalarContent = false;
  let emptySeed: Extract<ConversationBodyEvent, { type: "item_start" }> | undefined;
  let logicalStart: Extract<ConversationBodyEvent, { type: "item_start" }> | undefined;
  let textHash = new WhitespaceCollapsedHash();
  let textBytes = 0;

  const completed = (): Extract<ConversationBodyEvent, { type: "item_end" }> => ({
    type: "item_end",
    textSha256: textHash.digest(),
    originalTextBytes: textBytes,
    contentKinds: logicalStart?.contentKinds ?? ["text"],
    stepDiff: "unique",
  });

  const enrichedStart = (
    current: Extract<ConversationBodyEvent, { type: "item_start" }>,
  ): Extract<ConversationBodyEvent, { type: "item_start" }> => {
    if (!emptySeed || !sameSseLogicalKind(emptySeed, current)) return current;
    return {
      ...current,
      toolName: current.toolName ?? emptySeed.toolName,
      toolUseId: current.toolUseId ?? emptySeed.toolUseId,
    };
  };

  for await (const event of events) {
    if (event.type === "item_start") {
      scalarStart = event;
      scalarHasContent = false;
      suppressScalarContent = !!(
        event.streamEventType
        && isSseReconciledContentFinalEvent(event.streamEventType)
        && logicalStart
        && sameSseLogicalItem(logicalStart, enrichedStart(event))
      );
      continue;
    }
    if (event.type === "text") {
      if (!event.value || !scalarStart) continue;
      if (suppressScalarContent) {
        scalarHasContent = true;
        continue;
      }
      const nextStart = enrichedStart(scalarStart);
      if (!logicalStart || !sameSseLogicalItem(logicalStart, nextStart)) {
        if (logicalStart) yield completed();
        logicalStart = nextStart;
        logicalStart.stepDiff = "unique";
        textHash = new WhitespaceCollapsedHash();
        textBytes = 0;
        yield logicalStart;
      }
      emptySeed = undefined;
      scalarHasContent = true;
      textHash.update(event.value);
      textBytes += Buffer.byteLength(event.value);
      yield event;
      continue;
    }
    if (event.type === "media_descriptor") {
      if (!scalarStart) continue;
      const nextStart = enrichedStart(scalarStart);
      if (!logicalStart || !sameSseLogicalItem(logicalStart, nextStart)) {
        if (logicalStart) yield completed();
        logicalStart = nextStart;
        logicalStart.stepDiff = "unique";
        textHash = new WhitespaceCollapsedHash();
        textBytes = 0;
        yield logicalStart;
      }
      emptySeed = undefined;
      scalarHasContent = true;
      yield event;
      continue;
    }
    if (event.type === "item_end") {
      if (!scalarHasContent && scalarStart) emptySeed = scalarStart;
      scalarStart = undefined;
      scalarHasContent = false;
      suppressScalarContent = false;
      continue;
    }
    yield event;
  }
  if (logicalStart) yield completed();
}

function sameSseLogicalKind(
  left: Extract<ConversationBodyEvent, { type: "item_start" }>,
  right: Extract<ConversationBodyEvent, { type: "item_start" }>,
): boolean {
  return left.side === right.side && left.category === right.category;
}

function sameSseLogicalItem(
  left: Extract<ConversationBodyEvent, { type: "item_start" }>,
  right: Extract<ConversationBodyEvent, { type: "item_start" }>,
): boolean {
  if (!sameSseLogicalKind(left, right)) return false;
  // SSE 字段顺序不稳定：首个 delta 可能在同一事件后续字段读到 item_id
  // 之前就已产出，因而只有一侧具备稳定 provider lineage。双方都有稳定
  // lineage 时才按 logicalId 强制拆分；否则沿用类别/工具元数据兼容兜底。
  if (left.providerLineageKey && right.providerLineageKey
    && left.logicalId !== right.logicalId) return false;
  if (left.toolUseId && right.toolUseId && left.toolUseId !== right.toolUseId) return false;
  if (left.toolName && right.toolName && left.toolName !== right.toolName) return false;
  return true;
}

function consumeFingerprint(
  fingerprints: Map<string, number> | undefined,
  key: string,
): boolean {
  if (!fingerprints) return false;
  const count = fingerprints.get(key) ?? 0;
  if (count <= 0) return false;
  fingerprints.set(key, count - 1);
  return true;
}

function isExportMetadataKey(key: string): boolean {
  return [
    "role",
    "type",
    "name",
    "id",
    "item_id",
    "call_id",
    "index",
    "output_index",
    "content_index",
    "stop_reason",
    "finish_reason",
  ].includes(key);
}

function isExportConversationTextPath(
  path: string,
  key: string,
  materializedPreview: boolean,
  side: "request" | "response",
  eventType?: string,
): boolean {
  if (side === "response" && isSseControlSnapshotEvent(eventType)) return false;
  if (side === "response" && isSseLifecycleSnapshotPath(path)) return false;
  if (materializedPreview) return true;
  if (key === "image_url" || key === "url") return path.includes("image");
  return [
    "text",
    "content",
    "input",
    "output",
    "arguments",
    "thinking",
    "reasoning",
    "reasoning_content",
    "refusal",
    "summary",
    "system",
    "instructions",
    "delta",
    "partial_json",
  ].includes(key);
}

/**
 * Raw SSE 的生命周期快照可能把 instructions/output 放在 type 之前；
 * 路径级保护避免在尚未读到事件 type 时把快照字段当成模型正文。
 */
function isSseLifecycleSnapshotPath(path: string): boolean {
  return /^\$\.events\[\d+\](?:\.data)?\.response\.(?:instructions|output)(?:\.|\[|$)/u.test(path);
}

function classifyStreamSemantic(input: {
  options: IterateConversationBodyEventsOptions;
  frames: readonly ExportJsonFrame[];
  path: string;
  key: string;
  metadata: Record<string, string>;
  eventType?: string;
  preview?: ExchangeContentPreviewItem;
  toolName?: string;
  toolUseId?: string;
}): { semantic: ConversationSemanticItem; input: SemanticLaneInput } {
  const sseLane = stableSseSemanticLane(
    input.options.protocol,
    input.eventType,
    input.metadata,
    input.path,
  );
  const providerItemId = input.preview?.providerItemId
    ?? input.metadata.item_id
    ?? input.metadata.id;
  const providerItemType = input.preview?.itemType
    ?? sseLane?.providerItemType
    ?? input.eventType
    ?? input.metadata.type
    ?? input.key;
  const semanticInput: SemanticLaneInput = {
    protocol: semanticProtocolKind(input.options.protocol),
    agentKind: input.options.agentKind ?? "unknown",
    bodySide: input.options.side,
    providerRole: input.preview?.role ?? input.metadata.role,
    providerItemType,
    ancestorTypes: input.preview?.ancestorTypes
      ?? input.frames.flatMap(frame =>
        frame.metadata.type ? [frame.metadata.type] : []),
    evidencePath: input.path,
    parentIdentity: sseLane?.parentIdentity
      ?? (providerItemId ? `item:${providerItemId}` : semanticParentPath(input.path)),
    // 非 SSE 路径与 Worker semanticLaneIdentity 对齐，保证无 Preview 匹配时
    // providerLineageKey/logicalId 仍与持久化指纹一致（boundary_carryover 依赖）。
    semanticLane: sseLane?.semanticLane
      ?? jsonSemanticLaneIdentity(input.path, providerItemType),
    providerItemId,
    textPrefix: input.preview?.textPreview,
    toolName: input.toolName,
    toolUseId: input.toolUseId,
    contentKinds: conversationContentKindsFor(
      providerItemType,
      (input.preview?.mediaDescriptorOrdinals.length ?? 0) > 0,
    ),
    messageStopReason: input.metadata.stop_reason
      ?? input.metadata.finish_reason,
  };
  const classified = classifySemanticLane(semanticInput);
  if (!input.preview) return { semantic: classified, input: semanticInput };
  return {
    semantic: {
      ...classified,
      semanticCategory: input.preview.semanticCategory,
      provenance: input.preview.provenance,
      confidence: input.preview.confidence,
      displayPolicy: input.preview.displayPolicy,
      dedupePolicy: input.preview.dedupePolicy,
      logicalId: input.preview.logicalId,
      providerItemId: input.preview.providerItemId,
      providerLineageKey: input.preview.providerLineageKey,
    },
    input: semanticInput,
  };
}

/**
 * SSE 逻辑 lane 判定：与 Worker 投影器共用 `conversation-semantics/lane-classifier`，
 * 禁止在本文件重新实现正则——历史上这里的副本漏掉了 `custom_tool_call_input`，
 * 导致 Codex 自由格式工具入参被拆成 tool_use + unknown_output 多片。
 */
function stableSseSemanticLane(
  protocol: string,
  eventType: string | undefined,
  metadata: Readonly<Record<string, string>>,
  evidencePath: string,
): {
  parentIdentity: string;
  semanticLane: string;
  providerItemType: string;
} | undefined {
  const lane = resolveSseLane({
    protocol: semanticSseProtocol(protocol),
    ...(eventType !== undefined ? {eventType} : {}),
    evidencePath,
    ...(itemIdForLane(metadata) !== undefined ? {itemId: itemIdForLane(metadata)!} : {}),
    ...(metadata.output_index !== undefined ? {outputIndex: metadata.output_index} : {}),
    ...(metadata.content_index !== undefined ? {contentIndex: metadata.content_index} : {}),
    ...(metadata.index !== undefined ? {index: metadata.index} : {}),
    ...(metadata.type !== undefined ? {blockType: metadata.type} : {}),
  });
  if (!lane) return undefined;
  return {
    parentIdentity: lane.parentIdentity,
    semanticLane: lane.semanticLane,
    providerItemType: lane.family,
  };
}

function semanticSseProtocol(protocol: string): SseLaneProtocol {
  if (
    protocol === "openai-responses"
    || protocol === "anthropic-messages"
    || protocol === "openai-chat-completions"
  ) {
    return protocol;
  }
  return "unknown";
}

function itemIdForLane(metadata: Readonly<Record<string, string>>): string | undefined {
  return metadata.item_id ?? metadata.id;
}

function semanticProtocolKind(value: string): SemanticProtocolKind {
  if (
    value === "openai-chat-completions"
    || value === "openai-responses"
    || value === "anthropic-messages"
  ) {
    return value;
  }
  return "unknown";
}

function semanticParentPath(path: string): string {
  return path.replace(/(?:\.[A-Za-z_$][\w$]*|\[\d+\])$/u, "") || "$";
}

/**
 * 与 Worker 投影器的工具判定保持一致：只有工具类结构才允许把 provider id
 * 用作 toolUseId，普通消息/文本块不得使用。
 */
function isToolItemMetadata(
  path: string,
  metadata: Readonly<Record<string, string>>,
): boolean {
  return path.includes("tool")
    || path.includes("function")
    || (metadata.type ?? "").includes("tool")
    || (metadata.type ?? "").includes("function")
    || (metadata.type ?? "").includes("input_json")
    || metadata.semanticType === "call_output";
}

/**
 * JSON 路径的语义 lane 与 Worker semanticLaneIdentity 对齐：
 * content/summary/tool_calls 数组取索引，其余取末级 key。
 */
function jsonSemanticLaneIdentity(path: string, itemType: string): string {
  const contentIndex = /\.content\[(\d+)\]/u.exec(path)?.[1];
  const summaryIndex = /\.summary\[(\d+)\]/u.exec(path)?.[1];
  const toolIndex = /\.tool_calls\[(\d+)\]/u.exec(path)?.[1];
  if (contentIndex !== undefined) return `content:${contentIndex}:${itemType}`;
  if (summaryIndex !== undefined) return `summary:${summaryIndex}:${itemType}`;
  if (toolIndex !== undefined) return `tool:${toolIndex}:${itemType}`;
  return `${exportLastPathKey(path) || "value"}:${itemType}`;
}

function mergedFrameMetadata(frames: ExportJsonFrame[]): Record<string, string> {
  const metadata: Record<string, string> = {};
  for (const frame of frames) {
    if (isCallOutputType(frame.metadata.type ?? "")) {
      metadata.semanticType = "call_output";
    }
    Object.assign(metadata, frame.metadata);
  }
  return metadata;
}

function sseEventType(frames: ExportJsonFrame[]): string | undefined {
  return frames.find(frame =>
    /^\$\.events\[\d+\](?:\.data)?$/u.test(frame.path)
    && !!frame.metadata.type)?.metadata.type;
}

function isSseControlSnapshotEvent(eventType: string | undefined): boolean {
  if (!eventType) return false;
  if (isSseReconciledContentFinalEvent(eventType)) return false;
  return eventType.endsWith(".done")
    || /^response\.(?:created|queued|in_progress|completed|failed|incomplete|cancelled)$/u.test(eventType)
    || eventType === "message_stop"
    || eventType === "content_block_stop";
}

function isSseReconciledContentFinalEvent(eventType: string): boolean {
  return /^response\.(?:output_text|refusal|reasoning_summary_text|function_call_arguments)\.done$/u
    .test(eventType)
    || eventType === "response.content_part.done"
    || eventType === "response.reasoning_summary_part.done";
}

function isCallOutputType(type: string): boolean {
  return type.split(/\s+/u).some(value =>
    value.endsWith("_call_output") || value.endsWith(".call_output"));
}

function exportJsonPath(parent: string, key: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(key)
    ? `${parent}.${key}`
    : `${parent}[${JSON.stringify(key)}]`;
}

function exportLastPathKey(path: string): string {
  return /\.([A-Za-z_$][\w$]*)$/.exec(path)?.[1] ?? "";
}

/** 从单条 exchange 提取完整对话流条目（输入提示词 + 模型输出） */
export function extractConversationItems(
  exchange: RawCapturedExchange,
  normalized: NormalizedExchange,
  mapping: { turnId?: string; threadId?: string; agentSessionId?: string } | undefined,
): ConversationItem[] {
  const items: ConversationItem[] = [];
  const classification = classifyProtocol(exchange);
  const base = {
    exchangeId: exchange.exchangeId,
    turnId: mapping?.turnId,
    threadId: mapping?.threadId,
    agentSessionId: mapping?.agentSessionId,
    capturedAt: exchange.capturedAt,
    model: normalized.request.model,
    targetId: exchange.routing.targetId,
    targetName: exchange.routing.targetName || exchange.routing.targetId,
    isAuxiliary: classification.isAuxiliary,
    auxiliaryKind: auxiliaryKindFor(exchange, classification.endpointKind),
    agentProtocol: classification.protocol,
  };
  const push = (
    category: ConversationCategory,
    side: ConversationSide,
    text: string,
    extra?: { toolName?: string; toolUseId?: string },
  ): void => {
    const trimmed = text.trim();
    if (!trimmed) return;
    items.push({ category, side, text: trimmed, ...base, ...extra });
  };

  // 输入侧：system（systemBlocks 完整文本）
  for (const block of normalized.request.systemBlocks) {
    if (block.text) push("system", "input", block.text);
  }
  // Normalizer 已使用统一语义层；这里只消费最终类别并隐藏历史重放。
  for (const item of normalized.harnessPayload.conversationItems) {
    if (item.displayPolicy !== "conversation" || !item.summary) continue;
    push(item.semanticCategory, "input", item.summary, {
      toolName: item.toolName,
      toolUseId: item.toolUseId,
    });
  }
  // 输入侧：OpenAI Responses instructions（Codex 基础系统提示词，归入 system）
  const instructions = typeof normalized.request.params.instructions === "string"
    ? normalized.request.params.instructions : undefined;
  if (instructions) push("system", "input", instructions);
  // 输出侧：assistant 文本
  for (const msg of normalized.response.outputMessages) {
    for (const block of msg.content) {
      if (block.type === "text" && block.text) push("assistant", "output", block.text);
    }
  }
  // 输出侧：finalTextBlocks 兜底（部分协议 outputMessages 为空）
  for (const block of normalized.response.finalTextBlocks) {
    if (block.text) push("assistant", "output", block.text);
  }
  // 输出侧：工具调用
  for (const tu of normalized.response.toolUses) {
    push("tool_use", "output", `${tu.name}(${tu.input ? JSON.stringify(tu.input) : ""})`, { toolName: tu.name, toolUseId: tu.id });
  }
  // 输出侧：reasoning/thinking
  for (const rb of normalized.response.reasoningBlocks) {
    if (rb.text) push("reasoning", "output", rb.text);
  }
  if (classification.isAuxiliary) {
    push("tool_result", "output", auxiliaryResponseText(exchange));
  }
  return items;
}

function auxiliaryResponseText(exchange: RawCapturedExchange): string {
  const parsed = exchange.response.parsedBody;
  if (typeof parsed === "string" && parsed.trim()) return parsed;
  if (parsed !== undefined) {
    try {
      return JSON.stringify(parsed, null, 2);
    } catch {
      // 无法序列化时回退到已捕获的原始响应或 HTTP 摘要。
    }
  }
  if (typeof exchange.response.rawBody === "string" && exchange.response.rawBody.trim()) {
    return exchange.response.rawBody;
  }
  return `HTTP ${exchange.response.status} ${exchange.response.statusText}`.trim();
}

function resolveExchangeLimit(filters: ExportFilters): number | undefined {
  const value = filters.exchangeLimit ?? filters.maxExchanges;
  if (value === undefined || !Number.isFinite(value)) return undefined;
  return Math.max(0, Math.floor(value));
}

function resolvePageMaxBytes(filters: ExportFilters): number | undefined {
  const value = filters.pageMaxBytes ?? filters.maxBytes;
  if (value === undefined || !Number.isFinite(value)) return undefined;
  return Math.max(0, Math.floor(value));
}

/**
 * 导出主入口：按过滤条件提取对话流。
 * - scope=all：该范围全部请求。
 * - scope=upto：截止内部 Step（兼容旧 exchangeId）的累积快照。
 * - scope=step：仅当前 step，并与同业务 session 上一个 step 做上下文重放去重对比。
 * - categories：空=全部；非空=只保留选中类别。
 */
export async function loadExportConversation(
  dataDir: string,
  filters: ExportFilters,
  dependencies?: ExportConversationDependencies,
): Promise<ExportResult> {
  if (!dependencies) throw new Error("交互内容查询必须使用 SQLite 数据库依赖。");
  return loadSqliteExportConversation(dataDir, filters, dependencies);
}

async function loadSqliteExportConversation(
  dataDir: string,
  filters: ExportFilters,
  dependencies: ExportConversationDependencies,
): Promise<ExportResult> {
  void dataDir;
  const range = resolveExportRange(filters);
  const includeInherited = filters.includeInherited === true;
  if (range === "none" || hasExplicitEmptyCategorySelection(filters)) {
    return {
      items: [],
      scope: filters.scope,
      total: 0,
      candidateCount: 0,
      processedCount: 0,
      filters,
      dedupe: createDedupeSummary(range, includeInherited, 0, 0, 0),
    };
  }

  const plan = planSqliteExportPage(dependencies.db, filters);
  const {
    selected,
    refs,
    baselineRef: plannedBaselineRef,
    baselineBytes: plannedBaselineBytes,
    processedBytes: plannedProcessedBytes,
    limitedByBytes,
    blockedRef,
    blockedRequiredBytes,
  } = plan;
  const earliestModelRef = [...refs].reverse().find(ref => ref.isModelCall);
  const earliestPersisted = earliestModelRef
    ? loadPersistedRequestDedupe(dependencies.db, earliestModelRef.exchangeId)
    : undefined;
  const baselineRef = earliestPersisted ? undefined : plannedBaselineRef;
  const baselineBytes = earliestPersisted ? 0 : plannedBaselineBytes;
  const processedBytes = earliestPersisted
    ? plannedProcessedBytes - plannedBaselineBytes
    : plannedProcessedBytes;
  const maxBytes = resolvePageMaxBytes(filters);
  const batches: Array<{ ref: ExportExchangeRef; items: ConversationItem[] }> = [];
  const previewSummary = emptyPreviewSummary();
  let previousItems: ConversationItem[] = [];
  if (baselineRef) {
    const baselineProjection = loadExchangeProjectionDetail(
      dependencies.db,
      baselineRef.exchangeId,
    );
    if (baselineProjection) {
      addPreviewSummary(previewSummary, baselineProjection);
      previousItems = filterCategories(
        sortItemsForDisplay(conversationItemsFromProjection(
          baselineRef,
          baselineProjection,
          filters.side,
        )),
        filters.categories,
        filters.categoriesExplicit,
      );
    }
  }
  let uniqueItemCount = 0;
  let inheritedItemCount = 0;
  let stepComparison: StepComparison | undefined;
  const compareSingleStep = !!filters.step && filters.scope !== "upto";
  for (const ref of [...refs].reverse()) {
    const projection = loadExchangeProjectionDetail(dependencies.db, ref.exchangeId);
    if (!projection) continue;
    addPreviewSummary(previewSummary, projection);
    const persisted = ref.isModelCall
      ? loadPersistedRequestDedupe(dependencies.db, ref.exchangeId)
      : undefined;
    const extracted = conversationItemsFromProjection(
      ref,
      projection,
      filters.side,
      persisted,
    );
    const filtered = filterCategories(
      sortItemsForDisplay(extracted),
      filters.categories,
      filters.categoriesExplicit,
    );
    if (!ref.isModelCall) {
      const uniqueItems = markItemsAsUnique(filtered);
      uniqueItemCount += uniqueItems.length;
      batches.push({ ref, items: uniqueItems });
      continue;
    }
    if (persisted) {
      const inherited = filtered.filter(item =>
        item.stepDiff === "inherited").length;
      const unique = filtered.length - inherited;
      uniqueItemCount += unique;
      inheritedItemCount += inherited;
      batches.push({
        ref,
        items: filterInheritedItems(filtered, includeInherited),
      });
      previousItems = filtered;
      continue;
    }
    const compared = compareItemsWithPrevious(filtered, previousItems);
    uniqueItemCount += compared.uniqueItemCount;
    inheritedItemCount += compared.inheritedItemCount;
    batches.push({
      ref,
      items: filterInheritedItems(compared.items, includeInherited),
    });
    if (
      compareSingleStep
      && (ref.agentStepId === filters.step || ref.exchangeId === filters.step)
    ) {
      stepComparison = baselineRef
        ? {
            status: "compared",
            currentExchangeId: ref.exchangeId,
            previousExchangeId: baselineRef.exchangeId,
            uniqueItemCount: compared.uniqueItemCount,
            inheritedItemCount: compared.inheritedItemCount,
          }
        : {
            status: "no_previous_turn",
            currentExchangeId: ref.exchangeId,
            uniqueItemCount: compared.uniqueItemCount,
            inheritedItemCount: compared.inheritedItemCount,
          };
    }
    previousItems = filtered;
  }
  const items = batches
    .sort((left, right) => compareSqliteRefPosition(right.ref, left.ref))
    .flatMap((batch) => batch.items);
  const processedExchangeCount = refs.length + (baselineRef ? 1 : 0);
  const hasMore = selected.hasMore || refs.length < selected.refs.length;
  const nextCursor = hasMore && refs.length > 0
    ? encodeExportCursor(refs.at(-1)!)
    : undefined;
  const exchangeLimit = resolveExchangeLimit(filters) ?? DEFAULT_FULL_EXPORT_PAGE_EXCHANGES;
  const limited = hasMore || filters.cursor || limitedByBytes
    ? {
        candidateCount: selected.candidateCount,
        processedExchangeCount,
        maxExchanges: exchangeLimit,
        ...(maxBytes !== undefined ? {
          maxBytes,
          processedBytes: processedBytes + baselineBytes,
        } : {}),
      }
    : undefined;
  const page: ExportPageInfo = {
    candidateCount: selected.candidateCount,
    processedExchangeCount,
    loadedExchangeIds: refs.map((ref) => ref.exchangeId),
    firstExchangeId: refs[0]?.exchangeId,
    lastExchangeId: refs.at(-1)?.exchangeId,
    cursor: filters.cursor,
    nextCursor,
    hasMoreOlder: !!nextCursor,
    exchangeLimit,
    pageMaxBytes: maxBytes,
    processedBytes: processedBytes + baselineBytes,
    visibleProcessedBytes: processedBytes,
    baselineExchangeId: baselineRef?.exchangeId,
    baselineBytes,
    dedupeBaselineStatus: limitedByBytes && refs.length === 0
      ? "budget_blocked"
      : baselineRef ? "compared" : "not_required",
    ...(limitedByBytes ? {
      limitedByBytes: true,
      blockedExchangeId: blockedRef?.exchangeId,
      requiredBytes: blockedRequiredBytes,
    } : {}),
  };

  return {
    items,
    scope: filters.scope,
    total: items.length,
    candidateCount: selected.candidateCount,
    processedCount: processedExchangeCount,
    filters,
    page,
    limited,
    stepComparison,
    preview: {
      ...previewSummary,
      limited: previewSummary.limitedExchangeCount > 0
        || previewSummary.notMaterializedExchangeCount > 0
        || previewSummary.unavailableExchangeCount > 0
        || previewSummary.integrityFailedExchangeCount > 0,
    },
    dedupe: createDedupeSummary(
      range,
      includeInherited,
      uniqueItemCount,
      inheritedItemCount,
      processedExchangeCount,
    ),
  };
}

function conversationItemsFromProjection(
  ref: ExportExchangeRef,
  projection: ExchangeProjectionDetail,
  side?: ExportFilters["side"],
  persisted?: PersistedRequestDedupe,
): ConversationItem[] {
  return projection.preview.items.flatMap(item => {
    if (side && item.side !== side) return [];
    const text = item.textPreview?.trim();
    const category = previewConversationCategory(
      item,
      ref.isAuxiliary,
      projection.preview.protocol,
    );
    if (!text || !category) return [];
    const fingerprint = item.side === "request" && persisted
      ? conversationFingerprintKey({
          category,
          side: "input",
          provenance: item.provenance,
          providerItemType: item.itemType,
          textSha256: item.textSha256,
          mediaSha256: item.mediaSha256,
          contentKinds: conversationContentKindsFor(
            item.itemType,
            item.mediaDescriptorOrdinals.length > 0,
          ),
          toolName: item.toolName,
          toolUseId: item.toolUseId,
        })
      : undefined;
    return [{
      category,
      side: item.side === "request" ? "input" : "output",
      text,
      toolName: item.toolName,
      toolUseId: item.toolUseId,
      exchangeId: ref.exchangeId,
      turnId: ref.agentTurnId,
      threadId: ref.agentThreadId,
      agentSessionId: ref.agentSessionId,
      capturedAt: ref.capturedAt,
      model: projection.model,
      failover: projection.failover,
      targetId: ref.targetId,
      targetName: ref.targetName,
      isAuxiliary: ref.isAuxiliary,
      auxiliaryKind: ref.isAuxiliary
        ? auxiliaryKindFromEndpoint(projection.preview.endpointKind)
        : undefined,
      agentProtocol: projection.preview.protocol ?? "unknown",
      contentSource: "sqlite_preview",
      previewState: projection.previewState,
      textSha256: item.textSha256,
      originalTextBytes: item.originalTextBytes,
      previewTextBytes: item.previewTextBytes,
      truncated: item.truncated,
      mediaDescriptorOrdinals: [...item.mediaDescriptorOrdinals],
      stepDiff: item.side === "response"
        ? "unique"
        : persisted && fingerprint
          ? consumePersistedRequestFreshness(persisted, {
              fingerprint,
              providerLineageKey: item.providerLineageKey,
            })
          : undefined,
    } satisfies ConversationItem];
  });
}

export function previewConversationCategory(
  item: ExchangeProjectionDetail["preview"]["items"][number],
  isAuxiliary: boolean,
  protocol?: string,
): ConversationCategory | undefined {
  void protocol;
  if (isAuxiliary) return "tool_result";
  return item.displayPolicy === "conversation"
    ? item.semanticCategory
    : undefined;
}

export function auxiliaryKindFromEndpoint(endpointKind: string | undefined): AuxiliaryKind {
  if (endpointKind === "token-count") return "token_count";
  if (endpointKind === "title-generation") return "title_generation";
  if (endpointKind === "health-check") return "health_check";
  if (endpointKind === "metadata") return "metadata";
  return "unknown";
}

function emptyPreviewSummary(): ExportPreviewSummary {
  return {
    candidateItemCount: 0,
    processedItemCount: 0,
    candidateTextBytes: 0,
    processedTextBytes: 0,
    limitedExchangeCount: 0,
    notMaterializedExchangeCount: 0,
    unavailableExchangeCount: 0,
    integrityFailedExchangeCount: 0,
    limited: false,
  };
}

function addPreviewSummary(
  summary: ExportPreviewSummary,
  projection: ExchangeProjectionDetail,
): void {
  summary.candidateItemCount += projection.preview.itemCandidateCount;
  summary.processedItemCount += projection.preview.itemProcessedCount;
  summary.candidateTextBytes += projection.preview.candidateTextBytes;
  summary.processedTextBytes += projection.preview.processedTextBytes;
  if (projection.previewState === "limited") summary.limitedExchangeCount += 1;
  if (projection.previewState === "not_materialized") summary.notMaterializedExchangeCount += 1;
  if (projection.previewState === "unavailable") summary.unavailableExchangeCount += 1;
  if (projection.previewState === "integrity_failed") summary.integrityFailedExchangeCount += 1;
}

interface SqliteExportPagePlan {
  selected: ReturnType<typeof selectExportExchangeRefs>;
  refs: ExportExchangeRef[];
  baselineRef?: ExportExchangeRef;
  baselineBytes: number;
  processedBytes: number;
  limitedByBytes: boolean;
  blockedRef?: ExportExchangeRef;
  blockedRequiredBytes?: number;
  nextCursor?: string;
}

/** 只规划引用和字节预算；完整导出预检调用此函数时不会触碰 raw/blob。 */
function planSqliteExportPage(
  db: DeepaaDatabase,
  filters: ExportFilters,
  byteMode: "preview" | "raw" = "preview",
): SqliteExportPagePlan {
  const selected = selectExportExchangeRefs(db, filters);
  const maxBytes = resolvePageMaxBytes(filters);
  const acceptedExchangeIds = new Set<string>();
  const refs: ExportExchangeRef[] = [];
  let processedBytes = 0;
  let baselineRef: ExportExchangeRef | undefined;
  let baselineBytes = 0;
  let limitedByBytes = false;
  let blockedRef: ExportExchangeRef | undefined;
  let blockedRequiredBytes: number | undefined;
  for (const ref of selected.refs) {
    const nextBytes = processedBytes + exportPlannedByteSize(ref, byteMode);
    const earliestModel = [...refs, ref].reverse().find(item => item.isModelCall);
    let nextBaseline = earliestModel
      ? selectPreviousExportModelRef(db, filters, earliestModel)
      : undefined;
    // 当前页内的请求会按时间顺序参与上下文对比，不应再次作为隐藏基线读取。
    if (nextBaseline && acceptedExchangeIds.has(nextBaseline.exchangeId)) nextBaseline = undefined;
    const nextBaselineBytes = nextBaseline
      ? (byteMode === "raw" ? 0 : exportPlannedByteSize(nextBaseline, byteMode))
      : 0;
    if (maxBytes !== undefined && nextBytes + nextBaselineBytes > maxBytes) {
      limitedByBytes = true;
      blockedRef = ref;
      blockedRequiredBytes = nextBytes + nextBaselineBytes;
      break;
    }
    refs.push(ref);
    acceptedExchangeIds.add(ref.exchangeId);
    processedBytes = nextBytes;
    baselineRef = nextBaseline;
    baselineBytes = nextBaselineBytes;
  }
  const hasMore = selected.hasMore || refs.length < selected.refs.length;
  return {
    selected,
    refs,
    baselineRef,
    baselineBytes,
    processedBytes,
    limitedByBytes,
    blockedRef,
    blockedRequiredBytes,
    nextCursor: hasMore && refs.length > 0
      ? encodeExportCursor(refs.at(-1)!)
      : undefined,
  };
}

export async function loadAllExportConversationItems(
  dataDir: string,
  filters: ExportFilters,
  dependencies?: ExportConversationDependencies,
): Promise<ConversationItem[]> {
  const items: ConversationItem[] = [];
  const preflight = await preflightFullExport(dataDir, filters, dependencies);
  for await (const item of iterateExportConversationItems(
    dataDir,
    filters,
    preflight,
    dependencies,
  )) {
    items.push(item);
  }
  return items;
}

export interface FullExportPreflight {
  ok: boolean;
  reason?: "range_required" | "page_budget_exceeded";
  blockedPage?: ExportPageInfo;
  pageCount: number;
  candidateExchangeCount: number;
  declaredBodyBytes: number;
  range: ExportConversationRange;
  includeInherited: boolean;
  singleStep: boolean;
  /** SQLite 预检不保存所有页引用，流式阶段按同一筛选重新执行 keyset 查询。 */
  sqlite?: boolean;
}

/**
 * 完整导出预检只读取轻量索引聚合，不遍历或冻结所有分页引用。
 * 单条 Raw 超过页预算时在下载响应体创建前拒绝；其余记录由流式阶段按 keyset 分页。
 */
export async function preflightFullExport(
  dataDir: string,
  filters: ExportFilters,
  dependencies?: ExportConversationDependencies,
): Promise<FullExportPreflight> {
  void dataDir;
  if (!dependencies) throw new Error("完整导出预检必须使用 SQLite 数据库依赖。");
  return preflightSqliteFullExport(filters, dependencies);
}

function preflightSqliteFullExport(
  filters: ExportFilters,
  dependencies: ExportConversationDependencies,
): FullExportPreflight {
  const range = resolveExportRange(filters);
  const includeInherited = filters.includeInherited === true;
  const singleStep = filters.scope === "step"
    || (!!filters.step && filters.scope !== "upto");
  const estimate = range === "none"
    ? {
        candidateExchangeCount: 0,
        declaredBodyBytes: 0,
        maxDeclaredBodyBytes: 0,
      }
    : estimateExportRange(dependencies.db, filters);
  const {
    maxDeclaredBodyBytes,
    ...publicEstimate
  } = estimate;
  const base: FullExportPreflight = {
    ok: range !== "none",
    ...(range === "none" ? { reason: "range_required" as const } : {}),
    pageCount: 0,
    ...publicEstimate,
    range,
    includeInherited,
    singleStep,
    sqlite: true,
  };
  if (range === "none" || hasExplicitEmptyCategorySelection(filters)) {
    return base;
  }

  const exchangeLimit = resolveExchangeLimit(filters)
    ?? DEFAULT_FULL_EXPORT_PAGE_EXCHANGES;
  const pageMaxBytes = resolvePageMaxBytes(filters);
  if (
    pageMaxBytes !== undefined
    && maxDeclaredBodyBytes > pageMaxBytes
  ) {
    const violation = findExportBodyBudgetViolation(
      dependencies.db,
      filters,
      pageMaxBytes,
    );
    return {
      ...base,
      ok: false,
      reason: "page_budget_exceeded",
      blockedPage: {
        candidateCount: estimate.candidateExchangeCount,
        processedExchangeCount: 0,
        loadedExchangeIds: [],
        cursor: filters.cursor,
        hasMoreOlder: false,
        exchangeLimit,
        pageMaxBytes,
        processedBytes: 0,
        visibleProcessedBytes: 0,
        baselineBytes: 0,
        dedupeBaselineStatus: "budget_blocked",
        blockedExchangeId: violation?.exchangeId,
        requiredBytes: violation?.declaredBodyBytes
          ?? maxDeclaredBodyBytes,
        limitedByBytes: true,
      },
    };
  }
  const pagesByCount = Math.ceil(
    estimate.candidateExchangeCount / Math.max(1, exchangeLimit),
  );
  const pagesByBytes = pageMaxBytes && pageMaxBytes > 0
    ? Math.ceil(estimate.declaredBodyBytes / pageMaxBytes)
    : 0;
  return {
    ...base,
    pageCount: singleStep
      ? Math.min(1, estimate.candidateExchangeCount)
      : Math.max(pagesByCount, pagesByBytes),
  };
}

/**
 * 完整导出统一走分页入口逐页 drain，避免为 session/turn 先构造巨型 items 数组。
 * 调用方负责把 item 流式写出为 Markdown/JSONL/JSON 等传输格式。
 */
export async function* iterateExportConversationItems(
  dataDir: string,
  filters: ExportFilters,
  preparedPreflight?: FullExportPreflight,
  dependencies?: ExportConversationDependencies,
): AsyncGenerator<ConversationItem> {
  const preflight = preparedPreflight
    || await preflightFullExport(dataDir, filters, dependencies);
  if (!preflight.ok) {
    const blocked = preflight.blockedPage;
    throw new Error(`完整导出读取预算不足：${blocked?.blockedExchangeId || "unknown"} 需要 ${blocked?.requiredBytes || 0} 字节。`);
  }
  if (preflight.sqlite) {
    if (!dependencies) {
      throw new Error("SQLite 完整导出缺少数据库依赖。");
    }
    const rawReader = dependencies.rawReader;
    if (!rawReader) {
      throw new Error("完整对话下载必须使用流式渲染入口。");
    }
    let cursor = filters.cursor;
    for (;;) {
      const page = await loadInjectedRawExportPage(
        { ...filters, cursor },
        { ...dependencies, rawReader },
      );
      for (const item of page.items) yield item;
      const nextCursor = page.nextCursor;
      if (!nextCursor || nextCursor === cursor) break;
      cursor = nextCursor;
    }
    return;
  }
  throw new Error("完整导出预检不是 SQLite 计划。");
}

async function loadInjectedRawExportPage(
  filters: ExportFilters,
  dependencies: ExportConversationDependencies & {
    rawReader: NonNullable<ExportConversationDependencies["rawReader"]>;
  },
): Promise<{ items: ConversationItem[]; nextCursor?: string }> {
  const plan = planSqliteExportPage(dependencies.db, filters, "raw");
  let previousItems: ConversationItem[] = [];
  if (plan.baselineRef) {
    const baseline = await dependencies.rawReader(plan.baselineRef);
    if (baseline) {
      previousItems = filterCategories(
        sortItemsForDisplay(extractConversationItems(
          baseline,
          normalizeExchange(baseline),
          mappingFromRef(plan.baselineRef),
        ).filter(item => sideSelected(item.side, filters.side))),
        filters.categories,
        filters.categoriesExplicit,
      );
    }
  }
  const batches: Array<{ ref: ExportExchangeRef; items: ConversationItem[] }> = [];
  for (const ref of [...plan.refs].reverse()) {
    const exchange = await dependencies.rawReader(ref);
    if (!exchange) continue;
    const filtered = filterCategories(
      sortItemsForDisplay(extractConversationItems(
        exchange,
        normalizeExchange(exchange),
        mappingFromRef(ref),
      ).filter(item => sideSelected(item.side, filters.side))),
      filters.categories,
      filters.categoriesExplicit,
    );
    if (!ref.isModelCall) {
      batches.push({ ref, items: markItemsAsUnique(filtered) });
      continue;
    }
    const compared = compareItemsWithPrevious(filtered, previousItems);
    batches.push({
      ref,
      items: filterInheritedItems(compared.items, filters.includeInherited === true),
    });
    previousItems = filtered;
  }
  return {
    items: batches
      .sort((left, right) => compareSqliteRefPosition(right.ref, left.ref))
      .flatMap(batch => batch.items.map(item => ({
        ...item,
        contentSource: "raw_stream" as const,
      }))),
    nextCursor: plan.nextCursor,
  };
}

function mappingFromRef(ref: ExportExchangeRef): {
  turnId?: string;
  threadId?: string;
  agentSessionId?: string;
} {
  return {
    turnId: ref.agentTurnId,
    threadId: ref.agentThreadId,
    agentSessionId: ref.agentSessionId,
  };
}

export type ExportConversationDownloadFormat = "markdown" | "jsonl" | "json";

export async function* renderExportConversationDownload(
  dataDir: string,
  filters: ExportFilters,
  format: ExportConversationDownloadFormat,
  preparedPreflight?: FullExportPreflight,
  dependencies?: ExportConversationDependencies,
): AsyncGenerator<string> {
  if (dependencies && !dependencies.rawReader) {
    yield* renderStreamingExportConversationDownload(
      dataDir,
      filters,
      format,
      preparedPreflight,
      dependencies,
    );
    return;
  }
  if (format === "jsonl") {
    for await (const item of iterateExportConversationItems(
      dataDir,
      filters,
      preparedPreflight,
      dependencies,
    )) {
      yield `${JSON.stringify(item)}\n`;
    }
    return;
  }
  if (format === "json") {
    yield "[\n";
    let first = true;
    for await (const item of iterateExportConversationItems(
      dataDir,
      filters,
      preparedPreflight,
      dependencies,
    )) {
      yield `${first ? "" : ",\n"}${JSON.stringify(item)}`;
      first = false;
    }
    yield "\n]\n";
    return;
  }

  const heading = filters.step || filters.turn || filters.thread || filters.session || "conversation";
  yield `# 对话流完整导出 · ${heading}\n\n`;
  let currentExchangeId = "";
  for await (const item of iterateExportConversationItems(
    dataDir,
    filters,
    preparedPreflight,
    dependencies,
  )) {
    if (item.exchangeId !== currentExchangeId) {
      currentExchangeId = item.exchangeId;
      yield `\n## ${item.exchangeId} · ${item.capturedAt}\n\n`;
    }
    yield `- [${item.side}/${item.category}] ${item.text}\n\n`;
  }
}

interface StreamingDownloadRecord {
  ref: ExportExchangeRef;
  projection?: ExchangeProjectionDetail;
  event: ConversationBodyEvent;
}

async function* renderStreamingExportConversationDownload(
  dataDir: string,
  filters: ExportFilters,
  format: ExportConversationDownloadFormat,
  preparedPreflight: FullExportPreflight | undefined,
  dependencies: ExportConversationDependencies,
): AsyncGenerator<string> {
  const preflight = preparedPreflight
    ?? await preflightFullExport(dataDir, filters, dependencies);
  if (!preflight.ok) {
    throw new Error(preflight.reason === "range_required"
      ? "完整导出必须选择 Session、Thread、Turn 或 Step 范围。"
      : "完整导出读取预算不足。");
  }
  if (format === "markdown") {
    const heading = filters.step || filters.turn || filters.thread || filters.session || "conversation";
    yield `# 对话流完整导出 · ${heading}\n\n`;
  } else if (format === "json") {
    yield "[\n";
  }

  let firstJsonItem = true;
  let currentExchangeId = "";
  let activeFormat: ExportConversationDownloadFormat | undefined;
  for await (const record of iterateStreamingFullExportRecords(
    dataDir,
    filters,
    dependencies,
  )) {
    const event = record.event;
    if (event.type === "item_start") {
      const metadata = streamingItemMetadata(record.ref, record.projection, event);
      activeFormat = format;
      if (format === "markdown") {
        if (record.ref.exchangeId !== currentExchangeId) {
          currentExchangeId = record.ref.exchangeId;
          yield `\n## ${record.ref.exchangeId} · ${record.ref.capturedAt}\n\n`;
        }
        yield `- [${event.side}/${event.category}] `;
      } else {
        const prefix = JSON.stringify(metadata).slice(0, -1);
        if (format === "json") yield firstJsonItem ? "" : ",\n";
        yield `${prefix},\"text\":\"`;
        firstJsonItem = false;
      }
    } else if (event.type === "text" && activeFormat) {
      yield activeFormat === "markdown"
        ? event.value
        : escapeJsonStringChunk(event.value);
    } else if (event.type === "item_end" && activeFormat) {
      yield activeFormat === "markdown" ? "\n\n" : `\"}${activeFormat === "jsonl" ? "\n" : ""}`;
      activeFormat = undefined;
    }
  }
  if (format === "json") yield "\n]\n";
}

async function* iterateStreamingFullExportRecords(
  dataDir: string,
  filters: ExportFilters,
  dependencies: ExportConversationDependencies,
): AsyncGenerator<StreamingDownloadRecord> {
  let cursor = filters.cursor;
  for (;;) {
    const pageFilters = { ...filters, cursor };
    const plan = planSqliteExportPage(dependencies.db, pageFilters, "raw");
    let inheritedHashes = previewHashes(
      plan.baselineRef
        ? loadExchangeProjectionDetail(dependencies.db, plan.baselineRef.exchangeId)
        : undefined,
    );
    for (const ref of [...plan.refs].reverse()) {
      const projection = loadExchangeProjectionDetail(dependencies.db, ref.exchangeId);
      const persisted = ref.isModelCall
        ? loadPersistedRequestDedupe(dependencies.db, ref.exchangeId)
        : undefined;
      for await (const record of iterateRawExchangeDownloadRecords(
        dependencies.db,
        dataDir,
        ref,
        projection,
        inheritedHashes,
        persisted,
        filters.side,
      )) {
        const start = record.event.type === "item_start" ? record.event : undefined;
        const category = start && ref.isAuxiliary ? "tool_result" : start?.category;
        const selected = !start
          || (
            sideSelected(start.side, filters.side)
            && categorySelectedForSide(start.side, category!, filters.categories, filters.categoriesExplicit)
          );
        const inherited = start?.stepDiff === "inherited";
        let emit = selected && (filters.includeInherited === true || !inherited);
        if (start) {
          if (emit) {
            yield {
              ...record,
              event: { ...start, category: category! },
            };
          }
        } else if (record.itemEmitted) {
          yield record;
        }
        record.setItemEmitted?.(emit);
      }
      inheritedHashes = previewHashes(projection);
    }
    const nextCursor = plan.nextCursor;
    if (!nextCursor || nextCursor === cursor) break;
    cursor = nextCursor;
  }
}

interface RawDownloadRecord extends StreamingDownloadRecord {
  itemEmitted?: boolean;
  setItemEmitted?: (value: boolean) => void;
}

async function* iterateRawExchangeDownloadRecords(
  db: DeepaaDatabase,
  dataDir: string,
  ref: ExportExchangeRef,
  projection: ExchangeProjectionDetail | undefined,
  inheritedHashes: ReadonlySet<string>,
  persisted: PersistedRequestDedupe | undefined,
  selectedSide?: ExportFilters["side"],
): AsyncGenerator<RawDownloadRecord> {
  const gate = classifyRawReadGate(db, dataDir, ref.exchangeId);
  if (gate && gate.state !== "active") {
    throw new Error(
      `完整导出中止：${rawReadGateMessage(gate)}（Exchange ${ref.exchangeId}）`,
    );
  }
  const located = await locateRawExchange(db, dataDir, ref.exchangeId);
  if (!located) throw new Error(`完整导出无法定位 Exchange：${ref.exchangeId}`);
  let itemEmitted = false;
  let activeStepDiff: ConversationStepDiff = "unique";
  for (const side of ["request", "response"] as const) {
    if (selectedSide && side !== selectedSide) continue;
    const body = located.exchange[side];
    if (body.bodySizeBytes === 0) continue;
    const opened = await openRawBodyStream(dataDir, body, {
      purpose: "raw",
      label: side,
    });
    for await (const event of iterateConversationBodyEvents({
      stream: opened.stream,
      format: side === "response" && located.exchange.response.isStreaming
        ? "sse"
        : "json",
      exchangeId: ref.exchangeId,
      side,
      rawBodySha256: body.bodySha256,
      sourceStorage: rawSourceStorage(body),
      protocol: projection?.preview.protocol ?? "unknown",
      agentKind: agentKindForExportName(ref.agentName),
      previewItems: projection?.preview.items,
      inheritedHashes: persisted ? undefined : inheritedHashes,
    })) {
      let outputEvent = event;
      if (event.type === "item_start") {
        itemEmitted = false;
        activeStepDiff = persisted && event.side === "input"
          ? event.textSha256
            ? consumePersistedRequestFreshness(persisted, {
                fingerprint: conversationFingerprintKey({
                  category: event.category,
                  side: event.side,
                  provenance: event.provenance,
                  providerItemType: event.providerItemType,
                  textSha256: event.textSha256,
                  mediaSha256: event.mediaSha256,
                  contentKinds: event.contentKinds,
                  toolName: event.toolName,
                  toolUseId: event.toolUseId,
                }),
                providerLineageKey: event.providerLineageKey,
              })
            : "unconfirmed"
          : event.stepDiff ?? "unique";
        outputEvent = { ...event, stepDiff: activeStepDiff };
      } else if (event.type === "item_end") {
        outputEvent = { ...event, stepDiff: activeStepDiff };
      }
      yield {
        ref,
        projection,
        event: outputEvent,
        itemEmitted,
        setItemEmitted: value => {
          itemEmitted = value;
        },
      };
    }
    const verification = await opened.verification;
    if (verification.status !== "verified") {
      throw new Error(`完整导出 ${side} 正文完整性校验失败。`);
    }
  }
}

function agentKindForExportName(name: string): AgentKind {
  // 注册表驱动：已知语义 AgentKind 原样通过；其余非空名按通用工具，空名未知。
  if (isKnownSemanticAgentKind(name)) return name as AgentKind;
  return name ? "generic" : "unknown";
}

function sideSelected(
  side: ConversationSide,
  selected: ExportFilters["side"],
): boolean {
  return !selected
    || (selected === "request" ? side === "input" : side === "output");
}

function previewHashes(
  projection: ExchangeProjectionDetail | undefined,
): ReadonlySet<string> {
  return new Set(
    projection?.preview.items
      .filter(item => item.side === "request")
      .map(item => item.textSha256) ?? [],
  );
}

function streamingItemMetadata(
  ref: ExportExchangeRef,
  projection: ExchangeProjectionDetail | undefined,
  event: Extract<ConversationBodyEvent, { type: "item_start" }>,
): Omit<ConversationItem, "text"> & { jsonPath: string } {
  return {
    category: event.category,
    side: event.side,
    toolName: event.toolName,
    toolUseId: event.toolUseId,
    stepDiff: event.stepDiff,
    exchangeId: ref.exchangeId,
    turnId: ref.agentTurnId,
    threadId: ref.agentThreadId,
    agentSessionId: ref.agentSessionId,
    capturedAt: ref.capturedAt,
    model: projection?.model,
    ...(projection?.failover ? {failover: projection.failover} : {}),
    targetId: ref.targetId,
    targetName: ref.targetName,
    isAuxiliary: ref.isAuxiliary,
    auxiliaryKind: ref.isAuxiliary
      ? auxiliaryKindFromEndpoint(projection?.preview.endpointKind)
      : undefined,
    agentProtocol: projection?.preview.protocol ?? "unknown",
    contentSource: "raw_stream",
    textSha256: event.textSha256,
    jsonPath: event.jsonPath,
  };
}

function rawSourceStorage(
  body: RawCapturedExchange["request"] | RawCapturedExchange["response"],
): Exclude<RawBodyStorage, "none"> {
  return body.rawBodyRef?.storage ?? "inline";
}

function escapeJsonStringChunk(value: string): string {
  return JSON.stringify(value).slice(1, -1);
}

/**
 * 将 SSE 事件流式转换为 `{type,data}` JSON 数组。event 字段先于 data 写入，
 * 使 payload 内 type 后置时也能在正文投影前排除完成快照。
 */
async function* iterateSseJsonArrayChunks(source: Readable): AsyncGenerator<string> {
  const decoder = new StringDecoder("utf8");
  let prefix = "";
  let mode: "prefix" | "data" | "event" | "skip" = "prefix";
  let skipOptionalSpace = false;
  let lineHasCharacters = false;
  let eventLineValue = "";
  let eventName = "";
  let probe = "";
  let eventStarted = false;
  let firstEvent = true;
  yield "[";

  const startEvent = (output: string[]): void => {
    if (eventStarted) return;
    output.push(firstEvent ? "" : ",");
    output.push(eventName
      ? `{"type":${JSON.stringify(eventName)},"data":`
      : "{\"data\":");
    firstEvent = false;
    eventStarted = true;
  };
  const appendData = (value: string, output: string[]): void => {
    if (!value) return;
    if (eventStarted) {
      output.push(value);
      return;
    }
    const combined = probe + value;
    if ("[DONE]".startsWith(combined) && combined.length <= 6) {
      probe = combined;
      return;
    }
    startEvent(output);
    output.push(combined);
    probe = "";
  };
  const finishEvent = (output: string[]): void => {
    if (!eventStarted && probe && probe !== "[DONE]") {
      startEvent(output);
      output.push(probe);
    }
    if (eventStarted) output.push("}");
    probe = "";
    eventStarted = false;
    eventName = "";
  };
  const resetLine = (): void => {
    prefix = "";
    mode = "prefix";
    skipOptionalSpace = false;
    lineHasCharacters = false;
    eventLineValue = "";
  };
  const consumeSegment = (segment: string, lineEnd: boolean): string[] => {
    const output: string[] = [];
    if (segment) lineHasCharacters = true;
    let offset = 0;
    if (mode === "prefix") {
      while (offset < segment.length && mode === "prefix") {
        prefix += segment[offset]!;
        offset += 1;
        const dataPrefix = "data:";
        const eventPrefix = "event:";
        if (prefix === dataPrefix) {
          mode = "data";
          skipOptionalSpace = true;
        } else if (prefix === eventPrefix) {
          mode = "event";
          skipOptionalSpace = true;
        } else if (!dataPrefix.startsWith(prefix) && !eventPrefix.startsWith(prefix)) {
          mode = "skip";
        }
      }
    }
    if ((mode === "data" || mode === "event") && offset < segment.length) {
      if (skipOptionalSpace) {
        if (segment[offset] === " ") offset += 1;
        skipOptionalSpace = false;
      }
      if (mode === "data") {
        appendData(segment.slice(offset), output);
      } else {
        eventLineValue += segment.slice(offset);
      }
    }
    if (lineEnd) {
      if (!lineHasCharacters) {
        finishEvent(output);
      } else if (mode === "data" && eventStarted) {
        output.push("\n");
      } else if (mode === "event") {
        eventName = eventLineValue.slice(0, 512);
      }
      resetLine();
    }
    return output;
  };

  for await (const rawChunk of source) {
    let text = decoder.write(Buffer.from(rawChunk as Uint8Array));
    while (text.length > 0) {
      const newline = text.indexOf("\n");
      if (newline < 0) {
        for (const output of consumeSegment(text, false)) yield output;
        text = "";
      } else {
        const line = text.slice(0, newline).replace(/\r$/, "");
        for (const output of consumeSegment(line, true)) yield output;
        text = text.slice(newline + 1);
      }
    }
  }
  const trailing = decoder.end();
  if (trailing) for (const output of consumeSegment(trailing, false)) yield output;
  const finalOutput: string[] = [];
  finishEvent(finalOutput);
  for (const output of finalOutput) yield output;
  yield "]";
}

function resolveExportRange(filters: ExportFilters): ExportConversationRange {
  if (filters.step) return "step";
  if (filters.turn) return "turn";
  if (filters.thread) return "thread";
  if (filters.session) return "session";
  return "none";
}

function compareSqliteRefPosition(
  left: ExportExchangeRef,
  right: ExportExchangeRef,
): number {
  const time = left.capturedAt.localeCompare(right.capturedAt);
  if (time !== 0) return time;
  return left.exchangeId.localeCompare(right.exchangeId);
}

function exportPlannedByteSize(
  ref: ExportExchangeRef,
  mode: "preview" | "raw",
): number {
  if (mode === "preview") return ref.previewSizeBytes;
  return ref.requestBodyBytes + ref.responseBodyBytes;
}

function createDedupeSummary(
  range: ExportConversationRange,
  includeInherited: boolean,
  uniqueItemCount: number,
  inheritedItemCount: number,
  processedExchangeCount: number,
): ExportDedupeSummary {
  return {
    mode: "context_replay",
    range,
    requiredRangeMissing: range === "none",
    includeInherited,
    uniqueItemCount,
    inheritedItemCount,
    hiddenInheritedItemCount: includeInherited ? 0 : inheritedItemCount,
    processedExchangeCount,
  };
}

function filterInheritedItems(items: ConversationItem[], includeInherited: boolean): ConversationItem[] {
  return includeInherited ? items : items.filter(item => item.stepDiff !== "inherited");
}

function markItemsAsUnique(items: ConversationItem[]): ConversationItem[] {
  return items.map(item => ({ ...item, stepDiff: "unique" as const }));
}

function compareItemsWithPrevious(
  currentItems: ConversationItem[],
  previousItems: ConversationItem[],
): { items: ConversationItem[]; uniqueItemCount: number; inheritedItemCount: number } {
  if (previousItems.length === 0) {
    const items = markItemsAsUnique(currentItems);
    return { items, uniqueItemCount: items.length, inheritedItemCount: 0 };
  }

  const previousCounts = new Map<string, number>();
  for (const item of previousItems) {
    if (item.side !== "input") continue;
    const key = itemComparisonKey(item);
    previousCounts.set(key, (previousCounts.get(key) || 0) + 1);
  }

  let uniqueItemCount = 0;
  let inheritedItemCount = 0;
  const items = currentItems.map(item => {
    if (item.side === "output") {
      uniqueItemCount++;
      return { ...item, stepDiff: "unique" as const };
    }
    const key = itemComparisonKey(item);
    const count = previousCounts.get(key) || 0;
    if (count > 0) {
      previousCounts.set(key, count - 1);
      inheritedItemCount++;
      return { ...item, stepDiff: "inherited" as const };
    }
    uniqueItemCount++;
    return { ...item, stepDiff: "unique" as const };
  });
  return { items, uniqueItemCount, inheritedItemCount };
}

function sortItemsForDisplay(items: ConversationItem[]): ConversationItem[] {
  return [...items].reverse();
}

function filterCategories(items: ConversationItem[], categories: ConversationCategory[], categoriesExplicit?: boolean): ConversationItem[] {
  if (categories.length === 0 && categoriesExplicit) return [];
  if (categories.length === 0) return items;
  return items.filter(item => {
    const selected = selectedCategoriesForSide(categories, item.side);
    return selected.length === 0 || selected.includes(item.category);
  });
}

function hasExplicitEmptyCategorySelection(filters: ExportFilters): boolean {
  return filters.categoriesExplicit === true && filters.categories.length === 0;
}

function itemComparisonKey(item: ConversationItem): string {
  return stableHash({
    category: item.category,
    side: item.side,
    text: item.text,
    toolName: item.toolName,
    toolUseId: item.toolUseId,
  });
}

function auxiliaryKindFor(
  exchange: RawCapturedExchange,
  endpointKind: ReturnType<typeof classifyProtocol>["endpointKind"],
): AuxiliaryKind | undefined {
  if (endpointKind === "model-call") return undefined;
  if (exchange.response.status === 401 || exchange.response.status === 403) return "auth_error";
  if (endpointKind === "token-count") return "token_count";
  if (endpointKind === "title-generation") return "title_generation";
  if (endpointKind === "health-check") return "health_check";
  if (endpointKind === "metadata") return "metadata";
  return "unknown";
}

export { ALL_CATEGORIES };
