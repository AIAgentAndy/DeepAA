import {mkdtemp, readFile, rename, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {setTimeout as delay} from "node:timers/promises";
import {afterEach, describe, expect, test} from "vitest";
import {
  isModelAllowedForAgent,
  isModelWireApiAllowedForAgent,
  RoutingConfigController,
  type RoutingSnapshot,
} from "../src/proxy/routing-config.js";

const controllers: RoutingConfigController[] = [];

afterEach(async () => {
  await Promise.all(controllers.splice(0).map(controller => controller.close()));
});

function config(revision: number, targets = [{
  id: "primary",
  name: "Primary",
  openaiUrl: "https://primary.example/v1",
  enabled: true,
  supportedModels: ["gpt-5.6"],
  development: {defaultCredentials: {codex: "cred-primary"}},
}]): string {
  return `${JSON.stringify({
    version: 3,
    revision,
    agentConnections: {},
    targets,
    localProxyBaseUrl: "http://localhost:3211",
    updatedAt: new Date().toISOString(),
  })}\n`;
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition was not reached before timeout");
    await delay(10);
  }
}

async function atomicReplace(path: string, content: string): Promise<void> {
  const tempPath = `${path}.next`;
  await writeFile(tempPath, content, "utf8");
  await rename(tempPath, path);
}

