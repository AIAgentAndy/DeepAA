import {chmod, mkdtemp, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {expect, test} from "vitest";
import {GatewayTokenResolver} from "../src/proxy/token-resolver.js";
import {
  buildGatewayModelId,
  findModelTokenBytes,
  parseGatewayModelId,
  rewriteModelValue,
  rewriteModelValueBytes,
} from "../src/proxy/gateway-prefix.js";
import {
  decideGatewayRoute,
  GatewayRouteError,
} from "../src/proxy/gateway-router.js";
import type {RoutingSnapshot} from "../src/proxy/routing-config.js";

function snapshotWith(targets: Array<{
  id: string;
  supportedModels?: string[];
  supportedModelScopes?: Record<string, string[]>;
  supportedModelWireApis?: Record<string, string[]>;
  defaultCredentials?: Record<string, string>;
  openaiUrl?: string;
  anthropicUrl?: string;
  billingChannel?: string;
  credentialMode?: string;
}>): RoutingSnapshot {
  const byId = new Map(targets.map(target => [target.id, {
    id: target.id,
    name: target.id,
    enabled: true,
    ...(target.billingChannel ? {billingChannel: target.billingChannel} : {}),
    ...(target.credentialMode === "passthrough" ? {gatewayCredentialMode: "passthrough" as const} : {}),
    ...(target.openaiUrl ? {openaiUrl: target.openaiUrl} : {}),
    ...(target.anthropicUrl ? {anthropicUrl: target.anthropicUrl} : {}),
    supportedModels: Object.freeze([...(target.supportedModels || [])]),
    // 测试夹具未显式声明 scope/wire API 时默认放行全部 Agent 与全部协议，
    // 避免旧用例被默认拒绝策略误伤；生产默认拒绝由 proxy-routing-config 测试单独覆盖。
    modelAgentScopes: target.supportedModelScopes !== undefined
      ? new Map(Object.entries(target.supportedModelScopes))
      : new Map((target.supportedModels || []).map(model => [model, ["codex", "claude", "opencode", "dsh"]])),
    modelWireApis: target.supportedModelWireApis !== undefined
      ? new Map(Object.entries(target.supportedModelWireApis))
      : new Map((target.supportedModels || []).map(model => [model, ["responses", "chat_completions", "messages"]])),
    credentialsByAgent: new Map(Object.entries(target.defaultCredentials || {})),
  }]));
  return Object.freeze({
    revision: 1,
    targetsById: byId,
  }) as unknown as RoutingSnapshot;
}

test("网关模型 ID 以真实模型 ID 在前、路由 ID 为后缀且路由 ID 不允许下划线", () => {
  expect(buildGatewayModelId("api.deepseek.com", "deepseek-v4-flash"))
    .toBe("deepseek-v4-flash_api.deepseek.com");
  expect(() => buildGatewayModelId("bad_target_id", "gpt-5.6-sol")).toThrow();
});

test("解析网关模型 ID 时按最后一个下划线切分并拒绝非法路由后缀", () => {
  expect(parseGatewayModelId("gpt-5.6-sol_api.tokenshub.site")).toEqual({
    targetId: "api.tokenshub.site",
    modelId: "gpt-5.6-sol",
  });
  // 真实模型 ID 可自由包含下划线：全部归入模型部分。
  expect(parseGatewayModelId("weird_model.name_v2_api.example")).toEqual({
    targetId: "api.example",
    modelId: "weird_model.name_v2",
  });
  // 路由后缀缺失或含非法字符时拒绝。
  expect(parseGatewayModelId("plain-model")).toBeNull();
  expect(parseGatewayModelId("_model")).toBeNull();
  expect(parseGatewayModelId("model_")).toBeNull();
  expect(parseGatewayModelId("gpt-5.6-sol_BAD_ROUTE")).toBeNull();
});

test("decideGatewayRoute 按模型前缀与路径协议选择目标", () => {
  const snapshot = snapshotWith([
    {id: "api.deepseek.com", openaiUrl: "https://api.deepseek.com/v1", supportedModels: ["deepseek-v4-flash"], defaultCredentials: {codex: "deepseek-key"}},
    {id: "api.anthropic.com", anthropicUrl: "https://api.anthropic.com/v1", supportedModels: ["claude-sonnet-4-5"], defaultCredentials: {claude: "claude-key"}},
  ]);

  const openai = decideGatewayRoute(
    snapshot,
    "/codex/v1/responses",
    "deepseek-v4-flash_api.deepseek.com",
  );
  expect(openai.target.id).toBe("api.deepseek.com");
  expect(openai.modelId).toBe("deepseek-v4-flash");
  expect(openai.upstreamPath).toBe("/v1/responses");
  expect(openai.agent).toBe("codex");
  expect(openai.credentialId).toBe("deepseek-key");

  const anthropic = decideGatewayRoute(
    snapshot,
    "/claude/v1/messages",
    "claude-sonnet-4-5_api.anthropic.com",
  );
  expect(anthropic.target.id).toBe("api.anthropic.com");
  expect(anthropic.agent).toBe("claude");
});

test("decideGatewayRoute 拒绝无前缀、未知目标、协议不匹配、未授权模型与缺失凭证", () => {
  const snapshot = snapshotWith([
    {id: "api.deepseek.com", openaiUrl: "https://api.deepseek.com/v1", supportedModels: ["deepseek-v4-flash"], defaultCredentials: {codex: "deepseek-key"}},
    {id: "api.anthropic.com", anthropicUrl: "https://api.anthropic.com/v1", supportedModels: ["claude-sonnet-4-5"], defaultCredentials: {claude: "claude-key"}},
    {id: "no-key.example", openaiUrl: "https://no-key.example/v1", supportedModels: ["gpt-5.6-sol"]},
  ]);

  expect(() => decideGatewayRoute(snapshot, "/codex/v1/responses", "gpt-5.6-sol"))
    .toThrowError(new GatewayRouteError("MODEL_PREFIX_REQUIRED"));
  expect(() => decideGatewayRoute(snapshot, "/codex/v1/responses", "gpt-5.6-sol_ghost.example"))
    .toThrowError(new GatewayRouteError("TARGET_NOT_FOUND"));
  // Claude 路径被 Codex 使用：agent 与协议不匹配
  expect(() => decideGatewayRoute(snapshot, "/claude/v1/messages", "deepseek-v4-flash_api.deepseek.com"))
    .toThrowError(new GatewayRouteError("PROTOCOL_MISMATCH"));
  // 无 agent 段的历史路径直接拒绝
  expect(() => decideGatewayRoute(snapshot, "/v1/responses", "deepseek-v4-flash_api.deepseek.com"))
    .toThrowError(new GatewayRouteError("INVALID_ROUTE"));
  expect(() => decideGatewayRoute(snapshot, "/codex/v1/responses", "gpt-5.6-sol_api.deepseek.com"))
    .toThrowError(new GatewayRouteError("MODEL_NOT_ALLOWED"));
  expect(() => decideGatewayRoute(snapshot, "/codex/v1/responses", "gpt-5.6-sol_no-key.example"))
    .toThrowError(new GatewayRouteError("CREDENTIAL_NOT_CONFIGURED"));
});

test("decideGatewayRoute 按请求路径选择目标已配置的协议 URL", () => {
  const snapshot = snapshotWith([
    {
      id: "api.deepseek.com",
      openaiUrl: "https://api.deepseek.com/openai",
      anthropicUrl: "https://api.deepseek.com/anthropic",
      supportedModels: ["deepseek-v4-flash"],
      defaultCredentials: {codex: "deepseek-key", claude: "deepseek-key"},
    },
  ]);

  const openai = decideGatewayRoute(
    snapshot,
    "/codex/v1/responses",
    "deepseek-v4-flash_api.deepseek.com",
  );
  expect(openai.upstreamUrl).toBe("https://api.deepseek.com/openai");

  const anthropic = decideGatewayRoute(
    snapshot,
    "/claude/v1/messages",
    "deepseek-v4-flash_api.deepseek.com",
  );
  expect(anthropic.upstreamUrl).toBe("https://api.deepseek.com/anthropic");
});

test("decideGatewayRoute 目标缺少请求协议 URL 时拒绝 PROTOCOL_MISMATCH", () => {
  const snapshot = snapshotWith([
    {
      id: "api.deepseek.com",
      openaiUrl: "https://api.deepseek.com/openai",
      supportedModels: ["deepseek-v4-flash"],
      defaultCredentials: {codex: "deepseek-key"},
    },
  ]);

  expect(() => decideGatewayRoute(
    snapshot,
    "/claude/v1/messages",
    "deepseek-v4-flash_api.deepseek.com",
  )).toThrowError(new GatewayRouteError("PROTOCOL_MISMATCH"));
});

test("decideGatewayRoute 使用目标的单协议 URL", () => {
  const snapshot = snapshotWith([
    {
      id: "api.deepseek.com",
      openaiUrl: "https://api.deepseek.com/v1",
      supportedModels: ["deepseek-v4-flash"],
      defaultCredentials: {codex: "deepseek-key"},
    },
  ]);

  expect(decideGatewayRoute(
    snapshot,
    "/codex/v1/responses",
    "deepseek-v4-flash_api.deepseek.com",
  ).upstreamUrl).toBe("https://api.deepseek.com/v1");
});

test("decideGatewayRoute 按模型归属过滤并解析 Agent 级默认密钥", () => {
  const snapshot = snapshotWith([
    {
      id: "modelport.link",
      openaiUrl: "https://modelport.link/v1",
      anthropicUrl: "https://modelport.link/anthropic",
      supportedModels: ["gpt-5.6", "claude-sonnet-4", "deepseek-chat"],
      supportedModelScopes: {
        "gpt-5.6": ["codex"],
        "claude-sonnet-4": ["claude"],
      },
      defaultCredentials: {
        codex: "cred-codex",
        claude: "cred-claude",
      },
    },
  ]);

  // Codex 路径：gpt-5.6 归属含 codex → 放行，密钥取 Agent 级默认
  const codex = decideGatewayRoute(
    snapshot,
    "/codex/v1/responses",
    "gpt-5.6_modelport.link",
  );
  expect(codex.credentialId).toBe("cred-codex");

  // Claude 路径：claude-sonnet-4 归属含 claude → 放行，密钥取 Agent 级默认
  const claude = decideGatewayRoute(
    snapshot,
    "/claude/v1/messages",
    "claude-sonnet-4_modelport.link",
  );
  expect(claude.credentialId).toBe("cred-claude");

  // Codex 请求 claude 系模型：归属不含 codex → MODEL_NOT_ALLOWED
  expect(() => decideGatewayRoute(
    snapshot,
    "/codex/v1/responses",
    "claude-sonnet-4_modelport.link",
  )).toThrowError(new GatewayRouteError("MODEL_NOT_ALLOWED"));

  // 未记录归属的模型（deepseek-chat）默认不允许任何 Agent
  expect(() => decideGatewayRoute(
    snapshot,
    "/claude/v1/messages",
    "deepseek-chat_modelport.link",
  )).toThrowError(new GatewayRouteError("MODEL_NOT_ALLOWED"));
});

test("opencode 多协议路径按 binding 路由并返回 wireApi", () => {
  const snapshot = snapshotWith([
    {
      id: "gateway.example",
      openaiUrl: "https://gateway.example/openai",
      anthropicUrl: "https://gateway.example/anthropic",
      supportedModels: ["deepseek-v4-flash"],
      supportedModelWireApis: {"deepseek-v4-flash": ["responses", "chat_completions", "messages"]},
      supportedModelScopes: {"deepseek-v4-flash": ["opencode"]},
      defaultCredentials: {opencode: "cred-opencode"},
    },
  ]);

  expect(decideGatewayRoute(
    snapshot,
    "/opencode/v1/responses",
    "deepseek-v4-flash_gateway.example",
  ).wireApi).toBe("responses");
  expect(decideGatewayRoute(
    snapshot,
    "/opencode/v1/chat/completions",
    "deepseek-v4-flash_gateway.example",
  ).wireApi).toBe("chat_completions");
  expect(decideGatewayRoute(
    snapshot,
    "/opencode/v1/messages",
    "deepseek-v4-flash_gateway.example",
  ).wireApi).toBe("messages");
});

test("dsh 三协议路由（2026-10-06 pi-ai 官方核实）：chat/responses/messages 按 binding 放行，模型 wire 不符拒绝", () => {
  const snapshot = snapshotWith([
    {
      id: "dsh.example",
      openaiUrl: "https://dsh.example/v1",
      anthropicUrl: "https://dsh.example/anthropic",
      supportedModels: ["deepseek-v4-flash", "glm-5.3"],
      supportedModelWireApis: {
        "deepseek-v4-flash": ["chat_completions", "responses", "messages"],
        "glm-5.3": ["messages"],
      },
      supportedModelScopes: {"deepseek-v4-flash": ["dsh"], "glm-5.3": ["dsh"]},
      defaultCredentials: {dsh: "cred-dsh"},
    },
  ]);

  expect(decideGatewayRoute(
    snapshot,
    "/dsh/v1/chat/completions",
    "deepseek-v4-flash_dsh.example",
  ).wireApi).toBe("chat_completions");
  expect(decideGatewayRoute(
    snapshot,
    "/dsh/v1/responses",
    "deepseek-v4-flash_dsh.example",
  ).wireApi).toBe("responses");
  expect(decideGatewayRoute(
    snapshot,
    "/dsh/v1/messages",
    "glm-5.3_dsh.example",
  ).wireApi).toBe("messages");
  // 模型 wire 能力不包含该路径协议时本地拒绝（网关侧能力闸门不变）。
  expect(() => decideGatewayRoute(
    snapshot,
    "/dsh/v1/responses",
    "glm-5.3_dsh.example",
  )).toThrowError(new GatewayRouteError("MODEL_WIRE_API_UNSUPPORTED"));
});

test("模型缺少 wire API 声明时本地拒绝 MODEL_WIRE_API_UNSUPPORTED", () => {
  const snapshot = snapshotWith([
    {
      id: "api.example",
      openaiUrl: "https://api.example/v1",
      supportedModels: ["gpt-5.6"],
      supportedModelWireApis: {"gpt-5.6": ["chat_completions"]},
      supportedModelScopes: {"gpt-5.6": ["codex"]},
      defaultCredentials: {codex: "cred-codex"},
    },
  ]);

  expect(() => decideGatewayRoute(
    snapshot,
    "/codex/v1/responses",
    "gpt-5.6_api.example",
  )).toThrowError(new GatewayRouteError("MODEL_WIRE_API_UNSUPPORTED"));
});

test("订阅目标仅放行支持订阅透传的 binding，OpenCode 首期拒绝", () => {
  const snapshot = snapshotWith([
    {
      id: "sub.example",
      openaiUrl: "https://sub.example/v1",
      billingChannel: "subscription",
      supportedModels: ["gpt-5.6"],
      supportedModelWireApis: {"gpt-5.6": ["responses"]},
      supportedModelScopes: {"gpt-5.6": ["opencode"]},
    },
  ]);

  expect(() => decideGatewayRoute(
    snapshot,
    "/opencode/v1/responses",
    "gpt-5.6_sub.example",
  )).toThrowError(new GatewayRouteError("SUBSCRIPTION_PASSTHROUGH_UNSUPPORTED"));
});

test("decideGatewayRoute 使用显式 Agent 级默认密钥", () => {
  const snapshot = snapshotWith([
    {
      id: "api.deepseek.com",
      openaiUrl: "https://api.deepseek.com",
      supportedModels: ["deepseek-chat"],
      defaultCredentials: {codex: "target-default"},
    },
  ]);
  const decision = decideGatewayRoute(
    snapshot,
    "/codex/v1/responses",
    "deepseek-chat_api.deepseek.com",
  );
  expect(decision.credentialId).toBe("target-default");
});

test("订阅目标不要求钥匙串凭据并返回 passthrough；按量目标仍要求凭据", () => {
  const snapshot = snapshotWith([
    {
      id: "claude-sub",
      anthropicUrl: "https://api.anthropic.com",
      billingChannel: "subscription",
      supportedModels: ["claude-sonnet-4-5"],
    },
    {
      id: "no-key.example",
      openaiUrl: "https://no-key.example/v1",
      supportedModels: ["gpt-5.6-sol"],
    },
  ]);

  const sub = decideGatewayRoute(
    snapshot,
    "/claude/v1/messages",
    "claude-sonnet-4-5_claude-sub",
  );
  expect(sub.credentialMode).toBe("passthrough");
  expect(sub.credentialId).toBeUndefined();

  expect(() => decideGatewayRoute(
    snapshot,
    "/codex/v1/responses",
    "gpt-5.6-sol_no-key.example",
  )).toThrowError(new GatewayRouteError("CREDENTIAL_NOT_CONFIGURED"));
});

test("zcode 登录透传目标：messages 放行且不要求系统凭据，chat binding 拒绝", () => {
  const snapshot = snapshotWith([
    {
      id: "zhipu-plan",
      anthropicUrl: "https://open.bigmodel.cn/api/anthropic",
      openaiUrl: "https://open.bigmodel.cn/api/paas/v4",
      credentialMode: "passthrough",
      supportedModels: ["glm-5.3"],
      // 双协议都能声明该模型时，才能单测「透传门禁按 binding 区分」这一层。
      supportedModelWireApis: {"glm-5.3": ["messages", "chat_completions"]},
      supportedModelScopes: {"glm-5.3": ["zcode"]},
    },
  ]);

  const decision = decideGatewayRoute(
    snapshot,
    "/zcode/v1/messages",
    "glm-5.3_zhipu-plan",
  );
  expect(decision.credentialMode).toBe("passthrough");
  expect(decision.credentialId).toBeUndefined();
  expect(decision.agent).toBe("zcode");
  expect(decision.upstreamPath).toBe("/v1/messages");

  // zcode 的 openai 系 binding 未开放订阅透传。
  expect(() => decideGatewayRoute(
    snapshot,
    "/zcode/v1/chat/completions",
    "glm-5.3_zhipu-plan",
  )).toThrowError(new GatewayRouteError("SUBSCRIPTION_PASSTHROUGH_UNSUPPORTED"));
});

test("无 credentialMode 字段的既有目标保持 inject 语义（回归保障）", () => {
  const snapshot = snapshotWith([
    {
      id: "api.deepseek.com",
      openaiUrl: "https://api.deepseek.com/v1",
      supportedModels: ["deepseek-chat"],
      defaultCredentials: {codex: "key"},
    },
  ]);
  const decision = decideGatewayRoute(snapshot, "/codex/v1/responses", "deepseek-chat_api.deepseek.com");
  expect(decision.credentialMode).toBe("inject");
  expect(decision.credentialId).toBe("key");
});

test("按量目标默认返回 inject 并解析 Agent 级默认凭据", () => {
  const snapshot = snapshotWith([
    {
      id: "api.deepseek.com",
      openaiUrl: "https://api.deepseek.com/v1",
      supportedModels: ["deepseek-v4-flash"],
      defaultCredentials: {codex: "deepseek-key"},
    },
  ]);
  const decision = decideGatewayRoute(
    snapshot,
    "/codex/v1/responses",
    "deepseek-v4-flash_api.deepseek.com",
  );
  expect(decision.credentialMode).toBe("inject");
  expect(decision.credentialId).toBe("deepseek-key");
});

test("rewriteModelValue 只替换 model 字段并保留其余 JSON", () => {
  const source = '{"stream":true,"model":"deepseek-v4-flash_api.deepseek.com","instructions":"hi"}';
  const rewritten = rewriteModelValue(source, '"deepseek-v4-flash_api.deepseek.com"', "deepseek-v4-flash");
  expect(rewritten).toBe('{"stream":true,"model":"deepseek-v4-flash","instructions":"hi"}');
});

test("字节级定位 model 字段并仅替换该字段，其余内容逐字节保留", () => {
  const body = Buffer.from(
    '{"stream":true,"model" : "deepseek-v4-flash_api.deepseek.com","input":[{"role":"user","content":"评论持久化"}]}',
  );
  const match = findModelTokenBytes(body);
  expect(match).not.toBeUndefined();
  expect(match!.model).toBe("deepseek-v4-flash_api.deepseek.com");
  expect(body.subarray(match!.start, match!.end).toString("ascii"))
    .toBe('"deepseek-v4-flash_api.deepseek.com"');

  const rewritten = rewriteModelValueBytes(body, match!, "deepseek-v4-flash");
  const expected = Buffer.from(
    '{"stream":true,"model" : "deepseek-v4-flash","input":[{"role":"user","content":"评论持久化"}]}',
  );
  expect(rewritten).toEqual(expected);
  expect(rewritten.subarray(0, match!.start)).toEqual(body.subarray(0, match!.start));
  expect(rewritten.subarray(match!.start + Buffer.byteLength('"deepseek-v4-flash"')))
    .toEqual(body.subarray(match!.end));
});

test("累计前缀在多字节字符中间截断时保留原始截断字节，不产生 U+FFFD", () => {
  const prefix = Buffer.concat([
    Buffer.from('{"model":"deepseek-v4-flash_api.deepseek.com","input":"'),
    Buffer.from("评论", "utf8"),
    Buffer.from("A".repeat(64), "utf8"),
    Buffer.from("持久化", "utf8").subarray(0, 1),
  ]);
  const match = findModelTokenBytes(prefix);
  expect(match).not.toBeUndefined();
  const rewritten = rewriteModelValueBytes(prefix, match!, "deepseek-v4-flash");
  expect(rewritten[rewritten.length - 1]).toBe(prefix[prefix.length - 1]);
  expect(rewritten.includes(Buffer.from([0xef, 0xbf, 0xbd]))).toBe(false);
});

test("model 值为空、非字符串或未闭合时返回 undefined 并继续扫描后续合法字段", () => {
  expect(findModelTokenBytes(Buffer.from(
    '{"model":123,"model":"deepseek-v4-flash_api.deepseek.com"}',
  ))?.model).toBe("deepseek-v4-flash_api.deepseek.com");
  expect(findModelTokenBytes(Buffer.from('{"model":""}'))).toBeUndefined();
  expect(findModelTokenBytes(Buffer.from('{"model":"api.deepseek.com_deepseek'))).toBeUndefined();
});

test("GatewayTokenResolver 通过 credential-helper 获取并缓存 token", async () => {
  const root = await mkdtemp(join(tmpdir(), "gateway-token-"));
  const helperPath = join(root, "fake-helper.mjs");
  await writeFile(helperPath, [
    "#!/usr/bin/env node",
    "const [op] = process.argv.slice(2);",
    'if (op === "exists") { process.exit(0); }',
    'process.stdout.write("secret-token\\n");',
  ].join("\n"), "utf8");
  await chmod(helperPath, 0o755);

  const resolver = new GatewayTokenResolver({credentialHelperPath: helperPath});
  expect(await resolver.resolve("deepseek-key")).toBe("secret-token");
  expect(await resolver.resolve("deepseek-key")).toBe("secret-token");
  expect(await resolver.exists("deepseek-key")).toBe(true);
});

test("GatewayTokenResolver.exists 在 helper 返回非零时返回 false", async () => {
  const root = await mkdtemp(join(tmpdir(), "gateway-token-missing-"));
  const helperPath = join(root, "fake-helper.mjs");
  await writeFile(helperPath, "#!/usr/bin/env node\nprocess.exit(1);\n", "utf8");
  await chmod(helperPath, 0o755);

  const resolver = new GatewayTokenResolver({credentialHelperPath: helperPath});
  expect(await resolver.exists("missing-key")).toBe(false);
  await expect(resolver.resolve("missing-key")).rejects.toThrow();
});
