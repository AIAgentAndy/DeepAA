/**
 * Agent 本地扫描就绪信号（2026-09-22，扫描就绪门控）。
 *
 * 用途：派生侧「dsh 网关行身份等待」的边界从「行龄」修正为「链接可生产性」。
 * 90s 年龄窗假设「行很老 = 链接不会再来」，只在实时竞态成立；web 宕机期间
 * 3211 仍在捕获时，重启后 Worker（instrumentation 中先于调度器启动）会在本地
 * 扫描冷启动收敛前，把宕机期的旧行按降级身份派生（折不进原生会话树）。本
 * 信号让旧行在「扫描已启动且尚未收敛」期间继续顺延；收敛后 miss 即真缺失，
 * 按现状诚实降级——确保 3210/3211 任意不同步也不影响最终结构归 folding。
 *
 * 载体是进程内 globalThis 状态（对齐 `__deepaaIngestionWorkers` 惯例）而
 * **不是 SQLite**：收敛是「本进程调度器生命周期」的事实，持久化反而会用上一
 * 进程的陈旧收敛标记让重启后的旧行立即降级（正是要修的 bug），还需要额外的
 * 启动清零编排。信号按 agentId 键控——未来其他 Agent 需要同类就绪门控时直接
 * 复用（判定与常量均为通用命名，Agent 专属粒度常量在各适配器侧定义）。
 */

/** 已启动但迟迟未收敛的熔断窗：覆盖本地数据缺失/损坏、扫描持续失败等场景。 */
export const AGENT_SCAN_CONVERGENCE_MAX_WAIT_MS = 5 * 60_000;

export interface AgentScanReadiness {
  startedAt: number;
  /** 首次收敛时刻；本进程内 sticky（一次收敛不因后续失败回退，由熔断窗兜底）。 */
  convergedAt?: number;
}

type ScanReadinessGlobal = typeof globalThis & {
  __deepaaAgentScanReadiness?: Map<string, AgentScanReadiness>;
};

function readinessMap(): Map<string, AgentScanReadiness> {
  const globalState = globalThis as ScanReadinessGlobal;
  return globalState.__deepaaAgentScanReadiness
    ?? (globalState.__deepaaAgentScanReadiness = new Map());
}

/**
 * 调度器入口置位：本进程将为该 Agent 执行扫描。必须在 `void tick()` 之前调用——
 * Worker 在 instrumentation 中先于调度器启动，等首轮 tick 再置位会留下数百毫秒
 * 的窗口让 Worker 把旧行先派生掉。未绑定/数据不可用导致的「永不收敛」由熔断窗
 * 兜底（且未绑定的 Agent 不会有对应网关行，等待自然落空）。
 */
export function markAgentScanStarted(agentId: string, nowMs = Date.now()): void {
  const map = readinessMap();
  if (!map.has(agentId)) map.set(agentId, {startedAt: nowMs});
}

/** 一轮扫描无剩余待索引文件时置位；状态缺失时补建（startedAt 同步补记）。 */
export function markAgentScanConverged(agentId: string, nowMs = Date.now()): void {
  const map = readinessMap();
  const current = map.get(agentId);
  if (!current) {
    map.set(agentId, {startedAt: nowMs, convergedAt: nowMs});
    return;
  }
  if (current.convergedAt === undefined) current.convergedAt = nowMs;
}

/** 只读快照（测试与可观测用）。 */
export function readAgentScanReadiness(agentId: string): AgentScanReadiness | undefined {
  return readinessMap().get(agentId);
}

export interface AgentScanWaitDecision {
  /** 该 Agent 的旧行是否应继续顺延等待扫描收敛。 */
  waitable: boolean;
  /** 已启动未收敛且超过熔断窗（调用方可据此观测，不再等待）。 */
  circuitBroken?: boolean;
}

/**
 * 三态判定：未启动 / 已收敛 / 已熔断 → 不等待（按现状降级）；
 * 已启动且未收敛未熔断 → 等待。
 */
export function shouldWaitForAgentScanConvergence(
  agentId: string,
  nowMs = Date.now(),
): AgentScanWaitDecision {
  const state = readinessMap().get(agentId);
  if (!state) return {waitable: false};
  if (state.convergedAt !== undefined) return {waitable: false};
  if (nowMs - state.startedAt >= AGENT_SCAN_CONVERGENCE_MAX_WAIT_MS) {
    return {waitable: false, circuitBroken: true};
  }
  return {waitable: true};
}

/** 测试隔离：globalThis 状态跨用例泄漏，测试文件 afterEach 统一清空。 */
export function resetAgentScanReadinessForTests(): void {
  (globalThis as ScanReadinessGlobal).__deepaaAgentScanReadiness = undefined;
}
