import { createHash, type Hash } from "node:crypto";
import { WhitespaceCollapsedHash } from "../conversation-semantics/whitespace-hash";
import type {
  ExchangeContentFilterItem,
  ExchangeContentPreviewDraft,
  ExchangeContentPreviewItem,
  ExchangeOverviewCandidate,
  LimitedDimension,
  PreviewSemanticType,
  ProjectionBodySide,
} from "./projection-types";
import {
  buildSemanticLogicalId,
  classifySemanticLane,
  conversationContentKindsFor,
  conversationFingerprintKey,
  isMediaOnlyConversationPreview,
  type AgentKind,
  type ConversationSemanticItem,
  type ConversationSemanticOverride,
  type ProtocolKind,
  type RequestContextMode,
} from "../conversation-semantics";
import type { StreamLifecycleSummary } from "../harness/types";

/**
 * Preview 是「列表与概览用的有界索引」，不是正文存储（2026-09-11 存储瘦身）：
 * 正文一律按需从 raw 流式读取（/api/export/content），因此这里只保留代表性条目与
 * 小段文本预览。此前 256 KiB × 8 KiB 的口径让 1.2 万条数据吃掉 2.7 GB。
 */
export const CONTENT_PREVIEW_MAX_BYTES = 48 * 1024;
/** 单条目保留的正文预览上限；超出即视为「索引态」，不计为数据丢失。 */
export const CONTENT_PREVIEW_ITEM_MAX_BYTES = 512;
/**
 * 用户真实输入单独放宽（2026-09-18 用户反馈）：它是「本 Turn 用户输入」卡片的
 * 唯一数据源，512 B 会把正常长度的输入截成半句话。总量仍受 CONTENT_PREVIEW_MAX_BYTES
 * 约束，且该类别本来就有永不驱逐的保护（PROTECTED_CONVERSATION_CATEGORY）。
 */
export const USER_INPUT_PREVIEW_MAX_BYTES = 4 * 1024;
/** 触发 limited 标记的候选条目阈值（与保留条数解耦）。 */
export const CONTENT_PREVIEW_ITEM_LIMIT = 256;
/** 实际保留的代表性条目数上限（首尾优先 + 关键类别豁免）。 */
export const CONTENT_PREVIEW_RETAINED_ITEM_LIMIT = 32;
export const CONTENT_FILTER_ITEM_LIMIT = 4_096;

/**
 * 用户真实输入永不因预算被丢弃：它是列表/概览与 Turn 锚点的最小必要信息。
 * 对应实测根因——旧驱逐顺序按请求位置优先丢掉最靠前的 user_real（仅 47% 留有正文）。
 */
const PROTECTED_CONVERSATION_CATEGORY = "user_real";

/**
 * 最终 Request 上下文在 Worker 短事务内确定。Preview 阶段预留该空间，保证回写
 * contextEpoch/boundary 后仍满足 SQLite 硬限制。
 */
const REQUEST_CONTEXT_RESERVE_BYTES = 4 * 1024;
const METADATA_TEXT_MAX_BYTES = 512;
const DIAGNOSTIC_LIMIT = 64;
const MEDIA_ORDINAL_LIMIT = 256;
const SIDE_RESERVED_ITEM_LIMIT = CONTENT_PREVIEW_RETAINED_ITEM_LIMIT / 2;
const PROTECTED_EDGE_ITEM_COUNT = 4;
const HISTORY_REPLAY_EDGE_ITEM_COUNT = 4;
const HISTORY_REPLAY_SAMPLE_LIMIT = HISTORY_REPLAY_EDGE_ITEM_COUNT * 2;

export interface ContentPreviewBuilderOptions {
  exchangeId: string;
  projectionVersion: number;
  protocol?: string;
  agentKind?: AgentKind;
  endpointKind?: string;
  onClassifiedItem?: (item: ExchangeContentPreviewItem) => void;
}

export interface BeginContentPreviewItemOptions {
  side: ProjectionBodySide;
  category: string;
  semanticType?: PreviewSemanticType;
  role?: string;
  itemType: string;
  ancestorTypes?: string[];
  jsonPath: string;
  parentIdentity?: string;
  semanticLane?: string;
  providerItemId?: string;
  toolName?: string;
  toolUseId?: string;
  messageStopReason?: string;
  syntheticProviderControl?: boolean;
  semanticOverride?: ConversationSemanticOverride;
}

export interface MergeContentPreviewOptions extends ContentPreviewBuilderOptions {
  drafts: ExchangeContentPreviewDraft[];
  streamLifecycle?: StreamLifecycleSummary;
}

export interface ContentPreviewItemSink {
  pushText(value: string): void;
  addMediaOrdinal(ordinal: number): void;
  addMediaSha256(sha256: string): void;
  finish(): void;
}

type RawContentPreviewItem = Omit<
  ExchangeContentPreviewItem,
  | "semanticCategory"
  | "provenance"
  | "confidence"
  | "displayPolicy"
  | "dedupePolicy"
  | "logicalId"
  | "providerItemId"
  | "providerLineageKey"
>;

