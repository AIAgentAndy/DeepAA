import {afterEach, describe, expect, test} from "vitest";
import {mkdtemp, readFile, rm, stat, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {chmod} from "node:fs/promises";
import {expectPosixFileMode} from "./helpers/posix-permissions.js";
import {openDeepaaDatabase} from "../src/lib/db/connection.js";
import {
  NewApiAdapter,
  newApiLogin,
  newApiLoginWithSession,
  newApiSyncWithToken,
  parseNewApiPayloads,
  tokenMatchesMaskedKey,
} from "../src/lib/sync-engine/adapters/newapi.js";
import {
  Sub2ApiAdapter,
  parseSub2ApiPayloads,
  sub2ApiKeyMatches,
  sub2ApiLogin,
} from "../src/lib/sync-engine/adapters/sub2api.js";
import {RelayAdapter, friendlySyncFailure} from "../src/lib/sync-engine/adapters/relay.js";
import {ConsoleCredentialRepository} from "../src/lib/sync-engine/console-credentials.js";
import {SyncStore} from "../src/lib/sync-engine/store.js";
import {SyncService} from "../src/lib/sync-engine/service.js";
import {SyncAuthRequiredError} from "../src/lib/sync-engine/types.js";
import {ZhipuBalanceAdapter} from "../src/lib/sync-engine/adapters/zhipu.js";
import {MoonshotBalanceAdapter} from "../src/lib/sync-engine/adapters/moonshot.js";
import {NoBalanceConsoleAdapter} from "../src/lib/sync-engine/adapters/no-balance.js";
import {readCredentialRateMultiplier} from "../src/lib/development-launch/credential-metadata.js";
import type {ProxyConfigStore} from "../src/proxy-config.js";
import {ProxyConfigStore as RealProxyConfigStore} from "../src/proxy-config.js";
import type {ProviderCatalog} from "../src/lib/provider-catalog/types.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map(path => rm(path, {recursive: true, force: true})));
});

function makeFetch(
  handler: (url: string, init?: RequestInit) => Promise<unknown>,
): typeof fetch {
  const impl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = await handler(String(input), init);
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: {"content-type": "application/json"},
    });
  };
  return impl as typeof fetch;
}

