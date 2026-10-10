import {
  SyncAuthRequiredError,
  type CredentialComparisonItem,
  type RateSnapshotInput,
  type SyncConnector,
  type SyncInput,
  type SyncResult,
} from "../types";

const NEW_API_TIMEOUT_MS = 15_000;
const NEW_API_TOKEN_PAGE_SIZE = 100;
/**
 * New API 的倍率约定：ratio 1 = $0.002 / 1K token = $2 / 1M token。
 * model_ratio × 2 即输入绝对价（USD/1M）；输出价再乘 completion_ratio（缺省 1）。
 */

export type NewApiFetch = typeof fetch;

interface NewApiSelfData {
  quota?: number;
  used_quota?: number;
  group?: string;
  username?: string;
}

interface NewApiTokenItem {
  id?: number;
  name?: string;
  key?: string;
  group?: string;
  status?: number;
}

export interface NewApiPayloads {
  self: unknown;
  tokens: unknown;
  pricing: unknown;
}

export interface ResolvedCredentialKey {
  id: string;
  label: string;
  key: string;
}

/**
 * New API 登录会话：access_token（二开站返回）或标准 one-api/New API 的
 * 会话 Cookie（登录成功只回 {success:true}，凭 Cookie 调面板接口）。
 */
export interface NewApiSession {
  accessToken?: string;
  cookie?: string;
  /**
   * 面板用户 id：新版 New API 的鉴权面板接口（/api/user/self、/api/token/）在
   * 会话 Cookie 之外强制要求 `New-Api-User: <id>` 头，缺失直接 401。
   */
  userId?: string;
}

/**
 * New API 用户名密码登录：返回 access_token 或会话 Cookie。
 * 站方可开启 Turnstile/2FA，纯 HTTP 登录失败时抛 SyncAuthRequiredError，
 * 由调用方决定是否降级 Playwright 登录器。
 * 标准 one-api/New API 部署登录成功不返回 access_token，只下发 session Cookie；
 * 账号密码错误时 success=false（HTTP 仍 200），必须先于“缺 token”判断给出准确提示。
 */
export async function newApiLoginWithSession(
  consoleBaseUrl: string,
  username: string,
  password: string,
  fetchImpl: NewApiFetch = fetch,
): Promise<NewApiSession> {
  const loginUrl = `${stripTrailingSlash(consoleBaseUrl)}/api/user/login`;
  let response: Response;
  try {
    response = await fetchImpl(
      loginUrl,
      {
        method: "POST",
        headers: {"content-type": "application/json"},
        body: JSON.stringify({username, password}),
        signal: AbortSignal.timeout(NEW_API_TIMEOUT_MS),
      },
    );
  } catch (error) {
    throw new SyncAuthRequiredError(
      `SYNC_LOGIN_NETWORK_ERROR：无法连接 ${loginUrl}（${error instanceof Error ? error.message : String(error)}），请检查控制台地址与网络`,
    );
  }
  // 路径不存在：多为站点类型/控制台地址不匹配（如 one-api 新版 fork 走 /api/v1/auth/login），
  // 直接给出可操作提示，避免用户误以为是账号密码或 playwright 的问题。
  if (response.status === 404 || response.status === 405) {
    throw new SyncAuthRequiredError(
      `SYNC_LOGIN_PATH_NOT_FOUND：${loginUrl} 不存在（HTTP ${response.status}）。`
      + "请确认控制台地址正确，且该站点是标准 New API 中转站（登录接口 /api/user/login）；"
      + "部分 one-api 衍生站使用 /api/v1/auth/login 等其他路径，当前适配器不支持",
    );
  }
  let json: unknown;
  try {
    json = await response.json();
  } catch {
    throw new SyncAuthRequiredError(
      `SYNC_LOGIN_RESPONSE_INVALID：${loginUrl} 返回的不是 JSON（HTTP ${response.status}），`
      + "站点可能不是标准 New API 或控制台地址不对",
    );
  }
  const body = asRecord(json);
  const message = typeof body?.message === "string" ? body.message : "";
  if (body?.success === false) {
    throw new SyncAuthRequiredError(
      `SYNC_LOGIN_FAILED（HTTP ${response.status}）：用户名或密码错误${message ? `：${message}` : ""}`,
    );
  }
  const data = asRecord(body?.data);
  const accessToken = typeof data?.access_token === "string" && data.access_token
    ? data.access_token
    : undefined;
  // 标准 one-api/New API：data 是用户对象（含数字 id），供 New-Api-User 头使用。
  const rawData = body?.data;
  const rawUserId = data && data.id !== undefined ? data.id : typeof rawData === "number" ? rawData : undefined;
  const userId = typeof rawUserId === "number" && Number.isFinite(rawUserId)
    ? String(rawUserId)
    : typeof rawUserId === "string" && rawUserId.trim() && Number.isFinite(Number(rawUserId))
      ? rawUserId.trim()
      : undefined;
  const headers = response.headers as Headers & {getSetCookie?: () => string[]};
  const cookie = typeof headers.getSetCookie === "function"
    ? headers.getSetCookie()
      .map(item => item.split(";", 1)[0]?.trim() ?? "")
      .filter(Boolean)
      .join("; ") || undefined
    : undefined;
  if (!response.ok || (!accessToken && !cookie)) {
    throw new SyncAuthRequiredError(
      `SYNC_LOGIN_FAILED（HTTP ${response.status}）${message ? `：${message}` : "，登录响应既未返回 access_token，也未建立会话 Cookie"}`
      + "；若站点开启验证码 / 2FA，将尝试浏览器登录",
    );
  }
  return {accessToken, cookie, userId};
}

