/**
 * dsh（DeepSeek Harness）本地数据源适配器（2026-09-17 双链路扩展）。
 *
 * 数据源：~/.dsh/sessions/<workspace>/<session-uuid>/session.v3.jsonl.zstd
 * （生成式事件目录 KNOWN_SESSION_EVENT_TYPES，带版本化兼容契约；全程只读，
 * 绝不写/lock/checkpoint——与 zcode 适配器同一红线）。
 *
 * 与 zcode 的关键差异：
 * - dsh 的 wire 请求不携带任何会话身份（deepseek-harness attribution 设计决定，
 *   "no session ids"），但其本地事件有完整原生 session/turn/step 与 responseId，
 *   且 responseId 与网关捕获响应的 providerItemId 完全一致——因此采用
 *   「双路径」：官方直连流量合成 capture 入账（zcode 模式），经网关流量不重复
 *   入账、只把 (responseId → session/turn/step/parent) 身份标注回填给网关行。
 * - 准入规则 = gatewayProviderMarkers 黑名单（deepaa-gateway 等，dsh 本地
 *   request/context.provider 明确记录）+ 绑定目标 supportedModelScopes 模型
 *   白名单（用户规则：只接受供应商管理配置的模型）。dsh 的 provider 名是用户
 *   自定义字符串，无法像 zcode 一样枚举 allowedProviderIds——用黑名单 + 模型
 *   白名单达成同一语义（见设计文档 §1.4 偏差说明）。
 */

import {homedir} from "node:os";
import {join} from "node:path";
import {readdirSync, readFileSync, statSync} from "node:fs";
import {decompress} from "fzstd";
import type {AgentId} from "@/types";
import type {
  AgentLocalIdentityLink,
  AgentLocalSourceAdapter,
  LocalExchangeDetail,
  LocalExchangeRef,
  LocalSourceStatus,
  LocalUsageBatch,
  LocalUsageRecord,
  PendingImportCandidate,
} from "../types";

/** 单会话解压上限（与 zcode 时间线同款防御；超过即整会话跳过，绝不 OOM）。 */
const MAX_SESSION_DECOMPRESSED_BYTES = 64 * 1024 * 1024;
/** 单轮扫描的会话文件上限（有界目录枚举；超出留给下一轮）。 */
const MAX_SESSION_FILES_PER_SCAN = 240;
/**
 * 单轮扫描的解压字节预算（2026-09-18 修复"每轮全量重解压"）：
 * fzstd 是纯 JS 解压（本机实测 ~4.5 MB/s 解压输出），dsh 会话库解压后可达
 * 100 MB+，一次性解压会把 Next 主线程独占 20 s 以上，HTTP 与 Worker 全部排队
 * （2026-09-18 实测：接口 22–32 s 停顿、派生任务租约过期）。本预算只约束
 * **尚未建索引**的历史文件回补，单轮同步阻塞控制在 ~2 s 内；已建索引且
 * mtime/size 未变的文件零解压。
 */
const MAX_SCAN_DECOMPRESSED_BYTES_PER_ROUND = 8 * 1024 * 1024;
/**
 * 单次解析失败收取的预算成本（2026-10-10 修复）：失败路径没有真实解压字节数可记，
 * 按固定成本计入本轮预算。旧 break 条件要求「至少成功解析一个文件才检查预算」，
 * 全部失败的轮次会对扫描上限内的文件逐一重解压且每 2s 重复一轮——fzstd 是纯
 * JS 解压，一个解压后超限的活跃会话（>64 MiB 上限判定同样走失败路径）每轮即可
 * 独占主线程十几秒。
 */
const FAILED_PARSE_COST_BYTES = 4 * 1024 * 1024;
/**
 * 解析失败退避（2026-10-10 修复）：连续失败按指数退避（8s → 16s → … 封顶 10
 * 分钟），成功解析即清除。退避只按时间、不看签名——损坏/超限的活跃追加文件同样
 * 受约束（旧实现每轮重试，超大活跃会话等于每 2s 全量重解压一次）；瞬时失败
 * （写入中途被扫到）首轮退避 8s 后自愈，仍远小于网关行身份等待的 90s 窗口。
 */
const FAILED_PARSE_BACKOFF_BASE_MS = 8_000;
const FAILED_PARSE_BACKOFF_MAX_MS = 10 * 60_000;
/**
 * 正文缓存（events + assistant blocks）的解压字节总量上限，只在请求/响应重建
 * （`readExchangeDetail`）时使用，LRU 逐出最早使用的会话。
 *
 * 2026-09-18 修复要点：身份标注与候选枚举**不再读本缓存**，改读常驻
 * `SessionIndexEntry` 索引——因此逐出正文不会触发重新解压。此前索引与正文
 * 共用一份 LRU，而 dsh 会话库解压总量（实测 103.6 MB）已超过本上限（96 MiB），
 * 每轮扫描都会把先解析的会话逐出、下一轮再重新解压，形成必然抖动。
 */
const MAX_CACHE_TOTAL_BYTES = 96 * 1024 * 1024;
/** 扫描预筛：mtime 早于「回看窗 − 7 天安全余量」的文件直接跳过。 */
const FILE_MTIME_SAFETY_MARGIN_MS = 7 * 24 * 60 * 60 * 1000;

interface DshUsage {
  inputTokens?: unknown;
  outputTokens?: unknown;
  totalTokens?: unknown;
  cacheReadTokens?: unknown;
}

