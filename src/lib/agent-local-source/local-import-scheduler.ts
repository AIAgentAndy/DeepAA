/**
 * 本地导入调度器（双链路观测通道 B 编排，用户定案 D-5）：5 秒自动定时、单飞防重入、
 * 单轮 LIMIT 15、满载续批（积压自动加速）、回看上限 30 天（floor，游标落后超窗即重置）。
 * 无任何手动触发。规律与代理捕获一致：completed_at keyset ASC 顺序尾追，无积压时
 * 每轮读到的就是最新数据。正文与 usage 同轮趁热读取（rollout 短命，晚到即缺）。
 */

import type {DeepaaDatabase} from "@/lib/db/sqlite-driver";
import {openDeepaaDatabase} from "@/lib/db/connection";
import type {AgentId} from "@/types";
import type {AgentLocalSourceAdapter, LocalExchangeDetail} from "./types";
import {resolveLocalImportBinding, type LocalImportBinding} from "./binding";
import {
  buildRebuiltRequestBody,
  extractResponseParts,
  indexTimeline,
  rebuildExchangeFromTimeline,
  type RebuiltExchange,
  type TimelineIndex,
} from "./parts-rebuilder";
import {buildSyntheticExchange, ImportCaptureFileWriter, materializeLargeBodies} from "./synthetic-capture";
import {BoundedLruMap} from "./bounded-lru";
import {
  extractPromptSkeleton,
  loadLatestPromptSkeleton,
  recordPromptSkeleton,
} from "./prompt-skeleton";
import {readImportState, pruneAgentLocalImportSeen, updateImportState} from "./state-store";
import {isAgentLocalIdentityAgent, upsertAgentLocalIdentityLinks} from "./identity-links";
import {markAgentScanConverged, markAgentScanStarted} from "./scan-readiness";
import {AGENT_LOCAL_SOURCE_ADAPTERS} from "./registry";
import type {LocalUsageRecord, PendingImportCandidate} from "./types";

/**
 * 扫描节奏 2 秒（2026-09-22 用户定案，取代 2026-09-15 的 5 秒）：网关捕获侧
 * worker 空闲轮询 1s 即派生，身份标注侧此前 5s 节拍系统性慢于网关——提速到 2s
 * 后 dsh 网关行的身份等待窗口收敛到 2~5s（配合 worker 顺延机制零错误码消化）。
 * 单轮 15 条、回看 30 天不变；稳态扫描 ~10-50ms/轮，解压预算按轮上限不随频率
 * 放大（回补反而被摊得更细）。
 */
export const LOCAL_IMPORT_INTERVAL_MS = 2_000;
export const LOCAL_IMPORT_BATCH_LIMIT = 15;
/**
 * 会话上下文缓存字节上限（2026-10-10 用户确认）：timeline（zcode 全消息索引）与
 * 请求骨架体按会话有界保留、超限逐出最久未用——此前无淘汰的无限保留在 web 进程
 * 堆上限（768M）下会成为 OOM 引信。逐出后走既有降级：timeline 按需重读
 * （readSessionTimeline，每批每会话至多一次）、骨架回退 SQLite prompt-skeleton
 * 库（loadLatestPromptSkeleton 的「borrowed」路径），业务语义不变。
 */
const SESSION_CONTEXT_CACHE_MAX_BYTES = 32 * 1024 * 1024;
export {LOCAL_IMPORT_LOOKBACK_DAYS} from "./windows";
import {LOCAL_IMPORT_LOOKBACK_DAYS_MS} from "./windows";
/** 满载续批的安全上限：防异常数据源导致单次调度无限循环。 */
const MAX_CONTINUOUS_BATCHES = 200;
/**
 * 终态闸门等待窗（2026-09-17 引入，2026-09-22 改为按时间计量）：本地消息尚未
 * 终态（parts 未写完）时本轮不导入、不写 seen，下一轮重试；超过该时间窗才按
 * 降级导入并写诊断，避免异常数据源把候选批次永久堵死。原实现按轮次计数
 * （6 轮 × 5s = 30s）；节拍 5s→2s 后若仍按轮次，等待窗会静默缩水到 12s，
 * 让长消息提前降级——改为时间窗后与节拍解耦，任何节拍下语义不变。
 */