/** 兼容旧签名：只取 access_token 的登录；纯会话站点请使用 newApiLoginWithSession。 */
export async function newApiLogin(
  consoleBaseUrl: string,
  username: string,
  password: string,
  fetchImpl: NewApiFetch = fetch,
): Promise<string> {
  const session = await newApiLoginWithSession(consoleBaseUrl, username, password, fetchImpl);
  if (!session.accessToken) {
    throw new SyncAuthRequiredError(
      "SYNC_LOGIN_NO_ACCESS_TOKEN：站点登录成功但未返回 access_token（会话 Cookie 登录）；请改用支持会话登录的同步入口",
    );
  }
  return session.accessToken;
}

/** 用登录态（access_token 或会话 Cookie）拉取余额/令牌/定价三份数据。 */
export async function newApiSyncWithToken(
  consoleBaseUrl: string,
  auth: string | NewApiSession,
  fetchImpl: NewApiFetch = fetch,
): Promise<NewApiPayloads> {
  const base = stripTrailingSlash(consoleBaseUrl);
  const session = typeof auth === "string" ? {accessToken: auth} : auth;
  const headers: Record<string, string> = {"content-type": "application/json"};
  if (session.accessToken) headers.authorization = `Bearer ${session.accessToken}`;
  if (session.cookie) headers.cookie = session.cookie;
  if (session.userId) headers["new-api-user"] = session.userId;
  const [self, tokens, pricing] = await Promise.all([
    getJson(`${base}/api/user/self`, headers, fetchImpl),
    // New API 当前接口返回分页对象；显式使用服务端允许的单页最大值，
    // 避免默认仅取 10 条导致本地密钥被误报为远程不存在。
    getJson(`${base}/api/token/?p=1&size=${NEW_API_TOKEN_PAGE_SIZE}`, headers, fetchImpl),
    // /api/pricing 同时提供分组倍率（group_ratio）与模型价表；模型价链路已移除，
    // 仅保留分组倍率供密钥倍率快照使用。
    getJson(`${base}/api/pricing`, headers, fetchImpl).catch(() => undefined),
  ]);
  return {self, tokens, pricing};
}


/**
 * 解析 New API 三份 payload：余额 = quota/500000（USD）；
 * 密钥倍率 = 有效计费分组 → /api/pricing 的 group_ratio。
 * 有效计费分组镜像 New API 计费语义（middleware/auth.go）：令牌分组非空时以其为准
 * （"auto" 无法由 group_ratio 还原，查不到即跳过、保持黄标提醒），为空时跟随用户分组。
 */
export function parseNewApiPayloads(
  payloads: NewApiPayloads,
  resolvedCredentials: ResolvedCredentialKey[],
): SyncResult {
  const self = asRecord(payloads.self);
  const selfData = asRecord(self?.data);
  // 标准 New API/one-api 的 /api/pricing：group_ratio 与 data 平级（data 是模型价目数组）。
  // 2026-10-10 1yuanapi 事故：旧实现只读 data.group_ratio（把模型数组当分组容器），
  // 对全部标准站点永远拿不到分组倍率；嵌套形态仅个别 fork 存在，保留作兼容兜底。
  const pricingRecord = asRecord(payloads.pricing);
  const groupRatio = asRecord(pricingRecord?.group_ratio)
    ?? asRecord(asRecord(pricingRecord?.data)?.group_ratio);
  const userGroup = typeof selfData?.group === "string" && selfData.group
    ? selfData.group
    : undefined;
  const tokenData = asRecord(payloads.tokens)?.data;
  const tokenItems = Array.isArray(tokenData)
    ? tokenData
    : Array.isArray(asRecord(tokenData)?.items)
      ? (asRecord(tokenData)!.items as unknown[])
      : [];

  const balance: SyncResult["balance"] = selfData
    && typeof selfData.quota === "number"
    ? {
        currency: "USD",
        amount: selfData.quota / 500_000,
        quota: selfData.quota,
        usedQuota: typeof selfData.used_quota === "number" ? selfData.used_quota : undefined,
        source: "newapi",
        raw: payloads.self,
      }
    : undefined;

  const rates: RateSnapshotInput[] = [];
  for (const item of tokenItems) {
    const token = asRecord(item);
    if (!token || !newApiTokenIsActive(token.status)) continue;
    const group = resolveNewApiBillingGroup(token.group, userGroup);
    const ratio = group && groupRatio ? groupRatio[group] : undefined;
    if (typeof ratio !== "number" || !Number.isFinite(ratio) || ratio < 0) continue;
    const key = typeof token.key === "string" ? token.key : "";
    if (!key) continue;
    for (const credential of resolvedCredentials) {
      if (credential.key && tokenMatchesMaskedKey(key, credential.key)) {
        rates.push({
          credentialId: credential.id,
          tokenGroup: group,
          ratio,
          source: "auto_group",
        });
        break;
      }
    }
  }

  // 按密钥粒度的远程对比：遍历系统维护的每个密钥，标注远程是否找到匹配及原因。
  const credentialComparison: CredentialComparisonItem[] = resolvedCredentials.map(credential => {
    const remoteToken = tokenItems
      .map(item => asRecord(item))
      .find(token => token && credential.key && tokenMatchesMaskedKey(
        typeof token.key === "string" ? token.key : "",
        credential.key,
      ));
    if (!remoteToken) {
      return {
        credentialId: credential.id,
        label: credential.label,
        matched: false,
        reason: "对方网站未找到匹配密钥（可能已删除、停用或密钥不在此账号下）",
      };
    }
    const active = newApiTokenIsActive(remoteToken.status);
    const group = resolveNewApiBillingGroup(remoteToken.group, userGroup);
    const ratio = group && groupRatio ? groupRatio[group] : undefined;
    return {
      credentialId: credential.id,
      label: credential.label,
      matched: active,
      remoteName: typeof remoteToken.name === "string" && remoteToken.name ? remoteToken.name : undefined,
      ...(active && Number.isSafeInteger(remoteToken.id) && (remoteToken.id as number) > 0
        ? {remoteKeyId: String(remoteToken.id)} : {}),
      ...(active && typeof ratio === "number" && Number.isFinite(ratio) && ratio >= 0 ? {ratio} : {}),
      ...(!active ? {reason: "对方网站该密钥已停用"} : {}),
    };
  });
  return {
    providerType: "newapi",
    ...(balance ? {balance} : {}),
    ...(rates.length > 0 ? {rates} : {}),
    credentialComparison,
  };
}

