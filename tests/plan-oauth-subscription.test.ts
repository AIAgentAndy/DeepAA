import {describe, expect, test} from "vitest";
import {mkdtemp, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createServer} from "node:http";
import {
  parseAnthropicOAuthUsage,
  parseOpenAiWhamUsage,
  readCodexOAuthAuth,
  readClaudeOAuthCredentials,
} from "../src/lib/sync-engine/subscription-oauth.js";
import {createPlanAdapterRegistry} from "../src/lib/sync-engine/plan-registry.js";
import {resetOfficialUpstreamProxyCacheForTests} from "../src/proxy/official-upstream.js";
import {OpenAiSubscriptionPlanAdapter} from "../src/lib/sync-engine/adapters/plan/openai-subscription.js";
import {AnthropicSubscriptionPlanAdapter} from "../src/lib/sync-engine/adapters/plan/anthropic-subscription.js";
import type {PlanSyncInput} from "../src/lib/sync-engine/types.js";

function planInput(overrides: Partial<PlanSyncInput> = {}): PlanSyncInput {
  return {
    targetId: "target-1",
    baseUrl: "https://example.test",
    resolveCredential: async () => "",
    ...overrides,
  };
}

describe("OpenAI wham/usage 解析", () => {
  test("5h/7d 窗口按百分比快照输出", () => {
    const snapshots = parseOpenAiWhamUsage({
      plan_type: "plus",
      rate_limit: {
        primary_window: {used_percent: 23, limit_window_seconds: 18000, reset_at: 1744502400},
        secondary_window: {used_percent: 45, limit_window_seconds: 604800, reset_at: 1744934400},
      },
      credits: {has_credits: true, unlimited: false, balance: "42.50"},
    });
    expect(snapshots.map(snapshot => snapshot.windowLabel)).toEqual(["5h", "weekly"]);
    expect(snapshots[0]?.used).toBe(23);
    expect(snapshots[0]?.total).toBe(100);
    expect(snapshots[0]?.unit).toBe("percent");
    expect(snapshots[0]?.planName).toBe("OpenAI 订阅（ChatGPT/Codex）");
  });

  test("30 天免费档与 code review 窗口", () => {
    const snapshots = parseOpenAiWhamUsage({
      plan_type: "free",
      rate_limit: {
        primary_window: {used_percent: 5, limit_window_seconds: 2592000, reset_at: 1744934400},
        secondary_window: null,
      },
      code_review_rate_limit: {
        primary_window: {used_percent: 10, limit_window_seconds: 604800, reset_at: 1744934400},
      },
    });
    expect(snapshots.map(snapshot => snapshot.windowLabel)).toEqual(["30d", "code_review"]);
  });
});

describe("Anthropic oauth/usage 解析", () => {
  test("5h/7d + 模型级窗口 + extra usage 美分", () => {
    const snapshots = parseAnthropicOAuthUsage({
      five_hour: {utilization: 25, resets_at: "2026-01-28T15:00:00Z"},
      seven_day: {utilization: 40, resets_at: "2026-02-01T00:00:00Z"},
      seven_day_opus: {utilization: 5, resets_at: "2026-02-01T00:00:00Z"},
      extra_usage: {is_enabled: true, used_credits: 500, monthly_limit: 10000, currency: "USD"},
    });
    expect(snapshots.map(snapshot => snapshot.windowLabel)).toEqual([
      "5h",
      "weekly",
      "weekly_opus",
      "extra_usage",
    ]);
    expect(snapshots[0]?.unit).toBe("percent");
    expect(snapshots[3]?.used).toBe(5);
    expect(snapshots[3]?.total).toBe(100);
    expect(snapshots[3]?.unit).toBe("USD");
    expect(snapshots[3]?.planName).toBe("Anthropic 订阅（Claude Max/Pro）");
  });
});

describe("订阅 OAuth 凭据只读发现", () => {
  test("Codex auth.json 只读发现 OAuth token 与 accountId", async () => {
    const dir = await mkdtemp(join(tmpdir(), "codex-auth-"));
    await writeFile(join(dir, "auth.json"), JSON.stringify({
      auth_mode: "chatgpt",
      tokens: {access_token: "access-token", account_id: "account-1"},
    }));
    const found = await readCodexOAuthAuth(dir);
    expect(found).toEqual({accessToken: "access-token", accountId: "account-1"});
  });

  test("Claude credentials 文件只读发现 OAuth accessToken（preferFile 避免误读本机 Keychain）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claude-auth-"));
    await writeFile(join(dir, ".credentials.json"), JSON.stringify({
      claudeAiOauth: {accessToken: "claude-token"},
    }));
    const found = await readClaudeOAuthCredentials(dir, {preferFile: true});
    expect(found).toBe("claude-token");
  });
});

