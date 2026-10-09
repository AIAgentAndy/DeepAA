import {describe, expect, test} from "vitest";
import {
  computeManagedFileSections,
  hasMaskedSecret,
  maskSensitiveValues,
  type ConfigFileSection,
} from "../src/lib/config-sync/file-display.js";

/**
 * 受管文件段级高亮纯计算测试。
 *
 * 覆盖 5 个 Agent 的合并产物切块判定：当前供应商（current-target）、
 * Deepaa 共享块（shared-managed）、其它供应商受管块（managed-other）与用户自定义内容（unmanaged），
 * 以及空内容/敏感判定边界。
 */

const CURRENT = {defaultTargetId: "api.deepseek.com", currentTargetId: "api.deepseek.com"};

/** 合并后 Codex config.toml 形态（smol-toml 序列化：标量在前，表按名排序）。 */
const CODEX_TOML = [
  'model = "deepseek-v4-flash_api.deepseek.com"',
  'model_provider = "deepaa_gateway"',
  'model_catalog_json = "{\\"models\\":[]}"',
  "",
  "[model_providers.deepaa_gateway]",
  'name = "Deepaa 网关"',
  'base_url = "http://localhost:3211/codex/v1"',
  'experimental_bearer_token = "deepaa-gateway"',
  "",
  "[profiles.deepaa_api_deepseek_com]",
  'model = "deepseek-v4-flash_api.deepseek.com"',
  'model_provider = "deepaa_gateway"',
  "",
  "[profiles.deepaa_ai98pro_xyz]",
  'model = "j2-mid_ai98pro.xyz"',
  'model_provider = "deepaa_gateway"',
  "",
  "[mcp_servers.demo]",
  'command = "demo"',
].join("\n") + "\n";

