/**
 * Codex（OpenAI 官方直连）本地源适配器（2026-10-09 用户确认，通道 B）。
 *
 * 背景：codex 在 ChatGPT 登录态下切换为原生 wire（请求体无 model 字段，0.160 桌面 /
 * 0.161 CLI 双端实证），订阅账号无法经网关路由——「官方模式」（CLI 同步关闭、受管层
 * 清空）下用户原生使用官方客户端，本适配器只读 ~/.codex/sessions 日期目录下的
 * rollout-*.jsonl 合成 v2 raw 入账（账本 / 会话追踪 / 交互内容 / Token 统计 / 订阅
 * 估算），归因到 openai-subscription 预设目标。后链路（Worker 派生、SQLite 层级、
 * 账本）与网关捕获完全同一管线，零分叉（zcode 同构）。
 *
 * 数据契约（0.160/0.161 实测，rollout 为真相源；thread_history_1.sqlite 为官方投影
 * 库，第一版不接、留作后续增强——详见 AGENTS.md）：
 * - `session_meta`：session_id / model_provider（官方 "openai" vs 网关 "deepaa_gateway"）
 *   / cli_version / source（入口：vscode 等，透传 clientQuerySource）/ thread_source；
 * - `turn_context`：该轮 model / effort / turn_id / root_turn_id；
 * - `response_item`：wire 原始形态 item（message[content input_text/output_text]、
 *   reasoning[summary]、custom_tool_call / custom_tool_call_output）——请求上下文回放
 *   与响应组装直接复用原 payload，保真不改写；
 * - `event_msg(item_completed)`：payload.item.id + started_at_ms/completed_at_ms——
 *   首 token 与请求起点锚（response_item 的行级时间戳是批量落盘时间，不可用作首字）；
 * - `event_msg(token_count)`：payload.info.last_token_usage 五维（input_tokens **包含**
 *   cached_input_tokens 子集、reasoning 为 output 子集，与 OpenAI Responses wire 同口径）
 *   + payload.rate_limits（套餐窗口，离线兜底数据源）。
 *
 * 身份折叠（2026-10-09 B2）：合成头提供网关 codex 同款信号——x-codex-session-id 分
 * Session（CLI 与桌面 App 是独立 rollout、天然分离）、x-codex-turn-metadata.turn_id 定
 * Turn 边界与 native_turn_id 回填——折叠链路（thread-identity.ts / exchange-processor）
 * 零改动自动生效。
 *
 * 增量与预算红线（对齐 dsh 教训）：rollout 是 append-only JSONL——按 (mtime, size) 缓存
 * 解析进度，未变文件零解析；变化文件只从上次字节偏移续析（半行留在缓冲区等下轮）；
 * 冷启动整文件解析按「每轮文件数 + 每轮字节」双预算分摊多轮，绝不整目录一次物化。
 */

import {closeSync, fstatSync, openSync, readSync, readdirSync, statSync} from "node:fs";
import {homedir} from "node:os";
import {join} from "node:path";
import {BoundedLruMap} from "../bounded-lru";
import {openSeenProbeDatabase, probeSeenExchangeIds} from "../seen-probe";
import type {
  AgentLocalSourceAdapter,
  LocalExchangeDetail,
  LocalExchangeRef,
  LocalResponseShape,
  LocalSourceStatus,
  LocalUsageBatch,
  LocalUsageRecord,
  PendingBatchQuery,
  PendingBatchResult,
  PendingImportCandidate,
} from "../types";

/** 历史网关 provider id 由片段构造（品牌守卫禁止旧名字面量回流，与 config-sync 同款惯例）。 */
const LEGACY_GATEWAY_PROVIDER_MARKER = ["llm", "inspector", "gateway"].join("_");
/** 网关排重标记：config-sync 写入 codex 的 provider id（含历史名）。 */
const CODEX_GATEWAY_PROVIDER_MARKERS = ["deepaa_gateway", LEGACY_GATEWAY_PROVIDER_MARKER] as const;

/** 计费白名单：官方内置 provider 才导入（第三方自定义 provider 的直连流量不入账）。 */
const CODEX_ALLOWED_PROVIDER_IDS = ["openai"] as const;

const CODEX_OFFICIAL_UPSTREAM_BASE_URL = "https://chatgpt.com/backend-api/codex";
const CODEX_PROTOCOL_PATH = "/responses";

/** 冷启动预算：单轮最多新解析的文件数 / 字节数（增量续析不受文件数预算约束）。 */
const COLD_PARSE_FILES_PER_ROUND = 4;
const COLD_PARSE_BYTES_PER_ROUND = 8 * 1024 * 1024;

/**
 * 正文缓存字节上限（2026-10-10 A 修复）：扫描态只保留元数据（records /
 * recordDetails / 计数索引），items 正文进入进程级 LRU、按需在 readExchangeDetail
 * 从磁盘重析——常驻内存与 30 天语料规模由此解耦。对齐 dsh 正文缓存 96MiB 的设计，
 * codex 回放正文更肥，取更紧的 64MiB。
 */
const CONTENT_CACHE_MAX_BYTES = 64 * 1024 * 1024;
/** seen 反联探针单块候选数（每候选 2 键 → 800 个 IN 参数，主键索引查询）。 */
const SEEN_PROBE_CHUNK = 400;

/**
 * 会话内有序 item（wire 原始形态 + 解析出的方向/角色）。
 * direction：input 侧（用户/环境/工具输出，进请求回放）vs output 侧（assistant
 * 输出，既是历史上下文也是当次响应内容）。
 */
interface SessionItem {
  ordinal: number;
  turnId?: string;
  direction: "input" | "output";
  kind: "message" | "reasoning" | "custom_tool_call" | "custom_tool_call_output";
  itemId?: string;
  role?: string;
  /** message 文本（多 content 段拼接）。 */
  text?: string;
  reasoningText?: string;
  toolName?: string;
  callId?: string;
  toolInput?: unknown;
  toolOutput?: string;
}

