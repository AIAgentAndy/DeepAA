import type {NewApiSession} from "../adapters/newapi";
import {newApiLoginWithSession} from "../adapters/newapi";
import {sub2ApiLogin} from "../adapters/sub2api";

/**
 * 对账专用登录会话短期复用（2026-09-26 用户确认）。
 * 小时复核每个小时都可能触达站点，逐次登录会形成登录风暴（catapi 实测自锁）；
 * 会话只缓存在内存、绝不落盘，TTL 到期或站点鉴权失败后重新登录。
 */
const SESSION_TTL_MS = 10 * 60_000;

interface CachedSub2Api {
  token: string;
  fetchedAt: number;
}
interface CachedNewApi {
  session: NewApiSession;
  fetchedAt: number;
}

const sub2ApiCache = new Map<string, CachedSub2Api>();
const newApiCache = new Map<string, CachedNewApi>();

function cacheKey(consoleBaseUrl: string, username: string): string {
  return `${consoleBaseUrl.replace(/\/+$/u, "")}\0${username}`;
}

export async function sub2ApiLoginCached(
  consoleBaseUrl: string, username: string, password: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const key = cacheKey(consoleBaseUrl, username);
  const hit = sub2ApiCache.get(key);
  if (hit && Date.now() - hit.fetchedAt < SESSION_TTL_MS) return hit.token;
  const token = await sub2ApiLogin(consoleBaseUrl, username, password, fetchImpl);
  sub2ApiCache.set(key, {token, fetchedAt: Date.now()});
  return token;
}

export async function newApiSessionCached(
  consoleBaseUrl: string, username: string, password: string,
  fetchImpl: typeof fetch = fetch,
): Promise<NewApiSession> {
  const key = cacheKey(consoleBaseUrl, username);
  const hit = newApiCache.get(key);
  if (hit && Date.now() - hit.fetchedAt < SESSION_TTL_MS) return hit.session;
  const session = await newApiLoginWithSession(consoleBaseUrl, username, password, fetchImpl);
  newApiCache.set(key, {session, fetchedAt: Date.now()});
  return session;
}

/** 站点返回 401/403 时丢弃缓存会话，下一轮强制重新登录。 */
export function invalidateSub2ApiSession(consoleBaseUrl: string, username: string): void {
  sub2ApiCache.delete(cacheKey(consoleBaseUrl, username));
}

export function invalidateNewApiSession(consoleBaseUrl: string, username: string): void {
  newApiCache.delete(cacheKey(consoleBaseUrl, username));
}

/** 测试隔离入口：清空全部缓存会话。 */
export function clearReconciliationSessions(): void {
  sub2ApiCache.clear();
  newApiCache.clear();
}