describe("computeManagedFileSections", () => {
  test("codex config.toml：当前目标 profile 与 model 标 current，网关 managed，用户表 unmanaged", () => {
    const sections = computeManagedFileSections({
      agent: "codex",
      kind: "toml",
      specId: "codex-config",
      content: CODEX_TOML,
      ...CURRENT,
    });

    const kindAt = (line: number) => sections.find(section => line >= section.startLine && line <= section.endLine)?.kind;
    expect(kindAt(1)).toBe("current-target"); // model
    expect(kindAt(2)).toBe("managed-other"); // model_provider
    expect(kindAt(6)).toBe("managed-other"); // gateway 表
    expect(kindAt(10)).toBe("current-target"); // 当前 profile
    expect(kindAt(14)).toBe("managed-other"); // 其它 profile
    expect(kindAt(18)).toBe("unmanaged"); // 用户 mcp_servers
  });

  test("codex config.toml：查看其它目标时其 profile 仍按前缀标 current", () => {
    const sections = computeManagedFileSections({
      agent: "codex",
      kind: "toml",
      specId: "codex-config",
      content: CODEX_TOML,
      defaultTargetId: "api.deepseek.com",
      currentTargetId: "ai98pro.xyz",
    });
    // 顶层 model 仍指向 deepseek（managed-other），但 ai98pro 自己的 profile 是当前目标。
    expect(sections.find(section => section.label === "model")?.kind).toBe("managed-other");
    expect(sections.find(section => section.label === "profiles.deepaa_ai98pro_xyz")
      ?.kind).toBe("current-target");
  });

  test("codex catalog.json：真实目录只有 slug 时仍逐条目按目标后缀标 current / managed", () => {
    const catalog = JSON.stringify({
      models: [
        {slug: "deepseek-v4-flash_api.deepseek.com", context_window: 10},
        {slug: "j2-mid_ai98pro.xyz", context_window: 10},
      ],
    }, null, 2);
    const sections = computeManagedFileSections({
      agent: "codex",
      kind: "json",
      specId: "codex-catalog",
      content: catalog,
      ...CURRENT,
    });
    const first = sections.find(section => section.label === 'models[deepseek-v4-flash_api.deepseek.com]');
    const second = sections.find(section => section.label === "models[j2-mid_ai98pro.xyz]");
    expect(first?.kind).toBe("current-target");
    expect(second?.kind).toBe("managed-other");
  });

  test("claude settings.json：网关 env 标 shared，默认模型按目标标 current", () => {
    const settings = JSON.stringify({
      model: "deepseek-v4-flash_api.deepseek.com",
      env: {ANTHROPIC_AUTH_TOKEN: "deepaa-gateway"},
      hooks: {demo: true},
    }, null, 2);
    const sections = computeManagedFileSections({
      agent: "claude",
      kind: "json",
      specId: "claude-user",
      content: settings,
      ...CURRENT,
    });
    const env = sections.find(section => section.label === "env");
    const model = sections.find(section => section.label === "model");
    expect(env?.kind).toBe("shared-managed");
    expect(model?.kind).toBe("current-target");
    // hooks 保持用户自定义，不进受管段。
    expect(sections.find(section => section.kind === "unmanaged")).toBeDefined();
  });

  test("claude settings.json：网关键为 shared，模型别名按各自后缀逐键归属", () => {
    const settings = JSON.stringify({
      env: {
        ANTHROPIC_BASE_URL: "http://localhost:3211/claude",
        ANTHROPIC_AUTH_TOKEN: "deepaa-gateway",
        ANTHROPIC_MODEL: "claude-opus-5_api.anthropic.com",
        ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus-5_api.anthropic.com",
        ANTHROPIC_DEFAULT_HAIKU_MODEL: "claude-haiku-4-5_ai98pro.xyz",
      },
      model: "claude-opus-5_api.anthropic.com",
    }, null, 2);
    const sections = computeManagedFileSections({
      agent: "claude",
      kind: "json",
      specId: "claude-user",
      content: settings,
      defaultTargetId: "api.anthropic.com",
      currentTargetId: "ai98pro.xyz",
    });
    expect(sections.find(section => section.label === "env.ANTHROPIC_BASE_URL")?.kind).toBe("shared-managed");
    expect(sections.find(section => section.label === "env.ANTHROPIC_AUTH_TOKEN")?.kind).toBe("shared-managed");
    expect(sections.find(section => section.label === "env.ANTHROPIC_DEFAULT_HAIKU_MODEL")?.kind).toBe("current-target");
    expect(sections.find(section => section.label === "env.ANTHROPIC_DEFAULT_OPUS_MODEL")?.kind).toBe("managed-other");
    expect(sections.find(section => section.label === "model")?.kind).toBe("managed-other");
  });

  test("claude settings.json：Claude 默认目标是其它供应商时 env/model 标 managed", () => {
    const settings = JSON.stringify({
      model: "claude-sonnet-4-5_api.anthropic.com",
      env: {ANTHROPIC_AUTH_TOKEN: "deepaa-gateway"},
    }, null, 2);
    const sections = computeManagedFileSections({
      agent: "claude",
      kind: "json",
      specId: "claude-user",
      content: settings,
      defaultTargetId: "api.anthropic.com",
      currentTargetId: "api.deepseek.com",
    });
    expect(sections.every(section => section.kind !== "current-target")).toBe(true);
  });

  test("opencode.jsonc：受管 provider 段 managed，当前目标模型条目精标 current", () => {
    const content = [
      "{",
      '  "provider": {',
      '    "opencode-deepaa-gateway-chat": {',
      '      "npm": "@ai-sdk/openai-compatible",',
      '      "name": "Deepaa 网关",',
      '    },',
      '    "demo-provider": {',
      '      "npm": "@ai-sdk/openai-compatible",',
      '    },',
      '  },',
      '  "model": "opencode-deepaa-gateway-chat/deepseek-v4-flash_api.deepseek.com",',
      '  "small_model": "opencode-deepaa-gateway-chat/deepseek-v4-flash_api.deepseek.com",',
      '  "permissions": {',
      '    "deny": [], "allow": [],',
      '  },',
      "}",
    ].join("\n") + "\n";

    const sections = computeManagedFileSections({
      agent: "opencode",
      kind: "jsonc",
      specId: "opencode-global",
      content,
      ...CURRENT,
    });
    const label = (kind: string, start: number): ConfigFileSection | undefined =>
      sections.find(section => section.kind === kind && section.startLine === start);
    // provider 段行 3-6 managed（含收尾花括号行）；demo-provider 行 7-9 unmanaged。
    expect(label("managed-other", 3)?.endLine).toBe(6);
    expect(label("unmanaged", 7)).toBeDefined();
    // model / small_model：默认目标即当前目标时 current，各自成段。
    expect(label("current-target", 11)).toBeDefined();
    expect(label("current-target", 12)).toBeDefined();
  });

  test("opencode.jsonc：当前目标非默认时 model 只能 managed；模型条目仍按前缀定 current", () => {
    const content = [
      "{",
      '  "provider": {',
      '    "opencode-deepaa-gateway-chat": {',
      '      "models": {',
      '        "j2-mid_ai98pro.xyz": {},',
      '      },',
      '    },',
      '  },',
      '  "model": "opencode-deepaa-gateway-chat/j2-mid_ai98pro.xyz",',
      "}",
    ].join("\n") + "\n";
    const sections = computeManagedFileSections({
      agent: "opencode",
      kind: "jsonc",
      specId: "opencode-global",
      content,
      currentTargetId: "ai98pro.xyz",
      defaultTargetId: "api.deepseek.com", // 默认目标不同：model 不算 current
    });
    // 默认目标非当前目标时 model 为受管 managed；provider.models 条目按前缀 current。
    const modelSection = sections.find(section => section.label === "model");
    expect(modelSection?.kind).toBe("managed-other");
    expect(sections.find(section => section.kind === "current-target")).toBeDefined();
  });

  test("dsh settings.yaml：Deepaa Provider 受管，当前目标条目精标，自定义键 unmanaged", () => {
    const content = [
      "# 用户自定义注释",
      "lastUsedWorkspace: /tmp/demo",
      "llm-pi-ai:",
      "  providers:",
      "    deepaa-gateway:",
      "      baseURL: http://localhost:3211/dsh/v1",
      "      apiKeyEnv: DEEPAA_GATEWAY_TOKEN",
      "      models:",
      "        - id: deepseek-v4-flash_api.deepseek.com",
      "          name: DeepSeek-V4-Flash",
      "        - id: j2-mid_ai98pro.xyz",
      "          name: J2 Mid",
      "agent-default-model: deepseek-v4-flash_api.deepseek.com",
      "someCustomKey: 1",
    ].join("\n") + "\n";
    const sections = computeManagedFileSections({
      agent: "dsh",
      kind: "yaml",
      specId: "dsh-settings",
      content,
      ...CURRENT,
    });
    expect(sections.find(section => section.startLine === 1)?.kind).toBe("unmanaged");
    const deepseek = sections.find(section => section.label === "llm-pi-ai.providers.deepaa-gateway");
    expect(deepseek?.kind).toBe("managed-other");
    expect(sections.find(section => section.label.startsWith("deepaa-gateway.models[deepseek-v4-flash_api.deepseek.com"))
      ?.kind).toBe("current-target");
    expect(sections.find(section => section.label === "agent-default-model")?.kind).toBe("current-target");
  });

  test("dsh profile patch（cordis.patch.yml）：受管行按行 id 高亮，用户行 unmanaged", () => {
    const content = [
      "# 用户自定义行",
      "- id: ui-theme",
      "  config:",
      "    preference: dark",
      "- id: llm-pi-ai",
      "  config:",
      "    providers:",
      "      deepaa-gateway:",
      "        baseURL: http://localhost:3211/dsh/v1",
      "        models:",
      "          - id: deepseek-v4-flash_api.deepseek.com",
      "            name: DeepSeek-V4-Flash",
      "          - id: j2-mid_ai98pro.xyz",
      "            name: J2 Mid",
      "- id: agent-default-model",
      "  config:",
      "    provider: deepaa-gateway",
      "    model: deepseek-v4-flash_api.deepseek.com",
    ].join("\n") + "\n";
    const sections = computeManagedFileSections({
      agent: "dsh",
      kind: "yaml",
      specId: "dsh-profile-patch",
      content,
      ...CURRENT,
    });
    expect(sections.find(section => section.startLine === 1)?.kind).toBe("unmanaged");
    const deepseek = sections.find(section => section.label === "llm-pi-ai.providers.deepaa-gateway");
    expect(deepseek?.kind).toBe("managed-other");
    expect(sections.find(section => section.label.startsWith("deepaa-gateway.models[deepseek-v4-flash_api.deepseek.com"))
      ?.kind).toBe("current-target");
    expect(sections.find(section => section.label === "agent-default-model")?.kind).toBe("current-target");
  });

  test("dsh credentials：凭据文件也能展示受管占位键与用户凭据区段", () => {
    const credentialSections = computeManagedFileSections({
      agent: "dsh",
      kind: "yaml",
      specId: "dsh-credentials",
      content: "refs:\n  demo: sk-x\n",
      ...CURRENT,
    });
    expect(credentialSections.find(section => section.label === "refs")?.kind).toBe("shared-managed");
    expect(credentialSections.find(section => section.kind === "unmanaged")?.label).toBe("用户凭据");
    expect(computeManagedFileSections({
      agent: "codex",
      kind: "toml",
      specId: "codex-config",
      content: "   \n",
      ...CURRENT,
    })).toEqual([]);
    expect(computeManagedFileSections({
      agent: "diffusion" as never,
      kind: "json",
      specId: "x",
      content: "{}",
      ...CURRENT,
    })).toEqual([]);
  });

  test("zcode config.json：自有 Provider 的当前模型、共享壳和其它供应商模型分别标记", () => {
    const content = JSON.stringify({
      provider: {
        "deepaa-gateway": {
          name: "Deepaa 网关",
          options: {apiKey: "deepaa-gateway", baseURL: "http://localhost:3211/zcode"},
          models: {
            "claude-opus-5_ai98pro.xyz": {name: "ai98pro"},
            "claude-sonnet-5_api.anthropic.com": {name: "Anthropic"},
          },
        },
        "deepaa-state": {managed: {version: 1, addedKeys: ["deepaa-gateway"]}},
        "user-provider": {options: {apiKey: "masked-by-server"}},
      },
    }, null, 2);
    const sections = computeManagedFileSections({
      agent: "zcode",
      kind: "json",
      specId: "zcode-config",
      content,
      defaultTargetId: "ai98pro.xyz",
      currentTargetId: "ai98pro.xyz",
    });
    expect(sections.find(section => section.label === "provider.deepaa-gateway")?.kind).toBe("shared-managed");
    expect(sections.find(section => section.label.includes("claude-opus-5_ai98pro.xyz"))?.kind).toBe("current-target");
    expect(sections.find(section => section.label.includes("claude-sonnet-5_api.anthropic.com"))?.kind).toBe("managed-other");
    expect(sections.find(section => section.label === "provider.deepaa-state")?.kind).toBe("shared-managed");
    expect(sections.find(section => section.kind === "unmanaged")).toBeDefined();
  });

  test("zcode state.json：targets[] 按 targetId 标记当前供应商", () => {
    const content = JSON.stringify({
      deepaa: {
        version: 1,
        targets: [
          {targetId: "ai98pro.xyz", models: 2},
          {targetId: "api.anthropic.com", models: 1},
        ],
      },
    }, null, 2);
    const sections = computeManagedFileSections({
      agent: "zcode",
      kind: "json",
      specId: "zcode-state",
      content,
      defaultTargetId: "ai98pro.xyz",
      currentTargetId: "ai98pro.xyz",
    });
    expect(sections.find(section => section.label === "targets[ai98pro.xyz]")?.kind).toBe("current-target");
    expect(sections.find(section => section.label === "targets[api.anthropic.com]")?.kind).toBe("managed-other");
  });
});

describe("maskSensitiveValues", () => {
  test("打码 sk- 密钥与 apiKey/token 键值", () => {
    const masked = maskSensitiveValues(
      'apiKey = "sk-abcdefghijklmnopqrstuvwxyz123456"\nbase_url = "http://localhost:3211"',
    );
    expect(masked).toContain('apiKey = "sk-a**3456"');
    expect(masked).toContain("http://localhost"); // 普通 URL 不打码
  });

  test("无敏感内容时保持原文", () => {
    const text = 'model = "demo_model"';
    expect(maskSensitiveValues(text)).toBe(text);
  });

  test("只把查看器生成的局部隐藏标记识别为可展开敏感值", () => {
    expect(hasMaskedSecret('apiKey = "sk-a**3456"')).toBe(true);
    expect(hasMaskedSecret("prompt = \"Markdown **bold**\"")).toBe(false);
  });
});
