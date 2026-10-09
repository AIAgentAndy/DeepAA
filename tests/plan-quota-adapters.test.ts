import {describe, expect, test} from "vitest";
import {
  KimiCodingPlanAdapter,
  parseKimiPlanQuota,
} from "../src/lib/sync-engine/adapters/plan/kimi-coding.js";
import {
  parseZhipuPlanQuota,
  ZhipuPlanAdapter,
} from "../src/lib/sync-engine/adapters/plan/zhipu.js";
import {
  MiniMaxPlanAdapter,
  parseMiniMaxPlanQuota,
} from "../src/lib/sync-engine/adapters/plan/minimax.js";
import {createPlanAdapterRegistry} from "../src/lib/sync-engine/plan-registry.js";
import {QwenAiTokenPlanAdapter, parseQwenAiTokenPlanQuota} from "../src/lib/sync-engine/adapters/plan/qwenai-token-plan.js";
import {SyncAuthRequiredError} from "../src/lib/sync-engine/types.js";

function makePlanInput(overrides: Partial<{
  targetId: string;
  baseUrl: string;
  credentialId: string;
  apiKey: string;
}> = {}) {
  const values = {
    targetId: "target-1",
    baseUrl: "https://example.com/v1",
    credentialId: "cred-1",
    apiKey: "secret-key",
    ...overrides,
  };
  return {
    targetId: values.targetId,
    baseUrl: values.baseUrl,
    credentialId: values.credentialId,
    resolveCredential: async (credentialId: string) => {
      expect(credentialId).toBe(values.credentialId);
      return values.apiKey;
    },
  };
}

describe("套餐适配器注册表", () => {
  test("注册全部套餐适配器且声明额度能力（含两个订阅适配器）", () => {
    const registry = createPlanAdapterRegistry();
    expect([...registry.keys()]).toEqual([
      "kimi-coding",
      "zhipu",
      "minimax",
      "volcengine-plan",
      "volcengine-coding-plan",
      "qwenai-token-plan",
      "tencent-tokenhub-plan",
      "opencode-go",
      "openai-subscription",
      "anthropic-subscription",
    ]);
    for (const [providerType, adapter] of registry) {
      expect(adapter.capabilities).toEqual({
        balance: false,
        rates: false,
        quota: providerType !== "qwenai-token-plan",
        auth: providerType === "volcengine-plan" || providerType === "volcengine-coding-plan" || providerType === "tencent-tokenhub-plan"
          ? "access_key"
          : providerType === "openai-subscription" || providerType === "anthropic-subscription"
            ? "oauth"
            : "api_key",
      });
    }
  });
});

