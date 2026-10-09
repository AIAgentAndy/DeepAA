import type {CaptureFailover, CaptureFailoverAttempt} from "./harness/types";
import {parseGatewayModelId} from "../proxy/gateway-prefix";

/**
 * 模型故障转移展示层：宽松解析 + 统一文案。
 *
 * Step 列表（会话追踪第三栏）与交互内容页的 failover 徽标共用这里的解析与
 * 文案规则；数据全部来自代理捕获的 routing.failover（经 context_snapshots
 * 摘要透传），不做任何事后推断。
 */

export type {CaptureFailover, CaptureFailoverAttempt};

const TRIGGER_LABELS: Record<CaptureFailover["trigger"], string> = {
  consecutive_failures: "连续失败故障转移",
  compaction: "上下文压缩切回",
  probe: "定时恢复探测",
};

/** 连接类失败原因的稳定短文案；HTTP 状态码与未知值原样展示。 */
const ERROR_DETAIL_LABELS: ReadonlyArray<readonly [string, string]> = [
  ["CONNECT_TIMEOUT", "连接超时"],
  ["HEADER_TIMEOUT", "响应头超时"],
  ["CONNECTION_ERROR", "连接失败"],
  ["CREDENTIAL_RESOLVE_FAILED", "凭据解析失败"],
  ["OPENCODE_SESSION_REQUIRED", "缺少会话身份"],
  ["CLIENT_ABORTED", "客户端中断"],
  ["REPLAY_UNAVAILABLE", "重放不可用"],
];

/**
 * 宽松解析 context snapshot 摘要里的 failover 字段。
 * 旧数据或异常结构一律返回 undefined，绝不抛错阻断查询。
 */
export function parseStepFailover(value: unknown): CaptureFailover | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const trigger = record.trigger;
  if (trigger !== "consecutive_failures" && trigger !== "compaction" && trigger !== "probe") {
    return undefined;
  }
  if (typeof record.fromModel !== "string"
    || typeof record.toModel !== "string"
    || typeof record.retryCount !== "number") {
    return undefined;
  }
  const attempts: CaptureFailoverAttempt[] = [];
  if (Array.isArray(record.attempts)) {
    for (const item of record.attempts.slice(0, 8)) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const attempt = item as Record<string, unknown>;
      if (typeof attempt.targetId !== "string" || typeof attempt.model !== "string") continue;
      if (attempt.outcome !== "error" && attempt.outcome !== "served") continue;
      attempts.push({
        targetId: attempt.targetId,
        model: attempt.model,
        outcome: attempt.outcome,
        ...(typeof attempt.detail === "string" && attempt.detail.length <= 128
          ? {detail: attempt.detail}
          : {}),
      });
    }
  }
  if (attempts.length === 0) return undefined;
  const optionalName = (input: unknown): string | undefined =>
    typeof input === "string" && input.length > 0 && input.length <= 128 ? input : undefined;
  const fromTargetName = optionalName(record.fromTargetName);
  const toTargetName = optionalName(record.toTargetName);
  return {
    trigger,
    fromTargetId: typeof record.fromTargetId === "string" ? record.fromTargetId : "",
    ...(fromTargetName ? {fromTargetName} : {}),
    fromModel: record.fromModel,
    toTargetId: typeof record.toTargetId === "string" ? record.toTargetId : "",
    ...(toTargetName ? {toTargetName} : {}),
    toModel: record.toModel,
    attempts,
    retryCount: record.retryCount,
  };
}

/** 端点标签：「模型 ID · 供应商」——只有模型 + 供应商才能精确确认（2026-09-14 用户确认）。 */
function endpointLabel(failover: CaptureFailover, side: "from" | "to"): string {
  const model = side === "from" ? failover.fromModel : failover.toModel;
  const targetId = side === "from" ? failover.fromTargetId : failover.toTargetId;
  const targetName = side === "from" ? failover.fromTargetName : failover.toTargetName;
  return `${model} · ${targetName || targetId}`;
}