/**
 * 预览构建器只保留固定条数和每项固定字节前缀；完整文本只参与增量计数和 hash。
 * finalize 会按实际 JSON UTF-8 大小再次收敛，避免序列化开销突破 SQLite CHECK。
 */
export class ContentPreviewBuilder {
  private readonly items: ExchangeContentPreviewItem[] = [];
  private readonly historyReplaySamples: ExchangeContentPreviewItem[] = [];
  private readonly filterItems: ExchangeContentFilterItem[] = [];
  private readonly overviewCandidates = new Map<string, ExchangeOverviewCandidate>();
  private readonly diagnosticCodes = new Set<string>();
  private readonly limitedDimensions = new Set<LimitedDimension>();
  private itemCandidateCount = 0;
  private historyReplayCount = 0;
  private filterItemCandidateCount = 0;
  private filterItemCandidateCountExact = true;
  private readonly filterItemCandidateCountBySide: Record<ProjectionBodySide, number> = {
    request: 0,
    response: 0,
  };
  private readonly filterItemCandidateCountExactBySide: Record<ProjectionBodySide, boolean> = {
    request: true,
    response: true,
  };
  private candidateTextBytes = 0;
  private candidateCountExact = true;
  private requestContextMode?: RequestContextMode;
  private readonly coalescedTextItems = new Map<string, {
    options: BeginContentPreviewItemOptions;
    writer?: ContentPreviewItemWriter;
  }>();
  private sealed = false;

  constructor(private readonly options: ContentPreviewBuilderOptions) {
    if (!Number.isSafeInteger(options.projectionVersion) || options.projectionVersion < 1) {
      throw new RangeError("projectionVersion 必须是正安全整数。");
    }
  }

  beginTextItem(options: BeginContentPreviewItemOptions): ContentPreviewItemWriter {
    this.assertOpen();
    return this.createTextItemWriter(options);
  }

  /**
   * SSE 同一逻辑 lane 的多个 delta 共用一个增量 writer；代理只结束当前标量，
   * 真正的 item 在 block/message reconcile 后统一完成。
   */
  beginCoalescedTextItem(
    key: string,
    options: BeginContentPreviewItemOptions,
  ): ContentPreviewItemSink {
    this.assertOpen();
    let state = this.coalescedTextItems.get(key);
    if (!state) {
      state = { options: { ...options } };
      this.coalescedTextItems.set(key, state);
    }
    const ensureWriter = (): ContentPreviewItemWriter => {
      state!.writer ??= this.createTextItemWriter(state!.options);
      return state!.writer;
    };
    return {
      pushText: value => {
        if (value) ensureWriter().pushText(value);
      },
      addMediaOrdinal: ordinal => ensureWriter().addMediaOrdinal(ordinal),
      addMediaSha256: sha256 => ensureWriter().addMediaSha256(sha256),
      finish: () => undefined,
    };
  }

  updateCoalescedTextItem(
    key: string,
    updates: Partial<BeginContentPreviewItemOptions>,
  ): void {
    this.assertOpen();
    const state = this.coalescedTextItems.get(key);
    if (state) Object.assign(state.options, updates);
  }

  hasCoalescedTextContent(key: string): boolean {
    return this.coalescedTextItems.get(key)?.writer !== undefined;
  }

  finishCoalescedTextItems(): void {
    this.assertOpen();
    for (const state of this.coalescedTextItems.values()) state.writer?.finish();
    this.coalescedTextItems.clear();
  }

  addDiagnostic(code: string): void {
    this.assertOpen();
    if (this.diagnosticCodes.size >= DIAGNOSTIC_LIMIT) return;
    this.diagnosticCodes.add(boundedUtf8(code, 128));
  }

  addLimitedDimension(dimension: LimitedDimension): void {
    this.assertOpen();
    this.limitedDimensions.add(dimension);
  }

  markCandidateCountInexact(side: ProjectionBodySide): void {
    this.assertOpen();
    this.candidateCountExact = false;
    this.filterItemCandidateCountExact = false;
    this.filterItemCandidateCountExactBySide[side] = false;
    this.limitedDimensions.add("content_preview");
  }

  setRequestContextMode(mode: RequestContextMode | undefined): void {
    this.assertOpen();
    this.requestContextMode = mode;
  }