describe("sync engine newapi adapter", () => {
  test("密钥对比带回远端 ID，供对账识别唯一密钥范围", () => {
    const newApi = parseNewApiPayloads({
      self: {success: true, data: {quota: 0}},
      tokens: {success: true, data: {items: [
        {id: 8, name: "唯一令牌", key: "sk-abc****def", status: 1},
      ]}},
      pricing: {success: true, data: {}},
    }, [{id: "local", label: "唯一令牌", key: "sk-abc123def"}]);
    expect(newApi.credentialComparison).toEqual([expect.objectContaining({
      matched: true, remoteKeyId: "8",
    })]);
    const sub2Api = parseSub2ApiPayloads({
      profile: {data: {balance: 0}},
      keys: {data: {items: [{id: 7, name: "唯一密钥", key: "sk-abc****def", status: "active"}]}},
      rates: {data: {}},
    }, [{id: "local", label: "唯一密钥", key: "sk-abc123def"}]);
    expect(sub2Api.credentialComparison).toEqual([expect.objectContaining({
      matched: true, remoteKeyId: "7",
    })]);
  });

  test("登录接口返回 access_token 并组装三份 payload", async () => {
    const requestedUrls: string[] = [];
    const fetchImpl = makeFetch(async (url, init) => {
      requestedUrls.push(url);
      if (url.endsWith("/api/user/login")) {
        expect(JSON.parse(String(init?.body))).toEqual({username: "andy", password: "secret"});
        return {success: true, data: {access_token: "token-abc"}};
      }
      if (url.endsWith("/api/user/self")) {
        return {success: true, data: {quota: 5_000_000, used_quota: 1_000_000}};
      }
      if (url.includes("/api/token/")) {
        return {success: true, data: {
          page: 1,
          page_size: 100,
          total: 2,
          items: [
            {name: "gpt 稳定", key: "abc1**********defg", group: "vip", status: 1},
            {name: "停用", key: "old1**********9999", group: "default", status: 2},
          ],
        }};
      }
      if (url.endsWith("/api/pricing")) {
        return {success: true, data: {group_ratio: {vip: 0.9, default: 1}}};
      }
      throw new Error(`unexpected ${url}`);
    });

    const token = await newApiLogin("https://console.example.com", "andy", "secret", fetchImpl);
    expect(token).toBe("token-abc");

    const adapter = new NewApiAdapter(fetchImpl);
    const result = await adapter.sync({
      targetId: "modelport.link",
      consoleBaseUrl: "https://console.example.com",
      username: "andy",
      password: "secret",
      credentials: [{id: "cred-a", label: "密钥A", fingerprintSuffix: "1111"}],
      resolveCredential: async id => (id === "cred-a" ? "sk-abc1-middle-defg" : ""),
    });
    expect(result.balance?.amount).toBe(10);
    expect(result.balance?.currency).toBe("USD");
    expect(result.rates).toEqual([
      {credentialId: "cred-a", tokenGroup: "vip", ratio: 0.9, source: "auto_group"},
    ]);
    expect(requestedUrls).toContain("https://console.example.com/api/token/?p=1&size=100");
  });

  test("掩码 key 头尾匹配，无 **** 时全等比较", () => {
    expect(tokenMatchesMaskedKey("sk-abc123****defg", "sk-abc123xyzdefg")).toBe(true);
    expect(tokenMatchesMaskedKey("sk-abc123****defg", "sk-otherxyzdefg")).toBe(false);
    expect(tokenMatchesMaskedKey("sk-full-key", "sk-full-key")).toBe(true);
    expect(tokenMatchesMaskedKey("sk-full-key", "sk-diff")).toBe(false);
    expect(tokenMatchesMaskedKey("", "sk-x")).toBe(false);
    expect(tokenMatchesMaskedKey("abc1**********defg", "sk-abc1-middle-defg")).toBe(true);
  });

  test("兼容当前 New API 的 data.items 分页结构、十星掩码与省略 sk- 前缀", () => {
    const result = parseNewApiPayloads({
      self: {success: true, data: {quota: 500_000}},
      tokens: {success: true, data: {
        page: 1,
        page_size: 100,
        total: 1,
        items: [{name: "straitapi 主密钥", key: "stra**********tail", group: "vip", status: 1}],
      }},
      pricing: {success: true, data: {group_ratio: {vip: 0.08}}},
    }, [{id: "c-strait", label: "主密钥", key: "sk-straitapi-secret-tail"}]);

    expect(result.rates).toEqual([
      {credentialId: "c-strait", tokenGroup: "vip", ratio: 0.08, source: "auto_group"},
    ]);
    expect(result.credentialComparison).toEqual([
      {credentialId: "c-strait", label: "主密钥", matched: true, remoteName: "straitapi 主密钥", ratio: 0.08},
    ]);
  });

  test("New API 令牌列表请求使用单页最大 100 条的有界分页参数", async () => {
    const urls: string[] = [];
    await newApiSyncWithToken("https://console.example.com", "access", makeFetch(async url => {
      urls.push(url);
      if (url.includes("/api/token/")) return {success: true, data: {page: 1, page_size: 100, total: 0, items: []}};
      if (url.endsWith("/api/user/self")) return {success: true, data: {quota: 0}};
      if (url.endsWith("/api/pricing")) return {success: true, data: {group_ratio: {}}};
      throw new Error(`unexpected ${url}`);
    }));
    expect(urls).toContain("https://console.example.com/api/token/?p=1&size=100");
  });

  test("登录失败抛 SyncAuthRequiredError，pricing 模块关闭时仍返回余额", async () => {
    const fetchImpl = makeFetch(async url => {
      if (url.endsWith("/api/user/login")) return {success: false, message: "账号或密码错误"};
      return {};
    });
    await expect(newApiLogin("https://console.example.com", "a", "b", fetchImpl))
      .rejects.toBeInstanceOf(SyncAuthRequiredError);

    const payloads = {
      self: {success: true, data: {quota: 2_500_000}},
      tokens: {success: true, data: []},
      pricing: null,
    };
    const result = parseNewApiPayloads(payloads as never, [{id: "c1", label: "密钥A", key: "sk-1"}]);
    expect(result.balance?.amount).toBe(5);
    expect(result.rates).toBeUndefined();
  });

  test("登录接口 404 时给出站点类型/地址诊断（区分账号密码错误）", async () => {
    const fetchImpl = (async (input: RequestInfo | URL) => {
      expect(String(input)).toBe("https://console.example.com/api/user/login");
      return new Response("404 page not found", {status: 404});
    }) as typeof fetch;
    await expect(newApiLogin("https://console.example.com", "a", "b", fetchImpl))
      .rejects.toThrow(/SYNC_LOGIN_PATH_NOT_FOUND.*标准 New API/s);
  });

  test("标准 one-api/New API 会话登录：无 access_token 时改用 Set-Cookie 拉取数据", async () => {
    const seen: {cookie?: string; authorization?: string; newApiUser?: string} = {};
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/user/login")) {
        return new Response(JSON.stringify({success: true, message: "", data: {id: 184, username: "u"}}), {
          status: 200,
          headers: {"content-type": "application/json", "set-cookie": "session=MTc1Njcw; Path=/; HttpOnly"},
        });
      }
      const headers = new Headers(init?.headers);
      seen.cookie = headers.get("cookie") ?? undefined;
      seen.authorization = headers.get("authorization") ?? undefined;
      seen.newApiUser = headers.get("new-api-user") ?? undefined;
      if (url.endsWith("/api/user/self")) {
        return new Response(JSON.stringify({success: true, data: {quota: 1_000_000}}), {status: 200, headers: {"content-type": "application/json"}});
      }
      if (url.includes("/api/token/")) {
        return new Response(JSON.stringify({success: true, data: {items: []}}), {status: 200, headers: {"content-type": "application/json"}});
      }
      if (url.endsWith("/api/pricing")) {
        return new Response(JSON.stringify({success: true, data: {group_ratio: {}}}), {status: 200, headers: {"content-type": "application/json"}});
      }
      throw new Error(`unexpected ${url}`);
    }) as typeof fetch;

    const adapter = new NewApiAdapter(fetchImpl);
    const result = await adapter.sync({
      targetId: "target-1",
      consoleBaseUrl: "https://console.example.com",
      username: "u",
      password: "p",
      credentials: [],
      resolveCredential: async () => "",
    });
    // 余额走会话 Cookie（quota/500000 = 2 USD），不携带 authorization；
    // Cookie 只保留 kv 首段，不含 Path/HttpOnly 属性。
    expect(result.balance?.amount).toBe(2);
    expect(seen.cookie).toBe("session=MTc1Njcw");
    expect(seen.authorization).toBeUndefined();
    // 新版 New API：会话请求必须带 New-Api-User 头（取自登录响应的用户 id），否则 401。
    expect(seen.newApiUser).toBe("184");
  });

  test("success=false 时优先给出账号密码错误提示（HTTP 仍是 200）", async () => {
    const fetchImpl = (async () => new Response(
      JSON.stringify({message: "用户名或密码错误，或用户已被封禁", success: false}),
      {status: 200, headers: {"content-type": "application/json"}},
    )) as typeof fetch;
    await expect(newApiLoginWithSession("https://console.example.com", "a", "b", fetchImpl))
      .rejects.toThrow(/用户名或密码错误.*用户已被封禁/s);
  });

  test("登录接口返回非 JSON 时给出响应结构诊断", async () => {
    const fetchImpl = (async () => new Response("<html>captcha</html>", {status: 403})) as typeof fetch;
    await expect(newApiLogin("https://console.example.com", "a", "b", fetchImpl))
      .rejects.toThrow(/SYNC_LOGIN_RESPONSE_INVALID/);
  });

  test("分组倍率为非数值（自动）时跳过该密钥", () => {
    const result = parseNewApiPayloads(
      {
        self: {success: true, data: {quota: 0}},
        tokens: {success: true, data: [{key: "sk-a1****b2", group: "auto", status: 1}]},
        pricing: {success: true, data: {group_ratio: {auto: "自动"}}},
      },
      [{id: "c1", label: "密钥A", key: "sk-a1xxb2"}],
    );
    expect(result.rates).toBeUndefined();
  });





});