/** 单条导入记录的正文定位信息（readExchangeDetail 消费）。 */
interface RecordDetail {
  /** 请求上下文回放边界：items[0..contextEnd) 为该请求的全量可见上下文。 */
  contextEnd: number;
  /** 该请求的响应 = items 在 outputIndices 下标处的切片。 */
  outputIndices: readonly number[];
  /**
   * 解析时点的 items 总数（重析完整性守卫，A 修复）：从磁盘重建的 items 少于该值
   * 即判重建失败（文件被截短/轮转），绝不产出截断的上下文回放。
   */
  itemCount: number;
}

/** 解析进度缓存：rollout append-only，offset 只前进；半行跨轮缓冲。 */
interface RolloutFileCache {
  path: string;
  fileKey: string;
  mtimeMs: number;
  size: number;
  offset: number;
  tail: Buffer;
  records: LocalUsageRecord[];
  recordDetails: Map<string, RecordDetail>;
  /**
   * 已消费的 item 总数（单调计数，A 修复）：扫描态不再保留 items 正文——索引
   * （contextEnd / outputIndices）只依赖计数与方向，正文由 readExchangeDetail 按需
   * 从磁盘重析并进入有界 LRU。
   */
  itemCount: number;
  /** 自上一 token_count 以来累积的 output 侧 item 下标（items 数组下标）。 */
  pendingOutputIndices: number[];
  /**
   * 自上一 token_count 以来累积的 output 侧精确时序（2026-10-09 三修：不依赖 ID 匹配，
   * item_completed.item.type 为 AgentMessage/Reasoning 时按事件序推入）。
   */
  pendingOutputTimings: Array<{startedMs: number; completedMs: number}>;
  /** 最近一次 input 侧活动（UserMessage/CommandExecution）的 item_completed 行时间戳。 */
  lastInputActivityMs?: number;
  sessionMeta: {
    sessionId: string;
    modelProvider: string;
    cliVersion: string;
    source?: string;
    threadSource?: string;
    /** 会话基础指令（session_meta.base_instructions，实测 ~22KB）：回放请求体的 instructions。 */
    baseInstructions?: string;
  } | undefined;
  currentTurn: {turnId?: string; model?: string} | undefined;
  /** 请求起点锚：max(turn_context, lastInputActivityMs)。 */
  requestAnchorMs?: number;
  coldPending: boolean;
  lastActivityMs: number;
}

