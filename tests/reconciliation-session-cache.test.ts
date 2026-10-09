import {afterEach, describe, expect, test} from "vitest";
import {
  clearReconciliationSessions,
  invalidateSub2ApiSession,
  sub2ApiLoginCached,
} from "../src/lib/sync-engine/reconciliation/session-cache.js";

describe("对账登录会话复用", () => {
  afterEach(() => {
    clearReconciliationSessions();
  });

  test("TTL 内复用会话不重复登录；失效或主动清理后重新登录", async () => {
    let logins = 0;
    const fetchImpl = (async () => {
      logins++;
      return new Response(JSON.stringify({code: 0, data: {access_token: `token-${logins}`}}), {
        status: 200, headers: {"content-type": "application/json"},
      });
    }) as typeof fetch;

    const first = await sub2ApiLoginCached("https://relay.example/", "u", "p", fetchImpl);
    const second = await sub2ApiLoginCached("https://relay.example", "u", "p", fetchImpl);
    expect(logins).toBe(1);
    expect(second).toBe(first);

    // 不同账号不共享会话。
    await sub2ApiLoginCached("https://relay.example", "other", "p", fetchImpl);
    expect(logins).toBe(2);

    // 站点 401 后主动失效，下一轮强制重新登录。
    invalidateSub2ApiSession("https://relay.example", "u");
    const renewed = await sub2ApiLoginCached("https://relay.example", "u", "p", fetchImpl);
    expect(logins).toBe(3);
    expect(renewed).not.toBe(first);
  });
});