describe("sync engine 官方预设余额适配器", () => {
  test("智谱：Bearer API Key 查询 /api/paas/v4/balance", async () => {
    const fetchImpl = makeFetch(async url => {
      expect(url).toBe("https://open.bigmodel.cn/api/paas/v4/balance");
      return {balance: [{used: 3.2, remaining: 96.8, currency: "CNY"}]};
    });
    const adapter = new ZhipuBalanceAdapter(fetchImpl);
    const result = await adapter.sync({
      targetId: "zhipu",
      consoleBaseUrl: "https://open.bigmodel.cn/",
      username: "u",
      password: "p",
      credentials: [],
      defaultCredentialId: "cred-a",
      resolveCredential: async () => "sk-zhipu",
    });
    expect(result.balance).toMatchObject({currency: "CNY", amount: 96.8, source: "zhipu"});
  });

  test("Moonshot / Kimi：Bearer API Key 查询 /v1/users/me/balance", async () => {
    const fetchImpl = makeFetch(async url => {
      expect(url).toBe("https://api.moonshot.cn/v1/users/me/balance");
      return {available_balance: 12.34, total_balance: 50};
    });
    const adapter = new MoonshotBalanceAdapter(fetchImpl);
    const result = await adapter.sync({
      targetId: "moonshot",
      // 2026-09-30 修复回归：控制台域（platform.kimi.com，/v1 不提供 API 且 301→404）
      // 不得影响余额端点，适配器固定打 api.moonshot.cn。
      consoleBaseUrl: "https://platform.kimi.com",
      username: "u",
      password: "p",
      credentials: [],
      defaultCredentialId: "cred-b",
      resolveCredential: async () => "sk-moonshot",
    });
    expect(result.balance).toMatchObject({currency: "CNY", amount: 12.34, source: "moonshot"});
  });

  test("Moonshot / Kimi：官方嵌套形态 {code, data:{available_balance}} 优先解析", async () => {
    // 2026-10-05 修复：官方文档与 new-api/sub2api 实现均为 data.* 嵌套结构，
    // 顶层字段保留为旧形态回退（双形态兼容）。
    const fetchImpl = makeFetch(async () => ({
      code: 0,
      status: true,
      data: {available_balance: "88.88", voucher_balance: "10", cash_balance: "78.88"},
    }));
    const adapter = new MoonshotBalanceAdapter(fetchImpl);
    const result = await adapter.sync({
      targetId: "moonshot",
      consoleBaseUrl: "https://platform.kimi.com",
      username: "u",
      password: "p",
      credentials: [],
      defaultCredentialId: "cred-b",
      resolveCredential: async () => "sk-moonshot",
    });
    expect(result.balance).toMatchObject({currency: "CNY", amount: 88.88, source: "moonshot"});
  });

  test("MiniMax / 火山无公开余额接口：同步直接报不支持，不伪装成功", async () => {
    const adapter = new NoBalanceConsoleAdapter("minimax");
    await expect(adapter.sync({
      targetId: "minimax",
      consoleBaseUrl: "https://platform.minimaxi.com",
      username: "u",
      password: "p",
      credentials: [],
      resolveCredential: async () => "",
    })).rejects.toThrow("ACCOUNT_SYNC_UNSUPPORTED");
  });
});

describe("sync engine sub2api adapter", () => {
  test("登录接口返回 access_token 并组装三份 payload（余额 + 分组倍率）", async () => {
    const fetchImpl = makeFetch(async (url, init) => {
      if (url.endsWith("/api/v1/auth/login")) {
        expect(JSON.parse(String(init?.body))).toEqual({email: "andy@example.com", password: "secret"});
        return {
          code: 0,
          message: "success",
          data: {
            access_token: "token-sub2api",
            refresh_token: "refresh-1",
            token_type: "Bearer",
            user: {id: 1, email: "andy@example.com"},
          },
        };
      }
      if (url.endsWith("/api/v1/user/profile")) {
        return {code: 0, message: "success", data: {balance: 12.5, frozen_balance: 1.2, username: "andy"}};
      }
      if (url.includes("/api/v1/keys")) {
        return {
          code: 0,
          message: "success",
          data: {
            items: [
              {id: 10, key: "sk-sub2api-full-key", name: "主密钥", group_id: 3, group: {id: 3, name: "vip", rate_multiplier: 0.85}, status: "active"},
              {id: 11, key: "sk-masked****tail", name: "掩码密钥", group_id: 3, group: {id: 3, name: "vip", rate_multiplier: 0.85}, status: "active"},
              {id: 12, key: "sk-disabled", name: "停用", group_id: 3, group: {id: 3, rate_multiplier: 0.85}, status: "inactive"},
            ],
            total: 3,
            page: 1,
            page_size: 200,
            pages: 1,
          },
        };
      }
      if (url.endsWith("/api/v1/groups/rates")) {
        // 实际部署：data 直接是分组倍率 map
        return {code: 0, message: "success", data: {"3": 0.9}};
      }
      throw new Error(`unexpected ${url}`);
    });

    const token = await sub2ApiLogin("https://ai98pro.xyz", "andy@example.com", "secret", fetchImpl);
    expect(token).toBe("token-sub2api");

    const adapter = new Sub2ApiAdapter(fetchImpl);
    const result = await adapter.sync({
      targetId: "ai98pro.xyz",
      consoleBaseUrl: "https://ai98pro.xyz",
      username: "andy@example.com",
      password: "secret",
      credentials: [
        {id: "cred-full", label: "主密钥", fingerprintSuffix: "1111"},
        {id: "cred-masked", label: "掩码密钥", fingerprintSuffix: "2222"},
        {id: "cred-disabled", label: "停用密钥", fingerprintSuffix: "3333"},
      ],
      resolveCredential: async id => ({
        "cred-full": "sk-sub2api-full-key",
        "cred-masked": "sk-maskedXXXXtail",
        "cred-disabled": "sk-disabled",
      })[id] ?? "",
    });
    expect(result.balance?.amount).toBe(12.5);
    expect(result.balance?.currency).toBe("USD");
    expect(result.balance?.usedQuota).toBe(1.2);
    // key 自带 group.rate_multiplier（0.85）优先于 groups/rates map（0.9）；
    // 停用密钥与无匹配 key 不产生快照。
    expect(result.rates).toEqual([
      {credentialId: "cred-full", tokenGroup: "3", ratio: 0.85, source: "auto_group"},
      {credentialId: "cred-masked", tokenGroup: "3", ratio: 0.85, source: "auto_group"},
    ]);
    // 按密钥粒度对比：匹配成功的带远程名称与倍率；远程停用的密钥标注失败原因。
    expect(result.credentialComparison).toEqual([
      {credentialId: "cred-full", label: "主密钥", matched: true, remoteName: "主密钥", remoteKeyId: "10", ratio: 0.85},
      {credentialId: "cred-masked", label: "掩码密钥", matched: true, remoteName: "掩码密钥", remoteKeyId: "11", ratio: 0.85},
      {credentialId: "cred-disabled", label: "停用密钥", matched: false, remoteName: "停用", reason: "对方网站该密钥已停用（status 非 active）"},
    ]);
  });

  test("groups/rates 关闭或缺失时仍返回余额", async () => {
    const payloads = {
      profile: {code: 0, message: "success", data: {balance: 3}},
      keys: {code: 0, message: "success", data: {items: [{key: "sk-a", group_id: 1, status: "active"}]}},
      rates: undefined,
    };
    const result = parseSub2ApiPayloads(payloads as never, [{id: "c1", label: "密钥A", key: "sk-a"}]);
    expect(result.balance?.amount).toBe(3);
    expect(result.rates).toBeUndefined();
    // 远程存在匹配密钥时 comparison 标记成功。
    expect(result.credentialComparison).toEqual([
      {credentialId: "c1", label: "密钥A", matched: true, ratio: undefined},
    ]);
  });

  test("keys 未带 group 时回退 groups/rates 直接 map 匹配分组倍率", async () => {
    const payloads = {
      profile: {code: 0, message: "success", data: {balance: 5}},
      keys: {code: 0, message: "success", data: {items: [
        {id: 1, key: "sk-full-a", group_id: 2, status: "active"},
      ]}},
      rates: {code: 0, message: "success", data: {"2": 1.2}},
    };
    const result = parseSub2ApiPayloads(payloads as never, [{id: "c1", label: "密钥A", key: "sk-full-a"}]);
    expect(result.rates).toEqual([
      {credentialId: "c1", tokenGroup: "2", ratio: 1.2, source: "auto_group"},
    ]);
  });

  test("兼容 data.group_rates 包装的历史返回结构", async () => {
    const payloads = {
      profile: {code: 0, message: "success", data: {balance: 1}},
      keys: {code: 0, message: "success", data: {items: [
        {id: 1, key: "sk-full-b", group_id: 4, status: "active"},
      ]}},
      rates: {code: 0, message: "success", data: {group_rates: {"4": 0.75}}},
    };
    const result = parseSub2ApiPayloads(payloads as never, [{id: "c2", label: "密钥B", key: "sk-full-b"}]);
    expect(result.rates).toEqual([
      {credentialId: "c2", tokenGroup: "4", ratio: 0.75, source: "auto_group"},
    ]);
  });




  test("登录响应 requires_2fa 时给出 2FA 诊断", async () => {
    const fetchImpl = makeFetch(async url => {
      if (url.endsWith("/api/v1/auth/login")) {
        return {code: 0, message: "success", data: {requires_2fa: true, temp_token: "tmp-1", user_email_masked: "a***@x.com"}};
      }
      return {};
    });
    await expect(sub2ApiLogin("https://ai98pro.xyz", "a@x.com", "p", fetchImpl))
      .rejects.toThrow(/SYNC_LOGIN_2FA_REQUIRED/);
  });

  test("登录接口 404 时给出站点类型/地址诊断", async () => {
    const fetchImpl = (async (input: RequestInfo | URL) => {
      expect(String(input)).toBe("https://ai98pro.xyz/api/v1/auth/login");
      return new Response("404 page not found", {status: 404});
    }) as typeof fetch;
    await expect(sub2ApiLogin("https://ai98pro.xyz", "a@x.com", "p", fetchImpl))
      .rejects.toThrow(/SYNC_LOGIN_PATH_NOT_FOUND.*Sub2API/s);
  });

  test("sub2api 密钥匹配：全等优先，掩码头尾匹配兜底", () => {
    expect(sub2ApiKeyMatches("sk-abc123xyz", "sk-abc123xyz")).toBe(true);
    expect(sub2ApiKeyMatches("sk-abc123****xyz", "sk-abc123XYZxyz")).toBe(true);
    expect(sub2ApiKeyMatches("sk-abc123****xyz", "sk-otherXYZxyz")).toBe(false);
    expect(sub2ApiKeyMatches("", "sk-x")).toBe(false);
  });
});

