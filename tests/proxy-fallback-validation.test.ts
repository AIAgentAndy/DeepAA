import {describe, expect, test} from "vitest";
import {
  collectFallbackCandidateOptions,
  modelServableForAgent,
  servableAgentsForModel,
  validateTargetModelFallbacks,
  MAX_TARGET_MODEL_FALLBACKS,
} from "@/lib/proxy-management-domain";
import {buildGatewayModelId} from "../src/proxy/gateway-prefix.js";
import type {ProxyTarget} from "@/types";

interface TargetStubInput {
  id: string;
  models: Array<{
    modelId: string;
    scope: string[];
    wireApis: string[];
  }>;
  credentials: string[];
  name?: string;
  enabled?: boolean;
}

function target(input: TargetStubInput): ProxyTarget {
  const modelIds = input.models.map(model => model.modelId);
  return {
    id: input.id,
    name: input.name ?? input.id,
    openaiUrl: `https://${input.id}`,
    anthropicUrl: `https://${input.id}`,
    enabled: input.enabled ?? true,
    supportedModels: modelIds,
    supportedModelScopes: Object.fromEntries(input.models.map(model => [model.modelId, model.scope])),
    supportedModelWireApis: Object.fromEntries(input.models.map(model => [model.modelId, model.wireApis])),
    development: {defaultCredentials: Object.fromEntries(input.credentials.map(agent => [agent, `cred-${agent}`]))},
  } as ProxyTarget;
}

// 主模型：scope 含 codex+claude（外加 zcode 纸面 scope），双协议、凭据只有 codex+claude
// → 可服务 Agent = {codex, claude}；zcode 因无凭据不可服务（纸面 scope 不算数）。
const primary = target({
  id: "primary.example",
  name: "中转站A",
  models: [{modelId: "gpt-test", scope: ["codex", "claude", "zcode"], wireApis: ["responses", "messages"]}],
  credentials: ["codex", "claude"],
});

describe("modelServableForAgent / servableAgentsForModel（网关 /v1/models 同口径）", () => {
  test("scope + wireApi + 凭据齐备才可服务", () => {
    expect(servableAgentsForModel(primary, "gpt-test")).toEqual(["codex", "claude"]);
    expect(modelServableForAgent(primary, "gpt-test", "codex")).toBe(true);
    expect(modelServableForAgent(primary, "gpt-test", "claude")).toBe(true);
  });

  test("纸面 scope 有值但缺凭据 → 不可服务（假候选根因）", () => {
    expect(modelServableForAgent(primary, "gpt-test", "zcode")).toBe(false);
  });

  test("wire API 与 Agent binding 无交集 → 不可服务", () => {
    const chatOnly = target({
      id: "chat-only.example",
      models: [{modelId: "chat-model", scope: ["codex"], wireApis: ["chat_completions"]}],
      credentials: ["codex"],
    });
    // codex 只注册 responses binding；chat_completions 模型对 codex 不可服务。
    expect(modelServableForAgent(chatOnly, "chat-model", "codex")).toBe(false);
  });
});

