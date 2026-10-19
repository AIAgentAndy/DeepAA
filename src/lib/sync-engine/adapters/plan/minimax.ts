import {
  SyncUnsupportedError,
  type PlanQuotaSnapshotInput,
  type PlanSyncConnector,
  type PlanSyncInput,
  type SyncResult,
} from "../../types";
import {
  asRecord,
  fetchPlanJson,
  finiteNumber,
  normalizeResetAt,
  resolveRequiredPlanCredential,
} from "./shared";

type MiniMaxEndpoint = "international" | "china";

interface MiniMaxWindowSpec {
  windowLabel: string;
  totalKey: string;
  countKey: string;
  percentKey: string;
  absoluteResetKey: string;
  offsetResetKey: string;
  requireWeeklyStatusOne: boolean;
}

/** 两个时间窗字段名固定；周窗口在中国区按官方文档启用状态过滤。 */
const MINIMAX_WINDOW_SPECS: readonly MiniMaxWindowSpec[] = [
  {
    windowLabel: "5h",
    totalKey: "current_interval_total_count",
    countKey: "current_interval_usage_count",
    percentKey: "current_interval_remaining_percent",
    absoluteResetKey: "end_time",
    offsetResetKey: "remains_time",
    requireWeeklyStatusOne: false,
  },
  {
    windowLabel: "weekly",
    totalKey: "current_weekly_total_count",
    countKey: "current_weekly_usage_count",
    percentKey: "current_weekly_remaining_percent",
    absoluteResetKey: "weekly_end_time",
    offsetResetKey: "weekly_remains_time",
    requireWeeklyStatusOne: true,
  },
] as const;

function miniMaxEndpoint(baseUrl: string | undefined): MiniMaxEndpoint {
  // 未传地址时按旧语义默认国际区，避免纯解析调用（如测试）误入中国区。
  if (!baseUrl) return "international";
  return baseUrl.toLowerCase().includes("api.minimax.io") ? "international" : "china";
}

/**
 * 按 MiniMax 最新开放平台口径统一：count 类字段表示「已用量」，
 * remains/remain_count 表示剩余量、total_count 表示总额度。
 * 新旧接口均按 count=已用量 解析，缺失时用 remaining_percent 反推已用百分比。
 */
function buildMiniMaxWindow(
  item: Record<string, unknown>,
  spec: MiniMaxWindowSpec,
): PlanQuotaSnapshotInput | undefined {
  if (spec.requireWeeklyStatusOne) {
    const weeklyStatus = finiteNumber(item.current_weekly_status);
    if (weeklyStatus !== undefined && weeklyStatus !== 1) return undefined;
  }
  const resetAt =
    normalizeResetAt(item[spec.absoluteResetKey])
    ?? miniMaxOffsetResetAt(item[spec.offsetResetKey]);
  const total = finiteNumber(item[spec.totalKey]);
  const count = finiteNumber(item[spec.countKey]);
  if (total !== undefined && total > 0 && count !== undefined) {
    return {
      planName: "MiniMax Coding Plan",
      windowLabel: spec.windowLabel,
      used: Math.max(count, 0),
      total,
      unit: "count",
      resetAt,
      raw: item,
    };
  }
  const remainingPercent = finiteNumber(item[spec.percentKey]);
  if (remainingPercent === undefined) return undefined;
  return {
    planName: "MiniMax Coding Plan",
    windowLabel: spec.windowLabel,
    used: Math.max(100 - remainingPercent, 0),
    total: 100,
    unit: "percent",
    resetAt,
    raw: item,
  };
}

/** remains_time / weekly_remains_time 是毫秒级相对偏移，不能按绝对时间戳解析。 */
function miniMaxOffsetResetAt(value: unknown): string | undefined {
  const offset = finiteNumber(value);
  if (offset === undefined || offset < 0) return undefined;
  return new Date(Date.now() + offset).toISOString();
}