/** 中转站 relay 探测用的可路由 fetch：按 URL 片段返回指定状态与 JSON 体。 */
function makeRelayFetch(routes: Record<string, {status?: number; body?: unknown}>) {
  const requested: string[] = [];
  const impl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    requested.push(url);
    const route = Object.entries(routes).find(([pattern]) => url.includes(pattern));
    if (!route) return new Response("not found", {status: 404});
    const config = route[1];
    return new Response(JSON.stringify(config.body ?? {}), {
      status: config.status ?? 200,
      headers: {"content-type": "application/json"},
    });
  }) as typeof fetch;
  return {impl, requested};
}

const relaySub2ApiRoutes: Record<string, {body: unknown}> = {
  "/api/v1/auth/login": {body: {code: 0, message: "success", data: {access_token: "tok-sub2api"}}},
  "/api/v1/user/profile": {body: {code: 0, message: "success", data: {balance: 12.5}}},
  "/api/v1/keys": {body: {code: 0, message: "success", data: {items: []}}},
  "/api/v1/groups/rates": {body: {code: 0, message: "success", data: {}}},
};

const relayNewApiRoutes: Record<string, {body: unknown}> = {
  "/api/user/login": {body: {success: true, data: {access_token: "tok-newapi"}}},
  "/api/user/self": {body: {success: true, data: {quota: 5_000_000}}},
  "/api/token/": {body: {success: true, data: {items: []}}},
  "/api/pricing": {body: {success: true, data: {group_ratio: {}}}},
};

describe("sync engine relay adapter（中转站自动识别）", () => {
  const baseInput = {
    targetId: "t1",
    consoleBaseUrl: "https://relay.example.com",
    username: "andy",
    password: "secret",
    credentials: [],
    resolveCredential: async () => "",
  };

  test("未识别时先按 Sub2API 请求，成功后不再请求 New API", async () => {
    const {impl, requested} = makeRelayFetch(relaySub2ApiRoutes);
    const adapter = new RelayAdapter(impl);
    const result = await adapter.sync({...baseInput});
    expect(result.providerType).toBe("sub2api");
    expect(result.balance?.amount).toBe(12.5);
    expect(requested.some(url => url.includes("/api/v1/auth/login"))).toBe(true);
    expect(requested.some(url => url.includes("/api/user/login"))).toBe(false);
  });

  test("Sub2API 登录路径不存在时回退 New API 并识别为 newapi", async () => {
    const {impl, requested} = makeRelayFetch({
      "/api/v1/auth/login": {status: 404, body: {}},
      ...relayNewApiRoutes,
    });
    const adapter = new RelayAdapter(impl);
    const result = await adapter.sync({...baseInput});
    expect(result.providerType).toBe("newapi");
    expect(requested[0]).toContain("/api/v1/auth/login");
    expect(requested.find(url => url.includes("/api/user/login"))).toBeTruthy();
  });

  test("已识别 resolvedProvider 后直达对应适配器，不再循环探测", async () => {
    const {impl, requested} = makeRelayFetch({
      "/api/v1/auth/login": {status: 404, body: {}},
      ...relayNewApiRoutes,
    });
    const adapter = new RelayAdapter(impl);
    const result = await adapter.sync({...baseInput, resolvedProvider: "newapi"});
    expect(result.providerType).toBe("newapi");
    expect(requested.some(url => url.includes("/api/v1/auth/login"))).toBe(false);
    expect(requested.some(url => url.includes("/api/user/login"))).toBe(true);
  });

  test("Sub2API 与 New API 均失败时返回合并错误", async () => {
    const {impl} = makeRelayFetch({
      "/api/v1/auth/login": {status: 404, body: {}},
      "/api/user/login": {status: 405, body: {}},
    });
    const adapter = new RelayAdapter(impl);
    await expect(adapter.sync({...baseInput})).rejects.toThrow(/中转站自动识别失败/);
  });
});