export function createCodexLocalSourceAdapter(options: {cliDir?: string; contentCacheMaxBytes?: number} = {}): AgentLocalSourceAdapter {
  const cliDir = options.cliDir ?? process.env.CODEX_CLI_DIR ?? join(homedir(), ".codex");
  const sessionsDir = join(cliDir, "sessions");
  const caches = new Map<string, RolloutFileCache>();
  /** 正文 LRU（fileKey → 可续析条目）：字节预算有界，命中触达、超限逐出最旧。 */
  const contentLru = new BoundedLruMap<string, ContentCacheEntry>({
    maxBytes: options.contentCacheMaxBytes ?? CONTENT_CACHE_MAX_BYTES,
    bytesOf: estimateContentEntryBytes,
  });
  /** 缓存内容版本（任何文件解析到新字节即 +1）：有序候选列表的失效判据。 */
  let cachesVersion = 0;
  let orderedCache: {version: number; list: PendingImportCandidate[]} | undefined;

  /** 扫描 + 增量续析（readPendingCandidates / readPendingBatch 共用入口）。 */
  const scanAndIndex = (floorEpochMs: number): void => {
    const files = listRolloutFiles(sessionsDir, floorEpochMs);
    let coldFiles = 0;
    let coldBytes = 0;
    let parsedAnyBytes = false;
    // 文件按 mtime 倒序刷新：活跃会话（用户最关心）先获得解析预算。
    for (const file of files) {
      let cache = caches.get(file.fileKey);
      if (cache && cache.mtimeMs === file.mtimeMs && cache.size === file.size && !cache.coldPending) {
        continue;
      }
      if (!cache) {
        cache = {
          path: file.path, fileKey: file.fileKey, mtimeMs: file.mtimeMs, size: file.size,
          offset: 0, tail: Buffer.alloc(0), records: [], recordDetails: new Map(),
          itemCount: 0, pendingOutputIndices: [], pendingOutputTimings: [],
          lastInputActivityMs: undefined,
          sessionMeta: undefined, currentTurn: undefined, requestAnchorMs: undefined,
          coldPending: false, lastActivityMs: file.mtimeMs,
        };
        caches.set(file.fileKey, cache);
      }
      // 增量续析（append-only：只读新增字节）；冷文件（offset=0）计入双预算，
      // 预算耗尽标记 coldPending，下一轮继续——绝不整目录一次物化。
      const isNewColdStart = cache.offset === 0;
      if (isNewColdStart
        && (coldFiles >= COLD_PARSE_FILES_PER_ROUND || coldBytes >= COLD_PARSE_BYTES_PER_ROUND)) {
        cache.coldPending = true;
        continue;
      }
      const parsedBytes = refreshRolloutCache(cache);
      cache.coldPending = false;
      // 签名必须随解析回写：cache 的 mtime/size 停留在建缓存时刻，会让任何被
      // 追加过的文件永远命中不了「未变化跳过」，此后每轮都重走读取路径——即使
      // 新字节为零也是一次缓冲分配（2026-10-10 修复，稳态每 2s 的分配 churn 根因）。
      cache.mtimeMs = file.mtimeMs;
      cache.size = file.size;
      if (parsedBytes > 0) parsedAnyBytes = true;
      if (isNewColdStart) {
        coldFiles += 1;
        coldBytes += parsedBytes;
      }
    }
    if (parsedAnyBytes) cachesVersion += 1;
  };

  /**
   * 有序候选（版本缓存）：provider 白名单过滤后按「session 最新活动倒序、会话内
   * 完成时间正序、id 兜底」排序；窗口与模型面过滤按调用参数即时应用（floor 每
   * tick 前移、模型面可随目标配置变化，不进缓存）。排序只在版本变化时重算——
   * 稳态零排序成本（旧实现每次比较线性扫 caches，O(n·log n·文件数)/tick）。
   */
  const orderedCandidates = (): PendingImportCandidate[] => {
    if (orderedCache !== undefined && orderedCache.version === cachesVersion) return orderedCache.list;
    const activityBySession = new Map<string, number>();
    for (const cache of caches.values()) {
      if (cache.sessionMeta) activityBySession.set(cache.sessionMeta.sessionId, cache.lastActivityMs);
    }
    const candidates: PendingImportCandidate[] = [];
    for (const cache of caches.values()) {
      if (!cache.sessionMeta) continue;
      for (const record of cache.records) {
        if (!CODEX_ALLOWED_PROVIDER_IDS.includes(record.providerId as "openai")) continue;
        candidates.push({
          id: record.id,
          sessionId: record.sessionId,
          completedAt: record.completedAt ?? record.startedAt,
          modelId: record.modelId,
        });
      }
    }
    candidates.sort((left, right) => {
      const leftActivity = activityBySession.get(left.sessionId) ?? 0;
      const rightActivity = activityBySession.get(right.sessionId) ?? 0;
      if (leftActivity !== rightActivity) return rightActivity - leftActivity;
      if (left.completedAt !== right.completedAt) return left.completedAt - right.completedAt;
      return left.id < right.id ? -1 : 1;
    });
    orderedCache = {version: cachesVersion, list: candidates};
    return candidates;
  };

  const candidatesForQuery = (floorEpochMs: number, allowedModels: ReadonlySet<string>): PendingImportCandidate[] => {
    if (allowedModels.size === 0) return [];
    return orderedCandidates().filter(candidate =>
      candidate.completedAt >= floorEpochMs
      && modelFaceMatch(candidate.modelId, allowedModels));
  };

  /**
   * 正文按需解析（A 修复 + 2026-10-10 增量化）：LRU 命中且条数覆盖目标记录即用；
   * 命中但条目落后于文件追加（活跃会话）→ 只续析 [条目前沿, 解析前沿) 增量并追加
   * （取代全文件重析——活跃会话此前每 tick 全量重读重析，是 ~8MB/s 垃圾产出的
   * 主源）；未命中（逐出/首次）→ 从 0 全量重建。条数仍不足（文件被截短/轮转）
   * → undefined，绝不产出截断的上下文回放。
   */
  const resolveSessionItems = (cache: RolloutFileCache, minCount: number): SessionItem[] | undefined => {
    const hit = contentLru.get(cache.fileKey);
    if (hit !== undefined && hit.items.length >= minCount) return hit.items;
    let entry = hit;
    if (entry === undefined) {
      const rebuilt = rebuildSessionItems(cache.path, cache.offset);
      if (rebuilt === undefined) return undefined;
      entry = rebuilt;
    } else if (!advanceSessionItems(cache.path, entry, cache.offset)) {
      return undefined;
    }
    if (entry.items.length < minCount) return undefined;
    // 回填 LRU 同时按增长后的条目重估字节（可能触发对其它文件的逐出）。
    contentLru.set(cache.fileKey, entry);
    return entry.items;
  };

  return {
    agentId: "codex",
    label: "Codex 官方直连",
    directImportEnabled: true,
    /**
     * 回填限流（2026-10-10 B 修复，插件式）：单次调度 tick 最多导入 2 批（≤30 条）。
     * codex 详情重建与上下文回放的单条可达 MB 级字符串，限速使垃圾产出回到 GC
     * 舒适区，避免重启回填期 RSS 冲到 GiB 级（用户确认「慢慢导入」）。未声明的
     * 适配器（zcode/dsh）保持既有连续批语义，零影响。
     */
    backfillBatchesPerTick: 2,
    gatewayProviderMarkers: CODEX_GATEWAY_PROVIDER_MARKERS,
    allowedProviderIds: CODEX_ALLOWED_PROVIDER_IDS,
    officialUpstreamBaseUrl: CODEX_OFFICIAL_UPSTREAM_BASE_URL,
    protocolPath: CODEX_PROTOCOL_PATH,
    syntheticWireApi: "responses",
    syntheticTargetFormatHint: "openai",

    async discover(): Promise<LocalSourceStatus> {
      try {
        const info = statSync(sessionsDir);
        return {
          availability: info.isDirectory() ? {state: "available"} : {state: "missing", reason: "sessions 目录不存在"},
          dataDir: cliDir,
          localSchemaVersion: "codex-rollout-jsonl-2",
        };
      } catch {
        return {availability: {state: "missing", reason: "未找到 ~/.codex/sessions（尚未安装或使用 Codex CLI）"}, dataDir: cliDir};
      }
    },

    readPendingCandidates(floorEpochMs: number, allowedModels: ReadonlySet<string>): PendingImportCandidate[] {
      scanAndIndex(floorEpochMs);
      return candidatesForQuery(floorEpochMs, allowedModels);
    },

    readPendingBatch(query: PendingBatchQuery): PendingBatchResult {
      // D2 下推（2026-10-10 C）：与 readPendingCandidates 同一扫描、同一有序候选，
      // 仅「seen 反联 + LIMIT」改为主键索引分块探针（公共 seen-probe 模块）——取代
      // 调度器旧路径的「整表 seen 加载 + 全量候选 JS Set 过滤」（实测随历史线性放大）。
      if (query.allowedModels.size === 0) return {records: [], mode: "chunked"};
      scanAndIndex(query.floorEpochMs);
      const ordered = candidatesForQuery(query.floorEpochMs, query.allowedModels);
      const records: PendingImportCandidate[] = [];
      const seenDb = openSeenProbeDatabase(query.dataDir);
      try {
        for (let start = 0; start < ordered.length && records.length < query.limit; start += SEEN_PROBE_CHUNK) {
          const chunk = ordered.slice(start, start + SEEN_PROBE_CHUNK);
          const seen = probeSeenExchangeIds(seenDb, query.seenExchangeIdPrefix, chunk.map(candidate => candidate.id));
          for (const candidate of chunk) {
            if (seen.has(candidate.id)) continue;
            records.push(candidate);
            if (records.length >= query.limit) break;
          }
        }
      } finally {
        try { seenDb.close(); } catch { /* 短命连接，下一批重开。 */ }
      }
      return {records, mode: "chunked"};
    },

    hydrateUsageRecords(ids: readonly string[]): LocalUsageBatch {
      const byId = new Map<string, LocalUsageRecord>();
      for (const cache of caches.values()) {
        for (const record of cache.records) byId.set(record.id, record);
      }
      return {records: ids.flatMap(id => byId.get(id) ?? []), schemaVersion: "codex-rollout-jsonl-2"};
    },

    normalizeModelId(modelId: string): string {
      return modelId.trim();
    },

    readExchangeDetail(ref: LocalExchangeRef): Promise<LocalExchangeDetail | undefined> {
      // 正文定位（B2，2026-10-09）：ref.requestId = 记录 id（fileKey:ordinal）。
      // 请求体 = 该请求之前的全量可见上下文（wire 原始 payload 回放，与网关捕获的
      // responses input 形态一致）；响应 = 该请求的 output 侧 items 聚合。
      const cache = findCacheBySessionId(caches, ref.sessionId);
      if (!cache) return Promise.resolve(undefined);
      const detail = ref.requestId !== undefined ? cache.recordDetails.get(ref.requestId) : undefined;
      if (!detail) return Promise.resolve(undefined);
      // 正文按需解析（2026-10-10 A 修复）：items 不再常驻，LRU 命中且条数覆盖目标
      // 记录即用，否则从磁盘重析；重建失败（文件被清理/截短）→ 详情缺失（用量入账
      // 不受影响，与 dsh/zcode 的「短命正文、趁热导入」语义一致）。
      const items = resolveSessionItems(cache, detail.itemCount);
      if (items === undefined) return Promise.resolve(undefined);
      const meta = cache.sessionMeta;
      const input = items.slice(0, detail.contextEnd).map(item => itemWirePayload(item));
      const response = aggregateResponse(items, detail.outputIndices);
      const lastOutputItem = detail.outputIndices
        .map(index => items[index])
        .filter((item): item is SessionItem => item !== undefined)
        .at(-1);
      return Promise.resolve({
        // instructions 来自 session_meta.base_instructions（官方落盘的会话基础指令，
        // 实测 ~22KB）——部分会话可能缺失，不强求。
        requestRawBody: JSON.stringify({
          model: cache.currentTurn?.model ?? "",
          ...(meta?.baseInstructions !== undefined ? {instructions: meta.baseInstructions} : {}),
          input,
        }),
        response,
        // 响应头为合成占位（本地记录不含真实响应头；合成体是 JSON）。
        responseHeaders: {"content-type": "application/json"},
        ...(lastOutputItem?.itemId !== undefined ? {responseId: lastOutputItem.itemId} : {}),
        // codex rollout 结构上不含工具定义（tools），系统提示视会话可能有——骨架缺失
        // 是已知常态，标记后合成层跳过诊断，不产生 request_skeleton_missing 警告。
        ...(meta?.baseInstructions === undefined ? {skeletonUnavailable: true} : {}),
        skeletonSource: "rollout",
      });
    },

    async readSessionTimeline(): Promise<undefined> {
      // 交互内容由 readExchangeDetail 的上下文回放承载（responses input 形态）；
      // zcode 的 anthropic timeline 重建契约不适用于 responses wire。
      return undefined;
    },

    buildSyntheticRequestHeaders(record: LocalUsageRecord): Record<string, string> {
      // 网关 codex 同款身份信号（thread-identity / codexTurnMetadata 消费）：
      // x-codex-session-id 分 Session（CLI 与桌面 App 独立 rollout 天然分离）、
      // x-codex-turn-metadata.turn_id 定 Turn 边界与 native_turn_id 回填。
      const meta = findCacheBySessionId(caches, record.sessionId)?.sessionMeta;
      return {
        "user-agent": `codex-cli/${meta?.cliVersion || "unknown"} (Mac OS local-import)`,
        // 认证头按网关链路「raw 只记占位」语义合成：本地数据本就无真实密钥。
        authorization: "Bearer deepaa-gateway",
        "x-codex-session-id": record.sessionId,
        "x-codex-turn-metadata": JSON.stringify({
          ...(record.turnId ? {turn_id: record.turnId} : {}),
          thread_source: meta?.threadSource ?? "user",
        }),
      };
    },

    assembleChatResponseRawBody(record: LocalUsageRecord, detail: LocalExchangeDetail | undefined, modelId: string): string {
      // responses wire 形态：usage 组装与 extractTokenUsage 的 OpenAI 嵌套口径严格互逆
      // ——input_tokens 含 cached 子集（parser 自动相减得非缓存输入），reasoning 为
      // output 子集；cache_creation 走顶层独立字段。output 数组填真实 assistant items
      // （正文缺失时为空数组，账本永不缺数）。
      const inclusiveInput = record.usage.inputTokens + record.usage.cacheReadTokens;
      const response = detail?.response;
      const output: Array<Record<string, unknown>> = [];
      if (response?.reasoningText?.trim()) {
        output.push({type: "reasoning", summary: [{type: "summary_text", text: response.reasoningText}]});
      }
      if (response?.text) {
        output.push({type: "message", role: "assistant", content: [{type: "output_text", text: response.text}]});
      }
      for (const call of response?.toolCalls ?? []) {
        output.push({
          type: "function_call",
          call_id: call.id ?? `call_local_${record.id.replaceAll(":", "_")}`,
          name: call.name ?? "unknown",
          arguments: JSON.stringify(call.input ?? {}),
        });
      }
      const body = {
        id: `resp_local_${record.id.replaceAll(":", "_")}`,
        object: "response",
        status: record.status === "error" ? "failed" : "completed",
        model: modelId,
        output,
        usage: {
          input_tokens: inclusiveInput,
          input_tokens_details: {cached_tokens: record.usage.cacheReadTokens},
          cache_creation_input_tokens: record.usage.cacheCreationTokens,
          output_tokens: record.usage.outputTokens,
          output_tokens_details: {reasoning_tokens: record.usage.reasoningTokens},
          total_tokens: inclusiveInput + record.usage.cacheCreationTokens + record.usage.outputTokens,
        },
      };
      return JSON.stringify(body);
    },
  };
}

