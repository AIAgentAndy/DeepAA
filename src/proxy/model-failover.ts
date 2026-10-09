/**
 * 模型故障转移状态机（代理进程内存态，纯逻辑模块）。
 *
 * 语义（2026-09-13 二次修订，用户确认）：
 * - 候选链首（锚点）失败后延迟重试一次（300ms ± 50ms 抖动）：健康态锚点=主模型、
 *   降级态锚点=粘性备份、探测态锚点=主模型；偶发抖动被重试吸收时缓存零切换；
 * - 「连续 2 次」完全收敛为单请求内锚点两连败（不跨请求累计）：健康态两连败 →
 *   立即进入降级态；降级态转移成功 → 锁定成功备份为粘性；
 * - 降级期间备份链即时顺延，无次数门槛，顺延成功者立即成为新粘性（粘性滑动）；
 * - 切回触发：请求携带上下文压缩证据（调用方判定）或降级超过 2 小时后的下一个
 *   请求先探测主模型；探测失败只刷新兜底计时，客户端无感；
 * - 非 2xx 非通道类状态（400/401/403/404/3xx…）：提交客户端但**不锁定**；
 *   粘性自身返回此类状态 → 粘性失效（下一请求从链首备份重选，避免持续撞坏备份）；
 * - 状态键 = 目标 + 模型 + wireApi（同模型不同协议通道独立观测），跨 Agent 共享
 *   （通道健康是上游事实）；配置快照变更按目标差异精细清理；
 * - 客户端中断、本地 preflight 错误（凭据解析/会话头缺失）不污染上游健康状态。
 *
 * 备份候选范围 = 与主模型存在共同可服务 (Agent, wireApi) 维度的白名单模型，
 * 可跨供应商（跨目标）；每个候选用完整网关模型串表达，经 decideGatewayRoute
 * 按最新快照实时校验。本模块绝不落盘、绝不导入 SQLite/业务派生模块。
 */

import {decideGatewayRoute, type GatewayRouteDecision} from "./gateway-router.js";
import type {RoutingSnapshot} from "./routing-config.js";
import type {WireApi} from "@/types";

/** 通道级故障的 HTTP 状态码（500-599 全量计入，无需列举）。 */
export const FAILOVER_HTTP_STATUS_CODES: readonly number[] = [408, 429];

/**
 * 降级态时间兜底：超过该时长未切回主模型时，允许下一次请求探测主模型。
 * 1024K 级上下文可能数小时才发生压缩，压缩证据是首选切回时机，这里只是安全网。
 */
export const PRIMARY_RECOVERY_PROBE_MS = 2 * 60 * 60 * 1000;

/** 单个主模型允许配置的备份模型上限（配置写入端同值校验）。 */
export const MAX_MODEL_FALLBACKS = 5;

/** 锚点（候选链首）失败后的重试基准延迟；实际值附带 ±50ms 抖动。 */
export const ANCHOR_RETRY_DELAY_MS = 300;
export const ANCHOR_RETRY_JITTER_MS = 50;

/**
 * 故障转移链上单次尝试的响应头超时：主模型挂死场景下加速转移
 * （健康路径仍使用全局 60s）。拿到响应头即转发客户端，之后由流空闲超时保护，
 * 首字到达即实时透传，绝不判超时。
 */
export const FAILOVER_ATTEMPT_HEADER_TIMEOUT_MS = 30_000;

/** 单请求故障转移链的总时间预算：耗尽后不再发起新候选，进行中的尝试继续。 */
export const FAILOVER_CHAIN_BUDGET_MS = 120_000;

/**
 * 压缩证据触发的恢复探测最小间隔：Codex 压缩摘要会常驻后续每个请求的 64 KiB
 * 扫描窗口（历史首条消息），无间隔会让降级期间每个请求都先撞一次主模型探测
 * （最坏 2×30s）。间隔内压缩证据不再触发探测；2 小时时间兜底不受此限制。
 */
export const COMPACTION_PROBE_MIN_INTERVAL_MS = 10 * 60 * 1000;

/**
 * 备份候选返回非通道类 4xx（401/403/404 等）后的候选级冷却：冷却期内该候选
 * 不再进入候选链，避免坏备份（尤其链首）被每个请求反复撞击。
 */
export const CANDIDATE_CLIENT_ERROR_COOLDOWN_MS = 10 * 60 * 1000;

