import {describe, expect, test} from "vitest";
import {
  codexCliFormForTarget,
  isOpenAiSubscriptionTarget,
  subscriptionLaunchNotice,
  subscriptionLoginHint,
  subscriptionLoginHintForTarget,
  subscriptionLoginMissingNotice,
  subscriptionNetworkNotice,
  subscriptionReloginNotice,
  subscriptionWizardNotice,
} from "../src/lib/subscription-display.js";

/**
 * 订阅通道提示按预设分化守卫（2026-10-08 用户确认）。
 *
 * 订阅目标与官方 CLI 一一对应：openai-subscription → Codex CLI、anthropic-subscription →
 * Claude Code CLI。单一订阅目标的提示绝不允许再出现另一家 CLI 的登录指引；仅识别不出
 * 归属的订阅目标（双协议并存的手工配置）才回退合并文案。
 */

const openaiSubscriptionTarget = {
  presetId: "openai-subscription",
  billingChannel: "subscription" as const,
  openaiUrl: "https://chatgpt.com/backend-api/codex",
};

const anthropicSubscriptionTarget = {
  presetId: "anthropic-subscription",
  billingChannel: "subscription" as const,
  anthropicUrl: "https://api.anthropic.com",
};

describe("subscriptionLoginHint key 解析", () => {
  test("预设 id、套餐 providerType 与 Agent id 同键位命中", () => {
    expect(subscriptionLoginHint("openai-subscription")?.cliLabel).toBe("Codex CLI");
    expect(subscriptionLoginHint("codex")?.reloginCommand).toBe("codex login");
    expect(subscriptionLoginHint("anthropic-subscription")?.cliLabel).toBe("Claude Code CLI");
    expect(subscriptionLoginHint("claude")?.reloginCommand).toBe("claude 后输入 /login");
  });

  test("非订阅键返回 undefined，由调用方决定回退", () => {
    expect(subscriptionLoginHint("deepseek")).toBeUndefined();
    expect(subscriptionLoginHint(undefined)).toBeUndefined();
  });
});

describe("subscriptionLoginHintForTarget 目标分化", () => {
  test("无预设的自定义订阅目标按协议 URL 判定", () => {
    expect(subscriptionLoginHintForTarget({
      billingChannel: "subscription",
      openaiUrl: "https://chatgpt.com/backend-api/codex",
    }).cliLabel).toBe("Codex CLI");
    expect(subscriptionLoginHintForTarget({
      billingChannel: "subscription",
      anthropicUrl: "https://api.anthropic.com",
    }).cliLabel).toBe("Claude Code CLI");
  });

  test("双协议并存且无法归入订阅预设时回退合并文案", () => {
    // 注：任一 URL 命中订阅预设（如 chatgpt.com/backend-api/codex）时仍按预设精确分化；
    // 这里用中性 URL 构造真正的兜底场景（仅手工编辑配置可产生）。
    const hint = subscriptionLoginHintForTarget({
      billingChannel: "subscription",
      openaiUrl: "https://relay.example.com/v1",
      anthropicUrl: "https://mirror.example.com",
    });
    expect(hint.cliLabel).toContain("Codex / Claude");
    expect(hint.reloginCommand).toContain("codex login");
    expect(hint.reloginCommand).toContain("claude");
  });
});