/** rollout 文件清单（窗口内按 mtime 倒序）：sessions/YYYY/MM/DD 目录按日期裁剪。 */
function listRolloutFiles(sessionsDir: string, floorEpochMs: number): Array<{path: string; fileKey: string; mtimeMs: number; size: number}> {
  const floorDate = new Date(floorEpochMs);
  const results: Array<{path: string; fileKey: string; mtimeMs: number; size: number}> = [];
  const years = readdirSyncOrNull(sessionsDir);
  for (const year of years) {
    if (!/^\d{4}$/u.test(year) || Number(year) < floorDate.getUTCFullYear()) continue;
    const months = readdirSyncOrNull(join(sessionsDir, year));
    for (const month of months) {
      if (!/^\d{2}$/u.test(month)) continue;
      const days = readdirSyncOrNull(join(sessionsDir, year, month));
      for (const day of days) {
        if (!/^\d{2}$/u.test(day)) continue;
        // 日期目录粒度裁剪：早于窗口下界的整日跳过（readdir 有界，≤30 日目录）。
        if (Number(year) < floorDate.getUTCFullYear()
          || (Number(year) === floorDate.getUTCFullYear() && Number(month) < floorDate.getUTCMonth() + 1)
          || (Number(year) === floorDate.getUTCFullYear() && Number(month) === floorDate.getUTCMonth() + 1 && Number(day) < floorDate.getUTCDate())) {
          continue;
        }
        const dirPath = join(sessionsDir, year, month, day);
        for (const name of readdirSyncOrNull(dirPath)) {
          if (!name.startsWith("rollout-") || !name.endsWith(".jsonl")) continue;
          const filePath = join(dirPath, name);
          const info = statSyncOrNull(filePath);
          if (!info || info.mtimeMs < floorEpochMs) continue;
          results.push({path: filePath, fileKey: name.replace(/\.jsonl$/u, ""), mtimeMs: info.mtimeMs, size: info.size});
        }
      }
    }
  }
  results.sort((left, right) => right.mtimeMs - left.mtimeMs);
  return results;
}