/**
 * 降级态压缩证据扫描窗口（字节）。必须显著大于 model 定位的 64 KiB 有界读：
 * 真实案例（2026-09-14）中 Codex 压缩摘要标记位于请求体第 81,852 字节——
 * instructions 系统提示（约 17KB）+ 中文正文（UTF-8 每字 3 字节）把标记推出了
 * 64 KiB 窗口，导致降级期全程不探测主模型。2 MiB 覆盖超大 AGENTS.md 场景；
 * 仅降级态收集、随请求释放，内存有界。标记仍超出窗口时安全降级为不探测
 * （2 小时时间兜底仍在）。
 */
export const COMPACTION_SCAN_WINDOW_BYTES = 2 * 1024 * 1024;

/** 判定上游响应状态码是否属于「通道级不通」（触发换候选/锚点失败记账）。 */
export function isFailoverStatusCode(status: number): boolean {
  if (status >= 500 && status <= 599) return true;
  return FAILOVER_HTTP_STATUS_CODES.includes(status);
}

/** 判定状态码是否为「成功服务」（2xx：可锁定粘性/切回主模型）。 */
export function isServedStatusCode(status: number): boolean {
  return status >= 200 && status <= 299;
}

export interface StickyBackup {
  targetId: string;
  modelId: string;
}

export interface FailoverStateKey {
  targetId: string;
  modelId: string;
  wireApi: WireApi;
}

function stateKey({targetId, modelId, wireApi}: FailoverStateKey): string {
  return `${targetId}::${modelId}::${wireApi}`;
}

interface FailoverEntry {
  /** 进入降级态的时刻（毫秒）；探测失败会刷新，作为下一次时间兜底的起点。 */
  degradedAt?: number;
  /** 上次恢复探测（压缩或时间兜底）执行时刻；压缩证据在最小间隔内不重复探测。 */
  lastProbeAt?: number;
  stickyBackup?: StickyBackup;
}

function candidateCooldownKey(targetId: string, modelId: string): string {
  return `${targetId}::${modelId}`;
}

export class ModelFailoverRegistry {
  private readonly entries = new Map<string, FailoverEntry>();
  private readonly candidateCooldowns = new Map<string, number>();
  /** 全量清空（仅测试与整体重置使用；配置变更请用 clearTarget 精细清理）。 */
  clearAll(): void {
    this.entries.clear();
    this.candidateCooldowns.clear();
  }

  /** 配置快照变化时按目标精细清理：只清空该目标相关的健康状态与候选冷却。 */
  clearTarget(targetId: string): void {
    const prefix = `${targetId}::`;
    for (const key of this.entries.keys()) {
      if (key.startsWith(prefix)) this.entries.delete(key);
    }
    for (const key of this.candidateCooldowns.keys()) {
      if (key.startsWith(prefix)) this.candidateCooldowns.delete(key);
    }
  }

  isDegraded(key: FailoverStateKey): boolean {
    return this.entries.get(stateKey(key))?.degradedAt !== undefined;
  }

  stickyBackup(key: FailoverStateKey): StickyBackup | undefined {
    return this.entries.get(stateKey(key))?.stickyBackup;
  }

  /** 降级时间兜底：距进入降级（或上次探测失败）已超过探测间隔。 */
  shouldTimeProbe(key: FailoverStateKey, now: number): boolean {
    const entry = this.entries.get(stateKey(key));
    if (entry?.degradedAt === undefined) return false;
    return now - entry.degradedAt >= PRIMARY_RECOVERY_PROBE_MS;
  }

  /**
   * 本请求是否应执行恢复探测：时间兜底到点直接探测；压缩证据需距上次探测
   * 超过最小间隔（防摘要常驻历史导致降级期每请求都撞探测）。
   */
  shouldProbe(key: FailoverStateKey, compactionEvidence: boolean, now: number): boolean {
    if (!this.isDegraded(key)) return false;
    if (this.shouldTimeProbe(key, now)) return true;
    if (!compactionEvidence) return false;
    const entry = this.entries.get(stateKey(key))!;
    return entry.lastProbeAt === undefined || now - entry.lastProbeAt >= COMPACTION_PROBE_MIN_INTERVAL_MS;
  }

  /** 健康态锚点（主模型）请求内两连败：进入降级态（无粘性，链首备份兜底）。 */
  enterDegraded(key: FailoverStateKey, now: number): void {
    this.entries.set(stateKey(key), {degradedAt: now});
  }

  /** 探测态锚点（主模型）失败：刷新兜底计时与探测间隔，保留粘性。 */
  probeFailed(key: FailoverStateKey, now: number): void {
    const entry = this.entries.get(stateKey(key)) ?? {};
    entry.degradedAt = now;
    entry.lastProbeAt = now;
    this.entries.set(stateKey(key), entry);
  }