describe("collectFallbackCandidateOptions（共同可服务 Agent 交集）", () => {
  const backupCodex = target({
    id: "backup-codex.example",
    name: "中转站B",
    models: [{modelId: "gpt-test", scope: ["codex"], wireApis: ["responses"]}],
    credentials: ["codex"],
  });
  const backupClaude = target({
    id: "backup-claude.example",
    name: "中转站C",
    models: [{modelId: "claude-model", scope: ["claude"], wireApis: ["messages"]}],
    credentials: ["claude"],
  });
  const paperZcode = target({
    id: "paper-zcode.example",
    name: "纸面zcode",
    models: [{modelId: "zcode-model", scope: ["zcode"], wireApis: ["messages"]}],
    credentials: [],
  });
  const disabled = target({
    id: "disabled.example",
    models: [{modelId: "gpt-test", scope: ["codex"], wireApis: ["responses"]}],
    credentials: ["codex"],
    enabled: false,
  });

  test("共同可服务 Agent 的候选入选（不必完全一致）：codex 维度与 claude 维度都可转移", () => {
    const candidates = collectFallbackCandidateOptions(primary, [primary, backupCodex, backupClaude, paperZcode, disabled], "gpt-test");
    const ids = candidates.map(item => item.gatewayModelId);
    // codex 共同可服务（主模型与候选都真实可用 codex）。
    expect(ids).toContain(buildGatewayModelId("backup-codex.example", "gpt-test"));
    // claude 共同可服务：候选只适用 claude（非完全一致）也入选。
    expect(ids).toContain(buildGatewayModelId("backup-claude.example", "claude-model"));
    // 自身与停用目标排除。
    expect(ids).not.toContain(buildGatewayModelId("primary.example", "gpt-test"));
    expect(ids.some(item => item.targetId === "disabled.example")).toBe(false);
    // 候选标注自身真实可服务的 Agent 集合。
    const codexCandidate = candidates.find(item => item.targetId === "backup-codex.example")!;
    expect(codexCandidate.agents).toEqual(["codex"]);
    expect(codexCandidate.targetName).toBe("中转站B");
  });

  test("纸面 scope 交集但实际不可服务的假候选被排除（回归：zcode 纸面交集）", () => {
    const candidates = collectFallbackCandidateOptions(primary, [primary, paperZcode], "gpt-test");
    // zcode-model 纸面 scope 与主模型共享 zcode，但双方都无 zcode 凭据 → 任何维度都转不过去。
    expect(candidates).toEqual([]);
  });

  test("候选 wire API 与共同 Agent 的 binding 不匹配时排除（回归：responses 假交集）", () => {
    // 主模型可服务 {codex, claude}；候选 scope 只有 claude 但 wireApi 只有 responses
    // → claude 需要 messages，codex 又不在其 scope → 无共同可服务维度 → 排除。
    const mismatch = target({
      id: "mismatch.example",
      models: [{modelId: "m", scope: ["claude"], wireApis: ["responses"]}],
      credentials: ["claude"],
    });
    const candidates = collectFallbackCandidateOptions(primary, [primary, mismatch], "gpt-test");
    expect(candidates).toEqual([]);
  });

  test("主模型没有任何可服务 Agent 时候选为空（无法配置故障转移）", () => {
    const broken = target({
      id: "broken.example",
      models: [{modelId: "gpt-test", scope: ["codex"], wireApis: ["responses"]}],
      credentials: [],
    });
    expect(collectFallbackCandidateOptions(broken, [broken, backupCodex], "gpt-test")).toEqual([]);
  });
});

describe("validateTargetModelFallbacks（保存校验：共同可服务 Agent 底线）", () => {
  const backupCodex = target({
    id: "backup-codex.example",
    models: [{modelId: "gpt-test", scope: ["codex"], wireApis: ["responses"]}],
    credentials: ["codex"],
  });

  test("存在共同可服务 Agent 的有效链通过", () => {
    const candidate = {
      ...primary,
      supportedModelFallbacks: {"gpt-test": [buildGatewayModelId("backup-codex.example", "gpt-test")]},
    };
    expect(validateTargetModelFallbacks(candidate, [candidate, backupCodex])).toEqual([]);
  });

  test("悬空条目（目标不存在）报错", () => {
    const candidate = {
      ...primary,
      supportedModelFallbacks: {"gpt-test": [buildGatewayModelId("ghost.example", "none")]},
    };
    const errors = validateTargetModelFallbacks(candidate, [candidate, backupCodex]);
    expect(errors.join("\n")).toContain("不在任何供应商的白名单中");
  });

  test("无共同可服务 Agent（纸面 scope 交集）报错", () => {
    const paperZcode = target({
      id: "paper-zcode.example",
      models: [{modelId: "zcode-model", scope: ["zcode"], wireApis: ["messages"]}],
      credentials: [],
    });
    const candidate = {
      ...primary,
      supportedModelFallbacks: {"gpt-test": [buildGatewayModelId("paper-zcode.example", "zcode-model")]},
    };
    const errors = validateTargetModelFallbacks(candidate, [candidate, paperZcode]);
    expect(errors.join("\n")).toContain("没有共同可用的 Agent");
  });

  test("非法网关模型串报错", () => {
    const candidate = {
      ...primary,
      supportedModelFallbacks: {"gpt-test": ["not-a-gateway-model"]},
    };
    const errors = validateTargetModelFallbacks(candidate, [candidate, backupCodex]);
    expect(errors.join("\n")).toContain("不是有效的网关模型串");
  });

  test("故障转移模型超过上限报错", () => {
    const pool = Array.from({length: MAX_TARGET_MODEL_FALLBACKS + 1}, (_, index) =>
      target({id: `b${index}.example`, models: [{modelId: "gpt-test", scope: ["codex"], wireApis: ["responses"]}], credentials: ["codex"]}));
    const candidate = {
      ...primary,
      supportedModelFallbacks: {
        "gpt-test": pool.map(item => buildGatewayModelId(item.id, "gpt-test")),
      },
    };
    const errors = validateTargetModelFallbacks(candidate, [candidate, ...pool]);
    expect(errors.join("\n")).toContain(`故障转移模型最多 ${MAX_TARGET_MODEL_FALLBACKS} 个`);
  });

  test("未配置故障转移链不报错", () => {
    expect(validateTargetModelFallbacks(primary, [primary, backupCodex])).toEqual([]);
  });
});

