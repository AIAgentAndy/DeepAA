export function normalizeHttpBaseUrl(value: unknown, label = "Proxy URL"): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} is required`);
  }

  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error(`${label} must be a valid URL`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${label} must use http or https`);
  }

  return url.toString().replace(/\/+$/, "");
}

export function normalizeProxyRouteId(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("Proxy target id is required");
  }
  const normalized = value.trim().toLowerCase();
  // 路由 ID 是网关模型 `<targetId>_<modelId>` 的切分锚点，不能静默改写用户输入；
  // 尤其下划线会让模型前缀产生歧义，必须在保存时明确拒绝。
  if (!/^[a-z0-9.-]+$/.test(normalized) || normalized.includes("_")) {
    throw new Error("Proxy target id must contain only lowercase letters, numbers, dots, and hyphens");
  }
  return normalized;
}

function upstreamPortSuffix(url: URL): string {
  const defaultPort =
    (url.protocol === "http:" && url.port === "80") ||
    (url.protocol === "https:" && url.port === "443");
  return url.port && !defaultPort ? `.${url.port}` : "";
}

function composeRouteId(host: string, portSuffix: string, pathname: string): string {
  const hostPart = normalizeRoutePart(`${host}${portSuffix}`);
  const pathParts = pathname
    .split("/")
    .filter(Boolean)
    .map(segment => normalizeRoutePart(segment))
    .filter(Boolean);
  return normalizeProxyRouteId([hostPart, ...pathParts].join("-"));
}

export function routeIdFromUpstreamUrl(value: string): string {
  const url = new URL(normalizeHttpBaseUrl(value));
  return composeRouteId(url.hostname.toLowerCase(), upstreamPortSuffix(url), url.pathname);
}

/**
 * 短格式路由 ID：去掉域名第一段标签（api.z.ai → z.ai），让网关模型
 * `<modelId>_<routeId>` 的展示重心落在模型名上。
 * 仅当域名至少三段时才剥离；两段域名与单机名保持原样，
 * 剥离后只剩公共后缀（如 *.com.cn）时同样不剥。端口与 path 规则与全格式一致。
 */
export function shortRouteIdFromUpstreamUrl(value: string): string {
  const url = new URL(normalizeHttpBaseUrl(value));
  const host = url.hostname.toLowerCase();
  const portSuffix = upstreamPortSuffix(url);
  // IP 字面量没有「标签」概念，剥首段会把 10.0.0.5 毁成 0.0.5，原样保留。
  if (isIpLiteralHost(host)) {
    return composeRouteId(host, portSuffix, url.pathname);
  }
  const labels = host.split(".").filter(Boolean);
  if (labels.length >= 3) {
    const restLabels = labels.slice(1);
    const restHost = restLabels.join(".");
    const onlyPublicSuffix = restLabels.length === 2 && COMMON_TWO_PART_PUBLIC_SUFFIXES.has(restHost);
    if (!onlyPublicSuffix) {
      return composeRouteId(restHost, portSuffix, url.pathname);
    }
  }
  return composeRouteId(host, portSuffix, url.pathname);
}

function isIpLiteralHost(host: string): boolean {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.includes(":");
}

/**
 * 注册主域（eTLD+1 近似）：常规域名取末两段，`*.com.cn` 等两段公共后缀取末三段；
 * 单机名与 IP 字面量原样返回。IP 判定只覆盖 IPv4；IPv6 含 `:` 不符合路由 ID 字符集，
 * 属于手动填写场景，不参与自动派生。
 */
export function registrableHostFromUrl(value: string): string {
  const url = new URL(normalizeHttpBaseUrl(value));
  const host = url.hostname.toLowerCase();
  if (isIpLiteralHost(host)) return host;
  const labels = host.split(".").filter(Boolean);
  if (labels.length < 2) return host;
  const tail = labels.slice(-2).join(".");
  return COMMON_TWO_PART_PUBLIC_SUFFIXES.has(tail) && labels.length >= 3
    ? labels.slice(-3).join(".")
    : tail;
}

/** L0 候选：注册主域（含非默认端口），如 `open.bigmodel.cn/api/paas/v4` → `bigmodel.cn`。 */
export function registrableRouteIdFromUpstreamUrl(value: string): string {
  const url = new URL(normalizeHttpBaseUrl(value));
  return composeRouteId(registrableHostFromUrl(value), upstreamPortSuffix(url), "");
}

