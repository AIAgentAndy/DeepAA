import { afterEach, describe, expect, test } from "vitest";
import { expectPosixFileMode } from "./helpers/posix-permissions.js";
import { existsSync } from "fs";
import { mkdtemp, readFile, rm, stat } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  buildDevelopmentLaunchCommand,
  buildClaudeSettings,
  normalizeDevelopmentManualOverrides,
  prepareDevelopmentLaunch,
} from "../src/lib/development-launch/launch-plan.js";
import { normalizeResumeSessionId } from "../src/lib/development-launch/resume-session.js";
import {
  genericPreferencesNormalizer,
  sameLaunchPreferences,
} from "../src/lib/development-launch/strategies/shared.js";

const tempRoots: string[] = [];
const RESUME_SESSION_ID = "019b4a2c-8f30-7a21-b233-4d89283f76a1";

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe("development launch commands", () => {
  test("Codex 启动统一走 deepaa_gateway provider 并携带网关模型", () => {
    const first = buildDevelopmentLaunchCommand(codexInput({
      launchId: "launch_first",
      targetId: "catapi.chat",
    }));
    const repeated = buildDevelopmentLaunchCommand(codexInput({
      launchId: "launch_second",
      targetId: "catapi.chat",
    }));
    const collision = buildDevelopmentLaunchCommand(codexInput({
      launchId: "launch_third",
      targetId: "catapi-chat",
    }));

    const firstProvider = providerArgument(first.args);
    expect(firstProvider).toBe("deepaa_gateway");
    expect(providerArgument(repeated.args)).toBe("deepaa_gateway");
    expect(providerArgument(collision.args)).toBe("deepaa_gateway");
    expect(first.args).toContain("gpt-5.6_catapi.chat");
    expect(collision.args).toContain("gpt-5.6_catapi-chat");
  });

  test("Codex 始终显式携带网关模型、网关 base_url 与占位 token", () => {
    const command = buildDevelopmentLaunchCommand(codexInput({
      manualOverrides: {
        sandboxMode: "workspace-write",
      },
    }));

    const serialized = JSON.stringify(command);
    expect(command.args).toContain("-m");
    expect(command.args).toContain("gpt-5.6_catapi.chat");
    expect(command.args.some(argument => argument.endsWith('wire_api="responses"'))).toBe(true);
    expect(command.args.some(argument => argument.includes(
      'model_providers.deepaa_gateway.base_url="http://localhost:3211/codex/v1"',
    ))).toBe(true);
    expect(command.args.some(argument => argument.includes(
      'experimental_bearer_token="deepaa-gateway"',
    ))).toBe(true);
    expect(command.args.some(argument => argument.includes(
      'model_providers.deepaa_gateway.name="DeepAA 网关"',
    ))).toBe(true);
    expect(command.args.some(argument => argument.includes("requires_openai_auth"))).toBe(false);
    // 2026-10-02（D1 用户确认）：推理档/上下文窗口/压缩阈值对目录内网关模型被
    // 条目级能力位覆盖、实测 -c 无效，已移除；sandbox 无目录对应字段仍走 -c。
    expect(command.args).toContain('sandbox_mode="workspace-write"');
    expect(command.args.some(argument => argument.includes("model_reasoning_effort"))).toBe(false);
    expect(command.args.some(argument => argument.includes("model_context_window"))).toBe(false);
    expect(command.args.some(argument => argument.includes("model_auto_compact_token_limit"))).toBe(false);
    expect(command.args.some(argument => argument.includes("approval_policy"))).toBe(false);
    expect(serialized).not.toContain("credential-helper.mjs");
    expect(serialized).not.toContain("sk-sensitive");
  });

  test("Session ID 留空时新建会话，合法 UUID 规范化后用于恢复", () => {
    expect(normalizeResumeSessionId(undefined)).toBeUndefined();
    expect(normalizeResumeSessionId("   ")).toBeUndefined();
    expect(normalizeResumeSessionId(`  ${RESUME_SESSION_ID.toUpperCase()}  `))
      .toBe(RESUME_SESSION_ID);
    expect(() => normalizeResumeSessionId("--last")).toThrow("INVALID_RESUME_SESSION_ID");
    expect(() => normalizeResumeSessionId("019b4a2c-8f30-7a21-b233-4d89283f76a1\n--help"))
      .toThrow("INVALID_RESUME_SESSION_ID");
  });

  test("Session ID 按 Agent 校验：OpenCode 接受 ses_ 前缀，Codex 额外接受会话名称，dsh 拒绝恢复", () => {
    expect(normalizeResumeSessionId("ses_open123456789", "opencode")).toBe("ses_open123456789");
    expect(() => normalizeResumeSessionId(RESUME_SESSION_ID, "opencode"))
      .toThrow("INVALID_RESUME_SESSION_ID");
    expect(() => normalizeResumeSessionId("ses_open123456789", "dsh"))
      .toThrow("RESUME_NOT_SUPPORTED");
    // codex 会话名称（桌面端侧栏标题）：保留原样大小写；首字符 "-"、引号与控制符拒绝。
    expect(normalizeResumeSessionId("  Five Great Agents 调研", "codex")).toBe("Five Great Agents 调研");
    expect(normalizeResumeSessionId("fix gateway bug #42", "codex")).toBe("fix gateway bug #42");
    expect(() => normalizeResumeSessionId("-flag-like", "codex"))
      .toThrow("INVALID_RESUME_SESSION_ID");
    expect(() => normalizeResumeSessionId('bad "name"', "codex"))
      .toThrow("INVALID_RESUME_SESSION_ID");
    expect(() => normalizeResumeSessionId("bad\nname", "codex"))
      .toThrow("INVALID_RESUME_SESSION_ID");
    expect(() => normalizeResumeSessionId("Five Great Agents 调研", "claude"))
      .toThrow("INVALID_RESUME_SESSION_ID");
  });

  test("Codex 仅在显式提供 Session ID 时生成 resume 命令", () => {
    const fresh = buildDevelopmentLaunchCommand(codexInput());
    const resumed = buildDevelopmentLaunchCommand(codexInput({
      resumeSessionId: RESUME_SESSION_ID,
    }));

    expect(fresh.args).not.toContain("resume");
    expect(fresh.args).not.toContain(RESUME_SESSION_ID);
    expect(resumed.args[0]).toBe("resume");
    expect(resumed.args.at(-1)).toBe(RESUME_SESSION_ID);
  });

  test("Claude 仅在显式提供 Session ID 时添加 --resume 参数", () => {
    const common = {
      launchId: "launch_claude_resume",
      cli: "claude" as const,
      platform: "darwin" as const,
      targetId: "anthropic-target",
      targetName: "Anthropic target",
      localBaseUrl: "http://localhost:3211/anthropic-target",
      projectDir: "/Users/andy/demo",
      executablePath: "/usr/local/bin/claude",
      terminal: "terminal.app",
      credentialId: "cred_claude",
      credentialHelperPath: "/app/bin/credential-helper.mjs",
      nodeExecutable: "/usr/local/bin/node",
      resolvedModel: "claude-opus-4-1",
      manualOverrides: {},
      settingsPath: "/tmp/claude-settings.json",
    };
    const fresh = buildDevelopmentLaunchCommand(common);
    const resumed = buildDevelopmentLaunchCommand({
      ...common,
      resumeSessionId: RESUME_SESSION_ID,
    });

    expect(fresh.args).not.toContain("--resume");
    expect(fresh.args).not.toContain(RESUME_SESSION_ID);
    expect(resumed.args.slice(0, 2)).toEqual(["--resume", RESUME_SESSION_ID]);
  });

  test("Claude 高级设置：effort/权限模式/自动压缩阈值与上下文环境变量；附加目录已移除", () => {
    const command = buildDevelopmentLaunchCommand({
      launchId: "launch_claude_advanced",
      cli: "claude" as const,
      platform: "darwin" as const,
      targetId: "anthropic-target",
      targetName: "Anthropic target",
      localBaseUrl: "http://localhost:3211/anthropic-target",
      projectDir: "/Users/andy/demo",
      executablePath: "/usr/local/bin/claude",
      terminal: "terminal.app",
      credentialId: "cred_claude",
      credentialHelperPath: "/app/bin/credential-helper.mjs",
      nodeExecutable: "/usr/local/bin/node",
      resolvedModel: "claude-opus-4-1",
      manualOverrides: {
        effortLevel: "high",
        permissionMode: "acceptEdits",
        claudeAutoCompactTokens: 200000,
        claudeMaxContextTokens: 500000,
      },
      settingsPath: "/tmp/claude-settings.json",
    });

    const effortIndex = command.args.indexOf("--effort");
    expect(effortIndex).toBeGreaterThan(-1);
    expect(command.args[effortIndex + 1]).toBe("high");
    const permissionIndex = command.args.indexOf("--permission-mode");
    expect(command.args[permissionIndex + 1]).toBe("acceptEdits");
    const autocompactIndex = command.args.indexOf("--autocompact");
    expect(autocompactIndex).toBeGreaterThan(-1);
    expect(command.args[autocompactIndex + 1]).toBe("200000");
    expect(command.environment.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe("500000");
    // 附加目录字段已按产品决策移除。
    expect(command.args).not.toContain("--add-dir");
  });

  test("OpenCode 启动命令按 wire API 选择 provider，支持 TUI/headless/恢复", () => {
    const base = opencodeInput();
    const tui = buildDevelopmentLaunchCommand(base);
    // TUI 形态：主命令用位置参数传项目目录（不支持 --dir，见 launch-plan 注释）。
    expect(tui.args).toEqual([
      "/Users/andy/项目/demo",
      "-m",
      "opencode-deepaa-gateway-responses/gpt-5.6_catapi.chat",
    ]);
    expect(tui.environment.DEEPAA_GATEWAY_TOKEN).toBe("deepaa-gateway");

    const resumed = buildDevelopmentLaunchCommand({
      ...base,
      resumeSessionId: "ses_open123456789",
    });
    expect(resumed.args).toContain("--session");
    expect(resumed.args).toContain("ses_open123456789");

    const headless = buildDevelopmentLaunchCommand({
      ...base,
      launchMode: "headless",
      task: "帮我修复测试",
    });
    expect(headless.args.slice(0, 4)).toEqual([
      "run",
      "帮我修复测试",
      "--dir",
      "/Users/andy/项目/demo",
    ]);
    expect(headless.args.at(-1)).toBe(
      "opencode-deepaa-gateway-responses/gpt-5.6_catapi.chat",
    );

    const chat = buildDevelopmentLaunchCommand({
      ...base,
      opencodeWireApi: "chat_completions",
    });
    expect(chat.args.at(-1)).toBe(
      "opencode-deepaa-gateway-chat/gpt-5.6_catapi.chat",
    );
    const messages = buildDevelopmentLaunchCommand({
      ...base,
      opencodeWireApi: "messages",
    });
    expect(messages.args.at(-1)).toBe(
      "opencode-deepaa-gateway-anthropic/gpt-5.6_catapi.chat",
    );
  });

  test("OpenCode headless 缺少任务文本时拒绝；dsh 固定 Web UI 形态", () => {
    const base = opencodeInput();
    expect(() => buildDevelopmentLaunchCommand({
      ...base,
      launchMode: "headless",
    })).toThrow("TASK_REQUIRED");
    expect(() => buildDevelopmentLaunchCommand({
      ...base,
      opencodeWireApi: undefined,
    })).toThrow("OPENCODE_WIRE_API_REQUIRED");

    // dsh：PATH 通道启动 dsh web；不再支持 headless 一次性任务。
    const dsh = dshInput();
    const command = buildDevelopmentLaunchCommand(dsh);
    expect(command.args).toEqual(["web"]);
    expect(command.environment.DEEPAA_GATEWAY_TOKEN).toBe("deepaa-gateway");
  });

  test("dsh npx 通道：免安装启动（首次自动下载、之后走缓存），注入占位 token", () => {
    const base = dshInput({executablePath: "/usr/local/bin/npx"});
    const command = buildDevelopmentLaunchCommand({...base, dshChannel: "npx"});
    expect(command.args).toEqual(["@deepseek-ai/dsh", "web"]);
    expect(command.environment.DEEPAA_GATEWAY_TOKEN).toBe("deepaa-gateway");
  });

  test("OpenCode / dsh 直接命令不创建临时目录或 settings", async () => {
    const root = join(await mkdtemp(join(tmpdir(), "development-opencode-command-")), "runtime");
    tempRoots.push(root.replace(/[/\\]runtime$/u, ""));
    const opencode = await prepareDevelopmentLaunch({
      tempRoot: root,
      input: opencodeInput({launchMode: "headless", task: "任务"}),
    });
    expect(opencode.runtimeDirectory).toBeUndefined();
    expect(opencode.settingsPath).toBeUndefined();

    const dshRoot = join(await mkdtemp(join(tmpdir(), "development-dsh-command-")), "runtime");
    tempRoots.push(dshRoot.replace(/[/\\]runtime$/u, ""));
    const dsh = await prepareDevelopmentLaunch({
      tempRoot: dshRoot,
      input: dshInput(),
    });
    expect(dsh.runtimeDirectory).toBeUndefined();
    expect(dsh.settingsPath).toBeUndefined();
  });

  test("Codex 直接命令不创建临时目录或 launch.json", async () => {
    const root = join(await mkdtemp(join(tmpdir(), "development-codex-command-")), "runtime");
    tempRoots.push(root.replace(/[/\\]runtime$/u, ""));

    const prepared = await prepareDevelopmentLaunch({
      tempRoot: root,
      input: codexInput(),
    });

    expect(prepared.runtimeDirectory).toBeUndefined();
    expect(prepared.settingsPath).toBeUndefined();
    expect(existsSync(root)).toBe(false);
  });

  test("Claude 只写私有 runtime settings 并直接构建 CLI 参数", async () => {
    const root = await mkdtemp(join(tmpdir(), "development-claude-command-"));
    tempRoots.push(root);
    const prepared = await prepareDevelopmentLaunch({
      tempRoot: root,
      input: {
        launchId: "launch_claude",
        cli: "claude",
        platform: "darwin",
        targetId: "anthropic-target",
        targetName: "Anthropic target",
        localBaseUrl: "http://localhost:3211/anthropic-target",
        projectDir: "/Users/andy/demo",
        executablePath: "/usr/local/bin/claude",
        terminal: "terminal.app",
        credentialId: "cred_claude",
        credentialHelperPath: "/app/bin/credential-helper.mjs",
        nodeExecutable: "/usr/local/bin/node",
        resolvedModel: "claude-opus-4-1",
        manualOverrides: {},
      },
    });

    const settings = JSON.parse(await readFile(prepared.settingsPath!, "utf-8")) as Record<string, unknown>;
    expect(settings).toEqual({
      env: {
        ANTHROPIC_BASE_URL: "http://localhost:3211/claude",
        ANTHROPIC_AUTH_TOKEN: "deepaa-gateway",
      },
    });
    expect(prepared.command.args).toContain("user,project,local");
    expect(prepared.command.args).toContain("--model");
    expect(prepared.command.args).toContain("claude-opus-4-1_anthropic-target");
    expectPosixFileMode((await stat(prepared.runtimeDirectory!)).mode & 0o777, 0o700);
    expectPosixFileMode((await stat(prepared.settingsPath!)).mode & 0o777, 0o600);
    expect(existsSync(join(prepared.runtimeDirectory!, "launch.json"))).toBe(false);
  });

  test("拒绝空模型并只保留经过校验的手动覆盖", () => {
    expect(() => buildDevelopmentLaunchCommand({
      ...codexInput(),
      resolvedModel: "",
    })).toThrow("MODEL_REQUIRED");
    // 2026-10-02：codex 能力类参数（推理档/上下文窗口/压缩阈值）已从 manualOverrides
    // 退役（改走 launchPreferences → 目录条目），未知/退役键静默丢弃。
    expect(normalizeDevelopmentManualOverrides({
      model: "must-be-ignored",
      modelContextWindow: 200_000,
      modelReasoningEffort: "high",
      sandboxMode: "workspace-write",
      unknownSecret: "must-be-dropped",
    })).toEqual({ sandboxMode: "workspace-write" });
    // profile / approvalPolicy / addDirs 已随弹窗精简移除：未知键静默丢弃。
    expect(normalizeDevelopmentManualOverrides({
      profile: "work",
      approvalPolicy: "never",
      addDirs: ["/tmp"],
      claudeAutoCompactTokens: 200_000,
      claudeMaxContextTokens: 500_000,
    })).toEqual({ claudeAutoCompactTokens: 200_000, claudeMaxContextTokens: 500_000 });
    expect(() => normalizeDevelopmentManualOverrides(null)).toThrow("INVALID_OVERRIDE");
  });

  test("订阅透传时 Codex 省略占位 bearer、Claude settings 省略 AUTH_TOKEN，且 credentialId 可选", () => {
    const codex = buildDevelopmentLaunchCommand(codexInput({
      subscriptionPassthrough: true,
      credentialId: undefined,
    }));
    expect(codex.args.some(argument => argument.includes("experimental_bearer_token"))).toBe(false);
    expect(codex.args.some(argument => argument.includes(
      'model_providers.deepaa_gateway.name="OpenAI"',
    ))).toBe(true);
    expect(codex.args.some(argument => argument.includes(
      "model_providers.deepaa_gateway.requires_openai_auth=true",
    ))).toBe(true);
    expect(codex.args.some(argument => argument.includes(
      "model_providers.deepaa_gateway.supports_websockets=false",
    ))).toBe(true);

    const claudeInput = {
      launchId: "launch_claude_sub",
      cli: "claude" as const,
      platform: "darwin" as const,
      targetId: "anthropic-sub",
      targetName: "Claude 订阅",
      localBaseUrl: "http://localhost:3211/anthropic-sub",
      projectDir: "/Users/andy/demo",
      executablePath: "/usr/local/bin/claude",
      terminal: "terminal.app",
      credentialId: undefined,
      credentialHelperPath: "/app/bin/credential-helper.mjs",
      nodeExecutable: "/usr/local/bin/node",
      resolvedModel: "claude-sonnet-4-5",
      manualOverrides: {},
      settingsPath: "/tmp/claude-settings.json",
      subscriptionPassthrough: true,
    };
    expect(() => buildDevelopmentLaunchCommand(claudeInput)).not.toThrow();

    const settings = buildClaudeSettings({
      platform: "darwin",
      localBaseUrl: "http://localhost:3211",
      subscriptionPassthrough: true,
    });
    expect(settings.env.ANTHROPIC_BASE_URL).toBe("http://localhost:3211/claude");
    expect(settings.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  });
});

function codexInput(overrides: Record<string, unknown> = {}) {
  return {
    launchId: "launch_default",
    cli: "codex" as const,
    platform: "darwin" as const,
    targetId: "catapi.chat",
    targetName: "Cat API",
    localBaseUrl: "http://localhost:3211/catapi.chat",
    projectDir: "/Users/andy/项目/demo",
    executablePath: "/opt/homebrew/bin/codex",
    terminal: "terminal.app",
    credentialId: "cred_primary",
    credentialHelperPath: "/app/bin/credential-helper.mjs",
    nodeExecutable: "/usr/local/bin/node",
    resolvedModel: "gpt-5.6",
    manualOverrides: {},
    ...overrides,
  };
}

function opencodeInput(overrides: Record<string, unknown> = {}) {
  return {
    launchId: "launch_opencode",
    cli: "opencode" as const,
    platform: "darwin" as const,
    targetId: "catapi.chat",
    targetName: "Cat API",
    localBaseUrl: "http://localhost:3211/catapi.chat",
    projectDir: "/Users/andy/项目/demo",
    executablePath: "/opt/homebrew/bin/opencode",
    terminal: "terminal.app",
    credentialId: "cred_primary",
    credentialHelperPath: "/app/bin/credential-helper.mjs",
    nodeExecutable: "/usr/local/bin/node",
    resolvedModel: "gpt-5.6",
    manualOverrides: {},
    opencodeWireApi: "responses",
    ...overrides,
  };
}

function dshInput(overrides: Record<string, unknown> = {}) {
  return {
    launchId: "launch_dsh",
    cli: "dsh" as const,
    platform: "darwin" as const,
    targetId: "deepseek.example",
    targetName: "DeepSeek",
    localBaseUrl: "http://localhost:3211/deepseek.example",
    projectDir: "/Users/andy/项目/demo",
    executablePath: "/usr/local/bin/dsh",
    terminal: "terminal.app",
    credentialId: "cred_dsh",
    credentialHelperPath: "/app/bin/credential-helper.mjs",
    nodeExecutable: "/usr/local/bin/node",
    resolvedModel: "deepseek-v4-flash",
    manualOverrides: {},
    launchMode: "headless",
    task: "帮我分析这个仓库",
    ...overrides,
  };
}

function providerArgument(args: string[]): string {
  const value = args.find(argument => argument.startsWith("model_provider="));
  if (!value) throw new Error("PROVIDER_ARGUMENT_MISSING");
  return JSON.parse(value.slice("model_provider=".length)) as string;
}

describe("launchPreferences 归一化与相等性（2026-10-02 键规范：网关模型 ID）", () => {
  test("genericPreferencesNormalizer 接受 autoCompactTokenLimits 并校验网关 ID 键", () => {
    expect(genericPreferencesNormalizer({
      reasoningEffort: "high",
      contextWindows: {"gpt-6.1-sol_auto-code.net": 1075200},
      autoCompactTokenLimits: {"gpt-6.1-sol_auto-code.net": 1021440},
    })).toEqual({
      reasoningEffort: "high",
      contextWindows: {"gpt-6.1-sol_auto-code.net": 1075200},
      autoCompactTokenLimits: {"gpt-6.1-sol_auto-code.net": 1021440},
    });
    // 非法键（空串/控制符）与非法值（非正整数）拒绝。
    expect(() => genericPreferencesNormalizer({contextWindows: {"": 100}} as never))
      .toThrow("INVALID_LAUNCH_PREFERENCE");
    expect(() => genericPreferencesNormalizer({autoCompactTokenLimits: {"a_b": 0}}))
      .toThrow("INVALID_LAUNCH_PREFERENCE");
    // 裸模型 ID 键（2026-10-03 复合键规范前的旧格式）无法匹配任何网关 slug，
    // 写入侧直接拒绝；尾下划线（路由段为空）同理拒绝。
    expect(() => genericPreferencesNormalizer({contextWindows: {"glm-5.3-flash": 1048576}}))
      .toThrow("INVALID_LAUNCH_PREFERENCE");
    expect(() => genericPreferencesNormalizer({autoCompactTokenLimits: {"glm-5.3-flash_": 100}}))
      .toThrow("INVALID_LAUNCH_PREFERENCE");
    expect(genericPreferencesNormalizer({})).toBeUndefined();
    expect(genericPreferencesNormalizer(undefined)).toBeUndefined();
  });

  test("sameLaunchPreferences 逐字段比较，含两个 token 映射", () => {
    const base = {
      reasoningEffort: "high",
      contextWindows: {"glm-5.3_zhipu-payg": 262144},
      autoCompactTokenLimits: {"glm-5.3_zhipu-payg": 249000},
    };
    expect(sameLaunchPreferences(base, {...base})).toBe(true);
    expect(sameLaunchPreferences(base, undefined)).toBe(false);
    expect(sameLaunchPreferences(undefined, undefined)).toBe(true);
    expect(sameLaunchPreferences(base, {...base, reasoningEffort: "max"})).toBe(false);
    expect(sameLaunchPreferences(base, {...base, contextWindows: {"glm-5.3_zhipu-payg": 524288}})).toBe(false);
    expect(sameLaunchPreferences(base, {...base, autoCompactTokenLimits: {}})).toBe(false);
    // 键集合不同（多一个条目）视为变化。
    expect(sameLaunchPreferences(
      base,
      {...base, contextWindows: {...base.contextWindows, "glm-5.3_zhipu-plan": 524288}},
    )).toBe(false);
  });
});