describe("Kimi For Coding 套餐适配器", () => {
  test("解析 5 小时和周窗口并容忍未知字段", () => {
    expect(parseKimiPlanQuota({
      unknown: {future: true},
      limits: [{
        detail: {
          limit: "100",
          remaining: 40,
          resetTime: 1_780_329_600_000,
          futureField: "kept-in-raw",
        },
      }],
      usage: {
        limit: 1_000,
        remaining: "250",
        resetTime: "2026-08-24T00:00:00.000Z",
      },
    })).toEqual([
      expect.objectContaining({
        planName: "Kimi For Coding",
        windowLabel: "5h",
        used: 60,
        total: 100,
        unit: "quota",
        resetAt: expect.stringMatching(/^2026-/u),
      }),
      expect.objectContaining({
        windowLabel: "weekly",
        used: 750,
        total: 1_000,
        unit: "quota",
        resetAt: "2026-08-24T00:00:00.000Z",
      }),
    ]);
  });

  test("新档会员 monthly 月额度窗口防御解析（2026-09-30）", () => {
    expect(parseKimiPlanQuota({
      data: {
        limits: [{detail: {limit: 100, used: 30, reset_in: 3600}}],
        monthly: {limit: 3000, remaining: 2500, resetAt: "2026-10-01T00:00:00Z"},
      },
    })).toEqual([
      expect.objectContaining({windowLabel: "5h", used: 30, total: 100}),
      expect.objectContaining({windowLabel: "monthly", used: 500, total: 3000, resetAt: "2026-10-01T00:00:00.000Z"}),
    ]);
    // 无 monthly 字段时维持老档语义（5h + weekly），不产伪月窗。
    expect(parseKimiPlanQuota({
      limits: [{detail: {limit: 100, used: 30}}],
      usage: {limit: 1000, used: 400},
    }).map(item => item.windowLabel)).toEqual(["5h", "weekly"]);
  });

  test("解析 Kimi Code 新版 usages 窗口结构", () => {
    expect(parseKimiPlanQuota({
      usages: {
        limit5h: {limit: 100, used: 25, resetAt: "2026-10-04T01:00:00Z"},
        limit7d: {limit: 1000, remaining: 600, resetAt: "2026-10-06T00:00:00Z"},
        monthTotal: {limit: 5000, used: 1200, resetAt: "2026-11-01T00:00:00Z"},
        monthCode: {limit: 3000, remaining: 2400, resetAt: "2026-11-01T00:00:00Z"},
        extraUsage: {limit: 50, used: 5},
      },
    })).toEqual([
      expect.objectContaining({windowLabel: "5h", used: 25, total: 100}),
      expect.objectContaining({windowLabel: "weekly", used: 400, total: 1000}),
      expect.objectContaining({windowLabel: "monthly", used: 1200, total: 5000}),
      expect.objectContaining({windowLabel: "monthly_code", used: 600, total: 3000}),
      expect.objectContaining({windowLabel: "extra_usage", used: 5, total: 50, unit: "credits"}),
    ]);
  });

  test("非法数字与空额度不生成伪快照", () => {
    expect(parseKimiPlanQuota({
      limits: [{detail: {limit: "invalid", remaining: 0}}],
      usage: {limit: Number.POSITIVE_INFINITY, remaining: 1},
    })).toEqual([]);
  });

  test("兼容 data 包装、直接 used 字段与多种重置字段", () => {
    expect(parseKimiPlanQuota({
      data: {
        limits: [{detail: {limit: 50, used: 10, reset_in: 3600}}],
        usage: {limit: 200, used: 40, resetAt: "2026-08-24T00:00:00Z"},
      },
    })).toEqual([
      expect.objectContaining({
        windowLabel: "5h",
        used: 10,
        total: 50,
        unit: "quota",
        resetAt: expect.any(String),
      }),
      expect.objectContaining({
        windowLabel: "weekly",
        used: 40,
        total: 200,
        unit: "quota",
        resetAt: "2026-08-24T00:00:00.000Z",
      }),
    ]);
  });

  test("使用固定官方端点和 Bearer 密钥，401 映射为鉴权错误", async () => {
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://api.kimi.com/coding/v1/usages");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer secret-key");
      return new Response("{}", {status: 401});
    }) as typeof fetch;
    const adapter = new KimiCodingPlanAdapter(fetchImpl);
    await expect(adapter.sync(makePlanInput())).rejects.toBeInstanceOf(SyncAuthRequiredError);
  });
});