describe("各消费面文案", () => {
  test("接入向导提示按目标分化", () => {
    expect(subscriptionWizardNotice(openaiSubscriptionTarget)).not.toMatch(/claude/i);
    expect(subscriptionWizardNotice(anthropicSubscriptionTarget)).not.toMatch(/codex/i);
  });

  test("开发启动提示：codex 引导官方模式，claude 引导登录；其它 Agent 走通用透传表述", () => {
    // codex 因 ChatGPT 原生 wire 阻断（2026-10-09）只能引导「官方模式 + 直连导入」。
    expect(subscriptionLaunchNotice("codex")).toContain("官方模式");
    expect(subscriptionLaunchNotice("codex")).not.toMatch(/claude/i);
    expect(subscriptionLaunchNotice("claude")).toContain("claude 后输入 /login");
    expect(subscriptionLaunchNotice("claude")).not.toMatch(/codex/i);
    expect(subscriptionLaunchNotice("zcode")).toContain("ZCode");
    expect(subscriptionLaunchNotice("zcode")).not.toContain("官方模式");
  });

  test("套餐同步失败重登指引按 providerType 分化，未知类型回退合并", () => {
    expect(subscriptionReloginNotice("openai-subscription")).toContain("codex login");
    expect(subscriptionReloginNotice("openai-subscription")).not.toMatch(/claude/i);
    expect(subscriptionReloginNotice("anthropic-subscription")).toContain("claude 后输入 /login");
    expect(subscriptionReloginNotice("anthropic-subscription")).not.toMatch(/codex/i);
    expect(subscriptionReloginNotice(undefined)).toContain("codex login");
    expect(subscriptionReloginNotice(undefined)).toContain("claude");
  });

  test("未登录（NOT_FOUND）与已过期（REJECTED）文案严格分化（2026-10-08 用户确认）", () => {
    const missing = subscriptionLoginMissingNotice("openai-subscription");
    expect(missing).toContain("未检测到本机 Codex CLI 登录态");
    expect(missing).toContain("codex login");
    expect(missing).not.toContain("已过期");
    expect(missing).not.toMatch(/claude/i);
    expect(subscriptionLoginMissingNotice("anthropic-subscription")).toContain("claude 后输入 /login");
    // 对照：REJECTED 才允许出现「已过期」。
    expect(subscriptionReloginNotice("openai-subscription")).toContain("已过期");
    expect(subscriptionReloginNotice("openai-subscription")).not.toContain("未检测到");
  });

  test("网络层失败指引按 providerType 给出官方域名", () => {
    expect(subscriptionNetworkNotice("openai-subscription")).toContain("chatgpt.com");
    expect(subscriptionNetworkNotice("anthropic-subscription")).toContain("api.anthropic.com");
    expect(subscriptionNetworkNotice(undefined)).toContain("官方服务");
  });
});

describe("codexCliFormForTarget CLI 形态需求（2026-10-09 用户确认，仅 codex）", () => {
  test("OpenAI 订阅预设目标 → 官方直连（ChatGPT 原生 wire 无法经网关路由）", () => {
    expect(codexCliFormForTarget(openaiSubscriptionTarget)).toBe("official");
    // 仅 URL 命中订阅预设（手工编辑配置）同样按预设判定官方直连。
    expect(codexCliFormForTarget({
      billingChannel: "subscription",
      openaiUrl: "https://chatgpt.com/backend-api/codex",
    })).toBe("official");
  });

  test("非 OpenAI 订阅预设一律网关模式", () => {
    expect(codexCliFormForTarget({
      openaiUrl: "https://relay.example/v1",
      billingChannel: "pay_as_you_go",
    })).toBe("gateway");
    // 套餐通道（非订阅）与其它官方预设同样走网关。
    expect(codexCliFormForTarget({
      presetId: "zhipu-coding-plan",
      billingChannel: "plan",
      openaiUrl: "https://open.bigmodel.cn/api/paas/v4",
    })).toBe("gateway");
    // Claude 订阅预设与 codex 无关（双协议目标的 openai 位非订阅预设）。
    expect(codexCliFormForTarget(anthropicSubscriptionTarget)).toBe("gateway");
  });
});

describe("isOpenAiSubscriptionTarget 判定", () => {
  test("仅 openai-subscription 预设命中", () => {
    expect(isOpenAiSubscriptionTarget(openaiSubscriptionTarget)).toBe(true);
    expect(isOpenAiSubscriptionTarget(anthropicSubscriptionTarget)).toBe(false);
    expect(isOpenAiSubscriptionTarget({openaiUrl: "https://api.openai.com/v1"})).toBe(false);
  });
});