/**
 * 增量续析一个 rollout 文件（同步、有界）：从 cache.offset 读到文件尾，按 \n 切行，
 * 无换行的尾字节留在缓冲区跨轮拼接；逐行 JSON.parse 容错（坏行跳过）。返回本轮读取字节数。
 */
function refreshRolloutCache(cache: RolloutFileCache): number {
  let raw: Buffer;
  try {
    raw = readFileSyncBounded(cache.path, cache.offset);
  } catch {
    return 0;
  }
  if (raw.length === 0) return 0;
  cache.offset += raw.length;
  const merged = cache.tail.length > 0 ? Buffer.concat([cache.tail, raw]) : raw;
  let separator = merged.indexOf(0x0A);
  if (separator === -1) {
    cache.tail = ownedTailBuffer(merged);
    return raw.length;
  }
  let lineStart = 0;
  while (separator !== -1) {
    const line = merged.subarray(lineStart, separator);
    consumeRolloutLine(cache, line);
    lineStart = separator + 1;
    separator = merged.indexOf(0x0A, lineStart);
  }
  cache.tail = ownedTailBuffer(merged.subarray(lineStart));
  return raw.length;
}

/**
 * 尾部残片必须独立持有（2026-10-10 修复）：subarray 视图会钉住整段读取缓冲的
 * 底层 ArrayBuffer——rollout 行以 \n 结尾，正常轮次解析完尾部为 0 字节，但空
 * 视图仍保留读取缓冲的全量内存（固定 32 MiB 分配时代 = 每文件 32 MiB 常驻，
 * 实测把进程 RSS 推到 GiB 级）。
 */
function ownedTailBuffer(view: Buffer): Buffer {
  return view.length === 0 ? Buffer.alloc(0) : Buffer.from(view);
}

/** 正文缓存条目（A 修复 + 2026-10-10 增量化）：items 随文件追加续析增长。 */
interface ContentCacheEntry {
  items: SessionItem[];
  /** 已消费到的字节前沿（含尾部半行）。 */
  offset: number;
  /** 跨续析边界的半行缓冲（与 RolloutFileCache.tail 同语义）。 */
  tail: Buffer;
  /** 当前 turnId（与扫描态 currentTurn 同语义，续析与全量重建保持一致）。 */
  turnId: string | undefined;
}

/**
 * 单块字节的内容消费（全量重建与增量续析共用）：切行、尾部半行缓冲、
 * turn_context / response_item 映射追加——同一段字节经本函数产出与扫描态
 * 逐条一致的 items 序列。
 */
function consumeContentChunk(entry: ContentCacheEntry, raw: Buffer): void {
  const merged = entry.tail.length > 0 ? Buffer.concat([entry.tail, raw]) : raw;
  let separator = merged.indexOf(0x0A);
  if (separator === -1) {
    entry.tail = ownedTailBuffer(merged);
    return;
  }
  let lineStart = 0;
  while (separator !== -1) {
    const trimmed = merged.subarray(lineStart, separator).toString("utf8").trim();
    if (trimmed !== "") {
      try {
        const parsed = JSON.parse(trimmed) as {type?: string; ordinal?: number; payload?: Record<string, unknown>};
        if (parsed.type === "turn_context" && parsed.payload) {
          // 与扫描态 currentTurn 同语义：每个 turn_context 整体替换（缺 turn_id 即清空）。
          entry.turnId = typeof parsed.payload.turn_id === "string" ? parsed.payload.turn_id : undefined;
        } else if (parsed.type === "response_item" && parsed.payload) {
          const item = mapResponseItemToSessionItem(parsed.ordinal ?? entry.items.length + 1, parsed.payload, entry.turnId);
          if (item !== undefined) entry.items.push(item);
        }
      } catch {
        // 坏行跳过（与扫描态一致）。
      }
    }
    lineStart = separator + 1;
    separator = merged.indexOf(0x0A, lineStart);
  }
  entry.tail = ownedTailBuffer(merged.subarray(lineStart));
}