describe("relay 同步失败文案", () => {
  test("Playwright 原始报错折叠为一句话，无 ASCII 框；HTTP 原因保留", () => {
    const playwrightRaw = "browserType.launch: Executable doesn't exist at /x/chrome-headless-shell ╔════╗ ║ Looks like Playwright was just installed. ║ ║ pnpm exec playwright install ║ ╚════╝";
    const httpReason = "SYNC_LOGIN_FAILED（HTTP 200）：用户名或密码错误";
    const combined = `SYNC_LOGIN_PATH_NOT_FOUND：https://x/api/v1/auth/login 不存在（HTTP 404）——${playwrightRaw}`;
    const friendly = friendlySyncFailure(combined);
    expect(friendly).not.toContain("╔");
    expect(friendly).not.toContain("Executable doesn't exist");
    expect(friendly).toContain("本机未安装 Playwright 浏览器");
    expect(friendly).toContain("SYNC_LOGIN_PATH_NOT_FOUND");
    // 无浏览器部分的普通错误：截断多行装饰后原样保留
    expect(friendlySyncFailure(new Error(`${httpReason}\n附加行`))).toBe(httpReason);
  });
});

describe("sync engine store", () => {
  test("控制台账号、余额、倍率、同步记录落库与保留策略", async () => {
    const root = await mkdtemp(join(tmpdir(), "sync-store-"));
    tempRoots.push(root);
    const db = openDeepaaDatabase({dataDir: root});
    try {
      const store = new SyncStore(db);
      store.upsertConsoleAccount({
        id: "console_a",
        targetId: "t1",
        providerType: "newapi",
        consoleBaseUrl: "https://console.example.com",
        username: "andy",
        passwordRef: "t1",
        loginMode: "http",
        status: "idle",
        lastSyncAt: null,
        lastSyncError: null,
        consecutiveAutoFailures: 0,
        consecutiveFailureKind: null,
        nextSyncAt: new Date(Date.now() - 1000).toISOString(),
        syncIntervalMinutes: 30,
      });
      expect(store.getConsoleAccount("t1")?.providerType).toBe("newapi");
      expect(store.dueAccounts(new Date().toISOString())).toHaveLength(1);

      const now = new Date().toISOString();
      store.insertBalance({
        targetId: "t1",
        consoleAccountId: "console_a",
        providerType: "newapi",
        currency: "USD",
        amount: 10,
        quota: 5_000_000,
        usedQuota: null,
        source: "newapi",
        rawJson: "{}",
        capturedAt: now,
      });
      expect(store.latestBalance("t1")?.amount).toBe(10);

      store.insertRates([{
        targetId: "t1",
        credentialId: "cred-1",
        tokenGroup: "vip",
        ratio: 0.9,
        source: "auto_group",
        capturedAt: now,
      }]);
      expect(store.latestRate("cred-1")?.ratio).toBe(0.9);

      store.insertSyncRun({
        consoleAccountId: "console_a",
        targetId: "t1",
        status: "ok",
        mode: "http",
        detailJson: "{}",
        startedAt: now,
        finishedAt: now,
      });
      expect(store.latestSyncRuns("t1")).toHaveLength(1);

      store.prune(now);
      expect(store.latestBalance("t1")?.amount).toBe(10);
    } finally {
      db.close();
    }
  });

  test("保留策略：余额超 35 天清理、倍率与同步记录按上限保留", async () => {
    const root = await mkdtemp(join(tmpdir(), "sync-store-"));
    tempRoots.push(root);
    const db = openDeepaaDatabase({dataDir: root});
    try {
      const store = new SyncStore(db);
      store.upsertConsoleAccount({
        id: "console_b",
        targetId: "t2",
        providerType: "newapi",
        consoleBaseUrl: "https://console.example.com",
        username: "u",
        passwordRef: "t2",
        loginMode: "http",
        status: "idle",
        lastSyncAt: null,
        lastSyncError: null,
        consecutiveAutoFailures: 0,
        consecutiveFailureKind: null,
        nextSyncAt: null,
        syncIntervalMinutes: 5,
      });
      store.insertBalance({
        targetId: "t2",
        consoleAccountId: "console_b",
        providerType: "newapi",
        currency: "USD",
        amount: 1,
        quota: null,
        usedQuota: null,
        source: "newapi",
        rawJson: "{}",
        capturedAt: "2026-01-01T00:00:00.000Z",
      });
      store.prune("2026-08-01T00:00:00.000Z");
      expect(store.latestBalance("t2")).toBeUndefined();
    } finally {
      db.close();
    }
  });

  test("保留策略：余额与套餐快照 35 天边界（30 天保留、40 天清理）", async () => {
    const root = await mkdtemp(join(tmpdir(), "sync-store-retention-"));
    tempRoots.push(root);
    const db = openDeepaaDatabase({dataDir: root});
    try {
      const store = new SyncStore(db);
      store.upsertConsoleAccount({
        id: "console_retention",
        targetId: "t_retention",
        providerType: "newapi",
        consoleBaseUrl: "https://console.example.com",
        username: "u",
        passwordRef: "t_retention",
        loginMode: "http",
        status: "idle",
        lastSyncAt: null,
        lastSyncError: null,
        consecutiveAutoFailures: 0,
        consecutiveFailureKind: null,
        nextSyncAt: null,
        syncIntervalMinutes: 5,
      });
      // 相对 prune 时刻 2026-07-27：30 天前（保留）与 40 天前（清理）各一条。
      for (const [amount, capturedAt] of [
        [30, "2026-06-27T00:00:00.000Z"],
        [40, "2026-06-17T00:00:00.000Z"],
      ] as const) {
        store.insertBalance({
          targetId: "t_retention",
          consoleAccountId: "console_retention",
          providerType: "newapi",
          currency: "USD",
          amount,
          quota: null,
          usedQuota: null,
          source: "newapi",
          rawJson: "{}",
          capturedAt,
        });
      }
      store.upsertPlanSyncConfig({
        id: "plan_retention",
        targetId: "t_retention",
        providerType: "kimi-coding",
        credentialId: "cred-1",
        accessKeyRef: null,
        secretKeyRef: null,
        status: "idle",
        lastSyncAt: null,
        lastSyncError: null,
        consecutiveAutoFailures: 0,
        consecutiveFailureKind: null,
        nextSyncAt: null,
        syncIntervalMinutes: 30,
      });
      for (const [used, capturedAt] of [
        [30, "2026-06-27T00:00:00.000Z"],
        [40, "2026-06-17T00:00:00.000Z"],
      ] as const) {
        store.insertPlanQuotaSnapshots([{
          targetId: "t_retention",
          planSyncId: "plan_retention",
          consoleAccountId: null,
          credentialId: "cred-1",
          providerType: "kimi-coding",
          planName: null,
          windowLabel: "monthly",
          used,
          total: 100,
          unit: "requests",
          resetAt: null,
          rawJson: "{}",
          capturedAt,
        }]);
      }

      store.prune("2026-07-27T00:00:00.000Z");
      expect(store.latestBalance("t_retention")?.amount).toBe(30);
      expect(store.latestPlanQuota("t_retention", "cred-1", "monthly")?.used).toBe(30);
    } finally {
      db.close();
    }
  });

  test("套餐到期配置查询使用 limit+1 并返回可观测截断信息", async () => {
    const root = await mkdtemp(join(tmpdir(), "sync-store-plan-due-"));
    tempRoots.push(root);
    const db = openDeepaaDatabase({dataDir: root});
    try {
      const store = new SyncStore(db);
      for (const [index, targetId] of ["t1", "t2", "t3"].entries()) {
        store.upsertPlanSyncConfig({
          id: `plan_${targetId}`,
          targetId,
          providerType: "kimi-coding",
          credentialId: `cred-${targetId}`,
          accessKeyRef: null,
          secretKeyRef: null,
          status: "idle",
          lastSyncAt: null,
          lastSyncError: null,
          consecutiveAutoFailures: 0,
          consecutiveFailureKind: null,
          nextSyncAt: index < 2
            ? `2026-08-17T00:00:0${index}.000Z`
            : "2026-08-18T00:00:00.000Z",
          syncIntervalMinutes: 30,
        });
      }

      expect(store.duePlanConfigs("2026-08-17T00:01:00.000Z", 1)).toEqual({
        items: [expect.objectContaining({targetId: "t1"})],
        candidateCount: 2,
        processedCount: 2,
        limited: true,
      });
    } finally {
      db.close();
    }
  });

  test("套餐快照按目标、密钥和时间窗返回最近成功值", async () => {
    const root = await mkdtemp(join(tmpdir(), "sync-store-plan-latest-"));
    tempRoots.push(root);
    const db = openDeepaaDatabase({dataDir: root});
    try {
      const store = new SyncStore(db);
      store.upsertPlanSyncConfig({
        id: "plan_t1",
        targetId: "t1",
        providerType: "kimi-coding",
        credentialId: "cred-1",
        accessKeyRef: null,
        secretKeyRef: null,
        status: "idle",
        lastSyncAt: null,
        lastSyncError: null,
        consecutiveAutoFailures: 0,
        consecutiveFailureKind: null,
        nextSyncAt: null,
        syncIntervalMinutes: 30,
      });
      for (const snapshot of [
        {credentialId: "cred-1", windowLabel: "5h", used: 1, capturedAt: "2026-08-17T00:00:00.000Z"},
        {credentialId: "cred-1", windowLabel: "5h", used: 2, capturedAt: "2026-08-17T01:00:00.000Z"},
        {credentialId: "cred-1", windowLabel: "monthly", used: 3, capturedAt: "2026-08-17T01:00:00.000Z"},
        {credentialId: "cred-2", windowLabel: "5h", used: 4, capturedAt: "2026-08-17T02:00:00.000Z"},
      ]) {
        store.insertPlanQuotaSnapshots([{
          targetId: "t1",
          planSyncId: "plan_t1",
          consoleAccountId: null,
          credentialId: snapshot.credentialId,
          providerType: "kimi-coding",
          planName: "Coding Plan",
          windowLabel: snapshot.windowLabel,
          used: snapshot.used,
          total: 10,
          unit: "requests",
          resetAt: null,
          rawJson: "{}",
          capturedAt: snapshot.capturedAt,
        }]);
      }

      expect(store.latestPlanQuota("t1", "cred-1", "5h")?.used).toBe(2);
      expect(store.latestPlanQuotas("t1", {credentialId: "cred-1", limit: 1})).toEqual({
        items: [expect.objectContaining({windowLabel: "5h", used: 2})],
        candidateCount: 2,
        processedCount: 2,
        limited: true,
      });
    } finally {
      db.close();
    }
  });

  test("删除目标同步数据并清理过期套餐快照", async () => {
    const root = await mkdtemp(join(tmpdir(), "sync-store-plan-remove-"));
    tempRoots.push(root);
    const db = openDeepaaDatabase({dataDir: root});
    try {
      const store = new SyncStore(db);
      store.upsertPlanSyncConfig({
        id: "plan_t1",
        targetId: "t1",
        providerType: "kimi-coding",
        credentialId: "cred-1",
        accessKeyRef: null,
        secretKeyRef: null,
        status: "idle",
        lastSyncAt: null,
        lastSyncError: null,
        consecutiveAutoFailures: 0,
        consecutiveFailureKind: null,
        nextSyncAt: null,
        syncIntervalMinutes: 30,
      });
      store.insertPlanQuotaSnapshots([{
        targetId: "t1",
        planSyncId: "plan_t1",
        consoleAccountId: null,
        credentialId: "cred-1",
        providerType: "kimi-coding",
        planName: null,
        windowLabel: "monthly",
        used: 1,
        total: 10,
        unit: "requests",
        resetAt: null,
        rawJson: "{}",
        capturedAt: "2026-01-01T00:00:00.000Z",
      }]);

      store.prune("2026-08-17T00:00:00.000Z");
      expect(store.latestPlanQuota("t1", "cred-1", "monthly")).toBeUndefined();
      expect(store.removeTargetSyncData("t1")).toBe(true);
      expect(store.getPlanSyncConfig("t1")).toBeUndefined();
    } finally {
      db.close();
    }
  });
});