/** 身份判定：目标 + 模型双要素一致才是「主模型自身」（同模型 ID 跨供应商转移不算）。 */
function isSameEndpoint(failover: CaptureFailover): boolean {
  return failover.fromTargetId !== ""
    && failover.fromTargetId === failover.toTargetId
    && failover.fromModel === failover.toModel;
}

/** 触发原因中文文案。 */
export function formatFailoverTriggerLabel(trigger: CaptureFailover["trigger"]): string {
  return TRIGGER_LABELS[trigger] ?? trigger;
}

/** 单次尝试失败原因文案。 */
export function formatFailoverDetailLabel(detail: string | undefined): string {
  if (!detail) return "失败";
  const mapped = ERROR_DETAIL_LABELS.find(([code]) => code === detail);
  if (mapped) return mapped[1];
  return detail;
}

/**
 * Step 列表徽标的紧凑文案：`故障转移 · from → to`（端点含供应商）。
 * 主模型自身恢复服务（同目标同模型，压缩/兜底探测成功）时标注切回语义。
 */
export function formatFailoverChipText(failover: CaptureFailover): string {
  const last = failover.attempts[failover.attempts.length - 1];
  if (isSameEndpoint(failover)) {
    return `故障转移 · ${endpointLabel(failover, "from")} 已切回主模型`;
  }
  const servedText = last?.outcome === "served" ? "" : "（未恢复）";
  return `故障转移 · ${endpointLabel(failover, "from")} → ${endpointLabel(failover, "to")}${servedText}`;
}

/**
 * 交互内容页徽标的完整文案，例如：
 * `gpt-5.6-sol · ai98pro → gpt-5.6-sol · catapi · 连续失败故障转移 · HTTP 502 · 第 2 次尝试服务`。
 */
export function formatFailoverBadgeText(failover: CaptureFailover): string {
  const trigger = formatFailoverTriggerLabel(failover.trigger);
  const last = failover.attempts[failover.attempts.length - 1];
  if (isSameEndpoint(failover) && last?.outcome === "served") {
    return `${endpointLabel(failover, "from")}（${trigger} · 已切回主模型）`;
  }
  const reasonParts = failover.attempts
    .filter(attempt => attempt.outcome === "error")
    .map(attempt => formatFailoverDetailLabel(attempt.detail));
  const uniqueReasons = [...new Set(reasonParts)].slice(0, 3);
  const parts: string[] = [
    `${endpointLabel(failover, "from")} → ${endpointLabel(failover, "to")}`,
    trigger,
  ];
  if (uniqueReasons.length > 0) parts.push(uniqueReasons.join("、"));
  if (last?.outcome === "served") {
    parts.push(`第 ${failover.retryCount} 次尝试服务`);
  } else {
    parts.push(`${failover.attempts.length} 次尝试均失败`);
  }
  return parts.join(" · ");
}

/**
 * 备份模型条目的统一展示标签：「模型 ID · 供应商名」。
 * 表格 chips、弹窗候选卡片与已选列表共用；供应商名缺失时回退路由 ID，
 * 网关模型串非法时原样返回（不抛错）。
 */
export function formatFallbackEntryLabel(
  gatewayModelId: string,
  targetNames: ReadonlyMap<string, string>,
): string {
  const parsed = parseGatewayModelId(gatewayModelId);
  if (!parsed) return gatewayModelId;
  const targetName = targetNames.get(parsed.targetId) ?? parsed.targetId;
  return `${parsed.modelId} · ${targetName}`;
}

/**
 * Turn 级故障转移轨迹（总览展示）：按时间顺序聚合各 Step 的 failover 元数据，
 * 输出「主模型端点 → 各实际服务端点」的去重端点序列（连续重复合并）。
 * 入参应为按 failover 首次出现顺序排列的元数据列表；无有效转移时返回 undefined。
 */
export function buildFailoverTrajectory(failovers: CaptureFailover[]): string[] | undefined {
  const first = failovers[0];
  if (!first) return undefined;
  const trajectory: string[] = [endpointLabel(first, "from")];
  for (const failover of failovers) {
    const label = endpointLabel(failover, "to");
    if (trajectory[trajectory.length - 1] !== label) trajectory.push(label);
  }
  return trajectory.length >= 2 ? trajectory : undefined;
}