describe("智谱套餐适配器", () => {
  test("优先保留供应商返回的真实积分、剩余积分和窗口总额", () => {
    expect(parseZhipuPlanQuota({
      success: true,
      data: {
        level: "pro",
        limits: [
          {type: "CREDIT_LIMIT", unit: 6, number: 1, usage: 60_000, currentValue: 32_604, remaining: 27_395, percentage: 54, nextResetTime: 1_788_359_573_997},
          {type: "CREDIT_LIMIT", unit: 3, number: 5, usage: 12_000, currentValue: 0, remaining: 12_000, percentage: 0},
          {type: "TIME_LIMIT", percentage: 99},
        ],
        futureField: true,
      },
    })).toEqual([
      expect.objectContaining({planName: "pro", windowLabel: "5h", used: 0, total: 12_000, remaining: 12_000, unit: "credits"}),
      expect.objectContaining({planName: "pro", windowLabel: "weekly", used: 32_604, total: 60_000, remaining: 27_395, unit: "credits"}),
    ]);
  });

  test("缺少具体积分时保留百分比兜底，无额度记录时返回空", () => {
    expect(parseZhipuPlanQuota({
      success: true,
      data: {
        level: "max",
        limits: [
          {type: "TOKENS_LIMIT", unit: 6, percentage: 42, nextResetTime: 1_780_300_000_000},
          {type: "tokens_limit", unit: 3, percentage: 1, nextResetTime: 1_780_400_000_000},
        ],
      },
    })).toEqual([
      expect.objectContaining({windowLabel: "5h", used: 1, total: 100, unit: "percent"}),
      expect.objectContaining({windowLabel: "weekly", used: 42, total: 100, unit: "percent"}),
    ]);
    expect(parseZhipuPlanQuota({success: true, data: {limits: [{type: "TIME_LIMIT"}]}}))
      .toEqual([]);
  });

  test("按目标区域选择 host，Authorization 直接使用 API Key，429 稳定失败", async () => {
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://bigmodel.cn/api/monitor/usage/quota/limit");
      expect(new Headers(init?.headers).get("authorization")).toBe("secret-key");
      return new Response(JSON.stringify({message: "slow down"}), {status: 429});
    }) as typeof fetch;
    const adapter = new ZhipuPlanAdapter(fetchImpl);
    await expect(adapter.sync(makePlanInput({
      baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    }))).rejects.toThrow("PLAN_HTTP_429");
  });
});