describe("sync engine console credentials", () => {
  test("控制台凭据只落盘 0600 文件且不进入 SQLite", async () => {
    const root = await mkdtemp(join(tmpdir(), "sync-console-"));
    tempRoots.push(root);
    const filePath = join(root, "console-credentials.json");
    const repository = new ConsoleCredentialRepository(filePath);
    await repository.upsert({
      targetId: "t1",
      providerType: "newapi",
      consoleBaseUrl: "https://console.example.com",
      username: "andy",
      password: "plain-secret",
      updatedAt: new Date().toISOString(),
    });
    const raw = await import("node:fs/promises").then(fs => fs.readFile(filePath, "utf8"));
    expect(raw).toContain("plain-secret");
    const mode = (await stat(filePath)).mode & 0o777;
    expectPosixFileMode(mode, 0o600);
    expect((await repository.find("t1"))?.password).toBe("plain-secret");
    await repository.remove("t1");
    expect(await repository.find("t1")).toBeUndefined();
  });
});

describe("sync engine service", () => {
  test("runSync 全链路：登录、解析、落库并更新状态", async () => {
    const root = await mkdtemp(join(tmpdir(), "sync-service-"));
    tempRoots.push(root);
    const db = openDeepaaDatabase({dataDir: root});
    const configStore = await createConfigStore(root);
    const helperPath = join(root, "credential-helper.mjs");
    await writeFile(
      helperPath,
      "#!/usr/bin/env node\nconsole.log('sk-abc123xxdefg');\n",
      "utf8",
    );
    await chmod(helperPath, 0o755);
    const consolePath = join(root, "console-credentials.json");

    const service = new SyncService({
      db,
      configStore,
      developmentCredentialsPath: join(root, "development-credentials.json"),
      consoleCredentialsPath: consolePath,
      credentialHelperPath: helperPath,
      fetchImpl: makeFetch(async url => {
        if (url.endsWith("/api/user/login")) return {success: true, data: {access_token: "tok"}};
        if (url.endsWith("/api/user/self")) return {success: true, data: {quota: 5_000_000}};
        if (url.includes("/api/token/")) {
          return {success: true, data: {
            page: 1,
            page_size: 100,
            total: 1,
            items: [{name: "默认", key: "abc1**********defg", group: "vip", status: 1}],
          }};
        }
        if (url.endsWith("/api/pricing")) return {success: true, data: {group_ratio: {vip: 0.9}}};
        return {};
      }) as typeof fetch,
    });
    await service.saveConsoleAccount({
      targetId: "modelport.link",
      providerType: "newapi",
      consoleBaseUrl: "https://console.example.com",
      username: "andy",
      password: "secret",
    });
    await writeFile(
      join(root, "development-credentials.json"),
      JSON.stringify({
        version: 1,
        credentials: [{
          id: "cred-a",
          targetId: "modelport.link",
          label: "默认",
          store: "macos-keychain",
          account: "cred-a",
          fingerprintSuffix: "1111",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }],
      }),
      "utf8",
    );

    try {
      // 保存后立即执行首次同步：默认周期 5 分钟，结果随保存返回。
      const saved = await service.saveConsoleAccount({
        targetId: "modelport.link",
        providerType: "newapi",
        consoleBaseUrl: "https://console.example.com",
        username: "andy",
        password: "secret",
      });
      expect(saved.account.syncIntervalMinutes).toBe(5);
      expect(saved.sync.ok).toBe(true);
      expect(await service.status("modelport.link").then(status => status.account?.status)).toBe("ok");

      const result = await service.runSync("modelport.link");
      expect(result.balance?.amount).toBe(10);
      expect(result.rates).toHaveLength(1);
      const status = await service.status("modelport.link");
      expect(status.account?.status).toBe("ok");
      expect(status.balance?.amount).toBe(10);
      expect(status.rates[0]?.ratio).toBe(0.9);

      // 编辑保存显式周期 30 分钟：立即生效并保留原密码。
      const edited = await service.saveConsoleAccount({
        targetId: "modelport.link",
        providerType: "newapi",
        consoleBaseUrl: "https://console.example.com",
        username: "andy",
        password: "",
        syncIntervalMinutes: 30,
      });
      expect(edited.account.syncIntervalMinutes).toBe(30);
      expect(edited.sync.ok).toBe(true);
    } finally {
      db.close();
    }
  });

  test("relay 首次同步自动识别并记录底层类型，后续同步不再循环探测，编辑不丢失识别结果", async () => {
    const root = await mkdtemp(join(tmpdir(), "sync-relay-service-"));
    tempRoots.push(root);
    const db = openDeepaaDatabase({dataDir: root});
    const configStore = await createConfigStore(root);
    const helperPath = join(root, "credential-helper.mjs");
    await writeFile(
      helperPath,
      "#!/usr/bin/env node\nconsole.log('sk-abc123xxdefg');\n",
      "utf8",
    );
    await chmod(helperPath, 0o755);
    const consolePath = join(root, "console-credentials.json");
    let sub2ApiCalls = 0;
    const relayFetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/v1/auth/login")) {
        sub2ApiCalls += 1;
        return new Response("404 page not found", {status: 404});
      }
      const json = (body: unknown) => new Response(JSON.stringify(body), {
        status: 200,
        headers: {"content-type": "application/json"},
      });
      if (url.endsWith("/api/user/login")) return json({success: true, data: {access_token: "tok"}});
      if (url.endsWith("/api/user/self")) return json({success: true, data: {quota: 5_000_000}});
      if (url.includes("/api/token/")) return json({success: true, data: {items: []}});
      if (url.endsWith("/api/pricing")) return json({success: true, data: {group_ratio: {}}});
      return new Response("{}", {status: 404});
    }) as typeof fetch;
    const service = new SyncService({
      db,
      configStore,
      developmentCredentialsPath: join(root, "development-credentials.json"),
      consoleCredentialsPath: consolePath,
      credentialHelperPath: helperPath,
      fetchImpl: relayFetch,
    });
    await writeFile(join(root, "development-credentials.json"), JSON.stringify({
      version: 1,
      credentials: [],
    }), "utf8");
    try {
      await service.saveConsoleAccount({
        targetId: "modelport.link",
        providerType: "relay",
        consoleBaseUrl: "https://relay.example.com",
        username: "andy",
        password: "secret",
      });

      const first = await service.runSync("modelport.link");
      expect(first.providerType).toBe("newapi");
      const saved = JSON.parse(await readFile(consolePath, "utf8")) as {
        accounts: Array<{resolvedProvider?: string}>;
      };
      expect(saved.accounts[0]?.resolvedProvider).toBe("newapi");
      const status = await service.status("modelport.link");
      expect(status.account?.providerType).toBe("relay");
      expect(status.account?.resolvedProvider).toBe("newapi");

      // 已识别后第二次同步不再请求 Sub2API 探测
      const callsAfterFirst = sub2ApiCalls;
      const second = await service.runSync("modelport.link");
      expect(second.providerType).toBe("newapi");
      expect(sub2ApiCalls).toBe(callsAfterFirst);

      // 编辑保存（密码留空保留原值）不丢失已识别类型
      await service.saveConsoleAccount({
        targetId: "modelport.link",
        providerType: "relay",
        consoleBaseUrl: "https://relay.example.com",
        username: "andy",
        password: "",
      });
      const afterEdit = JSON.parse(await readFile(consolePath, "utf8")) as {
        accounts: Array<{resolvedProvider?: string}>;
      };
      expect(afterEdit.accounts[0]?.resolvedProvider).toBe("newapi");
    } finally {
      db.close();
    }
  });
});