interface DshStep {
  turn: number;
  step: number;
  startedAt: number;
  completedAt: number;
  finalized: boolean;
  provider?: string;
  requestModel?: string;
  responseModel?: string;
  responseId?: string;
  finishReason?: string;
  usage: DshUsage;
  /** assistant 消息内容块（reasoning/text/tool-call）。 */
  blocks: Array<Record<string, unknown>>;
  /** 该步 start 事件在事件全集中的下标（请求体重建只回放此前事件）。 */
  eventIndex: number;
}

interface DshSessionEvent {
  type: string;
  data: Record<string, unknown>;
}

interface ParsedDshSession {
  sessionId: string;
  createdAt: number;
  parentSession?: string;
  origin?: string;
  delegationDepth?: number;
  steps: DshStep[];
  /** 事件全集（重建请求体用；含 user/message、tool/*、system/message 等）。 */
  events: DshSessionEvent[];
}

interface CacheEntry {
  mtimeMs: number;
  size: number;
  bytes: number;
  session: ParsedDshSession;
}

/** 步级元数据：身份标注、候选枚举与账本字段所需的全部信息（不含 blocks 正文）。 */
type IndexedDshStep = Omit<DshStep, "blocks">;

/**
 * 常驻会话索引（2026-09-18 修复）：每文件一条，体积只与步数相关、与解压正文
 * 无关（实测 110 会话 / ~2500 步仅数百 KB），因此**不参与 LRU 逐出**，并且是
 * 「文件是否需要重新解压」的唯一判据（mtimeMs + size）。
 */
interface SessionIndexEntry {
  mtimeMs: number;
  size: number;
  sessionId: string;
  createdAt: number;
  parentSession?: string;
  origin?: string;
  delegationDepth?: number;
  steps: IndexedDshStep[];
}

