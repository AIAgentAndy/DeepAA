/**
 * 本地回环端点单一事实源（2026-09-19 用户确认全站统一 127.0.0.1）。
 *
 * 为什么必须是 127.0.0.1 而不是 localhost：浏览器把 localhost 与 127.0.0.1
 * 视为两个不同的 cookie 站点（站点判定不看端口但看主机）。dsh Web 的会话
 * cookie 是 SameSite=Strict，DeepAA 页面（localhost 别名）发起的弹窗/跨站
 * 导航会被浏览器扣发该 cookie，dsh 表现为 401「authentication required」；
 * 且刷新会继承标签页最初的跨站标记，只有地址栏回车这类无发起方导航能恢复。
 * 因此所有对外展示与写盘的本地地址一律使用 127.0.0.1，存量 localhost 值在
 * 读取与写入前经 normalizeLoopbackAliasBaseUrl 归一化。
 *
 * 注意：本文件会被 web 侧模块引用；代理 bundle 内的模块（如 agent-registry）
 * 保持字面量，禁止把 web 侧依赖引入代理构建边界。
 */

/** 本地网关（3211 代理）的规范地址，端口与 PROXY_PORT 环境变量约定一致。 */
export const DEFAULT_GATEWAY_BASE_URL = "http://127.0.0.1:3211";

/** dsh Web UI 常驻服务（与 src/lib/development-launch/strategies/dsh.ts 的端口探测一致）。 */
export const DSH_WEB_PORT = 3080;

export const DSH_WEB_URL = `http://127.0.0.1:${DSH_WEB_PORT}`;

/** 判定是否为需要归一化的 loopback 别名主机（127.x 字面量本身无需处理）。 */
export function isLoopbackAliasHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === "localhost" || normalized === "::1" || normalized === "[::1]";
}

/**
 * 把 URL 中的 loopback 别名主机（localhost/::1/[::1]）归一化为 127.0.0.1，
 * 其余 URL（含用户自定义主机、上游供应商地址）原样返回；非法输入按 trim 原样返回。
 * 只应作用于「本地入口地址」的展示与写盘路径，绝不作用于供应商上游 URL。
 */
export function normalizeLoopbackAliasBaseUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return trimmed;
  try {
    const url = new URL(trimmed);
    if (isLoopbackAliasHostname(url.hostname)) {
      const port = url.port ? `:${url.port}` : "";
      const path = url.pathname === "/" ? "" : url.pathname;
      return `${url.protocol}//127.0.0.1${port}${path}${url.search}${url.hash}`;
    }
  } catch {
    // 非 URL 输入不在此处报错，由调用方的专用校验负责
  }
  return trimmed;
}

/**
 * 广义回环主机判定（localhost/::1/[::1] 与 127.0.0.0/8 字面量）。
 * web 侧各 Origin/Host 安全闸门共用一份，保证「同时接受全部回环别名、不得收紧」的口径只有一处实现。
 */
export function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === "localhost"
    || normalized === "::1"
    || normalized === "[::1]"
    || /^127(?:\.\d{1,3}){3}$/.test(normalized);
}

/**
 * 判断两个 URL 是否指同一本机入口：host:port 逐字相等，或双方均为回环主机且端口相同。
 * Next 生产服务会把路由处理器的 request.url 主机名规范化为 localhost，与实际 Host 头
 * （127.0.0.1 等回环别名）字面不同但同机等价；安全闸门比较 Host/Origin 与 request.url 时
 * 必须按该等价判定，非回环主机与端口不符仍然拒绝（防 DNS rebinding / 跨站伪造）。
 */
export function isSameLocalEntrypoint(a: URL, b: URL): boolean {
  if (a.host.toLowerCase() === b.host.toLowerCase()) return true;
  return isLoopbackHostname(a.hostname) && isLoopbackHostname(b.hostname) && a.port === b.port;
}

/**
 * 解析规范化的本地网关入口：空值回退规范缺省，loopback 别名归一化为 127.0.0.1，
 * 并去除尾随斜杠。展示端（弹窗、接入页、预览）与写盘端（CLI 配置同步）共用。
 */
export function resolveGatewayBaseUrl(value: string | undefined | null): string {
  const raw = typeof value === "string" ? value.trim() : "";
  const normalized = normalizeLoopbackAliasBaseUrl(raw || DEFAULT_GATEWAY_BASE_URL);
  return normalized.replace(/\/+$/u, "");
}