describe("credential rate multiplier read chain", () => {
  test("手动倍率优先，其次 SQLite 自动快照，最后回退 undefined", async () => {
    const root = await mkdtemp(join(tmpdir(), "sync-rate-"));
    tempRoots.push(root);
    const metadataPath = join(root, "development-credentials.json");
    const db = openDeepaaDatabase({dataDir: root});
    const base = {
      targetId: "modelport.link",
      label: "默认",
      store: "macos-keychain" as const,
      account: "cred-a",
      fingerprintSuffix: "1111",
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
    };
    try {
      const store = new SyncStore(db);
      store.insertRates([{
        targetId: "modelport.link",
        credentialId: "cred-a",
        tokenGroup: "vip",
        ratio: 0.9,
        source: "auto_group",
        capturedAt: "2026-08-01T00:00:00.000Z",
      }]);

      // 无手动倍率：命中 SQLite 自动快照
      await writeFile(metadataPath, JSON.stringify({
        version: 1,
        credentials: [{id: "cred-a", ...base}],
      }), "utf8");
      expect(await readCredentialRateMultiplier(metadataPath, "cred-a", db)).toBe(0.9);

      // 手动倍率优先
      await writeFile(metadataPath, JSON.stringify({
        version: 1,
        credentials: [{id: "cred-a", ...base, rateMultiplier: 0.7}],
      }), "utf8");
      expect(await readCredentialRateMultiplier(metadataPath, "cred-a", db)).toBe(0.7);

      // 凭据不存在或都无倍率
      expect(await readCredentialRateMultiplier(metadataPath, "ghost", db)).toBeUndefined();
      await writeFile(metadataPath, JSON.stringify({
        version: 1,
        credentials: [{id: "cred-b", ...base, id: "cred-b"}],
      }), "utf8");
      expect(await readCredentialRateMultiplier(metadataPath, "cred-b", db)).toBeUndefined();
    } finally {
      db.close();
    }
  });
});