  finalize(): ExchangeContentPreviewDraft {
    this.assertOpen();
    this.finishCoalescedTextItems();
    this.sealed = true;
    const items = this.items.map(item => ({
      ...item,
      mediaDescriptorOrdinals: [...item.mediaDescriptorOrdinals],
    }));
    const historyReplaySamples = this.historyReplaySamples.map(item => ({
      ...item,
      mediaDescriptorOrdinals: [...item.mediaDescriptorOrdinals],
    }));
    const overviewCandidates = cloneOverviewCandidates(this.overviewCandidates.values());
    const requestContextMode = this.requestContextMode
      ?? inferRequestContextMode(
        this.options.protocol,
        this.options.endpointKind,
        this.options.agentKind,
        items,
        this.historyReplayCount,
      );
    const serialize = (): string =>
      serializeEnvelope(
        this.options,
        items,
        historyReplaySamples,
        this.historyReplayCount,
        overviewCandidates,
        this.diagnosticCodes,
        {
        itemCandidateCount: this.itemCandidateCount,
        itemCandidateCountExact: this.candidateCountExact,
        candidateTextBytes: this.candidateTextBytes,
        limitedDimensions: this.limitedDimensions,
        },
        requestContextMode,
      );
    const previewJson = convergePreviewSize(items, serialize, this.limitedDimensions);

    if (Buffer.byteLength(previewJson) > CONTENT_PREVIEW_MAX_BYTES) {
      throw new Error("Content Preview 固定元数据超过 256 KiB 安全上限。");
    }
    const processedTextBytes = items.reduce(
      (total, item) => total + item.previewTextBytes,
      0,
    );
    const limited = this.limitedDimensions.size > 0
      || items.length < this.itemCandidateCount
      || !this.candidateCountExact;
    return {
      exchangeId: this.options.exchangeId,
      projectionVersion: this.options.projectionVersion,
      protocol: this.options.protocol,
      agentKind: this.options.agentKind,
      endpointKind: this.options.endpointKind,
      items,
      historyReplaySamples,
      historyReplayCount: this.historyReplayCount,
      overviewCandidates,
      filterItems: this.filterItems.map(item => ({ ...item })),
      filterItemCandidateCount: this.filterItemCandidateCount,
      filterItemCandidateCountExact: this.filterItemCandidateCountExact,
      filterItemCandidateCountBySide: { ...this.filterItemCandidateCountBySide },
      filterItemCandidateCountExactBySide: {
        ...this.filterItemCandidateCountExactBySide,
      },
      streamLifecycle: undefined,
      requestContextMode,
      contextBoundaryCandidates: contextBoundaryCandidates(items),
      diagnosticCodes: [...this.diagnosticCodes],
      itemCandidateCount: this.itemCandidateCount,
      itemProcessedCount: items.length,
      itemCandidateCountExact: this.candidateCountExact,
      candidateTextBytes: this.candidateTextBytes,
      processedTextBytes,
      limited,
      truncated: limited,
      limitedDimensions: [...this.limitedDimensions],
      previewJson,
      sizeBytes: Buffer.byteLength(previewJson),
    };
  }

  private assertOpen(): void {
    if (this.sealed) throw new Error("Content Preview 已完成，不能继续写入。");
  }

  private createTextItemWriter(
    options: BeginContentPreviewItemOptions,
  ): ContentPreviewItemWriter {
    return new ContentPreviewItemWriter(options, item => {
      const semantic = this.classifyItem(item, options);
      const semanticItem = applySemanticItem(item, semantic);
      if (semanticItem.displayPolicy === "history_replay") {
        this.historyReplayCount += 1;
        retainHistoryReplaySample(this.historyReplaySamples, semanticItem);
        return;
      }
      this.itemCandidateCount += 1;
      if (this.itemCandidateCount > CONTENT_PREVIEW_ITEM_LIMIT) {
        this.limitedDimensions.add("content_preview");
        this.limitedDimensions.add(textDimension(options.side));
      }
      this.candidateTextBytes += item.originalTextBytes;
      if (item.truncated) {
        this.limitedDimensions.add("content_preview");
        this.limitedDimensions.add(textDimension(item.side));
      }
      retainRepresentativeItem(this.items, semanticItem, CONTENT_PREVIEW_RETAINED_ITEM_LIMIT);
      retainOverviewCandidate(this.overviewCandidates, semanticItem);
      this.retainFilterItem(semanticItem, semantic);
      this.options.onClassifiedItem?.(semanticItem);
    });
  }

  private retainFilterItem(
    item: ExchangeContentPreviewItem,
    semantic: ConversationSemanticItem,
  ): void {
    const category = item.semanticCategory;
    this.filterItemCandidateCount += 1;
    this.filterItemCandidateCountBySide[item.side] += 1;
    if (this.filterItems.length >= CONTENT_FILTER_ITEM_LIMIT) return;
    this.filterItems.push({
      side: item.side,
      category,
      fingerprint: conversationFingerprintKey({
        category,
        side: item.side === "request" ? "input" : "output",
        provenance: item.provenance,
        providerItemType: item.itemType,
        textSha256: item.textSha256,
        contentKinds: contentKindsFor(item),
        toolName: item.toolName,
        toolUseId: item.toolUseId,
        mediaSha256: item.mediaSha256,
      }),
      providerLineageKey: item.providerLineageKey,
      mediaSha256: item.mediaSha256 ? [...item.mediaSha256] : undefined,
      turnSignal: semantic.turnSignal,
    });
  }

  private classifyItem(
    item: RawContentPreviewItem,
    options: BeginContentPreviewItemOptions,
  ): ConversationSemanticItem {
    if (
      this.options.endpointKind !== undefined
      && this.options.endpointKind !== "model-call"
    ) {
      return auxiliarySemanticItem(this.options, item, options);
    }
    return classifySemanticLane({
      protocol: protocolKind(this.options.protocol),
      agentKind: this.options.agentKind,
      bodySide: item.side,
      providerRole: item.role,
      providerItemType: item.itemType,
      ancestorTypes: options.ancestorTypes,
      evidencePath: item.jsonPath,
      parentIdentity: options.parentIdentity ?? parentIdentityFromPath(item.jsonPath),
      semanticLane: options.semanticLane
        ?? semanticLaneFromPath(item.jsonPath, item.itemType),
      providerItemId: options.providerItemId,
      textPrefix: item.textPreview,
      toolName: item.toolName,
      toolUseId: item.toolUseId,
      contentKinds: contentKindsFor(item),
      messageStopReason: options.messageStopReason,
      syntheticProviderControl: options.syntheticProviderControl,
      semanticOverride: options.semanticOverride,
    });
  }
}