const MAX_FINALITY_WAIT_MS = 30_000;

/**
 * 会话上下文缓存：timeline 快照 + 最近一次读到的请求骨架。
 * 骨架来源必须可追溯（rollout 自带 / 会话缓存借用），页面据此如实标注。
 */
interface SessionContextCache {
  timeline?: TimelineIndex;
  skeletonBody?: string;
  promptSha256?: string;
  skeletonSource?: "rollout" | "borrowed";
}

interface SchedulerGlobal {
  __deepaaAgentLocalImportScheduler?: AgentLocalImportScheduler;
}

export interface AgentLocalImportScheduler {
  stop(): Promise<void>;
}

export function startAgentLocalImportScheduler(options: {dataDir: string}): AgentLocalImportScheduler {
  const globalState = globalThis as SchedulerGlobal;
  if (globalState.__deepaaAgentLocalImportScheduler) {
    return globalState.__deepaaAgentLocalImportScheduler;
  }
  const writers = new Map<string, ImportCaptureFileWriter>();
  // session 上下文缓存：timeline 每会话只读一次（命中 O(1) 复用）、skeleton 保留
  // 最近一份 rollout body（system/tools 骨架），正文源缺失时降级使用——字节预算
  // 有界（2026-10-10），逐出走 timeline 重读 / SQLite 骨架兜底。
  const sessionCaches = createSessionCacheStore(SESSION_CONTEXT_CACHE_MAX_BYTES);
  /** 终态闸门首延时刻（exchangeId → 首次延迟时的 nowMs），成功导入后清理。 */
  const finalityDeferrals = new Map<string, number>();
  let stopped = false;
  let inFlight = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // 扫描就绪门控（2026-09-22）入口置位：身份标注型 Agent 的「已启动」信号必须在
  // 首轮 tick 之前落位——instrumentation 中 Worker 先于本调度器启动，等首轮 tick
  // 再置位会留下窗口让 Worker 把宕机期的旧网关行先派生掉。未绑定/数据不可用导致
  // 的「永不收敛」由熔断窗（AGENT_SCAN_CONVERGENCE_MAX_WAIT_MS）兜底。
  for (const adapter of AGENT_LOCAL_SOURCE_ADAPTERS) {
    if (isAgentLocalIdentityAgent(adapter.agentId)) {
      markAgentScanStarted(adapter.agentId);
    }
  }
  const tick = async (): Promise<void> => {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      await runAgentLocalImportRound({
        dataDir: options.dataDir,
        writers,
        sessionCaches,
        finalityDeferrals,
      });
    } finally {
      inFlight = false;
    }
    if (!stopped) {
      timer = setTimeout(() => void tick(), LOCAL_IMPORT_INTERVAL_MS);
    }
  };
  void tick();
  const scheduler: AgentLocalImportScheduler = {
    stop: async () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
  globalState.__deepaaAgentLocalImportScheduler = scheduler;
  return scheduler;
}

/**
 * 执行一轮完整导入（全部适配器）：满载续批直到单批不足 LIMIT 或达安全上限。
 * 独立导出供测试与手动诊断复用；定时器路径同样经由本函数。
 */