async function createConfigStore(root: string): Promise<ProxyConfigStore> {
  const store = new RealProxyConfigStore({
    configPath: join(root, "proxy-config.json"),
    developmentCredentialsPath: join(root, "development-credentials.json"),
    localProxyBaseUrl: "http://localhost:3211",
  });
  await store.init();
  await store.updateConfig({
    targets: [{
      id: "modelport.link",
      name: "modelport",
      openaiUrl: "https://modelport.link/v1",
      anthropicUrl: "https://modelport.link/anthropic",
      enabled: true,
      supportedModels: ["gpt-5.6"],
      development: {defaultCredentials: {codex: "cred-a", claude: "cred-a"}},
    }],
  });
  return store;
}

describe("sync engine plan tier（opencode-go 档位必选，2026-09-30）", () => {
  test("档位必选 + 目录归属校验 + 落盘 target.pricing.planTier", async () => {
    const root = await mkdtemp(join(tmpdir(), "sync-plan-tier-"));
    tempRoots.push(root);
    const db = openDeepaaDatabase({dataDir: root});
    const store = new RealProxyConfigStore({
      configPath: join(root, "proxy-config.json"),
      developmentCredentialsPath: join(root, "development-credentials.json"),
      localProxyBaseUrl: "http://localhost:3211",
    });
    await store.init();
    await store.updateConfig({
      targets: [{
        id: "opencode-test",
        name: "opencode-go-test",
        presetId: "opencode-go",
        openaiUrl: "https://opencode.ai/zen/go/v1",
        anthropicUrl: "https://opencode.ai/zen/go/v1",
        enabled: true,
        supportedModels: ["glm-5.3"],
        billingChannel: "plan",
        pricing: {vendor: "opencode-go"},
      }],
    });
    const helperPath = join(root, "credential-helper.mjs");
    await writeFile(helperPath, "#!/usr/bin/env node\nconsole.log('sk-opencode-test');\n", "utf8");
    await chmod(helperPath, 0o755);
    await writeFile(
      join(root, "development-credentials.json"),
      JSON.stringify({
        version: 1,
        credentials: [{
          id: "cred-oc",
          targetId: "opencode-test",
          label: "默认",
          store: "macos-keychain",
          account: "cred-oc",
          fingerprintSuffix: "1234",
          kind: "api_key",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }],
      }),
      "utf8",
    );
    const planCatalog = {
      schemaVersion: 2,
      catalogRevision: "2026.09.30.04",
      publishedAt: "2026-09-30T23:00:00+08:00",
      providers: {
        "opencode-go": {
          name: "OpenCode Go",
          brandId: "opencode",
          pricingProviderId: "opencode-go",
          region: "global",
          category: "aggregator",
          planTiers: [
            {id: "go", name: "OpenCode Go", monthlyFee: 10},
            {id: "go-plus", name: "OpenCode Go Plus", monthlyFee: 40},
          ],
          models: [],
        },
      },
    } as unknown as ProviderCatalog;
    const service = new SyncService({
      db,
      configStore: store,
      developmentCredentialsPath: join(root, "development-credentials.json"),
      consoleCredentialsPath: join(root, "console-credentials.json"),
      credentialHelperPath: helperPath,
      loadPlanCatalog: async () => planCatalog,
      fetchImpl: makeFetch(async url => {
        if (url.endsWith("/usage")) {
          return {usage: {
            rolling: {status: "ok", percent: 0, resetsAt: "2026-09-30T20:00:00Z"},
            weekly: {status: "ok", percent: 0, resetsAt: "2026-10-05T00:00:00Z"},
            monthly: {status: "ok", percent: 0, resetsAt: "2026-10-23T00:00:00Z"},
          }};
        }
        return {};
      }) as typeof fetch,
    });
    const base = {targetId: "opencode-test", providerType: "opencode-go" as const, credentialId: "cred-oc"};

    // 未选档位 → PLAN_TIER_REQUIRED（表单默认选中 go，直连调用必须显式携带）。
    const revision1 = store.getConfig().revision;
    await expect(service.savePlanSyncConfig({...base, expectedRevision: revision1})).rejects.toThrow("PLAN_TIER_REQUIRED");
    // 档位不在目录 planTiers → PLAN_TIER_INVALID。
    await expect(service.savePlanSyncConfig({...base, planTier: "vip", expectedRevision: revision1})).rejects.toThrow("PLAN_TIER_INVALID");
    // 合法档位 → 保存成功并落盘 target.pricing.planTier（估算分母随档位解析）。
    const saved = await service.savePlanSyncConfig({...base, planTier: "go-plus", expectedRevision: revision1});
    expect(saved.config.providerType).toBe("opencode-go");
    const persisted = store.getConfig().targets.find(target => target.id === "opencode-test");
    expect(persisted?.pricing?.planTier).toBe("go-plus");
    // 保存后立即同步成功（usage 快照落库）。
    const snapshots = db.prepare("SELECT COUNT(*) AS n FROM plan_quota_snapshots WHERE target_id = ?").get("opencode-test") as {n: number};
    expect(snapshots.n).toBeGreaterThan(0);
  });
});