/**
 * 从磁盘全量重建正文条目（2026-10-10 A 修复）：从文件头重放到解析前沿
 * （cache.offset），读取有界（每块 ≤32 MiB 循环推进）。失败（文件被清理/不可读）
 * 返回 undefined。
 */
function rebuildSessionItems(path: string, parseFrontierOffset: number): ContentCacheEntry | undefined {
  const entry: ContentCacheEntry = {items: [], offset: 0, tail: Buffer.alloc(0), turnId: undefined};
  while (entry.offset < parseFrontierOffset) {
    let raw: Buffer;
    try {
      raw = readFileSyncBounded(path, entry.offset);
    } catch {
      return undefined;
    }
    if (raw.length === 0) break;
    entry.offset += raw.length;
    consumeContentChunk(entry, raw);
  }
  return entry;
}

/**
 * 增量续析（2026-10-10）：从条目已消费前沿推进到目标前沿，只处理新增字节并追加
 * items——活跃会话不再每 tick 全文件重读重析。读取失败（文件被清理）返回 false；
 * 文件截短（读到 EOF 仍不足）由调用方的条数守卫裁决。
 */
function advanceSessionItems(path: string, entry: ContentCacheEntry, targetOffset: number): boolean {
  while (entry.offset < targetOffset) {
    let raw: Buffer;
    try {
      raw = readFileSyncBounded(path, entry.offset);
    } catch {
      return false;
    }
    if (raw.length === 0) break;
    entry.offset += raw.length;
    consumeContentChunk(entry, raw);
  }
  return true;
}

/** 正文条目近似字节成本（LRU 预算口径）：字符数 ×2 覆盖 V8 双字节字符串，宁可高估。 */
function estimateContentEntryBytes(entry: ContentCacheEntry): number {
  let total = entry.tail.length;
  for (const item of entry.items) {
    total += 96;
    if (item.text !== undefined) total += item.text.length * 2;
    if (item.reasoningText !== undefined) total += item.reasoningText.length * 2;
    if (item.toolOutput !== undefined) total += item.toolOutput.length * 2;
    if (item.toolInput !== undefined && typeof item.toolInput === "object") {
      try {
        total += JSON.stringify(item.toolInput).length * 2;
      } catch {
        total += 2048;
      }
    }
  }
  return total;
}

function consumeRolloutLine(cache: RolloutFileCache, line: Buffer): void {
  const trimmed = line.toString("utf8").trim();
  if (trimmed === "") return;
  let parsed: {type?: string; timestamp?: string; ordinal?: number; payload?: Record<string, unknown>};
  try {
    parsed = JSON.parse(trimmed) as typeof parsed;
  } catch {
    return;
  }
  const timestampMs = Date.parse(parsed.timestamp ?? "");
  const validTs = Number.isFinite(timestampMs);
  if (validTs) cache.lastActivityMs = Math.max(cache.lastActivityMs, timestampMs);
  if (parsed.type === "session_meta" && parsed.payload) {
    cache.sessionMeta = {
      sessionId: String(parsed.payload.session_id ?? parsed.payload.id ?? cache.fileKey),
      modelProvider: String(parsed.payload.model_provider ?? "openai"),
      cliVersion: String(parsed.payload.cli_version ?? ""),
      ...(typeof parsed.payload.source === "string" ? {source: parsed.payload.source} : {}),
      ...(typeof parsed.payload.thread_source === "string" ? {threadSource: parsed.payload.thread_source} : {}),
      ...(typeof parsed.payload.base_instructions === "string" && parsed.payload.base_instructions !== ""
        ? {baseInstructions: parsed.payload.base_instructions}
        : {}),
    };
    return;
  }
  if (parsed.type === "turn_context" && parsed.payload) {
    cache.currentTurn = {
      turnId: typeof parsed.payload.turn_id === "string" ? parsed.payload.turn_id : undefined,
      model: typeof parsed.payload.model === "string" ? parsed.payload.model : undefined,
    };
    // 新 turn：请求起点锚回到 turn 开始（agentic 多请求轮的间隙归上一请求）。
    if (validTs) cache.requestAnchorMs = timestampMs;
    cache.pendingOutputIndices = [];
    cache.pendingOutputTimings = [];
    return;
  }
  if (parsed.type === "response_item" && parsed.payload) {
    consumeResponseItem(cache, parsed.ordinal ?? cache.itemCount + 1, parsed.payload, validTs ? timestampMs : undefined);
    return;
  }
  if (parsed.type === "event_msg" && parsed.payload?.type === "item_completed") {
    // 三修（2026-10-09）：不依赖 ID 匹配——item_completed.item.type 是桌面 App 语义类型
    // （UserMessage/CommandExecution/AgentMessage/Reasoning），与 response_item 的 wire ID
    // 是两套独立标识（实测匹配率仅 3/8，仅 AI 输出恰好共享前缀）。直接按 item.type
    // 分方向推进时序：input 侧完成 → 推进请求锚；output 侧 → 累积首字/完成时间。
    const item = parsed.payload.item as {type?: string} | undefined;
    const startedMs = Number(parsed.payload.started_at_ms) || 0;
    const completedMs = Number(parsed.payload.completed_at_ms) || 0;
    if (item?.type === "UserMessage") {
      // UserMessage 完成时刻 = 用户提交新请求的近似时刻 → 推进请求锚。
      // 注意：CommandExecution 不推进锚——工具执行发生在模型输出之后、token_count
      // 之前（当前请求生命周期内部），推锚会导致首字时间被错误过滤（四修根因）。
      if (completedMs > 0) {
        cache.lastInputActivityMs = completedMs;
        cache.requestAnchorMs = Math.max(cache.requestAnchorMs ?? 0, completedMs);
      }
    } else if (item?.type === "AgentMessage" || item?.type === "Reasoning") {
      if (startedMs > 0) {
        cache.pendingOutputTimings.push({startedMs, completedMs: Math.max(completedMs, startedMs)});
      }
    }
    return;
  }
  if (parsed.type === "event_msg" && parsed.payload?.type === "token_count") {
    consumeTokenCount(cache, String(parsed.ordinal ?? cache.records.length + 1), parsed.payload, validTs ? timestampMs : cache.lastActivityMs);
  }
}