export class ContentPreviewItemWriter {
  private readonly collapsedHash = new WhitespaceCollapsedHash();
  private readonly previewChunks: Buffer[] = [];
  private readonly mediaOrdinals: number[] = [];
  private readonly mediaSha256: string[] = [];
  private originalTextBytes = 0;
  private previewTextBytes = 0;
  private finished = false;

  constructor(
    private readonly options: BeginContentPreviewItemOptions,
    private readonly complete: (item: RawContentPreviewItem) => void,
  ) {}

  pushText(value: string): void {
    this.assertOpen();
    if (!value) return;
    const bytes = Buffer.from(value, "utf8");
    this.collapsedHash.update(bytes);
    this.originalTextBytes += bytes.length;
    const textLimit = this.options.category === PROTECTED_CONVERSATION_CATEGORY
      ? USER_INPUT_PREVIEW_MAX_BYTES
      : CONTENT_PREVIEW_ITEM_MAX_BYTES;
    if (this.previewTextBytes >= textLimit) return;
    const remaining = textLimit - this.previewTextBytes;
    const prefix = utf8Prefix(bytes, remaining);
    if (prefix.length > 0) {
      this.previewChunks.push(prefix);
      this.previewTextBytes += prefix.length;
    }
  }

  addMediaOrdinal(ordinal: number): void {
    this.assertOpen();
    if (
      Number.isSafeInteger(ordinal)
      && ordinal >= 0
      && this.mediaOrdinals.length < MEDIA_ORDINAL_LIMIT
      && !this.mediaOrdinals.includes(ordinal)
    ) {
      this.mediaOrdinals.push(ordinal);
    }
  }

  addMediaSha256(sha256: string): void {
    this.assertOpen();
    if (
      sha256
      && this.mediaSha256.length < MEDIA_ORDINAL_LIMIT
      && !this.mediaSha256.includes(sha256)
    ) this.mediaSha256.push(sha256);
  }

  finish(): void {
    this.assertOpen();
    this.finished = true;
    const textPreview = this.previewTextBytes > 0
      ? Buffer.concat(this.previewChunks, this.previewTextBytes).toString("utf8")
      : undefined;
    this.complete({
      side: this.options.side,
      category: boundedUtf8(this.options.category, 128),
      semanticType: this.options.semanticType,
      role: optionalBounded(this.options.role, 128),
      itemType: boundedUtf8(this.options.itemType, 128),
      ancestorTypes: (this.options.ancestorTypes ?? []).map(
        value => boundedUtf8(value, 128),
      ),
      jsonPath: boundedUtf8(this.options.jsonPath, METADATA_TEXT_MAX_BYTES),
      toolName: optionalBounded(this.options.toolName, 128),
      toolUseId: optionalBounded(this.options.toolUseId, 256),
      textPreview,
      textSha256: this.collapsedHash.digest(),
      originalTextBytes: this.originalTextBytes,
      previewTextBytes: this.previewTextBytes,
      truncated: this.previewTextBytes < this.originalTextBytes,
      mediaDescriptorOrdinals: [...this.mediaOrdinals],
      mediaSha256: this.mediaSha256.length > 0 ? [...this.mediaSha256] : undefined,
    });
  }

  private assertOpen(): void {
    if (this.finished) throw new Error("Content Preview item 已完成。");
  }
}