describe("RoutingConfigController", () => {
  test("零目标配置合法：快照为空且不设置默认目标", async () => {
    const root = await mkdtemp(join(tmpdir(), "routing-empty-"));
    const configPath = join(root, "proxy-config.json");
    await writeFile(configPath, JSON.stringify({
      version: 3,
      revision: 1,
      agentConnections: {},
      targets: [],
      localProxyBaseUrl: "http://localhost:3211",
      updatedAt: new Date().toISOString(),
    }), "utf8");
    const controller = new RoutingConfigController({
      configPath,
      statusPath: join(root, "proxy-routing-status.json"),
      debounceMs: 5,
      pollIntervalMs: 10_000,
    });
    controllers.push(controller);
    await controller.init();
    controller.start();

    const snapshot = controller.current();
    expect(snapshot.revision).toBe(1);
    expect(snapshot.targetsById.size).toBe(0);
  });

  test("watches the directory and atomically swaps an immutable snapshot", async () => {
    const root = await mkdtemp(join(tmpdir(), "routing-watch-"));
    const configPath = join(root, "proxy-config.json");
    await writeFile(configPath, config(1), "utf8");
    const controller = new RoutingConfigController({
      configPath,
      statusPath: join(root, "proxy-routing-status.json"),
      debounceMs: 5,
      pollIntervalMs: 10_000,
    });
    controllers.push(controller);
    await controller.init();
    controller.start();
    const first: RoutingSnapshot = controller.current();

    await atomicReplace(configPath, config(2, [{
      id: "secondary",
      name: "Secondary",
      anthropicUrl: "http://127.0.0.1:40123/v1",
      enabled: true,
      supportedModels: ["claude-sonnet-4-5"],
      development: {defaultCredentials: {claude: "cred-secondary"}},
    }]));
    await waitFor(() => controller.current().revision === 2);

    expect(first.revision).toBe(1);
    expect(first.targetsById.has("primary")).toBe(true);
    expect(controller.current().targetsById.has("secondary")).toBe(true);
    expect(Object.isFrozen(controller.current())).toBe(true);
  });

  test("uses exact-path stat polling when watch events are unavailable", async () => {
    const root = await mkdtemp(join(tmpdir(), "routing-poll-"));
    const configPath = join(root, "proxy-config.json");
    await writeFile(configPath, config(1), "utf8");
    const controller = new RoutingConfigController({
      configPath,
      statusPath: join(root, "proxy-routing-status.json"),
      watchEnabled: false,
      pollIntervalMs: 20,
    });
    controllers.push(controller);
    await controller.init();
    controller.start();

    await atomicReplace(configPath, config(2));
    await waitFor(() => controller.current().revision === 2);

    expect(controller.current().revision).toBe(2);
  });

  test("coalesces burst reloads and keeps last-known-good on invalid revisions", async () => {
    const root = await mkdtemp(join(tmpdir(), "routing-single-flight-"));
    const configPath = join(root, "proxy-config.json");
    await writeFile(configPath, config(3), "utf8");
    let activeLoads = 0;
    let maxActiveLoads = 0;
    const controller = new RoutingConfigController({
      configPath,
      statusPath: join(root, "proxy-routing-status.json"),
      watchEnabled: false,
      pollIntervalMs: 10_000,
      onLoadAttempt: async () => {
        activeLoads += 1;
        maxActiveLoads = Math.max(maxActiveLoads, activeLoads);
        await delay(10);
        activeLoads -= 1;
      },
    });
    controllers.push(controller);
    await controller.init();

    await writeFile(configPath, config(2), "utf8");
    await Promise.all([controller.reload(), controller.reload(), controller.reload()]);
    expect(controller.current().revision).toBe(3);
    expect(maxActiveLoads).toBe(1);

    await writeFile(configPath, "{ invalid", "utf8");
    await controller.reload();
    expect(controller.current().revision).toBe(3);
  });

  test("rejects oversized config and publishes a bounded applied marker", async () => {
    const root = await mkdtemp(join(tmpdir(), "routing-budget-"));
    const configPath = join(root, "proxy-config.json");
    const statusPath = join(root, "proxy-routing-status.json");
    await writeFile(configPath, config(7), "utf8");
    const controller = new RoutingConfigController({configPath, statusPath});
    controllers.push(controller);
    await controller.init();

    const status = JSON.parse(await readFile(statusPath, "utf8")) as Record<string, unknown>;
    expect(status).toMatchObject({
      appliedRevision: 7,
      proxyInstanceId: controller.proxyInstanceId,
    });
    expect(await readFile(statusPath, "utf8")).not.toContain("primary.example");

    await writeFile(configPath, `${" ".repeat(1024 * 1024)}x`, "utf8");
    await controller.reload();
    expect(controller.current().revision).toBe(7);
  });

  test("配置文件缺失时创建空 V3", async () => {
    const root = await mkdtemp(join(tmpdir(), "routing-initial-v3-"));
    const configPath = join(root, "proxy-config.json");
    const controller = new RoutingConfigController({
      configPath,
      statusPath: join(root, "proxy-routing-status.json"),
    });
    controllers.push(controller);

    await controller.init();

    expect(controller.current().targetsById.size).toBe(0);
    const persisted = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
    expect(persisted).toMatchObject({version: 3, revision: 1, agentConnections: {}, targets: []});
  });

  test("拒绝 V2 路由配置并保持最后一次 V3 快照", async () => {
    const root = await mkdtemp(join(tmpdir(), "routing-reject-v2-"));
    const configPath = join(root, "proxy-config.json");
    await writeFile(configPath, config(2), "utf8");
    const controller = new RoutingConfigController({configPath, watchEnabled: false});
    controllers.push(controller);
    await controller.init();

    await writeFile(configPath, JSON.stringify({version: 2, revision: 3, targets: []}), "utf8");
    await controller.reload();

    expect(controller.current().revision).toBe(2);
    expect(controller.current().targetsById.has("primary")).toBe(true);
  });

  test("解析 V3 目标时读取 billingChannel，缺省为 pay_as_you_go", async () => {
    const root = await mkdtemp(join(tmpdir(), "routing-channel-"));
    const configPath = join(root, "proxy-config.json");
    await writeFile(configPath, JSON.stringify({
      version: 3,
      revision: 1,
      agentConnections: {},
      targets: [
        {
          id: "claude-sub",
          name: "Claude 订阅",
          anthropicUrl: "https://api.anthropic.com",
          enabled: true,
          billingChannel: "subscription",
          supportedModels: ["claude-sonnet-4-5"],
        },
        {
          id: "paygo",
          name: "按量",
          openaiUrl: "https://api.example.com/v1",
          enabled: true,
          supportedModels: ["gpt-5.6"],
        },
      ],
      localProxyBaseUrl: "http://localhost:3211",
      updatedAt: new Date().toISOString(),
    }), "utf8");
    const controller = new RoutingConfigController({configPath, watchEnabled: false});
    controllers.push(controller);
    await controller.init();

    expect(controller.current().targetsById.get("claude-sub")?.billingChannel).toBe("subscription");
    expect(controller.current().targetsById.get("paygo")?.billingChannel).toBe("pay_as_you_go");
  });

  test("解析 V3 目标时读取 credentialMode=passthrough，非法值拒绝加载，缺省为 inject", async () => {
    const root = await mkdtemp(join(tmpdir(), "routing-credential-mode-"));
    const configPath = join(root, "proxy-config.json");
    await writeFile(configPath, JSON.stringify({
      version: 3,
      revision: 1,
      agentConnections: {},
      targets: [
        {
          id: "zhipu-plan",
          name: "智谱套餐",
          anthropicUrl: "https://open.bigmodel.cn/api/anthropic",
          enabled: true,
          credentialMode: "passthrough",
          supportedModels: ["glm-5.3"],
        },
        {
          id: "paygo",
          name: "按量",
          openaiUrl: "https://api.example.com/v1",
          enabled: true,
          supportedModels: ["gpt-5.6"],
        },
      ],
      localProxyBaseUrl: "http://localhost:3211",
      updatedAt: new Date().toISOString(),
    }), "utf8");
    const controller = new RoutingConfigController({configPath, watchEnabled: false});
    controllers.push(controller);
    await controller.init();

    const plan = controller.current().targetsById.get("zhipu-plan");
    expect(plan?.gatewayCredentialMode).toBe("passthrough");
    // 缺省目标不落 passthrough 字段（网关按 inject 处理）。
    expect(controller.current().targetsById.get("paygo")?.gatewayCredentialMode).toBeUndefined();

    await writeFile(configPath, JSON.stringify({
      version: 3,
      revision: 2,
      agentConnections: {},
      targets: [
        {
          id: "zhipu-plan",
          anthropicUrl: "https://open.bigmodel.cn/api/anthropic",
          enabled: true,
          credentialMode: "typo-passthrough",
          supportedModels: ["glm-5.3"],
        },
      ],
      localProxyBaseUrl: "http://localhost:3211",
      updatedAt: new Date().toISOString(),
    }), "utf8");
    // 运行中重载的解析失败由引擎吞掉并返回 false，保留上一个合法快照。
    expect(await controller.reload()).toBe(false);
    expect(controller.current().revision).toBe(1);
    expect(controller.current().targetsById.get("zhipu-plan")?.gatewayCredentialMode).toBe("passthrough");
  });

  test("未记录或空 scope 的模型不允许任何 Agent（默认拒绝）", async () => {
    const root = await mkdtemp(join(tmpdir(), "routing-deny-scope-"));
    const configPath = join(root, "proxy-config.json");
    await writeFile(configPath, JSON.stringify({
      version: 3,
      revision: 1,
      agentConnections: {},
      targets: [{
        id: "primary",
        name: "Primary",
        openaiUrl: "https://primary.example/v1",
        enabled: true,
        supportedModels: ["gpt-5.6", "deepseek-chat"],
        supportedModelScopes: {"gpt-5.6": ["codex"]},
        development: {defaultCredentials: {codex: "cred-primary"}},
      }],
      localProxyBaseUrl: "http://localhost:3211",
      updatedAt: new Date().toISOString(),
    }), "utf8");
    const controller = new RoutingConfigController({configPath, watchEnabled: false});
    controllers.push(controller);
    await controller.init();

    const target = controller.current().targetsById.get("primary")!;
    expect(isModelAllowedForAgent(target, "gpt-5.6", "codex")).toBe(true);
    expect(isModelAllowedForAgent(target, "gpt-5.6", "claude")).toBe(false);
    expect(isModelAllowedForAgent(target, "deepseek-chat", "codex")).toBe(false);
  });

  test("解析 supportedModelWireApis 并按 wire API 白名单判断", async () => {
    const root = await mkdtemp(join(tmpdir(), "routing-wire-api-"));
    const configPath = join(root, "proxy-config.json");
    await writeFile(configPath, JSON.stringify({
      version: 3,
      revision: 1,
      agentConnections: {},
      targets: [{
        id: "primary",
        name: "Primary",
        openaiUrl: "https://primary.example/v1",
        enabled: true,
        supportedModels: ["gpt-5.6", "deepseek-chat"],
        supportedModelScopes: {"gpt-5.6": ["codex"]},
        supportedModelWireApis: {"gpt-5.6": ["responses"]},
        development: {defaultCredentials: {codex: "cred-primary"}},
      }],
      localProxyBaseUrl: "http://localhost:3211",
      updatedAt: new Date().toISOString(),
    }), "utf8");
    const controller = new RoutingConfigController({configPath, watchEnabled: false});
    controllers.push(controller);
    await controller.init();

    const target = controller.current().targetsById.get("primary")!;
    expect(isModelWireApiAllowedForAgent(target, "gpt-5.6", "responses")).toBe(true);
    expect(isModelWireApiAllowedForAgent(target, "gpt-5.6", "chat_completions")).toBe(false);
    expect(isModelWireApiAllowedForAgent(target, "deepseek-chat", "responses")).toBe(false);
  });

  test("无 wire API 声明的自定义目标按 URL + 模型家族推断兜底", async () => {
    const root = await mkdtemp(join(tmpdir(), "routing-wire-infer-"));
    const configPath = join(root, "proxy-config.json");
    await writeFile(configPath, JSON.stringify({
      version: 3,
      revision: 1,
      agentConnections: {},
      targets: [{
        id: "relay",
        name: "Relay",
        openaiUrl: "https://relay.example/v1",
        anthropicUrl: "https://relay.example/anthropic",
        enabled: true,
        supportedModels: ["gpt-5.6-sol", "deepseek-v4-flash"],
        supportedModelScopes: {"gpt-5.6-sol": ["codex"], "deepseek-v4-flash": ["opencode", "dsh"]},
        development: {defaultCredentials: {codex: "cred-codex", opencode: "cred-open", dsh: "cred-dsh"}},
      }],
      localProxyBaseUrl: "http://localhost:3211",
      updatedAt: new Date().toISOString(),
    }), "utf8");
    const controller = new RoutingConfigController({configPath, watchEnabled: false});
    controllers.push(controller);
    await controller.init();

    const target = controller.current().targetsById.get("relay")!;
    // gpt-* 家族 → responses；非 gpt 家族 OpenAI 模型 → chat；anthropicUrl → messages。
    expect(isModelWireApiAllowedForAgent(target, "gpt-5.6-sol", "responses")).toBe(true);
    expect(isModelWireApiAllowedForAgent(target, "gpt-5.6-sol", "chat_completions")).toBe(false);
    expect(isModelWireApiAllowedForAgent(target, "deepseek-v4-flash", "chat_completions")).toBe(true);
    expect(isModelWireApiAllowedForAgent(target, "deepseek-v4-flash", "responses")).toBe(false);
    expect(isModelWireApiAllowedForAgent(target, "deepseek-v4-flash", "messages")).toBe(true);
  });

  test("显式声明为空数组的模型不被 URL 推断覆盖（显式拒绝）", async () => {
    const root = await mkdtemp(join(tmpdir(), "routing-wire-deny-"));
    const configPath = join(root, "proxy-config.json");
    await writeFile(configPath, JSON.stringify({
      version: 3,
      revision: 1,
      agentConnections: {},
      targets: [{
        id: "relay",
        name: "Relay",
        openaiUrl: "https://relay.example/v1",
        enabled: true,
        supportedModels: ["gpt-5.6-sol"],
        supportedModelScopes: {"gpt-5.6-sol": ["codex"]},
        supportedModelWireApis: {"gpt-5.6-sol": []},
        development: {defaultCredentials: {codex: "cred-codex"}},
      }],
      localProxyBaseUrl: "http://localhost:3211",
      updatedAt: new Date().toISOString(),
    }), "utf8");
    const controller = new RoutingConfigController({configPath, watchEnabled: false});
    controllers.push(controller);
    await controller.init();

    const target = controller.current().targetsById.get("relay")!;
    expect(isModelWireApiAllowedForAgent(target, "gpt-5.6-sol", "responses")).toBe(false);
    expect(isModelWireApiAllowedForAgent(target, "gpt-5.6-sol", "chat_completions")).toBe(false);
  });
});
