import {
  SyncAuthRequiredError,
  type CredentialComparisonItem,
  type RateSnapshotInput,
  type SyncConnector,
  type SyncInput,
  type SyncResult,
} from "../types";
import {tokenMatchesMaskedKey} from "./newapi";

const SUB2API_TIMEOUT_MS = 15_000;

export type Sub2ApiFetch = typeof fetch;

interface Sub2ApiProfileData {
  balance?: number;
  frozen_balance?: number;
  username?: string;
  email?: string;
}

interface Sub2ApiKeyItem {
  id?: number;
  key?: string;
  name?: string;
  group_id?: number | null;
  /** keys 列表每个 key 自带分组对象（含 rate_multiplier），是最可靠的倍率来源。 */
  group?: {
    id?: number;
    name?: string;
    rate_multiplier?: number;
  } | null;
  status?: string;
}

export interface Sub2ApiPayloads {
  profile: unknown;
  keys: unknown;
  rates: unknown;
}

export interface ResolvedCredentialKey {
  id: string;
  label: string;
  key: string;
}

/**
 * sub2api 用户名密码登录：POST /api/v1/auth/login，body {email, password}。
 * 站方可开启验证码（Turnstile/腾讯）或 TOTP 2FA，纯 HTTP 失败时抛
 * SyncAuthRequiredError，由调用方决定是否降级 Playwright 登录。
 * 成功响应 data 形如 {access_token, refresh_token, token_type, user}。
 */
export async function sub2ApiLogin(
  consoleBaseUrl: string,
  email: string,
  password: string,
  fetchImpl: Sub2ApiFetch = fetch,
): Promise<string> {
  const loginUrl = `${stripTrailingSlash(consoleBaseUrl)}/api/v1/auth/login`;
  let response: Response;
  try {
    response = await fetchImpl(
      loginUrl,
      {
        method: "POST",
        headers: {"content-type": "application/json"},
        body: JSON.stringify({email, password}),
        signal: AbortSignal.timeout(SUB2API_TIMEOUT_MS),
      },
    );
  } catch (error) {
    throw new SyncAuthRequiredError(
      `SYNC_LOGIN_NETWORK_ERROR：无法连接 ${loginUrl}（${error instanceof Error ? error.message : String(error)}），请检查控制台地址与网络`,
    );
  }
  // 路径不存在：站点类型/控制台地址不匹配，给出可操作提示。
  if (response.status === 404 || response.status === 405) {
    throw new SyncAuthRequiredError(
      `SYNC_LOGIN_PATH_NOT_FOUND：${loginUrl} 不存在（HTTP ${response.status}）。`
      + "请确认控制台地址正确，且该站点是 Sub2API 中转站（登录接口 /api/v1/auth/login）",
    );
  }
  let json: unknown;
  try {
    json = await response.json();
  } catch {
    throw new SyncAuthRequiredError(
      `SYNC_LOGIN_RESPONSE_INVALID：${loginUrl} 返回的不是 JSON（HTTP ${response.status}），`
      + "站点可能不是 Sub2API 或控制台地址不对",
    );
  }
  const body = asRecord(json);
  const data = asRecord(body?.data);
  // 2FA：登录成功后返回 requires_2fa + temp_token，HTTP 链路无法完成，需要浏览器人工登录。
  if (data && data.requires_2fa === true) {
    throw new SyncAuthRequiredError(
      "SYNC_LOGIN_2FA_REQUIRED：该账号开启了两步验证（TOTP），HTTP 登录无法完成，需要浏览器人工登录一次",
    );
  }
  const accessToken = typeof data?.access_token === "string" ? data.access_token : undefined;
  if (!response.ok || !accessToken) {
    const message = typeof body?.message === "string" ? body.message : "登录响应缺少 access_token";
    const reason = typeof body?.reason === "string" ? body.reason : "";
    throw new SyncAuthRequiredError(
      `SYNC_LOGIN_FAILED（HTTP ${response.status}）：${message}${reason ? `（${reason}）` : ""}`
      + "；若站点开启验证码，将尝试浏览器登录",
    );
  }
  return accessToken;
}

/** 用会话 token 拉取用户信息 / 密钥列表 / 分组倍率三份数据（模型价链路已移除）。 */
export async function sub2ApiSyncWithToken(
  consoleBaseUrl: string,
  accessToken: string,
  fetchImpl: Sub2ApiFetch = fetch,
): Promise<Sub2ApiPayloads> {
  const base = stripTrailingSlash(consoleBaseUrl);
  const headers = {authorization: `Bearer ${accessToken}`};
  const [profile, keys, rates] = await Promise.all([
    getJson(`${base}/api/v1/user/profile`, headers, fetchImpl),
    getJson(`${base}/api/v1/keys?page=1&page_size=200`, headers, fetchImpl),
    getJson(`${base}/api/v1/groups/rates`, headers, fetchImpl).catch(() => undefined),
  ]);
  return {profile, keys, rates};
}

/**
 * 解析 sub2api 三份 payload：余额 = data.balance（USD，直接金额）；
 * 密钥倍率 = key.group_id → data.group_rates[groupId]；
 * 本地密钥与远端 key 先全等匹配，再掩码头尾匹配兜底。
 */