/** Request/Response 各自扫描后仍需在 Exchange 维度重新执行同一个 256 KiB 预算。 */
export function mergeContentPreviews(
  options: MergeContentPreviewOptions,
): ExchangeContentPreviewDraft {
  const allItems = options.drafts.flatMap(draft => draft.items.map(item => ({
    ...item,
    mediaDescriptorOrdinals: [...item.mediaDescriptorOrdinals],
  })));
  const candidateMap = new Map<string, ExchangeOverviewCandidate>();
  for (const draft of options.drafts) {
    for (const candidate of draft.overviewCandidates) {
      retainOverviewCandidate(candidateMap, candidate);
    }
  }
  const overviewCandidates = cloneOverviewCandidates(candidateMap.values());
  const historyReplaySamples: ExchangeContentPreviewItem[] = [];
  for (const draft of options.drafts) {
    for (const item of draft.historyReplaySamples) {
      retainHistoryReplaySample(historyReplaySamples, {
        ...item,
        mediaDescriptorOrdinals: [...item.mediaDescriptorOrdinals],
      });
    }
  }
  const historyReplayCount = options.drafts.reduce(
    (total, draft) => total + draft.historyReplayCount,
    0,
  );
  const allFilterItems = options.drafts.flatMap(
    draft => draft.filterItems.map(item => ({ ...item })),
  );
  const filterItemCandidateCount = options.drafts.reduce(
    (total, draft) => total + draft.filterItemCandidateCount,
    0,
  );
  const filterItems = allFilterItems.slice(0, CONTENT_FILTER_ITEM_LIMIT);
  const filterItemCandidateCountExact = options.drafts.every(
    draft => draft.filterItemCandidateCountExact,
  );
  const filterItemCandidateCountBySide: Record<ProjectionBodySide, number> = {
    request: options.drafts.reduce(
      (total, draft) => total + draft.filterItemCandidateCountBySide.request,
      0,
    ),
    response: options.drafts.reduce(
      (total, draft) => total + draft.filterItemCandidateCountBySide.response,
      0,
    ),
  };
  const filterItemCandidateCountExactBySide: Record<ProjectionBodySide, boolean> = {
    request: options.drafts.every(
      draft => draft.filterItemCandidateCountExactBySide.request,
    ),
    response: options.drafts.every(
      draft => draft.filterItemCandidateCountExactBySide.response,
    ),
  };
  const requestItems = allItems.filter(item => item.side === "request");
  const responseItems = allItems.filter(item => item.side === "response");
  let requestLimit = Math.min(requestItems.length, SIDE_RESERVED_ITEM_LIMIT);
  let responseLimit = Math.min(responseItems.length, SIDE_RESERVED_ITEM_LIMIT);
  let unclaimed = CONTENT_PREVIEW_RETAINED_ITEM_LIMIT - requestLimit - responseLimit;
  const requestExtra = Math.min(requestItems.length - requestLimit, unclaimed);
  requestLimit += requestExtra;
  unclaimed -= requestExtra;
  responseLimit += Math.min(responseItems.length - responseLimit, unclaimed);
  const items = [
    ...representativeItems(requestItems, requestLimit),
    ...representativeItems(responseItems, responseLimit),
  ];
  const itemCandidateCount = options.drafts.reduce(
    (total, draft) => total + draft.itemCandidateCount,
    0,
  );
  const candidateTextBytes = options.drafts.reduce(
    (total, draft) => total + draft.candidateTextBytes,
    0,
  );
  const itemCandidateCountExact = options.drafts.every(
    draft => draft.itemCandidateCountExact,
  );
  const diagnosticCodes = new Set(options.drafts.flatMap(
    draft => draft.diagnosticCodes,
  ).slice(0, DIAGNOSTIC_LIMIT));
  const limitedDimensions = new Set(options.drafts.flatMap(
    draft => draft.limitedDimensions,
  ));
  if (items.length < itemCandidateCount) limitedDimensions.add("content_preview");
  if (requestItems.length > requestLimit) limitedDimensions.add("request_text");
  if (responseItems.length > responseLimit) limitedDimensions.add("response_text");

  const serialize = (): string => serializeEnvelope(
    options,
    items,
    historyReplaySamples,
    historyReplayCount,
    overviewCandidates,
    diagnosticCodes,
    {
    itemCandidateCount,
    itemCandidateCountExact,
    candidateTextBytes,
    limitedDimensions,
    },
    options.drafts.find(draft => draft.requestContextMode !== undefined)
      ?.requestContextMode,
    options.streamLifecycle,
  );
  const previewJson = convergePreviewSize(items, serialize, limitedDimensions);
  if (Buffer.byteLength(previewJson) > CONTENT_PREVIEW_MAX_BYTES) {
    throw new Error("合并后的 Content Preview 固定元数据超过 256 KiB 安全上限。");
  }
  const processedTextBytes = items.reduce(
    (total, item) => total + item.previewTextBytes,
    0,
  );
  const limited = limitedDimensions.size > 0
    || items.length < itemCandidateCount
    || !itemCandidateCountExact;
  return {
    exchangeId: options.exchangeId,
    projectionVersion: options.projectionVersion,
    protocol: options.protocol,
    agentKind: options.agentKind,
    endpointKind: options.endpointKind,
    items,
    historyReplaySamples,
    historyReplayCount,
    overviewCandidates,
    filterItems,
    filterItemCandidateCount,
    filterItemCandidateCountExact,
    filterItemCandidateCountBySide,
    filterItemCandidateCountExactBySide,
    streamLifecycle: options.streamLifecycle,
    requestContextMode: options.drafts
      .find(draft => draft.requestContextMode !== undefined)
      ?.requestContextMode,
    contextBoundaryCandidates: options.drafts
      .flatMap(draft => draft.contextBoundaryCandidates)
      .slice(0, 64),
    diagnosticCodes: [...diagnosticCodes],
    itemCandidateCount,
    itemProcessedCount: items.length,
    itemCandidateCountExact,
    candidateTextBytes,
    processedTextBytes,
    limited,
    truncated: limited,
    limitedDimensions: [...limitedDimensions],
    previewJson,
    sizeBytes: Buffer.byteLength(previewJson),
  };
}

/**
 * 固定条数内保留开头和最新尾部，避免长上下文把本次新增输入挤出 Preview。
 * 数组始终不超过 256 项，候选正文也只在单项 8 KiB 缓冲内短暂存在。
 */
