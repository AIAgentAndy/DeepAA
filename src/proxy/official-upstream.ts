/**
 * 国际官方上游出站代理（2026-10-08 用户确认）。
 *
 * 仅白名单域名允许经用户系统代理出站（国内网络下 Node 进程不读系统代理、
 * 直连官方域超时的根因修复）；其余上游一律直连，字节级行为不变。影响隔离红线：
 * 白名单是代码常量，扩展时加一行即可，不引入独立配置文件。
 *
 * 代理来源优先级：显式 env `DEEPAA_UPSTREAM_PROXY` > macOS 系统代理
 * （`scutil --proxy` 的 HTTP/HTTPS 代理端口，60 秒缓存，失败静默回退直连）。
 * 第一期只支持 HTTP 型代理（CONNECT 隧道）；SOCKS-only 用户用 env 显式兜底。
 */
import {execFile} from "node:child_process";

/** 国际官方上游域白名单（2026-10-08 用户确认；扩展时加一行）。 */
export const OFFICIAL_UPSTREAM_HOSTS = [
  "chatgpt.com",
  "api.anthropic.com",
  "api.openai.com",
  "openrouter.ai",
  "opencode.ai",
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

/** hostname 是否命中官方上游白名单（精确或子域）。 */
export function isOfficialUpstreamHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/^\[|\]$/gu, "");
  if (!host) return false;
  return OFFICIAL_UPSTREAM_HOSTS.some(domain => host === domain || host.endsWith(`.${domain}`));
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
 * 解析某 hostname 的出站代理；非白名单域直接返回 undefined（零开销直连）。
 * env 显式配置优先于系统代理探测；探测结果带 60 秒缓存。
 */
export async function resolveOfficialUpstreamProxy(
  hostname: string,
): Promise<UpstreamProxyEndpoint | undefined> {
  if (!isOfficialUpstreamHost(hostname)) return undefined;
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