/**
 * response_item → 会话 item 的纯映射（wire 原始字段保留，方向按 content/类型判定）。
 * 2026-10-10 A 拆分：扫描计数路径与按需重析路径共用同一份映射，保证从磁盘重建的
 * items 与原解析逐条一致。
 */
function mapResponseItemToSessionItem(ordinal: number, payload: Record<string, unknown>, turnId: string | undefined): SessionItem | undefined {
  const itemId = typeof payload.id === "string" ? payload.id : undefined;
  if (payload.type === "message") {
    const content = Array.isArray(payload.content) ? payload.content as Array<{type?: string; text?: string}> : [];
    const texts = content.map(part => typeof part.text === "string" ? part.text : "").filter(Boolean);
    const isOutput = content.some(part => part.type === "output_text");
    const role = typeof payload.role === "string" && payload.role ? payload.role : isOutput ? "assistant" : "user";
    return {
      ordinal, turnId,
      direction: isOutput ? "output" : "input",
      kind: "message", itemId, role,
      text: texts.join("\n"),
    };
  }
  if (payload.type === "reasoning") {
    const summary = Array.isArray(payload.summary) ? payload.summary as Array<{text?: string}> : [];
    return {
      ordinal, turnId,
      direction: "output", kind: "reasoning", itemId,
      reasoningText: summary.map(part => typeof part.text === "string" ? part.text : "").filter(Boolean).join("\n"),
    };
  }
  if (payload.type === "custom_tool_call") {
    return {
      ordinal, turnId,
      direction: "output", kind: "custom_tool_call", itemId,
      toolName: typeof payload.name === "string" ? payload.name : undefined,
      callId: typeof payload.call_id === "string" ? payload.call_id : undefined,
      toolInput: payload.input,
    };
  }
  if (payload.type === "custom_tool_call_output") {
    // 实测 output 是 input_text 段数组（多段文本），拼接为 function_call_output 的字符串。
    const outputText = Array.isArray(payload.output)
      ? (payload.output as Array<{text?: string}>)
        .map(part => typeof part.text === "string" ? part.text : "")
        .filter(Boolean).join("\n")
      : typeof payload.output === "string" ? payload.output : undefined;
    return {
      ordinal, turnId,
      direction: "input", kind: "custom_tool_call_output", itemId,
      callId: typeof payload.call_id === "string" ? payload.call_id : undefined,
      toolOutput: outputText,
    };
  }
  return undefined;
}

function consumeResponseItem(cache: RolloutFileCache, ordinal: number, payload: Record<string, unknown>, _timestampMs: number | undefined): void {
  const item = mapResponseItemToSessionItem(ordinal, payload, cache.currentTurn?.turnId);
  if (item !== undefined) pushSessionItem(cache, item);
}

function pushSessionItem(cache: RolloutFileCache, item: SessionItem): void {
  // 三修（2026-10-09）：response_item 的行时间戳是批量落盘时间（四行同毫秒，实测），
  // 不用于锚推进——锚只由 item_completed 的精确 payload 毫秒推进（见 consumeRolloutLine）。
  // A 修复（2026-10-10）：扫描态只推进计数与 output 索引，item 正文即弃（年轻代垃圾，
  // 回填节奏由 backfillBatchesPerTick 约束）——正文只在 readExchangeDetail 的按需
  // 重析中重建并进入有界 LRU。
  const index = cache.itemCount;
  cache.itemCount += 1;
  if (item.direction === "output") {
    cache.pendingOutputIndices.push(index);
  }
}

/**
 * token_count：一条导入记录（一次模型请求）+ 正文定位 + 时间信息。
 * 时间口径（2026-10-09 三修）：不依赖 response_item ID 与 item_completed ID 的匹配
 * （两套独立标识，实测匹配率仅 3/8）。锚 = 最近一次 input 侧活动（UserMessage /
 * CommandExecution 的 item_completed 行时间戳），首字/完成 = 自上一 token_count 以来
 * 累积的 output 侧 item_completed（AgentMessage/Reasoning）的精确毫秒。
 */
