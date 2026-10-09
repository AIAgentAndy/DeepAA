import {expect, test} from "vitest";
import {OpenRouterBalanceAdapter} from "../src/lib/sync-engine/adapters/openrouter.js";
import {OpenCodeGoPlanAdapter} from "../src/lib/sync-engine/adapters/plan/opencode-go.js";
import {SyncAuthRequiredError} from "../src/lib/sync-engine/types.js";
import {createBalanceConnectorRegistry} from "../src/lib/provider-plugins/index.js";

const input = {
  targetId: "target", consoleBaseUrl: "https://example.test", username: "", password: "",
  credentials: [{id: "cred", label: "主密钥", fingerprintSuffix: "1234"}], defaultCredentialId: "cred",
  resolveCredential: async () => "sk-test",
};

test("OpenRouter 优先走 /api/v1/key，解析 limit_remaining/limit/usage", async () => {
  const adapter = new OpenRouterBalanceAdapter(async (url, init) => {
    expect(String(url)).toBe("https://example.test/api/v1/key");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer sk-test");
    return new Response(JSON.stringify({
      data: {label: "主密钥", limit: 20, limit_remaining: 16.5, usage: 3.5, is_free_tier: false},
    }));
  });
  expect(await adapter.sync(input)).toMatchObject({
    balance: {currency: "USD", amount: 16.5, quota: 20, usedQuota: 3.5, source: "openrouter"},
  });
});

test("OpenRouter /api/v1/key 不可用时回退 credits，401 映射为鉴权错误", async () => {
  let calls = 0;
  const adapter = new OpenRouterBalanceAdapter(async (url, init) => {
    calls += 1;
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer sk-test");
    if (String(url).endsWith("/api/v1/key")) return new Response("not found", {status: 404});
    expect(String(url)).toBe("https://example.test/api/v1/credits");
    return new Response(JSON.stringify({data: {total_credits: 20, total_usage: 3.5}}));
  });
  expect(await adapter.sync(input)).toMatchObject({
    balance: {currency: "USD", amount: 16.5, quota: 20, usedQuota: 3.5, source: "openrouter"},
  });
  expect(calls).toBe(2);

  const unauthorized = new OpenRouterBalanceAdapter(async () => new Response("unauthorized", {status: 401}));
  await expect(unauthorized.sync(input)).rejects.toBeInstanceOf(SyncAuthRequiredError);
});

test("SiliconFlow 余额接口已下线：注册表降级为 NoBalance，不再调用 /user/info", () => {
  // 2026-08-14 官方下线 /v1/user/info 且无替代（2026-09-29 调研确认）；
  // 专属适配器移除，注册表与预设账号能力统一降级为 NoBalance/manual。
  const registry = createBalanceConnectorRegistry();
  expect(registry.get("siliconflow")?.providerType).toBe("siliconflow");
  expect(registry.get("siliconflow")?.capabilities.balance).toBe(false);
  expect(registry.get("siliconflow")?.capabilities.auth).toBe("manual");
});

test("OpenCode Go 套餐同步解析官方 percent/resetsAt 结构并保存三个窗口", async () => {
  const adapter = new OpenCodeGoPlanAdapter(async (url, init) => {
    expect(String(url)).toBe("https://opencode.ai/zen/go/v1/usage");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer sk-test");
    return new Response(JSON.stringify({
      usage: {
        rolling: {status: "ok", percent: 31.2, resetsAt: "2026-08-19T22:00:00Z"},
        weekly: {status: "ok", percent: 44.5, resetsAt: "2026-08-24T00:00:00Z"},
        monthly: {status: "ok", percent: 50.1, resetsAt: "2026-09-01T00:00:00Z"},
      },
    }));
  });
  const result = await adapter.sync({targetId: "target", baseUrl: "https://opencode.ai/zen/go/v1", credentialId: "cred", resolveCredential: async () => "sk-test"});
  expect(result.planQuota).toEqual(expect.arrayContaining([
    // 固定套餐名随快照返回：目录档位表（planTiers）按该名精确回填月费。
    expect.objectContaining({planName: "OpenCode Go", windowLabel: "5h", used: 31.2, total: 100, unit: "percent", resetAt: "2026-08-19T22:00:00.000Z"}),
    expect.objectContaining({planName: "OpenCode Go", windowLabel: "weekly", used: 44.5, total: 100, unit: "percent", resetAt: "2026-08-24T00:00:00.000Z"}),
    expect.objectContaining({planName: "OpenCode Go", windowLabel: "monthly", used: 50.1, total: 100, unit: "percent", resetAt: "2026-09-01T00:00:00.000Z"}),
  ]));
});

test("OpenCode Go 兼容旧 used/total、resetInSec，401 映射为鉴权错误且空窗口报稳定错误", async () => {
  const adapter = new OpenCodeGoPlanAdapter(async () => new Response(JSON.stringify({
    usage: {
      rolling: {used: 1, total: 10, resetInSec: 7200},
      weekly: {used: 2, total: 20, resetInSec: 345_600},
    },
  })));
  const result = await adapter.sync({targetId: "target", baseUrl: "https://opencode.ai/zen/go/v1", credentialId: "cred", resolveCredential: async () => "sk-test"});
  expect(result.planQuota).toHaveLength(2);

  const unauthorized = new OpenCodeGoPlanAdapter(async () => new Response("unauthorized", {status: 401}));
  await expect(unauthorized.sync({
    targetId: "target", baseUrl: "https://opencode.ai/zen/go/v1", credentialId: "cred", resolveCredential: async () => "sk-test",
  })).rejects.toBeInstanceOf(SyncAuthRequiredError);

  const empty = new OpenCodeGoPlanAdapter(async () => new Response(JSON.stringify({usage: {}})));
  await expect(empty.sync({
    targetId: "target", baseUrl: "https://opencode.ai/zen/go/v1", credentialId: "cred", resolveCredential: async () => "sk-test",
  })).rejects.toThrow("OPENCODE_GO_USAGE_INVALID");
});