export async function runAgentLocalImportRound(options: {
  dataDir: string;
  /** 时钟注入（测试）；缺省系统时间。 */
  nowMs?: number;
  writers?: Map<string, ImportCaptureFileWriter>;
  sessionCaches?: SessionCacheStore;
  /** 会话上下文缓存字节上限覆盖（测试用；缺省 SESSION_CONTEXT_CACHE_MAX_BYTES）。 */
  sessionCacheMaxBytes?: number;
  /** 终态闸门首延时刻（跨轮持久，成功导入后清理）。 */
  finalityDeferrals?: Map<string, number>;
}): Promise<number> {
  const writers = options.writers ?? new Map<string, ImportCaptureFileWriter>();
  const sessionCaches = options.sessionCaches
    ?? createSessionCacheStore(options.sessionCacheMaxBytes ?? SESSION_CONTEXT_CACHE_MAX_BYTES);
  const finalityDeferrals = options.finalityDeferrals ?? new Map<string, number>();
  /** 单 tick 回填限流账本（B 修复）：agentId → 本轮已导入批次数；随轮次创建即重置。 */
  const backfillBudgets = new Map<AgentId, number>();
  let totalImported = 0;
  for (let batch = 0; batch < MAX_CONTINUOUS_BATCHES; batch += 1) {
    const processed = await runOneBatchRound({
      dataDir: options.dataDir,
      writers,
      sessionCaches,
      finalityDeferrals,
      nowMs: options.nowMs ?? Date.now(),
      backfillBudgets,
    });
    totalImported += processed;
    if (processed < LOCAL_IMPORT_BATCH_LIMIT) break;
  }
  return totalImported;
}

/** 终态判定：响应与上下文都必须是最终状态。 */
function isRebuildFinal(rebuilt: RebuiltExchange): boolean {
  return rebuilt.responseFinalized && rebuilt.contextFinalized;
}

/** 会话上下文缓存存储（结构接口）：生产实现为字节预算有界 LRU，测试可注入裸 Map。 */
interface SessionCacheStore {
  get(key: string): SessionContextCache | undefined;
  set(key: string, value: SessionContextCache): unknown;
}

/** 会话上下文近似字节成本（×2 覆盖双字节字符串，宁可高估）：timeline parts + 骨架体。 */
function estimateSessionContextBytes(cache: SessionContextCache): number {
  let total = 128;
  if (cache.skeletonBody !== undefined) total += cache.skeletonBody.length * 2;
  const timeline = cache.timeline;
  if (timeline !== undefined) {
    for (const message of timeline.order) {
      total += 64;
      for (const part of message.parts) {
        total += 64;
        if (part.text !== undefined) total += part.text.length * 2;
        if (part.toolOutput !== undefined) total += part.toolOutput.length * 2;
        if (part.reason !== undefined) total += part.reason.length * 2;
      }
    }
  }
  return total;
}

function createSessionCacheStore(maxBytes: number): SessionCacheStore {
  return new BoundedLruMap<string, SessionContextCache>({
    maxBytes,
    bytesOf: estimateSessionContextBytes,
  });
}

/**
 * 骨架清扫：每个涉及到的 session 只做一次尾部窗口读取，把窗口内全部记录的
 * system/tools 落库（含已导入与尚未导入的记录），使骨架不再依赖窗口时序。
 */
async function harvestPromptSkeletons(
  db: DeepaaDatabase,
  adapter: AgentLocalSourceAdapter,
  records: readonly LocalUsageRecord[],
  rolloutCache?: unknown,
): Promise<void> {
  if (!adapter.readRecentRecords) return;
  const sessions = new Set(records.map(record => record.sessionId));
  for (const sessionId of sessions) {
    try {
      const recent = await adapter.readRecentRecords(sessionId, rolloutCache);
      for (const detail of recent) {
        const skeleton = extractPromptSkeleton(detail.requestRawBody);
        if (!skeleton) continue;
        recordPromptSkeleton(db, {
          agentId: adapter.agentId,
          sessionId,
          promptSha256: skeleton.promptSha256,
          bodyJson: skeleton.bodyJson,
          toolCount: skeleton.toolCount,
        });
      }
    } catch {
      // 清扫是尽力而为：失败绝不影响本批导入。
    }
  }
}