/** 保留代表性条目：user_real 优先占位，其余按首尾淘汰。 */
function retainRepresentativeItem(
  items: ExchangeContentPreviewItem[],
  item: ExchangeContentPreviewItem,
  limit: number,
): void {
  if (items.length < limit) {
    items.push(item);
    return;
  }
  const protectedCategory = item.semanticCategory === PROTECTED_CONVERSATION_CATEGORY;
  const headCount = Math.ceil(limit / 2);
  if (!protectedCategory) {
    items.splice(headCount, 1);
    items.push(item);
    return;
  }
  // 受保护类别：优先挤掉一个非受保护的中部条目，避免把 user_real 挤出去。
  const victimIndex = items.findIndex(
    (candidate, index) => index >= headCount
      && candidate.semanticCategory !== PROTECTED_CONVERSATION_CATEGORY,
  );
  items.splice(victimIndex >= 0 ? victimIndex : headCount, 1);
  items.push(item);
}

/** 首尾等量取样（保持原有相对顺序）。 */
function headTailSlice<T>(values: T[], limit: number): T[] {
  if (limit <= 0) return [];
  if (values.length <= limit) return [...values];
  const headCount = Math.ceil(limit / 2);
  const tailCount = limit - headCount;
  return tailCount === 0
    ? values.slice(0, headCount)
    : [...values.slice(0, headCount), ...values.slice(-tailCount)];
}

/** 合并阶段抽样：user_real 优先保留（自身超限时仍保首尾），其余按剩余额度首尾补齐。 */
function representativeItems(
  items: ExchangeContentPreviewItem[],
  limit: number,
): ExchangeContentPreviewItem[] {
  if (items.length <= limit) return [...items];
  if (limit <= 0) return [];
  const protectedItems = items.filter(
    item => item.semanticCategory === PROTECTED_CONVERSATION_CATEGORY,
  );
  const pickedProtected = protectedItems.length <= limit
    ? protectedItems
    : headTailSlice(protectedItems, limit);
  const rest = items.filter(
    item => item.semanticCategory !== PROTECTED_CONVERSATION_CATEGORY,
  );
  const pickedRest = headTailSlice(rest, limit - pickedProtected.length);
  return [...pickedProtected, ...pickedRest].sort((left, right) => (
    items.indexOf(left) - items.indexOf(right)
  ));
}

/**
 * JSON 包络超预算时优先释放历史 Request 文本；Request 最新尾部和 Response
 * 首尾具有更高保留优先级。只有固定元数据本身仍超限时才删除低价值条目。
 */
function convergePreviewSize(
  items: ExchangeContentPreviewItem[],
  serialize: () => string,
  limitedDimensions: Set<LimitedDimension>,
): string {
  let previewJson = serialize();
  const evictionOrder = previewValueOrder(items);
  for (const index of evictionOrder) {
    if (Buffer.byteLength(previewJson)
      <= CONTENT_PREVIEW_MAX_BYTES - REQUEST_CONTEXT_RESERVE_BYTES) break;
    const item = items[index]!;
    if (item.textPreview === undefined) continue;
    item.textPreview = undefined;
    item.previewTextBytes = 0;
    item.truncated = item.originalTextBytes > 0;
    limitedDimensions.add("content_preview");
    limitedDimensions.add(textDimension(item.side));
    previewJson = serialize();
  }

  while (
    Buffer.byteLength(previewJson)
      > CONTENT_PREVIEW_MAX_BYTES - REQUEST_CONTEXT_RESERVE_BYTES
    && items.length > 0
  ) {
    const leastValuableIndex = previewValueOrder(items)[0]!;
    const [removed] = items.splice(leastValuableIndex, 1);
    limitedDimensions.add("content_preview");
    limitedDimensions.add(textDimension(removed!.side));
    previewJson = serialize();
  }
  return previewJson;
}

function previewValueOrder(items: ExchangeContentPreviewItem[]): number[] {
  const positions = new Map<number, { sideIndex: number; sideCount: number }>();
  for (const side of ["request", "response"] as const) {
    const indexes = items
      .map((item, index) => item.side === side ? index : -1)
      .filter(index => index >= 0);
    indexes.forEach((index, sideIndex) => {
      positions.set(index, { sideIndex, sideCount: indexes.length });
    });
  }
  return items
    .map((item, index) => {
      const position = positions.get(index)!;
      return {
        index,
        priority: previewRetentionPriority(item.side, position.sideIndex, position.sideCount, item),
      };
    })
    .sort((left, right) => left.priority - right.priority || left.index - right.index)
    .map(value => value.index);
}

function previewRetentionPriority(
  side: ProjectionBodySide,
  sideIndex: number,
  sideCount: number,
  item: ExchangeContentPreviewItem,
): number {
  // user_real 是 Turn 锚点的最小必要信息，永不优先释放（数值越大越后释放）。
  if (item.semanticCategory === PROTECTED_CONVERSATION_CATEGORY) return 9_000 + sideIndex;
  if (side === "request") {
    const tailStart = Math.max(0, sideCount - PROTECTED_EDGE_ITEM_COUNT);
    return sideIndex >= tailStart ? 3_000 + sideIndex : sideIndex;
  }
  const edgeDistance = Math.min(sideIndex, sideCount - sideIndex - 1);
  return edgeDistance < PROTECTED_EDGE_ITEM_COUNT
    ? 4_000 - edgeDistance
    : 2_000 + edgeDistance;
}