function consumeTokenCount(cache: RolloutFileCache, ordinalText: string, payload: Record<string, unknown>, lineTimestampMs: number): void {
  const info = payload.info as {last_token_usage?: Record<string, unknown>} | undefined;
  const usageRaw = info?.last_token_usage;
  if (!usageRaw || !cache.sessionMeta) return;
  const inputTokens = numberOr(usageRaw.input_tokens);
  const cachedInput = numberOr(usageRaw.cached_input_tokens);
  const anchorMs = cache.requestAnchorMs ?? lineTimestampMs;
  // 四修（2026-10-09）：不做 startedMs > anchorMs 过滤——pendingOutputTimings 在每次
  // token_count 后清零，天然只含当前请求的输出；过滤会把先于 CommandExecution 锚的
  // Reasoning/AgentMessage 错误剔除（工具执行在模型输出之后才发生，推锚超过首字时间）。
  const outputTimings = cache.pendingOutputTimings;
  const firstTokenMs = outputTimings.length > 0 && outputTimings[0]!.startedMs > anchorMs
    ? outputTimings[0]!.startedMs - anchorMs
    : undefined;
  const lastOutputCompleted = outputTimings.at(-1)?.completedMs ?? 0;
  const completedAt = lastOutputCompleted > anchorMs ? lastOutputCompleted : lineTimestampMs;
  const id = `${cache.fileKey}:${ordinalText}`;
  // OpenAI 口径（实测 total = input + output）：input_tokens 含 cached 子集 →
  // 五维里的 inputTokens 记「非缓存输入」，缓存部分归 cacheReadTokens。
  cache.records.push({
    id,
    attemptIndex: 0,
    providerId: cache.sessionMeta.modelProvider,
    modelId: cache.currentTurn?.model ?? "",
    ...(cache.sessionMeta.source ? {querySource: cache.sessionMeta.source} : {}),
    status: "completed",
    startedAt: anchorMs,
    completedAt,
    ...(completedAt > anchorMs ? {durationMs: completedAt - anchorMs} : {}),
    ...(firstTokenMs !== undefined && firstTokenMs > 0 ? {firstTokenMs} : {}),
    usage: {
      inputTokens: Math.max(inputTokens - cachedInput, 0),
      outputTokens: numberOr(usageRaw.output_tokens),
      reasoningTokens: numberOr(usageRaw.reasoning_output_tokens),
      cacheCreationTokens: numberOr(usageRaw.cache_write_input_tokens),
      cacheReadTokens: cachedInput,
    },
    sessionId: cache.sessionMeta.sessionId,
    ...(cache.currentTurn?.turnId ? {turnId: cache.currentTurn.turnId} : {}),
    detailRef: {
      sessionId: cache.sessionMeta.sessionId,
      ...(cache.currentTurn?.turnId ? {turnId: cache.currentTurn.turnId} : {}),
      requestId: id,
      startedAt: anchorMs,
    },
  });
  cache.recordDetails.set(id, {
    // 请求上下文 = 当前全部 items 去掉本请求输出（output 侧尚未计入后续上下文）。
    contextEnd: cache.itemCount - cache.pendingOutputIndices.length,
    outputIndices: [...cache.pendingOutputIndices],
    // 解析时点的 items 总数：重析完整性守卫（见 RecordDetail.itemCount）。
    itemCount: cache.itemCount,
  });
  cache.pendingOutputIndices = [];
  cache.pendingOutputTimings = [];
  cache.requestAnchorMs = completedAt;
}

/** item → wire 原始 payload（请求回放保真；与网关捕获的 responses input 形态一致）。 */
function itemWirePayload(item: SessionItem): Record<string, unknown> {
  if (item.kind === "message") {
    const contentType = item.direction === "output" ? "output_text" : "input_text";
    return {
      type: "message",
      role: item.role ?? (item.direction === "output" ? "assistant" : "user"),
      content: item.text !== undefined ? [{type: contentType, text: item.text}] : [],
    };
  }
  if (item.kind === "reasoning") {
    return {
      type: "reasoning",
      summary: item.reasoningText !== undefined ? [{type: "summary_text", text: item.reasoningText}] : [],
    };
  }
  if (item.kind === "custom_tool_call") {
    return {
      type: "function_call",
      call_id: item.callId ?? "",
      name: item.toolName ?? "unknown",
      arguments: JSON.stringify(item.toolInput ?? {}),
    };
  }
  return {
    type: "function_call_output",
    call_id: item.callId ?? "",
    output: item.toolOutput ?? "",
  };
}

/** 响应聚合（LocalResponseShape）：output 侧 items → text / reasoning / toolCalls。 */
function aggregateResponse(items: SessionItem[], outputIndices: readonly number[]): LocalResponseShape {
  const texts: string[] = [];
  const reasoning: string[] = [];
  const toolCalls: Array<{id?: string; name?: string; input?: unknown}> = [];
  for (const index of outputIndices) {
    const item = items[index];
    if (!item) continue;
    if (item.kind === "message" && item.text) texts.push(item.text);
    if (item.kind === "reasoning" && item.reasoningText) reasoning.push(item.reasoningText);
    if (item.kind === "custom_tool_call") {
      toolCalls.push({id: item.callId, name: item.toolName, input: item.toolInput});
    }
  }
  return {
    ...(reasoning.length > 0 ? {reasoningText: reasoning.join("\n")} : {}),
    ...(texts.length > 0 ? {text: texts.join("\n")} : {}),
    ...(toolCalls.length > 0 ? {toolCalls} : {}),
  };
}

/** 模型面匹配（大小写不敏感，计价匹配同口径）。 */
function modelFaceMatch(modelId: string, allowedModels: ReadonlySet<string>): boolean {
  if (allowedModels.size === 0 || !modelId) return false;
  if (allowedModels.has(modelId)) return true;
  for (const allowed of allowedModels) {
    if (allowed.toLowerCase() === modelId.toLowerCase()) return true;
  }
  return false;
}

function findCacheBySessionId(caches: Map<string, RolloutFileCache>, sessionId: string): RolloutFileCache | undefined {
  for (const cache of caches.values()) {
    if (cache.sessionMeta?.sessionId === sessionId) return cache;
  }
  return undefined;
}

function numberOr(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function readdirSyncOrNull(path: string): string[] {
  // 清单枚举用同步 readdir（调度器契约为同步 readPendingCandidates）；目录体量
  // 受日期裁剪约束（≤30 日），失败按空处理（目录被清理等）。
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

function statSyncOrNull(path: string): {mtimeMs: number; size: number} | undefined {
  try {
    const info = statSync(path);
    return {mtimeMs: info.mtimeMs, size: info.size};
  } catch {
    return undefined;
  }
}

function readFileSyncBounded(path: string, offset: number): Buffer {
  const handle = openSync(path, "r");
  try {
    // 单轮单文件读取上限 32 MiB，但缓冲按实际剩余字节分配（fstat 与读取同一
    // fd，无 TOCTOU）：固定 32 MiB 分配会让「无新数据的轮次」也付出整段分配 +
    // 清零成本（2026-10-10 修复）。无剩余字节时零分配直接返回。
    const remaining = fstatSync(handle).size - offset;
    if (remaining <= 0) return Buffer.alloc(0);
    const buffer = Buffer.alloc(Math.min(32 * 1024 * 1024, remaining));
    // readSync 返回字节数（number）——按对象解构会得到 undefined 并放大成整个缓冲区，
    // 实测导致 offset 一轮跳 32MiB、冷启动预算立即耗尽（2026-10-09 首轮零导入根因）。
    const bytesRead = readSync(handle, buffer, 0, buffer.length, offset);
    return buffer.subarray(0, bytesRead);
  } finally {
    closeSync(handle);
  }
}