async function runOneBatchRound(options: {
  dataDir: string;
  writers: Map<string, ImportCaptureFileWriter>;
  sessionCaches: SessionCacheStore;
  finalityDeferrals: Map<string, number>;
  nowMs: number;
  /** 单 tick 回填限流账本（B 修复；测试直调可省略 = 不限流）。 */
  backfillBudgets?: Map<AgentId, number>;
}): Promise<number> {
  const {dataDir, writers, sessionCaches, finalityDeferrals, nowMs, backfillBudgets} = options;
  /** 本批内已强制重载过 timeline 的 session（有界重载：每批每 session 至多一次）。 */
  const reloadedSessions = new Set<string>();
  // 全部适配器按注册表轮询；当前注册 zcode。disabled 的适配器跳过（不记失败）。
  let totalImported = 0;
  for (const adapter of AGENT_LOCAL_SOURCE_ADAPTERS) {
    // 插件式回填限流（2026-10-10 B）：声明 backfillBatchesPerTick 的适配器单 tick
    // 最多导入 N 批——codex 的正文重析/上下文回放单条可达 MB 级字符串，限速使垃圾
    // 产出回到 GC 舒适区。未声明的适配器（zcode/dsh）行为零变化（不限流）。
    const backfillCap = adapter.backfillBatchesPerTick;
    if (backfillCap !== undefined
      && (backfillBudgets?.get(adapter.agentId) ?? 0) >= backfillCap) {
      continue;
    }
    const startedAt = Date.now();
    let db: DeepaaDatabase | undefined;
    try {
      const bindingStatus = await resolveLocalImportBinding(dataDir, adapter.agentId);
      if (bindingStatus.state !== "bound") continue;
      const binding: LocalImportBinding = bindingStatus.binding;
      const status = await adapter.discover();
      if (status.availability.state !== "available") continue;
      db = openDeepaaDatabase({dataDir});
      // 导入下界 = max(最近 30 天, 供应商创建时刻)——供应商建立之前的请求无归因意义
      // （2026-09-16 用户确认）。candidates 与回补收尾均受此下界约束。
      const floor = Math.max(nowMs - LOCAL_IMPORT_LOOKBACK_DAYS_MS, binding.floorEpochMs);
      // 待导入队列（2026-09-16 用户确认最终语义）：
      // 候选 = 30 天窗口内白名单 provider + 已配置模型面的未导入行。**反联本库已导入
      // 集合即游标**——天然幂等（重复候选不存在）、无遗漏（窗口内全部枚举）、无重复
      // （exchangeId 确定性 + 反联排除）；顺序 = session 按最新活动倒序（用户最先看到
      // 最新会话），同 session 内按完成时间正序（步骤号/标签/差分的派生序依赖，用户确认）。
      // 模型不在供应商配置面的行在候选查询即排除（账本口径 = 用户显式配置的模型面）。
      //
      // D2 下推（2026-10-05 用户确认）：实现 readPendingBatch 的适配器把「seen 反联 +
      // 目标顺序 + LIMIT」整体下推到 SQL 引擎执行，JS 侧只见 ≤15 行——取代旧路径的
      // 「全量候选物化 + seen 全表 JS Set 过滤」（实测稳态每轮物化数万行、随历史线性
      // 放大）。候选集、顺序、幂等语义与旧路径完全一致；未实现该方法的适配器（如
      // dsh，其候选枚举走自有内存索引）继续走旧路径，行为不变（渐进迁移）。
      const seenPrefix = `import-${adapter.agentId}-`;
      let batchRecords: PendingImportCandidate[];
      let pendingRemaining: number;
      if (typeof adapter.readPendingBatch === "function") {
        const pushed = adapter.readPendingBatch({
          dataDir,
          floorEpochMs: floor,
          allowedModels: binding.allowedModels,
          seenExchangeIdPrefix: seenPrefix,
          limit: LOCAL_IMPORT_BATCH_LIMIT,
        });
        batchRecords = pushed.records;
        // 满批 = 可能仍有剩余（保守非零，pendingSettled 保持 false）；恰好整除的
        // 边界由下一轮空批收尾——可观测标记允许一轮延迟，不参与业务判断。
        pendingRemaining = pushed.records.length >= LOCAL_IMPORT_BATCH_LIMIT ? LOCAL_IMPORT_BATCH_LIMIT : 0;
      } else {
        // 反联 seen 表（导入即写，先于派生）——杜绝「导入与派生之间窗口内重复重写」。
        const seenRows = db.prepare(
          "SELECT exchange_id FROM agent_local_import_seen",
        ).all() as Array<{exchange_id: string}>;
        const seenIds = new Set(seenRows.map(row =>
          row.exchange_id.startsWith(seenPrefix)
            ? row.exchange_id.slice(seenPrefix.length)
            : row.exchange_id));
        const pending = adapter
          .readPendingCandidates(floor, binding.allowedModels)
          .filter(candidate => !seenIds.has(candidate.id));
        batchRecords = pending.slice(0, LOCAL_IMPORT_BATCH_LIMIT);
        pendingRemaining = Math.max(0, pending.length - batchRecords.length);
      }
      // dsh 双链路（2026-09-17）：候选扫描同时积累原生身份标注（含经网关的步骤），
      // 先于导入落库——网关行的派生即可用 responseId 精确回填 session/turn/step。
      const identityLinks = adapter.drainIdentityLinks?.() ?? [];
      if (identityLinks.length > 0) {
        upsertAgentLocalIdentityLinks(db, identityLinks);
      }
      // 扫描就绪门控（2026-09-22）：本轮扫描后无剩余待索引文件即置收敛——派生侧
      // 旧行的等待到此为止（此后 miss 即真缺失，按现状诚实降级）。收敛 sticky；
      // 持续解析失败等「永不收敛」场景由熔断窗兜底。
      if (isAgentLocalIdentityAgent(adapter.agentId) && adapter.reportScanStatus) {
        if (adapter.reportScanStatus().pendingIndexFiles <= 0) {
          markAgentScanConverged(adapter.agentId);
        }
      }
      // 直连导入开关（2026-09-18 插件级常量，用户定稿）：缺省不支持直连——仅当
      // 适配器显式声明 directImportEnabled === true 时才合成 capture/入账（如 zcode
      // 的直连权益）；未声明或 false = 仅身份标注模式，上方扫描与标注照常执行，
      // 直连步不合成 capture、不入账。标注排空必须先于本过滤。
      if (adapter.directImportEnabled !== true) {
        // 仅身份标注模式也必须记录本轮结果（2026-09-18 修复）：扫描与标注照常
        // 执行、成本照常发生，若在此直接 continue 就跳过了下方的 updateImportState，
        // 该 Agent 的 last_success_at / last_run_duration_ms 会永久停在上一版本
        // 进程的最后一次导入时刻——2026-09-18 实测 dsh 每轮同步扫描阻塞主线程
        // 20 s+ 却完全不可见。这里只记录「本轮已执行 + 耗时」，不推进任何游标。
        updateImportState(db, {
          agentId: adapter.agentId,
          // 直连导入关闭时没有"待导入队列"概念，settled 语义不适用（保持未收尾）。
          pendingSettled: false,
          localSchemaVersion: status.localSchemaVersion,
          outcome: "success",
          importedCountDelta: 0,
          runDurationMs: Date.now() - startedAt,
          // 仅身份标注模式不导入任何记录：runCount 保持 0，标注条数只作诊断口径，
          // 不冒充"最近一轮导入 N 条"（UI 展示耗时用于暴露扫描成本）。
          runCount: 0,
        });
        continue;
      }
      const batch = {records: batchRecords};
      const accepted: LocalUsageRecord[] = adapter.hydrateUsageRecords(
        batch.records.map(record => record.id),
      ).records;
      if (accepted.length > 0) {
        // D3 批内尾窗去重（2026-10-05 用户确认）：骨架清扫与逐条正文读取共享同一份
        // rollout 尾窗（此前骨架 1 次 + 每条记录各 1 次 ≤32MiB 尾读，一批 15 条 =
        // 16 次读 + 重复逐行解析）。缓存生命周期 = 本批；未实现 createRolloutCache
        // 的适配器不受影响（每次独立读取）。
        const rolloutCache = adapter.createRolloutCache?.();
        // 骨架清扫（2026-09-17）：对涉及到的 session 各做一次尾部窗口读取，把窗口内
        // 全部记录的 system/tools 落库。即便这些记录已导入或尚未导入，骨架都能在
        // rollout 被清理/滚动后复用——不依赖任何客户端设置。
        await harvestPromptSkeletons(db, adapter, accepted, rolloutCache);
        let writer = writers.get(adapter.agentId);
        if (!writer) {
          writer = new ImportCaptureFileWriter(dataDir, adapter.agentId);
          writers.set(adapter.agentId, writer);
        }
        const exchanges = [];
        for (const record of accepted) {
          const modelId = adapter.normalizeModelId(record.modelId);
          const cacheKey = record.sessionId;
          const cache = sessionCaches.get(cacheKey) ?? {};
          const detail = record.detailRef ? await adapter.readExchangeDetail(record.detailRef, rolloutCache) : undefined;
          // rollout 自带骨架优先；缺失则借用本会话最近一次成功读到的骨架。
          let skeletonSource: "rollout" | "borrowed" | "none" = "none";
          if (detail?.requestRawBody !== undefined) {
            const skeleton = extractPromptSkeleton(detail.requestRawBody);
            if (skeleton) {
              cache.skeletonBody = detail.requestRawBody;
              cache.promptSha256 = skeleton.promptSha256;
              cache.skeletonSource = "rollout";
              skeletonSource = "rollout";
              recordPromptSkeleton(db, {
                agentId: adapter.agentId,
                sessionId: cacheKey,
                promptSha256: skeleton.promptSha256,
                bodyJson: skeleton.bodyJson,
                toolCount: skeleton.toolCount,
                ...(record.modelId !== undefined ? {modelId} : {}),
              });
            }
          }
          if (skeletonSource === "none") {
            const stored = loadLatestPromptSkeleton(db, adapter.agentId, cacheKey);
            if (stored) {
              cache.skeletonBody = stored.bodyJson;
              cache.promptSha256 = stored.promptSha256;
              cache.skeletonSource = "borrowed";
              skeletonSource = "borrowed";
            }
          }
          // 完整上下文重建（优先路径）：timeline 就绪且能定位目标响应消息时，
          // 请求体 = provider-visible 全序列回放；响应 = assistant parts 直映射。
          let rebuiltBody: string | undefined;
          let responseOverride: LocalExchangeDetail["response"] | undefined = undefined;
          if (record.assistantMessageId) {
            const attemptRebuild = () => cache.timeline
              ? rebuildExchangeFromTimeline(cache.timeline, record.assistantMessageId!)
              : undefined;
            let rebuilt = attemptRebuild();
            // 重建未命中（缓存过期）或目标/上下文尚未终态（parts 还在写）都必须
            // 强制重载一次：zcode 的 model_usage.completed_at 早于 parts 落库
            // （实测 -4ms ~ -8.6s），拿旧快照合成会得到空正文。
            if ((rebuilt === undefined || !isRebuildFinal(rebuilt)) && !reloadedSessions.has(cacheKey)) {
              reloadedSessions.add(cacheKey);
              const fresh = await adapter.readSessionTimeline(record.sessionId);
              cache.timeline = fresh ? indexTimeline(fresh) : undefined;
              rebuilt = attemptRebuild();
            }
            if (rebuilt && !isRebuildFinal(rebuilt)) {
              // 终态闸门：本轮不导入、不写 seen，下一轮重试；超过时间窗才降级导入。
              const firstDeferredMs = finalityDeferrals.get(record.id) ?? nowMs;
              finalityDeferrals.set(record.id, firstDeferredMs);
              if (nowMs - firstDeferredMs <= MAX_FINALITY_WAIT_MS) {
                sessionCaches.set(cacheKey, cache);
                continue;
              }
            }
            if (rebuilt) {
              rebuiltBody = buildRebuiltRequestBody(cache.skeletonBody, rebuilt, modelId);
              responseOverride = extractResponseParts(rebuilt);
            }
            sessionCaches.set(cacheKey, cache);
          } else {
            sessionCaches.set(cacheKey, cache);
          }
          const effectiveDetail = detail ?? (record.userText || rebuiltBody ? {
            ...(rebuiltBody !== undefined ? {requestRawBody: rebuiltBody} : {}),
            ...(responseOverride !== undefined ? {response: responseOverride} : {}),
          } : undefined);
          if (rebuiltBody !== undefined && effectiveDetail) {
            effectiveDetail.requestRawBody = rebuiltBody;
            if (responseOverride !== undefined) effectiveDetail.response = responseOverride;
          }
          if (effectiveDetail && skeletonSource !== "none") {
            effectiveDetail.skeletonSource = skeletonSource;
          }
          exchanges.push(buildSyntheticExchange({
            agentId: adapter.agentId,
            record,
            modelId,
            target: {
              id: binding.targetId,
              name: binding.targetName,
              ...(binding.defaultCredentialId ? {defaultCredentialId: binding.defaultCredentialId} : {}),
            },
            adapter,
            detail: effectiveDetail,
          }));
          finalityDeferrals.delete(record.id);
        }
        // 反向兜底（防标记漏判）：合成前按 responseId 反查网关捕获（captured_at
        // ±15s 有界窗口 + providerItemId 精确匹配），命中即跳过并照常记 seen。
        const gatewayCollision = db.prepare(
          `SELECT r.exchange_id FROM raw_exchange_refs r
           JOIN exchange_content_previews p ON p.exchange_id = r.exchange_id
           WHERE r.agent_name = ? AND r.origin = 'gateway'
             AND r.captured_at BETWEEN ? AND ?
             AND EXISTS (SELECT 1 FROM json_each(p.preview_json, '$.conversationItems') it
                         WHERE json_extract(it.value, '$.providerItemId') = ?)
           LIMIT 1`,
        );
        const markSeen = db.prepare(
          "INSERT INTO agent_local_import_seen(exchange_id, imported_at) VALUES(?, ?) ON CONFLICT(exchange_id) DO NOTHING",
        );
        const filteredExchanges = [];
        for (const exchange of exchanges) {
          let responseId: string | undefined;
          try {
            responseId = exchange.response.rawBody
              ? ((JSON.parse(exchange.response.rawBody) as Record<string, unknown>).id as string | undefined)
              : undefined;
          } catch {
            responseId = undefined;
          }
          if (responseId) {
            const capturedMs = Date.parse(exchange.capturedAt);
            const hit = gatewayCollision.get(
              adapter.agentId,
              new Date(capturedMs - 15_000).toISOString(),
              new Date(capturedMs + 15_000).toISOString(),
              responseId,
            ) as {exchange_id: string} | undefined;
            if (hit) {
              markSeen.run(exchange.exchangeId, new Date().toISOString());
              continue;
            }
          }
          filteredExchanges.push(exchange);
        }
        // 顺序红线（2026-09-21 修复）：必须先外置大正文、再落盘。此前顺序相反，
        // 导致行内保留完整明文 rawBody、blob 又写了一份（无人引用的孤儿），双重
        // 存储把 captures 与 blobs 同时撑大。外置后行内只留 rawBodyRef，登记为
        // external-blob，blob 生命周期随 raw 清理正常回收。
        await materializeLargeBodies(dataDir, filteredExchanges);
        await writer.appendBatch(filteredExchanges);
        for (const exchange of filteredExchanges) markSeen.run(exchange.exchangeId, new Date().toISOString());
        totalImported += filteredExchanges.length;
      }
      // 本适配器实际消费了一批候选即计入限流账本（含全部被网关碰撞过滤的情形——
      // 详情重建工作照常发生，垃圾产出同样发生）。
      if (backfillCap !== undefined && batchRecords.length > 0 && backfillBudgets) {
        backfillBudgets.set(adapter.agentId, (backfillBudgets.get(adapter.agentId) ?? 0) + 1);
      }
      // pendingSettled（可观测标记）：pendingRemaining === 0 = 本轮批未取满 → 窗口内
      // 已无待导入候选（满批时保守保持 false；恰好整除的边界由下一轮空批收尾，
      // 允许一轮延迟——不参与业务判断，新行到达自动清除）。
      updateImportState(db, {
        agentId: adapter.agentId,
        pendingSettled: pendingRemaining === 0,
        outcome: "success",
        localSchemaVersion: status.localSchemaVersion,
        importedCountDelta: accepted.length,
        runDurationMs: Date.now() - startedAt,
        runCount: accepted.length,
      });
      // seen 表有界清理（D2）：只删早于「回看窗口 + 5 天余量」的行（单次 ≤1000），
      // 被删行对应候选必然已出窗、不可能重新成为候选，幂等不受影响。仅在收敛后的
      // 空闲轮（批未满）执行——追赶期跳过，不打断满载续批。
      if (pendingRemaining === 0) {
        pruneAgentLocalImportSeen(db, {nowMs});
      }
    } catch (error) {
      try {
        db = db ?? openDeepaaDatabase({dataDir});
        updateImportState(db, {
          agentId: adapter.agentId,
          outcome: "failure",
          errorSummary: error instanceof Error ? error.message : String(error),
          runDurationMs: Date.now() - startedAt,
        });
      } catch {
        /* 状态写入失败不掩盖原始错误。 */
      }
      console.error(`[deepaa] agent local import (${adapter.agentId}) failed`, error);
    } finally {
      db?.close();
    }
  }
  return totalImported;
}

