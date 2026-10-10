/**
 * 国际官方上游出站代理（2026-10-08 引入；2026-10-10 用户确认两级化 + 模型门控）。
 *
 * 域白名单分两级：
 * - 全程隧道域：host 级封锁，与模型无关，命中即按代理探测结果决定隧道；
 * - 模型门控域：host 直连可达、但对国外系模型存在模型级地域封锁（用户实测
 *   opencode.ai 与 openrouter.ai：国产模型直连 OK、gpt/claude/gemini/grok 系
 *   直连被拒、开 VPN 正常）——仅当请求模型命中 VPN 家族才隧道，其余一律直连，
 *   绝不因系统代理存在而把国产模型劫持进 VPN。
 * 其余上游一律直连，字节级行为不变。影响隔离红线：两级白名单与 VPN 家族
 * 前缀都是代码常量，扩展时加一行即可，不引入独立配置文件。
 *
 * 代理来源优先级：显式 env `DEEPAA_UPSTREAM_PROXY` > macOS 系统代理
 * （`scutil --proxy` 的 HTTP/HTTPS 代理端口，60 秒缓存）。env 只替代探测
 * 端点、不豁免模型门控（2026-10-10 用户确认）。第一期只支持 HTTP 型代理
 * （CONNECT 隧道）；SOCKS-only 用户用 env 显式兜底。连接期隧道失败由
 * `UpstreamAgentPool` 的 `reportConnectFailure` 调 `invalidateOfficialUpstreamProxyCache`
 * 触发下一次请求重探测（自愈语义见 upstream-transport）。
 */
import {execFile} from "node:child_process";
import {isVpnTunnelModel} from "./upstream-model-gate";

/** 全程隧道域（host 级封锁，与模型无关；扩展时加一行）。 */
export const FULL_TUNNEL_UPSTREAM_HOSTS = [
  "chatgpt.com",
  "api.anthropic.com",
  "api.openai.com",
] as const;

/** 模型门控域：host 直连可达，但国外系模型被模型级地域封锁（用户实测）。 */
export const MODEL_GATED_TUNNEL_HOSTS = [
  "opencode.ai",
  "openrouter.ai",
] as const;

export interface UpstreamProxyEndpoint {
  host: string;
  port: number;
}

/**
 * 本地网关占位 token 镜像：代理 bundle 不能导入 web 侧 config-sync 模块，
 * 与 `src/lib/config-sync/core/placeholder-auth.ts` 的 GATEWAY_PLACEHOLDER_TOKEN
 * 由守卫测试锁定一致（项目「注册表镜像 + 守护测试」惯例）。
 */
export const PROXY_BUNDLE_PLACEHOLDER_TOKEN = "deepaa-gateway";

/** hostname 是否命中任一级白名单（精确或子域）。 */
export function isOfficialUpstreamHost(hostname: string): boolean {
  return isFullTunnelUpstreamHost(hostname) || isModelGatedUpstreamHost(hostname);
}

/** hostname 是否命中全程隧道域（精确或子域）。 */
export function isFullTunnelUpstreamHost(hostname: string): boolean {
  return hostMatchesList(hostname, FULL_TUNNEL_UPSTREAM_HOSTS);
}

/** hostname 是否命中模型门控域（精确或子域）。 */
export function isModelGatedUpstreamHost(hostname: string): boolean {
  return hostMatchesList(hostname, MODEL_GATED_TUNNEL_HOSTS);
}

function hostMatchesList(hostname: string, domains: readonly string[]): boolean {
  const host = hostname.trim().toLowerCase().replace(/^\[|\]$/gu, "");
  if (!host) return false;
  return domains.some(domain => host === domain || host.endsWith(`.${domain}`));
}

/**
 * 订阅透传目标收到的客户端 Authorization 是否为占位/缺失形态：
 * 该形态不可能通过官方鉴权，网关应本地报错（SUBSCRIPTION_LOGIN_REQUIRED）
 * 而不是转发一个必然失败的上游请求。
 */
export function isPlaceholderAuthorization(value: string | string[] | undefined): boolean {
  const normalized = (Array.isArray(value) ? value[0] : value)?.trim() ?? "";
  return normalized === "" || normalized === `Bearer ${PROXY_BUNDLE_PLACEHOLDER_TOKEN}`;
}