export function parseSub2ApiPayloads(
  payloads: Sub2ApiPayloads,
  resolvedCredentials: ResolvedCredentialKey[],
): SyncResult {
  const profileData = asRecord(asRecord(payloads.profile)?.data) as Sub2ApiProfileData | undefined;
  const balance: SyncResult["balance"] = profileData
    && typeof profileData.balance === "number"
    ? {
        currency: "USD",
        amount: profileData.balance,
        usedQuota: typeof profileData.frozen_balance === "number" ? profileData.frozen_balance : undefined,
        source: "sub2api",
        raw: payloads.profile,
      }
    : undefined;

  // groups/rates 响应：GetUserGroupRates 返回 map[groupID]ratio，data 直接是 {"1": 0.9}；
  // 兼容历史部署的 data.group_rates 包装。
  const ratesData = asRecord(asRecord(payloads.rates)?.data);
  const groupRates = asRecord(ratesData?.group_rates) ?? (
    ratesData && Object.keys(ratesData).length > 0 ? ratesData : undefined
  );
  const keysData = asRecord(payloads.keys)?.data;
  const keyItems = asRecord(keysData) && Array.isArray((keysData as Record<string, unknown>).items)
    ? ((keysData as Record<string, unknown>).items as unknown[])
    : [];

  const rates: RateSnapshotInput[] = [];
  for (const item of keyItems) {
    const keyItem = asRecord(item) as Sub2ApiKeyItem | undefined;
    if (!keyItem || (keyItem.status && keyItem.status !== "active")) continue;
    const remoteKey = typeof keyItem.key === "string" ? keyItem.key : "";
    if (!remoteKey) continue;
    const groupId = typeof keyItem.group_id === "number" ? String(keyItem.group_id) : undefined;
    // 优先取 key 自带分组的倍率；未带分组时回退 groups/rates 按分组 ID 匹配。
    const ownRatio = typeof keyItem.group?.rate_multiplier === "number"
      ? keyItem.group.rate_multiplier
      : undefined;
    const ratio = ownRatio ?? (groupId && groupRates ? groupRates[groupId] : undefined);
    if (typeof ratio !== "number" || !Number.isFinite(ratio) || ratio < 0) continue;
    for (const credential of resolvedCredentials) {
      if (credential.key && sub2ApiKeyMatches(remoteKey, credential.key)) {
        rates.push({
          credentialId: credential.id,
          tokenGroup: groupId,
          ratio,
          source: "auto_group",
        });
        break;
      }
    }
  }

  // 按密钥粒度的远程对比：遍历系统维护的每个密钥，标注远程是否找到匹配及原因。
  const credentialComparison: CredentialComparisonItem[] = resolvedCredentials.map(credential => {
    const remoteItem = keyItems
      .map(item => asRecord(item) as Sub2ApiKeyItem | undefined)
      .find(item => item && credential.key && sub2ApiKeyMatches(
        typeof item.key === "string" ? item.key : "",
        credential.key,
      ));
    if (!remoteItem) {
      return {
        credentialId: credential.id,
        label: credential.label,
        matched: false,
        reason: "对方网站未找到匹配密钥（可能已删除、停用或密钥不在此账号下）",
      };
    }
    const active = !remoteItem.status || remoteItem.status === "active";
    const groupId = typeof remoteItem.group_id === "number" ? String(remoteItem.group_id) : undefined;
    const ownRatio = typeof remoteItem.group?.rate_multiplier === "number"
      ? remoteItem.group.rate_multiplier
      : undefined;
    const ratio = ownRatio ?? (groupId && groupRates ? groupRates[groupId] : undefined);
    return {
      credentialId: credential.id,
      label: credential.label,
      matched: active,
      remoteName: typeof remoteItem.name === "string" && remoteItem.name ? remoteItem.name : undefined,
      ...(active && Number.isSafeInteger(remoteItem.id) && (remoteItem.id ?? 0) > 0
        ? {remoteKeyId: String(remoteItem.id)} : {}),
      ...(active && typeof ratio === "number" && Number.isFinite(ratio) && ratio >= 0 ? {ratio} : {}),
      ...(!active ? {reason: "对方网站该密钥已停用（status 非 active）"} : {}),
    };
  });
  return {
    providerType: "sub2api",
    ...(balance ? {balance} : {}),
    ...(rates.length > 0 ? {rates} : {}),
    credentialComparison,
  };
}

/** sub2api 密钥匹配：远端可能返回完整 key 或掩码（sk-abc****defg），先全等再掩码头尾匹配。 */
export function sub2ApiKeyMatches(remoteKey: string, fullKey: string): boolean {
  if (!remoteKey || !fullKey) return false;
  if (remoteKey === fullKey) return true;
  return tokenMatchesMaskedKey(remoteKey, fullKey);
}

/** HTTP 主链路适配器。 */
export class Sub2ApiAdapter implements SyncConnector {
  readonly providerType = "sub2api" as const;
  readonly capabilities = {balance: true, rates: true, quota: false, auth: "http" as const};

  constructor(private readonly fetchImpl: Sub2ApiFetch = fetch) {}

  async sync(input: SyncInput): Promise<SyncResult> {
    const accessToken = await sub2ApiLogin(
      input.consoleBaseUrl,
      input.username,
      input.password,
      this.fetchImpl,
    );
    const payloads = await sub2ApiSyncWithToken(
      input.consoleBaseUrl,
      accessToken,
      this.fetchImpl,
    );
    const resolved = await Promise.all(input.credentials.map(async credential => ({
      id: credential.id,
      label: credential.label,
      key: await input.resolveCredential(credential.id),
    })));
    return parseSub2ApiPayloads(payloads, resolved);
  }
}

async function getJson(
  url: string,
  headers: Record<string, string>,
  fetchImpl: Sub2ApiFetch,
): Promise<unknown> {
  const response = await fetchImpl(url, {
    headers: {...headers, "content-type": "application/json"},
    signal: AbortSignal.timeout(SUB2API_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`SYNC_HTTP_${response.status}`);
  }
  return await response.json();
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/u, "");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