/** 状态查询（只读 API 用）：绑定推导 + 数据源探测 + 导入进度，绝不触发导入。 */
export interface AgentLocalImportStatusEntry {
  agentId: AgentId;
  label: string;
  adapterPresent: boolean;
  /** 直连导入开关（false = 仅身份标注模式：扫描照常、不入账），供 UI 如实说明。 */
  directImportEnabled: boolean;
  binding: {state: "bound" | "disabled"; reason?: string; targetId?: string; floorEpochMs?: number; viaDefaultTarget?: boolean};
  source?: {state: string; reason?: string; dataDir: string; localSchemaVersion?: string};
  importState?: {
    lastStartedAt?: number;
    lastRecordId?: string;
    cursorResetCount: number;
    skippedModelNotProvisioned: number;
    consecutiveFailures: number;
    lastError?: string;
    importedCount: number;
    lastSuccessAt?: string;
    lastRunCount?: number;
    lastRunDurationMs?: number;
  };
}

export async function readAgentLocalImportStatus(dataDir: string): Promise<AgentLocalImportStatusEntry[]> {
  const entries: AgentLocalImportStatusEntry[] = [];
  for (const adapter of AGENT_LOCAL_SOURCE_ADAPTERS) {
    const bindingStatus = await resolveLocalImportBinding(dataDir, adapter.agentId);
    const source = await adapter.discover();
    const db = openDeepaaDatabase({dataDir});
    try {
      const importState = readImportState(db, adapter.agentId);
      entries.push({
        agentId: adapter.agentId,
        label: adapter.label,
        adapterPresent: true,
        directImportEnabled: adapter.directImportEnabled === true,
        binding: bindingStatus.state === "bound"
          ? {state: "bound", targetId: bindingStatus.binding.targetId, floorEpochMs: bindingStatus.binding.floorEpochMs, viaDefaultTarget: bindingStatus.binding.viaDefaultTarget}
          : {state: "disabled", reason: bindingStatus.reason},
        source: {
          state: source.availability.state,
          ...(source.availability.state !== "available" ? {reason: source.availability.reason} : {}),
          dataDir: source.dataDir,
          ...(source.localSchemaVersion ? {localSchemaVersion: source.localSchemaVersion} : {}),
        },
        ...(importState ? {
          importState: {
            ...(importState.lastStartedAt !== undefined ? {lastStartedAt: importState.lastStartedAt} : {}),
            ...(importState.lastRecordId !== undefined ? {lastRecordId: importState.lastRecordId} : {}),
            cursorResetCount: importState.cursorResetCount,
            skippedModelNotProvisioned: importState.skippedModelNotProvisioned,
            consecutiveFailures: importState.consecutiveFailures,
            ...(importState.lastError ? {lastError: importState.lastError} : {}),
            importedCount: importState.importedCount,
            ...(importState.lastSuccessAt ? {lastSuccessAt: importState.lastSuccessAt} : {}),
            ...(importState.lastRunCount !== undefined ? {lastRunCount: importState.lastRunCount} : {}),
            ...(importState.lastRunDurationMs !== undefined ? {lastRunDurationMs: importState.lastRunDurationMs} : {}),
          },
        } : {}),
      });
    } finally {
      db.close();
    }
  }
  return entries;
}