  /** 粘性备份失效（如持续返回 4xx）：保持降级态，下一请求从链首备份重选。 */
  clearSticky(key: FailoverStateKey): void {
    const entry = this.entries.get(stateKey(key));
    if (!entry || entry.stickyBackup === undefined) return;
    entry.stickyBackup = undefined;
  }

  /** 备份成功服务：确保降级态并把该备份设为粘性（转移即锁定 / 粘性滑动）。 */
  lockSticky(key: FailoverStateKey, backup: StickyBackup, now: number): void {
    const entry = this.entries.get(stateKey(key)) ?? {};
    entry.degradedAt ??= now;
    entry.stickyBackup = {targetId: backup.targetId, modelId: backup.modelId};
    this.entries.set(stateKey(key), entry);
  }

  /** 主模型成功服务（含恢复探测成功）：清零并退出降级态。 */
  recover(key: FailoverStateKey): void {
    this.entries.delete(stateKey(key));
  }

  /** 候选返回非通道类 4xx 后进入冷却（冷却期内不进入候选链）。 */
  coolCandidate(targetId: string, modelId: string, now: number): void {
    this.candidateCooldowns.set(candidateCooldownKey(targetId, modelId), now + CANDIDATE_CLIENT_ERROR_COOLDOWN_MS);
  }

  isCandidateCooling(targetId: string, modelId: string, now: number): boolean {
    const until = this.candidateCooldowns.get(candidateCooldownKey(targetId, modelId));
    return until !== undefined && now < until;
  }
}

/** 一次请求的故障转移执行计划。 */
export type FailoverPlanMode = "healthy" | "degraded" | "probe";

export interface FailoverAttemptPlanItem {
  decision: GatewayRouteDecision;
  /** 锚点重试尝试：执行前先等待该毫秒数（仅候选链首的第二次尝试携带，含抖动）。 */
  retryAfterMs?: number;
}

export interface FailoverPlan {
  /** 客户端请求的主模型路由决策（状态机记账的「主模型」锚点）。 */
  primary: GatewayRouteDecision;
  mode: FailoverPlanMode;
  attempts: FailoverAttemptPlanItem[];
  /** 随捕获落盘的触发原因；healthy 态无。 */
  trigger?: "consecutive_failures" | "compaction" | "probe";
}

/** 锚点尝试对：链首失败后延迟重试一次（对抗瞬时抖动，保住缓存宿主）。 */
function anchorPair(decision: GatewayRouteDecision): FailoverAttemptPlanItem[] {
  const jitter = (Math.random() * 2 - 1) * ANCHOR_RETRY_JITTER_MS;
  return [
    {decision},
    {decision, retryAfterMs: Math.max(0, Math.round(ANCHOR_RETRY_DELAY_MS + jitter))},
  ];
}

/**
 * 组装一次请求的候选链。每个备份候选按当前快照实时过闸（目标存在、白名单、
 * Agent scope、wire API、订阅透传、凭据解析），不合格候选静默跳过；
 * 全部有效备份（≤5）进入候选链；没有任何有效备份时返回 undefined。
 *
 * 链形态（锚点=链首候选，失败后延迟重试一次）：
 * - healthy：[主, 主(重试), 备份1, 备份2, ...]；
 * - degraded + 粘性：[粘性, 粘性(重试), 其余备份...]，trigger=consecutive_failures；
 * - degraded 无粘性：[备份1, 备份1(重试), 其余备份...]；
 * - probe（压缩/时间兜底）：[主(探测), 主(重试), 粘性, 其余备份...]。
 */