/** path 首个有效段：滤噪音词（api/apps/openai）与版本段（v1~vN），如 `/api/coding/paas/v4` → `coding`。 */
function firstMeaningfulPathSegment(pathname: string): string | undefined {
  return pathname
    .split("/")
    .filter(Boolean)
    .filter(segment => !PATH_SEGMENT_NOISE.has(segment) && !/^v\d+$/.test(segment))
    .map(segment => normalizeRoutePart(segment))
    .find(Boolean);
}

/** L1 候选：注册主域 + path 首个有效段，如智谱双通道 → `bigmodel.cn` / `bigmodel.cn-coding`。 */
export function registrableTokenRouteIdFromUpstreamUrl(value: string): string {
  const base = registrableRouteIdFromUpstreamUrl(value);
  const token = firstMeaningfulPathSegment(new URL(normalizeHttpBaseUrl(value)).pathname);
  return token ? normalizeProxyRouteId(`${base}-${token}`) : base;
}

/** L1b 候选：有效子域标签（滤 api/open 等噪音）+ 注册主域，区分 `a.example.com` / `b.example.com`。 */
export function subdomainRouteIdFromUpstreamUrl(value: string): string {
  const url = new URL(normalizeHttpBaseUrl(value));
  const host = url.hostname.toLowerCase();
  if (isIpLiteralHost(host)) return registrableRouteIdFromUpstreamUrl(value);
  const labels = host.split(".").filter(Boolean);
  const registrable = registrableHostFromUrl(value);
  const subdomains = labels
    .slice(0, labels.length - registrable.split(".").length)
    .filter(label => !SUBDOMAIN_LABEL_NOISE.has(label))
    .map(label => normalizeRoutePart(label))
    .filter(Boolean);
  if (subdomains.length === 0) return registrableRouteIdFromUpstreamUrl(value);
  return normalizeProxyRouteId(
    `${subdomains.join("-")}-${registrable}${upstreamPortSuffix(url)}`,
  );
}

/** 参与路由 ID 判重的既有供应商；只需 id 与两个协议上游 URL。 */
export interface RouteIdOccupant {
  id: string;
  openaiUrl?: string;
  anthropicUrl?: string;
}

export type RouteIdConflictReason = "identical_upstream_urls" | "candidates_exhausted";

export type DerivedRouteIdResolution =
  | {status: "resolved"; id: string}
  | {status: "conflict"; reason: RouteIdConflictReason}
  | {status: "unavailable"};

/**
 * 新建供应商路由 ID 的统一候选链（短主域优先，冲突逐级加区分信息）：
 * L0 注册主域 → L1 主域+path 首个有效词 → L1b 有效子域+主域 → 短格式 → 全格式，
 * 每层内按 OpenAI → Anthropic 来源顺序。前面层级被已有供应商占用时逐级回退；
 * 全部候选用尽由调用方引导用户手动修改。单个来源 URL 非法时跳过该来源，不影响其余候选。
 */
export function deriveRouteIdCandidates(openaiUrl?: string, anthropicUrl?: string): string[] {
  const orderedSources = [openaiUrl, anthropicUrl];
  const candidates = new Set<string>();
  const collect = (derive: (value: string) => string) => {
    for (const value of orderedSources) {
      if (!value?.trim()) continue;
      try {
        candidates.add(derive(value));
      } catch {
        // 非法 URL 只影响自身来源
      }
    }
  };
  collect(registrableRouteIdFromUpstreamUrl);
  collect(registrableTokenRouteIdFromUpstreamUrl);
  collect(subdomainRouteIdFromUpstreamUrl);
  collect(shortRouteIdFromUpstreamUrl);
  collect(routeIdFromUpstreamUrl);
  return [...candidates];
}

/** 归一化上游 URL 供同 URL 对比较；空值与非法值分别用互不相等的占位表示。 */
function normalizeComparableUpstreamUrl(value?: string): string {
  if (!value?.trim()) return "";
  try {
    return normalizeHttpBaseUrl(value);
  } catch {
    return "\u0000invalid-url";
  }
}