/**
 * 套餐聚合项识别。`minimax-m*` 通配与 `general` 在国内外区都会出现——2026-10-19
 * 实测中国区 `www/api.minimax.cn` 的 token_plan/remains 返回 `model_name: "general"`
 * 承载 5h + 周两个窗口；旧实现把 `general` 限定在国际区，导致中国区目标每次同步
 * 都解析出零个窗口（进而不落任何快照）。`video` 仅国际区响应出现，不作为中国区候选。
 */
function isMiniMaxCodingModelName(
  modelName: unknown,
  endpoint: MiniMaxEndpoint,
): boolean {
  if (typeof modelName !== "string") return false;
  const normalized = modelName.trim().toLowerCase();
  return normalized === "minimax-m*"
    || normalized.startsWith("minimax-m")
    || normalized === "general"
    || (endpoint === "international" && normalized === "video");
}

/** 优先官方通配模型 minimax-m*；否则取剩余百分比最差（最接近用尽）的模型。 */
function selectCanonicalMiniMaxModel(
  models: Array<Record<string, unknown>>,
  endpoint: MiniMaxEndpoint,
): Record<string, unknown> | undefined {
  const candidates = models.filter(model => isMiniMaxCodingModelName(model.model_name, endpoint));
  if (candidates.length === 0) return undefined;
  const wildcard = candidates.find(model =>
    typeof model.model_name === "string"
    && model.model_name.trim().toLowerCase() === "minimax-m*",
  );
  if (wildcard && miniMaxWorstRemainingPercent(wildcard, endpoint) !== undefined) {
    return wildcard;
  }
  // `general` 是套餐聚合项（国内外区通用），优先展示以免 video 等条目抢占。
  const general = candidates.find(model =>
    typeof model.model_name === "string"
    && model.model_name.trim().toLowerCase() === "general",
  );
  if (general && miniMaxWorstRemainingPercent(general, endpoint) !== undefined) {
    return general;
  }
  const scored = candidates
    .map(model => ({model, remaining: miniMaxWorstRemainingPercent(model, endpoint)}))
    .filter((item): item is {model: Record<string, unknown>; remaining: number} =>
      item.remaining !== undefined,
    )
    .sort((left, right) =>
      left.remaining - right.remaining
      || String(left.model.model_name).localeCompare(String(right.model.model_name)),
    );
  return scored[0]?.model;
}

/** 同一模型两个窗口的剩余百分比取最小值（越接近用尽越值得展示）。 */
function miniMaxWorstRemainingPercent(
  model: Record<string, unknown>,
  endpoint: MiniMaxEndpoint,
): number | undefined {
  const percents = MINIMAX_WINDOW_SPECS.flatMap(spec => {
    const total = finiteNumber(model[spec.totalKey]);
    const count = finiteNumber(model[spec.countKey]);
    if (total !== undefined && total > 0 && count !== undefined) {
      const remaining = Math.max(total - Math.max(count, 0), 0);
      return [remaining / total * 100];
    }
    const remainingPercent = finiteNumber(model[spec.percentKey]);
    return remainingPercent === undefined ? [] : [remainingPercent];
  });
  return percents.length > 0 ? Math.min(...percents) : undefined;
}

/**
 * 解析 MiniMax Coding Plan 用量；count 统一视为已用量，baseUrl 仅用于区域与模型名识别。
 * 纯解析函数保持宽容（业务错误码与未知形状一律返回空数组），把业务错误显式抛给用户的
 * 责任由 `sync` 的 `miniMaxBusinessError` 承担。
 */
export function parseMiniMaxPlanQuota(
  payload: unknown,
  options: {baseUrl?: string} = {},
): PlanQuotaSnapshotInput[] {
  const body = asRecord(payload);
  if (!body) return [];
  const baseResponse = asRecord(body.base_resp);
  const statusCode = finiteNumber(baseResponse?.status_code);
  if (statusCode !== undefined && statusCode !== 0) return [];
  const remains = Array.isArray(body.model_remains) ? body.model_remains : [];
  const models = remains
    .map(asRecord)
    .filter((record): record is Record<string, unknown> => Boolean(record));
  const endpoint = miniMaxEndpoint(options.baseUrl);
  const model = selectCanonicalMiniMaxModel(models, endpoint);
  if (!model) return [];
  return MINIMAX_WINDOW_SPECS.flatMap(spec => {
    const snapshot = buildMiniMaxWindow(model, spec);
    return snapshot ? [snapshot] : [];
  });
}