/** 单轮扫描命中的会话文件（workspace/session 目录已枚举、mtime 预筛已通过）。 */
interface ScopedSessionFile {
  path: string;
  mtimeMs: number;
  size: number;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function textOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** 从 assistant/message 的 stream 终态 chunk 提取 provider/model/responseId/finish。 */
function extractFinishInfo(data: Record<string, unknown>): {
  reason?: string;
  provider?: string;
  model?: string;
  responseId?: string;
} {
  const stream = Array.isArray(data.stream) ? data.stream : [];
  for (let index = stream.length - 1; index >= 0; index -= 1) {
    const wrapper = asRecord(stream[index]);
    const chunk = asRecord(wrapper.chunk ?? wrapper);
    if (chunk.type !== "finish") continue;
    const replay = asRecord(chunk.replayState);
    const response = asRecord(replay.response);
    const reason = asRecord(chunk.reason);
    return {
      ...(typeof reason.kind === "string" ? {reason: reason.kind} : {}),
      ...(typeof response.provider === "string" ? {provider: response.provider} : {}),
      ...(typeof response.model === "string" ? {model: response.model} : {}),
      ...(typeof response.responseId === "string" ? {responseId: response.responseId} : {}),
    };
  }
  return {};
}

function parseMaybeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function mapDshFinishReason(reason: string | undefined): string {
  if (reason === "tool-calls" || reason === "tool_use") return "tool_calls";
  if (reason === "length" || reason === "max-tokens") return "length";
  return "stop";
}

export function createDshLocalSourceAdapter(
  options: {
    cliDir?: string;
    /** 单轮扫描解压字节预算覆盖（测试用；缺省 MAX_SCAN_DECOMPRESSED_BYTES_PER_ROUND）。 */
    scanDecompressedBytesPerRound?: number;
    /** 正文缓存字节上限覆盖（测试用；缺省 MAX_CACHE_TOTAL_BYTES）。 */
    bodyCacheMaxBytes?: number;
    /** 解析失败退避基数覆盖（测试用；缺省 FAILED_PARSE_BACKOFF_BASE_MS）。 */
    failureBackoffBaseMs?: number;
  } = {},
): AgentLocalSourceAdapter {
  // DSH_CLI_DIR：测试/多环境隔离入口（对齐 ZCODE_CLI_DIR 惯例）；缺省真实主目录。
  const cliDir = options.cliDir
    ?? process.env.DSH_CLI_DIR
    ?? join(homedir(), ".dsh");
  const sessionsDir = join(cliDir, "sessions");
  const scanBytesPerRound = options.scanDecompressedBytesPerRound
    ?? MAX_SCAN_DECOMPRESSED_BYTES_PER_ROUND;
  const bodyCacheMaxBytes = options.bodyCacheMaxBytes ?? MAX_CACHE_TOTAL_BYTES;
  const failureBackoffBaseMs = options.failureBackoffBaseMs ?? FAILED_PARSE_BACKOFF_BASE_MS;

  /** 正文缓存（LRU：Map 插入序即使用序；命中即重插）；只服务请求/响应重建。 */
  const cache = new Map<string, CacheEntry>();
  let cacheTotalBytes = 0;
  /** 常驻身份/元数据索引：path → 条目。**不参与 LRU 逐出**（修复每轮全量重解压）。 */
  const index = new Map<string, SessionIndexEntry>();
  /** sessionId → path：祖先链解析与按需正文重建用；随索引同步维护。 */
  const indexPathBySessionId = new Map<string, string>();
  /** 本轮扫描积累的身份标注（drainIdentityLinks 排空；经网关的步骤同样记录）。 */
  let pendingIdentityLinks: AgentLocalIdentityLink[] = [];
  /**
   * 最近一轮扫描后的待索引文件数（扫描就绪门控，2026-09-22）：changed/unseen
   * 中未被本轮解析（预算耗尽或解析失败）的数量。初始 Infinity——首次扫描前
   * 不得被误判为收敛。0 = 收敛（本轮范围内可产的标注已全部积累）。
   */
  let lastScanPendingIndexFiles = Number.POSITIVE_INFINITY;
  /**
   * 解析失败退避缓存（path → 连续失败信息；进程内存级，重启后自然重试一轮）。
   * 只约束 scanAndCollect 的周期扫描，不影响 readExchangeDetail 的按需重建。
   */
  const parseFailures = new Map<string, {failedAtMs: number; failCount: number}>();
  const failureBackoffMs = (failCount: number): number =>
    Math.min(failureBackoffBaseMs * 2 ** Math.max(0, failCount - 1), FAILED_PARSE_BACKOFF_MAX_MS);

  const noteUsageBytes = (bytes: number): void => {
    cacheTotalBytes += bytes;
    while (cacheTotalBytes > bodyCacheMaxBytes && cache.size > 1) {
      const oldest = cache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      cacheTotalBytes -= cache.get(oldest)?.bytes ?? 0;
      // 只逐出正文；常驻索引保留，因此逐出不会引发下一轮重新解压。
      cache.delete(oldest);
    }
  };

  const entryOfSession = (sessionId: string): SessionIndexEntry | undefined => {
    const path = indexPathBySessionId.get(sessionId);
    return path === undefined ? undefined : index.get(path);
  };

  const setIndexEntry = (filePath: string, entry: SessionIndexEntry): void => {
    const previous = index.get(filePath);
    if (previous && previous.sessionId !== entry.sessionId
      && indexPathBySessionId.get(previous.sessionId) === filePath) {
      indexPathBySessionId.delete(previous.sessionId);
    }
    index.set(filePath, entry);
    indexPathBySessionId.set(entry.sessionId, filePath);
  };

  /**
   * 解析单个会话文件——**全链路唯一解压入口**。成功后同时写入常驻索引
   * （身份/元数据）与正文 LRU；身份标注由 `scanAndCollect` 在索引建全后统一补齐。
   */
  const parseSessionFileSync = (
    filePath: string,
    fileStat: {mtimeMs: number; size: number},
  ): {bytes: number} | undefined => {
    const decompressed = decompress(readFileSync(filePath));
    if (decompressed.byteLength > MAX_SESSION_DECOMPRESSED_BYTES) return undefined;
    const lines = new TextDecoder().decode(decompressed).split("\n");
    const session: ParsedDshSession = {sessionId: "", createdAt: 0, steps: [], events: []};
    const stepsByIndex = new Map<string, DshStep>();
    let provider: string | undefined;
    let requestModel: string | undefined;
    for (const line of lines) {
      if (!line.trim()) continue;
      let parsedLine: unknown;
      try {
        parsedLine = JSON.parse(line);
      } catch {
        continue;
      }
      const event = asRecord(parsedLine);
      const type = textOf(event.type);
      if (!type) continue;
      if (type === "session") {
        if (event.version !== 3) return undefined;
        session.sessionId = textOf(event.id);
        session.createdAt = numberOf(event.createdAt) ?? 0;
        // 父子层级（2026-09-17 实测：主会话 + depth1 子 + depth2 孙，parentSession
        // 链完整；此前漏解析导致 5 个会话独立成树）。
        session.parentSession = textOf(event.parentSession) || undefined;
        session.origin = textOf(event.origin) || undefined;
        session.delegationDepth = numberOf(event.delegationDepth)
          ?? (session.parentSession ? 1 : 0);
        continue;
      }
      const data = asRecord(event.data);
      const record: DshSessionEvent = {type, data};
      session.events.push(record);

      if (type === "request/context") {
        provider = textOf(data.provider) || provider;
        requestModel = textOf(data.model) || requestModel;
        continue;
      }
      if (type === "step/start") {
        const key = `${numberOf(data.turn) ?? 0}:${numberOf(data.step) ?? 0}`;
        stepsByIndex.set(key, {
          turn: numberOf(data.turn) ?? 0,
          step: numberOf(data.step) ?? 0,
          startedAt: numberOf(event.time) ?? 0,
          completedAt: numberOf(event.time) ?? 0,
          finalized: false,
          ...(provider ? {provider} : {}),
          ...(requestModel ? {requestModel} : {}),
          usage: {},
          blocks: [],
          eventIndex: session.events.length - 1,
        });
        continue;
      }
      if (type === "assistant/message") {
        const step = stepsByIndex.get(`${numberOf(data.turn) ?? 0}:${numberOf(data.step) ?? 0}`);
        if (!step) continue;
        // 重建窗口边界 = 本步 assistant 事件下标：dsh 事件序里 system/user 消息
        // 出现在 step/start 之后、assistant/message 之前（必须包含进请求重建）。
        step.eventIndex = session.events.length - 1;
        const finish = extractFinishInfo(data);
        const message = asRecord(data.message);
        step.blocks = Array.isArray(message.content)
          ? message.content.filter((block): block is Record<string, unknown> => !!block && typeof block === "object")
          : [];
        step.usage = asRecord(data.usage);
        step.completedAt = numberOf(event.time) ?? step.completedAt;
        if (finish.provider) step.provider = finish.provider;
        if (finish.responseId) step.responseId = finish.responseId;
        if (finish.model) step.responseModel = finish.model;
        if (finish.reason) step.finishReason = finish.reason;
        continue;
      }
      if (type === "step/end") {
        const step = stepsByIndex.get(`${numberOf(data.turn) ?? 0}:${numberOf(data.step) ?? 0}`);
        if (!step) continue;
        step.finalized = true;
        step.completedAt = numberOf(event.time) ?? step.completedAt;
        continue;
      }
    }
    if (!session.sessionId) return undefined;
    session.steps = [...stepsByIndex.values()].sort((a, b) => a.turn - b.turn || a.step - b.step);
    setIndexEntry(filePath, {
      mtimeMs: fileStat.mtimeMs,
      size: fileStat.size,
      sessionId: session.sessionId,
      createdAt: session.createdAt,
      ...(session.parentSession ? {parentSession: session.parentSession} : {}),
      ...(session.origin ? {origin: session.origin} : {}),
      ...(session.delegationDepth !== undefined ? {delegationDepth: session.delegationDepth} : {}),
      // 索引只保留步级元数据（blocks 正文留在 LRU 内，逐出不影响标注与候选）。
      steps: session.steps.map(({blocks: _blocks, ...meta}) => meta),
    });
    noteUsageBytes(decompressed.byteLength);
    cache.set(filePath, {mtimeMs: fileStat.mtimeMs, size: fileStat.size, bytes: decompressed.byteLength, session});
    return {bytes: decompressed.byteLength};
  };

  /** 有界目录枚举：workspace 一层 + 会话一层 readdir，mtime 预筛 + 文件数上限。 */
  const listScopedSessionFiles = (floorEpochMs: number): ScopedSessionFile[] => {
    let workspaces;
    try {
      workspaces = readdirSync(sessionsDir, {withFileTypes: true});
    } catch {
      return [];
    }
    const mtimeFloor = floorEpochMs - FILE_MTIME_SAFETY_MARGIN_MS;
    const files: ScopedSessionFile[] = [];
    let scanned = 0;
    for (const workspace of workspaces) {
      if (scanned >= MAX_SESSION_FILES_PER_SCAN) break;
      if (!workspace.isDirectory()) continue;
      let sessionEntries;
      try {
        sessionEntries = readdirSync(join(sessionsDir, workspace.name), {withFileTypes: true});
      } catch {
        continue;
      }
      for (const entry of sessionEntries) {
        if (scanned >= MAX_SESSION_FILES_PER_SCAN) break;
        if (!entry.isDirectory()) continue;
        const path = join(sessionsDir, workspace.name, entry.name, "session.v3.jsonl.zstd");
        try {
          const fileStat = statSync(path);
          if (fileStat.mtimeMs < mtimeFloor) continue;
          scanned += 1;
          files.push({path, mtimeMs: fileStat.mtimeMs, size: fileStat.size});
        } catch {
          continue;
        }
      }
    }
    return files;
  };

  /**
   * 有界同步扫描（2026-09-18 重写）：
   * 1. 已建索引且 mtime/size 未变的文件**零解压**；
   * 2. 已变化文件（活跃会话，标注必须及时）与未建索引文件（冷启动/新会话回补）
   *    按 mtime 倒序解析，最新优先（网关行 90 s 标注窗口最先受益）；
   * 3. 解析受单轮解压字节预算约束（每轮至少尝试一个文件保证前进；解析失败同样
   *    收取预算并进入退避，2026-10-10 修复全部失败轮次的无界重解压），避免一次性
   *    解压整个会话库独占主线程；
   * 4. 标注补齐统一放在**索引建完之后**：文件遍历顺序不再影响祖先链解析
   *    （子会话先于父会话被扫描时也能折到正确的根）。
   */
  const scanAndCollect = (floorEpochMs: number): void => {
    const scoped = listScopedSessionFiles(floorEpochMs);
    if (scoped.length === 0) {
      // 扫描范围内无文件（如 ~/.dsh 尚未创建）：没有可产标注，直接收敛。
      lastScanPendingIndexFiles = 0;
      return;
    }
    const changed: ScopedSessionFile[] = [];
    const unseen: ScopedSessionFile[] = [];
    for (const file of scoped) {
      const entry = index.get(file.path);
      if (entry === undefined) {
        unseen.push(file);
        continue;
      }
      if (entry.mtimeMs !== file.mtimeMs || entry.size !== file.size) changed.push(file);
    }
    const byNewest = (a: ScopedSessionFile, b: ScopedSessionFile): number => b.mtimeMs - a.mtimeMs;
    changed.sort(byNewest);
    unseen.sort(byNewest);
    let budget = scanBytesPerRound;
    let parsedThisRound = 0;
    let attemptedThisRound = 0;
    const nowMs = Date.now();
    for (const file of [...changed, ...unseen]) {
      // 「至少成功一个才检查预算」会让全部失败的轮次无界重解压（2026-10-10 修复）：
      // 改为至少「尝试」一个——失败同样收取预算，预算耗尽即止，剩余文件留待下一轮
      //（退避进一步摊薄重试频率）。
      if (attemptedThisRound > 0 && budget <= 0) break;
      const failure = parseFailures.get(file.path);
      if (failure !== undefined && nowMs - failure.failedAtMs < failureBackoffMs(failure.failCount)) {
        continue;
      }
      let parsed: {bytes: number} | undefined;
      try {
        parsed = parseSessionFileSync(file.path, file);
      } catch {
        parsed = undefined;
      }
      attemptedThisRound += 1;
      // 解析失败不写索引：记录退避后自动重试（损坏/超限文件的重复解压由此从
      // 每轮一次降为退避间隔一次；写入中途被扫到的瞬时失败 8s 后自愈）。
      if (parsed === undefined) {
        parseFailures.set(file.path, {
          failedAtMs: nowMs,
          failCount: (failure?.failCount ?? 0) + 1,
        });
        budget -= FAILED_PARSE_COST_BYTES;
        continue;
      }
      parseFailures.delete(file.path);
      parsedThisRound += 1;
      budget -= parsed.bytes;
    }
    // 待索引余量 = 本轮应处理总量 − 成功解析量（预算耗尽与解析失败都留在余量里）。
    lastScanPendingIndexFiles = changed.length + unseen.length - parsedThisRound;
    // 索引已在手（含本轮未解析但此前已索引的文件）：用完整索引补齐标注，零解压。
    for (const file of scoped) {
      const entry = index.get(file.path);
      if (entry) noteIdentityLinksOfEntry(entry);
    }
  };

  /**
   * 祖先链解析：root = 沿 parentSession 递归到顶。走常驻索引（sessionId → 条目）
   * 而不是遍历正文缓存——原实现每步都要 `[...cache.values()]` 重建数组再线性查找，
   * 是 O(会话数 × 步数) 的分配热点。父未建索引时按父 id 作根（保持原语义：
   * 子会话折入尚未索引的父会话，而不是把子会话当根）。
   */
  const rootSessionIdOf = (sessionId: string): string => {
    const seen = new Set<string>([sessionId]);
    let currentId = sessionId;
    for (;;) {
      const parent = entryOfSession(currentId)?.parentSession;
      if (!parent || seen.has(parent)) return currentId;
      if (!entryOfSession(parent)) return parent;
      seen.add(parent);
      currentId = parent;
    }
  };

  const noteIdentityLink = (entry: SessionIndexEntry, step: IndexedDshStep): void => {
    if (!step.responseId) return;
    const root = rootSessionIdOf(entry.sessionId);
    pendingIdentityLinks.push({
      responseId: step.responseId,
      agentId: "dsh" as AgentId,
      externalSessionId: entry.sessionId,
      ...(entry.parentSession ? {parentExternalSessionId: entry.parentSession} : {}),
      ...(root !== entry.sessionId ? {rootExternalSessionId: root} : {}),
      turnNumber: step.turn,
      stepNumber: step.step,
      delegationDepth: entry.delegationDepth ?? (entry.parentSession ? 1 : 0),
      recordedAt: new Date().toISOString(),
    });
  };

  /** 从常驻索引补齐某会话的全部身份标注（零解压；drain 处按 responseId 幂等去重）。 */
  const noteIdentityLinksOfEntry = (entry: SessionIndexEntry): void => {
    for (const step of entry.steps) noteIdentityLink(entry, step);
  };

  const isGatewayProvider = (provider: string | undefined): boolean =>
    !!provider && ["deepaa-gateway", "llm-inspector-gateway"].some(marker =>
      provider.toLowerCase().includes(marker));

  const normalizeModelId = (modelId: string): string =>
    modelId.trim().toLowerCase().replace(/_deepseek\.com$/u, "");

  /** 按 `sessionId_t<turn>_s<step>` 定位步（走常驻索引，不解压、不遍历正文缓存）。 */
  const findStepByRecordId = (
    recordId: string,
  ): {entry: SessionIndexEntry; step: IndexedDshStep} | undefined => {
    const match = /^(.*)_t(\d+)_s(\d+)$/.exec(recordId);
    if (!match) return undefined;
    const entry = entryOfSession(match[1]!);
    if (!entry) return undefined;
    const turn = Number(match[2]);
    const step = Number(match[3]);
    const found = entry.steps.find(item => item.turn === turn && item.step === step);
    return found ? {entry, step: found} : undefined;
  };

  /**
   * 按需正文重建：优先复用 LRU 中的正文缓存，缺失（被逐出/进程刚启动）时按
   * 常驻索引记录的 mtime/size 重新解析单文件。只在真正的请求/响应重建路径
   * （`readExchangeDetail`，每轮 ≤ 导入批大小）触发，且有界（单会话 ≤ 64 MiB）。
   */
  const hydrateSessionBody = (
    sessionId: string,
  ): ParsedDshSession | undefined => {
    const path = indexPathBySessionId.get(sessionId);
    if (path === undefined) return undefined;
    const entry = index.get(path);
    if (!entry) return undefined;
    const cached = cache.get(path);
    if (cached && cached.mtimeMs === entry.mtimeMs && cached.size === entry.size) {
      // LRU 触达：命中即重插（Map 插入序 = 使用序）。
      cache.delete(path);
      cache.set(path, cached);
      return cached.session;
    }
    let stat: {mtimeMs: number; size: number};
    try {
      const fileStat = statSync(path);
      stat = {mtimeMs: fileStat.mtimeMs, size: fileStat.size};
    } catch {
      return undefined;
    }
    try {
      parseSessionFileSync(path, stat);
    } catch {
      return undefined;
    }
    return cache.get(path)?.session;
  };

  /** 请求体重建（有界事件折叠；v1 语义见设计文档 §1.4「事件折叠重建器」）。 */
  const rebuildRequestRawBody = (
    session: ParsedDshSession,
    target: DshStep,
    modelId: string,
  ): {body: string; toolNames: string[]} => {
    const messages: Array<Record<string, unknown>> = [];
    const toolNames: string[] = [];
    let systemText: string | undefined;
    const events = session.events;
    for (let index = 0; index < target.eventIndex; index += 1) {
      const event = events[index]!;
      const data = event.data;
      if (event.type === "system/message") {
        const message = asRecord(data.message);
        const blocks = Array.isArray(message.content) ? message.content : [];
        const text = blocks.map(block => textOf(asRecord(block).text)).filter(Boolean).join("\n");
        if (text) systemText = text;
        continue;
      }
      if (event.type === "user/message") {
        const blocks = Array.isArray(data.content) ? data.content : [];
        const text = blocks.map(block => textOf(asRecord(block).text)).filter(Boolean).join("\n");
        if (text) messages.push({role: "user", content: text});
        continue;
      }
      if (event.type === "assistant/message") {
        const message = asRecord(data.message);
        const blocks = Array.isArray(message.content) ? message.content : [];
        const text = blocks
          .filter(block => asRecord(block).type === "text")
          .map(block => textOf(asRecord(block).text))
          .filter(Boolean)
          .join("\n");
        // 深度思考历史（reasoning_content）不回放：请求重放以文本与工具动作为准，
        // 推理原文保留在该步响应体中（交互内容响应侧完整可查）。
        messages.push({role: "assistant", content: text});
        continue;
      }
      if (event.type === "tool/call") {
        // 工具调用归属最近一条 assistant 消息（chat wire 的 tool_calls 字段）。
        for (let back = messages.length - 1; back >= 0; back -= 1) {
          if (messages[back]!.role !== "assistant") continue;
          const calls = Array.isArray(messages[back]!.tool_calls)
            ? messages[back]!.tool_calls as unknown[]
            : [];
          calls.push({
            id: textOf(data.callId) || `call_local_${calls.length}`,
            type: "function",
            function: {name: textOf(data.name), arguments: textOf(data.arguments)},
          });
          messages[back]!.tool_calls = calls;
          break;
        }
        continue;
      }
      if (event.type === "tool/result") {
        const message = asRecord(data.message);
        const source = asRecord(message.source);
        const blocks = Array.isArray(message.content) ? message.content : [];
        const text = blocks
          .flatMap(block => {
            const record = asRecord(block);
            const inner = Array.isArray(record.content) ? record.content : [];
            return [textOf(record.text), ...inner.map(part => textOf(asRecord(part).text))];
          })
          .filter(Boolean)
          .join("\n");
        messages.push({role: "tool", tool_call_id: textOf(source.callId), content: text});
        continue;
      }
      if (event.type.startsWith("compaction/")) {
        // 压缩语义逐事件核实前宁可截断重建：历史以压缩点起步（诚实降级，不冒充完整）。
        messages.length = 0;
        systemText = undefined;
        continue;
      }
    }
    // 目标步的工具定义来自 request/header（模型可见工具面）。
    const tools: Array<Record<string, unknown>> = [];
    for (let index = 0; index < target.eventIndex; index += 1) {
      const event = events[index]!;
      if (event.type !== "request/header") continue;
      const header = asRecord(asRecord(event.data).header);
      const config = asRecord(header.config);
      for (const raw of Array.isArray(config.tools) ? config.tools : []) {
        const tool = asRecord(raw);
        if (!textOf(tool.name)) continue;
        toolNames.push(textOf(tool.name));
        tools.push({
          type: "function",
          function: {
            name: textOf(tool.name),
            ...(textOf(tool.description) ? {description: tool.description} : {}),
            ...(tool.parameters !== undefined ? {parameters: tool.parameters} : {}),
          },
        });
      }
      break;
    }
    const body: Record<string, unknown> = {
      model: modelId,
      messages: [
        ...(systemText ? [{role: "system", content: systemText}] : []),
        ...messages,
      ],
      ...(tools.length > 0 ? {tools} : {}),
      stream: false,
    };
    return {body: JSON.stringify(body), toolNames: [...new Set(toolNames)]};
  };

  /** 由正文会话 + 目标步装配交互内容详情（请求体重建 + 响应直映射）。 */
  const buildExchangeDetail = (
    session: ParsedDshSession,
    target: DshStep,
  ): LocalExchangeDetail => {
    const modelId = normalizeModelId(target.responseModel ?? target.requestModel ?? "deepseek-chat");
    const rebuilt = rebuildRequestRawBody(session, target, modelId);
    const blocks = target.blocks;
    const text = blocks
      .filter(block => asRecord(block).type === "text")
      .map(block => textOf(asRecord(block).text))
      .filter(Boolean)
      .join("\n");
    const reasoning = blocks
      .filter(block => asRecord(block).type === "reasoning")
      .map(block => textOf(asRecord(block).text))
      .filter(Boolean)
      .join("\n");
    const toolCalls = blocks
      .filter(block => asRecord(block).type === "tool-call")
      .map(block => ({
        id: textOf(asRecord(block).id) || textOf(asRecord(block).callId) || undefined,
        name: textOf(asRecord(block).name) || undefined,
        input: parseMaybeJson(textOf(asRecord(block).arguments)),
      }));
    return {
      requestRawBody: rebuilt.body,
      requestHeaders: {
        "user-agent": "deepseek-harness/local-import",
        authorization: "Bearer deepaa-gateway",
      },
      response: {
        finishReason: target.finishReason,
        ...(text ? {text} : {}),
        ...(reasoning ? {reasoningText: reasoning} : {}),
        ...(toolCalls.length > 0 ? {toolCalls} : {}),
        usage: {
          inputTokens: numberOf(target.usage.inputTokens) ?? 0,
          outputTokens: numberOf(target.usage.outputTokens) ?? 0,
          totalTokens: numberOf(target.usage.totalTokens),
          cacheReadTokens: numberOf(target.usage.cacheReadTokens),
        },
      },
      ...(target.responseId ? {responseId: target.responseId} : {}),
      toolNames: rebuilt.toolNames,
      skeletonSource: "rollout",
    } satisfies LocalExchangeDetail;
  };

  return {
    agentId: "dsh" as AgentId,
    label: "Dsh（DeepSeek Harness）",
    // 直连导入默认关闭（2026-09-18 用户定稿）：dsh 直连与代理计费同价，代理 wire
    // 捕获数据更完整（工具面/正文/usage 全在 raw）。关直连后本地日志仍照常扫描，
    // 身份标注（responseId→session/turn/step）照常落库供网关行回填原生身份；仅
    // 直连步不再合成 capture、不再入账。后续按用户体验反馈翻回 true 即恢复。
    directImportEnabled: false,

    reportScanStatus(): {pendingIndexFiles: number} {
      return {pendingIndexFiles: lastScanPendingIndexFiles};
    },

    gatewayProviderMarkers: ["deepaa-gateway", "llm-inspector-gateway"],
    // dsh 的 provider 名为用户自定义字符串，无法枚举白名单；准入 = 网关标记排除 +
    // 绑定目标模型白名单（语义等价，见设计文档 §1.4 偏差说明）。
    allowedProviderIds: [],

    officialUpstreamBaseUrl: "https://api.deepseek.com",
    protocolPath: "/v1/chat/completions",
    syntheticWireApi: "chat_completions",
    syntheticTargetFormatHint: "openai",

    normalizeModelId,

    async discover(): Promise<LocalSourceStatus> {
      try {
        readdirSync(sessionsDir);
        return {availability: {state: "available"}, dataDir: sessionsDir};
      } catch {
        return {availability: {state: "missing", reason: "DSH_SESSIONS_MISSING"}, dataDir: sessionsDir};
      }
    },

    readPendingCandidates(floorEpochMs: number, allowedModels: ReadonlySet<string>): PendingImportCandidate[] {
      // 同步契约：本轮内有界同步扫描（未变化文件零解压），并为标注排空补齐。
      scanAndCollect(floorEpochMs);
      const candidates: PendingImportCandidate[] = [];
      const sessionActivity = new Map<string, number>();
      // 候选枚举读常驻索引：正文被 LRU 逐出也不影响候选完整性（此前会丢）。
      for (const entry of index.values()) {
        let latest = 0;
        for (const step of entry.steps) {
          if (step.completedAt > latest) latest = step.completedAt;
          if (!step.finalized) continue;
          if (step.completedAt < floorEpochMs) continue;
          // 经网关的步骤不导入（权威记录在网关 raw，身份经标注回填）；仅官方直连进候选。
          if (isGatewayProvider(step.provider)) continue;
          const rawModel = step.responseModel ?? step.requestModel ?? "";
          const model = normalizeModelId(rawModel);
          if (!model || !allowedModels.has(model)) continue;
          candidates.push({
            id: `${entry.sessionId}_t${step.turn}_s${step.step}`,
            sessionId: entry.sessionId,
            completedAt: step.completedAt,
            modelId: model,
          });
        }
        if (latest > 0) sessionActivity.set(entry.sessionId, latest);
      }
      // session 按最新活动倒序（用户最先看到最新会话），同 session 按完成正序。
      candidates.sort((a, b) => {
        const sessionOrder = (sessionActivity.get(b.sessionId) ?? 0) - (sessionActivity.get(a.sessionId) ?? 0);
        if (sessionOrder !== 0) return sessionOrder;
        return a.completedAt - b.completedAt;
      });
      return candidates;
    },

    hydrateUsageRecords(ids: readonly string[]): LocalUsageBatch {
      const records: LocalUsageRecord[] = [];
      for (const id of ids) {
        const found = findStepByRecordId(id);
        if (!found) continue;
        const {entry, step} = found;
        const root = rootSessionIdOf(entry.sessionId);
        records.push({
          id,
          attemptIndex: 0,
          providerId: step.provider ?? "deepseek",
          modelId: normalizeModelId(step.responseModel ?? step.requestModel ?? ""),
          status: "completed",
          startedAt: step.startedAt,
          completedAt: step.completedAt,
          durationMs: Math.max(0, step.completedAt - step.startedAt),
          finishReason: step.finishReason,
          usage: {
            inputTokens: numberOf(step.usage.inputTokens) ?? 0,
            outputTokens: numberOf(step.usage.outputTokens) ?? 0,
            reasoningTokens: 0,
            cacheCreationTokens: 0,
            cacheReadTokens: numberOf(step.usage.cacheReadTokens) ?? 0,
          },
          sessionId: entry.sessionId,
          ...(root !== entry.sessionId ? {rootSessionId: root} : {}),
          ...(entry.parentSession ? {traceId: entry.parentSession} : {}),
          turnId: String(step.turn),
          stepNumber: step.step,
          detailRef: {
            // 定位键优先级：responseId（有 replayState 的 provider）→ turn+step 精确
            // （官方直连 provider 不写 replayState；只按 turn 会命中首步导致整会话
            // 重建错位——2026-09-17 实测）。
            ...(step.responseId ? {requestId: step.responseId} : {}),
            sessionId: entry.sessionId,
            turnId: String(step.turn),
            stepNumber: step.step,
            startedAt: step.startedAt,
          },
        });
      }
      return {records};
    },

    async readExchangeDetail(ref: LocalExchangeRef): Promise<LocalExchangeDetail | undefined> {
      // 正文（events + blocks）不在常驻索引内：这里按需从索引定位到文件后重建，
      // 因此正文 LRU 逐出不会造成"详情永远拿不到"，也不会引发整库重解压。
      const session = hydrateSessionBody(ref.sessionId);
      if (session) {
        // 定位优先级：responseId（requestId，确定性）> turn 序号。
        const target = (ref.requestId
          ? session.steps.find(step => step.responseId === ref.requestId)
          : undefined)
          ?? (ref.turnId !== undefined
            ? session.steps.find(step =>
              String(step.turn) === ref.turnId
              && (ref.stepNumber === undefined || step.step === ref.stepNumber))
            : undefined);
        if (target) return buildExchangeDetail(session, target);
      }
      return undefined;
    },

    async readSessionTimeline(): Promise<undefined> {
      // dsh 走 adapter 内建折叠（readExchangeDetail 完整重建请求+响应），无需
      // zcode 式 message/part 时间线回放。
      return undefined;
    },

    assembleChatResponseRawBody(record, detail, modelId): string {
      const response = detail?.response;
      const toolCalls = (response?.toolCalls ?? []).map((call, index) => ({
        id: call.id ?? `call_local_${record.id}_${index}`,
        type: "function",
        function: {name: call.name ?? "unknown", arguments: JSON.stringify(call.input ?? {})},
      }));
      const message: Record<string, unknown> = {
        role: "assistant",
        content: response?.text ?? "",
        ...(response?.reasoningText ? {reasoning_content: response.reasoningText} : {}),
        ...(toolCalls.length > 0 ? {tool_calls: toolCalls} : {}),
      };
      const body = {
        id: detail?.responseId ?? `chatcmpl_local_${record.id}`,
        object: "chat.completion",
        created: Math.floor(record.startedAt / 1000),
        model: modelId,
        choices: [{
          index: 0,
          message,
          finish_reason: record.status === "cancelled" ? "stop" : mapDshFinishReason(record.finishReason),
        }],
        usage: {
          // usage 恒以客户端自报权威值为准；deepseek 缓存口径（hit/miss 分列）。
          prompt_tokens: record.usage.inputTokens,
          completion_tokens: record.usage.outputTokens,
          total_tokens: record.usage.inputTokens + record.usage.outputTokens,
          prompt_cache_hit_tokens: record.usage.cacheReadTokens,
          prompt_cache_miss_tokens: Math.max(0, record.usage.inputTokens - record.usage.cacheReadTokens),
        },
      };
      return JSON.stringify(body);
    },

    buildSyntheticRequestHeaders(record) {
      // 认证头只允许占位值（与网关 raw「只记占位」语义一致；本地数据本就无真实密钥）。
      // 身份语义（与网关行身份标注覆写完全同构）：
      // - x-session-id = 顶层祖先（root）→ 子代理会话折入主会话（Session 折叠）；
      // - x-dsh-thread-id = 自身 UUID（非 root 时作子 Thread 挂 root 根下）；
      // - x-dsh-turn-id = 原生 Turn 键（session:turn:N，Turn 边界精确分轮——
      //   官方直连 provider 无 replayState/responseId 时差分是唯一兜底，此头消陔回退）；
      // - x-dsh-step-id = 原生 Step 键（session:step:N），物化 agent_steps.native_step_id。
      const root = record.rootSessionId ?? record.sessionId;
      return {
        "user-agent": "deepseek-harness/local-import",
        authorization: "Bearer deepaa-gateway",
        "x-session-id": root,
        ...(record.rootSessionId ? {"x-dsh-thread-id": record.sessionId} : {}),
        ...(record.turnId !== undefined
          ? {"x-dsh-turn-id": `${record.sessionId}:turn:${record.turnId}`}
          : {}),
        ...(record.stepNumber !== undefined
          ? {"x-dsh-step-id": `${record.sessionId}:step:${record.stepNumber}`}
          : {}),
      };
    },

    drainIdentityLinks(): readonly AgentLocalIdentityLink[] {
      const drained = pendingIdentityLinks;
      pendingIdentityLinks = [];
      const seen = new Set<string>();
      return drained.filter(link => {
        if (seen.has(link.responseId)) return false;
        seen.add(link.responseId);
        return true;
      });
    },
  };
}
