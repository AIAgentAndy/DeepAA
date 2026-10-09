export type TopLevelPath = "/sessions" | "/export" | "/token-pricing" | "/proxy-management" | "/dashboard";

export interface SharedSelection {
  target?: string;
  agent?: string;
  session?: string;
  thread?: string;
  turn?: string;
  step?: string;
}

export interface TokenPricingHierarchySelection {
  session: string;
  thread: string;
  turn: string;
  step: string;
}

const SHARED_SELECTION_KEYS = ["target", "agent", "session", "thread", "turn", "step"] as const;

/**
 * 从页面查询参数提取唯一业务路径。供应商或 Agent 多选时不猜测当前项，
 * 但仍保留更具体且可由供应商页面校验的 Session/Thread/Turn/Step。
 */
export function sharedSelectionFromSearchParams(params: URLSearchParams): SharedSelection {
  const selection: SharedSelection = {};
  for (const key of SHARED_SELECTION_KEYS) {
    const value = singleValue(params.getAll(key));
    if (value) selection[key] = value;
  }
  return selection;
}

/** 以固定顺序生成三个一级页面共用的查询串。 */
export function sharedSelectionQuery(input: URLSearchParams | SharedSelection): string {
  const selection = input instanceof URLSearchParams
    ? sharedSelectionFromSearchParams(input)
    : input;
  const params = new URLSearchParams();
  for (const key of SHARED_SELECTION_KEYS) {
    const value = selection[key]?.trim();
    if (value) params.set(key, value);
  }
  return params.toString();
}

export function topLevelHref(path: TopLevelPath, input: URLSearchParams | SharedSelection): string {
  const query = sharedSelectionQuery(input);
  return query ? `${path}?${query}` : path;
}

/**
 * 参与公共业务路径互传的一级页面（2026-09-24 用户确认）：只有会话追踪/交互内容/
 * Token 价格三个数据页互相携带六级业务上下文；仪表盘与供应商管理不参与——
 * 从数据页切向它们丢弃全部参数，从它们切向数据页也不携带（保持无参首屏）。
 * 仪表盘 KPI 卡等页内深链不经本函数，不受影响。
 */
const SELECTION_PROPAGATION_PATHS = new Set<string>(["/sessions", "/export", "/token-pricing"]);

export function topLevelNavHref(
  target: TopLevelPath,
  currentPath: string,
  input: URLSearchParams | SharedSelection,
): string {
  const propagates = SELECTION_PROPAGATION_PATHS.has(target)
    && SELECTION_PROPAGATION_PATHS.has(currentPath);
  return propagates ? topLevelHref(target, input) : target;
}

/** 上级筛选变化时同步清理已经失效的下级业务路径。 */
export function tokenPricingHierarchyAfterChange(
  current: TokenPricingHierarchySelection,
  key: keyof TokenPricingHierarchySelection,
  value: string,
): TokenPricingHierarchySelection {
  if (key === "session") return { session: value, thread: "", turn: "", step: "" };
  if (key === "thread") return { ...current, thread: value, turn: "", step: "" };
  if (key === "turn") return { ...current, turn: value, step: "" };
  return { ...current, step: value };
}

/** 旧查询路径无法验证 Thread 时保留 URL 值，非空服务端值则视为已解析路径。 */
export function tokenPricingHierarchyAfterResolution(
  current: TokenPricingHierarchySelection,
  resolved: TokenPricingHierarchySelection,
): TokenPricingHierarchySelection {
  return {
    ...resolved,
    thread: resolved.thread || current.thread,
  };
}

/** 会话追踪页除公共业务路径外，仅追加本页私有的查看层级。 */
export function workbenchSelectionQuery(
  selection: SharedSelection,
  view: "session" | "thread" | "turn",
): string {
  const params = new URLSearchParams(sharedSelectionQuery(selection));
  params.set("view", view);
  return params.toString();
}

function singleValue(values: string[]): string | undefined {
  if (values.length !== 1) return undefined;
  const normalized = values[0]?.trim();
  if (!normalized || normalized.includes(",")) return undefined;
  return normalized;
}