describe("MiniMax 套餐适配器", () => {
  test("只解析 general，剩余百分比反转为已用百分比并跳过未启用周窗口", () => {
    expect(parseMiniMaxPlanQuota({
      model_remains: [
        {model_name: "video", current_interval_remaining_percent: 10},
        {
          model_name: "general",
          current_interval_remaining_percent: 98,
          current_weekly_remaining_percent: 95,
          current_weekly_status: 1,
          end_time: 1_780_329_600_000,
          weekly_end_time: 1_780_848_000_000,
          futureField: "ignored",
        },
      ],
      base_resp: {status_code: 0},
    })).toEqual([
      expect.objectContaining({windowLabel: "5h", used: 2, total: 100, unit: "percent"}),
      expect.objectContaining({windowLabel: "weekly", used: 5, total: 100, unit: "percent"}),
    ]);
    expect(parseMiniMaxPlanQuota({
      model_remains: [{
        model_name: "general",
        current_interval_remaining_percent: 99,
        current_weekly_remaining_percent: 100,
        current_weekly_status: 3,
      }],
    })).toHaveLength(1);
  });

  test("中国区与国际区使用各自固定 host，并在解析前拒绝超限响应", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response(" ".repeat(1024 * 1024 + 1), {
        status: 200,
        headers: {"content-type": "application/json"},
      });
    }) as typeof fetch;
    const adapter = new MiniMaxPlanAdapter(fetchImpl);
    await expect(adapter.sync(makePlanInput({
      baseUrl: "https://api.minimax.io/v1",
    }))).rejects.toThrow("PLAN_RESPONSE_TOO_LARGE");
    expect(calls).toEqual([
      "https://api.minimax.io/v1/api/openplatform/coding_plan/remains",
    ]);
  });

  test("中国区 token_plan 官方现行接口优先、coding_plan 旧接口回退；国际区只走旧路径", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response(JSON.stringify({base_resp: {status_code: 0}, model_remains: []}), {
        status: 200,
        headers: {"content-type": "application/json"},
      });
    }) as typeof fetch;
    const adapter = new MiniMaxPlanAdapter(fetchImpl);
    await adapter.sync(makePlanInput({baseUrl: "https://api.minimax.cn/v1"}));
    await adapter.sync(makePlanInput({baseUrl: "https://api.minimax.io/v1"}));
    // 2026-09-30 域名主链：官方 FAQ 唯一文档化域 www.minimax.cn 为主、api.minimax.cn 实测兜底
    // （同日对调主次序）；项目未上线，不留 minimaxi.com 旧域兜底；国际区仍走旧路径。
    expect(calls).toEqual([
      "https://www.minimax.cn/v1/token_plan/remains",
      "https://api.minimax.cn/v1/token_plan/remains",
      "https://api.minimax.io/v1/api/openplatform/coding_plan/remains",
    ]);
  });

  test("优先选择 minimax-m* 通配模型，count 统一表示已用量", () => {
    expect(parseMiniMaxPlanQuota({
      model_remains: [
        {model_name: "MiniMax-M2.7", current_interval_total_count: 100, current_interval_usage_count: 30, remains_time: 2_777_000},
        {model_name: "minimax-m*", current_interval_total_count: 200, current_interval_usage_count: 50, remains_time: 3_600_000},
      ],
      base_resp: {status_code: 0},
    }, {baseUrl: "https://api.minimax.io/v1"})).toEqual([
      expect.objectContaining({
        windowLabel: "5h",
        used: 50,
        total: 200,
        unit: "count",
        resetAt: expect.any(String),
      }),
    ]);
  });

  test("新接口返回有效额度时不再回退旧接口", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response(JSON.stringify({
        base_resp: {status_code: 0},
        model_remains: [{
          model_name: "MiniMax-M3",
          current_interval_total_count: 100,
          current_interval_usage_count: 25,
          remains_time: 3_600_000,
        }],
      }), {
        status: 200,
        headers: {"content-type": "application/json"},
      });
    }) as typeof fetch;
    const adapter = new MiniMaxPlanAdapter(fetchImpl);
    const result = await adapter.sync(makePlanInput({baseUrl: "https://api.minimax.cn/v1"}));
    expect(calls).toEqual([
      "https://www.minimax.cn/v1/token_plan/remains",
    ]);
    expect(result.planQuota).toEqual([
      expect.objectContaining({windowLabel: "5h", used: 25, total: 100, unit: "count"}),
    ]);
  });

  test("中国区 count 表示已用量，百分比字段仅作兜底", () => {
    expect(parseMiniMaxPlanQuota({
      model_remains: [{
        model_name: "MiniMax-M3",
        current_interval_total_count: 100,
        current_interval_usage_count: 25,
        current_interval_remaining_percent: 75,
        remains_time: 3_600_000,
      }],
      base_resp: {status_code: 0},
    }, {baseUrl: "https://api.minimaxi.com/v1"})).toEqual([
      expect.objectContaining({windowLabel: "5h", used: 25, total: 100, unit: "count"}),
    ]);
  });
});


describe("千问 AI Token Plan 套餐适配器", () => {
  test("保留团队统计 payload 解析函数，输出月度 Credits 快照", () => {
    const snapshots = parseQwenAiTokenPlanQuota({
      Success: true,
      Data: {
        SubscriptionStartTime: 1_788_328_800_000,
        SubscriptionEndTime: 1_790_920_800_000,
        Items: [{
          SeatType: "standard",
          SeatRefreshTime: 1_790_920_800_000,
          TotalSeats: 2,
          AssignedSeats: 1,
          SeatCredits: 20_000,
          SeatRemainingCredits: 12_500,
        }],
      },
    });
    expect(snapshots).toEqual([expect.objectContaining({
      planName: "百炼 Token Plan standard",
      windowLabel: "monthly",
      used: 7_500,
      total: 20_000,
      remaining: 12_500,
      unit: "credits",
    })]);
  });

  test("个人版 usage 无稳定公开查询接口时明确降级控制台查看", async () => {
    const adapter = new QwenAiTokenPlanAdapter();
    await expect(adapter.sync({
      targetId: "qwenai-token-plan",
      baseUrl: "https://token-plan.maas.qianwenaiapi.com/compatible-mode/v1",
      credentialId: "credential",
      resolveCredential: async () => "sk-sp-test",
    })).rejects.toThrow("QWENAI_TOKEN_PLAN_USAGE_CONSOLE_ONLY");
  });
});