/**
 * 掩码 key 匹配：兼容旧版带 sk- 前缀/四星掩码，以及当前 New API
 * 省略 sk- 前缀并使用连续十星掩码的返回格式。
 */
export function tokenMatchesMaskedKey(maskedKey: string, fullKey: string): boolean {
  if (!maskedKey || !fullKey) return false;
  const normalizedMasked = stripApiKeyPrefix(maskedKey.trim());
  const normalizedFull = stripApiKeyPrefix(fullKey.trim());
  const mask = normalizedMasked.match(/^([^*]+)\*+([^*]+)$/u);
  if (!mask) return normalizedMasked === normalizedFull;
  const [, head, tail] = mask;
  if (!head || !tail) return false;
  return normalizedFull.startsWith(head) && normalizedFull.endsWith(tail);
}

/** HTTP 主链路适配器。 */
export class NewApiAdapter implements SyncConnector {
  readonly providerType = "newapi" as const;
  readonly capabilities = {balance: true, rates: true, quota: false, auth: "http" as const};

  constructor(private readonly fetchImpl: NewApiFetch = fetch) {}

  async sync(input: SyncInput): Promise<SyncResult> {
    const session = await newApiLoginWithSession(
      input.consoleBaseUrl,
      input.username,
      input.password,
      this.fetchImpl,
    );
    const payloads = await newApiSyncWithToken(
      input.consoleBaseUrl,
      session,
      this.fetchImpl,
    );
    const resolved = await Promise.all(input.credentials.map(async credential => ({
      id: credential.id,
      label: credential.label,
      key: await input.resolveCredential(credential.id),
    })));
    return parseNewApiPayloads(payloads, resolved);
  }
}

async function getJson(
  url: string,
  headers: Record<string, string>,
  fetchImpl: NewApiFetch,
): Promise<unknown> {
  const response = await fetchImpl(url, {
    headers: {...headers, "content-type": "application/json"},
    signal: AbortSignal.timeout(NEW_API_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`SYNC_HTTP_${response.status}`);
  }
  return await response.json();
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/u, "");
}

function stripApiKeyPrefix(value: string): string {
  return value.toLowerCase().startsWith("sk-") ? value.slice(3) : value;
}

/**
 * 令牌的有效计费分组：镜像 New API 计费语义（middleware/auth.go 的 TokenAuth）——
 * 令牌分组非空时覆盖用户分组；为空/缺失时跟随用户分组（/api/user/self 的 group）。
 * "auto" 是令牌分组的有效取值，原样返回：自动分组链路无法由 group_ratio 精确还原，
 * 查不到倍率时保持「远端未返回有效倍率」提醒，绝不误回退到用户分组。
 */
function resolveNewApiBillingGroup(
  tokenGroup: unknown,
  userGroup: string | undefined,
): string | undefined {
  if (typeof tokenGroup === "string" && tokenGroup) return tokenGroup;
  return userGroup;
}

/** New API 当前状态 1 为启用；旧实现的 0 及当前的 2/3/4 均不可用于倍率快照。 */
function newApiTokenIsActive(status: unknown): boolean {
  return status === undefined || status === 1 || status === "active";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