describe("servableBindingsForModel（协议级对交集，OpenCode 多协议场景）", () => {
  test("OpenCode：responses 主模型与 messages-only 候选无共同协议维度（回归）", () => {
    // 主模型只声明 responses；候选只声明 messages——都「可服务 opencode」但协议不交。
    const responsesPrimary = target({
      id: "p.example",
      models: [{modelId: "gpt-test", scope: ["opencode"], wireApis: ["responses"]}],
      credentials: ["opencode"],
    });
    const messagesBackup = target({
      id: "m.example",
      models: [{modelId: "bm", scope: ["opencode"], wireApis: ["messages"]}],
      credentials: ["opencode"],
    });
    const candidates = collectFallbackCandidateOptions(responsesPrimary, [responsesPrimary, messagesBackup], "gpt-test");
    expect(candidates).toEqual([]);
    // 保存校验同样拒绝。
    const invalid = {...responsesPrimary, supportedModelFallbacks: {"gpt-test": [buildGatewayModelId("m.example", "bm")]}};
    expect(validateTargetModelFallbacks(invalid, [invalid, messagesBackup]).join("\n")).toContain("没有共同可用的 Agent 协议");
  });

  test("OpenCode：双协议候选与单协议主模型按共同协议维度入选", () => {
    const responsesPrimary = target({
      id: "p.example",
      models: [{modelId: "gpt-test", scope: ["opencode"], wireApis: ["responses"]}],
      credentials: ["opencode"],
    });
    const dualBackup = target({
      id: "d.example",
      models: [{modelId: "bm", scope: ["opencode"], wireApis: ["responses", "messages"]}],
      credentials: ["opencode"],
    });
    const candidates = collectFallbackCandidateOptions(responsesPrimary, [responsesPrimary, dualBackup], "gpt-test");
    expect(candidates.map(item => item.gatewayModelId)).toContain(buildGatewayModelId("d.example", "bm"));
  });

  test("passthrough/订阅目标不作为故障转移候选（OAuth 出境防护）", () => {
    const primary = target({
      id: "p.example",
      models: [{modelId: "gpt-test", scope: ["codex"], wireApis: ["responses"]}],
      credentials: ["codex"],
    });
    const subscriptionBackup = {
      ...target({id: "s.example", models: [{modelId: "bm", scope: ["codex"], wireApis: ["responses"]}], credentials: []}),
      billingChannel: "subscription",
    } as ProxyTarget;
    const candidates = collectFallbackCandidateOptions(primary, [primary, subscriptionBackup], "gpt-test");
    expect(candidates.some(item => item.targetId === "s.example")).toBe(false);
    // 保存校验直接拒绝（服务端安全边界）。
    const invalid = {...primary, supportedModelFallbacks: {"gpt-test": [buildGatewayModelId("s.example", "bm")]}};
    expect(validateTargetModelFallbacks(invalid, [invalid, subscriptionBackup]).join("\n")).toContain("订阅/透传通道");
  });
});