function serializeEnvelope(
  options: ContentPreviewBuilderOptions,
  items: ExchangeContentPreviewItem[],
  historyReplaySamples: ExchangeContentPreviewItem[],
  historyReplayCount: number,
  overviewCandidates: ExchangeOverviewCandidate[],
  diagnosticCodes: Set<string>,
  counts: {
    itemCandidateCount: number;
    itemCandidateCountExact: boolean;
    candidateTextBytes: number;
    limitedDimensions: Set<LimitedDimension>;
  },
  requestContextMode?: RequestContextMode,
  streamLifecycle?: StreamLifecycleSummary,
): string {
  const limited = counts.limitedDimensions.size > 0
    || items.length < counts.itemCandidateCount
    || !counts.itemCandidateCountExact;
  return JSON.stringify({
    schemaVersion: 3,
    exchangeId: options.exchangeId,
    projectionVersion: options.projectionVersion,
    protocol: optionalBounded(options.protocol, 128),
    agentKind: options.agentKind,
    endpointKind: optionalBounded(options.endpointKind, 128),
    conversationItems: items,
    historyReplaySamples,
    historyReplayCount,
    overviewCandidates,
    streamLifecycle,
    requestContextMode,
    contextBoundaryCandidates: contextBoundaryCandidates(items),
    itemCandidateCount: counts.itemCandidateCount,
    itemProcessedCount: items.length,
    itemCandidateCountExact: counts.itemCandidateCountExact,
    candidateTextBytes: counts.candidateTextBytes,
    processedTextBytes: items.reduce((total, item) => total + item.previewTextBytes, 0),
    diagnosticCodes: [...diagnosticCodes],
    limitedDimensions: [...counts.limitedDimensions],
    limited,
    truncated: limited,
  });
}

function retainOverviewCandidate(
  candidates: Map<string, ExchangeOverviewCandidate>,
  item: ExchangeContentPreviewItem,
): void {
  const conversationCategory = item.semanticCategory;
  if (!item.textPreview?.trim()) return;
  const key = `${item.side}:${conversationCategory}`;
  const current = candidates.get(key);
  if (
    current
    && !isMediaOnlyConversationPreview(
      current.textPreview,
      current.mediaDescriptorOrdinals,
    )
    && isMediaOnlyConversationPreview(
      item.textPreview,
      item.mediaDescriptorOrdinals,
    )
  ) {
    return;
  }
  candidates.set(key, {
    ...item,
    conversationCategory,
    mediaDescriptorOrdinals: [...item.mediaDescriptorOrdinals],
  });
}

function cloneOverviewCandidates(
  candidates: Iterable<ExchangeOverviewCandidate>,
): ExchangeOverviewCandidate[] {
  return [...candidates].map(cloneOverviewCandidate);
}

function cloneOverviewCandidate(
  candidate: ExchangeOverviewCandidate,
): ExchangeOverviewCandidate {
  return {
    ...candidate,
    mediaDescriptorOrdinals: [...candidate.mediaDescriptorOrdinals],
  };
}

function applySemanticItem(
  item: RawContentPreviewItem,
  semantic: ConversationSemanticItem,
): ExchangeContentPreviewItem {
  return {
    ...item,
    semanticCategory: semantic.semanticCategory,
    provenance: semantic.provenance,
    confidence: semantic.confidence,
    displayPolicy: semantic.displayPolicy,
    dedupePolicy: semantic.dedupePolicy,
    logicalId: semantic.logicalId,
    providerItemId: semantic.providerItemId,
    providerLineageKey: semantic.providerLineageKey,
  };
}

function auxiliarySemanticItem(
  builder: ContentPreviewBuilderOptions,
  item: RawContentPreviewItem,
  options: BeginContentPreviewItemOptions,
): ConversationSemanticItem {
  const logicalId = buildSemanticLogicalId(
    item.side,
    options.parentIdentity ?? parentIdentityFromPath(item.jsonPath),
    options.semanticLane ?? semanticLaneFromPath(item.jsonPath, item.itemType),
  );
  return {
    protocol: protocolKind(builder.protocol),
    agentKind: builder.agentKind ?? "unknown",
    bodySide: item.side,
    semanticCategory: "tool_result",
    providerRole: item.role,
    providerItemType: item.itemType,
    ancestorTypes: [...item.ancestorTypes],
    provenance: "tool_runtime",
    confidence: "structural",
    displayPolicy: "conversation",
    dedupePolicy: item.side === "request" ? "occurrence" : "none",
    logicalId,
    providerItemId: options.providerItemId,
    providerLineageKey: options.providerItemId
      ? `provider:${options.providerItemId}:${options.semanticLane ?? item.itemType}`
      : undefined,
    toolName: item.toolName,
    toolUseId: item.toolUseId,
    contentKinds: contentKindsFor(item),
    turnSignal: "neutral",
    evidencePath: item.jsonPath,
  };
}

