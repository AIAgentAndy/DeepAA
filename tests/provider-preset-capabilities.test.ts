import {describe, expect, test} from "vitest";
import {readFile} from "node:fs/promises";
import {PROVIDER_PRESETS, resolveProviderAccountCapability, type OpenAiWireApi} from "../src/lib/provider-presets.js";
import {parseProviderCatalogText} from "../src/lib/provider-catalog/normalize.js";
import {isValidCatalogRevision, isValidRfc3339WithZone} from "../src/lib/provider-catalog/catalog-contract.js";
import {
  resolveOfficialPresetForTarget,
  resolveTargetAgentCapability,
} from "../src/lib/provider-preset-capabilities.js";
import {resolvePlanProviderForTarget} from "../src/lib/sync-engine/plan-provider.js";

describe("官方预设协议能力", () => {
  test("本期新增官方预设完整注册且保留既有官方预设", () => {
    expect(PROVIDER_PRESETS.map(item => item.id)).toEqual(expect.arrayContaining([
      "deepseek", "zhipu-cn", "moonshot-cn", "minimax-cn", "volcengine-plan",
      "openrouter", "siliconflow", "qwenai", "opencode-go",
      // 本期新增：订阅通道 + 套餐通道（国内区优先）
      "openai-subscription", "anthropic-subscription", "zhipu-coding-plan",
      "kimi-coding", "minimax-plan", "volcengine-coding-plan",
      "qwenai-token-plan",
      // 2026-09-29 新增：腾讯 TokenHub 双通道（按量 + Token Plan 个人版积分套餐）
      "tencent-tokenhub", "tencent-tokenhub-plan",
    ]));
    expect(PROVIDER_PRESETS.length).toBe(18);
    // 本期移除：官方按量与国际区按量通道（订阅/套餐通道保留）。
    for (const removed of ["openai", "anthropic", "zhipu-global", "minimax-global"]) {
      expect(PROVIDER_PRESETS.some(item => item.id === removed), removed).toBe(false);
    }
    // 2026-09-02 用户确认：腾讯混元 Token Plan 官方规则变化，预设整体移除；
    // 2026-09-04 用户确认：混元按量预设与目录条目一并移除（官方迁移 TokenHub）。
    expect(PROVIDER_PRESETS.some(item => item.id === "tencent-hunyuan-plan")).toBe(false);
    expect(PROVIDER_PRESETS.some(item => item.id === "tencent-hunyuan")).toBe(false);
  });

  test("随包目录覆盖全部可用预设且元信息满足 v2 契约", async () => {
    const catalog = parseProviderCatalogText(
      await readFile("data/defaults/llm_catalog.jsonl", "utf8"),
    ).catalog;
    // 版本号本身随每次发布变化，不钉具体值，只钉契约：catalogRevision 固定宽度可字典序比较、
    // publishedAt 为 RFC 3339 带时区（版本闸门的比较前提）。
    expect(isValidCatalogRevision(catalog.catalogRevision)).toBe(true);
    expect(isValidRfc3339WithZone(catalog.publishedAt)).toBe(true);
    for (const preset of PROVIDER_PRESETS.filter(item => item.ready)) {
      expect(catalog.providers[preset.catalogKey]?.models, preset.id).toBeDefined();
    }
  });

  test("所有进入下拉的预设都有显式账号和套餐策略，不能用通用 manual 伪装完成", () => {
    for (const preset of PROVIDER_PRESETS) {
      if (!preset.creationHidden) expect(preset.ready, preset.id).toBe(true);
      expect(preset.accountSync?.providerType, preset.id).not.toBe("manual");
      expect(preset.planSync, preset.id).toBeDefined();
    }
    // creationHidden = 临时下架（不进新建官方预设下拉，2026-10-09 anthropic-subscription
    // 机制待修复）：能力字段必须保持完整，存量目标与后端消费链路不受隐藏影响。
    const hidden = PROVIDER_PRESETS.filter(preset => preset.creationHidden);
    expect(hidden.map(preset => preset.id)).toEqual(["anthropic-subscription"]);
    for (const preset of hidden) {
      expect(preset.ready, preset.id).toBe(false);
      expect(preset.accountSync, preset.id).toBeDefined();
      expect(preset.planSync, preset.id).toBeDefined();
    }
  });

  test("无自动余额接口的官方预设账号策略统一为手工查看", () => {
    for (const id of ["minimax-cn", "volcengine-plan", "qwenai", "opencode-go",
      "openai-subscription", "anthropic-subscription", "zhipu-coding-plan", "kimi-coding", "minimax-plan",
      "volcengine-coding-plan", "qwenai-token-plan",
      // 2026-09-29：SiliconFlow /v1/user/info 官方已下线且无替代，降级手工查看。
      "siliconflow"]) {
      expect(PROVIDER_PRESETS.find(item => item.id === id)?.accountSync?.auth, id).toBe("manual");
    }
    expect(resolveProviderAccountCapability("openai")?.balance).toBe("unsupported");
    expect(resolveProviderAccountCapability("openrouter")?.balance).toBe("supported");
  });

  test("新增供应商协议矩阵按官方能力声明，不把 Chat 自动当作 Responses", () => {
    expect(PROVIDER_PRESETS.find(item => item.id === "openrouter")?.openaiWireApis)
      .toEqual(["chat_completions", "responses"]);
    expect(PROVIDER_PRESETS.find(item => item.id === "siliconflow")?.openaiWireApis)
      .toEqual(["chat_completions"]);
    expect(PROVIDER_PRESETS.find(item => item.id === "qwenai")?.openaiWireApis)
      .toEqual(["chat_completions", "responses"]);
    expect(PROVIDER_PRESETS.find(item => item.id === "opencode-go")?.openaiWireApis)
      .toEqual(["chat_completions", "responses"]);
    // 火山方舟 Agent/Coding Plan 官方 Codex 文档与 CC Switch 均已确认 /api/plan/v3、
    // /api/coding/v3 原生支持 Responses，不再是“需要本地协议转换”的 Chat-only 通道。
    expect(PROVIDER_PRESETS.find(item => item.id === "volcengine-plan")?.openaiWireApis)
      .toEqual(["chat_completions", "responses"]);
    expect(PROVIDER_PRESETS.find(item => item.id === "volcengine-coding-plan")?.openaiWireApis)
      .toEqual(["chat_completions", "responses"]);
    for (const id of ["openrouter", "siliconflow", "qwenai", "opencode-go"]) {
      expect(PROVIDER_PRESETS.find(item => item.id === id)?.anthropicUrl).toBeTruthy();
    }
  });

  test("火山方舟 Agent/Coding Plan 预设直接支持 Codex Responses", () => {
    for (const id of ["volcengine-plan", "volcengine-coding-plan"]) {
      const preset = PROVIDER_PRESETS.find(item => item.id === id)!;
      expect(preset.openaiWireApis).toContain("responses");
      expect(resolveTargetAgentCapability({openaiUrl: preset.openaiUrl}, "codex")).toMatchObject({
        supported: true,
        presetId: id,
      });
      expect(resolveTargetAgentCapability({anthropicUrl: preset.anthropicUrl, presetId: id}, "claude")).toMatchObject({
        supported: true,
        presetId: id,
      });
    }
  });

  test("DeepSeek 预设支持 Codex Responses；OpenAI 按量预设已移除，订阅通道仅 Responses", () => {
    for (const id of ["deepseek"]) {
      const preset = PROVIDER_PRESETS.find(item => item.id === id)!;
      expect(preset.openaiWireApis).toContain("responses");
      expect(resolveTargetAgentCapability({openaiUrl: preset.openaiUrl}, "codex")).toMatchObject({
        supported: true,
        presetId: id,
      });
    }
    const subscription = PROVIDER_PRESETS.find(item => item.id === "openai-subscription")!;
    expect(subscription.openaiWireApis).toEqual(["responses"] satisfies readonly OpenAiWireApi[]);
  });

  test("GLM、Kimi 预设只支持 chat_completions，Codex 不可用；Claude Code 不受影响", () => {
    for (const id of ["zhipu-cn", "moonshot-cn"]) {
      const preset = PROVIDER_PRESETS.find(item => item.id === id)!;
      expect(preset.openaiWireApis).toEqual(["chat_completions"] satisfies readonly OpenAiWireApi[]);
      // Codex 只注册 Responses binding，chat 能力与预设无交集时不可接入。
      expect(resolveTargetAgentCapability({openaiUrl: preset.openaiUrl}, "codex")).toMatchObject({
        supported: false,
        presetId: id,
        reason: "PRESET_WIRE_API_UNSUPPORTED",
      });
      expect(resolveTargetAgentCapability({anthropicUrl: preset.anthropicUrl}, "claude")).toMatchObject({
        supported: true,
        presetId: id,
      });
    }
  });

  test("MiniMax 中国区与 Token Plan 官方 Codex 文档确认原生支持 Responses", () => {
    for (const id of ["minimax-cn", "minimax-plan"]) {
      const preset = PROVIDER_PRESETS.find(item => item.id === id)!;
      expect(preset.openaiWireApis).toContain("responses");
      // 按量与 Token Plan 共享同一上游 URL，显式 presetId 应被优先识别，避免归属错乱。
      expect(resolveTargetAgentCapability({openaiUrl: preset.openaiUrl, presetId: id}, "codex")).toMatchObject({
        supported: true,
        presetId: id,
      });
      expect(resolveTargetAgentCapability({anthropicUrl: preset.anthropicUrl, presetId: id}, "claude")).toMatchObject({
        supported: true,
        presetId: id,
      });
    }
  });

  test("OpenCode 任一 binding 可用即可用：只配 Anthropic URL 也可接入", () => {
    const both = resolveTargetAgentCapability({
      openaiUrl: "https://example.com/openai",
      anthropicUrl: "https://example.com/anthropic",
    }, "opencode");
    expect(both).toMatchObject({supported: true});

    const anthropicOnly = resolveTargetAgentCapability({
      anthropicUrl: "https://example.com/anthropic",
    }, "opencode");
    expect(anthropicOnly).toMatchObject({supported: true});
  });

  test("dsh 三协议均可接受（2026-10-06 pi-ai 官方核实：responses/messages 路由已支持）", () => {
    expect(resolveTargetAgentCapability({openaiUrl: "https://example.com/v1"}, "dsh"))
      .toMatchObject({supported: true});
    expect(resolveTargetAgentCapability({anthropicUrl: "https://example.com/v1"}, "dsh"))
      .toMatchObject({supported: true});
  });

  test("订阅目标仅对支持订阅透传的 binding 可用，OpenCode/dsh 首期拒绝", () => {
    expect(resolveTargetAgentCapability({
      openaiUrl: "https://example.com/v1",
      billingChannel: "subscription",
    }, "opencode")).toMatchObject({supported: false, reason: "SUBSCRIPTION_UNSUPPORTED"});
    expect(resolveTargetAgentCapability({
      openaiUrl: "https://example.com/v1",
      billingChannel: "subscription",
    }, "dsh")).toMatchObject({supported: false, reason: "SUBSCRIPTION_UNSUPPORTED"});
  });

  test("官方 URL 只负责识别身份，不会补齐另一个协议 URL", () => {
    const preset = PROVIDER_PRESETS.find(item => item.id === "openai-subscription")!;
    expect(resolveOfficialPresetForTarget({openaiUrl: `${preset.openaiUrl}/`} )?.id).toBe("openai-subscription");
    expect(resolveOfficialPresetForTarget({openaiUrl: preset.openaiUrl})).toMatchObject({id: "openai-subscription"});
    // 官方按量预设已移除：api.openai.com 不再被识别为官方预设（避免自定义按量目标误绑定订阅能力）。
    expect(resolveOfficialPresetForTarget({openaiUrl: "https://api.openai.com/v1"})).toBeUndefined();
    // api.anthropic.com 裸 URL 无法区分按量/订阅，需显式订阅元数据才识别为订阅通道。
    expect(resolveOfficialPresetForTarget({anthropicUrl: "https://api.anthropic.com"})).toBeUndefined();
    expect(resolveOfficialPresetForTarget({
      anthropicUrl: "https://api.anthropic.com",
      presetId: "anthropic-subscription",
      billingChannel: "subscription",
    })).toMatchObject({id: "anthropic-subscription"});
    expect(resolveOfficialPresetForTarget({openaiUrl: "https://proxy.example/v1"})).toBeUndefined();
  });

  test("自定义目标保留现状：只要存在对应协议 URL 即可支持 Agent", () => {
    expect(resolveTargetAgentCapability({openaiUrl: "https://proxy.example/v1"}, "codex")).toEqual({
      supported: true,
      presetId: undefined,
      reason: undefined,
      message: undefined,
    });
    expect(resolveTargetAgentCapability({anthropicUrl: "https://proxy.example"}, "claude")).toMatchObject({supported: true});
  });

  test("官方预设声明计费通道与供应商族（B 方案：一个目标=一个计费通道）", () => {
    for (const preset of PROVIDER_PRESETS) {
      expect(["pay_as_you_go", "plan", "subscription"], preset.id).toContain(preset.billingChannel);
      expect(preset.vendorFamily, preset.id).toMatch(/^[a-z0-9][a-z0-9-]{0,63}$/u);
    }
    expect(PROVIDER_PRESETS.find(item => item.id === "moonshot-cn")).toMatchObject({
      billingChannel: "pay_as_you_go",
      vendorFamily: "kimi",
    });
    expect(PROVIDER_PRESETS.find(item => item.id === "volcengine-plan")).toMatchObject({
      billingChannel: "plan",
      vendorFamily: "volcengine",
    });
    expect(PROVIDER_PRESETS.find(item => item.id === "opencode-go")).toMatchObject({
      billingChannel: "plan",
      vendorFamily: "opencode-go",
    });
    expect(PROVIDER_PRESETS.find(item => item.id === "openai-subscription")).toMatchObject({
      billingChannel: "subscription",
      vendorFamily: "openai",
    });
    expect(PROVIDER_PRESETS.find(item => item.id === "anthropic-subscription")).toMatchObject({
      billingChannel: "subscription",
      vendorFamily: "anthropic",
    });
    expect(PROVIDER_PRESETS.find(item => item.id === "zhipu-coding-plan")).toMatchObject({
      billingChannel: "plan",
      vendorFamily: "zhipu",
    });
    expect(PROVIDER_PRESETS.find(item => item.id === "kimi-coding")).toMatchObject({
      billingChannel: "plan",
      vendorFamily: "kimi",
    });
    expect(PROVIDER_PRESETS.find(item => item.id === "minimax-plan")).toMatchObject({
      billingChannel: "plan",
      vendorFamily: "minimax",
    });
    expect(PROVIDER_PRESETS.find(item => item.id === "volcengine-coding-plan")).toMatchObject({
      billingChannel: "plan",
      vendorFamily: "volcengine",
    });
    expect(PROVIDER_PRESETS.find(item => item.id === "qwenai-token-plan")).toMatchObject({
      billingChannel: "plan",
      vendorFamily: "qwenai",
    });
  });

  test("套餐预设展示名与官方口径一致", () => {
    expect(PROVIDER_PRESETS.find(item => item.id === "volcengine-plan")?.name).toContain("Agent Plan");
    expect(PROVIDER_PRESETS.find(item => item.id === "volcengine-coding-plan")?.name).toContain("Coding Plan");
    expect(PROVIDER_PRESETS.find(item => item.id === "minimax-plan")?.name).toContain("Token Plan");
  });

  test("按量目标不能命中套餐适配器，Coding Plan 与 Agent Plan 保持独立", () => {
    expect(resolvePlanProviderForTarget({
      pricing: {vendor: "moonshot-cn"},
      openaiUrl: "https://api.moonshot.cn/v1",
      anthropicUrl: "https://api.moonshot.cn/anthropic",
      presetId: "moonshot-cn",
      billingChannel: "pay_as_you_go",
    })).toBeUndefined();
    expect(resolvePlanProviderForTarget({
      pricing: {vendor: "volcengine-plan"},
      openaiUrl: "https://ark.cn-beijing.volces.com/api/plan/v3",
      anthropicUrl: "https://ark.cn-beijing.volces.com/api/plan",
      presetId: "volcengine-plan",
      billingChannel: "plan",
    })).toBe("volcengine-plan");
    expect(resolvePlanProviderForTarget({
      pricing: {vendor: "volcengine-plan"},
      openaiUrl: "https://ark.cn-beijing.volces.com/api/coding/v3",
      anthropicUrl: "https://ark.cn-beijing.volces.com/api/coding",
      presetId: "volcengine-coding-plan",
      billingChannel: "plan",
    })).toBe("volcengine-coding-plan");
  });

  test("千问 AI 使用规范 provider ID，不再把 DashScope 作为新预设", () => {
    expect(PROVIDER_PRESETS.map(item => item.id)).toEqual(expect.arrayContaining([
      "qwenai",
      "qwenai-token-plan",
    ]));
    expect(PROVIDER_PRESETS.some(item => item.id === "dashscope")).toBe(false);
    expect(PROVIDER_PRESETS.some(item => item.id === "dashscope-coding-plan")).toBe(false);
  });
});