describe("订阅适配器同步", () => {
  test("OpenAI 订阅适配器：自动发现 Codex 凭据并同步窗口", async () => {
    const dir = await mkdtemp(join(tmpdir(), "codex-sync-"));
    await writeFile(join(dir, "auth.json"), JSON.stringify({
      auth_mode: "chatgpt",
      tokens: {access_token: "access-token", account_id: "account-1"},
    }));
    const adapter = new OpenAiSubscriptionPlanAdapter({
      codexHome: dir,
      fetchImpl: async () => new Response(JSON.stringify({
        plan_type: "plus",
        rate_limit: {
          primary_window: {used_percent: 10, limit_window_seconds: 18000, reset_at: 1744502400},
          secondary_window: {used_percent: 20, limit_window_seconds: 604800, reset_at: 1744934400},
        },
      }), {status: 200, headers: {"content-type": "application/json"}}),
    });
    const result = await adapter.sync(planInput({baseUrl: "https://api.openai.com/v1"}));
    expect(result.planQuota?.length).toBe(2);
  });

  test("OpenAI 订阅适配器：未检测到 Codex 凭据抛 AuthRequired", async () => {
    const dir = await mkdtemp(join(tmpdir(), "codex-empty-"));
    const adapter = new OpenAiSubscriptionPlanAdapter({codexHome: dir});
    await expect(
      () => adapter.sync(planInput()),
    ).rejects.toMatchObject({
      message: expect.stringContaining("SUBSCRIPTION_OAUTH_NOT_FOUND"),
    });
  });

  test("网络层失败折叠为 PLAN_FETCH_FAILED_*，不透出裸 fetch failed（2026-10-08 用户确认）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "codex-netfail-"));
    await writeFile(join(dir, "auth.json"), JSON.stringify({
      auth_mode: "chatgpt",
      tokens: {access_token: "access-token", account_id: "account-1"},
    }));
    // Anthropic 侧：macOS 会先查真实 Keychain，找不到才回落该文件；两条路径都到 fetch mock。
    await writeFile(join(dir, ".credentials.json"), JSON.stringify({
      claudeAiOauth: {accessToken: "claude-token"},
    }));
    const networkError = Object.assign(new TypeError("fetch failed"), {cause: {code: "ENOTFOUND"}});
    const openAi = new OpenAiSubscriptionPlanAdapter({codexHome: dir, fetchImpl: async () => {
      throw networkError;
    }});
    await expect(() => openAi.sync(planInput())).rejects.toThrow("PLAN_FETCH_FAILED_ENOTFOUND");

    const anthropic = new AnthropicSubscriptionPlanAdapter({claudeHome: dir, fetchImpl: async () => {
      throw networkError;
    }});
    await expect(() => anthropic.sync(planInput())).rejects.toThrow("PLAN_FETCH_FAILED_ENOTFOUND");
  });

  test("registry 装配路径（无 fetchImpl 注入）对官方上游走 CONNECT 隧道（2026-10-09 事故回归）", async () => {
    // 事故根因：createPlanAdapterRegistry 曾把未注入的 fetchImpl 规范化为全局 fetch，
    // 导致 fetchOfficialUsage 的隧道条件永假、生产 SyncService 直连官方域超时
    // （PLAN_FETCH_FAILED_UND_ERR_CONNECT_TIMEOUT）。本用例经 registry 装配（与生产
    // 完全同路径）断言：显式代理下请求确实以 CONNECT 打到代理，而非直连。
    const connectTargets: string[] = [];
    const denyProxy = createServer();
    denyProxy.on("connect", (request, socket) => {
      connectTargets.push(String(request.url ?? ""));
      socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
    });
    await new Promise<void>(resolve => denyProxy.listen(0, "127.0.0.1", resolve));
    const proxyPort = (denyProxy.address() as {port: number}).port;
    process.env.DEEPAA_UPSTREAM_PROXY = `http://127.0.0.1:${String(proxyPort)}`;
    resetOfficialUpstreamProxyCacheForTests();
    try {
      const dir = await mkdtemp(join(tmpdir(), "codex-registry-tunnel-"));
      await writeFile(join(dir, "auth.json"), JSON.stringify({
        auth_mode: "chatgpt",
        tokens: {access_token: "access-token", account_id: "account-1"},
      }));
      // 与生产 SyncService 相同：registry 不注入 fetchImpl。
      const registry = createPlanAdapterRegistry({codexHome: dir});
      const adapter = registry.get("openai-subscription");
      expect(adapter).toBeDefined();
      await expect(() => adapter!.sync(planInput())).rejects.toThrow(/PLAN_FETCH_FAILED/u);
      // 隧道被真实走到：代理收到了对 chatgpt.com 的 CONNECT（旧 bug 下这里是
      // 直连超时、代理零命中）。
      expect(connectTargets).toEqual(["chatgpt.com:443"]);
    } finally {
      delete process.env.DEEPAA_UPSTREAM_PROXY;
      resetOfficialUpstreamProxyCacheForTests();
      await new Promise<void>(resolve => denyProxy.close(() => resolve()));
    }
  });

  test("Anthropic 订阅适配器：凭据文件发现并同步窗口", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claude-sync-"));
    await writeFile(join(dir, ".credentials.json"), JSON.stringify({
      claudeAiOauth: {accessToken: "claude-token"},
    }));
    const adapter = new AnthropicSubscriptionPlanAdapter({
      claudeHome: dir,
      fetchImpl: async () => new Response(JSON.stringify({
        five_hour: {utilization: 25, resets_at: "2026-01-28T15:00:00Z"},
        seven_day: {utilization: 40, resets_at: "2026-02-01T00:00:00Z"},
      }), {status: 200, headers: {"content-type": "application/json"}}),
    });
    const result = await adapter.sync(planInput({baseUrl: "https://api.anthropic.com"}));
    expect(result.planQuota?.length).toBe(2);
  });
});