/**
 * MiniMax 用 HTTP 200 + `base_resp.status_code` 承载业务失败（鉴权、额度、限流等）。
 * 必须显式抛出：静默返回空窗口会被同步服务记成「成功但零窗口」，页面只剩一句空态
 * 文案，用户无从区分「套餐确实没有用量」与「接口读到了但拒绝了这次请求」。
 */
function miniMaxBusinessError(payload: unknown): Error | undefined {
  const baseResponse = asRecord(asRecord(payload)?.base_resp);
  const statusCode = finiteNumber(baseResponse?.status_code);
  if (statusCode === undefined || statusCode === 0) return undefined;
  const statusMessage = typeof baseResponse?.status_msg === "string"
    ? baseResponse.status_msg.replace(/[\u0000-\u001f\u007f]+/gu, " ").trim().slice(0, 120)
    : "";
  return new Error(`MINIMAX_API_${statusCode}${statusMessage ? ` (${statusMessage})` : ""}`);
}

/**
 * 官方 FAQ 现行只展示 token_plan/remains（Bearer）；域名体系已切 minimax.cn
 * （2026-09-30，项目未上线不留 minimaxi.com 旧域兜底）。主端点为官方文档口径
 * www.minimax.cn（2026-09-30 官方 FAQ 核对对调），api.minimax.cn 保留实测兜底；
 * 国际区仍走 api.minimax.io 旧路径。
 */
function minimaxPlanUrls(baseUrl: string): string[] {
  const host = miniMaxEndpoint(baseUrl) === "international"
    ? "https://api.minimax.io"
    : "https://api.minimax.cn";
  if (host.includes("minimax.io")) {
    return [`${host}/v1/api/openplatform/coding_plan/remains`];
  }
  return [
    "https://www.minimax.cn/v1/token_plan/remains",
    `${host}/v1/token_plan/remains`,
  ];
}

export class MiniMaxPlanAdapter implements PlanSyncConnector {
  readonly providerType = "minimax" as const;
  readonly capabilities = {
    balance: false,
    rates: false,
    quota: true,
    auth: "api_key" as const,
  };

  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async sync(input: PlanSyncInput): Promise<SyncResult> {
    const apiKey = await resolveRequiredPlanCredential(
      input.credentialId,
      input.resolveCredential,
    );
    const urls = minimaxPlanUrls(input.baseUrl);
    let lastTransportError: unknown;
    let businessError: Error | undefined;
    let answered = false;
    for (const url of urls) {
      let payload: unknown;
      try {
        payload = await fetchPlanJson(
          url,
          `Bearer ${apiKey}`,
          this.fetchImpl,
        );
      } catch (error) {
        // 只有传输层失败才继续探测下一个端点。
        lastTransportError = error;
        continue;
      }
      // 有端点给出应答即说明链路是通的：此后其它端点的传输失败不得再被报成同步失败
      // （旧实现把「首个端点成功但无窗口 + 兜底端点超时」整体误报为 fetch failed）。
      answered = true;
      const rejected = miniMaxBusinessError(payload);
      if (rejected) {
        businessError = rejected;
        continue;
      }
      const planQuota = parseMiniMaxPlanQuota(payload, {baseUrl: url});
      if (planQuota.length > 0) {
        return {providerType: this.providerType, planQuota};
      }
    }
    if (businessError) throw businessError;
    if (!answered && lastTransportError !== undefined) {
      throw lastTransportError instanceof Error
        ? lastTransportError
        : new Error(String(lastTransportError));
    }
    // 应答有效却解析不出任何窗口：与 opencode-go 同口径显式失败，禁止静默返回空数组
    // 让同步状态显示「成功」（那正是本次「已同步但窗口不展示」的成因）。
    throw new SyncUnsupportedError("MINIMAX_USAGE_INVALID");
  }
}