/** 解析显式代理 env（`http://host:port` 或 `host:port`）；仅接受 http 代理。 */
export function parseUpstreamProxyEnv(value: string | undefined): UpstreamProxyEndpoint | undefined {
  const raw = value?.trim();
  if (!raw) return undefined;
  try {
    const url = new URL(raw.includes("://") ? raw : `http://${raw}`);
    if (url.protocol !== "http:") return undefined;
    const port = Number(url.port);
    if (!url.hostname || !Number.isInteger(port) || port <= 0 || port > 65_535) return undefined;
    return {host: url.hostname, port};
  } catch {
    return undefined;
  }
}

const PROXY_CACHE_TTL_MS = 60_000;
const SCUTIL_TIMEOUT_MS = 3_000;

let cachedProxy: {endpoint: UpstreamProxyEndpoint | undefined; at: number} | undefined;
let refreshing: Promise<void> | undefined;

/**
 * 解析某 hostname（可选携带本次请求模型）的出站代理；非白名单域、以及
 * 门控域的非 VPN 家族模型（含无模型请求）直接返回 undefined——零开销直连，
 * 不触发系统代理探测。env 显式配置优先于系统代理探测；探测结果带 60 秒缓存。
 */
export async function resolveOfficialUpstreamProxy(
  hostname: string,
  modelId?: string,
): Promise<UpstreamProxyEndpoint | undefined> {
  if (isFullTunnelUpstreamHost(hostname)) return resolveConfiguredProxy();
  if (isModelGatedUpstreamHost(hostname) && isVpnTunnelModel(modelId)) return resolveConfiguredProxy();
  return undefined;
}

async function resolveConfiguredProxy(): Promise<UpstreamProxyEndpoint | undefined> {
  const fromEnv = parseUpstreamProxyEnv(process.env.DEEPAA_UPSTREAM_PROXY);
  if (fromEnv) return fromEnv;
  if (cachedProxy && Date.now() - cachedProxy.at < PROXY_CACHE_TTL_MS) return cachedProxy.endpoint;
  refreshing ??= detectMacSystemProxy()
    .then(endpoint => {
      cachedProxy = {endpoint, at: Date.now()};
    })
    .finally(() => {
      refreshing = undefined;
    });
  await refreshing;
  return cachedProxy?.endpoint;
}

/**
 * 失效探测缓存（连接期隧道失败自愈）：下一次 resolveOfficialUpstreamProxy
 * 重新探测系统代理。进行中的探测不受影响（其结果仍会写入缓存）。
 */
export function invalidateOfficialUpstreamProxyCache(): void {
  cachedProxy = undefined;
}

/** 测试隔离钩子：清空探测缓存。 */
export function resetOfficialUpstreamProxyCacheForTests(): void {
  cachedProxy = undefined;
}

/** 测试隔离钩子：强制注入探测结果（undefined = 视为无系统代理），绕过真实 scutil。 */
export function setOfficialUpstreamProxyForTests(endpoint: UpstreamProxyEndpoint | undefined): void {
  cachedProxy = {endpoint, at: Date.now()};
}

function detectMacSystemProxy(): Promise<UpstreamProxyEndpoint | undefined> {
  if (process.platform !== "darwin") return Promise.resolve(undefined);
  return new Promise(resolve => {
    execFile("/usr/sbin/scutil", ["--proxy"], {timeout: SCUTIL_TIMEOUT_MS}, (error, stdout) => {
      if (error) return resolve(undefined);
      resolve(parseScutilProxy(stdout));
    });
  });
}

/** 解析 `scutil --proxy` 输出：HTTPS 代理优先，回落 HTTP 代理；未启用返回 undefined。 */
export function parseScutilProxy(output: string): UpstreamProxyEndpoint | undefined {
  return matchScutilValues(output, "HTTPS") ?? matchScutilValues(output, "HTTP");
}

function matchScutilValues(output: string, prefix: "HTTP" | "HTTPS"): UpstreamProxyEndpoint | undefined {
  const enable = matchScutilValue(output, `${prefix}Enable`);
  const host = matchScutilValue(output, `${prefix}Proxy`);
  const port = matchScutilValue(output, `${prefix}Port`);
  if (enable !== "1" || !host || !port) return undefined;
  const portNumber = Number(port);
  if (!Number.isInteger(portNumber) || portNumber <= 0 || portNumber > 65_535) return undefined;
  return {host, port: portNumber};
}

function matchScutilValue(output: string, key: string): string | undefined {
  const match = output.match(new RegExp(`^\\s*${key}\\s*:\\s*(.+?)\\s*$`, "mu"));
  return match?.[1];
}