/** 新供应商与某个已有供应商在两个协议位置的上游 URL 完全一致（如 MiniMax 按量与 Token Plan 共用端点）。 */
function hasIdenticalUpstreamPair(
  openaiUrl: string | undefined,
  anthropicUrl: string | undefined,
  existing: readonly RouteIdOccupant[],
): boolean {
  const openai = normalizeComparableUpstreamUrl(openaiUrl);
  const anthropic = normalizeComparableUpstreamUrl(anthropicUrl);
  return existing.some(item =>
    normalizeComparableUpstreamUrl(item.openaiUrl) === openai
    && normalizeComparableUpstreamUrl(item.anthropicUrl) === anthropic,
  );
}

/**
 * 按候选链解析第一个全局未占用的路由 ID；无可用上游 URL 时为 unavailable。
 * 同 URL 对（两个协议位置与某已有供应商完全一致）时 URL 本身不携带任何区分信息，
 * 直接判 conflict/identical_upstream_urls 引导手动填写——禁止靠协议顺序的遗留候选
 * （如拿对方的 anthropic 派生值）伪装成区分，那会生成语义错误的路由 ID。
 */
export function resolveDerivedRouteId(
  openaiUrl?: string,
  anthropicUrl?: string,
  existing: readonly RouteIdOccupant[] = [],
): DerivedRouteIdResolution {
  const candidates = deriveRouteIdCandidates(openaiUrl, anthropicUrl);
  if (candidates.length === 0) return {status: "unavailable"};
  if (hasIdenticalUpstreamPair(openaiUrl, anthropicUrl, existing)) {
    return {status: "conflict", reason: "identical_upstream_urls"};
  }
  const taken = new Set(existing.map(item => item.id.trim().toLowerCase()));
  const available = candidates.find(candidate => !taken.has(candidate));
  return available
    ? {status: "resolved", id: available}
    : {status: "conflict", reason: "candidates_exhausted"};
}

export function buildLocalProxyBaseUrl(
  baseUrl: string,
  targetId: string
): string {
  return `${baseUrl.replace(/\/+$/, "")}/${normalizeProxyRouteId(targetId)}`;
}

export function displayNameFromUpstreamUrl(value: string): string {
  try {
    const url = new URL(normalizeHttpBaseUrl(value));
    const labels = url.hostname.toLowerCase().split(".").filter(Boolean);
    const publicSuffixOffset = detectPublicSuffixOffset(labels);
    const domainLabels = labels.slice(0, Math.max(1, labels.length - publicSuffixOffset));
    const meaningfulLabels = domainLabels.filter(label => !HOST_NAME_NOISE.has(label));
    if (meaningfulLabels.length === 0) return routeIdFromUpstreamUrl(value);

    return meaningfulLabels.at(-1) || routeIdFromUpstreamUrl(value);
  } catch {
    return normalizeFallbackName(value);
  }
}

export function localBaseUrlPathPrefix(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.pathname.split("/").filter(Boolean)[0];
  } catch {
    return undefined;
  }
}

function normalizeRoutePart(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^\.+|\.+$/g, "")
    .replace(/^-+|-+$/g, "");
}

function detectPublicSuffixOffset(labels: string[]): number {
  const tail = labels.slice(-2).join(".");
  return COMMON_TWO_PART_PUBLIC_SUFFIXES.has(tail) ? 2 : 1;
}

function normalizeFallbackName(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .split(/[/?#]/)[0]
    ?.split(".")
    .filter(Boolean)
    .filter(label => !HOST_NAME_NOISE.has(label))
    .at(-1);
  return normalized || "proxy";
}

const HOST_NAME_NOISE = new Set([
  "api",
  "apis",
  "gateway",
  "gw",
  "proxy",
  "openapi",
  "www",
  "com",
  "cn",
  "net",
  "org",
  "io",
  "ai",
  "co",
  "uk",
  "us",
]);

const COMMON_TWO_PART_PUBLIC_SUFFIXES = new Set([
  "co.uk",
  "com.cn",
  "com.hk",
  "com.au",
  "co.jp",
  "co.kr",
]);

/** 子域噪音标签：平台前缀（api/open 等）不是品牌，进 L1b 只会制造无意义长度。 */
const SUBDOMAIN_LABEL_NOISE = new Set([
  "api",
  "apis",
  "gateway",
  "gw",
  "proxy",
  "openapi",
  "www",
  "open",
]);

/** path 噪音段：L1 只取首个有区分价值的段，端点骨架词与版本段不参与。 */
const PATH_SEGMENT_NOISE = new Set([
  "api",
  "apps",
  "openai",
]);