function retainHistoryReplaySample(
  samples: ExchangeContentPreviewItem[],
  item: ExchangeContentPreviewItem,
): void {
  if (samples.length < HISTORY_REPLAY_SAMPLE_LIMIT) {
    samples.push(item);
    return;
  }
  samples.splice(HISTORY_REPLAY_EDGE_ITEM_COUNT, 1);
  samples.push(item);
}

function protocolKind(protocol: string | undefined): ProtocolKind {
  if (
    protocol === "openai-chat-completions"
    || protocol === "openai-responses"
    || protocol === "anthropic-messages"
  ) {
    return protocol;
  }
  return "unknown";
}

function parentIdentityFromPath(path: string): string {
  const stableContainer = /^\$\.(input|output|messages|choices|system)\[(\d+)\]/u.exec(path);
  if (stableContainer) return `${stableContainer[1]}:${stableContainer[2]}`;
  const event = /^\$\.events\[(\d+)\]/u.exec(path);
  return event ? `event:${event[1]}` : `path:${boundedUtf8(path, 256)}`;
}

function semanticLaneFromPath(path: string, itemType: string): string {
  const contentIndex = /\.content\[(\d+)\]/u.exec(path)?.[1];
  const summaryIndex = /\.summary\[(\d+)\]/u.exec(path)?.[1];
  const toolIndex = /\.tool_calls\[(\d+)\]/u.exec(path)?.[1];
  if (contentIndex !== undefined) return `content:${contentIndex}:${itemType}`;
  if (summaryIndex !== undefined) return `summary:${summaryIndex}:${itemType}`;
  if (toolIndex !== undefined) return `tool:${toolIndex}:${itemType}`;
  return `${lastPathSegment(path)}:${itemType}`;
}

function lastPathSegment(path: string): string {
  return /\.([A-Za-z_$][\w$]*)$/u.exec(path)?.[1] ?? "value";
}

function contentKindsFor(
  item: Pick<
    RawContentPreviewItem,
    "itemType" | "mediaDescriptorOrdinals"
  >,
): ConversationSemanticItem["contentKinds"] {
  return conversationContentKindsFor(
    item.itemType,
    item.mediaDescriptorOrdinals.length > 0,
  );
}

function inferRequestContextMode(
  protocol: string | undefined,
  endpointKind: string | undefined,
  agentKind: AgentKind | undefined,
  items: readonly ExchangeContentPreviewItem[],
  historyReplayCount: number,
): RequestContextMode | undefined {
  if (endpointKind !== undefined && endpointKind !== "model-call") return undefined;
  if (!items.some(item => item.side === "request")) return undefined;
  if (
    protocol === "openai-responses"
    && (agentKind === "codex" || agentKind === "claude-code")
  ) {
    return "full_replay";
  }
  if (
    protocol === "openai-responses"
    && (
      historyReplayCount > 0
      || items.filter(item => item.side === "request").length > 1
    )
  ) {
    return "full_replay";
  }
  if (
    protocol === "anthropic-messages"
    && (historyReplayCount > 0 || agentKind === "claude-code")
  ) {
    return "full_replay";
  }
  if (protocol === "openai-responses" || protocol === "anthropic-messages") {
    return "unknown";
  }
  if (protocol === "openai-chat-completions") return "full_replay";
  return "unknown";
}

function contextBoundaryCandidates(
  items: readonly ExchangeContentPreviewItem[],
): ExchangeContentPreviewDraft["contextBoundaryCandidates"] {
  const result: ExchangeContentPreviewDraft["contextBoundaryCandidates"] = [];
  for (const item of items) {
    if (result.length >= 64 || !isCompactionBoundaryItem(item)) continue;
    result.push({
      bodySide: item.side,
      logicalId: item.logicalId,
      providerItemId: item.providerItemId,
      occurrenceOrdinal: result.length,
      effectivePhase: item.side === "response"
        ? "after_exchange"
        : item.textPreview?.trimStart().startsWith(
          "You are performing a CONTEXT CHECKPOINT COMPACTION",
        )
          ? "after_exchange"
          : "before_request",
      evidencePath: item.jsonPath,
    });
  }
  return result;
}

function isCompactionBoundaryItem(item: ExchangeContentPreviewItem): boolean {
  if (
    item.semanticCategory !== "control"
    || item.displayPolicy !== "conversation"
  ) {
    return false;
  }
  return item.itemType.toLowerCase() === "compaction"
    || item.textPreview?.trimStart().startsWith(
      "You are performing a CONTEXT CHECKPOINT COMPACTION",
    ) === true
    || item.textPreview?.trimStart().startsWith("<compact_boundary") === true
    || item.textPreview?.trimStart().startsWith("compact_boundary") === true;
}

function utf8Prefix(bytes: Buffer, maxBytes: number): Buffer {
  if (bytes.length <= maxBytes) return bytes;
  let end = maxBytes;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end);
}

export function boundedUtf8(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  return utf8Prefix(bytes, maxBytes).toString("utf8");
}

function optionalBounded(value: string | undefined, maxBytes: number): string | undefined {
  return value === undefined ? undefined : boundedUtf8(value, maxBytes);
}

function textDimension(side: ProjectionBodySide): LimitedDimension {
  return side === "request" ? "request_text" : "response_text";
}