export function resolveFailoverPlan(options: {
  snapshot: RoutingSnapshot;
  registry: ModelFailoverRegistry;
  decision: GatewayRouteDecision;
  /** 原始请求路径（/{agent}/v1/...），用于对备份候选复用网关路由决策。 */
  pathname: string;
  /** 请求携带上下文压缩证据（dsh 头或正文续接标记），降级态下触发主模型切回探测。 */
  compactionEvidence: boolean;
  now: number;
}): FailoverPlan | undefined {
  const {snapshot, registry, decision, pathname, compactionEvidence, now} = options;
  const fallbacks = decision.target.modelFallbacks.get(decision.modelId);
  if (!fallbacks || fallbacks.length === 0) return undefined;
  const chain: GatewayRouteDecision[] = [];
  for (const gatewayModel of fallbacks.slice(0, MAX_MODEL_FALLBACKS)) {
    try {
      const candidate = decideGatewayRoute(snapshot, pathname, gatewayModel);
      // 纵深防御：passthrough/订阅目标绝不作为候选（Web 保存端已拒绝，此处
      // 兜底手工改配置/旧配置场景，防客户端 OAuth 出境）。
      if (candidate.credentialMode === "passthrough") continue;
      // 候选冷却（曾返回非通道类 4xx）：冷却期内跳过。
      if (registry.isCandidateCooling(candidate.target.id, candidate.modelId, now)) continue;
      chain.push(candidate);
    } catch {
      // 悬空/不合格候选（目标删除、白名单或 scope 变更、凭据缺失等）：跳过。
    }
  }
  if (chain.length === 0) return undefined;

  const key: FailoverStateKey = {
    targetId: decision.target.id,
    modelId: decision.modelId,
    wireApi: decision.wireApi,
  };
  const asItems = (decisions: GatewayRouteDecision[]): FailoverAttemptPlanItem[] =>
    decisions.map(item => ({decision: item}));
  if (!registry.isDegraded(key)) {
    return {
      primary: decision,
      mode: "healthy",
      attempts: [...anchorPair(decision), ...asItems(chain)],
    };
  }
  const sticky = registry.stickyBackup(key);
  const stickyDecision = sticky
    ? chain.find(item => item.target.id === sticky.targetId && item.modelId === sticky.modelId)
    : undefined;
  const rest = chain.filter(item => item !== stickyDecision);
  if (registry.shouldProbe(key, compactionEvidence, now)) {
    return {
      primary: decision,
      mode: "probe",
      trigger: compactionEvidence && !registry.shouldTimeProbe(key, now) ? "compaction" : "probe",
      attempts: [...anchorPair(decision), ...asItems(stickyDecision ? [stickyDecision, ...rest] : chain)],
    };
  }
  const [head, ...tail] = stickyDecision ? [stickyDecision, ...rest] : chain;
  return {
    primary: decision,
    mode: "degraded",
    ...(stickyDecision ? {trigger: "consecutive_failures" as const} : {}),
    attempts: [...anchorPair(head!), ...asItems(tail)],
  };
}

/**
 * Codex 窗口编号追踪器（2026-09-15 调研确认的首选压缩信号）。
 *
 * Codex 在 `x-codex-turn-metadata` 头携带 `window_number`：上下文压缩（或 /new）
 * 重建窗口时编号精确 +1，普通请求绝不递增（真实会话验证：压缩前恒 0、压缩后恒 1）。
 * 这是零请求体扫描、事件精确、版本稳健（结构化 JSON 而非 prose 模板）的压缩边界信号；
 * 文本标记扫描（2 MiB 窗口）保留为无该头请求的兜底。
 *
 * 语义：同一 session 首次见到只记基线（不触发）；编号大于上次 = 窗口递增事件
 * （注入压缩证据，走既有探测机制）；编号回退/不变 = 无事件。容量上限防泄漏，
 * 淘汰后最坏丢失一次探测（下一次递增恢复），无害。
 */
export class CodexWindowTracker {
  private readonly lastSeen = new Map<string, number>();
  private static readonly MAX_TRACKED_SESSIONS = 5_000;

  consume(sessionKey: string, windowNumber: number): boolean {
    if (this.lastSeen.size >= CodexWindowTracker.MAX_TRACKED_SESSIONS
      && !this.lastSeen.has(sessionKey)) {
      this.lastSeen.clear();
    }
    const previous = this.lastSeen.get(sessionKey);
    this.lastSeen.set(sessionKey, windowNumber);
    return previous !== undefined && windowNumber > previous;
  }
}

/**
 * 解析 `x-codex-turn-metadata` 头中的 `window_number`（codex 上下文窗口代际）。
 * 头缺失（非 codex 请求）、JSON 非法或字段非安全整数时返回 undefined。
 */
export function codexWindowNumber(headers: {
  "x-codex-turn-metadata"?: string | string[];
  [key: string]: string | string[] | undefined;
}): number | undefined {
  const raw = headers["x-codex-turn-metadata"];
  const text = Array.isArray(raw) ? raw[0] : raw;
  if (!text || text.length > 8 * 1024) return undefined;
  try {
    const parsed = JSON.parse(text) as {window_number?: unknown};
    return typeof parsed.window_number === "number" && Number.isSafeInteger(parsed.window_number)
      ? parsed.window_number
      : undefined;
  } catch {
    return undefined;
  }
}
